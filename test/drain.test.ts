import { eq, inArray } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '../src/config.js'
import { devices, notifications } from '../src/db/schema.js'
import type { FcmSender } from '../src/fcm/client.js'
import { FcmConfigError, type FcmOutcome, type FcmSendItem } from '../src/fcm/types.js'
import { drainOnce } from '../src/notifications/drain.js'
import type { Filter } from '../src/segments/types.js'
import { createTestConfig, fakeFcm, seedDevices } from './helpers.js'

let config: ResolvedConfig

beforeEach(async () => {
  config = await createTestConfig({ batchSize: 500 })
})

async function queue(filter: Filter | null = null): Promise<string> {
  const [row] = await config.db
    .insert(notifications)
    .values({ title: 'Naslov', body: 'Tekst', filter, status: 'pending' })
    .returning()
  return row!.id
}

async function load(id: string) {
  const [row] = await config.db.select().from(notifications).where(eq(notifications.id, id))
  return row!
}

function sentIds(fcm: { calls: FcmSendItem[][] }): string[] {
  return fcm.calls.flat().map((item) => item.deviceId)
}

describe('drainOnce — the main pass', () => {
  it('walks a large audience in batches and counts every device once', async () => {
    await seedDevices(config, 1200)
    const id = await queue()
    const fcm = fakeFcm()

    const report = await drainOnce(config, { fcm })

    expect(fcm.calls.map((c) => c.length)).toEqual([500, 500, 200])
    expect(report.sent).toBe(1200)
    expect(report.hasMore).toBe(false)

    const notification = await load(id)
    expect(notification.status).toBe('completed')
    expect(notification.sentCount).toBe(1200)
    expect(notification.completedAt).not.toBeNull()

    expect(new Set(sentIds(fcm)).size).toBe(1200)
  })

  it('only targets devices matching the filter', async () => {
    await seedDevices(config, 30, (i) => ({ plan: i < 10 ? 'pro' : 'free' }))
    await queue({ key: 'plan', op: 'eq', value: 'pro' })
    const fcm = fakeFcm()

    const report = await drainOnce(config, { fcm })

    expect(report.sent).toBe(10)
  })

  it('skips devices already deactivated', async () => {
    const ids = await seedDevices(config, 10)
    await config.db
      .update(devices)
      .set({ active: false })
      .where(inArray(devices.id, ids.slice(0, 4)))

    await queue()
    const fcm = fakeFcm()

    expect((await drainOnce(config, { fcm })).sent).toBe(6)
  })

  it('completes with zero sends when nobody matches', async () => {
    await seedDevices(config, 5, () => ({ plan: 'free' }))
    const id = await queue({ key: 'plan', op: 'eq', value: 'pro' })
    const fcm = fakeFcm()

    const report = await drainOnce(config, { fcm })

    expect(report.sent).toBe(0)
    expect((await load(id)).status).toBe('completed')
  })
})

describe('drainOnce — resuming after the clock runs out', () => {
  it('saves its cursor and resumes without resending anyone', async () => {
    await seedDevices(config, 1200)
    const id = await queue()

    // Each batch takes longer than the budget, so exactly one goes out per call:
    // the deadline is checked at the top of the loop.
    const slowFcm: FcmSender & { calls: FcmSendItem[][] } = {
      calls: [],
      async send(items: FcmSendItem[]): Promise<FcmOutcome[]> {
        this.calls.push(items)
        await new Promise((resolve) => setTimeout(resolve, 30))
        return items.map((item) => ({
          status: 'sent' as const,
          deviceId: item.deviceId,
          messageId: 'x',
        }))
      },
    }

    const first = await drainOnce(config, { fcm: slowFcm, timeBudgetMs: 10 })
    expect(first.hasMore).toBe(true)
    expect(slowFcm.calls).toHaveLength(1)

    const afterFirst = await load(id)
    expect(afterFirst.status).toBe('sending')
    expect(afterFirst.cursor).not.toBeNull()
    // The lease is handed back, so the next invocation can claim it immediately
    // instead of waiting a minute for the lease to lapse.
    expect(afterFirst.leaseUntil).toBeNull()

    const second = await drainOnce(config, { fcm: slowFcm, timeBudgetMs: 30_000 })
    expect(second.hasMore).toBe(false)

    const all = sentIds(slowFcm)
    expect(all).toHaveLength(1200)
    expect(new Set(all).size).toBe(1200)
    expect((await load(id)).sentCount).toBe(1200)
  })
})

describe('drainOnce — failure handling', () => {
  it('deactivates devices FCM reports as unregistered', async () => {
    const ids = await seedDevices(config, 10)
    const dead = new Set(ids.slice(0, 3))
    const id = await queue()

    const fcm = fakeFcm((item) => (dead.has(item.deviceId) ? 'invalid_token' : 'sent'))
    const report = await drainOnce(config, { fcm })

    expect(report.sent).toBe(7)
    expect(report.deactivated).toBe(3)

    const rows = await config.db
      .select({ id: devices.id, active: devices.active })
      .from(devices)
      .where(inArray(devices.id, [...dead]))

    expect(rows.every((r) => r.active === false)).toBe(true)
    // The row survives so its attributes are still there after a reinstall.
    expect(rows).toHaveLength(3)

    expect((await load(id)).failedCount).toBe(3)
  })

  it('retries transient failures after the main pass and leaves the device active', async () => {
    const ids = await seedDevices(config, 10)
    const flaky = ids[0]!
    const id = await queue()

    let attempts = 0
    const fcm = fakeFcm((item) => {
      if (item.deviceId !== flaky) return 'sent'
      attempts += 1
      return attempts === 1 ? 'retryable' : 'sent'
    })

    const report = await drainOnce(config, { fcm })

    expect(attempts).toBe(2)
    expect(report.sent).toBe(10)

    const notification = await load(id)
    expect(notification.status).toBe('completed')
    expect(notification.sentCount).toBe(10)
    expect(notification.failedCount).toBe(0)
    expect(notification.retryIds).toEqual([])
    expect(notification.retryRound).toBeGreaterThan(0)

    const [row] = await config.db.select().from(devices).where(eq(devices.id, flaky))
    expect(row?.active).toBe(true)
  })

  it('gives up on a permanently unavailable device and counts it failed', async () => {
    await seedDevices(config, 3)
    const id = await queue()

    const fcm = fakeFcm(() => 'retryable')
    const report = await drainOnce(config, { fcm })

    const notification = await load(id)
    expect(notification.status).toBe('completed')
    expect(notification.sentCount).toBe(0)
    // 3 devices, abandoned once the retry rounds ran out — not silently dropped.
    expect(notification.failedCount).toBe(3)
    expect(report.hasMore).toBe(false)
  })

  it('fails the whole notification on a credentials error instead of the whole audience', async () => {
    await seedDevices(config, 50)
    const id = await queue()

    const brokenFcm: FcmSender = {
      async send() {
        throw new FcmConfigError('FCM rejected our credentials (401)', 401)
      },
    }

    const report = await drainOnce(config, { fcm: brokenFcm })

    const notification = await load(id)
    expect(notification.status).toBe('failed')
    expect(notification.error).toContain('401')
    // Nobody is marked failed — the devices did nothing wrong.
    expect(notification.failedCount).toBe(0)
    expect(report.hasMore).toBe(false)
  })
})

describe('drainOnce — claiming work', () => {
  it('processes queued notifications oldest first', async () => {
    await seedDevices(config, 2)
    const first = await queue()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await queue()

    const fcm = fakeFcm()
    await drainOnce(config, { fcm, maxNotifications: 1 })

    expect((await load(first)).status).toBe('completed')
    expect((await load(second)).status).toBe('pending')
  })

  it('does nothing when there is no work', async () => {
    const fcm = fakeFcm()
    const report = await drainOnce(config, { fcm })

    expect(report).toMatchObject({ processed: 0, sent: 0, hasMore: false })
    expect(fcm.calls).toHaveLength(0)
  })

  it('leaves a leased notification alone until the lease lapses', async () => {
    await seedDevices(config, 2)
    const id = await queue()

    // Simulate a worker that claimed the row and then died.
    await config.db
      .update(notifications)
      .set({ status: 'sending', leaseUntil: new Date(Date.now() + 60_000) })
      .where(eq(notifications.id, id))

    const fcm = fakeFcm()
    const report = await drainOnce(config, { fcm })

    expect(fcm.calls).toHaveLength(0)
    // Still unfinished, so the caller knows to come back — but flagged as
    // someone else's work so it doesn't chain into a spin.
    expect(report.hasMore).toBe(true)
    expect(report.blocked).toBe(true)
  })

  it('picks up a notification whose lease has expired', async () => {
    await seedDevices(config, 2)
    const id = await queue()

    await config.db
      .update(notifications)
      .set({ status: 'sending', leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(notifications.id, id))

    const fcm = fakeFcm()
    await drainOnce(config, { fcm })

    expect((await load(id)).status).toBe('completed')
  })

  it('claims without opening a transaction', async () => {
    await seedDevices(config, 1)
    await queue()

    // `neon-http` sends every statement as its own HTTP request and throws on
    // `transaction()`. Standing in for it here so a reintroduced transaction
    // fails the suite instead of only failing in production.
    const httpOnlyDb = new Proxy(config.db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return () => {
            throw new Error('No transactions support in neon-http driver')
          }
        }
        return Reflect.get(target, property, receiver)
      },
    })

    const report = await drainOnce({ ...config, db: httpOnlyDb }, { fcm: fakeFcm() })

    expect(report.sent).toBe(1)
  })
})

describe('drainOnce — targeting one notification', () => {
  it('sends the notification it was given, not the oldest one queued', async () => {
    await seedDevices(config, 1)

    // A notification stuck at the head of the queue — a send that died before
    // finishing, which is exactly what a failed claim used to leave behind.
    const stuck = await queue()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const fresh = await queue()

    const fcm = fakeFcm()
    await drainOnce(config, { fcm, notificationId: fresh })

    expect((await load(fresh)).status).toBe('completed')
    // Untargeted, this drain would have picked `stuck` and the caller would
    // have received the previous notification instead of the one just sent.
    expect((await load(stuck)).status).toBe('pending')
  })

  it('reports the backlog as remaining work so the caller still chains', async () => {
    await seedDevices(config, 1)
    await queue()
    const fresh = await queue()

    const report = await drainOnce(config, { fcm: fakeFcm(), notificationId: fresh })

    expect(report.processed).toBe(1)
    expect(report.hasMore).toBe(true)
    expect(report.blocked).toBe(false)
  })

  it('does not chain when the target is already leased by another worker', async () => {
    await seedDevices(config, 1)
    const id = await queue()

    await config.db
      .update(notifications)
      .set({ status: 'sending', leaseUntil: new Date(Date.now() + 60_000) })
      .where(eq(notifications.id, id))

    const fcm = fakeFcm()
    const report = await drainOnce(config, { fcm, notificationId: id })

    expect(fcm.calls).toHaveLength(0)
    expect(report).toMatchObject({ hasMore: true, blocked: true })
  })

  it('is a no-op once the target has completed', async () => {
    await seedDevices(config, 1)
    const id = await queue()

    await drainOnce(config, { fcm: fakeFcm(), notificationId: id })
    const second = await drainOnce(config, { fcm: fakeFcm(), notificationId: id })

    expect(second).toMatchObject({ processed: 0, hasMore: false, blocked: false })
  })
})
