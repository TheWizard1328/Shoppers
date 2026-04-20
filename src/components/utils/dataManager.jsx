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
import {
  markOfflineDBLoadComplete,
  isOfflineDBLoadComplete
} from './dataManagerOfflineState';

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

// NO FREQUENT CACHE - removed

export { getData, markOfflineDBLoadComplete, isOfflineDBLoadComplete };

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