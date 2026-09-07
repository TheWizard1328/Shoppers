// Lightweight in-flight tracker for the per-patient history backfill fired
// from PatientForm after an edit. Only the just-edited patient's card shows
// a spinner on its Edit button while the backfill is running.
//
// Flow: PatientForm calls startPatientHistoryBackfill(patientId) right before
// firing the two background invokes, then finishPatientHistoryBackfill(id)
// in the finally block. PatientCard subscribes via subscribePatientHistoryBackfill
// and flips its Edit button into a spinner while its patient id is in flight.

const START_EVENT = 'patientHistoryBackfillStarted';
const FINISH_EVENT = 'patientHistoryBackfillFinished';

let inFlightId = null;

export const startPatientHistoryBackfill = (patientId) => {
  if (!patientId) return;
  inFlightId = patientId;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(START_EVENT, { detail: { patientId } }));
  }
};

export const finishPatientHistoryBackfill = (patientId) => {
  if (inFlightId === patientId) inFlightId = null;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(FINISH_EVENT, { detail: { patientId } }));
  }
};

export const getInFlightPatientId = () => inFlightId;

export const subscribePatientHistoryBackfill = (cb) => {
  if (typeof window === 'undefined') return () => {};
  const onStart = (e) => cb(e.detail?.patientId || null);
  const onFinish = () => cb(inFlightId); // inFlightId already cleared by finish if it matched
  window.addEventListener(START_EVENT, onStart);
  window.addEventListener(FINISH_EVENT, onFinish);
  // Fire immediately with current state so a card mounting mid-flight picks it up.
  cb(inFlightId);
  return () => {
    window.removeEventListener(START_EVENT, onStart);
    window.removeEventListener(FINISH_EVENT, onFinish);
  };
};