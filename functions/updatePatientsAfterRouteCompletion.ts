import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // CRITICAL: Only admins can trigger this function
    if (user.role !== 'admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
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

    if (deliveries.length === 0) {
      return Response.json({ 
        success: true, 
        message: 'No deliveries found for this date',
        patientsUpdated: 0
      });
    }

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

    // Update each patient
    for (const patientId of patientIds) {
      try {
        const patient = await base44.asServiceRole.entities.Patient.filter({ id: patientId });
        if (!patient || patient.length === 0) continue;

        const currentPatient = patient[0];
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

    console.log(`✅ [UpdatePatients] Complete - Updated ${updatedCount} patients (${activatedCount} activated)`);

    return Response.json({
      success: true,
      deliveryDate,
      patientsUpdated: updatedCount,
      patientsActivated: activatedCount,
      totalDeliveries: deliveries.length
    });
  } catch (error) {
    console.error('❌ [UpdatePatients] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});