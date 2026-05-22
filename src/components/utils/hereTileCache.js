/**
 * hereTileCache.js
 *
 * IndexedDB-based HERE map tile cache for Leaflet.
 * Works in Capacitor WebViews, mobile browsers, and desktop — no Service Worker needed.
 *
 * Strategy:
 *   - Cache key: `{style}|{z}/{x}/{y}` (apiKey stripped — tiles are identical across keys)
 *   - Storage: IndexedDB object store "tiles" keyed by cache key
 *   - TTL: 30 days (tiles rarely change; HERE re-renders on style change via different cache key)
 *   - Max entries: 3,000 tiles (LRU eviction — auto-prune oldest 500 when limit hit)
 *   - Each entry: { key, blob, ts } — ts used for LRU eviction
 */

const DB_NAME = 'here-tile-cache-v1';
const STORE_NAME = 'tiles';
const DB_VERSION = 1;
const MAX_ENTRIES = 3000;
const PRUNE_COUNT = 500;       // evict this many oldest entries when MAX_ENTRIES is hit
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let _db = null;
let _dbPromise = null;

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
      req.onsuccess = (e) => {
        _db = e.target.result;
        resolve(_db);
      };
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });

  return _dbPromise;
}

/** Build a cache key from a tile URL — strips apiKey so same tile = same key across key rotations */
export function buildTileCacheKey(url) {
  try {
    const u = new URL(url);
    // path is like /v3/base/mc/z/x/y/png — extract z/x/y/format
    const parts = u.pathname.split('/');
    // parts: ['', 'v3', 'base', 'mc', z, x, y, 'png']
    const z = parts[4], x = parts[5], yFmt = parts.slice(6).join('/');
    const style = u.searchParams.get('style') || 'explore.day';
    const size = u.searchParams.get('size') || '256';
    return `${style}|${size}|${z}/${x}/${yFmt}`;
  } catch {
    return null;
  }
}

/** Get a cached tile blob URL. Returns null if not cached or expired. */
export async function getCachedTile(cacheKey) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(cacheKey);
      req.onsuccess = () => {
        const record = req.result;
        if (!record) return resolve(null);
        if (Date.now() - record.ts > TTL_MS) {
          // Expired — delete and return null
          store.delete(cacheKey);
          return resolve(null);
        }
        // Refresh LRU timestamp
        store.put({ ...record, ts: Date.now() });
        resolve(URL.createObjectURL(record.blob));
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/** Store a tile blob in the cache. Triggers LRU prune if over limit. */
export async function cacheTile(cacheKey, blob) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put({ key: cacheKey, blob, ts: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });

    // Async prune — don't block tile rendering
    pruneIfNeeded(db).catch(() => {});
  } catch {
    // Silent fail — caching is best-effort
  }
}

async function pruneIfNeeded(db) {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const countReq = store.count();
    countReq.onsuccess = () => {
      const count = countReq.result;
      if (count <= MAX_ENTRIES) return resolve();

      // Get oldest entries by ts index and delete PRUNE_COUNT of them
      const tsIndex = store.index('ts');
      const toDelete = [];
      const cursorReq = tsIndex.openCursor();
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor || toDelete.length >= PRUNE_COUNT) {
          toDelete.forEach((key) => store.delete(key));
          return resolve();
        }
        toDelete.push(cursor.value.key);
        cursor.continue();
      };
      cursorReq.onerror = () => resolve();
    };
    countReq.onerror = () => resolve();
  });
}

/**
 * CachedHereTileLayer — a Leaflet TileLayer subclass that intercepts createTile()
 * and serves tiles from IndexedDB cache before falling back to network.
 */
export function createCachedHereTileLayer(L) {
  return L.TileLayer.extend({
    // Round zoom to integer (same as IntegerZoomTileLayer)
    _getZoomForUrl() {
      return Math.round(L.TileLayer.prototype._getZoomForUrl.call(this));
    },

    createTile(coords, done) {
      const img = document.createElement('img');
      img.setAttribute('role', 'presentation');
      img.setAttribute('alt', '');

      const url = this.getTileUrl(coords);
      const cacheKey = buildTileCacheKey(url);

      if (!cacheKey) {
        // Fallback: load normally
        img.onload = () => done(null, img);
        img.onerror = (e) => done(e, img);
        img.src = url;
        return img;
      }

      // Try cache first
      getCachedTile(cacheKey).then((cachedBlobUrl) => {
        if (cachedBlobUrl) {
          img.onload = () => {
            // Revoke the blob URL after the image loads to free memory
            URL.revokeObjectURL(cachedBlobUrl);
            done(null, img);
          };
          img.onerror = () => {
            // Blob URL failed (shouldn't happen) — fall back to network
            URL.revokeObjectURL(cachedBlobUrl);
            fetchAndCache(url, cacheKey, img, done);
          };
          img.src = cachedBlobUrl;
        } else {
          fetchAndCache(url, cacheKey, img, done);
        }
      }).catch(() => {
        // IDB unavailable — load normally
        img.onload = () => done(null, img);
        img.onerror = (e) => done(e, img);
        img.src = url;
      });

      return img;
    }
  });
}

function fetchAndCache(url, cacheKey, img, done) {
  fetch(url, { mode: 'cors', credentials: 'omit' })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    })
    .then((blob) => {
      // Cache it (async, don't wait)
      cacheTile(cacheKey, blob).catch(() => {});

      const blobUrl = URL.createObjectURL(blob);
      img.onload = () => {
        URL.revokeObjectURL(blobUrl);
        done(null, img);
      };
      img.onerror = (e) => {
        URL.revokeObjectURL(blobUrl);
        done(e, img);
      };
      img.src = blobUrl;
    })
    .catch((e) => {
      // Network failed — set src directly as final fallback (may hit CORS issues but better than nothing)
      img.onload = () => done(null, img);
      img.onerror = (err) => done(err, img);
      img.src = url;
    });
}

/** Clear the entire tile cache (useful for admin reset / style change) */
export async function clearTileCache() {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Silent fail
  }
}

/** Get cache stats for debugging */
export async function getTileCacheStats() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).count();
      req.onsuccess = () => resolve({ count: req.result, maxEntries: MAX_ENTRIES });
      req.onerror = () => resolve({ count: 0, maxEntries: MAX_ENTRIES });
    });
  } catch {
    return { count: 0, maxEntries: MAX_ENTRIES };
  }
}
