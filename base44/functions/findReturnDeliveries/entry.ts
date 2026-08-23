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
      } catch (e) {}
    }
    
    // Also scan completed deliveries for (rtn) in notes
    const completed = await base44.entities.Delivery.filter({ status: 'completed' }).catch(() => []);
    const rtnInNotes = (completed || []).filter((d: any) => 
      (d.delivery_notes || '').toLowerCase().includes('(rtn)')
    );
    
    // Combine by delivery id
    const allReturnSet = new Map<string, any>();
    for (const d of allReturnDeliveries) allReturnSet.set(d.id, d);
    for (const d of rtnInNotes) allReturnSet.set(d.id, d);
    
    const allReturns = Array.from(allReturnSet.values());
    
    // Categorize issues
    const issues = { A: 0, B: 0, C: 0, D: 0 };
    const byDriver = {};
    const issueA = []; // (RTN) but no return patient
    const issueB = []; // store mismatch
    const issueD = []; // not completed
    
    for (const d of allReturns) {
      const notes = (d.delivery_notes || '').toLowerCase();
      const hasRTN = notes.includes('(rtn)');
      const rp = d.patient_id ? returnPatientMap.get(d.patient_id) : null;
      const isRP = !!rp;
      const driver = d.driver_name || 'Unknown';
      
      if (hasRTN && !isRP) { issues.A++; issueA.push({ d: d.delivery_date, dr: driver, so: d.stop_order, id: d.delivery_id, n: (d.delivery_notes||'').substring(0,60) }); }
      else if (isRP && rp.store_id && d.store_id && rp.store_id !== d.store_id) { issues.B++; issueB.push({ d: d.delivery_date, dr: driver, so: d.stop_order, id: d.delivery_id, rp: rp.full_name, n: (d.delivery_notes||'').substring(0,60) }); }
      else if (isRP && !hasRTN) { issues.C++; byDriver[driver] = (byDriver[driver]||0)+1; }
      else if (d.status !== 'completed') { issues.D++; issueD.push({ d: d.delivery_date, dr: driver, so: d.stop_order, id: d.delivery_id, st: d.status, n: (d.delivery_notes||'').substring(0,60) }); }
    }
    
    return Response.json({
      total_returns: allReturns.length,
      issue_counts: issues,
      issue_A_RTN_no_patient: issueA,
      issue_B_store_mismatch: issueB,
      issue_D_not_completed: issueD,
      issue_C_by_driver: byDriver,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
