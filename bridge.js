#!/usr/bin/env node
// The Discord bridge on its own, without the relay: the NAS runs it as the
// "bridge" container (deploy/nas/docker-compose.yml), and it works on any
// other machine with Node 22 too. It does exactly what the Render copy does -
// see discord-bridge.js and DISCORD_BRIDGE.md.
//
//   CHAT_URL             the chat's address, e.g. https://discords-zf2n.onrender.com
//   DISCORD_BOT_TOKEN    the bot's token (Discord Developer Portal > your app > Bot)
//   DISCORDS_BRIDGE_KEY  from the chat: Settings > Site Admin > Discord bridge
//   DISCORD_GUILD_ID     (optional) only bridge this Discord server
//   PUBLIC_URL           (optional) the address people open the chat at, for links
//                        to pictures and files; defaults to CHAT_URL
//   VERSION_FILE         (optional) a file that changes when the code updates
//                        (the NAS's /app/.version): the bridge exits then, so
//                        Docker restarts it on the new code
//
// Run it by hand with:  node --env-file=bridge.env bridge.js
// Only run ONE copy: if the Render service also has DISCORD_BOT_TOKEN set,
// remove it there, or every message shows up twice.
const { startDiscordBridge } = require('./discord-bridge');

const missing = ['CHAT_URL', 'DISCORD_BOT_TOKEN', 'DISCORDS_BRIDGE_KEY'].filter(k => !String(process.env[k] || '').trim());
if (missing.length) {
  console.error(`[bridge] missing ${missing.join(', ')} - see DISCORD_BRIDGE.md`);
  process.exit(2);
}
let chatUrl;
try {
  chatUrl = new URL(process.env.CHAT_URL.trim());
  if (!/^https?:$/.test(chatUrl.protocol)) throw new Error('not http(s)');
} catch {
  console.error(`[bridge] CHAT_URL isn't a web address: ${process.env.CHAT_URL}`);
  process.exit(2);
}

console.log(`[bridge] starting, chat at ${chatUrl.origin}`);
const bridge = startDiscordBridge({
  chatUrl: chatUrl.origin,
  publicUrl: (process.env.PUBLIC_URL || '').trim() || chatUrl.origin,
  botToken: process.env.DISCORD_BOT_TOKEN.trim(),
  bridgeKey: process.env.DISCORDS_BRIDGE_KEY.trim(),
  guildId: (process.env.DISCORD_GUILD_ID || '').trim(),
  // A wrong token never fixes itself: stop after a minute (so Docker's
  // restarts don't hammer Discord's sign-in) and try again fresh.
  onLoginFailed: () => setTimeout(() => process.exit(1), 60 * 1000)
});

// The NAS chat updates the shared code by itself; follow it.
const versionFile = (process.env.VERSION_FILE || '').trim();
if (versionFile) {
  const fs = require('fs');
  const read = () => { try { return fs.readFileSync(versionFile, 'utf8').trim(); } catch { return ''; } };
  const started = read();
  setInterval(() => {
    const now = read();
    if (now && now !== started) { console.log(`[bridge] the code was updated (${now.slice(0, 7)}) - restarting`); bridge.stop(); setTimeout(() => process.exit(0), 500); }
  }, 60 * 1000).unref();
}

const stop = () => { console.log('[bridge] stopping'); bridge.stop(); setTimeout(() => process.exit(0), 500); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('unhandledRejection', err => console.warn('[bridge] unexpected error:', err && err.message ? err.message : err));
