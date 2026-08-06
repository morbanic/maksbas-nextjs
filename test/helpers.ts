import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { type ResolvedConfig, resolveConfig } from '../src/config.js'
import { migrate } from '../src/db/migrate.js'
import type { MaksbasDb } from '../src/db/types.js'
import type { FcmSender } from '../src/fcm/client.js'
import type { FcmOutcome, FcmSendItem } from '../src/fcm/types.js'
import { devices } from '../src/db/schema.js'

export const PUBLIC_KEY = 'pk_test_public'
export const SECRET_KEY = 'sk_test_secret'
export const CRON_SECRET = 'cron_test_secret'

/** Structurally valid, cryptographically useless — no test ever mints a real token. */
const FAKE_SERVICE_ACCOUNT = {
  project_id: 'maksbas-test',
  client_email: 'test@maksbas-test.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
}

export async function createTestConfig(
  overrides: Partial<Parameters<typeof resolveConfig>[0]> = {},
): Promise<ResolvedConfig & { pglite: PGlite }> {
  const pglite = new PGlite()
  const db = drizzle(pglite) as unknown as MaksbasDb

  await migrate(db)

  const config = resolveConfig({
    db,
    publicKey: PUBLIC_KEY,
    secretKey: SECRET_KEY,
    cronSecret: CRON_SECRET,
    fcm: { serviceAccount: FAKE_SERVICE_ACCOUNT },
    // Self-chaining would try to reach a real URL from inside the test process.
    selfChain: false,
    inlineDrainMs: 0,
    ...overrides,
  })

  return Object.assign(config, { pglite })
}

export function url(path: string): string {
  return `http://localhost/api/maksbas${path}`
}

export function request(
  method: string,
  path: string,
  { token, body }: { token?: string; body?: unknown } = {},
): Request {
  return new Request(url(path), {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

/**
 * Records every send and replies according to a per-token script, so a test can
 * say "this token is dead, that one is flaky" without touching the network.
 */
export function fakeFcm(
  script: (item: FcmSendItem, callIndex: number) => FcmOutcome['status'] = () => 'sent',
): FcmSender & { calls: FcmSendItem[][]; totalSends: number } {
  const calls: FcmSendItem[][] = []
  let totalSends = 0

  const sender = {
    calls,
    get totalSends() {
      return totalSends
    },
    async send(items: FcmSendItem[]): Promise<FcmOutcome[]> {
      calls.push(items)
      return items.map((item) => {
        const status = script(item, totalSends++)
        switch (status) {
          case 'sent':
            return { status, deviceId: item.deviceId, messageId: `msg_${item.deviceId}` }
          case 'invalid_token':
            return {
              status,
              deviceId: item.deviceId,
              code: 'UNREGISTERED',
              message: 'Requested entity was not found.',
            }
          case 'retryable':
            return {
              status,
              deviceId: item.deviceId,
              code: 'UNAVAILABLE',
              message: 'The service is currently unavailable.',
            }
          case 'failed':
            return {
              status,
              deviceId: item.deviceId,
              code: 'INVALID_ARGUMENT',
              message: 'Bad request',
            }
        }
      })
    },
  }

  return sender as FcmSender & { calls: FcmSendItem[][]; totalSends: number }
}

/** Inserts devices directly, bypassing the HTTP layer. */
export async function seedDevices(
  config: ResolvedConfig,
  count: number,
  attributes: (index: number) => Record<string, string> = () => ({}),
): Promise<string[]> {
  const rows = Array.from({ length: count }, (_, i) => ({
    fcmToken: `token_${i}_${Math.random().toString(36).slice(2)}`,
    secretHash: 'unused',
    attributes: attributes(i),
  }))

  const inserted = await config.db.insert(devices).values(rows).returning({ id: devices.id })
  return inserted.map((r) => r.id)
}

export async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T
}
