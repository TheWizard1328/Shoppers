export const offlineDB = {
  STORES: { DELIVERIES: 'deliveries' },
  getByIds: async (_store, ids) => (globalThis.__TEST_IDB || []).filter((r) => ids.includes(r.id)),
};
