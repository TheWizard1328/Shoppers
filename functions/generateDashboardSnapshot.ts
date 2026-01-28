import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();

        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { snapshot_date, active_filters = {} } = await req.json();

        if (!snapshot_date) {
            return Response.json({ error: 'snapshot_date is required' }, { status: 400 });
        }

        // Fetch deliveries for the specified date
        const deliveries = await base44.asServiceRole.entities.Delivery.filter({ 
            delivery_date: snapshot_date 
        });

        // Fetch current driver locations (AppUsers with location data)
        const appUsers = await base44.asServiceRole.entities.AppUser.list();
        const driverLocations = appUsers
            .filter(au => au.current_latitude && au.current_longitude)
            .map(au => ({
                driver_id: au.user_id,
                driver_name: au.user_name,
                latitude: au.current_latitude,
                longitude: au.current_longitude,
                driver_status: au.driver_status,
                location_updated_at: au.location_updated_at
            }));

        // Create snapshot record
        const snapshot = await base44.asServiceRole.entities.DashboardSnapshot.create({
            timestamp: new Date().toISOString(),
            snapshot_date: snapshot_date,
            active_filters: active_filters,
            snapshot_data: {
                deliveries: deliveries.map(d => ({
                    id: d.id,
                    delivery_id: d.delivery_id,
                    driver_id: d.driver_id,
                    driver_name: d.driver_name,
                    patient_name: d.patient_name,
                    status: d.status,
                    delivery_date: d.delivery_date,
                    delivery_time_eta: d.delivery_time_eta,
                    stop_order: d.stop_order,
                    store_id: d.store_id
                })),
                driverLocations: driverLocations
            }
        });

        return Response.json({ 
            success: true, 
            snapshot_id: snapshot.id,
            timestamp: snapshot.timestamp
        });
    } catch (error) {
        console.error('Snapshot generation error:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});