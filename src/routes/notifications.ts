import { and, desc, eq, sql } from 'drizzle-orm'
import type { ResolvedConfig } from '../config.js'
import { type Notification, events, notifications, segments } from '../db/schema.js'
import { optionalString, readJson, requireString } from '../http/body.js'
import { isUuid, requireSecretKey } from '../http/auth.js'
import { ApiError, json } from '../http/errors.js'
import { triggerDrain } from '../notifications/chain.js'
import { drainOnce } from '../notifications/drain.js'
import type { Filter } from '../segments/types.js'
import { FilterError } from '../segments/types.js'
import { validateFilter } from '../segments/validate.js'

export interface CreateNotificationBody {
  title?: unknown
  body?: unknown
  image?: unknown
  deeplink?: unknown
  data?: unknown
  filter?: unknown
  segment?: unknown
}

/**
 * POST /notifications — queue a notification and start sending. Auth: secret key.
 *
 * Returns 202 rather than 200: for anything beyond a few hundred devices the
 * send outlives this request. Poll `GET /notifications/:id` for progress.
 */
export async function createNotification(
  request: Request,
  config: ResolvedConfig,
): Promise<Response> {
  requireSecretKey(request, config)

  const body = await readJson<CreateNotificationBody>(request)
  const { notification, handedOff } = await queueNotification(config, body)

  return json({ ...serialise(notification), handedOff }, 202)
}

/**
 * Validates, writes and starts a notification.
 *
 * Split out of the route so the admin dashboard queues sends through exactly the
 * same path — including the head start and the hand-off — instead of growing a
 * second, subtly different copy of it.
 */
export async function queueNotification(
  config: ResolvedConfig,
  body: CreateNotificationBody,
): Promise<{ notification: Notification; handedOff: boolean }> {
  const title = requireString(body.title, 'title', { maxLength: 200 })
  const text = requireString(body.body, 'body', { maxLength: 2000 })
  const image = optionalString(body.image, 'image', 2048)
  const deeplink = optionalString(body.deeplink, 'deeplink', 2048)

  if (body.filter != null && body.segment != null) {
    throw new ApiError(
      'bad_request',
      'Pass either `filter` or `segment`, not both — a saved segment already carries its filter',
    )
  }

  const { filter, segmentName } = await resolveAudience(config, body)
  const data = normaliseData(body.data)

  const [created] = await config.db
    .insert(notifications)
    .values({
      title,
      body: text,
      image: image ?? null,
      deeplink: deeplink ?? null,
      data,
      filter,
      segmentName,
      status: 'pending',
    })
    .returning()

  if (!created) throw new ApiError('internal', 'Failed to create notification')

  // Give it a head start inside this request. Small audiences finish here and
  // never involve the cron at all.
  //
  // `notificationId` pins the drain to the row we just wrote. Draining "one
  // notification" without it claims the *oldest* unfinished one instead, so a
  // single stalled row at the head of the queue turns every send into a delivery
  // of the previous one.
  let report = { hasMore: true, blocked: false }
  if (config.inlineDrainMs > 0) {
    report = await drainOnce(config, {
      timeBudgetMs: config.inlineDrainMs,
      notificationId: created.id,
    })
  }

  // Don't chain into a lease someone else holds — that worker will chain itself.
  let handedOff = false
  if (report.hasMore && !report.blocked) handedOff = await triggerDrain(config)

  const [current] = await config.db
    .select()
    .from(notifications)
    .where(eq(notifications.id, created.id))
    .limit(1)

  return {
    notification: current ?? created,
    // Surfaced so a misconfigured deployment is visible from the response
    // instead of showing up as a notification that never arrives.
    handedOff: report.hasMore ? handedOff : false,
  }
}

async function resolveAudience(
  config: ResolvedConfig,
  body: CreateNotificationBody,
): Promise<{ filter: Filter | null; segmentName: string | null }> {
  if (body.segment != null) {
    const name = requireString(body.segment, 'segment', { maxLength: 128 })
    const [segment] = await config.db
      .select()
      .from(segments)
      .where(eq(segments.name, name))
      .limit(1)

    if (!segment) throw new ApiError('not_found', `No segment named "${name}"`)
    return { filter: segment.filter, segmentName: name }
  }

  if (body.filter != null) {
    try {
      validateFilter(body.filter)
    } catch (error) {
      if (error instanceof FilterError) {
        throw new ApiError('invalid_filter', error.message)
      }
      throw error
    }
    return { filter: body.filter as Filter, segmentName: null }
  }

  // No audience given targets every active device. Explicit and intentional —
  // it is the "announcement to everyone" case.
  return { filter: null, segmentName: null }
}

function normaliseData(input: unknown): Record<string, string> | null {
  if (input == null) return null
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError('bad_request', '`data` must be an object of string values')
  }

  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value == null) continue
    if (typeof value === 'object') {
      throw new ApiError(
        'bad_request',
        `\`data.${key}\` must be a string, number or boolean — FCM payloads are flat`,
      )
    }
    out[key] = String(value)
  }
  return Object.keys(out).length > 0 ? out : null
}

/** GET /notifications/:id — status plus delivery numbers. Auth: secret key. */
export async function getNotification(
  request: Request,
  config: ResolvedConfig,
  id: string,
): Promise<Response> {
  requireSecretKey(request, config)
  if (!isUuid(id)) throw new ApiError('not_found', 'Notification not found')

  const [notification] = await config.db
    .select()
    .from(notifications)
    .where(eq(notifications.id, id))
    .limit(1)

  if (!notification) throw new ApiError('not_found', 'Notification not found')

  const counts = await config.db
    .select({ type: events.type, count: sql<number>`count(*)::int` })
    .from(events)
    .where(eq(events.notificationId, id))
    .groupBy(events.type)

  const delivered = counts.find((c) => c.type === 'delivered')?.count ?? 0
  const opened = counts.find((c) => c.type === 'opened')?.count ?? 0

  return json({ ...serialise(notification), delivered, opened })
}

/** GET /notifications — most recent first. Auth: secret key. */
export async function listNotifications(
  request: Request,
  config: ResolvedConfig,
): Promise<Response> {
  requireSecretKey(request, config)

  const url = new URL(request.url)
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20) || 20, 1), 100)

  const rows = await config.db
    .select()
    .from(notifications)
    .orderBy(desc(notifications.createdAt))
    .limit(limit)

  return json({ notifications: rows.map(serialise) })
}

/**
 * POST|GET /cron/drain — continue unfinished sends. Auth: cron secret.
 *
 * Vercel Cron issues a GET, so both verbs are accepted.
 */
export async function cronDrain(request: Request, config: ResolvedConfig): Promise<Response> {
  const report = await drainOnce(config)

  // Chain onward so a large audience isn't paced by the cron interval — on a
  // Hobby plan that interval is a day. Skip it when the remaining work is
  // already claimed, or the two workers just take turns spinning.
  if (report.hasMore && !report.blocked) await triggerDrain(config)

  return json(report)
}

export function serialise(notification: Notification) {
  const { retryIds, leaseUntil, ...rest } = notification
  return { ...rest, pendingRetries: retryIds.length }
}

export { and }
