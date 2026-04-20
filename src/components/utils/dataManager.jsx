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
export {
  getDeliveriesForDateRange,
  loadDeliveriesForDate,
  loadFullMonthDeliveries,
  loadPriorityDeliveriesForSelection,
  loadDeliveries,
  loadBackgroundDeliveries
} from './dataManagerDeliveryExports';
import { localWrites } from './dataManagerLocalWrites';

// CRITICAL: NO IN-MEMORY CACHE - Use offline DB exclusively
// Deleted all cache layers to prevent stale data and reappearing deleted items

// NO FREQUENT CACHE - removed

export { getData, markOfflineDBLoadComplete, isOfflineDBLoadComplete };

export { localWrites };