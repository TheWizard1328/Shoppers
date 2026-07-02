/**
 * map-tile-sw.js — HERE map tile cache-first Service Worker + Web Push
 *
 * Tile caching strategy:
 *   1. Check active city cache → return if hit
 *   2. Check legacy/fallback caches → return if hit
 *   3. Fetch from network, cache it, broadcast TILE_NETWORK_FETCH to clients
 *
 * City namespacing: each city gets its own Cache Storage bucket so switching
 * cities doesn't invalidate the entire tile cache.
 *
 * Push notifications:
 *   'push' event      — shows a notification using the payload's title/body/icon/url
 *   'notificationclick' — focuses an existing app window or opens a new one,
 *                         navigating to `data.url` if provided (deep link)
 */

const SW_VERSION = 'v9';
const CACHE_PREFIX = 'here-tiles';
const DEFAULT_CACHE = `${CACHE_PREFIX}-default-${SW_VERSION}`;
const TILE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const STALE_CITY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Active city — updated via SET_ACTIVE_CITY message
let activeCityId = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCacheName(cityId) {
  return cityId ? `${CACHE_PREFIX}-${cityId}` : DEFAULT_CACHE;
}

/** Strip API key and other volatile params so the same tile always hits the same cache entry */
function normalizeTileUrl(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('apiKey');
    u.searchParams.delete('api_key');
    u.searchParams.delete('token');
    return u.toString();
  } catch (_) {
    return url;
  }
}

function isTileRequest(url) {
  try {
    const u = new URL(url);
    return (
      u.hostname.includes('maps.hereapi.com') ||
      u.hostname.includes('tiles.maps.hereapi.com') ||
      u.hostname.includes('map.ls.hereapi.com') ||
      (u.hostname.includes('here.com') && (u.pathname.includes('/maptile') || u.pathname.includes('/tile')))
    );
  } catch (_) {
    return false;
  }
}

/** Broadcast a message to all controlled clients */
async function broadcastToClients(msg) {
  try {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
    clients.forEach((client) => client.postMessage(msg));
  } catch (_) {}
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  console.log(`[TileSW ${SW_VERSION}] Installing`);
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  console.log(`[TileSW ${SW_VERSION}] Activating`);
  event.waitUntil(self.clients.claim());
});

// ─── Fetch interception ───────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only intercept HERE tile requests
  if (!isTileRequest(request.url)) return;

  event.respondWith(handleTileRequest(request));
});

async function handleTileRequest(request) {
  const cacheKey = normalizeTileUrl(request.url);
  const cacheRequest = new Request(cacheKey);

  // ── 1. Try active city cache first ────────────────────────────────────────
  if (activeCityId) {
    try {
      const cityCache = await caches.open(getCacheName(activeCityId));
      const cityHit = await cityCache.match(cacheRequest);
      if (cityHit) {
        return cityHit;
      }
    } catch (_) {}
  }

  // ── 2. Try default/fallback cache ─────────────────────────────────────────
  try {
    const defaultCache = await caches.open(DEFAULT_CACHE);
    const defaultHit = await defaultCache.match(cacheRequest);
    if (defaultHit) {
      // Promote to active city cache for future hits
      if (activeCityId) {
        defaultHit.clone().blob().then((blob) => {
          caches.open(getCacheName(activeCityId)).then((c) =>
            c.put(cacheRequest, new Response(blob, {
              status: defaultHit.status,
              statusText: defaultHit.statusText,
              headers: defaultHit.headers
            }))
          ).catch(() => {});
        }).catch(() => {});
      }
      return defaultHit;
    }
  } catch (_) {}

  // ── 3. Try any other existing city caches ─────────────────────────────────
  try {
    const allCacheNames = await caches.keys();
    const otherTileCaches = allCacheNames.filter(
      (name) => name.startsWith(CACHE_PREFIX) && name !== getCacheName(activeCityId) && name !== DEFAULT_CACHE
    );
    for (const cacheName of otherTileCaches) {
      const cache = await caches.open(cacheName);
      const hit = await cache.match(cacheRequest);
      if (hit) {
        return hit;
      }
    }
  } catch (_) {}

  // ── 4. Network fetch (cache miss) ─────────────────────────────────────────
  let networkResponse;
  try {
    networkResponse = await fetch(request);
  } catch (networkError) {
    // Offline and no cache — return a transparent 1x1 PNG tile placeholder
    console.warn(`[TileSW] Network error for tile: ${networkError.message}`);
    return new Response(null, { status: 503, statusText: 'Service Unavailable' });
  }

  if (!networkResponse.ok) {
    return networkResponse;
  }

  // Broadcast cache miss so the usage tracker can log it
  broadcastToClients({ type: 'TILE_NETWORK_FETCH', count: 1 });

  // Cache the response
  try {
    const targetCacheName = getCacheName(activeCityId);
    const responseToCache = networkResponse.clone();
    const cache = await caches.open(targetCacheName);
    await cache.put(cacheRequest, responseToCache);
  } catch (cacheError) {
    console.warn(`[TileSW] Failed to cache tile: ${cacheError.message}`);
  }

  return networkResponse;
}

// ─── Message handling ─────────────────────────────────────────────────────────

self.addEventListener('message', (event) => {
  const { type, cityId } = event.data || {};

  switch (type) {
    case 'SET_ACTIVE_CITY':
      if (cityId && cityId !== activeCityId) {
        console.log(`[TileSW] Active city → ${cityId}`);
        activeCityId = cityId;
      }
      break;

    case 'CLEAR_CITY_CACHE':
      if (cityId) {
        caches.delete(getCacheName(cityId))
          .then(() => console.log(`[TileSW] Cleared cache for city: ${cityId}`))
          .catch(() => {});
      }
      break;

    case 'CLEAR_STALE_CITIES':
      pruneStaleCarches();
      break;

    case 'GET_CACHE_STATS':
      getCacheStats().then((stats) => {
        event.source?.postMessage({ type: 'CACHE_STATS', ...stats });
      }).catch(() => {});
      break;

    default:
      break;
  }
});

// ─── Stale cache pruning ──────────────────────────────────────────────────────

async function pruneStaleCarches() {
  try {
    const allCaches = await caches.keys();
    const tileCaches = allCaches.filter((name) => name.startsWith(CACHE_PREFIX));
    const now = Date.now();

    for (const cacheName of tileCaches) {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();
      let deletedCount = 0;

      for (const req of requests) {
        const response = await cache.match(req);
        if (!response) continue;

        const dateHeader = response.headers.get('date');
        if (dateHeader) {
          const cacheAge = now - new Date(dateHeader).getTime();
          if (cacheAge > STALE_CITY_TTL_MS) {
            await cache.delete(req);
            deletedCount++;
          }
        }
      }

      // Delete the whole cache bucket if it's now empty
      const remaining = await cache.keys();
      if (remaining.length === 0) {
        await caches.delete(cacheName);
        console.log(`[TileSW] Pruned empty cache: ${cacheName}`);
      } else if (deletedCount > 0) {
        console.log(`[TileSW] Pruned ${deletedCount} stale tiles from ${cacheName}`);
      }
    }
  } catch (err) {
    console.warn(`[TileSW] Stale cache pruning failed: ${err.message}`);
  }
}

// ─── Cache stats ──────────────────────────────────────────────────────────────

async function getCacheStats() {
  try {
    const allCaches = await caches.keys();
    const tileCaches = allCaches.filter((name) => name.startsWith(CACHE_PREFIX));
    let totalTiles = 0;
    const perCity = {};

    for (const cacheName of tileCaches) {
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();
      totalTiles += keys.length;
      perCity[cacheName] = keys.length;
    }

    return { totalTiles, perCity, activeCityId };
  } catch (_) {
    return { totalTiles: 0, perCity: {}, activeCityId };
  }
}


// ─── Web Push ─────────────────────────────────────────────────────────────────

const DEFAULT_NOTIFICATION_ICON = '/icons/icon-192.png';
const DEFAULT_NOTIFICATION_BADGE = '/icons/icon-192.png';

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    // Payload wasn't JSON — fall back to plain text body
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'RxDeliver';
  const options = {
    body: payload.body || '',
    icon: payload.icon || DEFAULT_NOTIFICATION_ICON,
    badge: payload.badge || DEFAULT_NOTIFICATION_BADGE,
    tag: payload.tag || undefined,
    // Re-notify even if the same tag exists so route/message alerts aren't silently merged
    renotify: !!payload.tag,
    requireInteraction: !!payload.requireInteraction,
    data: {
      url: payload.url || '/',
      ...payload.data
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

      // If a window is already open, focus it and navigate to the deep link
      for (const client of allClients) {
        try {
          const clientUrl = new URL(client.url);
          const sameOrigin = clientUrl.origin === self.location.origin;
          if (sameOrigin && 'focus' in client) {
            await client.focus();
            if ('navigate' in client && targetUrl !== clientUrl.pathname) {
              try {
                await client.navigate(targetUrl);
              } catch (_) {
                // navigate() can fail cross-origin or if unsupported — fall back silently,
                // the focused window is still usable even without the deep link
              }
            }
            return;
          }
        } catch (_) {}
      }

      // No existing window — open a new one at the deep link
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })()
  );
});
