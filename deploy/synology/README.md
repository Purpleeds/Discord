# Moving the chat to a NAS (Synology, UGREEN or any Docker host)

Written for Synology; on UGREEN (UGOS Pro) use the **Files** app instead of
File Station, the **Docker** app instead of Container Manager, and enable
SSH under Control Panel > Terminal. For the outside address use option A or
C below (UGREEN has no built-in reverse proxy like option B).

The app runs as a Docker container next to the Postgres you already have
on the NAS. Its data goes in its own database (`chat`) inside that
Postgres, so `main_database` is never touched. Big files are kept on the
NAS's disk for 30 days instead of 6 hours, and files up to 25 MB are kept
for good.

You'll need SSH on the NAS (Control Panel > Terminal & SNMP > Enable SSH)
and about 20 minutes. The chat is paused for a few minutes during step 4.

## 1. Put the app on the NAS

1. On GitHub, open the repository, click **Code > Download ZIP**.
2. In File Station, make a folder `docker/chat-app`, upload the ZIP there
   and extract it, so that `Dockerfile` sits directly in
   `/volume1/docker/chat-app/`.
3. In `deploy/synology/`, copy `.env.example` to `.env` and fill it in.
   `POSTGRES_USER` and `POSTGRES_PASSWORD` are the ones in your Postgres
   compose file.

**Change your Postgres password first.** The current one was shared in a
chat. Changing `POSTGRES_PASSWORD` in the compose file does nothing once
the database exists, so change it inside Postgres (letters and numbers
only):

```sh
sudo docker exec -it postgresql psql -U admin -d main_database -c "ALTER USER admin PASSWORD 'NewPasswordHere'"
```

Then put the new password in both your Postgres compose file and `.env`.

## 2. Choose how people reach it from outside

At home it answers on `http://<nas-ip>:8080`. Calls need HTTPS, though
(browsers only allow the microphone and camera on secure sites), and
friends need to reach it from anywhere. Pick one:

**A. Cloudflare Tunnel** (no router ports opened; needs a domain on
Cloudflare, about $10 a year):
1. Cloudflare dashboard > Zero Trust > Networks > Tunnels > Create a
   tunnel (type: Cloudflared). Copy its token into `TUNNEL_TOKEN` in `.env`.
2. In the tunnel, add a public hostname, e.g. `chat.yourdomain.com`, with
   service `http://chat:3000`.
3. In step 5, start with `--profile tunnel` (shown below).

**B. Synology's own reverse proxy** (free; opens port 443 on your router,
for the web app only, never the database):
1. Control Panel > External Access > DDNS: add a free `yourname.synology.me`
   name.
2. Control Panel > Security > Certificate: add a Let's Encrypt certificate
   for that name.
3. Control Panel > Login Portal > Advanced > Reverse Proxy > Create:
   source `HTTPS`, that hostname, port `443`; destination `HTTP`,
   `localhost`, port `8080`. Under **Custom Header**, choose
   **Create > WebSocket** (the chat needs it).
4. On your router, forward TCP port 443 to the NAS. **Don't** forward
   55432 (the database).

**C. Tailscale Funnel** (free; no domain, no router ports; visitors don't
need Tailscale):
1. Make a free account at tailscale.com.
2. Admin console > **DNS**: under HTTPS Certificates click **Enable HTTPS**.
   Note your tailnet name on that page (like `tail1234.ts.net`).
3. Admin console > **Access controls**: make sure the policy lets you use
   Funnel. New accounts already have it; if not, add
   `"nodeAttrs": [{"target": ["autogroup:member"], "attr": ["funnel"]}]`.
4. Admin console > **Settings > Keys > Generate auth key** (defaults are
   fine). Put it in `TS_AUTHKEY` in `.env`.
5. In step 5, start with `--profile funnel` (shown below).
6. Once it's running, the NAS appears as **chat** under Machines: open its
   **...** menu and choose **Disable key expiry**, or the address stops
   working after a few months.

The address is `https://chat.<your tailnet name>`, for example
`https://chat.tail1234.ts.net`.

Either way you now have the new address, e.g. `https://chat.yourdomain.com`.

## 3. Pause the old site

In the Render dashboard, open the **Discords** service > **Environment**,
and add `MOVED_TO` = your new address. Save, and let it redeploy. From now
on the old address sends everyone to the new one and accepts no more
messages, so nothing is lost during the copy.

While you're there, copy the `DATABASE_URL` value (the Neon address). You
need it next.

## 4. Copy the data from Neon

SSH into the NAS, then:

```sh
cd /volume1/docker/chat-app/deploy/synology
sudo sh copy-from-neon.sh 'PASTE-THE-NEON-DATABASE_URL-HERE'
```

It creates the `chat` database, copies everything into it (accounts,
logins, messages, servers, roles, bots, files), and prints the counts. It
also keeps a `neon-<date>.sql` file in that folder as a backup. Nothing on
Neon is changed. If it says the `chat` database already has data, it stops
rather than overwrite anything.

## 5. Start the app

```sh
sudo docker compose up -d --build                    # option B (reverse proxy)
sudo docker compose --profile tunnel up -d --build   # option A (Cloudflare Tunnel)
sudo docker compose --profile funnel up -d --build   # option C (Tailscale Funnel)
```

The first build takes a few minutes. Check it with
`sudo docker ps` (it should say `healthy`) and `sudo docker logs chat`.
It also shows up in Container Manager, where you can stop and start it.

## 6. Check, then tidy up

- Open the new address and log in. Everyone logs in once on the new
  address, because browsers keep logins per address. Accounts and
  passwords are all there.
- Push notifications have to be turned on again (Settings > Notifications)
  at the new address, for the same reason.
- Bots keep their tokens; point their programs at the new address.
- Once you're happy, after a few days, suspend the Render service. Keep
  the Neon project a few weeks as an extra backup, then delete it.

## Updating later

Download the new ZIP and extract it over `/volume1/docker/chat-app` (your
`.env` stays as it is). Then:

```sh
cd /volume1/docker/chat-app/deploy/synology
sudo docker compose up -d --build
```

The app upgrades its own tables when it starts. Your data stays in
Postgres and in the `chat_chat-files` volume.

## Backups

Everything except big temporary files is in the `chat` database. To make
a backup file:

```sh
sudo docker exec postgresql pg_dump -U admin chat > /volume1/docker/chat-backup-$(date +%F).sql
```

Hyper Backup can then back up that folder, and Synology's Task Scheduler
can run the command every night.
