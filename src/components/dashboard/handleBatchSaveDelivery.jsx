import { format } from 'date-fns';
import { generateUniqueSID, addMinutesToTime } from "@/components/dashboard/DashboardHelpers";
import { batchCreateDeliveriesLocal, updateDeliveryLocal } from "@/components/utils/entityMutations";
import { base44 } from "@/api/base44Client";
import { determineAMPMFromTime } from '@/components/utils/ampmUtils';

const getCurrentAppUserId = async () => {
  const me = await base44.auth.me();
  if (!me?.id) return null;
  const appUsers = await base44.entities.AppUser.filter({ user_id: me.id }, '-updated_date', 1);
  return appUsers?.[0]?.id || null;
};

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
  const allCreatedDeliveries = [];
  const allUpdatedDeliveries = [];
  const createdPickupRecords = [];
  const createdDeliveryMap = new Map();
  const currentAppUserId = await getCurrentAppUserId();

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
      stopsToProcess.push({
        isNew: true,
        ...newDelivery,
        status: newDelivery.status || 'pending', // Use delivered status or fallback to 'pending'
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
      stop.ampm_deliveries = resolvedAmpm;
      const correspondingPickup = stopsToProcess.find((p) =>
      p && !p.patient_id && p.store_id === stop.store_id &&
      p.ampm_deliveries === resolvedAmpm && p.stop_id
      );
      if (correspondingPickup) {
        stop.puid = correspondingPickup.stop_id;
      } else {
        const fallbackPickup = stopsToProcess.find((p) =>
        p && !p.patient_id && p.store_id === stop.store_id && p.stop_id
        );
        if (fallbackPickup) {
          stop.puid = fallbackPickup.stop_id;
          stop.ampm_deliveries = fallbackPickup.ampm_deliveries || resolvedAmpm;
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
        } else if (correspondingPickup && correspondingPickup.delivery_time_start) {
          stop.delivery_time_start = addMinutesToTime(correspondingPickup.delivery_time_start, 5);
        } else {
          stop.delivery_time_start = stop.delivery_time_start || '10:00';
        }

        // CRITICAL: Only set delivery_time_end for NEW deliveries or if patient has explicit time window
        if (stopPatient?.time_window_end) {
          stop.delivery_time_end = stopPatient.time_window_end;
        }
        // DISABLED: No longer auto-assign 9:00 PM default - leave blank if patient has no time window
      }
    }

    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const completedStops = stopsToProcess.filter((s) => s && finishedStatuses.includes(s.status));
    const incompleteStops = stopsToProcess.filter((s) => s && !finishedStatuses.includes(s.status));

    // Sort completed by actual time
    completedStops.sort((a, b) => {
      if (!a || !b) return 0;
      if (!a.actual_delivery_time || !b.actual_delivery_time) return 0;
      return new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time);
    });

    // CRITICAL: Sort incomplete stops - pending deliveries ALWAYS LAST
    incompleteStops.sort((a, b) => {
      if (!a || !b) return 0;

      const isAPickup = !a.patient_id;
      const isBPickup = !b.patient_id;
      const isAPending = a.status === 'pending';
      const isBPending = b.status === 'pending';

      // CRITICAL: Pending deliveries ALWAYS go last
      if (isAPending && !isBPending) return 1;
      if (!isAPending && isBPending) return -1;

      // For non-pending stops, sort by time
      const timeA = a.delivery_time_start || a.delivery_time_eta || '99:99';
      const timeB = b.delivery_time_start || b.delivery_time_eta || '99:99';

      if (timeA !== timeB) {
        return timeA.localeCompare(timeB);
      }

      // CRITICAL: Same time - pickups before deliveries from same store
      if (a.store_id === b.store_id) {
        if (isAPickup && !isBPickup) return -1;
        if (!isAPickup && isBPickup) return 1;

        // If both are deliveries from same store, sort by distance
        if (!isAPickup && !isBPickup) {
          const storeForSort = stores.find((s) => s && s.id === a.store_id);
          if (storeForSort?.latitude && storeForSort?.longitude && a.latitude && a.longitude && b.latitude && b.longitude) {
            const distA = calculateDistance(storeForSort.latitude, storeForSort.longitude, a.latitude, a.longitude);
            const distB = calculateDistance(storeForSort.latitude, storeForSort.longitude, b.latitude, b.longitude);
            return distA - distB;
          }
        }
      }

      return 0;
    });

    const optimizedRoute = [...completedStops, ...incompleteStops];
    for (const stop of optimizedRoute) {
      if (!stop || stop.patient_id === null) continue;
      const stopPatient = patients.find((p) => p.id === stop.patient_id);
      const correspondingPickup = optimizedRoute.find((s) => s && s.store_id === stop.store_id && s.patient_id === null && s.ampm_deliveries === stop.ampm_deliveries);
      if (stopPatient?.time_window_start) {
        stop.delivery_time_start = stopPatient.time_window_start;
      } else if (correspondingPickup) {
        const p5 = addMinutesToTime(correspondingPickup.delivery_time_start, 5);
        const eta5 = correspondingPickup.estimated_arrival ? addMinutesToTime(correspondingPickup.estimated_arrival, 5) : null;
        if (eta5 && eta5 > p5) stop.delivery_time_start = eta5;else
        if (p5) stop.delivery_time_start = p5;
      }
      if (stopPatient?.time_window_end) stop.delivery_time_end = stopPatient.time_window_end;
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

    let pickupTRCounter = 0;
    const storePickupTRMap = {};

    // First pass: Assign TR# to pickups (existing and new)
    for (const stop of optimizedRoute) {
      if (!stop) continue;

      if (stop.patient_id === null) {
        const mapKey = `${stop.store_id}-${stop.ampm_deliveries}`;
        // If pickup already has TR# (existing), preserve it
        if (stop.tracking_number && !stop.isNew) {
          const existingTR = parseInt(stop.tracking_number, 10);
          if (!isNaN(existingTR)) {
            storePickupTRMap[mapKey] = existingTR;
            continue;
          }
        }

        // Assign new TR# for new pickups
        const trNumber = String(pickupTRCounter).padStart(2, '0');
        stop.tracking_number = trNumber;
        storePickupTRMap[mapKey] = pickupTRCounter;
        pickupTRCounter += 20;
      }
    }

    // Second pass: Assign TR# to deliveries (both active and pending)
    for (const stop of optimizedRoute) {
      if (!stop) continue;

      if (stop.patient_id !== null) {
        const mapKey = `${stop.store_id}-${stop.ampm_deliveries}`;
        const pickupBaseTR = storePickupTRMap[mapKey];

        if (pickupBaseTR !== undefined) {
          // Count deliveries from this store and same AM/PM slot that come before this one
          const deliveriesBeforeThis = optimizedRoute.filter((s) => {
            if (!s) return false;
            return s.patient_id !== null &&
            s.store_id === stop.store_id &&
            s.ampm_deliveries === stop.ampm_deliveries &&
            optimizedRoute.indexOf(s) < optimizedRoute.indexOf(stop);
          }).length;

          const trNumber = String(pickupBaseTR + deliveriesBeforeThis + 1).padStart(2, '0');
          stop.tracking_number = trNumber;

          const patient = patients.find((p) => p.id === stop.patient_id);
        } else {
          stop.tracking_number = '99';
          console.warn(`[AddToRoute]     No pickup found for delivery (${mapKey}), using TR#99`);
        }
      }
    }

    const deliveriesToCreate = [];
    const deliveriesToUpdate = [];

    for (let i = 0; i < optimizedRoute.length; i++) {
      const stop = optimizedRoute[i];
      if (!stop) continue; // Defensive check

      const stopPatient = patients.find((p) => p && p.id === stop.patient_id);
      const stopStore = stores.find((s) => s && s.id === stop.store_id);

      stop.stop_order = i + 1;

      if (!stop.stop_id) {
        stop.stop_id = generateUniqueSID(allDeliveriesForDate);
      }

      // CRITICAL: Generate delivery_id for new stops
      const deliveryId = stop.delivery_id || `DID-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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
        status: stop.patient_id ? stop.status : 'en_route',
        stop_id: stop.stop_id,
        puid: stop.puid || null,
        stop_order: stop.stop_order,
        tracking_number: stop.tracking_number,
        delivery_notes: stop.delivery_notes || '',
        patient_name: stop.patient_id ? stop.patient_name || stopPatient?.full_name || '' : '',
        patient_phone: stop.patient_id ? stop.patient_phone || stopPatient?.phone || '' : '',
        store_phone: stop.store_phone || stopStore?.phone || '',
        cod_payments: stop.cod_payments || null,
        cod_total_amount_required: stop.cod_total_amount_required || 0,
        barcode_values: Array.isArray(stop.barcode_values) ? stop.barcode_values : [], receipt_barcode_values: Array.isArray(stop.receipt_barcode_values) ? stop.receipt_barcode_values : [],
        ampm_deliveries: stop.ampm_deliveries, prescription_number: stop.prescription_number || '',
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
      } else {
        deliveriesToUpdate.push({ id: stop.id, updates: stop._wasEdited ? payload : { stop_id: payload.stop_id, puid: payload.puid, stop_order: payload.stop_order, tracking_number: payload.tracking_number, delivery_time_start: payload.delivery_time_start, delivery_time_end: payload.delivery_time_end, delivery_time_eta: payload.delivery_time_eta, time_window_start: payload.time_window_start, time_window_end: payload.time_window_end, ampm_deliveries: payload.ampm_deliveries, status: payload.status } });
      }
    }

    const createdPickupDeliveries = [];
    const createdDeliveries = deliveriesToCreate.length > 0 ? await batchCreateDeliveriesLocal(deliveriesToCreate) : [];

    createdPickupDeliveries.forEach((delivery) => {
      if (delivery?.store_id && delivery?.delivery_date && delivery?.ampm_deliveries) {
        createdDeliveryMap.set(`pickup__${delivery.store_id}__${delivery.delivery_date}__${delivery.driver_id || ''}__${delivery.ampm_deliveries || ''}`, delivery);
      }
    });
    createdDeliveries.forEach((delivery) => {
      if (delivery?.patient_id) {
        createdDeliveryMap.set(`patient__${delivery.patient_id}__${delivery.delivery_date}__${delivery.driver_id || ''}`, delivery);
      }
    });

    createdPickupRecords.push(...createdPickupDeliveries);
    allCreatedDeliveries.push(...createdDeliveries);

    if (deliveriesToUpdate.length > 0) {
      for (const { id, updates } of deliveriesToUpdate) {
        if (!id || !updates) continue;
        const updated = await updateDeliveryLocal(id, updates);
        if (updated) allUpdatedDeliveries.push(updated);
      }
    }

    // NOTE: Route optimizer is NOT run here - deliveries are saved as 'pending'.
    // Optimization runs when stops are transitioned to 'in_transit' status.
  }

  invalidate('Delivery');

  const batchDeliveryDate = stagedDeliveries[0]?.delivery_date || format(selectedDate, 'yyyy-MM-dd');
  const batchDriverId = stagedDeliveries[0]?.driver_id;
  
  // Use the locally created/updated deliveries to update UI immediately
  const resolvedEnsuredPickups = (ensuredPickupRecords || []).map((delivery) => {
    const resolved = createdDeliveryMap.get(`pickup__${delivery?.store_id}__${delivery?.delivery_date}__${delivery?.driver_id || ''}__${delivery?.ampm_deliveries || ''}`);
    return resolved || delivery;
  });

  const allProcessedDeliveries = Array.from(new Map([...allCreatedDeliveries, ...createdPickupRecords, ...resolvedEnsuredPickups, ...allUpdatedDeliveries].filter(Boolean).map((delivery) => [delivery.id, delivery])).values());
  
  if (updateDeliveriesLocally && allProcessedDeliveries.length > 0) {
    updateDeliveriesLocally(allProcessedDeliveries, false); // Merge instead of replace
  }

  window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
    detail: { immediate: true, freshDeliveries: allProcessedDeliveries, deliveryDate: batchDeliveryDate, driverId: batchDriverId, triggeredBy: 'batchSaveImmediate' }
  }));
  window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
  setShowDeliveryForm(false);
  setEditingDelivery(null);
  hasAutoSelectedRef.current = false;

  setTimeout(async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await refreshData();

      if (batchDriverId) {
        const allDriverDeliveries = await base44.entities.Delivery.filter({
          driver_id: batchDriverId,
          delivery_date: batchDeliveryDate
        });

        const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
        const allActive = allDriverDeliveries.every((d) =>
        d && (d.status === 'in_transit' || d.status === 'en_route' || finishedStatuses.includes(d.status))
        );
        const hasIncompleteStops = allDriverDeliveries.some((d) =>
        d && d.status !== 'pending' && !finishedStatuses.includes(d.status)
        );

        if (allActive && hasIncompleteStops) {
          const now = new Date();
          const localTimeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
          await base44.functions.invoke('optimizeRouteRealTime', {
            driverId: batchDriverId,
            deliveryDate: batchDeliveryDate,
            currentLocalTime: localTimeString,
            deviceTime: now.toISOString(),
            generatePolyline: true
          });
          if (invalidateDeliveriesForDate) invalidateDeliveriesForDate(batchDeliveryDate);
          await refreshData();
        }
      }
    } catch (optimizeError) {
      console.warn('⚠️ [AddToRoute] Route optimization failed:', optimizeError.message);
    }
  }, 0);
};