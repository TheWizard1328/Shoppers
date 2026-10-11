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
 * Append a new entry to a patient's delivery_history array (newest first).
 * Returns a new array — does not mutate the original.
 * @param {Array} existingHistory - Current delivery_history array
 * @param {Object} newEntry - History entry from buildHistoryEntry()
 * @returns {Array} New sorted array with entry at index 0
 */
// (Sep 23 2026) Cap on stored history entries. Long-running recurring patients
// accumulated 100+ entries, pushing Patient records past the realtime
// broadcast size limit (>10 KB) — every save then triggered "oversize slimmed"
// errors on every client in the fleet and oversize WS payloads (see Sep 23
// sluggishness incident, patient 68e1e249f45648303b222f9e). Older history is
// still derivable from the Delivery records themselves; the array is a
// convenience cache, not the source of truth.
const MAX_HISTORY_ENTRIES = 60;

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
  if (history.length > MAX_HISTORY_ENTRIES) history.length = MAX_HISTORY_ENTRIES;
  return history;
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
