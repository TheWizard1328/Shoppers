export const getOfflineStoreName = (_db, _e) => 'deliveries';
export const OFFLINE_SYNC_ENTITY_CLIENTS = {
  Delivery: { update: async () => { throw new Error('HTTP 500 boom'); } },
};
