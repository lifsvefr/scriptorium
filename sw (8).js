/* Söguþræðir service worker.
   Keeps the notebook working offline, and catches files shared to it from other apps.
   Only ever clears its own old caches, so sibling apps on the same site are left alone. */
const CACHE = 'soguthraedir-v1';
const SHARE = 'soguthraedir-share';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(['./', './manifest.webmanifest'].map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(k => k.startsWith('soguthraedir-') && k !== CACHE && k !== SHARE)
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(req) {
  const c = await caches.open(CACHE);
  try {
    const r = await Promise.race([
      fetch(req),
      new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3500))
    ]);
    if (r && r.ok) c.put(req, r.clone());
    return r;
  } catch (err) {
    const m = await c.match(req) || (req.mode === 'navigate' ? await c.match('./') : null);
    if (m) return m;
    throw err;
  }
}

async function cacheFirst(req) {
  const c = await caches.open(CACHE);
  const m = await c.match(req);
  if (m) return m;
  const r = await fetch(req);
  /* scripts from cdnjs arrive as "opaque" responses; they're still safe to keep */
  if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone());
  return r;
}

/* A file shared from another app arrives here, waits in a small cache,
   and the notebook picks it up as soon as it opens. */
async function receiveShare(req) {
  const form = await req.formData();
  const files = form.getAll('files').filter(f => f && typeof f !== 'string');
  const c = await caches.open(SHARE);
  for (const k of await c.keys()) await c.delete(k);
  let i = 0;
  for (const f of files) {
    const url = new URL('shared/' + (i++) + '-' + Date.now(), self.registration.scope);
    await c.put(url, new Response(f, { headers: {
      'content-type': f.type || 'application/octet-stream',
      'x-name': encodeURIComponent(f.name || 'shared-file')
    }}));
  }
  return Response.redirect(new URL('./?shared=' + files.length, self.registration.scope).href, 303);
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;
  if (url.pathname.includes('/glyph')) { e.respondWith(cacheFirst(e.request)); return; }
  /* the PDF, zip and text-recognition tools stay available offline once they've loaded once */
  if (url.hostname === 'cdnjs.cloudflare.com' || url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'tessdata.projectnaptha.com') { e.respondWith(cacheFirst(e.request)); return; }
  if (url.origin === location.origin || url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com')) {
    e.respondWith(networkFirst(e.request));
  }
});
