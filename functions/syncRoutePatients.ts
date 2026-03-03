import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);

    const payload = await req.json().catch(() => ({}));
    const { driverId, deliveryDate, patientId: directPatientId } = payload || {};

    // Detect automation payload (Patient update)
    const isAutomation = !!payload?.event && payload?.event?.entity_name === 'Patient';
    const patientId = directPatientId || (isAutomation ? (payload?.event?.entity_id || payload?.data?.id) : null);

    // Choose API scope
    const api = user ? base44 : base44.asServiceRole;

    // Load deliveries to sync
    const finished = new Set(['completed', 'failed', 'cancelled', 'returned']);
    let deliveries = [];

    if (driverId && deliveryDate) {
      deliveries = await api.entities.Delivery.filter({ driver_id: driverId, delivery_date: deliveryDate }, '-created_date', 1000);
    } else if (patientId) {
      deliveries = await api.entities.Delivery.filter({ patient_id: patientId }, '-created_date', 500);
    } else {
      return Response.json({ error: 'Provide (driverId & deliveryDate) OR patientId (or trigger via Patient automation).' }, { status: 400 });
    }

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
    const etaGroups = new Set(); // unique key: driverId__deliveryDate

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

      // Align time windows from Patient when available
      if (typeof p.time_window_start === 'string' && p.time_window_start.length >= 4) {
        patch.delivery_time_start = p.time_window_start;
      }
      if (typeof p.time_window_end === 'string' && p.time_window_end.length >= 4) {
        patch.delivery_time_end = p.time_window_end;
      }

      await api.entities.Delivery.update(d.id, patch);
      updatedCount += 1;

      if (d.driver_id && d.delivery_date) {
        etaGroups.add(`${d.driver_id}__${d.delivery_date}`);
      }
    }

    // Attempt ETA recalculation for affected driver/date groups
    for (const key of etaGroups) {
      const [drv, date] = key.split('__');
      try {
        await api.functions.invoke('calculateRealTimeETA', {
          driverId: drv,
          deliveryDate: date,
          currentLocalTime: null,
        });
      } catch (e) {
        console.warn('[syncRoutePatients] ETA recalculation skipped:', e?.message || String(e));
      }
    }

    return Response.json({ success: true, updated: updatedCount, groupsProcessed: etaGroups.size });
  } catch (error) {
    return Response.json({ error: error.message || 'Failed to sync route patient data' }, { status: 500 });
  }
});