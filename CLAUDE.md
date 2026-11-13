# Notes for Claude

Self-hosted Discord-style chat app. See README.md for setup, env vars and
deployment (Render web service from `main`, Postgres on Neon).

**What to build next is in ROADMAP.md** - read it before starting new
features, work through it in order unless asked otherwise, and tick items
off there (with anything learned) when they ship.

**UPGRADES.md** logs each major version (what changed, what to check, what
to do next) - read it before a big upgrade and add an entry after one.

## Layout
- `server.js`: the whole backend (Express routes, Socket.IO handlers, schema).
- `public/index.html`: the whole frontend (CSS, markup and JS in one file).
  Keep it a single file unless asked otherwise. The look ("After hours",
  ROADMAP extras) lives in the design tokens at the top of `<style>` and the
  big layer at the end of it; JS finds elements by ID, so keep IDs when
  restyling. On phones close the drawer with `closeNav()`, never by
  removing the `open` class by hand. Put text on the accent colour in
  `var(--on-brand)`, not white.
- `relay.js`: relay mode (`RELAY_TO`). Render runs this: it proxies every
  request and the WebSocket to the real chat on the owner's NAS (Tailscale
  Funnel address) and answers `/healthz` itself. The NAS runs
  `deploy/nas/docker-compose.yml` (app + Postgres), which downloads `main` on
  start (skipped when `.version` already matches) - and with `AUTO_UPDATE_REPO`
  the server polls GitHub and restarts itself after a merge (waits for calls),
  and open pages reload when `serverInfo.version` changes.
- `public/sw.js`: Web Push service worker.
- `desktop/`: the Chat Notifier, a Windows tray program (Electron) - see
  desktop/README.md. Released by `.github/workflows/notifier.yml`.
- `test/smoke.test.js`: end-to-end test (`npm test`, needs `TEST_DATABASE_URL`).
  Calls need a real browser to check audio/video: Playwright's Chromium
  with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`.
- `regression/`: the bigger suites (API and real-browser), run against a
  fresh server that `regression/run.sh` starts - see `regression/README.md`. Run them all
  before merging anything broad; add to them when you add a feature.

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
  can unlock private channels (`channel_access`), and can carry powers
  (`server_roles.permissions`, keys in `ROLE_PERMISSIONS`). Check a power with
  `hasServerPerm()` / `requirePerm()` (owner, server admins and site admins
  have them all; bots and the default server get none from roles) - never
  with `canManageServer()` for something a role could be allowed. No climbing:
  roles can only be made, edited, given or taken by someone covering all
  their powers (`coversRole()`), and roles with powers can never be
  auto-assigned or picked from a reaction menu. Making/removing server
  admins and deleting the server stay owner-only. Slowmode, announcement and
  forum posting rules are enforced on the server in `channelPostBlock()`.
- Per-server profiles live on `server_members` (nickname, avatar_url,
  banner_url, bio, hide_roles). Messages in server rooms get the nickname and
  avatar from `serverLooksFor()`. Hidden roles (owner/admins, or a role with
  `allow_hide`) are stripped from `/servers/:id/members` for viewers without
  `manage_roles`; powers are unaffected. Nothing may give away that someone
  hides: `rolesHidden`/`serverProfile.hideRoles` only go to themselves and
  role managers, and `/servers` sends `owner: ''` for an owner who hides.
  Site admins can hide the Site Admin badge everywhere (`users.hide_admin`):
  `profileFromRow()` then says `isAdmin: false` to everyone; `selfProfile()`
  keeps the real `isAdmin` plus `adminHidden`. Your own profile card has an
  eye beside your roles (`roleEyeButton()`) - hidden roles show greyed. Banner/avatar media go through
  `/assets` (allow-listed image/video types, `assetProblem()` checks the
  uploader); unused assets are removed after a day. Assets up to 8 MB are in
  Postgres (`storage 'db'`); bigger ones (up to `ASSET_MAX_MB`, 2 GB) stream to
  `ASSET_DIR` on disk (`storage 'disk'`, `data` NULL) - delete both together.
  `server.requestTimeout = 0` (server.js and relay.js) so big uploads aren't cut off.
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
- Login tokens are passwords: `sessions.token` holds only `sessionKey(token)`
  (`sha256:<hex>`). Never store, log or return a raw token or its hash; the
  Devices page uses `public_id`. End sessions with `endSessions()` (it also
  drops their live sockets). The app's login sends `create:false`, so it
  never auto-creates an account; `AUTO_REGISTER_ON_LOGIN` only applies to
  callers that leave it out. Check new names with `usernameTaken()` (it
  ignores capitals).
- Unread is server-side: `unreadFor()` counts messages newer than the
  person's read receipt (and their `unread_base_id`). Anything that gives
  someone a room that already has history (joining a server, being added to
  a group) must call `markRoomsRead()` so old history isn't "unread". The
  client marks read only through `markCurrentRead()` (not while the tab is
  in the background) and never emits `markRead` directly.
- Attachments: `files.storage` is `'db'` (kept; bytes in `file_blobs`, served
  by `/media`) or `'disk'` (temporary, has `expires_at`). `/media` must keep
  the `/uploads` safety rules (type from the extension, `ACTIVE_UPLOAD_EXT`
  download-only, `SVG_UPLOAD_CSP`). Delete files with `deleteFiles()` so the
  bytes, the disk file and everyone's screen go together. File queries list
  `FILE_COLUMNS` explicitly, like messages.
- The client loads a room with `GET /history` (messages + the files from the
  same stretch of time, `HISTORY_PAGE` at a time). `/messages` and `/files`
  remain for bots and older clients.
- The client sends chat through `postChatMessage()`; it works while
  disconnected (socket.io holds the emit) and failed sends stay on screen
  via `markSendFailed()`. Don't add an "if not connected, return" in front
  of sending.
- The app page is served with `APP_CSP`. Anything new the page loads from
  another origin (a script, a font, a frame) has to be allowed there, and
  the browser regression suite fails on CSP violations.
- Attachments belong to messages: the client uploads with `X-Attach: 1`
  (a `pending` file, not broadcast), then sends the message with
  `attachments: [ids]`; `checkAttachments()`/`claimAttachments()` tie them
  to it. Messages carry `attachments`; `/history` and unread counting skip
  attached and pending files. Deleting a message deletes its files. Older
  standalone files (message_id NULL) still show as their own items.
- Moderation: per-server bans (`server_bans`, block rejoining) and timeouts
  (`server_timeouts`, enforced in `channelPostBlock()`, uploads and voice)
  need `ban_members`; `moderationProblem()` decides who can be moderated.
  Log moderator actions with `auditLog()` (never blocks the action).
- Custom emoji (`server_emojis`, `manage_emoji`) are written `<:name:id>` in
  text and reactions; `validReaction()` checks reactions. Personas were
  removed: old persona messages keep their label (`persona` flag); don't
  bring back posting under another name.
- Stickers (`server_stickers`, `manage_emoji`): only pictures/GIFs are stored -
  videos are turned into GIFs in the browser (`videoToGif()`, up to `GIF_MAX_SECONDS` = 2 min). A sticker
  message has `sticker_id` (history column lists include it), no text, can't
  be edited; `usableSticker()` allows a server's stickers there, and in DMs
  stickers from servers the sender is in. The sticker button is always shown
  (an empty picker offers "Add stickers" to managers); in the open general
  server only site admins can add them.
- In server channels the client must not cache message names/avatars as
  profiles (`cacheFromPayload()` skips them): they can be nicknames (or old personas).
- TURN: `/voice/ice` gives coturn time-limited logins from `TURN_SECRET` /
  `TURN_SECRET_FILE`; `{host}` in `TURN_URLS` becomes the public name.
- Pop-up message cards (`showMessageCard()`, `#notiStack`): in-app only, while
  the app is on screen, for rooms you're not looking at; same `shouldAlert()`
  rules as the chime, off via `notifPrefs.popups`. They always show where the
  message was sent. OS notifications can't be restyled - they only get the
  sender's picture as their icon.
- Push subscriptions: only browser push services (`PUSH_SERVICE_HOSTS`, https,
  default port) are accepted - `pushEndpointProblem()` runs on subscribe AND
  before every send (bad stored rows are deleted). Max 10 per person.
- Push payloads come from `pushContent()` (text + tags, optional `image`) with
  `pushIcon()` and a `/#m/<id>` link; `sw.js` posts `openUrl` to an open tab.
- The notifier connects with `auth: { background: true }`: such sockets live in
  `backgroundSockets`, not `onlineUsers` - they never count as online
  (presence, push skip), but `sendToUser()`, `endSessions()`,
  `disconnectUser()` and the Devices list include them (`allSocketIdsOf()`).
  Tabs report `appVisible`; `syncNotifierState()` tells notifiers
  `foreground` and tabs `notifier` (tabs then skip desktop notifications).
  Keep `desktop/lib/logic.js` in step with the client's alert rules.
  Notifier looks: built-in themes mirror the chat's tokens (`BUILT_IN` in
  logic.js); custom themes are 4 hex colours checked by `cleanCustomTheme()` in
  the main process, and pages only ever get the full set from `themeTokens()`.
  The notifier logs to `notifier.log` in its data folder (never tokens,
  passwords or message text). `desktop/test/install-test.ps1` (CI, Windows)
  checks a real install/update actually opens a window; keep
  `build.toolsets.nsis` (NSIS 3.12) - the default NSIS 3.0.4 installer crashes on Windows 11 24H2.
  The Microsoft Store build (`appx` target, `STORE` in main.js) must not self-update or
  set login items; `desktop/test/store-test.ps1` installs and starts it in CI.
- Phones/touch: there's no hover, so every action must also be reachable from
  a menu. Right-click menus (`oncontextmenu` -> `showMenu()`) also open on a
  long press - the app makes the `contextmenu` event itself because iPhone
  Safari never sends one. Messages get `showMessageMenu()` (built from the
  hover toolbar's buttons, plus quick reactions and Copy Text). On phones
  menus/pickers/popouts are bottom sheets, the member list is a drawer
  (`setMembersDrawer()`), and inputs stay 16px+ (iPhones zoom otherwise).
  `regression/phone_ui.test.js` checks all of this with real touch events.
- `/healthz` must not touch the database (it would keep Neon awake).
- Appearance and notification preferences are per-device (localStorage);
  profile data is in Postgres.

## Debugging the live site
The cloud environment "Discord" allows `discords-zf2n.onrender.com` and has a
saved network secret: the login token of the **Claude** account (a normal
member made for testing, at William's request). The proxy adds it as
`Authorization: Bearer ...` to every request to that host, so API calls there
act as Claude with no token in code. The live connection accepts the same
header (use Socket.IO's `polling` transport through `HTTPS_PROXY`). Logins last
90 days after last use; if it stops working, ask William to log in as Claude
and save a fresh token (request_credential). Never commit the token.

## Testing locally
`DATABASE_URL=... PGSSL=false RATE_LIMITS=off PORT=4100 node server.js`
against a local Postgres, then `npm test` and a browser check of anything
UI-related.
