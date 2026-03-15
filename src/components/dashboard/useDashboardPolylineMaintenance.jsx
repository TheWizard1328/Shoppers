import { useCallback, useEffect, useRef, useState } from "react";
import { format } from "date-fns";
import { base44 } from "@/api/base44Client";
import { offlineDB } from "@/components/utils/offlineDatabase";
import { invalidateDeliveriesForDate } from "@/components/utils/dataManager";
import { globalFilters } from "@/components/utils/globalFilters";
import { isAppOwner } from "@/components/utils/userRoles";
import { sumApiLogCalls } from "@/components/utils/apiUsageLog";

export function useDashboardPolylineMaintenance({
  currentUser,
  selectedDate,
  selectedDriverId,
  deliveries,
  isDataLoaded,
  dataReadyForSelectedDate,
  isSnapshotModeActive,
  updateDeliveriesLocally
}) {
  const [dailyPolylineCount, setDailyPolylineCount] = useState(null);
  const polylineRepairInFlightRef = useRef(new Set());
  const autoRepairTriggeredRef = useRef(new Set());

  useEffect(() => {
    autoRepairTriggeredRef.current.clear();
  }, [selectedDate, selectedDriverId]);

  useEffect(() => {
    if (!currentUser || !isDataLoaded || !dataReadyForSelectedDate || isSnapshotModeActive) return;

    const dateStr = format(selectedDate, 'yyyy-MM-dd');
    const activeSelectedDriverId = selectedDriverId || globalFilters.getSelectedDriverId() || 'all';
    const selectedScopeKey = `${dateStr}__${activeSelectedDriverId}`;
    const selectedDateDeliveries = (deliveries || [])
      .filter((delivery) => delivery && delivery.delivery_date === dateStr)
      .filter((delivery) => activeSelectedDriverId === 'all' || !activeSelectedDriverId || delivery.driver_id === activeSelectedDriverId);

    if (selectedDateDeliveries.length === 0) return;
    if (autoRepairTriggeredRef.current.has(selectedScopeKey)) return;

    const uniqueDriverIds = [...new Set(selectedDateDeliveries.map((delivery) => delivery.driver_id).filter(Boolean))];
    const driverIdsToRepair = uniqueDriverIds.filter((driverId) => {
      const repairKey = `${driverId}__${dateStr}`;
      if (polylineRepairInFlightRef.current.has(repairKey)) {
        return false;
      }

      return selectedDateDeliveries.some((delivery) =>
        delivery.driver_id === driverId && delivery.PolylineUpdated !== true
      );
    });

    if (driverIdsToRepair.length === 0) return;

    autoRepairTriggeredRef.current.add(selectedScopeKey);
    let cancelled = false;

    const runPolylineRepair = async () => {
      driverIdsToRepair.forEach((driverId) => {
        polylineRepairInFlightRef.current.add(`${driverId}__${dateStr}`);
      });

      const repairResults = await Promise.allSettled(
        driverIdsToRepair.map((driverId) =>
          base44.functions.invoke('purgeAndRegeneratePolylines', {
            driverId,
            deliveryDate: dateStr
          })
        )
      );

      driverIdsToRepair.forEach((driverId) => {
        const repairKey = `${driverId}__${dateStr}`;
        polylineRepairInFlightRef.current.delete(repairKey);
      });

      if (cancelled) return;

      const anyRepairCompleted = repairResults.some((result) => result.status === 'fulfilled');
      if (!anyRepairCompleted) {
        autoRepairTriggeredRef.current.delete(selectedScopeKey);
        return;
      }

      const refreshedDeliveries = await base44.entities.Delivery.filter({ delivery_date: dateStr });
      if (cancelled) return;

      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, refreshedDeliveries);
      invalidateDeliveriesForDate(dateStr);

      if (updateDeliveriesLocally) {
        const otherDateDeliveries = (deliveries || []).filter((delivery) => delivery && delivery.delivery_date !== dateStr);
        updateDeliveriesLocally([...otherDateDeliveries, ...refreshedDeliveries], true);
      }

      window.dispatchEvent(new CustomEvent('polylineCacheCleared', {
        detail: { driverIds: driverIdsToRepair, deliveryDate: dateStr, triggeredBy: 'polylineAutoUpdate' }
      }));
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { deliveryDate: dateStr, triggeredBy: 'polylineAutoUpdateComplete' }
      }));
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
    };

    runPolylineRepair();

    return () => {
      cancelled = true;
    };
  }, [currentUser, selectedDate, selectedDriverId, deliveries, isDataLoaded, dataReadyForSelectedDate, isSnapshotModeActive, updateDeliveriesLocally]);

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