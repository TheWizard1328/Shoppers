import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { deliveryDate, driverId, runDailyCleanup } = await req.json();

    // Mode 1: Daily cleanup - deactivate patients with no delivery in 6+ months
    if (runDailyCleanup === true) {
      console.log('🧹 [UpdatePatients] Running daily cleanup - deactivating stale patients...');
      
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      const sixMonthsAgoStr = sixMonthsAgo.toISOString().split('T')[0];
      
      const activePatients = await base44.asServiceRole.entities.Patient.filter({
        status: 'active'
      });
      
      let deactivatedCount = 0;
      
      for (const patient of activePatients) {
        try {
          if (!patient.last_delivery_date) continue;
          if (patient.last_delivery_date >= sixMonthsAgoStr) continue;
          
          await base44.asServiceRole.entities.Patient.update(patient.id, { status: 'inactive' });
          deactivatedCount++;
          console.log(`⏸️ Deactivating: ${patient.full_name} (last delivery: ${patient.last_delivery_date})`);
        } catch (error) {
          console.error(`❌ Failed to deactivate ${patient.id}:`, error.message);
        }
      }
      
      console.log(`✅ [UpdatePatients] Daily cleanup complete - Deactivated ${deactivatedCount} patients`);
      return Response.json({
        success: true,
        mode: 'dailyCleanup',
        patientsDeactivated: deactivatedCount,
        cutoffDate: sixMonthsAgoStr
      });
    }

    // Mode 2: Route completion - update patients after driver completes route
    if (!deliveryDate) {
      return Response.json({ error: 'deliveryDate is required' }, { status: 400 });
    }

    console.log(`🔄 [UpdatePatients] Processing completed routes for ${deliveryDate}${driverId ? ` (driver: ${driverId})` : ''}`);

    // Get deliveries for this date (optionally filtered by driver)
    const filter = { delivery_date: deliveryDate };
    if (driverId) {
      filter.driver_id = driverId;
    }
    const deliveries = await base44.asServiceRole.entities.Delivery.filter(filter);

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

    console.log(`✅ [UpdatePatients] Route completion - Updated ${updatedCount} patients, Activated ${activatedCount}`);

    return Response.json({
      success: true,
      mode: 'routeCompletion',
      deliveryDate,
      driverId: driverId || null,
      patientsUpdated: updatedCount,
      patientsActivated: activatedCount,
      totalDeliveries: deliveries.length
    });
  } catch (error) {
    console.error('❌ [UpdatePatients] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});