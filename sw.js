// Service Worker: App-Shell offline verfügbar machen
const VERSION = 'dynatune-v7';
const ASSETS = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/tuning.js',
  'js/reference.js',
  'js/display.js',
  'js/tracker.js',
  'js/diagnose.js',
  'js/calibrate.js',
  'js/stopsignal.js',
  'js/dsp.js',
  'worklet/dynatune-processor.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Netz zuerst (Updates kommen sofort an), Cache als Rückfall für offline
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
