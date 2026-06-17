/**
 * map-tile-sw.js — RxDeliver HERE Tile Cache Service Worker
 *
 * Strategy: Cache-first, city-namespaced SW Cache API buckets.
 *
 * Each city gets its own named cache: 'rxdeliver-tiles-{cityId}'
 * Only the ACTIVE city's cache is served from. Other cities sit dormant
 * until a SET_ACTIVE_CITY message switches the active bucket, or a
 * CLEAR_STALE_CITIES sweep removes caches not accessed in 30 days.
 *
 * Messages handled (postMessage from client):
 *   { type: 'SET_ACTIVE_CITY',    cityId: string }
 *   { type: 'CLEAR_STALE_CITIES', maxAgeMs: number }  // optional, default 30 days
 *   { type: 'GET_CACHE_STATS' }                        // replies with stats
 *   { type: 'CLEAR_CITY_CACHE',   cityId: string }     // force-wipe one city
 *
 * Cache key: URL with apiKey stripped (so key is stable across key rotations)
 * Tile TTL: 30 days (enforced by CLEAR_STALE_CITIES sweep)
 */

const SW_VERSION = 'v3';
const CACHE_PREFIX = 'rxdeliver-tiles-';
const FALLBACK_CACHE = 'rxdeliver-tiles-default';
const HERE_HOSTNAME = 'maps.hereapi.com';
const TILE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const STALE_CITY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// In-memory active city state — persists for the lifetime of this SW instance
let _activeCityId = null;
let _activeCacheName = FALLBACK_CACHE;

// Track last-access timestamp per city cache (in-memory, resets on SW restart)
const _cityLastAccess = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cacheName(cityId) {
  return cityId ? `${CACHE_PREFIX}${cityId}` : FALLBACK_CACHE;
}

/**
 * Build a stable cache key from a HERE tile URL — strips the apiKey query param
 * so the same tile is always the same key regardless of which API key is active.
 */
function stableKey(request) {
  try {
    const u = new URL(request.url);
    u.searchParams.delete('apiKey');
    return u.toString();
  } catch {
    return request.url;
  }
}

function isHereTileRequest(request) {
  try {
    const u = new URL(request.url);
    return u.hostname === HERE_HOSTNAME;
  } catch {
    return false;
  }
}

// ─── Install / Activate ───────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  console.log(`[TileSW ${SW_VERSION}] Installing — skipWaiting`);
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  console.log(`[TileSW ${SW_VERSION}] Activating — claiming clients`);
  event.waitUntil((async () => {
    // Delete legacy IDB-era SW caches (old naming scheme)
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('here-map-tiles-'))
        .map((k) => {
          console.log(`[TileSW] Deleting legacy cache: ${k}`);
          return caches.delete(k);
        })
    );
    await self.clients.claim();
  })());
});

// ─── Fetch intercept — cache-first for HERE tiles ─────────────────────────────

self.addEventListener('fetch', (event) => {
  if (!isHereTileRequest(event.request)) return;

  event.respondWith((async () => {
    const key = stableKey(event.request);
    const targetCache = _activeCacheName;

    // Track access time for the active city
    if (_activeCityId) {
      _cityLastAccess.set(_activeCityId, Date.now());
    }

    // 1. Try active city cache
    const cache = await caches.open(targetCache);
    const cached = await cache.match(key);
    if (cached) {
      return cached;
    }

    // 2. Cache miss — fetch from HERE API
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        // Store in active city cache (clone — body can only be consumed once)
        cache.put(key, response.clone()).catch(() => {});
      }
      return response;
    } catch (err) {
      // Network error — return a 503
      return new Response('Tile unavailable offline', { status: 503 });
    }
  })());
});

// ─── Message handler ──────────────────────────────────────────────────────────

self.addEventListener('message', (event) => {
  const { type, cityId, maxAgeMs } = event.data || {};

  switch (type) {

    case 'SET_ACTIVE_CITY': {
      const prev = _activeCityId;
      _activeCityId = cityId || null;
      _activeCacheName = cacheName(cityId);
      if (cityId) _cityLastAccess.set(cityId, Date.now());
      console.log(`[TileSW] Active city: ${prev || 'none'} → ${_activeCityId || 'default'} (cache: ${_activeCacheName})`);
      event.source?.postMessage({ type: 'CITY_SET', cityId: _activeCityId, cacheName: _activeCacheName });
      break;
    }

    case 'CLEAR_STALE_CITIES': {
      const threshold = maxAgeMs ?? STALE_CITY_TTL_MS;
      const cutoff = Date.now() - threshold;
      event.waitUntil((async () => {
        const keys = await caches.keys();
        let removed = 0;
        for (const k of keys) {
          if (!k.startsWith(CACHE_PREFIX)) continue;
          const cId = k.slice(CACHE_PREFIX.length);
          if (cId === _activeCityId) continue; // never remove active city
          const lastAccess = _cityLastAccess.get(cId) ?? 0;
          if (lastAccess < cutoff) {
            await caches.delete(k);
            removed++;
            console.log(`[TileSW] Pruned stale city cache: ${k}`);
          }
        }
        event.source?.postMessage({ type: 'STALE_CITIES_CLEARED', removed });
      })());
      break;
    }

    case 'CLEAR_CITY_CACHE': {
      if (!cityId) break;
      event.waitUntil((async () => {
        const cn = cacheName(cityId);
        const existed = await caches.delete(cn);
        console.log(`[TileSW] Cleared city cache: ${cn} (existed: ${existed})`);
        event.source?.postMessage({ type: 'CITY_CACHE_CLEARED', cityId, existed });
      })());
      break;
    }

    case 'GET_CACHE_STATS': {
      event.waitUntil((async () => {
        const keys = await caches.keys();
        const cityKeys = keys.filter((k) => k.startsWith(CACHE_PREFIX));
        const stats = await Promise.all(
          cityKeys.map(async (k) => {
            const c = await caches.open(k);
            const entries = await c.keys();
            return { cache: k, cityId: k.slice(CACHE_PREFIX.length), tiles: entries.length };
          })
        );
        event.source?.postMessage({
          type: 'CACHE_STATS',
          activeCityId: _activeCityId,
          activeCacheName: _activeCacheName,
          caches: stats,
          totalTiles: stats.reduce((s, x) => s + x.tiles, 0),
        });
      })());
      break;
    }

    default:
      break;
  }
});
