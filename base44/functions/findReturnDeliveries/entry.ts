import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    const returnPatientMap = new Map<string, any>();
    try {
      const allPatients = await base44.entities.Patient.filter({}).catch(() => []);
      (allPatients || []).forEach((p: any) => {
        if (p.full_name && p.full_name.toLowerCase().includes('return')) {
          returnPatientMap.set(p.id, { full_name: p.full_name, store_id: p.store_id });
        }
      });
    } catch (e) {}

    const returnPatientIds = Array.from(returnPatientMap.keys());
    
    // Fetch deliveries for each return patient
    let allReturnDeliveries: any[] = [];
    for (const pid of returnPatientIds) {
      const deliveries = await base44.entities.Delivery.filter({ patient_id: pid }).catch(() => []);
      allReturnDeliveries = allReturnDeliveries.concat(deliveries || []);
    }
    
    // Also scan completed for (rtn) in notes
    const completed = await base44.entities.Delivery.filter({ status: 'completed' }).catch(() => []);
    const rtnInNotes = (completed || []).filter((d: any) => 
      (d.delivery_notes || '').toLowerCase().includes('(rtn)')
    );
    
    // Combine, deduplicate
    const allSet = new Map<string, any>();
    for (const d of allReturnDeliveries) allSet.set(d.id, d);
    for (const d of rtnInNotes) allSet.set(d.id, d);
    
    // Filter to 2026 only AND problematic only
    const problematic2026 = Array.from(allSet.values()).filter((d: any) => {
      // Must be 2026
      if (!d.delivery_date || !d.delivery_date.startsWith('2026')) return false;
      
      const notes = (d.delivery_notes || '').toLowerCase();
      const hasRTN = notes.includes('(rtn)');
      const rp = d.patient_id ? returnPatientMap.get(d.patient_id) : null;
      const isRP = !!rp;
      
      // Problematic conditions:
      if (hasRTN && !isRP) return true; // A: (RTN) but no return patient
      if (isRP && rp.store_id && d.store_id && rp.store_id !== d.store_id) return true; // B: store mismatch
      if (isRP && !hasRTN) return true; // C: return patient but missing (RTN)
      if (d.status !== 'completed') return true; // D: not completed
      return false;
    });
    
    const results = problematic2026.map((d: any) => {
      const notes = (d.delivery_notes || '').toLowerCase();
      const hasRTN = notes.includes('(rtn)');
      const rp = d.patient_id ? returnPatientMap.get(d.patient_id) : null;
      const isRP = !!rp;
      
      let issue = '';
      if (hasRTN && !isRP) issue = 'A: (RTN) but no return patient';
      else if (isRP && rp.store_id && d.store_id && rp.store_id !== d.store_id) issue = `B: store mismatch (${rp.full_name})`;
      else if (isRP && !hasRTN) issue = `C: missing (RTN) marker (${rp.full_name})`;
      else if (d.status !== 'completed') issue = `D: status=${d.status}`;
      
      return {
        date: d.delivery_date,
        driver: d.driver_name || 'Unknown',
        stop_order: d.stop_order,
        delivery_id: d.delivery_id,
        issue,
        notes: (d.delivery_notes || '').substring(0, 60),
      };
    });
    
    // Sort by date desc, then stop_order
    results.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (a.stop_order || 0) - (b.stop_order || 0));
    
    return Response.json({ count: results.length, results });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
