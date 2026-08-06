import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { Filter } from '../segments/types.js'

/**
 * Attribute values are always strings. See README "Atributi" — this is a
 * deliberate contract choice: numeric comparison operators (gt/lt/gte/lte)
 * cast at query time behind a regex guard, so garbage values drop out of a
 * segment instead of blowing up the query.
 */
export type Attributes = Record<string, string>

export const devices = pgTable(
  'maksbas_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** FCM registration token. Unique — re-registering the same token updates the row. */
    fcmToken: text('fcm_token').notNull(),

    /** SHA-256 of the device secret handed to the SDK at registration. Never stored raw. */
    secretHash: text('secret_hash').notNull(),

    platform: text('platform').notNull().default('android'),

    attributes: jsonb('attributes').$type<Attributes>().notNull().default({}),

    /** Whether the OS-level notification permission is currently granted. */
    notificationsEnabled: boolean('notifications_enabled').notNull().default(false),

    /** Flipped to false when FCM reports the token is dead. Excluded from all sends. */
    active: boolean('active').notNull().default(true),

    appVersion: text('app_version'),
    sdkVersion: text('sdk_version'),
    deviceModel: text('device_model'),
    osVersion: text('os_version'),
    language: text('language'),
    timezone: text('timezone'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fcmTokenIdx: uniqueIndex('maksbas_devices_fcm_token_idx').on(t.fcmToken),
    // GIN over the whole attributes document — powers containment lookups.
    attributesIdx: index('maksbas_devices_attributes_idx').using('gin', t.attributes),
    // Every send walks this: active rows ordered by id (the drain cursor).
    activeIdx: index('maksbas_devices_active_id_idx').on(t.active, t.id),
  }),
)

export const segments = pgTable(
  'maksbas_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description'),
    filter: jsonb('filter').$type<Filter>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: uniqueIndex('maksbas_segments_name_idx').on(t.name),
  }),
)

/**
 * `sending` walks the device cursor; `retrying` replays the devices that failed
 * transiently during that walk. Both are unfinished states the drain will claim.
 */
export type NotificationStatus = 'pending' | 'sending' | 'retrying' | 'completed' | 'failed'

export const UNFINISHED_STATUSES = ['pending', 'sending', 'retrying'] as const

export const notifications = pgTable(
  'maksbas_notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    title: text('title').notNull(),
    body: text('body').notNull(),
    image: text('image'),
    deeplink: text('deeplink'),
    /** Arbitrary key/value payload handed to the app on open. */
    data: jsonb('data').$type<Record<string, string>>(),

    /** Resolved at creation time. null targets every active device. */
    filter: jsonb('filter').$type<Filter | null>(),
    /** Kept for reporting only — the filter above is already resolved. */
    segmentName: text('segment_name'),

    status: text('status').$type<NotificationStatus>().notNull().default('pending'),

    /**
     * Highest device id already processed. The drain resumes at `id > cursor`,
     * which is what makes a killed function safe to restart.
     */
    cursor: uuid('cursor'),

    sentCount: integer('sent_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),

    /**
     * Devices whose send failed transiently (FCM `UNAVAILABLE`, `INTERNAL`, a
     * network blip). The cursor has already moved past them, so they are parked
     * here and replayed once the main pass finishes.
     *
     * This is the accumulator for the *next* round. Keeping it separate from
     * `retryQueue` is what makes the replay terminate: a round drains a fixed
     * snapshot, and anything that fails again lands here rather than back in the
     * queue it was just taken from.
     */
    retryIds: jsonb('retry_ids').$type<string[]>().notNull().default([]),
    /** The snapshot the current retry round is working through. */
    retryQueue: jsonb('retry_queue').$type<string[]>().notNull().default([]),
    /** Retry rounds already spent. Capped so a long outage can't loop forever. */
    retryRound: integer('retry_round').notNull().default(0),

    /**
     * Claim held by the worker currently draining this row. A crashed worker's
     * claim expires on its own, so the notification is never stuck forever.
     */
    leaseUntil: timestamp('lease_until', { withTimezone: true }),

    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    // The drain's claim query: unfinished work, oldest first.
    pendingIdx: index('maksbas_notifications_pending_idx').on(t.status, t.createdAt),
  }),
)

export type EventType = 'delivered' | 'opened'

export const events = pgTable(
  'maksbas_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    type: text('type').$type<EventType>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Devices retry event delivery, so the same event arrives more than once.
    // This makes the second one a no-op instead of a double count.
    uniqueIdx: uniqueIndex('maksbas_events_unique_idx').on(
      t.notificationId,
      t.deviceId,
      t.type,
    ),
    notificationIdx: index('maksbas_events_notification_idx').on(t.notificationId, t.type),
  }),
)

export const schema = { devices, segments, notifications, events }

export type Device = typeof devices.$inferSelect
export type Segment = typeof segments.$inferSelect
export type Notification = typeof notifications.$inferSelect
export type NotificationEvent = typeof events.$inferSelect

/** Marker so the migration runner and the schema can't silently drift apart. */
export const SCHEMA_VERSION = 1

export const NOW = sql`now()`
