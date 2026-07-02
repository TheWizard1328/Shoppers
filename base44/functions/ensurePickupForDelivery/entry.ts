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
      skipReuseCheck = false,
      deliveryId: callerDeliveryId = null
    } = body || {};

    if (!storeId || !deliveryDate || !driverId) {
      return Response.json({ error: 'Missing required parameters: storeId, deliveryDate, driverId' }, { status: 400 });
    }

    // CRITICAL: Never run pickup logic for ISP/ISD deliveries — they manage their own PUID linkage.
    const upperDeliveryId = String(callerDeliveryId || '').toUpperCase();
    if (upperDeliveryId.startsWith('ISP-') || upperDeliveryId.startsWith('ISD-')) {
      console.log(`[ensurePickupForDelivery] Skipped — ISP/ISD delivery: ${callerDeliveryId}`);
      return Response.json({ puid: null, pickupId: null, isNew: false, skipAutoCreate: true, skippedInterStore: true });
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

    const [stores, dateOverrides] = await Promise.all([
      base44.asServiceRole.entities.Store.filter({ id: storeId }),
      base44.asServiceRole.entities.DriverScheduleOverride.filter({ date: deliveryDate }),
    ]);
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

      let incompletePickup = existingPickups.find((pickup) =>
        !pickup.patient_id &&
        pickup.status !== 'completed' &&
        pickup.status !== 'cancelled' &&
        pickup.status !== 'returned'
      );

      if (incompletePickup) {
        // CRITICAL: Correct status to en_route if it's null/blank/in_transit
        if (incompletePickup.status !== 'en_route') {
          console.log(`[ensurePickupForDelivery] Correcting special-store pickup status "${incompletePickup.status}" → "en_route" | pickup=${incompletePickup.id}`);
          try {
            const corrected = await base44.asServiceRole.entities.Delivery.update(incompletePickup.id, { status: 'en_route' }).catch((error) => {
              if (isNotFoundError(error)) return null;
              throw error;
            });
            if (corrected) incompletePickup = { ...incompletePickup, ...corrected, status: 'en_route' };
          } catch (_) { incompletePickup = { ...incompletePickup, status: 'en_route' }; }
        }
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

    // Helper: resolve the effective driver for a store slot, checking overrides first
    const getEffectiveSlotDriverId = (slot) => {
      const prefix = dow === 6 ? 'saturday' : dow === 0 ? 'sunday' : 'weekday';
      const slotKey = `${prefix}_${slot === 'AM' ? 'am' : 'pm'}`;
      const override = (dateOverrides || []).find((o) => o.store_id === storeId && o.slot_key === slotKey);
      if (override) return override.driver_id; // may be '__booked_off__' or a real driver id
      const fieldKey = slot === 'AM'
        ? (isWeekday ? 'weekday_am_driver_id' : dow === 6 ? 'saturday_am_driver_id' : 'sunday_am_driver_id')
        : (isWeekday ? 'weekday_pm_driver_id' : dow === 6 ? 'saturday_pm_driver_id' : 'sunday_pm_driver_id');
      return store?.[fieldKey] || null;
    };

    const slotEnabled = (slot) => {
      // If the slot is booked off via override, treat as disabled for this driver
      const effectiveDriverId = getEffectiveSlotDriverId(slot);
      if (effectiveDriverId === '__booked_off__') return false;
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

    // Helper: compute corrected times for a pickup that falls in the past window
    const nowEdmontonForReuse = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Edmonton' }));
    const todayStrForReuse = nowEdmontonForReuse.toISOString().slice(0, 10);
    const isTodayReuse = deliveryDate === todayStrForReuse;
    const pad2r = (n) => String(n).padStart(2, '0');
    const addMinR = (d, m) => { const r = new Date(d.getTime() + m * 60000); return `${pad2r(r.getHours())}:${pad2r(r.getMinutes())}`; };
    const toMinR = (t) => { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const nowMinR = nowEdmontonForReuse.getHours() * 60 + nowEdmontonForReuse.getMinutes();

    const maybeUpdatePickupTimes = async (pickup) => {
      if (!pickup?.id || !isTodayReuse) return pickup;
      const windowEnd = toMinR(pickup.delivery_time_end);
      if (windowEnd === null || nowMinR <= windowEnd) return pickup;
      // Current time is past the pickup's end window — update to now+30/now+90
      const newStart = addMinR(nowEdmontonForReuse, 30);
      const newEnd = addMinR(nowEdmontonForReuse, 90);
      const updated = await base44.asServiceRole.entities.Delivery.update(pickup.id, {
        delivery_time_start: newStart,
        delivery_time_end: newEnd,
        delivery_time_eta: newStart,
      }).catch((error) => { if (isNotFoundError(error)) return null; throw error; });
      return updated || { ...pickup, delivery_time_start: newStart, delivery_time_end: newEnd, delivery_time_eta: newStart };
    };

    // Helper: trigger polyline regen for a reused pickup that had stale times updated,
    // passing forcedPickupId so the corrected times are written AFTER all ETA recalc.
    const triggerRegenForReusedPickup = (pickup, updatedPickup) => {
      // Only trigger if times were actually changed (maybeUpdatePickupTimes returns original if no change)
      const timesChanged = updatedPickup?.delivery_time_start !== pickup?.delivery_time_start ||
                           updatedPickup?.delivery_time_end !== pickup?.delivery_time_end;
      if (!timesChanged || !updatedPickup?.id) return;
      const forcedStart = updatedPickup.delivery_time_start;
      const forcedEnd = updatedPickup.delivery_time_end;
      base44.asServiceRole.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      }, 'stop_order', 50000).then(allDels => {
        const orderedDeliveryIds = (allDels || [])
          .filter(d => d?.id)
          .sort((a, b) => (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0))
          .map(d => d.id);
        const nowEdmRegen = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Edmonton' }));
        const nowStr = `${String(nowEdmRegen.getHours()).padStart(2,'0')}:${String(nowEdmRegen.getMinutes()).padStart(2,'0')}`;
        return base44.functions.invoke('purgeAndRegeneratePolylines', {
          driverId,
          deliveryDate,
          orderedDeliveryIds,
          bypassDriverStatus: true,
          recalculateEtas: true,
          completionTime: nowStr,
          forcedPickupId: updatedPickup.id,
          forcedPickupTimeStart: forcedStart,
          forcedPickupTimeEnd: forcedEnd,
        });
      }).catch((err) => console.warn('[ensurePickupForDelivery] reused pickup regen failed:', err?.message));
    };

    if (!skipReuseCheck) {
      let enRoutePickup = storePickups.find((pickup) => pickup.status === 'en_route' && (pickup.ampm_deliveries || 'AM') === primarySlot);
      if (!enRoutePickup) {
        enRoutePickup = storePickups.find((pickup) => pickup.status === 'en_route');
      }
      if (enRoutePickup) {
        let updated = await maybeUpdatePickupTimes(enRoutePickup);
        const pickupWithDriverName = await ensurePickupDriverName(base44, updated, driverName);
        if (!pickupWithDriverName) {
          return Response.json({ puid: null, pickupId: null, isNew: false, skipAutoCreate: true, skipped: true, reason: 'pickup_not_found_during_driver_name_update' });
        }
        triggerRegenForReusedPickup(enRoutePickup, updated);
        return Response.json({ puid: pickupWithDriverName.stop_id, pickupId: pickupWithDriverName.id, isNew: false, pickup: pickupWithDriverName });
      }

      const isIncomplete = (pickup) => !['en_route', 'completed', 'cancelled', 'returned'].includes(pickup.status);
      let targetPickup = storePickups.find((pickup) => isIncomplete(pickup) && (pickup.ampm_deliveries || 'AM') === primarySlot);
      if (!targetPickup) {
        targetPickup = storePickups.find((pickup) => isIncomplete(pickup));
      }
      if (targetPickup) {
        // CRITICAL: If the pickup's status is not en_route (e.g. null, blank, in_transit),
        // correct it to en_route before returning. Only completed/cancelled are exempt.
        const needsStatusCorrection = targetPickup.status !== 'en_route';
        if (needsStatusCorrection) {
          console.log(`[ensurePickupForDelivery] Correcting pickup status from "${targetPickup.status}" → "en_route" | pickup=${targetPickup.id}`);
          try {
            const corrected = await base44.asServiceRole.entities.Delivery.update(targetPickup.id, { status: 'en_route' }).catch((error) => {
              if (isNotFoundError(error)) return null;
              throw error;
            });
            if (corrected) targetPickup = { ...targetPickup, ...corrected, status: 'en_route' };
          } catch (_) { targetPickup = { ...targetPickup, status: 'en_route' }; }
        }
        let updated = await maybeUpdatePickupTimes(targetPickup);
        const pickupWithDriverName = await ensurePickupDriverName(base44, updated, driverName);
        if (!pickupWithDriverName) {
          return Response.json({ puid: null, pickupId: null, isNew: false, skipAutoCreate: true, skipped: true, reason: 'pickup_not_found_during_driver_name_update' });
        }
        triggerRegenForReusedPickup(targetPickup, updated);
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
    const nowEdmonton = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Edmonton' }));
    const todayStr = nowEdmonton.toISOString().slice(0, 10);
    const isToday = deliveryDate === todayStr;
    const toMin = (t) => { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const nowMin = nowEdmonton.getHours() * 60 + nowEdmonton.getMinutes();
    const windowEndMin = toMin(times.end);
    const isPastWindow = isToday && windowEndMin !== null && nowMin > windowEndMin;
    const pad2 = (n) => String(n).padStart(2, '0');
    const addMin = (d, m) => { const r = new Date(d.getTime() + m * 60000); return `${pad2(r.getHours())}:${pad2(r.getMinutes())}`; };
    const delivery_time_start = isPastWindow ? addMin(nowEdmonton, 30) : (times.start || fallbackTimes(chosenSlot).start);
    const delivery_time_end = isPastWindow ? addMin(nowEdmonton, 90) : (times.end || fallbackTimes(chosenSlot).end);
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

    // If every existing stop on the route is finished, this is an "after-route" pickup —
    // set first_leg_origin to driver home so the polyline starts from home correctly.
    // Also fix any existing en_route pickups on this route that still have stale (past) time windows.
    const allExistingFinished = allPickups.length > 0 && allPickups.every(d =>
      ['completed', 'failed', 'cancelled', 'returned'].includes(d?.status)
    );
    if (allExistingFinished && isTodayReuse) {
      // Update any en_route pickups on this route with stale time windows
      const stalePickups = storePickups.filter(p => p?.id && p.status === 'en_route');
      for (const sp of stalePickups) {
        await maybeUpdatePickupTimes(sp);
      }
    }
    const homeLat = driverAppUsers?.[0]?.home_latitude != null ? Number(driverAppUsers[0].home_latitude) : null;
    const homeLon = driverAppUsers?.[0]?.home_longitude != null ? Number(driverAppUsers[0].home_longitude) : null;
    const hasHome = homeLat != null && homeLon != null && Number.isFinite(homeLat) && Number.isFinite(homeLon) && !(homeLat === 0 && homeLon === 0);

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
      stop_order: stopOrder,
      ...(allExistingFinished && hasHome ? { first_leg_origin_lat: homeLat, first_leg_origin_lng: homeLon } : {}),
    });

    const normalizedPickup = await normalizePickupPuid(base44, newPickup);

    // Trigger polyline regeneration after creating a new pickup.
    // If all previous stops were finished (after-route pickup), pass recalculateEtas=true
    // with completionTime = now so ETAs are computed from the current time, not the old window.
    const nowEdmForRegen = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Edmonton' }));
    const nowHH = String(nowEdmForRegen.getHours()).padStart(2, '0');
    const nowMM = String(nowEdmForRegen.getMinutes()).padStart(2, '0');
    const currentTimeStr = `${nowHH}:${nowMM}`;

    // Compute forced ETA fields for after-route pickups so polyline regen can apply them last
    const forcedPickupStart = allExistingFinished ? (normalizedPickup?.delivery_time_start || newPickup.delivery_time_start) : null;
    const forcedPickupEnd = allExistingFinished ? (normalizedPickup?.delivery_time_end || newPickup.delivery_time_end) : null;

    base44.asServiceRole.entities.Delivery.filter({
      driver_id: driverId,
      delivery_date: deliveryDate
    }, 'stop_order', 50000).then(allDels => {
      const orderedDeliveryIds = (allDels || [])
        .filter(d => d?.id)
        .sort((a, b) => (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0))
        .map(d => d.id);
      return base44.functions.invoke('purgeAndRegeneratePolylines', {
        driverId,
        deliveryDate,
        orderedDeliveryIds,
        bypassDriverStatus: true,
        recalculateEtas: allExistingFinished,
        completionTime: allExistingFinished ? currentTimeStr : null,
        // Force-apply these times to the pickup AFTER all ETA writes, so polyline regen can't overwrite them
        forcedPickupId: allExistingFinished ? (normalizedPickup?.id || newPickup.id) : null,
        forcedPickupTimeStart: forcedPickupStart,
        forcedPickupTimeEnd: forcedPickupEnd,
      });
    }).catch((err) => console.warn('[ensurePickupForDelivery] polyline regen failed:', err.message));

    return Response.json({ puid, pickupId: normalizedPickup?.id || newPickup.id, isNew: true, pickup: normalizedPickup || newPickup });
  } catch (error) {
    console.error('❌ Error in ensurePickupForDelivery:', error.message);
    return Response.json({ error: 'Failed to ensure pickup exists: ' + error.message }, { status: 500 });
  }
});