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
    let allReturnDeliveries: any[] = [];
    for (const pid of returnPatientIds) {
      const deliveries = await base44.entities.Delivery.filter({ patient_id: pid }).catch(() => []);
      allReturnDeliveries = allReturnDeliveries.concat(deliveries || []);
    }
    const completed = await base44.entities.Delivery.filter({ status: 'completed' }).catch(() => []);
    const rtnInNotes = (completed || []).filter((d: any) => (d.delivery_notes || '').toLowerCase().includes('(rtn)'));
    
    const allSet = new Map<string, any>();
    for (const d of allReturnDeliveries) allSet.set(d.id, d);
    for (const d of rtnInNotes) allSet.set(d.id, d);
    
    const problematic2026 = Array.from(allSet.values()).filter((d: any) => {
      if (!d.delivery_date || !d.delivery_date.startsWith('2026')) return false;
      const notes = (d.delivery_notes || '').toLowerCase();
      const hasRTN = notes.includes('(rtn)');
      const rp = d.patient_id ? returnPatientMap.get(d.patient_id) : null;
      const isRP = !!rp;
      if (hasRTN && !isRP) return true;
      if (isRP && rp.store_id && d.store_id && rp.store_id !== d.store_id) return true;
      if (isRP && !hasRTN) return true;
      if (d.status !== 'completed') return true;
      return false;
    });
    
    // Separate by issue type
    const issueB = []; // store mismatch - most critical
    const issueA = []; // RTN but no patient link - critical
    const issueD = []; // not completed - critical
    const issueC = []; // missing RTN marker - cosmetic
    
    for (const d of problematic2026) {
      const notes = (d.delivery_notes || '').toLowerCase();
      const hasRTN = notes.includes('(rtn)');
      const rp = d.patient_id ? returnPatientMap.get(d.patient_id) : null;
      const isRP = !!rp;
      const row = `${d.delivery_date}|${d.driver_name||'?'}|Stop ${d.stop_order||'?'}|${d.delivery_id||'no-id'}`;
      
      if (hasRTN && !isRP) issueA.push(row);
      else if (isRP && rp.store_id && d.store_id && rp.store_id !== d.store_id) issueB.push(`${row}|${rp.full_name}`);
      else if (isRP && !hasRTN) issueC.push(`${row}|${rp.full_name}`);
      else if (d.status !== 'completed') issueD.push(`${row}|status=${d.status}`);
    }
    
    return Response.json({
      total_2026: problematic2026.length,
      A_rtn_no_patient: issueA.length,
      B_store_mismatch: issueB.length,
      C_missing_rtn: issueC.length,
      D_not_completed: issueD.length,
      issue_B: issueB,
      issue_A: issueA,
      issue_D: issueD,
      issue_C_sample: issueC.slice(0, 50),
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
