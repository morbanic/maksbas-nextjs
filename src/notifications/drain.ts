import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type { ResolvedConfig } from '../config.js'
import {
  type Notification,
  UNFINISHED_STATUSES,
  devices,
  notifications,
} from '../db/schema.js'
import { type FcmSender, createFcmClient } from '../fcm/client.js'
import { FcmConfigError, type FcmOutcome, type FcmSendItem } from '../fcm/types.js'
import { PayloadTooLargeError, buildPayload } from './payload.js'
import { compileFilter } from '../segments/compile.js'

/** Transient failures get this many replay rounds before being counted as failed. */
const MAX_RETRY_ROUNDS = 3

/** How long a claim survives if the worker holding it dies. */
const LEASE_MS = 60_000

export interface DrainOptions {
  /** Injected in tests; defaults to a real FCM client built from the config. */
  fcm?: FcmSender
  /** Stop after this many notifications even if time remains. @default 10 */
  maxNotifications?: number
  /** Overrides the configured time budget for this call. */
  timeBudgetMs?: number
}

export interface DrainReport {
  /** Notifications touched during this invocation. */
  processed: number
  sent: number
  failed: number
  deactivated: number
  /** True when work remains — by us, or by whoever holds the lease. */
  hasMore: boolean
  /**
   * True when the only remaining work is claimed by another worker. Callers use
   * this to decide *not* to chain: firing another invocation immediately would
   * just spin against a lease that is already being worked.
   */
  blocked: boolean
}

/**
 * Does as much sending as fits in the time budget, then saves its position.
 *
 * Everything here assumes the process can be killed at any moment: work is
 * claimed under a lease, progress is a cursor persisted after every batch, and
 * restarting just re-reads the cursor. That is what makes serverless delivery
 * survivable — the request that started the send is long gone by the time the
 * last batch goes out.
 */
export async function drainOnce(
  config: ResolvedConfig,
  options: DrainOptions = {},
): Promise<DrainReport> {
  const budget = options.timeBudgetMs ?? config.timeBudgetMs
  const deadline = Date.now() + budget
  const maxNotifications = options.maxNotifications ?? 10

  const fcm =
    options.fcm ??
    createFcmClient({
      serviceAccount: config.fcm.serviceAccount,
      concurrency: config.concurrency,
    })

  const report: DrainReport = {
    processed: 0,
    sent: 0,
    failed: 0,
    deactivated: 0,
    hasMore: false,
    blocked: false,
  }

  while (Date.now() < deadline && report.processed < maxNotifications) {
    const claimed = await claimNotification(config)

    if (!claimed) {
      // Nothing claimable. Either everything is done, or someone else holds the
      // only outstanding lease — very different situations for the caller.
      if (await hasUnfinishedWork(config)) {
        report.hasMore = true
        report.blocked = true
      }
      return report
    }

    report.processed += 1
    const result = await processNotification(config, fcm, claimed, deadline)

    report.sent += result.sent
    report.failed += result.failed
    report.deactivated += result.deactivated

    if (!result.finished) {
      report.hasMore = true
      return report
    }
  }

  report.hasMore = report.hasMore || (await hasUnfinishedWork(config))
  return report
}

/**
 * Takes exclusive ownership of one unfinished notification.
 *
 * `FOR UPDATE SKIP LOCKED` plus the lease is what keeps the three drain triggers
 * — inline, self-chain and cron — from sending the same batch three times.
 */
async function claimNotification(config: ResolvedConfig): Promise<Notification | null> {
  return config.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(notifications)
      .where(
        and(
          inArray(notifications.status, [...UNFINISHED_STATUSES]),
          or(isNull(notifications.leaseUntil), lt(notifications.leaseUntil, new Date())),
        ),
      )
      .orderBy(asc(notifications.createdAt))
      .limit(1)
      .for('update', { skipLocked: true })

    if (!row) return null

    const [claimed] = await tx
      .update(notifications)
      .set({
        status: row.status === 'pending' ? 'sending' : row.status,
        leaseUntil: new Date(Date.now() + LEASE_MS),
        startedAt: row.startedAt ?? new Date(),
      })
      .where(eq(notifications.id, row.id))
      .returning()

    return claimed ?? null
  })
}

interface ProcessResult {
  sent: number
  failed: number
  deactivated: number
  /** False means the deadline hit mid-send and the cursor was saved. */
  finished: boolean
}

async function processNotification(
  config: ResolvedConfig,
  fcm: FcmSender,
  initial: Notification,
  deadline: number,
): Promise<ProcessResult> {
  const result: ProcessResult = { sent: 0, failed: 0, deactivated: 0, finished: false }
  let current = initial

  let payload: ReturnType<typeof buildPayload>
  try {
    payload = buildPayload(current)
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      await fail(config, current.id, error.message)
      result.finished = true
      return result
    }
    throw error
  }

  try {
    while (Date.now() < deadline) {
      const step =
        current.status === 'retrying'
          ? await retryStep(config, current)
          : await cursorStep(config, current)

      if (step.exhausted) {
        current = await advancePhase(config, current)
        if (current.status === 'completed') {
          result.finished = true
          return result
        }
        continue
      }

      if (step.items.length === 0) {
        // The window existed but every device in it is gone or deactivated.
        // Consume it anyway, or the round never ends.
        current = await update(config, current.id, {
          retryQueue: step.remainingQueue ?? current.retryQueue,
          leaseUntil: new Date(Date.now() + LEASE_MS),
        })
        continue
      }

      const outcomes = await fcm.send(step.items, payload)
      const applied = await applyOutcomes(config, current, step, outcomes)

      result.sent += applied.sent
      result.failed += applied.failed
      result.deactivated += applied.deactivated
      current = applied.notification
    }

    // Out of time with work remaining. The cursor is already persisted, so hand
    // the claim back rather than making the next worker wait out the lease.
    await releaseLease(config, current.id)
    return result
  } catch (error) {
    if (error instanceof FcmConfigError) {
      // Credentials or project misconfiguration. Marking the whole audience
      // failed one device at a time would be noise — stop and surface it.
      await fail(config, current.id, error.message)
      result.finished = true
      return result
    }
    await releaseLease(config, current.id)
    throw error
  }
}

interface Step {
  items: FcmSendItem[]
  /** True when this phase has no work left at all. */
  exhausted: boolean
  /** Retry phase only: what `retryQueue` becomes once this window is consumed. */
  remainingQueue?: string[]
}

/** Next page of the main pass: active devices matching the filter, ordered by id. */
async function cursorStep(config: ResolvedConfig, notification: Notification): Promise<Step> {
  const conditions = [eq(devices.active, true), compileFilter(notification.filter ?? null)]
  if (notification.cursor) conditions.push(gt(devices.id, notification.cursor))

  const rows = await config.db
    .select({ deviceId: devices.id, fcmToken: devices.fcmToken })
    .from(devices)
    .where(and(...conditions))
    .orderBy(asc(devices.id))
    .limit(config.batchSize)

  return { items: rows, exhausted: rows.length === 0 }
}

/**
 * Next window of the replay round.
 *
 * The window is consumed by position, not by which devices came back. A device
 * that was deactivated between the failure and the replay simply isn't in
 * `items` — if the queue only shrank by what came back, that device would sit at
 * the head of the queue forever.
 */
async function retryStep(config: ResolvedConfig, notification: Notification): Promise<Step> {
  const window = notification.retryQueue.slice(0, config.batchSize)
  if (window.length === 0) return { items: [], exhausted: true }

  const rows = await config.db
    .select({ deviceId: devices.id, fcmToken: devices.fcmToken })
    .from(devices)
    .where(and(inArray(devices.id, window), eq(devices.active, true)))

  return {
    items: rows,
    exhausted: false,
    remainingQueue: notification.retryQueue.slice(window.length),
  }
}

/**
 * Called when the current phase runs dry. Starts the next retry round from the
 * accumulated ids, or finishes the notification.
 *
 * Promoting `retryIds` into `retryQueue` and clearing it is what bounds the
 * replay: a round works through a fixed snapshot, and anything that fails again
 * lands in a fresh accumulator only the *next* round will look at.
 */
async function advancePhase(
  config: ResolvedConfig,
  notification: Notification,
): Promise<Notification> {
  const pending = notification.retryIds
  const roundsLeft = notification.retryRound < MAX_RETRY_ROUNDS

  if (pending.length > 0 && roundsLeft) {
    return update(config, notification.id, {
      status: 'retrying',
      retryQueue: pending,
      retryIds: [],
      retryRound: notification.retryRound + 1,
      leaseUntil: new Date(Date.now() + LEASE_MS),
    })
  }

  // Anything still parked has exhausted its rounds — count it as failed so the
  // numbers add up against the audience size instead of quietly vanishing.
  return update(config, notification.id, {
    status: 'completed',
    completedAt: new Date(),
    leaseUntil: null,
    retryIds: [],
    retryQueue: [],
    failedCount: notification.failedCount + pending.length,
  })
}

async function applyOutcomes(
  config: ResolvedConfig,
  notification: Notification,
  step: Step,
  outcomes: FcmOutcome[],
): Promise<{ sent: number; failed: number; deactivated: number; notification: Notification }> {
  const invalid: string[] = []
  const retryable: string[] = []
  let sent = 0
  let failed = 0

  for (const outcome of outcomes) {
    switch (outcome.status) {
      case 'sent':
        sent += 1
        break
      case 'invalid_token':
        invalid.push(outcome.deviceId)
        failed += 1
        break
      case 'retryable':
        retryable.push(outcome.deviceId)
        break
      case 'failed':
        failed += 1
        break
    }
  }

  if (invalid.length > 0) {
    // Keep the row: its attributes stay useful if the user reinstalls, and
    // deleting would cascade away this notification's delivery events.
    await config.db
      .update(devices)
      .set({ active: false, updatedAt: new Date() })
      .where(inArray(devices.id, invalid))
  }

  const patch: Partial<typeof notifications.$inferInsert> = {
    sentCount: notification.sentCount + sent,
    failedCount: notification.failedCount + failed,
    // Failures always accumulate for the *next* round, never back into the queue
    // this batch was drawn from.
    retryIds: [...notification.retryIds, ...retryable],
    leaseUntil: new Date(Date.now() + LEASE_MS),
  }

  if (step.remainingQueue !== undefined) {
    patch.retryQueue = step.remainingQueue
  } else {
    const last = step.items[step.items.length - 1]
    if (last) patch.cursor = last.deviceId
  }

  const updated = await update(config, notification.id, patch)
  return { sent, failed, deactivated: invalid.length, notification: updated }
}

async function update(
  config: ResolvedConfig,
  id: string,
  patch: Partial<typeof notifications.$inferInsert>,
): Promise<Notification> {
  const [row] = await config.db
    .update(notifications)
    .set(patch)
    .where(eq(notifications.id, id))
    .returning()
  if (!row) throw new Error(`[maksbas] notification ${id} vanished mid-send`)
  return row
}

async function fail(config: ResolvedConfig, id: string, message: string): Promise<void> {
  await config.db
    .update(notifications)
    .set({
      status: 'failed',
      error: message.slice(0, 2000),
      completedAt: new Date(),
      leaseUntil: null,
    })
    .where(eq(notifications.id, id))
}

/** Hands the claim back early so the next invocation can pick it up immediately. */
async function releaseLease(config: ResolvedConfig, id: string): Promise<void> {
  await config.db
    .update(notifications)
    .set({ leaseUntil: null })
    .where(eq(notifications.id, id))
}

export async function hasUnfinishedWork(config: ResolvedConfig): Promise<boolean> {
  const [row] = await config.db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(inArray(notifications.status, [...UNFINISHED_STATUSES]))
  return (row?.count ?? 0) > 0
}
