// Service worker личного кабинета «Чайлэнд».
// Кэшируем оболочку приложения, чтобы карта открывалась и без сети.
const CACHE = 'gab-lk-v15';
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
  // Оболочка приложения (HTML) — сначала сеть, чтобы после обновления на сервере
  // гость сразу видел новую версию; кэш — только когда сети нет.
  if (e.request.mode === 'navigate' || url.pathname === '/lk/' || url.pathname === '/lk/index.html') {
    e.respondWith(
      fetch(e.request)
        .then((resp) => {
          if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
          return resp;
        })
        .catch(() => caches.match(e.request).then((c) => c || caches.match('/lk/')))
    );
    return;
  }
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

// ---- Push-уведомления из парка (новости, акции, напоминания о празднике) ----
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(
    self.registration.showNotification(d.title || 'ЧайЛэнд', {
      body: d.body || '',
      icon: d.icon || '/logo.png',
      badge: '/logo.png',
      tag: d.tag || undefined,
      renotify: !!d.tag,
      data: { url: d.url || '/lk/' },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/lk/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.indexOf('/lk') !== -1 && 'focus' in c) {
          if ('navigate' in c) c.navigate(url).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
