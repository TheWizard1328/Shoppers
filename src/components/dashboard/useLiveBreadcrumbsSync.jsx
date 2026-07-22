import { useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';
import { loadBreadcrumbsForDriver } from '@/components/utils/breadcrumbsManager';

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

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!showBreadcrumbs) return;
    const activeDriverId = showAllDriverMarkers || selectedDriverId === 'all' ? currentUser?.id : selectedDriverId;
    const activeDate = format(selectedDate, 'yyyy-MM-dd');
    const matches = ({ driverId, deliveryDate } = {}) =>
      (!driverId || !activeDriverId || driverId === activeDriverId) &&
      (!deliveryDate || deliveryDate === activeDate);

    // Debounced, guarded refresh — skips if already running, no-ops if unmounted
    const refresh = (event) => {
      if (!matches(event?.detail || {})) return;
      if (refreshBusyRef.current) return; // already loading, skip
      refreshBusyRef.current = true;
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

    const unsubscribeLive = activeDriverId
      ? base44.entities.PendingBreadcrumbLive.subscribe((event) => {
          if (event?.data?.driver_id !== activeDriverId) return;
          refresh({ detail: { driverId: activeDriverId, deliveryDate: activeDate } });
        })
      : null;

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
      unsubscribeLive?.();
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
