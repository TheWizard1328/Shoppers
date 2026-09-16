/**
 * useRouteDeviationMonitor — fires a current-leg polyline regen when the driver
 * physically strays off their prescribed path (built Sep 14 2026; replaces the
 * crude 100m-movement refresh removed from locationTracker on Aug 29).
 *
 * Pipeline: live GPS tick → throttle (10s) → gates (setting enabled, primary
 * driver device, on duty, today's route, a non-cycling in-flight next stop with
 * a stored current-leg polyline) → perpendicular distance from GPS to that
 * polyline → if over the admin threshold (default 200m) AND the per-driver
 * cooldown (default 5 min) has elapsed → performRouteOptimization with
 * preserveExistingOrder (NO stop reshuffling, no skipOptimize — see fix note
 * at the call site). The engine's live-GPS via-point (Sep 11)
 * then regenerates the current leg through the driver's actual position, and
 * the next stop's ETA/distance use only the GPS→stop portion.
 *
 * Loop safety (three layers):
 *   1. The regenerated leg bends through the GPS, so the next measurement is
 *      ~0m off-path — no re-trigger from the same deviation.
 *   2. Cooldown timestamp per driver (module-level, survives remounts).
 *   3. In-flight promise lock — GPS ticks arriving during the await are dropped.
 *
 * The 'deliveriesUpdated' event is dispatched with alreadyOptimized: true so
 * listeners don't re-optimize our write. All writes go through the coordinator's
 * own bulkUpdateDeliveries (awaitServerWrite: true — the same read-your-write
 * fix used for the Start button, so the first post-regen server re-pull sees
 * committed data instead of bouncing the map back to the stale polyline).
 */
import { useEffect, useRef } from 'react';
import { deviationFromDeliveryPolylineMeters, getDeviationSettings } from '@/components/utils/routeDeviationDetector';

const CHECK_THROTTLE_MS = 10_000;          // min time between deviation CHECKS
const GPS_FRESHNESS_MS = 2 * 60 * 1000;    // ignore stale GPS (tracker cached ≤15s, this is generous)
const IN_FLIGHT_STATUSES = ['en_route', 'in_transit'];

// Module-level (survive component remounts): per-driver cooldown + in-flight lock
const lastRegenAtByDriver = new Map();
let regenInFlight = false;

function localDateString(d) {
  const now = d || new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function useRouteDeviationMonitor({
  isDriver,
  isPrimaryDevice,
  driverLocation,
  currentUser,
  appUsers,
  deliveries,
  patients,
  stores,
  selectedDate,
  updateDeliveriesLocally,
}) {
  // Refs mirror the latest state so the GPS-tick effect doesn't re-subscribe
  // on every data change (mirrors the Dashboard ref-mirroring pattern).
  const stateRef = useRef({});
  stateRef.current = { isDriver, isPrimaryDevice, driverLocation, currentUser, appUsers, deliveries, patients, stores, selectedDate, updateDeliveriesLocally };
  const lastCheckAtRef = useRef(0);

  useEffect(() => {
    const tick = async () => {
      const now = Date.now();
      const s = stateRef.current;

      // ── Throttle ──
      if (now - lastCheckAtRef.current < CHECK_THROTTLE_MS) return;
      lastCheckAtRef.current = now;

      // ── Gates ──
      if (!s.isDriver || !s.isPrimaryDevice) return;

      const settings = getDeviationSettings();
      if (!settings.enableRouteDeviationDetection) return;
      const threshold = Number(settings.routeDeviationThresholdMeters) || 200;
      const cooldownMs = (Number(settings.routeDeviationCooldownMinutes) || 5) * 60 * 1000;

      const gps = s.driverLocation;
      if (!gps || !Number.isFinite(Number(gps.latitude)) || !Number.isFinite(Number(gps.longitude))) return;
      const gpsTime = gps.timestamp ? new Date(gps.timestamp).getTime() : now;
      if (now - gpsTime > GPS_FRESHNESS_MS) return;

      const driverId = s.currentUser?.id;
      if (!driverId) return;

      // Today's route only — deviation regen on past/future dates makes no sense.
      const todayStr = localDateString();
      if (localDateString(s.selectedDate) !== todayStr) return;

      // Driver must be on duty (matches the clientRouteEngine via-point gates).
      const selfAppUser = (s.appUsers || []).find((au) => au?.user_id === driverId);
      if (!['on_duty', 'online'].includes(String(selfAppUser?.driver_status || '').toLowerCase())) return;

      // Today's driver deliveries (same scope the delete flow passes the
      // coordinator) + the next in-flight stop (lowest stop_order among
      // en_route/in_transit).
      const todayDeliveries = (s.deliveries || [])
        .filter((d) => d && d.driver_id === driverId && d.delivery_date === todayStr);
      const nextStop = todayDeliveries
        .filter((d) => IN_FLIGHT_STATUSES.includes(String(d.status || '').toLowerCase()))
        .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0];
      if (!nextStop) return;

      // Cycling markers have their own specialized regen paths (segment-only,
      // hand-picked origins) — never deviation-regen them.
      if (nextStop.delivery_notes === 'Cycling Route Start') return;

      // ── Deviation measurement ──
      const distance = deviationFromDeliveryPolylineMeters(
        Number(gps.latitude), Number(gps.longitude), nextStop.encoded_polyline
      );
      if (!Number.isFinite(distance) || distance <= threshold) return;

      // ── Cooldown + in-flight lock ──
      const lastRegenAt = lastRegenAtByDriver.get(driverId) || 0;
      if (now - lastRegenAt < cooldownMs) return;
      if (regenInFlight) return;
      regenInFlight = true;
      lastRegenAtByDriver.set(driverId, now);

      try {
        console.log(`[RouteDeviation] ${Math.round(distance)}m off the current leg (threshold ${threshold}m) — regenerating leg via live-GPS waypoint`);
        const { performRouteOptimization } = await import('@/components/utils/routeOptimizationCoordinator');
        const result = await performRouteOptimization({
          driverId,
          deliveryDate: todayStr,
          currentLocation: { lat: Number(gps.latitude), lon: Number(gps.longitude) },
          deliveries: todayDeliveries,
          patients: s.patients,
          stores: s.stores,
          appUsers: s.appUsers,
          source: 'route_deviation',
          // CRITICAL FIX (Sep 16, 2026): do NOT pass skipOptimize. In the coordinator,
          // the ENTIRE polyline-regen + writeBatch + server/IDB write path runs only
          // inside `if (!skipOptimize)` — with skipOptimize:true (and no orderedDeliveryIds)
          // the call returned "success" with a null writeBatch and regenerated NOTHING,
          // silently. preserveExistingOrder:true alone is the correct posture: the
          // engine keeps stop_order as-is (no re-sequencing), keeps the isNextDelivery
          // lock, and regenerates all legs — the current leg bending through the
          // driver's live GPS via-point (the actual deviation recovery).
          preserveExistingOrder: true,  // keep stop_order as-is — NO re-sequencing
          awaitServerWrite: true,       // read-your-write: commit before sync managers re-pull
        });

        if (result?.success && Array.isArray(result.freshDeliveries) && result.freshDeliveries.length > 0) {
          s.updateDeliveriesLocally?.(result.freshDeliveries, false);
        }
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: { driverId, deliveryDate: todayStr, triggeredBy: 'routeDeviation', alreadyOptimized: true }
        }));
        console.log('[RouteDeviation] regen complete');
      } catch (err) {
        console.warn('[RouteDeviation] regen failed:', err?.message || err);
      } finally {
        regenInFlight = false;
      }
    };

    // React to every driverLocation update (live GPS on the primary device).
    tick();
  }, [driverLocation]);
}

export default useRouteDeviationMonitor;
