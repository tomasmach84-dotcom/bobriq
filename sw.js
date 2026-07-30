// BOBRIQ, offline vrstva (service worker).
// Strategie: zkus internet (at se novinky hned projevi), kdyz neni, podej z mezipameti.
const CACHE = 'bobriq-v104';
const ASSETS = ['./', './index.html', './app.enc.bin', './manifest.webmanifest',
  './icons/icon-192.png?v=4', './icons/icon-512.png?v=4', './icons/icon-512-maskable.png?v=4',
  './icons/apple-touch-icon.png?v=4'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return r;
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match('./index.html')))
  );
});
