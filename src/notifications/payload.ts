import type { Notification } from '../db/schema.js'
import type { FcmData } from '../fcm/types.js'

/** FCM caps the data payload at 4096 bytes. Leave headroom for our own keys. */
const MAX_DATA_BYTES = 3800

/**
 * Builds the data-only FCM payload the Android SDK expects.
 *
 * Keys are prefixed `ms_` so a host app's own `data` entries can never collide
 * with ours — `title` is a plausible key for someone to pass through.
 */
export function buildPayload(notification: Notification): FcmData {
  const data: FcmData = {
    mb_id: notification.id,
    mb_title: notification.title,
    mb_body: notification.body,
  }

  if (notification.image) data.mb_image = notification.image
  if (notification.deeplink) data.mb_deeplink = notification.deeplink

  if (notification.data && Object.keys(notification.data).length > 0) {
    data.mb_data = JSON.stringify(notification.data)
  }

  const size = byteLength(data)
  if (size > MAX_DATA_BYTES) {
    throw new PayloadTooLargeError(
      `Notification payload is ${size} bytes; FCM allows about ${MAX_DATA_BYTES}. ` +
        'Shorten the body or move the extra fields behind the deeplink.',
    )
  }

  return data
}

export class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PayloadTooLargeError'
  }
}

function byteLength(data: FcmData): number {
  const encoder = new TextEncoder()
  let total = 0
  for (const [key, value] of Object.entries(data)) {
    total += encoder.encode(key).length + encoder.encode(value).length
  }
  return total
}
