import { timingSafeEqual } from '../http/auth.js'

/**
 * Cookie-backed login for the dashboard.
 *
 * The point of the cookie is that the secret key never reaches the browser. The
 * page talks to endpoints that hold the key server-side, so a stolen session
 * expires on its own instead of handing over a credential that does not.
 *
 * The cookie carries nothing but an expiry and an HMAC of it, keyed by the
 * secret key. Rotating the secret key invalidates every session for free.
 */
export const SESSION_COOKIE = 'maksbas_admin'

/** Sent by the dashboard's own fetches. See `requireSameOrigin`. */
export const CSRF_HEADER = 'x-maksbas-admin'

export async function createSession(secretKey: string, maxAgeSeconds: number): Promise<string> {
  const expiresAt = Date.now() + maxAgeSeconds * 1000
  return `${expiresAt}.${await sign(secretKey, String(expiresAt))}`
}

export async function verifySession(secretKey: string, cookie: string | null): Promise<boolean> {
  if (!cookie) return false

  const separator = cookie.indexOf('.')
  if (separator < 1) return false

  const expiresAt = cookie.slice(0, separator)
  const signature = cookie.slice(separator + 1)

  const expected = await sign(secretKey, expiresAt)
  if (!timingSafeEqual(signature, expected)) return false

  const deadline = Number(expiresAt)
  return Number.isFinite(deadline) && deadline > Date.now()
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null

  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== name) continue
    return decodeURIComponent(part.slice(separator + 1).trim())
  }
  return null
}

export function sessionCookie(value: string, maxAgeSeconds: number, request: Request): string {
  // `Secure` is conditional so the dashboard still logs in over plain http on
  // localhost, where the browser would otherwise silently drop the cookie.
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return (
    `${SESSION_COOKIE}=${encodeURIComponent(value)}` +
    `; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure}`
  )
}

export function clearedCookie(request: Request): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`
}

async function sign(secretKey: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))

  let hex = ''
  for (const byte of new Uint8Array(signature)) hex += byte.toString(16).padStart(2, '0')
  return hex
}
