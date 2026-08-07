# maksbas-nextjs

Push notification backend for Next.js. Device registry, `key:value` attributes,
segmentation, FCM delivery.

One npm package plus one catch-all route. No dashboard, no geolocation, no
in-app messaging — the parts of OneSignal you actually use.

---

## Setup

### 1. Install

```bash
npm install maksbas-nextjs drizzle-orm
```

Straight from GitHub works too — `dist/` is not committed, so npm builds the
package from source during install via the `prepare` script:

```bash
npm install github:USER/maksbas-nextjs drizzle-orm     # default branch
npm install github:USER/maksbas-nextjs#v0.1.0          # pin to a tag
```

The one thing that breaks this is `npm install --ignore-scripts` (or a CI that
sets it globally) — `prepare` never runs and the package lands without `dist/`.
Allow scripts for this dependency, or install from a published tarball.

`drizzle-orm` is a peer dependency — the package uses whichever version and
driver your app already has (node-postgres, postgres.js, Neon, PGlite).

### 2. Environment

```bash
DATABASE_URL=postgres://...
MAKSBAS_PUBLIC_KEY=pk_live_...      # ships inside the mobile app
MAKSBAS_SECRET_KEY=sk_live_...      # server-side only, never in a bundle
CRON_SECRET=...                      # protects the drain endpoint
FCM_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

Generate the two keys with anything unguessable:

```bash
node -e "console.log('pk_live_' + require('crypto').randomBytes(24).toString('base64url'))"
node -e "console.log('sk_live_' + require('crypto').randomBytes(24).toString('base64url'))"
```

`FCM_SERVICE_ACCOUNT_JSON` is the whole file from Firebase Console → Project
Settings → Service accounts → **Generate new private key**. Paste the entire
JSON. If your host mangles newlines in the private key, the package repairs
literal `\n` sequences automatically.

### 3. The route

```ts
// app/api/maksbas/[...path]/route.ts
import { createHandler } from "maksbas-nextjs";
import { db } from "@/lib/db";

const maksbas = createHandler({
  db,
  publicKey: process.env.MAKSBAS_PUBLIC_KEY!,
  secretKey: process.env.MAKSBAS_SECRET_KEY!,
  cronSecret: process.env.CRON_SECRET,
  fcm: { serviceAccount: process.env.FCM_SERVICE_ACCOUNT_JSON! },
});

export const { GET, POST, PATCH, PUT, DELETE } = maksbas;

// Sending is CPU-light but wall-clock heavy; the Node runtime is required.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
```

### 4. Create the tables

Once, from a script or a one-off route:

```ts
import { migrate } from "maksbas-nextjs";
import { db } from "@/lib/db";

await migrate(db);
```

Creates four tables prefixed `maksbas_`, plus `maksbas_migrations` to track
what ran. Safe to call on every boot.

### 5. Cron

```json
// vercel.json
{
  "crons": [{ "path": "/api/maksbas/cron/drain", "schedule": "* * * * *" }]
}
```

**Vercel Hobby allows one cron run per day.** Most sends never need it — see
[How sending works](#how-sending-works) — but on Hobby a send interrupted
mid-flight waits up to a day to resume. Pro is required for minute-level
recovery.

Not on Vercel? Skip the cron and call `maksbas.drain()` on an interval from a
long-lived process instead.

---

## Dashboard

A second, optional route gives you a UI for devices and sent notifications.

```ts
// app/admin/maksbas/[[...path]]/route.ts
import { createAdminHandler } from "maksbas-nextjs/ui";
import { db } from "@/lib/db";

const admin = createAdminHandler({
  db,
  publicKey: process.env.MAKSBAS_PUBLIC_KEY!,
  secretKey: process.env.MAKSBAS_SECRET_KEY!,
  fcm: { serviceAccount: process.env.FCM_SERVICE_ACCOUNT_JSON! },
  password: process.env.MAKSBAS_ADMIN_PASSWORD,
});

export const { GET, POST, PATCH, DELETE } = admin;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
```

Open `/admin/maksbas`. That is the whole installation — the page is a single
HTML document with its CSS and JS inlined, so there is nothing to add to
`public/`, no bundler config, and no component to import.

Mounted anywhere else, pass `adminPath` to match:

```ts
createAdminHandler({ ...config, adminPath: "/dash/push" });
```

### What it does

| Tab             | What you can do                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `Notifications` | Every send with status, audience, sent/failed and delivered/opened. Resume a stalled one, delete a finished one. |
| `Devices`       | Search by id, token, model or attribute; filter active/inactive; edit attributes; deactivate; delete. |
| `Send`          | Compose a notification, target everyone / a saved segment / a filter, and size the audience before sending. |

Sends go through exactly the same code path as `POST /notifications`, so a
notification composed here behaves identically to one sent from your own server.

### Access

| Option                 | Default        | Notes                                                       |
| ---------------------- | -------------- | ----------------------------------------------------------- |
| `password`             | the secret key | Set `MAKSBAS_ADMIN_PASSWORD` — the secret key is also what your servers authenticate with, and this one gets typed into a browser. |
| `sessionMaxAgeSeconds` | `43200` (12h)  | Rotating the secret key invalidates every live session.     |

Signing in sets an `HttpOnly`, `SameSite=Lax` cookie holding a signed expiry and
nothing else. **The secret key never reaches the browser** — the page only ever
calls endpoints that hold it server-side. Writes additionally require a header a
cross-site form cannot set, and the page is served `no-store` and `noindex`.

The dashboard is one password in front of your whole device registry. Put it
behind your existing auth middleware too if you have one.

---

## Sending

From your own code, no HTTP:

```ts
import { createServerClient } from "maksbas-nextjs/server";

const maksbas = createServerClient({ db, publicKey, secretKey, fcm });

await maksbas.send({
  title: "Popust 20%",
  body: "Samo danas",
  deeplink: "app://promo/20",
  segment: "pro-korisnici",
});
```

Or over HTTP with the secret key:

```bash
curl -X POST https://app.hr/api/maksbas/notifications \
  -H "Authorization: Bearer $MAKSBAS_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Popust 20%",
    "body": "Samo danas",
    "filter": { "and": [
      { "key": "plan", "op": "eq", "value": "pro" },
      { "key": "city", "op": "in", "value": ["ST", "ZG"] }
    ]}
  }'
```

Responds `202` immediately. Poll `GET /notifications/:id` for progress.

---

## Attributes

Every device carries a flat `key: value` map. **Values are always strings** —
numbers and booleans are coerced, `null` deletes the key.

```ts
await Maksbas.setAttributes({ plan: "pro", age: 34, vip: true });
// stored as { plan: 'pro', age: '34', vip: 'true' }

await Maksbas.setAttributes({ userId: null }); // deletes the key
```

There is no dedicated user field. Linking a device to your user is
`setAttributes({ userId: '...' })`, and signing out is setting it to `null`.

Limits: 100 attributes per device, 128-character keys, 1024-character values.

---

## Segmentation

A filter is a JSON tree of conditions.

```json
{
  "and": [
    { "key": "plan", "op": "eq", "value": "pro" },
    {
      "or": [
        { "key": "city", "op": "in", "value": ["ST", "ZG"] },
        { "key": "vip", "op": "exists" }
      ]
    },
    { "not": { "key": "muted", "op": "eq", "value": "true" } }
  ]
}
```

### Operators

| Operator                                 | Value          | Notes                                      |
| ---------------------------------------- | -------------- | ------------------------------------------ |
| `eq`                                     | string         | Uses the GIN index                         |
| `neq`                                    | string         | **Also matches devices without the key**   |
| `in` / `nin`                             | string[]       | `nin` also matches devices without the key |
| `exists` / `not_exists`                  | —              |                                            |
| `contains` / `starts_with` / `ends_with` | string         | Wildcards in the value are literal         |
| `gt` / `gte` / `lt` / `lte`              | numeric string | See below                                  |

### Numeric comparison on string values

Attributes are strings, so `gt`/`lt` compare numerically behind a regex guard:

```sql
CASE WHEN attributes->>'age' ~ '^-?[0-9]+(\.[0-9]+)?$'
     THEN (attributes->>'age')::numeric > 25
     ELSE false END
```

Two consequences worth knowing:

- A device with `age: "nepoznato"` drops out of the segment. The query does not
  fail — which it would, non-deterministically, if the guard were an `AND`
  instead of a `CASE`, since Postgres may reorder `AND` operands.
- A device with `age: "34 godine"` will **never** match a numeric filter. It
  looks like data, so nothing warns you. Keep numeric attributes clean.

Passing a non-numeric value to `gt` is rejected with `422` rather than silently
matching nobody.

### Saved segments

```bash
curl -X POST https://app.hr/api/maksbas/segments \
  -H "Authorization: Bearer $MAKSBAS_SECRET_KEY" \
  -d '{"name":"pro-korisnici","filter":{"key":"plan","op":"eq","value":"pro"}}'
```

Then `{"segment": "pro-korisnici"}` when sending. Segments are evaluated at send
time, so membership is always current — there is no membership table to go
stale.

A notification resolves and **stores** its filter when created. Editing a segment
never rewrites the audience of a send already in flight.

---

## How sending works

A 50,000-device send is 50,000 HTTP requests to FCM. FCM v1 has no batch
endpoint — the one the old SDKs used was retired — so there is no way around
that. At 50 concurrent requests that is roughly 100 seconds, well past any
serverless function timeout.

So a send is a resumable cursor walk:

1. `POST /notifications` writes the row and drains **that row** for
   `inlineDrainMs` (3s by default). **Small audiences finish here** and never
   touch the cron.
2. If work remains — for this notification or any other — the request hands off
   to `/cron/drain` and returns `202`.
3. Each drain claims a notification with a 60-second lease, sends batches of
   500, and persists a cursor after each one.
4. Out of time, it releases the lease and hands off again.
5. Cron is the recovery net: if a function is killed between batches, the lease
   lapses and the next tick picks up at the cursor.

Being killed at any point costs at most one batch of duplicate work, never a
lost audience.

The inline drain in step 1 is pinned to the notification that was just created.
A drain that simply takes the *oldest* unfinished row instead — which is what
the cron does, correctly — turns one stalled notification at the head of the
queue into an off-by-one: every send delivers the previous message.

### Claiming, without transactions

The claim is a single `UPDATE` whose `WHERE` re-checks the lease, with a
`FOR UPDATE SKIP LOCKED` subquery picking the row:

```sql
UPDATE maksbas_notifications SET lease_until = now() + interval '60 seconds', ...
WHERE id = (SELECT id FROM maksbas_notifications
            WHERE status IN ('pending','sending','retrying')
              AND (lease_until IS NULL OR lease_until < now())
            ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
```

One statement is atomic on its own, so this needs no `BEGIN`. That matters
because **`neon-http` has no transaction support at all** — it sends every
statement as its own HTTP request and `db.transaction()` throws. Two workers
racing for the same row serialise on the row lock, and the loser re-evaluates
`WHERE` against the winner's committed lease and claims nothing. `SKIP LOCKED`
is what sends it to the *next* free notification rather than stalling on a
contended one.

Every driver works, including the HTTP ones:

```ts
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";

export const db = drizzle(neon(process.env.DATABASE_URL!));
```

### Failure handling

| FCM result                                               | What happens                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `UNREGISTERED`, `INVALID_ARGUMENT`, `SENDER_ID_MISMATCH` | Device set `active = false`. The row and its attributes stay.                       |
| `UNAVAILABLE`, `INTERNAL`, network error, 429, 5xx       | Parked and replayed after the main pass, up to 3 rounds.                            |
| 401/403                                                  | Whole notification marked `failed`. Credentials are wrong; the devices did nothing. |

---

## API

Base path is wherever you mounted the route.

### Device (auth: public key, then device secret)

| Method   | Path                      | Auth          | Purpose                                        |
| -------- | ------------------------- | ------------- | ---------------------------------------------- |
| `POST`   | `/devices`                | public key    | Register. Returns `deviceId` + `deviceSecret`. |
| `GET`    | `/devices/:id`            | device secret | Read own state                                 |
| `PATCH`  | `/devices/:id`            | device secret | Rotate FCM token, report permission            |
| `PATCH`  | `/devices/:id/attributes` | device secret | Merge attributes                               |
| `DELETE` | `/devices/:id`            | device secret | Unregister                                     |
| `POST`   | `/devices/:id/events`     | device secret | Report delivered/opened                        |

The device secret is generated at registration and only its SHA-256 is stored.
Using another device's id returns `404`, not `403` — a `403` would confirm the id
exists.

### Server (auth: secret key)

| Method           | Path                 | Purpose                           |
| ---------------- | -------------------- | --------------------------------- |
| `POST`           | `/notifications`     | Queue a send                      |
| `GET`            | `/notifications`     | Recent notifications              |
| `GET`            | `/notifications/:id` | Status + delivered/opened counts  |
| `POST`           | `/devices/query`     | List devices, optionally filtered |
| `POST`           | `/audience/count`    | Size a filter before sending      |
| `GET POST`       | `/segments`          | List / create                     |
| `GET PUT DELETE` | `/segments/:name`    | Read / update / delete            |

### Cron (auth: cron secret, or the secret key)

| Method       | Path          |
| ------------ | ------------- |
| `GET` `POST` | `/cron/drain` |

The secret key is accepted here as well. Without that, a deployment that never
set `CRON_SECRET` has no credential to self-chain with, and an interrupted send
sits unfinished until someone triggers a drain by hand.

### Dashboard (auth: session cookie)

Mounted separately — see [Dashboard](#dashboard). The page is served at the
mount point; everything below it is what the page itself calls.

| Method   | Path                            | Purpose                       |
| -------- | ------------------------------- | ----------------------------- |
| `GET`    | `/session`                      | Is this browser signed in     |
| `POST`   | `/session`                      | Sign in with the password     |
| `DELETE` | `/session`                      | Sign out                      |
| `GET`    | `/api/overview`                 | Counters for the header       |
| `GET`    | `/api/devices`                  | `?q=&status=&limit=&offset=`  |
| `PATCH`  | `/api/devices/:id`              | Replace attributes, toggle active |
| `DELETE` | `/api/devices/:id`              | Unregister                    |
| `GET`    | `/api/notifications`            | Sends with delivery numbers   |
| `POST`   | `/api/notifications`            | Compose and send              |
| `GET`    | `/api/notifications/:id`        | One send in full              |
| `POST`   | `/api/notifications/:id/resume` | Push a stalled send along     |
| `DELETE` | `/api/notifications/:id`        | Delete a finished send        |
| `GET`    | `/api/segments`                 | Feeds the audience picker     |
| `POST`   | `/api/audience`                 | Size a filter before sending  |

---

## Schema

```
maksbas_devices        id, fcm_token (unique), secret_hash, platform,
                        attributes (jsonb, GIN), notifications_enabled, active,
                        app_version, sdk_version, device_model, os_version,
                        language, timezone, created_at, updated_at, last_seen_at

maksbas_segments       id, name (unique), description, filter (jsonb)

maksbas_notifications  id, title, body, image, deeplink, data, filter,
                        segment_name, status, cursor, sent_count, failed_count,
                        retry_ids, retry_queue, retry_round, lease_until, error,
                        created_at, started_at, completed_at

maksbas_events         id, notification_id, device_id, type,
                        unique(notification_id, device_id, type)
```

---

## Tests

```bash
npm test
```

100 tests against a real Postgres 16 running in WASM (`@electric-sql/pglite`) —
no Docker, no CI service container. Covers the filter compiler including the
non-numeric-value case, device auth, attribute merging, the cursor walk across
batch boundaries, token deactivation, retry rounds, lease handling, the
transaction-free claim, the targeted inline drain, and the dashboard's session
and CSRF guards.

The Android side has no automated coverage — see the `react-native-maksbas`
README for the manual checklist.
