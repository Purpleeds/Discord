# Chat

https://github.com/Purpleeds/Discord/releases/tag/notifier-v1.1.0
A self-hosted, Discord-style chat app: servers and channels, DMs, group
chats, voice and video calls, voice channels and screen sharing, a
guided server setup with templates and banners, bot accounts with a
discord.js-style library, friends and blocking, reactions, replies, file sharing, link previews, webhooks,
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
| `DATA_DIR` | no | Where large temporary files are stored (default: this folder). |
| `KEEP_FILE_MB` | no | Attachments up to this size are kept, in the database (default `8`). Bigger ones are temporary. |
| `MEDIA_BUDGET_MB` | no | Total space kept attachments may use before the oldest are removed (default `250`). |
| `FILE_EXPIRY_HOURS` | no | How long files over `KEEP_FILE_MB` live (default `6`; set it higher where the disk is permanent, e.g. a NAS). |
| `ASSET_MAX_MB` | no | Largest banner/avatar/sticker picture, GIF or video people can upload (default `2048` = 2 GB). Over 8 MB they're kept on disk in `DATA_DIR/assets`, not in Postgres. |
| `KEEPALIVE_URL` | no | An address to visit every `KEEPALIVE_MINUTES` (default 1) to keep it awake - e.g. a Render relay's `/healthz`. In relay mode the relay pings its own `RENDER_EXTERNAL_URL` by itself (`KEEPALIVE_MINUTES=0` turns that off). |
| `AUTO_UPDATE_REPO` | no | `owner/repo` - check GitHub every `AUTO_UPDATE_MINUTES` (default 3) and restart on a new commit of `AUTO_UPDATE_BRANCH` (default `main`); waits for calls to end (up to `AUTO_UPDATE_MAX_WAIT_MIN`, default 120). For the NAS setup, whose start-up script downloads the code and writes `.version`. |
| `ASSET_BUDGET_MB` | no | Total space for all of those together (default `30000`); uploads are refused once it's full. |
| `RELAY_TO` | no | Relay mode: this copy runs no chat and no database, it just passes everything (pages, uploads, live connections) to the real chat at this address, e.g. a NAS. Keeps the old address working. See relay.js. |
| `MOVED_TO` | no | Set on an old copy of the app after moving it: pages redirect to this address and no more messages are accepted. |
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

### Bots

Anyone can make up to 5 bot accounts in Settings → My Bots and add them to
servers they own or are an admin of. Bots are written in JavaScript with
the small discord.js-style library the site serves at `/sdk/chat-bot.js`
(needs Node.js 18+ and `npm install socket.io-client`):

```js
const { Client } = require('./chat-bot.js');
const client = new Client({ url: 'https://<your site>' });
client.on('ready', () => client.setCommands([{ name: 'hello', description: 'Say hello' }]));
client.on('messageCreate', msg => { if (!msg.author.bot && msg.content === '!ping') msg.reply('Pong!'); });
client.on('interactionCreate', i => { if (i.commandName === 'hello') i.reply(`Hello, ${i.user.displayName}!`); });
client.login(process.env.BOT_TOKEN);
```

A bot signs in with its token (`Authorization: Bot <token>` over HTTP, or
`auth: { token: 'Bot <token>' }` for Socket.IO) - only the token's SHA-256
is stored. It sees exactly what a normal member of its servers sees, and
can't use invite codes, make servers, be a friend, join group chats or
calls, be a server admin, or see the open "general" server. It can DM only
people it shares a server with (or who DMed it first). Bot answers to slash
commands show who used the command.

### Link previews

Links in messages get a preview card. The server fetches the page (so the
linked site doesn't see who's reading) with SSRF protection: public
addresses only (checked after DNS, connection pinned to the checked IP),
default ports, at most 3 redirects (each re-checked), 6 seconds and 512 KB
per page. See `fetchLinkPreview()` in server.js.

## Deploying

To run it on a NAS (UGREEN, Synology) or any Docker host instead, the
easiest way is the single file [deploy/nas/docker-compose.yml](deploy/nas/docker-compose.yml)
(guide: [deploy/nas/README.md](deploy/nas/README.md)): app, database, a one-time
copy from Neon and a public address, pasted into the NAS's Docker app. The
older build-it-yourself setup is in [deploy/synology/](deploy/synology/README.md).
The database can be given as `DATABASE_URL` or the standard `PGHOST` /
`PGUSER` / `PGPASSWORD` / `PGDATABASE` settings.


Render auto-deploys the `main` branch to the **Discords** web service
(build `npm install`, start `npm start`, health check `/healthz`). The
database is the Neon project `long-dew-25979383`; both are in Singapore,
so keep them in the same region if either is ever recreated (every query
crosses between them). Node is pinned to 22 via `engines` in
package.json. See
[RENDER_POSTGRES_SETUP.md](RENDER_POSTGRES_SETUP.md) for moving the
database or setting it up from scratch.

Everything is in Postgres: accounts, messages, avatars, server icons,
friends, and attachments up to `KEEP_FILE_MB` (8 MB by default). Kept
attachments share a budget (`MEDIA_BUDGET_MB`, 250 MB by default) and the
oldest are removed when it fills, so size it to your database plan (Neon's
free plan is 0.5 GB for everything). Bigger files, up to 10 GB, are
temporary shares on Render's disk: deleted after 6 hours or on a restart,
and labelled that way in the app.

[UPGRADES.md](UPGRADES.md) lists what each major version changed and what
to check after deploying it.

## Tests

The smoke test starts its own copy of the server against a database you
point it at and checks the main features end to end (accounts and
sessions, messages, DMs, friends, blocking, uploads and kept attachments,
unread counts, history paging, servers, private channels, threads, events,
calls, webhooks, slash commands, reaction roles, bots and link-preview SSRF
protection). Use a throwaway database: it creates test accounts.

```bash
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/chat_test PGSSL=false npm test
```

## Admin

The account named `Purple` is always a site-wide admin. Other accounts can
be created or made admins at startup via `SEED_ACCOUNTS` near the top of
`server.js`.

`regression/` holds the larger suites, including the browser ones that
click through the real page (see [regression/README.md](regression/README.md)).
