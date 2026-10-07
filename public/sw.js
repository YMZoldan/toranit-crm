/* App shell cache: the app opens instantly and survives weak signal on site.
   API calls and plan images always go to the network. */
const VERSION = 'cp-v25';
const SHELL = ['/', '/shim.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
/* Android share target: "Share" from WhatsApp (or any app) -> Toranit. The files wait in a cache until the app uploads them. */
self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method === 'POST' && u.origin === self.location.origin && u.pathname === '/share-receipt') {
    e.respondWith((async () => {
      try {
        const fd = await req.formData(), files = fd.getAll('file').filter(f => f && f.size), c = await caches.open('share-inbox');
        let n = 0;
        for (const f of files.slice(0, 10)) { n++; await c.put('/share-inbox/' + Date.now() + '-' + n, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Name': encodeURIComponent(f.name || ('receipt-' + n)) } })); }
        return Response.redirect('/?share=' + (n ? '1' : 'empty'), 303);
      } catch (err) { return Response.redirect('/?share=failed', 303); }
    })());
    return;
  }
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/_blob/') || url.pathname === '/healthz') return;
    e.respondWith(
      fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req).then(r => r || caches.match('/')))
    );
    return;
  }
  if (/(^|\.)cdnjs\.cloudflare\.com$|(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res;
    })));
  }
});
