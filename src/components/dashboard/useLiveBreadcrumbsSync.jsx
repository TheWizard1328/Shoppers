import { useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';
import { loadBreadcrumbsForDriver } from '@/components/utils/breadcrumbsManager';

/**
 * PERF FIX: The `refresh` function calls `loadBreadcrumbsForDriver` which reads
 * from IDB and decodes the full polyline. Previously this fired on EVERY
 * `deliveriesUpdated` event with no debounce — and since `deliveriesUpdated`
 * can fire 5-10 times during a single delivery action (accept, complete,
 * optimize, etc.), multiple full polyline decodes would queue up and block
 * the main thread. This caused the SmartRefreshIndicator to freeze (its 50ms
 * polling couldn't fire) and cross-driver WebSocket markers to stop updating.
 *
 * Fix: debounce refresh calls to 500ms so rapid event bursts collapse into
 * a single `loadBreadcrumbsForDriver` call. Also added `requestIdleCallback`
 * wrapper so the decode runs during browser idle time, not blocking React
 * renders or WebSocket callbacks.
 */
export default function useLiveBreadcrumbsSync({
  showBreadcrumbs,
  showAllDriverMarkers,
  selectedDriverId,
  currentUser,
  selectedDate,
  appUsers,
  setBreadcrumbsData
}) {
  // Keep appUsers in a ref so the effect doesn't re-subscribe on every GPS update
  const appUsersRef = useRef(appUsers);
  useEffect(() => { appUsersRef.current = appUsers; }, [appUsers]);

  // Guard against concurrent refreshes and post-unmount state updates
  const isMountedRef = useRef(true);
  const refreshBusyRef = useRef(false);
  const debounceTimerRef = useRef(null);
  const pendingEventRef = useRef(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    // Clean up debounce timer on re-subscription
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    if (!showBreadcrumbs) return;
    const activeDriverId = showAllDriverMarkers || selectedDriverId === 'all' ? currentUser?.id : selectedDriverId;
    const activeDate = format(selectedDate, 'yyyy-MM-dd');
    const matches = ({ driverId, deliveryDate } = {}) =>
      (!driverId || !activeDriverId || driverId === activeDriverId) &&
      (!deliveryDate || deliveryDate === activeDate);

    // Debounced refresh: collapse rapid event bursts into a single loadBreadcrumbsForDriver call
    const refresh = (event) => {
      const detail = event?.detail || {};
      const eventDriverId = detail.driverId || detail.driver_id || detail.delivery?.driver_id;
      if (eventDriverId && activeDriverId && eventDriverId !== activeDriverId && eventDriverId !== currentUser?.id) return;
      if (!matches(detail)) return;

      // Store the latest event and debounce — if another event fires within 500ms,
      // it replaces the pending one and resets the timer. This collapses bursts
      // of 5-10 `deliveriesUpdated` events from a single delivery action into
      // one `loadBreadcrumbsForDriver` call.
      pendingEventRef.current = event;
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        if (!isMountedRef.current || refreshBusyRef.current) return;
        refreshBusyRef.current = true;

        // Use requestIdleCallback if available so the decode doesn't block
        // React renders or WebSocket callbacks. Falls back to setTimeout(0) on
        // browsers without requestIdleCallback support.
        const runRefresh = () => {
          loadBreadcrumbsForDriver(activeDriverId, activeDate, appUsersRef.current)
            .then((data) => {
              if (isMountedRef.current) setBreadcrumbsData(data);
            })
            .catch((err) => {
              console.warn('⚠️ useLiveBreadcrumbsSync refresh error:', err?.message);
            })
            .finally(() => {
              refreshBusyRef.current = false;
            });
        };

        if (typeof window !== 'undefined' && window.requestIdleCallback) {
          window.requestIdleCallback(runRefresh, { timeout: 2000 });
        } else {
          setTimeout(runRefresh, 0);
        }
      }, 500);
    };

    const append = (event) => {
      const { point, ...detail } = event?.detail || {};
      if (!point || !matches(detail)) return;
      if (!isMountedRef.current) return;
      setBreadcrumbsData((prev) => {
        if (!prev) return prev;
        if (prev?.current?.some((p) => Number(p?.timestamp) === Number(point.timestamp))) return prev;
        return { historical: prev?.historical || [], current: [...(prev?.current || []), point] };
      });
    };

    // PendingBreadcrumbLive entity was removed/renamed — guard against undefined.
    let unsubscribeLive = null;
    try {
      if (activeDriverId && base44?.entities?.PendingBreadcrumbLive?.subscribe) {
        unsubscribeLive = base44.entities.PendingBreadcrumbLive.subscribe((event) => {
          if (event?.data?.driver_id !== activeDriverId) return;
          refresh({ detail: { driverId: activeDriverId, deliveryDate: activeDate } });
        });
      }
    } catch (e) {
      // Entity may not exist in production builds — silently ignore
    }

    // Reload breadcrumbs when the driver returns from a long app-switch.
    const handleResumeAfterAbsence = (event) => {
      const { userId } = event?.detail || {};
      if (userId && activeDriverId && userId !== activeDriverId) return;
      refresh({ detail: { driverId: activeDriverId, deliveryDate: activeDate } });
    };

    window.addEventListener('deliveriesUpdated', refresh);
    window.addEventListener('routeOptimizationComplete', refresh);
    window.addEventListener('routeReordered', refresh);
    window.addEventListener('breadcrumbCollected', append);
    window.addEventListener('driverResumedAfterAbsence', handleResumeAfterAbsence);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      try { unsubscribeLive?.(); } catch {}
      window.removeEventListener('deliveriesUpdated', refresh);
      window.removeEventListener('routeOptimizationComplete', refresh);
      window.removeEventListener('routeReordered', refresh);
      window.removeEventListener('breadcrumbCollected', append);
      window.removeEventListener('driverResumedAfterAbsence', handleResumeAfterAbsence);
    };
  // appUsers intentionally omitted — accessed via ref to prevent re-subscribing on every GPS tick
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBreadcrumbs, showAllDriverMarkers, selectedDriverId, currentUser?.id, selectedDate, setBreadcrumbsData]);
}
