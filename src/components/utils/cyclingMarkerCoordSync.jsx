/**
 * cyclingMarkerCoordSync
 *
 * OWNER RULE (Nov 27 2026): "Cycling markers always use the CyclingLocation
 * coords before the delivery location coords, and update the delivery coords if
 * they are different."
 *
 * A cycling marker (start or end) is a Delivery row that only stores
 * `cycling_location_name` — no foreign key. The saved spot lives in the
 * CyclingLocation entity, and the two copies drifted apart whenever the saved
 * spot moved (e.g. Update GPS on a marker, or an edit in the cycling dialog)
 * without every marker of that route being rewritten.
 *
 * This module is the single reconciliation path:
 *   - match a marker to its saved spot by name (same city preferred)
 *   - if the marker's coords differ by more than MIN_METERS, write the SAVED
 *     spot's coords down into the delivery (local-first via updateDeliveryLocal)
 *   - report what moved so callers can log / re-polylines
 */

import { updateDeliveryLocal } from './offlineMutations';

export const normalizeCyclingName = (value) => String(value || '').trim().toLowerCase();

const R = 6371000;
export const metersBetween = (lat1, lng1, lat2, lng2) => {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
};

/** Match a cycling marker to its saved CyclingLocation spot (name, same city first). */
export const matchCyclingLocation = (marker, locations) => {
  const name = normalizeCyclingName(marker?.cycling_location_name);
  if (!name) return null;
  const named = (locations || []).filter((loc) => normalizeCyclingName(loc?.name) === name);
  if (!named.length) return null;
  const cityId = marker?.city_id || null;
  return named.find((loc) => !cityId || !loc?.city_id || loc.city_id === cityId) || named[0] || null;
};

/**
 * Push the saved spot's coords down onto one marker record when they differ.
 * Returns { moved, marker, location } — moved=false when already in sync.
 */
export const syncMarkerToLocation = async (marker, location, { minMeters = 1.5 } = {}) => {
  const lat = Number(location?.latitude);
  const lng = Number(location?.longitude);
  if (!marker?.id || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { moved: false, marker, location };
  }
  const mLat = Number(marker.cycling_latitude ?? marker.latitude);
  const mLng = Number(marker.cycling_longitude ?? marker.longitude);
  if (Number.isFinite(mLat) && Number.isFinite(mLng) && metersBetween(mLat, mLng, lat, lng) < minMeters) {
    return { moved: false, marker, location };
  }
  await updateDeliveryLocal(marker.id, {
    cycling_latitude: lat,
    cycling_longitude: lng,
    latitude: lat,
    longitude: lng,
  });
  return { moved: true, marker, location, latitude: lat, longitude: lng };
};

/**
 * Reconcile every cycling marker handed in against the saved spot library.
 * Returns the list of markers that were rewritten.
 */
export const reconcileCyclingMarkers = async ({ deliveries = [], locations = [], minMeters = 1.5 } = {}) => {
  const moved = [];
  for (const marker of deliveries || []) {
    if (!marker?.is_cycling_marker) continue;
    const location = matchCyclingLocation(marker, locations);
    if (!location) continue;
    try {
      const result = await syncMarkerToLocation(marker, location, { minMeters });
      if (result.moved) {
        moved.push({ id: marker.id, name: location.name, latitude: result.latitude, longitude: result.longitude });
      }
    } catch (err) {
      console.warn('[cyclingMarkerCoordSync] marker not synced:', marker?.id, err?.message);
    }
  }
  if (moved.length) {
    console.log(`[cyclingMarkerCoordSync] pulled saved spot coords onto ${moved.length} cycling marker(s):`,
      moved.map((m) => `${m.name}(${m.id?.slice(0, 6)})`).join(', '));
  }
  return moved;
};
