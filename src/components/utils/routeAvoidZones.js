/**
 * routeAvoidZones — shared "blocked area" system for HERE routing.
 *
 * Owner rule (Oct 2 2026): cycling routes keep sending riders down rough back
 * alleys — bumpy surface + blind intersections. Riders would rather take main
 * and sub roads, sidewalks and bike paths. HERE has no "avoid alleys" flag, so we
 * give drivers/owner a simple tool: tap an alley on the map once, it becomes a
 * saved RouteAvoidZone (shared across all users, no RLS), and every cycling
 * polyline request feeds the zones near the route to HERE as
 * `avoid[areas]=bbox:w,s,e,n|bbox:...` (verified live: the route detours
 * around a blocked box; pipe-separated list, max 20 areas, 250 total boxes).
 * Cycling requests also set `avoid[features]=dirtRoad` for rough surfaces.
 *
 * Zones apply to CYCLING polylines only — driving routes are untouched so
 * existing car/driver routes don't silently change shape.
 */

const CACHE_TTL_MS = 60 * 1000;
const MAX_AREAS = 20;          // HERE cap on avoid areas per request
const NEARBY_METERS = 2000;     // only zones within 2 km of any route point

let _zones = null;
let _fetchedAt = 0;
let _inflight = null;

export function clearAvoidZoneCache() {
  _zones = null;
  _fetchedAt = 0;
  _inflight = null;
}

export async function fetchAvoidZones({ force = false } = {}) {
  const fresh = _zones && (Date.now() - _fetchedAt < CACHE_TTL_MS);
  if (fresh && !force) return _zones;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const { base44 } = await import('@/api/base44Client');
      const zones = [];
      // Zone lists are tiny; paginate defensively anyway.
      let skip = 0;
      for (;;) {
        const page = await base44.entities.RouteAvoidZone.list({ limit: 500, skip });
        const rows = page?.items || page || [];
        if (!Array.isArray(rows) || rows.length === 0) break;
        zones.push(...rows);
        if (rows.length < 500) break;
        skip += 500;
        if (skip >= 5000) break; // hard safety cap
      }
      _zones = zones;
      _fetchedAt = Date.now();
      return zones;
    } catch (_) {
      // Never let zone fetching break route generation — caller falls back to
      // no avoid areas (same behavior as before this feature existed).
      return _zones || [];
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Zones near the route's points, as a HERE `avoid[areas]` value string.
 * Returns '' when there is nothing relevant to block.
 */
export function zonesToAvoidAreasParam(zones, points, { maxAreas = MAX_AREAS, nearbyMeters = NEARBY_METERS } = {}) {
  if (!Array.isArray(zones) || zones.length === 0) return '';
  const pts = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (pts.length === 0) return '';

  const areas = [];
  for (const z of zones) {
    const lat = Number(z?.center_lat);
    const lng = Number(z?.center_lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const r = Math.max(15, Math.min(400, Number(z?.radius_meters) || 60));
    // Only send zones that can plausibly touch this route (keeps the URL
    // short and away from HERE's area caps on busy city days).
    const near = pts.some((p) => haversineMeters(lat, lng, Number(p.lat), Number(p.lon)) <= nearbyMeters + r);
    if (!near) continue;
    const dLat = r / 111320;
    const dLng = r / (111320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
    const south = Math.max(-90, lat - dLat).toFixed(6);
    const north = Math.min(90, lat + dLat).toFixed(6);
    const west = Math.max(-180, lng - dLng).toFixed(6);
    const east = Math.min(180, lng + dLng).toFixed(6);
    areas.push(`bbox:${west},${south},${east},${north}`);
    if (areas.length >= maxAreas) break;
  }
  return areas.join('|');
}
