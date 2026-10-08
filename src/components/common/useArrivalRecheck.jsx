import { useEffect, useRef } from 'react';
import { haversineMeters } from '@/components/utils/geoUtils';
import { getCachedWinterModeSync } from '@/components/utils/winterModeSettings';

/**
 * SECONDARY arrival re-check for the Complete-button arrival gate (Oct 8 2026).
 *
 * Owner report: once in a while the footer Complete button stays gated (disabled
 * on missing arrival_time) even though the driver is parked at the stop, because:
 *   1. the app was (re)loaded while already at the location — the 30s-stationary
 *      timer only starts on the first GPS fix after load, and GPS jitter >20m
 *      between ticks can reset it indefinitely;
 *   2. the arrival write failed silently (offline / server in-flight) and nothing
 *      re-tried it;
 *   3. a stale WS echo / background server fetch wiped the recorded arrival_time
 *      (also fixed via STRICT_PRESERVE_FIELDS in realtimeSync).
 *
 * This hook is the UI-side safety net. It is mounted ONLY while the gate is
 * actually active (isNextDelivery stop, blank arrival_time, non-retro timing):
 *   • listens to `driverPositionUpdated` (fired on every live GPS tick while
 *     foreground) and falls back to locationTracker.lastPosition every 10s;
 *   • tracks CUMULATIVE time inside the arrival geofence — tolerant of GPS
 *     jitter (only resets when the driver leaves the radius, never on a 20m
 *     move between ticks, unlike the primary stationary timer);
 *   • once 35s cumulative in-radius (5s grace over the primary 30s), calls
 *     arrivalTimeDetector.checkImmediateArrival, which reuses the proven write
 *     path (server + IDB + pullToSyncDataReady state push + co-located stops);
 *   • retries every 15s while the gate persists, so a failed write self-heals.
 *
 * It intentionally does NOT bypass the gate directly — it re-records the missing
 * arrival_time, which re-enables the button through the normal data flow.
 */
const SECONDARY_MIN_CUMULATIVE_MS = 35000; // 35s cumulative in-radius
const RETRY_EVERY_MS = 15000;             // re-attempt while still gated
const POLL_INTERVAL_MS = 10000;           // fallback position poll
const RADIUS_TOLERANCE = 1.25;            // 25% jitter buffer over the geofence

export function useArrivalRecheck({ enabled, delivery, patient, store, driverId }) {
  const inRadiusSinceRef = useRef(null);
  const lastAttemptRef = useRef(0);
  const detailRef = useRef({ delivery, patient, store, driverId });
  detailRef.current = { delivery, patient, store, driverId };

  useEffect(() => {
    if (!enabled) {
      inRadiusSinceRef.current = null;
      return;
    }

    const stopCoords = () => {
      const d = detailRef.current.delivery;
      if (!d) return null;
      if (d.is_cycling_marker) {
        return d.cycling_latitude && d.cycling_longitude
          ? { lat: d.cycling_latitude, lon: d.cycling_longitude }
          : null;
      }
      const p = detailRef.current.patient;
      if (d.patient_id && p?.latitude && p?.longitude) return { lat: p.latitude, lon: p.longitude };
      const s = detailRef.current.store;
      if (s?.latitude && s?.longitude) return { lat: s.latitude, lon: s.longitude };
      return null;
    };

    const attemptStamp = (latitude, longitude) => {
      const { driverId: uid, delivery: d } = detailRef.current;
      if (!uid || !d?.delivery_date) return;
      const now = Date.now();
      if (now - lastAttemptRef.current < RETRY_EVERY_MS) return;
      lastAttemptRef.current = now;
      // eslint-disable-next-line no-undef
      import('@/components/utils/arrivalTimeDetector')
        .then(({ arrivalTimeDetector }) =>
          arrivalTimeDetector.checkImmediateArrival(latitude, longitude, uid, d.delivery_date)
        )
        .then(() => { inRadiusSinceRef.current = null; })
        .catch((err) =>
          console.warn('⚠️ [ArrivalRecheck] secondary arrival stamp failed:', err?.message)
        );
    };

    const handlePosition = (latitude, longitude) => {
      const target = stopCoords();
      if (!target) return;
      const winter = getCachedWinterModeSync();
      const radius = (winter.enabled ? winter.arrival_radius_m : 100) * RADIUS_TOLERANCE;
      const dist = haversineMeters(latitude, longitude, target.lat, target.lon);
      const now = Date.now();
      if (dist <= radius) {
        if (!inRadiusSinceRef.current) inRadiusSinceRef.current = now;
        if (now - inRadiusSinceRef.current >= SECONDARY_MIN_CUMULATIVE_MS) {
          attemptStamp(latitude, longitude);
        }
      } else {
        // Only leaving the geofence resets the cumulative timer — GPS jitter
        // between ticks while parked must NEVER reset it (that's the primary
        // flow's exact failure mode this hook exists to cover).
        inRadiusSinceRef.current = null;
      }
    };

    // Guard: the position must belong to the SAME driver whose stop card is gated.
    // On a dispatcher/admin device the card may show another driver's stop — a
    // dispatcher standing near the patient location must never stamp that
    // driver's arrival_time.
    const onPositionEvent = (e) => {
      const pos = e?.detail;
      const ownCard = detailRef.current.driverId;
      if (pos?.userId && ownCard && pos.userId !== ownCard) return;
      if (pos?.latitude && pos?.longitude) handlePosition(pos.latitude, pos.longitude);
    };

    window.addEventListener('driverPositionUpdated', onPositionEvent);

    // Fallback poll: on some devices the position event can stop firing (e.g.
    // WebView quirks); the tracker's cached lastPosition stays fresh regardless.
    let pollTimer = null;
    const startPoll = () => {
      pollTimer = setInterval(async () => {
        try {
          const { locationTracker } = await import('@/components/utils/locationTracker');
          const ownCard = detailRef.current.driverId;
          if (ownCard && locationTracker?.currentUser?.id && locationTracker.currentUser.id !== ownCard) return;
          const lp = locationTracker?.lastPosition;
          if (lp?.latitude && lp?.longitude) handlePosition(lp.latitude, lp.longitude);
        } catch (_) { /* tracker unavailable — skip this tick */ }
      }, POLL_INTERVAL_MS);
    };
    startPoll();

    return () => {
      window.removeEventListener('driverPositionUpdated', onPositionEvent);
      if (pollTimer) clearInterval(pollTimer);
      inRadiusSinceRef.current = null;
    };
  }, [enabled]);
}

export default useArrivalRecheck;
