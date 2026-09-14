/**
 * winterModeSettings — central access to the Winter Mode app settings.
 *
 * Stored in AppSettings (setting_key 'refresh_intervals'), inside
 * setting_value.winter_mode:
 *   {
 *     enabled: boolean,        // master toggle
 *     eta_factor: number,      // multiplier for fresh leg durations (1.25 = +25%)
 *     gps_snap_km: number,     // proximity-snap radius in km (default 0.15 = 150m)
 *     arrival_radius_m: number,// arrival geofence radius in meters (default 150)
 *     cold_threshold_c: number // briefing cold-warning threshold in °C
 *   }
 *
 * Winter Mode (owner spec, Sep 2026): pads ETAs, raises GPS-drift tolerance
 * in the arrival/proximity-snap logic, and enables cold-weather warnings in
 * the daily driver briefing. It does NOT touch cycling-route logic.
 *
 * Cached with a 5-minute TTL so hot paths (every optimization, every GPS
 * tick) read from memory instead of hitting the API. 'appSettingsUpdated'
 * events invalidate the cache immediately when an admin saves settings.
 */

import { base44 } from '@/api/base44Client';

export const DEFAULT_WINTER_MODE = Object.freeze({
  enabled: false,
  eta_factor: 1.25,
  gps_snap_km: 0.15,
  arrival_radius_m: 150,
  cold_threshold_c: -10,
});

const CACHE_TTL_MS = 5 * 60 * 1000;
let _cached = null;       // merged settings object
let _fetchedAt = 0;
let _fetchPromise = null;

export function invalidateWinterModeCache() {
  _cached = null;
  _fetchedAt = 0;
}

/**
 * Async getter — returns cached settings when fresh; otherwise fetches
 * (single-flight). Never throws: falls back to cached/defaults on failure.
 */
export async function getWinterModeSettings({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cached && now - _fetchedAt < CACHE_TTL_MS) return _cached;
  if (_fetchPromise) return _fetchPromise;
  _fetchPromise = (async () => {
    try {
      const rows = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
      const raw = rows?.[0]?.setting_value?.winter_mode;
      const merged = { ...DEFAULT_WINTER_MODE, ...(raw && typeof raw === 'object' ? raw : {}) };
      // Sanity clamps
      if (!Number.isFinite(merged.eta_factor) || merged.eta_factor < 1 || merged.eta_factor > 3) merged.eta_factor = DEFAULT_WINTER_MODE.eta_factor;
      if (!Number.isFinite(merged.gps_snap_km) || merged.gps_snap_km <= 0 || merged.gps_snap_km > 1) merged.gps_snap_km = DEFAULT_WINTER_MODE.gps_snap_km;
      if (!Number.isFinite(merged.arrival_radius_m) || merged.arrival_radius_m <= 0) merged.arrival_radius_m = DEFAULT_WINTER_MODE.arrival_radius_m;
      if (!Number.isFinite(merged.cold_threshold_c)) merged.cold_threshold_c = DEFAULT_WINTER_MODE.cold_threshold_c;
      merged.enabled = merged.enabled === true;
      _cached = merged;
      _fetchedAt = Date.now();
      return merged;
    } catch {
      // Fetch failed — keep whatever we had, or defaults
      _cached = _cached || { ...DEFAULT_WINTER_MODE };
      return _cached;
    } finally {
      _fetchPromise = null;
    }
  })();
  return _fetchPromise;
}

/**
 * Synchronous read of the last-known settings (defaults before first fetch).
 * Use in sync hot paths; pair with a mount-time getWinterModeSettings() call
 * to keep the cache warm.
 */
export function getCachedWinterModeSync() {
  return _cached || DEFAULT_WINTER_MODE;
}

// Auto-invalidate when an admin saves app settings (AppSettingsPanel dispatch).
if (typeof window !== 'undefined') {
  window.addEventListener?.('appSettingsUpdated', () => invalidateWinterModeCache());
}
