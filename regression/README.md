# Regression suites

Bigger end-to-end checks than `npm test`: the API suites talk to a running
server over HTTP and Socket.IO, and the `*_ui` suites drive the real page
in Chromium (logging in, sending, calls with fake camera/mic, phone
layouts). Run them all before merging anything broad, and add to them
when you add a feature.

## Running

```bash
npm install
npm install --no-save playwright-core     # browser suites only
DB=postgresql://user:pass@localhost/chat_test regression/run.sh
```

`run.sh` starts the server on `BASE` (default `http://localhost:4100`)
against `DB` with rate limits off, runs every suite (or the ones you name:
`regression/run.sh v3_unread batch1`), and prints `passed N, failed M` for
each. Use a throwaway database: the suites create accounts and servers.
Point it at a copy of a database made by the previous version of the app
too, not only an empty one.

The browser suites need a Chromium. Set `CHROME=/path/to/chrome` if
Playwright's own isn't found. Screenshots and the server log go to
`regression/shots/` (ignored by git).

Two suites stop and restart the server on purpose (`calls_ui`, `v3_ui`) to
check that people reconnect, so run them on a server only the tests use.

## Suites

| Suite | Covers |
| --- | --- |
| `v3_sessions` | hashed sessions, Devices, login/sign-up rules, security headers |
| `v3_unread` | server-side unread, read sync between devices, mark as read |
| `v3_files` | kept attachments, `/media` safety and ranges, temporary files, `/history` paging |
| `v3_ui` | new login screen, unread badges and New line, attachments, drafts, failed sends, connection banner, Devices, phone |
| `batch1` / `batch2` | polls, links, search, mentions, mutuals / private channels, threads, forums, events |
| `batch4_api` / `batch4_ui` / `ssrf` / `previews_ui` | webhooks, commands, reaction roles, link previews and their SSRF guards |
| `calls_api` / `calls_ui` | call signalling and real browser calls, voice channels, screen share, reconnect |
| `bots_api` / `bots_ui` / `bans` | bot accounts, the SDK, bans |
| `setup_api` / `setup_ui` / `motion` | server setup wizard, banners, animations and reduced motion |
