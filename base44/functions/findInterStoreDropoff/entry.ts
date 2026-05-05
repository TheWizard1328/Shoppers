import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const containsISP = (value) => String(value || '').toLowerCase().includes('(isp)') || String(value || '').toLowerCase().includes('isp');
const containsISD = (value) => {
  const normalized = String(value || '').toLowerCase();
  return normalized.includes('interstore drop off') || normalized.includes('interstore dropoff') || normalized.includes('(isd)') || normalized.includes('isd');
};
const normalizeValue = (value) => String(value || '').trim().toLowerCase();
const tokenize = (value) => normalizeValue(value).split(/[^a-z0-9]+/).filter((token) => token.length >= 3);
const hasAddressSimilarity = (candidate, origin) => {
  const candidateValue = normalizeValue(candidate);
  const originValue = normalizeValue(origin);
  if (!candidateValue || !originValue) return false;
  if (candidateValue.includes(originValue) || originValue.includes(candidateValue)) return true;
  const originTokens = tokenize(originValue);
  if (originTokens.length === 0) return false;
  const sharedTokens = originTokens.filter((token) => candidateValue.includes(token));
  return sharedTokens.length >= Math.min(2, originTokens.length);
};

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

    const pickupMatches = delivery.puid
      ? await base44.asServiceRole.entities.Delivery.filter({ stop_id: delivery.puid }, '-created_date', 1)
      : [];
    const pickupDelivery = pickupMatches?.[0] || null;
    const targetStoreId = pickupDelivery?.store_id;

    if (!targetStoreId) {
      return Response.json({ success: true, isInterStorePickup: true, match: null });
    }

    const targetStoreMatches = await base44.asServiceRole.entities.Store.filter({ id: targetStoreId }, '-created_date', 1);
    const targetStore = targetStoreMatches?.[0] || null;
    const originStoreAddress = targetStore?.address || '';
    const originStoreName = targetStore?.name || '';
    const storePatients = await base44.asServiceRole.entities.Patient.filter({ store_id: targetStoreId });
    const candidates = (storePatients || [])
      .filter((item) => {
        const isIsdCandidate = containsISD(item?.full_name) || containsISD(item?.address) || containsISD(item?.notes);
        if (!isIsdCandidate || item?.store_id !== targetStoreId) return false;
        const similarToOrigin =
          hasAddressSimilarity(item?.address, originStoreAddress) ||
          hasAddressSimilarity(item?.full_name, originStoreAddress) ||
          hasAddressSimilarity(item?.notes, originStoreAddress) ||
          hasAddressSimilarity(item?.full_name, originStoreName) ||
          hasAddressSimilarity(item?.notes, originStoreName);
        return similarToOrigin;
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
        store_name: targetStore?.name || null,
        patient_id: match.patient_id
      } : null
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});