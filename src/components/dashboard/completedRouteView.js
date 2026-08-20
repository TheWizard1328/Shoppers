// Completed-route overview helpers.
// When a driver's route is finished the dashboard zooms OUT to a city-center
// "30 km radius" overview and locks the map so it cannot zoom back IN past
// that level (the driver can still zoom further out).

export const COMPLETED_ROUTE_RADIUS_KM = 30;
const DEFAULT_MAX_ZOOM = 18;
const METERS_PER_PX_AT_Z0_EQUATOR = 156543.03392;

/**
 * Fractional Leaflet zoom at which a square `radiusKm`-radius box around
 * `latitude` just fits the visible (padded) map area. Any zoom tighter than
 * this would show LESS than the full radius — which we forbid for completed
 * routes, so this value becomes the map's temporary maxZoom.
 *
 * @param {{ latitude: number, radiusKm: number, mapSize?: {x:number,y:number}, padX?: number, padY?: number }} args
 * @returns {number|null}
 */
export function getRadiusFitZoom({ latitude, radiusKm, mapSize, padX = 0, padY = 0 }) {
  const lat = Number(latitude);
  const radius = Number(radiusKm);
  if (!Number.isFinite(lat) || !(radius > 0)) return null;
  if (!mapSize) return null;
  const widthPx = Math.max(1, (mapSize.x || 0) - (padX || 0));
  const heightPx = Math.max(1, (mapSize.y || 0) - (padY || 0));
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const diameterM = radius * 2 * 1000;
  // meters-per-pixel at zoom z = METERS_PER_PX_AT_Z0_EQUATOR * cos(lat) / 2^z
  // visible world meters at z = pixels * metersPerPx
  // require visible >= diameterM  →  2^z <= pixels * METERS * cos(lat) / diameterM
  const scaleFromWidth = (widthPx * METERS_PER_PX_AT_Z0_EQUATOR * cosLat) / diameterM;
  const scaleFromHeight = (heightPx * METERS_PER_PX_AT_Z0_EQUATOR * cosLat) / diameterM;
  const scale = Math.min(scaleFromWidth, scaleFromHeight);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return Math.max(1, Math.log2(scale));
}

/**
 * Build a [SW, NE] bounds box of `radiusKm` around a center point.
 * Square in METERS (not degrees) so the fit looks like a true radius circle.
 * @returns {[[number,number],[number,number]]}
 */
export function getCityRadiusBounds({ latitude, longitude, radiusKm = COMPLETED_ROUTE_RADIUS_KM }) {
  const lat = Number(latitude);
  const lng = Number.longitude || Number(longitude);
  const safeLng = Number.isFinite(lng) ? lng : Number(longitude);
  const latDegPerKm = 1 / 110.574;
  const lonDegPerKm = 1 / (111.32 * Math.cos((lat * Math.PI) / 180));
  const latOff = radiusKm * latDegPerKm;
  const lonOff = radiusKm * lonDegPerKm;
  return [
    [lat - latOff, safeLng - lonOff],
    [lat + latOff, safeLng + lonOff],
  ];
}

/**
 * Resolve the city to center on for a completed route.
 * Priority: explicit selected-city filter → driver's assigned city(ies) → first city.
 * Returns { latitude, longitude } or null.
 */
export function resolveCompletedRouteCity({ cities, currentUser, selectedCityId }) {
  const safeCities = Array.isArray(cities) ? cities : [];
  const hasCoords = (c) => !!c && Number.isFinite(Number(c.latitude)) && Number.isFinite(Number(c.longitude));

  // 1. The active city filter (matches the "city center" the dashboard is scoped to)
  if (selectedCityId) {
    const sc = safeCities.find((c) => c && c.id === selectedCityId);
    if (hasCoords(sc)) return { latitude: Number(sc.latitude), longitude: Number(sc.longitude) };
  }

  // 2. Driver's assigned city (city_id or first of city_ids)
  const userCityIds = currentUser?.city_ids || (currentUser?.city_id ? [currentUser.city_id] : []);
  for (const cid of userCityIds) {
    const c = safeCities.find((x) => x && x.id === cid);
    if (hasCoords(c)) return { latitude: Number(c.latitude), longitude: Number(c.longitude) };
  }

  // 3. Any city with coords
  const any = safeCities.find(hasCoords);
  return any ? { latitude: Number(any.latitude), longitude: Number(any.longitude) } : null;
}

export const DEFAULT_MAP_MAX_ZOOM = DEFAULT_MAX_ZOOM;