import { eq, sql } from 'drizzle-orm'
import type { ResolvedConfig } from '../config.js'
import { devices, segments } from '../db/schema.js'
import { optionalString, readJson, requireString } from '../http/body.js'
import { requireSecretKey } from '../http/auth.js'
import { ApiError, json } from '../http/errors.js'
import { compileFilter } from '../segments/compile.js'
import { type Filter, FilterError } from '../segments/types.js'
import { validateFilter } from '../segments/validate.js'
import { and } from 'drizzle-orm'

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i

/** GET /segments — every saved segment with its current size. Auth: secret key. */
export async function listSegments(request: Request, config: ResolvedConfig): Promise<Response> {
  requireSecretKey(request, config)

  const rows = await config.db.select().from(segments).orderBy(segments.name)

  // Sizes are counted live, one query per segment. Fine for the handful of
  // segments a project actually keeps; if that ever stops being true, this is
  // the line to revisit.
  const withCounts = await Promise.all(
    rows.map(async (segment) => ({
      ...segment,
      deviceCount: await countMatching(config, segment.filter),
    })),
  )

  return json({ segments: withCounts })
}

/** POST /segments — create a named segment. Auth: secret key. */
export async function createSegment(request: Request, config: ResolvedConfig): Promise<Response> {
  requireSecretKey(request, config)

  const body = await readJson<{ name?: unknown; description?: unknown; filter?: unknown }>(request)
  const name = requireString(body.name, 'name', { maxLength: 128 })

  if (!NAME_RE.test(name)) {
    throw new ApiError(
      'bad_request',
      '`name` may contain letters, digits, dots, dashes and underscores only',
    )
  }

  const filter = parseFilter(body.filter)

  const existing = await config.db
    .select({ id: segments.id })
    .from(segments)
    .where(eq(segments.name, name))
    .limit(1)

  if (existing.length > 0) {
    throw new ApiError('conflict', `A segment named "${name}" already exists`)
  }

  const [created] = await config.db
    .insert(segments)
    .values({
      name,
      description: optionalString(body.description, 'description', 512) ?? null,
      filter,
    })
    .returning()

  return json({ ...created, deviceCount: await countMatching(config, filter) }, 201)
}

/** GET /segments/:name — one segment plus its current size. */
export async function getSegment(
  request: Request,
  config: ResolvedConfig,
  name: string,
): Promise<Response> {
  requireSecretKey(request, config)

  const segment = await findSegment(config, name)
  return json({ ...segment, deviceCount: await countMatching(config, segment.filter) })
}

/**
 * PUT /segments/:name — replace a segment's filter.
 *
 * Sends already in flight are unaffected: a notification resolves and stores its
 * filter at creation time, so editing a segment never rewrites the audience of a
 * send that is halfway through.
 */
export async function updateSegment(
  request: Request,
  config: ResolvedConfig,
  name: string,
): Promise<Response> {
  requireSecretKey(request, config)

  const segment = await findSegment(config, name)
  const body = await readJson<{ description?: unknown; filter?: unknown }>(request)

  const filter = body.filter === undefined ? segment.filter : parseFilter(body.filter)

  const [updated] = await config.db
    .update(segments)
    .set({
      filter,
      description:
        body.description === undefined
          ? segment.description
          : (optionalString(body.description, 'description', 512) ?? null),
      updatedAt: new Date(),
    })
    .where(eq(segments.id, segment.id))
    .returning()

  return json({ ...updated, deviceCount: await countMatching(config, filter) })
}

/** DELETE /segments/:name */
export async function deleteSegment(
  request: Request,
  config: ResolvedConfig,
  name: string,
): Promise<Response> {
  requireSecretKey(request, config)

  const segment = await findSegment(config, name)
  await config.db.delete(segments).where(eq(segments.id, segment.id))
  return json({ deleted: true })
}

async function findSegment(config: ResolvedConfig, name: string) {
  const [segment] = await config.db
    .select()
    .from(segments)
    .where(eq(segments.name, name))
    .limit(1)

  if (!segment) throw new ApiError('not_found', `No segment named "${name}"`)
  return segment
}

function parseFilter(input: unknown): Filter {
  if (input == null) {
    throw new ApiError('bad_request', '`filter` is required')
  }
  try {
    validateFilter(input)
  } catch (error) {
    if (error instanceof FilterError) throw new ApiError('invalid_filter', error.message)
    throw error
  }
  return input as Filter
}

async function countMatching(config: ResolvedConfig, filter: Filter | null): Promise<number> {
  const [row] = await config.db
    .select({ count: sql<number>`count(*)::int` })
    .from(devices)
    .where(and(eq(devices.active, true), compileFilter(filter)))
  return row?.count ?? 0
}
