import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));

    // Determine invocation context (direct call vs automation event)
    const isAutomation = !!payload?.event && !!payload?.event?.entity_name;

    let patientId = payload?.patientId || null;
    let deliveryDate = payload?.deliveryDate || null; // optional filter

    if (isAutomation && payload.event.entity_name === 'Patient') {
      patientId = patientId || payload.event.entity_id || payload?.data?.id || null;
    }

    if (!patientId) {
      return Response.json({ error: 'Missing patientId' }, { status: 400 });
    }

    // Prefer user-scoped when available; fallback to service role for automations
    let api = base44;
    try {
      const me = await base44.auth.me();
      if (!me) api = base44.asServiceRole;
    } catch {
      api = base44.asServiceRole;
    }

    // Load patient
    const patients = await api.entities.Patient.filter({ id: patientId }, '-updated_date', 1);
    const patient = patients?.[0];
    if (!patient) {
      return Response.json({ error: 'Patient not found' }, { status: 404 });
    }

    // Fetch candidate deliveries for this patient (limit sufficiently high)
    const deliveries = await api.entities.Delivery.filter({ patient_id: patientId }, '-created_date', 500);

    // Only update active/incomplete deliveries (pending/en_route/in_transit or no status)
    const activeStatuses = new Set(['pending', 'en_route', 'in_transit']);
    const toUpdate = deliveries.filter(d => activeStatuses.has(d?.status || 'pending') && (!deliveryDate || d.delivery_date === deliveryDate));

    if (toUpdate.length === 0) {
      return Response.json({ updated: 0, message: 'No active deliveries to sync' });
    }

    const patch = {
      patient_name: patient.full_name || null,
      patient_phone: patient.phone || null,
      unit_number: patient.unit_number || null,
      delivery_instructions: patient.notes || null,
      mailbox_ok: !!patient.mailbox_ok,
      call_upon_arrival: !!patient.call_upon_arrival,
      ring_bell: patient.dont_ring_bell ? false : (typeof patient.ring_bell === 'boolean' ? patient.ring_bell : true),
      dont_ring_bell: !!patient.dont_ring_bell,
      back_door: !!patient.back_door,
    };

    // Apply updates sequentially (SDK has per-record update)
    let count = 0;
    for (const d of toUpdate) {
      await api.entities.Delivery.update(d.id, patch);
      count += 1;
    }

    return Response.json({ updated: count, patient_id: patientId });
  } catch (error) {
    return Response.json({ error: error.message || 'Failed to sync patient data to deliveries' }, { status: 500 });
  }
});