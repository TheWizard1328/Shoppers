/**
 * cyclingAwareOptimizer
 *
 * Shared helper called by both RouteActionButtons (manual FAB) and
 * useStopCardActions (Accept All / handleStartDelivery) whenever a full
 * re-optimisation is needed.
 *
 * Detects whether an active cycling segment exists for the driver on the
 * given date and routes accordingly:
 *
 *   ── No active cycling segment ──────────────────────────────────────────
 *   Single-pass: standard optimizeRemainingStops call (existing behaviour).
 *
 *   ── Active cycling segment detected ────────────────────────────────────
 *   Three-stage flow:
 *
 *   Stage 1 – Cycling pass
 *     Origin:      First unfinished cycling stop's coords (cycling_latitude /
 *                  cycling_longitude when is_cycling_marker, or patient/store
 *                  coords for regular stops with transport_mode='cycling').
 *                  NOTE: This is NOT always the Cycling Route Start marker —
 *                  if the route is mid-cycle the Start marker may already be
 *                  completed; we find the first non-finished cycling stop.
 *     Destination: Cycling Route End marker coords (cycling_latitude/longitude).
 *     Waypoints:   All remaining unfinished stops with transport_mode='cycling'
 *                  that are NOT is_cycling_marker records (the markers are
 *                  anchors, not sequenceable waypoints).
 *     HERE mode:   bicycle
 *     startingStopOrder: End marker's current stop_order – cyclingStopCount
 *                  (preserves the End marker's relative position).
 *
 *   Stage 2 – Driving pass (post-cycling)
 *     Origin:      Cycling Route End marker coords.
 *     Waypoints:   All remaining unfinished stops excluding cycling stops +
 *                  both marker records.
 *     HERE mode:   car (driver's normal preferred mode).
 *     startingStopOrder: End marker's stop_order + 1.
 *
 *   Stage 3 – Polyline regeneration
 *     Single purgeAndRegeneratePolylines call.  The backend's existing
 *     segment-grouping logic (groupModeOverrideRanges) automatically draws:
 *       3a) driving  → Cycling Route Start
 *       3b) cycling  → selected stops → Cycling Route End
 *       3c) driving  → remaining driving stops
 *     No extra params needed — transport_mode per stop drives grouping.
 */

import { base44 } from '@/api/base44Client';
import { Delivery } from '@/api/entities';
import { format } from 'date-fns';

const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled', 'returned']);

/**
 * Resolve the GPS coords for a single delivery record.
 * Mirrors what the backend's getDeliveryCoords does but client-side, using
 * the patients/stores arrays already in memory.
 *
 * Returns { lat, lon } or null.
 */
function resolveStopCoords(delivery, patients = [], stores = []) {
  if (!delivery) return null;

  // Cycling markers carry their own GPS
  if (delivery.is_cycling_marker) {
    const lat = Number(delivery.cycling_latitude);
    const lon = Number(delivery.cycling_longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0) {
      return { lat, lon };
    }
    return null;
  }

  if (delivery.patient_id) {
    const p = patients.find((x) => x?.id === delivery.patient_id);
    if (p?.latitude != null && p?.longitude != null) {
      return { lat: Number(p.latitude), lon: Number(p.longitude) };
    }
  }

  if (delivery.store_id) {
    const s = stores.find((x) => x?.id === delivery.store_id);
    if (s?.latitude != null && s?.longitude != null) {
      return { lat: Number(s.latitude), lon: Number(s.longitude) };
    }
  }

  return null;
}

/**
 * Detect whether there is an active (unfinished) cycling segment on this route.
 *
 * Returns null if no cycling segment exists, or an object:
 * {
 *   startMarker,          // Delivery record for "Cycling Route Start" (may be finished)
 *   endMarker,            // Delivery record for "Cycling Route End" (always unfinished)
 *   endMarkerCoords,      // { lat, lon } of End marker
 *   cyclingOriginStop,    // First unfinished stop in the cycling segment (marker OR regular)
 *   cyclingOriginCoords,  // { lat, lon } of cyclingOriginStop
 *   unfinishedCyclingStopIds, // IDs of unfinished regular cycling stops (not markers)
 * }
 */

/**
 * Ensure the cycling start marker has isNextDelivery=true if it is the next unfinished
 * stop in the route (i.e. no other non-pending, non-finished stop comes before it).
 * Call this after creating cycling markers or after any stop completion.
 */
export async function syncCyclingMarkerNextDeliveryFlag(deliveries, driverId, deliveryDate) {
  if (!Array.isArray(deliveries) || deliveries.length === 0) return;

  const driverDeliveries = deliveries.filter(
    (d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate
  );

  const startMarker = driverDeliveries.find(
    (d) => d?.is_cycling_marker && d?.delivery_notes === 'Cycling Route Start'
  );
  if (!startMarker) return; // No cycling segment

  // Skip if start marker is already finished
  if (FINISHED_STATUSES.has(startMarker.status)) return;

  // Find all incomplete, non-pending stops sorted by stop_order
  const incompleteStops = driverDeliveries
    .filter((d) => d && !FINISHED_STATUSES.has(d.status) && d.status !== 'pending')
    .sort((a, b) => (Number(a.stop_order) || 99999) - (Number(b.stop_order) || 99999));

  if (incompleteStops.length === 0) return;

  const firstIncomplete = incompleteStops[0];
  const shouldBeNext = firstIncomplete.id === startMarker.id;

  // Only update if the start marker should be next but isn't, or vice versa
  if (shouldBeNext && !startMarker.isNextDelivery) {
    console.log(`[cyclingAwareOptimizer] Setting isNextDelivery=true on cycling start marker ${startMarker.id}`);
    try {
      await Delivery.update(startMarker.id, { isNextDelivery: true });
      // Also clear any other stop that may have the flag
      const otherNextStops = driverDeliveries.filter(
        (d) => d.id !== startMarker.id && d.isNextDelivery === true
      );
      await Promise.all(
        otherNextStops.map((d) => Delivery.update(d.id, { isNextDelivery: false }).catch(() => {}))
      );
    } catch (e) {
      console.warn(`[cyclingAwareOptimizer] Failed to set isNextDelivery on start marker:`, e?.message);
    }
  }
}

export function detectActiveCyclingSegment(deliveries, patients = [], stores = []) {
  if (!Array.isArray(deliveries) || deliveries.length === 0) return null;

  const startMarker = deliveries.find(
    (d) => d?.is_cycling_marker && d?.delivery_notes === 'Cycling Route Start'
  ) || null;

  const endMarker = deliveries.find(
    (d) => d?.is_cycling_marker && d?.delivery_notes === 'Cycling Route End'
  ) || null;

  // No cycling segment configured at all
  if (!endMarker) return null;

  // End marker must be unfinished — if it's done the entire loop is complete
  if (FINISHED_STATUSES.has(endMarker.status)) return null;

  const endMarkerCoords = resolveStopCoords(endMarker, patients, stores);
  if (!endMarkerCoords) return null;

  // ── Find all unfinished regular cycling stops (transport_mode='cycling', not markers) ──
  const endMarkerOrder = Number(endMarker.stop_order ?? 99999);
  const startMarkerOrder = startMarker ? Number(startMarker.stop_order ?? 0) : 0;

  const unfinishedCyclingStops = deliveries
    .filter((d) =>
      d &&
      !d.is_cycling_marker &&
      !FINISHED_STATUSES.has(d.status) &&
      d.transport_mode === 'cycling' &&
      Number(d.stop_order ?? 99999) > startMarkerOrder &&
      Number(d.stop_order ?? 99999) < endMarkerOrder
    )
    .sort((a, b) => (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0));

  const unfinishedCyclingStopIds = unfinishedCyclingStops.map((d) => d.id);

  // ── Determine cycling origin ──────────────────────────────────────────────
  // Priority:
  //   a) Start marker itself, if unfinished (route hasn't entered the loop)
  //   b) isNextDelivery stop, if no start marker active but cycling is configured
  //      (dispatcher manually set cycling stops without a start marker)
  //   c) First unfinished regular cycling stop (mid-loop)
  //   d) End marker as last resort

  const startMarkerUnfinished = startMarker && !FINISHED_STATUSES.has(startMarker.status);

  // Find the isNextDelivery stop that is NOT a cycling marker (current active stop)
  const isNextDeliveryStop = deliveries.find(
    (d) => d?.isNextDelivery === true && !d?.is_cycling_marker && !FINISHED_STATUSES.has(d?.status)
  ) || null;

  let cyclingOriginStop = null;
  let cyclingOriginCoords = null;

  if (startMarkerUnfinished) {
    // Haven't entered the loop yet — origin is the Start marker
    cyclingOriginStop = startMarker;
    cyclingOriginCoords = resolveStopCoords(startMarker, patients, stores);
  } else if (unfinishedCyclingStops.length > 0) {
    // Mid-loop — origin is the first unfinished regular cycling stop
    cyclingOriginStop = unfinishedCyclingStops[0];
    cyclingOriginCoords = resolveStopCoords(cyclingOriginStop, patients, stores);
  } else if (isNextDeliveryStop) {
    // No start marker active, but isNextDelivery stop exists — use it as origin
    cyclingOriginStop = isNextDeliveryStop;
    cyclingOriginCoords = resolveStopCoords(isNextDeliveryStop, patients, stores);
  } else {
    // All cycling stops done but End marker still pending — sequence from End marker itself
    // (nothing to resequence for Stage 1, but we still need Stage 2 to run)
    cyclingOriginStop = endMarker;
    cyclingOriginCoords = endMarkerCoords;
  }

  if (!cyclingOriginCoords) return null;

  return {
    startMarker,
    endMarker,
    endMarkerCoords,
    cyclingOriginStop,
    cyclingOriginCoords,
    unfinishedCyclingStopIds,
  };
}

/**
 * Main entry point.
 *
 * Replaces direct `optimizeRemainingStops` calls in RouteActionButtons and
 * useStopCardActions.  Always ends with a purgeAndRegeneratePolylines call.
 *
 * @param {object} opts
 * @param {string}  opts.driverId
 * @param {string}  opts.deliveryDate          'yyyy-MM-dd'
 * @param {string}  opts.currentLocalTime      'HH:mm'
 * @param {string}  opts.deviceTime            ISO string
 * @param {string}  opts.hereApiKey
 * @param {object}  [opts.currentLocation]     { lat, lon } driver GPS (optional)
 * @param {Array}   opts.deliveriesWithStopOrder  All deliveries in memory
 * @param {Array}   [opts.patients]
 * @param {Array}   [opts.stores]
 * @param {boolean} [opts.forceFullRemainingRouteOptimization]
 * @param {boolean} [opts.bypassDeduplication]
 * @param {boolean} [opts.bypassDriverStatus]
 * @param {string}  [opts.triggerSource]
 *
 * @returns {Promise<object>}  Last optimizeRemainingStops response data
 */
export async function invokeOptimizeAwareCycling({
  driverId,
  deliveryDate,
  currentLocalTime,
  deviceTime,
  hereApiKey,
  currentLocation = null,
  deliveriesWithStopOrder = [],
  patients = [],
  stores = [],
  forceFullRemainingRouteOptimization = true,
  bypassDeduplication = true,
  bypassDriverStatus = true,
  triggerSource = 'manual',
}) {
  const baseArgs = {
    driverId,
    deliveryDate,
    currentLocalTime,
    deviceTime,
    hereApiKey,
    forceFullRemainingRouteOptimization,
    bypassDeduplication,
    bypassDriverStatus,
    ...(currentLocation ? { currentLocation } : {}),
  };

  // ── Detect active cycling segment ───────────────────────────────────────
  const cycling = detectActiveCyclingSegment(deliveriesWithStopOrder, patients, stores);

  let finalOptimizeData = null;

  if (!cycling) {
    // ── No cycling segment — single-pass standard optimization ─────────────
    console.log(`[cyclingAwareOptimizer] No active cycling segment — standard single-pass optimize | driver=${driverId}`);
    const resp = await base44.functions.invoke('optimizeRemainingStops', {
      ...baseArgs,
      triggerSource: `${triggerSource}:standard`,
    });
    finalOptimizeData = resp?.data || resp;

  } else {
    const { endMarker, endMarkerCoords, cyclingOriginCoords, unfinishedCyclingStopIds } = cycling;
    const endMarkerOrder = Number(endMarker.stop_order ?? 0);

    console.log(
      `[cyclingAwareOptimizer] Active cycling segment detected | driver=${driverId}` +
      ` | originStop=${cycling.cyclingOriginStop?.id} | cyclingStops=${unfinishedCyclingStopIds.length}` +
      ` | endMarker=${endMarker.id} | endMarkerOrder=${endMarkerOrder}`
    );

    // ── Stage 1 — Cycling pass ─────────────────────────────────────────────
    // Only run if there are actual cycling stops to sequence.
    // If all cycling stops are done (origin === endMarker), skip Stage 1.
    if (unfinishedCyclingStopIds.length > 0) {
      console.log(`[cyclingAwareOptimizer] Stage 1: cycling pass | stops=${unfinishedCyclingStopIds.length}`);
      try {
        await base44.functions.invoke('optimizeRemainingStops', {
          ...baseArgs,
          triggerSource: `${triggerSource}:cycling:stage1`,
          cyclingSegmentOnly: true,
          cyclingOrigin: cyclingOriginCoords,
          cyclingDestination: endMarkerCoords,
          cyclingStopIds: unfinishedCyclingStopIds,
          // Write stop_order values starting immediately after the cycling origin stop.
          // endMarkerOrder - cyclingStopIds.length gives the first slot, so the
          // resequenced stops slot in right before the End marker.
          startingStopOrder: endMarkerOrder - unfinishedCyclingStopIds.length,
        });
      } catch (e) {
        console.warn(`[cyclingAwareOptimizer] Stage 1 cycling pass failed: ${e?.message}`);
      }

      // Brief gap so the deduplication window in optimizeRemainingStops doesn't
      // block Stage 2 (they use different triggerSources but same dedupeKey).
      await new Promise((r) => setTimeout(r, 1200));
    } else {
      console.log(`[cyclingAwareOptimizer] Stage 1 skipped — no unfinished cycling stops`);
    }

    // ── Stage 2 — Driving pass ─────────────────────────────────────────────
    // Exclude: all unfinished cycling stops + both marker IDs.
    const excludeStopIds = [
      ...unfinishedCyclingStopIds,
      cycling.startMarker?.id,
      endMarker.id,
    ].filter(Boolean);

    console.log(`[cyclingAwareOptimizer] Stage 2: driving pass | excludeCount=${excludeStopIds.length}`);
    try {
      const resp2 = await base44.functions.invoke('optimizeRemainingStops', {
        ...baseArgs,
        triggerSource: `${triggerSource}:cycling:stage2`,
        drivingSegmentOnly: true,
        drivingOrigin: endMarkerCoords,
        excludeStopIds,
        startingStopOrder: endMarkerOrder + 1,
      });
      finalOptimizeData = resp2?.data || resp2;
    } catch (e) {
      console.warn(`[cyclingAwareOptimizer] Stage 2 driving pass failed: ${e?.message}`);
    }
  }

  // ── Sync cycling marker stop_orders + isNextDelivery ──────────────────
  // After stages 1/2, explicitly re-anchor unfinished cycling markers so their
  // stop_order numbers reflect the current route state. The backend never writes
  // cycling markers during optimize passes (they are routing anchors, not waypoints).
  if (cycling) {
    const { startMarker, endMarker: em } = cycling;
    const completedCount = deliveriesWithStopOrder.filter(
      (d) => d && d.driver_id === driverId && FINISHED_STATUSES.has(d.status)
    ).length;

    const markerUpdates = [];

    // Start marker: if still unfinished, it must sit at completedCount + 1
    // AND must carry isNextDelivery=true (it is the next stop in the route)
    if (startMarker && !FINISHED_STATUSES.has(startMarker.status)) {
      const correctOrder = completedCount + 1;
      const orderNeedsUpdate = Number(startMarker.stop_order) !== correctOrder;
      const nextFlagNeedsUpdate = !startMarker.isNextDelivery;

      if (orderNeedsUpdate || nextFlagNeedsUpdate) {
        const patch = {};
        if (orderNeedsUpdate) {
          patch.stop_order = correctOrder;
          patch.display_stop_order = correctOrder;
          console.log(`[cyclingAwareOptimizer] Updating startMarker stop_order: ${startMarker.stop_order} → ${correctOrder}`);
        }
        if (nextFlagNeedsUpdate) {
          patch.isNextDelivery = true;
          console.log(`[cyclingAwareOptimizer] Setting isNextDelivery=true on cycling start marker ${startMarker.id}`);
        }
        markerUpdates.push(
          Delivery.update(startMarker.id, patch).catch(() => {})
        );
      }

      // Clear isNextDelivery on any other stop that may have the flag
      const otherNextStops = deliveriesWithStopOrder.filter(
        (d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate &&
          d.id !== startMarker.id && d.isNextDelivery === true
      );
      otherNextStops.forEach((d) => {
        markerUpdates.push(Delivery.update(d.id, { isNextDelivery: false }).catch(() => {}));
      });
    }

    if (markerUpdates.length > 0) {
      await Promise.all(markerUpdates).catch(() => {});
    }
  }

  // ── Stage 3 — Polyline regeneration ────────────────────────────────────
  // Always runs regardless of cycling/non-cycling.
  console.log(`[cyclingAwareOptimizer] Stage 3: polyline regeneration | driver=${driverId}`);
  // Signal KITT bar to switch to polyline message
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('polylineGenerationStarted', { detail: { isRegenerate: finalOptimizeData?.routeChanged === false, driverId, deliveryDate } }));
  }
  try {
    const orderedIds = Array.isArray(finalOptimizeData?.optimizedRoute)
      ? finalOptimizeData.optimizedRoute.map((s) => s.deliveryId).filter(Boolean)
      : [];

    await base44.functions.invoke('purgeAndRegeneratePolylines', {
      driverId,
      deliveryDate,
      scope: 'active_only',
      reason: finalOptimizeData?.routeChanged ? 'route_reordered' : 'manual',
      bypassDriverStatus: true,
      ...(orderedIds.length > 0 ? { orderedDeliveryIds: orderedIds } : {}),
    });
  } catch (e) {
    console.warn(`[cyclingAwareOptimizer] Stage 3 polyline regen failed: ${e?.message}`);
  }

  // ── Sync isNextDelivery flag for cycling markers after all optimization ──
  // This ensures the cycling start marker always carries isNextDelivery=true
  // when it is the next stop in line after route optimization completes.
  try {
    await syncCyclingMarkerNextDeliveryFlag(deliveriesWithStopOrder, driverId, deliveryDate);
  } catch (e) {
    console.warn(`[cyclingAwareOptimizer] syncCyclingMarkerNextDeliveryFlag failed (non-fatal):`, e?.message);
  }

  return finalOptimizeData;
}