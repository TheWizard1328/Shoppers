/**
 * appSettingsCache.js
 *
 * Offline-first access layer for the AppSettings entity — the app's most
 * heavily-read online entity (30+ call sites, ~20 on hot paths: boot,
 * sidebar, stop cards, weather, Square, payroll). Every read used to be a
 * direct base44.entities.AppSettings.filter() API call with no persistence.
 *
 * Read order (per setting_key):
 *   1. Memory cache (TTL 60s, shared by every caller).
 *   2. IndexedDB `app_settings` store (v23) — returns instantly and, if the
 *      rows are older than the background-refresh age, silently revalidates
 *      from the API (stale-while-revalidate).
 *   3. API fallback — filters via requestQueue (rate-limit safe), upserts the
 *      result into IndexedDB for next boot.
 *
 * Live updates: the AppSettings entity WebSocket broadcasts an
 * `appSettingsUpdated` window event with the full changed record. The
 * self-registering listener below refreshes memory + IndexedDB immediately,
 * so admin edits propagate without any API refetch.
 *
 * Callers that READ-then-WRITE AppSettings (admin dialogs, messageCleaner's
 * status stamp) should use getFreshAppSettingRows() for the pre-write read.
 */

import { base44 } from '@/api/base44Client';
import { queueEntityRequest } from '@/components/utils/requestQueue';

const MEMORY_TTL_MS = 60 * 1000;            // memory cache validity
const IDB_BG_REFRESH_MS = 10 * 60 * 1000;   // IDB rows older than this -> background revalidate

// setting_key -> { rows: Array, fetchedAt: number }
const _memory = new Map();
// setting_key -> Promise<Array> (in-flight API fetch dedup)
const _inflight = new Map();

let _listenerBound = false;

const _bindWsListener = () => {
  if (_listenerBound || typeof window === 'undefined') return;
  _listenerBound = true;
  window.addEventListener('appSettingsUpdated', (event) => {
    const updated = event?.detail?.data || event?.detail;
    if (!updated?.setting_key) return;
    // Optimistically apply the broadcast record to memory + IndexedDB.
    _memory.set(updated.setting_key, { rows: [updated], fetchedAt: Date.now() });
    (async () => {
      try {
        const { offlineDB } = await import('@/components/utils/offlineDatabase');
        await offlineDB.save(offlineDB.STORES.APP_SETTINGS, { ...updated, _fetched_at: Date.now() });
      } catch (_) { /* non-critical */ }
    })();
  });
};

const _loadIdbRows = async (settingKey) => {
  try {
    const { offlineDB } = await import('@/components/utils/offlineDatabase');
    return await offlineDB.getByIndex(offlineDB.STORES.APP_SETTINGS, 'setting_key', settingKey);
  } catch (_) { return null; }
};

const _saveIdbRows = async (settingKey, rows) => {
  try {
    const { offlineDB } = await import('@/components/utils/offlineDatabase');
    const stamped = (rows || []).map((r) => ({ ...r, _fetched_at: Date.now() }));
    // Upsert fresh rows; prune same-key rows the API no longer returns (renamed/removed settings).
    const existing = await offlineDB.getByIndex(offlineDB.STORES.APP_SETTINGS, 'setting_key', settingKey).catch(() => []);
    const freshIds = new Set(stamped.map((r) => r.id));
    for (const old of existing || []) {
      if (old?.id && !freshIds.has(old.id)) {
        await offlineDB.deleteRecord(offlineDB.STORES.APP_SETTINGS, old.id).catch(() => {});
      }
    }
    if (stamped.length) await offlineDB.bulkSave(offlineDB.STORES.APP_SETTINGS, stamped);
  } catch (_) { /* non-critical */ }
};

const _fetchFromApi = (settingKey) => {
  _bindWsListener();
  let p = _inflight.get(settingKey);
  if (p) return p;
  p = queueEntityRequest(async () => {
    const rows = await base44.entities.AppSettings.filter({ setting_key: settingKey });
    const list = rows || [];
    _memory.set(settingKey, { rows: list, fetchedAt: Date.now() });
    await _saveIdbRows(settingKey, list);
    return list;
  }, `appSettingsCache:${settingKey}`);
  _inflight.set(settingKey, p);
  p.catch(() => {}).finally(() => _inflight.delete(settingKey));
  return p;
};

/**
 * Get all AppSettings rows for a setting key — offline-first.
 * @returns {Promise<Array>} rows (empty array when unknown/offline with no cache)
 */
export async function getAppSettingRows(settingKey) {
  if (!settingKey) return [];
  _bindWsListener();

  const mem = _memory.get(settingKey);
  if (mem && Date.now() - mem.fetchedAt < MEMORY_TTL_MS) return mem.rows;

  const idbRows = await _loadIdbRows(settingKey);
  if (idbRows && idbRows.length > 0) {
    _memory.set(settingKey, { rows: idbRows, fetchedAt: Date.now() });
    const oldest = idbRows.reduce((m, r) => Math.min(m, r?._fetched_at || 0), Infinity);
    if (Date.now() - oldest > IDB_BG_REFRESH_MS) _fetchFromApi(settingKey).catch(() => {});
    return idbRows;
  }

  try {
    return await _fetchFromApi(settingKey);
  } catch (_) {
    return [];
  }
}

/**
 * Convenience: setting_value of the first row (single-row settings).
 * @returns {Promise<*|null>}
 */
export async function getAppSettingValue(settingKey) {
  const rows = await getAppSettingRows(settingKey);
  return rows?.[0]?.setting_value ?? null;
}

/**
 * Authoritative read (skips memory + IDB). Use for read-modify-write flows
 * (admin dialogs, status stamps) where a stale pre-write read would clobber
 * concurrent edits.
 */
export async function getFreshAppSettingRows(settingKey) {
  if (!settingKey) return [];
  _bindWsListener();
  try {
    return await _fetchFromApi(settingKey);
  } catch (_) {
    return [];
  }
}

/**
 * Force-refresh a key from the API (call after admin saves outside the WS flow).
 */
export async function refreshAppSetting(settingKey) {
  if (!settingKey) return [];
  try {
    return await _fetchFromApi(settingKey);
  } catch (_) {
    return [];
  }
}
