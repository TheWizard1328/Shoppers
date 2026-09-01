/**
 * Deleted Delivery Registry
 * 
 * Single source of truth for "this delivery was deleted and should not be
 * resurrected by any code path."
 * 
 * Tracks deletions by:
 * 1. Record ID — catches WS echoes, stale cache merges, refresh merges
 * 2. Content signature (patient_id + delivery_date + store_id + driver_id) —
 *    catches create-mutation replays that generate a NEW server ID for the
 *    same logical delivery that was just deleted.
 * 
 * Persisted to sessionStorage so it survives page reloads but not app restarts.
 * TTL: 30 minutes — long enough to cover WS echo latency + mutation replay
 * cycles, short enough to avoid blocking legitimate re-creation of a delivery
 * with the same content (e.g. next day's delivery for the same patient).
 */

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const STORAGE_KEY = '__deletedDeliveryRegistry';
const MAX_ENTRIES = 500;

// In-memory maps
const deletedIds = new Map(); // id → timestamp
const deletedSignatures = new Map(); // signature → timestamp

/**
 * Build a content signature for a delivery record.
 * Used to catch create-mutation replays that generate new IDs.
 */
function buildSignature(delivery) {
  if (!delivery) return null;
  const parts = [
    delivery.patient_id || '',
    delivery.delivery_date || '',
    delivery.store_id || '',
    delivery.driver_id || '',
  ];
  const sig = parts.join('|');
  // Skip if all parts are empty — can't meaningfully match
  if (sig === '|||') return null;
  return sig;
}

/**
 * Load persisted entries from sessionStorage on module init.
 */
function loadFromStorage() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const now = Date.now();
    if (parsed.ids) {
      for (const [id, ts] of Object.entries(parsed.ids)) {
        if (now - ts < TTL_MS) deletedIds.set(id, ts);
      }
    }
    if (parsed.sigs) {
      for (const [sig, ts] of Object.entries(parsed.sigs)) {
        if (now - ts < TTL_MS) deletedSignatures.set(sig, ts);
      }
    }
  } catch (_) { /* ignore */ }
}

/**
 * Persist current entries to sessionStorage.
 */
function saveToStorage() {
  try {
    const now = Date.now();
    const ids = {};
    const sigs = {};
    for (const [id, ts] of deletedIds) {
      if (now - ts < TTL_MS) ids[id] = ts;
    }
    for (const [sig, ts] of deletedSignatures) {
      if (now - ts < TTL_MS) sigs[sig] = ts;
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ids, sigs }));
  } catch (_) { /* ignore quota errors */ }
}

/**
 * Sweep expired entries to prevent unbounded growth.
 */
function sweepExpired() {
  const now = Date.now();
  let swept = false;
  for (const [key, ts] of deletedIds) {
    if (now - ts >= TTL_MS) { deletedIds.delete(key); swept = true; }
  }
  for (const [key, ts] of deletedSignatures) {
    if (now - ts >= TTL_MS) { deletedSignatures.delete(key); swept = true; }
  }
  // Hard cap: if still too many entries, remove oldest
  if (deletedIds.size > MAX_ENTRIES) {
    const sorted = [...deletedIds.entries()].sort((a, b) => a[1] - b[1]);
    const toRemove = sorted.slice(0, deletedIds.size - MAX_ENTRIES);
    for (const [id] of toRemove) deletedIds.delete(id);
    swept = true;
  }
  if (swept) saveToStorage();
}

// Load on module init
loadFromStorage();

/**
 * Mark a delivery as deleted. Call from deleteDeliveryLocal and the WS delete handler.
 * @param {string} id — the delivery record ID
 * @param {object} deliveryData — the delivery record (for content signature)
 */
export function markDeleted(id, deliveryData) {
  if (!id) return;
  sweepExpired();
  deletedIds.set(id, Date.now());
  const sig = buildSignature(deliveryData);
  if (sig) deletedSignatures.set(sig, Date.now());
  saveToStorage();
}

/**
 * Check if a delivery ID has been recently deleted.
 * @param {string} id
 * @returns {boolean}
 */
export function isDeleted(id) {
  if (!id) return false;
  const ts = deletedIds.get(id);
  if (!ts) return false;
  if (Date.now() - ts >= TTL_MS) {
    deletedIds.delete(id);
    return false;
  }
  return true;
}

/**
 * Check if a delivery with the same content signature was recently deleted.
 * Used to gate create-mutation replays that generate new server IDs.
 * @param {object} deliveryData
 * @returns {boolean}
 */
export function isDeletedByContent(deliveryData) {
  const sig = buildSignature(deliveryData);
  if (!sig) return false;
  const ts = deletedSignatures.get(sig);
  if (!ts) return false;
  if (Date.now() - ts >= TTL_MS) {
    deletedSignatures.delete(sig);
    return false;
  }
  return true;
}

/**
 * Filter an array of deliveries, removing any that are in the deleted registry.
 * @param {Array} deliveries
 * @returns {Array}
 */
export function filterDeleted(deliveries) {
  if (!Array.isArray(deliveries) || deliveries.length === 0) return deliveries;
  sweepExpired();
  let changed = false;
  const result = deliveries.filter(d => {
    if (!d?.id) return true;
    if (isDeleted(d.id)) {
      changed = true;
      return false;
    }
    return true;
  });
  return changed ? result : deliveries;
}

/**
 * Clear a specific ID from the registry (e.g. when a legitimate new delivery
 * is intentionally created by the user with the same ID — rare).
 */
export function clearDeleted(id) {
  if (!id) return;
  deletedIds.delete(id);
  saveToStorage();
}

/**
 * Get the raw deleted IDs set (for debugging).
 */
export function getDeletedIds() {
  return new Set(deletedIds.keys());
}

// Sweep on module load and every 5 minutes
sweepExpired();
if (typeof window !== 'undefined') {
  setInterval(sweepExpired, 5 * 60 * 1000);
}
