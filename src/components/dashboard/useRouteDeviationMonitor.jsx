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
import { useCallback, useEffect, useRef } from 'react';
import { emitGatedEvent } from '@/components/utils/uiGate';
import { deviationFromDeliveryPolylineMeters, getDeviationSettings } from '@/components/utils/routeDeviationDetector';
import { locationTracker } from '@/components/utils/locationTracker';

const CHECK_THROTTLE_MS = 10_000;          // min time between deviation CHECKS
const GPS_FRESHNESS_MS = 2 * 60 * 1000;    // ignore stale GPS (tracker cached ≤15s, this is generous)
const IN_FLIGHT_STATUSES = ['en_route', 'in_transit'];

// Module-level (survive component remounts): per-driver cooldown + in-flight lock
const lastRegenAtByDriver = new Map();
let regenInFlight = false;
// TEMPORARY live-path diagnostics (Sep 21 2026): reports said the deviation
// check never ran while the app was foregrounded, only on resume. These
// throttled warn lines (console.warn survives the production Terser pass and
// is captured by remoteLogger) expose each check's outcome so the next test
// drive pinpoints the failing gate. Remove once live health is confirmed.
let _diagLastBeatAt = 0;
const _diag = (reason, extra = '') => {
  const n = Date.now();
  if (reason === 'ok') {
    // Normal case: heartbeat at most one line per 2 minutes.
    if (n - _diagLastBeatAt < 120000) return;
    _diagLastBeatAt = n;
  }
  try { console.warn(`[RouteDeviation] ${reason}${extra ? ' ' + extra : ''}`); } catch (_) {}
};

function localDateString(d) {
  const now = d || new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Shared scoped current-leg regen ─────────────────────────────────────────
// Single code path for BOTH callers: the GPS-tick monitor (below) and the
// on-duty deviation check (exported below). Owns the in-flight lock + the
// per-driver cooldown stamp so the two can never double-regen.
async function _regenCurrentLeg({ nextStop, gps, todayDeliveries, patients, stores, appUsers, driverId, updateDeliveriesLocally, todayStr }) {
  if (regenInFlight) return { regenerated: false, reason: 'in_flight' };
  regenInFlight = true;
  lastRegenAtByDriver.set(driverId, Date.now());
  try {
    console.log(`[RouteDeviation] ${driverId === undefined ? '' : ''}regenerating CURRENT LEG ONLY via live-GPS via-point`);
    const { regenerateCurrentLegPolyline } = await import('@/components/utils/currentLegRegenerator');
    const result = await regenerateCurrentLegPolyline({
      nextStop,
      gps: { latitude: Number(gps.latitude), longitude: Number(gps.longitude) },
      deliveries: todayDeliveries,
      patients,
      stores,
      appUsers,
      driverId,
    });

    if (result?.success) {
      // Belt-and-suspenders local state sync (updateDelivery already pushed the
      // optimistic record through the mutation subscription).
      updateDeliveriesLocally?.([result.updatedDelivery], false);
    } else {
      console.log(`[RouteDeviation] current-leg regen skipped: ${result?.reason || 'unknown'}`);
    }
    // UI-gated: while the app is hidden the deliveriesUpdated re-render is
    // deferred and replays at resume (the entity/IDB writes above already ran).
    emitGatedEvent(new CustomEvent('deliveriesUpdated', {
      detail: { driverId, deliveryDate: todayStr, triggeredBy: 'routeDeviation', alreadyOptimized: true }
    }), 'deliveriesUpdated:routeDeviation');
    console.log('[RouteDeviation] current-leg regen complete');
    return { regenerated: result?.success === true, updatedDelivery: result?.updatedDelivery || null };
  } catch (err) {
    console.warn('[RouteDeviation] regen failed:', err?.message || err);
    return { regenerated: false, error: err?.message || String(err) };
  } finally {
    regenInFlight = false;
  }
}

// ── On-duty deviation check (owner rule Sep 18 2026) ────────────────────────
// Called from DriverStatusToggle right after a driver is toggled ON duty. The
// driver may be re-entering the route far from the current leg's stored
// polyline (break stop, off-duty errand). Measure deviation NOW — if beyond
// the admin threshold, regenerate the CURRENT leg through the driver's
// position instead of waiting for the next GPS-tick detection cycle.
// Gates mirror the GPS-tick monitor (settings, in-flight next stop, cycling
// exclusion, cooldown, in-flight lock) EXCEPT duty status — the caller has
// just confirmed the on_duty transition.
export async function checkCurrentLegDeviationOnDuty({
  driverId, lat, lng, deliveries, patients = [], stores = [], appUsers = [], updateDeliveriesLocally,
}) {
  if (!driverId) return { checked: false, reason: 'no_driver_id' };
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return { checked: false, reason: 'no_gps' };

  const settings = getDeviationSettings();
  if (!settings.enableRouteDeviationDetection) return { checked: false, reason: 'detection_disabled' };
  const threshold = Number(settings.routeDeviationThresholdMeters) || 200;
  const cooldownMs = (Number(settings.routeDeviationCooldownMinutes) || 5) * 60 * 1000;

  const todayStr = localDateString();
  const todayDeliveries = (deliveries || [])
    .filter((d) => d && d.driver_id === driverId && d.delivery_date === todayStr);
  const nextStop = todayDeliveries
    .filter((d) => IN_FLIGHT_STATUSES.includes(String(d.status || '').toLowerCase()))
    .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0];
  if (!nextStop) return { checked: false, reason: 'no_next_stop' };
  // Cycling markers have their own specialized regen paths — never deviation-regen them.
  if (nextStop.delivery_notes === 'Cycling Route Start') return { checked: false, reason: 'cycling_marker' };

  const distance = deviationFromDeliveryPolylineMeters(Number(lat), Number(lng), nextStop.encoded_polyline);
  if (!Number.isFinite(distance) || distance <= threshold) {
    return { checked: true, deviated: false, deviatedMeters: Number.isFinite(distance) ? Math.round(distance) : null };
  }

  const lastRegenAt = lastRegenAtByDriver.get(driverId) || 0;
  if (Date.now() - lastRegenAt < cooldownMs) {
    return { checked: true, deviated: true, regenerated: false, deviatedMeters: Math.round(distance), reason: 'cooldown' };
  }
  if (regenInFlight) {
    return { checked: true, deviated: true, regenerated: false, deviatedMeters: Math.round(distance), reason: 'in_flight' };
  }

  console.log(`[RouteDeviation] on-duty check: driver ${Math.round(distance)}m off the current leg (threshold ${threshold}m) — regenerating CURRENT leg`);
  const regenResult = await _regenCurrentLeg({
    nextStop,
    gps: { latitude: Number(lat), longitude: Number(lng) },
    todayDeliveries,
    patients,
    stores,
    appUsers,
    driverId,
    updateDeliveriesLocally,
    todayStr,
  });
  _diag(regenResult?.regenerated ? 'regen' : 'regen_failed', `dist=${Math.round(distance)}m${regenResult?.reason ? ' reason=' + regenResult.reason : ''}${regenResult?.error ? ' error=' + regenResult.error : ''}`);
  return { checked: true, deviated: true, ...regenResult, deviatedMeters: Math.round(distance) };
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

  // ── Shared deviation check ────────────────────────────────────────────────
  // Called from BOTH triggers: driverLocation STATE changes (GPS fixes flowing
  // through the UI-gated driverPositionUpdated event) and a foreground-only
  // 15s safety interval reading locationTracker.lastPosition directly. Per the
  // owner's design (Sep 21 2026): detection runs ONLY while the app is visible —
  // backgrounded/screen-off is OFF by design (battery), with the leg updated on
  // resume. The 10s throttle + per-driver cooldown + in-flight lock dedupe the
  // two triggers.
  const tick = useCallback(async (eventFix) => {
      const now = Date.now();
      const s = stateRef.current;

      // ── Throttle ──
      if (now - lastCheckAtRef.current < CHECK_THROTTLE_MS) return;
      lastCheckAtRef.current = now;

      // ── Gates ──
      if (!s.isDriver || !s.isPrimaryDevice) { return; }

      // ── Duty hard gate (owner rule Sep 18 2026) ──
      // Deviation detection must be DISABLED while the driver is off_duty or
      // on_break. The appUsers React state below can lag behind the actual duty
      // toggle (WS / refresh propagation delay); the locationTracker's
      // in-memory status flips SYNCHRONOUSLY with the toggle, so treat it as
      // authoritative whenever the tracker has a user loaded.
      if (locationTracker?.currentUser && !['on_duty', 'online'].includes(String(locationTracker.driverStatus || '').toLowerCase())) { _diag('gate:tracker_duty', locationTracker.driverStatus); return; }

      const settings = getDeviationSettings();
      if (!settings.enableRouteDeviationDetection) { _diag('gate:disabled_setting'); return; }
      const threshold = Number(settings.routeDeviationThresholdMeters) || 200;
      const cooldownMs = (Number(settings.routeDeviationCooldownMinutes) || 5) * 60 * 1000;

      // Prefer the direct fix (safety interval) over the state value — the
      // tracker's lastPosition is never subject to the UI push gates.
      const gps = eventFix || s.driverLocation;
      if (!gps || !Number.isFinite(Number(gps.latitude)) || !Number.isFinite(Number(gps.longitude))) { _diag('gate:no_gps'); return; }
      const gpsTime = gps.timestamp ? new Date(gps.timestamp).getTime() : now;
      if (now - gpsTime > GPS_FRESHNESS_MS) { _diag('gate:stale_gps', Math.round((now - gpsTime) / 1000) + 's'); return; }

      const driverId = s.currentUser?.id;
      if (!driverId) { _diag('gate:no_user'); return; }

      // Today's route only — deviation regen on past/future dates makes no sense.
      const todayStr = localDateString();
      if (localDateString(s.selectedDate) !== todayStr) { _diag('gate:date', String(s.selectedDate)); return; }

      // Driver must be on duty (matches the clientRouteEngine via-point gates).
      const selfAppUser = (s.appUsers || []).find((au) => au?.user_id === driverId);
      if (!['on_duty', 'online'].includes(String(selfAppUser?.driver_status || '').toLowerCase())) { _diag('gate:appuser_duty', selfAppUser?.driver_status); return; }

      // Today's driver deliveries (same scope the delete flow passes the
      // coordinator) + the next in-flight stop (lowest stop_order among
      // en_route/in_transit).
      const todayDeliveries = (s.deliveries || [])
        .filter((d) => d && d.driver_id === driverId && d.delivery_date === todayStr);
      const nextStop = todayDeliveries
        .filter((d) => IN_FLIGHT_STATUSES.includes(String(d.status || '').toLowerCase()))
        .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0];
      if (!nextStop) { _diag('gate:no_next_stop'); return; }

      // Cycling markers have their own specialized regen paths (segment-only,
      // hand-picked origins) — never deviation-regen them.
      if (nextStop.delivery_notes === 'Cycling Route Start') { _diag('gate:cycling_marker'); return; }

      // ── Deviation measurement ──
      const distance = deviationFromDeliveryPolylineMeters(
        Number(gps.latitude), Number(gps.longitude), nextStop.encoded_polyline
      );
      if (!Number.isFinite(distance)) { _diag('gate:unusable_polyline', 'no encoded_polyline on next stop'); return; }
      if (distance <= threshold) { _diag('ok', `dist=${Math.round(distance)}m thr=${threshold}m next=${nextStop.tracking_number || nextStop.id}`); return; }

      // ── Cooldown + in-flight lock ──
      const lastRegenAt = lastRegenAtByDriver.get(driverId) || 0;
      if (now - lastRegenAt < cooldownMs) { _diag('cooldown', `dist=${Math.round(distance)}m`); return; }
      if (regenInFlight) { _diag('gate:regen_in_flight', `dist=${Math.round(distance)}m`); return; }

      // Scoped regen (Sep 17 2026): one 2-3 point Directions call for the current
      // leg only — origin (last finished stop / home) → live GPS → next stop.
      // No coordinator run, no re-sequencing, other stops' polylines untouched.
      const regenResult = await _regenCurrentLeg({
        nextStop,
        gps: { latitude: Number(gps.latitude), longitude: Number(gps.longitude) },
        todayDeliveries,
        patients: s.patients,
        stores: s.stores,
        appUsers: s.appUsers,
        driverId,
        updateDeliveriesLocally: s.updateDeliveriesLocally,
        todayStr,
      });
      _diag(regenResult?.regenerated ? 'regen' : 'regen_failed', `dist=${Math.round(distance)}m${regenResult?.reason ? ' reason=' + regenResult.reason : ''}${regenResult?.error ? ' error=' + regenResult.error : ''}`);
  }, []);

  // Trigger 1: driverLocation state updates (visible UI path — unchanged).
  useEffect(() => {
    tick();
  }, [driverLocation, tick]);

  // Trigger 2: foreground-only safety interval (Sep 21 2026). The live path
  // reported dead while the app is visibly open (detection only fired on
  // resume-from-background), yet every link of the state-push chain looks
  // correct — so this interval GUARANTEES the foreground check runs every 15s
  // by reading locationTracker.lastPosition (the raw, ungated freshest fix)
  // instead of relying on driverLocation state pushes. document.hidden check
  // keeps the background-off design: no checks while minimized/screen-off —
  // the resume catch-up path (deferred replay + foreground snap) stays the
  // only hidden→visible transition point. The 10s CHECK_THROTTLE dedupes
  // against Trigger 1 when both fire.
  useEffect(() => {
    const iv = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return; // background OFF by design
      const lp = locationTracker?.lastPosition;
      if (!Number.isFinite(Number(lp?.latitude)) || !Number.isFinite(Number(lp?.longitude))) return;
      const s = stateRef.current;
      if (s.isDriver && s.isPrimaryDevice) {
        tick({ latitude: lp.latitude, longitude: lp.longitude, timestamp: new Date().toISOString(), accuracy: lp.accuracy });
      }
    }, 15000);
    return () => clearInterval(iv);
  }, [tick]);
}

export default useRouteDeviationMonitor;
