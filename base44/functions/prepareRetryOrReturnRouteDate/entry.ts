import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

function generateShortStopId() {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let result = '';
  for (let i = 0; i < 3; i++) result += characters.charAt(Math.floor(Math.random() * characters.length));
  return result;
}

function parseTrackingNumber(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).match(/\d+/);
  if (!match) return null;
  const parsed = parseInt(match[0], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function isDriverAssignedToSlot(store, driverAppUser, slotPrefix) {
  const enabledField = `${slotPrefix}_enabled`;
  if (!store?.[enabledField]) return false;
  const idField = `${slotPrefix}_driver_id`;
  const legacyField = `${slotPrefix}_driver`;
  if (store?.[idField] && driverAppUser) {
    // Match against AppUser.id (new) OR user_id (legacy) for backward compatibility
    if (store[idField] === driverAppUser.id) return true;
    if (driverAppUser.user_id && store[idField] === driverAppUser.user_id) return true;
  }
  if (store?.[legacyField] && driverAppUser?.user_name) return String(store[legacyField]).trim().toLowerCase() === String(driverAppUser.user_name).trim().toLowerCase();
  return false;
}

function getAssignedSlotsForStore(store, driverAppUser, dayOfWeek) {
  const isSaturday = dayOfWeek === 6;
  const isSunday = dayOfWeek === 0;
  const slots = [];
  if (isSaturday) {
    if (isDriverAssignedToSlot(store, driverAppUser, 'saturday_am')) slots.push('AM');
    if (isDriverAssignedToSlot(store, driverAppUser, 'saturday_pm')) slots.push('PM');
    return slots;
  }
  if (isSunday) {
    if (isDriverAssignedToSlot(store, driverAppUser, 'sunday_am')) slots.push('AM');
    if (isDriverAssignedToSlot(store, driverAppUser, 'sunday_pm')) slots.push('PM');
    return slots;
  }
  if (isDriverAssignedToSlot(store, driverAppUser, 'weekday_am')) slots.push('AM');
  if (isDriverAssignedToSlot(store, driverAppUser, 'weekday_pm')) slots.push('PM');
  return slots;
}

function getSlotTimes(store, dayOfWeek, slot) {
  const fallback = slot === 'PM' ? { start: '13:00', end: '17:00' } : { start: '09:00', end: '12:00' };
  if (dayOfWeek === 6) {
    return {
      start: slot === 'PM' ? store?.saturday_pm_start || fallback.start : store?.saturday_am_start || fallback.start,
      end: slot === 'PM' ? store?.saturday_pm_end || fallback.end : store?.saturday_am_end || fallback.end,
    };
  }
  if (dayOfWeek === 0) {
    return {
      start: slot === 'PM' ? store?.sunday_pm_start || fallback.start : store?.sunday_am_start || fallback.start,
      end: slot === 'PM' ? store?.sunday_pm_end || fallback.end : store?.sunday_am_end || fallback.end,
    };
  }
  return {
    start: slot === 'PM' ? store?.weekday_pm_start || fallback.start : store?.weekday_am_start || fallback.start,
    end: slot === 'PM' ? store?.weekday_pm_end || fallback.end : store?.weekday_am_end || fallback.end,
  };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { driverId, deliveryDate, targetStoreId, ampmDeliveries, originalTrackingNumber } = body || {};
    if (!driverId || !deliveryDate || !targetStoreId) {
      return Response.json({ error: 'driverId, deliveryDate and targetStoreId are required' }, { status: 400 });
    }

    const todayDate = new Date().toISOString().slice(0, 10);
    const effectiveDate = todayDate > deliveryDate ? todayDate : deliveryDate;

    let dateDeliveries = await base44.asServiceRole.entities.Delivery.filter({ driver_id: driverId, delivery_date: effectiveDate }, 'stop_order', 50000);
    // Resolve AppUser: try AppUser.id first (new standard), fallback to user_id (legacy)
    let driverAppUser = (await base44.asServiceRole.entities.AppUser.filter({ id: driverId }, '-created_date', 1))?.[0] || null;
    if (!driverAppUser) {
      driverAppUser = (await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId }, '-created_date', 1))?.[0] || null;
    }
    // Resolve creator AppUser for created_by_app_user_id
    const creatorAppUser = (await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }, '-created_date', 1))?.[0] || null;
    const stores = await base44.asServiceRole.entities.Store.list(undefined, 50000);
    const targetStore = (stores || []).find((store) => store?.id === targetStoreId);
    const requestedSlot = ampmDeliveries === 'PM' ? 'PM' : 'AM';
    const dayOfWeek = new Date(`${effectiveDate}T00:00:00`).getDay();
    if ((dateDeliveries || []).filter((delivery) => !delivery?.patient_id).length === 0) {
      const assignedStores = (stores || [])
        .filter((store) => !!store)
        .sort((a, b) => (a.sort_order ?? 9999) - (b.sort_order ?? 9999));

      let pickupCounter = 0;
      for (const store of assignedStores) {
        const slots = getAssignedSlotsForStore(store, driverAppUser, dayOfWeek);
        for (const slot of slots) {
          const existingPickup = (dateDeliveries || []).find((delivery) => !delivery?.patient_id && delivery?.store_id === store.id && (delivery?.ampm_deliveries || 'AM') === slot);
          if (existingPickup) continue;
          const times = getSlotTimes(store, dayOfWeek, slot);
          const pickupTracking = `${store?.abbreviation || ''}${String(pickupCounter).padStart(2, '0')}`;
          const stopId = generateShortStopId();
          const createdPickup = await base44.asServiceRole.entities.Delivery.create({
            store_id: store.id,
            driver_id: driverAppUser?.id || driverId,
            driver_name: driverAppUser?.user_name || '',
            created_by_app_user_id: creatorAppUser?.id || '',
            delivery_date: effectiveDate,
            delivery_time_start: times.start,
            delivery_time_end: times.end,
            ampm_deliveries: slot,
            status: 'en_route',
            delivery_notes: `Store Pickup for ${store.name}`,
            stop_id: stopId,
            puid: stopId,
            tracking_number: pickupTracking,
            store_phone: store?.phone || '',
            extra_time: 15,
          });
          dateDeliveries.push(createdPickup);
          pickupCounter += 20;
        }
      }
    }

    let targetPickup = (dateDeliveries || []).find((delivery) => !delivery?.patient_id && delivery?.store_id === targetStoreId && (delivery?.ampm_deliveries || 'AM') === requestedSlot);
    if (!targetPickup) {
      const ensureResponse = await base44.asServiceRole.functions.invoke('ensurePickupForDelivery', {
        storeId: targetStoreId,
        deliveryDate: effectiveDate,
        driverId,
        ampmDeliveries: requestedSlot,
        allowCreateIfMissing: true,
      });
      const ensureData = ensureResponse?.data || ensureResponse || {};
      if (ensureData?.pickup) targetPickup = ensureData.pickup;
      if (!targetPickup && ensureData?.pickupId) {
        targetPickup = await base44.asServiceRole.entities.Delivery.get(ensureData.pickupId).catch((error) => {
          if (isNotFoundError(error)) return null;
          throw error;
        });
      }
      if (targetPickup) dateDeliveries.push(targetPickup);
    }

    if (!targetPickup?.stop_id) {
      return Response.json({ error: 'Could not prepare pickup for target store/date' }, { status: 400 });
    }

    const baseTracking = parseTrackingNumber(targetPickup.tracking_number) ?? parseTrackingNumber(originalTrackingNumber) ?? 0;
    const linkedTrackingNumbers = (dateDeliveries || [])
      .filter((delivery) => delivery?.patient_id && delivery?.puid === targetPickup.stop_id)
      .map((delivery) => parseTrackingNumber(delivery.tracking_number))
      .filter((value) => value !== null);
    const nextTrackingNumber = Math.max(baseTracking, ...(linkedTrackingNumbers.length ? linkedTrackingNumbers : [baseTracking])) + 1;

    const existingStopIds = new Set((dateDeliveries || []).map((delivery) => delivery?.stop_id).filter(Boolean));
    let nextStopId = generateShortStopId();
    while (existingStopIds.has(nextStopId)) nextStopId = generateShortStopId();

    return Response.json({
      success: true,
      deliveryDate: effectiveDate,
      ampmDeliveries: requestedSlot,
      puid: targetPickup.stop_id,
      pickupId: targetPickup.id,
      stopId: nextStopId,
      trackingNumber: String(nextTrackingNumber),
      pickupsCreated: (dateDeliveries || []).filter((delivery) => !delivery?.patient_id).length,
    });
  } catch (error) {
    console.error('[prepareRetryOrReturnRouteDate] Error:', error?.message || error);
    return Response.json({ error: error?.message || 'Internal error' }, { status: 500 });
  }
});