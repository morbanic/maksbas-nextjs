import { type MaksbasConfig, resolveConfig } from './config.js'
import { handleRequest } from './http/router.js'
import { type DrainOptions, type DrainReport, drainOnce } from './notifications/drain.js'
import { migrate } from './db/migrate.js'
import { createServerClient } from './server.js'

export type NextRouteHandler = (request: Request) => Promise<Response>

export interface MaksbasHandler extends NextRouteHandler {
  GET: NextRouteHandler
  POST: NextRouteHandler
  PATCH: NextRouteHandler
  PUT: NextRouteHandler
  DELETE: NextRouteHandler
  /** Creates the tables. Safe to call repeatedly. */
  migrate: () => Promise<{ applied: string[] }>
  /** Continues unfinished sends — for a long-running server that has no cron. */
  drain: (options?: DrainOptions) => Promise<DrainReport>
  /** Typed server-side API for your own code. */
  client: ReturnType<typeof createServerClient>
}

/**
 * Builds the route handler for a Next.js catch-all.
 *
 * ```ts
 * // app/api/maksbas/[...path]/route.ts
 * import { createHandler } from 'maksbas-nextjs'
 * import { db } from '@/lib/db'
 *
 * const maksbas = createHandler({
 *   db,
 *   publicKey: process.env.MAKSBAS_PUBLIC_KEY!,
 *   secretKey: process.env.MAKSBAS_SECRET_KEY!,
 *   cronSecret: process.env.CRON_SECRET,
 *   fcm: { serviceAccount: process.env.FCM_SERVICE_ACCOUNT_JSON! },
 * })
 *
 * export const { GET, POST, PATCH, PUT, DELETE } = maksbas
 * ```
 */
export function createHandler(config: MaksbasConfig): MaksbasHandler {
  const resolved = resolveConfig(config)

  const handler = ((request: Request) => handleRequest(request, resolved)) as MaksbasHandler

  handler.GET = handler
  handler.POST = handler
  handler.PATCH = handler
  handler.PUT = handler
  handler.DELETE = handler

  handler.migrate = () => migrate(resolved.db)
  handler.drain = (options?: DrainOptions) => drainOnce(resolved, options)
  handler.client = createServerClient(resolved)

  return handler
}

export { migrate } from './db/migrate.js'
export { drainOnce } from './notifications/drain.js'
export { createServerClient } from './server.js'
export { resolveConfig } from './config.js'
export type { MaksbasConfig, ResolvedConfig } from './config.js'
export type { DrainOptions, DrainReport } from './notifications/drain.js'

export { compileFilter } from './segments/compile.js'
export { validateFilter } from './segments/validate.js'
export {
  FilterError,
  OPERATORS,
  type Condition,
  type Filter,
  type Operator,
} from './segments/types.js'

export { ApiError } from './http/errors.js'
export { devices, segments, notifications, events } from './db/schema.js'
export type {
  Attributes,
  Device,
  Notification,
  NotificationEvent,
  NotificationStatus,
  Segment,
} from './db/schema.js'
export type { FcmOutcome, ServiceAccount } from './fcm/types.js'
export type { FcmSender } from './fcm/client.js'
export { createFcmClient } from './fcm/client.js'
