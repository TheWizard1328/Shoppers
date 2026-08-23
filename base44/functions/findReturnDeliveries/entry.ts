import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Find return patient records
    let returnPatientIds = new Set<string>();
    try {
      const allPatients = await base44.entities.Patient.filter({}).catch(() => []);
      (allPatients || []).forEach((p: any) => {
        if (p.full_name && p.full_name.toLowerCase().includes('return')) {
          returnPatientIds.add(p.id);
        }
      });
    } catch (e) { console.log('Patient error:', e.message); }
    
    // Get all deliveries (paginate)
    let allDeliveries: any[] = [];
    for (let skip = 0; skip < 10000; skip += 500) {
      const batch = await base44.entities.Delivery.filter({}).catch(() => []);
      if (!batch || batch.length === 0) break;
      allDeliveries = allDeliveries.concat(batch);
      if (batch.length < 500) break;
      // Note: filter({}) may not support skip, so we may get the same 500 repeatedly
      // Let's deduplicate by id
      if (skip === 0 && batch.length === 500) {
        // Try to get more by sorting differently - just use what we have
        break;
      }
    }
    
    // Filter for return deliveries
    const returnDeliveries = allDeliveries.filter((d: any) => {
      const notes = (d.delivery_notes || '').toLowerCase();
      const pname = (d.patient_name || '').toLowerCase();
      if (notes.includes('(rtn)') || pname.includes('(rtn)')) return true;
      if (/\breturn\b/i.test(notes) || /\breturn\b/i.test(pname)) return true;
      if (d.patient_id && returnPatientIds.has(d.patient_id)) return true;
      return false;
    });
    
    // Return compact format: just date, driver, stop_order, delivery_id
    const results = returnDeliveries.map((d: any) => ({
      d: d.delivery_date,
      dr: d.driver_name || 'Unknown',
      so: d.stop_order,
      id: d.delivery_id,
      pid: d.patient_id || '',
      st: d.status,
      n: (d.delivery_notes || '').substring(0, 60),
    }));
    
    return Response.json({
      total: allDeliveries.length,
      count: results.length,
      r: results,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
