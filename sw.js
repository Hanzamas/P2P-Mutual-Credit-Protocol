// ============================================================
// NOTA KITA - SERVICE WORKER
// Offline-first caching with update notification
// ============================================================

var CACHE_NAME = 'nota-kita-v7';

// Critical assets that MUST be cached for offline to work
var CRITICAL_ASSETS = [
  './',
  'app.html',
  // CSS
  'css/base.css',
  'css/components.css',
  'css/nav.css',
  'css/screens.css',
  'css/animations.css',
  // Vendor libs
  'js/lib/qrcode.js',
  'js/lib/jsQR.js',
  'js/lib/trystero-nostr.js',
  'js/lib/noble-secp256k1.js',
  'js/lib/noble-secp256k1-loader.js',
  // Core: no DOM
  'js/core/crypto.js',
  'js/core/encrypt.js',
  'js/core/db.js',
  'js/core/interest.js',
  'js/core/note.js',
  'js/core/endorse.js',
  'js/core/netting.js',
  'js/core/circle.js',
  'js/core/reputation.js',
  'js/core/oracle.js',
  'js/core/merge.js',
  // IO: network, file, QR
  'js/io/qr.js',
  'js/io/fountain.js',
  'js/io/share.js',
  'js/io/backup.js',
  'js/io/rtc.js',
  // UI
  'js/ui/ui.js',
  'js/ui/tutorial.js',
  'js/ui/render/home.js',
  'js/ui/render/ledger.js',
  'js/ui/render/bills.js',
  'js/ui/render/settings.js',
  'js/ui/render/peers.js',
  'js/ui/render/reports.js',
  // Bootstrap
  'js/app.js'
];

// Nice-to-have
var OPTIONAL_ASSETS = [
  'index.html',
  'manifest.json',
  'version.json',
  'icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // Cache critical assets first (all-or-nothing for these)
      return cache.addAll(CRITICAL_ASSETS).then(function () {
        // Then cache optional assets individually (failures are OK)
        return Promise.allSettled(
          OPTIONAL_ASSETS.map(function (url) {
            return cache.add(url).catch(function () {
              console.warn('SW: optional asset skipped:', url);
            });
          })
        );
      });
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_NAME; })
          .map(function (n) { return caches.delete(n); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  var url = event.request.url;
  if (url.indexOf('http') !== 0) return;
  // Always fetch version.json from network (for update checks)
  if (url.indexOf('version.json') !== -1) return;

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).then(function (response) {
        if (response.status === 200 && response.type === 'basic') {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(function () {
        // Offline and not in cache — serve app.html for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('app.html');
        }
        return new Response('', { status: 503, statusText: 'Offline' });
      });
    })
  );
});
