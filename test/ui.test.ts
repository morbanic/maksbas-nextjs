import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '../src/config.js'
import { devices, notifications } from '../src/db/schema.js'
import { createAdminHandler } from '../src/ui/index.js'
import { PUBLIC_KEY, SECRET_KEY, createTestConfig, json, seedDevices } from './helpers.js'

const ADMIN_PATH = '/admin/maksbas'
const PASSWORD = 'dashboard-password'

let config: ResolvedConfig
let admin: ReturnType<typeof createAdminHandler>

beforeEach(async () => {
  config = await createTestConfig()
  admin = createAdminHandler({
    db: config.db,
    publicKey: PUBLIC_KEY,
    secretKey: SECRET_KEY,
    fcm: { serviceAccount: config.fcm.serviceAccount },
    password: PASSWORD,
    selfChain: false,
    inlineDrainMs: 0,
  })
})

function call(
  method: string,
  path: string,
  { body, cookie, csrf = true }: { body?: unknown; cookie?: string; csrf?: boolean } = {},
): Promise<Response> {
  return admin(
    new Request(`http://localhost${ADMIN_PATH}${path}`, {
      method,
      headers: {
        ...(csrf ? { 'x-maksbas-admin': '1' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )
}

/** Logs in and returns the cookie header every other request needs. */
async function signIn(): Promise<string> {
  const response = await call('POST', '/session', { body: { password: PASSWORD } })
  expect(response.status).toBe(200)

  const setCookie = response.headers.get('set-cookie')
  expect(setCookie).toBeTruthy()
  return (setCookie as string).split(';')[0] as string
}

describe('admin UI — the page', () => {
  it('serves a self-contained document at the mount point', async () => {
    const response = await call('GET', '')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    // Nothing to fetch from a CDN, and nothing for a crawler to index.
    expect(response.headers.get('x-robots-tag')).toContain('noindex')

    const body = await response.text()
    expect(body).toContain('<!doctype html>')
    expect(body).not.toMatch(/<script[^>]+src=/)
    expect(body).not.toMatch(/<link[^>]+stylesheet/)
  })

  it('serves the page rather than a 404 for unknown sub-paths', async () => {
    expect((await call('GET', '/anything')).status).toBe(200)
  })

  it('never puts the secret key in the document', async () => {
    const body = await (await call('GET', '')).text()
    expect(body).not.toContain(SECRET_KEY)
    expect(body).not.toContain(PASSWORD)
  })
})

describe('admin UI — authentication', () => {
  it('reports an anonymous visitor as signed out', async () => {
    const response = await call('GET', '/session')
    expect(await json(response)).toEqual({ authenticated: false })
  })

  it('refuses the wrong password', async () => {
    const response = await call('POST', '/session', { body: { password: 'nope' } })

    expect(response.status).toBe(401)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('issues an HttpOnly session cookie on the right password', async () => {
    const response = await call('POST', '/session', { body: { password: PASSWORD } })
    const setCookie = response.headers.get('set-cookie') ?? ''

    expect(response.status).toBe(200)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    // The cookie is a signed expiry, not the credential itself.
    expect(setCookie).not.toContain(PASSWORD)
    expect(setCookie).not.toContain(SECRET_KEY)
  })

  it('accepts the secret key as the password when none is configured', async () => {
    const fallback = createAdminHandler({
      db: config.db,
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY,
      fcm: { serviceAccount: config.fcm.serviceAccount },
    })

    const response = await fallback(
      new Request(`http://localhost${ADMIN_PATH}/session`, {
        method: 'POST',
        headers: { 'x-maksbas-admin': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ password: SECRET_KEY }),
      }),
    )

    expect(response.status).toBe(200)
  })

  it('guards every data endpoint behind the session', async () => {
    const paths = ['/api/overview', '/api/devices', '/api/notifications', '/api/segments']
    for (const path of paths) {
      expect((await call('GET', path)).status).toBe(401)
    }
  })

  it('rejects a forged cookie', async () => {
    const forged = `maksbas_admin=${Date.now() + 60_000}.deadbeef`
    expect((await call('GET', '/api/overview', { cookie: forged })).status).toBe(401)
  })

  it('rejects an expired cookie', async () => {
    const shortLived = createAdminHandler({
      db: config.db,
      publicKey: PUBLIC_KEY,
      secretKey: SECRET_KEY,
      fcm: { serviceAccount: config.fcm.serviceAccount },
      password: PASSWORD,
      sessionMaxAgeSeconds: -1,
    })

    const login = await shortLived(
      new Request(`http://localhost${ADMIN_PATH}/session`, {
        method: 'POST',
        headers: { 'x-maksbas-admin': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      }),
    )
    const cookie = (login.headers.get('set-cookie') as string).split(';')[0] as string

    const response = await shortLived(
      new Request(`http://localhost${ADMIN_PATH}/api/overview`, { headers: { cookie } }),
    )
    expect(response.status).toBe(401)
  })

  it('blocks a write that carries no same-origin header', async () => {
    const cookie = await signIn()
    const ids = await seedDevices(config, 1)

    const response = await call('DELETE', `/api/devices/${ids[0]}`, { cookie, csrf: false })
    expect(response.status).toBe(403)

    // And the device is still there.
    const rows = await config.db.select().from(devices)
    expect(rows).toHaveLength(1)
  })

  it('signs out by clearing the cookie', async () => {
    const cookie = await signIn()
    const response = await call('DELETE', '/session', { cookie })

    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  })
})

describe('admin UI — devices', () => {
  it('lists devices without exposing the secret hash or the full token', async () => {
    const cookie = await signIn()
    await seedDevices(config, 3, (i) => ({ plan: i === 0 ? 'pro' : 'free' }))

    const payload = await json(await call('GET', '/api/devices', { cookie }))

    expect(payload.total).toBe(3)
    expect(payload.devices).toHaveLength(3)
    for (const device of payload.devices) {
      expect(device.secretHash).toBeUndefined()
      expect(device.fcmToken).toBeUndefined()
      expect(device.fcmTokenPreview).toContain('…')
    }
  })

  it('searches across attributes', async () => {
    const cookie = await signIn()
    await seedDevices(config, 5, (i) => ({ userId: `user-${i}` }))

    const payload = await json(await call('GET', '/api/devices?q=user-3', { cookie }))

    expect(payload.total).toBe(1)
    expect(payload.devices[0].attributes.userId).toBe('user-3')
  })

  it('filters by active state', async () => {
    const cookie = await signIn()
    const ids = await seedDevices(config, 4)
    await config.db.update(devices).set({ active: false }).where(eq(devices.id, ids[0] as string))

    expect((await json(await call('GET', '/api/devices?status=active', { cookie }))).total).toBe(3)
    expect((await json(await call('GET', '/api/devices?status=inactive', { cookie }))).total).toBe(1)
  })

  it('replaces attributes so a key can actually be removed', async () => {
    const cookie = await signIn()
    const [id] = await seedDevices(config, 1, () => ({ plan: 'pro', city: 'ST' }))

    await call('PATCH', `/api/devices/${id}`, { cookie, body: { attributes: { plan: 'free' } } })

    const [row] = await config.db.select().from(devices).where(eq(devices.id, id as string))
    expect(row?.attributes).toEqual({ plan: 'free' })
  })

  it('rejects attributes the storage contract cannot hold', async () => {
    const cookie = await signIn()
    const [id] = await seedDevices(config, 1)

    const response = await call('PATCH', `/api/devices/${id}`, {
      cookie,
      body: { attributes: { nested: { no: 'thanks' } } },
    })

    expect(response.status).toBe(400)
  })

  it('deactivates and deletes a device', async () => {
    const cookie = await signIn()
    const [id] = await seedDevices(config, 1)

    await call('PATCH', `/api/devices/${id}`, { cookie, body: { active: false } })
    let [row] = await config.db.select().from(devices).where(eq(devices.id, id as string))
    expect(row?.active).toBe(false)

    expect((await call('DELETE', `/api/devices/${id}`, { cookie })).status).toBe(200)
    expect(await config.db.select().from(devices)).toHaveLength(0)
  })

  it('answers 404 for an id that is not a device', async () => {
    const cookie = await signIn()
    expect((await call('DELETE', '/api/devices/not-a-uuid', { cookie })).status).toBe(404)
  })
})

describe('admin UI — notifications', () => {
  async function queue(title: string) {
    const [row] = await config.db
      .insert(notifications)
      .values({ title, body: 'Tekst', status: 'completed', sentCount: 2, completedAt: new Date() })
      .returning()
    return row!.id
  }

  it('lists sends with their audience and delivery numbers', async () => {
    const cookie = await signIn()
    await queue('Prva')

    const payload = await json(await call('GET', '/api/notifications', { cookie }))

    expect(payload.total).toBe(1)
    expect(payload.notifications[0]).toMatchObject({
      title: 'Prva',
      audience: 'everyone',
      sentCount: 2,
      delivered: 0,
      opened: 0,
    })
    // Internals stay internal.
    expect(payload.notifications[0].retryIds).toBeUndefined()
    expect(payload.notifications[0].leaseUntil).toBeUndefined()
  })

  it('queues a send through the same path as the public API', async () => {
    const cookie = await signIn()

    const response = await call('POST', '/api/notifications', {
      cookie,
      body: { title: 'Popust', body: 'Samo danas' },
    })

    expect(response.status).toBe(202)
    const rows = await config.db.select().from(notifications)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.title).toBe('Popust')
  })

  it('reports a bad filter as an invalid filter, not a crash', async () => {
    const cookie = await signIn()

    const response = await call('POST', '/api/notifications', {
      cookie,
      body: { title: 'a', body: 'b', filter: { key: 'age', op: 'gt', value: 'stara' } },
    })

    expect(response.status).toBe(422)
  })

  it('resumes a stalled send', async () => {
    const cookie = await signIn()
    const [row] = await config.db
      .insert(notifications)
      .values({ title: 'Zapelo', body: 'Tekst', status: 'pending' })
      .returning()

    // No devices, so the drain finishes the row without ever calling FCM.
    const response = await call('POST', `/api/notifications/${row!.id}/resume`, { cookie })
    expect(response.status).toBe(200)

    const [after] = await config.db
      .select()
      .from(notifications)
      .where(eq(notifications.id, row!.id))
    expect(after?.status).toBe('completed')
  })

  it('refuses to resume something already finished', async () => {
    const cookie = await signIn()
    const id = await queue('Gotovo')

    const response = await call('POST', `/api/notifications/${id}/resume`, { cookie })
    expect(response.status).toBe(409)
  })

  it('deletes a finished send but not one still in flight', async () => {
    const cookie = await signIn()
    const done = await queue('Gotovo')

    const [inFlight] = await config.db
      .insert(notifications)
      .values({ title: 'U letu', body: 'Tekst', status: 'sending' })
      .returning()

    expect((await call('DELETE', `/api/notifications/${done}`, { cookie })).status).toBe(200)
    expect((await call('DELETE', `/api/notifications/${inFlight!.id}`, { cookie })).status).toBe(409)
  })

  it('counts the audience before anything is sent', async () => {
    const cookie = await signIn()
    await seedDevices(config, 6, (i) => ({ plan: i < 2 ? 'pro' : 'free' }))

    const payload = await json(
      await call('POST', '/api/audience', {
        cookie,
        body: { filter: { key: 'plan', op: 'eq', value: 'pro' } },
      }),
    )

    expect(payload.count).toBe(2)
  })
})

describe('admin UI — overview', () => {
  it('summarises the registry and the send log', async () => {
    const cookie = await signIn()
    const ids = await seedDevices(config, 4)
    await config.db.update(devices).set({ active: false }).where(eq(devices.id, ids[0] as string))
    await config.db
      .insert(notifications)
      .values({ title: 'a', body: 'b', status: 'sending', sentCount: 7 })

    const payload = await json(await call('GET', '/api/overview', { cookie }))

    expect(payload.devices).toMatchObject({ total: 4, active: 3 })
    expect(payload.notifications).toMatchObject({ total: 1, inFlight: 1, sent: 7 })
  })
})
