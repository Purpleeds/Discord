# Roadmap

The feature plan agreed with William (Nov 2026), from a check of the app
against Discord's feature list. Work top to bottom. Tick items off (and
note anything learned) as they ship, so the next session knows where
things stand.

**Effort** is the thinking level to run Claude at for that step:
`low` (small, obvious change), `medium` (normal feature), `high` (touches
security or permissions, or many parts of the app), `xhigh` / `max` (a
large, new system - also split it over several sessions).

## Batch 1 - quick wins

- [ ] **1. Installable app (PWA)** - `low`
  Web app manifest + icons so phones/computers can "install" the site.
  Also makes push notifications work on iPhone (iOS only allows web push
  for sites added to the home screen). Notifications must still say they
  come from this chat app (see CLAUDE.md).
- [ ] **2. Video and audio players in chat** - `low`
  Uploaded video/audio currently shows as a plain file card.
- [ ] **3. Polls** - `medium`
  Question + options, one or multiple choice, live results, optional end time.
- [ ] **4. Message links + Quick Switcher (Ctrl+K)** - `medium`
  "Copy Message Link" on any message, links jump to it (loading older
  history if needed). Ctrl+K to jump to any channel, DM, group or server.
- [ ] **5. Search everywhere + mentions inbox** - `medium`
  Search across every channel/DM you can access (respect access checks),
  and an inbox listing recent messages that mention you.
- [ ] **6. `@everyone` and `@role` mentions** - `medium`
  `@everyone` limited to owner/admins. Watch push-notification fan-out
  (don't spam a big server) and the per-channel notification levels.
- [ ] **7. Mutual servers and friends on profile cards** - `low`

## Batch 2 - bigger features

- [ ] **8. Channel categories + private channels (real permissions)** - `high`
  Collapsible categories, and channels only certain roles can see/post in.
  This turns roles from cosmetic into permissions: EVERY server-side access
  check (history, search, pins, uploads, sockets, typing, push) must
  respect it - update the CLAUDE.md note about roles being cosmetic.
- [ ] **9. Threads, then forum channels** - `high`
- [ ] **10. Scheduled events** - `medium`
  Events with RSVP ("interested") and a reminder notification. Render's free
  server sleeps, so reminders can't rely on a timer alone.

## Batch 3 - voice and video (its own project)

- [ ] **11. Voice and video calls (WebRTC)** - `xhigh` / `max`, over several sessions
  In order: 11a DM voice calls -> 11b video + group calls -> 11c voice
  channels -> 11d screen sharing -> 11e push-to-talk, noise suppression.
  Calls connect device to device; some school/office networks block that
  without a paid TURN relay server - tell William before relying on it.
  Soundboard, Stage channels and Watch Together come after this.

## Batch 4 - automation

- [ ] **12. Webhooks + simple bots** - `high`
  Incoming webhooks, slash commands, reaction roles, auto-roles. Bot and
  webhook tokens are secrets: hash them, allow resetting them.
- [ ] **13. Link previews** - `high`
  The server must fetch pages, so guard against SSRF (no private/internal
  addresses, size and time limits, no redirects to internal hosts).

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

DMs, group chats, servers with invites, text channels with topics,
announcement channels, slowmode, channel reordering, editing/deleting,
replies, pins, reactions, emoji picker, Markdown, file sharing (deleted
after 6h), @mentions, per-conversation search, custom role colours,
server banners/descriptions, welcome messages, friends, blocking,
profiles, presence, desktop + push notifications with per-channel levels,
keyboard shortcuts, themes and appearance settings.
