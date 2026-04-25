const CACHE_NAME = 'here-raster-tiles-v3';
const HERE_TILE_HOSTS = [
  'maps.hereapi.com',
  'maps.here.com'
];

const isHereTileRequest = (requestUrl) => {
  try {
    const url = new URL(requestUrl);
    if (!HERE_TILE_HOSTS.includes(url.hostname)) return false;
    return /\/v3\/base\//.test(url.pathname);
  } catch {
    return false;
  }
};

const buildCacheKey = (request) => {
  const url = new URL(request.url);
  const style = url.searchParams.get('style') || '';
  const size = url.searchParams.get('size') || '';
  const lang = url.searchParams.get('lang') || '';
  const ppi = url.searchParams.get('ppi') || '';
  return `${url.origin}${url.pathname}?style=${style}&size=${size}&lang=${lang}&ppi=${ppi}`;
};

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET' || !isHereTileRequest(request.url)) {
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cacheKey = buildCacheKey(request);
    const cached = await cache.match(cacheKey);

    if (cached) {
      return cached;
    }

    const response = await fetch(request, {
      mode: 'cors',
      credentials: 'omit'
    });

    if (response.ok) {
      cache.put(cacheKey, response.clone()).catch(() => {});
    }

    return response;
  })());
});
