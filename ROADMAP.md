# Roadmap

The feature plan agreed with William (Nov 2026), from a check of the app
against Discord's feature list. Work top to bottom. Tick items off (and
note anything learned) as they ship, so the next session knows where
things stand.

**Effort** is the thinking level to run Claude at for that step:
`low` (small, obvious change), `medium` (normal feature), `high` (touches
security or permissions, or many parts of the app), `xhigh` / `max` (a
large, new system - also split it over several sessions).

## Batch 1 - quick wins (done)

- [x] **1. Installable app (PWA)** - `low` - *done Nov 2026*
  Web app manifest + icons so phones/computers can "install" the site.
  Also makes push notifications work on iPhone (iOS only allows web push
  for sites added to the home screen). Notifications must still say they
  come from this chat app (see CLAUDE.md).
  *Shipped as "Chat" with its own chat-bubble icon (`public/icons/`,
  `public/manifest.webmanifest`), NOT as "Google" like the tab title -
  an installed app must not impersonate another product. Settings >
  Notifications has an Install button / iPhone instructions.*
- [x] **2. Video and audio players in chat** - `low` - *done Nov 2026*
  *Formats the browser can't play fall back to the download card.*
- [x] **3. Polls** - `medium` - *done Nov 2026*
  *A poll is a message with kind 'poll' (text = question) plus the polls /
  poll_options / poll_votes tables. Created from the composer's + menu.
  Votes broadcast as 'pollUpdated'. Works in channels, groups and DMs.*
- [x] **4. Message links + Quick Switcher (Ctrl+K)** - `medium` - *done Nov 2026*
  *Links are `/#m/<id>`; `GET /messages/:id/locate` returns 404 for
  anything you can't see. Switcher supports # @ * prefixes.*
- [x] **5. Search everywhere + mentions inbox** - `medium` - *done Nov 2026*
  *Both use `readableRoomsClause()` in server.js - reuse it for anything
  that reads across rooms. Inbox skips blocked users.*
- [x] **6. `@everyone` and `@role` mentions** - `medium` - *done Nov 2026*
  *Role mentions are stored as `<@&id>`. Whether a mention pings is
  decided by the server at send time (`mentionFlags()`) and stored on the
  message; non-pinging ones render as plain text. Group mention pushes
  are capped at 100 offline people (`MAX_GROUP_MENTION_PUSHES`).*
- [x] **7. Mutual servers and friends on profile cards** - `low` - *done Nov 2026*

## Batch 2 - bigger features (done)

- [x] **8. Channel categories + private channels (real permissions)** - `high` - *done Nov 2026*
  Collapsible categories, and channels only certain roles can see/post in.
  This turns roles from cosmetic into permissions: EVERY server-side access
  check (history, search, pins, uploads, sockets, typing, push) must
  respect it - update the CLAUDE.md note about roles being cosmetic.
  *Private channels = owner/admins + chosen roles/members (`channel_access`).
  All access goes through `canViewChannel()`; `resyncRooms()` pulls
  sockets out of rooms when access is lost (this also fixed an older leak:
  kicked members kept receiving the server's messages until they reloaded).*
- [x] **9. Threads, then forum channels** - `high` - *done Nov 2026*
  *`threads` table; each thread is a `thread:<id>` room under a channel.
  Threads ignore the parent's slowmode/announcement rules (discussion under
  announcements is allowed). Forum channels (`server_channels.kind =
  'forum'`) only take posts. Sidebar shows open/unread/recent threads.*
- [x] **10. Scheduled events** - `medium` - *done Nov 2026*
  *Admins schedule; members click Interested. Reminder at start time
  (in-app + push + a message in the event's channel). No polling loop:
  `scheduleEventReminders()` sets a timer for the next start (re-checked
  hourly). If the free Render server is asleep at start time, the reminder
  goes out when it wakes - up to 1 hour late, after that it's skipped.*

## Batch 3 - voice and video (done)

- [x] **11. Voice and video calls (WebRTC)** - `xhigh` / `max` - *done Nov 2026*
  11a DM voice calls -> 11b video + group calls -> 11c voice channels ->
  11d screen sharing -> 11e push-to-talk, noise suppression.
  *Mesh calls (everyone sends to everyone), max 8 people. The server only
  relays setup messages (`voice:signal`), and only between two people in
  the same call. Calls are kept in memory (`calls` Map in server.js):
  a restart ends them and the browsers rejoin. Call keys:
  `call:dm:<a>:<b>`, `call:group:<id>`, `voice:<channel room>`; voice
  channels are `server_channels.kind = 'voice'`. A DM/group call rings for
  45s and leaves a `kind = 'call'` message (`ongoing` -> `ended:<secs>` or
  `missed`). `callJoinProblem()` is the one access check for joining;
  `enforceCallAccess()` (run from `resyncRooms()`) kicks people out of calls
  they lose access to. Push-to-talk only works while the tab is focused (a
  website can't read keys in other apps). Only STUN by default - some
  school/office networks need a TURN relay (`TURN_URLS`, see README); told
  William. Found + fixed on the way: people removed from (or leaving) a
  group chat kept getting its live messages until they reloaded.*
  Next ideas (not planned yet): soundboard, Stage channels, Watch Together,
  an SFU server if calls ever need more than 8 people.

## Batch 4 - automation (done)

- [x] **12. Webhooks + simple bots** - `high` - *done Nov 2026*
  Incoming webhooks, slash commands, reaction roles, auto-roles. Bot and
  webhook tokens are secrets: hash them, allow resetting them.
  *Webhooks: Server Settings → Integrations; Discord-compatible
  `/api/webhooks/<id>/<token>` (content, username, embeds flattened to
  quotes, `?wait=true`). Token = 32 random bytes, only SHA-256 stored,
  shown once, "New Link" resets. Webhook messages have `"user" =
  'webhook:<id>'` + `webhook_id` + `author_name`, show a BOT tag and never
  ping. Slash commands: composer autocomplete; /shrug /tableflip /unflip
  /lenny /me /spoiler /poll are done in the browser, /roll and /flip on the
  server (`runCommand`, kind 'roll') so results can't be faked; custom
  per-server commands (`server_commands`, kind 'command'). Auto-roles:
  `server_roles.auto_assign`, given on join. Reaction roles:
  `reaction_roles` (message, emoji → role), toggled in the `reactMessage`
  handler + `resyncRooms()`.*
  *Bot accounts (done Nov 2026): users with `is_bot`/`bot_owner`, token
  "bot_..." (SHA-256 in `bot_token_hash`, `usernameForBotToken()`), made in
  Settings > My Bots (max 5), added by their owner to servers the owner
  manages (`addServerMember()`). Same access checks as people; limits: no
  password login, invites, servers, friends, groups, calls, server admin,
  or the open default server; DMs only with shared-server people or people
  who DMed them (`botMayDM()`). discord.js-style SDK at
  `public/sdk/chat-bot.js`. Bot slash commands: `bot_commands` +
  `bot:setCommands`, used via `runCommand` -> `interactionCreate` to the
  bot -> `interactionReply` (15 min, max 5 answers), posted as kind
  'command' with `invoked_by`.*
- [x] **13. Link previews** - `high` - *done Nov 2026*
  The server must fetch pages, so guard against SSRF (no private/internal
  addresses, size and time limits, no redirects to internal hosts).
  *`/link-preview` + `fetchLinkPreview()`: http(s), default ports, every
  DNS answer must be public (net.BlockList of private/reserved v4+v6),
  connection pinned to the checked IP, manual redirects (max 3, each
  re-checked), 6s / 512KB, 8 in flight, cached 6h (misses 30 min). Only the
  card's picture is loaded from the site itself. Tested against a decoy
  server: localhost tricks, numeric IPs, IPv6-mapped, metadata IP,
  redirects to internal hosts.*

## Extras (Nov 2026)

- [x] **Hover and click animations** - subtle, mouse-only lifts; Settings >
  Appearance > Reduced motion (defaults to the device's setting) turns them off.
- [x] **Server setup** - creating a server is a short setup: template
  (Gaming, School Club, Study Group, Friends, Artists & Creators, Local
  Community or Create My Own) -> community or friends (community adds an
  Information category with admin-only #welcome-and-rules and
  #announcements) -> icon, name, description, banner -> invite code.
  `SERVER_TEMPLATES` in server.js builds the categories and channels; every
  new server gets voice channels. The original server got a #lounge voice
  channel once (site_settings `default_voice_added`, so deleting it sticks).
- [x] **Discord-style banner** - taller, name on top, folds into a normal
  header when you scroll the channel list. The voice channel you're in is green.
- [x] **UI overhaul ("After hours")** - ink-blue night room with one warm
  amber accent (the "lamp", default accent `#ffb648`; old default blue
  accents migrate once via `appearance.v2`). Bricolage Grotesque for titles,
  Figtree for everything else. Layout: a floating server dock (with your
  avatar and settings at its foot) beside one rounded "desk" panel holding
  the channel list, chat, members and search. Two-line chat header (name +
  topic), capsule composer with a send button. Phones: chat is full screen,
  the dock and channel list slide in together (`openNav()` / `closeNav()`),
  and a bottom bar has Messages, Mentions, Find and You. Themes: After hours,
  Graphite, Midnight, Daylight. Text on the accent colour uses `--on-brand`
  (dark or white, worked out from the accent's brightness).

## Decided against

- Game detection / Rich Presence, game overlays, PlayStation/Xbox linking -
  need a desktop app or console access, impossible from a website.
- Spotify / Steam / Twitch / YouTube connections - each needs developer
  accounts and API keys; revisit only if William asks.
- Music bots - break YouTube's terms of service.
- Developer portal, OAuth2, SDKs, embedded activities - platform tooling,
  far too big for this app.
- Native Windows/Mac/Android/iOS apps - the PWA (item 1) covers this.

## Already built (Nov 2026)

Batches 1-4 above, plus: DMs, group chats, servers with invites, text channels with topics,
announcement channels, slowmode, channel reordering, editing/deleting,
replies, pins, reactions, emoji picker, Markdown, file sharing (deleted
after 6h), @mentions, per-conversation search, custom role colours,
server banners/descriptions, welcome messages, friends, blocking,
profiles, presence, desktop + push notifications with per-channel levels,
keyboard shortcuts, themes and appearance settings.
