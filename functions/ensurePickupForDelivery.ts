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

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();

        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { storeId, deliveryDate, driverId, ampmDeliveries: requestedAmpm = null } = await req.json();

        if (!storeId || !deliveryDate || !driverId) {
            return Response.json({ error: 'Missing required parameters: storeId, deliveryDate, driverId' }, { status: 400 });
        }

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

        // Determine AM/PM: default to AM unless PM explicitly requested
        const now = new Date();
        const primarySlot = requestedAmpm === 'PM' ? 'PM' : 'AM';

        console.log(`🔍 Ensuring pickup (store-scoped): store=${storeId}, date=${deliveryDate}, driver=${driverId}, primarySlot=${primarySlot}`);

        // Fetch ALL pickups for this driver/date (AM + PM) for numbering purposes
        const allPickups = await base44.entities.Delivery.filter({
            delivery_date: deliveryDate,
            driver_id: driverId
        }, '-created_date', 200);

        const isIncomplete = (p) => !p.patient_id && !['completed','cancelled','returned'].includes(p.status);

        // Focus selection ONLY on this store
        const storePickups = allPickups.filter(p => p.store_id === storeId);

        // 1) Prefer an incomplete pickup for THIS STORE that matches the primary slot
        let targetPickup = storePickups.find(p => isIncomplete(p) && (p.ampm_deliveries || 'AM') === primarySlot);
        // 2) Otherwise, take any incomplete pickup for THIS STORE (other slot)
        if (!targetPickup) {
            targetPickup = storePickups.find(p => isIncomplete(p));
        }
        if (targetPickup) {
            console.log(`✅ Using existing incomplete pickup for store ${storeId}: ${targetPickup.id}, PUID: ${targetPickup.stop_id}`);
            return Response.json({ puid: targetPickup.stop_id, pickupId: targetPickup.id, isNew: false, pickup: targetPickup });
        }

        // 3) No incomplete pickups — create a new one (even if prior pickups are completed)
        const chosenSlot = primarySlot;

        // Time helpers
        const pad = (n) => String(n).padStart(2, '0');
        const toHHMM = (mins) => `${pad(Math.floor((mins % (24*60)) / 60))}:${pad(mins % 60)}`;

        const todayStr = new Date().toISOString().split('T')[0];
        let startMinutes;

        if (deliveryDate === todayStr) {
            // Today: start between now and 21:00 (clamped to 21:00)
            const minutesNow = now.getHours() * 60 + now.getMinutes();
            const clampMax = 21 * 60; // 21:00
            startMinutes = Math.min(minutesNow, clampMax);
        } else if (deliveryDate < todayStr) {
            // Past date: start at last completed time + 5 minutes (fallback 10:00)
            const completed = await base44.entities.Delivery.filter({
                driver_id: driverId,
                delivery_date: deliveryDate,
                status: 'completed'
            }, '-updated_date', 200);

            let baseMinutes = 10 * 60; // 10:00 default
            if (completed && completed.length > 0) {
                const times = completed
                  .map(d => d.actual_delivery_time)
                  .filter(Boolean)
                  .map(t => { try { const dt = new Date(t); return dt.getHours()*60 + dt.getMinutes(); } catch { return null; }})
                  .filter(v => v !== null);
                if (times.length > 0) baseMinutes = Math.max(...times) + 5;
            }
            startMinutes = baseMinutes;
        } else {
            // Future date: default 10:00
            startMinutes = 10 * 60;
        }

        const delivery_time_start = toHHMM(startMinutes);
        const delivery_time_end = toHHMM(startMinutes + 60);

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
            delivery_date: deliveryDate,
            driver_id: driverId,
            ampm_deliveries: chosenSlot,
            status: 'Staged',
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