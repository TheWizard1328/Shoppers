const TILE_CACHE_NAME = 'rxdeliver-map-tiles-v1';
const MAX_CACHE_ENTRIES = 1200;
const TILE_HOST_PATTERNS = [
  'cartocdn.com',
  'hereapi.com',
  'maps.hereapi.com'
];

const isTileRequest = (request) => {
  const url = new URL(request.url);
  return TILE_HOST_PATTERNS.some((host) => url.hostname.includes(host));
};

const trimCache = async (cache) => {
  const keys = await cache.keys();
  if (keys.length <= MAX_CACHE_ENTRIES) return;
  const overflow = keys.length - MAX_CACHE_ENTRIES;
  await Promise.all(keys.slice(0, overflow).map((request) => cache.delete(request)));
};

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !isTileRequest(event.request)) return;

  event.respondWith((async () => {
    const cache = await caches.open(TILE_CACHE_NAME);
    const cached = await cache.match(event.request);
    if (cached) return cached;

    const response = await fetch(event.request);
    if (response.ok) {
      cache.put(event.request, response.clone());
      trimCache(cache);
    }
    return response;
  })());
});
