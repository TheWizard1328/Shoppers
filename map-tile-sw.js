/**
 * map-tile-sw.js — RxDeliver HERE Tile Cache Service Worker
 *
 * Strategy: Cache-first, city-namespaced SW Cache API buckets with per-tile TTL.
 *
 * Each city gets its own named cache: 'rxdeliver-tiles-{cityId}'
 * Only the ACTIVE city's cache is served from. Other cities sit dormant
 * until a SET_ACTIVE_CITY message switches the active bucket, or a
 * CLEAR_STALE_CITIES sweep removes caches not accessed in 30 days.
 *
 * Per-tile TTL: cached tiles older than TILE_TTL_MS are treated as a miss
 * and re-fetched from HERE, so stale/broken tiles refresh naturally without
 * a global cache wipe (which would force every tile to re-fetch simultaneously
 * and overwhelm HERE rate limits at high zoom).
 *
 * Messages handled (postMessage from client):
 *   { type: 'SET_ACTIVE_CITY',    cityId: string }
 *   { type: 'CLEAR_STALE_CITIES', maxAgeMs: number }  // optional, default 30 days
 *   { type: 'GET_CACHE_STATS' }                        // replies with stats
 *   { type: 'CLEAR_CITY_CACHE',   cityId: string }     // force-wipe one city
 *
 * Cache key: URL with apiKey stripped (so key is stable across key rotations)
 */

const SW_VERSION = 'v5';
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

/**
 * Check if a cached Response is older than TILE_TTL_MS by reading its Date
 * header. HERE always sets a Date header on tile responses, so this reliably
 * detects stale entries. Falls back to "not stale" if no Date header is present
 * (e.g. very old caches that predate this check) so we don't wipe good tiles.
 */
function isCacheEntryStale(cachedResponse) {
  try {
    const dateHeader = cachedResponse.headers.get('date');
    if (!dateHeader) return false;
    const cacheTime = new Date(dateHeader).getTime();
    if (!cacheTime || isNaN(cacheTime)) return false;
    return (Date.now() - cacheTime) > TILE_TTL_MS;
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
    // Only delete genuinely LEGACY caches from the old IDB-era SW ('here-map-tiles-*').
    // We do NOT sweep 'rxdeliver-tiles-*' caches — those hold the user's cached tiles
    // at all zoom levels, and wiping them forces every tile to re-fetch from HERE
    // simultaneously, which overwhelms rate limits at high zoom and leaves the map
    // blank. Stale individual tiles are handled by per-tile TTL validation in the
    // fetch handler (isCacheEntryStale) instead of a global wipe.
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('here-map-tiles-'))
        .map((k) => {
          console.log(`[TileSW ${SW_VERSION}] Deleting legacy cache: ${k}`);
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

    // 1. Try active city cache — but skip if the cached tile is stale (>30 days)
    const cache = await caches.open(targetCache);
    const cached = await cache.match(key);
    if (cached && !isCacheEntryStale(cached)) {
      return cached;
    }

    // 2. Cache miss or stale entry — fetch from HERE API
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        // Store in active city cache (clone — body can only be consumed once)
        cache.put(key, response.clone()).catch(() => {});
      }
      return response;
    } catch (err) {
      // Network error — if we have a stale cached tile, serve it as a last resort
      if (cached) return cached;
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