import { offlineDB } from './offlineDatabase';
import { base44 } from '@/api/base44Client';

/**
 * Historical Delivery Sync — City-Scoped
 *
 * Backfills delivery history one date at a time, scoped to the logged-in user's
 * assigned cities. After the initial 365-day backfill, steady-state is just a
 * count-match validation pass: if online and offline counts for a date+city match,
 * the write is skipped entirely (WebSocket owns live updates after that).
 */

/**
 * Get the set of store IDs that belong to the user's assigned cities.
 * Returns null if the user has no city restriction (admin with no cities = all stores).
 * Returns empty Set if user has cities but no matching stores found.
 */
export const getUserCityStoreIds = (currentUser, stores) => {
  if (!currentUser || !stores?.length) return null;

  const cityIds = currentUser.city_ids?.length
    ? currentUser.city_ids
    : currentUser.city_id
      ? [currentUser.city_id]
      : [];

  const isAdmin = currentUser.app_roles?.includes('admin');
  if (cityIds.length === 0 && isAdmin) return null;
  if (cityIds.length === 0) return new Set();

  return new Set(
    stores.filter(s => s && cityIds.includes(s.city_id)).map(s => s.id)
  );
};

/**
 * Stable hash string for a user's city assignment, used to key the persisted cursor.
 * If the user's cities change, the cursor resets automatically.
 */
export const getCityIdsHash = (currentUser) => {
  const cityIds = currentUser?.city_ids?.length
    ? [...currentUser.city_ids].sort()
    : currentUser?.city_id
      ? [currentUser.city_id]
      : [];
  return cityIds.join(',');
};

const filterToCityScope = (deliveries, cityStoreIds) => {
  if (cityStoreIds === null) return deliveries || [];
  if (!cityStoreIds || cityStoreIds.size === 0) return [];
  return (deliveries || []).filter(d =>
    d?.is_cycling_marker || (d?.store_id && cityStoreIds.has(d.store_id))
  );
};

const CURSOR_KEY_PREFIX = 'historical_delivery_cursor';

/**
 * Load the persisted historical sync cursor from IndexedDB.
 * Returns a Date or null.
 */
export const loadHistoricalCursor = async (cityIdsHash) => {
  try {
    const meta = await offlineDB.getSyncMetadata(`${CURSOR_KEY_PREFIX}::${cityIdsHash}`);
    if (meta?.cursor_date) {
      return new Date(meta.cursor_date);
    }
  } catch (e) {
    console.warn('⚠️ [HistoricalSync] Failed to load cursor:', e.message);
  }
  return null;
};

/**
 * Save the historical sync cursor to IndexedDB so restarts resume where left off.
 */
export const saveHistoricalCursor = async (cursor, cityIdsHash) => {
  try {
    await offlineDB.updateSyncMetadata(
      `${CURSOR_KEY_PREFIX}::${cityIdsHash}`,
      cursor ? cursor.toISOString() : null,
      new Date().toISOString(),
      { cursor_date: cursor ? cursor.toISOString() : null, city_ids_hash: cityIdsHash }
    );
  } catch (e) {
    console.warn('⚠️ [HistoricalSync] Failed to save cursor:', e.message);
  }
};

/**
 * Sync a single historical date with city scoping.
 *
 * @param {string} dateStr - yyyy-MM-dd
 * @param {object} currentUser - current authenticated user
 * @param {Array} stores - all stores (from offline DB)
 * @returns {Promise<{synced: boolean, onlineCount: number, offlineCount: number, pruned: number}>}
 */
export const syncHistoricalDateCityScoped = async (dateStr, currentUser, stores) => {
  const cityStoreIds = getUserCityStoreIds(currentUser, stores);

  const onlineDeliveries = await base44.entities.Delivery.filter(
    { delivery_date: dateStr }, '-updated_date', 5000
  );

  const cityOnlineDeliveries = filterToCityScope(onlineDeliveries, cityStoreIds);
  const onlineCount = cityOnlineDeliveries.length;

  const offlineRecords = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, dateStr);
  const cityOfflineRecords = filterToCityScope(offlineRecords, cityStoreIds);
  const offlineCount = cityOfflineRecords.length;

  if (onlineCount === offlineCount && offlineCount > 0) {
    return { synced: false, onlineCount, offlineCount, pruned: 0 };
  }

  if (cityOnlineDeliveries.length > 0) {
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, cityOnlineDeliveries);
  }

  let pruned = 0;
  if (offlineCount > 0) {
    const onlineIds = new Set(cityOnlineDeliveries.map(d => d?.id).filter(Boolean));
    const orphans = cityOfflineRecords.filter(d =>
      d?.id && !onlineIds.has(d.id) && !d.is_cycling_marker
    );
    if (orphans.length > 0) {
      await Promise.all(
        orphans.map(d => offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, d.id).catch(() => {}))
      );
      pruned = orphans.length;
    }
  }

  return { synced: true, onlineCount, offlineCount, pruned };
};