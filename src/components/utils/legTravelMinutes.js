/**
 * legTravelMinutes.js — thin client-side adapter over the SHARED travel-minute
 * ladder in routeRules.js (owner directive Nov 16 2026: one set of rules, two
 * engines). Kept as its own module because several client call sites import
 * these names; the actual ladder lives in
 * base44/functions/rxServerRouteOptimizer/routeRules.js so the server engine
 * computes exactly the same minutes.
 */
import {
  SAME_ADDRESS_TRAVEL_MINUTES as SHARED_SAME_ADDRESS_TRAVEL_MINUTES,
  legTravelMinutesFrom,
} from '../../../base44/functions/rxServerRouteOptimizer/routeRules.js';

export const SAME_ADDRESS_TRAVEL_MINUTES = SHARED_SAME_ADDRESS_TRAVEL_MINUTES;

export const getLegTravelMinutes = ({
  stop, leg, segmentPolyline, fallbackMinutes, preferLeg = false,
  winterPadFactor = null, legMode = 'driving', nearPreviousStop = false, crowFliesKmValue = null,
}) => {
  const freshMinutes = segmentPolyline?.estimatedDurationMinutes;
  const freshLegSeconds = leg?.duration;
  const minutes = legTravelMinutesFrom({
    freshMinutes,
    freshLegSeconds: preferLeg ? freshLegSeconds : freshLegSeconds,
    nearPreviousStop,
    mode: legMode,
    winterPadFactor,
    crowFliesKmValue,
  });
  // The shared ladder already ends with its own fallback; keep the caller's
  // override only when nothing else was known at all.
  if (minutes === undefined || minutes === null) {
    return Number.isFinite(fallbackMinutes) ? fallbackMinutes : 5;
  }
  return minutes;
};
