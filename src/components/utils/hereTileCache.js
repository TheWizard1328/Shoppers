/**
 * hereTileCache.js
 *
 * HERE map tile caching for Leaflet + React-Leaflet v4.
 *
 * PRIMARY cache: Service Worker Cache API (map-tile-sw.js)
 *   - City-namespaced buckets: 'rxdeliver-tiles-{cityId}'
 *   - Intercepts fetch() at the network level — Leaflet never sees a miss
 *   - Persistent storage via navigator.storage.persist()
 *   - 6GB quota on Android vs IDB's 50MB
 *
 * FALLBACK cache: IndexedDB 'here-tile-cache-v1' (same as before)
 *   - Used when SW isn't active yet (first paint, Capacitor cold start)
 *   - Same key scheme, same TTL, same LRU eviction
 *   - Gradually superseded by SW cache as tiles get served
 *
 * BUG FIX: updateWhenZooming default changed false → prevents float-zoom
 *   tile explosions during pinch-zoom with zoomSnap=0 / zoomDelta=0.1.
 *   With updateWhenZooming=false, Leaflet only calls createTile() when
 *   zoom animation settles — eliminating 10-50x redundant tile fetches.
 */

import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';

// ─── IDB fallback setup ───────────────────────────────────────────────────────

const DB_NAME    = 'here-tile-cache-v1';
const STORE_NAME = 'tiles';
const DB_VERSION = 1;
const MAX_ENTRIES = 800;                         // ~24MB — safely below Android IDB limit
const PRUNE_COUNT = 150;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;       // 30 days
const LRU_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // rate-limit LRU writes to 1/tile/10min
const DB_READY_TIMEOUT_MS = 1500;

let _db = null;
let _dbPromise = null;
let _dbHasOpened = false;

function openDB() {
  if (_db) return Promise.resolve(_db);
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('ts', 'ts', { unique: false });
        }
      };
      req.onsuccess  = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror    = ()  => reject(req.error);
    } catch (err) { reject(err); }
  });
  return _dbPromise;
}

if (typeof indexedDB !== 'undefined') {
  openDB().then(() => { _dbHasOpened = true; }).catch(() => {});
}

function openDBWithTimeout() {
  if (_dbHasOpened && _db) return Promise.resolve(_db);
  return Promise.race([
    openDB().then((db) => { _dbHasOpened = true; return db; }),
    new Promise((resolve) => setTimeout(() => resolve(null), DB_READY_TIMEOUT_MS)),
  ]);
}

// ─── Cache key builder ────────────────────────────────────────────────────────

/**
 * Build a stable cache key from a HERE tile URL.
 * Strips apiKey so the key is consistent across key rotations.
 * Format: `{style}|{size}|{z}/{x}/{y.format}`
 */
export function buildTileCacheKey(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/');
    const z    = parts[4];
    const x    = parts[5];
    const yFmt = parts.slice(6).join('/');
    const style = u.searchParams.get('style') || 'explore.day';
    const size  = u.searchParams.get('size')  || '256';
    return `${style}|${size}|${z}/${x}/${yFmt}`;
  } catch {
    return null;
  }
}

// ─── IDB read / write ─────────────────────────────────────────────────────────

export async function getCachedTile(cacheKey) {
  try {
    const db = await openDBWithTimeout();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(cacheKey);
      req.onsuccess = () => {
        const record = req.result;
        if (!record) return resolve(null);
        const now = Date.now();
        if (now - record.ts > TTL_MS) {
          // Expired — async delete, don't block render
          openDB().then((rdb) => {
            try {
              const dtx = rdb.transaction(STORE_NAME, 'readwrite');
              dtx.objectStore(STORE_NAME).delete(cacheKey);
            } catch (_) {}
          }).catch(() => {});
          return resolve(null);
        }
        // Rate-limited LRU refresh
        if (now - record.ts > LRU_REFRESH_INTERVAL_MS) {
          openDB().then((rdb) => {
            try {
              const utx = rdb.transaction(STORE_NAME, 'readwrite');
              utx.objectStore(STORE_NAME).put({ ...record, ts: now });
            } catch (_) {}
          }).catch(() => {});
        }
        resolve(URL.createObjectURL(record.blob));
      };
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

export async function cacheTile(cacheKey, blob) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ key: cacheKey, blob, ts: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
    pruneIfNeeded(db).catch(() => {});
  } catch { /* best-effort */ }
}

async function pruneIfNeeded(db) {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const countReq = store.count();
    countReq.onsuccess = () => {
      if (countReq.result <= MAX_ENTRIES) return resolve();
      const toDelete = [];
      store.index('ts').openCursor().onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor || toDelete.length >= PRUNE_COUNT) {
          toDelete.forEach((key) => store.delete(key));
          return resolve();
        }
        toDelete.push(cursor.value.key);
        cursor.continue();
      };
    };
    countReq.onerror = () => resolve();
  });
}

// ─── Network fetch → IDB + usage counter ────────────────────────────────────

let _pendingNetworkTileCount = 0;
let _tileFlushTimer = null;

// Active city_id — set by tileCoverageManager via setTileCoverageCity()
let _coverageCityId = null;
export function setTileCoverageCity(cityId) { _coverageCityId = cityId; }

function _dispatchTileNetworkFetch(count = 1) {
  _pendingNetworkTileCount += count;
  if (_tileFlushTimer) return;
  _tileFlushTimer = setTimeout(() => {
    _tileFlushTimer = null;
    const n = _pendingNetworkTileCount;
    _pendingNetworkTileCount = 0;
    if (n <= 0) return;
    window.dispatchEvent(new CustomEvent('hereTileNetworkFetch', { detail: { count: n } }));
  }, 3000);
}

function _isSwControlling() {
  return typeof navigator !== 'undefined' &&
    !!navigator.serviceWorker &&
    !!navigator.serviceWorker.controller;
}

// ─── Page-direct Cache API layer ─────────────────────────────────────────────
// The SW cache only serves pages the SW CONTROLS. In two real environments
// that control is unreliable: the Base44 builder preview iframe (controller
// stays null) and the Android WebView inside the APK (control/storage flaky
// across cold starts). The Cache API is ALSO usable directly from the page,
// with the same persistent ~6GB quota and no SW handshake. When the SW isn't
// controlling (or we're in the APK and don't trust it), this layer becomes
// the primary tile cache.
//
// Named 'rx-tiles-*' (NOT 'here-tiles-*') so the SW's activate-time purge of
// legacy tile caches never touches it.
const PAGE_TILE_CACHE = 'rx-tiles-page-v1';

function _isNativeApk() {
  try {
    return typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();
  } catch (_) { return false; }
}

function _pageCacheApiAvailable() {
  return typeof caches !== 'undefined' && typeof caches.open === 'function';
}

function _normalizeUrlForPageCache(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('apiKey');
    u.searchParams.delete('api_key');
    u.searchParams.delete('token');
    u.searchParams.delete('rxr');
    return u.toString();
  } catch (_) { return url; }
}

async function pageCacheGet(url) {
  try {
    if (!_pageCacheApiAvailable()) return null;
    const cache = await caches.open(PAGE_TILE_CACHE);
    const hit = await cache.match(_normalizeUrlForPageCache(url));
    if (!hit || hit.type === 'opaque' || !hit.ok) return null;
    return hit;
  } catch (_) { return null; }
}

async function pageCachePut(url, response) {
  try {
    if (!_pageCacheApiAvailable()) return;
    // Only cache proper CORS responses — opaque ones can't be re-read via blob()
    if (!response.ok || response.type === 'opaque') return;
    const cache = await caches.open(PAGE_TILE_CACHE);
    await cache.put(_normalizeUrlForPageCache(url), response.clone());
  } catch (_) {}
}

function fetchAndCache(url, cacheKey, img, done, attempt = 0) {
  const swControlling = _isSwControlling();

  // Page-direct cache first — this is the persistent layer for environments
  // where the SW can't be trusted (editor preview iframe, APK WebView).
  // A hit here is a zero-API, zero-log load.
  pageCacheGet(url).then((cachedRes) => {
    if (cachedRes) {
      return cachedRes.blob().then((blob) => {
        const blobUrl = URL.createObjectURL(blob);
        img.onload  = () => { URL.revokeObjectURL(blobUrl); done(null, img); };
        img.onerror = () => { URL.revokeObjectURL(blobUrl); fetchAndCache(url, cacheKey, img, done, attempt + 1); };
        img.src = blobUrl;
      });
    }
    return _fetchAndCacheFromNetwork(url, cacheKey, img, done, attempt, swControlling);
  }).catch(() => {
    _fetchAndCacheFromNetwork(url, cacheKey, img, done, attempt, swControlling);
  });
}

function _fetchAndCacheFromNetwork(url, cacheKey, img, done, attempt, swControlling) {
  fetch(url, { mode: 'cors', credentials: 'omit' })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Check whether this was served from the SW cache or fetched from HERE.
      // The SW tags its responses: X-Tile-Cache: hit (cached) | miss (real HERE call).
      // If the header is absent (SW not active yet), treat as a real HERE call.
      const swCacheHit = res.headers.get('X-Tile-Cache') === 'hit';

      // Persist to the page-direct cache when the SW didn't already cache it
      // (SW-controlling hits/misses are cached inside the SW's own layer; when
      // the SW is NOT controlling, this page cache is the only persistent copy).
      if (!swCacheHit) {
        pageCachePut(url, res).catch(() => {});
      }

      return res.blob().then((blob) => ({ blob, swCacheHit }));
    })
    .then(({ blob, swCacheHit }) => {
      // IDB is only the cold-start fallback for when the SW isn't controlling
      // yet. When it IS controlling, it caches the tile in Cache API storage —
      // writing here too would just add readwrite-transaction contention on
      // the IDB store, serializing every other tile's cache lookups.
      if (!swControlling) {
        cacheTile(cacheKey, blob).catch(() => {});
      }

      if (!swCacheHit) {
        // Genuine HERE API network call. When the SW is controlling the page
        // it already broadcasts TILE_NETWORK_FETCH for this fetch — counting
        // here too would double-log every miss. Only count when the SW is NOT
        // controlling (unsupported, cold start pre-claim, or registration failure).
        if (!swControlling) {
          _dispatchTileNetworkFetch(1);

          if (_coverageCityId && cacheKey) {
            try {
              const zoom = parseInt(cacheKey.split('|')[2]?.split('/')[0], 10) || 0;
              window.dispatchEvent(new CustomEvent('hereTileDiscovered', {
                detail: { tile_key: cacheKey, city_id: _coverageCityId, zoom }
              }));
            } catch (_) {}
          }
        }
      }
      // SW cache hit → no API log, no discovery event (tile already known)
      const blobUrl = URL.createObjectURL(blob);
      img.onload  = () => { URL.revokeObjectURL(blobUrl); done(null, img); };
      img.onerror = (e) => {
        URL.revokeObjectURL(blobUrl);
        if (attempt < 1) fetchAndCache(url, cacheKey, img, done, attempt + 1);
        else { done(e, img); }
      };
      img.src = blobUrl;
    })
    .catch(() => {
      // Final fallback — let the browser try directly
      img.onload  = () => done(null, img);
      img.onerror = (e) => done(e, img);
      img.src = url;
    });
}

// ─── Leaflet layer class ──────────────────────────────────────────────────────

export function createCachedHereTileLayer(LInstance) {
  return LInstance.TileLayer.extend({
    // Always round zoom for URL generation — prevents float-zoom cache misses
    _getZoomForUrl() {
      return Math.round(LInstance.TileLayer.prototype._getZoomForUrl.call(this));
    },

    createTile(coords, done) {
      const img = document.createElement('img');
      img.setAttribute('role', 'presentation');
      img.setAttribute('alt', '');
      img.setAttribute('loading', 'eager');
      img.decoding = 'async';
      img.crossOrigin = 'anonymous';

      const url = this.getTileUrl(coords);
      const cacheKey = buildTileCacheKey(url);

      if (!cacheKey) {
        img.onload  = () => done(null, img);
        img.onerror = (e) => done(e, img);
        img.src = url;
        return img;
      }

      // When the SW is controlling, load the tile NATIVELY. The SW intercepts
      // the image request transparently: cache hits come straight from Cache
      // API storage, misses are fetched from HERE and returned immediately
      // (caching tracked via waitUntil in the background). This is the browser's
      // own image pipeline — same speed as the uncached era, renders
      // progressively, and skips the fetch→blob→objectURL round trip entirely.
      // In the APK, the Android WebView's service-worker control has proven
      // unreliable across cold starts (same tiles re-fetched every launch) —
      // always use the page-direct cache + fetch→blob path there.
      if (_isSwControlling() && !_isNativeApk()) {
        img.onload  = () => done(null, img);
        img.onerror = (e) => done(e, img);
        img.src = url;

        // Watchdog: if a tile hasn't loaded in 15s (hung SW response, dead
        // connection), retry once with a cache-busting param — the SW strips
        // 'rxr' before cache lookups, so the retry still caches normally.
        setTimeout(() => {
          if (img.complete || img.src !== url) return;
          img.onload  = () => done(null, img);
          img.onerror = (e) => done(e, img);
          img.src = `${url}&rxr=${Date.now()}`;
        }, 15000);
        return img;
      }

      // Cold start / APK (SW not controlling) — check the page-direct Cache API
      // first (persistent, no SW handshake), then the legacy IDB store.
      pageCacheGet(url).then((cachedRes) => {
        if (cachedRes) {
          return cachedRes.blob().then((blob) => URL.createObjectURL(blob));
        }
        return getCachedTile(cacheKey);
      }).then((cachedBlobUrl) => {
        if (cachedBlobUrl) {
          // IDB hit (cold-start fast path)
          img.onload  = () => { URL.revokeObjectURL(cachedBlobUrl); done(null, img); };
          img.onerror = () => { URL.revokeObjectURL(cachedBlobUrl); fetchAndCache(url, cacheKey, img, done); };
          img.src = cachedBlobUrl;
        } else {
          // SW cache or network (SW intercepts the fetch transparently)
          fetchAndCache(url, cacheKey, img, done);
        }
      }).catch(() => {
        fetchAndCache(url, cacheKey, img, done);
      });

      return img;
    },
  });
}

const _CachedHereTileLayerClass = createCachedHereTileLayer(L);

// ─── React-Leaflet component ──────────────────────────────────────────────────

export function CachedTileLayer({
  url,
  attribution,
  tileSize = 256,
  zoomOffset = 0,
  maxNativeZoom,
  opacity = 1,
  // FIX: default false — prevents Leaflet from calling createTile() at every
  // intermediate float zoom level during pinch-zoom with zoomSnap=0.
  // With zoomSnap=0 / zoomDelta=0.1, a single pinch from z14→z15 fires
  // createTile() ~10 times per tile if updateWhenZooming=true → 10x API cost.
  updateWhenZooming = false,
  keepBuffer = 0,
  className,
  pane = 'tilePane',
}) {
  const map = useMap();
  const layerRef = useRef(null);
  const rafRef   = useRef(null);

  useEffect(() => {
    if (!map) return;
    let cancelled = false;

    const addLayer = () => {
      if (cancelled) return;
      try {
        if (!map.getPane(pane)) {
          rafRef.current = requestAnimationFrame(addLayer);
          return;
        }
        const layer = new _CachedHereTileLayerClass(url, {
          attribution, tileSize, zoomOffset, maxNativeZoom, opacity,
          updateWhenZooming, keepBuffer, className, pane,
        });
        layer.addTo(map);
        layerRef.current = layer;
      } catch {
        if (!cancelled) {
          rafRef.current = requestAnimationFrame(() => {
            if (cancelled) return;
            try {
              const layer = new _CachedHereTileLayerClass(url, {
                attribution, tileSize, zoomOffset, maxNativeZoom, opacity,
                updateWhenZooming, keepBuffer, className, pane,
              });
              layer.addTo(map);
              layerRef.current = layer;
            } catch (e) {
              console.warn('[CachedTileLayer] Failed to add tile layer:', e);
            }
          });
        }
      }
    };

    rafRef.current = requestAnimationFrame(addLayer);

    return () => {
      cancelled = true;
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      if (layerRef.current) {
        try { map.removeLayer(layerRef.current); } catch (_) {}
        layerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, tileSize, zoomOffset, maxNativeZoom, opacity, updateWhenZooming, keepBuffer, className, pane, attribution]);

  useEffect(() => {
    if (layerRef.current && url) {
      layerRef.current.setUrl(url);
    }
  }, [url]);

  return null;
}

// ─── Admin / debug helpers ────────────────────────────────────────────────────

export async function clearTileCache() {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  } catch {}
}

export async function getTileCacheStats() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).count();
      req.onsuccess = () => resolve({ count: req.result, maxEntries: MAX_ENTRIES, source: 'idb-fallback' });
      req.onerror   = () => resolve({ count: 0, maxEntries: MAX_ENTRIES, source: 'idb-fallback' });
    });
  } catch {
    return { count: 0, maxEntries: MAX_ENTRIES, source: 'idb-fallback' };
  }
}

// prefetchTilesForBounds — kept for compatibility but guarded tightly
export function prefetchTilesForBounds(map, bounds, zoom, tileUrl, extraBuffer = 0) {
  if (!map || !bounds || !tileUrl) return;
  try {
    const intZoom = Math.round(zoom);
    const nwTile = map.project(bounds.getNorthWest(), intZoom).divideBy(256).floor();
    const seTile = map.project(bounds.getSouthEast(), intZoom).divideBy(256).floor();
    const minX = nwTile.x - extraBuffer;
    const maxX = seTile.x + extraBuffer;
    const minY = nwTile.y - extraBuffer;
    const maxY = seTile.y + extraBuffer;
    const tileCount = (maxX - minX + 1) * (maxY - minY + 1);
    if (tileCount > 12) return; // tight guard
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const url = tileUrl.replace('{z}', intZoom).replace('{x}', x).replace('{y}', y);
        const cacheKey = buildTileCacheKey(url);
        if (!cacheKey) continue;
        // SW will intercept this fetch and cache it automatically
        fetch(url, { mode: 'cors', credentials: 'omit', priority: 'low' }).catch(() => {});
      }
    }
  } catch (_) {}
}
