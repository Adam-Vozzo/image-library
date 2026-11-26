/* Pocket service worker: makes the app shell, seen thumbnails and pinned originals available offline. */
'use strict';
const SHELL = 'pocket-shell';
const THUMBS = 'pocket-thumbs';
const PINNED = 'pocket-pinned';
const SHELL_FILES = ['./', 'app.css', 'app.js', 'query.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
const MAX_THUMBS = 6000;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/thumb/')) event.respondWith(thumb(req, url));
  else if (url.pathname.startsWith('/file/')) event.respondWith(file(req, url));
  else event.respondWith(shell(req, url));
});

/** Serve the cached shell straight away and refresh it in the background. */
async function shell(req, url) {
  const cache = await caches.open(SHELL);
  const key = req.mode === 'navigate' ? './' : url.pathname;
  const cached = await cache.match(key);
  const fresh = fetch(req).then((r) => {
    if (r.ok) cache.put(key, r.clone());
    return r;
  });
  if (cached) {
    fresh.catch(() => {});
    return cached;
  }
  return fresh;
}

async function thumb(req, url) {
  const pinned = await (await caches.open(PINNED)).match(url.pathname);
  if (pinned) return pinned;
  const cache = await caches.open(THUMBS);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const r = await fetch(req);
    if (r.ok) {
      cache.put(req, r.clone()).then(() => trim(cache));
    }
    return r;
  } catch (err) {
    // Offline: an older version of the thumbnail beats a blank tile.
    const old = await cache.match(req, { ignoreSearch: true });
    if (old) return old;
    throw err;
  }
}

let puts = 0;
async function trim(cache) {
  if (++puts % 200) return;
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_THUMBS))) await cache.delete(k);
}

async function file(req, url) {
  const cached = await (await caches.open(PINNED)).match(url.pathname);
  if (!cached) return fetch(req);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
  if (!range) return cached;
  // Video players ask for byte ranges; answer them out of the stored copy.
  const blob = await cached.blob();
  let start = range[1] ? Number(range[1]) : Math.max(0, blob.size - Number(range[2]));
  let end = range[1] && range[2] ? Math.min(Number(range[2]), blob.size - 1) : blob.size - 1;
  if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': cached.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${blob.size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
