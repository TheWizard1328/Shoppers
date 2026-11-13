/**
 * Patient delivery history utilities.
 * Provides read/append/clear helpers for the delivery_history array on Patient records.
 * During transition, read helpers fall back to last_delivery_date when delivery_history is empty.
 */

/**
 * Get the most recent delivery date from a patient record.
 * Uses delivery_history[0] (newest first), falls back to last_delivery_date.
 * @param {Object} patient - Patient entity record
 * @returns {string|null} YYYY-MM-DD date string or null
 */
export function getLastDeliveryDate(patient) {
  if (!patient) return null;
  if (patient.delivery_history && patient.delivery_history.length > 0) {
    return patient.delivery_history[0].delivery_date || null;
  }
  // Fallback during transition
  return patient.last_delivery_date || null;
}

/**
 * Check if this is a first-time patient (no delivery history).
 * Uses delivery_history array, falls back to last_delivery_date.
 * @param {Object} patient - Patient entity record
 * @returns {boolean} true if patient has never had a delivery
 */
export function isFirstDeliveryPatient(patient) {
  if (!patient) return true;
  if (patient.delivery_history && patient.delivery_history.length > 0) {
    return false;
  }
  // Fallback during transition
  return !patient.last_delivery_date;
}

/**
 * Build a new delivery_history entry for appending.
 * @param {string} deliveryId - Delivery entity record ID (Base44 ObjectId)
 * @param {string} deliveryDate - Scheduled delivery date (YYYY-MM-DD)
 * @param {string|null} actualDeliveryTime - ISO timestamp of actual completion
 * @param {string} status - Terminal status: 'completed', 'failed', or 'returned'
 * @returns {Object} History entry object
 */
export function buildHistoryEntry(deliveryId, deliveryDate, actualDeliveryTime, status) {
  return {
    id: deliveryId,
    delivery_date: deliveryDate || null,
    actual_delivery_time: actualDeliveryTime || null,
    status
  };
}

/**
 * OWNER FIX (Oct 19 2026): the history array is HARD-CAPPED. It used to grow
 * unbounded — Sarah Nicholle's Patient record hit 23.6KB of embedded history,
 * every status update rewrote + rebroadcast the whole blob, the platform
 * slimmed the oversize broadcast (fields >10KB emptied), and EVERY device
 * then re-fetched the full record (Patient.get) to fill the stub — heating
 * the shared pool and triggering the account-wide 429 storms. Every reader
 * only uses [0] / length / a short display list, so a cap of 20 newest
 * entries loses nothing; full history lives in the Delivery entity.
 */
export const MAX_HISTORY_ENTRIES = 20;

/**
 * HARD CAP for any delivery_history array bound for storage (Nov 13 2026).
 * Owner report: "those 20 get boosted back up to the full amount" every time a
 * delivery is picked up. The cap existed only on the append helpers; every
 * writer that copied an EXISTING array (patient updates built from the local
 * IDB record, the backfill runners, syncPatientLastDeliveryDate's own
 * appendToHistory copy, PatientForm edits) re-persisted the full array. Any
 * array leaving for IDB or the server now goes through this.
 */
export function capHistory(history, cap = MAX_HISTORY_ENTRIES) {
  if (!Array.isArray(history)) return [];
  const byId = new Map();
  for (const e of history) {
    if (!e) continue;
    const key = e.id || `${e.delivery_date || ''}|${e.actual_delivery_time || ''}|${e.status || ''}`;
    if (!byId.has(key)) byId.set(key, e);
  }
  const sorted = Array.from(byId.values()).sort((a, b) => {
    const ad = a.delivery_date || '';
    const bd = b.delivery_date || '';
    if (ad !== bd) return bd.localeCompare(ad);
    return String(b.actual_delivery_time || '').localeCompare(String(a.actual_delivery_time || ''));
  });
  return sorted.slice(0, Math.max(0, Number(cap) || MAX_HISTORY_ENTRIES));
}

/**
 * Append a new entry to a patient's delivery_history array (newest first).
 * Returns a new array — does not mutate the original.
 * @param {Array} existingHistory - Current delivery_history array
 * @param {Object} newEntry - History entry from buildHistoryEntry()
 * @returns {Array} New sorted array with entry at index 0, capped at MAX_HISTORY_ENTRIES
 */
// (Sep 23 2026) Cap on stored history entries. Long-running recurring patients
// accumulated 100+ entries, pushing Patient records past the realtime
// broadcast size limit (>10 KB) — every save then triggered "oversize slimmed"
// errors on every client in the fleet and oversize WS payloads (see Sep 23
// sluggishness incident, patient 68e1e249f45648303b222f9e). Older history is
// still derivable from the Delivery records themselves; the array is a
// convenience cache, not the source of truth. (Oct 19 2026: lowered 60 → 20 —
// 60 entries ≈ 24KB on long-history patients, which oversize-slims every
// broadcast and forces full-record Patient.get fetches on all devices.)

export function appendToHistory(existingHistory, newEntry) {
  const history = Array.isArray(existingHistory) ? [...existingHistory] : [];
  history.unshift(newEntry);
  // Keep sorted newest-first (in case dates don't sort naturally)
  history.sort((a, b) => {
    const aDate = a.delivery_date || '';
    const bDate = b.delivery_date || '';
    if (aDate !== bDate) return bDate.localeCompare(aDate);
    const aTime = a.actual_delivery_time || '';
    const bTime = b.actual_delivery_time || '';
    return bTime.localeCompare(aTime);
  });
  // Trim oldest entries beyond the cap (sort is newest-first).
  return capHistory(history);
}

/**
 * Get the full delivery history array from a patient record.
 * @param {Object} patient - Patient entity record
 * @returns {Array} Delivery history array (newest first), empty if none
 */
export function getDeliveryHistory(patient) {
  if (!patient) return [];
  return patient.delivery_history || [];
}

/**
 * Get the count of deliveries for a patient.
 * @param {Object} patient - Patient entity record
 * @returns {number} Total delivery count
 */
export function getDeliveryCount(patient) {
  return getDeliveryHistory(patient).length;
}
