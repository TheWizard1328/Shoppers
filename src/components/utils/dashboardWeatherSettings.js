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
const STALE_MS = 5 * 60 * 1000;
let _cached = null;
let _fetchedAt = 0;
let _fetchPromise = null;
let _lastClientPoll = 0;

/**
 * Stale-on-load trigger: when the stored snapshot is older than 5 minutes,
 * fire ONE background poll (throttled to one attempt per 5 minutes across
 * all loads). The backend function re-fetches the weather and writes the
 * AppSettings record ONLY if something changed; after it resolves we
 * re-read and re-broadcast so the bar updates even if the WebSocket event
 * from the entity write never arrives on this device.
 */
function triggerClientPollIfStale(payload) {
  const fetchedAtMs = payload?.fetched_at ? new Date(payload.fetched_at).getTime() : NaN;
  const ageMs = Number.isFinite(fetchedAtMs) ? Date.now() - fetchedAtMs : Infinity;
  if (ageMs < STALE_MS) return; // fresh enough — nothing to do
  if (Date.now() - _lastClientPoll < STALE_MS) return; // already tried recently
  _lastClientPoll = Date.now();
  base44.functions.invoke('dashboardWeatherPoll', { client_refresh: true })
    .then(() => getDashboardWeather({ force: true }))
    .then(() => {
      try { window.dispatchEvent(new CustomEvent('appSettingsUpdated', { detail: { key: 'dashboard_weather' } })); } catch { /* non-fatal */ }
    })
    .catch(() => { /* stale data beats a broken dashboard */ });
}

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
      // App load / re-read with data older than 5 minutes → refresh it now.
      triggerClientPollIfStale(_cached);
      return _cached;
    } catch {
      return _cached; // never throw — stale data beats a broken dashboard
    } finally {
      _fetchPromise = null;
    }
  })();
  return _fetchPromise;
}
