import { type MaksbasConfig, type ResolvedConfig, isResolved, resolveConfig } from '../config.js'
import { timingSafeEqual } from '../http/auth.js'
import { readJson } from '../http/body.js'
import { ApiError, errorResponse, json } from '../http/errors.js'
import { FilterError } from '../segments/types.js'
import * as api from './api.js'
import { renderPage } from './page.js'
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  clearedCookie,
  createSession,
  readCookie,
  sessionCookie,
  verifySession,
} from './session.js'

export interface AdminConfig extends MaksbasConfig {
  /**
   * Where the dashboard route is mounted. Must match the folder the route file
   * lives in.
   * @default '/admin/maksbas'
   */
  adminPath?: string

  /**
   * Password for the dashboard. Defaults to the secret key, which works but is
   * worth replacing — a password gets typed into a browser, and the secret key
   * is also the credential your servers send.
   */
  password?: string

  /** How long a login lasts. @default 43200 (12 hours) */
  sessionMaxAgeSeconds?: number
}

export type AdminRouteHandler = (request: Request) => Promise<Response>

export interface AdminHandler extends AdminRouteHandler {
  GET: AdminRouteHandler
  POST: AdminRouteHandler
  PATCH: AdminRouteHandler
  DELETE: AdminRouteHandler
}

interface ResolvedAdmin {
  config: ResolvedConfig
  adminPath: string
  password: string
  sessionMaxAgeSeconds: number
}

type AdminRoute = {
  method: string
  pattern: string[]
  /** Whether a valid session is required. */
  guarded: boolean
  handler: (
    request: Request,
    config: ResolvedConfig,
    ...params: string[]
  ) => Promise<Response>
}

/**
 * A self-contained dashboard for devices and sent notifications.
 *
 * ```ts
 * // app/admin/maksbas/[[...path]]/route.ts
 * import { createAdminHandler } from 'maksbas-nextjs/ui'
 * import { db } from '@/lib/db'
 *
 * const admin = createAdminHandler({
 *   db,
 *   publicKey: process.env.MAKSBAS_PUBLIC_KEY!,
 *   secretKey: process.env.MAKSBAS_SECRET_KEY!,
 *   fcm: { serviceAccount: process.env.FCM_SERVICE_ACCOUNT_JSON! },
 *   password: process.env.MAKSBAS_ADMIN_PASSWORD,
 * })
 *
 * export const { GET, POST, PATCH, DELETE } = admin
 * ```
 *
 * The page is one HTML document with its CSS and JS inlined — no build step, no
 * bundler config, nothing to serve from `public/`. It talks only to the
 * endpoints below, so the secret key stays on the server.
 */
export function createAdminHandler(config: AdminConfig): AdminHandler {
  const resolved: ResolvedAdmin = {
    config: isResolved(config) ? config : resolveConfig(config),
    adminPath: normalisePath(config.adminPath ?? '/admin/maksbas'),
    password: config.password ?? config.secretKey,
    sessionMaxAgeSeconds: config.sessionMaxAgeSeconds ?? 12 * 60 * 60,
  }

  const handler = ((request: Request) => handleAdminRequest(request, resolved)) as AdminHandler

  handler.GET = handler
  handler.POST = handler
  handler.PATCH = handler
  handler.DELETE = handler

  return handler
}

const ROUTES: AdminRoute[] = [
  guarded('GET', '/api/overview', api.overview),
  guarded('GET', '/api/devices', api.listDevices),
  guarded('PATCH', '/api/devices/:id', api.updateDevice),
  guarded('DELETE', '/api/devices/:id', api.deleteDevice),
  guarded('GET', '/api/notifications', api.listNotifications),
  guarded('POST', '/api/notifications', api.createNotification),
  guarded('GET', '/api/notifications/:id', api.getNotification),
  guarded('POST', '/api/notifications/:id/resume', api.resumeNotification),
  guarded('DELETE', '/api/notifications/:id', api.deleteNotification),
  guarded('GET', '/api/segments', api.listSegments),
  guarded('POST', '/api/audience', api.countAudience),
]

function guarded(method: string, path: string, handler: AdminRoute['handler']): AdminRoute {
  return { method, pattern: path.split('/').filter(Boolean), guarded: true, handler }
}

async function handleAdminRequest(request: Request, admin: ResolvedAdmin): Promise<Response> {
  try {
    const segments = pathSegments(request, admin.adminPath)
    const method = request.method.toUpperCase()

    // The page itself. Served for the mount point and for anything that isn't an
    // endpoint, so a client-side route or a stray trailing slash still lands on
    // the dashboard instead of a 404.
    if (method === 'GET' && segments[0] !== 'api' && segments[0] !== 'session') {
      return html(renderPage(admin.adminPath))
    }

    if (method === 'GET' && segments[0] === 'session' && segments.length === 1) {
      return json({ authenticated: await authenticated(request, admin) })
    }

    if (method === 'POST' && segments[0] === 'session' && segments.length === 1) {
      // Awaited, not returned: a bare `return` would hand the rejection past
      // this function's own catch and out of the route as an unhandled throw.
      return await login(request, admin)
    }

    if (method === 'DELETE' && segments[0] === 'session' && segments.length === 1) {
      return new Response(JSON.stringify({ authenticated: false }), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': clearedCookie(request),
        },
      })
    }

    const match = matchRoute(method, segments)
    if (!match) {
      return json({ error: { code: 'not_found', message: 'No such admin endpoint' } }, 404)
    }

    if (match.route.guarded) {
      if (!(await authenticated(request, admin))) {
        throw new ApiError('unauthorized', 'Session expired — sign in again')
      }
      requireSameOrigin(request)
    }

    return await match.route.handler(request, admin.config, ...match.params)
  } catch (error) {
    if (error instanceof FilterError) {
      return errorResponse(new ApiError('invalid_filter', error.message))
    }
    return errorResponse(error)
  }
}

async function login(request: Request, admin: ResolvedAdmin): Promise<Response> {
  requireSameOrigin(request)

  const body = await readJson<{ password?: unknown }>(request).catch(
    () => ({}) as { password?: unknown },
  )
  const password = typeof body.password === 'string' ? body.password : ''

  if (!password || !timingSafeEqual(password, admin.password)) {
    throw new ApiError('unauthorized', 'Wrong password')
  }

  const session = await createSession(admin.config.secretKey, admin.sessionMaxAgeSeconds)

  return new Response(JSON.stringify({ authenticated: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': sessionCookie(session, admin.sessionMaxAgeSeconds, request),
    },
  })
}

function authenticated(request: Request, admin: ResolvedAdmin): Promise<boolean> {
  return verifySession(admin.config.secretKey, readCookie(request, SESSION_COOKIE))
}

/**
 * Blocks cross-site writes.
 *
 * `SameSite=Lax` already stops the cookie riding along on a cross-site `fetch`,
 * but not on a form post. A custom header cannot be set by a form at all, so
 * requiring one turns every state-changing endpoint into something only our own
 * page can call.
 */
function requireSameOrigin(request: Request): void {
  if (request.method.toUpperCase() === 'GET') return
  if (request.headers.get(CSRF_HEADER) !== '1') {
    throw new ApiError('forbidden', 'Cross-site request blocked')
  }
}

function pathSegments(request: Request, adminPath: string): string[] {
  const path = new URL(request.url).pathname
  const relative = path.startsWith(adminPath) ? path.slice(adminPath.length) : path
  return relative.split('/').filter(Boolean).map(decodeURIComponent)
}

function matchRoute(
  method: string,
  segments: string[],
): { route: AdminRoute; params: string[] } | null {
  const candidates = ROUTES.filter((route) => route.method === method).sort(
    (a, b) => captureCount(a) - captureCount(b),
  )

  for (const route of candidates) {
    if (route.pattern.length !== segments.length) continue

    const params: string[] = []
    let matched = true
    for (let i = 0; i < route.pattern.length; i++) {
      const expected = route.pattern[i] as string
      const actual = segments[i] as string
      if (expected.startsWith(':')) params.push(actual)
      else if (expected !== actual) {
        matched = false
        break
      }
    }
    if (matched) return { route, params }
  }
  return null
}

function captureCount(route: AdminRoute): number {
  return route.pattern.filter((segment) => segment.startsWith(':')).length
}

function html(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The dashboard lists device identifiers and message contents; keep it out
      // of shared caches and out of search engines.
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'same-origin',
    },
  })
}

function normalisePath(path: string): string {
  const withLeading = path.startsWith('/') ? path : `/${path}`
  return withLeading.endsWith('/') ? withLeading.slice(0, -1) : withLeading
}
