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
  patients = [],
  currentLocalTime,
  deliveryTimeStart,
  updateDeliveriesLocally,
  localDeviceTodayStr
}) {
  const routeDeliveries = allDeliveries.filter((item) => item && item.driver_id === triggerDelivery.driver_id && item.delivery_date === triggerDelivery.delivery_date);
  const scopedPendingDeliveries = routeDeliveries.filter((item) => item?.store_id === triggerDelivery.store_id && item.status === 'pending');

  // RETRO RULES: For past dates, use pickup start time; for current/future, add 5 minutes
  const isRetroDate = triggerDelivery.delivery_date < localDeviceTodayStr;
  const pickupStartTime = currentLocalTime;
  const defaultTransitionTime = isRetroDate 
    ? addMinutesToTimeString(currentLocalTime, 5)
    : addMinutesToTimeString(currentLocalTime, 5);

  const stagedRoute = routeDeliveries.map((item, index) => {
     if (!item) return item;
     if (item.id === triggerDelivery.id) {
       // RETRO RULES: For retro pickup (first stop), set delivery_time_eta to delivery_time_start
       const pickupUpdate = {
         ...item,
         status: item.status === 'pending' ? 'in_transit' : item.status,
         isNextDelivery: true,
         delivery_time_start: pickupStartTime,
         ...(item.active === false ? { active: true } : {})
       };
       if (isRetroDate) {
         pickupUpdate.delivery_time_eta = pickupStartTime;
       }
       return pickupUpdate;
     }
     // CRITICAL: Only transition strictly 'pending' stops - never touch en_route/in_transit stops
     if (item.store_id === triggerDelivery.store_id && item.status === 'pending') {
       // CRITICAL: Check if patient has time_window_start - if so, use it instead of default transition time
       let delivery_time_start = defaultTransitionTime;
       if (item.patient_id) {
         const patient = patients.find((p) => p?.id === item.patient_id);
         if (patient?.time_window_start) {
           delivery_time_start = patient.time_window_start;
         }
       }

       // RETRO RULES: For retro dates, calculate ETA from previous stop's actual delivery time + duration
       let delivery_time_eta = undefined;
       if (isRetroDate) {
         const triggerIndex = routeDeliveries.findIndex(d => d?.id === triggerDelivery.id);
         const isFirstDeliveryAfterPickup = index === triggerIndex + 1;

         if (isFirstDeliveryAfterPickup && triggerDelivery.estimated_duration_minutes) {
           // First delivery: pickup ETA + pickup duration
           delivery_time_eta = addMinutesToTimeString(pickupStartTime, triggerDelivery.estimated_duration_minutes);
         } else if (index > triggerIndex + 1) {
           // Subsequent deliveries: previous stop's actual delivery time + previous stop's duration
           const previousStop = routeDeliveries[index - 1];
           if (previousStop?.actual_delivery_time) {
             const prevDuration = previousStop.estimated_duration_minutes || 5;
             delivery_time_eta = addMinutesToTimeString(previousStop.actual_delivery_time, prevDuration);
           }
         }
       }

       return {
         ...item,
         status: 'in_transit',
         isNextDelivery: false,
         delivery_time_start,
         ...(delivery_time_eta ? { delivery_time_eta } : {}),
         ampm_deliveries: item.ampm_deliveries || triggerDelivery.ampm_deliveries || (pickupStartTime >= '15:00' ? 'PM' : 'AM'),
         ...(item.active === false ? { active: true } : {})
       };
     }
     // CRITICAL: Only clear isNextDelivery from non-active stops. Preserve en_route/in_transit ETAs.
     if (item.isNextDelivery === true && item.status !== 'en_route' && item.status !== 'in_transit') {
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

    // CRITICAL: Pre-stamp the dedup key BEFORE individual writes to suppress automation-triggered
    // optimizeRemainingStops calls that fire from each in_transit write. The explicit call below
    // (with bypassDeduplication: true) is the single authoritative optimization.
    base44.functions.invoke('optimizeRemainingStops', {
      driverId: triggerDelivery.driver_id,
      deliveryDate: triggerDelivery.delivery_date,
      _stampDedupeOnly: true,
      bypassDeduplication: false
    }).catch(() => {});

    await Promise.all(stagedChangedDeliveries.map((item) =>
      base44.entities.Delivery.update(item.id, {
        status: item.status,
        isNextDelivery: !!item.isNextDelivery,
        active: item.active,
        delivery_time_start: item.delivery_time_start || undefined,
        ampm_deliveries: item.ampm_deliveries
      })
    ));

    await processPendingMutations();

    // Reactivate any inactive patients whose deliveries just went in_transit
    const inactivePatientIds = stagedChangedDeliveries
      .filter((item) => item?.patient_id && item.status === 'in_transit')
      .map((item) => item.patient_id);

    if (inactivePatientIds.length > 0) {
      Promise.resolve().then(async () => {
        try {
          const cachedPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS).catch(() => []);
          const inactivePatients = cachedPatients.filter((p) => p?.id && inactivePatientIds.includes(p.id) && p.status === 'inactive');
          if (inactivePatients.length > 0) {
            const { updatePatientLocal } = await import('./offlineMutations');
            await Promise.all(inactivePatients.map(async (p) => {
              await updatePatientLocal(p.id, { status: 'active' }).catch(() => {});
              await base44.entities.Patient.update(p.id, { status: 'active' }).catch(() => {});
            }));
          }
        } catch {}
      });
    }
  }

  const optimizeResponse = await base44.functions.invoke('optimizeRemainingStops', {
   driverId: triggerDelivery.driver_id,
   deliveryDate: triggerDelivery.delivery_date,
   currentLocalTime,
   deviceTime: new Date().toISOString(),
   forceFullRemainingRouteOptimization: true,
   bypassDriverStatus: true,
   bypassDeduplication: true,
   bypassHistoricalCheck: true,
   allowPolylineGenerationForRetroDate: true
  });
  const optimizeData = optimizeResponse?.data || optimizeResponse || {};

  // Generate polylines for the optimized route order
  const orderedDeliveryIds = Array.isArray(optimizeData?.orderedDeliveryIds) && optimizeData.orderedDeliveryIds.length > 0
    ? optimizeData.orderedDeliveryIds
    : null;
  if (orderedDeliveryIds) {
    // CRITICAL: Skip the first stop (the pickup/trigger delivery) — its Type 1 polyline already
    // exists and does not need to be regenerated. Only regenerate stops 2+ (Type 2 forward polylines).
    const polylineIds = orderedDeliveryIds.filter((id) => id !== triggerDelivery.id);
    if (polylineIds.length > 0) {
      // CRITICAL: Use the pickup/store location as the origin for the first segment after the pickup.
      // Without this, purgeAndRegeneratePolylines falls back to driver home as the origin.
      const triggerStore = stores.find((s) => s && s.id === triggerDelivery.store_id);
      const pickupOrigin = triggerStore?.latitude && triggerStore?.longitude
        ? { lat: Number(triggerStore.latitude), lon: Number(triggerStore.longitude) }
        : null;

      base44.functions.invoke('purgeAndRegeneratePolylines', {
        driverId: triggerDelivery.driver_id,
        deliveryDate: triggerDelivery.delivery_date,
        orderedDeliveryIds: polylineIds,
        ...(pickupOrigin ? { currentPosition: pickupOrigin } : {})
      }).catch(() => {});
    }
  }

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
      ...(typeof stop.travel_dist === 'number' ? { travel_dist: stop.travel_dist } : {}),
      ...(typeof stop.encoded_polyline === 'string' ? { encoded_polyline: stop.encoded_polyline } : {}),
      ...(typeof stop.estimated_distance_km === 'number' ? { estimated_distance_km: stop.estimated_distance_km } : {}),
      ...(typeof stop.estimated_duration_minutes === 'number' ? { estimated_duration_minutes: stop.estimated_duration_minutes } : {})
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