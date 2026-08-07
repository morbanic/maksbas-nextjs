import { eq } from 'drizzle-orm'
import type { ResolvedConfig } from '../config.js'
import { type Device, devices } from '../db/schema.js'
import { ApiError } from './errors.js'

/** Web Crypto rather than `node:crypto` so the handler also runs on edge runtimes. */
export async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return bytesToHex(new Uint8Array(digest))
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

/**
 * Constant-time string comparison.
 *
 * A plain `===` leaks how many leading characters matched via timing, which is
 * enough to recover an API key one character at a time.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a)
  const bBytes = new TextEncoder().encode(b)
  // Comparing against itself on length mismatch keeps the work constant; the
  // result is forced false below.
  const reference = aBytes.length === bBytes.length ? bBytes : aBytes
  let diff = aBytes.length ^ bBytes.length
  for (let i = 0; i < aBytes.length; i++) {
    diff |= (aBytes[i] as number) ^ (reference[i] as number)
  }
  return diff === 0
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const [scheme, ...rest] = header.split(' ')
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null
  const token = rest.join(' ').trim()
  return token.length > 0 ? token : null
}

/** Requires the public key — the one embedded in the mobile app. */
export function requirePublicKey(request: Request, config: ResolvedConfig): void {
  const token = bearerToken(request)
  if (!token || !timingSafeEqual(token, config.publicKey)) {
    throw new ApiError('unauthorized', 'Missing or invalid public key')
  }
}

/** Requires the secret key. Never put this in a mobile app or browser bundle. */
export function requireSecretKey(request: Request, config: ResolvedConfig): void {
  const token = bearerToken(request)
  if (!token || !timingSafeEqual(token, config.secretKey)) {
    throw new ApiError('unauthorized', 'Missing or invalid secret key')
  }
}

/**
 * Guards `/cron/drain`.
 *
 * The secret key is accepted alongside the cron secret: it is already a
 * superuser credential, and without it a deployment that never set `cronSecret`
 * has no way to self-chain — an interrupted send would then sit unfinished until
 * someone triggers a drain by hand.
 */
export function requireCronSecret(request: Request, config: ResolvedConfig): void {
  const token = bearerToken(request) ?? request.headers.get('x-cron-secret')
  if (!token) throw new ApiError('unauthorized', 'Missing cron secret')

  const accepted = [config.cronSecret, config.secretKey].filter(
    (candidate): candidate is string => Boolean(candidate),
  )
  // Every candidate is compared, so the reply takes the same time whether the
  // first one matched or none did.
  const matched = accepted.reduce(
    (found, candidate) => timingSafeEqual(token, candidate) || found,
    false,
  )

  if (!matched) throw new ApiError('unauthorized', 'Missing or invalid cron secret')
}

/**
 * Resolves the device named in the path and checks the bearer token against its
 * stored secret hash.
 *
 * Returns 404 for both "no such device" and "wrong secret" so the endpoint can't
 * be used to confirm which device ids exist.
 */
export async function requireDevice(
  request: Request,
  config: ResolvedConfig,
  deviceId: string,
): Promise<Device> {
  const token = bearerToken(request)
  if (!token) throw new ApiError('unauthorized', 'Missing device secret')

  if (!isUuid(deviceId)) throw new ApiError('not_found', 'Device not found')

  const [device] = await config.db
    .select()
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1)

  if (!device) throw new ApiError('not_found', 'Device not found')

  const hash = await sha256(token)
  if (!timingSafeEqual(hash, device.secretHash)) {
    throw new ApiError('not_found', 'Device not found')
  }

  return device
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
