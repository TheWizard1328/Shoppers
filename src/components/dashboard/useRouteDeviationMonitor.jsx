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
import { emitGatedEvent, isUIHidden } from '@/components/utils/uiGate';
import { deviationFromDeliveryPolylineMeters, getDeviationSettings } from '@/components/utils/routeDeviationDetector';
import { getDeliveryCoords } from '@/components/utils/clientRouteEngine';
import { haversineKm } from '@/components/utils/geoUtils';
import { resolvePolylineOrigin } from '@/components/utils/polylineOriginRules';
import { parseTimeToMinutes } from '@/components/utils/fuzzyMatching';
import { locationTracker } from '@/components/utils/locationTracker';

const CHECK_THROTTLE_MS = 6_000;          // min time between deviation CHECKS
const GPS_FRESHNESS_MS = 2 * 60 * 1000;    // ignore stale GPS (tracker cached ≤15s, this is generous)
const IN_FLIGHT_STATUSES = ['en_route', 'in_transit'];

// Module-level (survive component remounts): per-driver cooldown + in-flight lock
const lastRegenAtByDriver = new Map();
// Oct 16 2026 (owner report — 2.5km deviation, phone never updated): the 5-min
// cooldown armed at regen START, so a FAILED regen (e.g. HERE 403 during the
// quota-exhaustion window before the UTC reset) blocked all retries for the
// full 5 minutes while the driver kept driving off-path. Failed regens now get
// a short 45s retry window; successful regens arm the full cooldown.
const lastRegenFailedAtByDriver = new Map();
// RETRY CAP (owner directive Oct 21 2026: retry loops bog devices down; max
// 2-3 attempts then let user interactions re-trigger). The 45s failure retry
// window now only applies to the FIRST TWO consecutive failures — after a
// 3rd consecutive failure the FULL cooldown arms (default 5 min), so a
// persistently failing regen API (HERE 403/429 quota window) can no longer
// re-attempt every 45s for an entire drive. Any successful regen or any
// optimization pass heals the leg independently.
const regenConsecutiveFailuresByDriver = new Map();
const MAX_REGEN_FAILURES = 3;
const FAILED_REGEN_RETRY_MS = 45 * 1000;
// ESCALATION COOLDOWN (owner report Oct 22 2026 — 'took seven whole blocks /
// at least a kilometer before it finally detected the deviation'): with the
// admin threshold at 50m and a 1-minute cooldown, an ACTIVELY DIVERGING driver
// only got re-anchored once per cooldown expiry — at city speed that is a full
// kilometer of drawn-line lag between redraws (API log confirmed: deviation
// regens firing every ~60-70s for the whole drive). When the driver is more
// than 2x the threshold off the CURRENT polyline they are diverging, not
// jittering: the regen re-anchors on a short 15s cadence instead of waiting
// out the full cooldown, so the drawn line (and the next stop's ETA) stays
// within a couple hundred meters of the driver. Jitter/parking cases are
// unaffected — after a regen the line bends through the driver, so distance
// only grows again while actually moving away.
const ESCALATION_DISTANCE_FACTOR = 2;
// OWNER REPORT Oct 30 2026 (phone showed repeated 429 'entity_update' /
// 'entity_list' balloons on the highway): with the admin threshold at 50m the
// 2x escalation gate opened at 100m, i.e. ordinary GPS noise plus one reroute,
// and the 15s short cooldown then fired a FULL current-leg regen — HERE Router
// call plus a Delivery write — up to four times a minute for the whole drive
// (logs: regen dist=145m / 583m / 2904m). Escalation is now bounded by an
// absolute floor AND a sane cadence: it only shortens the cooldown when the
// driver is at least 250m off the line, and never faster than once a minute.
const ESCALATION_MIN_DISTANCE_M = 250;
const ESCALATION_SHORT_COOLDOWN_MS = 60 * 1000;
let regenInFlight = false;
let regenInFlightAt = 0;
// ── REGEN WATCHDOG (owner report Oct 5 2026) ────────────────────────────────
// A regen attempt that never settles (dynamic import hang in a suspended
// WebView, dead-socket Directions fetch) left regenInFlight true FOREVER —
// every subsequent deviation check for the rest of the session hit the
// in-flight gate and the current-leg polyline stayed stale until an app
// RESTART reset the module flag (owner: 'took an app restart to update the
// current leg polyline after deviation'; API log showed zero deviation regens
// all drive, then one the moment the app restarted). A lock older than this
// watchdog is treated as hung: the next check logs it, takes over the lock,
// and regenerates anyway.
const REGEN_WATCHDOG_MS = 45_000;
// TEMPORARY live-path diagnostics (Sep 21 2026): reports said the deviation
// check never ran while the app was foregrounded, only on resume. These
// throttled warn lines (console.warn survives the production Terser pass and
// is captured by remoteLogger) expose each check's outcome so the next test
// drive pinpoints the failing gate. Remove once live health is confirmed.
let _diagLastBeatAt = 0;
const _diagLastByReason = new Map();
const _diag = (reason, extra = '') => {
  const n = Date.now();
  // 'ok' heartbeat: at most one line per 2 minutes. Every other reason: at
  // most one line per minute (was: unlimited — gate spam every 15s drowned
  // the real signal, a multi-minute silent gap in the tick loop).
  const last = reason === 'ok' ? _diagLastBeatAt : (_diagLastByReason.get(reason) || 0);
  if (n - last < (reason === 'ok' ? 120000 : 60000)) return;
  if (reason === 'ok') _diagLastBeatAt = n; else _diagLastByReason.set(reason, n);
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
// ── OPTIMIZATION GATE (owner report Oct 27 2026) ────────────────────────────
// A manual/server re-optimization regenerates the whole route (including the
// current leg with the live-GPS via + deviation chain) in ONE silent commit +
// ONE marker broadcast. Deviation regens firing DURING that window erased and
// rewrote the current leg mid-flight — the "vanish, reappear, vanish" flicker
// on the initiating device and extra per-write WS broadcasts on remotes.
// Skip deviation regens while an optimization for this driver is in flight;
// entries expire after 3 min as a missed-complete watchdog.
const _optInFlightByDriver = new Map();
const _OPT_GATE_MS = 3 * 60 * 1000;
if (typeof window !== 'undefined' && !window.__routeDeviationOptGateArmed) {
  window.__routeDeviationOptGateArmed = true;
  window.addEventListener('routeOptimizationStarted', (e) => {
    _optInFlightByDriver.set(String(e?.detail?.driverId || 'unknown'), Date.now());
  });
  const _clear = (e) => { _optInFlightByDriver.delete(String(e?.detail?.driverId || 'unknown')); };
  window.addEventListener('routeOptimizationComplete', _clear);
}
const _optInFlightFor = (driverId) => {
  const t = _optInFlightByDriver.get(String(driverId));
  return !!t && Date.now() - t < _OPT_GATE_MS;
};

// ── MIS-ANCHORED LEG HEAL (owner report Oct 29 2026) ─────────────────────────
// "My current leg polyline originates from the last stop, which is still
// PENDING." Before the origin rule was hardened, a freshly edited pending stop
// could be picked as the current leg's anchor, so the stored leg runs
// pending-stop -> home -> first active stop. The generator fix stops NEW legs
// from doing that, but the bad leg is already painted from the stop's
// encoded_polyline. This checks the stored leg once per leg signature: if its
// FIRST point sits >1.5km from the true origin (most recent FINISHED stop, else
// home), regenerate the current leg anchored to that origin.
const _healByDriver = new Map();
const HEAL_COOLDOWN_MS = 10 * 60 * 1000;
const HEAL_MAX_DRIFT_KM = 1.5;

async function _healMisAnchoredLeg({ nextStop, todayDeliveries, patients, stores, appUsers, driverId, updateDeliveriesLocally, gps = null }) {
  try {
    const enc = String(nextStop?.encoded_polyline || '');
    if (enc.length < 20) return;
    const { decodeGooglePolyline } = await import('@/components/utils/routePolylineGenerator');
    const pts = decodeGooglePolyline(enc);
    if (!Array.isArray(pts) || pts.length < 2) return;
    const key = `${nextStop.id}:${enc.length}:${enc.slice(0, 24)}`;
    const prev = _healByDriver.get(driverId);
    if (prev?.key === key) return; // this exact leg already evaluated
    if (prev && Date.now() - prev.at < HEAL_COOLDOWN_MS) return;

    const patientMap = new Map((patients || []).filter(Boolean).map((p) => [p.id, p]));
    const storeMap = new Map((stores || []).filter(Boolean).map((st) => [st.id, st]));
    const stopCoords = getDeliveryCoords(nextStop, patientMap, storeMap);
    const selfAppUser = (appUsers || []).find((au) => au?.user_id === driverId) || null;
    const pick = resolvePolylineOrigin({
      finishedDeliveries: todayDeliveries,
      resolveCoords: (d) => getDeliveryCoords(d, patientMap, storeMap),
      homePosition: (selfAppUser?.home_latitude != null && selfAppUser?.home_longitude != null)
        ? { lat: Number(selfAppUser.home_latitude), lon: Number(selfAppUser.home_longitude) } : null,
      firstTargetCoords: stopCoords ? { lat: Number(stopCoords.lat), lon: Number(stopCoords.lng) } : null,
      // Late-route fallback only: no finished stop AND no home on file.
      gpsPosition: (gps && Number.isFinite(Number(gps.latitude)))
        ? { lat: Number(gps.latitude), lon: Number(gps.longitude) } : null,
    });
    const origin = pick?.origin;
    if (!origin) return;

    const driftKm = haversineKm(Number(pts[0][0]), Number(pts[0][1]), origin.lat, origin.lon);
    if (!Number.isFinite(driftKm) || driftKm <= HEAL_MAX_DRIFT_KM) return;

    // OWNER REPORT (Oct 30 2026: two API calls per cycle, leg cleared and
    // redrawn as a loop): the healer measured drift from the TRUE origin
    // (home / last finished stop), but a deviation leg legitimately STARTS at
    // the recorded deviation exit point. Home-anchored -> healer redraws from
    // home -> deviation monitor redraws the deviated leg -> healer again, for
    // ever. A leg that starts on one of this stop's own deviation waypoints is
    // correctly anchored and must be left alone.
    const waypoints = Array.isArray(nextStop?.deviation_waypoints) ? nextStop.deviation_waypoints : [];
    const startsOnDeviationPoint = waypoints.some((w) => {
      const wLat = Number(w?.lat), wLng = Number(w?.lng);
      if (!Number.isFinite(wLat) || !Number.isFinite(wLng)) return false;
      return haversineKm(Number(pts[0][0]), Number(pts[0][1]), wLat, wLng) <= 0.15;
    });
    if (startsOnDeviationPoint) return;

    _healByDriver.set(driverId, { key, at: Date.now() });
    console.warn(`[RouteDeviation] stored current leg starts ${driftKm.toFixed(2)}km from its true origin (${pick.source}) — regenerating anchored to it`);
    await _regenCurrentLeg({
      nextStop,
      // Anchor the regen at the true origin: 0m from the anchor means no live-GPS via.
      gps: { latitude: origin.lat, longitude: origin.lon },
      todayDeliveries,
      patients,
      stores,
      appUsers,
      driverId,
      updateDeliveriesLocally,
    });
  } catch (_) { /* best effort — never break the deviation loop */ }
}

async function _regenCurrentLeg({ nextStop, gps, todayDeliveries, patients, stores, appUsers, driverId, updateDeliveriesLocally, todayStr }) {
  if (_optInFlightFor(driverId)) {
    console.log('[RouteDeviation] regen skipped — route optimization in flight (the optimizer redraws the current leg in its single commit; owner Oct 27)');
    return { regenerated: false, reason: 'optimization_in_flight' };
  }
  if (regenInFlight && Date.now() - regenInFlightAt < REGEN_WATCHDOG_MS) return { regenerated: false, reason: 'in_flight' };
  if (regenInFlight) console.warn('[RouteDeviation] regen lock was stuck >45s (hung import/fetch) — watchdog recovery, regenerating anyway');
  regenInFlight = true;
  regenInFlightAt = Date.now();
  try {
    // Keep the lock fresh while the regen is genuinely still working —
    // heartbeat pings let the watchdog distinguish 'slow but alive' from
    // 'hung'. A cheap ping at each await boundary is unnecessary; the whole
    // regen (import + 1 Directions call + 1 entity write) normally settles
    // in <10s, far under the 45s watchdog.
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
      lastRegenAtByDriver.set(driverId, Date.now());
      lastRegenFailedAtByDriver.delete(driverId);
      regenConsecutiveFailuresByDriver.delete(driverId);
    } else {
      lastRegenFailedAtByDriver.set(driverId, Date.now());
      const _fails = (regenConsecutiveFailuresByDriver.get(driverId) || 0) + 1;
      regenConsecutiveFailuresByDriver.set(driverId, _fails);
      if (_fails >= MAX_REGEN_FAILURES) {
        console.warn(`[RouteDeviation] ${_fails} consecutive regen failures for driver ${driverId} — arming full cooldown (short retry window disabled)`);
      }
    }
    if (result?.success) {
      // Belt-and-suspenders local state sync (updateDelivery already pushed the
      // optimistic record through the mutation subscription).
      updateDeliveriesLocally?.([result.updatedDelivery], false);

      // ── Mathematical ETA cascade for the REMAINING stops (owner request, Sep 29 2026) ──
      // The deviation regen re-anchored the NEXT stop's ETA from live GPS, but the
      // stops after it kept their pre-deviation ETAs. Chain them from the next
      // stop's new ETA using the SAME math as the completion cascade (each stop:
      // + its estimated leg travel, fallback 5 min, then a 2-min dwell) so the
      // whole remaining route shifts with the deviation instantly, instead of
      // waiting for the 2-min locationTracker poll cycle to catch up.
      try {
        const newEtaStr = String(result.updatedDelivery?.delivery_time_eta || nextStop.delivery_time_eta || '');
        let baseMinutes = parseTimeToMinutes(newEtaStr);
        if (Number.isFinite(baseMinutes)) {
          const TERMINAL = ['completed', 'failed', 'cancelled'];
          const remainingStops = todayDeliveries
            .filter((d) => d && d.id !== nextStop.id
              && !TERMINAL.includes(String(d.status || '').toLowerCase())
              && String(d.status || '').toLowerCase() !== 'pending'
              && (d.stop_order || 0) > (nextStop.stop_order || 0))
            .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
          baseMinutes += 2; // dwell at the next stop (completion-cascade parity)
          const etaUpdates = [];
          const toWindowMinutes = (t) => {
            const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})/);
            return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : null;
          };
          for (const stop of remainingStops) {
            const legMinutes = Number(stop.estimated_duration_minutes);
            baseMinutes += Number.isFinite(legMinutes) && legMinutes > 0 ? Math.ceil(legMinutes) : 5;
            // OWNER REQUEST (Sep 29 2026): window floor (matches the completion
            // cascade) — a mathematically earlier ETA never displays before the
            // stop's delivery start window; clamp up and cascade from there.
            const windowStartMin = toWindowMinutes(stop.delivery_time_start || stop.time_window_start);
            if (windowStartMin != null && baseMinutes < windowStartMin) {
              baseMinutes = windowStartMin;
            }
            const eta = `${String(Math.floor((baseMinutes % 1440) / 60)).padStart(2, '0')}:${String(baseMinutes % 60).padStart(2, '0')}`;
            baseMinutes += 2;
            if (eta !== stop.delivery_time_eta) etaUpdates.push({ ...stop, delivery_time_eta: eta });
          }
          if (etaUpdates.length > 0) {
            const { updateDelivery: cascadeUpdateDelivery } = await import('@/components/utils/entityMutations');
            etaUpdates.forEach((stop) => {
              cascadeUpdateDelivery(stop.id, { delivery_time_eta: stop.delivery_time_eta }).catch(() => {});
            });
            updateDeliveriesLocally?.(etaUpdates, false);
            console.log(`[RouteDeviation] remaining-stop ETA cascade: ${etaUpdates.length} stop(s) re-anchored from next-stop ETA ${newEtaStr}`);
          }
        }
      } catch (cascadeErr) {
        console.warn('[RouteDeviation] remaining-stop ETA cascade failed:', cascadeErr?.message || cascadeErr);
      }
    } else {
      // console.warn (NOT console.log) — production Terser strips console.log,
      // which is why failed regen attempts during drives were invisible to
      // remoteLogger (Oct 5 2026: whole drive with zero deviation regens, no
      // clue why; the skip reason needs to survive the build).
      console.warn(`[RouteDeviation] current-leg regen skipped: ${result?.reason || 'unknown'}`);
    }
    // UI-gated: while the app is hidden the deliveriesUpdated re-render is
    // deferred and replays at resume (the entity/IDB writes above already ran).
    emitGatedEvent(new CustomEvent('deliveriesUpdated', {
      detail: { driverId, deliveryDate: todayStr, triggeredBy: 'routeDeviation', alreadyOptimized: true }
    }), 'deliveriesUpdated:routeDeviation');
    // CRITICAL (Oct 2 2026): ALSO fire the polylineUpdated event — the map's
    // route layer (UnifiedRoutePolylines) only repaints route lines when it
    // receives one of its invalidate events. The deliveriesUpdated event above
    // carries no freshDeliveries array and 'routeDeviation' was not in the
    // listener's triggeredBy whitelist, so the freshly regenerated current-leg
    // polyline sat undrawn until the NEXT refresh cycle (WS full refresh /
    // smartRefresh poll) happened to bump the map's refresh token — the
    // "polyline updates a cycle late" symptom. Accept/Start/Return flows all
    // dispatch this same event for exactly this reason.
    emitGatedEvent(new CustomEvent('polylineUpdated', {
      detail: { driverId, deliveryDate: todayStr, source: 'route_deviation' }
    }), 'polylineUpdated:routeDeviation');
    console.log('[RouteDeviation] current-leg regen complete');
    return { regenerated: result?.success === true, updatedDelivery: result?.updatedDelivery || null };
  } catch (err) {
    console.warn('[RouteDeviation] regen failed:', err?.message || err);
    // COOLDOWN BYPASS FIX (Oct 22 2026, owner-approved perf fix 2): this catch
    // previously stamped NOTHING — an exception (dynamic-import failure, HERE/
    // Google throw on weak coverage — the COMMON case for drivers with bad
    // signal) left no failure stamp, so the very next GPS tick (10s throttle)
    // passed the cooldown gate and launched a full regen attempt again.
    // Live logs showed regens 15s-1min apart all drive on weak-signal devices.
    // Stamping here makes exceptions follow the SAME 45s retry window + 3-strike
    // full-cooldown as ordinary result-failures (v371 caps).
    lastRegenFailedAtByDriver.set(driverId, Date.now());
    const _fails = (regenConsecutiveFailuresByDriver.get(driverId) || 0) + 1;
    regenConsecutiveFailuresByDriver.set(driverId, _fails);
    if (_fails >= MAX_REGEN_FAILURES) {
      console.warn(`[RouteDeviation] ${_fails} consecutive regen failures (exception path) for driver ${driverId} — arming full cooldown (short retry window disabled)`);
    }
    return { regenerated: false, error: err?.message || String(err) };
  } finally {
    regenInFlight = false;
    regenInFlightAt = 0;
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
  // OWNER DIRECTIVE (Oct 27 2026): pause detection during route optimization —
  // mid-commit polylines measure as false deviations (see the poll check gate).
  if (_optInFlightFor(driverId)) return { checked: false, reason: 'optimization_in_flight' };
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
  const _failedAt = lastRegenFailedAtByDriver.get(driverId) || 0;
  const _escalated = distance > ESCALATION_DISTANCE_FACTOR * threshold
    && distance > ESCALATION_MIN_DISTANCE_M;
  const _effectiveCooldownMs = (_failedAt >= lastRegenAt && (regenConsecutiveFailuresByDriver.get(driverId) || 0) < MAX_REGEN_FAILURES)
    ? FAILED_REGEN_RETRY_MS
    : (_escalated ? Math.min(cooldownMs, ESCALATION_SHORT_COOLDOWN_MS) : cooldownMs);
  if (Date.now() - Math.max(lastRegenAt, _failedAt) < _effectiveCooldownMs) {
    return { checked: true, deviated: true, regenerated: false, deviatedMeters: Math.round(distance), reason: _failedAt >= lastRegenAt ? 'cooldown_after_failure' : 'cooldown' };
  }
  if (regenInFlight && Date.now() - regenInFlightAt < REGEN_WATCHDOG_MS) {
    return { checked: true, deviated: true, regenerated: false, deviatedMeters: Math.round(distance), reason: 'in_flight' };
  }
  if (regenInFlight) console.warn('[RouteDeviation] on-duty check: regen lock stuck >45s — watchdog recovery');

  console.log(`[RouteDeviation] on-duty check: driver ${Math.round(distance)}m off the current leg (threshold ${threshold}m${_escalated ? ', ESCALATED short-cooldown' : ''}) — regenerating CURRENT leg`);
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

      // ── GPS-ACCURACY GATE (owner report Oct 20 2026) ─────────────────────────
      // Indoor fixes (inside a store) can be kilometers off with accuracy
      // numbers in the hundreds of meters — the Oct 20 false 'deviation'
      // (4845m while picking up inside the store) was exactly this. A fix
      // this fuzzy is unusable for deviation measurement: skip the check.
      const gpsAcc = Number(gps?.accuracy);
      if (Number.isFinite(gpsAcc) && gpsAcc > 100) { _diag('gate:poor_gps_accuracy', Math.round(gpsAcc) + 'm'); return; }

      // Today's route only — deviation regen on past/future dates makes no sense.
      const todayStr = localDateString();
      if (localDateString(s.selectedDate) !== todayStr) { _diag('gate:date', String(s.selectedDate)); return; }

      // Driver must be on duty (matches the clientRouteEngine via-point gates).
      const selfAppUser = (s.appUsers || []).find((au) => au?.user_id === driverId);
      if (!['on_duty', 'online'].includes(String(selfAppUser?.driver_status || '').toLowerCase())) { _diag('gate:appuser_duty', selfAppUser?.driver_status); return; }

      // OWNER DIRECTIVE (Oct 27 2026): the CHECKER itself pauses while a route
      // optimization is in flight — polylines are cleared/re-written mid-commit
      // during optimization, and measuring GPS against a half-written or stale
      // leg registers a FALSE deviation (points recorded where the driver never
      // deviated). The optimizer redraws the current leg in its single commit;
      // detection resumes on routeOptimizationComplete (3-min expiry watchdog).
      if (_optInFlightFor(driverId)) { _diag('gate:optimization_in_flight', 'route optimization running — deviation detection paused'); return; }

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

      // Stored-leg origin sanity (once per leg): a leg anchored to a pending
      // stop is regenerated from the real origin before any deviation math.
      await _healMisAnchoredLeg({
        nextStop,
        todayDeliveries,
        patients: s.patients,
        stores: s.stores,
        appUsers: s.appUsers,
        driverId,
        updateDeliveriesLocally: s.updateDeliveriesLocally,
        gps,
      });

      // ── AT-LOCATION GATE (owner directive Oct 20 2026) ───────────────────────
      // 'If a driver is at a location the route deviation monitor should be
      // disabled.' Once the driver has ARRIVED (arrival_time stamped) or is
      // within 150m of the next stop (same radius as the engine's adjacency
      // checks), deviation detection is OFF entirely — indoor GPS jitter at
      // the stop must never trigger a regen (the Oct 20 store-pickup case:
      // a 4.8km indoor fix fired a regen that mangled the current leg).
      const _patientMap = new Map((s.patients || []).filter(Boolean).map((p) => [p.id, p]));
      const _storeMap = new Map((s.stores || []).filter(Boolean).map((st) => [st.id, st]));
      const _stopCoords = getDeliveryCoords(nextStop, _patientMap, _storeMap);
      if (nextStop.arrival_time) { _diag('gate:at_stop_arrived'); return; }
      if (_stopCoords && haversineKm(Number(gps.latitude), Number(gps.longitude), _stopCoords.lat, _stopCoords.lng) <= 0.15) {
        _diag('gate:at_stop_range', 'gps within 150m of next stop');
        return;
      }

      // ── Deviation measurement ──
      const distance = deviationFromDeliveryPolylineMeters(
        Number(gps.latitude), Number(gps.longitude), nextStop.encoded_polyline
      );
      if (!Number.isFinite(distance)) { _diag('gate:unusable_polyline', 'no encoded_polyline on next stop'); return; }
      if (distance <= threshold) { _diag('ok', `dist=${Math.round(distance)}m thr=${threshold}m next=${nextStop.tracking_number || nextStop.id}`); return; }

      // ── OFF-ROUTE SIGNAL (owner report Oct 28 2026) ─────────────────────────
      // Fired the moment the driver is measured beyond the threshold — BEFORE
      // the cooldown / in-flight / regen gates, because those can skip the
      // regen but the driver is still off route. The Phase 2 turn auto-zoom
      // listens for this and pins the map back to normal Phase 2 immediately
      // (without it the zoom stayed locked on the missed corner because the
      // regenerated leg kept the same stop id/status).
      try {
        window.dispatchEvent(new CustomEvent('routeDeviationDetected', {
          detail: { driverId, distanceM: Math.round(distance), thresholdM: threshold, nextStopId: nextStop.id },
        }));
      } catch {}


      // ── Cooldown + in-flight lock ──
      const lastRegenAt = lastRegenAtByDriver.get(driverId) || 0;
      const _failedAt = lastRegenFailedAtByDriver.get(driverId) || 0;
      const _escalated = distance > ESCALATION_DISTANCE_FACTOR * threshold
    && distance > ESCALATION_MIN_DISTANCE_M;
      const _effectiveCooldownMs = (_failedAt >= lastRegenAt && (regenConsecutiveFailuresByDriver.get(driverId) || 0) < MAX_REGEN_FAILURES)
        ? FAILED_REGEN_RETRY_MS
        : (_escalated ? Math.min(cooldownMs, ESCALATION_SHORT_COOLDOWN_MS) : cooldownMs);
      if (now - Math.max(lastRegenAt, _failedAt) < _effectiveCooldownMs) { _diag(_failedAt >= lastRegenAt ? 'cooldown_after_failure' : 'cooldown', `dist=${Math.round(distance)}m`); return; }
      if (regenInFlight && Date.now() - regenInFlightAt < REGEN_WATCHDOG_MS) { _diag('gate:regen_in_flight', `dist=${Math.round(distance)}m`); return; }
      if (regenInFlight) { _diag('watchdog:regen_lock_stuck', `dist=${Math.round(distance)}m — forcing regen`); }

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

  // Trigger 2: 15s safety interval (Sep 21 2026; owner re-confirmed Sep 23 2026).
  // Reads locationTracker.lastPosition (the raw, ungated freshest fix) instead
  // of relying on driverLocation state pushes, so the check runs every 15s
  // WHILE THE APP IS FOREGROUND/VISIBLE. Deviation checks are OFF while the
  // app is backgrounded, minimized, or the screen is off — they resume when
  // the app regains focus (resume path: fresh GPS + resync + this interval).
  // The gate uses uiGate.isUIHidden(), NOT document.hidden: the APK shell does
  // not fire visibilitychange on screen off/on, so on native the hidden flag is
  // maintained by the Capacitor appStateChange listener wired into uiGate
  // (locationTracker). On web/PWA isUIHidden() tracks document.hidden exactly.
  // The 10s CHECK_THROTTLE dedupes against Trigger 1 when both fire.
  useEffect(() => {
    // Owner rule (Oct 13 2026): deviation detection is a driver-primary-device
    // feature. Non-primary driver devices, admins, and dispatchers never run
    // the safety interval AT ALL — previously every device ran it and logged
    // gate:no_last_position / gate:not_driver_device on each 15s tick, which
    // flooded RemoteLogEntry (each write is an API call against the shared
    // per-user rate budget) and helped cause the afternoon 429 storms.
    if (!isDriver || !isPrimaryDevice) return;
    const iv = setInterval(() => {
      if (isUIHidden()) { _diag('gate:hidden_ui'); return; } // background OFF by owner design
      const lp = locationTracker?.lastPosition;
      if (!Number.isFinite(Number(lp?.latitude)) || !Number.isFinite(Number(lp?.longitude))) {
        _diag('gate:no_last_position'); // tracker has no fix yet
        return;
      }
      tick({ latitude: lp.latitude, longitude: lp.longitude, timestamp: new Date().toISOString(), accuracy: lp.accuracy });
    }, 15000);
    return () => clearInterval(iv);
  }, [tick, isDriver, isPrimaryDevice]);
}

export default useRouteDeviationMonitor;
