import { offlineDB } from './offlineDatabase';
import { base44 } from '@/api/base44Client';

const ACTIVE_STATUSES = ['in_transit', 'en_route'];

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

  const stagedRoute = routeDeliveries.map((item) => {
    if (!item) return item;
    if (item.id === triggerDelivery.id) {
      return { ...item, status: item.status === 'pending' ? 'in_transit' : item.status, isNextDelivery: true, ...(item.active === false ? { active: true } : {}) };
    }
    if (item.store_id === triggerDelivery.store_id && item.status === 'pending') {
      return { ...item, status: 'in_transit', isNextDelivery: false, ...(item.active === false ? { active: true } : {}) };
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
  }

  const optimizeResponse = await base44.functions.invoke('optimizeRemainingStops', {
    driverId: triggerDelivery.driver_id,
    deliveryDate: triggerDelivery.delivery_date,
    currentLocalTime,
    forceFullRemainingRouteOptimization: true
  });
  const optimizeData = optimizeResponse?.data || optimizeResponse || {};

  const offlineDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
  const optimizedMap = new Map();
  const optimizedRoute = Array.isArray(optimizeData?.optimizedRoute) ? optimizeData.optimizedRoute : [];

  optimizedRoute.forEach((stop) => {
    const id = stop.deliveryId || stop.delivery_id;
    if (!id) return;
    const existing = offlineDeliveries.find((item) => item?.id === id);
    if (!existing) return;
    optimizedMap.set(id, {
      ...existing,
      ...(Number.isFinite(Number(stop.stop_order)) ? { stop_order: Number(stop.stop_order), display_stop_order: Number(stop.stop_order) } : {}),
      ...(stop.newETA || stop.eta ? { delivery_time_eta: stop.newETA || stop.eta } : {}),
      ...(typeof stop.travel_dist === 'number' ? { travel_dist: stop.travel_dist } : {})
    });
  });

  const finalOfflineUpdates = Array.from(optimizedMap.values());
  if (finalOfflineUpdates.length > 0) {
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, finalOfflineUpdates);
    updateDeliveriesLocally?.(finalOfflineUpdates, false);
  }

  const finalActiveStops = (await offlineDB.getAll(offlineDB.STORES.DELIVERIES)).filter((item) =>
    item && item.driver_id === triggerDelivery.driver_id && item.delivery_date === triggerDelivery.delivery_date && ACTIVE_STATUSES.includes(item.status)
  );

  await Promise.all(finalActiveStops.map((item) =>
    base44.entities.Delivery.update(item.id, {
      status: item.status,
      isNextDelivery: !!item.isNextDelivery,
      active: item.active,
      stop_order: item.stop_order,
      display_stop_order: item.display_stop_order,
      delivery_time_eta: item.delivery_time_eta,
      delivery_time_start: item.delivery_time_start,
      travel_dist: item.travel_dist
    })
  ));

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

  return { stagedChangedDeliveries, finalOfflineUpdates, finalActiveStops, codBatch, optimizeData, scopedPendingDeliveries };
}