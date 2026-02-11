import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await req.json();
    const { cityId, deliveryDate } = payload;

    if (!cityId || !deliveryDate) {
      return Response.json({ 
        error: 'Missing required fields: cityId and deliveryDate are required' 
      }, { status: 400 });
    }

    console.log(`🎯 [Targeted Refresh] Starting for city: ${cityId}, date: ${deliveryDate}`);

    // STEP 1: Get all stores in the selected city
    const cityStores = await base44.asServiceRole.entities.Store.filter({ city_id: cityId });
    const cityStoreIds = cityStores.map(s => s.id);
    
    console.log(`🏪 [Targeted Refresh] Found ${cityStoreIds.length} stores in city`);

    // STEP 2: Fetch all deliveries for the selected date and city stores
    // Use $in operator for efficient filtering
    const deliveries = cityStoreIds.length > 0 
      ? await base44.asServiceRole.entities.Delivery.filter({ 
          delivery_date: deliveryDate,
          store_id: { $in: cityStoreIds }
        })
      : [];
    
    console.log(`📦 [Targeted Refresh] Found ${deliveries.length} deliveries`);

    // STEP 3: Get unique patient IDs from deliveries
    const uniquePatientIds = [...new Set(
      deliveries
        .filter(d => d?.patient_id)
        .map(d => d.patient_id)
    )];

    // Fetch related patients (only those referenced in deliveries)
    let patients = [];
    if (uniquePatientIds.length > 0) {
      patients = await base44.asServiceRole.entities.Patient.filter({ 
        id: { $in: uniquePatientIds } 
      });
      console.log(`👥 [Targeted Refresh] Found ${patients.length} patients`);
    }

    // STEP 4: Get ALL drivers in the city (not just assigned to deliveries)
    let appUsers = [];
    try {
      // Fetch ALL AppUsers with city_ids matching this city
      appUsers = await base44.asServiceRole.entities.AppUser.filter({ 
        city_ids: { $in: [cityId] }
      });
      console.log(`🚗 [Targeted Refresh] Found ${appUsers.length} drivers assigned to city`);
    } catch (error) {
      console.warn(`⚠️ [Targeted Refresh] Failed to fetch drivers by city, fetching all: ${error.message}`);
      // Fallback: fetch all AppUsers and filter by city
      const allAppUsers = await base44.asServiceRole.entities.AppUser.list();
      appUsers = allAppUsers.filter(au => 
        au?.city_ids?.includes(cityId) || au?.city_id === cityId
      );
      console.log(`🚗 [Targeted Refresh] Filtered ${appUsers.length} drivers from all users`);
    }
    
    console.log(`🚗 [Targeted Refresh] Found ${appUsers.length} drivers with locations`);

    // STEP 5: Return stores from step 1 (already filtered by city)
    console.log(`🏪 [Targeted Refresh] Returning ${cityStores.length} stores`);

    // STEP 6: Return complete dataset
    return Response.json({
      success: true,
      data: {
        deliveries,
        patients,
        appUsers,
        stores: cityStores
      },
      metadata: {
        deliveryCount: deliveries.length,
        patientCount: patients.length,
        driverCount: appUsers.length,
        storeCount: cityStores.length,
        cityId,
        deliveryDate
      }
    });

  } catch (error) {
    console.error('❌ [Targeted Refresh] Error:', error);
    return Response.json({ 
      success: false,
      error: error.message 
    }, { status: 500 });
  }
});