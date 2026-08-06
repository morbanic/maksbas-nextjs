import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '../src/config.js'
import { devices } from '../src/db/schema.js'
import { compileFilter } from '../src/segments/compile.js'
import { FilterError, type Filter } from '../src/segments/types.js'
import { validateFilter } from '../src/segments/validate.js'
import { createTestConfig } from './helpers.js'

let config: ResolvedConfig

/** Names make the expectations below readable. */
const PEOPLE: Array<{ name: string; attributes: Record<string, string> }> = [
  { name: 'ana', attributes: { plan: 'pro', city: 'ST', age: '34', tag: 'beta-tester' } },
  { name: 'bruno', attributes: { plan: 'free', city: 'ZG', age: '25' } },
  { name: 'cvita', attributes: { plan: 'pro', city: 'ZG', age: '9' } },
  { name: 'dario', attributes: { plan: 'pro', city: 'ST', age: 'nepoznato' } },
  { name: 'eva', attributes: {} },
]

beforeAll(async () => {
  config = await createTestConfig()
  await config.db.insert(devices).values(
    PEOPLE.map((p) => ({
      fcmToken: `token_${p.name}`,
      secretHash: 'unused',
      attributes: { name: p.name, ...p.attributes },
    })),
  )
})

async function matching(filter: Filter | null): Promise<string[]> {
  const rows = await config.db
    .select({ attributes: devices.attributes })
    .from(devices)
    .where(and(eq(devices.active, true), compileFilter(filter)))
  return rows.map((r) => r.attributes.name as string).sort()
}

describe('compileFilter — basic operators', () => {
  it('eq matches exact string values', async () => {
    expect(await matching({ key: 'plan', op: 'eq', value: 'pro' })).toEqual([
      'ana',
      'cvita',
      'dario',
    ])
  })

  it('neq also matches devices missing the key entirely', async () => {
    // "not on the pro plan" has to include people who never told us their plan,
    // otherwise they fall out of every segment and never hear from you again.
    expect(await matching({ key: 'plan', op: 'neq', value: 'pro' })).toEqual(['bruno', 'eva'])
  })

  it('in matches any of the listed values', async () => {
    expect(await matching({ key: 'city', op: 'in', value: ['ST', 'RI'] })).toEqual([
      'ana',
      'dario',
    ])
  })

  it('nin excludes the listed values and keeps devices missing the key', async () => {
    expect(await matching({ key: 'city', op: 'nin', value: ['ZG'] })).toEqual([
      'ana',
      'dario',
      'eva',
    ])
  })

  it('exists / not_exists check for the key', async () => {
    expect(await matching({ key: 'plan', op: 'exists' })).toEqual([
      'ana',
      'bruno',
      'cvita',
      'dario',
    ])
    expect(await matching({ key: 'plan', op: 'not_exists' })).toEqual(['eva'])
  })

  it('contains / starts_with / ends_with do substring matching', async () => {
    expect(await matching({ key: 'tag', op: 'contains', value: 'test' })).toEqual(['ana'])
    expect(await matching({ key: 'tag', op: 'starts_with', value: 'beta' })).toEqual(['ana'])
    expect(await matching({ key: 'tag', op: 'ends_with', value: 'tester' })).toEqual(['ana'])
  })
})

describe('compileFilter — numeric comparison on string attributes', () => {
  it('compares numerically, not lexicographically', async () => {
    // The whole reason for the numeric branch: "9" > "25" as text, but 9 < 25.
    expect(await matching({ key: 'age', op: 'gt', value: '25' })).toEqual(['ana'])
    expect(await matching({ key: 'age', op: 'gte', value: '25' })).toEqual(['ana', 'bruno'])
    expect(await matching({ key: 'age', op: 'lt', value: '25' })).toEqual(['cvita'])
  })

  it('drops non-numeric values instead of aborting the query', async () => {
    // dario has age "nepoznato". Without the CASE guard this whole query dies
    // with `invalid input syntax for type numeric` and nobody gets the push.
    const result = await matching({ key: 'age', op: 'gt', value: '0' })
    expect(result).toEqual(['ana', 'bruno', 'cvita'])
    expect(result).not.toContain('dario')
  })

  it('survives a garbage value even when it is the only device', async () => {
    const fresh = await createTestConfig()
    await fresh.db.insert(devices).values({
      fcmToken: 'lonely',
      secretHash: 'unused',
      attributes: { name: 'zero', age: 'nije broj' },
    })

    const rows = await fresh.db
      .select({ attributes: devices.attributes })
      .from(devices)
      .where(compileFilter({ key: 'age', op: 'lt', value: '100' }))

    expect(rows).toEqual([])
  })
})

describe('compileFilter — boolean composition', () => {
  it('ands conditions together', async () => {
    expect(
      await matching({
        and: [
          { key: 'plan', op: 'eq', value: 'pro' },
          { key: 'city', op: 'eq', value: 'ST' },
        ],
      }),
    ).toEqual(['ana', 'dario'])
  })

  it('ors conditions together', async () => {
    expect(
      await matching({
        or: [
          { key: 'city', op: 'eq', value: 'RI' },
          { key: 'plan', op: 'eq', value: 'free' },
        ],
      }),
    ).toEqual(['bruno'])
  })

  it('nests and/or/not', async () => {
    expect(
      await matching({
        and: [
          { key: 'plan', op: 'eq', value: 'pro' },
          { not: { key: 'city', op: 'eq', value: 'ZG' } },
        ],
      }),
    ).toEqual(['ana', 'dario'])
  })

  it('treats an empty and as everyone and an empty or as nobody', async () => {
    expect(await matching({ and: [] })).toHaveLength(PEOPLE.length)
    expect(await matching({ or: [] })).toEqual([])
  })

  it('null targets everyone', async () => {
    expect(await matching(null)).toHaveLength(PEOPLE.length)
  })
})

describe('compileFilter — injection safety', () => {
  it('treats SQL metacharacters in values as literal text', async () => {
    expect(await matching({ key: 'plan', op: 'eq', value: "pro' OR '1'='1" })).toEqual([])
  })

  it('treats SQL metacharacters in keys as literal text', async () => {
    expect(await matching({ key: "plan') OR true --", op: 'exists' })).toEqual([])
  })

  it('treats LIKE wildcards in values as literal characters', async () => {
    // Without escaping, '%' would match every device that has a tag at all.
    expect(await matching({ key: 'tag', op: 'contains', value: '%' })).toEqual([])
  })
})

describe('validateFilter', () => {
  it('rejects an unknown operator', () => {
    expect(() => validateFilter({ key: 'plan', op: 'sorta_eq', value: 'pro' })).toThrow(
      FilterError,
    )
  })

  it('rejects a non-numeric value on a numeric operator', () => {
    // This would compile to a query matching nobody. Silently sending to zero
    // devices is worse than a 422.
    expect(() => validateFilter({ key: 'age', op: 'gt', value: 'trideset' })).toThrow(
      /not a number/,
    )
  })

  it('rejects a value on a nullary operator', () => {
    expect(() => validateFilter({ key: 'plan', op: 'exists', value: 'pro' })).toThrow(
      /does not take a value/,
    )
  })

  it('rejects an empty in list', () => {
    expect(() => validateFilter({ key: 'city', op: 'in', value: [] })).toThrow(/non-empty/)
  })

  it('rejects a non-string value', () => {
    expect(() => validateFilter({ key: 'age', op: 'eq', value: 34 })).toThrow(
      /requires a string value/,
    )
  })

  it('rejects excessive nesting', () => {
    let filter: Filter = { key: 'a', op: 'exists' }
    for (let i = 0; i < 15; i++) filter = { and: [filter] }
    expect(() => validateFilter(filter)).toThrow(/nested deeper/)
  })

  it('accepts a well-formed nested filter', () => {
    expect(() =>
      validateFilter({
        and: [
          { key: 'plan', op: 'eq', value: 'pro' },
          { or: [{ key: 'city', op: 'in', value: ['ST', 'ZG'] }, { key: 'vip', op: 'exists' }] },
        ],
      }),
    ).not.toThrow()
  })
})
