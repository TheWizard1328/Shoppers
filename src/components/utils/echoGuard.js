/**
 * Content-aware echo detection for Delivery WebSocket events.
 *
 * PROBLEM (Robert, Sep 4 2026): time-based echo suppression
 * (window.__localDeliveryWrites) blocks ALL incoming WS events for a delivery
 * during the suppression window (15s legacy, 90-120s extended for Accept All /
 * Start / terminal actions). It cannot distinguish:
 *   (a) a true echo of THIS device's own server write, and
 *   (b) a GENUINE update from ANOTHER device (same user on phone + tablet,
 *       or another dispatcher) for the same delivery.
 *
 * Suppressing (b) left the device's IDB stale; the client-side
 * computeNextDeliveryState then pushed stale statuses back to the server,
 * reverting completions made by the other device minutes earlier.
 *
 * FIX: while inside the suppression window, only treat the event as an echo if
 * every field in the WS payload already matches the local IDB record — i.e.
 * we already have this data. If ANY field differs, it is newer remote state and
 * MUST be processed (merged into IDB) even inside the window.
 *
 * Restart safety: this only affects WS event intake. Direct user actions
 * (Complete/Fail/Cancel/Restart) are unaffected — they write locally and to
 * the server directly.
 */

const NON_COMPARE_FIELDS = new Set([
  'id', 'created_date', 'updated_date', 'created_by',
]);

const normalize = (value) => {
  if (value === undefined) return '__MISSING__';
  if (value === null || value === '') return '';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }
  // Numeric strings vs numbers ("1" vs 1, "1.0" vs 1) must compare equal.
  if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) {
    return String(Number(value));
  }
  return String(value);
};

/**
 * Determine whether an incoming WS Delivery payload is a true echo of data
 * this device already has in IDB.
 *
 * @param {string} deliveryId
 * @param {object} wsPayload - the normalized event.data payload (partial or full)
 * @returns {Promise<boolean>} true → safe to suppress; false → process (remote change)
 */
export const isTrueDeliveryEcho = async (deliveryId, wsPayload) => {
  let existing = null;
  try {
    const { offlineDB } = await import('./offlineDatabase');
    existing = await offlineDB.getById(offlineDB.STORES.DELIVERIES, deliveryId);
  } catch (_) {
    existing = null;
  }
  // No local copy (or IDB read failed) — cannot confirm echo; process the event.
  if (!existing) return false;

  const keys = Object.keys(wsPayload || {}).filter((k) => !NON_COMPARE_FIELDS.has(k));
  // Payload with no comparable fields — treat as echo (nothing to learn).
  if (keys.length === 0) return true;

  for (const key of keys) {
    const incoming = normalize(wsPayload[key]);
    if (incoming === '__MISSING__') continue;
    if (incoming !== normalize(existing[key])) {
      return false; // differs from local → genuine remote update
    }
  }
  return true;
};
