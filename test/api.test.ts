import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '../src/config.js'
import { notifications } from '../src/db/schema.js'
import { handleRequest } from '../src/http/router.js'
import { drainOnce } from '../src/notifications/drain.js'
import {
  CRON_SECRET,
  PUBLIC_KEY,
  SECRET_KEY,
  createTestConfig,
  fakeFcm,
  json,
  request,
  seedDevices,
} from './helpers.js'

let config: ResolvedConfig

beforeEach(async () => {
  config = await createTestConfig()
})

async function registerDevice() {
  const response = await handleRequest(
    request('POST', '/devices', {
      token: PUBLIC_KEY,
      body: { fcmToken: `token_${Math.random().toString(36).slice(2)}` },
    }),
    config,
  )
  return json(response)
}

describe('POST /notifications', () => {
  it('accepts a notification and reports it as queued', async () => {
    await seedDevices(config, 3)

    const response = await handleRequest(
      request('POST', '/notifications', {
        token: SECRET_KEY,
        body: { title: 'Popust', body: '20% samo danas', deeplink: 'app://promo' },
      }),
      config,
    )

    expect(response.status).toBe(202)
    const payload = await json(response)
    expect(payload.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(payload.status).toBe('pending')
    expect(payload.deeplink).toBe('app://promo')
  })

  it('requires the secret key', async () => {
    const response = await handleRequest(
      request('POST', '/notifications', {
        token: PUBLIC_KEY,
        body: { title: 'a', body: 'b' },
      }),
      config,
    )
    expect(response.status).toBe(401)
  })

  it('rejects a filter and a segment together', async () => {
    const response = await handleRequest(
      request('POST', '/notifications', {
        token: SECRET_KEY,
        body: {
          title: 'a',
          body: 'b',
          segment: 'pro',
          filter: { key: 'plan', op: 'eq', value: 'pro' },
        },
      }),
      config,
    )
    expect(response.status).toBe(400)
  })

  it('rejects an invalid filter with 422 and says why', async () => {
    const response = await handleRequest(
      request('POST', '/notifications', {
        token: SECRET_KEY,
        body: { title: 'a', body: 'b', filter: { key: 'age', op: 'gt', value: 'trideset' } },
      }),
      config,
    )

    expect(response.status).toBe(422)
    expect((await json(response)).error.message).toMatch(/not a number/)
  })

  it('404s on an unknown segment name', async () => {
    const response = await handleRequest(
      request('POST', '/notifications', {
        token: SECRET_KEY,
        body: { title: 'a', body: 'b', segment: 'ne-postoji' },
      }),
      config,
    )
    expect(response.status).toBe(404)
  })

  it('freezes the audience at creation time', async () => {
    await handleRequest(
      request('POST', '/segments', {
        token: SECRET_KEY,
        body: { name: 'pro', filter: { key: 'plan', op: 'eq', value: 'pro' } },
      }),
      config,
    )

    const created = await json(
      await handleRequest(
        request('POST', '/notifications', {
          token: SECRET_KEY,
          body: { title: 'a', body: 'b', segment: 'pro' },
        }),
        config,
      ),
    )

    // Editing the segment afterwards must not rewrite an in-flight send.
    await handleRequest(
      request('PUT', '/segments/pro', {
        token: SECRET_KEY,
        body: { filter: { key: 'plan', op: 'eq', value: 'free' } },
      }),
      config,
    )

    const [row] = await config.db
      .select()
      .from(notifications)
      .where(eq(notifications.id, created.id))

    expect(row?.filter).toEqual({ key: 'plan', op: 'eq', value: 'pro' })
  })
})

describe('segments', () => {
  it('creates, reads, updates and deletes a segment', async () => {
    await seedDevices(config, 10, (i) => ({ plan: i < 4 ? 'pro' : 'free' }))

    const created = await handleRequest(
      request('POST', '/segments', {
        token: SECRET_KEY,
        body: {
          name: 'pro-korisnici',
          description: 'Svi na pro planu',
          filter: { key: 'plan', op: 'eq', value: 'pro' },
        },
      }),
      config,
    )

    expect(created.status).toBe(201)
    expect((await json(created)).deviceCount).toBe(4)

    const fetched = await json(
      await handleRequest(request('GET', '/segments/pro-korisnici', { token: SECRET_KEY }), config),
    )
    expect(fetched.name).toBe('pro-korisnici')

    const updated = await json(
      await handleRequest(
        request('PUT', '/segments/pro-korisnici', {
          token: SECRET_KEY,
          body: { filter: { key: 'plan', op: 'eq', value: 'free' } },
        }),
        config,
      ),
    )
    expect(updated.deviceCount).toBe(6)

    const deleted = await handleRequest(
      request('DELETE', '/segments/pro-korisnici', { token: SECRET_KEY }),
      config,
    )
    expect(deleted.status).toBe(200)

    const gone = await handleRequest(
      request('GET', '/segments/pro-korisnici', { token: SECRET_KEY }),
      config,
    )
    expect(gone.status).toBe(404)
  })

  it('refuses a duplicate name', async () => {
    const body = { name: 'dupli', filter: { key: 'a', op: 'exists' } }
    await handleRequest(request('POST', '/segments', { token: SECRET_KEY, body }), config)
    const second = await handleRequest(
      request('POST', '/segments', { token: SECRET_KEY, body }),
      config,
    )
    expect(second.status).toBe(409)
  })
})

describe('POST /audience/count', () => {
  it('counts only active devices matching the filter', async () => {
    await seedDevices(config, 10, (i) => ({ city: i < 3 ? 'ST' : 'ZG' }))

    const response = await handleRequest(
      request('POST', '/audience/count', {
        token: SECRET_KEY,
        body: { filter: { key: 'city', op: 'eq', value: 'ST' } },
      }),
      config,
    )

    expect(await json(response)).toEqual({ count: 3 })
  })
})

describe('events', () => {
  it('records delivery and open events and folds them into the stats', async () => {
    const device = await registerDevice()

    const created = await json(
      await handleRequest(
        request('POST', '/notifications', {
          token: SECRET_KEY,
          body: { title: 'a', body: 'b' },
        }),
        config,
      ),
    )

    const response = await handleRequest(
      request('POST', `/devices/${device.deviceId}/events`, {
        token: device.deviceSecret,
        body: {
          events: [
            { notificationId: created.id, type: 'delivered' },
            { notificationId: created.id, type: 'opened' },
          ],
        },
      }),
      config,
    )

    expect(await json(response)).toEqual({ recorded: 2 })

    const stats = await json(
      await handleRequest(
        request('GET', `/notifications/${created.id}`, { token: SECRET_KEY }),
        config,
      ),
    )
    expect(stats.delivered).toBe(1)
    expect(stats.opened).toBe(1)
  })

  it('ignores a replayed flush instead of double counting', async () => {
    // A device that flushes, loses the response and retries must not inflate
    // the numbers — and must not get an error, or it retries forever.
    const device = await registerDevice()
    const created = await json(
      await handleRequest(
        request('POST', '/notifications', { token: SECRET_KEY, body: { title: 'a', body: 'b' } }),
        config,
      ),
    )

    const payload = {
      events: [{ notificationId: created.id, type: 'delivered' }],
    }

    for (let i = 0; i < 3; i++) {
      const response = await handleRequest(
        request('POST', `/devices/${device.deviceId}/events`, {
          token: device.deviceSecret,
          body: payload,
        }),
        config,
      )
      expect(response.status).toBe(200)
    }

    const stats = await json(
      await handleRequest(
        request('GET', `/notifications/${created.id}`, { token: SECRET_KEY }),
        config,
      ),
    )
    expect(stats.delivered).toBe(1)
  })

  it("rejects another device's secret", async () => {
    const mine = await registerDevice()
    const theirs = await registerDevice()
    const created = await json(
      await handleRequest(
        request('POST', '/notifications', { token: SECRET_KEY, body: { title: 'a', body: 'b' } }),
        config,
      ),
    )

    const response = await handleRequest(
      request('POST', `/devices/${theirs.deviceId}/events`, {
        token: mine.deviceSecret,
        body: { events: [{ notificationId: created.id, type: 'opened' }] },
      }),
      config,
    )

    expect(response.status).toBe(404)
  })
})

describe('cron drain endpoint', () => {
  it('requires the cron secret', async () => {
    const missing = await handleRequest(request('GET', '/cron/drain'), config)
    const wrong = await handleRequest(request('GET', '/cron/drain', { token: 'nope' }), config)

    expect(missing.status).toBe(401)
    expect(wrong.status).toBe(401)
  })

  it('finishes work left behind by an earlier invocation', async () => {
    await seedDevices(config, 5)
    await handleRequest(
      request('POST', '/notifications', { token: SECRET_KEY, body: { title: 'a', body: 'b' } }),
      config,
    )

    // The HTTP path builds a real FCM client, so drive the drain directly with a
    // fake sender — the point here is that the cron route is reachable and the
    // pending work gets picked up.
    const fcm = fakeFcm()
    const report = await drainOnce(config, { fcm })
    expect(report.sent).toBe(5)

    const after = await handleRequest(
      request('GET', '/cron/drain', { token: CRON_SECRET }),
      config,
    )
    expect(after.status).toBe(200)
    expect((await json(after)).hasMore).toBe(false)
  })
})
