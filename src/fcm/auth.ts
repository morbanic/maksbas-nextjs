import { SignJWT, importPKCS8 } from 'jose'
import { FcmConfigError, type ServiceAccount } from './types.js'

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

/** Refresh this far ahead of expiry so a token never dies mid-batch. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

interface CachedToken {
  accessToken: string
  expiresAt: number
}

/**
 * Access tokens live an hour and cost a round trip plus an RSA signature, so
 * they are cached per service account for the life of the process. On serverless
 * that is per warm instance, which still saves the call on the vast majority of
 * invocations.
 */
const cache = new Map<string, CachedToken>()

/** In-flight refreshes, so a burst of concurrent sends mints one token, not fifty. */
const inflight = new Map<string, Promise<string>>()

export async function getAccessToken(account: ServiceAccount): Promise<string> {
  const key = account.client_email
  const cached = cache.get(key)
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return cached.accessToken
  }

  const pending = inflight.get(key)
  if (pending) return pending

  const promise = mintToken(account).finally(() => inflight.delete(key))
  inflight.set(key, promise)
  return promise
}

async function mintToken(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000)

  let privateKey: CryptoKey
  try {
    privateKey = (await importPKCS8(account.private_key, 'RS256')) as CryptoKey
  } catch (error) {
    throw new FcmConfigError(
      'Could not read the service account private key. It must be the full PEM block, ' +
        'including the BEGIN/END lines. If it comes from an env var, check that newlines survived. ' +
        `(${(error as Error).message})`,
    )
  }

  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(account.client_email)
    .setSubject(account.client_email)
    .setAudience(TOKEN_ENDPOINT)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey)

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: GRANT_TYPE, assertion }),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new FcmConfigError(
      `Google rejected the service account (${response.status}): ${text.slice(0, 400)}`,
      response.status,
    )
  }

  let payload: { access_token?: string; expires_in?: number }
  try {
    payload = JSON.parse(text)
  } catch {
    throw new FcmConfigError(`Token endpoint returned non-JSON: ${text.slice(0, 200)}`)
  }

  if (!payload.access_token) {
    throw new FcmConfigError('Token endpoint response had no `access_token`')
  }

  cache.set(account.client_email, {
    accessToken: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  })

  return payload.access_token
}

/** Test seam — drops cached tokens. */
export function clearTokenCache(): void {
  cache.clear()
  inflight.clear()
}
