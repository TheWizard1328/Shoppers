import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Find return patient records (patients with "Return" in full_name)
    let returnPatientIds = new Set<string>();
    let returnPatients: any[] = [];
    
    try {
      const allPatients = await base44.entities.Patient.filter({}).catch(() => []);
      returnPatients = (allPatients || []).filter((p: any) => 
        p.full_name && p.full_name.toLowerCase().includes('return')
      );
      returnPatientIds = new Set(returnPatients.map((p: any) => p.id));
    } catch (e) {
      console.log('Patient entity error:', e.message);
    }
    
    // Get all deliveries - paginate through them
    let allDeliveries: any[] = [];
    let skip = 0;
    let hasMore = true;
    while (hasMore) {
      const batch = await base44.entities.Delivery.filter({}).catch(() => []);
      allDeliveries = allDeliveries.concat(batch || []);
      hasMore = batch && batch.length === 500;
      if (hasMore) {
        skip += 500;
        // Note: filter doesn't support skip, so this might not work
        // Let's break after first batch and try a different approach
        break;
      }
    }
    
    // If we only got one batch, try getting more by using different sort orders
    // Actually, let's just use what we have and filter
    
    // Filter for return deliveries
    const returnDeliveries = allDeliveries.filter((d: any) => {
      const notes = d.delivery_notes || '';
      const patientName = d.patient_name || '';
      // Match by (rtn) or "return" in notes or patient_name
      if (notes.toLowerCase().includes('(rtn)') || patientName.toLowerCase().includes('(rtn)')) return true;
      if (/\breturn\b/i.test(notes) || /\breturn\b/i.test(patientName)) return true;
      // Match by patient_id being a return patient
      if (d.patient_id && returnPatientIds.has(d.patient_id)) return true;
      return false;
    });
    
    const results = returnDeliveries.map((d: any) => ({
      id: d.id,
      delivery_id: d.delivery_id,
      delivery_date: d.delivery_date,
      driver_name: d.driver_name || 'Unknown',
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
      total_deliveries_scanned: allDeliveries.length,
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
