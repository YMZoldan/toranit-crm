'use strict';
/*
 * Toranit cable planner — self-hosted backend.
 * Stores the app's JSON documents in PostgreSQL, plan images on a volume,
 * and protects everything behind a password login (signed session cookie).
 *
 * CLI:
 *   node server.js adduser <email> <password|-> [name]   ('-' reads the password from stdin)
 *   node server.js passwd  <email> <new-password>
 *   node server.js deluser <email>
 *   node server.js users
 */
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = +process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || '';
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || 'true') !== 'false';
const COOKIE = 'cp_session';
const SESSION_DAYS = 30;
const MAX_DOC_BYTES = 256 * 1024;
const PUBLIC_DIR = path.join(__dirname, 'public');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/* ---------- database ---------- */
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      pass_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS docs (
      path TEXT PRIMARY KEY,
      collection TEXT NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by INT
    );
    CREATE INDEX IF NOT EXISTS docs_collection_idx ON docs (collection);
    CREATE TABLE IF NOT EXISTS secrets (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sumit_log (
      id SERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      user_id INT,
      endpoint TEXT NOT NULL,
      ok BOOLEAN NOT NULL,
      message TEXT,
      ref TEXT
    );
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      size INT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by INT
    );
  `);
}

/* ---------- passwords & sessions ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1 };
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, SCRYPT);
  return 'scrypt$' + salt.toString('base64') + '$' + h.toString('base64');
}
function checkPw(pw, stored) {
  const [kind, s, h] = String(stored).split('$');
  if (kind !== 'scrypt' || !s || !h) return false;
  const want = Buffer.from(h, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 64, SCRYPT);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function sign(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(tok) {
  if (!tok || typeof tok !== 'string') return null;
  const [body, mac] = tok.split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString());
    return o && o.uid && o.exp > Date.now() ? o : null;
  } catch (e) { return null; }
}
function readCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) {} }
  });
  return out;
}
function cookieAttrs(maxAge) {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` + (COOKIE_SECURE ? '; Secure' : '');
}

/* ---------- app ---------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://fonts.googleapis.com https://fonts.gstatic.com",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; '));
  next();
});

app.get('/healthz', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); }
  catch (e) { res.status(503).json({ ok: false }); }
});

/* auth helpers */
async function auth(req, res, next) {
  const s = verify(readCookies(req)[COOKIE]);
  if (!s) return res.status(401).json({ code: 'unauthenticated', message: 'login required' });
  try {
    const r = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [s.uid]);
    if (!r.rows[0]) return res.status(401).json({ code: 'unauthenticated', message: 'login required' });
    req.user = r.rows[0];
    next();
  } catch (e) { next(e); }
}
/* Custom header check: cross-site pages cannot send it without a CORS preflight, which we never allow. */
function csrf(req, res, next) {
  if (req.get('X-CP') !== '1') return res.status(403).json({ code: 'invalid_argument', message: 'missing header' });
  next();
}

/* login rate limit: 10 failed attempts per IP per 15 minutes */
const attempts = new Map();
function limited(ip) {
  const now = Date.now(), a = attempts.get(ip);
  if (!a || now - a.t > 15 * 60e3) return false;
  return a.n >= 10;
}
function failed(ip) {
  const now = Date.now(), a = attempts.get(ip);
  if (!a || now - a.t > 15 * 60e3) attempts.set(ip, { n: 1, t: now }); else a.n++;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of attempts) if (now - v.t > 15 * 60e3) attempts.delete(k); }, 60e3).unref();

app.post('/api/login', express.json({ limit: '10kb' }), csrf, async (req, res, next) => {
  try {
    const ip = req.ip || '';
    if (limited(ip)) return res.status(429).json({ code: 'rate_limited', message: 'יותר מדי ניסיונות. נסה שוב בעוד רבע שעה.' });
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    const r = await pool.query('SELECT id, pass_hash FROM users WHERE email = $1', [email]);
    const u = r.rows[0];
    if (!u || !checkPw(password, u.pass_hash)) { failed(ip); return res.status(401).json({ code: 'bad_login', message: 'אימייל או סיסמה שגויים.' }); }
    attempts.delete(ip);
    const exp = Date.now() + SESSION_DAYS * 864e5;
    res.setHeader('Set-Cookie', `${COOKIE}=${sign({ uid: u.id, exp })}; ${cookieAttrs(SESSION_DAYS * 86400)}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post('/api/logout', csrf, (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(0)}`);
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => res.json({ id: req.user.id, email: req.user.email, name: req.user.name }));

/* ---------- document store (mirrors the app's db API) ---------- */
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
function parsePath(p, wantDoc) {
  if (typeof p !== 'string' || p.length > 1000) return null;
  const segs = p.split('/');
  if (segs.length > 16 || !segs.every(s => SEG.test(s) && s !== '.' && s !== '..')) return null;
  if (wantDoc !== (segs.length % 2 === 0)) return null;
  return { path: p, collection: segs.slice(0, -1).join('/'), id: segs[segs.length - 1] };
}
const bad = (res, msg) => res.status(400).json({ code: 'invalid_argument', message: msg });
const jsonBody = express.json({ limit: '600kb' });

app.get('/api/doc', auth, async (req, res, next) => {
  try {
    const p = parsePath(req.query.path, true); if (!p) return bad(res, 'bad path');
    const r = await pool.query('SELECT data FROM docs WHERE path = $1', [p.path]);
    res.json({ exists: !!r.rows[0], data: r.rows[0] ? r.rows[0].data : null });
  } catch (e) { next(e); }
});
app.put('/api/doc', auth, csrf, jsonBody, async (req, res, next) => {
  try {
    const p = parsePath(req.body && req.body.path, true); if (!p) return bad(res, 'bad path');
    const data = req.body.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return bad(res, 'body must be an object');
    const txt = JSON.stringify(data);
    if (Buffer.byteLength(txt) > MAX_DOC_BYTES) return bad(res, 'document too large');
    await pool.query(
      `INSERT INTO docs (path, collection, data, updated_at, updated_by) VALUES ($1, $2, $3::jsonb, now(), $4)
       ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [p.path, p.collection, txt, req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.patch('/api/doc', auth, csrf, jsonBody, async (req, res, next) => {
  try {
    const p = parsePath(req.body && req.body.path, true); if (!p) return bad(res, 'bad path');
    const data = req.body.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return bad(res, 'body must be an object');
    const r = await pool.query(
      'UPDATE docs SET data = data || $2::jsonb, updated_at = now(), updated_by = $3 WHERE path = $1',
      [p.path, JSON.stringify(data), req.user.id]);
    if (!r.rowCount) return bad(res, 'document does not exist');
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.delete('/api/doc', auth, csrf, async (req, res, next) => {
  try {
    const p = parsePath(req.query.path, true); if (!p) return bad(res, 'bad path');
    await pool.query('DELETE FROM docs WHERE path = $1', [p.path]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.get('/api/collection', auth, async (req, res, next) => {
  try {
    const p = parsePath(req.query.path, false); if (!p) return bad(res, 'bad path');
    const r = await pool.query('SELECT path, data FROM docs WHERE collection = $1 ORDER BY path LIMIT 5000', [p.path]);
    res.json({ docs: r.rows.map(x => ({ id: x.path.split('/').pop(), data: x.data })) });
  } catch (e) { next(e); }
});

/* ---------- plan images ---------- */
const IMG_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
app.post('/api/uploads', auth, csrf, express.raw({ type: IMG_TYPES, limit: '20mb' }), async (req, res, next) => {
  try {
    const mime = String(req.get('Content-Type') || '').split(';')[0].trim();
    if (!IMG_TYPES.includes(mime) || !Buffer.isBuffer(req.body) || !req.body.length) return bad(res, 'image required');
    const id = crypto.randomBytes(16).toString('hex');
    await fs.promises.writeFile(path.join(UPLOAD_DIR, id), req.body, { flag: 'wx' });
    await pool.query('INSERT INTO uploads (id, mime, size, created_by) VALUES ($1, $2, $3, $4)', [id, mime, req.body.length, req.user.id]);
    res.json({ id });
  } catch (e) { next(e); }
});
app.get('/_blob/:id', auth, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).end();
    const r = await pool.query('SELECT mime FROM uploads WHERE id = $1', [id]);
    if (!r.rows[0]) return res.status(404).end();
    res.setHeader('Content-Type', r.rows[0].mime);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(path.join(UPLOAD_DIR, id));
  } catch (e) { next(e); }
});

/* ---------- price-list inbox (Chrome extension uploads files with an extension key) ---------- */
const EXT_COL = 'data/users/team/extkeys';
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
app.get('/api/extkeys', auth, async (req, res, next) => {
  try { const r = await pool.query('SELECT data FROM docs WHERE collection = $1', [EXT_COL]); res.json(r.rows.map(x => ({ id: x.data.id, label: x.data.label, created: x.data.created, lastUsed: x.data.lastUsed || null }))); } catch (e) { next(e); }
});
app.post('/api/extkeys', auth, csrf, express.json({ limit: '4kb' }), async (req, res, next) => {
  try {
    const id = crypto.randomBytes(8).toString('hex'), key = 'tk_' + crypto.randomBytes(24).toString('hex');
    const data = { id, hash: sha256(key), label: str(req.body && req.body.label, 60) || 'תוסף כרום', created: Date.now(), by: req.user.id };
    await pool.query(`INSERT INTO docs (path, collection, data, updated_at, updated_by) VALUES ($1, $2, $3::jsonb, now(), $4)`, [EXT_COL + '/' + id, EXT_COL, JSON.stringify(data), req.user.id]);
    res.json({ id, key, label: data.label });
  } catch (e) { next(e); }
});
app.delete('/api/extkeys/:id', auth, csrf, async (req, res, next) => {
  try { if (!/^[a-f0-9]{16}$/.test(req.params.id)) return bad(res, 'bad id'); await pool.query('DELETE FROM docs WHERE path = $1', [EXT_COL + '/' + req.params.id]); res.json({ ok: true }); } catch (e) { next(e); }
});
const extHits = new Map();
async function extAuth(req, res, next) {
  const m = /^Bearer\s+(tk_[a-f0-9]{48})$/.exec(String(req.get('Authorization') || ''));
  const ip = req.ip || 'x', now = Date.now(), h = (extHits.get(ip) || []).filter(t => now - t < 60e3); h.push(now); extHits.set(ip, h);
  if (h.length > 60) return res.status(429).json({ code: 'rate_limited', message: 'too many requests' });
  if (!m) return res.status(401).json({ code: 'unauthenticated', message: 'מפתח תוסף חסר או שגוי' });
  try {
    const r = await pool.query("SELECT path, data FROM docs WHERE collection = $1 AND data->>'hash' = $2", [EXT_COL, sha256(m[1])]);
    if (!r.rows[0]) return res.status(401).json({ code: 'unauthenticated', message: 'המפתח בוטל או לא קיים. צור מפתח חדש במסך מחירון.' });
    const d = r.rows[0].data; d.lastUsed = Date.now();
    await pool.query('UPDATE docs SET data = $2::jsonb WHERE path = $1', [r.rows[0].path, JSON.stringify(d)]);
    req.extKey = d; next();
  } catch (e) { next(e); }
}
app.get('/api/ext/ping', extAuth, (req, res) => res.json({ ok: true, label: req.extKey.label }));
const INBOX_EXT = /\.(xlsx|xlsm|xlsb|xls|ods|csv|tsv|pdf|docx|txt)$/i;
app.post('/api/inbox', extAuth, express.raw({ type: () => true, limit: '40mb' }), async (req, res, next) => {
  try {
    const dec = v => { try { return decodeURIComponent(String(v || '')); } catch (e) { return String(v || ''); } };
    const fileName = dec(req.get('X-Filename')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 160), supplier = dec(req.get('X-Supplier')).slice(0, 60), sourceUrl = dec(req.get('X-Source-Url')).slice(0, 300);
    if (!INBOX_EXT.test(fileName)) return bad(res, 'סוג קובץ לא נתמך: ' + fileName);
    if (!Buffer.isBuffer(req.body) || req.body.length < 20) return bad(res, 'הקובץ ריק');
    const head = req.body.slice(0, 200).toString('latin1').toLowerCase();
    if (/<html|<!doctype/.test(head)) return bad(res, 'התקבל דף אינטרנט ולא קובץ. כנראה שהחיבור לפורטל של הספק פג. התחבר מחדש ונסה שוב.');
    const blobId = crypto.randomBytes(16).toString('hex');
    await fs.promises.writeFile(path.join(UPLOAD_DIR, blobId), req.body, { flag: 'wx' });
    await pool.query('INSERT INTO uploads (id, mime, size, created_by) VALUES ($1, $2, $3, $4)', [blobId, 'application/octet-stream', req.body.length, null]);
    const id = 'in' + crypto.randomBytes(6).toString('hex');
    const data = { id, blobId, supplier, fileName, size: req.body.length, at: Date.now(), status: 'new', source: 'extension', sourceUrl, key: req.extKey.label };
    await pool.query(`INSERT INTO docs (path, collection, data, updated_at) VALUES ($1, $2, $3::jsonb, now())`, ['data/users/team/root/plinbox/' + id, 'data/users/team/root/plinbox', JSON.stringify(data)]);
    res.json({ ok: true, id });
  } catch (e) { next(e); }
});

/* ---------- price-list sources: a fixed download link per supplier, fetched every morning ---------- */
const SRC_COL = 'data/users/team/plsources', INBOX_COL = 'data/users/team/root/plinbox';
const dnsLookup = require('dns').promises.lookup;
const isPrivateIp = ip => /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip) || /^(::1|::|fc|fd|fe80:)/i.test(ip) || ip === '::ffff:127.0.0.1';
async function checkPublicUrl(raw) {
  let u; try { u = new URL(String(raw || '').trim()); } catch (e) { throw new SumitError('הקישור לא תקין'); }
  const allowHttp = process.env.PLSOURCE_ALLOW_HTTP === 'true';
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw new SumitError('אפשר רק קישור https');
  if (process.env.PLSOURCE_ALLOW_PRIVATE !== 'true') {
    if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname)) throw new SumitError('כתובת פנימית לא מותרת');
    const addrs = await dnsLookup(u.hostname, { all: true }).catch(() => { throw new SumitError('הכתובת לא נמצאה'); });
    if (addrs.some(a => isPrivateIp(a.address))) throw new SumitError('כתובת פנימית לא מותרת');
  }
  return u;
}
const israelHour = () => +new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false }) % 24;
const israelDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
async function runSource(src) {
  const started = Date.now();
  try {
    const u = await checkPublicUrl(src.url);
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 90e3);
    let r; try { r = await fetch(u.toString(), { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Toranit CRM price list)' } }); } finally { clearTimeout(t); }
    if (!r.ok) throw new Error('הספק החזיר שגיאה ' + r.status);
    if (r.url && r.url !== u.toString()) await checkPublicUrl(r.url);
    const len = +(r.headers.get('content-length') || 0); if (len > 40e6) throw new Error('הקובץ גדול מדי');
    const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 40e6) throw new Error('הקובץ גדול מדי');
    if (buf.length < 20) throw new Error('הקובץ ריק');
    const head = buf.slice(0, 300).toString('latin1').toLowerCase();
    if (/<html|<!doctype/.test(head)) throw new Error('התקבל דף אינטרנט ולא קובץ. ייתכן שהקישור דורש עכשיו כניסה לפורטל.');
    const hash = sha256(buf.toString('base64'));
    if (hash === src.lastHash) { Object.assign(src, { lastRun: Date.now(), lastDay: israelDay(), lastStatus: 'unchanged', lastError: '' }); }
    else {
      const cd = r.headers.get('content-disposition') || '';
      let fileName = ''; const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd); if (m) { try { fileName = decodeURIComponent(m[1]); } catch (e) { fileName = m[1]; } }
      if (!fileName) fileName = decodeURIComponent(u.pathname.split('/').pop() || 'pricelist.xlsx');
      if (!INBOX_EXT.test(fileName)) fileName += /^PK/.test(buf.slice(0, 2).toString('latin1')) ? '.xlsx' : /^%PDF/.test(head) ? '.pdf' : '.csv';
      fileName = fileName.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 160);
      const blobId = crypto.randomBytes(16).toString('hex');
      await fs.promises.writeFile(path.join(UPLOAD_DIR, blobId), buf, { flag: 'wx' });
      await pool.query('INSERT INTO uploads (id, mime, size, created_by) VALUES ($1, $2, $3, $4)', [blobId, 'application/octet-stream', buf.length, null]);
      const id = 'in' + crypto.randomBytes(6).toString('hex');
      const data = { id, blobId, supplier: src.supplier, fileName, size: buf.length, at: Date.now(), status: 'new', source: 'url', sourceId: src.id };
      await pool.query('INSERT INTO docs (path, collection, data, updated_at) VALUES ($1, $2, $3::jsonb, now())', [INBOX_COL + '/' + id, INBOX_COL, JSON.stringify(data)]);
      Object.assign(src, { lastRun: Date.now(), lastDay: israelDay(), lastStatus: 'new', lastError: '', lastHash: hash, lastSize: buf.length });
    }
  } catch (e) {
    Object.assign(src, { lastRun: Date.now(), lastDay: israelDay(), lastStatus: 'error', lastError: (e && e.name === 'AbortError') ? 'הספק לא ענה בזמן' : String((e && e.message) || e).slice(0, 200) });
  }
  src.lastMs = Date.now() - started;
  await pool.query('UPDATE docs SET data = $2::jsonb, updated_at = now() WHERE path = $1', [SRC_COL + '/' + src.id, JSON.stringify(src)]);
  return src;
}
const pubSrc = d => ({ id: d.id, supplier: d.supplier, url: d.url, hour: d.hour, lastRun: d.lastRun || null, lastStatus: d.lastStatus || '', lastError: d.lastError || '', lastSize: d.lastSize || 0 });
app.get('/api/plsources', auth, async (req, res, next) => {
  try { const r = await pool.query('SELECT data FROM docs WHERE collection = $1', [SRC_COL]); res.json(r.rows.map(x => pubSrc(x.data))); } catch (e) { next(e); }
});
app.post('/api/plsources', auth, csrf, express.json({ limit: '8kb' }), async (req, res, next) => {
  try {
    const b = req.body || {}, supplier = str(b.supplier, 60), hour = Math.min(23, Math.max(0, Math.round(+b.hour || 6)));
    if (!supplier) return bad(res, 'חסר שם ספק');
    const u = await checkPublicUrl(b.url);
    const id = /^[a-f0-9]{12}$/.test(b.id || '') ? b.id : crypto.randomBytes(6).toString('hex');
    const old = (await pool.query('SELECT data FROM docs WHERE path = $1', [SRC_COL + '/' + id])).rows[0];
    const data = Object.assign(old ? old.data : { id, created: Date.now() }, { supplier, url: u.toString(), hour });
    await pool.query(`INSERT INTO docs (path, collection, data, updated_at, updated_by) VALUES ($1, $2, $3::jsonb, now(), $4)
      ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now(), updated_by = EXCLUDED.updated_by`, [SRC_COL + '/' + id, SRC_COL, JSON.stringify(data), req.user.id]);
    res.json(pubSrc(data));
  } catch (e) { next(e); }
});
app.delete('/api/plsources/:id', auth, csrf, async (req, res, next) => {
  try { if (!/^[a-f0-9]{12}$/.test(req.params.id)) return bad(res, 'bad id'); await pool.query('DELETE FROM docs WHERE path = $1', [SRC_COL + '/' + req.params.id]); res.json({ ok: true }); } catch (e) { next(e); }
});
app.post('/api/plsources/:id/run', auth, csrf, async (req, res, next) => {
  try {
    if (!/^[a-f0-9]{12}$/.test(req.params.id)) return bad(res, 'bad id');
    const r = await pool.query('SELECT data FROM docs WHERE path = $1', [SRC_COL + '/' + req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ code: 'not_found', message: 'not found' });
    const src = r.rows[0].data; src.lastHash = req.query.force === '1' ? '' : src.lastHash;
    res.json(pubSrc(await runSource(src)));
  } catch (e) { next(e); }
});
async function runDueSources() {
  const r = await pool.query('SELECT data FROM docs WHERE collection = $1', [SRC_COL]);
  const day = israelDay(), hour = israelHour();
  for (const row of r.rows) { const s = row.data; if (s.lastDay !== day && hour >= (s.hour ?? 6)) { const x = await runSource(s); console.log('price list source', s.supplier, x.lastStatus, x.lastError || ''); } }
}

/* ---------- product images: Icecat lookup by brand + manufacturer part number, or an image link ---------- */
const PIMG_COL = 'data/users/team/root/pimages';
const pimgId = key => sha256('pimg:' + String(key).toUpperCase()).slice(0, 24);
async function fetchT(url, ms, opt) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, Object.assign({ signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Toranit CRM)' } }, opt || {})); } finally { clearTimeout(t); }
}
async function saveImageFrom(url, userId) {
  const u = await checkPublicUrl(url);
  const r = await fetchT(u.toString(), 30000);
  if (!r.ok) throw new SumitError('התמונה לא ירדה (' + r.status + ')');
  if (r.url && r.url !== u.toString()) await checkPublicUrl(r.url);
  const mime = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!IMG_TYPES.includes(mime)) throw new SumitError('הקישור לא מוביל לתמונה (jpg, png או webp)');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 200 || buf.length > 8e6) throw new SumitError('גודל התמונה לא תקין');
  const blobId = crypto.randomBytes(16).toString('hex');
  await fs.promises.writeFile(path.join(UPLOAD_DIR, blobId), buf, { flag: 'wx' });
  await pool.query('INSERT INTO uploads (id, mime, size, created_by) VALUES ($1, $2, $3, $4)', [blobId, mime, buf.length, userId || null]);
  return blobId;
}
async function putPimg(key, data, userId) {
  const id = pimgId(key), p = PIMG_COL + '/' + id, full = Object.assign({ id, key: String(key).toUpperCase(), at: Date.now() }, data);
  await pool.query(`INSERT INTO docs (path, collection, data, updated_at, updated_by) VALUES ($1, $2, $3::jsonb, now(), $4)
    ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now(), updated_by = EXCLUDED.updated_by`, [p, PIMG_COL, JSON.stringify(full), userId || null]);
  return full;
}
app.post('/api/productimage', auth, csrf, express.json({ limit: '8kb' }), async (req, res, next) => {
  try {
    const b = req.body || {}, key = str(b.key, 80);
    if (!key) return bad(res, 'חסר מזהה מוצר');
    if (b.url) { const blobId = await saveImageFrom(b.url, req.user.id); return res.json(await putPimg(key, { status: 'ok', src: '/_blob/' + blobId, source: 'url' }, req.user.id)); }
    const user = str(b.icecatUser, 60) || 'openIcecat-live', mpn = str(b.mpn, 60), brand = str(b.brand, 40);
    if (!mpn || !brand) return res.json(await putPimg(key, { status: 'notfound', reason: !brand ? 'לא זוהה יצרן' : 'אין מק"ט יצרן' }, req.user.id));
    const q = (process.env.ICECAT_URL || 'https://live.icecat.biz/api') + '?lang=EN&shopname=' + encodeURIComponent(user) + '&ProductCode=' + encodeURIComponent(mpn) + '&Brand=' + encodeURIComponent(brand) + '&content=';
    let j = null; try { const r = await fetchT(q, 20000, { headers: { 'User-Agent': 'Mozilla/5.0 (Toranit CRM)', Accept: 'application/json' } }); j = await r.json(); } catch (e) {}
    const d = j && j.data;
    const im = (d && d.Image) || {}, gal = (d && Array.isArray(d.Gallery) && d.Gallery[0]) || {};
    const imgUrl = im.Pic500x500 || im.HighPic || im.LowPic || gal.Pic500x500 || gal.Pic || gal.LowPic || '';
    const gi = (d && d.GeneralInfo) || {};
    const title = gi.Title || (gi.TitleInfo && gi.TitleInfo.GeneratedLocalTitle && gi.TitleInfo.GeneratedLocalTitle.Value) || '';
    if (!imgUrl) return res.json(await putPimg(key, { status: 'notfound', reason: (j && (j.Message || j.msg)) ? String(j.Message || j.msg).slice(0, 120) : 'לא נמצא ב-Icecat' }, req.user.id));
    const blobId = await saveImageFrom(imgUrl, req.user.id);
    res.json(await putPimg(key, { status: 'ok', src: '/_blob/' + blobId, source: 'icecat', title: String(title).slice(0, 200), icecatId: (gi.IcecatId || '') + '' }, req.user.id));
  } catch (e) { next(e); }
});

/* ---------- product page lookup (one page, on request, approved shops only) ---------- */
const FETCH_HOSTS = ['gamers-outlet.net'].concat(String(process.env.FETCH_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
const htmlDecode = s => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/\s+/g, ' ').trim();
function parseProductPage(html) {
  let name = '', price = null, currency = '';
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walk);
        if (/product/i.test(String(o['@type'] || ''))) { name = name || o.name || ''; const of = Array.isArray(o.offers) ? o.offers[0] : o.offers; if (of) { price = price ?? (of.price ?? of.lowPrice); currency = currency || of.priceCurrency || ''; } }
        Object.values(o).forEach(walk); };
      walk(JSON.parse(m[1]));
    } catch (e) {}
  }
  const meta = p => { const r = new RegExp('<meta[^>]+(?:property|name|itemprop)=["\']' + p + '["\'][^>]*content=["\']([^"\']*)', 'i').exec(html) || new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name|itemprop)=["\']' + p + '["\']', 'i').exec(html); return r ? htmlDecode(r[1]) : ''; };
  name = name || meta('og:title') || htmlDecode((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1]).replace(/<[^>]+>/g, '') || htmlDecode((/<title>([\s\S]*?)<\/title>/i.exec(html) || [])[1]);
  if (price == null) { const v = meta('product:price:amount') || meta('price') || meta('og:price:amount'); if (v) price = v; currency = currency || meta('product:price:currency') || meta('priceCurrency') || meta('og:price:currency'); }
  if (price == null) { const m = /itemprop=["']price["'][^>]*content=["']([\d.,]+)/i.exec(html); if (m) price = m[1]; }
  if (price == null) { const m = /(€|\$|₪)\s*([\d]+(?:[.,]\d{1,2})?)/.exec(html.replace(/<[^>]+>/g, ' ')); if (m) { price = m[2]; currency = currency || { '€': 'EUR', '$': 'USD', '₪': 'ILS' }[m[1]]; } }
  const num = price == null ? null : Number(String(price).replace(/,(\d{1,2})$/, '.$1').replace(/[^\d.]/g, ''));
  return { name: String(name || '').slice(0, 200), price: Number.isFinite(num) ? num : null, currency: String(currency || '').toUpperCase().slice(0, 3) || (/€/.test(html) ? 'EUR' : '') };
}
app.post('/api/fetchproduct', auth, csrf, express.json({ limit: '4kb' }), async (req, res, next) => {
  try {
    let u; try { u = new URL(String(req.body && req.body.url || '')); } catch (e) { return bad(res, 'קישור לא תקין'); }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (u.protocol !== 'https:' || !FETCH_HOSTS.some(h => host === h || host.endsWith('.' + h))) return bad(res, 'אפשר למשוך רק מאתרים מאושרים: ' + FETCH_HOSTS.join(', '));
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
    let r; try { r = await fetch(u.toString(), { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Toranit CRM product lookup)', 'Accept': 'text/html' } }); } finally { clearTimeout(t); }
    if (!r.ok) return bad(res, 'האתר החזיר שגיאה ' + r.status);
    const html = (await r.text()).slice(0, 3e6);
    const p = parseProductPage(html);
    if (!p.name) return bad(res, 'לא נמצא שם מוצר בעמוד');
    res.json(Object.assign(p, { site: host, url: u.toString() }));
  } catch (e) { if (e && e.name === 'AbortError') return bad(res, 'האתר לא ענה בזמן'); next(e); }
});

/* ---------- SUMIT (accounting) ---------- */
const SUMIT_BASE = (process.env.SUMIT_API_URL || 'https://api.sumit.co.il').replace(/\/+$/, '');
class SumitError extends Error { constructor(msg) { super(msg); this.sumit = true; } }
async function getSumitCreds() {
  const r = await pool.query("SELECT value FROM secrets WHERE key = 'sumit'");
  if (!r.rows[0]) return null;
  try { return JSON.parse(r.rows[0].value); } catch (e) { return null; }
}
async function sumitLog(userId, endpoint, ok, message, ref) {
  try { await pool.query('INSERT INTO sumit_log (user_id, endpoint, ok, message, ref) VALUES ($1, $2, $3, $4, $5)', [userId || null, endpoint, ok, (message || '').slice(0, 1000), (ref || '').slice(0, 200)]); } catch (e) {}
}
async function sumitCall(endpoint, body, user, ref) {
  const creds = await getSumitCreds();
  if (!creds) throw new SumitError('לא הוגדר חיבור לסאמיט. הגדר אותו במסך מחירון.');
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 45000);
  let r;
  try {
    r = await fetch(SUMIT_BASE + endpoint, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Language': 'he' },
      body: JSON.stringify(Object.assign({}, body, { Credentials: { CompanyID: Number(creds.companyId), APIKey: creds.apiKey } }))
    });
  } catch (e) { await sumitLog(user && user.id, endpoint, false, 'network: ' + e.message, ref); throw new SumitError('אין תקשורת עם סאמיט. נסה שוב בעוד רגע.'); }
  finally { clearTimeout(timer); }
  let j;
  try { j = await r.json(); } catch (e) { await sumitLog(user && user.id, endpoint, false, 'bad json http ' + r.status, ref); throw new SumitError('תשובה לא תקינה מסאמיט (HTTP ' + r.status + ').'); }
  const st = j.Status, statusOk = st === 0 || st === '0' || (typeof st === 'string' && /^success/i.test(st)) || (st === undefined && r.ok);
  if (!statusOk || j.UserErrorMessage) {
    const msg = j.UserErrorMessage || j.TechnicalErrorDetails || ('סאמיט החזירה שגיאה (' + String(j.Status) + ').');
    await sumitLog(user && user.id, endpoint, false, msg + (j.TechnicalErrorDetails && j.TechnicalErrorDetails !== msg ? ' | ' + j.TechnicalErrorDetails : ''), ref);
    throw new SumitError(msg);
  }
  const data = j.Data || {};
  await sumitLog(user && user.id, endpoint, true, data.DocumentNumber != null ? 'doc ' + data.DocumentNumber : '', ref);
  return data;
}
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const r2 = v => Math.round(Number(v) * 100) / 100;
function numIn(v, min, max) { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; }
function sumitCustomer(c) {
  return {
    ID: c.sumitId != null && c.sumitId !== '' ? (Number.isFinite(Number(c.sumitId)) ? Number(c.sumitId) : c.sumitId) : null,
    ExternalIdentifier: str(c.id, 100) || null,
    Name: str(c.name, 200), Phone: str(c.phone, 50) || null, EmailAddress: str(c.email, 200) || null,
    City: str(c.city, 100) || null, Address: str(c.address, 300) || null, ZipCode: str(c.zip, 20) || null,
    CompanyNumber: str(c.companyNumber, 30) || null, NoVAT: null, SearchMode: null, Folder: null, Properties: null
  };
}
const PAY_DETAILS = { cash: 1, transfer: 1, cheque: 1, credit: 1, other: 1 };
function sumitPayment(p) {
  const ref = str(p.ref, 60) || null;
  if (p.method === 'cash') return { Amount: r2(p.amount), Type: 2, Details_Cash: {} };
  if (p.method === 'transfer') return { Amount: r2(p.amount), Type: 3, Details_BankTransfer: { Reference: ref } };
  if (p.method === 'cheque') return { Amount: r2(p.amount), Type: 4, Details_Cheque: { ChequeNumber: ref } };
  if (p.method === 'credit') return { Amount: r2(p.amount), Type: 5, Details_CreditCard: { Last4Digits: /^\d{4}$/.test(String(p.last4 || '')) ? String(p.last4) : null, Payments: numIn(p.installments, 1, 36) || 1 } };
  return { Amount: r2(p.amount), Type: 6, Details_Digital: { Type: 'Other', Description: ref || 'תשלום דיגיטלי' } };
}
const KINDS = ['quote', 'payreq', 'receipt', 'invrec', 'invoice'];
const SUMIT_TYPE_NUM = { Invoice: 0, InvoiceAndReceipt: 1, Receipt: 2, ProformaInvoice: 3, DonationReceipt: 4, CreditInvoice: 5, CreditInvoiceAndReceipt: 6, CreditReceipt: 7, Order: 8, DeliveryNote: 9, GoodsReturnNote: 10, PurchasingOrder: 11, PriceQuotation: 12, PaymentRequest: 13 };
const TYPE_KIND = { 0: 'invoice', 1: 'invrec', 2: 'receipt', 12: 'quote', 13: 'payreq' };
function enumNum(v, names) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).trim();
  const m = /\((-?\d+)\)\s*$/.exec(s); if (m) return +m[1];
  if (/^-?\d+$/.test(s)) return +s;
  if (names && names[s] != null) return names[s];
  return null;
}

app.get('/api/sumit/status', auth, async (req, res, next) => {
  try {
    const c = await getSumitCreds();
    res.json({ configured: !!c, companyId: c ? c.companyId : null, keyHint: c ? '…' + String(c.apiKey).slice(-4) : null });
  } catch (e) { next(e); }
});
app.put('/api/sumit/credentials', auth, csrf, express.json({ limit: '10kb' }), async (req, res, next) => {
  try {
    const companyId = str(req.body && req.body.companyId, 20), apiKey = str(req.body && req.body.apiKey, 500);
    if (!companyId && !apiKey) { await pool.query("DELETE FROM secrets WHERE key = 'sumit'"); return res.json({ ok: true, configured: false }); }
    if (!/^\d{3,12}$/.test(companyId)) return bad(res, 'מספר החברה צריך להכיל ספרות בלבד.');
    let key = apiKey;
    if (!key) { const cur = await getSumitCreds(); if (!cur) return bad(res, 'חסר מפתח API.'); key = cur.apiKey; }
    if (key.length < 10) return bad(res, 'מפתח ה־API קצר מדי.');
    await pool.query(`INSERT INTO secrets (key, value, updated_at) VALUES ('sumit', $1, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify({ companyId, apiKey: key })]);
    res.json({ ok: true, configured: true });
  } catch (e) { next(e); }
});
app.post('/api/sumit/test', auth, csrf, async (req, res, next) => {
  try {
    const d = await sumitCall('/accounting/general/getvatrate/', { Date: new Date().toISOString() }, req.user, 'test');
    const vat = d.VATRate != null ? d.VATRate : d.Rate != null ? d.Rate : d.VAT != null ? d.VAT : null;
    res.json({ ok: true, vat });
  } catch (e) { next(e); }
});
let docTypesCache = null;
app.get('/api/sumit/doctypes', auth, async (req, res, next) => {
  try {
    if (docTypesCache && Date.now() - docTypesCache.t < 12 * 3600e3) return res.json(docTypesCache.v);
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 45000);
    let sw;
    try { const r = await fetch(SUMIT_BASE + '/swagger/v1/swagger.json', { signal: ctl.signal }); sw = await r.json(); }
    catch (e) { throw new SumitError('לא הצלחתי לקרוא את הגדרות ה־API של סאמיט.'); }
    finally { clearTimeout(timer); }
    const S = (sw.components && sw.components.schemas) || {};
    const deref = s => { for (let g = 0; s && g < 12; g++) {
      if (s.$ref) s = S[s.$ref.split('/').pop()];
      else if (s.allOf && s.allOf.length) s = s.allOf.find(x => x.$ref) || s.allOf[0];
      else if (s.oneOf && s.oneOf.length) s = s.oneOf.find(x => x.$ref) || s.oneOf[0];
      else if (s.anyOf && s.anyOf.length) s = s.anyOf.find(x => x.$ref) || s.anyOf[0];
      else break; } return s || {}; };
    const reqS = deref(S.Accounting_Documents_Create_Request || {});
    const det = deref((reqS.properties || {}).Details);
    const typeProp = (det.properties || {}).Type || {};
    const t = deref(typeProp);
    const vals = Array.isArray(t.enum) ? t.enum : [];
    const names = t['x-enumNames'] || t['x-enum-varnames'] || (t['x-ms-enum'] && t['x-ms-enum'].values && t['x-ms-enum'].values.map(v => v.name)) || [];
    const descs = t['x-enumDescriptions'] || t['x-enum-descriptions'] || [];
    const fromDesc = {};
    String(t.description || typeProp.description || '').split(/\n|<br\s*\/?>|<li>|;/).forEach(line => {
      const m = /(-?\d+)\s*(?:=|-|:|–)\s*([^\n<]+)/.exec(line.replace(/<[^>]+>/g, ' '));
      if (m) fromDesc[m[1]] = m[2].trim();
    });
    const types = vals.map((v, i) => {
      const m = typeof v === 'string' ? /^(.*?)\s*\((-?\d+)\)\s*$/.exec(v) : null;
      if (m) return { value: +m[2], name: m[1] };
      return { value: v, name: names[i] || descs[i] || fromDesc[String(v)] || (typeof v === 'string' ? v : '') };
    });
    const v = { types, rawDescription: String(t.description || typeProp.description || '').slice(0, 4000) };
    docTypesCache = { t: Date.now(), v };
    res.json(v);
  } catch (e) { next(e); }
});
app.post('/api/sumit/customer', auth, csrf, express.json({ limit: '50kb' }), async (req, res, next) => {
  try {
    const c = (req.body && req.body.customer) || {};
    if (!str(c.name, 200)) return bad(res, 'חסר שם לקוח.');
    const upd = c.sumitId != null && c.sumitId !== '';
    const d = await sumitCall(upd ? '/accounting/customers/update/' : '/accounting/customers/create/', { Details: sumitCustomer(c) }, req.user, 'customer ' + str(c.name, 80));
    const id = d.CustomerID != null ? d.CustomerID : d.ID != null ? d.ID : d.EntityID != null ? d.EntityID : (upd ? c.sumitId : null);
    res.json({ sumitId: id });
  } catch (e) { next(e); }
});
app.post('/api/sumit/document', auth, csrf, express.json({ limit: '300kb' }), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!KINDS.includes(b.kind)) return bad(res, 'סוג מסמך לא מוכר.');
    if (b.type === null || b.type === undefined || b.type === '' || (typeof b.type !== 'number' && typeof b.type !== 'string')) return bad(res, 'לא הוגדר סוג המסמך בסאמיט.');
    const typeNum = enumNum(b.type, SUMIT_TYPE_NUM);
    if (typeNum === null) return bad(res, 'סוג המסמך לא מוכר בסאמיט. טען מחדש את סוגי המסמכים במסך מחירון.');
    const cu = b.customer || {};
    if (!str(cu.name, 200)) return bad(res, 'חסר שם לקוח.');
    const items = Array.isArray(b.items) ? b.items.slice(0, 200) : [];
    const pays = Array.isArray(b.payments) ? b.payments.slice(0, 30) : [];
    for (const i of items) if (!str(i.name, 300) || numIn(i.qty, 0.0001, 1e7) === null || numIn(i.price, -1e9, 1e9) === null) return bad(res, 'יש שורה לא תקינה במסמך.');
    for (const p of pays) if (numIn(p.amount, 0.01, 1e9) === null || !PAY_DETAILS[p.method]) return bad(res, 'יש תשלום לא תקין במסמך.');
    if ((b.kind === 'receipt' || b.kind === 'invrec') && !pays.length) return bad(res, 'חסרים פרטי תשלום.');
    if (b.kind !== 'receipt' && !items.length) return bad(res, 'חסרות שורות במסמך.');
    const email = str(b.email, 200);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 'כתובת אימייל לא תקינה.');
    const refs = pays.map(p => str(p.ref, 60)).filter(Boolean);
    const Details = {
      IsDraft: !!b.draft, Date: null, Customer: sumitCustomer(cu), Type: typeNum, Language: null, Currency: null,
      Description: str(b.description, 500) || null, ExternalReference: str(b.externalRef, 100) || null,
      SendByEmail: email ? { EmailAddress: email, Original: true, SendAsPaymentRequest: b.kind === 'payreq' } : null,
      DueDate: (b.kind === 'payreq' || b.kind === 'invoice') && /^\d{4}-\d{2}-\d{2}$/.test(b.dueDate || '') ? b.dueDate + 'T00:00:00' : null,
      ClosingText: refs.length ? 'אסמכתא: ' + refs.join(', ') : null
    };
    const body = {
      Details,
      Items: items.map(i => ({ Quantity: Number(i.qty), UnitPrice: r2(i.price), TotalPrice: r2(Number(i.qty) * Number(i.price)), Item: { Name: str(i.name, 300), SearchMode: 0 }, Description: null })),
      Payments: pays.map(sumitPayment),
      VATIncluded: false
    };
    const d = await sumitCall('/accounting/documents/create/', body, req.user, b.kind + ' ' + str(cu.name, 80));
    res.json({
      id: d.DocumentID != null ? d.DocumentID : d.EntityID != null ? d.EntityID : null,
      number: d.DocumentNumber != null ? d.DocumentNumber : null,
      url: d.DocumentDownloadURL || d.DownloadURL || null,
      customerId: d.CustomerID != null ? d.CustomerID : null
    });
  } catch (e) { next(e); }
});

/* ---------- SUMIT -> app sync (documents, payment status, customers) ---------- */
const ROOT = 'data/users/team/root';
const SYNC_DOC = 'data/users/team/sumitsync';
let syncRunning = null;
async function readCollection(col) {
  const r = await pool.query('SELECT path, data FROM docs WHERE collection = $1', [col]);
  const out = {}; r.rows.forEach(x => { out[x.path.split('/').pop()] = x.data; }); return out;
}
async function writeDoc(path, data, userId) {
  const i = path.lastIndexOf('/');
  await pool.query(`INSERT INTO docs (path, collection, data, updated_at, updated_by) VALUES ($1, $2, $3::jsonb, now(), $4)
    ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now(), updated_by = EXCLUDED.updated_by`, [path, path.slice(0, i), JSON.stringify(data), userId || null]);
}
const isoDay = d => new Date(d).toISOString().slice(0, 10) + 'T00:00:00';
const normName = s => String(s || '').replace(/["'״׳`]/g, '').replace(/בע"?מ|בעמ|ltd\.?/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();
async function syncFromSumit(user, days) {
  if (syncRunning) return syncRunning;
  syncRunning = (async () => {
    const started = Date.now();
    const from = isoDay(Date.now() - Math.max(7, Math.min(3650, days || 365)) * 864e5), to = isoDay(Date.now() + 864e5);
    const list = [];
    for (let page = 0, start = 0, more = true; more && page < 200; page++) {
      const d = await sumitCall('/accounting/documents/list/', { DocumentTypes: [0, 1, 2, 12, 13], DateFrom: from, DateTo: to, IncludeDrafts: false, Paging: { StartIndex: start, PageSize: 100 } }, user, 'sync list ' + start);
      const got = d.Documents || [];
      got.forEach(x => list.push(x));
      start += got.length;
      more = !!d.HasNextPage && got.length > 0;
    }
    const customers = await readCollection(ROOT + '/customers');
    const documents = await readCollection(ROOT + '/documents');
    const bySumitCust = {}, byName = {};
    Object.values(customers).forEach(c => { if (c.sumitId != null && c.sumitId !== '') bySumitCust[String(c.sumitId)] = c; const n = normName(c.name); if (n && !byName[n]) byName[n] = c; });
    const bySumitDoc = {}, byId = {};
    Object.values(documents).forEach(d => { if (d.sumitId != null) bySumitDoc[String(d.sumitId)] = d; byId[d.id] = d; });
    const stats = { found: list.length, newDocs: 0, updatedDocs: 0, closed: 0, newCustomers: 0, linkedCustomers: 0 };
    for (const x of list) {
      const t = enumNum(x.Type, SUMIT_TYPE_NUM), kind = TYPE_KIND[t];
      if (!kind || x.IsDraft) continue;
      const cid = x.CustomerID != null ? String(x.CustomerID) : '';
      let cust = cid ? bySumitCust[cid] : null;
      if (!cust && x.CustomerName) {
        const hit = byName[normName(x.CustomerName)];
        if (hit && (hit.sumitId == null || hit.sumitId === '')) { cust = hit; cust.sumitId = x.CustomerID; cust.updated = Date.now(); bySumitCust[cid] = cust; await writeDoc(ROOT + '/customers/' + cust.id, cust, user && user.id); stats.linkedCustomers++; }
      }
      if (!cust && (cid || x.CustomerName)) {
        cust = { id: 'c' + crypto.randomBytes(6).toString('hex'), name: String(x.CustomerName || ('לקוח ' + cid)).slice(0, 200), companyNumber: '', contact: '', phone: '', email: '', city: '', address: '', zip: '', notes: '',
          sumitId: x.CustomerID != null ? x.CustomerID : null, source: 'sumit', created: Date.now(), updated: Date.now() };
        if (cid) bySumitCust[cid] = cust; byName[normName(cust.name)] = cust;
        await writeDoc(ROOT + '/customers/' + cust.id, cust, user && user.id); stats.newCustomers++;
      }
      const total = Math.round(Number(x.DocumentValue || 0) * 100) / 100;
      const created = x.Date ? Date.parse(x.Date) || Date.now() : Date.now();
      const due = x.DueDate ? String(x.DueDate).slice(0, 10) : '';
      let d = bySumitDoc[String(x.DocumentID)] || (x.ExternalReference && byId[x.ExternalReference]) || null;
      const isNew = !d;
      if (!d) d = { id: 'sd' + x.DocumentID, kind, customerId: cust ? cust.id : null, projectId: null, projectName: String(x.Description || '').slice(0, 120), items: [], payments: [], paid: 0, payLog: [], source: 'sumit', created, emailed: false };
      const snap = o => JSON.stringify(Object.assign({}, o, { sumitSynced: 0 }));
      const before = snap(d);
      Object.assign(d, { kind, sumitId: x.DocumentID, number: x.DocumentNumber != null ? x.DocumentNumber : d.number, url: x.DocumentDownloadURL || d.url || '', payUrl: x.DocumentPaymentURL || d.payUrl || '',
        total: total || d.total || 0, draft: false, dueDate: due || d.dueDate || '', customerId: d.customerId || (cust ? cust.id : null), sumitClosed: !!x.IsClosed, sumitSynced: Date.now() });
      if (!d.created) d.created = created;
      if ((kind === 'payreq' || kind === 'invoice')) {
        if (x.IsClosed) { if ((+d.paid || 0) < d.total - 0.05) { d.payLog = d.payLog || []; d.payLog.push({ amount: Math.round((d.total - (+d.paid || 0)) * 100) / 100, at: Date.now(), method: '', ref: 'נסגר בסאמיט', sumit: true }); d.paid = d.total; stats.closed++; } d.status = 'paid'; }
        else d.status = (+d.paid || 0) > 0.05 ? 'partial' : 'open';
      }
      if (isNew || snap(d) !== before) { await writeDoc(ROOT + '/documents/' + d.id, d, user && user.id); if (isNew) stats.newDocs++; else stats.updatedDocs++; bySumitDoc[String(x.DocumentID)] = d; }
    }
    const result = { at: Date.now(), ms: Date.now() - started, days: days || 365, ok: true, stats };
    await writeDoc(SYNC_DOC, result, user && user.id);
    return result;
  })().catch(async e => {
    const result = { at: Date.now(), ok: false, error: (e && e.message) || 'sync failed' };
    try { await writeDoc(SYNC_DOC, result, user && user.id); } catch (_) {}
    throw e;
  }).finally(() => { syncRunning = null; });
  return syncRunning;
}
/* ---------- SUMIT customers (CRM folder) -> app customers ---------- */
const SYNC_CUST_DOC = 'data/users/team/sumitsynccust';
let custSyncRunning = null;
const firstVal = v => {
  if (v == null) return '';
  if (Array.isArray(v)) { for (const x of v) { const y = firstVal(x); if (y !== '') return y; } return ''; }
  if (typeof v === 'object') return firstVal(v.Name ?? v.Value ?? v.Title ?? v.Text ?? v.ID ?? Object.values(v)[0]);
  return String(v).trim();
};
const PROP_MAP = [
  ['name', /(^|_)(full)?name$|fullname|customername|^שם|title$/i],
  ['companyNumber', /companynumber|company_number|idnumber|taxid|vatid|ח\.?פ|ע\.?מ|תעודת זהות|identifier$/i],
  ['email', /e-?mail/i], ['phone', /phone|mobile|טלפון|נייד/i], ['city', /city|עיר|ישוב/i],
  ['address', /address|street|כתובת|רחוב/i], ['zip', /zip|postal|מיקוד/i], ['contact', /contact|איש קשר/i]];
function mapCustomerProps(props) {
  const out = {}; const keys = Object.keys(props || {});
  for (const [field, re] of PROP_MAP) {
    const k = keys.find(k => re.test(k) && !(field === 'name' && /(contact|city|folder|user|owner|file|status)/i.test(k)) && !(field === 'address' && /mail/i.test(k)) && !(field === 'phone' && /fax/i.test(k)));
    if (k) { const v = firstVal(props[k]); if (v) out[field] = v.slice(0, 200); }
  }
  return out;
}
const digits = s => String(s || '').replace(/\D/g, '');
async function syncCustomersFromSumit(user, folderHint) {
  if (custSyncRunning) return custSyncRunning;
  custSyncRunning = (async () => {
    const started = Date.now();
    const fl = await sumitCall('/crm/schema/listfolders/', { NameFilter: null }, user, 'cust folders');
    const folders = (fl.Folders || []).map(f => ({ id: f.ID, name: String(f.Name || '') }));
    const hint = String(folderHint || '').trim();
    const folder = (hint && folders.find(f => String(f.id) === hint || f.name === hint))
      || folders.find(f => /^לקוחות$/.test(f.name.trim())) || folders.find(f => /^customers?$/i.test(f.name.trim()))
      || folders.find(f => /לקוח|customer|client/i.test(f.name));
    if (!folder) throw new SumitError('לא נמצאה תיקיית לקוחות בסאמיט. התיקיות שנמצאו: ' + (folders.map(f => f.name).join(', ') || 'אין'));
    const fetchAll = async folderParam => {
      const ents = [];
      for (let page = 0, start = 0, more = true; more && page < 300; page++) {
        const d = await sumitCall('/crm/data/listentities/', { Folder: folderParam, IncludeInheritedFolders: false, Filters: [], Order: null, Paging: { StartIndex: start, PageSize: 100 }, LoadProperties: true }, user, 'cust list ' + start);
        const got = d.Entities || []; got.forEach(x => ents.push(x)); start += got.length; more = !!d.HasNextPage && got.length > 0;
      }
      return ents;
    };
    let ents;
    try { ents = await fetchAll(String(folder.id)); } catch (e) { ents = await fetchAll(folder.name); }
    const customers = await readCollection(ROOT + '/customers');
    const idx = { sumit: {}, cn: {}, email: {}, phone: {}, name: {} };
    const index = c => {
      if (c.sumitId != null && c.sumitId !== '') idx.sumit[String(c.sumitId)] = c;
      if (digits(c.companyNumber).length >= 5) idx.cn[digits(c.companyNumber)] = c;
      if (c.email) idx.email[String(c.email).toLowerCase().trim()] = c;
      if (digits(c.phone).length >= 9) idx.phone[digits(c.phone).slice(-9)] = c;
      const n = normName(c.name); if (n) idx.name[n] = c;
    };
    Object.values(customers).forEach(index);
    const stats = { found: ents.length, newCustomers: 0, updated: 0, linked: 0, unchanged: 0, folder: folder.name, sampleKeys: [] };
    if (ents[0]) stats.sampleKeys = Object.keys(ents[0].Properties || {}).slice(0, 40);
    let mappedNames = 0;
    for (const en of ents) {
      const m = mapCustomerProps(en.Properties);
      if (m.name) mappedNames++;
      const sid = en.ID != null ? String(en.ID) : '';
      let c = (sid && idx.sumit[sid]) || (digits(m.companyNumber).length >= 5 && idx.cn[digits(m.companyNumber)]) || (m.email && idx.email[m.email.toLowerCase()]) || (digits(m.phone).length >= 9 && idx.phone[digits(m.phone).slice(-9)]) || (m.name && idx.name[normName(m.name)]) || null;
      if (c && c.sumitId != null && c.sumitId !== '' && sid && String(c.sumitId) !== sid) c = null;
      if (!c) {
        if (!m.name) continue;
        c = { id: 'c' + crypto.randomBytes(6).toString('hex'), name: m.name, companyNumber: m.companyNumber || '', contact: m.contact || '', phone: m.phone || '', email: m.email || '', city: m.city || '', address: m.address || '', zip: m.zip || '', notes: '', sumitId: en.ID, source: 'sumit', created: Date.now(), updated: Date.now() };
        await writeDoc(ROOT + '/customers/' + c.id, c, user && user.id); index(c); stats.newCustomers++; continue;
      }
      const before = JSON.stringify(c);
      const wasLinked = c.sumitId != null && c.sumitId !== '';
      if (!wasLinked && sid) c.sumitId = en.ID;
      for (const f of ['name', 'companyNumber', 'phone', 'email', 'city', 'address', 'zip', 'contact']) if (m[f] && m[f] !== c[f]) c[f] = m[f];
      if (JSON.stringify(c) !== before) { c.updated = Date.now(); await writeDoc(ROOT + '/customers/' + c.id, c, user && user.id); index(c); if (!wasLinked) stats.linked++; else stats.updated++; }
      else stats.unchanged++;
    }
    stats.mappedNames = mappedNames;
    const result = { at: Date.now(), ms: Date.now() - started, ok: true, stats, folders };
    await writeDoc(SYNC_CUST_DOC, result, user && user.id);
    return result;
  })().catch(async e => {
    try { await writeDoc(SYNC_CUST_DOC, { at: Date.now(), ok: false, error: (e && e.message) || 'sync failed' }, user && user.id); } catch (_) {}
    throw e;
  }).finally(() => { custSyncRunning = null; });
  return custSyncRunning;
}
app.post('/api/sumit/synccustomers', auth, csrf, express.json({ limit: '10kb' }), async (req, res, next) => {
  try { res.json(await syncCustomersFromSumit(req.user, req.body && req.body.folder)); } catch (e) { next(e); }
});
app.get('/api/sumit/synccuststatus', auth, async (req, res, next) => {
  try { const r = await pool.query('SELECT data FROM docs WHERE path = $1', [SYNC_CUST_DOC]); res.json(r.rows[0] ? r.rows[0].data : null); } catch (e) { next(e); }
});
app.post('/api/sumit/sync', auth, csrf, express.json({ limit: '10kb' }), async (req, res, next) => {
  try { const days = numIn(req.body && req.body.days, 7, 3650) || 365; res.json(await syncFromSumit(req.user, days)); } catch (e) { next(e); }
});
app.get('/api/sumit/syncstatus', auth, async (req, res, next) => {
  try { const r = await pool.query('SELECT data FROM docs WHERE path = $1', [SYNC_DOC]); res.json(r.rows[0] ? r.rows[0].data : null); } catch (e) { next(e); }
});

/* ---------- static app ---------- */
const noCache = res => res.setHeader('Cache-Control', 'no-cache');
app.get(['/', '/index.html'], (req, res) => { noCache(res); res.sendFile(path.join(PUBLIC_DIR, 'index.html')); });
app.get('/sw.js', (req, res) => { noCache(res); res.setHeader('Service-Worker-Allowed', '/'); res.sendFile(path.join(PUBLIC_DIR, 'sw.js')); });
app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));
app.use('/api', (req, res) => res.status(404).json({ code: 'invalid_argument', message: 'not found' }));

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ code: 'invalid_argument', message: 'too large' });
  if (err && err.type === 'entity.parse.failed') return bad(res, 'bad json');
  if (err && err.sumit) return res.status(400).json({ code: 'sumit', message: err.message });
  console.error(err);
  res.status(500).json({ code: 'unavailable', message: 'server error' });
});

/* ---------- CLI & startup ---------- */
function readStdin() {
  return new Promise((resolve, reject) => {
    let d = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', x => { d += x; }); process.stdin.on('end', () => resolve(d.replace(/\r?\n$/, ''))); process.stdin.on('error', reject);
  });
}
async function cli(args) {
  const [cmd, a, b0, c] = args;
  const b = b0 === '-' ? await readStdin() : b0;  /* '-' = read the password from stdin */
  await migrate();
  if (cmd === 'adduser') {
    if (!a || !b) throw new Error('usage: adduser <email> <password> [name]');
    if (b.length < 8) throw new Error('password must be at least 8 characters');
    await pool.query('INSERT INTO users (email, pass_hash, name) VALUES ($1, $2, $3)', [a.trim().toLowerCase(), hashPw(b), c || '']);
    console.log('user added:', a);
  } else if (cmd === 'passwd') {
    if (!a || !b) throw new Error('usage: passwd <email> <new-password>');
    if (b.length < 8) throw new Error('password must be at least 8 characters');
    const r = await pool.query('UPDATE users SET pass_hash = $2 WHERE email = $1', [a.trim().toLowerCase(), hashPw(b)]);
    console.log(r.rowCount ? 'password changed' : 'no such user');
  } else if (cmd === 'deluser') {
    const r = await pool.query('DELETE FROM users WHERE email = $1', [String(a || '').trim().toLowerCase()]);
    console.log(r.rowCount ? 'user deleted' : 'no such user');
  } else if (cmd === 'users') {
    const r = await pool.query('SELECT email, name, created_at FROM users ORDER BY id');
    r.rows.forEach(u => console.log(u.email, u.name ? '(' + u.name + ')' : '', u.created_at.toISOString().slice(0, 10)));
  } else {
    throw new Error('unknown command: ' + cmd);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length) {
    try { await cli(args); } catch (e) { console.error(e.message); process.exitCode = 1; }
    await pool.end();
    return;
  }
  if (SECRET.length < 32) { console.error('SESSION_SECRET must be set and at least 32 characters long'); process.exit(1); }
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  for (let i = 1; ; i++) {
    try { await migrate(); break; }
    catch (e) { if (i >= 20) throw e; console.log('waiting for database...'); await new Promise(r => setTimeout(r, 2000)); }
  }
  const n = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  if (!n && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    await pool.query('INSERT INTO users (email, pass_hash, name) VALUES ($1, $2, $3)',
      [process.env.ADMIN_EMAIL.trim().toLowerCase(), hashPw(process.env.ADMIN_PASSWORD), 'admin']);
    console.log('created first user:', process.env.ADMIN_EMAIL);
  } else if (!n) {
    console.log('no users yet: run  docker compose exec app node server.js adduser <email> <password>');
  }
  const server = app.listen(PORT, () => console.log('listening on', PORT));
  const autoSync = async () => { try { if (await getSumitCreds()) { try { const c = await syncCustomersFromSumit(null); console.log('sumit customers sync:', JSON.stringify(Object.assign({}, c.stats, { sampleKeys: undefined }))); } catch (e) { console.log('sumit customers sync failed:', e.message); } const r = await syncFromSumit(null, 120); console.log('sumit sync:', JSON.stringify(r.stats)); } } catch (e) { console.log('sumit sync failed:', e.message); } };
  if (process.env.SUMIT_AUTO_SYNC !== 'false') { setTimeout(autoSync, 90e3).unref(); setInterval(autoSync, 60 * 60e3).unref(); }
  const srcTick = () => runDueSources().catch(e => console.log('price list sources failed:', e.message));
  setTimeout(srcTick, 60e3).unref(); setInterval(srcTick, 15 * 60e3).unref();
  const stop = () => { server.close(() => pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main().catch(e => { console.error(e); process.exit(1); });
