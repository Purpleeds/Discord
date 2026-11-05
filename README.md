# Chat

A self-hosted, Discord-style chat app: servers and channels, DMs, group
chats, friends and blocking, reactions, replies, file sharing, push
notifications and a full settings screen.

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
DMs, friends, blocking, upload safety). Use a throwaway database: it
creates test accounts.

```bash
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/chat_test PGSSL=false npm test
```

## Admin

The account named `Purple` is always a site-wide admin. Other accounts can
be created or made admins at startup via `SEED_ACCOUNTS` near the top of
`server.js`.
