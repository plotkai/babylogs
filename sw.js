// sw.js — Service Worker for Babylogs PWA (offline-first caching)

const CACHE_NAME = 'babylogs-v53';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './robots.txt',
  './sitemap.xml',
  './config/baby-config.json',
  './js/app.js',
  './js/db.js',
  './js/config.js',
  './js/utils.js',
  './js/summary.js',
  './js/notifications.js',
  './js/export.js',
  './js/analytics.js',
  './js/drive-sync.js',
  './js/qrcode.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './favicon.svg'
];

// Install — precache all static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate — clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== 'babylogs-share-target')
          .map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch — handle Share Target POST & cache-first GET
self.addEventListener('fetch', (event) => {
  // Handle Web Share Target POST request
  if (event.request.method === 'POST' && event.request.url.includes('share-target')) {
    event.respondWith((async () => {
      try {
        const formData = await event.request.formData();
        const file = formData.get('backup') || formData.get('file');
        if (file) {
          const text = await file.text();
          const shareCache = await caches.open('babylogs-share-target');
          await shareCache.put(
            './incoming-backup.json',
            new Response(text, { headers: { 'content-type': 'application/json' } })
          );
        }
      } catch (err) {
        console.error('Error handling share target POST:', err);
      }
      return Response.redirect('./index.html?shared_target=1', 303);
    })());
    return;
  }

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip chrome-extension and other non-http(s) requests
  if (!event.request.url.startsWith('http')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((response) => {
        // Don't cache non-ok responses or external requests
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }

        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseClone);
        });

        return response;
      }).catch(() => {
        // If both cache and network fail, return offline page for navigation
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
