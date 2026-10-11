import { offlineDB } from './offlineDatabase';
import { sanitizeAppUserMutationPayload } from './pendingAppUserMutations';

const sanitizePayload = (entityName, payload = {}) => {
  if (entityName === 'AppUser') return sanitizeAppUserMutationPayload(payload);
  const { _userInitiated, _isBatchSave, _stagedDeliveries, ...clean } = payload || {};
  return clean;
};

const recordMatchesFilter = (record, filter = {}) => Object.entries(filter || {}).every(([field, expected]) => {
  if (expected == null) return true;
  if (expected && typeof expected === 'object' && Array.isArray(expected.$in)) {
    return expected.$in.includes(record?.[field]);
  }
  return record?.[field] === expected;
});

/**
 * Protect local-first writes from stale server pulls while their durable
 * mutations are pending. Applies creates, updates and deletes in queue order.
 */
export const applyPendingEntityMutations = async ({
  entityName,
  serverRows = [],
  storeName,
  filter = {},
}) => {
  try {
    const pending = (await offlineDB.getPendingMutations())
      .filter((mutation) => mutation?.entity === entityName)
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
    if (!pending.length) return serverRows || [];

    const byId = new Map((serverRows || []).filter(Boolean).map((row) => [row.id, { ...row }]));
    for (const mutation of pending) {
      if (mutation.operation === 'delete') {
        byId.delete(mutation.recordId);
        continue;
      }

      let localRecord = storeName
        ? await offlineDB.getById(storeName, mutation.recordId).catch(() => null)
        : null;
      const existing = byId.get(mutation.recordId);
      const payload = sanitizePayload(entityName, mutation.payload);
      const merged = {
        ...(existing || localRecord || {}),
        ...payload,
        id: mutation.recordId,
        updated_date: mutation.createdAt || existing?.updated_date || localRecord?.updated_date,
      };

      if (mutation.operation === 'create' && !recordMatchesFilter(merged, filter)) continue;
      if (mutation.operation === 'update' && !existing && !localRecord) continue;
      byId.set(mutation.recordId, merged);
    }
    return Array.from(byId.values());
  } catch (error) {
    console.warn(`[PendingEntity] Could not overlay ${entityName} mutations:`, error?.message);
    return serverRows || [];
  }
};

export const hasPendingEntityMutation = async (entityName, recordId) => {
  const pending = await offlineDB.getPendingMutations();
  return pending.some((mutation) => mutation?.entity === entityName && mutation?.recordId === recordId);
};
