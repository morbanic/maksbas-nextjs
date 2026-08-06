import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { ResolvedConfig } from '../config.js'
import { type Device, devices } from '../db/schema.js'
import { mergeAttributes } from '../devices/attributes.js'
import { optionalString, readJson, requireString } from '../http/body.js'
import { ApiError, json } from '../http/errors.js'
import {
  randomToken,
  requireDevice,
  requirePublicKey,
  requireSecretKey,
  sha256,
} from '../http/auth.js'
import { compileFilter } from '../segments/compile.js'
import type { Filter } from '../segments/types.js'
import { validateFilter } from '../segments/validate.js'

interface RegisterBody {
  fcmToken?: unknown
  platform?: unknown
  attributes?: unknown
  notificationsEnabled?: unknown
  appVersion?: unknown
  sdkVersion?: unknown
  deviceModel?: unknown
  osVersion?: unknown
  language?: unknown
  timezone?: unknown
}

/**
 * POST /devices — register or re-register a device. Auth: public key.
 *
 * Returns a fresh `deviceSecret` every time. The SDK stores it and uses it for
 * everything afterwards; we only keep its hash.
 *
 * Re-registering an FCM token that already exists updates that row rather than
 * inserting a second one. Android hands the same token back on every launch, so
 * without the upsert a device would accumulate a row per app start and receive
 * one copy of every notification per row.
 */
export async function registerDevice(
  request: Request,
  config: ResolvedConfig,
): Promise<Response> {
  requirePublicKey(request, config)

  const body = await readJson<RegisterBody>(request)
  const fcmToken = requireString(body.fcmToken, 'fcmToken', { maxLength: 4096 })
  const platform = optionalString(body.platform, 'platform', 32) ?? 'android'

  const secret = randomToken()
  const secretHash = await sha256(secret)
  const attributes = mergeAttributes({}, body.attributes ?? {})

  const values = {
    fcmToken,
    secretHash,
    platform,
    attributes,
    notificationsEnabled: body.notificationsEnabled === true,
    active: true,
    appVersion: optionalString(body.appVersion, 'appVersion', 64) ?? null,
    sdkVersion: optionalString(body.sdkVersion, 'sdkVersion', 64) ?? null,
    deviceModel: optionalString(body.deviceModel, 'deviceModel', 128) ?? null,
    osVersion: optionalString(body.osVersion, 'osVersion', 64) ?? null,
    language: optionalString(body.language, 'language', 32) ?? null,
    timezone: optionalString(body.timezone, 'timezone', 64) ?? null,
    updatedAt: new Date(),
    lastSeenAt: new Date(),
  }

  const [device] = await config.db
    .insert(devices)
    .values(values)
    .onConflictDoUpdate({
      target: devices.fcmToken,
      set: {
        // Deliberately NOT resetting attributes — a reinstall keeps its token,
        // and silently wiping segmentation data on every launch would be worse
        // than carrying over slightly stale values.
        secretHash: values.secretHash,
        platform: values.platform,
        notificationsEnabled: values.notificationsEnabled,
        active: true,
        appVersion: values.appVersion,
        sdkVersion: values.sdkVersion,
        deviceModel: values.deviceModel,
        osVersion: values.osVersion,
        language: values.language,
        timezone: values.timezone,
        updatedAt: values.updatedAt,
        lastSeenAt: values.lastSeenAt,
      },
    })
    .returning()

  if (!device) throw new ApiError('internal', 'Failed to register device')

  // If the caller sent attributes on re-registration, merge them onto whatever
  // the row already had instead of the empty object used for the insert.
  let merged = device
  if (body.attributes && Object.keys(body.attributes as object).length > 0) {
    const nextAttributes = mergeAttributes(device.attributes, body.attributes)
    const [updated] = await config.db
      .update(devices)
      .set({ attributes: nextAttributes, updatedAt: new Date() })
      .where(eq(devices.id, device.id))
      .returning()
    if (updated) merged = updated
  }

  return json(
    {
      deviceId: merged.id,
      deviceSecret: secret,
      attributes: merged.attributes,
      notificationsEnabled: merged.notificationsEnabled,
    },
    201,
  )
}

/** GET /devices/:id — the device reads its own state. Auth: device secret. */
export async function getDevice(
  request: Request,
  config: ResolvedConfig,
  deviceId: string,
): Promise<Response> {
  const device = await requireDevice(request, config, deviceId)
  await touch(config, device.id)
  return json(publicDevice(device))
}

/** PATCH /devices/:id — rotate the FCM token or update permission state. */
export async function updateDevice(
  request: Request,
  config: ResolvedConfig,
  deviceId: string,
): Promise<Response> {
  const device = await requireDevice(request, config, deviceId)
  const body = await readJson<RegisterBody>(request)

  const patch: Partial<typeof devices.$inferInsert> = {
    updatedAt: new Date(),
    lastSeenAt: new Date(),
  }

  if (body.fcmToken !== undefined) {
    patch.fcmToken = requireString(body.fcmToken, 'fcmToken', { maxLength: 4096 })
    // A token that arrives here is live by definition.
    patch.active = true
  }
  if (body.notificationsEnabled !== undefined) {
    patch.notificationsEnabled = body.notificationsEnabled === true
  }
  for (const field of ['appVersion', 'sdkVersion', 'deviceModel', 'osVersion', 'language', 'timezone'] as const) {
    if (body[field] !== undefined) {
      patch[field] = optionalString(body[field], field, 128) ?? null
    }
  }

  try {
    const [updated] = await config.db
      .update(devices)
      .set(patch)
      .where(eq(devices.id, device.id))
      .returning()
    return json(publicDevice(updated ?? device))
  } catch (error) {
    // FCM occasionally moves a token between installs. The other row owns it.
    if (isUniqueViolation(error)) {
      throw new ApiError(
        'conflict',
        'That FCM token is already registered to another device. Register again to get a fresh device id.',
      )
    }
    throw error
  }
}

/** PATCH /devices/:id/attributes — merge a key/value patch. `null` deletes a key. */
export async function patchAttributes(
  request: Request,
  config: ResolvedConfig,
  deviceId: string,
): Promise<Response> {
  const device = await requireDevice(request, config, deviceId)
  const body = await readJson<{ attributes?: unknown }>(request)

  // Accept both `{attributes: {...}}` and a bare `{...}` object.
  const patch = body && typeof body === 'object' && 'attributes' in body ? body.attributes : body

  const attributes = mergeAttributes(device.attributes, patch)

  const [updated] = await config.db
    .update(devices)
    .set({ attributes, updatedAt: new Date(), lastSeenAt: new Date() })
    .where(eq(devices.id, device.id))
    .returning()

  return json({ attributes: (updated ?? device).attributes })
}

/** DELETE /devices/:id — unregister. Auth: device secret. */
export async function deleteDevice(
  request: Request,
  config: ResolvedConfig,
  deviceId: string,
): Promise<Response> {
  const device = await requireDevice(request, config, deviceId)
  await config.db.delete(devices).where(eq(devices.id, device.id))
  return json({ deleted: true })
}

interface ListQuery {
  filter?: Filter | null
  limit?: number
  cursor?: string | null
}

/** POST /devices/query — list devices, optionally filtered. Auth: secret key. */
export async function queryDevices(
  request: Request,
  config: ResolvedConfig,
): Promise<Response> {
  requireSecretKey(request, config)

  const body = await readJson<ListQuery>(request).catch(() => ({}) as ListQuery)
  const limit = Math.min(Math.max(body.limit ?? 50, 1), 200)

  let filter: Filter | null = null
  if (body.filter != null) {
    validateFilter(body.filter)
    filter = body.filter
  }

  const conditions = [compileFilter(filter)]
  if (body.cursor) conditions.push(sql`${devices.id} > ${body.cursor}::uuid`)

  const rows = await config.db
    .select()
    .from(devices)
    .where(and(...conditions))
    .orderBy(asc(devices.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows

  return json({
    devices: page.map(publicDevice),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  })
}

/** POST /audience/count — how many devices a filter currently reaches. */
export async function countAudience(
  request: Request,
  config: ResolvedConfig,
): Promise<Response> {
  requireSecretKey(request, config)

  const body = await readJson<{ filter?: Filter | null }>(request).catch(
    () => ({}) as { filter?: Filter | null },
  )
  let filter: Filter | null = null
  if (body.filter != null) {
    validateFilter(body.filter)
    filter = body.filter
  }

  const [row] = await config.db
    .select({ count: sql<number>`count(*)::int` })
    .from(devices)
    .where(and(eq(devices.active, true), compileFilter(filter)))

  return json({ count: row?.count ?? 0 })
}

/** GET /devices/:id/... helpers */

function publicDevice(device: Device) {
  const { secretHash: _secretHash, ...rest } = device
  return rest
}

async function touch(config: ResolvedConfig, id: string): Promise<void> {
  await config.db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, id))
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  )
}

export { publicDevice, desc }
