/* upio web — service worker.
 * Cache-first cho static same-origin KHÔNG phải /api hay /v1; còn lại → network thẳng.
 * Có cập nhật nền (stale-while-revalidate) và dọn cache cũ khi activate.
 */
const CACHE = 'upio-web-v3';

const PRECACHE = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/api.js',
  './js/boot.js',
  './js/icons.js',
  './js/views/home.js',
  './js/views/hub.js',
  './js/views/agents.js',
  './js/views/chat.js',
  './js/views/settings.js',
  './manifest.webmanifest',
  './icons/favicon.svg',
];

/* ---------- install: precache static (bỏ qua lỗi từng URL) ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

/* ---------- activate: dọn cache phiên bản cũ ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ---------- fetch strategy ---------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== location.origin) return;                    // chỉ same-origin
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/v1')) return; // API → network

  event.respondWith(cacheFirst(req));
});

/** Cache-first + cập nhật nền; navigate rớt về index.html khi offline. */
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const isNav = req.mode === 'navigate';
  const cached = await cache.match(req, { ignoreSearch: isNav });

  // Luôn làm mới nền (không bao giờ chặn phản hồi)
  const refresh = fetch(req)
    .then((res) => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  if (cached) {
    refresh.catch(() => {});
    return cached;
  }

  const res = await refresh;
  if (res) return res;

  if (isNav) {
    const shell = (await cache.match('./index.html')) || (await cache.match('./'));
    if (shell) return shell;
  }
  return new Response('offline', { status: 503, statusText: 'offline' });
}
