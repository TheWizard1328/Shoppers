import { format } from 'date-fns';
import { generateUniqueSID, addMinutesToTime } from "@/components/dashboard/DashboardHelpers";
import { batchCreateDeliveriesLocal, updateDeliveryLocal } from "@/components/utils/entityMutations";
import { base44 } from "@/api/base44Client";
import { determineAMPMFromTime } from '@/components/utils/ampmUtils';

const calculateDistance = (lat1, lon1, lat2, lon2) => {
  if (lat1 === undefined || lon1 === undefined || lat2 === undefined || lon2 === undefined) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
  Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

export const handleBatchSaveDelivery = async ({
  deliveryData,
  drivers,
  deliveries,
  patients,
  stores,
  currentUser,
  selectedDate,
  invalidate,
  updateDeliveriesLocally,
  refreshData,
  setShowDeliveryForm,
  setEditingDelivery,
  hasAutoSelectedRef,
  invalidateDeliveriesForDate
}) => {
  const stagedDeliveries = deliveryData._stagedDeliveries;
  const ensuredPickupRecords = Array.isArray(deliveryData._ensuredPickups) ? deliveryData._ensuredPickups.filter(Boolean) : [];
  console.log('[AddToRoute] handleBatchSaveDelivery:start', {
    stagedCount: stagedDeliveries?.length || 0,
    ensuredPickupCount: ensuredPickupRecords.length,
    stagedSnapshot: (stagedDeliveries || []).map((delivery) => ({
      id: delivery?.id || null,
      tempId: delivery?._tempId || null,
      patient_id: delivery?.patient_id || null,
      store_id: delivery?.store_id || null,
      driver_id: delivery?.driver_id || null,
      status: delivery?.status || null,
      puid: delivery?.puid || null,
      tracking_number: delivery?.tracking_number || null
    }))
  });
  const allCreatedDeliveries = [];
  const allUpdatedDeliveries = [];
  const createdPickupRecords = [];
  const createdDeliveryMap = new Map();
  const currentAppUserId = currentUser?.id || currentUser?.app_user_id || null;

  if (!stagedDeliveries || stagedDeliveries.length === 0) {
    console.warn('[AddToRoute] ⚠️ No staged deliveries found!');
    return;
  }

  const deliveriesByGroup = {};
  stagedDeliveries.forEach((delivery) => {
    if (!delivery) return;

    const driverId = delivery.driver_id && delivery.driver_id.trim() !== '' ? delivery.driver_id : 'unassigned';
    const date = delivery.delivery_date || format(selectedDate, 'yyyy-MM-dd');
    const key = `${driverId}_${date}`;
    if (!deliveriesByGroup[key]) {
      deliveriesByGroup[key] = [];
    }
    deliveriesByGroup[key].push(delivery);
  });

  for (const [groupKey, driverDeliveries] of Object.entries(deliveriesByGroup)) {
    const driverId = groupKey.split('_')[0];
    const deliveryDate = driverDeliveries[0].delivery_date || format(selectedDate, 'yyyy-MM-dd');

    // Allow 'unassigned' driverId to proceed

    const driver = drivers.find((d) => d && d.id === driverId);
    if (!driver && driverId !== 'unassigned') {
      console.warn(`[AddToRoute] ⚠️ Driver not found: ${driverId}`);
      continue;
    }

    const isDriverAssignedToSlot = (store, slotPrefix) => {
      if (!driver) return false; // Skip slot checks for unassigned
      const enabledField = `${slotPrefix}_enabled`;
      if (!store[enabledField]) return false;

      const idField = `${slotPrefix}_driver_id`;
      const nameField = `${slotPrefix}_driver`;

      if (store[idField] && driver.id) return store[idField] === driver.id;
      if (store[nameField] && driver.user_name) {
        return store[nameField].toLowerCase().trim() === driver.user_name.toLowerCase().trim();
      }
      return false;
    };

    const allDeliveriesForDate = (deliveries || []).filter((delivery) => {
      if (!delivery) return false;
      return delivery.delivery_date === deliveryDate;
    });
    const driverDeliveriesForDate = allDeliveriesForDate.filter((delivery) => {
      if (!delivery) return false;
      if (driverId === 'unassigned') return !delivery.driver_id; // Match unassigned
      return delivery.driver_id === driverId;
    });

    const stopsToProcess = [];
    const ensuredPickupMap = new Map(
      ensuredPickupRecords
        .filter((pickup) => pickup && !pickup.patient_id)
        .map((pickup) => [`${pickup.store_id}__${pickup.delivery_date}__${pickup.driver_id || ''}__${pickup.ampm_deliveries || 'AM'}`, pickup])
    );

    for (const existingDelivery of driverDeliveriesForDate) {
      if (!existingDelivery) continue;

      const enriched = { ...existingDelivery, isNew: false };

      if (existingDelivery.patient_id) {
        const existingPatient = patients.find((p) => p.id === existingDelivery.patient_id);
        if (existingPatient?.latitude && existingPatient?.longitude) {
          enriched.latitude = existingPatient.latitude;
          enriched.longitude = existingPatient.longitude;
        }
      } else {
        const existingStore = stores.find((s) => s.id === existingDelivery.store_id);
        if (existingStore?.latitude && existingStore?.longitude) {
          enriched.latitude = existingStore.latitude;
          enriched.longitude = existingStore.longitude;
        }
      }

      stopsToProcess.push(enriched);
    }

    const dateObj = new Date(deliveryDate + 'T00:00:00');
    const dayOfWeek = dateObj.getDay();
    const isSaturday = dayOfWeek === 6;
    const isSunday = dayOfWeek === 0;

    const specialStoreNames = ['Lakeland Ridge', 'Sherwood Pk Mall', 'SouthPoint', 'WestPark'];

    for (const newDelivery of driverDeliveries) {
      if (!newDelivery) continue;

      const patient = patients.find((p) => p && p.id === newDelivery.patient_id) || null;
      const deliveryStore = stores.find((s) => s && s.id === newDelivery.store_id) || null;

      // CRITICAL: For special stores, create pickup on-demand when first delivery is added
      // CRITICAL: Use the status from DeliveryForm (already converted from 'Staged' to 'pending' or 'in_transit')
      // Do NOT override with hardcoded 'pending' - respect what DeliveryForm sent
      // Reliable ISP/ISD detection: covers both non-patient ISP/ISD stops and patient ISP/ISD deliveries
      const isInterStoreTransfer = !!(
        newDelivery?._interstore_source_id ||
        String(newDelivery?.delivery_id || '').toUpperCase().startsWith('ISP-') ||
        String(newDelivery?.delivery_id || '').toUpperCase().startsWith('ISD-')
      );
      const now = new Date();
      const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      stopsToProcess.push({
        isNew: true,
        ...newDelivery,
        status: isInterStoreTransfer ? 'in_transit' : (newDelivery.status || 'pending'),
        delivery_time_start: isInterStoreTransfer ? currentLocalTime : newDelivery.delivery_time_start,
        latitude: patient?.latitude ?? newDelivery.latitude,
        longitude: patient?.longitude ?? newDelivery.longitude,
        extra_time: newDelivery.extra_time || 5
      });

    }

    for (const stop of stopsToProcess) {
      if (!stop || !stop.isNew) continue;
      if (!stop.patient_id) {
        if (!stop.stop_id) {
          stop.stop_id = generateUniqueSID(allDeliveriesForDate);
        }
        stop.puid = stop.stop_id;
      }
    }

    for (const stop of stopsToProcess) {
      if (!stop || !stop.isNew || !stop.patient_id) continue;
      const resolvedAmpm = stop.ampm_deliveries || determineAMPMFromTime(stop.delivery_time_start || '10:00');
      const ensuredPickup = ensuredPickupMap.get(`${stop.store_id}__${stop.delivery_date}__${driverId === 'unassigned' ? '' : driverId}__${resolvedAmpm}`);
      stop.ampm_deliveries = ensuredPickup?.ampm_deliveries || resolvedAmpm;

      if (ensuredPickup?.stop_id) {
        stop.puid = ensuredPickup.stop_id;
        continue;
      }

      const correspondingPickup = stopsToProcess.find((p) =>
      p && !p.patient_id && p.store_id === stop.store_id &&
      p.ampm_deliveries === stop.ampm_deliveries && p.stop_id
      );
      if (correspondingPickup) {
        stop.puid = correspondingPickup.stop_id;
      } else {
        const fallbackPickup = stopsToProcess.find((p) =>
        p && !p.patient_id && p.store_id === stop.store_id && p.stop_id
        );
        if (fallbackPickup) {
          stop.puid = fallbackPickup.stop_id;
          stop.ampm_deliveries = fallbackPickup.ampm_deliveries || stop.ampm_deliveries;
        } else {
          console.warn(`[AddToRoute]   ⚠️ No matching pickup found for ${stop.patient_name || stop.patient_id}`);
        }
      }
    }

    for (const stop of stopsToProcess) {
      if (!stop) continue;

      if (stop.patient_id !== null) {
        const stopPatient = patients.find((p) => p.id === stop.patient_id);

        // CRITICAL: Find the corresponding pickup by matching BOTH store_id AND ampm_deliveries
        const correspondingPickup = stopsToProcess.find((s) => {
          if (!s) return false;
          return s.store_id === stop.store_id &&
          s.patient_id === null &&
          s.ampm_deliveries === stop.ampm_deliveries;
        });

        if (stopPatient?.time_window_start) {
          stop.delivery_time_start = stopPatient.time_window_start;
        } else if (correspondingPickup?.delivery_time_start) {
          stop.delivery_time_start = addMinutesToTime(correspondingPickup.delivery_time_start, 5);
        } else {
          stop.delivery_time_start = stop.delivery_time_start || '10:00';
        }

        if (stopPatient?.time_window_end) {
          stop.delivery_time_end = stopPatient.time_window_end;
        } else {
          stop.delivery_time_end = '';
        }

        stop.time_window_start = stop.delivery_time_start;
        stop.time_window_end = stop.delivery_time_end || '';
        // DISABLED: No longer auto-assign 9:00 PM default - leave blank if patient has no time window
      }
    }

    const optimizedRoute = [...stopsToProcess];
    for (const stop of optimizedRoute) {
      if (!stop || stop.patient_id === null) continue;
      const stopPatient = patients.find((p) => p.id === stop.patient_id);
      const correspondingPickup = optimizedRoute.find((s) => s && s.store_id === stop.store_id && s.patient_id === null && s.ampm_deliveries === stop.ampm_deliveries);
      if (stopPatient?.time_window_start) {
        stop.delivery_time_start = stopPatient.time_window_start;
      } else if (correspondingPickup?.delivery_time_start) {
        const p5 = addMinutesToTime(correspondingPickup.delivery_time_start, 5);
        const eta5 = correspondingPickup.estimated_arrival ? addMinutesToTime(correspondingPickup.estimated_arrival, 5) : null;
        if (eta5 && eta5 > p5) stop.delivery_time_start = eta5;else
        if (p5) stop.delivery_time_start = p5;
      }
      if (stopPatient?.time_window_end) {
        stop.delivery_time_end = stopPatient.time_window_end;
      } else {
        stop.delivery_time_end = '';
      }
      stop.time_window_start = stop.delivery_time_start;
      stop.time_window_end = stop.delivery_time_end || '';
    }

    // First, set AM/PM on all pickups based on their scheduled time
    for (const stop of optimizedRoute) {
      if (!stop) continue;

      if (stop.patient_id === null && stop.delivery_time_start) {
        const ampm = determineAMPMFromTime(stop.delivery_time_start);
        stop.ampm_deliveries = ampm;
        if (!stop.puid && stop.stop_id) {
          stop.puid = stop.stop_id;
        }
      }
    }

    // Then, set AM/PM on all deliveries based on their PICKUP's time slot (not their own time)
    for (const stop of optimizedRoute) {
      if (!stop) continue;

      if (stop.patient_id !== null) {
        // Find the corresponding pickup for this store
        const correspondingPickup = optimizedRoute.find((p) =>
        p && !p.patient_id && p.store_id === stop.store_id
        );

        if (correspondingPickup && correspondingPickup.ampm_deliveries) {
          // CRITICAL: Use pickup's AM/PM designation, not delivery's own time
          stop.ampm_deliveries = correspondingPickup.ampm_deliveries;
          if (!stop.puid && correspondingPickup.stop_id) {
            stop.puid = correspondingPickup.stop_id;
          }
        } else {
          // Fallback: if no pickup found, determine from delivery time
          const ampm = determineAMPMFromTime(stop.delivery_time_start);
          stop.ampm_deliveries = ampm;
          console.warn(`[AddToRoute]   ⚠️ No pickup found for ${patients.find((pt) => pt.id === stop.patient_id)?.full_name}, using delivery time for AM/PM`);
        }
      }
    }

    const parsePickupTrackingNumber = (value) => {
      if (value === null || value === undefined) return null;
      const match = String(value).match(/\d+/);
      if (!match) return null;
      const parsed = parseInt(match[0], 10);
      return Number.isNaN(parsed) ? null : parsed;
    };

    const getNextPickupTrackingNumber = (pickups = []) => {
      const usedTrackingNumbers = [...new Set(
        pickups
          .map((pickup) => parsePickupTrackingNumber(pickup?.tracking_number))
          .filter((value) => value !== null && value >= 0 && value % 20 === 0)
      )].sort((a, b) => a - b);

      let expectedTrackingNumber = 0;
      for (const trackingNumber of usedTrackingNumbers) {
        if (trackingNumber > expectedTrackingNumber) break;
        if (trackingNumber === expectedTrackingNumber) expectedTrackingNumber += 20;
      }

      return String(expectedTrackingNumber).padStart(2, '0');
    };

    const storePickupTRMap = {};
    const allExistingPickupTRs = (driverDeliveriesForDate || [])
      .filter((stop) => stop && !stop.patient_id)
      .map((stop) => parsePickupTrackingNumber(stop.tracking_number))
      .filter((value) => value !== null && value >= 0);

    for (const stop of driverDeliveriesForDate || []) {
      if (!stop || stop.patient_id !== null) continue;
      const mapKey = `${stop.store_id}-${stop.ampm_deliveries || 'AM'}`;
      const existingTR = parseInt(stop.tracking_number, 10);
      if (!isNaN(existingTR) && storePickupTRMap[mapKey] === undefined) {
        storePickupTRMap[mapKey] = existingTR;
      }
    }

    const pickupTrackingPool = (driverDeliveriesForDate || []).filter((stop) => stop && !stop.patient_id);

    for (const stop of optimizedRoute) {
      if (!stop || !stop.isNew || stop.patient_id !== null) continue;
      const mapKey = `${stop.store_id}-${stop.ampm_deliveries || 'AM'}`;
      const existingTR = parsePickupTrackingNumber(stop.tracking_number);
      if (existingTR !== null && existingTR >= 0) {
        storePickupTRMap[mapKey] = existingTR;
        pickupTrackingPool.push({ tracking_number: String(existingTR).padStart(2, '0') });
        continue;
      }
      if (storePickupTRMap[mapKey] !== undefined) {
        stop.tracking_number = String(storePickupTRMap[mapKey]).padStart(2, '0');
        continue;
      }
      const nextPickupTR = getNextPickupTrackingNumber(pickupTrackingPool);
      stop.tracking_number = nextPickupTR;
      storePickupTRMap[mapKey] = parsePickupTrackingNumber(nextPickupTR);
      pickupTrackingPool.push({ tracking_number: nextPickupTR });
    }

    const newDeliveryCountsBySlot = {};

    for (const stop of optimizedRoute) {
      if (!stop || !stop.isNew || stop.patient_id === null) continue;

      const mapKey = `${stop.store_id}-${stop.ampm_deliveries || 'AM'}`;
      const pickupBaseTR = storePickupTRMap[mapKey];

      if (pickupBaseTR !== undefined) {
        const newCount = newDeliveryCountsBySlot[mapKey] || 0;
        stop.tracking_number = String(pickupBaseTR + newCount + 1).padStart(2, '0');
        newDeliveryCountsBySlot[mapKey] = newCount + 1;
      } else {
        stop.tracking_number = '99';
        console.warn(`[AddToRoute]     No pickup found for delivery (${mapKey}), using TR#99`);
      }
    }

    const deliveriesToCreate = [];
    const deliveriesToUpdate = [];

    for (let i = 0; i < optimizedRoute.length; i++) {
      const stop = optimizedRoute[i];
      if (!stop) continue; // Defensive check

      const stopPatient = patients.find((p) => p && p.id === stop.patient_id);
      const stopStore = stores.find((s) => s && s.id === stop.store_id);

      if (!stop.stop_id) {
        stop.stop_id = generateUniqueSID(allDeliveriesForDate);
      }

      // CRITICAL: Generate delivery_id for new stops
      const deliveryId = stop.delivery_id || (stop.is_cycling_marker ? `BIK-${Date.now()}-${Math.random().toString(36).substr(2, 9)}` : `DID-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
      const dispatcherId = stop.dispatcher_id || currentUser?.id || null;
      const createdByAppUserId = stop.created_by_app_user_id || currentAppUserId || null;

      const payload = {
        delivery_id: deliveryId,
        dispatcher_id: dispatcherId,
        created_by_app_user_id: createdByAppUserId,
        patient_id: stop.patient_id || null,
        store_id: stop.store_id,
        driver_id: driverId === 'unassigned' ? null : driverId,
        driver_name: driver ? (driver.user_name || driver.full_name) : '',
        delivery_date: stop.delivery_date,
        delivery_time_start: stop.delivery_time_start,
        delivery_time_end: stop.delivery_time_end,
        delivery_time_eta: stop.estimated_arrival || stop.delivery_time_start,
        time_window_start: stop.time_window_start || stop.delivery_time_start,
        time_window_end: stop.time_window_end || stop.delivery_time_end,
        status: stop.patient_id ? stop.status : (stop.status || 'en_route'),
        stop_id: stop.stop_id,
        puid: stop.patient_id ? (stop.puid || null) : stop.stop_id,
        stop_order: stop.isNew ? (stop.stop_order ?? null) : stop.stop_order,
        tracking_number: stop.tracking_number,
        delivery_notes: stop.delivery_notes || '',
        patient_name: stop.patient_id ? stop.patient_name || stopPatient?.full_name || '' : '',
        patient_phone: stop.patient_id ? stop.patient_phone || stopPatient?.phone || '' : '',
        store_phone: stop.store_phone || stopStore?.phone || '',
        cod_payments: stop.cod_payments || null,
        cod_total_amount_required: stop.cod_total_amount_required || 0,
        barcode_values: Array.isArray(stop.barcode_values) ? stop.barcode_values : [], receipt_barcode_values: Array.isArray(stop.receipt_barcode_values) ? stop.receipt_barcode_values : [],
        ampm_deliveries: stop.ampm_deliveries,
        finished_leg_transport_mode: stop.finished_leg_transport_mode || 'driving',
        prescription_number: stop.prescription_number || '',
        delivery_instructions: stop.delivery_instructions || '',
        unit_number: stop.unit_number || '',
        mailbox_ok: stop.mailbox_ok || false,
        call_upon_arrival: stop.call_upon_arrival || false,
        ring_bell: stop.ring_bell || false,
        dont_ring_bell: stop.dont_ring_bell || false,
        back_door: stop.back_door || false,
        signature_needed: stop.signature_needed || false,
        fridge_item: stop.fridge_item || false,
        oversized: stop.oversized || false,
        extra_time: stop.extra_time || 5,
        first_delivery: stop.first_delivery || false
      };

      if (stop.isNew) {
        deliveriesToCreate.push(payload);
      } else if (stop._wasEdited) {
        const { stop_order, ...payloadWithoutStopOrder } = payload;
        deliveriesToUpdate.push({ id: stop.id, updates: payloadWithoutStopOrder });
      }
    }

    const newEnsuredPickupsToCreate = ensuredPickupRecords.filter((pickup) => {
      if (!pickup || pickup.patient_id) return false;
      return !pickup.id;
    });

    const deliveriesToCreateFiltered = deliveriesToCreate.filter((delivery) => {
      if (delivery?.patient_id) return true;
      return !delivery?.id;
    });

    const combinedCreates = [...newEnsuredPickupsToCreate, ...deliveriesToCreateFiltered];
    console.log('[AddToRoute] handleBatchSaveDelivery:combinedCreates', combinedCreates.map((delivery) => ({
      patient_id: delivery?.patient_id || null,
      store_id: delivery?.store_id || null,
      driver_id: delivery?.driver_id || null,
      status: delivery?.status || null,
      puid: delivery?.puid || null,
      tracking_number: delivery?.tracking_number || null
    })));
    const createdDeliveries = combinedCreates.length > 0 ? await batchCreateDeliveriesLocal(combinedCreates) : [];
    console.log('[AddToRoute] handleBatchSaveDelivery:createdDeliveries', createdDeliveries.map((delivery) => ({
      id: delivery?.id || null,
      patient_id: delivery?.patient_id || null,
      store_id: delivery?.store_id || null,
      driver_id: delivery?.driver_id || null,
      status: delivery?.status || null,
      puid: delivery?.puid || null,
      tracking_number: delivery?.tracking_number || null
    })));

    createdDeliveries.forEach((delivery) => {
      if (!delivery?.patient_id && delivery?.store_id && delivery?.delivery_date) {
        createdDeliveryMap.set(`pickup__${delivery.store_id}__${delivery.delivery_date}__${delivery.driver_id || ''}__${delivery.ampm_deliveries || ''}`, delivery);
      }
      if (delivery?.patient_id) {
        createdDeliveryMap.set(`patient__${delivery.patient_id}__${delivery.delivery_date}__${delivery.driver_id || ''}`, delivery);
      }
    });

    createdPickupRecords.push(...createdDeliveries.filter((delivery) => !delivery?.patient_id));
    allCreatedDeliveries.push(...createdDeliveries.filter((delivery) => !!delivery?.patient_id));

    if (deliveriesToUpdate.length > 0) {
      for (const { id, updates } of deliveriesToUpdate) {
        if (!id || !updates) continue;
        const updated = await updateDeliveryLocal(id, updates);
        if (updated) allUpdatedDeliveries.push(updated);
      }
    }


  }

  invalidate('Delivery');

  const batchDeliveryDate = stagedDeliveries[0]?.delivery_date || format(selectedDate, 'yyyy-MM-dd');
  const batchDriverId = stagedDeliveries[0]?.driver_id;
  
  // Use the locally created/updated deliveries to update UI immediately
  const resolvedEnsuredPickups = (ensuredPickupRecords || []).map((delivery) => {
    const resolved = createdDeliveryMap.get(`pickup__${delivery?.store_id}__${delivery?.delivery_date}__${delivery?.driver_id || ''}__${delivery?.ampm_deliveries || ''}`);
    const merged = resolved || delivery;
    return !merged?.patient_id && merged?.stop_id ? { ...merged, puid: merged.puid || merged.stop_id } : merged;
  });

  const allProcessedDeliveries = Array.from(new Map([...allCreatedDeliveries, ...createdPickupRecords, ...resolvedEnsuredPickups, ...allUpdatedDeliveries].filter(Boolean).map((delivery) => [delivery.id, delivery])).values());
  console.log('[AddToRoute] handleBatchSaveDelivery:allProcessedDeliveries', allProcessedDeliveries.map((delivery) => ({
    id: delivery?.id || null,
    patient_id: delivery?.patient_id || null,
    store_id: delivery?.store_id || null,
    driver_id: delivery?.driver_id || null,
    status: delivery?.status || null,
    puid: delivery?.puid || null,
    tracking_number: delivery?.tracking_number || null
  })));
  
  if (updateDeliveriesLocally && allProcessedDeliveries.length > 0) {
    updateDeliveriesLocally(allProcessedDeliveries, false); // Merge instead of replace
  }

  // suppressOptimization=true: new pending stops from the "Add to Route" form must NOT
  // trigger ETA recalculation or re-optimization. Optimization only runs when the
  // dispatcher/driver explicitly clicks "Assign All", "Accept All", or the manual re-optimize FAB.
  window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
    detail: { immediate: true, freshDeliveries: allProcessedDeliveries, deliveryDate: batchDeliveryDate, driverId: batchDriverId, triggeredBy: 'batchSaveImmediate', suppressOptimization: true }
  }));
  window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
  setShowDeliveryForm(false);
  setEditingDelivery(null);
  hasAutoSelectedRef.current = false;

  setTimeout(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await refreshData();
  }, 0);
};