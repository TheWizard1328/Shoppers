import { format } from 'date-fns';

export { format };
import {
  invalidate,
  getCached,
  setCached,
  invalidateDeliveryRangeCache,
  updateCache,
  removeDeletedFromCache,
  invalidateDeliveriesForDate
} from './dataManagerCacheHelpers';

export {
  invalidate,
  getCached,
  setCached,
  invalidateDeliveryRangeCache,
  updateCache,
  removeDeletedFromCache,
  invalidateDeliveriesForDate
};
import { getData } from './dataManagerGetData';
import {
  getDeliveriesForDateRange,
  loadDeliveriesForDate,
  loadFullMonthDeliveries,
  loadPriorityDeliveriesForSelection,
  loadDeliveries
} from './dataManagerDeliveryLoader';
import { loadBackgroundDeliveries } from './dataManagerBackgroundLoader';

export {
  getDeliveriesForDateRange,
  loadDeliveriesForDate,
  loadFullMonthDeliveries,
  loadPriorityDeliveriesForSelection,
  loadDeliveries
};
import { 
  createPatientLocal, 
  updatePatientLocal, 
  deletePatientLocal,
  createDeliveryLocal,
  updateDeliveryLocal,
  deleteDeliveryLocal,
  batchCreateDeliveriesLocal,
  createCityLocal,
  updateCityLocal,
  deleteCityLocal,
  createStoreLocal,
  updateStoreLocal,
  deleteStoreLocal,
  createCompanyLocal,
  updateCompanyLocal,
  deleteCompanyLocal,
  subscribeMutations
} from './offlineMutations';

// CRITICAL: NO IN-MEMORY CACHE - Use offline DB exclusively
// Deleted all cache layers to prevent stale data and reappearing deleted items

// Track offline DB load completion
let offlineDBLoadComplete = false;

export const markOfflineDBLoadComplete = () => {
  offlineDBLoadComplete = true;
};

export const isOfflineDBLoadComplete = () => {
  return offlineDBLoadComplete;
};

// NO FREQUENT CACHE - removed

export { getData };

/**
 * Local-first write operations - exported for use in forms
 */
export const localWrites = {
  // Patient operations
  createPatient: createPatientLocal,
  updatePatient: updatePatientLocal,
  deletePatient: deletePatientLocal,
  
  // Delivery operations
  createDelivery: createDeliveryLocal,
  updateDelivery: updateDeliveryLocal,
  deleteDelivery: deleteDeliveryLocal,
  batchCreateDeliveries: batchCreateDeliveriesLocal,

  // City operations
  createCity: createCityLocal,
  updateCity: updateCityLocal,
  deleteCity: deleteCityLocal,

  // Store operations
  createStore: createStoreLocal,
  updateStore: updateStoreLocal,
  deleteStore: deleteStoreLocal,

  // Company operations
  createCompany: createCompanyLocal,
  updateCompany: updateCompanyLocal,
  deleteCompany: deleteCompanyLocal,
  
  // Subscribe to mutation events for UI updates
  subscribeMutations
};