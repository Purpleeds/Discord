# Discord bridge

Links **#cross-platform** in this chat with **#cross-platform** on your real
Discord server, both ways:

- Something said here shows up on Discord as a normal-looking message, with the
  person's name and picture and the time. Discord marks webhook messages with
  its own small "APP" tag.
- Something said on Discord shows up here with the person's Discord name and
  picture, and a small grey **from Discord** tag on the right.

It runs inside the Render service (the relay), which is online all the time,
so it doesn't need your PC or the NAS to run it.

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

### 3. Give both to Render

In the Render dashboard, open the chat's service, then **Environment**, and add:

| Key | Value |
|---|---|
| `DISCORD_BOT_TOKEN` | the bot token from step 1 |
| `DISCORDS_BRIDGE_KEY` | the bridge key from step 2 |
| `DISCORD_GUILD_ID` | *(optional)* your Discord server's ID, if the bot is in more than one |

Save. Render restarts the service, and the bot then:

- signs in,
- makes **#cross-platform** on your Discord server (if it isn't there already),
- connects to the chat.

The Site Admin page then says "On and connected".

## If something's wrong

- **Site Admin says "On, but not connected":** check both Render values. The
  Render service's **Logs** show lines starting with `[bridge]` that say what's wrong
  (for example "Discord sign-in failed" or "check DISCORDS_BRIDGE_KEY").
- **Discord messages don't come through:** turn on **Message Content Intent**
  (step 1.2).
- **The bot can't make the channel:** give it **Manage Channels**, or make
  #cross-platform yourself. It also needs **Manage Webhooks**.
- **"New bridge key"** on the Site Admin page replaces the key, and the old one
  stops working. Put the new one in Render. **Turn off** stops the bridge; the
  channel stays.

## How it works (for developers)

- `discord-bridge.js`: the bot (discord.js). It's started by `relay.js` when
  `DISCORD_BOT_TOKEN` and `DISCORDS_BRIDGE_KEY` are set.
- `server.js`: the `bridges` table (key stored as a SHA-256 hash only) and these routes:
  - `POST /admin/bridge`, `GET /admin/bridge` and `POST /admin/bridge/off` (site admins).
  - `GET /bridge/discord` and `POST /bridge/discord/messages` (the bridge key, in `X-Bridge-Key`).
  - The socket.io namespace `/bridge`, where `bridgeOut()` sends people's messages from that channel.
- Bridged messages are `"user" = 'bridge:discord'`, `source = 'discord'`, with
  `author_name` and `author_avatar` set. They're bot messages: no profile, no pings,
  and `bridgeOut()` never sends them back.
- Tested by `regression/discord_bridge.test.js`, everything short of Discord itself.
