import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

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

const extractDateString = (value) => {
  if (!value || typeof value !== 'string') return null;
  const match = value.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
};

const resolvePatientLastDeliveryDate = (delivery) => {
  return (
    extractDateString(delivery?.actual_delivery_time) ||
    extractDateString(delivery?.arrival_time) ||
    extractDateString(delivery?.updated_date) ||
    extractDateString(delivery?.delivery_date) ||
    null
  );
};

const getPatientById = async (base44, patientId) => {
  const patients = await base44.asServiceRole.entities.Patient.filter({ id: patientId });
  return patients?.[0] || null;
};

const syncSingleDelivery = async (base44, delivery) => {
  if (!delivery?.patient_id) {
    return { updated: false, reason: 'No patient linked' };
  }

  if (!TERMINAL_STATUSES.has(delivery.status)) {
    return { updated: false, reason: 'Status not terminal' };
  }

  const resolvedDate = resolvePatientLastDeliveryDate(delivery);
  if (!resolvedDate) {
    return { updated: false, reason: 'No usable date found' };
  }

  const patient = await getPatientById(base44, delivery.patient_id);
  if (!patient) {
    return { updated: false, reason: 'Patient not found' };
  }

  if (patient.last_delivery_date && patient.last_delivery_date >= resolvedDate) {
    return { updated: false, reason: 'Patient already has same/newer date', date: resolvedDate };
  }

  await base44.asServiceRole.entities.Patient.update(patient.id, {
    last_delivery_date: resolvedDate
  });

  return {
    updated: true,
    patientId: patient.id,
    fullName: patient.full_name,
    date: resolvedDate
  };
};

const runBackfill = async (base44, backfillDays) => {
  const safeDays = Number.isFinite(backfillDays) ? Math.max(1, Math.min(365, backfillDays)) : 90;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (safeDays - 1));
  const cutoffDate = getEdmontonDateString(cutoff);

  const deliveries = await base44.asServiceRole.entities.Delivery.filter({
    delivery_date: { $gte: cutoffDate }
  }, '-delivery_date', 5000);

  const latestByPatient = new Map();

  for (const delivery of deliveries) {
    if (!delivery?.patient_id || !TERMINAL_STATUSES.has(delivery.status)) continue;

    const resolvedDate = resolvePatientLastDeliveryDate(delivery);
    if (!resolvedDate) continue;

    const existingDate = latestByPatient.get(delivery.patient_id);
    if (!existingDate || resolvedDate > existingDate) {
      latestByPatient.set(delivery.patient_id, resolvedDate);
    }
  }

  let updatedCount = 0;

  for (const [patientId, lastDeliveryDate] of latestByPatient.entries()) {
    const patient = await getPatientById(base44, patientId);
    if (!patient) continue;
    if (patient.last_delivery_date && patient.last_delivery_date >= lastDeliveryDate) continue;

    await base44.asServiceRole.entities.Patient.update(patient.id, {
      last_delivery_date: lastDeliveryDate
    });
    updatedCount += 1;
  }

  return Response.json({
    success: true,
    mode: 'backfill',
    backfillDays: safeDays,
    cutoffDate,
    deliveriesScanned: deliveries.length,
    patientsMatched: latestByPatient.size,
    patientsUpdated: updatedCount
  });
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));

    if (payload?.backfillDays) {
      const user = await base44.auth.me();
      if (!user || !['admin', 'App Owner'].includes(user.role)) {
        return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
      }
      return await runBackfill(base44, Number(payload.backfillDays));
    }

    const delivery = payload?.data;
    const oldDelivery = payload?.old_data;
    const eventType = payload?.event?.type;

    if (!delivery) {
      return Response.json({ skipped: true, reason: 'No delivery payload' });
    }

    if (!TERMINAL_STATUSES.has(delivery.status)) {
      return Response.json({ skipped: true, reason: 'Delivery not completed or failed' });
    }

    if (eventType === 'update' && oldDelivery?.status === delivery.status) {
      return Response.json({ skipped: true, reason: 'Status did not change into terminal state' });
    }

    const result = await syncSingleDelivery(base44, delivery);
    return Response.json({ success: true, mode: 'delivery_sync', ...result });
  } catch (error) {
    console.error('❌ [syncPatientLastDeliveryDate] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});