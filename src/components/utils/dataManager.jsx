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
import { localWrites } from './dataManagerLocalWrites';

// CRITICAL: NO IN-MEMORY CACHE - Use offline DB exclusively
// Deleted all cache layers to prevent stale data and reappearing deleted items

// NO FREQUENT CACHE - removed

export { getData, markOfflineDBLoadComplete, isOfflineDBLoadComplete };

export { localWrites };