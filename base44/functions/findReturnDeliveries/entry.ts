import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Build return patient lookup
    const returnPatientMap = new Map<string, any>();
    try {
      const allPatients = await base44.entities.Patient.filter({}).catch(() => []);
      (allPatients || []).forEach((p: any) => {
        if (p.full_name && p.full_name.toLowerCase().includes('return')) {
          returnPatientMap.set(p.id, { full_name: p.full_name, store_id: p.store_id });
        }
      });
    } catch (e) { console.log('Patient error:', e.message); }
    
    const returnPatientIds = Array.from(returnPatientMap.keys());
    
    // For each return patient, fetch ALL their deliveries
    let allReturnDeliveries: any[] = [];
    for (const pid of returnPatientIds) {
      try {
        const deliveries = await base44.entities.Delivery.filter({ patient_id: pid }).catch(() => []);
        allReturnDeliveries = allReturnDeliveries.concat(deliveries || []);
      } catch (e) { console.log(`Error fetching deliveries for patient ${pid}:`, e.message); }
    }
    
    // Also get all deliveries and scan for (rtn) in notes (might have deliveries without return patient link)
    // We'll need to paginate through all deliveries
    let allDeliveries: any[] = [];
    // Try using filter with status completed to get completed deliveries
    const completed = await base44.entities.Delivery.filter({ status: 'completed' }).catch(() => []);
    allDeliveries = completed || [];
    
    // Also get failed ones (return deliveries might have failed status)
    const failed = await base44.entities.Delivery.filter({ status: 'failed' }).catch(() => []);
    allDeliveries = allDeliveries.concat(failed || []);
    
    // Also get cancelled ones
    const cancelled = await base44.entities.Delivery.filter({ status: 'cancelled' }).catch(() => []);
    allDeliveries = allDeliveries.concat(cancelled || []);
    
    // Deduplicate by id
    const seen = new Set<string>();
    allDeliveries = allDeliveries.filter((d: any) => {
      if (seen.has(d.id)) return false;
      seen.add(d.id);
      return true;
    });
    
    // Find deliveries with (rtn) in notes that are NOT linked to return patients
    const rtnInNotes = allDeliveries.filter((d: any) => {
      const notes = (d.delivery_notes || '').toLowerCase();
      return notes.includes('(rtn)');
    });
    
    // Combine: return patient deliveries + (rtn) in notes deliveries
    const allReturnSet = new Map<string, any>();
    for (const d of allReturnDeliveries) allReturnSet.set(d.id, d);
    for (const d of rtnInNotes) allReturnSet.set(d.id, d);
    
    const allReturns = Array.from(allReturnSet.values());
    
    // Identify problematic ones
    const problematic = allReturns.filter((d: any) => {
      const notes = (d.delivery_notes || '').toLowerCase();
      const hasRTN = notes.includes('(rtn)');
      const returnPatient = d.patient_id ? returnPatientMap.get(d.patient_id) : null;
      const isReturnPatient = !!returnPatient;
      
      // A: Has (rtn) but no return patient link
      if (hasRTN && !isReturnPatient) return true;
      // B: Return patient store doesn't match delivery store
      if (isReturnPatient && returnPatient.store_id && d.store_id && returnPatient.store_id !== d.store_id) return true;
      // C: Has return patient but missing (rtn) marker
      if (isReturnPatient && !hasRTN) return true;
      // D: Not completed status
      if (d.status && d.status !== 'completed') return true;
      return false;
    });
    
    const results = problematic.map((d: any) => {
      const returnPatient = d.patient_id ? returnPatientMap.get(d.patient_id) : null;
      const notes = (d.delivery_notes || '').toLowerCase();
      const hasRTN = notes.includes('(rtn)');
      const isReturnPatient = !!returnPatient;
      
      let issue = '';
      if (hasRTN && !isReturnPatient) issue = 'A: (RTN) in notes but no return patient link';
      else if (isReturnPatient && returnPatient.store_id && d.store_id && returnPatient.store_id !== d.store_id) issue = `B: store mismatch (${returnPatient.full_name}→${returnPatient.store_id?.slice(-4)}, delivery→${d.store_id?.slice(-4)})`;
      else if (isReturnPatient && !hasRTN) issue = `C: return patient (${returnPatient.full_name}) but missing (RTN)`;
      else if (d.status !== 'completed') issue = `D: status=${d.status}`;
      
      return {
        d: d.delivery_date,
        dr: d.driver_name || 'Unknown',
        so: d.stop_order,
        id: d.delivery_id,
        pid: d.patient_id || '(none)',
        st: d.status,
        issue,
        rp: returnPatient ? returnPatient.full_name : '(none)',
        n: (d.delivery_notes || '').substring(0, 80),
      };
    });
    
    return Response.json({
      total_returns: allReturns.length,
      problematic_count: results.length,
      total_scanned: allDeliveries.length,
      results,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
