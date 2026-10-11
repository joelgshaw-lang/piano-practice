// Offline support for the web (iPad) version: keep a copy of the app files so it opens without internet.
// Bump VERSION whenever the files change so devices pick up the new copy.
const VERSION = 'piano-v1';
const FILES = [
  'practice.html', 'practice.css', 'practice.js', 'synth.js', 'midi-file.js', 'demo-song.js',
  'index.html', 'fingering.js', 'staff.js', 'mic.js', 'share.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png',
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first (so updates arrive), falling back to the saved copy when offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
