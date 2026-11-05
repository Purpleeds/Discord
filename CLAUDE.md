# Notes for Claude

Self-hosted Discord-style chat app. See README.md for setup, env vars and
deployment (Render web service from `main`, Postgres on Neon).

**What to build next is in ROADMAP.md** - read it before starting new
features, work through it in order unless asked otherwise, and tick items
off there (with anything learned) when they ship.

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
  `ACTIVE_UPLOAD_EXT` in server.js). SVGs are the exception: they open
  as images, but always with the no-scripts sandbox `SVG_UPLOAD_CSP`.
- Blocks live in the `blocks` table and are enforced on the server for DMs,
  DM uploads/typing, friend requests and mention pushes; the client only
  hides blocked users' channel messages.
- Server roles (`server_roles`) are cosmetic: name colour and member-list
  grouping. Permissions come only from `server_members.role`
  (owner/admin/member). Slowmode and announcement channels are enforced
  on the server in `channelPostBlock()`; owner/admins are exempt.
- History queries (`getMessagesForRoom`, `getMessagesBefore`) list their
  columns explicitly - a new `messages` column must be added there too,
  or it silently disappears on every reload (live events use `SELECT *`).
- `@everyone` / `@role` pings are decided on the server (`mentionFlags()`)
  and stored on the message (`mentions_everyone`, `mention_role_ids`); the
  client trusts those flags, never the raw text.
- Anything that reads across many rooms (search everywhere, the mentions
  inbox) must go through `readableRoomsClause()` so it can't leak rooms.
- `/healthz` must not touch the database (it would keep Neon awake).
- Appearance and notification preferences are per-device (localStorage);
  profile data is in Postgres.

## Testing locally
`DATABASE_URL=... PGSSL=false RATE_LIMITS=off PORT=4100 node server.js`
against a local Postgres, then `npm test` and a browser check of anything
UI-related.
