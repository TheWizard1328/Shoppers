const CACHE_NAME = 'here-map-tiles-v3';
const HERE_TILE_HOST = 'maps.hereapi.com';
const HERE_TILE_PATH_PREFIX = '/v3/base/mc/';
const CACHEABLE_SEARCH_PARAMS = ['style', 'size'];

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('here-map-tiles-') && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

const isHereTileRequest = (requestUrl) => {
  try {
    const url = new URL(requestUrl);
    return url.hostname === HERE_TILE_HOST && url.pathname.startsWith(HERE_TILE_PATH_PREFIX);
  } catch {
    return false;
  }
};

const buildNormalizedCacheKey = (requestUrl) => {
  const url = new URL(requestUrl);
  const normalized = new URL(url.origin + url.pathname);

  CACHEABLE_SEARCH_PARAMS.forEach((param) => {
    const value = url.searchParams.get(param);
    if (value) normalized.searchParams.set(param, value);
  });

  return normalized.toString();
};

const notifyClients = async (payload) => {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach((client) => client.postMessage(payload));
};

const createCacheRequest = (cacheKey) => new Request(cacheKey, { method: 'GET' });

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || !isHereTileRequest(request.url)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cacheKey = buildNormalizedCacheKey(request.url);
    const cacheRequest = createCacheRequest(cacheKey);
    const cachedResponse = await cache.match(cacheRequest);

    if (cachedResponse) {
      notifyClients({ type: 'HERE_TILE_CACHE_HIT', url: request.url, cacheKey }).catch(() => {});
      return cachedResponse;
    }

    const networkResponse = await fetch(request);
    if (!networkResponse || !networkResponse.ok) {
      return networkResponse;
    }

    const responseToCache = networkResponse.clone();
    await cache.put(cacheRequest, responseToCache);
    notifyClients({ type: 'HERE_TILE_CACHED', url: request.url, cacheKey }).catch(() => {});

    return networkResponse;
  })());
});