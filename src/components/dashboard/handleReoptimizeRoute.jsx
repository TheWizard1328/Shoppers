/**
 * Handles the manual re-optimize route action.
 * Delegates to the unified routeOptimizationCoordinator,
 * then manages UI state (map lock, loading indicators, events).
 *
 * Now passes local in-memory data (deliveries, patients, stores) to the
 * coordinator so the client-side engine operates on fresh data, not a
 * stale backend fetch.
 */
import { base44 } from '@/api/base44Client';
import { pauseOfflineMutations, resumeOfflineMutations } from '@/components/utils/offlineMutations';
import { pauseOfflineSync, resumeOfflineSync } from '@/components/utils/offlineSync';
import { performRouteOptimization } from '@/components/utils/routeOptimizationCoordinator';

export async function handleReoptimizeRoute({
  currentUser,
  selectedDate,
  appUsers,
  format,
  // CRITICAL: driverId is the selected driver (may differ from currentUser.id for admins)
  driverId: explicitDriverId,
  setIsReoptimizing,
  setOptimizationMessage,
  setIsEntityUpdating,
  setSkippedStopsDialogData,
  refreshData,
  updateDeliveriesLocally,
  isMapViewLockedRef,
  setIsMapViewLocked,
  setMapViewTrigger,
  // Local data for the client-side engine
  deliveries = null,
  patients = null,
  stores = null,
}) {
  // Use explicit driverId when provided (admin viewing a specific driver), else fall back to currentUser
  const driverId = explicitDriverId || currentUser.id;

  try {
    console.log('🚀 [handleReoptimizeRoute] FAB triggered — driverId:', driverId, 'deliveries:', deliveries?.length, 'patients:', patients?.length, 'stores:', stores?.length);
    setIsReoptimizing(true);
    setOptimizationMessage('Re-optimizing route...');

    // Pause smart refresh BEFORE optimization
    setIsEntityUpdating(true);
    pauseOfflineMutations();
    pauseOfflineSync();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const deliveryDate = format(selectedDate, 'yyyy-MM-dd');
    const driverAppUser = appUsers.find((au) => au?.user_id === driverId);
    const currentLocation = driverAppUser?.current_latitude && driverAppUser?.current_longitude
      ? { lat: driverAppUser.current_latitude, lon: driverAppUser.current_longitude }
      : null;

    // Filter deliveries to just this driver+date for the engine
    const driverDeliveries = Array.isArray(deliveries)
      ? deliveries.filter(d => d && d.driver_id === driverId && d.delivery_date === deliveryDate)
      : null;

    // ── Unified optimization call (client-side engine) ──────────────────────
    const result = await performRouteOptimization({
      driverId,
      deliveryDate,
      currentLocation,
      deliveries: driverDeliveries,
      patients,
      stores,
      appUsers,
      source: 'reoptimize_fab',
      bypassDriverStatus: true,
    });

    if (result.success) {
      setOptimizationMessage(`Route optimized! ${result.optimizeData?.optimizedCount || 0} stops updated.`);
      if (result.isDegraded) {
        setOptimizationMessage(prev => `${prev} (approximated — HERE routing was unavailable)`);
      }

      // Push fresh deliveries to UI
      if (Array.isArray(result.freshDeliveries) && result.freshDeliveries.length > 0) {
        updateDeliveriesLocally?.(result.freshDeliveries, true);
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: {
            driverId,
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
          detail: { driverId, deliveryDate, triggeredBy: 'reoptimizeRoute', alreadyOptimized: true },
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