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
  const statusOk = j.Status === 0 || j.Status === '0' || j.Status === 'Success' || (j.Status === undefined && r.ok);
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
const PAY_DETAILS = { cash: 'Details_Cash', transfer: 'Details_BankTransfer', cheque: 'Details_Cheque', credit: 'Details_CreditCard', other: 'Details_Other' };
function sumitPayment(p) {
  const o = { Amount: r2(p.amount) };
  o[PAY_DETAILS[p.method]] = p.method === 'credit'
    ? { Last4Digits: /^\d{4}$/.test(String(p.last4 || '')) ? String(p.last4) : null, Payments: numIn(p.installments, 1, 36) || 1 }
    : {};
  return o;
}
const KINDS = ['quote', 'payreq', 'receipt', 'invrec', 'invoice'];

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
    const types = vals.map((v, i) => ({ value: v, name: names[i] || descs[i] || fromDesc[String(v)] || (typeof v === 'string' ? v : '') }));
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
      IsDraft: !!b.draft, Date: null, Customer: sumitCustomer(cu), Type: b.type, Language: null, Currency: null,
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
  const stop = () => { server.close(() => pool.end().then(() => process.exit(0))); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main().catch(e => { console.error(e); process.exit(1); });
