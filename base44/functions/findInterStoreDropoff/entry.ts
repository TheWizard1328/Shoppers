import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const containsISP = (value) => String(value || '').toLowerCase().includes('(isp)') || String(value || '').toLowerCase().includes('isp');

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { deliveryId } = await req.json();
    if (!deliveryId) {
      return Response.json({ error: 'deliveryId is required' }, { status: 400 });
    }

    const deliveryMatches = await base44.asServiceRole.entities.Delivery.filter({ id: deliveryId }, '-created_date', 1);
    const delivery = deliveryMatches?.[0] || null;

    if (!delivery) {
      return Response.json({ error: 'Delivery not found' }, { status: 404 });
    }

    const patientMatches = delivery.patient_id
      ? await base44.asServiceRole.entities.Patient.filter({ id: delivery.patient_id }, '-created_date', 1)
      : [];
    const patient = patientMatches?.[0] || null;

    const isInterStorePickup = containsISP(delivery.patient_name) || containsISP(delivery.delivery_notes) || containsISP(patient?.full_name) || containsISP(patient?.address);

    if (!isInterStorePickup || !delivery.store_id) {
      return Response.json({ success: true, match: null, isInterStorePickup: false });
    }

    const storePatients = await base44.asServiceRole.entities.Patient.filter({ store_id: delivery.store_id });
    const candidates = (storePatients || []).filter((item) => containsISP(item.full_name) || containsISP(item.address));
    const match = candidates[0] || null;

    return Response.json({
      success: true,
      isInterStorePickup: true,
      match: match ? {
        id: match.id,
        full_name: match.full_name,
        address: match.address,
        store_id: match.store_id,
        patient_id: match.patient_id
      } : null
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});