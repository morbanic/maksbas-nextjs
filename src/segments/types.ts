/**
 * Attribute values are strings, so every operator below is defined over strings.
 * The four numeric operators are the exception and are documented on `Operator`.
 */
export const OPERATORS = [
  'eq',
  'neq',
  'in',
  'nin',
  'exists',
  'not_exists',
  'contains',
  'starts_with',
  'ends_with',
  'gt',
  'gte',
  'lt',
  'lte',
] as const

export type Operator = (typeof OPERATORS)[number]

/** Operators that take no `value`. */
export const NULLARY_OPERATORS: ReadonlySet<Operator> = new Set(['exists', 'not_exists'])

/** Operators whose `value` is an array of strings. */
export const ARRAY_OPERATORS: ReadonlySet<Operator> = new Set(['in', 'nin'])

/**
 * Operators compared numerically. Since attributes are stored as strings, these
 * are guarded by a regex so a device whose value is not a number simply drops
 * out of the segment rather than aborting the whole query with a cast error.
 */
export const NUMERIC_OPERATORS: ReadonlySet<Operator> = new Set(['gt', 'gte', 'lt', 'lte'])

export interface Condition {
  key: string
  op: Operator
  value?: string | string[]
}

export type Filter =
  | Condition
  | { and: Filter[] }
  | { or: Filter[] }
  | { not: Filter }

export function isAnd(f: Filter): f is { and: Filter[] } {
  return typeof f === 'object' && f !== null && 'and' in f
}

export function isOr(f: Filter): f is { or: Filter[] } {
  return typeof f === 'object' && f !== null && 'or' in f
}

export function isNot(f: Filter): f is { not: Filter } {
  return typeof f === 'object' && f !== null && 'not' in f
}

export function isCondition(f: Filter): f is Condition {
  return typeof f === 'object' && f !== null && 'key' in f && 'op' in f
}

export class FilterError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} (at ${path})`)
    this.name = 'FilterError'
  }
}

/** Guards against a hostile or accidentally recursive filter melting the planner. */
export const MAX_FILTER_DEPTH = 10
export const MAX_FILTER_CONDITIONS = 100
export const MAX_IN_VALUES = 500
