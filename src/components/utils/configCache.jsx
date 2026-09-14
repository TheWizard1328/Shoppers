/**
 * configCache.jsx
 *
 * Centralized in-memory cache for small, rarely-changing config entities
 * (AppSettings, RemoteLoggingSettings, DemoSettings, DriverScheduleOverride).
 *
 * Every fetch goes through requestQueue so config reads can never burst
 * past the API rate limit. Duplicate callers (e.g. AppSidebar + LiveTempBadge
 * both fetching AppSettings.refresh_intervals) share a single queued request
 * via the in-flight promise dedup.
 *
 * TTL keeps the cache fresh without re-hitting the API on every mount.
 */

import { base44 } from '@/api/base44Client';
import { queueEntityRequest } from '@/components/utils/requestQueue';

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

// cache: Map<string, { value, expiresAt, promise? }>
const _cache = new Map();

const _buildKey = (entityName, filterObj) => {
  try {
    return `${entityName}:${JSON.stringify(filterObj || {})}`;
  } catch {
    return `${entityName}:${String(filterObj)}`;
  }
};

/**
 * Fetch a config entity with caching + queue routing.
 * Returns the first row (most configs are single-row) or null.
 *
 * @param {string} entityName  - e.g. 'AppSettings', 'RemoteLoggingSettings'
 * @param {object} filterObj   - filter passed to entity.filter()
 * @param {object} opts        - { ttlMs, sort, limit, force }
 * @returns {Promise<object|null>}
 */
export async function getCachedConfigRow(entityName, filterObj = {}, opts = {}) {
  const { ttlMs = DEFAULT_TTL_MS, sort, limit, force = false } = opts;
  const key = _buildKey(entityName, filterObj);

  const entry = _cache.get(key);
  const now = Date.now();

  if (!force && entry && entry.expiresAt > now && entry.value !== undefined) {
    return entry.value;
  }

  // Dedup: if a fetch for this key is already in-flight, piggyback on it
  if (entry?.promise) {
    return entry.promise;
  }

  const promise = queueEntityRequest(async () => {
    const rows = await base44.entities[entityName].filter(filterObj, sort, limit);
    const row = (rows && rows.length > 0) ? rows[0] : null;
    _cache.set(key, { value: row, expiresAt: Date.now() + ttlMs, promise: null });
    return row;
  }, `configCache:${entityName}`);

  _cache.set(key, { value: undefined, expiresAt: now + ttlMs, promise });
  return promise;
}

/**
 * Fetch all rows for a config entity (when you need the full set, not just
 * the first row).
 */
export async function getCachedConfigRows(entityName, filterObj = {}, opts = {}) {
  const { ttlMs = DEFAULT_TTL_MS, sort, limit, force = false } = opts;
  const key = _buildKey(entityName, filterObj);

  const entry = _cache.get(key);
  const now = Date.now();

  if (!force && entry && entry.expiresAt > now && entry.value !== undefined) {
    return entry.value;
  }

  if (entry?.promise) {
    return entry.promise;
  }

  const promise = queueEntityRequest(async () => {
    const rows = await base44.entities[entityName].filter(filterObj, sort, limit);
    _cache.set(key, { value: rows || [], expiresAt: Date.now() + ttlMs, promise: null });
    return rows || [];
  }, `configCache:${entityName}`);

  _cache.set(key, { value: undefined, expiresAt: now + ttlMs, promise });
  return promise;
}

/**
 * Invalidate a specific cached key (call after an update so the next read
 * re-fetches). If no filter is passed, clears all keys for that entity.
 */
export function invalidateConfigCache(entityName, filterObj = null) {
  if (filterObj === null) {
    for (const k of _cache.keys()) {
      if (k.startsWith(`${entityName}:`)) _cache.delete(k);
    }
  } else {
    _cache.delete(_buildKey(entityName, filterObj));
  }
}

// ── Convenience wrappers for the most common config entities ──────────────

export async function getAppSettings(force = false) {
  return getCachedConfigRow('AppSettings', { setting_key: 'refresh_intervals' }, { force });
}

export async function getRemoteLoggingSettings(force = false) {
  return getCachedConfigRow('RemoteLoggingSettings', { scope: 'global' }, { sort: '-updated_date', limit: 100, force });
}

export async function getDemoSettings(userId, force = false) {
  if (!userId) return null;
  return getCachedConfigRow('DemoSettings', { user_id: userId }, { force });
}

export async function getBookedOffOverrides(force = false) {
  return getCachedConfigRows('DriverScheduleOverride', { driver_id: '__booked_off__' }, { force });
}