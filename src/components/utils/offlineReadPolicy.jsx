import { offlineDB } from './offlineDatabase';
import { getOfflineStoreName, isOfflineManagedEntity } from './offlineEntityRegistry';

const EXTRA_STORE_MAP = {
  SquareLocationConfig: offlineDB.STORES.SQUARE_LOCATION_CONFIGS,
  SquareTransaction: offlineDB.STORES.SQUARE_TRANSACTIONS,
  SquareCatalogItems: offlineDB.STORES.SQUARE_CATALOG_ITEMS,
};

const matchesFilter = (record, filter = {}) => {
  if (!record) return false;
  return Object.entries(filter).every(([key, value]) => {
    const recordValue = record[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('$in' in value) return value.$in.includes(recordValue);
      if ('$gte' in value && recordValue < value.$gte) return false;
      if ('$lte' in value && recordValue > value.$lte) return false;
      return true;
    }
    return recordValue === value;
  });
};

const sortRecords = (records, sortKey = null) => {
  if (!sortKey) return records;
  const descending = String(sortKey).startsWith('-');
  const field = descending ? String(sortKey).slice(1) : sortKey;
  return [...records].sort((a, b) => {
    const av = a?.[field];
    const bv = b?.[field];
    if (av === bv) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (descending) return av < bv ? 1 : -1;
    return av > bv ? 1 : -1;
  });
};

export const getOfflineStoreForEntity = (entityName) => {
  return getOfflineStoreName(offlineDB, entityName) || EXTRA_STORE_MAP[entityName] || null;
};

export const readEntityOffline = async (entityName, { sortKey = null, query = null, limit = null } = {}) => {
  const storeName = getOfflineStoreForEntity(entityName);
  if (!storeName) return [];

  let records = await offlineDB.getAll(storeName);
  if (!Array.isArray(records)) records = [];

  if (query) {
    records = records.filter((record) => matchesFilter(record, query));
  }

  records = sortRecords(records, sortKey);

  if (typeof limit === 'number') {
    records = records.slice(0, limit);
  }

  return records;
};

export const isOfflineFirstEntity = (entityName) => {
  return isOfflineManagedEntity(entityName) || entityName in EXTRA_STORE_MAP;
};