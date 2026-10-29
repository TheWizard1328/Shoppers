import { useEffect, useState } from "react";
import { base44 } from '@/api/base44Client';
import { decodeGooglePolyline } from '@/components/utils/routePolylineGenerator';
import { haversineKm } from '@/components/utils/geoUtils';
import { commitDeliveryUpdatesSilently } from '@/components/utils/routeCommitMarker';
import { calculateDeliveryPay } from '@/components/utils/payCalculator';
import { parseAnyTimestamp } from '@/components/utils/albertaTime';
import { totalOnDutyMinutes as sharedTotalOnDutyMinutes, hasOpenSegment, segmentsLookIncoherent } from '@/components/utils/driverDutyTime';
import { fetchDriverDailyActivityCached, invalidateDriverDailyActivityCache } from '@/components/utils/driverDailyActivityCache';

// Polyline-derived leg km cache — key id:polylineSignature so a re-render
// (or a value the server healed) never re-decodes the same leg twice.
const _polylineKmCache = new Map();
const _healedSig = new Set();

// Road length of a stored leg polyline — the AUTHORITATIVE per-stop distance
// under the v372 single-writer rule: travel_dist is supposed to be exactly
// this value. Decoding + haversine per finished leg, memoized by signature.
const _polylineLegKm = (delivery) => {
  const poly = delivery?.encoded_polyline;
  if (typeof poly !== "string" || poly.length <= 10) return 0;
  const sig = `${delivery.id}:${poly.length}:${delivery.stop_order || 0}`;
  if (_polylineKmCache.has(sig)) return _polylineKmCache.get(sig);
  let km = 0;
  try {
    const pts = decodeGooglePolyline(poly);
    for (let i = 1; i < pts.length; i++) {
      km += haversineKm(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    }
  } catch (_) { km = 0; }
  km = Number(km.toFixed(3));
  if (_polylineKmCache.size > 500) _polylineKmCache.clear();
  _polylineKmCache.set(sig, km);
  return km;
};

// Last-seen driver_status per driver — duty toggles (on_duty/off_duty/on_break)
// always accompany DriverDailyActivity segment changes, so a status flip is the
// signal to drop that driver's cached segments instead of waiting out the TTL.
const _lastSeenDriverStatus = new Map();
// One forced DriverDailyActivity revalidate per driver+date+duty-state per session
// (owner report Oct 28 2026 — stale IDB record / unclosed segment).
const _dutyForceRefreshed = new Set();
// Authoritative driver_status per driver+date, resolved ONCE when the local
// AppUser copy disagrees with an OPEN segment (owner report Oct 29 2026).
const _authDutyStatus = new Map();

/**
 * Computes performance stats (pay, km, extra km, duty time) for the currently
 * selected driver using the SAME calculation path for every role — driver
 * self-view, admin viewing any driver, or all-drivers aggregation.
 *
 * Per the user's request: the pay values come straight from the AppUser record of
 * the selected driver. If that driver's pay rates are missing from the React
 * `appUsers` snapshot (which only ~5min later is fully populated by the smart
 * refresh poll), the hook calls AppUser.filter({ user_id }) to fetch them so
 * StatsCard Total Pay never falls back to $0.
 */
export function useLocalPerformanceStats({
  currentUser,
  isDataLoaded,
  isDispatcher,
  isAdmin,
  isDriver,
  selectedDriverId,
  filteredDeliveries,
  patients,
  appUsers,
  setPerformanceStats,
  setIsLoadingPayrollStats
}) {
  // Cached fresh AppUser record(s) fetched on demand when pay rates are missing.
  // Keyed by user_id so multiple selections are remembered within the session.
  const [freshAppUserMap, setFreshAppUserMap] = useState({});

  useEffect(() => {
    if (!currentUser?.id || !isDataLoaded || isDispatcher) {
      setPerformanceStats(null);
      setIsLoadingPayrollStats(false);
      return;
    }

    const finishedStatuses = ["completed", "failed", "cancelled", "returned"];
    const patientMap = new Map((patients || []).filter((p) => p?.id).map((p) => [p.id, p]));
    const driverAppUserMap = new Map((appUsers || []).filter((au) => au?.user_id).map((au) => [au.user_id, au]));

    const extractLocalTimeMinutes = (timeStr) => {
      if (!timeStr) return null;
      const match = timeStr.match(/T(\d{2}):(\d{2})/);
      if (!match) return null;
      return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
    };

    const formatMinutes = (totalMinutes) => {
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    };

    const isReturnStop = (delivery) => {
      if (!delivery) return false;
      const patient = delivery.patient_id ? patientMap.get(delivery.patient_id) : null;
      const notes = delivery.delivery_notes || "";
      const patientName = delivery.patient_name || patient?.full_name || "";
      if (notes.toLowerCase().includes("(rtn)") || patientName.toLowerCase().includes("(rtn)")) return true;
      return /\breturn\b/i.test(notes) || /\breturn\b/i.test(patientName);
    };

    const isFailedStop = (delivery) => {
      if (!delivery || isReturnStop(delivery)) return false;
      if (delivery.status === "failed") return true;
      if (delivery.status === "cancelled" && !delivery.patient_id) return true;
      return false;
    };

    const isCompletedStop = (delivery) => {
      if (!delivery || delivery.status !== "completed") return false;
      return !isReturnStop(delivery);
    };

    // TRUE if the AppUser record we just resolved has pay rate data present.
    // Used to decide whether we need an async fetch to enrich it.
    const hasPayRates = (au) =>
      au != null && (au.pay_rate_per_delivery != null || au.extra_km_rate != null || au.oversized_item_rate != null);

    const resolveSelectedAppUserMapSync = () => {
      const map = new Map();
      // Prefer freshly fetched records; fall back to the React appUsers snapshot.
      Object.entries(freshAppUserMap).forEach(([uid, au]) => { if (au) map.set(uid, au); });
      (appUsers || []).forEach((au) => {
        if (!au?.user_id) return;
        if (map.has(au.user_id)) {
          // Fresh single-driver record wins on pay fields only — keep the rest.
          const fresh = map.get(au.user_id);
          map.set(au.user_id, { ...au, ...fresh });
        } else {
          map.set(au.user_id, au);
        }
      });
      return map;
    };

    // We run the calculation synchronously whenever we have *some* AppUser data;
    // if pay rates are missing for the selected driver, we fetch fresh and re-run.
    const compute = (resolvedMap) => {
      const driverIds = selectedDriverId && selectedDriverId !== "all"
        ? [selectedDriverId]
        : [...new Set((filteredDeliveries || []).map((d) => d?.driver_id).filter(Boolean))];

      if (driverIds.length === 0) {
        return {
          totalPay: 0,
          totalKm: 0,
          totalExtraKm: 0,
          totalTimeOnDuty: "00:00",
          extraKmLimit: 0,
          _driverId: selectedDriverId || null
        };
      }

      let totalPay = 0;
      let totalKm = 0;
      let totalExtraKm = 0;
      let totalDutyMinutes = 0;
      let singleDriverExtraKmLimit = 0;

      let allDriversEarliestMinutes = null;
      let allDriversLatestMinutes = null;
      const isAllDrivers = driverIds.length > 1;

      driverIds.forEach((driverId) => {
        const driverAppUser = resolvedMap.get(driverId);
        const extraKmLimit = driverAppUser?.extra_km_limit || 0;
        const driverStatus = driverAppUser?.driver_status;
        const driverDeliveries = (filteredDeliveries || []).filter((d) => d?.driver_id === driverId);

        if (driverIds.length === 1) {
          singleDriverExtraKmLimit = extraKmLimit;
        }

        const isInterStore = (d) => { const id = String(d?.delivery_id || '').toUpperCase(); return id.startsWith('ISD-') || id.startsWith('ISP-'); };

        const paidDeliveries = driverDeliveries.filter((delivery) => {
          if (!delivery) return false;
          if (delivery.patient_id) return isCompletedStop(delivery) || isFailedStop(delivery) || isReturnStop(delivery);
          if (delivery.after_hours_pickup) return delivery.status === "completed" || delivery.status === "cancelled";
          if (isInterStore(delivery)) return delivery.status === "completed" || delivery.status === "failed";
          return false;
        });

        // Use the canonical per-delivery pay calculator — keeps StatsCard Total Pay
        // identical to the stop-card badges (AH patient deliveries pay 2x base;
        // AH store pickups pay 1x base; regular pickups pay 0; N/C deliveries skip
        // base pay but oversized + extra km are still payable).
        paidDeliveries.forEach((delivery) => {
          const patient = delivery?.patient_id ? patientMap.get(delivery.patient_id) : null;
          totalPay += calculateDeliveryPay(delivery, driverAppUser, patient);

          // Extra km debug total feeds the "Extra" badge — not part of calculateDeliveryPay's return.
          const distance = delivery.paid_km_override !== null && delivery.paid_km_override !== undefined
            ? parseFloat(delivery.paid_km_override)
            : patient?.distance_from_store;

          if (typeof distance === "number" && !Number.isNaN(distance) && distance > extraKmLimit) {
            totalExtraKm += distance - extraKmLimit;
          }
        });

        const finishedDeliveries = driverDeliveries.filter((delivery) => {
          if (!delivery?.actual_delivery_time) return false;
          return isCompletedStop(delivery) || isFailedStop(delivery) || isReturnStop(delivery);
        });

        const _healQueue = [];

        finishedDeliveries.forEach((delivery) => {
          // OWNER RULE (Oct 21 2026): every finished stop's leg distance
          // counts — stop one included. travel_dist is the polyline-stamped
          // leg km (v372 single-writer rule). A 0/absent travel_dist is the
          // OLD completion-zeroing bug's stamp (the pre-v372 code wrote
          // travel_dist=0 to the first finished stop) — fall through to the
          // leg estimate instead of counting the stop as 0 km.
          const _estKm = typeof delivery?.estimated_distance_km === "number" ? delivery.estimated_distance_km : 0;
          // OWNER RULE (Oct 21 2026, retro correction): the stored leg
          // polyline is the source of truth for a finished stop's km —
          // today's route was completed under the old writers (stop one
          // zeroed, others stamped with straight-line last-stop->this-stop
          // haversines), so travel_dist UNDERCOUNTS (~61 vs ~100 km).
          // Polyline km wins; stale/zero/absent travel_dist values are
          // healed to it via one silent bulk commit (fire-and-forget).
          const _plKm = _polylineLegKm(delivery);
          const distToUse =
            (_plKm > 0) ? _plKm
            : (typeof delivery?.travel_dist === "number" && delivery.travel_dist > 0) ? delivery.travel_dist
            : (_estKm > 0 ? _estKm
            : (() => {
                const patient = delivery?.patient_id ? patientMap.get(delivery.patient_id) : null;
                return typeof patient?.distance_from_store === "number" ? patient.distance_from_store : 0;
              })());
          totalKm += distToUse;
          const _sig = `${delivery.id}:${(delivery.encoded_polyline || "").length}:${delivery.stop_order || 0}`;
          if (_plKm > 0 && Math.abs(Number(delivery.travel_dist || 0) - _plKm) > 0.05 && !_healedSig.has(_sig)) {
            _healedSig.add(_sig);
            _healQueue.push({ id: delivery.id, data: { travel_dist: _plKm } });
          }
        });

        // RETRO CORRECTION (owner, Oct 21 2026): heal stale travel_dist stamps
        // (old straight-line/zeroed writers) to the polyline-derived road km.
        // One silent bulk commit — zero WS broadcasts, deduped by signature so
        // a recompute never re-writes the same leg.
        if (_healQueue.length > 0) {
          const batch = _healQueue.splice(0, _healQueue.length);
          commitDeliveryUpdatesSilently(batch).catch(() => {});
        }

        // OWNER RULE (Oct 21 2026): total distance = FINISHED stops only.
        // The in-progress leg does NOT count — its km joins the total when
        // the stop is completed (polyline leg, v372 single-writer rule).

        const finishedStopsWithTimes = driverDeliveries
          .filter((delivery) => delivery?.actual_delivery_time)
          .map((delivery) => ({
            ...delivery,
            localMinutes: extractLocalTimeMinutes(delivery.actual_delivery_time)
          }))
          .filter((delivery) => delivery.localMinutes !== null)
          .sort((a, b) => a.localMinutes - b.localMinutes);

        if (finishedStopsWithTimes.length > 0) {
          const firstMinutes = finishedStopsWithTimes[0].localMinutes;
          const patientDeliveriesOnly = driverDeliveries.filter((delivery) => delivery?.patient_id);
          const routeComplete = patientDeliveriesOnly.length > 0 && patientDeliveriesOnly.every((delivery) => finishedStatuses.includes(delivery.status));
          let endMinutes = finishedStopsWithTimes[finishedStopsWithTimes.length - 1].localMinutes;

          if (!routeComplete && driverStatus === "on_duty") {
            const now = new Date();
            endMinutes = now.getHours() * 60 + now.getMinutes();
          }

          if (isAllDrivers) {
            if (allDriversEarliestMinutes === null || firstMinutes < allDriversEarliestMinutes) {
              allDriversEarliestMinutes = firstMinutes;
            }
            if (allDriversLatestMinutes === null || endMinutes > allDriversLatestMinutes) {
              allDriversLatestMinutes = endMinutes;
            }
          } else {
            let rawDurationMinutes = endMinutes - firstMinutes;
            if (rawDurationMinutes < 0) rawDurationMinutes += 24 * 60;
            totalDutyMinutes += Math.max(0, rawDurationMinutes);
          }
        }
      });

      if (isAllDrivers && allDriversEarliestMinutes !== null && allDriversLatestMinutes !== null) {
        let span = allDriversLatestMinutes - allDriversEarliestMinutes;
        if (span < 0) span += 24 * 60;
        totalDutyMinutes = Math.max(0, span);
      }

      return {
        totalPay,
        totalKm,
        totalExtraKm,
        totalTimeOnDuty: isAllDrivers ? formatMinutes(totalDutyMinutes) : undefined,
        totalDutyMinutesRaw: totalDutyMinutes, // used by single-driver branch below
        extraKmLimit: isAllDrivers ? 0 : singleDriverExtraKmLimit,
        _singleDriver: !isAllDrivers,
        _singleDriverId: !isAllDrivers ? driverIds[0] : null
      };
    };

    // Single-driver path: always use DriverDailyActivity segments for duty time.
    const finalizeSingleDriverDuty = (stats, totalDutyMinutes) => {
      setPerformanceStats(prev => ({
        totalPay: stats.totalPay,
        totalKm: stats.totalKm,
        totalExtraKm: stats.totalExtraKm,
        totalTimeOnDuty: prev?.totalTimeOnDuty ?? '--:--',
        extraKmLimit: stats.extraKmLimit
      }));
      setIsLoadingPayrollStats(false);

      if (!stats._singleDriverId) return;
      const segDriverId = stats._singleDriverId;
      const segDate = (() => {
        const anyDelivery = (filteredDeliveries || []).find(d => d?.driver_id === segDriverId && d?.delivery_date);
        return anyDelivery?.delivery_date || new Date().toISOString().split('T')[0];
      })();

      (async () => {
        try {
          // Duty-toggle invalidation: driver_status change ⇒ segments changed.
          // (Was a raw server fetch on EVERY WS event — see driverDailyActivityCache.js)
          const segAppUser = (appUsers || []).find(au => au?.user_id === segDriverId)
            || (freshAppUserMap && freshAppUserMap[segDriverId]);
          const segStatus = segAppUser?.driver_status || null;
          const prevStatus = _lastSeenDriverStatus.get(segDriverId);
          if (prevStatus !== undefined && prevStatus !== segStatus) {
            invalidateDriverDailyActivityCache(segDriverId, segDate);
          }
          _lastSeenDriverStatus.set(segDriverId, segStatus);
          // OWNER REPORT (Oct 28 2026): the card must show the SAME number as
          // the Driver Activity page and must never keep counting once the
          // driver is off duty. Two failure modes caused the drift:
          //   • phone kept counting: the local record held an OPEN segment long
          //     after auto-off-duty closed it server-side, and the math ran that
          //     segment against "now" forever.
          //   • tablet showed 2h: the IDB-first cache served a stale record and
          //     never revalidated, while the activity page read the server.
          // Fix: read the authoritative record ONCE when the driver is off duty
          // or their stale copy still has an open segment (forced revalidate,
          // memoized per driver+date), and stop running open segments against
          // the clock while off duty.
          let dailyRec = await fetchDriverDailyActivityCached(segDriverId, segDate);
          const _isOnDutyStatus = String(segStatus || '').toLowerCase() === 'on_duty';
          // "Route finished" also ends the live clock: the owner's report was a
          // driver whose route was done while the card kept counting. Duty time
          // stops accruing once every stop for that day is terminal.
          const _FINISHED = ['completed', 'failed', 'cancelled'];
          const _dayStops = (filteredDeliveries || []).filter(d => d?.driver_id === segDriverId && d?.delivery_date === segDate);
          const _routeFinishedToday = _dayStops.length > 0 && _dayStops.every(d => _FINISHED.includes(String(d?.status || '').toLowerCase()));
          const isOnDutyNow = _isOnDutyStatus && !_routeFinishedToday;
          // OWNER REPORT (Oct 29 2026): also revalidate when the LOCAL legs are
          // incoherent with the live duty state — driver on duty but no open leg
          // (phone: only the closed 160 min showed) or an open leg that starts
          // before the last closed leg ends (tablet: the 25-minute break was
          // never banked, so it displayed as one long 5h19 shift). Normal local
          // records are still computed entirely on-device, no server pull.
          const needsFresh = !isOnDutyNow
            || hasOpenSegment(dailyRec)
            || segmentsLookIncoherent(dailyRec, { onDutyNow: _isOnDutyStatus && !_routeFinishedToday, routeFinished: _routeFinishedToday, nowMs: Date.now() });
          if (needsFresh) {
            const _forceKey = `${segDriverId}:${segDate}:${isOnDutyNow ? 'open' : 'off'}`;
            if (!_dutyForceRefreshed.has(_forceKey)) {
              try {
                dailyRec = await fetchDriverDailyActivityCached(segDriverId, segDate, { force: true }) || dailyRec;
                _dutyForceRefreshed.add(_forceKey);
              } catch (_) { /* keep the local copy on failure */ }
            }
          }
          // ── AUTHORITATIVE DUTY STATE (owner report Oct 29 2026) ──────────
          // Phone showed 2h40 while the tablet showed 4h45 for the SAME record
          // (closed 160 min + an OPEN segment since 12:45). The phone's local
          // AppUser copy still said off_duty, so `liveOpenSegment` was false and
          // the open shift simply vanished — half the number. A record that
          // still holds an OPEN segment while the day has unfinished stops and
          // the local status says otherwise means the LOCAL status is the stale
          // side; read the server's driver_status once and decide from that. The
          // guarded reference resolution above already handles the genuine
          // off-duty case.
          let _dutyStatusFinal = segStatus;
          if (!_isOnDutyStatus && !_routeFinishedToday && hasOpenSegment(dailyRec)) {
            const _authKey = `${segDriverId}:${segDate}`;
            if (!_authDutyStatus.has(_authKey)) {
              try {
                const _authRows = await base44.entities.AppUser.filter({ user_id: segDriverId }, '-updated_date', 1);
                const _authStatus = _authRows?.[0]?.driver_status;
                if (_authStatus) _authDutyStatus.set(_authKey, String(_authStatus).toLowerCase());
              } catch (_) { /* keep the local copy on failure */ }
            }
            const _authStatus = _authDutyStatus.get(_authKey);
            if (_authStatus) {
              _dutyStatusFinal = _authStatus;
              if (_authStatus === 'on_duty') {
                console.log(`[DutyTime] local status "${segStatus || 'unknown'}" disagreed with an OPEN segment — using server status "on_duty" for ${segDriverId}`);
              }
            }
          }
          const isOnDutyNowFinal = (String(_dutyStatusFinal || '').toLowerCase() === 'on_duty') && !_routeFinishedToday;

          const segments = dailyRec?.activity_segments;
          if (Array.isArray(segments) && segments.length > 0) {
            const nowMs = Date.now();

            // SHARED DUTY MATH (owner directive Oct 27 2026): the stats card
            // uses the EXACT same on-duty computation as the Admin Driver
            // Activity page — one shared module (driverDutyTime.js), per-segment
            // sum. liveOpenSegment is TRUE only while the driver is actually on
            // duty, so a route-finished driver's clock stops.
            const segMinutes = sharedTotalOnDutyMinutes(dailyRec, nowMs, { liveOpenSegment: isOnDutyNowFinal });

            const cappedMinutes = Math.min(segMinutes, 1440);
            setPerformanceStats(prev => prev ? { ...prev, totalTimeOnDuty: formatMinutes(cappedMinutes) } : null);
          } else {
            setPerformanceStats(prev => prev ? { ...prev, totalTimeOnDuty: formatMinutes(totalDutyMinutes) } : null);
          }
        } catch (_) {
          setPerformanceStats(prev => prev ? { ...prev, totalTimeOnDuty: formatMinutes(totalDutyMinutes) } : null);
        }
      })();
    };

    const run = () => {
      const resolvedMap = resolveSelectedAppUserMapSync();
      const stats = compute(resolvedMap);

      if (stats._singleDriver) {
        finalizeSingleDriverDuty(stats, stats.totalDutyMinutesRaw);
      } else {
        // Multi-driver / all
        setPerformanceStats({
          totalPay: stats.totalPay,
          totalKm: stats.totalKm,
          totalExtraKm: stats.totalExtraKm,
          totalTimeOnDuty: stats.totalTimeOnDuty,
          extraKmLimit: stats.extraKmLimit
        });
        setIsLoadingPayrollStats(false);
      }

      // Whether the single selected driver is missing pay rates — if so, fetch & recompute.
      if (selectedDriverId && selectedDriverId !== 'all') {
        const existing = resolvedMap.get(selectedDriverId);
        if (!hasPayRates(existing)) {
          (async () => {
            try {
              const fresh = await base44.entities.AppUser.filter({ user_id: selectedDriverId });
              const freshAu = fresh?.[0];
              if (!freshAu) return;
              setFreshAppUserMap(prev => ({ ...prev, [selectedDriverId]: freshAu }));
            } catch (_) {
              // Ignore — leave current calc (best-effort) in place
            }
          })();
        }
      }
    };

    run();
  }, [
    currentUser?.id,
    isDataLoaded,
    isDispatcher,
    isAdmin,
    isDriver,
    selectedDriverId,
    filteredDeliveries,
    patients,
    appUsers,
    freshAppUserMap,
    setPerformanceStats,
    setIsLoadingPayrollStats
  ]);
}