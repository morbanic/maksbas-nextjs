import {
  ARRAY_OPERATORS,
  type Condition,
  type Filter,
  FilterError,
  MAX_FILTER_CONDITIONS,
  MAX_FILTER_DEPTH,
  MAX_IN_VALUES,
  NULLARY_OPERATORS,
  NUMERIC_OPERATORS,
  OPERATORS,
  type Operator,
  isAnd,
  isCondition,
  isNot,
  isOr,
} from './types.js'

const NUMERIC_RE = /^-?\d+(\.\d+)?$/

/**
 * Validates an untrusted filter before it reaches the compiler.
 *
 * The compiler assumes a well-formed tree, so every 400-worthy problem has to be
 * caught here — including the non-obvious one: a numeric operator with a
 * non-numeric value can never match anything, which would silently send a
 * notification to nobody. That is a client bug worth surfacing loudly.
 *
 * @throws {FilterError}
 */
export function validateFilter(filter: unknown, path = '$'): asserts filter is Filter {
  let conditions = 0

  const walk = (node: unknown, depth: number, at: string): void => {
    if (depth > MAX_FILTER_DEPTH) {
      throw new FilterError(`Filter nested deeper than ${MAX_FILTER_DEPTH}`, at)
    }
    if (typeof node !== 'object' || node === null || Array.isArray(node)) {
      throw new FilterError('Expected a filter object', at)
    }

    const f = node as Filter

    if (isAnd(f)) {
      if (!Array.isArray(f.and)) throw new FilterError('`and` must be an array', at)
      f.and.forEach((child, i) => walk(child, depth + 1, `${at}.and[${i}]`))
      return
    }
    if (isOr(f)) {
      if (!Array.isArray(f.or)) throw new FilterError('`or` must be an array', at)
      f.or.forEach((child, i) => walk(child, depth + 1, `${at}.or[${i}]`))
      return
    }
    if (isNot(f)) {
      walk(f.not, depth + 1, `${at}.not`)
      return
    }
    if (!isCondition(f)) {
      throw new FilterError('Expected `and`, `or`, `not`, or a {key, op} condition', at)
    }

    conditions += 1
    if (conditions > MAX_FILTER_CONDITIONS) {
      throw new FilterError(`Filter has more than ${MAX_FILTER_CONDITIONS} conditions`, at)
    }
    validateCondition(f, at)
  }

  walk(filter, 0, path)
}

function validateCondition(c: Condition, at: string): void {
  if (typeof c.key !== 'string' || c.key.length === 0) {
    throw new FilterError('`key` must be a non-empty string', at)
  }
  if (c.key.length > 128) {
    throw new FilterError('`key` must be 128 characters or fewer', at)
  }
  if (!OPERATORS.includes(c.op)) {
    throw new FilterError(
      `Unknown operator "${String(c.op)}". Expected one of: ${OPERATORS.join(', ')}`,
      at,
    )
  }

  const op: Operator = c.op

  if (NULLARY_OPERATORS.has(op)) {
    if (c.value !== undefined) {
      throw new FilterError(`Operator "${op}" does not take a value`, at)
    }
    return
  }

  if (ARRAY_OPERATORS.has(op)) {
    if (!Array.isArray(c.value)) {
      throw new FilterError(`Operator "${op}" requires an array value`, at)
    }
    if (c.value.length === 0) {
      throw new FilterError(`Operator "${op}" requires a non-empty array`, at)
    }
    if (c.value.length > MAX_IN_VALUES) {
      throw new FilterError(`Operator "${op}" accepts at most ${MAX_IN_VALUES} values`, at)
    }
    if (!c.value.every((v) => typeof v === 'string')) {
      throw new FilterError(`Operator "${op}" requires an array of strings`, at)
    }
    return
  }

  if (typeof c.value !== 'string') {
    throw new FilterError(
      `Operator "${op}" requires a string value (attributes are always strings)`,
      at,
    )
  }

  if (NUMERIC_OPERATORS.has(op) && !NUMERIC_RE.test(c.value)) {
    throw new FilterError(
      `Operator "${op}" compares numerically, but "${c.value}" is not a number. ` +
        'It would match zero devices.',
      at,
    )
  }
}

export { NUMERIC_RE }
