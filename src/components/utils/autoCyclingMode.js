/**
 * Auto-cycling mode assignment (owner rule, Oct 13 2026)
 * ------------------------------------------------------------------
 * When a driver has an ACTIVE cycling route (start + end markers painted on
 * today's route), any newly created stop — or any stop transitioning through
 * Accept All — that falls inside the cycling range is automatically flagged
 * transport_mode='cycling' BEFORE route optimization, so clientRouteEngine's
 * bicycle sequencing includes it in the cycling pool.
 *
 * Range definition: identical to the cycling mode stop-select dialog
 * (useModeRouteDialog → getNearbyModeStops): a 50 km haversine window measured
 * from the cycling START marker's coords (fallback: END marker coords).
 * The gate is the END marker: no active end marker → feature skipped entirely.
 * Markers are created manually by the driver, so this feature is only ever
 * "armed" on days/routes where the driver deliberately painted them.
 *
 * Explicit choice always wins: callers must NOT run this sweep when the
 * cycling mode dialog ran (the driver picked stops by hand there).
 * Only PATIENT deliveries auto-flip; pickups, InterStore transfers and the
 * markers themselves are always left in driving mode.
 */
import { haversineKm } from '@/components/utils/geoUtils';

// Same radius the cycling mode dialog uses (useModeRouteDialog radiusKm: 50).
export const AUTO_CYCLING_RADIUS_KM = 50;

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

/**
 * Find the active cycling context for a driver+date, if any.
 * Returns { endMarker, startMarker, origin: {lat, lng}, radiusKm } or null.
 * An END marker that is completed/failed/cancelled means the bike loop is
 * done → inactive → feature skipped (owner rule).
 */
export const getActiveCyclingContext = ({ deliveries = [], driverId, deliveryDate }) => {
  if (!driverId || !deliveryDate) return null;
  const markers = (deliveries || []).filter(d => d &&
    d.is_cycling_marker === true &&
    d.driver_id === driverId &&
    d.delivery_date === deliveryDate &&
    !TERMINAL_STATUSES.includes(d.status)
  );
  if (markers.length === 0) return null;

  const endMarker = markers.find(d => String(d.delivery_notes || '').toLowerCase().includes('end'));
  if (!endMarker) return null; // engine falls back to single-pool driving without it too

  const startMarker = markers.find(d => String(d.delivery_notes || '').toLowerCase().includes('start')) || null;
  const _coords = (m) => {
    // Guard null/undefined BEFORE Number(): Number(null) === 0, which would
    // silently turn a coordinate-less marker into lat 0 / lng 0 (null island).
    const rawLat = m?.cycling_latitude;
    const rawLng = m?.cycling_longitude;
    if (rawLat == null || rawLng == null) return null;
    const lat = Number(rawLat);
    const lng = Number(rawLng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  };
  // Distance origin matches getNearbyModeStops: start marker coords first,
  // end marker coords as fallback (they are both in the bike-zone area).
  const origin = _coords(startMarker) || _coords(endMarker);
  if (!origin) return null;

  return { endMarker, startMarker, origin, radiusKm: AUTO_CYCLING_RADIUS_KM };
};

const _patientCoords = (target, patients = []) => {
  const patient = (patients || []).find(p => p && (p.id === target.patient_id || p.patient_id === target.patient_id));
  // Null-guard before Number(): Number(null) === 0 (see _coords).
  if (patient?.latitude == null || patient?.longitude == null) return null;
  const lat = Number(patient.latitude);
  const lng = Number(patient.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
};

/**
 * Returns the subset of `targets` (delivery objects or drafts) that should be
 * auto-flagged cycling: patient deliveries inside the active cycling range
 * for their own driver+date. Does NOT mutate; callers set
 * transport_mode='cycling' on the returned objects.
 */
export const getAutoCyclingTargets = ({ deliveries = [], targets = [], patients = [] }) => {
  const contextCache = new Map(); // "driverId|date" → ctx|null (undefined = not computed)
  const qualify = [];
  for (const target of targets || []) {
    if (!target || target.is_cycling_marker === true) continue;
    if (String(target.transport_mode || '').toLowerCase() === 'cycling') continue; // already cycling
    if (!target.patient_id) continue; // pickups / InterStore stay driving
    const key = `${target.driver_id}|${target.delivery_date}`;
    if (!contextCache.has(key)) {
      contextCache.set(key, getActiveCyclingContext({
        deliveries,
        driverId: target.driver_id,
        deliveryDate: target.delivery_date
      }));
    }
    const ctx = contextCache.get(key);
    if (!ctx) continue; // no active cycling end marker for this driver+date → skip
    const coords = _patientCoords(target, patients);
    if (!coords) continue;
    const distKm = haversineKm(ctx.origin.lat, ctx.origin.lng, coords.lat, coords.lng);
    if (distKm <= ctx.radiusKm) qualify.push(target);
  }
  return qualify;
};
