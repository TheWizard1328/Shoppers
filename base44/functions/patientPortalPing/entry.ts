import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * patientPortalPing — public (no auth) presence heartbeat from the Patient Portal.
 *
 * The portal calls this every 30s while its tab is visible. Writes/upserts one
 * PatientPortalPresence record per patient (service-role, no WS broadcast —
 * dashboards poll patientPortalWatchers instead).
 *
 * Gate rule (owner spec Oct 23 2026): a presence row is only written when the
 * patient has a DELIVERY for the given date — the watcher indicator is
 * meaningful only for patients watching their delivery that day.
 *
 * Body: { patient_id, delivery_date }
 * Returns: { ok, watching }
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { patient_id, delivery_date } = await req.json();

    if (!patient_id || !delivery_date) {
      return Response.json({ ok: false, error: 'patient_id and delivery_date are required' }, { status: 400 });
    }

    // Verify the patient exists (prevents spoofed presence rows for random ids).
    let patient = null;
    try {
      patient = await base44.asServiceRole.entities.Patient.get(patient_id);
    } catch (_) {
      return Response.json({ ok: false, error: 'Patient not found' }, { status: 404 });
    }

    // Gate: patient must have a delivery for this date.
    const deliveries = await base44.asServiceRole.entities.Delivery.filter(
      { patient_id, delivery_date },
      '-created_date',
      20
    ).catch(() => []);

    const ACTIVE = ['in_transit', 'en_route', 'pending', 'staged'];
    const activeDelivery = (deliveries || []).find((d) => ACTIVE.includes(String(d?.status)));
    const delivery = activeDelivery || (deliveries || [])[0] || null;
    if (!delivery) {
      // No delivery that date — clear any stale presence so the driver stops
      // seeing a watcher for a day the patient isn't watching anymore.
      try {
        const stale = await base44.asServiceRole.entities.PatientPortalPresence.filter({ patient_id, delivery_date });
        for (const row of stale || []) {
          await base44.asServiceRole.entities.PatientPortalPresence.delete(row.id);
        }
      } catch (_) {}
      return Response.json({ ok: true, watching: false });
    }

    const now = new Date().toISOString();
    const record = {
      patient_id,
      patient_name: patient?.full_name || delivery.patient_name || '',
      driver_id: delivery.driver_id || '',
      driver_name: delivery.driver_name || '',
      store_id: delivery.store_id || '',
      store_name: delivery.store_name || '',
      delivery_date,
      last_ping_at: now,
    };

    // Upsert: one presence row per patient.
    let existing = null;
    try {
      const rows = await base44.asServiceRole.entities.PatientPortalPresence.filter({ patient_id });
      existing = (rows || [])[0] || null;
    } catch (_) {}

    if (existing) {
      await base44.asServiceRole.entities.PatientPortalPresence.update(existing.id, record);
    } else {
      await base44.asServiceRole.entities.PatientPortalPresence.create(record);
    }

    return Response.json({ ok: true, watching: true });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});
