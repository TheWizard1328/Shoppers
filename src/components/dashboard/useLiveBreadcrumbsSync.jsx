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

  useEffect(() => {
    if (!showBreadcrumbs) return;
    const activeDriverId = showAllDriverMarkers || selectedDriverId === 'all' ? currentUser?.id : selectedDriverId;
    const activeDate = format(selectedDate, 'yyyy-MM-dd');
    const matches = ({ driverId, deliveryDate } = {}) => (!driverId || !activeDriverId || driverId === activeDriverId) && (!deliveryDate || deliveryDate === activeDate);
    const refresh = async (event) => matches(event.detail || {}) && setBreadcrumbsData(await loadBreadcrumbsForDriver(activeDriverId, activeDate, appUsersRef.current));
    const append = (event) => {
      const { point, ...detail } = event.detail || {};
      if (!point || !matches(detail)) return;
      setBreadcrumbsData((prev) => prev?.current?.some((p) => Number(p?.timestamp) === Number(point.timestamp)) ? prev : { historical: prev?.historical || [], current: [...(prev?.current || []), point] });
    };
    const unsubscribeLive = activeDriverId ? base44.entities.PendingBreadcrumbLive.subscribe((event) => {
      if (event?.data?.driver_id !== activeDriverId) return;
      refresh({ detail: { driverId: activeDriverId, deliveryDate: activeDate } });
    }) : null;
    // Also reload breadcrumbs when the driver returns from a long app-switch.
    // Without this, the UI keeps stale pre-suspension crumbs and the first new crumb
    // saved by the restarted tracker appears as a straight line from the old position.
    const handleResumeAfterAbsence = (event) => {
      const { userId } = event.detail || {};
      // Only reload for the currently displayed driver
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