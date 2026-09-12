import { useCallback, useEffect, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";
import { isAppOwner } from "@/components/utils/userRoles";

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
      // Use the backend function that returns only the count — avoids pulling
      // full GoogleAPILog rows client-side for a growing log table.
      const result = await base44.functions.invoke('getDailyApiLogCount', {});
      setDailyPolylineCount(result?.total ?? 0);
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