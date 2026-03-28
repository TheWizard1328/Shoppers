import { offlineDB } from './offlineDatabase';

const DEFAULT_LOOKBACK_DAYS = 60;

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
  const timestamp = new Date(transaction?.created_date || transaction?.updated_date || 0).getTime();
  return Number.isFinite(timestamp) && timestamp >= getLookbackStartMs();
};

const isRecentCatalogItem = (record) => {
  const sourceDate = record?.delivery_date ? `${record.delivery_date}T00:00:00` : (record?.created_date || record?.updated_date || 0);
  const timestamp = new Date(sourceDate).getTime();
  return Number.isFinite(timestamp) && timestamp >= getLookbackStartMs();
};

const normalizeCatalogEntityRecord = (record) => ({
  ...record,
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
  const items = await offlineDB.getAll(SQUARE_COD_STORES.CATALOG_ITEMS);
  const recentItems = (items || []).filter(isRecentCatalogItem);

  if (recentItems.length !== (items || []).length) {
    await offlineDB.clearStore(SQUARE_COD_STORES.CATALOG_ITEMS);
    if (recentItems.length > 0) {
      await offlineDB.bulkSave(SQUARE_COD_STORES.CATALOG_ITEMS, recentItems);
    }
  }

  await updateCatalogSyncStatus();
  return recentItems;
};

const pruneStoredSquareTransactions = async () => {
  const transactions = await offlineDB.getAll(SQUARE_COD_STORES.PAYMENT_TRANSACTIONS);
  const recentTransactions = (transactions || []).filter(isRecentSquareTransaction);

  if (recentTransactions.length !== (transactions || []).length) {
    await offlineDB.clearStore(SQUARE_COD_STORES.PAYMENT_TRANSACTIONS);
    if (recentTransactions.length > 0) {
      await offlineDB.bulkSave(SQUARE_COD_STORES.PAYMENT_TRANSACTIONS, recentTransactions);
    }
  }

  await updateTransactionSyncStatus();
  return recentTransactions;
};

export const saveCatalogItemsOffline = async (items) => {
  try {
    const normalizedItems = (items || []).filter(Boolean).map(normalizeCatalogEntityRecord).filter(isRecentCatalogItem);
    await offlineDB.clearStore(SQUARE_COD_STORES.CATALOG_ITEMS);

    if (normalizedItems.length > 0) {
      await offlineDB.bulkSave(SQUARE_COD_STORES.CATALOG_ITEMS, normalizedItems);
    }

    await updateCatalogSyncStatus();
    return { success: true, count: normalizedItems.length };
  } catch (error) {
    console.error('❌ [SquareCODOffline] Error saving catalog items:', error);
    return { success: false, error: error.message };
  }
};

export const savePaymentTransactionsOffline = async (transactions) => {
  try {
    const recentTransactions = (transactions || []).filter(Boolean).filter(isRecentSquareTransaction).filter(isActualCollectedTransaction);
    await offlineDB.clearStore(SQUARE_COD_STORES.PAYMENT_TRANSACTIONS);

    if (recentTransactions.length > 0) {
      await offlineDB.bulkSave(SQUARE_COD_STORES.PAYMENT_TRANSACTIONS, recentTransactions);
    }

    await updateTransactionSyncStatus();
    return { success: true, count: recentTransactions.length };
  } catch (error) {
    console.error('❌ [SquareCODOffline] Error saving payment transactions:', error);
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
    console.error('❌ [SquareCODOffline] Error retrieving catalog items:', error);
    return [];
  }
};

export const getPaymentTransactionsOffline = async () => {
  try {
    return await pruneStoredSquareTransactions();
  } catch (error) {
    console.error('❌ [SquareCODOffline] Error retrieving payment transactions:', error);
    return [];
  }
};

export const getCatalogItemsByLocationOffline = async (locationId) => {
  try {
    const items = await offlineDB.getByIndex(SQUARE_COD_STORES.CATALOG_ITEMS, 'location_id', locationId);
    return (items || []).map(mapCatalogEntityToUIItem);
  } catch (error) {
    console.error('❌ [SquareCODOffline] Error retrieving items by location:', error);
    return [];
  }
};

export const getPaymentTransactionsByLocationOffline = async (locationId) => {
  try {
    const transactions = await getPaymentTransactionsOffline();
    return (transactions || []).filter((transaction) => transaction.location_id === locationId);
  } catch (error) {
    console.error('❌ [SquareCODOffline] Error retrieving transactions by location:', error);
    return [];
  }
};

export const handleSquareCatalogItemRealtimeEvent = async (event) => {
  if (!event?.type) return;

  if (event.type === 'delete') {
    await offlineDB.deleteRecord(SQUARE_COD_STORES.CATALOG_ITEMS, event.id);
  } else if (event.data?.id) {
    const normalizedRecord = normalizeCatalogEntityRecord(event.data);
    if (isRecentCatalogItem(normalizedRecord)) {
      await offlineDB.save(SQUARE_COD_STORES.CATALOG_ITEMS, normalizedRecord);
    } else {
      await offlineDB.deleteRecord(SQUARE_COD_STORES.CATALOG_ITEMS, event.data.id);
    }
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
    console.error('❌ [SquareCODOffline] Error clearing data:', error);
    return { success: false, error: error.message };
  }
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
    console.error('❌ [SquareCODOffline] Error getting sync status:', error);
    return { catalog: null, transactions: null };
  }
};

export const initializeCatalogItemsStore = async () => {
  try {
    const db = await offlineDB.openDatabase();

    if (!db.objectStoreNames.contains(SQUARE_COD_STORES.CATALOG_ITEMS)) {
      console.log('⚠️ [SquareCODOffline] Catalog items store does not exist, need to upgrade DB');
    }

    return { success: true };
  } catch (error) {
    console.error('❌ [SquareCODOffline] Error initializing store:', error);
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
  getSquareCODSyncStatus
};