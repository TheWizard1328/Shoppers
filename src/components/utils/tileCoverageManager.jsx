/**
 * tileCoverageManager.js
 *
 * Collective tile discovery — 4 drivers build 1 city map together.
 *
 * HOW IT WORKS:
 *   1. When any driver fetches a tile from HERE (SW cache miss), hereTileCache.js
 *      fires a 'hereTileDiscovered' CustomEvent with { tile_key, city_id, zoom }.
 *
 *   2. tileCoverageManager batches those discoveries and writes them to the
 *      TileCoverage Base44 entity (shared online DB) — one record per tile.
 *      Writes are batched (2-min window) and deduplicated against IDB so we
 *      never write a tile that's already in the online DB.
 *
 *   3. realtimeSync subscribes to TileCoverage entity changes. When another
 *      driver discovers a tile, the WebSocket pushes the new record to all
 *      other devices → realtimeSync fires 'realtimeUpdate_TileCoverage' →
 *      tileCoverageManager receives it → saves to IDB → prefetches from HERE.
 *
 *   4. At startup, tileCoverageManager loads the full TileCoverage list for
 *      the active city from IDB (instant, offline). If IDB is empty or stale
 *      (>6hrs), it fetches from Base44 entity once and refreshes IDB.
 *      It then prefetches all tiles NOT yet in the SW cache — low priority,
 *      background, so it never competes with active delivery work.
 *
 * NET RESULT:
 *   Day 1: Each driver builds their own slice of the city map.
 *   Day 2: Every driver starts with 100% of what all 4 saw yesterday.
 *   Week 1: Full city coverage reached. HERE API tile calls → near-zero.
 *
 * DB CALL BUDGET per device per shift:
 *   Reads:  1 (startup refresh if IDB stale, max once per 6hrs)
 *   Writes: N new tiles discovered (fire-and-forget, batched, typically 20-80/day)
 *   Realtime: existing WebSocket — no extra cost
 */

import { offlineDB } from './offlineDatabase';

// ─── Config ───────────────────────────────────────────────────────────────────

const IDB_REFRESH_INTERVAL_MS  = 6 * 60 * 60 * 1000;  // refresh from DB once per 6hrs
const DISCOVERY_FLUSH_DELAY_MS = 2 * 60 * 1000;        // batch discoveries, flush every 2 min
const PREFETCH_BATCH_SIZE      = 25;                    // prefetch 25 tiles at a time (was 8)
const PREFETCH_BATCH_DELAY_MS  = 200;                   // 200ms between batches (was 500ms)
const STALE_TILE_TTL_MS        = 90 * 24 * 60 * 60 * 1000; // 90 days — prune IDB coverage older than this (was 30)
const IDB_REFRESH_KEY          = 'rxdeliver_tile_coverage_refreshed';

// ─── State ────────────────────────────────────────────────────────────────────

let _activeCityId      = null;
let _initialized       = false;
let _idbCoverageSet    = new Set();  // tile_keys known to be in IDB (this city)
let _pendingDiscoveries = new Map(); // tile_key → { tile_key, city_id, zoom, first_seen, last_seen, hit_count }
let _flushTimer        = null;
let _prefetchQueue     = [];
let _prefetchRunning   = false;
let _TileCoverage      = null;       // lazy-loaded Base44 entity

// ─── Lazy Base44 entity loader ────────────────────────────────────────────────

async function getTileCoverageEntity() {
  if (_TileCoverage) return _TileCoverage;
  try {
    const { TileCoverage } = await import('@/api/entities');
    _TileCoverage = TileCoverage;
    return _TileCoverage;
  } catch (err) {
    console.warn('[TileCoverage] Failed to load entity:', err.message);
    return null;
  }
}

// ─── IDB helpers ──────────────────────────────────────────────────────────────

async function loadCoverageFromIDB(cityId) {
  try {
    const db = await offlineDB.getDB();
    if (!db || !db.objectStoreNames.contains(offlineDB.STORES.TILE_COVERAGE)) return [];
    return new Promise((resolve) => {
      const tx = db.transaction(offlineDB.STORES.TILE_COVERAGE, 'readonly');
      const index = tx.objectStore(offlineDB.STORES.TILE_COVERAGE).index('city_id');
      const req = index.getAll(cityId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => resolve([]);
    });
  } catch { return []; }
}

async function saveCoverageToIDB(records) {
  if (!records || records.length === 0) return;
  try {
    await offlineDB.bulkSave(offlineDB.STORES.TILE_COVERAGE, records);
  } catch (err) {
    console.warn('[TileCoverage] IDB save failed:', err.message);
  }
}

async function pruneStaleIDBCoverage(cityId) {
  // Remove IDB records older than 30 days — tiles are still valid via SW cache
  // This just keeps IDB lean and prevents unbounded growth
  try {
    const db = await offlineDB.getDB();
    if (!db || !db.objectStoreNames.contains(offlineDB.STORES.TILE_COVERAGE)) return;
    const cutoff = new Date(Date.now() - STALE_TILE_TTL_MS).toISOString();
    const all = await loadCoverageFromIDB(cityId);
    const stale = all.filter(r => r.last_seen && r.last_seen < cutoff);
    if (stale.length === 0) return;
    await Promise.all(
      stale.map(r => offlineDB.deleteRecord(offlineDB.STORES.TILE_COVERAGE, r.tile_key).catch(() => {}))
    );
    stale.forEach(r => _idbCoverageSet.delete(r.tile_key));
    console.log(`[TileCoverage] Pruned ${stale.length} stale IDB records for city ${cityId}`);
  } catch {}
}

// ─── SW cache check ───────────────────────────────────────────────────────────

/**
 * Ask the SW if it has a given set of tile_keys cached.
 * Returns a Set of tile_keys that are NOT in the SW cache.
 * Uses the Cache API directly (no network).
 */
async function getMissingFromSWCache(tileKeys) {
  const missing = new Set();
  if (!tileKeys || tileKeys.length === 0) return missing;
  if (!('caches' in window)) {
    // No Cache API — all are "missing" (will be fetched on next map open)
    tileKeys.forEach(k => missing.add(k));
    return missing;
  }

  const cacheNames = await caches.keys();
  const cityCache  = cacheNames.find(n => n.startsWith('rxdeliver-tiles-'));
  if (!cityCache) {
    tileKeys.forEach(k => missing.add(k));
    return missing;
  }

  const cache = await caches.open(cityCache);
  await Promise.all(
    tileKeys.map(async (tileKey) => {
      // Reconstruct a representative URL for the cache key lookup
      // tile_key format: "explore.day|512|13/1508/2642"
      const match = await cache.match(_tileKeyToLookupUrl(tileKey));
      if (!match) missing.add(tileKey);
    })
  );
  return missing;
}

/**
 * Convert a tile_key back to a lookup URL for Cache API matching.
 * The SW stores tiles with apiKey stripped — we match the same way.
 */
function _tileKeyToLookupUrl(tileKey) {
  try {
    // "explore.day|512|13/1508/2642"  →  matches stored key
    // The SW stores by URL-with-apiKey-stripped. We use a synthetic URL
    // that matches the stripped form the SW uses as the cache key.
    const [styleSizePart, coords] = tileKey.split('|').reduce((acc, p, i) => {
      if (i === 0) acc[0] = p;
      else if (i === 1) acc[0] = acc[0] + '|' + p;
      else acc[1] = (acc[1] ? acc[1] + '|' : '') + p;
      return acc;
    }, ['', '']);
    const parts = tileKey.split('|');
    const style = parts[0];
    const size  = parts[1];
    const zxy   = parts[2]; // "13/1508/2642"
    const [z, x, y] = zxy.split('/');
    // Build a URL matching the SW's stripped-key format
    return `https://maps.hereapi.com/v3/base/mc/${z}/${x}/${y}/png?style=${style}&size=${size}`;
  } catch {
    return `https://maps.hereapi.com/__lookup__/${tileKey}`;
  }
}

// ─── Prefetch queue ───────────────────────────────────────────────────────────

function enqueuePrefetch(tileKeys) {
  if (!tileKeys || tileKeys.length === 0) return;
  const newKeys = tileKeys.filter(k => !_prefetchQueue.includes(k));
  _prefetchQueue.push(...newKeys);
  if (!_prefetchRunning) _runPrefetchQueue();
}

async function _runPrefetchQueue() {
  if (_prefetchQueue.length === 0) { _prefetchRunning = false; return; }
  _prefetchRunning = true;

  const batch = _prefetchQueue.splice(0, PREFETCH_BATCH_SIZE);
  const missingKeys = await getMissingFromSWCache(batch);

  // For each missing tile, fire a low-priority fetch.
  // The SW intercepts it, stores in the city cache, done.
  // We need an actual HERE URL — reconstruct from tile_key + active API key.
  const apiKey = _getActiveApiKey();
  if (apiKey) {
    await Promise.allSettled(
      Array.from(missingKeys).map(async (tileKey) => {
        const url = _tileKeyToHereUrl(tileKey, apiKey);
        if (!url) return;
        try {
          await fetch(url, { mode: 'cors', credentials: 'omit', priority: 'low' });
          // SW cached it automatically — no further action needed
        } catch {}
      })
    );
  }

  if (_prefetchQueue.length > 0) {
    setTimeout(_runPrefetchQueue, PREFETCH_BATCH_DELAY_MS);
  } else {
    _prefetchRunning = false;
    console.log(`[TileCoverage] Prefetch queue exhausted — SW cache fully primed for city ${_activeCityId}`);
  }
}

function _tileKeyToHereUrl(tileKey, apiKey) {
  try {
    const parts = tileKey.split('|');
    const style = parts[0];
    const size  = parts[1];
    const zxy   = parts[2];
    const [z, x, y] = zxy.split('/');
    return `https://maps.hereapi.com/v3/base/mc/${z}/${x}/${y}/png?style=${style}&size=${size}&apiKey=${apiKey}`;
  } catch { return null; }
}

function _getActiveApiKey() {
  // Pull the active API key from the same place hereTileCache.js would use.
  // hereApiKeyStore is the app's singleton key manager.
  try {
    const { hereApiKeyStore } = window.__hereApiKeyStore__ || {};
    if (hereApiKeyStore?.getKey) return hereApiKeyStore.getKey();
  } catch {}
  // Fallback: read from the tile layer URL if one is visible
  try {
    const url = window.__activeTileLayerUrl__;
    if (url) {
      const u = new URL(url);
      return u.searchParams.get('apiKey') || null;
    }
  } catch {}
  return null;
}

// ─── Discovery flush ──────────────────────────────────────────────────────────

/**
 * Called by hereTileCache.js via 'hereTileDiscovered' event when the SW
 * fetches a tile from HERE (cache miss = new tile for this device).
 */
function onTileDiscovered({ tile_key, city_id, zoom }) {
  if (!tile_key || !city_id) return;
  if (_idbCoverageSet.has(tile_key)) return; // already known — skip

  const now = new Date().toISOString();
  if (_pendingDiscoveries.has(tile_key)) {
    // Bump hit_count + last_seen
    const existing = _pendingDiscoveries.get(tile_key);
    existing.hit_count = (existing.hit_count || 1) + 1;
    existing.last_seen = now;
  } else {
    _pendingDiscoveries.set(tile_key, {
      tile_key,
      city_id,
      zoom: zoom || 0,
      first_seen: now,
      last_seen: now,
      hit_count: 1,
    });
  }

  // Schedule batch flush
  if (!_flushTimer) {
    _flushTimer = setTimeout(flushDiscoveries, DISCOVERY_FLUSH_DELAY_MS);
  }
}

async function flushDiscoveries() {
  _flushTimer = null;
  if (_pendingDiscoveries.size === 0) return;

  const records = Array.from(_pendingDiscoveries.values());
  _pendingDiscoveries.clear();

  // 1. Save to IDB immediately (instant, local)
  await saveCoverageToIDB(records);
  records.forEach(r => _idbCoverageSet.add(r.tile_key));

  // 2. Write to Base44 TileCoverage entity (online DB — shared with all drivers)
  const entity = await getTileCoverageEntity();
  if (!entity) return;

  // Upsert each tile — use filter+create or update pattern
  await Promise.allSettled(
    records.map(async (rec) => {
      try {
        // Try to find existing record first to avoid duplicates
        const existing = await entity.filter({ tile_key: rec.tile_key }).catch(() => []);
        if (existing && existing.length > 0) {
          // Update hit_count + last_seen only
          await entity.update(existing[0].id, {
            last_seen: rec.last_seen,
            hit_count: (existing[0].hit_count || 1) + 1,
          });
        } else {
          await entity.create(rec);
        }
      } catch (err) {
        // Best-effort — don't let a write failure break the driver's session
        console.warn(`[TileCoverage] Failed to write tile ${rec.tile_key}:`, err.message);
      }
    })
  );

  console.log(`[TileCoverage] Flushed ${records.length} new tiles to shared DB for city ${_activeCityId}`);
}

// ─── Startup load ─────────────────────────────────────────────────────────────

async function loadAndPrefetch(cityId) {
  // Load from IDB first (instant)
  const idbRecords = await loadCoverageFromIDB(cityId);
  _idbCoverageSet = new Set(idbRecords.map(r => r.tile_key));

  const lastRefresh = Number(localStorage.getItem(`${IDB_REFRESH_KEY}_${cityId}`) || 0);
  const needsRefresh = (Date.now() - lastRefresh) > IDB_REFRESH_INTERVAL_MS;

  if (needsRefresh || idbRecords.length === 0) {
    // Fetch from Base44 entity — once per 6hrs max
    try {
      const entity = await getTileCoverageEntity();
      if (entity) {
        console.log(`[TileCoverage] Refreshing coverage for city ${cityId} from online DB...`);
        const onlineRecords = await entity.filter(
          { city_id: cityId },
          'created_date',
          2000 // max 2000 tiles — well above Edmonton's 663
        );
        if (onlineRecords && onlineRecords.length > 0) {
          await saveCoverageToIDB(onlineRecords);
          onlineRecords.forEach(r => _idbCoverageSet.add(r.tile_key));
          localStorage.setItem(`${IDB_REFRESH_KEY}_${cityId}`, String(Date.now()));
          console.log(`[TileCoverage] Loaded ${onlineRecords.length} tiles from online DB into IDB`);
        }
      }
    } catch (err) {
      console.warn('[TileCoverage] Online refresh failed — using IDB only:', err.message);
    }
  }

  // Prune stale IDB records (background, non-blocking)
  pruneStaleIDBCoverage(cityId).catch(() => {});

  // Enqueue prefetch for all tiles in coverage but NOT in SW cache
  if (_idbCoverageSet.size > 0) {
    const allKeys = Array.from(_idbCoverageSet);
    console.log(`[TileCoverage] ${allKeys.length} tiles known for city ${cityId} — checking SW cache...`);
    const missingFromSW = await getMissingFromSWCache(allKeys);
    if (missingFromSW.size > 0) {
      console.log(`[TileCoverage] Prefetching ${missingFromSW.size} tiles missing from SW cache (background)`);
      enqueuePrefetch(Array.from(missingFromSW));
    } else {
      console.log(`[TileCoverage] SW cache fully primed — ${allKeys.length} tiles ready`);
    }
  }
}

// ─── Realtime push handler ────────────────────────────────────────────────────

/**
 * Called by realtimeSync when TileCoverage entity changes come in via WebSocket.
 * Another driver discovered a tile — save to IDB and prefetch it.
 */
export function onRealtimeTileCoverage(eventType, data) {
  if (!data?.tile_key || !data?.city_id) return;
  if (data.city_id !== _activeCityId) return; // ignore other cities

  if (eventType === 'create' || eventType === 'update') {
    // Save to IDB
    saveCoverageToIDB([data]).catch(() => {});
    _idbCoverageSet.add(data.tile_key);

    // Prefetch this tile if we don't have it yet
    if (eventType === 'create') {
      enqueuePrefetch([data.tile_key]);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialize the tile coverage manager for the active city.
 * Call once on app startup after city is known.
 * Safe to call again on city switch.
 */
export async function initTileCoverageManager(cityId) {
  if (!cityId || cityId === 'all' || cityId === 'waiting-for-selection') return;

  if (_initialized && _activeCityId === cityId) return; // already up for this city

  _activeCityId   = cityId;
  _initialized    = true;
  _idbCoverageSet = new Set();
  _prefetchQueue  = [];
  _prefetchRunning = false;

  console.log(`[TileCoverage] Initializing for city ${cityId}`);

  // Listen for local tile discoveries from hereTileCache.js
  window.removeEventListener('hereTileDiscovered', _handleDiscoveryEvent);
  window.addEventListener('hereTileDiscovered', _handleDiscoveryEvent);

  // Listen for realtime TileCoverage pushes (dispatched by realtimeSync)
  window.removeEventListener('realtimeUpdate_TileCoverage', _handleRealtimeEvent);
  window.addEventListener('realtimeUpdate_TileCoverage', _handleRealtimeEvent);

  // Load existing coverage and start prefetch (non-blocking)
  loadAndPrefetch(cityId).catch(err => {
    console.warn('[TileCoverage] Startup load failed:', err.message);
  });
}

function _handleDiscoveryEvent(e) {
  onTileDiscovered(e.detail || {});
}

function _handleRealtimeEvent(e) {
  const { type, data } = e.detail || {};
  onRealtimeTileCoverage(type, data);
}

/** Force-flush any pending discoveries immediately (e.g. on app backgrounded) */
export function flushPendingDiscoveries() {
  if (_pendingDiscoveries.size > 0) {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    flushDiscoveries().catch(() => {});
  }
}

/** Get current coverage stats for admin dashboard */
export function getCoverageStats() {
  return {
    cityId: _activeCityId,
    knownTiles: _idbCoverageSet.size,
    pendingDiscoveries: _pendingDiscoveries.size,
    prefetchQueueLength: _prefetchQueue.length,
    prefetchRunning: _prefetchRunning,
  };
}