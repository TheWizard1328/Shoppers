import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';
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
        const ampmDeliveries = requestedAmpm || (currentHour < 14 ? 'AM' : 'PM');

        console.log(`🔍 Checking for incomplete pickup: store=${storeId}, date=${deliveryDate}, driver=${driverId}, ampm=${ampmDeliveries}`);

        // CRITICAL: Preliminary check - does this specific store already have ANY deliveries for this driver on this date?
        const allStoreDeliveries = await base44.entities.Delivery.filter({
            store_id: storeId,
            delivery_date: deliveryDate,
            driver_id: driverId
        });

        if (allStoreDeliveries.length === 0) {
            console.log(`⏭️ [ensurePickup] No existing deliveries for store ${storeId} - skipping auto-pickup creation (first delivery for this store)`);
            return Response.json({ 
                puid: null,
                pickupId: null,
                isNew: false,
                skipAutoCreate: true
            });
        }

        // 1. Check for an existing incomplete pickup for this store, date, driver, and AM/PM slot
        const existingPickups = await base44.entities.Delivery.filter({
            store_id: storeId,
            delivery_date: deliveryDate,
            driver_id: driverId,
            ampm_deliveries: ampmDeliveries
        }, '-created_date', 20);

        // Find pickups (no patient_id) that are incomplete
        const incompletePickup = existingPickups.find(p => 
            !p.patient_id && 
            p.status !== 'completed' && 
            p.status !== 'cancelled' && 
            p.status !== 'returned'
        );

        if (incompletePickup) {
            console.log(`✅ Found existing incomplete pickup: ${incompletePickup.id}, PUID: ${incompletePickup.stop_id}`);
            return Response.json({ 
                puid: incompletePickup.stop_id,
                pickupId: incompletePickup.id,
                isNew: false 
            });
        }

        // 2. No incomplete pickup exists - do NOT auto-create; Dashboard will handle pickup creation
        console.log(`⏭️ [ensurePickup] No incomplete pickup; skipping auto-create for store ${storeId}`);
        return Response.json({
            puid: null,
            pickupId: null,
            isNew: false,
            skipAutoCreate: true
        });

        // Removed auto-create block

    } catch (error) {
        console.error('❌ Error in ensurePickupForDelivery:', error.message);
        return Response.json({ error: 'Failed to ensure pickup exists: ' + error.message }, { status: 500 });
    }
});