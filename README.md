# Chat

A self-hosted, Discord-style chat app: servers and channels, DMs, group
chats, voice and video calls, voice channels and screen sharing, friends
and blocking, reactions, replies, file sharing, link previews, webhooks,
slash commands, reaction roles, push notifications and a full settings
screen.

- **Backend:** Node.js, Express, Socket.IO and Postgres (`server.js`)
- **Frontend:** one file of plain HTML/CSS/JS (`public/index.html`), plus
  the push service worker (`public/sw.js`)
- **Hosting:** Render free web service + Neon free Postgres

## Run it locally

You need Node 22+ and a Postgres database.

```bash
npm install
DATABASE_URL=postgresql://user:pass@localhost:5432/chat PGSSL=false npm start
```

Then open http://localhost:3000. The app creates and upgrades all of its
tables itself on startup, so an empty database is all it needs.

### Environment variables

| Variable | Needed | What it does |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. On Neon use the **pooled** one. |
| `PORT` | no | Port to listen on (default `3000`; Render sets this). |
| `PGSSL` | no | Set to `false` for a local Postgres without SSL. |
| `DATA_DIR` | no | Where shared files are stored (default: this folder). |
| `RATE_LIMITS` | no | Set to `off` to disable rate limits (for tests only). |
| `LINK_PREVIEW_TEST_HOSTS` | no | Tests only (ignored unless `RATE_LIMITS=off`): exact `host:port` pairs link previews may fetch even though they're private. |
| `TURN_URLS` | no | Comma-separated TURN relay URLs for calls, e.g. `turn:turn.example.com:3478,turns:turn.example.com:5349`. |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | no | Login for that TURN relay. |

### Calls and TURN

Calls (DMs, groups, voice channels, screen sharing) connect browser to
browser with WebRTC; the server only passes the setup messages along.
Each person sends to everyone else in the call, so calls are capped at 8
people. By default only free public STUN servers are used, which works on
most home and phone connections. Some school, office and public wifi
networks block direct connections; there a call shows "Can't connect" and
needs a TURN relay (a paid or self-hosted service such as coturn or
Cloudflare/Twilio TURN) set with the three variables above. Calls live in
the server's memory, so a restart or redeploy ends them (people's apps
rejoin automatically when the server comes back).

### Webhooks

Server admins make webhooks in Server Settings → Integrations. A webhook
URL looks like `https://<your site>/api/webhooks/<id>/<token>` and accepts
Discord's webhook JSON (`content`, `username`, `embeds`; add `?wait=true`
to get the message back), so tools that post to Discord work by swapping
the host:

```bash
curl -H "Content-Type: application/json" -d '{"content":"Build passed"}' https://<your site>/api/webhooks/<id>/<token>
```

The token is shown once; only its SHA-256 is stored. "New Link" resets it.

### Link previews

Links in messages get a preview card. The server fetches the page (so the
linked site doesn't see who's reading) with SSRF protection: public
addresses only (checked after DNS, connection pinned to the checked IP),
default ports, at most 3 redirects (each re-checked), 6 seconds and 512 KB
per page. See `fetchLinkPreview()` in server.js.

## Deploying

Render auto-deploys the `main` branch to the **Discords** web service
(build `npm install`, start `npm start`, health check `/healthz`). The
database is the Neon project `long-dew-25979383`; both are in Singapore,
so keep them in the same region if either is ever recreated (every query
crosses between them). Node is pinned to 22 via `engines` in
package.json. See
[RENDER_POSTGRES_SETUP.md](RENDER_POSTGRES_SETUP.md) for moving the
database or setting it up from scratch.

Shared files (the up-to-10GB uploads) are kept on Render's temporary disk
and deleted after 6 hours. Everything else (accounts, messages, avatars,
server icons, friends) is in Postgres.

## Tests

The smoke test starts its own copy of the server against a database you
point it at and checks the main features end to end (accounts, messages,
DMs, friends, blocking, upload safety, servers, private channels,
threads, events, calls, webhooks, slash commands, reaction roles and
link-preview SSRF protection). Use a throwaway database: it
creates test accounts.

```bash
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/chat_test PGSSL=false npm test
```

## Admin

The account named `Purple` is always a site-wide admin. Other accounts can
be created or made admins at startup via `SEED_ACCOUNTS` near the top of
`server.js`.
