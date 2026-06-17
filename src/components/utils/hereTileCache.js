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

function fetchAndCache(url, cacheKey, img, done) {
  fetch(url, { mode: 'cors', credentials: 'omit' })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Check whether this was served from the SW cache or fetched from HERE.
      // The SW tags its responses: X-Tile-Cache: hit (cached) | miss (real HERE call).
      // If the header is absent (SW not active yet), treat as a real HERE call.
      const swCacheHit = res.headers.get('X-Tile-Cache') === 'hit';

      return res.blob().then((blob) => ({ blob, swCacheHit }));
    })
    .then(({ blob, swCacheHit }) => {
      // Always store in IDB — keeps the cold-start fallback warm regardless.
      cacheTile(cacheKey, blob).catch(() => {});

      if (!swCacheHit) {
        // Genuine HERE API network call — log it to the dashboard counter
        // and fire the tile discovery event for the collective coverage map.
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
      // SW cache hit → no API log, no discovery event (tile already known)
      const blobUrl = URL.createObjectURL(blob);
      img.onload  = () => { URL.revokeObjectURL(blobUrl); done(null, img); };
      img.onerror = (e) => { URL.revokeObjectURL(blobUrl); fetchAndCache(url, cacheKey, img, done); };
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

      // SW intercepts the fetch for us — but check IDB first for instant
      // paint during cold-start before the SW has had time to activate.
      getCachedTile(cacheKey).then((cachedBlobUrl) => {
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
          attribution, tileSize, zoomOffset, opacity,
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
                attribution, tileSize, zoomOffset, opacity,
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
  }, [map, tileSize, zoomOffset, opacity, updateWhenZooming, keepBuffer, className, pane, attribution]);

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
