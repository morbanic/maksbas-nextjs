export interface ServiceAccount {
  project_id: string
  client_email: string
  private_key: string
  [key: string]: unknown
}

/** Data-only payload. Every value must be a string — that is an FCM constraint. */
export type FcmData = Record<string, string>

export interface FcmSendItem {
  deviceId: string
  fcmToken: string
}

export type FcmOutcome =
  /** Accepted by FCM. Says nothing about whether the handset showed it. */
  | { status: 'sent'; deviceId: string; messageId: string }
  /** The token is dead. Deactivate it and stop sending. */
  | { status: 'invalid_token'; deviceId: string; code: string; message: string }
  /** Transient. Leave the device alone; a later run can retry. */
  | { status: 'retryable'; deviceId: string; code: string; message: string }
  /** Our request was wrong in a way retrying won't fix. */
  | { status: 'failed'; deviceId: string; code: string; message: string }

/**
 * Thrown when the problem is the configuration rather than an individual token —
 * a bad service account, a revoked key, the API not enabled. Draining stops
 * immediately instead of burning through the whole audience marking everyone failed.
 */
export class FcmConfigError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'FcmConfigError'
  }
}

/** Per-token error codes FCM returns in `error.details[].errorCode`. */
export const PERMANENT_TOKEN_ERRORS = new Set([
  'UNREGISTERED',
  'INVALID_ARGUMENT',
  'SENDER_ID_MISMATCH',
])

export const RETRYABLE_ERRORS = new Set(['UNAVAILABLE', 'INTERNAL', 'QUOTA_EXCEEDED'])
