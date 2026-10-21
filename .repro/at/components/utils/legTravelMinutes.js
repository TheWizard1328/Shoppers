/**
 * legTravelMinutes.js — pure ETA-leg travel-time ladder, shared by the route
 * engine's ETA chain.
 *
 * OWNER REPORT (Oct 15 2026): two stops at the SAME coordinates (223 Heagle Cres,
 * stop #33 → #34) got ETAs 34 minutes apart. Root cause: HERE returns a
 * zero-duration leg between two identical coordinates, and the old ladder's
 * `> 0` checks treated that as "no fresh data" — so it fell through to the
 * stop's stored estimated_duration_minutes (a STALE 29-min leg from an old
 * route position) and chained the inflated ETA through every completion.
 *
 * Fix: a stop whose predecessor in the optimized sequence sits at (nearly) the
 * same coordinates always travels ~0 — capped at SAME_ADDRESS_TRAVEL_MINUTES
 * regardless of any stale stored estimate. A fresh polyline segment (if the
 * generator produced one) still wins.
 */

export const SAME_ADDRESS_TRAVEL_MINUTES = 2;

export const getLegTravelMinutes = ({
  stop, leg, segmentPolyline, fallbackMinutes = 5, preferLeg = false,
  winterPadFactor = null, legMode = 'driving', nearPreviousStop = false,
}) => {
  if (typeof segmentPolyline?.estimatedDurationMinutes === 'number' && segmentPolyline.estimatedDurationMinutes > 0)
    return Math.ceil(segmentPolyline.estimatedDurationMinutes);
  // Same-coordinates consecutive stops: travel is ~0 by definition. Never let a
  // stale stored estimate (left over from an old route position) leak in.
  if (nearPreviousStop) return SAME_ADDRESS_TRAVEL_MINUTES;
  // OWNER REQUEST (Oct 5 2026): when polyline generation was SKIPPED because the
  // optimizer kept the existing stop order, there is no fresh segmentPolyline —
  // ETAs must still update. Prefer the FRESH findsequence2 leg duration over the
  // stored (possibly hours-old) estimated_duration_minutes, with the same winter
  // pad the generator applies to fresh durations (cycling excluded).
  if (preferLeg) {
    const _legSeconds = Number(leg?.duration || 0);
    if (_legSeconds > 0) {
      let _minutes = Math.ceil(_legSeconds / 60);
      if (winterPadFactor && Number(winterPadFactor) > 0 && String(legMode).toLowerCase() !== 'cycling') {
        _minutes = Math.ceil(_minutes * Number(winterPadFactor));
      }
      return _minutes;
    }
  }
  if (typeof stop?.delivery?.estimated_duration_minutes === 'number' && stop.delivery.estimated_duration_minutes > 0)
    return Math.ceil(stop.delivery.estimated_duration_minutes);
  const travelSeconds = Number(leg?.duration || 0);
  if (travelSeconds > 0) return Math.ceil(travelSeconds / 60);
  return fallbackMinutes;
};
