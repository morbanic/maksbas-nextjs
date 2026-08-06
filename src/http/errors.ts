export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'invalid_filter'
  | 'internal'

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  invalid_filter: 422,
  internal: 500,
}

export class ApiError extends Error {
  readonly status: number

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = STATUS[code]
  }
}

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return json(
      { error: { code: error.code, message: error.message, details: error.details } },
      error.status,
    )
  }

  // Anything unexpected is logged in full but reported opaquely — error text can
  // carry connection strings and token fragments.
  console.error('[maksbas] unhandled error', error)
  return json({ error: { code: 'internal', message: 'Internal server error' } }, 500)
}
