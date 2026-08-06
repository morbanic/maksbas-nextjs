import type { ResolvedConfig } from '../config.js'
import { type EventType, events } from '../db/schema.js'
import { readJson } from '../http/body.js'
import { isUuid, requireDevice } from '../http/auth.js'
import { ApiError, json } from '../http/errors.js'

const VALID_TYPES: ReadonlySet<string> = new Set<EventType>(['delivered', 'opened'])

/** One request may carry a whole flush queue, but not an unbounded one. */
const MAX_EVENTS_PER_REQUEST = 200

interface EventInput {
  notificationId?: unknown
  type?: unknown
}

/**
 * POST /devices/:id/events — record delivery and open events. Auth: device secret.
 *
 * Batched on purpose: the SDK queues events and flushes them together, so a
 * 50k-device send lands as a few thousand inserts rather than 50k round trips.
 *
 * Duplicates are ignored rather than rejected. A device that flushes, loses the
 * response, and retries must not double-count — and must not see an error either,
 * or it will keep retrying forever.
 */
export async function recordEvents(
  request: Request,
  config: ResolvedConfig,
  deviceId: string,
): Promise<Response> {
  const device = await requireDevice(request, config, deviceId)

  const body = await readJson<{ events?: unknown }>(request)
  const raw = Array.isArray(body.events) ? body.events : null

  if (!raw) throw new ApiError('bad_request', '`events` must be an array')
  if (raw.length === 0) return json({ recorded: 0 })
  if (raw.length > MAX_EVENTS_PER_REQUEST) {
    throw new ApiError(
      'bad_request',
      `At most ${MAX_EVENTS_PER_REQUEST} events per request (got ${raw.length})`,
    )
  }

  const rows = (raw as EventInput[]).map((event, index) => {
    const notificationId = event.notificationId
    if (typeof notificationId !== 'string' || !isUuid(notificationId)) {
      throw new ApiError('bad_request', `events[${index}].notificationId must be a UUID`)
    }
    if (typeof event.type !== 'string' || !VALID_TYPES.has(event.type)) {
      throw new ApiError(
        'bad_request',
        `events[${index}].type must be "delivered" or "opened"`,
      )
    }
    return { notificationId, deviceId: device.id, type: event.type as EventType }
  })

  // A notification that has since been deleted takes its events with it via the
  // FK, so an insert referencing one races with deletion. Failing the whole
  // batch for that would strand the device's queue — swallow and report zero.
  try {
    await config.db.insert(events).values(rows).onConflictDoNothing()
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      return json({ recorded: 0, ignored: rows.length })
    }
    throw error
  }

  return json({ recorded: rows.length })
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23503'
  )
}
