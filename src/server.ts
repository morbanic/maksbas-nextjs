import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { type MaksbasConfig, type ResolvedConfig, isResolved, resolveConfig } from './config.js'
import { type Device, type Notification, devices, events, notifications, segments } from './db/schema.js'
import { drainOnce } from './notifications/drain.js'
import { triggerDrain } from './notifications/chain.js'
import { compileFilter } from './segments/compile.js'
import type { Filter } from './segments/types.js'
import { validateFilter } from './segments/validate.js'

export interface SendInput {
  title: string
  body: string
  image?: string
  deeplink?: string
  data?: Record<string, string | number | boolean>
  /** Inline audience filter. Mutually exclusive with `segment`. */
  filter?: Filter
  /** Name of a saved segment. Mutually exclusive with `filter`. */
  segment?: string
}

/**
 * Server-side API for your own code — no HTTP, no keys, straight to the database.
 *
 * ```ts
 * import { createServerClient } from 'maksbas-nextjs/server'
 * const maksbas = createServerClient({ db, ... })
 * await maksbas.send({ title: 'Popust 20%', body: 'Samo danas', segment: 'pro' })
 * ```
 */
export function createServerClient(config: MaksbasConfig | ResolvedConfig) {
  const resolved: ResolvedConfig = isResolved(config) ? config : resolveConfig(config)

  return {
    /**
     * Queues a notification and gives it a head start, exactly like the HTTP
     * endpoint. Resolves as soon as the send is under way — not when it finishes.
     */
    async send(input: SendInput): Promise<Notification> {
      if (input.filter && input.segment) {
        throw new Error('[maksbas] pass either `filter` or `segment`, not both')
      }

      let filter: Filter | null = null
      let segmentName: string | null = null

      if (input.segment) {
        const [segment] = await resolved.db
          .select()
          .from(segments)
          .where(eq(segments.name, input.segment))
          .limit(1)
        if (!segment) throw new Error(`[maksbas] no segment named "${input.segment}"`)
        filter = segment.filter
        segmentName = input.segment
      } else if (input.filter) {
        validateFilter(input.filter)
        filter = input.filter
      }

      const data = input.data
        ? Object.fromEntries(Object.entries(input.data).map(([k, v]) => [k, String(v)]))
        : null

      const [created] = await resolved.db
        .insert(notifications)
        .values({
          title: input.title,
          body: input.body,
          image: input.image ?? null,
          deeplink: input.deeplink ?? null,
          data,
          filter,
          segmentName,
          status: 'pending',
        })
        .returning()

      if (!created) throw new Error('[maksbas] failed to create notification')

      const report =
        resolved.inlineDrainMs > 0
          ? await drainOnce(resolved, {
              timeBudgetMs: resolved.inlineDrainMs,
              maxNotifications: 1,
            })
          : { hasMore: true, blocked: false }

      if (report.hasMore && !report.blocked) await triggerDrain(resolved)

      const [current] = await resolved.db
        .select()
        .from(notifications)
        .where(eq(notifications.id, created.id))
        .limit(1)

      return current ?? created
    },

    /** Progress and delivery numbers for one notification. */
    async status(notificationId: string) {
      const [notification] = await resolved.db
        .select()
        .from(notifications)
        .where(eq(notifications.id, notificationId))
        .limit(1)

      if (!notification) return null

      const counts = await resolved.db
        .select({ type: events.type, count: sql<number>`count(*)::int` })
        .from(events)
        .where(eq(events.notificationId, notificationId))
        .groupBy(events.type)

      return {
        ...notification,
        delivered: counts.find((c) => c.type === 'delivered')?.count ?? 0,
        opened: counts.find((c) => c.type === 'opened')?.count ?? 0,
      }
    },

    /** Most recent notifications first. */
    async recent(limit = 20): Promise<Notification[]> {
      return resolved.db
        .select()
        .from(notifications)
        .orderBy(desc(notifications.createdAt))
        .limit(limit)
    },

    devices: {
      /** How many active devices a filter reaches right now. */
      async count(filter: Filter | null = null): Promise<number> {
        if (filter) validateFilter(filter)
        const [row] = await resolved.db
          .select({ count: sql<number>`count(*)::int` })
          .from(devices)
          .where(and(eq(devices.active, true), compileFilter(filter)))
        return row?.count ?? 0
      },

      /** Page through devices, optionally filtered. Cursor is the last id seen. */
      async list({
        filter = null,
        limit = 50,
        cursor = null,
      }: { filter?: Filter | null; limit?: number; cursor?: string | null } = {}): Promise<{
        devices: Device[]
        nextCursor: string | null
      }> {
        if (filter) validateFilter(filter)

        const conditions = [compileFilter(filter)]
        if (cursor) conditions.push(sql`${devices.id} > ${cursor}::uuid`)

        const rows = await resolved.db
          .select()
          .from(devices)
          .where(and(...conditions))
          .orderBy(asc(devices.id))
          .limit(limit + 1)

        const hasMore = rows.length > limit
        const page = hasMore ? rows.slice(0, limit) : rows
        return {
          devices: page,
          nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
        }
      },
    },

    segments: {
      async upsert(name: string, filter: Filter, description?: string) {
        validateFilter(filter)
        const [row] = await resolved.db
          .insert(segments)
          .values({ name, filter, description: description ?? null })
          .onConflictDoUpdate({
            target: segments.name,
            set: { filter, description: description ?? null, updatedAt: new Date() },
          })
          .returning()
        return row
      },

      async list() {
        return resolved.db.select().from(segments).orderBy(segments.name)
      },

      async remove(name: string) {
        await resolved.db.delete(segments).where(eq(segments.name, name))
      },
    },

    /** Continues unfinished sends. Call on an interval if you run a long-lived server. */
    drain: (options?: Parameters<typeof drainOnce>[1]) => drainOnce(resolved, options),
  }
}

export type MaksbasServerClient = ReturnType<typeof createServerClient>
