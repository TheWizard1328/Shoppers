// ── Polyline routing preferences (owner request Oct 29 2026) ─────────────────
// The polyline generator used to send the BARE minimum to the routing provider:
// origin + destination + via points. Nothing told Google/HERE whether the driver
// wants live traffic factored in, or whether "best" should mean the quickest
// road, the shortest distance, or the provider's own recommendation.
//
// Two preferences, both app-wide, edited in the Route Optimization Settings
// panel and stored on the shared AppSettings 'route_optimization' record:
//   trafficAware     — factor live/typical traffic into the drive times
//                      (Google: departure_time=now + traffic_model=best_guess,
//                       HERE: departureTime=now)
//   routePreference  — 'fastest' | 'shortest' | 'best' (exactly one active)
// NOTE on Google: the Directions API only honours `alternatives` when the
// request has NO intermediate waypoints, so for a multi-stop chain Google
// returns its own recommendation and the comparison below simply keeps it.
// HERE has a real distance mode (routingMode=short) and needs no alternatives.
//
//                      fastest  → provider default quickest route, no detour
//                      shortest → fewest kilometres (alternatives compared on
//                                 distance; HERE routingMode=short)
//                      best     → provider's recommendation among alternatives
//                                 (highest-quality full-length comparison)
//
// Read SYNCHRONOUSLY during polyline generation, so the values are cached here
// and refreshed: seeded at boot/save, on the 'routeOptimizationSettingsSaved'
// event, and lazily once per TTL when nothing has seeded them yet.

export const ROUTE_PREFERENCE_VALUES = ['fastest', 'shortest', 'best'];

export const POLYLINE_ROUTE_PREF_DEFAULTS = {
  trafficAware: false,
  routePreference: 'fastest',
};

const TTL_MS = 5 * 60 * 1000;

let _prefs = { ...POLYLINE_ROUTE_PREF_DEFAULTS };
let _loadedAt = 0;
let _inflight = null;

const normalize = (raw) => {
  const src = (raw && typeof raw === 'object') ? raw : {};
  return {
    trafficAware: src.trafficAware === true,
    routePreference: ROUTE_PREFERENCE_VALUES.includes(src.routePreference)
      ? src.routePreference
      : POLYLINE_ROUTE_PREF_DEFAULTS.routePreference,
  };
};

/** Seed from an AppSettings 'route_optimization' setting_value object. */
export const seedPolylineRoutePrefs = (settingValue) => {
  if (!settingValue || typeof settingValue !== 'object') return getPolylineRoutePrefs();
  _prefs = normalize({
    trafficAware: settingValue.polylineTrafficAware,
    routePreference: settingValue.polylineRoutePreference,
  });
  _loadedAt = Date.now();
  if (typeof window !== 'undefined') window.__polylineRoutePrefs = { ..._prefs };
  return { ..._prefs };
};

/** Synchronous read used by the generators. Never throws, never blocks. */
export const getPolylineRoutePrefs = () => {
  if (typeof window !== 'undefined' && window.__polylineRoutePrefs) {
    _prefs = normalize(window.__polylineRoutePrefs && {
      trafficAware: window.__polylineRoutePrefs.trafficAware,
      routePreference: window.__polylineRoutePrefs.routePreference,
    });
  }
  return { ..._prefs };
};

/** Load once from AppSettings (cheap, deduped) — call when booting the map. */
export const loadPolylineRoutePrefs = async () => {
  if (Date.now() - _loadedAt < TTL_MS) return getPolylineRoutePrefs();
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const { getAppSettingRows } = await import('./appSettingsCache');
      const rows = await getAppSettingRows('route_optimization');
      const value = rows?.[0]?.setting_value;
      if (value && typeof value === 'object') seedPolylineRoutePrefs(value);
    } catch (_) { /* offline — keep the cached/default prefs */ }
    _loadedAt = Date.now();
    _inflight = null;
    return getPolylineRoutePrefs();
  })();
  return _inflight;
};

export const invalidatePolylineRoutePrefs = () => { _loadedAt = 0; };
