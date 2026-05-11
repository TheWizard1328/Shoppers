// Redeployed on 2026-05-01
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

function parseTrackingNumber(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).match(/\d+/);
  if (!match) return null;
  const parsed = parseInt(match[0], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function getNextPickupTrackingNumber(pickups = []) {
  const usedTrackingNumbers = [...new Set(
    pickups
      .map((pickup) => parseTrackingNumber(pickup?.tracking_number))
      .filter((value) => value !== null && value >= 0 && value % 20 === 0)
  )].sort((a, b) => a - b);

  let expectedTrackingNumber = 0;
  for (const trackingNumber of usedTrackingNumbers) {
    if (trackingNumber > expectedTrackingNumber) {
      break;
    }
    if (trackingNumber === expectedTrackingNumber) {
      expectedTrackingNumber += 20;
    }
  }

  return String(expectedTrackingNumber).padStart(2, '0');
}

function getNextPickupStopOrder(deliveries = []) {
  const maxStopOrder = deliveries.reduce((max, delivery) => {
    const parsed = Number(delivery?.stop_order);
    return Number.isFinite(parsed) && parsed > max ? parsed : max;
  }, 0);
  return maxStopOrder + 1;
}

function generateShortStopId() {
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let result = '';
  for (let i = 0; i < 3; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

function generateDeliveryId() {
  return `DID-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

const ensurePickupInFlight = new Map();
const ensurePickupRecent = new Map();

async function normalizePickupPuid(base44, pickup) {
  if (!pickup?.id) return pickup;
  const desiredPuid = pickup.puid || pickup.stop_id || null;
  if (!desiredPuid) return pickup;
  if (pickup.puid === desiredPuid && pickup.stop_id === desiredPuid) return pickup;
  try {
    return await base44.asServiceRole.entities.Delivery.update(pickup.id, {
      stop_id: desiredPuid,
      puid: desiredPuid,
    }).catch((error) => {
      if (isNotFoundError(error)) return null;
      throw error;
    }) || { ...pickup, stop_id: desiredPuid, puid: desiredPuid };
  } catch (_) {
    return { ...pickup, stop_id: desiredPuid, puid: desiredPuid };
  }
}

async function ensurePickupDriverName(base44, pickup, driverName) {
  if (!pickup) return pickup;
  const desiredPuid = pickup.puid || pickup.stop_id || null;
  const needsDriverName = driverName && pickup.driver_name !== driverName;
  const needsPuid = desiredPuid && (pickup.puid !== desiredPuid || pickup.stop_id !== desiredPuid);
  if (!needsDriverName && !needsPuid) return pickup;
  const updatePayload = {
    ...(needsDriverName ? { driver_name: driverName } : {}),
    ...(needsPuid ? { stop_id: desiredPuid, puid: desiredPuid } : {}),
  };
  try {
    const updatedPickup = await base44.asServiceRole.entities.Delivery.update(pickup.id, updatePayload).catch((error) => {
      if (isNotFoundError(error)) return null;
      throw error;
    });
    return updatedPickup || { ...pickup, ...updatePayload };
  } catch (_) {
    return { ...pickup, ...updatePayload };
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const {
      storeId,
      deliveryDate,
      driverId,
      ampmDeliveries: requestedAmpm = null,
      primarySlot: legacyPrimarySlot = null,
      allowCreateIfMissing = false,
      skipReuseCheck = false
    } = body || {};

    if (!storeId || !deliveryDate || !driverId) {
      return Response.json({ error: 'Missing required parameters: storeId, deliveryDate, driverId' }, { status: 400 });
    }

    const requestedSlot = requestedAmpm || legacyPrimarySlot || null;

    try {
      const key = `${storeId}|${deliveryDate}|${driverId}|${requestedSlot || 'auto'}`;
      const last = ensurePickupRecent.get(key);
      const nowTs = Date.now();
      if (last && (nowTs - last) < 3500) {
        return Response.json({ puid: null, pickupId: null, isNew: false, skipAutoCreate: true, debounced: true });
      }
      ensurePickupRecent.set(key, nowTs);
    } catch (_) {}

    try {
      const inflightKey = `${storeId}|${deliveryDate}|${driverId}|${requestedSlot || 'auto'}`;
      const lastTs = ensurePickupInFlight.get(inflightKey);
      const nowTs = Date.now();
      if (lastTs && (nowTs - lastTs) < 3500) {
        return Response.json({ puid: null, pickupId: null, isNew: false, skipAutoCreate: true, debounced: true });
      }
      ensurePickupInFlight.set(inflightKey, nowTs);
      setTimeout(() => {
        try { ensurePickupInFlight.delete(inflightKey); } catch (_) {}
      }, 3600);
    } catch (_) {}

    const stores = await base44.asServiceRole.entities.Store.filter({ id: storeId });
    const store = stores[0];
    // driverId from the frontend is the AppUser.id, not AppUser.user_id — filter by id first, fallback to user_id
    let driverAppUsers = await base44.asServiceRole.entities.AppUser.filter({ id: driverId });
    if (!driverAppUsers?.length) {
      driverAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId });
    }
    const driverName = driverAppUsers?.[0]?.user_name || driverAppUsers?.[0]?.full_name || '';
    // Resolve creator: always use AppUser.id for created_by_app_user_id and dispatcher_id
    const creatorAppUsers = user?.id ? await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }, '-created_date', 1) : [];
    const creatorAppUser = creatorAppUsers?.[0] || null;
    const creatorAppUserId = creatorAppUser?.id || '';
    const dispatcherId = creatorAppUser?.id || user?.id || null;
    const specialStoreNames = ['Lakeland Ridge', 'Sherwood Pk Mall', 'WestPark', 'SouthPoint'];

    if (store && specialStoreNames.includes(store.name)) {
      const now = new Date();
      const ampmDeliveries = requestedAmpm || (now.getHours() < 14 ? 'AM' : 'PM');

      const existingPickups = await base44.asServiceRole.entities.Delivery.filter({
        store_id: storeId,
        delivery_date: deliveryDate,
        driver_id: driverId,
        ampm_deliveries: ampmDeliveries
      }, '-created_date', 20);

      const incompletePickup = existingPickups.find((pickup) =>
        !pickup.patient_id &&
        pickup.status !== 'completed' &&
        pickup.status !== 'cancelled' &&
        pickup.status !== 'returned'
      );

      if (incompletePickup) {
        const pickupWithDriverName = await ensurePickupDriverName(base44, incompletePickup, driverName);
        if (!pickupWithDriverName) {
          return Response.json({ puid: null, pickupId: null, isNew: false, skipAutoCreate: true, skipped: true, reason: 'pickup_not_found_during_driver_name_update' });
        }
        return Response.json({ puid: pickupWithDriverName.stop_id, pickupId: pickupWithDriverName.id, isNew: false, pickup: pickupWithDriverName });
      }

      if (!allowCreateIfMissing) {
        return Response.json({ puid: null, pickupId: null, isNew: false, skipAutoCreate: true });
      }

      const puid = generateShortStopId();
      const delivery_time_start = ampmDeliveries === 'PM' ? '15:00' : '10:00';
      const delivery_time_end = ampmDeliveries === 'PM' ? '16:00' : '11:00';
      const routePickups = await base44.asServiceRole.entities.Delivery.filter({
        delivery_date: deliveryDate,
        driver_id: driverId
      }, '-created_date', 150);
      const slotPickups = (routePickups || []).filter((pickup) =>
        !pickup?.patient_id &&
        (pickup?.ampm_deliveries || 'AM') === ampmDeliveries
      );
      const trackingNumber = getNextPickupTrackingNumber(slotPickups);
      const stopOrder = getNextPickupStopOrder(routePickups || []);

      const newPickup = await base44.asServiceRole.entities.Delivery.create({
        stop_id: puid,
        puid,
        store_id: storeId,
        delivery_id: generateDeliveryId(),
        delivery_date: deliveryDate,
        driver_id: driverId,
        driver_name: driverName,
        dispatcher_id: dispatcherId,
        created_by_app_user_id: creatorAppUserId,
        ampm_deliveries: ampmDeliveries,
        status: 'en_route',
        delivery_time_start,
        delivery_time_end,
        tracking_number: trackingNumber,
        stop_order: stopOrder
      });

      const normalizedPickup = await normalizePickupPuid(base44, newPickup);
      return Response.json({ puid, pickupId: normalizedPickup?.id || newPickup.id, isNew: true, pickup: normalizedPickup || newPickup });
    }

    const now = new Date();
    const dow = new Date(deliveryDate.replace(/-/g, '/')).getDay();
    const isWeekday = dow >= 1 && dow <= 5;
    const slotEnabled = (slot) => {
      if (isWeekday) return slot === 'AM' ? !!store?.weekday_am_enabled : !!store?.weekday_pm_enabled;
      if (dow === 6) return slot === 'AM' ? !!store?.saturday_am_enabled : !!store?.saturday_pm_enabled;
      return slot === 'AM' ? !!store?.sunday_am_enabled : !!store?.sunday_pm_enabled;
    };

    let primarySlot = (requestedSlot === 'PM' || requestedSlot === 'AM') && slotEnabled(requestedSlot) ? requestedSlot : null;
    if (!primarySlot) {
      if (slotEnabled('AM') && slotEnabled('PM')) {
        primarySlot = now.getHours() < 14 ? 'AM' : 'PM';
      } else if (slotEnabled('AM')) {
        primarySlot = 'AM';
      } else if (slotEnabled('PM')) {
        primarySlot = 'PM';
      } else {
        primarySlot = 'AM';
      }
    }

    const storePickups = (await base44.asServiceRole.entities.Delivery.filter({
      store_id: storeId,
      delivery_date: deliveryDate,
      driver_id: driverId
    }, '-created_date', 50)).filter((pickup) => !pickup.patient_id);

    let allPickups = null;

    if (!skipReuseCheck) {
      let enRoutePickup = storePickups.find((pickup) => pickup.status === 'en_route' && (pickup.ampm_deliveries || 'AM') === primarySlot);
      if (!enRoutePickup) {
        enRoutePickup = storePickups.find((pickup) => pickup.status === 'en_route');
      }
      if (enRoutePickup) {
        const pickupWithDriverName = await ensurePickupDriverName(base44, enRoutePickup, driverName);
        if (!pickupWithDriverName) {
          return Response.json({ puid: null, pickupId: null, isNew: false, skipAutoCreate: true, skipped: true, reason: 'pickup_not_found_during_driver_name_update' });
        }
        return Response.json({ puid: pickupWithDriverName.stop_id, pickupId: pickupWithDriverName.id, isNew: false, pickup: pickupWithDriverName });
      }

      const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Edmonton' }));
      const nowLocalMs = nowLocal.getTime();

      const isIncomplete = (pickup) => !['en_route', 'completed', 'cancelled', 'returned'].includes(pickup.status);
      let targetPickup = storePickups.find((pickup) => isIncomplete(pickup) && (pickup.ampm_deliveries || 'AM') === primarySlot);
      if (!targetPickup) {
        targetPickup = storePickups.find((pickup) => isIncomplete(pickup));
      }
      if (targetPickup) {
        const pickupWithDriverName = await ensurePickupDriverName(base44, targetPickup, driverName);
        if (!pickupWithDriverName) {
          return Response.json({ puid: null, pickupId: null, isNew: false, skipAutoCreate: true, skipped: true, reason: 'pickup_not_found_during_driver_name_update' });
        }
        return Response.json({ puid: pickupWithDriverName.stop_id, pickupId: pickupWithDriverName.id, isNew: false, pickup: pickupWithDriverName });
      }
    }

    if (!allowCreateIfMissing) {
      return Response.json({ puid: null, pickupId: null, isNew: false, skipAutoCreate: true });
    }

    const chosenSlot = primarySlot;
    const fallbackTimes = (slot) => slot === 'PM' ? { start: '15:00', end: '16:00' } : { start: '10:00', end: '11:00' };
    const getSlotTimes = (targetStore, targetDow, slot) => {
      const safeTime = (value) => typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) ? value : null;
      if (targetDow >= 1 && targetDow <= 5) {
        return {
          start: safeTime(slot === 'AM' ? targetStore?.weekday_am_start : targetStore?.weekday_pm_start),
          end: safeTime(slot === 'AM' ? targetStore?.weekday_am_end : targetStore?.weekday_pm_end),
        };
      }
      if (targetDow === 6) {
        return {
          start: safeTime(slot === 'AM' ? targetStore?.saturday_am_start : targetStore?.saturday_pm_start),
          end: safeTime(slot === 'AM' ? targetStore?.saturday_am_end : targetStore?.saturday_pm_end),
        };
      }
      return {
        start: safeTime(slot === 'AM' ? targetStore?.sunday_am_start : targetStore?.sunday_pm_start),
        end: safeTime(slot === 'AM' ? targetStore?.sunday_am_end : targetStore?.sunday_pm_end),
      };
    };

    const times = getSlotTimes(store, dow, chosenSlot) || {};
    const delivery_time_start = times.start || fallbackTimes(chosenSlot).start;
    const delivery_time_end = times.end || fallbackTimes(chosenSlot).end;
    const puid = generateShortStopId();

    if (!allPickups) {
      allPickups = await base44.asServiceRole.entities.Delivery.filter({
        delivery_date: deliveryDate,
        driver_id: driverId
      }, '-created_date', 150);
    }

    const slotPickups = allPickups.filter((pickup) =>
      !pickup.patient_id &&
      (pickup.ampm_deliveries || 'AM') === chosenSlot
    );
    const trackingNumber = getNextPickupTrackingNumber(slotPickups);
    const stopOrder = getNextPickupStopOrder(allPickups || []);

    const newPickup = await base44.asServiceRole.entities.Delivery.create({
      stop_id: puid,
      puid,
      store_id: storeId,
      delivery_id: generateDeliveryId(),
      delivery_date: deliveryDate,
      driver_id: driverId,
      driver_name: driverName,
      dispatcher_id: dispatcherId,
      created_by_app_user_id: creatorAppUserId,
      ampm_deliveries: chosenSlot,
      status: 'en_route',
      delivery_time_start,
      delivery_time_end,
      tracking_number: trackingNumber,
      stop_order: stopOrder
    });

    const normalizedPickup = await normalizePickupPuid(base44, newPickup);
    return Response.json({ puid, pickupId: normalizedPickup?.id || newPickup.id, isNew: true, pickup: normalizedPickup || newPickup });
  } catch (error) {
    console.error('❌ Error in ensurePickupForDelivery:', error.message);
    return Response.json({ error: 'Failed to ensure pickup exists: ' + error.message }, { status: 500 });
  }
});