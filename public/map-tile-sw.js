const HERE_TILE_CACHE = 'here-map-tiles-v1';
const HERE_TILE_HOST = 'maps.hereapi.com';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

const isHereTileRequest = (requestUrl) => {
  try {
    const url = new URL(requestUrl);
    return url.hostname.includes(HERE_TILE_HOST) && url.pathname.includes('/v3/base/mc/');
  } catch {
    return false;
  }
};

const notifyClients = async (message) => {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach((client) => client.postMessage(message));
};

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || !isHereTileRequest(request.url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(HERE_TILE_CACHE);
    const cached = await cache.match(request, { ignoreSearch: false });
    if (cached) {
      return cached;
    }

    const response = await fetch(request);
    if (!response || !response.ok) {
      return response;
    }

    await cache.put(request, response.clone());
    await notifyClients({
      type: 'HERE_TILE_CACHED',
      url: request.url,
      cacheKey: request.url,
      cachedAt: Date.now()
    });
    return response;
  })());
});
