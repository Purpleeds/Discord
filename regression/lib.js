// Shared settings and helpers for the regression suites (see README.md).
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');
const BASE = process.env.BASE || 'http://localhost:4100';
// the database the server under test uses (some suites restart the server, or peek at the data)
const DB = process.env.DB || process.env.DATABASE_URL || 'postgresql://chat:chat@localhost/chat_test';
// a Chromium for the browser suites: CHROME, or Playwright's own if it is installed
const CHROME = process.env.CHROME || (fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
const SHOTS = path.join(__dirname, 'shots') + path.sep;
fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(method, p, token, body, headers) {
  const r = await fetch(BASE + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}, headers || {}), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})), headers: r.headers };
}
const get = (p, t) => call('GET', p, t);
const post = (p, t, b) => call('POST', p, t, b || {});
async function reg(u) { const r = await post('/register', null, { username: u, password: 'secret123' }); if (!r.data.token) throw new Error('register failed ' + JSON.stringify(r.data)); return r.data.token; }
const sock = t => new Promise((res, rej) => { const s = io(BASE, { auth: { token: t }, transports: ['websocket'], reconnection: false }); s.on('connect', () => res(s)); s.on('connect_error', e => rej(e)); });
const emit = (s, e, d) => new Promise(r => s.emit(e, d, r));
const done = () => { console.log(`passed ${pass}, failed ${fail}`); process.exit(fail ? 1 : 0); };
module.exports = { BASE, DB, CHROME, SHOTS, check, sleep, call, get, post, reg, sock, emit, done, uid: () => Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 36).toString(36) };
