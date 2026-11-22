# Discord bridge

Links **#cross-platform** in this chat with **#cross-platform** on your real
Discord server, both ways:

- Something said here shows up on Discord as a normal-looking message, with the
  person's name and picture and the time. Discord marks webhook messages with
  its own small "APP" tag.
- Something said on Discord shows up here with the person's Discord name and
  picture, and a small grey **from Discord** tag on the right.

It runs on the NAS, as the `chat-bridge` container next to the chat
(`deploy/nas/docker-compose.yml`). It can also run inside the Render service
(the relay) instead - but only ever run one of the two, or every message shows
up twice.

## What it does to messages ("screening")

- Ignores bots, webhooks, and its own messages, so nothing loops back and forth.
- Mentions become plain names, and nothing it posts pings anyone on either side
  (no @everyone, no role or user pings).
- Pictures, files and stickers go across as links.
- Long messages are shortened to the other side's limit (2,000 characters on
  Discord, 4,000 here).
- Discord pictures are only accepted from Discord's own image servers.
- Only #cross-platform is bridged; nothing else is read or sent.

Edits, deletions and reactions aren't copied across, only new messages.

## Setting it up (about 10 minutes)

### 1. Make the Discord bot

1. Go to https://discord.com/developers/applications and click **New Application**.
   Name it, for example "Discords bridge".
2. Open **Bot** on the left:
   - click **Reset Token** and copy the token. It's a password, so keep it to yourself;
   - turn on **Message Content Intent** (under Privileged Gateway Intents) and save.
3. Open **OAuth2 > URL Generator**:
   - Scopes: tick **bot**.
   - Bot permissions: tick **View Channels**, **Send Messages**,
     **Read Message History**, **Manage Channels** and **Manage Webhooks**.
   - Open the link at the bottom and add the bot to your Discord server.

### 2. Turn it on in the chat

Settings > **Site Admin > Discord bridge > Turn on the Discord bridge**. This
makes #cross-platform in the original chat and shows a **bridge key** once.
Copy it.

### 3. Give both to the NAS

Open the chat's project in the NAS's Docker app (the one made from
`deploy/nas/docker-compose.yml`). In the settings block at the very top, fill in:

```yaml
  discord-bot-token: &discord_token "the bot token from step 1"
  discords-bridge-key: &bridge_key "the bridge key from step 2"
```

If the bot is in more than one Discord server, also put your server's ID in
`DISCORD_GUILD_ID` in the `bridge` service. Save and redeploy the project
(if your file is older and has no `bridge` service yet, paste in the new
`docker-compose.yml` first and keep your settings at the top).

The `chat-bridge` container then:

- signs in to Discord,
- makes **#cross-platform** on your Discord server (if it isn't there already),
- connects to the chat straight inside the NAS (`http://chat:3000`).

The Site Admin page then says "On and connected". It updates itself: when the
chat picks up a new version, the bridge restarts onto it within a minute.

**Switch off the Render copy:** if the Render service has `DISCORD_BOT_TOKEN`
set (from before), delete it there (Render > the service > Environment) -
otherwise both copies post every message.

<details><summary>Running it on Render instead</summary>

In the Render dashboard, open the chat's service, then **Environment**, and add
`DISCORD_BOT_TOKEN`, `DISCORDS_BRIDGE_KEY` and optionally `DISCORD_GUILD_ID`.
Leave the two NAS settings empty then.
</details>

<details><summary>Running it on any other machine</summary>

With Node 22 and a copy of this repo (`npm install`), make a `bridge.env` with
`CHAT_URL` (the chat's address), `DISCORD_BOT_TOKEN`, `DISCORDS_BRIDGE_KEY` and
optionally `DISCORD_GUILD_ID`, then run `node --env-file=bridge.env bridge.js`.
</details>

## If something's wrong

- **Site Admin says "On, but not connected":** check both values. The
  `chat-bridge` container's log (or Render's **Logs**) shows lines starting with
  `[bridge]` that say what's wrong (for example "Discord sign-in failed" or
  "check DISCORDS_BRIDGE_KEY"). "off - fill in ..." means the settings are empty.
- **Every message shows up twice on Discord:** the bridge runs both on the NAS and
  on Render. Delete `DISCORD_BOT_TOKEN` on Render.
- **Discord messages don't come through:** turn on **Message Content Intent**
  (step 1.2).
- **The bot can't make the channel:** give it **Manage Channels**, or make
  #cross-platform yourself. It also needs **Manage Webhooks**.
- **"New bridge key"** on the Site Admin page replaces the key, and the old one
  stops working. Put the new one at the top of the NAS file and redeploy. **Turn off** stops the bridge; the
  channel stays.

## How it works (for developers)

- `discord-bridge.js`: the bot (discord.js). `bridge.js` runs it on its own
  (the NAS's `bridge` service: the chat's code volume read-only, `CHAT_URL`
  `http://chat:3000`, exits when `/app/.version` changes so Docker restarts it on
  new code). `relay.js` also starts it when `DISCORD_BOT_TOKEN` and
  `DISCORDS_BRIDGE_KEY` are set on Render.
- `server.js`: the `bridges` table (key stored as a SHA-256 hash only) and these routes:
  - `POST /admin/bridge`, `GET /admin/bridge` and `POST /admin/bridge/off` (site admins).
  - `GET /bridge/discord` and `POST /bridge/discord/messages` (the bridge key, in `X-Bridge-Key`).
  - The socket.io namespace `/bridge`, where `bridgeOut()` sends people's messages from that channel.
- Bridged messages are `"user" = 'bridge:discord'`, `source = 'discord'`, with
  `author_name` and `author_avatar` set. They're bot messages: no profile, no pings,
  and `bridgeOut()` never sends them back.
- Tested by `regression/discord_bridge.test.js`, everything short of Discord itself.
