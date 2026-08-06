import { getAccessToken } from './auth.js'
import {
  type FcmData,
  type FcmOutcome,
  type FcmSendItem,
  FcmConfigError,
  PERMANENT_TOKEN_ERRORS,
  RETRYABLE_ERRORS,
  type ServiceAccount,
} from './types.js'

export interface FcmSender {
  send(items: FcmSendItem[], data: FcmData): Promise<FcmOutcome[]>
}

export interface FcmClientOptions {
  serviceAccount: ServiceAccount
  concurrency?: number
  /** Injected in tests. */
  fetchImpl?: typeof fetch
}

/**
 * FCM HTTP v1 client.
 *
 * v1 has no batch endpoint — the `/batch` one the old SDKs used was retired — so
 * a multi-token send is genuinely N requests. We run them with a concurrency
 * limit and return one outcome per device, which is also what lets us tell a
 * dead token apart from a transient blip.
 */
export function createFcmClient({
  serviceAccount,
  concurrency = 50,
  fetchImpl = fetch,
}: FcmClientOptions): FcmSender {
  const endpoint = `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`

  return {
    async send(items, data) {
      if (items.length === 0) return []

      const accessToken = await getAccessToken(serviceAccount)
      return mapWithConcurrency(items, concurrency, (item) =>
        sendOne({ endpoint, accessToken, item, data, fetchImpl }),
      )
    },
  }
}

async function sendOne({
  endpoint,
  accessToken,
  item,
  data,
  fetchImpl,
}: {
  endpoint: string
  accessToken: string
  item: FcmSendItem
  data: FcmData
  fetchImpl: typeof fetch
}): Promise<FcmOutcome> {
  const body = {
    message: {
      token: item.fcmToken,
      // Data-only: no `notification` block, so our own FirebaseMessagingService
      // is what runs and draws the notification. Adding a `notification` block
      // here would make Android draw its own copy in the background and skip our
      // handler entirely — the classic duplicate-notification bug.
      android: {
        priority: 'high',
      },
      data,
    },
  }

  let response: Response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (error) {
    // Network-level failure — never a reason to drop a token.
    return {
      status: 'retryable',
      deviceId: item.deviceId,
      code: 'NETWORK_ERROR',
      message: (error as Error).message,
    }
  }

  if (response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { name?: string }
    return { status: 'sent', deviceId: item.deviceId, messageId: payload.name ?? '' }
  }

  const text = await response.text().catch(() => '')

  // 401/403 mean our credentials are wrong, not this device's token. Abort the
  // whole run rather than marking the entire audience as failed one by one.
  if (response.status === 401 || response.status === 403) {
    throw new FcmConfigError(
      `FCM rejected our credentials (${response.status}). Check the service account and that ` +
        `Firebase Cloud Messaging API is enabled. ${text.slice(0, 300)}`,
      response.status,
    )
  }

  const code = extractErrorCode(text) ?? `HTTP_${response.status}`
  const message = extractErrorMessage(text) ?? text.slice(0, 300)

  if (PERMANENT_TOKEN_ERRORS.has(code)) {
    return { status: 'invalid_token', deviceId: item.deviceId, code, message }
  }
  if (RETRYABLE_ERRORS.has(code) || response.status === 429 || response.status >= 500) {
    return { status: 'retryable', deviceId: item.deviceId, code, message }
  }
  return { status: 'failed', deviceId: item.deviceId, code, message }
}

interface FcmErrorPayload {
  error?: {
    message?: string
    status?: string
    details?: Array<{ '@type'?: string; errorCode?: string }>
  }
}

/**
 * The useful code lives in `error.details[].errorCode`, not in the top-level
 * `status`. `NOT_FOUND` at the top level is `UNREGISTERED` underneath, and only
 * the latter reliably means "this token is dead".
 */
function extractErrorCode(text: string): string | null {
  try {
    const payload = JSON.parse(text) as FcmErrorPayload
    const detail = payload.error?.details?.find((d) => typeof d.errorCode === 'string')
    return detail?.errorCode ?? payload.error?.status ?? null
  } catch {
    return null
  }
}

function extractErrorMessage(text: string): string | null {
  try {
    return (JSON.parse(text) as FcmErrorPayload).error?.message ?? null
  } catch {
    return null
  }
}

/**
 * Runs `worker` over every item with at most `limit` in flight, preserving
 * input order in the result.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await worker(items[index] as T, index)
    }
  })

  await Promise.all(runners)
  return results
}
