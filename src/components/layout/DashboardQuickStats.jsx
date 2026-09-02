import React, { useState, useEffect, useRef } from "react";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Truck, Package, CheckCircle, AlertCircle } from "lucide-react";
import { globalFilters } from '../utils/globalFilters';
import { offlineDB } from '../utils/offlineDatabase';
import { userHasRole } from '../utils/userRoles';
import { isReturnAddress } from '../utils/returnDeliveryUtils';
import OfflineSyncIndicator from './OfflineSyncIndicator';

export default function DashboardQuickStats({ currentUser, storeIds = [], isMobile, screenWidth, showOfflineSync = false }) {
  const [selectedDateStr, setSelectedDateStr] = useState(() => globalFilters.getSelectedDate());
  const [selectedDriverId, setSelectedDriverIdLocal] = useState(() => {
    // For drivers, default to their own ID
    if (currentUser && userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin')) {
      return currentUser.id;
    }
    return globalFilters.getSelectedDriverId();
  });
  const [stats, setStats] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const lastFetchRef = useRef({ date: null, driver: null, timestamp: 0 });
  const debounceTimerRef = useRef(null);
  const idleHandleRef = useRef(null);
  const isMountedRef = useRef(true);

  // Subscribe to global filter changes (not polling)
  useEffect(() => {
    const unsubscribe = globalFilters.subscribe(() => {
      const currentDateStr = globalFilters.getSelectedDate();
      const currentDriverId = globalFilters.getSelectedDriverId();

      if (currentDateStr !== selectedDateStr) {
        setSelectedDateStr(currentDateStr);
        // CRITICAL: Force immediate stats refresh on date change
        lastFetchRef.current = { date: null, driver: null, timestamp: 0 };
      }
      if (currentDriverId !== selectedDriverId) {
        setSelectedDriverIdLocal(currentDriverId);
        // CRITICAL: Force immediate stats refresh on driver change
        lastFetchRef.current = { date: null, driver: null, timestamp: 0 };
      }
    });

    return () => unsubscribe();
  }, [selectedDateStr, selectedDriverId]);

  // Load stats from offline DB
  useEffect(() => {
    if (!currentUser || !selectedDateStr) return;
    isMountedRef.current = true;

    // CRITICAL: loadStats does heavy IDB reads + array scans. It must NEVER run
    // synchronously inside a button click's own promise chain (Add/Update/Done),
    // or it blocks the main thread and freezes those buttons until it finishes.
    // isBackground=true (the refresh-event path) skips the loading flag entirely
    // and is always scheduled via requestIdleCallback so it only runs once the
    // browser is idle — after the click handler's own UI updates have painted.
    const loadStats = async (isBackground = false) => {
      if (!isBackground) setIsLoading(true);
      setHasError(false);

      try {
        const selectedDate = new Date(selectedDateStr + 'T00:00:00');
        const todayStr = format(new Date(), 'yyyy-MM-dd');
        const monthStr = format(selectedDate, 'yyyy-MM');

        // Load deliveries from offline DB
        const allDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);

        if (!isMountedRef.current) return;

        if (!allDeliveries || allDeliveries.length === 0) {
          setStats(null);
          if (!isBackground) setIsLoading(false);
          return;
        }

        const allPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);

        if (!isMountedRef.current) return;

        // PERF: Precompute a Set of "return" patient keys once (O(n)) instead of
        // calling getReturnCountFromPatientId's array.find() per-delivery, which
        // was an O(deliveries * patients) nested scan — the main hotspot causing
        // multi-hundred-ms main-thread blocks on stores with large patient lists.
        const returnPatientKeys = new Set();
        (allPatients || []).forEach((p) => {
          if (p && isReturnAddress(p.address)) {
            if (p.id) returnPatientKeys.add(p.id);
            if (p.patient_id) returnPatientKeys.add(p.patient_id);
          }
        });
        const isReturnDelivery = (d) => d?.patient_id && returnPatientKeys.has(d.patient_id);

        // Determine store filter for dispatcher
        const isDispatcher = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');
        const dispatcherStoreIds = isDispatcher ? new Set(currentUser.store_ids || []) : null;

        // Filter deliveries for today and month, scoped to city/store only for legend stats.
        // Driver filter is intentionally ignored for admins/dispatchers so the legend always shows aggregated data.
        const filterByStore = (d) => {if (!d) return false;if (dispatcherStoreIds) return dispatcherStoreIds.has(d.store_id);if (Array.isArray(storeIds) && storeIds.length > 0) return storeIds.includes(d.store_id);return true;};
        const shouldRestrictToCurrentDriver = userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin');
        const todayDeliveries = allDeliveries.filter((d) => d?.delivery_date === selectedDateStr && filterByStore(d) && (!shouldRestrictToCurrentDriver || d?.driver_id === currentUser.id));
        const monthDeliveries = allDeliveries.filter((d) => d?.delivery_date?.startsWith(monthStr) && filterByStore(d) && (!shouldRestrictToCurrentDriver || d?.driver_id === currentUser.id));

        // Calculate today's stats
        const todayPatientDeliveries = todayDeliveries.filter((d) => d && d.patient_id);
        const allAppUsersFromDB = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
        if (!isMountedRef.current) return;
        const offDutyIds = new Set((allAppUsersFromDB || []).filter((au) => au?.driver_status === 'off_duty').map((au) => au.user_id));const todayActiveDrivers = [...new Set(todayDeliveries.filter((d) => d?.driver_id).map((d) => d.driver_id))].filter((id) => !offDutyIds.has(id)).length;
        const todayActiveStops = todayPatientDeliveries.filter((d) => !['completed', 'failed', 'cancelled'].includes(d?.status)).length;
        const todayCompleted = todayPatientDeliveries.filter((d) => d?.status === 'completed').length;
        const todayFailed = todayPatientDeliveries.filter((d) => d?.status === 'failed').length;
        // Inter-store counts for superscript
        const isInterStore = (d) => !!d._interstore_source_id || !!d._interstore_dest_id;
        const todayInTransitInterStore = todayPatientDeliveries.filter((d) => !['completed', 'failed', 'cancelled'].includes(d?.status) && isInterStore(d)).length;
        const todayCompletedInterStore = todayPatientDeliveries.filter((d) => d?.status === 'completed' && isInterStore(d)).length;
        const todayReturns = todayPatientDeliveries.reduce((sum, d) => {
          const isFinishedReturn = d?.status === 'completed' && isReturnDelivery(d);
          return sum + (isFinishedReturn ? 1 : 0);
        }, 0);

        // Calculate month's stats
        const monthPatientDeliveries = monthDeliveries.filter((d) => d && d.patient_id);
        const monthCompleted = monthPatientDeliveries.filter((d) => d?.status === 'completed').length;
        const monthFailed = monthPatientDeliveries.filter((d) => d?.status === 'failed').length;
        const monthReturns = monthPatientDeliveries.reduce((sum, d) => {
          const isFinishedReturn = d?.status === 'completed' && isReturnDelivery(d);
          return sum + (isFinishedReturn ? 1 : 0);
        }, 0);

        if (!isMountedRef.current) return;

        setStats({
          today: {
            activeDrivers: todayActiveDrivers,
            activeStops: todayActiveStops,
            completed: todayCompleted,
            failed: todayFailed,
            returns: todayReturns,
            inTransitInterStore: todayInTransitInterStore,
            completedInterStore: todayCompletedInterStore
          },
          month: {
            completed: monthCompleted,
            failed: monthFailed,
            returns: monthReturns
          }
        });
        if (!isBackground) setIsLoading(false);
      } catch (error) {
        console.error('Failed to load QuickStats:', error);
        if (isMountedRef.current) setHasError(true);
        if (!isBackground && isMountedRef.current) setIsLoading(false);
      }
    };

    // Initial load — this one is allowed to show the loading skeleton (only
    // matters on first mount since `stats` is still null at that point).
    loadStats(false);

    // CRITICAL: Delivery-change refresh must be a background process, never a
    // blocking foreground one. Add/Update/Done handlers dispatch this event
    // right as part of their own success path — if we ran loadStats() synchronously
    // here, its IDB reads + array scans would compete with (and delay) the
    // click handler's own UI updates on the same main thread, which is exactly
    // what was freezing the Add/Update/Done buttons. Fix: debounce rapid-fire
    // events (300ms trailing) so several quick edits collapse into one
    // recompute, then run that recompute via requestIdleCallback so it only
    // executes once the browser is idle — after pending UI work has painted.
    const scheduleBackgroundRefresh = () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        if (!isMountedRef.current) return;

        const runRefresh = () => {
          idleHandleRef.current = null;
          if (!isMountedRef.current) return;
          loadStats(true);
        };

        if (typeof window !== 'undefined' && window.requestIdleCallback) {
          idleHandleRef.current = window.requestIdleCallback(runRefresh, { timeout: 2000 });
        } else {
          idleHandleRef.current = setTimeout(runRefresh, 0);
        }
      }, 300);
    };

    window.addEventListener('refreshDeliveryStats', scheduleBackgroundRefresh);
    window.addEventListener('deliveriesImported', scheduleBackgroundRefresh);
    window.addEventListener('offlineSyncComplete', scheduleBackgroundRefresh);

    return () => {
      isMountedRef.current = false;
      window.removeEventListener('refreshDeliveryStats', scheduleBackgroundRefresh);
      window.removeEventListener('deliveriesImported', scheduleBackgroundRefresh);
      window.removeEventListener('offlineSyncComplete', scheduleBackgroundRefresh);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (idleHandleRef.current) {
        if (typeof window !== 'undefined' && window.cancelIdleCallback) {
          window.cancelIdleCallback(idleHandleRef.current);
        } else {
          clearTimeout(idleHandleRef.current);
        }
      }
    };
  }, [currentUser, selectedDateStr, selectedDriverId]);

  const StatItem = ({ icon: Icon, label, value, colorClass, superscript }) =>
  <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${colorClass || 'text-slate-500 dark:text-slate-400 dark:text-slate-500'}`} />
          <span className="font-medium" style={{ color: 'var(--text-slate-600)' }}>{label}</span>
        </div>
        <Badge variant="secondary" className="items-center bg-secondary text-secondary-foreground inline-flex border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent hover:bg-secondary/80 justify-center w-[65px] rounded-[10px]" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)' }}>
          {value}{superscript > 0 && <sup className="ml-0.5 text-[9px] font-bold" style={{ color: 'var(--text-slate-400)' }}>{superscript}</sup>}
        </Badge>
      </div>;

  if (!currentUser) return null;

  const selectedDate = selectedDateStr ? new Date(selectedDateStr + 'T00:00:00') : new Date();
  const now = new Date();
  const todayString = format(now, 'yyyy-MM-dd');
  const isToday = format(selectedDate, 'yyyy-MM-dd') === todayString;

  // CRITICAL: Only show loading skeleton on FIRST load (no stats yet)
  // When stats exist, keep displaying them while updating
  if (isLoading && !stats) {
    return (
      <div className="px-3 py-2">
        <div className="animate-pulse space-y-2">
          <div className="h-4 bg-slate-200 rounded w-1/2"></div>
          <div className="h-6 bg-slate-200 rounded"></div>
          <div className="h-6 bg-slate-200 rounded"></div>
        </div>
      </div>);

  }

  if (hasError && !stats) {
    return (
      <div className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400 dark:text-slate-500">
        Unable to load stats
      </div>);

  }

  // CRITICAL: Add null check for stats to prevent crashes
  if (!stats || !stats.today || !stats.month) {
    return null;
  }

  return (
    <div className="space-y-1 py-1 px-4">
      {showOfflineSync &&
      <div className="border-b pb-2" style={{ borderColor: 'var(--border-slate-200)' }}>
          <OfflineSyncIndicator embedded={true} />
        </div>
      }
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-slate-500)' }}>
          {isToday ? "Today's Stats:" : format(selectedDate, 'MMM dd, yyyy') + ':'}
        </h4>
        <div className="space-y-1">
          {!userHasRole(currentUser, 'driver') && <StatItem icon={Truck} label="Active Drivers" value={stats.today.activeDrivers} colorClass="text-blue-600" />}
          <StatItem icon={Package} label="Active Stops" value={stats.today.activeStops} superscript={stats.today.inTransitInterStore} colorClass="text-slate-600 dark:text-slate-400 dark:text-slate-500" />
          <StatItem icon={CheckCircle} label="Completed" value={stats.today.completed} superscript={stats.today.completedInterStore} colorClass="text-green-600" />
          {(stats.today.failed > 0 || stats.today.returns > 0) &&
          <StatItem
            icon={AlertCircle}
            label="Failed/Returned"
            value={`${stats.today.failed} / ${stats.today.returns}`}
            colorClass="text-red-600" />
          }
          {/* <StatItem icon={MapPin} label="Polylines" value={stats.today.polylineCount || 0} colorClass="text-blue-600" /> */}
        </div>
      </div>

      <div>
        <h4 className="xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-slate-500)' }}>{format(selectedDate, 'MMMM yyyy')}:</h4>
        <div className="space-y-1">
          <StatItem icon={CheckCircle} label="Completed" value={stats.month.completed} colorClass="text-green-600" />
          {(stats.month.failed > 0 || stats.month.returns > 0) &&
          <StatItem
            icon={AlertCircle}
            label="Failed/Returned"
            value={`${stats.month.failed} / ${stats.month.returns}`}
            colorClass="text-red-600" />
          }
        </div>
      </div>
    </div>);

}