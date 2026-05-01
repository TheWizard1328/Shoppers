import { toast } from 'sonner';
import { base44 } from '@/api/base44Client';
import { fabControlEvents } from '../utils/fabControlEvents';
import { offlineDB } from '../utils/offlineDatabase';
import { smartRefreshManager } from '../utils/smartRefreshManager';
import { reorderActiveRouteLocally, setAndCenterNextDelivery, getDriverRouteDeliveries } from './stopCardActionHelpers';
import { pauseOfflineSync, resumeOfflineSync } from '../utils/offlineSync';

const isValidObjectId = (value) => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);

const buildStartRoute = ({ routeDeliveries, delivery, isPickup, currentLocalTime, shouldPreserveWindowTimesOnStart }) => {
  return routeDeliveries.map((item) => {
    if (!item) return item;
    const isCurrent = item.id === delivery.id;
    return {
      ...item,
      ...(isCurrent ? {
        status: isPickup ? 'en_route' : 'in_transit',
        stop_order: 1,
        ...(shouldPreserveWindowTimesOnStart ? {} : {
          delivery_time_start: currentLocalTime,
          delivery_time_end: currentLocalTime
        }),
        delivery_time_eta: currentLocalTime,
        isNextDelivery: true,
        travel_dist: 0
      } : {
        ...(item.isNextDelivery ? { isNextDelivery: false } : {})
      })
    };
  });
};

const getChangedDeliveries = (originalRoute, nextRoute) => nextRoute.filter((item) => {
  const existing = originalRoute.find((routeItem) => routeItem?.id === item?.id);
  return existing && (
    Number(existing.stop_order || 0) !== Number(item.stop_order || 0) ||
    (existing.isNextDelivery || false) !== (item.isNextDelivery || false) ||
    (existing.status || null) !== (item.status || null) ||
    (existing.delivery_time_eta || null) !== (item.delivery_time_eta || null) ||
    (existing.delivery_time_start || null) !== (item.delivery_time_start || null) ||
    (existing.delivery_time_end || null) !== (item.delivery_time_end || null) ||
    Number(existing.travel_dist || 0) !== Number(item.travel_dist || 0)
  );
});

const persistLocalRouteChanges = async ({ originalRoute, changedStops, updateDeliveryLocal, updateDeliveriesLocally }) => {
  const safeChangedStops = changedStops.filter(Boolean);
  if (safeChangedStops.length === 0) return;

  await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, safeChangedStops);
  updateDeliveriesLocally?.(safeChangedStops, false);

  await Promise.all(
    safeChangedStops.map((item) => {
      const existing = originalRoute.find((routeItem) => routeItem?.id === item?.id);
      if (!existing) return Promise.resolve(null);
      const updates = {};
      if (existing.status !== item.status) updates.status = item.status;
      if ((existing.isNextDelivery || false) !== (item.isNextDelivery || false)) updates.isNextDelivery = item.isNextDelivery || false;
      if ((existing.delivery_time_start || null) !== (item.delivery_time_start || null)) updates.delivery_time_start = item.delivery_time_start || null;
      if ((existing.delivery_time_end || null) !== (item.delivery_time_end || null)) updates.delivery_time_end = item.delivery_time_end || null;
      if ((existing.delivery_time_eta || null) !== (item.delivery_time_eta || null)) updates.delivery_time_eta = item.delivery_time_eta || null;
      if ((existing.stop_order || null) !== (item.stop_order || null)) updates.stop_order = item.stop_order || null;
      if ((existing.travel_dist || 0) !== (item.travel_dist || 0)) updates.travel_dist = item.travel_dist || 0;
      if (Object.keys(updates).length === 0) return Promise.resolve(null);
      return updateDeliveryLocal(item.id, updates, { skipSmartRefresh: true, isBatchOperation: true });
    })
  );
};

export async function runStartFlow({
  delivery,
  allDeliveries,
  isPickup,
  patient,
  currentUser,
  store,
  appUsers,
  shouldPreserveWindowTimesOnStart,
  collapseDriverStopCards,
  updateDeliveryLocal,
  updateDeliveriesLocally,
  resetActionLocks,
  ensureDriverOnline,
  userHasRole,
  notifyDriverStarted,
  setIsEntityUpdating,
  setIsProcessingBackground
}) {
  if (!delivery?.id || !delivery?.driver_id || !delivery?.delivery_date) {
    resetActionLocks(true);
    return;
  }

  pauseOfflineSync('delivery_actions');
  try {
    const now = new Date();
    const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (!isValidObjectId(delivery.id) || !isValidObjectId(delivery.driver_id)) {
      throw new Error('This stop is still syncing. Please try again in a moment.');
    }

    const routeDeliveries = getDriverRouteDeliveries(allDeliveries, delivery);
    window.dispatchEvent(new CustomEvent('rememberStartButtonMapState'));
    await collapseDriverStopCards();

    const startedRouteDeliveries = buildStartRoute({
      routeDeliveries,
      delivery,
      isPickup,
      currentLocalTime,
      shouldPreserveWindowTimesOnStart
    });

    await persistLocalRouteChanges({
      originalRoute: routeDeliveries,
      changedStops: getChangedDeliveries(routeDeliveries, startedRouteDeliveries),
      updateDeliveryLocal,
      updateDeliveriesLocally
    });

    if (!isPickup && patient?.id && patient?.status === 'inactive') {
      await base44.entities.Patient.update(patient.id, { status: 'active' });
    }

    const locallyReorderedRoute = reorderActiveRouteLocally(startedRouteDeliveries, delivery.id);
    const locallyChangedStops = getChangedDeliveries(routeDeliveries, locallyReorderedRoute);

    await persistLocalRouteChanges({
      originalRoute: routeDeliveries,
      changedStops: locallyChangedStops,
      updateDeliveryLocal,
      updateDeliveriesLocally
    });

    await setAndCenterNextDelivery({
      driverDeliveries: locallyReorderedRoute,
      targetDeliveryId: delivery.id,
      updateDeliveryLocal,
      updateDeliveriesLocally,
      driverId: delivery.driver_id,
      deliveryDate: delivery.delivery_date,
      skipBackgroundSync: true
    });

    window.dispatchEvent(new CustomEvent('centerStopCard', { detail: { deliveryId: delivery.id } }));
    window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
      detail: {
        triggeredBy: 'start',
        driverId: delivery.driver_id,
        deliveryDate: delivery.delivery_date,
        preserveLocalState: true,
        freshDeliveries: locallyChangedStops
      }
    }));
    window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

    Promise.resolve().then(async () => {
      window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source: 'start', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
      try {
        const startResponse = await base44.functions.invoke('handleStartDelivery', {
          deliveryId: delivery.id,
          driverId: delivery.driver_id,
          deliveryDate: delivery.delivery_date,
          currentLocalTime
        });
        const startData = startResponse?.data || startResponse || {};
        const optimizationDeferred = startData?.optimization?.deferred === true || startData?.optimization?.reason === 'rate_limited';
        const backendOptimizedRoute = Array.isArray(startData?.optimization?.optimizedRoute) ? startData.optimization.optimizedRoute : [];

        if (optimizationDeferred) {
          const refreshedRouteDeliveries = await base44.entities.Delivery.filter({
            driver_id: delivery.driver_id,
            delivery_date: delivery.delivery_date
          });
          await setAndCenterNextDelivery({
            driverDeliveries: refreshedRouteDeliveries,
            targetDeliveryId: delivery.id,
            updateDeliveryLocal,
            updateDeliveriesLocally,
            driverId: delivery.driver_id,
            deliveryDate: delivery.delivery_date
          });
        }

        if (backendOptimizedRoute.length > 0) {
          window.dispatchEvent(new CustomEvent('etaUpdated', {
            detail: {
              updates: backendOptimizedRoute.map((item) => ({
                deliveryId: item.deliveryId || item.delivery_id,
                newEta: item.eta || item.newETA
              }))
            }
          }));
          if (startData?.routeChanged || startData?.optimization?.routeChanged || startData?.optimization?.activeStopCountChanged) {
            window.dispatchEvent(new CustomEvent('routeReordered', {
              detail: {
                driverId: delivery.driver_id,
                deliveryDate: delivery.delivery_date,
                source: 'startOptimized'
              }
            }));
          }
        }

        await base44.functions.invoke('recalculateTrackingNumbers', {
          driverId: delivery.driver_id,
          deliveryDate: delivery.delivery_date
        }).catch(() => null);

        if (window.__fabFlashUpdate) {
          window.__fabFlashUpdate('route_change', {
            driverId: delivery.driver_id,
            deliveryDate: delivery.delivery_date,
            deliveryId: delivery.id
          });
        }

        fabControlEvents.resetToPhaseOneAfterDone(3000);
        window.dispatchEvent(new CustomEvent('restoreStartButtonMapState'));
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: {
            triggeredBy: 'startOptimized',
            driverId: delivery.driver_id,
            deliveryDate: delivery.delivery_date,
            alreadyOptimized: true,
            preserveLocalState: true
          }
        }));
      } catch (optErr) {
        const isNotFound = optErr?.status === 404 || optErr?.response?.status === 404 || String(optErr?.message || '').includes('404');
        if (!isNotFound) console.warn('⚠️ [Start] background optimization failed:', optErr?.message || optErr);
      } finally {
        window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'start', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date } }));
      }
    });

    Promise.resolve().then(async () => {
      await ensureDriverOnline().catch(() => {});
      if (userHasRole(currentUser, 'driver') && currentUser.id === delivery.driver_id) {
        await notifyDriverStarted({
          driver: currentUser,
          patientName: isPickup ? `${store?.name || 'Store'} Pickup` : patient?.full_name,
          delivery,
          store,
          appUsers
        }).catch(() => {});
      }
    });
  } catch (error) {
    toast.error(`Failed to start: ${error.message}`);
  } finally {
    resumeOfflineSync('delivery_actions');
    const { driverLocationPoller } = await import('../utils/driverLocationPoller');
    driverLocationPoller.resume();
    smartRefreshManager.resume();
    setIsEntityUpdating(false);
    setIsProcessingBackground(false);
    resetActionLocks(true);
  }
}