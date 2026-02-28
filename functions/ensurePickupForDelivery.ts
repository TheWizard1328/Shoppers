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
        const specialStoreNames = ['Lakeland Ridge', 'Sherwood Pk Mall', 'SouthPoint', 'WestPark'];
        
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

        // Determine AM/PM based on current time if not provided
        const now = new Date();
        const currentHour = now.getHours();
        const primarySlot = requestedAmpm || (currentHour < 14 ? 'AM' : 'PM');

        console.log(`🔍 Ensuring pickup (both slots): store=${storeId}, date=${deliveryDate}, driver=${driverId}, primarySlot=${primarySlot}`);

        // Fetch ALL pickups for this store/date/driver (AM + PM)
        const allPickups = await base44.entities.Delivery.filter({
            store_id: storeId,
            delivery_date: deliveryDate,
            driver_id: driverId
        }, '-created_date', 50);

        const isIncomplete = (p) => !p.patient_id && !['completed','cancelled','returned'].includes(p.status);

        // 1) Prefer an incomplete pickup that matches the primary slot
        let targetPickup = allPickups.find(p => isIncomplete(p) && (p.ampm_deliveries || 'AM') === primarySlot);
        // 2) Otherwise, take any incomplete pickup (other slot)
        if (!targetPickup) {
            targetPickup = allPickups.find(p => isIncomplete(p));
        }
        if (targetPickup) {
            console.log(`✅ Using existing incomplete pickup: ${targetPickup.id}, PUID: ${targetPickup.stop_id}`);
            return Response.json({ puid: targetPickup.stop_id, pickupId: targetPickup.id, isNew: false });
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
        const newPickup = await base44.entities.Delivery.create({
            stop_id: puid,
            store_id: storeId,
            delivery_date: deliveryDate,
            driver_id: driverId,
            ampm_deliveries: chosenSlot,
            status: 'en_route',
            delivery_time_start,
            delivery_time_end
        });

        console.log(`🆕 Created new pickup ${newPickup.id} (PUID ${puid}) for ${chosenSlot}`);
        return Response.json({ puid, pickupId: newPickup.id, isNew: true, pickup: newPickup });

    } catch (error) {
        console.error('❌ Error in ensurePickupForDelivery:', error.message);
        return Response.json({ error: 'Failed to ensure pickup exists: ' + error.message }, { status: 500 });
    }
});