import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '../src/config.js'
import { devices } from '../src/db/schema.js'
import { handleRequest } from '../src/http/router.js'
import { PUBLIC_KEY, SECRET_KEY, createTestConfig, json, request } from './helpers.js'

let config: ResolvedConfig

beforeEach(async () => {
  config = await createTestConfig()
})

async function register(body: Record<string, unknown> = {}) {
  const response = await handleRequest(
    request('POST', '/devices', {
      token: PUBLIC_KEY,
      body: { fcmToken: `token_${Math.random().toString(36).slice(2)}`, ...body },
    }),
    config,
  )
  return { response, payload: await json(response) }
}

describe('POST /devices', () => {
  it('registers a device and returns a secret exactly once', async () => {
    const { response, payload } = await register()

    expect(response.status).toBe(201)
    expect(payload.deviceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(payload.deviceSecret).toBeTypeOf('string')
    expect(payload.deviceSecret.length).toBeGreaterThan(20)
  })

  it('never stores the secret in plaintext', async () => {
    const { payload } = await register()

    const [row] = await config.db
      .select()
      .from(devices)
      .where(eq(devices.id, payload.deviceId))

    expect(row?.secretHash).not.toBe(payload.deviceSecret)
    expect(row?.secretHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('updates the existing row when the same FCM token registers again', async () => {
    // Android hands back the same token on every launch. One row per launch
    // would mean one copy of every notification per launch.
    const token = 'stable_token'
    const first = await handleRequest(
      request('POST', '/devices', { token: PUBLIC_KEY, body: { fcmToken: token } }),
      config,
    )
    const second = await handleRequest(
      request('POST', '/devices', { token: PUBLIC_KEY, body: { fcmToken: token } }),
      config,
    )

    const a = await json(first)
    const b = await json(second)

    expect(b.deviceId).toBe(a.deviceId)
    expect(b.deviceSecret).not.toBe(a.deviceSecret)

    const rows = await config.db.select().from(devices)
    expect(rows).toHaveLength(1)
  })

  it('keeps attributes across re-registration', async () => {
    const token = 'stable_token'
    await handleRequest(
      request('POST', '/devices', {
        token: PUBLIC_KEY,
        body: { fcmToken: token, attributes: { plan: 'pro' } },
      }),
      config,
    )
    const again = await handleRequest(
      request('POST', '/devices', { token: PUBLIC_KEY, body: { fcmToken: token } }),
      config,
    )

    // Wiping segmentation data on every app launch would be silent and awful.
    expect((await json(again)).attributes).toEqual({ plan: 'pro' })
  })

  it('rejects a missing or wrong public key', async () => {
    const missing = await handleRequest(
      request('POST', '/devices', { body: { fcmToken: 'x' } }),
      config,
    )
    const wrong = await handleRequest(
      request('POST', '/devices', { token: 'pk_nope', body: { fcmToken: 'x' } }),
      config,
    )

    expect(missing.status).toBe(401)
    expect(wrong.status).toBe(401)
  })

  it('rejects the secret key on a device endpoint', async () => {
    const response = await handleRequest(
      request('POST', '/devices', { token: SECRET_KEY, body: { fcmToken: 'x' } }),
      config,
    )
    expect(response.status).toBe(401)
  })
})

describe('PATCH /devices/:id/attributes', () => {
  it('merges a patch onto existing attributes', async () => {
    const { payload } = await register({ attributes: { plan: 'free', city: 'ST' } })

    const response = await handleRequest(
      request('PATCH', `/devices/${payload.deviceId}/attributes`, {
        token: payload.deviceSecret,
        body: { plan: 'pro' },
      }),
      config,
    )

    expect(await json(response)).toEqual({ attributes: { plan: 'pro', city: 'ST' } })
  })

  it('deletes a key when the value is null', async () => {
    // This is the logout story: there is no dedicated user field, so clearing
    // one has to be expressible.
    const { payload } = await register({ attributes: { userId: 'user_8123', plan: 'pro' } })

    const response = await handleRequest(
      request('PATCH', `/devices/${payload.deviceId}/attributes`, {
        token: payload.deviceSecret,
        body: { userId: null },
      }),
      config,
    )

    expect(await json(response)).toEqual({ attributes: { plan: 'pro' } })
  })

  it('coerces numbers and booleans to strings', async () => {
    const { payload } = await register()

    const response = await handleRequest(
      request('PATCH', `/devices/${payload.deviceId}/attributes`, {
        token: payload.deviceSecret,
        body: { age: 34, vip: true },
      }),
      config,
    )

    expect(await json(response)).toEqual({ attributes: { age: '34', vip: 'true' } })
  })

  it('rejects nested objects', async () => {
    const { payload } = await register()

    const response = await handleRequest(
      request('PATCH', `/devices/${payload.deviceId}/attributes`, {
        token: payload.deviceSecret,
        body: { profile: { city: 'ST' } },
      }),
      config,
    )

    expect(response.status).toBe(400)
  })

  it("refuses another device's secret", async () => {
    const mine = await register()
    const theirs = await register()

    const response = await handleRequest(
      request('PATCH', `/devices/${theirs.payload.deviceId}/attributes`, {
        token: mine.payload.deviceSecret,
        body: { plan: 'pro' },
      }),
      config,
    )

    // 404 rather than 403 — a 403 would confirm the device id exists.
    expect(response.status).toBe(404)

    const [row] = await config.db
      .select()
      .from(devices)
      .where(eq(devices.id, theirs.payload.deviceId))
    expect(row?.attributes).toEqual({})
  })

  it('enforces the attribute count limit', async () => {
    const { payload } = await register()
    const tooMany = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`key_${i}`, 'value']),
    )

    const response = await handleRequest(
      request('PATCH', `/devices/${payload.deviceId}/attributes`, {
        token: payload.deviceSecret,
        body: tooMany,
      }),
      config,
    )

    expect(response.status).toBe(400)
  })
})

describe('device lifecycle', () => {
  it('rotates the FCM token', async () => {
    const { payload } = await register()

    const response = await handleRequest(
      request('PATCH', `/devices/${payload.deviceId}`, {
        token: payload.deviceSecret,
        body: { fcmToken: 'rotated_token', notificationsEnabled: true },
      }),
      config,
    )

    const updated = await json(response)
    expect(updated.fcmToken).toBe('rotated_token')
    expect(updated.notificationsEnabled).toBe(true)
    expect(updated.secretHash).toBeUndefined()
  })

  it('deletes the device', async () => {
    const { payload } = await register()

    const response = await handleRequest(
      request('DELETE', `/devices/${payload.deviceId}`, { token: payload.deviceSecret }),
      config,
    )

    expect(response.status).toBe(200)
    expect(await config.db.select().from(devices)).toHaveLength(0)
  })
})

describe('routing', () => {
  it('does not let /devices/:id swallow /devices/query', async () => {
    const response = await handleRequest(
      request('POST', '/devices/query', { token: SECRET_KEY, body: {} }),
      config,
    )
    expect(response.status).toBe(200)
  })

  it('answers 405 with an Allow header on a wrong verb', async () => {
    const response = await handleRequest(request('PUT', '/devices', { token: SECRET_KEY }), config)
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toContain('POST')
  })

  it('answers 404 on an unknown path', async () => {
    const response = await handleRequest(request('GET', '/nope', { token: SECRET_KEY }), config)
    expect(response.status).toBe(404)
  })
})
