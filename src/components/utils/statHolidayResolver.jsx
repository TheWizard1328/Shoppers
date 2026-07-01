/**
 * statHolidayResolver — shared utility for stat holiday lookups.
 * Caches the loaded holidays for the session to avoid redundant API calls.
 */
import { base44 } from '@/api/base44Client';

let _cache = null; // array of StatHoliday records
let _loadPromise = null;

export async function loadStatHolidays() {
  if (_cache) return _cache;
  if (_loadPromise) return _loadPromise;
  _loadPromise = base44.entities.StatHoliday.list().then((records) => {
    _cache = records || [];
    _loadPromise = null;
    return _cache;
  }).catch(() => {
    _loadPromise = null;
    _cache = [];
    return [];
  });
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