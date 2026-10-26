// Keeps the app opening with no signal. The app files and the Whisper library are served from the
// cache and refreshed in the background. The model files cache themselves (the library does it),
// and calls to Claude and GitHub always go to the network.
const CACHE = 'notes-v6';
const SHELL = ['./', 'index.html', 'app.js', 'ink.js', 'whisper-worker.js', 'pcm-worklet.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('notes-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const mine = url.origin === location.origin || url.hostname === 'cdn.jsdelivr.net';
  if (e.request.method !== 'GET' || !mine) return;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || fresh;
  }));
});
