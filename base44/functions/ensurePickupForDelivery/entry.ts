import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

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

async function ensurePickupDriverName(base44, pickup, driverName) {
  if (!pickup || pickup.driver_name || !driverName) return pickup;
  try {
    return await base44.asServiceRole.entities.Delivery.update(pickup.id, { driver_name: driverName });
  } catch (_) {
    return { ...pickup, driver_name: driverName };
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

    const stores = await base44.entities.Store.filter({ id: storeId });
    const store = stores[0];
    const driverAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId });
    const driverName = driverAppUsers?.[0]?.user_name || driverAppUsers?.[0]?.full_name || '';
    const specialStoreNames = ['Lakeland Ridge', 'Sherwood Pk Mall', 'WestPark', 'SouthPoint'];

    if (store && specialStoreNames.includes(store.name)) {
      const now = new Date();
      const ampmDeliveries = requestedAmpm || (now.getHours() < 14 ? 'AM' : 'PM');

      const existingPickups = await base44.entities.Delivery.filter({
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
        return Response.json({ puid: pickupWithDriverName.stop_id, pickupId: pickupWithDriverName.id, isNew: false, pickup: pickupWithDriverName });
      }

      return Response.json({ puid: null, pickupId: null, isNew: false, skipAutoCreate: true });
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

    const storePickups = (await base44.entities.Delivery.filter({
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
        return Response.json({ puid: pickupWithDriverName.stop_id, pickupId: pickupWithDriverName.id, isNew: false, pickup: pickupWithDriverName });
      }

      const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Edmonton' }));
      const nowLocalMs = nowLocal.getTime();
      const recentCompletedPickup = storePickups
        .filter((pickup) => pickup.status === 'completed' && (pickup.ampm_deliveries || 'AM') === primarySlot)
        .sort((a, b) => new Date(b.actual_delivery_time || b.updated_date || 0) - new Date(a.actual_delivery_time || a.updated_date || 0))
        .find((pickup) => {
          let completedAtMs = 0;
          if (pickup.actual_delivery_time) {
            completedAtMs = new Date(pickup.actual_delivery_time).getTime();
          } else if (pickup.updated_date) {
            completedAtMs = new Date(new Date(pickup.updated_date).toLocaleString('en-US', { timeZone: 'America/Edmonton' })).getTime();
          }
          const diffMinutes = (nowLocalMs - completedAtMs) / (60 * 1000);
          return completedAtMs > 0 && diffMinutes >= 0 && diffMinutes < 60;
        });

      if (recentCompletedPickup) {
        const pickupWithDriverName = await ensurePickupDriverName(base44, recentCompletedPickup, driverName);
        return Response.json({
          puid: pickupWithDriverName.stop_id,
          pickupId: pickupWithDriverName.id,
          isNew: false,
          pickup: pickupWithDriverName,
          deliveryStatus: 'in_transit'
        });
      }

      const isIncomplete = (pickup) => !['en_route', 'completed', 'cancelled', 'returned'].includes(pickup.status);
      let targetPickup = storePickups.find((pickup) => isIncomplete(pickup) && (pickup.ampm_deliveries || 'AM') === primarySlot);
      if (!targetPickup) {
        targetPickup = storePickups.find((pickup) => isIncomplete(pickup));
      }
      if (targetPickup) {
        const pickupWithDriverName = await ensurePickupDriverName(base44, targetPickup, driverName);
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
      allPickups = await base44.entities.Delivery.filter({
        delivery_date: deliveryDate,
        driver_id: driverId
      }, '-created_date', 150);
    }

    const slotPickups = allPickups.filter((pickup) => !pickup.patient_id && (pickup.ampm_deliveries || 'AM') === chosenSlot);
    const uniqueStoreCount = new Set(slotPickups.map((pickup) => pickup.store_id)).size;
    const totalPickupsAfterCreate = uniqueStoreCount + 1;
    const baseNumber = totalPickupsAfterCreate * 20 - 20;
    const trackingNumber = `${store?.abbreviation || ''}${baseNumber}`;

    const newPickup = await base44.entities.Delivery.create({
      stop_id: puid,
      store_id: storeId,
      delivery_id: generateDeliveryId(),
      delivery_date: deliveryDate,
      driver_id: driverId,
      driver_name: driverName,
      dispatcher_id: store?.dispatcher_id || null,
      ampm_deliveries: chosenSlot,
      status: 'en_route',
      delivery_time_start,
      delivery_time_end,
      tracking_number: trackingNumber
    });

    return Response.json({ puid, pickupId: newPickup.id, isNew: true, pickup: newPickup });
  } catch (error) {
    console.error('❌ Error in ensurePickupForDelivery:', error.message);
    return Response.json({ error: 'Failed to ensure pickup exists: ' + error.message }, { status: 500 });
  }
});