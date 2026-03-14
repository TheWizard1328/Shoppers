import { useCallback, useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { base44 } from "@/api/base44Client";
import { offlineDB } from "@/components/utils/offlineDatabase";
import { invalidateDeliveriesForDate } from "@/components/utils/dataManager";
import { isAppOwner } from "@/components/utils/userRoles";
import { sumApiLogCalls } from "@/components/utils/apiUsageLog";

export function useDashboardPolylineMaintenance({
  currentUser,
  selectedDate,
  deliveries,
  isDataLoaded,
  dataReadyForSelectedDate,
  isSnapshotModeActive,
  updateDeliveriesLocally
}) {
  const [dailyPolylineCount, setDailyPolylineCount] = useState(null);
  const repairedDriverDatesRef = useRef(new Set());
  const polylineRepairInFlightRef = useRef(new Set());

  useEffect(() => {
    if (!currentUser || !isDataLoaded || !dataReadyForSelectedDate || isSnapshotModeActive) return;

    const dateStr = format(selectedDate, 'yyyy-MM-dd');
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const hasStoredPolyline = (value) => typeof value === 'string' ? value.trim().length > 0 : !!value;
    const selectedDateDeliveries = (deliveries || []).filter((delivery) => delivery && delivery.delivery_date === dateStr);
    const finishedDeliveries = selectedDateDeliveries.filter((delivery) => finishedStatuses.includes(delivery.status));

    if (finishedDeliveries.length === 0) return;

    const finishedPolylineCount = finishedDeliveries.filter((delivery) => hasStoredPolyline(delivery.finished_leg_encoded_polyline)).length;
    if (finishedPolylineCount === finishedDeliveries.length) return;

    const uniqueDriverIds = [...new Set(finishedDeliveries.map((delivery) => delivery.driver_id).filter(Boolean))];
    const driverIdsToRepair = uniqueDriverIds.filter((driverId) => {
      const repairKey = `${driverId}__${dateStr}`;
      if (repairedDriverDatesRef.current.has(repairKey) || polylineRepairInFlightRef.current.has(repairKey)) {
        return false;
      }

      return finishedDeliveries.some((delivery) =>
        delivery.driver_id === driverId && !hasStoredPolyline(delivery.finished_leg_encoded_polyline)
      );
    });

    if (driverIdsToRepair.length === 0) return;

    let cancelled = false;

    const runPolylineRepair = async () => {
      driverIdsToRepair.forEach((driverId) => {
        polylineRepairInFlightRef.current.add(`${driverId}__${dateStr}`);
      });

      const repairResults = await Promise.allSettled(
        driverIdsToRepair.map((driverId) =>
          base44.functions.invoke('repairMissingPolylines', {
            driverId,
            deliveryDate: dateStr
          })
        )
      );

      driverIdsToRepair.forEach((driverId, index) => {
        const repairKey = `${driverId}__${dateStr}`;
        polylineRepairInFlightRef.current.delete(repairKey);
        if (repairResults[index]?.status === 'fulfilled') {
          repairedDriverDatesRef.current.add(repairKey);
        }
      });

      if (cancelled) return;

      const anyRepairCompleted = repairResults.some((result) => result.status === 'fulfilled');
      if (!anyRepairCompleted) return;

      const refreshedDeliveries = await base44.entities.Delivery.filter({ delivery_date: dateStr });
      if (cancelled) return;

      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, refreshedDeliveries);
      invalidateDeliveriesForDate(dateStr);

      if (updateDeliveriesLocally) {
        const otherDateDeliveries = (deliveries || []).filter((delivery) => delivery && delivery.delivery_date !== dateStr);
        updateDeliveriesLocally([...otherDateDeliveries, ...refreshedDeliveries], true);
      }

      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { deliveryDate: dateStr, triggeredBy: 'polylineRepairComplete' }
      }));
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
    };

    runPolylineRepair();

    return () => {
      cancelled = true;
    };
  }, [currentUser, selectedDate, deliveries, isDataLoaded, dataReadyForSelectedDate, isSnapshotModeActive, updateDeliveriesLocally]);

  const fetchPolylineCount = useCallback(async () => {
    if (!currentUser || !isAppOwner(currentUser)) return;

    try {
      const now = new Date();
      const todayStr = format(now, 'yyyy-MM-dd');
      const todayStart = new Date(todayStr + 'T00:00:00').toISOString();
      const todayEnd = new Date(todayStr + 'T23:59:59').toISOString();
      const apiLogs = await base44.entities.GoogleAPILog.filter({
        timestamp: { $gte: todayStart, $lte: todayEnd }
      });
      setDailyPolylineCount(sumApiLogCalls(apiLogs));
    } catch (error) {
      if (error.response?.status === 429 || error.message?.includes('429') || error.message?.includes('Rate limit')) {
        return;
      }
      setDailyPolylineCount(0);
    }
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser || !isAppOwner(currentUser)) return;

    const initialTimer = setTimeout(() => {
      fetchPolylineCount();
    }, 2000);

    const interval = setInterval(fetchPolylineCount, 300000);
    const handleSmartRefreshComplete = () => {
      fetchPolylineCount();
    };

    window.addEventListener('smartRefreshComplete', handleSmartRefreshComplete);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
      window.removeEventListener('smartRefreshComplete', handleSmartRefreshComplete);
    };
  }, [currentUser, fetchPolylineCount]);

  return { dailyPolylineCount };
}