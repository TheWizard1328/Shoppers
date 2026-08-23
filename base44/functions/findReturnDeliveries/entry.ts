import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Build return patient lookup: id -> {full_name, store_id}
    const returnPatientMap = new Map<string, any>();
    try {
      const allPatients = await base44.entities.Patient.filter({}).catch(() => []);
      (allPatients || []).forEach((p: any) => {
        if (p.full_name && p.full_name.toLowerCase().includes('return')) {
          returnPatientMap.set(p.id, { full_name: p.full_name, store_id: p.store_id });
        }
      });
    } catch (e) { console.log('Patient error:', e.message); }
    
    // Get all deliveries
    const allDeliveries = await base44.entities.Delivery.filter({}).catch(() => []);
    
    // Identify return deliveries strictly:
    // 1. patient_id matches a return patient record, OR
    // 2. delivery_notes contains "(rtn)" (the specific marker from returnDeliveryBuilder)
    // NOT using broad \breturn\b match (catches false positives)
    const returnDeliveries = (allDeliveries || []).filter((d: any) => {
      const notes = (d.delivery_notes || '').toLowerCase();
      if (notes.includes('(rtn)')) return true;
      if (d.patient_id && returnPatientMap.has(d.patient_id)) return true;
      return false;
    });
    
    // Now identify PROBLEMATIC ones:
    // A) Has (rtn) in notes but patient_id doesn't match a return patient (missing or wrong patient link)
    // B) Has return patient_id but store_id doesn't match the return patient's store
    // C) Has return patient_id but no (rtn) in notes (inconsistent marking)
    // D) Status is not "completed" (return deliveries should be completed)
    const problematic = returnDeliveries.filter((d: any) => {
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
    
    // Also find deliveries that DON'T match return criteria but have "return" in patient_name
    // (these might be misidentified returns)
    const suspectByName = (allDeliveries || []).filter((d: any) => {
      if (returnDeliveries.includes(d)) return false; // already counted
      const pname = (d.patient_name || '').toLowerCase();
      return pname.includes('return') && !!d.patient_id;
    });
    
    const results = problematic.map((d: any) => {
      const returnPatient = d.patient_id ? returnPatientMap.get(d.patient_id) : null;
      const notes = (d.delivery_notes || '').toLowerCase();
      const hasRTN = notes.includes('(rtn)');
      const isReturnPatient = !!returnPatient;
      
      let issue = '';
      if (hasRTN && !isReturnPatient) issue = 'A: has (RTN) but no return patient link';
      else if (isReturnPatient && returnPatient.store_id && d.store_id && returnPatient.store_id !== d.store_id) issue = `B: store mismatch (patient store=${returnPatient.store_id}, delivery store=${d.store_id})`;
      else if (isReturnPatient && !hasRTN) issue = 'C: return patient but missing (RTN) marker';
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
      total_deliveries: allDeliveries.length,
      total_returns: returnDeliveries.length,
      problematic_count: results.length,
      suspect_by_name_count: suspectByName.length,
      return_patients: Array.from(returnPatientMap.entries()).map(([id, v]) => ({ id, ...v })),
      results,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
