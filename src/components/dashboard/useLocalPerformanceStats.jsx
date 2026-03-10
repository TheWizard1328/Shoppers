import { useEffect } from "react";

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

      const paidDeliveries = driverDeliveries.filter((delivery) => {
        if (!delivery) return false;
        if (delivery.patient_id) return isCompletedStop(delivery) || isFailedStop(delivery) || isReturnStop(delivery);
        if (delivery.after_hours_pickup) return delivery.status === "completed" || delivery.status === "cancelled";
        return false;
      });

      totalPay += paidDeliveries.length * payRatePerDelivery;
      totalPay += paidDeliveries.filter((delivery) => delivery?.oversized === true).length * oversizedRate;

      paidDeliveries.forEach((delivery) => {
        if (!delivery?.patient_id) return;
        const patient = patientMap.get(delivery.patient_id);
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

      finishedDeliveries.forEach((delivery) => {
        if (typeof delivery?.travel_dist === "number") {
          totalKm += delivery.travel_dist;
          return;
        }
        const patient = delivery?.patient_id ? patientMap.get(delivery.patient_id) : null;
        if (typeof patient?.distance_from_store === "number") {
          totalKm += patient.distance_from_store;
        }
      });

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

        let rawDurationMinutes = endMinutes - firstMinutes;
        if (rawDurationMinutes < 0) rawDurationMinutes += 24 * 60;
        totalDutyMinutes += Math.max(0, rawDurationMinutes);
      }
    });

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