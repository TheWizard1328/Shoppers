import { useEffect } from "react";
import { useLocalPerformanceStats } from "@/components/dashboard/useLocalPerformanceStats";
import usePayrollStats from "@/components/utils/usePayrollStats";

/**
 * Wires up the dashboard's performance-stats source:
 *  - driver self-view + all-drivers aggregation → local instant computation
 *    (useLocalPerformanceStats).
 *  - pure admin viewing a specific OTHER driver → authoritative backend
 *    getDriverPayrollStats (already handles N/C exclusion correctly).
 *
 * The local hook defers (returns without writing performanceStats) in the
 * admin→other-driver case so its result can't clobber the backend value —
 * this is what previously caused StatsCard Total Pay to flash to $0 after an
 * admin switched drivers (the remote driver's pay rate wasn't always present
 * in the React appUsers snapshot the local calc reads from).
 */
export function useDashboardPerformanceStats({
  currentUser,
  isDataLoaded,
  isDispatcher,
  isAdmin,
  isDriver,
  selectedDriverId,
  selectedDate,
  filteredDeliveries,
  patients,
  appUsers,
  setPerformanceStats,
  setIsLoadingPayrollStats,
}) {
  const isAdminNonDriver = isAdmin && !isDriver;

  const { schedulePayrollFetch } = usePayrollStats({
    isDriver: false, // backend owns admin→other-driver case; driver self stays local
    isAdmin: isAdminNonDriver,
    currentUser,
    selectedDriverId,
    selectedDate,
    setPerformanceStats,
    setIsLoadingPayrollStats,
  });

  useLocalPerformanceStats({
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
    setIsLoadingPayrollStats,
  });

  // Fire the authoritative backend fetch immediately when an admin switches
  // to a different driver (bypass the 10s throttle so the StatsCard doesn't
  // show a stale $0 between selections).
  useEffect(() => {
    if (!isAdminNonDriver) return;
    if (!selectedDriverId || selectedDriverId === 'all') return;
    if (selectedDriverId === currentUser?.id) return;
    schedulePayrollFetch('dashboard-driver-change', { bypassThrottle: true });
  }, [schedulePayrollFetch, selectedDriverId, selectedDate, isAdminNonDriver, currentUser?.id]);
}