import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const isNotFoundError = (error) => error?.status === 404 || error?.response?.status === 404 || String(error?.message || '').toLowerCase().includes('not found');

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

const getEdmontonDateString = (value = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Edmonton',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(value));
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
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
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
};

const resolvePatientLastDeliveryDate = (delivery) => {
  return normalizeDateString(delivery?.actual_delivery_time) ||
    normalizeDateString(delivery?.arrival_time) ||
    normalizeDateString(delivery?.updated_date) ||
    normalizeDateString(delivery?.delivery_date) || null;
};

const getPatientById = async (base44, patientId) => {
  const patients = await base44.asServiceRole.entities.Patient.filter({ id: patientId });
  return patients?.[0] || null;
};

// Build a delivery_history entry from a delivery record
const buildHistoryEntry = (delivery) => ({
  id: delivery.id,
  delivery_date: delivery.delivery_date || resolvePatientLastDeliveryDate(delivery),
  actual_delivery_time: delivery.actual_delivery_time || null,
  status: delivery.status
});

// Append entry to history array (newest first, sorted)
const appendToHistory = (existingHistory, entry) => {
  const history = Array.isArray(existingHistory) ? [...existingHistory] : [];
  // Avoid duplicate entries (same delivery ID)
  const existingIdx = history.findIndex(h => h.id === entry.id);
  if (existingIdx !== -1) {
    history[existingIdx] = entry; // update in place
  } else {
    history.unshift(entry);
  }
  history.sort((a, b) => {
    const aDate = a.delivery_date || '';
    const bDate = b.delivery_date || '';
    if (aDate !== bDate) return bDate.localeCompare(aDate);
    const aTime = a.actual_delivery_time || '';
    const bTime = b.actual_delivery_time || '';
    return bTime.localeCompare(aTime);
  });
  return history;
};

const syncSingleDelivery = async (base44, delivery) => {
  if (!delivery?.patient_id) return { updated: false, reason: 'No patient linked' };
  if (!TERMINAL_STATUSES.has(delivery.status)) return { updated: false, reason: 'Status not terminal' };

  const resolvedDate = resolvePatientLastDeliveryDate(delivery);
  if (!resolvedDate) return { updated: false, reason: 'No usable date found' };

  const patient = await getPatientById(base44, delivery.patient_id);
  if (!patient) return { updated: false, reason: 'Patient not found' };

  const currentLastDeliveryDate = normalizeDateString(patient.last_delivery_date);
  const nextLastDeliveryDate = !currentLastDeliveryDate || resolvedDate > currentLastDeliveryDate
    ? resolvedDate : currentLastDeliveryDate;

  // Build and append history entry
  const historyEntry = buildHistoryEntry(delivery);
  const newHistory = appendToHistory(patient.delivery_history, historyEntry);

  await base44.asServiceRole.entities.Patient.update(patient.id, {
    delivery_history: newHistory,
    last_delivery_date: nextLastDeliveryDate
  }).catch((error) => {
    if (isNotFoundError(error)) return null;
    throw error;
  });

  return { updated: true, patientId: patient.id, fullName: patient.full_name, date: resolvedDate };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runBackfill = async (base44, backfillDays) => {
  const safeDays = Number.isFinite(backfillDays) ? Math.max(1, Math.min(365, backfillDays)) : 90;
  const todayEdmontonDate = getEdmontonDateString();
  const cutoffDate = shiftDateString(todayEdmontonDate, -(safeDays - 1));

  const [deliveries, allPatients] = await Promise.all([
    base44.asServiceRole.entities.Delivery.list('-delivery_date', 5000),
    base44.asServiceRole.entities.Patient.list('full_name', 5000),
  ]);

  const patientMap = new Map(allPatients.map((p) => [p.id, p]));
  // Group deliveries by patient for full history building
  const deliveriesByPatient = new Map();
  let deliveriesScanned = 0;

  for (const delivery of deliveries) {
    if (!delivery?.patient_id || !TERMINAL_STATUSES.has(delivery.status)) continue;
    const deliveryDate = normalizeDateString(delivery.delivery_date);
    if (!deliveryDate || deliveryDate < cutoffDate || deliveryDate > todayEdmontonDate) continue;
    deliveriesScanned += 1;
    if (!deliveriesByPatient.has(delivery.patient_id)) deliveriesByPatient.set(delivery.patient_id, []);
    deliveriesByPatient.get(delivery.patient_id).push(delivery);
  }

  let updatedCount = 0;
  for (const [patientId, patientDeliveries] of deliveriesByPatient.entries()) {
    const patient = patientMap.get(patientId);
    if (!patient) continue;

    // Build full history array from all matched deliveries
    let history = Array.isArray(patient.delivery_history) ? [...patient.delivery_history] : [];
    for (const d of patientDeliveries) {
      const entry = buildHistoryEntry(d);
      history = appendToHistory(history, entry);
    }

    const lastDate = history.length > 0 ? history[0].delivery_date : null;

    await base44.asServiceRole.entities.Patient.update(patientId, {
      delivery_history: history,
      last_delivery_date: lastDate
    }).catch((error) => {
      if (isNotFoundError(error)) return null;
      throw error;
    });
    updatedCount += 1;
    await sleep(200);
  }

  return Response.json({
    success: true, mode: 'backfill', backfillDays: safeDays,
    cutoffDate, deliveriesScanned, patientsMatched: deliveriesByPatient.size, patientsUpdated: updatedCount
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

    if (!delivery) return Response.json({ skipped: true, reason: 'No delivery payload' });
    if (!TERMINAL_STATUSES.has(delivery.status)) return Response.json({ skipped: true, reason: 'Delivery not completed or failed' });
    if (eventType === 'update' && oldDelivery?.status === delivery.status) {
      return Response.json({ skipped: true, reason: 'Status did not change into terminal state' });
    }

    const result = await syncSingleDelivery(base44, delivery);
    return Response.json({ success: true, mode: 'delivery_sync', ...result });
  } catch (e) {
    console.error('❌ [syncPatientLastDeliveryDate] error', e?.message || e);
    return Response.json({ error: e?.message || 'Unknown error' }, { status: 500 });
  }
});
