import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Find return patient records (patients with "Return" in full_name)
    let returnPatientIds = new Set<string>();
    let returnPatients: any[] = [];
    
    try {
      const allPatients = await base44.asServiceRole.entities.Patient.list({ limit: 500 });
      returnPatients = (allPatients || []).filter((p: any) => 
        p.full_name && p.full_name.toLowerCase().includes('return')
      );
      returnPatientIds = new Set(returnPatients.map((p: any) => p.id));
    } catch (e) {
      console.log('Patient entity not available or error:', e.message);
    }
    
    // Get all completed deliveries (paginated)
    let allDeliveries: any[] = [];
    let skip = 0;
    let hasMore = true;
    while (hasMore) {
      const batch = await base44.asServiceRole.entities.Delivery.list({ 
        limit: 500, 
        skip,
        sort: '-updated_date'
      });
      allDeliveries = allDeliveries.concat(batch || []);
      skip += 500;
      hasMore = batch && batch.length === 500;
      if (skip > 5000) break; // safety limit
    }
    
    // Filter for return deliveries
    const returnDeliveries = allDeliveries.filter((d: any) => {
      if (d.patient_id && returnPatientIds.has(d.patient_id)) return true;
      if (d.delivery_notes && /RTN/i.test(d.delivery_notes)) return true;
      if (d.patient_name && /Return/i.test(d.patient_name)) return true;
      return false;
    });
    
    const results = returnDeliveries.map((d: any) => ({
      id: d.id,
      delivery_id: d.delivery_id,
      delivery_date: d.delivery_date,
      driver_name: d.driver_name,
      driver_id: d.driver_id,
      stop_order: d.stop_order,
      patient_id: d.patient_id,
      patient_name: d.patient_name,
      status: d.status,
      store_id: d.store_id,
      delivery_notes: d.delivery_notes,
      puid: d.puid,
    }));
    
    return Response.json({
      success: true,
      count: results.length,
      return_patient_count: returnPatientIds.size,
      return_patients: returnPatients.map((p: any) => ({ id: p.id, full_name: p.full_name, store_id: p.store_id })),
      deliveries: results,
    });
  } catch (error) {
    console.error('Error finding return deliveries:', error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});
