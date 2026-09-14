const CACHE_NAME = 'most-wanted-v7';
const ASSETS = [
  '/',
  '/index.html',
  '/runner.html',
  '/hunter.html',
  '/css/style.css',
  '/js/runner.js',
  '/js/hunter.js',
  '/manifest.json'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
    ])
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then((response) => response || fetch(e.request))
  );
});
