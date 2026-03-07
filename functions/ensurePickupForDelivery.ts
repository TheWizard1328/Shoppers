import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import { format } from 'npm:date-fns';

function generateShortStopId() {
    // Generate a 3-character alphanumeric ID (same format as frontend)
    const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let result = '';
    for (let i = 0; i < 3; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

function generateDeliveryId() {
    // Generate a DID-XXXXX style ID for Delivery.delivery_id
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let suffix = '';
    for (let i = 0; i < 5; i++) {
        suffix += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `DID-${suffix}`;
}

// In-memory debounce maps (per warm instance)
const __ensurePickupInFlight = new Map();
const __ensurePickupRecent = new Map();

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();

        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await req.json().catch(() => ({}));
        const { storeId, deliveryDate, driverId, ampmDeliveries: requestedAmpm = null, allowCreateIfMissing = false, skipReuseCheck = false } = body || {};

        if (!storeId || !deliveryDate || !driverId) {
            return Response.json({ error: 'Missing required parameters: storeId, deliveryDate, driverId' }, { status: 400 });
        }

        // Debounce rapid duplicates for same store/date/driver (3.5s)
        try {
          const key = `${storeId}|${deliveryDate}|${driverId}`;
          const last = __ensurePickupRecent.get(key);
          const nowTs = Date.now();
          if (last && (nowTs - last) < 3500) {
            return Response.json({ puid: null, pickupId: null, isNew: false, skipAutoCreate: true, debounced: true });
          }
          __ensurePickupRecent.set(key, nowTs);
        } catch (_) {}

        // In-flight guard for duplicate concurrent calls (3.5s)
        try {
          const inflightKey = `${storeId}|${deliveryDate}|${driverId}`;
          const lastTs = __ensurePickupInFlight.get(inflightKey);
          const nowTs2 = Date.now();
          if (lastTs && (nowTs2 - lastTs) < 3500) {
            return Response.json({ puid: null, pickupId: null, isNew: false, skipAutoCreate: true, debounced: true });
          }
          __ensurePickupInFlight.set(inflightKey, nowTs2);
          setTimeout(() => { try { __ensurePickupInFlight.delete(inflightKey); } catch (_) {} }, 3600);
        } catch (_) {}

        // CRITICAL: Special stores - do NOT auto-create pickups (Dashboard handles them on-demand)
        const stores = await base44.entities.Store.filter({ id: storeId });
        const store = stores[0];
        const specialStoreNames = ['Lakeland Ridge', 'Sherwood Pk Mall', 'WestPark', 'SouthPoint'];
        
        if (store && specialStoreNames.includes(store.name)) {
            console.log(`⏭️ [ensurePickup] Special store ${store.name} - skipping auto-pickup creation (handled by Dashboard)`);
            
            // Still check for existing incomplete pickup and return it if found
            const now = new Date();
            const currentHour = now.getHours();
            const ampmDeliveries = requestedAmpm || (currentHour < 14 ? 'AM' : 'PM');
            
            const existingPickups = await base44.entities.Delivery.filter({
                store_id: storeId,
                delivery_date: deliveryDate,
                driver_id: driverId,
                ampm_deliveries: ampmDeliveries
            }, '-created_date', 20);
            
            const incompletePickup = existingPickups.find(p => 
                !p.patient_id && 
                p.status !== 'completed' && 
                p.status !== 'cancelled' && 
                p.status !== 'returned'
            );
            
            if (incompletePickup) {
                return Response.json({ 
                    puid: incompletePickup.stop_id,
                    pickupId: incompletePickup.id,
                    isNew: false 
                });
            }
            
            // No incomplete pickup exists, but don't create one - Dashboard will handle it
            return Response.json({ 
                puid: null,
                pickupId: null,
                isNew: false,
                skipAutoCreate: true
            });
        }

        // Determine AM/PM using store schedule for the given day (fallback to AM)
        const now = new Date();
        const dow = new Date(deliveryDate.replace(/-/g,'/')).getDay(); // 0=Sun..6=Sat
        const isWeekday = dow >= 1 && dow <= 5;
        const slotEnabled = (slot) => {
          if (isWeekday) return slot === 'AM' ? !!store?.weekday_am_enabled : !!store?.weekday_pm_enabled;
          if (dow === 6) return slot === 'AM' ? !!store?.saturday_am_enabled : !!store?.saturday_pm_enabled;
          return slot === 'AM' ? !!store?.sunday_am_enabled : !!store?.sunday_pm_enabled;
        };
        let primarySlot = (requestedAmpm === 'PM' || requestedAmpm === 'AM') && slotEnabled(requestedAmpm) ? requestedAmpm : null;
        if (!primarySlot) {
          // Today: pick based on time if both enabled, else first enabled
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

        console.log(`🔍 Ensuring pickup (store-scoped): store=${storeId}, date=${deliveryDate}, driver=${driverId}, primarySlot=${primarySlot}`);

        // Fetch ALL pickups for this driver/date (AM + PM) for numbering purposes
        const allPickups = await base44.entities.Delivery.filter({
            delivery_date: deliveryDate,
            driver_id: driverId
        }, '-created_date', 150);

        // Focus selection ONLY on this store
        const storePickups = allPickups.filter(p => p.store_id === storeId && !p.patient_id);

        // 1) Prefer an en_route pickup for THIS STORE that matches the primary slot
        //    Driver is already heading there — assign new delivery to this pickup
        let enRoutePickup = storePickups.find(p => p.status === 'en_route' && (p.ampm_deliveries || 'AM') === primarySlot);
        if (!enRoutePickup) {
            enRoutePickup = storePickups.find(p => p.status === 'en_route');
        }
        if (enRoutePickup) {
            console.log(`✅ Using existing en_route pickup for store ${storeId}: ${enRoutePickup.id}, PUID: ${enRoutePickup.stop_id}`);
            return Response.json({ puid: enRoutePickup.stop_id, pickupId: enRoutePickup.id, isNew: false, pickup: enRoutePickup });
        }

        // 2) Check for a pickup completed within the last 60 minutes — driver already picked up from this store recently
        //    Assign new delivery to that pickup's PUID but flag that the delivery should be set to in_transit
        const nowMs = Date.now();
        const recentCompletedPickup = storePickups
            .filter(p => p.status === 'completed' && (p.ampm_deliveries || 'AM') === primarySlot)
            .sort((a, b) => new Date(b.actual_delivery_time || b.updated_date || 0) - new Date(a.actual_delivery_time || a.updated_date || 0))
            .find(p => {
                const completedAt = new Date(p.actual_delivery_time || p.updated_date || 0).getTime();
                return completedAt > 0 && (nowMs - completedAt) < 60 * 60 * 1000; // within 60 minutes
            });

        if (recentCompletedPickup) {
            console.log(`✅ Using recently completed pickup (within 60min) for store ${storeId}: ${recentCompletedPickup.id}, PUID: ${recentCompletedPickup.stop_id} — delivery should be in_transit`);
            return Response.json({ 
                puid: recentCompletedPickup.stop_id, 
                pickupId: recentCompletedPickup.id, 
                isNew: false, 
                pickup: recentCompletedPickup,
                deliveryStatus: 'in_transit'
            });
        }

        // 3) Check for any pending/other incomplete pickup for THIS STORE
        const isIncomplete = (p) => !['en_route','completed','cancelled','returned'].includes(p.status);
        let targetPickup = storePickups.find(p => isIncomplete(p) && (p.ampm_deliveries || 'AM') === primarySlot);
        if (!targetPickup) {
            targetPickup = storePickups.find(p => isIncomplete(p));
        }
        if (targetPickup) {
            console.log(`✅ Using existing incomplete pickup for store ${storeId}: ${targetPickup.id}, PUID: ${targetPickup.stop_id}`);
            return Response.json({ puid: targetPickup.stop_id, pickupId: targetPickup.id, isNew: false, pickup: targetPickup });
        }

        // Policy: Only auto-create a new pickup when this is the FIRST staged delivery for the driver on this date
        // Otherwise, callers should only ensure the patient's store pickup when needed
        if (!allowCreateIfMissing) {
            return Response.json({ puid: null, pickupId: null, isNew: false, skipAutoCreate: true });
        }

        // 3) No incomplete pickups — create a new one (even if prior pickups are completed)
        const chosenSlot = primarySlot;

        // Time helpers (use store's configured slot times; conservative fallbacks)
        const fallbackTimes = (slot) => slot === 'PM' ? { start: '15:00', end: '16:00' } : { start: '10:00', end: '11:00' };
        const getSlotTimes = (s, dow, slot) => {
          const safe = (v) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : null;
          if (dow >= 1 && dow <= 5) {
            return {
              start: safe(slot === 'AM' ? s?.weekday_am_start : s?.weekday_pm_start),
              end: safe(slot === 'AM' ? s?.weekday_am_end : s?.weekday_pm_end),
            };
          } else if (dow === 6) {
            return {
              start: safe(slot === 'AM' ? s?.saturday_am_start : s?.saturday_pm_start),
              end: safe(slot === 'AM' ? s?.saturday_am_end : s?.saturday_pm_end),
            };
          } else {
            return {
              start: safe(slot === 'AM' ? s?.sunday_am_start : s?.sunday_pm_start),
              end: safe(slot === 'AM' ? s?.sunday_am_end : s?.sunday_pm_end),
            };
          }
        };

        const times = getSlotTimes(store, dow, chosenSlot) || {};
        const delivery_time_start = times.start || fallbackTimes(chosenSlot).start;
        const delivery_time_end = times.end || fallbackTimes(chosenSlot).end;

        const puid = generateShortStopId();

        // Compute pickup TR#: StoreAbbrev + (20 * total_unique_pickups_in_slot + (-20))
        const slotPickups = allPickups.filter(p => !p.patient_id && (p.ampm_deliveries || 'AM') === chosenSlot);
        const uniqueStoreCount = new Set(slotPickups.map(p => p.store_id)).size;
        const totalPickupsAfterCreate = uniqueStoreCount + 1; // include this new pickup
        const baseNumber = totalPickupsAfterCreate * 20 - 20;
        const trackingNumber = `${store?.abbreviation || ''}${baseNumber}`;

        const newPickup = await base44.entities.Delivery.create({
            stop_id: puid,
            store_id: storeId,
            delivery_id: generateDeliveryId(),
            delivery_date: deliveryDate,
            driver_id: driverId,
            dispatcher_id: store?.dispatcher_id || null,
            ampm_deliveries: chosenSlot,
            status: 'en_route',
            delivery_time_start,
            delivery_time_end,
            tracking_number: trackingNumber
        });

        console.log(`🆕 Created new pickup ${newPickup.id} (PUID ${puid}) for ${chosenSlot}`);
        return Response.json({ puid, pickupId: newPickup.id, isNew: true, pickup: newPickup });

    } catch (error) {
        console.error('❌ Error in ensurePickupForDelivery:', error.message);
        return Response.json({ error: 'Failed to ensure pickup exists: ' + error.message }, { status: 500 });
    }
});