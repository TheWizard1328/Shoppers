import { offlineDB } from './offlineDatabase';

// Store names for Square COD data
const SQUARE_COD_STORES = {
  CATALOG_ITEMS: 'square_catalog_items',
  PAYMENT_TRANSACTIONS: 'square_payment_transactions'
};

// Add stores to offlineDB STORES
offlineDB.STORES.SQUARE_CATALOG_ITEMS = SQUARE_COD_STORES.CATALOG_ITEMS;
offlineDB.STORES.SQUARE_PAYMENT_TRANSACTIONS = SQUARE_COD_STORES.PAYMENT_TRANSACTIONS;

/**
 * Save catalog items to offline database
 */
export const saveCatalogItemsOffline = async (items) => {
  if (!items || items.length === 0) {
    return { success: true, count: 0 };
  }

  try {
    const result = await offlineDB.bulkSave(SQUARE_COD_STORES.CATALOG_ITEMS, items);
    
    if (result.success) {
      // Count actual items in database to ensure accuracy
      const allItems = await offlineDB.getAll(SQUARE_COD_STORES.CATALOG_ITEMS);
      const actualCount = allItems.length;
      
      await offlineDB.updateSyncStatus('SquareCatalogItems', {
        status: 'synced',
        recordCount: actualCount,
        lastSync: new Date().toISOString()
      });
      
      console.log(`✅ [SquareCODOffline] Saved ${result.count} catalog items offline (${actualCount} total in DB)`);
    }
    
    return result;
  } catch (error) {
    console.error('❌ [SquareCODOffline] Error saving catalog items:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Save payment transactions to offline database
 */
export const savePaymentTransactionsOffline = async (transactions) => {
  if (!transactions || transactions.length === 0) {
    return { success: true, count: 0 };
  }

  try {
    const result = await offlineDB.bulkSave(SQUARE_COD_STORES.PAYMENT_TRANSACTIONS, transactions);
    
    if (result.success) {
      await offlineDB.updateSyncStatus('SquarePaymentTransactions', {
        status: 'synced',
        recordCount: transactions.length,
        lastSync: new Date().toISOString()
      });
      
      console.log(`✅ [SquareCODOffline] Saved ${result.count} payment transactions offline`);
    }
    
    return result;
  } catch (error) {
    console.error('❌ [SquareCODOffline] Error saving payment transactions:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Get all catalog items from offline database
 */
export const getCatalogItemsOffline = async () => {
  try {
    const items = await offlineDB.getAll(SQUARE_COD_STORES.CATALOG_ITEMS);
    console.log(`📖 [SquareCODOffline] Retrieved ${items.length} catalog items from offline db`);
    return items || [];
  } catch (error) {
    console.error('❌ [SquareCODOffline] Error retrieving catalog items:', error);
    return [];
  }
};

/**
 * Get all payment transactions from offline database
 */
export const getPaymentTransactionsOffline = async () => {
  try {
    const transactions = await offlineDB.getAll(SQUARE_COD_STORES.PAYMENT_TRANSACTIONS);
    console.log(`📖 [SquareCODOffline] Retrieved ${transactions.length} payment transactions from offline db`);
    return transactions || [];
  } catch (error) {
    console.error('❌ [SquareCODOffline] Error retrieving payment transactions:', error);
    return [];
  }
};

/**
 * Get catalog items by location
 */
export const getCatalogItemsByLocationOffline = async (locationId) => {
  try {
    const items = await offlineDB.getByIndex(SQUARE_COD_STORES.CATALOG_ITEMS, 'location_id', locationId);
    return items || [];
  } catch (error) {
    console.error('❌ [SquareCODOffline] Error retrieving items by location:', error);
    return [];
  }
};

/**
 * Get payment transactions by location
 */
export const getPaymentTransactionsByLocationOffline = async (locationId) => {
  try {
    const transactions = await offlineDB.getByIndex(SQUARE_COD_STORES.PAYMENT_TRANSACTIONS, 'location_id', locationId);
    return transactions || [];
  } catch (error) {
    console.error('❌ [SquareCODOffline] Error retrieving transactions by location:', error);
    return [];
  }
};

/**
 * Clear all Square COD offline data
 */
export const clearSquareCODOfflineData = async () => {
  try {
    await Promise.all([
      offlineDB.clearStore(SQUARE_COD_STORES.CATALOG_ITEMS),
      offlineDB.clearStore(SQUARE_COD_STORES.PAYMENT_TRANSACTIONS)
    ]);
    
    console.log('✅ [SquareCODOffline] Cleared all Square COD offline data');
    return { success: true };
  } catch (error) {
    console.error('❌ [SquareCODOffline] Error clearing data:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Get sync status for Square COD data
 */
export const getSquareCODSyncStatus = async () => {
  try {
    const [catalogStatus, transactionStatus] = await Promise.all([
      offlineDB.getSyncStatus('SquareCatalogItems'),
      offlineDB.getSyncStatus('SquarePaymentTransactions')
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

/**
 * Initialize catalog items store (create indexes)
 */
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
  getCatalogItemsOffline,
  getPaymentTransactionsOffline,
  getCatalogItemsByLocationOffline,
  getPaymentTransactionsByLocationOffline,
  clearSquareCODOfflineData,
  getSquareCODSyncStatus
};