// Service worker личного кабинета «Чайлэнд».
// Кэшируем оболочку приложения, чтобы карта открывалась и без сети.
const CACHE = 'gab-lk-v7';
const ASSETS = ['/lk/', '/lk/index.html', '/lk/manifest.webmanifest', '/logo.png', '/lk/driftland.svg', '/lk/driftland-mark.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API и QR — всегда сеть, не кэшируем (данные должны быть свежими).
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) =>
      cached ||
      fetch(e.request)
        .then((resp) => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return resp;
        })
        .catch(() => caches.match('/lk/'))
    )
  );
});
