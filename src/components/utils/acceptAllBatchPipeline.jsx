import { offlineDB } from './offlineDatabase';
import { base44 } from '@/api/base44Client';
import { processPendingMutations } from './offlineSync';

const ACTIVE_STATUSES = ['in_transit', 'en_route'];

const addMinutesToTimeString = (timeString, minutesToAdd = 0) => {
  const [hours, minutes] = String(timeString || '00:00').split(':').map(Number);
  const totalMinutes = ((hours || 0) * 60) + (minutes || 0) + minutesToAdd;
  const normalizedMinutes = ((totalMinutes % 1440) + 1440) % 1440;
  const nextHours = Math.floor(normalizedMinutes / 60);
  const nextMinutes = normalizedMinutes % 60;
  return `${String(nextHours).padStart(2, '0')}:${String(nextMinutes).padStart(2, '0')}`;
};

export async function runAcceptAllBatchPipeline({
  triggerDelivery,
  allDeliveries,
  stores,
  currentLocalTime,
  deliveryTimeStart,
  updateDeliveriesLocally
}) {
  const routeDeliveries = allDeliveries.filter((item) => item && item.driver_id === triggerDelivery.driver_id && item.delivery_date === triggerDelivery.delivery_date);
  const scopedPendingDeliveries = routeDeliveries.filter((item) => item?.store_id === triggerDelivery.store_id && item.status === 'pending');

  const pickupStartTime = currentLocalTime;
  const transitionedStopStartTime = addMinutesToTimeString(currentLocalTime, 5);

  const stagedRoute = routeDeliveries.map((item) => {
    if (!item) return item;
    if (item.id === triggerDelivery.id) {
      return {
        ...item,
        status: item.status === 'pending' ? 'in_transit' : item.status,
        isNextDelivery: true,
        delivery_time_start: pickupStartTime,
        ...(item.active === false ? { active: true } : {})
      };
    }
    if (item.store_id === triggerDelivery.store_id && item.status === 'pending') {
      return {
        ...item,
        status: 'in_transit',
        isNextDelivery: false,
        delivery_time_start: transitionedStopStartTime,
        ampm_deliveries: item.ampm_deliveries || triggerDelivery.ampm_deliveries || (transitionedStopStartTime >= '15:00' ? 'PM' : 'AM'),
        ...(item.active === false ? { active: true } : {})
      };
    }
    if (item.isNextDelivery === true) {
      return { ...item, isNextDelivery: false };
    }
    return item;
  });

  const stagedChangedDeliveries = stagedRoute.filter((item, index) => {
    const original = routeDeliveries[index];
    return original && JSON.stringify(original) !== JSON.stringify(item);
  });

  if (stagedChangedDeliveries.length > 0) {
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, stagedChangedDeliveries);
    updateDeliveriesLocally?.(stagedChangedDeliveries, false);

    await Promise.all(stagedChangedDeliveries.map((item) =>
      base44.entities.Delivery.update(item.id, {
        status: item.status,
        isNextDelivery: !!item.isNextDelivery,
        active: item.active,
        delivery_time_start: item.delivery_time_start,
        ampm_deliveries: item.ampm_deliveries
      })
    ));

    await processPendingMutations();
  }

  const optimizeResponse = await base44.functions.invoke('optimizeRemainingStops', {
    driverId: triggerDelivery.driver_id,
    deliveryDate: triggerDelivery.delivery_date,
    currentLocalTime,
    deviceTime: new Date().toISOString(),
    forceFullRemainingRouteOptimization: false,
    bypassDriverStatus: true
  });
  const optimizeData = optimizeResponse?.data || optimizeResponse || {};

  const offlineDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
  const stagedStatusMap = new Map(stagedRoute.filter(Boolean).map((item) => [item.id, item]));
  const optimizedMap = new Map();
  const optimizedRoute = Array.isArray(optimizeData?.optimizedRoute) ? optimizeData.optimizedRoute : [];

  optimizedRoute.forEach((stop) => {
    const id = stop.deliveryId || stop.delivery_id;
    if (!id) return;
    const existing = offlineDeliveries.find((item) => item?.id === id);
    const staged = stagedStatusMap.get(id);
    if (!existing && !staged) return;
    optimizedMap.set(id, {
      ...(existing || {}),
      ...(staged || {}),
      ...(Number.isFinite(Number(stop.stop_order)) ? { stop_order: Number(stop.stop_order), display_stop_order: Number(stop.stop_order) } : {}),
      ...(stop.newETA || stop.eta ? { delivery_time_eta: stop.newETA || stop.eta } : {}),
      ...(typeof stop.travel_dist === 'number' ? { travel_dist: stop.travel_dist } : {})
    });
  });

  const finalOfflineUpdates = Array.from(optimizedMap.values());
  const fallbackStatusLockedUpdates = stagedChangedDeliveries.filter((item) => !optimizedMap.has(item.id));
  const mergedFinalOfflineUpdates = [...finalOfflineUpdates, ...fallbackStatusLockedUpdates];
  if (mergedFinalOfflineUpdates.length > 0) {
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, mergedFinalOfflineUpdates);
    updateDeliveriesLocally?.(mergedFinalOfflineUpdates, false);
  }

  const finalRouteStops = (await offlineDB.getAll(offlineDB.STORES.DELIVERIES)).filter((item) =>
    item && item.driver_id === triggerDelivery.driver_id && item.delivery_date === triggerDelivery.delivery_date
  );

  await Promise.all(finalRouteStops.map((item) => {
    const staged = stagedStatusMap.get(item.id);
    return base44.entities.Delivery.update(item.id, {
      status: staged?.status ?? item.status,
      isNextDelivery: staged?.isNextDelivery ?? !!item.isNextDelivery,
      active: staged?.active ?? item.active,
      stop_order: item.stop_order,
      display_stop_order: item.display_stop_order,
      delivery_time_eta: item.delivery_time_eta,
      delivery_time_start: item.delivery_time_start,
      ampm_deliveries: staged?.ampm_deliveries ?? item.ampm_deliveries,
      travel_dist: item.travel_dist,
      encoded_polyline: item.encoded_polyline,
      transport_mode: item.transport_mode,
      estimated_distance_km: item.estimated_distance_km,
      estimated_duration_minutes: item.estimated_duration_minutes
    });
  }));

  await processPendingMutations();

  const codBatch = scopedPendingDeliveries.filter((pd) => pd.cod_total_amount_required > 0 && pd.patient_id).map((pendingDelivery) => {
    const storeForCod = stores.find((s) => s && s.id === pendingDelivery.store_id);
    return {
      deliveryId: pendingDelivery.id,
      patientName: pendingDelivery.patient_name,
      storeAbbreviation: storeForCod?.abbreviation || '',
      codAmount: pendingDelivery.cod_total_amount_required,
      deliveryDate: pendingDelivery.delivery_date,
      storeId: pendingDelivery.store_id
    };
  });

  return { stagedChangedDeliveries, finalOfflineUpdates: mergedFinalOfflineUpdates, finalActiveStops: finalRouteStops.filter((item) => ACTIVE_STATUSES.includes(item.status)), codBatch, optimizeData, scopedPendingDeliveries };
}