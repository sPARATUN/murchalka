// Мурчалка — работает без интернета: отдаём из кэша, обновляем в фоне.
const V = 'murchalka-v2';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'db.js', 'parsers.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const key = req.mode === 'navigate' ? './' : req;
  e.respondWith((async () => {
    const cache = await caches.open(V);
    const hit = await cache.match(key, { ignoreSearch: true });
    const net = fetch(req).then(r => {
      if (r.ok) { const copy = r.clone(); cache.put(key, copy); }
      return r;
    }).catch(() => hit);
    if (hit) { e.waitUntil(net); return hit; }
    return net;
  })());
});
