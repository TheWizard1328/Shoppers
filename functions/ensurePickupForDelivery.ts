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

        // CRITICAL: Find all existing pickups for this driver to determine next tracking number
        // Pickups are multiples of 20 (0, 20, 40, 60, 80, 100, etc.)
        const allDriverPickups = await base44.entities.Delivery.filter({
            driver_id: driverId,
            delivery_date: deliveryDate
        });

        // Filter to only pickups (no patient_id) and extract tracking numbers
        const pickupTrackingNumbers = allDriverPickups
            .filter(d => !d.patient_id && d.tracking_number)
            .map(d => {
                // Remove any letters to get numeric part
                const numericPart = d.tracking_number.replace(/[A-Za-z]/g, '');
                return parseInt(numericPart, 10);
            })
            .filter(num => !isNaN(num));

        // Find the largest tracking number
        const maxTrackingNumber = pickupTrackingNumbers.length > 0 
            ? Math.max(...pickupTrackingNumbers)
            : (store?.base_tracking_number || 0) - 20; // Subtract 20 so first pickup gets base_tracking_number

        // New pickup gets max + 20 (no store abbreviation prefix)
        const newTrackingNumber = maxTrackingNumber + 20;

        console.log(`🔢 [ensurePickup] Pickup TR# calculation: max=${maxTrackingNumber}, new=${newTrackingNumber}`);

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
            tracking_number: String(newTrackingNumber), // CRITICAL: Generated tracking number (e.g., 100)
            store_phone: store?.phone || '',
            delivery_notes: `Auto-created pickup for new ${ampmDeliveries} delivery`,
            isNextDelivery: false
        };

        const newPickup = await base44.entities.Delivery.create(newPickupData);
        console.log(`✅ Created new pickup: ${newPickup.id}, PUID: ${newPickup.stop_id}`);

        return Response.json({ 
            puid: newPickup.stop_id,
            pickupId: newPickup.id,
            isNew: true,
            pickup: newPickup // Return full pickup object
        });

    } catch (error) {
        console.error('❌ Error in ensurePickupForDelivery:', error.message);
        return Response.json({ error: 'Failed to ensure pickup exists: ' + error.message }, { status: 500 });
    }
});