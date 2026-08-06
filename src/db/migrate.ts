import { sql } from 'drizzle-orm'
import type { MaksbasDb } from './types.js'

/**
 * Migrations are plain idempotent SQL rather than drizzle-kit artifacts, so the
 * package works against whatever Drizzle driver the host app already uses
 * (node-postgres, postgres.js, Neon serverless, PGlite in tests) without
 * shipping a second migration toolchain into their project.
 *
 * Each entry runs exactly once and is recorded. Never edit a shipped migration —
 * append a new one.
 */
type Migration = { id: string; sql: string }

const MIGRATIONS: Migration[] = [
  {
    id: '0001_init',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS maksbas_devices (
        id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        fcm_token             text NOT NULL,
        secret_hash           text NOT NULL,
        platform              text NOT NULL DEFAULT 'android',
        attributes            jsonb NOT NULL DEFAULT '{}'::jsonb,
        notifications_enabled boolean NOT NULL DEFAULT false,
        active                boolean NOT NULL DEFAULT true,
        app_version           text,
        sdk_version           text,
        device_model          text,
        os_version            text,
        language              text,
        timezone              text,
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now(),
        last_seen_at          timestamptz NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS maksbas_devices_fcm_token_idx
        ON maksbas_devices (fcm_token);
      CREATE INDEX IF NOT EXISTS maksbas_devices_attributes_idx
        ON maksbas_devices USING gin (attributes);
      CREATE INDEX IF NOT EXISTS maksbas_devices_active_id_idx
        ON maksbas_devices (active, id);

      CREATE TABLE IF NOT EXISTS maksbas_segments (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name        text NOT NULL,
        description text,
        filter      jsonb NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS maksbas_segments_name_idx
        ON maksbas_segments (name);

      CREATE TABLE IF NOT EXISTS maksbas_notifications (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title        text NOT NULL,
        body         text NOT NULL,
        image        text,
        deeplink     text,
        data         jsonb,
        filter       jsonb,
        segment_name text,
        status       text NOT NULL DEFAULT 'pending',
        cursor       uuid,
        sent_count   integer NOT NULL DEFAULT 0,
        failed_count integer NOT NULL DEFAULT 0,
        retry_ids    jsonb NOT NULL DEFAULT '[]'::jsonb,
        retry_queue  jsonb NOT NULL DEFAULT '[]'::jsonb,
        retry_round  integer NOT NULL DEFAULT 0,
        lease_until  timestamptz,
        error        text,
        created_at   timestamptz NOT NULL DEFAULT now(),
        started_at   timestamptz,
        completed_at timestamptz
      );

      CREATE INDEX IF NOT EXISTS maksbas_notifications_pending_idx
        ON maksbas_notifications (status, created_at);

      CREATE TABLE IF NOT EXISTS maksbas_events (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        notification_id uuid NOT NULL REFERENCES maksbas_notifications (id) ON DELETE CASCADE,
        device_id       uuid NOT NULL REFERENCES maksbas_devices (id) ON DELETE CASCADE,
        type            text NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS maksbas_events_unique_idx
        ON maksbas_events (notification_id, device_id, type);
      CREATE INDEX IF NOT EXISTS maksbas_events_notification_idx
        ON maksbas_events (notification_id, type);
    `,
  },
]

/**
 * Creates every Maksbas table. Safe to call on every boot — already-applied
 * migrations are skipped.
 */
export async function migrate(db: MaksbasDb): Promise<{ applied: string[] }> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS maksbas_migrations (
      id         text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  const rows = await db.execute(sql`SELECT id FROM maksbas_migrations`)
  const done = new Set(toRows<{ id: string }>(rows).map((r) => r.id))

  const applied: string[] = []
  for (const migration of MIGRATIONS) {
    if (done.has(migration.id)) continue
    for (const statement of splitStatements(migration.sql)) {
      await db.execute(sql.raw(statement))
    }
    await db.execute(
      sql`INSERT INTO maksbas_migrations (id) VALUES (${migration.id}) ON CONFLICT DO NOTHING`,
    )
    applied.push(migration.id)
  }

  return { applied }
}

/**
 * Splits a migration into single statements.
 *
 * Drivers speaking the extended query protocol — PGlite, and node-postgres the
 * moment a query carries parameters — reject multi-statement strings outright,
 * so migrations have to be fed one at a time.
 *
 * The split is a plain scan on `;`, which holds only because these migrations
 * contain no semicolons inside string literals or function bodies. A future
 * migration that needs one must be added as its own entry instead.
 */
function splitStatements(migrationSql: string): string[] {
  return migrationSql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

/**
 * Drivers disagree on the shape of `execute()`: node-postgres returns a
 * `QueryResult` with `.rows`, postgres.js and PGlite return arrays or `.rows`
 * depending on version. Normalise once here.
 */
export function toRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows
  }
  return []
}
