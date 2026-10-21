export const __CALLS = [];
const _store = new Map();
export const offlineDB = {
  STORES: { PENDING_MUTATIONS: 'pending_mutations', DELIVERIES: 'deliveries' },
  getPendingMutations: async () => [..._store.values()].map(r => ({ ...r })),
  removePendingMutation: async (id) => { __CALLS.push(['remove', id]); _store.delete(id); },
  updateMutationRetry: async (id, count, notBefore) => {
    __CALLS.push(['retry', id, count, notBefore]);
    const m = _store.get(id); if (m) { m.retryCount = count; m.notBefore = notBefore; }
  },
  __seed: (rows) => { _store.clear(); for (const r of rows) _store.set(r.mutationId, { ...r }); },
};
