const locks = /* @__PURE__ */ new Map();
const DEFAULT_TTL_MS = 45e3;
const STATUS_RANK = {
  "pending": 0,
  "in_transit": 1,
  "en_route": 2,
  "completed": 3,
  "failed": 3,
  "cancelled": 3
};
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];
const TERMINAL_STICKY_WINDOW_MS = 10 * 60 * 1e3;
const applyTerminalStatusGuard = (incomingData, localData) => {
  if (!incomingData || !localData) return incomingData;
  const localStatus = localData?.status;
  if (!TERMINAL_STATUSES.includes(localStatus)) return incomingData;
  const terminalTs = new Date(
    localData.actual_delivery_time || localData.updated_date || localData.created_date || 0
  ).getTime();
  const sticky = Number.isFinite(terminalTs) ? Date.now() - terminalTs < TERMINAL_STICKY_WINDOW_MS : true;
  if (!sticky) return incomingData;
  const merged = { ...incomingData };
  const incomingStatus = merged.status;
  if (incomingStatus !== void 0 && !TERMINAL_STATUSES.includes(incomingStatus)) {
    merged.status = localStatus;
  }
  if (merged.isNextDelivery === true) {
    merged.isNextDelivery = false;
  }
  return merged;
};
const lockDeliveryFields = (deliveryId, fields, ttlMs = DEFAULT_TTL_MS, values = {}, options = {}) => {
  if (!deliveryId || !fields?.length) return;
  const existing = locks.get(deliveryId);
  const fieldSet = /* @__PURE__ */ new Set([...existing?.fields || [], ...fields]);
  const mergedValues = { ...existing?.values || {}, ...values };
  const newExpiry = Date.now() + ttlMs;
  const existingExpiry = existing?.expiresAt || 0;
  locks.set(deliveryId, { fields: fieldSet, expiresAt: Math.max(newExpiry, existingExpiry), values: mergedValues, symmetric: existing?.symmetric || !!options.symmetric });
};
const unlockDeliveryFields = (deliveryId) => {
  locks.delete(deliveryId);
};
const unlockAll = () => {
  locks.clear();
};
const getDeliveryFieldLock = (deliveryId) => {
  if (!deliveryId) return null;
  const entry = locks.get(deliveryId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    locks.delete(deliveryId);
    return null;
  }
  return entry;
};
const isFieldLocked = (deliveryId, field) => {
  if (!deliveryId || !field) return false;
  const entry = locks.get(deliveryId);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    locks.delete(deliveryId);
    return false;
  }
  return entry.fields.has(field);
};
const getLockedDeliveryIds = () => {
  const now = Date.now();
  for (const [id, entry] of locks) {
    if (now > entry.expiresAt) locks.delete(id);
  }
  return Array.from(locks.keys());
};
const applyRealtimeMergeWithLockout = (deliveryId, incomingData, localData) => {
  if (!incomingData || !localData) return incomingData;
  const entry = locks.get(deliveryId);
  if (!entry || Date.now() > entry.expiresAt) {
    if (entry) locks.delete(deliveryId);
    return applyTerminalStatusGuard(incomingData, localData);
  }
  const merged = { ...incomingData };
  for (const field of entry.fields) {
    const incomingVal = incomingData[field];
    const localVal = localData[field];
    if (incomingVal === void 0) continue;
    if (field === "status") {
      const _expectedStatus = entry.values?.status;
      if (entry.symmetric && _expectedStatus !== void 0 && incomingVal !== _expectedStatus) {
        merged[field] = _expectedStatus;
        continue;
      }
      const expectedStatus = entry.values?.status;
      const refStatus = expectedStatus !== void 0 ? expectedStatus : localVal;
      const incomingRank = STATUS_RANK[incomingVal] ?? -1;
      const refRank = STATUS_RANK[refStatus] ?? -1;
      if (refRank > incomingRank) {
        merged[field] = refStatus;
      } else if (TERMINAL_STATUSES.includes(incomingVal) && !TERMINAL_STATUSES.includes(refStatus)) {
        merged[field] = refStatus;
      }
    } else if (field === "isNextDelivery") {
      const expectedVal = entry.values?.isNextDelivery;
      const refVal = expectedVal !== void 0 ? expectedVal : localVal;
      if (incomingVal !== refVal) {
        merged[field] = refVal;
      }
    } else if (field === "actual_delivery_time") {
      if (localVal && (!incomingVal || incomingVal === null)) {
        merged[field] = localVal;
      }
    } else if (field === "stop_order") {
      if (localVal != null && Number.isFinite(Number(localVal)) && incomingVal !== localVal) {
        merged[field] = localVal;
      }
    } else if (field === "transport_mode") {
      if (localVal && incomingVal !== localVal) {
        merged[field] = localVal;
      }
    } else if (field === "tracking_number") {
      if (localVal && (!incomingVal || incomingVal === null || incomingVal === "")) {
        merged[field] = localVal;
      }
    } else if (field === "delivery_time_start") {
      if (localVal && incomingVal !== localVal) {
        merged[field] = localVal;
      }
    } else {
      if ((incomingVal === null || incomingVal === void 0 || incomingVal === false) && localVal) {
        merged[field] = localVal;
      }
    }
  }
  return applyTerminalStatusGuard(merged, localData);
};
export {
  TERMINAL_STATUSES,
  applyRealtimeMergeWithLockout,
  applyTerminalStatusGuard,
  getDeliveryFieldLock,
  getLockedDeliveryIds,
  isFieldLocked,
  lockDeliveryFields,
  unlockAll,
  unlockDeliveryFields
};
