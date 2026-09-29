import { offlineDB } from './offlineDatabase';

// 190 days: covers the 6-month backfill history retained back to the oldest uncollected COD
const DEFAULT_LOOKBACK_DAYS = 190;

const getLookbackDays = () => DEFAULT_LOOKBACK_DAYS;
const SQUARE_COD_STORES = {
  CATALOG_ITEMS: offlineDB.STORES.SQUARE_CATALOG_ITEMS,
  PAYMENT_TRANSACTIONS: offlineDB.STORES.SQUARE_TRANSACTIONS
};

const getLookbackStartMs = () => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - getLookbackDays());
  cutoff.setHours(0, 0, 0, 0);
  return cutoff.getTime();
};

const isRecentSquareTransaction = (transaction) => {
  const rawDate = transaction?.created_date || transaction?.updated_date || transaction?.raw_square_data?.payment_date || 0;
  const timestamp = new Date(rawDate).getTime();
  return Number.isFinite(timestamp) && timestamp >= getLookbackStartMs();
};

const parseCatalogDate = (record) => {
  if (record?.delivery_date) {
    return new Date(`${record.delivery_date}T00:00:00`).getTime();
  }

  const itemName = record?.item_name || record?.name || '';
  const match = String(itemName).match(/^(\d{2})[\/-](\d{2})/);
  if (match) {
    const today = new Date();
    const candidate = new Date(today.getFullYear(), Number(match[1]) - 1, Number(match[2]));
    const msInDay = 24 * 60 * 60 * 1000;
    if (candidate.getTime() - today.getTime() > 45 * msInDay) {
      candidate.setFullYear(candidate.getFullYear() - 1);
    }
    return candidate.getTime();
  }

  return new Date(record?.created_date || record?.updated_date || 0).getTime();
};

const isRecentCatalogItem = (record) => {
  const timestamp = parseCatalogDate(record);
  return Number.isFinite(timestamp) && timestamp >= getLookbackStartMs();
};

const normalizeCatalogEntityRecord = (record) => ({
  ...record,
  id: record?.id || record?.square_catalog_object_id,
  amount: Number(record?.amount || 0),
  amount_cents: record?.amount_cents ?? Math.round(Number(record?.amount || 0) * 100),
  status: record?.status || 'active'
});

const isActualCollectedTransaction = (transaction) => {
  if (!transaction) return false;
  const label = `${transaction?.item_name || ''} ${transaction?.delivery_id || ''}`.toLowerCase();
  return !(transaction?.type === 'transfer' || label.includes('transfer') || label.includes('interstore') || label.includes('inter-store'));
};

const mapCatalogEntityToUIItem = (record) => ({
  id: record.id,
  catalog_object_id: record.square_catalog_object_id || record.id,
  variation_id: null,
  name: record.item_name,
  description: record.description || '',
  price_cents: record.amount_cents ?? Math.round(Number(record.amount || 0) * 100),
  price_dollars: Number(record.amount || 0),
  location_id: record.location_id || '',
  present_at_locations: record.location_id ? [record.location_id] : [],
  present_at_all: false,
  updated_at: record.updated_date,
  version: record.square_catalog_version || 0,
  transaction_id: null,
  delivery_id: record.delivery_id,
  patient_id: record.patient_id,
  store_id: record.store_id,
  status: record.status || 'active',
  created_date: record.created_date,
  is_sold: false
});

const updateCatalogSyncStatus = async () => {
  const allItems = await offlineDB.getAll(SQUARE_COD_STORES.CATALOG_ITEMS);
  await offlineDB.updateSyncStatus('SquareCatalogItems', {
    status: 'synced',
    recordCount: allItems.length,
    lastSync: new Date().toISOString()
  });
};

const updateTransactionSyncStatus = async () => {
  const allTransactions = await offlineDB.getAll(SQUARE_COD_STORES.PAYMENT_TRANSACTIONS);
  await offlineDB.updateSyncStatus('SquareTransaction', {
    status: 'synced',
    recordCount: allTransactions.length,
    lastSync: new Date().toISOString()
  });
};

const pruneStoredCatalogItems = async () => {
  // Catalog items are not date-filtered â€” no pruning needed, just update sync status.
  await updateCatalogSyncStatus();
  const items = await offlineDB.getAll(SQUARE_COD_STORES.CATALOG_ITEMS);
  return items || [];
};

// Chunked bulkSave — each chunk gets its own IDB_OPERATION_TIMEOUT window.
// A single 8s window over 900+ encrypted records aborted too often on phone
// hardware; chunking makes the big 6-month backfill set durable.
const BULK_CHUNK_SIZE = 150;
const bulkSaveChunked = async (storeName, records) => {
  const all = records || [];
  let saved = 0;
  for (let i = 0; i < all.length; i += BULK_CHUNK_SIZE) {
    const chunk = all.slice(i, i + BULK_CHUNK_SIZE);
    const result = await offlineDB.bulkSave(storeName, chunk);
    if (!result?.success) {
      return { success: false, error: result?.error || `bulkSave chunk ${Math.floor(i / BULK_CHUNK_SIZE)} failed`, saved };
    }
    saved += result.count || chunk.length;
  }
  return { success: true, count: saved };
};

const pruneStoredSquareTransactions = async () => {
  const transactions = await offlineDB.getAll(SQUARE_COD_STORES.PAYMENT_TRANSACTIONS);
  const recentTransactions = (transactions || []).filter(isRecentSquareTransaction);

  // DELETE-ONLY prune (owner fix, Sep 29 2026): never clearStore-then-resave
  // on the read path — the clear commits in its own IDB transaction and a
  // failed save afterwards leaves the store empty (the backfill IDB wipe).
  const stale = (transactions || []).filter((t) => t?.id && !isRecentSquareTransaction(t));
  if (stale.length > 0) {
    await Promise.all(stale.map((t) => offlineDB.deleteRecord(SQUARE_COD_STORES.PAYMENT_TRANSACTIONS, t.id).catch(() => null)));
  }

  await updateTransactionSyncStatus();
  return recentTransactions;
};

export const saveCatalogItemsOffline = async (items) => {
  try {
    // Catalog items have NO date filter â€” we store ALL active items from Square.
    const normalizedItems = (items || []).filter(Boolean).map(normalizeCatalogEntityRecord);
    // UPSERT-FIRST (owner fix, Sep 29 2026): save BEFORE pruning, and never
    // clear the store first — clearStore+bulkSave ran as two separate IDB
    // transactions, so a failed/timed-out save left the store wiped.
    if (normalizedItems.length > 0) {
      const saveResult = await bulkSaveChunked(SQUARE_COD_STORES.CATALOG_ITEMS, normalizedItems);
      if (!saveResult?.success) {
        console.error('[SquareCODOffline] Catalog bulkSave failed — keeping existing IDB rows:', saveResult?.error);
        return { success: false, error: saveResult?.error };
      }
      const incomingIds = new Set(normalizedItems.map((r) => r?.id).filter(Boolean));
      const existingItems = (await offlineDB.getAll(SQUARE_COD_STORES.CATALOG_ITEMS)) || [];
      const toDelete = existingItems.filter((r) => r?.id && !incomingIds.has(r.id));
      if (toDelete.length > 0) {
        await Promise.all(toDelete.map((r) => offlineDB.deleteRecord(SQUARE_COD_STORES.CATALOG_ITEMS, r.id).catch(() => null)));
      }
    }

    await updateCatalogSyncStatus();
    return { success: true, count: normalizedItems.length };
  } catch (error) {
    console.error('âŒ [SquareCODOffline] Error saving catalog items:', error);
    return { success: false, error: error.message };
  }
};

export const savePaymentTransactionsOffline = async (transactions) => {
  try {
    // Do NOT filter by date here â€” the online DB was just cleared and rebuilt from
    // the Square API. Trust the source completely. Filter out only non-collected types.
    const normalizedTransactions = (transactions || []).filter(Boolean).filter(isActualCollectedTransaction);

    // UPSERT-FIRST (owner fix, Sep 29 2026): the old code did clearStore() then
    // bulkSave() — TWO separate IDB transactions. The clear committed first;
    // when the bulkSave then hit the 8s operation timeout (900+ records on the
    // 6-month backfill, AES-GCM encrypted as a PHI store) it aborted, leaving
    // the store EMPTY with the failure silently ignored — every backfill
    // wiped the entire Square Transaction history in IDB, so all collected
    // CODs looked uncollected. Now: save first (chunked, each chunk gets its
    // own timeout window); prune stale rows only after a CONFIRMED successful
    // save; never touch existing rows on failure or empty input.
    if (normalizedTransactions.length === 0) {
      console.warn('[SquareCODOffline] Empty transaction set — keeping existing IDB tx history untouched');
      await updateTransactionSyncStatus();
      return { success: true, count: 0, skipped: true };
    }

    const saveResult = await bulkSaveChunked(SQUARE_COD_STORES.PAYMENT_TRANSACTIONS, normalizedTransactions);
    if (!saveResult?.success) {
      console.error('[SquareCODOffline] Tx bulkSave failed — KEEPING existing IDB rows:', saveResult?.error);
      await updateTransactionSyncStatus();
      return { success: false, error: saveResult?.error };
    }

    // Prune rows not in the incoming mirror set (purged collected rows must
    // leave IDB so the DB mirror stays exact) — only after a confirmed save.
    const incomingIds = new Set(normalizedTransactions.map((r) => r?.id).filter(Boolean));
    const existingTxs = (await offlineDB.getAll(SQUARE_COD_STORES.PAYMENT_TRANSACTIONS)) || [];
    const toDelete = existingTxs.filter((r) => r?.id && !incomingIds.has(r.id));
    if (toDelete.length > 0) {
      await Promise.all(toDelete.map((r) => offlineDB.deleteRecord(SQUARE_COD_STORES.PAYMENT_TRANSACTIONS, r.id).catch(() => null)));
    }

    await updateTransactionSyncStatus();
    return { success: true, count: normalizedTransactions.length };
  } catch (error) {
    console.error('âŒ [SquareCODOffline] Error saving payment transactions:', error);
    return { success: false, error: error.message };
  }
};

export const syncSquareCODSnapshotOffline = async ({ catalogItems = [], transactions = [] }) => {
  const [catalogResult, transactionResult] = await Promise.all([
    saveCatalogItemsOffline(catalogItems),
    savePaymentTransactionsOffline(transactions)
  ]);

  return {
    success: catalogResult.success && transactionResult.success,
    catalogCount: catalogResult.count || 0,
    transactionCount: transactionResult.count || 0
  };
};

export const getCatalogItemsOffline = async () => {
  try {
    const items = await pruneStoredCatalogItems();
    return (items || []).map(mapCatalogEntityToUIItem);
  } catch (error) {
    console.error('âŒ [SquareCODOffline] Error retrieving catalog items:', error);
    return [];
  }
};

export const getPaymentTransactionsOffline = async () => {
  try {
    return await pruneStoredSquareTransactions();
  } catch (error) {
    console.error('âŒ [SquareCODOffline] Error retrieving payment transactions:', error);
    return [];
  }
};

export const getCatalogItemsByLocationOffline = async (locationId) => {
  try {
    const items = await offlineDB.getByIndex(SQUARE_COD_STORES.CATALOG_ITEMS, 'location_id', locationId);
    return (items || []).map(mapCatalogEntityToUIItem);
  } catch (error) {
    console.error('âŒ [SquareCODOffline] Error retrieving items by location:', error);
    return [];
  }
};

export const getPaymentTransactionsByLocationOffline = async (locationId) => {
  try {
    const transactions = await getPaymentTransactionsOffline();
    return (transactions || []).filter((transaction) => transaction.location_id === locationId);
  } catch (error) {
    console.error('âŒ [SquareCODOffline] Error retrieving transactions by location:', error);
    return [];
  }
};

export const handleSquareCatalogItemRealtimeEvent = async (event) => {
  if (!event?.type) return;

  if (event.type === 'delete') {
    await offlineDB.deleteRecord(SQUARE_COD_STORES.CATALOG_ITEMS, event.id);
  } else if (event.data?.id) {
    // Catalog items are not date-filtered â€” save all active items
    const normalizedRecord = normalizeCatalogEntityRecord(event.data);
    await offlineDB.save(SQUARE_COD_STORES.CATALOG_ITEMS, normalizedRecord);
  }

  await pruneStoredCatalogItems();
};

export const handleSquareTransactionRealtimeEvent = async (event) => {
  if (!event?.type) return;

  if (event.type === 'delete') {
    await offlineDB.deleteRecord(SQUARE_COD_STORES.PAYMENT_TRANSACTIONS, event.id);
  } else if (event.data?.id) {
    if (isRecentSquareTransaction(event.data)) {
      await offlineDB.save(SQUARE_COD_STORES.PAYMENT_TRANSACTIONS, event.data);
    } else {
      await offlineDB.deleteRecord(SQUARE_COD_STORES.PAYMENT_TRANSACTIONS, event.data.id);
    }
  }

  await pruneStoredSquareTransactions();
};

export const clearSquareCODOfflineData = async () => {
  try {
    await Promise.all([
      offlineDB.clearStore(SQUARE_COD_STORES.CATALOG_ITEMS),
      offlineDB.clearStore(SQUARE_COD_STORES.PAYMENT_TRANSACTIONS)
    ]);

    await Promise.all([
      updateCatalogSyncStatus(),
      updateTransactionSyncStatus()
    ]);

    return { success: true };
  } catch (error) {
    console.error('âŒ [SquareCODOffline] Error clearing data:', error);
    return { success: false, error: error.message };
  }
};

export const purgeSquareCODOfflineDataBeforeSync = async () => {
  return await clearSquareCODOfflineData();
};

export const getSquareCODSyncStatus = async () => {
  try {
    const [catalogStatus, transactionStatus] = await Promise.all([
      offlineDB.getSyncStatus('SquareCatalogItems'),
      offlineDB.getSyncStatus('SquareTransaction')
    ]);

    return {
      catalog: catalogStatus || { status: 'never_synced', recordCount: 0 },
      transactions: transactionStatus || { status: 'never_synced', recordCount: 0 }
    };
  } catch (error) {
    console.error('âŒ [SquareCODOffline] Error getting sync status:', error);
    return { catalog: null, transactions: null };
  }
};

export const initializeCatalogItemsStore = async () => {
  try {
    const db = await offlineDB.openDatabase();

    if (!db.objectStoreNames.contains(SQUARE_COD_STORES.CATALOG_ITEMS)) {
      console.log('âš ï¸ [SquareCODOffline] Catalog items store does not exist, need to upgrade DB');
    }

    return { success: true };
  } catch (error) {
    console.error('âŒ [SquareCODOffline] Error initializing store:', error);
    return { success: false, error: error.message };
  }
};

export const squareCODOfflineManager = {
  saveCatalogItemsOffline,
  savePaymentTransactionsOffline,
  syncSquareCODSnapshotOffline,
  getCatalogItemsOffline,
  getPaymentTransactionsOffline,
  getCatalogItemsByLocationOffline,
  getPaymentTransactionsByLocationOffline,
  handleSquareCatalogItemRealtimeEvent,
  handleSquareTransactionRealtimeEvent,
  clearSquareCODOfflineData,
  purgeSquareCODOfflineDataBeforeSync,
  getSquareCODSyncStatus
};