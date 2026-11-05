# Notes for Claude

Self-hosted Discord-style chat app. See README.md for setup, env vars and
deployment (Render web service from `main`, Postgres on Neon).

## Layout
- `server.js`: the whole backend (Express routes, Socket.IO handlers, schema).
- `public/index.html`: the whole frontend (CSS, markup and JS in one file).
  Keep it a single file unless asked otherwise.
- `public/sw.js`: Web Push service worker.
- `test/smoke.test.js`: end-to-end test (`npm test`, needs `TEST_DATABASE_URL`).

## Rules
- **Never assume a fresh database.** `setupSchema()` runs on every boot
  against the live database: add new columns with
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and make data migrations safe
  to re-run. Test schema changes against a database created by the
  previous version of the code, not only an empty one.
- After any `UPDATE users`, call `invalidateUser(username)` (getUser() is cached).
- Notifications (desktop and push) must always say honestly that they come
  from this chat app, naming the channel/DM and sender. Don't add features
  that disguise the app as something else.
- Uploaded files are served from the app's own origin, so anything a
  browser could run as a page must stay download-only (see
  `ACTIVE_UPLOAD_EXT` in server.js).
- Blocks live in the `blocks` table and are enforced on the server for DMs,
  DM uploads/typing, friend requests and mention pushes; the client only
  hides blocked users' channel messages.
- `/healthz` must not touch the database (it would keep Neon awake).
- Appearance and notification preferences are per-device (localStorage);
  profile data is in Postgres.

## Testing locally
`DATABASE_URL=... PGSSL=false RATE_LIMITS=off PORT=4100 node server.js`
against a local Postgres, then `npm test` and a browser check of anything
UI-related.
