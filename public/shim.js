/*
 * Self-hosted bridge: provides the same `window.claude.use(...)` API the app
 * was built on, backed by this server's REST API, plus login and PWA setup.
 */
(() => {
  'use strict';
  const HDR = { 'X-CP': '1' };
  let loginP = null, authP = null;

  async function api(method, url, body, rawType) {
    const headers = Object.assign({}, HDR);
    let payload;
    if (rawType) { headers['Content-Type'] = rawType; payload = body; }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    let r;
    try { r = await fetch(url, { method, credentials: 'same-origin', headers, body: payload }); }
    catch (e) { throw { code: 'unavailable', message: 'network' }; }
    if (r.status === 401) { authP = null; showLogin(); throw { code: 'unavailable', message: 'auth' }; }
    if (!r.ok) {
      let j = {}; try { j = await r.json(); } catch (e) {}
      throw { code: j.code || (r.status >= 500 ? 'unavailable' : 'invalid_argument'), message: j.message || r.statusText };
    }
    return r.json();
  }

  /* ---------- overlays: login and no-connection ---------- */
  function overlay(html) {
    let o = document.getElementById('cpGate');
    if (!o) {
      o = document.createElement('div'); o.id = 'cpGate';
      o.style.cssText = 'position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:var(--bg,#e9ecea);font-family:Rubik,Arial,sans-serif;direction:rtl;padding:20px';
      document.body.appendChild(o);
    }
    o.innerHTML = '<div style="background:var(--panel,#fff);color:var(--ink,#1f2a2e);border:1px solid var(--line,#cfd6d3);border-radius:12px;padding:26px 24px;width:100%;max-width:360px;box-shadow:0 8px 30px rgba(0,0,0,.08)">' + html + '</div>';
    return o;
  }
  function closeOverlay() { const o = document.getElementById('cpGate'); if (o) o.remove(); }
  function whenBody() { return document.body ? Promise.resolve() : new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true })); }

  function showLogin() {
    if (loginP) return loginP;
    loginP = whenBody().then(() => new Promise(resolve => {
      const o = overlay(
        '<h1 style="font-size:21px;margin:0 0 4px">מתכנן כבילה</h1>' +
        '<p style="margin:0 0 16px;color:var(--muted,#62706f);font-size:14px">כניסה למערכת</p>' +
        '<form id="cpLogin" style="display:flex;flex-direction:column;gap:10px">' +
        '<label style="display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted,#62706f)">אימייל<input name="email" type="email" autocomplete="username" required style="font:inherit;font-size:15px;padding:8px 10px;border:1px solid var(--line,#cfd6d3);border-radius:7px;background:var(--btn,#fff);color:var(--ink,#1f2a2e);direction:ltr"></label>' +
        '<label style="display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted,#62706f)">סיסמה<input name="password" type="password" autocomplete="current-password" required style="font:inherit;font-size:15px;padding:8px 10px;border:1px solid var(--line,#cfd6d3);border-radius:7px;background:var(--btn,#fff);color:var(--ink,#1f2a2e);direction:ltr"></label>' +
        '<div id="cpErr" style="color:var(--danger,#b42318);font-size:13.5px;min-height:18px"></div>' +
        '<button type="submit" style="font:inherit;font-size:15px;padding:9px;border-radius:8px;border:0;background:var(--sel,#0b7a75);color:#fff;cursor:pointer">כניסה</button>' +
        '</form>');
      const f = o.querySelector('#cpLogin');
      const em = f.querySelector('[name=email]'), pw = f.querySelector('[name=password]');
      try { em.focus(); } catch (e) {}
      f.addEventListener('submit', async e => {
        e.preventDefault();
        const btn = f.querySelector('button'); btn.disabled = true;
        o.querySelector('#cpErr').textContent = '';
        try {
          const r = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: Object.assign({ 'Content-Type': 'application/json' }, HDR),
            body: JSON.stringify({ email: em.value, password: pw.value }) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { o.querySelector('#cpErr').textContent = j.message || 'הכניסה נכשלה.'; btn.disabled = false; return; }
          closeOverlay(); loginP = null; resolve(true);
        } catch (err) { o.querySelector('#cpErr').textContent = 'אין חיבור לשרת. בדוק את האינטרנט ונסה שוב.'; btn.disabled = false; }
      });
    }));
    return loginP;
  }
  function showOffline() {
    return whenBody().then(() => new Promise(resolve => {
      const o = overlay('<h1 style="font-size:20px;margin:0 0 8px">אין חיבור לשרת</h1><p style="margin:0 0 16px;color:var(--muted,#62706f);font-size:14px">המערכת צריכה אינטרנט כדי לטעון ולשמור את הפרויקטים.</p>' +
        '<button id="cpRetry" style="font:inherit;font-size:15px;padding:9px 16px;border-radius:8px;border:0;background:var(--sel,#0b7a75);color:#fff;cursor:pointer">נסה שוב</button>');
      o.querySelector('#cpRetry').addEventListener('click', () => { closeOverlay(); resolve(); });
    }));
  }
  function ensureAuth() {
    if (authP) return authP;
    authP = (async () => {
      for (;;) {
        let r;
        try { r = await fetch('/api/me', { credentials: 'same-origin' }); }
        catch (e) { await showOffline(); continue; }
        if (r.ok) return r.json();
        if (r.status === 401) { try { await showLogin(); } catch (e) { loginP = null; await showOffline(); } continue; }
        await showOffline();
      }
    })();
    return authP;
  }

  /* ---------- db: same surface the app uses ---------- */
  const snap = (id, exists, data) => ({ id, exists, data: () => (exists ? data : undefined), metadata: { fromCache: false, hasPendingWrites: false } });
  function docRef(p) {
    const id = p.split('/').pop();
    return {
      id, path: p,
      async get() { const j = await api('GET', '/api/doc?path=' + encodeURIComponent(p)); return snap(id, j.exists, j.data); },
      async set(data) { await api('PUT', '/api/doc', { path: p, data }); },
      async update(data) { await api('PATCH', '/api/doc', { path: p, data }); },
      async delete() { await api('DELETE', '/api/doc?path=' + encodeURIComponent(p)); },
      collection(c) { return colRef(p + '/' + c); }
    };
  }
  function colRef(p) {
    const ref = {
      path: p,
      doc(id) { return docRef(p + '/' + (id || (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36)))); },
      async get() {
        const j = await api('GET', '/api/collection?path=' + encodeURIComponent(p));
        const docs = j.docs.map(d => snap(d.id, true, d.data));
        return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
      },
      onSnapshot(next, onErr) {
        let alive = true, busy = false;
        const run = async () => {
          if (!alive || busy) return; busy = true;
          try { next(await ref.get()); } catch (e) { /* transient: next poll retries */ }
          busy = false;
        };
        const vis = () => { if (document.visibilityState === 'visible') run(); };
        run();
        const iv = setInterval(() => { if (document.visibilityState === 'visible') run(); }, 15000);
        document.addEventListener('visibilitychange', vis); window.addEventListener('focus', vis);
        return () => { alive = false; clearInterval(iv); document.removeEventListener('visibilitychange', vis); window.removeEventListener('focus', vis); };
      }
    };
    return ref;
  }
  const db = { doc: docRef, collection: colRef };
  const user = { id: async () => 'team', isOwner: async () => true, canEdit: async () => true, can: async () => true };
  const assets = {
    async upload(blob, opts) {
      const type = (opts && opts.type) || blob.type || 'image/jpeg';
      const j = await api('POST', '/api/uploads', blob, type);
      return { id: j.id, url: '/_blob/' + j.id, sizeBytes: blob.size, contentType: type };
    }
  };
  const downloads = {
    async save({ filename, data }) {
      const type = /\.pdf$/i.test(filename) ? 'application/pdf' : /\.csv$/i.test(filename) ? 'text/csv;charset=utf-8' : 'application/octet-stream';
      const blob = data instanceof Blob ? data : new Blob([data], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return { status: 'saved' };
    }
  };
  const sumit = {
    status: () => api('GET', '/api/sumit/status'),
    setCredentials: (companyId, apiKey) => api('PUT', '/api/sumit/credentials', { companyId, apiKey }),
    test: () => api('POST', '/api/sumit/test', {}),
    docTypes: () => api('GET', '/api/sumit/doctypes'),
    saveCustomer: c => api('POST', '/api/sumit/customer', { customer: c }),
    createDocument: d => api('POST', '/api/sumit/document', d),
    sync: days => api('POST', '/api/sumit/sync', { days }),
    syncCustomers: folder => api('POST', '/api/sumit/synccustomers', { folder: folder || null }),
    syncCustStatus: () => api('GET', '/api/sumit/synccuststatus'),
    syncStatus: () => api('GET', '/api/sumit/syncstatus')
  };
  const inbox = {
    keys: { list: () => api('GET', '/api/extkeys'), create: label => api('POST', '/api/extkeys', { label }), revoke: id => api('DELETE', '/api/extkeys/' + encodeURIComponent(id)) },
    sources: { list: () => api('GET', '/api/plsources'), save: src => api('POST', '/api/plsources', src), remove: id => api('DELETE', '/api/plsources/' + encodeURIComponent(id)), run: (id, force) => api('POST', '/api/plsources/' + encodeURIComponent(id) + '/run' + (force ? '?force=1' : '')) },
    blob: async blobId => { const r = await fetch('/_blob/' + encodeURIComponent(blobId), { credentials: 'same-origin' }); if (!r.ok) throw new Error('הקובץ לא נמצא בשרת'); return r.blob(); }
  };
  const caps = { db, user, assets, downloads, sumit, inbox };
  window.__fetchProduct = url => api('POST', '/api/fetchproduct', { url });
  window.__productImage = req => api('POST', '/api/productimage', req);
  window.claude = Object.freeze({
    use: async name => {
      if (!(name in caps)) return null;
      if (name !== 'downloads') await ensureAuth();
      return caps[name];
    }
  });

  /* ---------- logout button, service worker ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    const bar = document.querySelector('.bar');
    if (bar) {
      const b = document.createElement('button');
      b.textContent = 'יציאה'; b.title = 'התנתקות מהמערכת';
      b.style.cssText = 'margin-inline-start:auto';
      b.addEventListener('click', async () => {
        try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: HDR }); } catch (e) {}
        location.reload();
      });
      bar.appendChild(b);
    }
  });
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
  }
})();
