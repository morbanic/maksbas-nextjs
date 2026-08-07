import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { ResolvedConfig } from '../config.js'
import { UNFINISHED_STATUSES, devices, events, notifications, segments } from '../db/schema.js'
import { mergeAttributes } from '../devices/attributes.js'
import { isUuid } from '../http/auth.js'
import { readJson } from '../http/body.js'
import { ApiError, json } from '../http/errors.js'
import { triggerDrain } from '../notifications/chain.js'
import { drainOnce } from '../notifications/drain.js'
import {
  type CreateNotificationBody,
  queueNotification,
  serialise,
} from '../routes/notifications.js'
import { compileFilter } from '../segments/compile.js'
import type { Filter } from '../segments/types.js'
import { validateFilter } from '../segments/validate.js'

const MAX_PAGE = 100

/** Counters for the header strip. */
export async function overview(_request: Request, config: ResolvedConfig): Promise<Response> {
  const [deviceCounts] = await config.db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${devices.active})::int`,
      reachable: sql<number>`count(*) filter (where ${devices.active} and ${devices.notificationsEnabled})::int`,
    })
    .from(devices)

  const [notificationCounts] = await config.db
    .select({
      total: sql<number>`count(*)::int`,
      inFlight: sql<number>`count(*) filter (where ${notifications.status} in ('pending','sending','retrying'))::int`,
      failed: sql<number>`count(*) filter (where ${notifications.status} = 'failed')::int`,
      sent: sql<number>`coalesce(sum(${notifications.sentCount}), 0)::int`,
    })
    .from(notifications)

  return json({
    devices: deviceCounts ?? { total: 0, active: 0, reachable: 0 },
    notifications: notificationCounts ?? { total: 0, inFlight: 0, failed: 0, sent: 0 },
  })
}

/**
 * GET /api/devices — one page of the registry.
 *
 * Offset paging rather than the API's cursor: a dashboard needs to jump around
 * and show a total, and the page size here is small enough that the offset
 * scan never matters.
 */
export async function listDevices(request: Request, config: ResolvedConfig): Promise<Response> {
  const url = new URL(request.url)
  const limit = clamp(Number(url.searchParams.get('limit')) || 25, 1, MAX_PAGE)
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0)
  const search = (url.searchParams.get('q') ?? '').trim()
  const status = url.searchParams.get('status') ?? 'all'

  const conditions = []
  if (status === 'active') conditions.push(eq(devices.active, true))
  if (status === 'inactive') conditions.push(eq(devices.active, false))
  if (search) {
    // `attributes::text` covers keys and values in one go, which is what someone
    // pasting a userId out of their own database actually wants.
    const pattern = `%${search.replace(/[%_\\]/g, (char) => `\\${char}`)}%`
    conditions.push(
      sql`(
        ${devices.id}::text ilike ${pattern}
        or ${devices.fcmToken} ilike ${pattern}
        or ${devices.attributes}::text ilike ${pattern}
        or coalesce(${devices.deviceModel}, '') ilike ${pattern}
      )`,
    )
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined

  const rows = await config.db
    .select()
    .from(devices)
    .where(where)
    .orderBy(desc(devices.lastSeenAt))
    .limit(limit)
    .offset(offset)

  const [count] = await config.db
    .select({ total: sql<number>`count(*)::int` })
    .from(devices)
    .where(where)

  return json({
    devices: rows.map(({ secretHash: _secretHash, fcmToken, ...rest }) => ({
      ...rest,
      // Enough to match against a log line, not enough to send with.
      fcmTokenPreview: `${fcmToken.slice(0, 12)}…${fcmToken.slice(-6)}`,
    })),
    total: count?.total ?? 0,
    limit,
    offset,
  })
}

/** PATCH /api/devices/:id — edit attributes or deactivate. */
export async function updateDevice(
  request: Request,
  config: ResolvedConfig,
  id: string,
): Promise<Response> {
  const device = await loadDevice(config, id)
  const body = await readJson<{ attributes?: unknown; active?: unknown }>(request)

  const patch: Partial<typeof devices.$inferInsert> = { updatedAt: new Date() }

  if (body.attributes !== undefined) {
    // Replaces rather than merges: the dashboard edits the whole document, and a
    // merge would make deleting a key from the editor impossible.
    patch.attributes = mergeAttributes({}, body.attributes)
  }
  if (body.active !== undefined) {
    patch.active = body.active === true
  }

  const [updated] = await config.db
    .update(devices)
    .set(patch)
    .where(eq(devices.id, device.id))
    .returning()

  const { secretHash: _secretHash, fcmToken: _fcmToken, ...rest } = updated ?? device
  return json({ device: rest })
}

/** DELETE /api/devices/:id — drop the registration and its events. */
export async function deleteDevice(
  _request: Request,
  config: ResolvedConfig,
  id: string,
): Promise<Response> {
  const device = await loadDevice(config, id)
  await config.db.delete(devices).where(eq(devices.id, device.id))
  return json({ deleted: true })
}

/** GET /api/notifications — recent sends with their delivery numbers. */
export async function listNotifications(
  request: Request,
  config: ResolvedConfig,
): Promise<Response> {
  const url = new URL(request.url)
  const limit = clamp(Number(url.searchParams.get('limit')) || 25, 1, MAX_PAGE)
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0)

  const rows = await config.db
    .select()
    .from(notifications)
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
    .offset(offset)

  const [count] = await config.db
    .select({ total: sql<number>`count(*)::int` })
    .from(notifications)

  const stats = await eventCounts(
    config,
    rows.map((row) => row.id),
  )

  return json({
    notifications: rows.map((row) => ({
      ...serialise(row),
      ...(stats.get(row.id) ?? { delivered: 0, opened: 0 }),
      audience: describeAudience(row.segmentName, row.filter),
    })),
    total: count?.total ?? 0,
    limit,
    offset,
  })
}

/** GET /api/notifications/:id — one send in full. */
export async function getNotification(
  _request: Request,
  config: ResolvedConfig,
  id: string,
): Promise<Response> {
  const notification = await loadNotification(config, id)
  const stats = await eventCounts(config, [notification.id])

  return json({
    notification: {
      ...serialise(notification),
      ...(stats.get(notification.id) ?? { delivered: 0, opened: 0 }),
      audience: describeAudience(notification.segmentName, notification.filter),
      pendingRetries: notification.retryIds.length + notification.retryQueue.length,
    },
  })
}

/** POST /api/notifications — compose and send. */
export async function createNotification(
  request: Request,
  config: ResolvedConfig,
): Promise<Response> {
  const body = await readJson<CreateNotificationBody>(request)
  const { notification, handedOff } = await queueNotification(config, body)
  return json({ notification: serialise(notification), handedOff }, 202)
}

/**
 * POST /api/notifications/:id/resume — push an unfinished send along.
 *
 * The escape hatch for a notification that stalled because the cron never ran:
 * it drains the row itself rather than waiting for the next tick.
 */
export async function resumeNotification(
  _request: Request,
  config: ResolvedConfig,
  id: string,
): Promise<Response> {
  const notification = await loadNotification(config, id)

  if (!isUnfinished(notification.status)) {
    throw new ApiError('conflict', `This notification is already ${notification.status}`)
  }

  const report = await drainOnce(config, {
    notificationId: notification.id,
    timeBudgetMs: config.inlineDrainMs > 0 ? config.inlineDrainMs : 3_000,
  })

  const handedOff = report.hasMore && !report.blocked ? await triggerDrain(config) : false

  return json({ report, handedOff })
}

/** DELETE /api/notifications/:id — remove the record and its events. */
export async function deleteNotification(
  _request: Request,
  config: ResolvedConfig,
  id: string,
): Promise<Response> {
  const notification = await loadNotification(config, id)

  if (isUnfinished(notification.status)) {
    throw new ApiError(
      'conflict',
      'This notification is still sending. Wait for it to finish before deleting it.',
    )
  }

  await config.db.delete(notifications).where(eq(notifications.id, notification.id))
  return json({ deleted: true })
}

/** GET /api/segments — feeds the audience picker. */
export async function listSegments(
  _request: Request,
  config: ResolvedConfig,
): Promise<Response> {
  const rows = await config.db.select().from(segments).orderBy(segments.name)
  return json({ segments: rows })
}

/** POST /api/audience — how many devices a filter reaches, before sending. */
export async function countAudience(
  request: Request,
  config: ResolvedConfig,
): Promise<Response> {
  const body = await readJson<{ filter?: Filter | null; segment?: string }>(request).catch(
    () => ({}) as { filter?: Filter | null; segment?: string },
  )

  let filter: Filter | null = null

  if (body.segment) {
    const [segment] = await config.db
      .select()
      .from(segments)
      .where(eq(segments.name, body.segment))
      .limit(1)
    if (!segment) throw new ApiError('not_found', `No segment named "${body.segment}"`)
    filter = segment.filter
  } else if (body.filter != null) {
    validateFilter(body.filter)
    filter = body.filter
  }

  const [row] = await config.db
    .select({ count: sql<number>`count(*)::int` })
    .from(devices)
    .where(and(eq(devices.active, true), compileFilter(filter)))

  return json({ count: row?.count ?? 0 })
}

async function eventCounts(
  config: ResolvedConfig,
  ids: string[],
): Promise<Map<string, { delivered: number; opened: number }>> {
  const stats = new Map<string, { delivered: number; opened: number }>()
  if (ids.length === 0) return stats

  const rows = await config.db
    .select({
      notificationId: events.notificationId,
      type: events.type,
      count: sql<number>`count(*)::int`,
    })
    .from(events)
    .where(inArray(events.notificationId, ids))
    .groupBy(events.notificationId, events.type)

  for (const row of rows) {
    const entry = stats.get(row.notificationId) ?? { delivered: 0, opened: 0 }
    if (row.type === 'delivered') entry.delivered = row.count
    if (row.type === 'opened') entry.opened = row.count
    stats.set(row.notificationId, entry)
  }
  return stats
}

async function loadDevice(config: ResolvedConfig, id: string) {
  if (!isUuid(id)) throw new ApiError('not_found', 'Device not found')

  const [device] = await config.db.select().from(devices).where(eq(devices.id, id)).limit(1)
  if (!device) throw new ApiError('not_found', 'Device not found')
  return device
}

async function loadNotification(config: ResolvedConfig, id: string) {
  if (!isUuid(id)) throw new ApiError('not_found', 'Notification not found')

  const [notification] = await config.db
    .select()
    .from(notifications)
    .where(eq(notifications.id, id))
    .limit(1)
  if (!notification) throw new ApiError('not_found', 'Notification not found')
  return notification
}

function isUnfinished(status: string): boolean {
  return (UNFINISHED_STATUSES as readonly string[]).includes(status)
}

function describeAudience(segmentName: string | null, filter: Filter | null): string {
  if (segmentName) return `segment: ${segmentName}`
  if (!filter) return 'everyone'
  return 'custom filter'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
