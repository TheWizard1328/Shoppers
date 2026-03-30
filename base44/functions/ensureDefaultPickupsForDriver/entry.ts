import { createClientFromRequest } from 'npm:@base44/sdk@0.8.21';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

const ACTIVE_DELIVERY_STATUSES = new Set(['pending', 'in_transit', 'en_route']);
const SPECIAL_STORE_NAMES = new Set(['Lakeland Ridge', 'Sherwood Pk Mall', 'WestPark', 'SouthPoint']);

function generateShortStopId() {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let result = '';
  for (let i = 0; i < 3; i += 1) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

function generateDeliveryId() {
  return `DID-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function getPrimarySlot(delivery) {
  if (delivery?.ampm_deliveries === 'AM' || delivery?.ampm_deliveries === 'PM') {
    return delivery.ampm_deliveries;
  }

  const timeValue = delivery?.delivery_time_start || delivery?.delivery_time_end || '';
  const hour = Number.parseInt(String(timeValue).split(':')[0], 10);
  if (Number.isFinite(hour)) {
    return hour >= 15 ? 'PM' : 'AM';
  }

  return 'AM';
}

function getAssignedSlotsForStore(store, deliveryDate, driverId) {
  const dayOfWeek = new Date(`${deliveryDate}T00:00:00`).getDay();
  const slots = [];

  if (dayOfWeek === 6) {
    if (store?.saturday_am_driver_id === driverId) slots.push('AM');
    if (store?.saturday_pm_driver_id === driverId) slots.push('PM');
    return slots;
  }

  if (dayOfWeek === 0) {
    if (store?.sunday_am_driver_id === driverId) slots.push('AM');
    if (store?.sunday_pm_driver_id === driverId) slots.push('PM');
    return slots;
  }

  if (store?.weekday_am_driver_id === driverId) slots.push('AM');
  if (store?.weekday_pm_driver_id === driverId) slots.push('PM');
  return slots;
}

function getDriverStoreFields(deliveryDate) {
  const dayOfWeek = new Date(`${deliveryDate}T00:00:00`).getDay();

  if (dayOfWeek === 6) {
    return { am: 'saturday_am_driver_id', pm: 'saturday_pm_driver_id' };
  }

  if (dayOfWeek === 0) {
    return { am: 'sunday_am_driver_id', pm: 'sunday_pm_driver_id' };
  }

  return { am: 'weekday_am_driver_id', pm: 'weekday_pm_driver_id' };
}

async function loadAssignedStores(base44, deliveryDate, driverId) {
  const fields = getDriverStoreFields(deliveryDate);
  const [amStores, pmStores] = await Promise.all([
    base44.asServiceRole.entities.Store.filter({ [fields.am]: driverId }, '-created_date', 100),
    base44.asServiceRole.entities.Store.filter({ [fields.pm]: driverId }, '-created_date', 100),
  ]);

  const deduped = new Map();
  [...(amStores || []), ...(pmStores || [])].forEach((store) => {
    if (store?.id) deduped.set(store.id, store);
  });

  return Array.from(deduped.values());
}

function getSlotTimes(store, deliveryDate, slot) {
  const dayOfWeek = new Date(`${deliveryDate}T00:00:00`).getDay();
  const safeTime = (value) => typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) ? value : null;

  if (dayOfWeek >= 1 && dayOfWeek <= 5) {
    return {
      start: safeTime(slot === 'AM' ? store?.weekday_am_start : store?.weekday_pm_start),
      end: safeTime(slot === 'AM' ? store?.weekday_am_end : store?.weekday_pm_end),
    };
  }

  if (dayOfWeek === 6) {
    return {
      start: safeTime(slot === 'AM' ? store?.saturday_am_start : store?.saturday_pm_start),
      end: safeTime(slot === 'AM' ? store?.saturday_am_end : store?.saturday_pm_end),
    };
  }

  return {
    start: safeTime(slot === 'AM' ? store?.sunday_am_start : store?.sunday_pm_start),
    end: safeTime(slot === 'AM' ? store?.sunday_am_end : store?.sunday_pm_end),
  };
}

function getFallbackTimes(slot) {
  return slot === 'PM'
    ? { start: '15:00', end: '16:00' }
    : { start: '10:00', end: '11:00' };
}

function findReusablePickup(pickups, targetSlot) {
  const sameSlot = (pickup) => (pickup?.ampm_deliveries || 'AM') === targetSlot;
  const byNewest = (a, b) => new Date(b?.created_date || b?.updated_date || 0).getTime() - new Date(a?.created_date || a?.updated_date || 0).getTime();

  return [...(pickups || [])].sort(byNewest).find((pickup) => pickup?.status === 'en_route' && sameSlot(pickup)) ||
    [...(pickups || [])].sort(byNewest).find((pickup) => pickup?.status === 'en_route') ||
    [...(pickups || [])].sort(byNewest).find((pickup) => ['pending', 'in_transit'].includes(pickup?.status) && sameSlot(pickup)) ||
    [...(pickups || [])].sort(byNewest).find((pickup) => ['pending', 'in_transit'].includes(pickup?.status));
}

async function ensurePickup(base44, { store, deliveryDate, driverId, driverName, slot, dispatcherId, createdByAppUserId }) {
  const existingStoreDeliveries = await base44.asServiceRole.entities.Delivery.filter({
    store_id: store.id,
    delivery_date: deliveryDate,
    driver_id: driverId,
  }, '-created_date', 50);

  const pickups = (existingStoreDeliveries || []).filter((item) => !item?.patient_id);
  const reusablePickup = findReusablePickup(pickups, slot);
  if (reusablePickup) {
    if (!reusablePickup.driver_name && driverName) {
      const updatedPickup = await base44.asServiceRole.entities.Delivery.update(reusablePickup.id, { driver_name: driverName }).catch((error) => {
        if (isNotFoundError(error)) return null;
        throw error;
      });
      return updatedPickup || reusablePickup;
    }
    return reusablePickup;
  }

  const routeDeliveries = await base44.asServiceRole.entities.Delivery.filter({
    delivery_date: deliveryDate,
    driver_id: driverId,
  }, '-created_date', 150);

  const slotPickups = (routeDeliveries || []).filter((item) => !item?.patient_id && (item?.ampm_deliveries || 'AM') === slot);
  const uniqueStoreCount = new Set(slotPickups.map((item) => item?.store_id).filter(Boolean)).size;
  const trackingNumberBase = (uniqueStoreCount + 1) * 20 - 20;
  const times = getSlotTimes(store, deliveryDate, slot);
  const fallbackTimes = getFallbackTimes(slot);

  return await base44.asServiceRole.entities.Delivery.create({
    stop_id: generateShortStopId(),
    store_id: store.id,
    delivery_id: generateDeliveryId(),
    delivery_date: deliveryDate,
    driver_id: driverId,
    driver_name: driverName,
    dispatcher_id: dispatcherId,
    created_by_app_user_id: createdByAppUserId,
    ampm_deliveries: slot,
    status: 'en_route',
    delivery_time_start: times.start || fallbackTimes.start,
    delivery_time_end: times.end || fallbackTimes.end,
    tracking_number: `${store?.abbreviation || ''}${trackingNumberBase}`,
  });
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json();
    const user = await base44.auth.me();
    const creatorAppUsers = user?.id ? await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }, '-created_date', 1) : [];
    const creatorAppUserId = creatorAppUsers?.[0]?.id || '';

    const isEntityEvent = payload?.event?.type === 'create' && payload?.event?.entity_name === 'Delivery';
    const directDriverId = payload?.driverId || null;
    const directDeliveryDate = payload?.deliveryDate || null;
    const directStoreIds = Array.isArray(payload?.storeIds) ? payload.storeIds.filter(Boolean) : [];

    let delivery = null;
    if (isEntityEvent) {
      delivery = payload?.payload_too_large
        ? await base44.asServiceRole.entities.Delivery.get(payload.event.entity_id).catch((error) => {
            if (isNotFoundError(error)) return null;
            throw error;
          })
        : payload?.data;

      if (!delivery?.driver_id || !delivery?.delivery_date || !delivery?.store_id) {
        return Response.json({ skipped: true, reason: 'Missing driver/date/store' });
      }

      if (!delivery?.patient_id) {
        return Response.json({ skipped: true, reason: 'Pickup record already' });
      }
    } else {
      if (!directDriverId || !directDeliveryDate) {
        return Response.json({ error: 'Missing driverId or deliveryDate' }, { status: 400 });
      }
    }

    if (isEntityEvent) {
      // CRITICAL: Skip pickup creation for retry and return deliveries
      // These are created via the Retry/Return buttons and already have a puid linking to an existing pickup
      if (delivery._skipPickupCreation === true) {
        return Response.json({ skipped: true, reason: 'Retry/return delivery — pickup creation explicitly skipped' });
      }

      if (!ACTIVE_DELIVERY_STATUSES.has(delivery.status)) {
        return Response.json({ skipped: true, reason: `Status ${delivery.status} does not need pickup ensure` });
      }

      // CRITICAL: If this delivery already has a puid pointing to an existing pickup on this driver/date,
      // skip all pickup creation (handles retry/return deliveries where puid is inherited)
      if (delivery.puid) {
        const existingPickupForPuid = await base44.asServiceRole.entities.Delivery.filter({
          stop_id: delivery.puid,
          delivery_date: delivery.delivery_date,
          driver_id: delivery.driver_id,
        }, '-created_date', 5);
        const hasMatchingPickup = (existingPickupForPuid || []).some((item) => !item?.patient_id);
        if (hasMatchingPickup) {
          return Response.json({ skipped: true, reason: 'Delivery already has a valid puid pointing to an existing pickup' });
        }
      }
    }

    const driverId = isEntityEvent ? delivery.driver_id : directDriverId;
    const deliveryDate = isEntityEvent ? delivery.delivery_date : directDeliveryDate;
    const primarySlot = isEntityEvent ? getPrimarySlot(delivery) : null;
    const routeDeliveries = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
    }, '-created_date', 200);

    const otherActivePatientStops = isEntityEvent
      ? (routeDeliveries || []).filter((item) => item?.id !== delivery.id && item?.patient_id && ACTIVE_DELIVERY_STATUSES.has(item?.status))
      : (routeDeliveries || []).filter((item) => item?.patient_id && ACTIVE_DELIVERY_STATUSES.has(item?.status));

    const [assignedStores, driverAppUsers] = await Promise.all([
      loadAssignedStores(base44, deliveryDate, driverId),
      base44.asServiceRole.entities.AppUser.filter({ user_id: driverId }, '-created_date', 1),
    ]);

    const requestedStoreIdSet = new Set(directStoreIds);
    const filteredAssignedStores = !isEntityEvent && requestedStoreIdSet.size > 0
      ? (assignedStores || []).filter((store) => requestedStoreIdSet.has(store.id))
      : (assignedStores || []);

    const currentStore = isEntityEvent ? filteredAssignedStores.find((store) => store?.id === delivery.store_id) || null : null;
    if (isEntityEvent && !currentStore) {
      return Response.json({ skipped: true, reason: 'Store not found' });
    }

    const driverName = driverAppUsers?.[0]?.user_name || driverAppUsers?.[0]?.full_name || delivery?.driver_name || '';

    const ensureTargets = [];
    const seenTargets = new Set();
    const addTarget = (store, slot) => {
      if (!store?.id || !slot) return;
      const key = `${store.id}:${slot}`;
      if (seenTargets.has(key)) return;
      seenTargets.add(key);
      ensureTargets.push({ store, slot });
    };

    const isFirstStopOnRoute = otherActivePatientStops.length === 0;
    if (isFirstStopOnRoute || !isEntityEvent) {
      filteredAssignedStores.forEach((store) => {
        if (!store || SPECIAL_STORE_NAMES.has(store.name || '')) return;
        const slots = getAssignedSlotsForStore(store, deliveryDate, driverId);
        slots.forEach((slot) => addTarget(store, slot));
      });
    }

    if (isEntityEvent) {
      addTarget(currentStore, primarySlot);
    }

    const ensuredPickups = [];
    for (const target of ensureTargets) {
      const pickup = await ensurePickup(base44, {
        store: target.store,
        deliveryDate,
        driverId,
        driverName,
        slot: target.slot,
        dispatcherId: user?.id || null,
        createdByAppUserId: creatorAppUserId
      });

      ensuredPickups.push({
        store_id: target.store.id,
        slot: target.slot,
        pickup_id: pickup?.id || null,
        puid: pickup?.stop_id || null,
      });
    }

    if (isEntityEvent) {
      const matchedPickup = ensuredPickups.find((item) => item.store_id === delivery.store_id && item.slot === primarySlot);
      if (matchedPickup?.puid && matchedPickup.puid !== delivery.puid) {
        const updatedDelivery = await base44.asServiceRole.entities.Delivery.update(delivery.id, { puid: matchedPickup.puid }).catch((error) => {
          if (isNotFoundError(error)) return null;
          throw error;
        });
        if (!updatedDelivery) {
          return Response.json({ skipped: true, reason: 'delivery_not_found_during_puid_update' });
        }
      }

      return Response.json({
        success: true,
        delivery_id: delivery.id,
        primary_slot: primarySlot,
        is_first_stop_on_route: isFirstStopOnRoute,
        assigned_puid: matchedPickup?.puid || null,
        ensured_pickups: ensuredPickups,
        pickups: ensuredPickups.map((item) => ({
          id: item.pickup_id,
          stop_id: item.puid,
          store_id: item.store_id,
          delivery_date: deliveryDate,
          driver_id: driverId,
          ampm_deliveries: item.slot
        }))
      });
    }

    return Response.json({
      success: true,
      driver_id: driverId,
      delivery_date: deliveryDate,
      ensured_pickups: ensuredPickups,
      pickups: ensuredPickups.map((item) => ({
        id: item.pickup_id,
        stop_id: item.puid,
        store_id: item.store_id,
        delivery_date: deliveryDate,
        driver_id: driverId,
        ampm_deliveries: item.slot
      }))
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});