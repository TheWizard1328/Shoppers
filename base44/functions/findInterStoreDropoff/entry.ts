import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const containsISP = (value) => String(value || '').toLowerCase().includes('(isp)') || String(value || '').toLowerCase().includes('isp');
const containsISD = (value) => {
  const normalized = String(value || '').toLowerCase();
  return normalized.includes('interstore drop off') || normalized.includes('interstore dropoff') || normalized.includes('(isd)') || normalized.includes('isd');
};
const normalizeValue = (value) => String(value || '').trim().toLowerCase();

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

    const storeMatches = delivery.store_id
      ? await base44.asServiceRole.entities.Store.filter({ id: delivery.store_id }, '-created_date', 1)
      : [];
    const store = storeMatches?.[0] || null;

    const isInterStorePickup =
      containsISP(delivery.patient_name) ||
      containsISP(delivery.delivery_notes) ||
      containsISP(patient?.full_name) ||
      containsISP(patient?.address) ||
      containsISP(store?.name) ||
      containsISP(store?.address);

    if (!isInterStorePickup || !delivery.store_id) {
      return Response.json({ success: true, match: null, isInterStorePickup: false });
    }

    if (!store) {
      return Response.json({ success: true, match: null, isInterStorePickup: true });
    }

    const targetStoreId = patient?.store_id;
    const normalizedStoreAddress = normalizeValue(store?.address);

    if (!targetStoreId || !normalizedStoreAddress) {
      return Response.json({ success: true, isInterStorePickup: true, match: null });
    }

    const storePatients = await base44.asServiceRole.entities.Patient.filter({ store_id: targetStoreId });
    const candidates = (storePatients || []).filter((item) => {
      const isIsdCandidate = containsISD(item?.full_name) || containsISD(item?.address) || containsISD(item?.notes);
      return item?.store_id === targetStoreId && isIsdCandidate;
    });
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