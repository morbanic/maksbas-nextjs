import { ApiError } from './errors.js'

const MAX_BODY_BYTES = 256 * 1024

/**
 * Parses a JSON request body with a size cap.
 *
 * The cap matters on the registration endpoint specifically: it accepts the
 * public key, which by definition ships inside every copy of the app.
 */
export async function readJson<T = unknown>(request: Request): Promise<T> {
  const text = await request.text()

  if (text.length > MAX_BODY_BYTES) {
    throw new ApiError('payload_too_large', `Request body exceeds ${MAX_BODY_BYTES} bytes`)
  }
  if (text.trim().length === 0) {
    throw new ApiError('bad_request', 'Request body is empty')
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError('bad_request', 'Request body is not valid JSON')
  }
}

export function requireString(
  value: unknown,
  field: string,
  { maxLength = 1024, minLength = 1 }: { maxLength?: number; minLength?: number } = {},
): string {
  if (typeof value !== 'string') {
    throw new ApiError('bad_request', `\`${field}\` must be a string`)
  }
  const trimmed = value.trim()
  if (trimmed.length < minLength) {
    throw new ApiError('bad_request', `\`${field}\` must not be empty`)
  }
  if (trimmed.length > maxLength) {
    throw new ApiError('bad_request', `\`${field}\` must be ${maxLength} characters or fewer`)
  }
  return trimmed
}

export function optionalString(
  value: unknown,
  field: string,
  maxLength = 1024,
): string | undefined {
  if (value === undefined || value === null) return undefined
  return requireString(value, field, { maxLength })
}
