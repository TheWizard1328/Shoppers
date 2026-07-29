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
 *
 * Extended (2026-07-29): Now also guards against status regression (pending→in_transit
 * reverts during Accept All), stop_order/transport_mode/tracking_number reverts
 * during route optimization, and cycling marker isNextDelivery persistence.
 *
 * Extended (2026-07-29 v2): isNextDelivery guard is now SYMMETRIC — blocks both
 * true→false AND false→true reversion. Added expected-values support: the lock
 * stores the optimistic values written, so the guard doesn't depend on IDB
 * read timing. This fixes the completed-stop reversion where a stale WS echo
 * carries isNextDelivery=true and status=in_transit for a just-completed stop.
 */

const locks = new Map();  // deliveryId → { fields: Set<string>, expiresAt: number }
const DEFAULT_TTL_MS = 45000; // 45 seconds — covers background IDB resyncs and smart refresh cycles

// Status progression order — used to detect regressions
// pending → in_transit → en_route → completed/failed/cancelled
const STATUS_RANK = {
  'pending': 0,
  'in_transit': 1,
  'en_route': 2,
  'completed': 3,
  'failed': 3,
  'cancelled': 3,
};

/**
 * Lock specific fields for a delivery against realtime reversion.
 * @param {string} deliveryId
 * @param {string[]} fields  – e.g. ['status', 'isNextDelivery']
 * @param {number} [ttlMs]
 */
export const lockDeliveryFields = (deliveryId, fields, ttlMs = DEFAULT_TTL_MS, values = {}) => {
  if (!deliveryId || !fields?.length) return;
  const existing = locks.get(deliveryId);
  const fieldSet = new Set([...(existing?.fields || []), ...fields]);
  // Merge expected values — these are the optimistic values we just wrote.
  // If provided, the guard uses these instead of the IDB record, eliminating
  // races where the WS echo arrives before the IDB optimistic write commits.
  const mergedValues = { ...(existing?.values || {}), ...values };
  // If there's an existing lock, extend the expiry (don't shorten it)
  const newExpiry = Date.now() + ttlMs;
  const existingExpiry = existing?.expiresAt || 0;
  locks.set(deliveryId, { fields: fieldSet, expiresAt: Math.max(newExpiry, existingExpiry), values: mergedValues });
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
 * Returns the list of all currently-locked delivery IDs (for debugging).
 */
export const getLockedDeliveryIds = () => {
  const now = Date.now();
  // Prune expired
  for (const [id, entry] of locks) {
    if (now > entry.expiresAt) locks.delete(id);
  }
  return Array.from(locks.keys());
};

/**
 * Given an incoming realtime payload and an existing local record, return a
 * merged object that refuses to overwrite any locked field with a "regressing"
 * value.
 *
 * "Regressing" means the incoming value would undo an optimistic write:
 *   - status: incoming status has a LOWER rank than local (e.g. 'pending'
 *     coming in when local already says 'in_transit' or terminal)
 *   - isNextDelivery: incoming value is false when local is true  (and the
 *     NEXT stop's true is coming in a separate event — we just suppress the
 *     intermediate false)
 *   - stop_order: incoming value differs from local and local was recently
 *     written by an optimization or Accept All — keep the local value
 *   - transport_mode: incoming value differs from local when locked — keep local
 *   - tracking_number: incoming null/empty when local has a value — keep local
 *   - actual_delivery_time: incoming null when local has value — keep local
 *
 * For any other locked field we simply keep the local value if incoming
 * would clear/regress it.
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

    // Skip if the incoming payload doesn't even mention this field
    if (incomingVal === undefined) continue;

    if (field === 'status') {
      // Status regression guard: never let a lower-rank status overwrite a higher one
      // e.g. 'pending' (rank 0) cannot overwrite 'in_transit' (rank 1) or terminal (rank 3)
      // Use expected value from the lock if available (eliminates IDB read race).
      const expectedStatus = entry.values?.status;
      const refStatus = expectedStatus !== undefined ? expectedStatus : localVal;
      const incomingRank = STATUS_RANK[incomingVal] ?? -1;
      const refRank = STATUS_RANK[refStatus] ?? -1;
      if (refRank > incomingRank) {
        merged[field] = refStatus;
      }
    } else if (field === 'isNextDelivery') {
      // SYMMETRIC guard: if locked and incoming differs from our optimistic
      // value, keep ours. This handles BOTH reversion directions:
      //   - true → false: stale echo clearing the next stop's badge
      //   - false → true: stale echo re-marking a completed stop as next
      // The lock was set because we just wrote this field authoritatively —
      // any incoming echo with a different value is stale.
      // Use expected value from the lock if available (eliminates IDB read race),
      // otherwise fall back to the local (IDB) record.
      const expectedVal = entry.values?.isNextDelivery;
      const refVal = expectedVal !== undefined ? expectedVal : localVal;
      if (incomingVal !== refVal) {
        merged[field] = refVal;
      }
    } else if (field === 'actual_delivery_time') {
      // Never let a null/empty incoming value wipe a completion timestamp
      if (localVal && (!incomingVal || incomingVal === null)) {
        merged[field] = localVal;
      }
    } else if (field === 'stop_order') {
      // During optimization, stop_order is recomputed locally. A stale WS echo
      // carrying the old stop_order would revert the optimized sequence.
      // Only guard if local has a real stop_order and incoming differs.
      if (localVal != null && Number.isFinite(Number(localVal)) &&
          incomingVal !== localVal) {
        merged[field] = localVal;
      }
    } else if (field === 'transport_mode') {
      // Cycling mode setup writes transport_mode locally. A stale WS echo with
      // the old mode would revert it. Keep local if incoming differs.
      if (localVal && incomingVal !== localVal) {
        merged[field] = localVal;
      }
    } else if (field === 'tracking_number') {
      // Never let a null/empty tracking_number wipe one that was just assigned
      if (localVal && (!incomingVal || incomingVal === null || incomingVal === '')) {
        merged[field] = localVal;
      }
    } else if (field === 'delivery_time_start') {
      // Accept All sets delivery_time_start on all transitioned deliveries.
      // A stale WS echo from a pre-transition server record would wipe it.
      if (localVal && incomingVal !== localVal) {
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
