import { useEffect } from "react";
import { base44 } from '@/api/base44Client';

export function useLocalPerformanceStats({
  currentUser,
  isDataLoaded,
  isDispatcher,
  selectedDriverId,
  filteredDeliveries,
  patients,
  appUsers,
  setPerformanceStats,
  setIsLoadingPayrollStats
}) {
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

    const driverIds = selectedDriverId && selectedDriverId !== "all"
      ? [selectedDriverId]
      : [...new Set((filteredDeliveries || []).map((d) => d?.driver_id).filter(Boolean))];

    if (driverIds.length === 0) {
      setPerformanceStats({
        totalPay: 0,
        totalKm: 0,
        totalExtraKm: 0,
        totalTimeOnDuty: "00:00",
        extraKmLimit: 0
      });
      setIsLoadingPayrollStats(false);
      return;
    }

    let totalPay = 0;
    let totalKm = 0;
    let totalExtraKm = 0;
    let totalDutyMinutes = 0;
    let singleDriverExtraKmLimit = 0;

    // For "all drivers" mode we track the earliest and latest finished-stop times
    // across all drivers so the duty window is overall span, not a sum.
    let allDriversEarliestMinutes = null;
    let allDriversLatestMinutes = null;
    const isAllDrivers = driverIds.length > 1;

    driverIds.forEach((driverId) => {
      const driverAppUser = driverAppUserMap.get(driverId);
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

      totalPay += paidDeliveries.length * payRatePerDelivery;
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

      // Active (isNextDelivery) delivery - use estimated_distance_km as a non-accumulating
      // estimate so we never double-count GPS increments written by liveDistanceTracker.
      const activeDelivery = driverDeliveries.find((d) => d?.isNextDelivery === true && !finishedStatuses.includes(d.status));

      finishedDeliveries.forEach((delivery) => {
        // Prefer travel_dist when it has been set (actual measured distance from GPS breadcrumbs
        // or live tracking). Fall back to estimated_distance_km (HERE route estimate) and then
        // patient distance_from_store as a last resort.
        const distToUse =
          typeof delivery?.travel_dist === "number" ? delivery.travel_dist
          : typeof delivery?.estimated_distance_km === "number" ? delivery.estimated_distance_km
          : (() => {
              const patient = delivery?.patient_id ? patientMap.get(delivery.patient_id) : null;
              return typeof patient?.distance_from_store === "number" ? patient.distance_from_store : 0;
            })();
        totalKm += distToUse;
      });

      // Add the active leg as its route estimate (not the live GPS value).
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
        // Note: totalDutyMinutes will be overridden below if activity_segments are available

        if (isAllDrivers) {
          // Track overall span across all drivers
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

    // For all-drivers mode, compute duty span from earliest first stop to latest last stop
    if (isAllDrivers && allDriversEarliestMinutes !== null && allDriversLatestMinutes !== null) {
      let span = allDriversLatestMinutes - allDriversEarliestMinutes;
      if (span < 0) span += 24 * 60;
      totalDutyMinutes = Math.max(0, span);
    }

    // ── Prefer activity_segments for single-driver view ──────────────────────
    // If the selected driver has a DriverDailyActivity record with segments,
    // use the segment sum (closed tots + live open segment) as the authoritative
    // on-duty time rather than the first-stop to last-stop span.
    // This is done asynchronously — it fires a second setPerformanceStats
    // update once the DB read resolves, so the UI shows the span first then
    // immediately corrects to the segment-based value.
    if (!isAllDrivers && driverIds.length === 1 && isDataLoaded) {
      const segDriverId = driverIds[0];
      const segDate = (() => {
        // Derive selected date from filteredDeliveries
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
            const segMinutes = segments.reduce((sum, seg) => {
              if (!seg?.start_time) return sum;
              if (seg.end_time && typeof seg.tot === 'number') return sum + seg.tot;
              if (!seg.end_time) {
                return sum + Math.max(0, Math.round((nowMs - new Date(seg.start_time).getTime()) / 60000));
              }
              return sum;
            }, 0);
            setPerformanceStats(prev => prev
              ? { ...prev, totalTimeOnDuty: formatMinutes(segMinutes) }
              : null
            );
          }
        } catch (_) { /* non-critical — span fallback already set */ }
      })();
    }

    setPerformanceStats({
      totalPay,
      totalKm,
      totalExtraKm,
      totalTimeOnDuty: formatMinutes(totalDutyMinutes),
      extraKmLimit: driverIds.length === 1 ? singleDriverExtraKmLimit : 0
    });
    setIsLoadingPayrollStats(false);
  }, [
    currentUser?.id,
    isDataLoaded,
    isDispatcher,
    selectedDriverId,
    filteredDeliveries,
    patients,
    appUsers,
    setPerformanceStats,
    setIsLoadingPayrollStats
  ]);
}