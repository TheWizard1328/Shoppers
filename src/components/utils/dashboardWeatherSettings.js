/**
 * dashboardWeatherSettings — central access to the dashboard weather-bar data.
 *
 * Stored in AppSettings (setting_key 'dashboard_weather'), written ONLY by the
 * dashboardWeatherPoll backend function (runs every 5 minutes via the
 * "Dashboard Weather Poll" workflow). Payload:
 *   { cities: { [cityId]: { city_id, city_name, temp, feels, text, icon,
 *                 high, low, precipProb, snowCm, wind, forecast, source } },
 *     fetched_at }
 *
 * icon buckets (from WMO code / provider text): sun / partly / cloud / fog /
 * rain / snow / storm.
 *
 * Clients NEVER hit weather APIs — they read this record. The AppSettings
 * WebSocket subscription broadcasts every poll write as 'appSettingsUpdated',
 * and the weather bar re-reads on that event. Cached with a TTL so hot paths
 * read from memory.
 */

import { base44 } from '@/api/base44Client';

const CACHE_TTL_MS = 10 * 60 * 1000;
let _cached = null;
let _fetchedAt = 0;
let _fetchPromise = null;

export function invalidateDashboardWeatherCache() {
  _cached = null;
  _fetchedAt = 0;
}

/**
 * Async getter — returns the cached record when fresh; otherwise fetches
 * (single-flight). Never throws: falls back to the last cached value.
 */
export async function getDashboardWeather({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cached && now - _fetchedAt < CACHE_TTL_MS) return _cached;
  if (_fetchPromise) return _fetchPromise;
  _fetchPromise = (async () => {
    try {
      const rows = await base44.entities.AppSettings.filter({ setting_key: 'dashboard_weather' });
      const raw = rows?.[0]?.setting_value || null;
      _cached = raw && typeof raw === 'object' && raw.cities && typeof raw.cities === 'object' ? raw : null;
      _fetchedAt = Date.now();
      return _cached;
    } catch {
      return _cached; // never throw — stale data beats a broken dashboard
    } finally {
      _fetchPromise = null;
    }
  })();
  return _fetchPromise;
}
