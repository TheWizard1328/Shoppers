import { useEffect, useState } from "react";
import { base44 } from '@/api/base44Client';

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
        const payRatePerDelivery = driverAppUser?.pay_rate_per_delivery || 0;
        const extraKmRate = driverAppUser?.extra_km_rate || 0;
        const extraKmLimit = driverAppUser?.extra_km_limit || 0;
        const oversizedRate = driverAppUser?.oversized_item_rate || 0;
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

        // N/C deliveries skip BASE pay only — oversized and extra km are still payable.
        const noChargeCount = paidDeliveries.filter((d) => d?.no_charge === true).length;
        totalPay += (paidDeliveries.length - noChargeCount) * payRatePerDelivery;
        totalPay += paidDeliveries.filter((delivery) => delivery?.oversized === true).length * oversizedRate;

        paidDeliveries.forEach((delivery) => {
          const patient = delivery?.patient_id ? patientMap.get(delivery.patient_id) : null;
          const distance = delivery.paid_km_override !== null && delivery.paid_km_override !== undefined
            ? parseFloat(delivery.paid_km_override)
            : patient?.distance_from_store;

          if (typeof distance === "number" && !Number.isNaN(distance) && distance > extraKmLimit) {
            const extraKm = distance - extraKmLimit;
            totalExtraKm += extraKm;
            totalPay += extraKm * extraKmRate;
          }
        });

        const finishedDeliveries = driverDeliveries.filter((delivery) => {
          if (!delivery?.actual_delivery_time) return false;
          return isCompletedStop(delivery) || isFailedStop(delivery) || isReturnStop(delivery);
        });

        const activeDelivery = driverDeliveries.find((d) => d?.isNextDelivery === true && !finishedStatuses.includes(d.status));

        finishedDeliveries.forEach((delivery) => {
          const distToUse =
            typeof delivery?.travel_dist === "number" ? delivery.travel_dist
            : typeof delivery?.estimated_distance_km === "number" ? delivery.estimated_distance_km
            : (() => {
                const patient = delivery?.patient_id ? patientMap.get(delivery.patient_id) : null;
                return typeof patient?.distance_from_store === "number" ? patient.distance_from_store : 0;
              })();
          totalKm += distToUse;
        });

        if (activeDelivery) {
          const activeLegKm =
            typeof activeDelivery.estimated_distance_km === "number" ? activeDelivery.estimated_distance_km
            : typeof activeDelivery.travel_dist === "number" ? activeDelivery.travel_dist
            : 0;
          totalKm += activeLegKm;
        }

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
          const recs = await base44.entities.DriverDailyActivity.filter({
            driver_id: segDriverId,
            activity_date: segDate
          });
          const segments = recs?.[0]?.activity_segments;
          if (Array.isArray(segments) && segments.length > 0) {
            const nowMs = Date.now();
            const ranges = segments
              .filter(s => s?.start_time)
              .map(s => ({
                start: new Date(s.start_time).getTime(),
                end: s.end_time ? new Date(s.end_time).getTime() : nowMs
              }))
              .sort((a, b) => a.start - b.start);

            const merged = [];
            for (const r of ranges) {
              const last = merged[merged.length - 1];
              if (last && r.start <= last.end) {
                last.end = Math.max(last.end, r.end);
              } else {
                merged.push({ start: r.start, end: r.end });
              }
            }

            const segMinutes = merged.reduce((sum, r) => {
              return sum + Math.max(0, Math.round((r.end - r.start) / 60000));
            }, 0);

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