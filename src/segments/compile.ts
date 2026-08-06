import { type SQL, sql } from 'drizzle-orm'
import { devices } from '../db/schema.js'
import {
  type Condition,
  type Filter,
  FilterError,
  isAnd,
  isCondition,
  isNot,
  isOr,
} from './types.js'

/** Matches an optionally-signed integer or decimal. Kept in sync with validate.ts. */
const NUMERIC_SQL_RE = '^-?[0-9]+(\\.[0-9]+)?$'

/**
 * Compiles a validated filter tree into a boolean SQL expression over
 * `maksbas_devices`.
 *
 * Pass `null` to target every device.
 *
 * Semantics worth knowing:
 * - `eq` compiles to jsonb containment (`@>`) so it can use the GIN index.
 * - `neq` and `nin` match devices that lack the key entirely. "Not on the pro
 *   plan" includes everyone who never told us their plan.
 * - Numeric operators are wrapped in CASE, not AND. Postgres is free to reorder
 *   AND operands, so a regex guard sitting beside a cast does not reliably run
 *   first — a single device with `age: "nepoznato"` would abort the query.
 *   CASE has defined evaluation order.
 */
export function compileFilter(filter: Filter | null): SQL {
  if (filter === null) return sql`true`
  return compileNode(filter)
}

function compileNode(node: Filter): SQL {
  if (isAnd(node)) {
    if (node.and.length === 0) return sql`true`
    return joinBool(node.and.map(compileNode), 'and')
  }
  if (isOr(node)) {
    // An empty OR matches nothing — the opposite of an empty AND. Both are
    // reachable from `{or: []}` in a client payload, so neither may throw.
    if (node.or.length === 0) return sql`false`
    return joinBool(node.or.map(compileNode), 'or')
  }
  if (isNot(node)) {
    return sql`(not ${compileNode(node.not)})`
  }
  if (isCondition(node)) {
    return compileCondition(node)
  }
  throw new FilterError('Unrecognised filter node', '$')
}

function joinBool(parts: SQL[], op: 'and' | 'or'): SQL {
  const separator = op === 'and' ? sql` and ` : sql` or `
  return sql`(${sql.join(parts, separator)})`
}

function compileCondition(c: Condition): SQL {
  const value = sql`(${devices.attributes} ->> ${c.key})`

  switch (c.op) {
    case 'eq':
      // Containment rather than `->> = ...` so the GIN index is usable.
      return sql`(${devices.attributes} @> ${JSON.stringify({ [c.key]: c.value })}::jsonb)`

    case 'neq':
      return sql`(${value} is distinct from ${c.value as string})`

    case 'in':
      return sql`(${value} in (${sql.join(
        (c.value as string[]).map((v) => sql`${v}`),
        sql`, `,
      )}))`

    case 'nin':
      // COALESCE so a missing key (NULL) counts as "not in".
      return sql`(coalesce(${value} in (${sql.join(
        (c.value as string[]).map((v) => sql`${v}`),
        sql`, `,
      )}), false) = false)`

    case 'exists':
      return sql`(${devices.attributes} ? ${c.key})`

    case 'not_exists':
      return sql`(not (${devices.attributes} ? ${c.key}))`

    case 'contains':
      return like(value, `%${escapeLike(c.value as string)}%`)

    case 'starts_with':
      return like(value, `${escapeLike(c.value as string)}%`)

    case 'ends_with':
      return like(value, `%${escapeLike(c.value as string)}`)

    case 'gt':
      return numeric(value, sql`>`, c.value as string)
    case 'gte':
      return numeric(value, sql`>=`, c.value as string)
    case 'lt':
      return numeric(value, sql`<`, c.value as string)
    case 'lte':
      return numeric(value, sql`<=`, c.value as string)

    default: {
      const exhaustive: never = c.op
      throw new FilterError(`Unhandled operator "${String(exhaustive)}"`, '$')
    }
  }
}

function like(column: SQL, pattern: string): SQL {
  return sql`(${column} like ${pattern} escape '\\')`
}

/**
 * `CASE WHEN <looks numeric> THEN <compare> ELSE false END`.
 *
 * The ELSE branch is why a device with `age: "nepoznato"` quietly drops out of
 * an `age > 25` segment instead of raising `invalid input syntax for type numeric`.
 */
function numeric(column: SQL, op: SQL, value: string): SQL {
  return sql`(case when ${column} ~ ${NUMERIC_SQL_RE}
    then ${column}::numeric ${op} ${value}::numeric
    else false end)`
}

/** Escapes LIKE wildcards so a literal `%` in a user value stays literal. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
