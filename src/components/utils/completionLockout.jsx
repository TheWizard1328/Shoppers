/**
 * completionLockout
 *
 * During a Complete action the backend fires a rapid sequence of WebSocket events:
 *   1. status → "completed", isNextDelivery → false   (the completed stop)
 *   2. isNextDelivery → false  (cleared from previous next stop)
 *   3. isNextDelivery → true   (set on the new next stop)
 *
 * Steps 1 & 2 arrive so quickly that the realtime merge logic can momentarily
 * revert the optimistic UI state back to "in_transit / isNextDelivery=true" on
 * the old stop before step 3 corrects it.
 *
 * This module maintains a simple in-memory map of:
 *   deliveryId → { fields: Set<string>, expiresAt: number }
 *
 * The realtime sync merge checks this map and skips reverting protected fields.
 */

const locks = new Map();  // deliveryId → { fields: Set<string>, expiresAt: number }
const DEFAULT_TTL_MS = 45000; // 45 seconds — covers background IDB resyncs and smart refresh cycles

/**
 * Lock specific fields for a delivery against realtime reversion.
 * @param {string} deliveryId
 * @param {string[]} fields  – e.g. ['status', 'isNextDelivery']
 * @param {number} [ttlMs]
 */
export const lockDeliveryFields = (deliveryId, fields, ttlMs = DEFAULT_TTL_MS) => {
  if (!deliveryId || !fields?.length) return;
  const existing = locks.get(deliveryId);
  const fieldSet = new Set([...(existing?.fields || []), ...fields]);
  locks.set(deliveryId, { fields: fieldSet, expiresAt: Date.now() + ttlMs });
};

/**
 * Unlock all fields for a delivery (call when action fully confirmed).
 * @param {string} deliveryId
 */
export const unlockDeliveryFields = (deliveryId) => {
  locks.delete(deliveryId);
};

/**
 * Unlock all deliveries (e.g. on page navigation or hard reset).
 */
export const unlockAll = () => {
  locks.clear();
};

/**
 * Returns true if the given field for the given delivery is currently locked.
 * Expired locks are pruned automatically.
 */
export const isFieldLocked = (deliveryId, field) => {
  if (!deliveryId || !field) return false;
  const entry = locks.get(deliveryId);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    locks.delete(deliveryId);
    return false;
  }
  return entry.fields.has(field);
};

/**
 * Given an incoming realtime payload and an existing local record, return a
 * merged object that refuses to overwrite any locked field with a "regressing"
 * value.
 *
 * "Regressing" means the incoming value would undo an optimistic write:
 *   - status: incoming value is NOT 'completed' when local already is
 *   - isNextDelivery: incoming value is false when local is true  (and the
 *     NEXT stop's true is coming in a separate event — we just suppress the
 *     intermediate false)
 *
 * For any other locked field we simply keep the local value.
 */
export const applyRealtimeMergeWithLockout = (deliveryId, incomingData, localData) => {
  if (!incomingData || !localData) return incomingData;

  const entry = locks.get(deliveryId);
  if (!entry) return incomingData;
  if (Date.now() > entry.expiresAt) {
    locks.delete(deliveryId);
    return incomingData;
  }

  const merged = { ...incomingData };

  for (const field of entry.fields) {
    const incomingVal = incomingData[field];
    const localVal = localData[field];

    if (field === 'status') {
      // Never let a non-terminal status overwrite a terminal one
      const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'returned']);
      if (TERMINAL.has(localVal) && !TERMINAL.has(incomingVal) && incomingVal !== undefined) {
        merged[field] = localVal;
      }
    } else if (field === 'isNextDelivery') {
      // Suppress a false incoming when local is already true
      if (localVal === true && incomingVal === false) {
        merged[field] = true;
      }
    } else if (field === 'actual_delivery_time') {
      // Never let a null/empty incoming value wipe a completion timestamp
      if (localVal && (!incomingVal || incomingVal === null)) {
        merged[field] = localVal;
      }
    } else {
      // Generic: keep local if incoming would clear/regress it
      if ((incomingVal === null || incomingVal === undefined || incomingVal === false) && localVal) {
        merged[field] = localVal;
      }
    }
  }

  return merged;
};