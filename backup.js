// Backups, restore and data exports (see BACKUPS.md).
//
// A backup ("snapshot") is the whole database plus every file the chat keeps
// on disk (big attachments in uploads/, big banners and videos in assets/),
// written to BACKUP_DIR:
//
//   BACKUP_DIR/snapshots/<id>/manifest.json      what is in it, row counts, files
//   BACKUP_DIR/snapshots/<id>/<table>.ndjson.gz   one JSON row per line
//   BACKUP_DIR/blobs/<ab>/<sha256>                file bytes and big bytea values
//
// Blobs are stored once by their SHA-256, so a daily backup only costs the
// files that are new since the last one. Rows are read inside one
// REPEATABLE READ transaction (a consistent picture even while people chat)
// and restored with jsonb_populate_recordset, so Postgres does the type
// conversion and a backup made by an older version of the app restores into
// the current schema: columns it doesn't have keep their defaults.
//
// The routes here are for the site owner (Purple) only: a backup holds every
// DM and every password hash. "Download my data" and "Export channel" are
// zip files of what that person may already read.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const readline = require('readline');
const { once } = require('events');
const { finished } = require('stream/promises');

const FORMAT = 1;
const INLINE_BYTEA_MAX = 64 * 1024;   // bigger bytea values (kept files, assets) go to blobs/
const SNAPSHOT_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
const OWNER = 'Purple';

const qi = name => '"' + String(name).replace(/"/g, '""') + '"';
const ql = text => "'" + String(text).replace(/'/g, "''") + "'";
// wait until a stream wants more (or has gone away), without piling up listeners
function drained(stream) {
  return new Promise(resolve => {
    const done = () => { stream.off('drain', done); stream.off('close', done); resolve(); };
    stream.on('drain', done); stream.on('close', done);
  });
}
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

function newSnapshotId(now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}

// Every file under dir (relative paths with '/'), skipping half-written ones.
async function walk(dir, rel = '') {
  const out = [];
  const entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...await walk(dir, r));
    else if (e.isFile() && !/\.(partial|tmp|part)$/i.test(e.name)) out.push(r);
  }
  return out;
}
// A path inside base, or null (never trust a path from a file).
function inside(base, rel) {
  const full = path.resolve(base, String(rel || ''));
  return full.startsWith(path.resolve(base) + path.sep) ? full : null;
}

// ---------------- the blob store ----------------
class BlobStore {
  constructor(dir) { this.dir = path.join(dir, 'blobs'); }
  pathOf(sha) { return path.join(this.dir, sha.slice(0, 2), sha); }
  async has(sha) { return !!(await fsp.stat(this.pathOf(sha)).catch(() => null)); }
  async putBuffer(buf) {
    const sha = sha256(buf);
    if (await this.has(sha)) return sha;
    const dest = this.pathOf(sha);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const tmp = dest + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, dest);
    return sha;
  }
  // copies a file in while hashing it; returns { sha, size }
  async putFile(file) {
    await fsp.mkdir(this.dir, { recursive: true });
    const tmp = path.join(this.dir, crypto.randomBytes(8).toString('hex') + '.tmp');
    const hash = crypto.createHash('sha256');
    let size = 0;
    const out = fs.createWriteStream(tmp);
    try {
      for await (const chunk of fs.createReadStream(file)) {
        hash.update(chunk); size += chunk.length;
        if (!out.write(chunk)) await once(out, 'drain');
      }
      out.end(); await finished(out);
    } catch (err) { out.destroy(); await fsp.unlink(tmp).catch(() => {}); throw err; }
    const sha = hash.digest('hex');
    if (await this.has(sha)) await fsp.unlink(tmp).catch(() => {});
    else { await fsp.mkdir(path.dirname(this.pathOf(sha)), { recursive: true }); await fsp.rename(tmp, this.pathOf(sha)); }
    return { sha, size };
  }
  async all() {
    const out = [];
    for (const d of await fsp.readdir(this.dir).catch(() => [])) {
      for (const f of await fsp.readdir(path.join(this.dir, d)).catch(() => [])) if (/^[0-9a-f]{64}$/.test(f)) out.push(f);
    }
    return out;
  }
}

// ---------------- zip and tar writers (no dependencies) ----------------
// Zip: "stored" entries for files (pictures and videos are compressed
// already), deflated for text. Sizes must stay under 4 GB (no zip64), so
// callers keep a budget (ZIP_FILE_BUDGET).
const ZIP_FILE_BUDGET = 3.5 * 1024 * 1024 * 1024;
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf, prev = 0) {
  if (zlib.crc32) return zlib.crc32(buf, prev);
  let c = ~prev;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function dosTime(d = new Date()) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
class ZipWriter {
  constructor(out) { this.out = out; this.offset = 0; this.entries = []; this.names = new Set(); }
  async write(buf) {
    if (this.out.destroyed) throw new Error('download stopped');
    this.offset += buf.length;
    if (!this.out.write(buf)) await drained(this.out);
  }
  uniqueName(name) {
    let n = String(name).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\.(\/|$)/g, '_$1') || 'file';
    if (!this.names.has(n)) { this.names.add(n); return n; }
    const ext = path.posix.extname(n), base = n.slice(0, n.length - ext.length);
    for (let i = 2; ; i++) { const c = `${base} (${i})${ext}`; if (!this.names.has(c)) { this.names.add(c); return c; } }
  }
  async header(name, method) {
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosTime();
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0808, 6); h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt16LE(nameBuf.length, 26);
    const entry = { nameBuf, method, time, date, offset: this.offset, crc: 0, csize: 0, usize: 0 };
    await this.write(h); await this.write(nameBuf);
    return entry;
  }
  async trailer(entry) {
    const d = Buffer.alloc(16);
    d.writeUInt32LE(0x08074b50, 0); d.writeUInt32LE(entry.crc >>> 0, 4); d.writeUInt32LE(entry.csize, 8); d.writeUInt32LE(entry.usize, 12);
    await this.write(d);
    this.entries.push(entry);
  }
  async addText(name, text) {
    const raw = Buffer.from(text, 'utf8');
    const entry = await this.header(this.uniqueName(name), 8);
    const deflated = zlib.deflateRawSync(raw);
    entry.crc = crc32(raw); entry.usize = raw.length; entry.csize = deflated.length;
    await this.write(deflated);
    await this.trailer(entry);
  }
  async addBuffer(name, buf) {
    const entry = await this.header(this.uniqueName(name), 0);
    entry.crc = crc32(buf); entry.usize = entry.csize = buf.length;
    await this.write(buf);
    await this.trailer(entry);
  }
  async addFile(name, file) {
    const entry = await this.header(this.uniqueName(name), 0);
    let crc = 0, size = 0;
    for await (const chunk of fs.createReadStream(file)) { crc = crc32(chunk, crc); size += chunk.length; await this.write(chunk); }
    entry.crc = crc; entry.usize = entry.csize = size;
    await this.trailer(entry);
  }
  async finish() {
    const start = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0808, 8); c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(e.time, 12); c.writeUInt16LE(e.date, 14); c.writeUInt32LE(e.crc >>> 0, 16); c.writeUInt32LE(e.csize, 20); c.writeUInt32LE(e.usize, 24);
      c.writeUInt16LE(e.nameBuf.length, 28); c.writeUInt32LE(e.offset, 42);
      await this.write(c); await this.write(e.nameBuf);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(this.entries.length, 8); end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12); end.writeUInt32LE(start, 16);
    await this.write(end);
    this.out.end();
  }
}
// Tar (ustar, sizes in base-256 past 8 GB): extracting it into a backup
// folder gives the same layout the app reads.
function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(512);
  let prefix = '', n = name;
  if (Buffer.byteLength(n) > 100) { const cut = n.lastIndexOf('/', 154); prefix = n.slice(0, cut); n = n.slice(cut + 1); }
  h.write(n, 0, 100); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  if (size < 8 ** 11) h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  else { h[124] = 0x80; let s = BigInt(size); for (let i = 135; i > 124; i--) { h[i] = Number(s & 0xffn); s >>= 8n; } }
  h.write(Math.floor((mtime || Date.now()) / 1000).toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263); h.write(prefix, 345, 155);
  let sum = 0; for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

// ---------------- setup ----------------
module.exports = function setupBackups(deps) {
  const { app, pool, q, one, route, requireAuth, rateLimited, dirs, hooks } = deps;
  const BACKUP_DIR = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : '';
  const EVERY_MS = Math.max(1, Number(process.env.BACKUP_EVERY_HOURS) || 24) * 60 * 60 * 1000;
  const KEEP = {
    daily: Math.max(1, Number(process.env.BACKUP_KEEP_DAILY) || 7),
    weekly: Math.max(0, Number(process.env.BACKUP_KEEP_WEEKLY ?? 8)),
    monthly: Math.max(0, Number(process.env.BACKUP_KEEP_MONTHLY ?? 12))
  };
  const RESTORE_IF_EMPTY = process.env.BACKUP_RESTORE_IF_EMPTY !== 'off';
  const AREAS = { uploads: dirs.UPLOAD_DIR, assets: dirs.ASSET_DIR };
  const store = BACKUP_DIR ? new BlobStore(BACKUP_DIR) : null;
  const snapRoot = BACKUP_DIR ? path.join(BACKUP_DIR, 'snapshots') : '';
  const state = { busy: null, startedAt: null, lastError: null, lastOk: null, timer: null };

  function snapDir(id) { return path.join(snapRoot, id); }
  async function readManifest(id) {
    if (!SNAPSHOT_ID.test(id)) return null;
    try { return JSON.parse(await fsp.readFile(path.join(snapDir(id), 'manifest.json'), 'utf8')); } catch (_) { return null; }
  }
  // complete snapshots, newest first
  async function listSnapshots() {
    if (!BACKUP_DIR) return [];
    const ids = (await fsp.readdir(snapRoot).catch(() => [])).filter(n => SNAPSHOT_ID.test(n)).sort().reverse();
    const out = [];
    for (const id of ids) { const m = await readManifest(id); if (m && m.format === FORMAT) out.push(m); }
    // ids only have whole seconds; two backups in one second sort by time made
    return out.sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));
  }

  // ---- the file index: path+size+mtime -> sha, so unchanged files aren't re-read daily ----
  const indexFile = () => path.join(BACKUP_DIR, 'file-index.json');
  async function loadIndex() { try { return JSON.parse(await fsp.readFile(indexFile(), 'utf8')); } catch (_) { return {}; } }
  async function saveIndex(index) { const tmp = indexFile() + '.tmp'; await fsp.writeFile(tmp, JSON.stringify(index)); await fsp.rename(tmp, indexFile()); }

  // ---------------- make a backup ----------------
  async function createSnapshot(label = 'scheduled', by = '') {
    if (!BACKUP_DIR) throw new Error('backups are off (BACKUP_DIR is not set)');
    const id = newSnapshotId();
    const tmpDir = snapDir(id) + '.partial';
    await fsp.mkdir(tmpDir, { recursive: true });
    const started = Date.now();
    const manifest = { format: FORMAT, id, createdAt: new Date().toISOString(), label, by, appVersion: deps.version ? deps.version() : '', tables: [], sequences: {}, files: [], blobs: [], rows: 0, bytes: 0 };
    const blobs = new Set();
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const tables = (await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`)).rows.map(r => r.table_name);
      const cols = (await client.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`)).rows;
      for (const table of tables) {
        const tcols = cols.filter(c => c.table_name === table);
        const bytea = tcols.filter(c => c.data_type === 'bytea').map(c => c.column_name);
        const file = table.replace(/[^\w.-]/g, '_') + '.ndjson.gz';
        const gz = zlib.createGzip({ level: 6 });
        const out = fs.createWriteStream(path.join(tmpDir, file));
        gz.pipe(out);
        const minus = bytea.length ? ` - ARRAY[${bytea.map(ql).join(',')}]::text[]` : '';
        await client.query(`DECLARE backup_cur NO SCROLL CURSOR FOR SELECT to_jsonb(t)${minus} AS __row${bytea.map(c => ', t.' + qi(c)).join('')} FROM ${qi(table)} t`);
        let rows = 0;
        for (;;) {
          const batch = (await client.query(`FETCH ${bytea.length ? 4 : 1000} FROM backup_cur`)).rows;
          if (!batch.length) break;
          for (const r of batch) {
            const row = r.__row;
            for (const c of bytea) {
              const v = r[c];
              if (v == null) row[c] = null;
              else if (v.length <= INLINE_BYTEA_MAX) row[c] = '\\x' + v.toString('hex');
              else { const sha = await store.putBuffer(v); blobs.add(sha); row[c] = { $blob: sha }; }
            }
            if (!gz.write(JSON.stringify(row) + '\n')) await once(gz, 'drain');
            rows++;
          }
        }
        await client.query('CLOSE backup_cur');
        gz.end(); await finished(out);
        manifest.tables.push({ name: table, file, rows, columns: tcols.map(c => c.column_name) });
        manifest.rows += rows;
        for (const c of tcols) {
          const seq = (await client.query(`SELECT pg_get_serial_sequence($1, $2) AS s`, [qi(table), c.column_name])).rows[0].s;
          if (!seq) continue;
          const v = (await client.query(`SELECT last_value, is_called FROM ${seq}`)).rows[0];
          manifest.sequences[table + '.' + c.column_name] = Number(v.is_called ? v.last_value : Number(v.last_value) - 1);
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    } finally { client.release(); }

    // files on disk (big attachments and big banners/videos)
    try {
      const index = await loadIndex();
      const seen = {};
      for (const [area, dir] of Object.entries(AREAS)) {
        for (const rel of await walk(dir)) {
          const full = path.join(dir, rel);
          const st = await fsp.stat(full).catch(() => null);
          if (!st) continue; // deleted meanwhile
          const key = area + '/' + rel;
          let known = index[key];
          if (!(known && known.size === st.size && known.mtimeMs === st.mtimeMs && await store.has(known.sha))) {
            const put = await store.putFile(full).catch(() => null);
            if (!put) continue;
            known = { sha: put.sha, size: put.size, mtimeMs: st.mtimeMs };
          }
          seen[key] = known;
          blobs.add(known.sha);
          manifest.files.push({ area, path: rel, sha: known.sha, size: known.size, mtime: Math.round(st.mtimeMs) });
        }
      }
      await saveIndex(seen);
    } catch (err) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    manifest.blobs = [...blobs];
    for (const t of manifest.tables) manifest.bytes += (await fsp.stat(path.join(tmpDir, t.file))).size;
    manifest.fileBytes = manifest.files.reduce((s, f) => s + f.size, 0);
    manifest.seconds = Math.round((Date.now() - started) / 100) / 10;
    await fsp.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
    await fsp.rename(tmpDir, snapDir(id));
    console.log(`backup ${id} (${label}): ${manifest.rows} rows, ${manifest.files.length} files, ${manifest.seconds}s`);
    await prune().catch(err => console.error('backup prune failed:', err.message));
    return manifest;
  }

  // Keep the newest KEEP.daily, the newest of each of the last KEEP.weekly
  // weeks and of the last KEEP.monthly months; then drop blobs nothing uses.
  async function prune() {
    const snaps = await listSnapshots();
    const keep = new Set(snaps.slice(0, KEEP.daily).map(s => s.id));
    const now = Date.now();
    const bucket = (ms, count) => {
      const seen = new Set();
      for (const s of snaps) {
        const age = now - Date.parse(s.createdAt);
        const b = Math.floor(age / ms);
        if (b >= count || seen.has(b)) continue;
        seen.add(b); keep.add(s.id);
      }
    };
    bucket(7 * 24 * 3600e3, KEEP.weekly);
    bucket(30 * 24 * 3600e3, KEEP.monthly);
    for (const s of snaps) if (!keep.has(s.id)) await fsp.rm(snapDir(s.id), { recursive: true, force: true });
    const used = new Set();
    for (const s of snaps) if (keep.has(s.id)) for (const b of s.blobs || []) used.add(b);
    if (!used.size && snaps.length) return; // something is off - never empty the store
    for (const b of await store.all()) if (!used.has(b)) await fsp.unlink(store.pathOf(b)).catch(() => {});
  }

  // ---------------- restore ----------------
  async function restoreSnapshot(id, { safety = true, by = '' } = {}) {
    const manifest = await readManifest(id);
    if (!manifest) throw new Error('no such backup');
    if (manifest.format !== FORMAT) throw new Error('this backup was made by a newer version of the app');
    // everything it needs must be there before anything is touched
    const missing = [];
    for (const b of manifest.blobs || []) if (!(await store.has(b))) missing.push(b);
    for (const t of manifest.tables) if (!(await fsp.stat(path.join(snapDir(id), t.file)).catch(() => null))) missing.push(t.file);
    if (missing.length) throw new Error(`this backup is incomplete (${missing.length} missing pieces) - restore another one`);
    let before = null;
    if (safety) before = await createSnapshot('before-restore', by);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tables = (await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`)).rows.map(r => r.table_name);
      const cols = (await client.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema()`)).rows;
      const counters = [];
      for (const c of cols) {
        const seq = (await client.query(`SELECT pg_get_serial_sequence($1, $2) AS s`, [qi(c.table_name), c.column_name])).rows[0].s;
        if (!seq) continue;
        const v = (await client.query(`SELECT last_value, is_called FROM ${seq}`)).rows[0];
        counters.push({ seq, table: c.table_name, column: c.column_name, now: v.is_called ? Number(v.last_value) : Number(v.last_value) - 1 });
      }
      if (tables.length) await client.query(`TRUNCATE ${tables.map(qi).join(', ')}`);
      for (const t of manifest.tables) {
        if (!tables.includes(t.name)) continue; // a table this version no longer has
        const current = cols.filter(c => c.table_name === t.name);
        const names = t.columns.filter(c => current.some(x => x.column_name === c));
        if (!names.length) continue;
        const bytea = new Set(current.filter(c => c.data_type === 'bytea').map(c => c.column_name));
        const colList = names.map(qi).join(', ');
        const rList = names.map(c => 'r.' + qi(c)).join(', ');
        let batch = [], chars = 0;
        const flush = async () => {
          if (!batch.length) return;
          await client.query(`INSERT INTO ${qi(t.name)} (${colList}) SELECT ${rList} FROM jsonb_populate_recordset(NULL::${qi(t.name)}, $1::jsonb) r`, ['[' + batch.join(',') + ']']);
          batch = []; chars = 0;
        };
        const lines = readline.createInterface({ input: fs.createReadStream(path.join(snapDir(id), t.file)).pipe(zlib.createGunzip()), crlfDelay: Infinity });
        for await (const line of lines) {
          if (!line) continue;
          if (line.includes('"$blob"')) {
            const row = JSON.parse(line);
            const params = [];
            const sel = names.map(c => {
              const v = row[c];
              if (bytea.has(c) && v && typeof v === 'object' && v.$blob) { params.push(v.$blob); delete row[c]; return `$${params.length + 1}::bytea`; }
              return 'r.' + qi(c);
            });
            const values = [];
            for (const sha of params) values.push(await fsp.readFile(store.pathOf(sha)));
            await client.query(`INSERT INTO ${qi(t.name)} (${colList}) SELECT ${sel.join(', ')} FROM jsonb_populate_record(NULL::${qi(t.name)}, $1::jsonb) r`, [JSON.stringify(row), ...values]);
            continue;
          }
          batch.push(line); chars += line.length;
          if (batch.length >= 500 || chars > 4 * 1024 * 1024) await flush();
        }
        await flush();
      }
      // counters: never hand out an id that a restored row - or one made
      // since the backup, which open pages may still show - already had
      for (const { seq, table, column, now } of counters) {
        const max = Number((await client.query(`SELECT COALESCE(MAX(${qi(column)}), 0) AS m FROM ${qi(table)}`)).rows[0].m);
        const saved = Number(manifest.sequences[table + '.' + column] || 0);
        const v = Math.max(max, saved, now);
        await client.query(`SELECT setval($1, $2, $3)`, [seq, Math.max(v, 1), v > 0]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }

    // files back on disk
    let restoredFiles = 0;
    for (const f of manifest.files || []) {
      const base = AREAS[f.area];
      const dest = base && inside(base, f.path);
      if (!dest) continue;
      const st = await fsp.stat(dest).catch(() => null);
      if (st && st.size === f.size) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const tmp = dest + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
      await fsp.copyFile(store.pathOf(f.sha), tmp);
      if (f.mtime) await fsp.utimes(tmp, new Date(), new Date(f.mtime)).catch(() => {});
      await fsp.rename(tmp, dest);
      restoredFiles++;
    }
    console.log(`restored backup ${id}: ${manifest.rows} rows, ${restoredFiles} files written${before ? `, previous data saved as ${before.id}` : ''}`);
    return { manifest, before };
  }

  // one at a time: backups and restores never overlap
  async function exclusive(kind, fn) {
    if (state.busy) throw Object.assign(new Error(state.busy === 'restore' ? 'a restore is running' : 'a backup is already running'), { status: 409 });
    state.busy = kind; state.startedAt = Date.now();
    try { const r = await fn(); state.lastError = null; return r; }
    catch (err) { state.lastError = { at: new Date().toISOString(), message: err.message }; throw err; }
    finally { state.busy = null; state.startedAt = null; }
  }

  async function scheduledTick() {
    if (state.busy || hooks.shuttingDown()) return;
    const snaps = await listSnapshots();
    const newest = snaps[0];
    if (newest && Date.now() - Date.parse(newest.createdAt) < EVERY_MS) return;
    await exclusive('backup', () => createSnapshot('scheduled'));
  }

  // ---------------- downloads ----------------
  // A short-lived, single-use link, so a big download can go straight to the
  // browser's download manager (no login header there). The secret is in the
  // link; it lasts DOWNLOAD_TTL_MS and works once.
  const DOWNLOAD_TTL_MS = 10 * 60 * 1000;
  const downloads = new Map();
  function makeDownload(username, fileName, type, send) {
    const ticket = crypto.randomBytes(24).toString('base64url');
    downloads.set(ticket, { username, fileName, type, send, expires: Date.now() + DOWNLOAD_TTL_MS });
    return `/downloads/${ticket}/${encodeURIComponent(fileName)}`;
  }
  setInterval(() => { const now = Date.now(); for (const [k, d] of downloads) if (d.expires < now) downloads.delete(k); }, 60 * 1000).unref();
  app.get('/downloads/:ticket/:name?', route(async (req, res) => {
    const d = downloads.get(req.params.ticket);
    if (!d || d.expires < Date.now()) return res.status(404).type('text').send('This download link has expired. Start the download again from the app.');
    downloads.delete(req.params.ticket);
    res.setHeader('Content-Type', d.type);
    res.setHeader('Content-Disposition', `attachment; filename="${d.fileName.replace(/[^\w.-]/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try { await d.send(res); }
    catch (err) { console.error('download failed:', err.message); res.destroy(); }
  }));
  const safeName = s => String(s || '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chat';
  const stamp = () => new Date().toISOString().slice(0, 10);

  async function sendSnapshotTar(manifest, res) {
    const dir = snapDir(manifest.id);
    const entries = [];
    entries.push({ name: 'README.txt', buf: Buffer.from(TAR_README) });
    for (const f of await fsp.readdir(dir)) entries.push({ name: `snapshots/${manifest.id}/${f}`, file: path.join(dir, f) });
    for (const b of manifest.blobs || []) entries.push({ name: `blobs/${b.slice(0, 2)}/${b}`, file: store.pathOf(b) });
    const write = async buf => { if (res.destroyed) throw new Error('download stopped'); if (!res.write(buf)) await drained(res); };
    for (const e of entries) {
      if (e.buf) { await write(tarHeader(e.name, e.buf.length)); await write(e.buf); }
      else {
        const st = await fsp.stat(e.file);
        await write(tarHeader(e.name, st.size, st.mtimeMs));
        for await (const chunk of fs.createReadStream(e.file)) await write(chunk);
      }
      const size = e.buf ? e.buf.length : (await fsp.stat(e.file)).size;
      if (size % 512) await write(Buffer.alloc(512 - (size % 512)));
    }
    await write(Buffer.alloc(1024));
    res.end();
  }

  // ---------------- owner routes ----------------
  function ownerOnly(req, res) {
    if (req.username !== OWNER) { res.status(403).json({ error: 'only the site owner can manage backups' }); return false; }
    return true;
  }
  async function freeSpace() {
    try { const s = await fsp.statfs(BACKUP_DIR); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch (_) { return null; }
  }
  app.get('/admin/backups', requireAuth, route(async (req, res) => {
    if (!ownerOnly(req, res)) return;
    const snaps = await listSnapshots();
    res.json({
      enabled: !!BACKUP_DIR,
      dir: BACKUP_DIR,
      everyHours: EVERY_MS / 3600e3,
      keep: KEEP,
      busy: state.busy, startedAt: state.startedAt,
      lastError: state.lastError,
      nextAt: BACKUP_DIR ? new Date((snaps[0] ? Date.parse(snaps[0].createdAt) : Date.now()) + (snaps[0] ? EVERY_MS : 0)).toISOString() : null,
      disk: BACKUP_DIR ? await freeSpace() : null,
      storeBytes: snaps.length ? await storeSize() : 0,
      snapshots: snaps.map(s => ({ id: s.id, createdAt: s.createdAt, label: s.label, by: s.by || '', rows: s.rows, tables: s.tables.length, files: s.files.length, fileBytes: s.fileBytes || 0, bytes: s.bytes, seconds: s.seconds, appVersion: s.appVersion }))
    });
  }));
  let sizeCache = { at: 0, bytes: 0 };
  async function storeSize() {
    if (Date.now() - sizeCache.at < 5 * 60 * 1000 && !state.busy) return sizeCache.bytes;
    let bytes = 0;
    for (const b of await store.all()) { const st = await fsp.stat(store.pathOf(b)).catch(() => null); if (st) bytes += st.size; }
    for (const s of await listSnapshots()) for (const t of s.tables) bytes += 0 + (await fsp.stat(path.join(snapDir(s.id), t.file)).catch(() => ({ size: 0 }))).size;
    sizeCache = { at: Date.now(), bytes };
    return bytes;
  }
  app.post('/admin/backups', requireAuth, route(async (req, res) => {
    if (!ownerOnly(req, res)) return;
    if (!BACKUP_DIR) return res.status(400).json({ error: 'backups are off: set BACKUP_DIR (see BACKUPS.md)' });
    try {
      const m = await exclusive('backup', () => createSnapshot('manual', req.username));
      sizeCache.at = 0;
      res.json({ ok: true, id: m.id, rows: m.rows, files: m.files.length });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  }));
  app.post('/admin/backups/:id/download', requireAuth, route(async (req, res) => {
    if (!ownerOnly(req, res)) return;
    const m = await readManifest(req.params.id);
    if (!m) return res.status(404).json({ error: 'no such backup' });
    res.json({ url: makeDownload(req.username, `chat-backup-${m.id}.tar`, 'application/x-tar', r => sendSnapshotTar(m, r)) });
  }));
  app.post('/admin/backups/:id/restore', requireAuth, route(async (req, res) => {
    if (!ownerOnly(req, res)) return;
    if (req.body.confirm !== 'RESTORE') return res.status(400).json({ error: 'type RESTORE to confirm' });
    const m = await readManifest(req.params.id);
    if (!m) return res.status(404).json({ error: 'no such backup' });
    try {
      const { before } = await exclusive('restore', () => restoreSnapshot(m.id, { by: req.username }));
      res.json({ ok: true, restored: m.id, savedAs: before && before.id });
      // everything in memory (caches, live sockets, calls) belongs to the old
      // data: start again. Docker (restart: unless-stopped) brings it back.
      hooks.restarting(`restored backup ${m.id}`);
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
  }));

  // ---------------- "Download my data" ----------------
  // A zip of what is about this person: account and profiles (no password or
  // token hashes), friends, blocks, servers, groups, devices, every message
  // they sent (with where), their reactions, and the files and pictures they
  // uploaded. Not other people's messages.
  async function roomLabels(rooms, me) {
    const labels = {};
    const list = [...new Set(rooms)];
    const chans = await q(`SELECT c.room, c.name, s.name AS server FROM server_channels c LEFT JOIN servers s ON s.id = c.server_id WHERE c.room = ANY($1)`, [list]);
    for (const c of chans) labels[c.room] = `${c.server || 'server'} > #${c.name}`;
    const threadIds = list.map(r => /^thread:(\d+)$/.exec(r)).filter(Boolean).map(m => Number(m[1]));
    if (threadIds.length) {
      const threads = await q(`SELECT t.id, t.name, c.name AS channel, s.name AS server FROM threads t LEFT JOIN server_channels c ON c.room = t.parent_room LEFT JOIN servers s ON s.id = c.server_id WHERE t.id = ANY($1)`, [threadIds]);
      for (const t of threads) labels['thread:' + t.id] = `${t.server || 'server'} > #${t.channel || '?'} > thread "${t.name}"`;
    }
    const groupIds = list.map(r => /^group:(\d+)$/.exec(r)).filter(Boolean).map(m => Number(m[1]));
    if (groupIds.length) for (const g of await q(`SELECT id, name FROM chat_groups WHERE id = ANY($1)`, [groupIds])) labels['group:' + g.id] = `Group "${g.name}"`;
    for (const r of list) {
      if (labels[r]) continue;
      const dm = /^dm:([^:]+):([^:]+)$/.exec(r);
      labels[r] = dm ? `DM with ${dm[1] === me ? dm[2] : dm[1]}` : '#' + r;
    }
    return labels;
  }
  const SECRET_COLUMN = /password|token|secret|hash|^data$/i;
  const clean = row => { const o = {}; for (const [k, v] of Object.entries(row || {})) if (!SECRET_COLUMN.test(k)) o[k] = v; return o; };

  async function addFileRows(zip, rows, folder, budget) {
    const skipped = [];
    for (const f of rows) {
      const name = `${folder}/${f.id}-${String(f.file_name || 'file').replace(/[\\/]/g, '_')}`;
      try {
        if (f.storage === 'db') {
          const b = await one(`SELECT data, size FROM file_blobs WHERE file_id = $1`, [f.id]);
          if (!b) { skipped.push({ id: f.id, name: f.file_name, why: 'no longer stored' }); continue; }
          if (budget.left < b.data.length) { skipped.push({ id: f.id, name: f.file_name, why: 'too big for one download' }); continue; }
          budget.left -= b.data.length;
          await zip.addBuffer(name, b.data);
        } else {
          const p = deps.diskPathForUpload(f.file_url);
          const st = p && await fsp.stat(p).catch(() => null);
          if (!st) { skipped.push({ id: f.id, name: f.file_name, why: 'temporary file, already deleted' }); continue; }
          if (budget.left < st.size) { skipped.push({ id: f.id, name: f.file_name, why: 'too big for one download' }); continue; }
          budget.left -= st.size;
          await zip.addFile(name, p);
        }
      } catch (err) { skipped.push({ id: f.id, name: f.file_name, why: 'could not be read' }); }
    }
    return skipped;
  }
  const exportMessage = (m, files, names) => ({
    id: m.id,
    at: m.created_at,
    author: m.user,
    authorName: m.author_name || (names && names[m.user]) || m.user,
    text: m.text,
    kind: m.kind || undefined,
    replyTo: m.reply_to || undefined,
    editedAt: m.edited_at || undefined,
    pinned: m.pinned_at ? true : undefined,
    source: m.source || undefined,
    attachments: (files[m.id] || []).map(f => ({ id: f.id, name: f.file_name, type: f.file_type, size: Number(f.file_size) || 0 }))
  });
  const MESSAGE_COLUMNS = `id, room, "user", text, to_user, is_group, reply_to, edited_at, pinned_at, kind, author_name, source, created_at`;

  async function sendMyData(username, res) {
    const zip = new ZipWriter(res);
    const user = await one(`SELECT * FROM users WHERE username = $1`, [username]);
    const account = clean(user);
    const serverRows = await q(`SELECT m.*, s.name AS server_name FROM server_members m LEFT JOIN servers s ON s.id = m.server_id WHERE m.username = $1 ORDER BY m.joined_at`, [username]);
    const roles = await q(`SELECT r.server_id, r.name FROM server_member_roles mr JOIN server_roles r ON r.id = mr.role_id WHERE mr.username = $1`, [username]).catch(() => []);
    const groups = await q(`SELECT g.id, g.name, g.owner, m.joined_at FROM group_members m JOIN chat_groups g ON g.id = m.group_id WHERE m.username = $1`, [username]);
    const friends = await q(`SELECT requester, addressee, status, created_at FROM friendships WHERE requester = $1 OR addressee = $1`, [username]);
    const blocks = await q(`SELECT blocked, created_at FROM blocks WHERE blocker = $1`, [username]);
    const devices = await q(`SELECT device, created_at, last_seen_at FROM sessions WHERE username = $1 ORDER BY created_at`, [username]);
    const bots = await q(`SELECT username, display_name, created_at FROM users WHERE bot_owner = $1 AND COALESCE(is_bot, 0) = 1`, [username]).catch(() => []);
    await zip.addText('account.json', JSON.stringify({
      exportedAt: new Date().toISOString(),
      account,
      servers: serverRows.map(s => Object.assign(clean(s), { roles: roles.filter(r => r.server_id === s.server_id).map(r => r.name) })),
      groups, friends, blocked: blocks, devices, bots
    }, null, 2));

    const messages = await q(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE "user" = $1 AND deleted_at IS NULL ORDER BY id`, [username]);
    const fileRows = await q(`SELECT id, room, message_id, file_name, file_type, file_url, file_size, storage, created_at FROM files WHERE "user" = $1 AND COALESCE(pending, 0) = 0 ORDER BY id`, [username]);
    const byMessage = {};
    for (const f of fileRows) if (f.message_id) (byMessage[f.message_id] = byMessage[f.message_id] || []).push(f);
    const labels = await roomLabels(messages.map(m => m.room).concat(fileRows.map(f => f.room)), username);
    const rooms = {};
    for (const m of messages) (rooms[m.room] = rooms[m.room] || { where: labels[m.room], messages: [] }).messages.push(exportMessage(m, byMessage, null));
    await zip.addText('messages.json', JSON.stringify(Object.values(rooms), null, 2));
    const reactions = await q(`SELECT message_id, emoji, created_at FROM message_reactions WHERE username = $1 ORDER BY created_at`, [username]);
    await zip.addText('reactions.json', JSON.stringify(reactions, null, 2));

    const budget = { left: ZIP_FILE_BUDGET };
    const skipped = await addFileRows(zip, fileRows, 'files', budget);
    // pictures, banners and videos they uploaded for profiles and servers
    const assets = await q(`SELECT id, key, type, storage, size FROM assets WHERE owner = $1 ORDER BY id`, [username]).catch(() => []);
    for (const a of assets) {
      const ext = String(a.type || '').split('/')[1] || 'bin';
      if (a.storage === 'disk') {
        const p = inside(dirs.ASSET_DIR, a.key);
        if (p && await fsp.stat(p).catch(() => null) && budget.left >= Number(a.size)) { budget.left -= Number(a.size); await zip.addFile(`pictures/${a.key}.${ext}`, p); }
      } else {
        const row = await one(`SELECT data FROM assets WHERE id = $1`, [a.id]);
        if (row && row.data) await zip.addBuffer(`pictures/${a.key}.${ext}`, row.data);
      }
    }
    if (user && /^data:image\/(\w+);base64,/.test(user.avatar_url || '')) {
      const m = /^data:image\/(\w+);base64,(.*)$/s.exec(user.avatar_url);
      await zip.addBuffer(`pictures/avatar.${m[1]}`, Buffer.from(m[2], 'base64'));
    }
    await zip.addText('files.json', JSON.stringify({
      files: fileRows.map(f => ({ id: f.id, name: f.file_name, type: f.file_type, size: Number(f.file_size) || 0, where: labels[f.room], at: f.created_at, message: f.message_id || undefined })),
      notIncluded: skipped
    }, null, 2));
    await zip.addText('README.txt', MY_DATA_README(username));
    await zip.finish();
  }
  app.post('/me/export', requireAuth, route(async (req, res) => {
    if (rateLimited('export:' + req.username, 3, 15 * 60 * 1000)) return res.status(429).json({ error: 'you can download your data 3 times every 15 minutes - try again soon' });
    const url = makeDownload(req.username, `my-chat-data-${safeName(req.username)}-${stamp()}.zip`, 'application/zip', r => sendMyData(req.username, r));
    res.json({ url });
  }));

  // ---------------- "Export channel" ----------------
  // For people who can read the channel and have Manage messages there: a
  // zip with messages.json, a readable messages.html, and the attachments
  // that are still stored. Threads in the channel are included.
  async function sendChannel(channel, server, res) {
    const zip = new ZipWriter(res);
    const threads = await q(`SELECT id, name, created_by, created_at FROM threads WHERE parent_room = $1 ORDER BY id`, [channel.room]);
    const rooms = [{ room: channel.room, title: '#' + channel.name }].concat(threads.map(t => ({ room: 'thread:' + t.id, title: `Thread "${t.name}"` })));
    const out = [];
    const allFiles = [];
    for (const r of rooms) {
      const msgs = await q(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE room = $1 AND deleted_at IS NULL ORDER BY id`, [r.room]);
      const files = await q(`SELECT id, room, message_id, file_name, file_type, file_url, file_size, storage, created_at FROM files WHERE room = $1 AND COALESCE(pending, 0) = 0 ORDER BY id`, [r.room]);
      allFiles.push(...files);
      const byMessage = {};
      for (const f of files) if (f.message_id) (byMessage[f.message_id] = byMessage[f.message_id] || []).push(f);
      const people = [...new Set(msgs.map(m => m.user))];
      const names = {};
      if (people.length) {
        for (const u of await q(`SELECT username, display_name FROM users WHERE username = ANY($1)`, [people])) names[u.username] = u.display_name || u.username;
        for (const u of await q(`SELECT username, nickname FROM server_members WHERE server_id = $1 AND username = ANY($2) AND nickname IS NOT NULL AND nickname <> ''`, [channel.server_id, people])) names[u.username] = u.nickname;
      }
      out.push({ room: r.room, title: r.title, messages: msgs.map(m => exportMessage(m, byMessage, names)), files: files.filter(f => !f.message_id).map(f => ({ id: f.id, name: f.file_name, type: f.file_type, size: Number(f.file_size) || 0, at: f.created_at, by: f.user })) });
    }
    const info = { exportedAt: new Date().toISOString(), server: server && server.name, channel: channel.name, topic: channel.topic || '' };
    await zip.addText('messages.json', JSON.stringify(Object.assign(info, { rooms: out }), null, 2));
    await zip.addText('messages.html', channelHtml(info, out));
    const skipped = await addFileRows(zip, allFiles, 'attachments', { left: ZIP_FILE_BUDGET });
    if (skipped.length) await zip.addText('not-included.json', JSON.stringify(skipped, null, 2));
    await zip.finish();
  }
  app.post('/channels/export', requireAuth, route(async (req, res) => {
    const channel = await deps.getChannelByRoom(String(req.body.room || ''));
    if (!channel || !(await deps.canViewChannel(req.username, channel))) return res.status(404).json({ error: 'channel not found' });
    if (!(await deps.hasServerPerm(req.username, channel.server_id, 'manage_messages'))) return res.status(403).json({ error: 'you need the Manage messages power in this server to export a channel' });
    if (rateLimited('channel-export:' + req.username, 5, 15 * 60 * 1000)) return res.status(429).json({ error: 'too many exports - try again in a few minutes' });
    const server = await one(`SELECT id, name FROM servers WHERE id = $1`, [channel.server_id]);
    deps.auditLog(channel.server_id, req.username, 'channel_export', channel.name, {});
    res.json({ url: makeDownload(req.username, `${safeName(server && server.name)}-${safeName(channel.name)}-${stamp()}.zip`, 'application/zip', r => sendChannel(channel, server, r)) });
  }));

  // ---------------- boot ----------------
  // An empty database (a new NAS, or a lost disk) with backups in BACKUP_DIR:
  // bring the newest one back before anything else is created.
  async function restoreIfEmpty() {
    if (!BACKUP_DIR || !RESTORE_IF_EMPTY) return false;
    const users = await one(`SELECT COUNT(*)::int AS n FROM users`);
    if (users.n > 0) return false;
    const snaps = (await listSnapshots()).filter(s => s.rows > 0 && s.tables.some(t => t.name === 'users' && t.rows > 0));
    if (!snaps.length) return false;
    console.log(`the database is empty and ${BACKUP_DIR} has backups - restoring ${snaps[0].id}`);
    await exclusive('restore', () => restoreSnapshot(snaps[0].id, { safety: false, by: 'auto' }));
    return true;
  }
  function start() {
    if (!BACKUP_DIR) { console.log('backups are off (set BACKUP_DIR to turn them on)'); return; }
    // half-written snapshots from a crash or restart mid-backup
    fsp.readdir(snapRoot).then(names => Promise.all(names.filter(n => n.endsWith('.partial')).map(n => fsp.rm(path.join(snapRoot, n), { recursive: true, force: true })))).catch(() => {});
    const tick = () => scheduledTick().catch(err => console.error('scheduled backup failed:', err.message));
    setTimeout(tick, Number(process.env.BACKUP_FIRST_DELAY_MS || 2 * 60 * 1000)).unref();
    setInterval(tick, 10 * 60 * 1000).unref();
    console.log(`backups: every ${EVERY_MS / 3600e3}h to ${BACKUP_DIR}`);
  }
  return { start, restoreIfEmpty, createSnapshot, listSnapshots, busy: () => state.busy };
};

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function channelHtml(info, rooms) {
  const when = d => new Date(d).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC';
  const body = rooms.map(r => `<h2>${esc(r.title)}</h2>` + (r.messages.length ? r.messages.map(m =>
    `<div class="m" id="m${m.id}"><div class="h"><b>${esc(m.authorName)}</b>${m.source ? ` <span class="t">from ${esc(m.source)}</span>` : ''} <span class="d">${esc(when(m.at))}${m.editedAt ? ' (edited)' : ''}</span></div>` +
    (m.replyTo ? `<div class="r">reply to <a href="#m${m.replyTo}">a message</a></div>` : '') +
    `<div class="x">${esc(m.kind && m.kind !== 'text' ? `[${m.kind}] ` : '')}${esc(m.text)}</div>` +
    m.attachments.map(a => `<div class="a">📎 <a href="attachments/${a.id}-${esc(String(a.name).replace(/[\\/]/g, '_'))}">${esc(a.name)}</a></div>`).join('') + '</div>'
  ).join('') : '<p class="d">No messages.</p>')).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>#${esc(info.channel)}</title>
<style>body{font:15px/1.45 system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;background:#fff;color:#222}h1{margin-bottom:0}.d{color:#777;font-size:12px}.m{padding:8px 0;border-bottom:1px solid #eee}.x{white-space:pre-wrap;word-wrap:break-word}.r,.a{font-size:13px;color:#555}.t{font-size:11px;background:#eef;padding:1px 5px;border-radius:4px}@media(prefers-color-scheme:dark){body{background:#1d1d22;color:#ddd}.m{border-color:#333}.r,.a{color:#aaa}a{color:#9bf}.t{background:#334}}</style></head>
<body><h1>${esc(info.server || '')} &gt; #${esc(info.channel)}</h1><p class="d">${esc(info.topic)}${info.topic ? ' · ' : ''}Exported ${esc(when(info.exportedAt))}</p>${body}</body></html>`;
}
const TAR_README = `A backup of the chat (database + files).

To restore it on a chat whose backup folder is empty or lost:
  1. Extract this file into the chat's backup folder (BACKUP_DIR), so that
     it contains "snapshots" and "blobs" folders.
  2. In the chat: Settings > Backups > pick this backup > Restore.
     Or, on a brand-new empty database, just start the chat: it restores the
     newest backup it finds by itself.
See BACKUPS.md in the app's code for details.
`;
const MY_DATA_README = username => `Your data from the chat, for ${username}.

account.json   your account and profiles, servers, groups, friends, blocks,
               devices (no passwords or login tokens)
messages.json  every message you sent, grouped by where you sent it
reactions.json the reactions you added
files.json     the files you shared (and which ones aren't included)
files/         the files you shared that are still stored
pictures/      profile pictures, banners and videos you uploaded

Other people's messages aren't included - they're theirs.
`;
module.exports.ZipWriter = ZipWriter;
module.exports.tarHeader = tarHeader;
