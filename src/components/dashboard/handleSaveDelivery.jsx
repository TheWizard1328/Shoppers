/**
 * Extracted handleSaveDelivery logic from Dashboard.jsx
 * Called as: await handleSaveDelivery(deliveryData, context)
 */
import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';
import { determineAMPMFromTime } from '@/components/utils/ampmUtils';
import { saveDriverChangedDelivery } from '@/components/utils/saveDriverChangedDelivery';
import { fabControlEvents } from '@/components/utils/fabControlEvents';
import { invalidate } from '@/components/utils/dataManager';
import { updateDeliveryLocal } from '@/components/utils/offlineMutations';
import { pauseOfflineSync, resumeOfflineSync } from '@/components/utils/offlineSync';
import { addMinutesToTime, generateUniqueSID, populateTemporaryStartTimes } from '@/components/dashboard/DashboardHelpers';
import { optimizeRoute } from '@/components/utils/routeOptimizer';

function addMinutes(time, mins) {
  return addMinutesToTime(time, mins);
}

export async function handleSaveDelivery(deliveryData, ctx) {
  const {
    editingDelivery, drivers, deliveries, patients, stores, currentUser, selectedDate,
    updateDeliveriesLocally, applyDeliveryChangesLocally, refreshData, setShowDeliveryForm, setEditingDelivery,
    hasAutoSelectedRef, setIsEntityUpdating, smartRefreshManager,
    handleDualDriverOptimization,
  } = ctx;

  setIsEntityUpdating(true);
  pauseOfflineSync();
  smartRefreshManager.pause();
  await new Promise((resolve) => setTimeout(resolve, 100));

  try {
    if (deliveryData._isBatchSave && deliveryData._stagedDeliveries) {
      const { handleBatchSaveDelivery } = await import('@/components/dashboard/handleBatchSaveDelivery');
      await handleBatchSaveDelivery({
        deliveryData, drivers, deliveries, patients, stores, currentUser, selectedDate,
        invalidate, updateDeliveriesLocally, refreshData,
        setShowDeliveryForm, setEditingDelivery, hasAutoSelectedRef,
        invalidateDeliveriesForDate: () => invalidate('Delivery'),
      });
      return;
    }

    const isEditing = !!editingDelivery;
    const deliveryDate = deliveryData.delivery_date;
    const driverId = deliveryData.driver_id;
    const originalDriverId = deliveryData._originalDriverId;
    const driverWasChanged = deliveryData._driverWasChanged;
    const isPickup = !deliveryData.patient_id;

    const driver = drivers.find((d) => d && d.id === driverId);
    if (!driver) throw new Error('Driver not found');

    const isDriverAssignedToSlot = (store, slotPrefix) => {
      if (!store[`${slotPrefix}_enabled`]) return false;
      const idField = `${slotPrefix}_driver_id`;
      const nameField = `${slotPrefix}_driver`;
      if (store[idField] && driver.id) return store[idField] === driver.id;
      if (store[nameField] && driver.user_name)
        return store[nameField].toLowerCase().trim() === driver.user_name.toLowerCase().trim();
      return false;
    };

    if (isEditing && driverWasChanged) {
      await saveDriverChangedDelivery({ base44, deliveries, editingDelivery, deliveryData, deliveryDate, driverId, driver, originalDriverId });
      invalidate('Delivery');
      await handleDualDriverOptimization(originalDriverId, driverId, deliveryDate);
      await refreshData();
      setShowDeliveryForm(false); setEditingDelivery(null); hasAutoSelectedRef.current = false;
      fabControlEvents.resetToPhaseOneAfterDone(500);
      return;
    }

    if (isEditing && !driverWasChanged) {
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

      // Step 1: Apply the edit to the delivery being changed
      await updateDeliveryLocal(editingDelivery.id, deliveryData);

      // Step 2: Optimistically update the UI immediately using current in-memory state
      // so stops don't disappear while we do background work
      if (applyDeliveryChangesLocally) {
        applyDeliveryChangesLocally({ upserts: [{ ...editingDelivery, ...deliveryData }] });
      } else if (updateDeliveriesLocally) {
        updateDeliveriesLocally([{ ...editingDelivery, ...deliveryData }], false);
      }

      // Step 3: Reorder stop_orders in the background (non-blocking for UI)
      const allForDriver = (deliveries || []).filter((d) => d && d.delivery_date === deliveryDate && d.driver_id === driverId);
      const completedDeliveries = allForDriver.filter((d) => finishedStatuses.includes(d.status));
      const incompleteDeliveries = allForDriver.filter((d) => !finishedStatuses.includes(d.status));
      let startingStopOrder = completedDeliveries.length > 0 ? Math.max(...completedDeliveries.map((d) => d.stop_order || 0)) : 0;
      const sortedIncomplete = [...incompleteDeliveries].sort((a, b) => {
        if (!a || !b) return 0;
        if (a.status === 'pending' && b.status !== 'pending') return 1;
        if (a.status !== 'pending' && b.status === 'pending') return -1;
        return (a.delivery_time_eta || a.delivery_time_start || '99:99').localeCompare(b.delivery_time_eta || b.delivery_time_start || '99:99');
      });
      for (let i = 0; i < sortedIncomplete.length; i++) {
        if (sortedIncomplete[i]) await updateDeliveryLocal(sortedIncomplete[i].id, { stop_order: startingStopOrder + i + 1 });
      }

      invalidate('Delivery');
      setShowDeliveryForm(false); setEditingDelivery(null); fabControlEvents.resetToPhaseOneAfterDone(500);
      return;
    }

    const allDeliveriesForDate = (deliveries || []).filter((d) => d && d.delivery_date === deliveryDate);
    const driverDeliveriesForDate = allDeliveriesForDate.filter((d) => d && d.driver_id === driverId);
    const dateObj = new Date(deliveryDate + 'T00:00:00');
    const dayOfWeek = dateObj.getDay();
    const isSaturday = dayOfWeek === 6;
    const isSunday = dayOfWeek === 0;
    const assignedStores = (stores || []).filter((store) => {
      if (!store) return false;
      if (isSaturday) return isDriverAssignedToSlot(store, 'saturday_am') || isDriverAssignedToSlot(store, 'saturday_pm');
      if (isSunday) return isDriverAssignedToSlot(store, 'sunday_am') || isDriverAssignedToSlot(store, 'sunday_pm');
      return isDriverAssignedToSlot(store, 'weekday_am') || isDriverAssignedToSlot(store, 'weekday_pm');
    });

    const stopsToProcess = [];
    for (const existingDelivery of driverDeliveriesForDate) {
      if (!existingDelivery) continue;
      const enriched = { ...existingDelivery, isNew: false };
      if (existingDelivery.patient_id) {
        const ep = patients.find((p) => p && p.id === existingDelivery.patient_id);
        if (ep?.latitude && ep?.longitude) { enriched.latitude = ep.latitude; enriched.longitude = ep.longitude; }
        enriched.call_upon_arrival = existingDelivery.call_upon_arrival ?? ep?.call_upon_arrival;
        enriched.ring_bell = existingDelivery.ring_bell ?? ep?.ring_bell;
        enriched.dont_ring_bell = existingDelivery.dont_ring_bell ?? ep?.dont_ring_bell;
        enriched.mailbox_ok = existingDelivery.mailbox_ok ?? ep?.mailbox_ok;
      } else {
        const es = stores.find((s) => s && s.id === existingDelivery.store_id);
        if (es?.latitude && es?.longitude) { enriched.latitude = es.latitude; enriched.longitude = es.longitude; }
      }
      stopsToProcess.push(enriched);
    }

    const isFirstStop = driverDeliveriesForDate.length === 0;
    const deliveryStore = stores.find((s) => s.id === deliveryData.store_id);
    const isInterStore = deliveryData.patient_name?.toLowerCase().includes('interstore') || deliveryData.delivery_notes?.toLowerCase().includes('interstore');
    const specialStoreNames = ['Lakeland Ridge', 'Sherwood Pk Mall', 'SouthPoint', 'WestPark'];
    const isSpecialStore = deliveryStore && specialStoreNames.includes(deliveryStore.name);
    const storesToCheck = isInterStore ? [] : isSpecialStore ? (deliveryStore ? [deliveryStore] : []) : isFirstStop ? assignedStores : (deliveryStore ? [deliveryStore] : []);

    for (const store of storesToCheck) {
      const isAM = isSaturday ? isDriverAssignedToSlot(store, 'saturday_am') : isSunday ? isDriverAssignedToSlot(store, 'sunday_am') : isDriverAssignedToSlot(store, 'weekday_am');
      const isPM = isSaturday ? isDriverAssignedToSlot(store, 'saturday_pm') : isSunday ? isDriverAssignedToSlot(store, 'sunday_pm') : isDriverAssignedToSlot(store, 'weekday_pm');
      if (isAM && !stopsToProcess.find((d) => d && d.store_id === store.id && !d.patient_id && d.ampm_deliveries === 'AM')) {
        const t = isSaturday ? store.saturday_am_start : isSunday ? store.sunday_am_start : store.weekday_am_start;
        const te = isSaturday ? store.saturday_am_end : isSunday ? store.sunday_am_end : store.weekday_am_end;
        stopsToProcess.push({ isNew: true, patient_id: null, store_id: store.id, driver_id: driverId, driver_name: driver.user_name || driver.full_name, delivery_date: deliveryDate, delivery_time_start: t || '09:00', delivery_time_end: te || '12:00', ampm_deliveries: 'AM', status: 'en_route', delivery_notes: `Store Pickup for ${store.name}`, latitude: store.latitude, longitude: store.longitude, patient_name: '', patient_phone: '', store_phone: store.phone || '', extra_time: 15 });
      }
      if (isPM && !stopsToProcess.find((d) => d && d.store_id === store.id && !d.patient_id && d.ampm_deliveries === 'PM')) {
        const t = isSaturday ? store.saturday_pm_start : isSunday ? store.sunday_pm_start : store.weekday_pm_start;
        const te = isSaturday ? store.saturday_pm_end : isSunday ? store.sunday_pm_end : store.weekday_pm_end;
        stopsToProcess.push({ isNew: true, patient_id: null, store_id: store.id, driver_id: driverId, driver_name: driver.user_name || driver.full_name, delivery_date: deliveryDate, delivery_time_start: t || '13:00', delivery_time_end: te || '17:00', ampm_deliveries: 'PM', status: 'en_route', delivery_notes: `Store Pickup for ${store.name}`, latitude: store.latitude, longitude: store.longitude, patient_name: '', patient_phone: '', store_phone: store.phone || '', extra_time: 15 });
      }
    }

    if (!isPickup) {
      const patient = patients.find((p) => p.id === deliveryData.patient_id);
      if (!patient) throw new Error('Patient not found');
      if (!deliveryStore) throw new Error('Store not found for patient');
      stopsToProcess.push({ isNew: true, ...deliveryData, status: 'en_route', latitude: patient.latitude, longitude: patient.longitude, extra_time: deliveryData.extra_time || 5 });
    } else {
      const pickupStore = stores.find((s) => s.id === deliveryData.store_id);
      if (!pickupStore) throw new Error('Store not found for pickup');
      stopsToProcess.push({ isNew: true, ...deliveryData, patient_id: null, status: 'en_route', delivery_notes: deliveryData.delivery_notes || `Store Pickup for ${pickupStore.name}`, latitude: pickupStore.latitude, longitude: pickupStore.longitude, extra_time: deliveryData.extra_time || 15 });
    }

    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const applyTimes = (list) => {
      for (const stop of list) {
        if (!stop || stop.patient_id === null) continue;
        const sp = patients.find((p) => p.id === stop.patient_id);
        if (sp?.time_window_start) { stop.delivery_time_start = sp.time_window_start; }
        else {
          const cp = list.find((s) => s && !s.patient_id && s.store_id === stop.store_id && !(s.ampm_deliveries && stop.ampm_deliveries && s.ampm_deliveries !== stop.ampm_deliveries) && !finishedStatuses.includes(s.status));
          if (cp?.delivery_time_start) stop.delivery_time_start = addMinutes(cp.delivery_time_start, 5);
          else stop.delivery_time_start = stop.delivery_time_start || '10:00';
        }
        if (sp?.time_window_end) stop.delivery_time_end = sp.time_window_end;
      }
    };
    applyTimes(stopsToProcess);

    const optimizedRoute = [...stopsToProcess].sort((a, b) => {
      if (!a || !b) return 0;
      const af = finishedStatuses.includes(a.status), bf = finishedStatuses.includes(b.status);
      if (af && !bf) return -1; if (!af && bf) return 1;
      if (af && bf && a.stop_order && b.stop_order) return a.stop_order - b.stop_order;
      return (a.delivery_time_start || '99:99').localeCompare(b.delivery_time_start || '99:99');
    });
    applyTimes(optimizedRoute);

    const storeAMPMMap = {};
    for (const stop of optimizedRoute) {
      if (stop && !stop.patient_id && stop.delivery_time_start) storeAMPMMap[stop.store_id] = determineAMPMFromTime(stop.delivery_time_start);
    }
    for (const stop of optimizedRoute) {
      if (stop) stop.ampm_deliveries = storeAMPMMap[stop.store_id] || determineAMPMFromTime(stop.delivery_time_start);
    }

    let pickupTRCounter = 0;
    const storePickupTRMap = {};
    for (const stop of optimizedRoute) {
      if (!stop || stop.patient_id !== null) continue;
      stop.tracking_number = String(pickupTRCounter).padStart(2, '0');
      storePickupTRMap[stop.store_id] = pickupTRCounter;
      pickupTRCounter += 20;
    }
    for (const stop of optimizedRoute) {
      if (!stop || stop.patient_id === null) continue;
      const base = storePickupTRMap[stop.store_id];
      if (base !== undefined) {
        const before = optimizedRoute.filter((s) => s && s.patient_id !== null && s.store_id === stop.store_id && optimizedRoute.indexOf(s) < optimizedRoute.indexOf(stop)).length;
        stop.tracking_number = String(base + before + 1).padStart(2, '0');
      } else { stop.tracking_number = '99'; }
    }

    for (let i = 0; i < optimizedRoute.length; i++) {
      const stop = optimizedRoute[i];
      if (!stop) continue;
      const stopPatient = patients.find((p) => p && p.id === stop.patient_id);
      const stopStore = stores.find((s) => s && s.id === stop.store_id);
      stop.stop_order = i + 1;
      if (!stop.stop_id) stop.stop_id = generateUniqueSID(allDeliveriesForDate);
      const deliveryId = stop.delivery_id || `DID-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const payload = {
        delivery_id: deliveryId, patient_id: stop.patient_id || null, store_id: stop.store_id,
        driver_id: driverId, driver_name: driver.user_name || driver.full_name, delivery_date: stop.delivery_date,
        delivery_time_start: stop.delivery_time_start, delivery_time_end: stop.delivery_time_end,
        delivery_time_eta: stop.estimated_arrival || stop.delivery_time_start,
        time_window_start: stop.time_window_start || stop.delivery_time_start,
        time_window_end: stop.time_window_end || stop.delivery_time_end,
        status: stop.status, stop_id: stop.stop_id, puid: stop.puid || null, stop_order: stop.stop_order,
        tracking_number: stop.tracking_number, delivery_notes: stop.delivery_notes || '',
        patient_name: stop.patient_id ? stopPatient?.full_name || '' : '',
        patient_phone: stop.patient_id ? stopPatient?.phone || '' : '',
        store_phone: stopStore?.phone || '', cod_payments: stop.cod_payments || null,
        cod_total_amount_required: stop.cod_total_amount_required || 0,
        barcode_values: Array.isArray(stop.barcode_values) ? stop.barcode_values : [],
        receipt_barcode_values: Array.isArray(stop.receipt_barcode_values) ? stop.receipt_barcode_values : [],
        ampm_deliveries: stop.ampm_deliveries, prescription_number: stop.prescription_number || '',
        delivery_instructions: stop.delivery_instructions || '', unit_number: stop.unit_number || '',
        mailbox_ok: stop.mailbox_ok || false, call_upon_arrival: stop.call_upon_arrival || false,
        ring_bell: stop.ring_bell || false, dont_ring_bell: stop.dont_ring_bell || false,
        back_door: stop.back_door || false, signature_needed: stop.signature_needed || false,
        fridge_item: stop.fridge_item || false, oversized: stop.oversized || false,
        extra_time: stop.extra_time || 5, first_delivery: stop.first_delivery || false,
      };
      if (stop.isNew) {
        await base44.entities.Delivery.create(payload);
      } else {
        const upd = { stop_id: payload.stop_id, puid: payload.puid, stop_order: payload.stop_order, delivery_time_start: payload.delivery_time_start, delivery_time_end: payload.delivery_time_end, delivery_time_eta: payload.delivery_time_eta, time_window_start: payload.time_window_start, time_window_end: payload.time_window_end, ampm_deliveries: payload.ampm_deliveries };
        if (!stop.tracking_number || stop.tracking_number === '' || stop.tracking_number === '99') upd.tracking_number = payload.tracking_number;
        await base44.entities.Delivery.update(stop.id, upd);
      }
    }

    if (driverId && deliveryDate) {
      const now = new Date();
      await base44.functions.invoke('optimizeRemainingStops', { driverId, deliveryDate, currentLocalTime: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`, deviceTime: now.toISOString() });
    }

    invalidate('Delivery');
    await refreshData();
    if (driverId && deliveryDate) window.dispatchEvent(new CustomEvent('routeReordered', { detail: { driverId, deliveryDate, source: 'handleSaveDelivery' } }));
    window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
    hasAutoSelectedRef.current = false;
    setShowDeliveryForm(false); setEditingDelivery(null); fabControlEvents.resetToPhaseOneAfterDone(500);

  } catch (error) {
    console.error('❌ Error saving delivery:', error);
    alert(`Failed to save delivery: ${error.message}`);
    throw error;
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    resumeOfflineSync();
    smartRefreshManager.resume();
    setIsEntityUpdating(false);
  }
}