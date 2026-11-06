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
  Calls need a real browser to check audio/video: Playwright's Chromium
  with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`.

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
- Server roles (`server_roles`) give name colours, member-list grouping,
  and can unlock private channels (`channel_access`). Owner/admin powers
  come only from `server_members.role`. Slowmode, announcement and forum
  posting rules are enforced on the server in `channelPostBlock()`.
- **Who can read a room** is decided in ONE place: `isAllowedRoom()` ->
  `canViewChannel()` (private channels), with `readableChannelRooms()` /
  `allRoomsFor()` as the bulk version. Never check server membership
  alone for a channel. Threads (`thread:<id>` rooms) inherit their parent
  channel's access; use `channelForRoom()` to get a thread's channel.
- After ANY change that can take access away (kick, leave, role or admin
  change, channel privacy, deleting things), call `resyncRooms(usernames)`
  so the server removes their live sockets from rooms - never rely on the
  browser to do it.
- History queries (`getMessagesForRoom`, `getMessagesBefore`) list their
  columns explicitly - a new `messages` column must be added there too,
  or it silently disappears on every reload (live events use `SELECT *`).
- `@everyone` / `@role` pings are decided on the server (`mentionFlags()`)
  and stored on the message (`mentions_everyone`, `mention_role_ids`); the
  client trusts those flags, never the raw text.
- Anything that reads across many rooms (search everywhere, the mentions
  inbox) must go through `readableRoomsClause()` so it can't leak rooms.
- Calls (WebRTC, in-memory `calls` Map): `callJoinProblem()` is the only
  check for who may join a call - it reuses `isAllowedRoom()`, blocks and
  mutes. `resyncRooms()` also runs `enforceCallAccess()`, so anything that
  removes access ends the person's call too. `voice:signal` is relayed
  only between two current participants; never relay to anyone else.
  Ring notifications follow the honest-notification rule above.
- Webhook tokens are passwords: store only `sha256Hex(token)`, show the
  token once, compare with `webhookTokenMatches()` (constant time). Webhook
  messages are `"user" = 'webhook:<id>'` (never a real username) with
  `bot: true`; they never ping and the client shows no profile for them.
- Message kinds made by the server (`roll`, `command`, `call`, `join`,
  `event`, `poll`) can't be edited - `editMessage` refuses any `kind`.
- Anything that fetches a URL a user supplied must go through the
  link-preview guards (`resolvePreviewHost()` + `previewRequest()`): public
  addresses only, pinned connection, re-checked redirects, time/size caps.
  Never `fetch()` user URLs directly from the server.
- New servers are built from `SERVER_TEMPLATES` (server.js); the client's
  `SERVER_TEMPLATE_CHOICES` mirrors it for the setup screen - change both.
  Channel names are unique per server and lowercase, so a voice channel
  can't share a text channel's name.
- Bot accounts are users with `is_bot = 1`: they go through every normal
  access check, plus `isBotUser()` limits (see ROADMAP item 12). Bot tokens
  are passwords - store only `sha256Hex(token)`. The open default server is
  for people only: `isServerMember()`, `readableChannelRooms()`,
  `serversForUser()` and `serverMemberUsernames()` all leave bots out of it.
  `public/sdk/chat-bot.js` is the public bot library - keep it in step with
  the socket events it uses.
- `/healthz` must not touch the database (it would keep Neon awake).
- Appearance and notification preferences are per-device (localStorage);
  profile data is in Postgres.

## Testing locally
`DATABASE_URL=... PGSSL=false RATE_LIMITS=off PORT=4100 node server.js`
against a local Postgres, then `npm test` and a browser check of anything
UI-related.
