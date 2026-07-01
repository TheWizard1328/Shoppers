/**
 * statHolidayResolver — shared utility for stat holiday lookups.
 * Reads from offline DB first (instant), falls back to API, persists to offline DB.
 */
import { base44 } from '@/api/base44Client';

let _cache = null; // array of StatHoliday records
let _loadPromise = null;

export async function loadStatHolidays() {
  if (_cache) return _cache;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      // Try offline DB first (fast, no API call)
      const { offlineDB } = await import('./offlineDatabase');
      const offline = await offlineDB.getAll(offlineDB.STORES.STAT_HOLIDAYS);
      if (offline && offline.length > 0) {
        _cache = offline;
        _loadPromise = null;
        // Refresh from server in the background without blocking
        base44.entities.StatHoliday.list().then(async (records) => {
          if (records && records.length > 0) {
            _cache = records;
            await offlineDB.replaceAllRecords(offlineDB.STORES.STAT_HOLIDAYS, records);
          }
        }).catch(() => {});
        return _cache;
      }
    } catch (_) { /* offline DB unavailable — fall through to API */ }

    // Not in offline DB — fetch from API and persist
    try {
      const records = await base44.entities.StatHoliday.list();
      _cache = records || [];
      _loadPromise = null;
      if (_cache.length > 0) {
        import('./offlineDatabase').then(({ offlineDB }) =>
          offlineDB.replaceAllRecords(offlineDB.STORES.STAT_HOLIDAYS, _cache).catch(() => {})
        );
      }
      return _cache;
    } catch {
      _loadPromise = null;
      _cache = [];
      return [];
    }
  })();
  return _loadPromise;
}

export function invalidateStatHolidayCache() {
  _cache = null;
}

/** Returns the StatHoliday record for a date string (YYYY-MM-DD), or null. */
export function getStatHoliday(dateStr, holidays) {
  if (!dateStr || !Array.isArray(holidays)) return null;
  return holidays.find((h) => h.date === dateStr) || null;
}

/** Returns true if the given date string is a stat holiday. */
export function isStatHoliday(dateStr, holidays) {
  return !!getStatHoliday(dateStr, holidays);
}