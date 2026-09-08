// Per-patient history backfill queue, fired from PatientForm AFTER the form
// has closed. Owns the backfillPatientHistory → syncPatientLastDeliveryDate
// invokes so they survive the form unmount and run serialized: back-to-back
// edits queue up instead of overlapping. The edited patient's card shows a
// spinner on its Edit button while its slot is queued or in flight.

import { base44 } from '@/api/base44Client';

const START_EVENT = 'patientHistoryBackfillStarted';
const FINISH_EVENT = 'patientHistoryBackfillFinished';
const QUEUE_EVENT = 'patientHistoryBackfillQueue';

let inFlightId = null;
const queue = [];
let processing = false;

const dispatch = (name, detail = {}) => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }
};

const processQueue = async () => {
  if (processing) return;
  processing = true;
  while (queue.length > 0) {
    const patientId = queue.shift();
    dispatch(QUEUE_EVENT, { queue: queue.slice() });
    inFlightId = patientId;
    dispatch(START_EVENT, { patientId });
    try {
      await base44.functions.invoke('backfillPatientHistory', { patient_id: patientId });
      await base44.functions.invoke('syncPatientLastDeliveryDate', { patient_id: patientId });
    } catch (err) {
      console.warn('⚠️ [patientHistoryBackfill] failed for', patientId, err?.message || err);
    } finally {
      if (inFlightId === patientId) inFlightId = null;
      dispatch(FINISH_EVENT, { patientId });
    }
  }
  processing = false;
};

export const enqueuePatientHistoryBackfill = (patientId) => {
  if (!patientId) return;
  // Skip if already running or already queued
  if (inFlightId !== patientId && !queue.includes(patientId)) {
    queue.push(patientId);
    dispatch(QUEUE_EVENT, { queue: queue.slice() });
  }
  processQueue();
};

export const getInFlightPatientId = () => inFlightId;
export const getQueuedPatientIds = () => queue.slice();

// cb(inFlightId, queuedIds) — fires on start, finish, enqueue, and on subscribe.
// A card is "working" when its patient id is in-flight OR in the queue.
export const subscribePatientHistoryBackfill = (cb) => {
  if (typeof window === 'undefined') return () => {};
  const onStart = (e) => cb(e.detail?.patientId || null, queue.slice());
  const onFinish = () => cb(inFlightId, queue.slice());
  const onQueue = (e) => cb(inFlightId, e.detail?.queue || queue.slice());
  window.addEventListener(START_EVENT, onStart);
  window.addEventListener(FINISH_EVENT, onFinish);
  window.addEventListener(QUEUE_EVENT, onQueue);
  cb(inFlightId, queue.slice());
  return () => {
    window.removeEventListener(START_EVENT, onStart);
    window.removeEventListener(FINISH_EVENT, onFinish);
    window.removeEventListener(QUEUE_EVENT, onQueue);
  };
};