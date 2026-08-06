import type { Attributes } from '../db/schema.js'
import { ApiError } from '../http/errors.js'

export const MAX_ATTRIBUTE_KEYS = 100
export const MAX_KEY_LENGTH = 128
export const MAX_VALUE_LENGTH = 1024

/**
 * Validates an attribute patch and merges it onto the device's current attributes.
 *
 * A `null` value deletes the key. That is the whole logout story: attributes are
 * plain key/value pairs with no special user field, so signing a user out means
 * `setAttributes({ userId: null })`. Without deletion by null there would be no
 * way to clear an attribute at all.
 *
 * Numbers and booleans are coerced to strings rather than rejected — the storage
 * contract is string-only, and rejecting `{ age: 34 }` would be a papercut on
 * every single integration.
 */
export function mergeAttributes(current: Attributes, patch: unknown): Attributes {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new ApiError('bad_request', '`attributes` must be an object')
  }

  const next: Attributes = { ...current }

  for (const [key, raw] of Object.entries(patch)) {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
      throw new ApiError(
        'bad_request',
        `Attribute key "${truncate(key)}" must be between 1 and ${MAX_KEY_LENGTH} characters`,
      )
    }

    if (raw === null || raw === undefined) {
      delete next[key]
      continue
    }

    const value = coerce(raw, key)
    if (value.length > MAX_VALUE_LENGTH) {
      throw new ApiError(
        'bad_request',
        `Attribute "${key}" exceeds ${MAX_VALUE_LENGTH} characters`,
      )
    }
    next[key] = value
  }

  if (Object.keys(next).length > MAX_ATTRIBUTE_KEYS) {
    throw new ApiError(
      'bad_request',
      `A device may hold at most ${MAX_ATTRIBUTE_KEYS} attributes (got ${Object.keys(next).length})`,
    )
  }

  return next
}

function coerce(raw: unknown, key: string): string {
  switch (typeof raw) {
    case 'string':
      return raw
    case 'number':
      if (!Number.isFinite(raw)) {
        throw new ApiError('bad_request', `Attribute "${key}" must be a finite number`)
      }
      return String(raw)
    case 'boolean':
      return raw ? 'true' : 'false'
    default:
      throw new ApiError(
        'bad_request',
        `Attribute "${key}" must be a string, number, boolean, or null — ` +
          'nested objects and arrays are not supported',
      )
  }
}

function truncate(value: string, max = 32): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}
