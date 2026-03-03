import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);

    const { driverId, deliveryDate } = await req.json();

    if (!driverId || !deliveryDate) {
      return Response.json({ error: 'Missing required parameters: driverId, deliveryDate' }, { status: 400 });
    }

    // Use user scope if authenticated; otherwise service role (e.g., if called by automation)
    const api = user ? base44 : base44.asServiceRole;

    // Load all deliveries for this driver/date that have a patient and are not finished
    const finished = new Set(['completed', 'failed', 'cancelled', 'returned']);
    const deliveries = await api.entities.Delivery.filter({ driver_id: driverId, delivery_date: deliveryDate }, '-created_date', 1000);
    const activePatientDeliveries = deliveries.filter(d => d.patient_id && !finished.has(d.status || 'pending'));

    if (activePatientDeliveries.length === 0) {
      return Response.json({ updated: 0, message: 'No active patient deliveries to sync' });
    }

    // Fetch patients in bulk
    const patientIds = [...new Set(activePatientDeliveries.map(d => d.patient_id))];
    const patients = await api.entities.Patient.filter({ id: { $in: patientIds } }, '-updated_date', patientIds.length);
    const pMap = new Map(patients.map(p => [p.id, p]));

    // Prepare and apply patches
    let updatedCount = 0;
    for (const d of activePatientDeliveries) {
      const p = pMap.get(d.patient_id);
      if (!p) continue;

      const patch = {
        patient_name: p.full_name || null,
        patient_phone: p.phone || null,
        unit_number: p.unit_number || null,
        delivery_instructions: p.notes || null,
        mailbox_ok: !!p.mailbox_ok,
        call_upon_arrival: !!p.call_upon_arrival,
        ring_bell: p.dont_ring_bell ? false : (typeof p.ring_bell === 'boolean' ? p.ring_bell : true),
        dont_ring_bell: !!p.dont_ring_bell,
        back_door: !!p.back_door,
      };

      // Time window alignment (if patient has a preferred window)
      if (typeof p.time_window_start === 'string' && p.time_window_start.length >= 4) {
        patch.delivery_time_start = p.time_window_start;
      }
      if (typeof p.time_window_end === 'string' && p.time_window_end.length >= 4) {
        patch.delivery_time_end = p.time_window_end;
      }

      await api.entities.Delivery.update(d.id, patch);
      updatedCount += 1;
    }

    // Recalculate ETAs to immediately reflect any GPS/time window changes
    try {
      await api.functions.invoke('calculateRealTimeETA', {
        driverId,
        deliveryDate,
        currentLocalTime: null,
      });
    } catch (e) {
      console.warn('[syncRoutePatients] ETA recalculation failed or deferred:', e?.message || e);
    }

    return Response.json({ success: true, updated: updatedCount, deliveriesProcessed: activePatientDeliveries.length });
  } catch (error) {
    return Response.json({ error: error.message || 'Failed to sync route patient data' }, { status: 500 });
  }
});