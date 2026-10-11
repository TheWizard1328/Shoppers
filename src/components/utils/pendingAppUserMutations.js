import { offlineDB } from './offlineDatabase';

const INTERNAL_PAYLOAD_FIELDS = new Set([
  '_userInitiated',
  '_driverStatusTransition',
  '_queuedOffline',
]);

export const sanitizeAppUserMutationPayload = (payload = {}) =>
  Object.fromEntries(
    Object.entries(payload || {}).filter(([key]) => !INTERNAL_PAYLOAD_FIELDS.has(key))
  );

/**
 * Overlay queued AppUser updates onto freshly fetched server rows.
 *
 * A reconnect pull can start at the same time as mutation replay. Without this
 * overlay, stale server values overwrite the local user's offline status before
 * the queued write reaches the server. Mutations are applied oldest to newest,
 * so multiple offline status changes resolve to the latest local intent.
 */
export const applyPendingAppUserMutations = async (serverRows = []) => {
  try {
    const pending = (await offlineDB.getPendingMutations())
      .filter((mutation) => mutation?.entity === 'AppUser' && mutation?.operation === 'update')
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));

    if (!pending.length) return serverRows || [];

    const byId = new Map((serverRows || []).filter(Boolean).map((row) => [row.id, { ...row }]));
    for (const mutation of pending) {
      const existing = byId.get(mutation.recordId);
      if (!existing) continue;
      byId.set(mutation.recordId, {
        ...existing,
        ...sanitizeAppUserMutationPayload(mutation.payload),
        id: existing.id,
        updated_date: mutation.createdAt || existing.updated_date,
      });
    }
    return Array.from(byId.values());
  } catch (error) {
    console.warn('[PendingAppUser] Could not overlay pending mutations:', error?.message);
    return serverRows || [];
  }
};

export const hasPendingDriverStatusMutation = async (appUserId) => {
  if (!appUserId) return false;
  const pending = await offlineDB.getPendingMutations();
  return pending.some((mutation) =>
    mutation?.entity === 'AppUser' &&
    mutation?.operation === 'update' &&
    mutation?.recordId === appUserId &&
    typeof mutation?.payload?.driver_status === 'string'
  );
};
