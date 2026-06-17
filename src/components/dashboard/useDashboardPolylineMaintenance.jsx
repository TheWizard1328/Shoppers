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

    // Polylines are regenerated only by explicit post-optimization / route-change side effects.
    // This disables the old dashboard-wide auto-repair loop that was causing repeated HERE calls.
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