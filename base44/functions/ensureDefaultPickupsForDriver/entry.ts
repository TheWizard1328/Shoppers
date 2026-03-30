import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const SPECIAL_STORE_NAMES = new Set(['Lakeland Ridge', 'Sherwood Pk Mall', 'WestPark', 'SouthPoint']);
const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

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

function getDriverStoreFields(deliveryDate) {
  const dayOfWeek = new Date(`${deliveryDate}T00:00:00`).getDay();
  if (dayOfWeek === 6) return { am: 'saturday_am_driver_id', pm: 'saturday_pm_driver_id' };
  if (dayOfWeek === 0) return { am: 'sunday_am_driver_id', pm: 'sunday_pm_driver_id' };
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
  return slot === 'PM' ? { start: '15:00', end: '16:00' } : { start: '10:00', end: '11:00' };
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
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await req.json().catch(() => ({}));
    const input = payload?.payload && typeof payload.payload === 'object' ? payload.payload : payload;
    const driverId = input?.driverId || null;
    const deliveryDate = input?.deliveryDate || null;
    const storeIds = Array.isArray(input?.storeIds) ? input.storeIds.filter(Boolean) : [];

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'Missing driverId or deliveryDate' }, { status: 400 });
    }

    const creatorAppUsers = user?.id ? await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }, '-created_date', 1) : [];
    const creatorAppUserId = creatorAppUsers?.[0]?.id || '';
    const dispatcherId = user.id;

    const [assignedStores, driverAppUsers] = await Promise.all([
      loadAssignedStores(base44, deliveryDate, driverId),
      base44.asServiceRole.entities.AppUser.filter({ id: driverId }, '-created_date', 1),
    ]);

    const filteredStores = assignedStores || [];

    const driverName = driverAppUsers?.[0]?.user_name || driverAppUsers?.[0]?.full_name || '';
    const ensuredPickups = [];

    for (const store of filteredStores) {
      if (!store || SPECIAL_STORE_NAMES.has(store.name || '')) continue;
      const slots = getAssignedSlotsForStore(store, deliveryDate, driverId);

      for (const slot of slots) {
        const pickup = await ensurePickup(base44, {
          store,
          deliveryDate,
          driverId,
          driverName,
          slot,
          dispatcherId,
          createdByAppUserId: creatorAppUserId,
        });

        ensuredPickups.push({ ...pickup, patient_id: null, puid: pickup?.stop_id || pickup?.puid || null });
      }
    }

    return Response.json({
      success: true,
      driver_id: driverId,
      delivery_date: deliveryDate,
      pickups: ensuredPickups,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});