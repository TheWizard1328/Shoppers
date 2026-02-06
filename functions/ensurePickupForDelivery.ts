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

        // Determine AM/PM based on current time if not provided
        const now = new Date();
        const currentHour = now.getHours();
        const ampmDeliveries = requestedAmpm || (currentHour < 14 ? 'AM' : 'PM');

        console.log(`🔍 Checking for incomplete pickup: store=${storeId}, date=${deliveryDate}, driver=${driverId}, ampm=${ampmDeliveries}`);

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

        // 2. No incomplete pickup exists - create a new one for the new delivery
        console.log(`⚠️ No incomplete pickup found for store ${storeId}. Creating new pickup for new delivery.`);

        const newStopId = generateShortStopId();

        // Calculate pickup time: 5 minutes from now
        const pickupTime = new Date(now.getTime() + 5 * 60 * 1000);
        const pickupTimeStr = format(pickupTime, 'HH:mm');

        // Get driver name
        const appUsers = await base44.entities.AppUser.filter({ user_id: driverId });
        const driverName = appUsers[0]?.user_name || 'Unknown Driver';

        // Get store info for store_phone
        const stores = await base44.entities.Store.filter({ id: storeId });
        const store = stores[0];

        const newPickupData = {
            delivery_date: deliveryDate,
            store_id: storeId,
            driver_id: driverId,
            driver_name: driverName,
            status: 'en_route',
            delivery_time_start: pickupTimeStr,
            delivery_time_end: '',
            time_window_start: pickupTimeStr,
            time_window_end: '',
            ampm_deliveries: ampmDeliveries,
            puid: newStopId, // CRITICAL: PUID = pickup's own SID (stop_id)
            stop_id: newStopId, // 3-character short ID (e.g., "k3E")
            delivery_stop_id: newStopId,
            store_phone: store?.phone || '',
            delivery_notes: `Auto-created pickup for new ${ampmDeliveries} delivery`,
            isNextDelivery: false
        };

        const newPickup = await base44.entities.Delivery.create(newPickupData);
        console.log(`✅ Created new pickup: ${newPickup.id}, PUID: ${newPickup.stop_id}`);

        return Response.json({ 
            puid: newPickup.stop_id,
            pickupId: newPickup.id,
            isNew: true 
        });

    } catch (error) {
        console.error('❌ Error in ensurePickupForDelivery:', error.message);
        return Response.json({ error: 'Failed to ensure pickup exists: ' + error.message }, { status: 500 });
    }
});