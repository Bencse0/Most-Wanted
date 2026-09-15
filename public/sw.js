const CACHE_NAME = 'most-wanted-v12-ultra';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/runner.html',
  '/hunter.html',
  '/manifest.json',
  '/css/style.css',
  '/js/runner.js',
  '/js/hunter.js', '/audio/notification.wav', '/audio/notification-urgent.wav'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/socket.io/')) return;
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
    return response;
  }).catch(() => caches.match(event.request)));
});
