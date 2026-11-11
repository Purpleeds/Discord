// Relay mode: this copy of the app runs no chat and touches no database. It
// passes every request (pages, API calls, uploads and the live WebSocket
// connection) through to the real chat at RELAY_TO, e.g. a NAS at home
// reached over Tailscale Funnel. Used so the chat keeps its familiar address
// (the Render one) while it actually runs somewhere else.
//
// Started from server.js when RELAY_TO is set:
//   RELAY_TO=https://discord.example.ts.net node server.js
const http = require('http');
const https = require('https');

const target = new URL(process.env.RELAY_TO);
if (!['http:', 'https:'].includes(target.protocol)) {
  console.error('RELAY_TO must be an http:// or https:// address');
  process.exit(1);
}
const client = target.protocol === 'https:' ? https : http;
const targetPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
const agent = new client.Agent({ keepAlive: true, maxSockets: 100 });
const PORT = Number(process.env.PORT) || 3000;

// Hop-by-hop headers belong to one connection and must not be forwarded.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function forwardHeaders(req) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name)) headers[name] = value;
  }
  headers.host = target.host;
  // the visitor's address, for the chat's per-network limits (it only trusts one hop)
  const visitor = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (visitor) headers['x-forwarded-for'] = visitor;
  headers['x-forwarded-proto'] = 'https';
  return headers;
}

function offlinePage(res, why) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '30' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chat is offline</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121731;color:#e8eaf6;font:16px/1.5 system-ui,sans-serif;text-align:center;padding:24px}
h1{font-size:28px;margin:0 0 8px}p{color:#a9b0d6;max-width:420px}button{margin-top:12px;font:inherit;font-weight:600;padding:10px 18px;border:0;border-radius:10px;background:#ffb648;color:#1f1500;cursor:pointer}</style>
<div><h1>The chat is offline right now</h1><p>The server it runs on can't be reached at the moment (${why}). It usually comes back by itself within a few minutes.</p><button onclick="location.reload()">Try again</button></div>`);
}

const server = http.createServer((req, res) => {
  // answered here, so Render's health check never depends on the NAS
  if (req.url === '/healthz' || req.url.startsWith('/healthz?')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, relay: true }));
    return;
  }
  const upstream = client.request({
    protocol: target.protocol, hostname: target.hostname, port: targetPort, agent,
    method: req.method, path: req.url, headers: forwardHeaders(req)
  }, upRes => {
    const headers = {};
    for (const [name, value] of Object.entries(upRes.headers)) {
      if (!HOP_BY_HOP.has(name)) headers[name] = value;
    }
    res.writeHead(upRes.statusCode, upRes.statusMessage, headers);
    upRes.pipe(res);
    upRes.on('error', () => res.destroy());
  });
  upstream.on('error', err => {
    console.error('relay:', req.method, req.url, err.code || err.message);
    offlinePage(res, err.code === 'ENOTFOUND' ? 'its address was not found' : 'no answer');
  });
  // a visitor who leaves mid-request (or cancels an upload) frees the upstream request too
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
});
// big uploads (2 GB banners) take longer than Node's 5-minute request limit
server.requestTimeout = 0;

// The chat's live connection (Socket.IO over WebSocket): open the same
// upgrade to the real server, then join the two connections end to end.
server.on('upgrade', (req, socket, head) => {
  const upstream = client.request({
    protocol: target.protocol, hostname: target.hostname, port: targetPort,
    method: req.method, path: req.url,
    headers: { ...forwardHeaders(req), connection: 'Upgrade', upgrade: req.headers.upgrade || 'websocket' }
  });
  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upHead && upHead.length) socket.write(upHead);
    if (head && head.length) upSocket.write(head);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    const close = () => { socket.destroy(); upSocket.destroy(); };
    upSocket.on('error', close); socket.on('error', close);
    upSocket.on('close', close); socket.on('close', close);
  });
  // the real server answered without upgrading (e.g. it's restarting)
  upstream.on('response', upRes => {
    socket.end(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n\r\n`);
    upRes.resume();
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  upstream.end();
});

// uploads can take a while; never cut a slow but working request off
server.requestTimeout = 0;
server.headersTimeout = 60 * 1000;
server.keepAliveTimeout = 65 * 1000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Relay running on port ${PORT}, passing everything to ${target.origin}`);
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
