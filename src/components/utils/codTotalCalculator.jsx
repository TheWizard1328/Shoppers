import { base44 } from '@/api/base44Client';
import { userHasRole } from '@/components/utils/userRoles';

/**
 * Calculate total COD amount remaining to collect based on user role and city
 * Uses catalog items (pending collections) as the source of truth
 * Excludes items that have matching payment transactions
 * 
 * @param {Object} currentUser - Current user object with role and store assignments
 * @param {Array} catalogItems - Square catalog items (pending CODs)
 * @param {Array} locationConfigs - Square location configurations
 * @param {Array} stores - Store data
 * @param {Array} transactions - Square transactions to check for payments (optional)
 * @returns {number} - Total COD amount due
 */
export const calculateUserCodTotal = (currentUser, catalogItems = [], locationConfigs = [], stores = [], transactions = []) => {
  if (!currentUser || !catalogItems || catalogItems.length === 0) {
    return 0;
  }

  // Build a set of catalog item IDs that have completed payment transactions
  const paidItemIds = new Set();
  if (transactions && transactions.length > 0) {
    transactions.forEach(txn => {
      if (txn.type === 'collection' && txn.status === 'completed' && txn.square_catalog_object_id) {
        paidItemIds.add(txn.square_catalog_object_id);
      }
    });
  }

  let filteredItems = [];

  // Filter based on user role
  if (userHasRole(currentUser, 'driver')) {
    // Drivers: Only see CODs for their assigned Square locations
    const driverLocationIds = currentUser.square_location_ids || [];
    const squareLocationIds = locationConfigs
      .filter(c => driverLocationIds.includes(c.id))
      .map(c => c.square_location_id);
    
    filteredItems = catalogItems.filter(item => 
      squareLocationIds.includes(item.location_id) && !paidItemIds.has(item.catalog_object_id)
    );
  } else if (userHasRole(currentUser, 'dispatcher')) {
    // Dispatchers: See CODs for stores they manage
    const dispatcherStoreIds = currentUser.store_ids || [];
    filteredItems = catalogItems.filter(item => {
      const config = locationConfigs.find(c => c.square_location_id === item.location_id);
      const store = stores.find(s => s.square_location_config_id === config?.id);
      return store && dispatcherStoreIds.includes(store.id) && !paidItemIds.has(item.catalog_object_id);
    });
  } else if (userHasRole(currentUser, 'admin')) {
    // Admins: See all CODs except paid ones
    filteredItems = catalogItems.filter(item => !paidItemIds.has(item.catalog_object_id));
  }

  // Sum the amounts
  return filteredItems.reduce((sum, item) => sum + (item.price_dollars || 0), 0);
};

/**
 * Fetch fresh catalog items from the database
 * @returns {Promise<Array>} - Array of catalog items
 */
export const fetchCatalogItems = async () => {
  try {
    const response = await base44.functions.invoke('squareSyncCatalogItems', {});
    const data = response?.data || response;
    return data.items || [];
  } catch (error) {
    console.error('Failed to fetch catalog items:', error);
    return [];
  }
};