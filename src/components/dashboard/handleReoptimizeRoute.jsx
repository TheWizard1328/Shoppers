import { base44 } from '@/api/base44Client';
import { pauseOfflineMutations, resumeOfflineMutations } from '@/components/utils/offlineMutations';
import { pauseOfflineSync, resumeOfflineSync } from '@/components/utils/offlineSync';
import { invalidate } from '@/components/utils/dataManager';
import { offlineDB } from '@/components/utils/offlineDatabase';

/**
 * Handles the manual re-optimize route action.
 * After optimization completes, triggers polyline regeneration using the optimizer's
 * exact stop order so segment points are built in the correct sequence.
 */
export async function handleReoptimizeRoute({
  currentUser,
  selectedDate,
  appUsers,
  format,
  setIsReoptimizing,
  setOptimizationMessage,
  setIsEntityUpdating,
  setSkippedStopsDialogData,
  refreshData,
  updateDeliveriesLocally,
  isMapViewLockedRef,
  setIsMapViewLocked,
  setMapViewTrigger,
}) {
  try {
    setIsReoptimizing(true);
    setOptimizationMessage('Re-optimizing route...');

    // Pause smart refresh BEFORE optimization
    setIsEntityUpdating(true);
    pauseOfflineMutations();
    pauseOfflineSync();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const deliveryDate = format(selectedDate, 'yyyy-MM-dd');
    const now = new Date();
    const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const response = await base44.functions.invoke('optimizeRemainingStops', {
      driverId: currentUser.id,
      deliveryDate,
      currentLocalTime,
      deviceTime: now.toISOString(),
    });

    const data = response?.data || response;

    if (data?.success) {
      setOptimizationMessage(`Route optimized! ${data.optimizedCount} stops updated.`);
      if (data.skippedStopsCount > 0 && Array.isArray(data.skippedStops)) {
        setSkippedStopsDialogData(data.skippedStops);
      }

      // CRITICAL: Regenerate polylines using the optimizer's exact ordered stop list.
      // Pass orderedDeliveryIds so regenerateType1Polyline skips its own re-sort heuristic
      // and builds segment points in the exact sequence the optimizer computed.
      if (data.shouldRefreshPolylines && Array.isArray(data.orderedDeliveryIds) && data.orderedDeliveryIds.length > 0) {
        const driverAppUser = appUsers.find((au) => au?.user_id === currentUser.id);
        if (driverAppUser?.current_latitude && driverAppUser?.current_longitude) {
          await base44.functions.invoke('regenerateType1Polyline', {
            driverId: currentUser.id,
            deliveryDate,
            currentLocation: { lat: driverAppUser.current_latitude, lon: driverAppUser.current_longitude },
            orderedDeliveryIds: data.orderedDeliveryIds,
            routeChangeSource: 'reoptimize',
            force: true,
          }).catch((e) => console.warn('⚠️ [reoptimize] polyline regen failed:', e.message));
        }
      }

      // Fetch fresh deliveries (with updated stop_order + polylines) and push to offline DB + UI
      invalidate('Delivery');
      const freshDeliveries = await base44.entities.Delivery.filter({
        driver_id: currentUser.id,
        delivery_date: deliveryDate
      }).catch(() => null);
      if (Array.isArray(freshDeliveries) && freshDeliveries.length > 0) {
        // CRITICAL: The optimizer only writes routing fields (stop_order, ETA, isNextDelivery, etc).
        // It never touches status/arrival_time. However, due to async write timing, the fresh fetch
        // can return a pickup stop before its status has been fully committed back, returning a
        // stale/empty status. Guard against this by preserving the status and arrival_time of any
        // currently active (en_route / in_transit) stop from the local state before replacing.
        const { offlineDB: odb } = await import('@/components/utils/offlineDatabase');
        const localDeliveries = await odb.getAll(odb.STORES.DELIVERIES).catch(() => []);
        const localStatusMap = new Map(
          (localDeliveries || [])
            .filter(d => d?.id && (d.status === 'en_route' || d.status === 'in_transit'))
            .map(d => [d.id, { status: d.status, arrival_time: d.arrival_time }])
        );
        const mergedDeliveries = freshDeliveries.map(d => {
          const preserved = d?.id ? localStatusMap.get(d.id) : null;
          if (!preserved) return d;
          // Only restore if the fresh record has a weaker/missing status
          const freshStatus = d.status;
          if (!freshStatus || freshStatus === 'pending') {
            return { ...d, status: preserved.status, ...(preserved.arrival_time ? { arrival_time: preserved.arrival_time } : {}) };
          }
          return d;
        });
        await offlineDB.replaceRecordsByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', deliveryDate, mergedDeliveries).catch(() => {});
        updateDeliveriesLocally?.(mergedDeliveries, true);
      } else {
        await refreshData();
      }
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { driverId: currentUser.id, deliveryDate, triggeredBy: 'reoptimizeRoute', alreadyOptimized: true, fullReplacement: true, freshDeliveries: freshDeliveries || undefined },
      }));
      isMapViewLockedRef.current = true;
      setIsMapViewLocked(true);
      setMapViewTrigger((prev) => prev + 1);
      setTimeout(() => {
        isMapViewLockedRef.current = false;
        setOptimizationMessage(null);
        setIsMapViewLocked(false);
      }, 3000);
    } else {
      setOptimizationMessage(data?.error || 'Optimization failed');
      setTimeout(() => setOptimizationMessage(null), 5000);
    }
  } catch (error) {
    console.error('❌ [handleReoptimizeRoute] Error:', error);
    setOptimizationMessage(`Error: ${error.message}`);
    setTimeout(() => setOptimizationMessage(null), 5000);
  } finally {
    resumeOfflineMutations();
    resumeOfflineSync();
    setIsEntityUpdating(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    setIsReoptimizing(false);
  }
}