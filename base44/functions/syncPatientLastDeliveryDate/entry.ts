// Redeployed on 2026-03-28
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

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

const shiftDateString = (dateString, days) => {
  const [year, month, day] = dateString.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const shiftedYear = shifted.getUTCFullYear();
  const shiftedMonth = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const shiftedDay = String(shifted.getUTCDate()).padStart(2, '0');
  return `${shiftedYear}-${shiftedMonth}-${shiftedDay}`;
};

const resolvePatientLastDeliveryDate = (delivery) => {
  return (
    normalizeDateString(delivery?.actual_delivery_time) ||
    normalizeDateString(delivery?.arrival_time) ||
    normalizeDateString(delivery?.updated_date) ||
    normalizeDateString(delivery?.delivery_date) ||
    null
  );
};

const getPatientById = async (base44, patientId) => {
  const patients = await base44.asServiceRole.entities.Patient.filter({ id: patientId });
  return patients?.[0] || null;
};

const syncSingleDelivery = async (base44, delivery) => {
  console.log('ℹ️ [syncPatientLastDeliveryDate] syncSingleDelivery:start', {
    deliveryId: delivery?.id,
    patientId: delivery?.patient_id,
    status: delivery?.status,
    deliveryDate: delivery?.delivery_date,
    actualDeliveryTime: delivery?.actual_delivery_time,
    arrivalTime: delivery?.arrival_time,
    updatedDate: delivery?.updated_date
  });

  if (!delivery?.patient_id) {
    console.log('ℹ️ [syncPatientLastDeliveryDate] syncSingleDelivery:skip:no_patient');
    return { updated: false, reason: 'No patient linked' };
  }

  if (!TERMINAL_STATUSES.has(delivery.status)) {
    console.log('ℹ️ [syncPatientLastDeliveryDate] syncSingleDelivery:skip:not_terminal', { status: delivery?.status });
    return { updated: false, reason: 'Status not terminal' };
  }

  const resolvedDate = resolvePatientLastDeliveryDate(delivery);
  console.log('ℹ️ [syncPatientLastDeliveryDate] syncSingleDelivery:resolved_date', { resolvedDate });
  if (!resolvedDate) {
    return { updated: false, reason: 'No usable date found' };
  }

  const patient = await getPatientById(base44, delivery.patient_id);
  console.log('ℹ️ [syncPatientLastDeliveryDate] syncSingleDelivery:patient_lookup', {
    requestedPatientId: delivery.patient_id,
    foundPatientId: patient?.id,
    foundPatientName: patient?.full_name,
    currentLastDeliveryDateRaw: patient?.last_delivery_date
  });
  if (!patient) {
    return { updated: false, reason: 'Patient not found' };
  }

  const currentLastDeliveryDate = normalizeDateString(patient.last_delivery_date);
  const nextLastDeliveryDate =
    !currentLastDeliveryDate || resolvedDate > currentLastDeliveryDate
      ? resolvedDate
      : currentLastDeliveryDate;

  console.log('ℹ️ [syncPatientLastDeliveryDate] syncSingleDelivery:date_compare', {
    currentLastDeliveryDate,
    nextLastDeliveryDate,
    rawPatientLastDeliveryDate: patient.last_delivery_date
  });

  if (patient.last_delivery_date === nextLastDeliveryDate) {
    console.log('ℹ️ [syncPatientLastDeliveryDate] syncSingleDelivery:skip:already_current');
    return { updated: false, reason: 'Patient already has same/newer date', date: nextLastDeliveryDate };
  }

  console.log('ℹ️ [syncPatientLastDeliveryDate] syncSingleDelivery:updating_patient', {
    patientId: patient.id,
    nextLastDeliveryDate
  });

  await base44.asServiceRole.entities.Patient.update(patient.id, {
    last_delivery_date: nextLastDeliveryDate
  }).catch((error) => {
    console.error('❌ [syncPatientLastDeliveryDate] syncSingleDelivery:update_failed', {
      patientId: patient.id,
      nextLastDeliveryDate,
      error: error?.message,
      status: error?.status,
      responseStatus: error?.response?.status
    });
    if (isNotFoundError(error)) return null;
    throw error;
  });

  console.log('✅ [syncPatientLastDeliveryDate] syncSingleDelivery:updated', {
    patientId: patient.id,
    fullName: patient.full_name,
    nextLastDeliveryDate
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
  const todayEdmontonDate = getEdmontonDateString();
  const cutoffDate = shiftDateString(todayEdmontonDate, -(safeDays - 1));

  const deliveries = await base44.asServiceRole.entities.Delivery.list('-delivery_date', 5000);

  const latestByPatient = new Map();
  let deliveriesScanned = 0;

  for (const delivery of deliveries) {
    if (!delivery?.patient_id || !TERMINAL_STATUSES.has(delivery.status)) continue;

    const deliveryDate = normalizeDateString(delivery.delivery_date);
    if (!deliveryDate || deliveryDate < cutoffDate || deliveryDate > todayEdmontonDate) continue;

    const resolvedDate = resolvePatientLastDeliveryDate(delivery);
    if (!resolvedDate) continue;

    deliveriesScanned += 1;
    const existingDate = latestByPatient.get(delivery.patient_id);
    if (!existingDate || resolvedDate > existingDate) {
      latestByPatient.set(delivery.patient_id, resolvedDate);
    }
  }

  let updatedCount = 0;

  for (const [patientId, lastDeliveryDate] of latestByPatient.entries()) {
    const patient = await getPatientById(base44, patientId);
    if (!patient) continue;

    const currentLastDeliveryDate = normalizeDateString(patient.last_delivery_date);
    const nextLastDeliveryDate =
      !currentLastDeliveryDate || lastDeliveryDate > currentLastDeliveryDate
        ? lastDeliveryDate
        : currentLastDeliveryDate;

    if (patient.last_delivery_date === nextLastDeliveryDate) continue;

    await base44.asServiceRole.entities.Patient.update(patient.id, {
      last_delivery_date: nextLastDeliveryDate
    }).catch((error) => {
      if (isNotFoundError(error)) return null;
      throw error;
    });
    updatedCount += 1;
  }

  return Response.json({
    success: true,
    mode: 'backfill',
    backfillDays: safeDays,
    cutoffDate,
    deliveriesScanned,
    patientsMatched: latestByPatient.size,
    patientsUpdated: updatedCount
  });
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));

    console.log('ℹ️ [syncPatientLastDeliveryDate] request_received', {
      hasBackfillDays: !!payload?.backfillDays,
      eventType: payload?.event?.type,
      deliveryId: payload?.data?.id,
      patientId: payload?.data?.patient_id,
      status: payload?.data?.status,
      oldStatus: payload?.old_data?.status
    });

    if (payload?.backfillDays) {
      const user = await base44.auth.me();
      console.log('ℹ️ [syncPatientLastDeliveryDate] backfill_requested', {
        backfillDays: payload?.backfillDays,
        userId: user?.id,
        userRole: user?.role
      });
      if (!user || !['admin', 'App Owner'].includes(user.role)) {
        return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
      }
      return await runBackfill(base44, Number(payload.backfillDays));
    }

    const delivery = payload?.data;
    const oldDelivery = payload?.old_data;
    const eventType = payload?.event?.type;

    if (!delivery) {
      console.log('ℹ️ [syncPatientLastDeliveryDate] skip:no_delivery_payload');
      return Response.json({ skipped: true, reason: 'No delivery payload' });
    }

    if (!TERMINAL_STATUSES.has(delivery.status)) {
      console.log('ℹ️ [syncPatientLastDeliveryDate] skip:not_terminal', { status: delivery.status });
      return Response.json({ skipped: true, reason: 'Delivery not completed or failed' });
    }

    if (eventType === 'update' && oldDelivery?.status === delivery.status) {
      console.log('ℹ️ [syncPatientLastDeliveryDate] skip:status_unchanged', {
        eventType,
        status: delivery.status,
        oldStatus: oldDelivery?.status
      });
      return Response.json({ skipped: true, reason: 'Status did not change into terminal state' });
    }

    const result = await syncSingleDelivery(base44, delivery);
    console.log('✅ [syncPatientLastDeliveryDate] request_complete', result);
    return Response.json({ success: true, mode: 'delivery_sync', ...result });
  } catch (error) {
    console.error('❌ [syncPatientLastDeliveryDate] Error:', {
      message: error?.message,
      status: error?.status,
      responseStatus: error?.response?.status,
      stack: error?.stack
    });
    return Response.json({ error: error.message }, { status: 500 });
  }
});