/**
 * Handles the manual re-optimize route action.
 * Delegates to the unified routeOptimizationCoordinator,
 * then manages UI state (map lock, loading indicators, events).
 */
import { base44 } from '@/api/base44Client';
import { pauseOfflineMutations, resumeOfflineMutations } from '@/components/utils/offlineMutations';
import { pauseOfflineSync, resumeOfflineSync } from '@/components/utils/offlineSync';
import { performRouteOptimization } from '@/components/utils/routeOptimizationCoordinator';
import { offlineDB } from '@/components/utils/offlineDatabase';

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
    const driverAppUser = appUsers.find((au) => au?.user_id === currentUser.id);
    const currentLocation = driverAppUser?.current_latitude && driverAppUser?.current_longitude
      ? { lat: driverAppUser.current_latitude, lon: driverAppUser.current_longitude }
      : null;

    // ── Unified optimization call ──────────────────────────────────────────
    const result = await performRouteOptimization({
      driverId: currentUser.id,
      deliveryDate,
      currentLocation,
      source: 'reoptimize_fab',
      bypassDriverStatus: true,
    });

    if (result.success) {
      setOptimizationMessage(`Route optimized! ${result.optimizeData?.optimizedCount || 0} stops updated.`);
      if (result.optimizeData?.skippedStopsCount > 0 && Array.isArray(result.optimizeData.skippedStops)) {
        setSkippedStopsDialogData(result.optimizeData.skippedStops);
      }

      // Push fresh deliveries to UI
      if (Array.isArray(result.freshDeliveries) && result.freshDeliveries.length > 0) {
        updateDeliveriesLocally?.(result.freshDeliveries, true);
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: {
            driverId: currentUser.id,
            deliveryDate,
            triggeredBy: 'reoptimizeRoute',
            alreadyOptimized: true,
            fullReplacement: true,
            freshDeliveries: result.freshDeliveries,
          },
        }));
      } else {
        await refreshData();
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: { driverId: currentUser.id, deliveryDate, triggeredBy: 'reoptimizeRoute', alreadyOptimized: true },
        }));
      }

      // Map lock: freeze for 3s so user sees the final phase
      isMapViewLockedRef.current = true;
      setIsMapViewLocked(true);
      setMapViewTrigger((prev) => prev + 1);
      setTimeout(() => {
        isMapViewLockedRef.current = false;
        setOptimizationMessage(null);
        setIsMapViewLocked(false);
      }, 3000);
    } else {
      setOptimizationMessage(result.error || 'Optimization failed');
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