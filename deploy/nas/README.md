# The chat on a NAS, in one file

`docker-compose.yml` here runs everything: the chat, its own database, a
one-time copy of your data from Neon, and (optionally) a public HTTPS
address through Tailscale Funnel. It works in UGREEN's and Synology's
Docker apps, or with `docker compose up -d` anywhere. No SSH needed.

## Steps

1. **Tailscale** (for a public address; skip for home-only):
   tailscale.com, sign up > **DNS** > **Enable HTTPS** (note your tailnet
   name, e.g. `tail1234.ts.net`) > **Settings > Keys > Generate auth key**.
2. **Pause the old site:** Render > Discords > Environment. Copy the
   `DATABASE_URL` value (the Neon address), then add `MOVED_TO` =
   `https://discord.tail1234.ts.net` (your address) and save.
3. **Fill in the file:** open `docker-compose.yml`, and in the settings
   block at the top set the database password, the Neon address and the
   Tailscale key.
4. **Create the project:** in the NAS's Docker app choose
   **Project > Create**, give it a name (e.g. `chat`), and paste the file
   in. Start it. The first start takes a few minutes.
5. **Check:** the `chat-import` container's log says how many accounts
   and messages it copied, and `chat` turns healthy. Open
   `http://<NAS IP>:8080` at home, and `https://discord.<tailnet>` anywhere.
6. **Tailscale:** in its admin console > Machines > **discord** > ... >
   **Disable key expiry**.

## Good to know

- **Updates are automatic:** the chat checks GitHub every 3 minutes and,
  when `main` has a new commit, restarts itself on it (it waits while anyone
  is in a call, up to 2 hours). Open pages reload onto the new version by
  themselves. Restarting the `chat` container by hand also updates it, and a
  restart with nothing new skips the download (seconds, not minutes).
  To turn auto-update off, delete the `AUTO_UPDATE_REPO` line.
- The copy from Neon only happens while the chat database is empty. It
  never changes Neon and never overwrites anything.
- The chat uses its own Postgres container (`chat-db`), separate from any
  Postgres you already run.
- Data lives in Docker volumes named after the project (`chat-db`,
  `chat-files`). Back up with:
  `docker exec chat-db pg_dump -U chat chat > chat-backup.sql`
- The older multi-file setup (building the image yourself, sharing an
  existing Postgres) is in `deploy/synology/`.

## Keeping an older address (e.g. Render)

To keep using an address the chat had before, run that old copy in relay
mode: on Render set `RELAY_TO` = your Funnel address (e.g.
`https://discord.dorper-trout.ts.net`) and remove `MOVED_TO`. It then passes
everything through to the NAS and needs no database of its own. If the NAS
is off, visitors see a short "the chat is offline" page.
