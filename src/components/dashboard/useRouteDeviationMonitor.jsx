/**
 * useRouteDeviationMonitor — fires a current-leg polyline regen when the driver
 * physically strays off their prescribed path (built Sep 14 2026; replaces the
 * crude 100m-movement refresh removed from locationTracker on Aug 29).
 *
 * Pipeline: live GPS tick → throttle (10s) → gates (setting enabled, primary
 * driver device, on duty, today's route, a non-cycling in-flight next stop with
 * a stored current-leg polyline) → perpendicular distance from GPS to that
 * polyline → if over the admin threshold (default 200m) AND the per-driver
 * cooldown (default 5 min) has elapsed → regenerateCurrentLegPolyline (Sep 17
 * 2026: scoped to the CURRENT LEG ONLY — a single 2-3 point Directions call
 * bending through the driver's actual position, instead of the old full-route
 * performRouteOptimization which re-cut every remaining leg). The next stop's
 * polyline/ETA/distance update; every other stop stays exactly as the last
 * full optimization left it. The Maps API usage log labels this call
 * 'Route Deviation (Google Directions) — Current Route Leg'.
 *
 * Loop safety (three layers):
 *   1. The regenerated leg bends through the GPS, so the next measurement is
 *      ~0m off-path — no re-trigger from the same deviation.
 *   2. Cooldown timestamp per driver (module-level, survives remounts).
 *   3. In-flight promise lock — GPS ticks arriving during the await are dropped.
 *
 * The 'deliveriesUpdated' event is dispatched with alreadyOptimized: true so
 * listeners don't re-optimize our write. The single-delivery commit goes through
 * entityMutations.updateDelivery (optimistic UI + IDB + user-scoped server write
 * with WS broadcast + local-write echo suppression) — the same pipeline the stop
 * card actions use.
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
        console.log(`[RouteDeviation] ${Math.round(distance)}m off the current leg (threshold ${threshold}m) — regenerating CURRENT LEG ONLY via live-GPS via-point`);
        // Scoped regen (Sep 17 2026): one 2-3 point Directions call for the current
        // leg only — origin (last finished stop / home) → live GPS → next stop.
        // No coordinator run, no re-sequencing, other stops' polylines untouched.
        // (Previous full performRouteOptimization re-cut every remaining leg on
        // each deviation — slower and churned legs that were still valid.)
        const { regenerateCurrentLegPolyline } = await import('@/components/utils/currentLegRegenerator');
        const result = await regenerateCurrentLegPolyline({
          nextStop,
          gps: { latitude: Number(gps.latitude), longitude: Number(gps.longitude) },
          deliveries: todayDeliveries,
          patients: s.patients,
          stores: s.stores,
          appUsers: s.appUsers,
          driverId,
        });

        if (result?.success) {
          // Belt-and-suspenders local state sync (updateDelivery already pushed the
          // optimistic record through the mutation subscription).
          s.updateDeliveriesLocally?.([result.updatedDelivery], false);
        } else {
          console.log(`[RouteDeviation] current-leg regen skipped: ${result?.reason || 'unknown'}`);
        }
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: { driverId, deliveryDate: todayStr, triggeredBy: 'routeDeviation', alreadyOptimized: true }
        }));
        console.log('[RouteDeviation] current-leg regen complete');
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
