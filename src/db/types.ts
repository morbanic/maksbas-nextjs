import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'

/**
 * Any Drizzle Postgres handle: node-postgres, postgres.js, Neon serverless, or
 * PGlite. Left generic on purpose — the host app keeps whatever driver and
 * Drizzle version it already has, and we only rely on the shared pg-core surface.
 */
// biome-ignore lint/suspicious/noExplicitAny: the schema/session generics differ per driver.
export type MaksbasDb = PgDatabase<PgQueryResultHKT, any, any>
