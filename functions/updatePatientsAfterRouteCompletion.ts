import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { deliveryDate } = await req.json();

    if (!deliveryDate) {
      return Response.json({ error: 'deliveryDate is required' }, { status: 400 });
    }

    console.log(`🔄 [UpdatePatients] Processing completed routes for ${deliveryDate}`);

    // Get all deliveries for this date
    const deliveries = await base44.asServiceRole.entities.Delivery.filter({
      delivery_date: deliveryDate
    });

    // Get unique patient IDs from completed/failed deliveries
    const patientIds = new Set();
    deliveries.forEach(d => {
      if (d.patient_id && (d.status === 'completed' || d.status === 'failed')) {
        patientIds.add(d.patient_id);
      }
    });

    console.log(`📦 Found ${patientIds.size} unique patients with completed/failed deliveries`);

    let updatedCount = 0;
    let activatedCount = 0;

    // Update each patient with delivery on this date
    for (const patientId of patientIds) {
      try {
        const patients = await base44.asServiceRole.entities.Patient.filter({ id: patientId });
        if (!patients || patients.length === 0) continue;

        const currentPatient = patients[0];
        const updateData = {
          last_delivery_date: deliveryDate
        };

        // Activate patient if currently inactive
        if (currentPatient.status === 'inactive') {
          updateData.status = 'active';
          activatedCount++;
          console.log(`✅ Activating patient: ${currentPatient.full_name}`);
        }

        await base44.asServiceRole.entities.Patient.update(patientId, updateData);
        updatedCount++;
      } catch (error) {
        console.error(`❌ Failed to update patient ${patientId}:`, error.message);
      }
    }

    // PART 2: Deactivate patients with no delivery in 6+ months
    console.log(`🔍 [UpdatePatients] Checking for inactive patients (6+ months since last delivery)...`);
    
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const sixMonthsAgoStr = sixMonthsAgo.toISOString().split('T')[0];
    
    // Get all active patients
    const activePatients = await base44.asServiceRole.entities.Patient.filter({
      status: 'active'
    });
    
    let deactivatedCount = 0;
    
    for (const patient of activePatients) {
      try {
        // Skip if no last_delivery_date (new patient)
        if (!patient.last_delivery_date) continue;
        
        // Skip if delivered within last 6 months
        if (patient.last_delivery_date >= sixMonthsAgoStr) continue;
        
        // Deactivate patient
        await base44.asServiceRole.entities.Patient.update(patient.id, { status: 'inactive' });
        deactivatedCount++;
        console.log(`⏸️ Deactivating patient: ${patient.full_name} (last delivery: ${patient.last_delivery_date})`);
      } catch (error) {
        console.error(`❌ Failed to deactivate patient ${patient.id}:`, error.message);
      }
    }

    console.log(`✅ [UpdatePatients] Complete - Updated ${updatedCount} patients, Activated ${activatedCount}, Deactivated ${deactivatedCount}`);

    return Response.json({
      success: true,
      deliveryDate,
      patientsUpdated: updatedCount,
      patientsActivated: activatedCount,
      patientsDeactivated: deactivatedCount,
      totalDeliveries: deliveries.length
    });
  } catch (error) {
    console.error('❌ [UpdatePatients] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});