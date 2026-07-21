// Redeployed on 2026-05-01
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';


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
  if (dayOfWeek === 6) return {
    am: 'saturday_am_driver_id',
    pm: 'saturday_pm_driver_id',
    amEnabled: 'saturday_am_enabled',
    pmEnabled: 'saturday_pm_enabled'
  };
  if (dayOfWeek === 0) return {
    am: 'sunday_am_driver_id',
    pm: 'sunday_pm_driver_id',
    amEnabled: 'sunday_am_enabled',
    pmEnabled: 'sunday_pm_enabled'
  };
  return {
    am: 'weekday_am_driver_id',
    pm: 'weekday_pm_driver_id',
    amEnabled: 'weekday_am_enabled',
    pmEnabled: 'weekday_pm_enabled'
  };
}

// Maps slot key → AM/PM label
function slotKeyToAmPm(slotKey) {
  return slotKey && slotKey.endsWith('_am') ? 'AM' : 'PM';
}

// Maps deliveryDate day-of-week + AM/PM → slot key prefix (weekday/saturday/sunday)
function getSlotKey(deliveryDate, ampm) {
  const dow = new Date(`${deliveryDate}T00:00:00`).getDay();
  const prefix = dow === 6 ? 'saturday' : dow === 0 ? 'sunday' : 'weekday';
  return `${prefix}_${ampm === 'AM' ? 'am' : 'pm'}`;
}

async function loadAssignedStores(base44, deliveryDate, driverId, driverUserId = null) {
  const fields = getDriverStoreFields(deliveryDate);
  const [stores, overrides] = await Promise.all([
    base44.asServiceRole.entities.Store.list('-created_date', 200),
    base44.asServiceRole.entities.DriverScheduleOverride.filter({ date: deliveryDate }),
  ]);
  const driverIdsToMatch = [driverId, driverUserId].filter(Boolean);

  return (stores || [])
    .filter((store) => {
      if (!store?.id) return false;
      // Check AM slot: override first, fallback to store default
      const amSlotKey = getSlotKey(deliveryDate, 'AM');
      const amOverride = (overrides || []).find((o) => o.store_id === store.id && o.slot_key === amSlotKey);
      const amDriverId = amOverride ? amOverride.driver_id : store?.[fields.am];
      const amEnabled = store?.[fields.amEnabled] === true;
      const amMatch = amEnabled && amDriverId && amDriverId !== '__booked_off__' && driverIdsToMatch.includes(amDriverId);

      // Check PM slot: override first, fallback to store default
      const pmSlotKey = getSlotKey(deliveryDate, 'PM');
      const pmOverride = (overrides || []).find((o) => o.store_id === store.id && o.slot_key === pmSlotKey);
      const pmDriverId = pmOverride ? pmOverride.driver_id : store?.[fields.pm];
      const pmEnabled = store?.[fields.pmEnabled] === true;
      const pmMatch = pmEnabled && pmDriverId && pmDriverId !== '__booked_off__' && driverIdsToMatch.includes(pmDriverId);

      return amMatch || pmMatch;
    })
    .sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
}

async function getAssignedSlotsForStoreWithOverrides(base44, store, deliveryDate, driverId, driverUserId = null, overrides = []) {
  const fields = getDriverStoreFields(deliveryDate);
  const slots = [];
  const driverIdsToMatch = [driverId, driverUserId].filter(Boolean);

  const amSlotKey = getSlotKey(deliveryDate, 'AM');
  const amOverride = overrides.find((o) => o.store_id === store.id && o.slot_key === amSlotKey);
  const amDriverId = amOverride ? amOverride.driver_id : store?.[fields.am];
  if (store?.[fields.amEnabled] === true && amDriverId && amDriverId !== '__booked_off__' && driverIdsToMatch.includes(amDriverId)) slots.push('AM');

  const pmSlotKey = getSlotKey(deliveryDate, 'PM');
  const pmOverride = overrides.find((o) => o.store_id === store.id && o.slot_key === pmSlotKey);
  const pmDriverId = pmOverride ? pmOverride.driver_id : store?.[fields.pm];
  if (store?.[fields.pmEnabled] === true && pmDriverId && pmDriverId !== '__booked_off__' && driverIdsToMatch.includes(pmDriverId)) slots.push('PM');

  return slots;
}

function getAssignedSlotsForStore(store, deliveryDate, driverId, driverUserId = null) {
  const fields = getDriverStoreFields(deliveryDate);
  const slots = [];
  const driverIdsToMatch = [driverId, driverUserId].filter(Boolean);

  if (store?.[fields.amEnabled] === true && driverIdsToMatch.includes(store?.[fields.am])) slots.push('AM');
  if (store?.[fields.pmEnabled] === true && driverIdsToMatch.includes(store?.[fields.pm])) slots.push('PM');

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
    [...(pickups || [])].sort(byNewest).find((pickup) => ['pending', 'in_transit'].includes(pickup?.status) && sameSlot(pickup));
}

async function ensurePickup(base44, { store, deliveryDate, driverId, driverName, slot, dispatcherId, createdByAppUserId, createdByUserId }) {
  const normalizePickupPuid = async (pickup) => {
    if (!pickup?.id) return pickup;
    const desiredPuid = pickup.puid || pickup.stop_id || null;
    if (!desiredPuid) return pickup;
    if (pickup.puid === desiredPuid && pickup.stop_id === desiredPuid) return pickup;
    const updatedPickup = await base44.asServiceRole.entities.Delivery.update(pickup.id, {
      stop_id: desiredPuid,
      puid: desiredPuid,
    }).catch((error) => {
      if (isNotFoundError(error)) return null;
      throw error;
    });
    return updatedPickup || { ...pickup, stop_id: desiredPuid, puid: desiredPuid };
  };
  const existingStoreDeliveries = await base44.asServiceRole.entities.Delivery.filter({
    store_id: store.id,
    delivery_date: deliveryDate,
    driver_id: driverId,
  }, '-created_date', 50);

  const pickups = (existingStoreDeliveries || []).filter((item) => !item?.patient_id && !item?._interstore_source_id && !item?._interstore_dest_id);
  const reusablePickup = findReusablePickup(pickups, slot);
  if (reusablePickup) {
    // If today and current time is past the pickup's window end, update times to now+30/now+90
    const nowEdmForCheck = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Edmonton' }));
    const isTodayCheck = deliveryDate === nowEdmForCheck.toISOString().slice(0, 10);
    const toMinCheck = (t) => { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const nowMinCheck = nowEdmForCheck.getHours() * 60 + nowEdmForCheck.getMinutes();
    const winEnd = toMinCheck(reusablePickup.delivery_time_end);
    let pickupToReturn = reusablePickup;
    if (isTodayCheck && winEnd !== null && nowMinCheck > winEnd) {
      const pad2c = (n) => String(n).padStart(2, '0');
      const addMinC = (d, m) => { const r = new Date(d.getTime() + m * 60000); return `${pad2c(r.getHours())}:${pad2c(r.getMinutes())}`; };
      const newStart = addMinC(nowEdmForCheck, 30);
      const newEnd = addMinC(nowEdmForCheck, 90);
      const upd = await base44.asServiceRole.entities.Delivery.update(reusablePickup.id, {
        delivery_time_start: newStart,
        delivery_time_end: newEnd,
        delivery_time_eta: newStart,
        ...(driverName && reusablePickup.driver_name !== driverName ? { driver_name: driverName } : {}),
      }).catch((error) => { if (isNotFoundError(error)) return null; throw error; });
      pickupToReturn = upd || { ...reusablePickup, delivery_time_start: newStart, delivery_time_end: newEnd };
    } else if (driverName && reusablePickup.driver_name !== driverName) {
      const updatedPickup = await base44.asServiceRole.entities.Delivery.update(reusablePickup.id, { driver_name: driverName }).catch((error) => {
        if (isNotFoundError(error)) return null;
        throw error;
      });
      pickupToReturn = updatedPickup || reusablePickup;
    }
    return await normalizePickupPuid(pickupToReturn);
  }

  const times = getSlotTimes(store, deliveryDate, slot);
  const fallbackTimes = getFallbackTimes(slot);

  const nowEdmonton = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Edmonton' }));
  const todayStr = nowEdmonton.toISOString().slice(0, 10);
  const isToday = deliveryDate === todayStr;
  const toMin = (t) => { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const nowMin = nowEdmonton.getHours() * 60 + nowEdmonton.getMinutes();
  const windowEndMin = toMin(times.end || fallbackTimes.end);
  const isPastWindow = isToday && windowEndMin !== null && nowMin > windowEndMin;
  const pad2 = (n) => String(n).padStart(2, '0');
  const addMin = (d, m) => { const r = new Date(d.getTime() + m * 60000); return `${pad2(r.getHours())}:${pad2(r.getMinutes())}`; };
  const resolvedStart = isPastWindow ? addMin(nowEdmonton, 30) : (times.start || fallbackTimes.start);
  const resolvedEnd = isPastWindow ? addMin(nowEdmonton, 90) : (times.end || fallbackTimes.end);

  // Check if every existing stop on the route is finished (after-route pickup scenario).
  // If so, set first_leg_origin to driver home so polylines originate from home.
  const existingRouteDeliveries = await base44.asServiceRole.entities.Delivery.filter({
    driver_id: driverId,
    delivery_date: deliveryDate,
  }, '-created_date', 200);
  const allExistingFinished = existingRouteDeliveries.length > 0 && existingRouteDeliveries.every(d =>
    ['completed', 'failed', 'cancelled', 'returned'].includes(d?.status)
  );
  const driverForHome = (await base44.asServiceRole.entities.AppUser.filter({ id: driverId }, '-created_date', 1))[0]
    || (await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId }, '-created_date', 1))[0]
    || null;
  const homeLat = driverForHome?.home_latitude != null ? Number(driverForHome.home_latitude) : null;
  const homeLon = driverForHome?.home_longitude != null ? Number(driverForHome.home_longitude) : null;
  const hasHome = homeLat != null && homeLon != null && Number.isFinite(homeLat) && Number.isFinite(homeLon) && !(homeLat === 0 && homeLon === 0);

  const pickupStopId = generateShortStopId();
  const createdPickup = await base44.asServiceRole.entities.Delivery.create({
    stop_id: pickupStopId,
    puid: pickupStopId,
    store_id: store.id,
    delivery_id: generateDeliveryId(),
    delivery_date: deliveryDate,
    driver_id: driverId,
    driver_name: driverName,
    dispatcher_id: dispatcherId,
    created_by_app_user_id: createdByAppUserId,
    created_by_user_id: createdByUserId,
    ampm_deliveries: slot,
    status: 'en_route',
    delivery_time_start: resolvedStart,
    delivery_time_end: resolvedEnd,
    ...(allExistingFinished && hasHome ? { first_leg_origin_lat: homeLat, first_leg_origin_lng: homeLon } : {}),
  });

  return await normalizePickupPuid(createdPickup);
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

    // CRITICAL: Never create default pickups for ISP/ISD routes.
    // Check if any existing delivery on this driver/date is an ISP or ISD stop.
    const existingRouteDeliveriesForCheck = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate,
    }, '-created_date', 50);
    const hasInterStoreStop = (existingRouteDeliveriesForCheck || []).some((d) =>
      String(d?.delivery_id || '').toUpperCase().startsWith('ISP-') ||
      String(d?.delivery_id || '').toUpperCase().startsWith('ISD-') ||
      d?._interstore_source_id
    );
    if (hasInterStoreStop) {
      console.log(`[ensureDefaultPickups] Skipped — ISP/ISD stop found for driver=${driverId} date=${deliveryDate}`);
      return Response.json({ success: true, driver_id: driverId, delivery_date: deliveryDate, pickups: [], skippedInterStore: true });
    }

    // Resolve creator: always use AppUser.id for created_by_app_user_id and dispatcher_id
    const creatorAppUsers = user?.id ? await base44.asServiceRole.entities.AppUser.filter({ user_id: user.id }, '-created_date', 1) : [];
    const creatorAppUser = creatorAppUsers?.[0] || null;
    const creatorAppUserId = creatorAppUser?.id || '';
    const dispatcherId = creatorAppUser?.id || user.id;

    let driverAppUsers = await base44.asServiceRole.entities.AppUser.filter({ id: driverId }, '-created_date', 1);
    if (!driverAppUsers?.length) {
      driverAppUsers = await base44.asServiceRole.entities.AppUser.filter({ user_id: driverId }, '-created_date', 1);
    }
    const driverAppUser = driverAppUsers?.[0] || null;
    const driverUserId = driverAppUser?.user_id || null;
    const [assignedStores, dateOverrides] = await Promise.all([
      loadAssignedStores(base44, deliveryDate, driverId, driverUserId),
      base44.asServiceRole.entities.DriverScheduleOverride.filter({ date: deliveryDate }),
    ]);

    const filteredStores = assignedStores || [];

    const driverName = driverAppUser?.user_name || driverAppUser?.full_name || '';
    console.log(`[ensureDefaultPickups] driverId=${driverId} driverAppUser=${JSON.stringify(driverAppUser)} driverName="${driverName}"`);
    const ensuredPickups = [];

    for (const store of filteredStores) {
      if (!store) continue;
      const slots = await getAssignedSlotsForStoreWithOverrides(base44, store, deliveryDate, driverId, driverUserId, dateOverrides || []);

      for (const slot of slots) {
        const pickup = await ensurePickup(base44, {
          store,
          deliveryDate,
          driverId,
          driverName,
          slot,
          dispatcherId,
          createdByAppUserId: creatorAppUserId,
          createdByUserId: user.id,
        });

        ensuredPickups.push({ ...pickup, patient_id: null, driver_name: pickup?.driver_name || driverName || '', puid: pickup?.stop_id || pickup?.puid || null });
      }
    }

    // Sort the newly created pickups by delivery_time_start and assign
    // stop_order 1, 2, 3... in that order.
    // Stores are iterated in store.sort_order sequence above, so ensuredPickups
    // arrives unsorted by time. We sort in memory — no DB round-trip needed
    // because this is always a fresh route with no existing stops.
    const timeToMinutes = (t) => {
      if (!t || typeof t !== 'string') return 9999;
      const parts = t.split(':');
      return parseInt(parts[0], 10) * 60 + parseInt(parts[1] || '0', 10);
    };

    const validPickups = ensuredPickups.filter(p => p?.id);

    if (validPickups.length > 0) {
      const sortedPickups = [...validPickups].sort((a, b) => {
        const aMin = timeToMinutes(a.delivery_time_start);
        const bMin = timeToMinutes(b.delivery_time_start);
        if (aMin !== bMin) return aMin - bMin;
        // Tiebreaker: AM before PM for same-time slots
        const aSlot = a.ampm_deliveries || 'AM';
        const bSlot = b.ampm_deliveries || 'AM';
        if (aSlot !== bSlot) return aSlot === 'AM' ? -1 : 1;
        // Final tiebreaker: store name alphabetically for stability
        return String(a.store_id || '').localeCompare(String(b.store_id || ''));
      });

      await Promise.all(sortedPickups.map((pickup, idx) => {
        const stopOrder = idx + 1;
        return base44.asServiceRole.entities.Delivery.update(pickup.id, { stop_order: stopOrder }).catch((error) => {
          if (!isNotFoundError(error)) throw error;
          return null;
        });
      }));

      console.log(`[ensureDefaultPickups] Sorted ${sortedPickups.length} pickups by delivery_time_start → stop_order. Order: ${sortedPickups.map(p => `${p.delivery_time_start || '??'}(${p.ampm_deliveries || '?'})`).join(' → ')}`);
    }

    const allDeliveriesForPolyline = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order', 50000);
    const orderedDeliveryIds = (allDeliveriesForPolyline || [])
      .filter(d => d?.id)
      .sort((a, b) => (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0))
      .map(d => d.id);

    await base44.functions.invoke('purgeAndRegeneratePolylines', {
      driverId,
      deliveryDate,
      orderedDeliveryIds,
      bypassDriverStatus: true
    }).catch((error) => {
      if (!isNotFoundError(error)) throw error;
      return null;
    });

    await base44.functions.invoke('recalculateTrackingNumbers', {
      driverId,
      deliveryDate
    }).catch((error) => {
      if (!isNotFoundError(error)) throw error;
      return null;
    });

    const refreshedPickups = await base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order', 50000);

    const pickupNameFixes = (refreshedPickups || [])
      .filter((pickup) => pickup && !pickup.patient_id && !pickup._interstore_source_id && !pickup._interstore_dest_id && pickup.driver_id === driverId && !pickup.driver_name)
      .map((pickup) => base44.asServiceRole.entities.Delivery.update(pickup.id, { driver_name: driverName || '' }).catch((error) => {
        if (isNotFoundError(error)) return null;
        throw error;
      }));

    if (pickupNameFixes.length > 0) {
      await Promise.all(pickupNameFixes);
    }

    const finalPickups = pickupNameFixes.length > 0
      ? await base44.asServiceRole.entities.Delivery.filter({
          driver_id: driverId,
          delivery_date: deliveryDate
        }, 'stop_order', 50000)
      : refreshedPickups;

    return Response.json({
      success: true,
      driver_id: driverId,
      delivery_date: deliveryDate,
      pickups: (finalPickups || []).filter((pickup) => pickup && !pickup.patient_id && !pickup._interstore_source_id && !pickup._interstore_dest_id),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});