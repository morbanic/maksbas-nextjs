import type { ResolvedConfig } from '../config.js'
import { requireCronSecret } from './auth.js'
import { ApiError, errorResponse, json } from './errors.js'
import { FilterError } from '../segments/types.js'
import {
  countAudience,
  deleteDevice,
  getDevice,
  patchAttributes,
  queryDevices,
  registerDevice,
  updateDevice,
} from '../routes/devices.js'
import { recordEvents } from '../routes/events.js'
import {
  cronDrain,
  createNotification,
  getNotification,
  listNotifications,
} from '../routes/notifications.js'
import {
  createSegment,
  deleteSegment,
  getSegment,
  listSegments,
  updateSegment,
} from '../routes/segments.js'

type Handler = (
  request: Request,
  config: ResolvedConfig,
  ...params: string[]
) => Promise<Response>

interface Route {
  method: string
  /** Path segments; `:name` captures. */
  pattern: string[]
  handler: Handler
}

const ROUTES: Route[] = [
  route('POST', '/devices', registerDevice),
  route('POST', '/devices/query', queryDevices),
  route('GET', '/devices/:id', getDevice),
  route('PATCH', '/devices/:id', updateDevice),
  route('DELETE', '/devices/:id', deleteDevice),
  route('PATCH', '/devices/:id/attributes', patchAttributes),
  route('POST', '/devices/:id/events', recordEvents),

  route('POST', '/audience/count', countAudience),

  route('GET', '/notifications', listNotifications),
  route('POST', '/notifications', createNotification),
  route('GET', '/notifications/:id', getNotification),

  route('GET', '/segments', listSegments),
  route('POST', '/segments', createSegment),
  route('GET', '/segments/:name', getSegment),
  route('PUT', '/segments/:name', updateSegment),
  route('DELETE', '/segments/:name', deleteSegment),

  route('GET', '/cron/drain', withCronAuth(cronDrain)),
  route('POST', '/cron/drain', withCronAuth(cronDrain)),

  route('GET', '/health', async () => json({ ok: true })),
]

function route(method: string, path: string, handler: Handler): Route {
  return { method, pattern: path.split('/').filter(Boolean), handler }
}

function withCronAuth(handler: Handler): Handler {
  return async (request, config, ...params) => {
    requireCronSecret(request, config)
    return handler(request, config, ...params)
  }
}

export async function handleRequest(
  request: Request,
  config: ResolvedConfig,
): Promise<Response> {
  try {
    const segments = pathSegments(request, config)
    const match = matchRoute(request.method.toUpperCase(), segments)

    if (!match) {
      // Distinguish "no such path" from "wrong verb" — the second one is almost
      // always a typo in the caller, and a bare 404 sends people hunting in the
      // wrong place.
      const allowed = allowedMethods(segments)
      if (allowed.length > 0) {
        return json(
          {
            error: {
              code: 'not_found',
              message: `${request.method} is not supported here. Try: ${allowed.join(', ')}`,
            },
          },
          405,
          { allow: allowed.join(', ') },
        )
      }
      return json(
        { error: { code: 'not_found', message: `No route for /${segments.join('/')}` } },
        404,
      )
    }

    return await match.route.handler(request, config, ...match.params)
  } catch (error) {
    if (error instanceof FilterError) {
      return errorResponse(new ApiError('invalid_filter', error.message))
    }
    return errorResponse(error)
  }
}

/**
 * Strips the mount point off the request path.
 *
 * Matching on the configured `basePath` rather than the catch-all's own params
 * means the same handler works whether it is mounted at `/api/maksbas` or
 * somewhere else entirely.
 */
function pathSegments(request: Request, config: ResolvedConfig): string[] {
  const path = new URL(request.url).pathname
  const base = config.basePath

  const relative = path.startsWith(base) ? path.slice(base.length) : path
  return relative.split('/').filter(Boolean).map(decodeURIComponent)
}

function matchRoute(
  method: string,
  segments: string[],
): { route: Route; params: string[] } | null {
  // Static segments win over captures, so `/devices/query` is never swallowed by
  // `/devices/:id`.
  const candidates = ROUTES.filter((r) => r.method === method)
  const ranked = [...candidates].sort((a, b) => captureCount(a) - captureCount(b))

  for (const route of ranked) {
    const params = matchPattern(route.pattern, segments)
    if (params) return { route, params }
  }
  return null
}

function allowedMethods(segments: string[]): string[] {
  return ROUTES.filter((r) => matchPattern(r.pattern, segments) !== null).map((r) => r.method)
}

function matchPattern(pattern: string[], segments: string[]): string[] | null {
  if (pattern.length !== segments.length) return null

  const params: string[] = []
  for (let i = 0; i < pattern.length; i++) {
    const expected = pattern[i] as string
    const actual = segments[i] as string
    if (expected.startsWith(':')) {
      params.push(actual)
    } else if (expected !== actual) {
      return null
    }
  }
  return params
}

function captureCount(route: Route): number {
  return route.pattern.filter((s) => s.startsWith(':')).length
}
