/**
 * rxTempLogsCache.jsx
 *
 * Shared cache for RxTempLogs keyed by `driver_id:delivery_date`.
 * Always reads the offline DB first; only hits the server API on a miss,
 * and the API call goes through requestQueue so it can never burst.
 *
 * Used by LiveTempBadge (poll) and dashboardInitialLoadHelpers (boot) so
 * both share the same cached record instead of each issuing a separate
 * RxTempLogs.filter call.
 */

import { queueEntityRequest } from '@/components/utils/requestQueue';

const TTL_MS = 2 * 60 * 1000; // 2 minutes in-memory TTL
const _cache = new Map(); // key: "driver_id:delivery_date" → { value, expiresAt, promise? }

const _key = (driverId, deliveryDate) => `${driverId}:${deliveryDate}`;

/**
 * Get a single RxTempLogs record for a driver+date.
 * 1. Check in-memory cache
 * 2. Check offline DB (IDB)
 * 3. Fall back to server API (queued)
 *
 * @returns {Promise<object|null>}
 */
export async function getRxTempLog(driverId, deliveryDate) {
  if (!driverId || !deliveryDate) return null;
  const k = _key(driverId, deliveryDate);
  const now = Date.now();

  const entry = _cache.get(k);
  if (entry && entry.expiresAt > now && entry.value !== undefined) {
    return entry.value;
  }
  if (entry?.promise) return entry.promise;

  const promise = (async () => {
    // Step 1: offline DB
    let record = null;
    try {
      const { offlineDB } = await import('@/components/utils/offlineDatabase');
      const all = await offlineDB.getAll(offlineDB.STORES.RX_TEMP_LOGS);
      record = (all || []).find((l) => l?.driver_id === driverId && l?.delivery_date === deliveryDate) || null;
    } catch { /* non-fatal */ }

    // Step 2: server API (queued) — only if offline DB had nothing
    if (!record) {
      record = await queueEntityRequest(async () => {
        const { base44 } = await import('@/api/base44Client');
        const logs = await base44.entities.RxTempLogs.filter({ driver_id: driverId, delivery_date: deliveryDate });
        return logs?.[0] || null;
      }, `rxTempLogs:${k}`);
    }

    _cache.set(k, { value: record, expiresAt: Date.now() + TTL_MS, promise: null });
    return record;
  })();

  _cache.set(k, { value: undefined, expiresAt: now + TTL_MS, promise });
  return promise;
}

/**
 * Get all RxTempLogs for a date (used by dashboardInitialLoadHelpers).
 * Reads offline DB first; only fetches from server on miss.
 */
export async function getRxTempLogsForDate(deliveryDate) {
  if (!deliveryDate) return [];
  const k = `date:${deliveryDate}`;
  const now = Date.now();

  const entry = _cache.get(k);
  if (entry && entry.expiresAt > now && entry.value !== undefined) {
    return entry.value;
  }
  if (entry?.promise) return entry.promise;

  const promise = (async () => {
    let records = [];
    try {
      const { offlineDB } = await import('@/components/utils/offlineDatabase');
      const all = await offlineDB.getAll(offlineDB.STORES.RX_TEMP_LOGS);
      records = (all || []).filter((l) => l?.delivery_date === deliveryDate);
    } catch { /* non-fatal */ }

    if (records.length === 0) {
      records = await queueEntityRequest(async () => {
        const { base44 } = await import('@/api/base44Client');
        const logs = await base44.entities.RxTempLogs.filter({ delivery_date: deliveryDate });
        return logs || [];
      }, `rxTempLogs:${k}`);
    }

    _cache.set(k, { value: records, expiresAt: Date.now() + TTL_MS, promise: null });
    return records;
  })();

  _cache.set(k, { value: undefined, expiresAt: now + TTL_MS, promise });
  return promise;
}

/**
 * Invalidate the cache for a specific driver+date (call after a new temp
 * is recorded so the next read picks up the fresh data).
 */
export function invalidateRxTempLog(driverId, deliveryDate) {
  if (driverId && deliveryDate) {
    _cache.delete(_key(driverId, deliveryDate));
  }
  if (deliveryDate) {
    _cache.delete(`date:${deliveryDate}`);
  }
}