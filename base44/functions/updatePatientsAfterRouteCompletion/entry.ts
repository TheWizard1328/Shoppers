import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

const getEdmontonDateString = (value = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Edmonton',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value));

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
};

const normalizeDateString = (value) => {
  if (!value) return null;

  if (typeof value === 'string') {
    const isoMatch = value.match(/\d{4}-\d{2}-\d{2}/);
    if (isoMatch) return isoMatch[0];

    const legacyMatch = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (legacyMatch) {
      const [, month, day, year] = legacyMatch;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
  }

  return null;
};

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
      const sixMonthsAgoStr = getEdmontonDateString(sixMonthsAgo);
      
      const activePatients = await base44.asServiceRole.entities.Patient.filter({
        status: 'active'
      });
      
      let deactivatedCount = 0;
      
      for (const patient of activePatients) {
        try {
          const normalizedLastDeliveryDate = normalizeDateString(patient.last_delivery_date);
          if (!normalizedLastDeliveryDate) continue;

          const updateData = {};
          if (patient.last_delivery_date !== normalizedLastDeliveryDate) {
            updateData.last_delivery_date = normalizedLastDeliveryDate;
          }

          if (normalizedLastDeliveryDate < sixMonthsAgoStr) {
            updateData.status = 'inactive';
            deactivatedCount++;
            console.log(`⏸️ Deactivating: ${patient.full_name} (last delivery: ${normalizedLastDeliveryDate})`);
          }

          if (Object.keys(updateData).length === 0) continue;
          
          await base44.asServiceRole.entities.Patient.update(patient.id, updateData).catch((error) => {
            if (isNotFoundError(error)) return null;
            throw error;
          });
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

    const normalizedDeliveryDate = normalizeDateString(deliveryDate);
    if (!normalizedDeliveryDate) {
      return Response.json({ error: 'deliveryDate must be a valid date' }, { status: 400 });
    }

    console.log(`🔄 [UpdatePatients] Processing completed routes for ${normalizedDeliveryDate}${driverId ? ` (driver: ${driverId})` : ''}`);

    // Get deliveries for this date (optionally filtered by driver)
    const filter = { delivery_date: normalizedDeliveryDate };
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
        const currentLastDeliveryDate = normalizeDateString(currentPatient.last_delivery_date);
        const nextLastDeliveryDate =
          !currentLastDeliveryDate || normalizedDeliveryDate > currentLastDeliveryDate
            ? normalizedDeliveryDate
            : currentLastDeliveryDate;

        const updateData = {};

        if (currentPatient.last_delivery_date !== nextLastDeliveryDate) {
          updateData.last_delivery_date = nextLastDeliveryDate;
        }

        // Activate patient if currently inactive
        if (currentPatient.status === 'inactive') {
          updateData.status = 'active';
          activatedCount++;
          console.log(`✅ Activating patient: ${currentPatient.full_name}`);
        }

        if (Object.keys(updateData).length === 0) {
          continue;
        }

        await base44.asServiceRole.entities.Patient.update(patientId, updateData).catch((error) => {
          if (isNotFoundError(error)) return null;
          throw error;
        });
        updatedCount++;
      } catch (error) {
        console.error(`❌ Failed to update patient ${patientId}:`, error.message);
      }
    }

    console.log(`✅ [UpdatePatients] Route completion - Updated ${updatedCount} patients, Activated ${activatedCount}`);

    return Response.json({
      success: true,
      mode: 'routeCompletion',
      deliveryDate: normalizedDeliveryDate,
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