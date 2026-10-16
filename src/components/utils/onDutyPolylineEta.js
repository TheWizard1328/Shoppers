// Duty-resume ETA re-anchor (owner spec, Oct 16 2026):
// On toggling on_duty, derive the next stop's arrival from the driver's
// CURRENT POSITION ALONG the current leg's polyline (ZERO API calls), then
// chain ALL remaining stops via the ETA calculator (etaCascadeUtil).
// If the driver is off-path (> threshold) or the leg polyline is missing,
// return mode 'fallback' — the caller runs the full path (current-leg
// polyline regeneration + routing-call ETA projection for the whole chain).
import { decodeGooglePolyline } from './routePolylineGenerator';
import { haversineMeters } from './geoUtils';
import { computeCascadeEtas } from './etaCascadeUtil';

// Same threshold as the route deviation monitor (200m).
export const DUTY_RESUME_DEVIATION_THRESHOLD_M = 200;

// Point-wise projection onto a decoded polyline: nearest vertex distance
// (deviation) + remaining distance along the polyline from that vertex.
// Polyline vertex density (HERE/Google) makes point-wise nearest accurate
// enough for ETA scaling; no segment interpolation needed.
export const projectOntoPolyline = (encodedPolyline, { lat, lng }) => {
  const pts = decodeGooglePolyline(encodedPolyline);
  if (!Array.isArray(pts) || pts.length < 2) return null;
  const cumulative = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    total += haversineMeters(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    cumulative.push(total);
  }
  let nearestIdx = -1;
  let nearestDist = Infinity;
  for (let i = 0; i < pts.length; i += 1) {
    const d = haversineMeters(lat, lng, pts[i][0], pts[i][1]);
    if (d < nearestDist) {
      nearestDist = d;
      nearestIdx = i;
    }
  }
  if (nearestIdx < 0) return null;
  return {
    deviatedMeters: nearestDist,
    remainingMeters: Math.max(0, total - cumulative[nearestIdx]),
    totalMeters: total,
    nearestIdx,
  };
};

// orderedStops: the driver's remaining stops sorted by stop_order; [0] = next
// stop and must carry encoded_polyline (the leg INTO it, stored on the stop)
// and estimated_duration_minutes (that leg's travel time).
// nowMinutes: current time in wall-clock minutes (device-local, same
// convention as the Start fast path — driver devices are Edmonton).
// Returns { mode: 'polyline', etaUpdates, remainingMinutes, ... } or
// { mode: 'fallback', reason }.
export const computeDutyResumeEtas = ({
  orderedStops,
  currentLocation,
  nowMinutes,
  deviationThresholdM = DUTY_RESUME_DEVIATION_THRESHOLD_M,
}) => {
  const nextStop = orderedStops?.[0] || null;
  if (!nextStop?.id) return { mode: 'fallback', reason: 'no_next_stop' };
  if (!Number.isFinite(Number(currentLocation?.lat)) || !Number.isFinite(Number(currentLocation?.lng))) {
    return { mode: 'fallback', reason: 'no_location' };
  }
  if (typeof nextStop.encoded_polyline !== 'string' || nextStop.encoded_polyline.length < 10) {
    return { mode: 'fallback', reason: 'no_leg_polyline' };
  }
  if (!Number.isFinite(Number(nowMinutes))) return { mode: 'fallback', reason: 'no_now_minutes' };

  const proj = projectOntoPolyline(nextStop.encoded_polyline, currentLocation);
  if (!proj) return { mode: 'fallback', reason: 'decode_failed' };
  if (proj.deviatedMeters > deviationThresholdM) {
    return { mode: 'fallback', reason: 'off_path', deviatedMeters: Math.round(proj.deviatedMeters) };
  }

  // Travel from the projected point to the next stop: scale the leg's stored
  // travel time by the remaining share of the polyline. No stored duration →
  // 35 km/h distance estimate (existing retro-fallback convention, 2-min floor).
  const legMinutes = Number(nextStop.estimated_duration_minutes);
  let remainingMinutes;
  if (Number.isFinite(legMinutes) && legMinutes > 0 && proj.totalMeters > 50) {
    remainingMinutes = Math.max(1, Math.round(legMinutes * (proj.remainingMeters / proj.totalMeters)));
  } else {
    remainingMinutes = Math.max(2, Math.round(((proj.remainingMeters / 1000) / 35) * 60));
  }
  if (proj.remainingMeters < 50) remainingMinutes = Math.min(remainingMinutes, 1);

  // ETA-calculator cascade (regular rules: window-floor clamp stays ON):
  // first stop's travel = remaining minutes from the projected position;
  // every later stop keeps its stored estimated_duration_minutes + 2-min dwell.
  const etaUpdates = computeCascadeEtas({
    anchorMinutes: nowMinutes,
    stops: orderedStops.map((s, i) => ({
      ...s,
      estimated_duration_minutes: i === 0 ? remainingMinutes : (s.estimated_duration_minutes || 5),
    })),
    skipWindowFloor: false,
  });
  if (!Array.isArray(etaUpdates) || etaUpdates.length === 0) {
    return { mode: 'fallback', reason: 'cascade_empty' };
  }
  return {
    mode: 'polyline',
    etaUpdates,
    remainingMinutes,
    projectedRemainingMeters: Math.round(proj.remainingMeters),
    deviatedMeters: Math.round(proj.deviatedMeters),
  };
};
