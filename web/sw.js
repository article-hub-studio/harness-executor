/* upio web — service worker.
 * Cache-first cho static same-origin KHÔNG phải /api hay /v1; còn lại → network thẳng.
 * Có cập nhật nền (stale-while-revalidate) và dọn cache cũ khi activate.
 */
const CACHE = 'upio-web-v14';

const PRECACHE = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/api.js',
  './js/boot.js',
  './js/icons.js',
  './js/md.js',
  './js/views/term.js',
  './js/i18n.js',
  './js/views/home.js',
  './js/views/hub.js',
  './js/views/agents.js',
  './js/views/chat.js',
  './js/views/settings.js',
  './manifest.webmanifest',
  './icons/favicon.svg',
];

/* Mọi fetch trong SW cũng phải có deadline. SW nằm NGOÀI semaphore của api.js, nên
 * ~15 asset refresh nền treo vĩnh viễn (server nhận TCP rồi im) sẽ tự ăn hết 6 kết nối
 * của origin và làm tắc cả app — đúng cơ chế freeze mà api.js vừa chặn. */
const SW_TIMEOUT_MS = 10000;
function fetchWithDeadline(req, ms = SW_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(req, { signal: ac.signal }).finally(() => clearTimeout(t));
}

/* ---------- install: precache static (bỏ qua lỗi từng URL) ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(PRECACHE.map(async (url) => {
        const res = await fetchWithDeadline(new Request(url, { cache: 'reload' }));
        if (res && res.ok) await cache.put(url, res);
      })))
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

  // Luôn làm mới nền (không bao giờ chặn phản hồi) — CÓ deadline, xem ghi chú trên
  const refresh = fetchWithDeadline(req)
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
