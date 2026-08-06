import type { MaksbasDb } from './db/types.js'
import type { ServiceAccount } from './fcm/types.js'

export interface MaksbasConfig {
  /** Any Drizzle Postgres handle. */
  db: MaksbasDb

  /** Shipped inside the mobile app. Only allows device registration. */
  publicKey: string

  /** Server-side only. Allows sending, listing devices, managing segments. */
  secretKey: string

  fcm: {
    /** The Firebase service account JSON — object, or the raw JSON string from an env var. */
    serviceAccount: ServiceAccount | string
  }

  /** Required to call `/cron/drain`. Vercel Cron sends it as `Authorization: Bearer`. */
  cronSecret?: string

  /**
   * Where the catch-all route is mounted. Only used to strip the prefix off
   * incoming paths and to build self-chain URLs.
   * @default '/api/maksbas'
   */
  basePath?: string

  /**
   * Absolute origin of this deployment, used to call itself for the next drain
   * batch. On Vercel this defaults to `https://$VERCEL_URL`. Without it,
   * self-chaining is off and the cron alone finishes long sends.
   */
  baseUrl?: string

  /** Devices pulled from the database per batch. @default 500 */
  batchSize?: number

  /** Concurrent FCM requests inside a batch. @default 50 */
  concurrency?: number

  /**
   * How long one drain invocation may work before saving its cursor and handing
   * off. Keep it comfortably under the platform's function timeout.
   * @default 8000
   */
  timeBudgetMs?: number

  /**
   * After saving a cursor, fire a request at our own drain endpoint to continue
   * immediately instead of waiting for the next cron tick.
   * @default true
   */
  selfChain?: boolean

  /**
   * How long `POST /notifications` sends for before returning 202. A small
   * audience finishes inside this window and needs no cron at all; a large one
   * gets a head start and hands off.
   * @default 3000
   */
  inlineDrainMs?: number
}

/**
 * Marks a config as already normalised. A plain duck-type check can't tell the
 * two apart — every field of `ResolvedConfig` is also a legal field of
 * `MaksbasConfig` — and resolving twice would re-parse the service account on
 * every call.
 */
export const RESOLVED = Symbol.for('maksbas.resolved')

export interface ResolvedConfig extends Required<Omit<MaksbasConfig, 'fcm' | 'cronSecret' | 'baseUrl'>> {
  fcm: { serviceAccount: ServiceAccount }
  cronSecret: string | null
  baseUrl: string | null
  readonly [RESOLVED]: true
}

export function isResolved(config: MaksbasConfig | ResolvedConfig): config is ResolvedConfig {
  return (config as ResolvedConfig)[RESOLVED] === true
}

export function resolveConfig(config: MaksbasConfig): ResolvedConfig {
  if (!config.db) throw new Error('[maksbas] `db` is required')
  if (!config.publicKey) throw new Error('[maksbas] `publicKey` is required')
  if (!config.secretKey) throw new Error('[maksbas] `secretKey` is required')
  if (config.publicKey === config.secretKey) {
    throw new Error(
      '[maksbas] `publicKey` and `secretKey` must differ — the public key ships inside your app',
    )
  }

  return {
    [RESOLVED]: true,
    db: config.db,
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    fcm: { serviceAccount: parseServiceAccount(config.fcm?.serviceAccount) },
    cronSecret: config.cronSecret ?? null,
    basePath: normalisePath(config.basePath ?? '/api/maksbas'),
    baseUrl: config.baseUrl ?? inferBaseUrl(),
    batchSize: clamp(config.batchSize ?? 500, 1, 1000),
    concurrency: clamp(config.concurrency ?? 50, 1, 200),
    timeBudgetMs: clamp(config.timeBudgetMs ?? 8_000, 500, 600_000),
    selfChain: config.selfChain ?? true,
    inlineDrainMs: clamp(config.inlineDrainMs ?? 3_000, 0, 60_000),
  }
}

function parseServiceAccount(input: ServiceAccount | string | undefined): ServiceAccount {
  if (!input) throw new Error('[maksbas] `fcm.serviceAccount` is required')

  let account: ServiceAccount
  if (typeof input === 'string') {
    try {
      account = JSON.parse(input) as ServiceAccount
    } catch {
      throw new Error(
        '[maksbas] `fcm.serviceAccount` is a string but not valid JSON. ' +
          'If it comes from an env var, make sure the whole JSON file is in there, newlines and all.',
      )
    }
  } else {
    account = input
  }

  for (const field of ['project_id', 'client_email', 'private_key'] as const) {
    if (!account[field]) {
      throw new Error(`[maksbas] service account is missing \`${field}\``)
    }
  }

  // Env vars routinely carry the key with literal \n instead of real newlines,
  // which makes the PKCS#8 import fail with a confusing error much later.
  account.private_key = account.private_key.replace(/\\n/g, '\n')

  return account
}

function inferBaseUrl(): string | null {
  const url = process.env.MAKSBAS_BASE_URL ?? process.env.VERCEL_URL
  if (!url) return null
  return url.startsWith('http') ? url : `https://${url}`
}

function normalisePath(path: string): string {
  const withLeading = path.startsWith('/') ? path : `/${path}`
  return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
