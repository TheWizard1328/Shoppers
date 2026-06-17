import { useEffect } from 'react';
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
  useEffect(() => {
    if (!showBreadcrumbs) return;
    const activeDriverId = showAllDriverMarkers || selectedDriverId === 'all' ? currentUser?.id : selectedDriverId;
    const activeDate = format(selectedDate, 'yyyy-MM-dd');
    const matches = ({ driverId, deliveryDate } = {}) => (!driverId || !activeDriverId || driverId === activeDriverId) && (!deliveryDate || deliveryDate === activeDate);
    const refresh = async (event) => matches(event.detail || {}) && setBreadcrumbsData(await loadBreadcrumbsForDriver(activeDriverId, activeDate, appUsers));
    const append = (event) => {
      const { point, ...detail } = event.detail || {};
      if (!point || !matches(detail)) return;
      setBreadcrumbsData((prev) => prev?.current?.some((p) => Number(p?.timestamp) === Number(point.timestamp)) ? prev : { historical: prev?.historical || [], current: [...(prev?.current || []), point] });
    };
    const unsubscribeLive = activeDriverId ? base44.entities.PendingBreadcrumbLive.subscribe((event) => {
      if (event?.data?.driver_id !== activeDriverId) return;
      refresh({ detail: { driverId: activeDriverId, deliveryDate: activeDate } });
    }) : null;
    window.addEventListener('deliveriesUpdated', refresh);window.addEventListener('routeOptimizationComplete', refresh);window.addEventListener('routeReordered', refresh);window.addEventListener('breadcrumbCollected', append);
    return () => {
      unsubscribeLive?.();
      window.removeEventListener('deliveriesUpdated', refresh);window.removeEventListener('routeOptimizationComplete', refresh);window.removeEventListener('routeReordered', refresh);window.removeEventListener('breadcrumbCollected', append);
    };
  }, [showBreadcrumbs, showAllDriverMarkers, selectedDriverId, currentUser?.id, selectedDate, appUsers, setBreadcrumbsData]);
}