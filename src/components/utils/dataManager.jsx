import { Patient } from '@/entities/Patient';
import { Delivery } from '@/entities/Delivery';
import { Store } from '@/entities/Store';
import { User } from '@/entities/User';
import { City } from '@/entities/City';
import { AppUser } from '@/entities/AppUser';
import { format, subDays } from 'date-fns';
import { offlineDB } from './offlineDatabase';
import { 
  createPatientLocal, 
  updatePatientLocal, 
  deletePatientLocal,
  createDeliveryLocal,
  updateDeliveryLocal,
  deleteDeliveryLocal,
  batchCreateDeliveriesLocal,
  subscribeMutations
} from './offlineMutations';

const entities = {
  Patient,
  Delivery,
  Store,
  User,
  City,
  AppUser
};

const cache = new Map();
const cacheTimestamps = new Map();
const CACHE_DURATION = 15 * 60 * 1000; // 15 minutes (increased from 5 min) to prevent stale data issues

// Date range-based delivery cache for staged loading
const deliveryRangeCache = new Map();
const deliveryRangeCacheTimestamps = new Map();
const DELIVERY_RANGE_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes for historical data

// Rate limit protection - track last API call time
let lastApiCallTime = 0;
const MIN_API_INTERVAL = 1000; // 1 second between API calls to prevent rate limiting

const waitForRateLimit = async () => {
  const now = Date.now();
  const timeSinceLastCall = now - lastApiCallTime;
  if (timeSinceLastCall < MIN_API_INTERVAL) {
    const waitTime = MIN_API_INTERVAL - timeSinceLastCall;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  lastApiCallTime = Date.now();
};

export const getData = async (entityName, sortKey = null, queryOrLimit = null, forceRefresh = false) => {
  // Determine if queryOrLimit is a query object or a limit number
  const isQueryObject = queryOrLimit && typeof queryOrLimit === 'object' && !Array.isArray(queryOrLimit);
  const query = isQueryObject ? queryOrLimit : null;
  const limit = !isQueryObject && typeof queryOrLimit === 'number' ? queryOrLimit : null;
  
  const cacheKey = `${entityName}_${sortKey || 'default'}_${JSON.stringify(query) || 'noquery'}_${limit || 'all'}`;
  
  // OFFLINE-FIRST: Try IndexedDB for Patient and Delivery entities
  if (!forceRefresh && (entityName === 'Patient' || entityName === 'Delivery')) {
    try {
      const storeName = entityName === 'Patient' ? offlineDB.STORES.PATIENTS : offlineDB.STORES.DELIVERIES;
      let offlineData = await offlineDB.getAll(storeName);
      
      if (offlineData && offlineData.length > 0) {
        cache.set(cacheKey, offlineData);
        cacheTimestamps.set(cacheKey, Date.now());
        return offlineData;
      }
    } catch (offlineError) {
      console.warn(`⚠️ [dataManager] Offline ${entityName} fetch failed, falling back to network:`, offlineError);
    }
  }
  
  if (!forceRefresh && cache.has(cacheKey)) {
    const timestamp = cacheTimestamps.get(cacheKey);
    if (timestamp && Date.now() - timestamp < CACHE_DURATION) {
      return cache.get(cacheKey);
    }
  }

  let retries = 3;
  let lastError = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // CRITICAL: Wait for rate limit before making API call
      await waitForRateLimit();

      if (attempt > 0) {
        // Exponential backoff: 1s, 2s, 4s
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      const Entity = entities[entityName];
      if (!Entity) {
        return [];
      }

      let data;
      
      // FIXED: Use correct method signatures
      // .list(sortKey?, limit?) - for listing without filters
      // .filter(query, sortKey?, limit?) - for filtering with query
      
      if (query) {
        // Use filter method when query exists
        if (sortKey && limit) {
          data = await Entity.filter(query, sortKey, limit);
        } else if (sortKey) {
          data = await Entity.filter(query, sortKey);
        } else {
          data = await Entity.filter(query);
        }
      } else {
        // Use list method when no query
        if (sortKey && limit) {
          data = await Entity.list(sortKey, limit);
        } else if (sortKey) {
          data = await Entity.list(sortKey);
        } else {
          data = await Entity.list();
        }
      }

      cache.set(cacheKey, data);
      cacheTimestamps.set(cacheKey, Date.now());

      // BACKGROUND: Save to IndexedDB for offline access
      if (entityName === 'Patient' || entityName === 'Delivery') {
        const storeName = entityName === 'Patient' ? offlineDB.STORES.PATIENTS : offlineDB.STORES.DELIVERIES;
        offlineDB.bulkSave(storeName, data).catch(err => {
        });
      }

      return data;
      
    } catch (error) {
        lastError = error;

        // Handle WebSocket errors gracefully (return cached data if available)
        if (error.message?.includes('WebSocket') || error.message?.includes('closed without opened')) {
          if (cache.has(cacheKey)) {
            return cache.get(cacheKey);
          }
          cache.set(cacheKey, []);
          cacheTimestamps.set(cacheKey, Date.now());
          return [];
        }

        // CRITICAL: Handle 403 Forbidden gracefully (user doesn't have permission)
        if (error.response?.status === 403 || error.message?.includes('403')) {
          cache.set(cacheKey, []);
          cacheTimestamps.set(cacheKey, Date.now());
          return [];
        }

        if (attempt < retries - 1 && (error.message?.includes('Network Error') || error.code === 'NETWORK_ERROR')) {
          continue;
        }

        if (error.response?.status === 429 || error.message?.includes('429')) {
          // Exponential backoff for rate limits: 2s, 4s, 8s
          const backoffDelay = Math.min(2000 * Math.pow(2, attempt), 10000);
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
          if (attempt < retries - 1) continue;
        }

        break;
      }
  }
  
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }
  
  return [];
};

export const invalidate = (entityName) => {
  const keysToDelete = [];
  for (const key of cache.keys()) {
    if (key.startsWith(`${entityName}_`)) {
      keysToDelete.push(key);
    }
  }
  if (keysToDelete.length > 0) {
    keysToDelete.forEach(key => {
      cache.delete(key);
      cacheTimestamps.delete(key);
    });
  }
  
  // Also invalidate delivery range cache for Delivery entities
  if (entityName === 'Delivery') {
    invalidateDeliveryRangeCache();
  }
};

export const getCached = (entityName) => {
  const cacheKey = `${entityName}_default_noquery_all`;
  if (cache.has(cacheKey)) {
    const timestamp = cacheTimestamps.get(cacheKey);
    if (timestamp && Date.now() - timestamp < CACHE_DURATION) {
      return cache.get(cacheKey);
    }
  }
  return null;
};

export const setCached = (entityName, data) => {
  const cacheKey = `${entityName}_default_noquery_all`;
  cache.set(cacheKey, data);
  cacheTimestamps.set(cacheKey, Date.now());
};

/**
 * Get deliveries for a specific date range with caching
 * @param {string} startDate - Start date (yyyy-MM-dd)
 * @param {string} endDate - End date (yyyy-MM-dd)
 * @param {object} filters - Additional filters (store_id, driver_id, etc.)
 * @param {boolean} forceRefresh - Force bypass cache
 * @returns {Promise<Array>} - Deliveries for that date range
 */
export const getDeliveriesForDateRange = async (startDate, endDate, filters = {}, forceRefresh = false) => {
  const cacheKey = `Delivery_range_${startDate}_${endDate}_${JSON.stringify(filters)}`;
  
  // Check cache first
  if (!forceRefresh) {
    const cachedData = deliveryRangeCache.get(cacheKey);
    const cachedTimestamp = deliveryRangeCacheTimestamps.get(cacheKey);
    
    if (cachedData && cachedTimestamp && (Date.now() - cachedTimestamp < DELIVERY_RANGE_CACHE_DURATION)) {
      return cachedData;
    }
  }
  
  const rangeFilters = {
    ...filters,
    delivery_date: {
      $gte: startDate,
      $lte: endDate
    }
  };
  
  try {
    // CRITICAL: Wait for rate limit before making API call
    await waitForRateLimit();
    
    const Entity = entities.Delivery;
    const deliveries = await Entity.filter(rangeFilters, '-updated_date');
    
    // Cache the result
    deliveryRangeCache.set(cacheKey, deliveries);
    deliveryRangeCacheTimestamps.set(cacheKey, Date.now());
    
    return deliveries;
  } catch (error) {
    // Handle WebSocket errors gracefully
    if (error.message?.includes('WebSocket') || error.message?.includes('closed without opened')) {
      if (deliveryRangeCache.has(cacheKey)) {
        return deliveryRangeCache.get(cacheKey);
      }
      return [];
    }
    
    throw error;
  }
};

/**
 * Load deliveries for a specific date (priority loading)
 * Used for loading today's/selected date's data first
 * 
 * @param {string} dateStr - Date in yyyy-MM-dd format
 * @param {object} filters - Filters to apply (store_id, driver_id, etc.)
 * @param {boolean} forceRefresh - Force bypass cache
 * @returns {Promise<Array>} - Deliveries for that date
 */
export const loadDeliveriesForDate = async (dateStr, filters = {}, forceRefresh = false) => {
  const cacheKey = `Delivery_date_${dateStr}_${JSON.stringify(filters)}`;
  
  // OFFLINE-FIRST: Try IndexedDB first
  if (!forceRefresh) {
    try {
      let offlineData = await offlineDB.getByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', dateStr);
      
      // Apply additional filters locally
      if (filters.store_id) {
        const storeIds = filters.store_id.$in || [filters.store_id];
        offlineData = offlineData.filter(d => storeIds.includes(d.store_id));
      }
      if (filters.driver_id) {
        offlineData = offlineData.filter(d => d.driver_id === filters.driver_id);
      }
      
      if (offlineData && offlineData.length > 0) {
        deliveryRangeCache.set(cacheKey, offlineData);
        deliveryRangeCacheTimestamps.set(cacheKey, Date.now());
        return offlineData;
      }
    } catch (offlineError) {
      console.warn(`⚠️ [dataManager] Offline delivery fetch failed, falling back to network:`, offlineError);
    }
  }
  
  // Check cache next
  if (!forceRefresh) {
    const cachedData = deliveryRangeCache.get(cacheKey);
    const cachedTimestamp = deliveryRangeCacheTimestamps.get(cacheKey);
    
    if (cachedData && cachedTimestamp && (Date.now() - cachedTimestamp < DELIVERY_RANGE_CACHE_DURATION)) {
      return cachedData;
    }
  }
  
  const dateFilters = {
    ...filters,
    delivery_date: dateStr
  };
  
  
  try {
    await waitForRateLimit();
    
    const Entity = entities.Delivery;
    const deliveries = await Entity.filter(dateFilters, '-updated_date');
    
    // Cache the result
    deliveryRangeCache.set(cacheKey, deliveries);
    deliveryRangeCacheTimestamps.set(cacheKey, Date.now());

    // BACKGROUND: Save to IndexedDB
    offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries).catch(err => {
    });

    return deliveries;
  } catch (error) {
    if (error.message?.includes('WebSocket') || error.message?.includes('closed without opened')) {
      if (deliveryRangeCache.has(cacheKey)) {
        return deliveryRangeCache.get(cacheKey);
      }
      return [];
    }
    
    console.error(`❌ [dataManager] Error fetching deliveries for ${dateStr}:`, error);
    throw error;
  }
};

/**
 * Load 3 months of deliveries (background) - expanded from 30 days for better historical data
 */
export const loadFullMonthDeliveries = async (filters = {}, forceRefresh = false) => {
  const today = new Date();
  const todayStr = format(today, 'yyyy-MM-dd');
  const last90Days = subDays(today, 90); // 3 months of history
  const last90DaysStr = format(last90Days, 'yyyy-MM-dd');

  const deliveries = await getDeliveriesForDateRange(last90DaysStr, todayStr, filters, forceRefresh);
  return deliveries;
};

/**
 * Load deliveries: today first, then next 7 days, then past deliveries in background
 * @param {string} selectedDateStr - Selected date (yyyy-MM-dd)
 * @param {object} priorityFilters - Filters for priority loads (today + next 7 days) - should load ALL drivers
 * @param {object} backgroundFilters - Filters for background past data - can be role-restricted
 * @param {boolean} forceRefresh - Force bypass cache
 * @param {function} onInitialLoadComplete - Callback for initial data (today + next 7 days)
 * @param {function} onFullMonthLoadComplete - Callback for full month data
 */
export const loadDeliveries = async (
  selectedDateStr,
  priorityFilters = {},
  backgroundFilters = {},
  forceRefresh = false,
  onInitialLoadComplete = () => {},
  onFullMonthLoadComplete = () => {}
) => {
  const today = new Date();
  
  // 1. Load selected date's deliveries FIRST (highest priority) - ALL drivers for city
  
  // OFFLINE-FIRST: Try to load from IndexedDB immediately for instant UI
  try {
    const offlineDeliveries = await offlineDB.getByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', selectedDateStr);
    if (offlineDeliveries && offlineDeliveries.length > 0 && !forceRefresh) {
      onInitialLoadComplete(offlineDeliveries);
    }
  } catch (err) {
    console.warn('⚠️ [dataManager] Offline load failed, fetching from network');
  }
  
  const selectedDateDeliveries = await loadDeliveriesForDate(selectedDateStr, priorityFilters, forceRefresh);
  
  // CRITICAL: Immediately refresh UI with fresh data from server
  onInitialLoadComplete(selectedDateDeliveries);
  
  // BACKGROUND: Load entire date range in ONE API call after UI is ready
  setTimeout(async () => {
    try {
      // Wait 2 seconds before background load
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Calculate date range: 30 days back + 7 days forward
      const past30Days = subDays(today, 30);
      const future7Days = new Date(today);
      future7Days.setDate(today.getDate() + 7);

      // SINGLE API CALL for entire range - no more per-day fetching!
      const allRangeDeliveries = await getDeliveriesForDateRange(
        format(past30Days, 'yyyy-MM-dd'),
        format(future7Days, 'yyyy-MM-dd'),
        backgroundFilters,
        forceRefresh
      );

      // Merge with selected date deliveries (deduplicate by ID)
      const deliveryMap = new Map();
      allRangeDeliveries.forEach(d => deliveryMap.set(d.id, d));
      selectedDateDeliveries.forEach(d => deliveryMap.set(d.id, d));

      const allDeliveries = Array.from(deliveryMap.values());
      onFullMonthLoadComplete(allDeliveries);
    } catch (error) {
      console.error('❌ [dataManager] Error in background load:', error);
      // Still provide selected date data on error
      onFullMonthLoadComplete(selectedDateDeliveries);
    }
  }, 0);

  return selectedDateDeliveries;
};

/**
 * Invalidate delivery range cache
 */
export const invalidateDeliveryRangeCache = () => {
  deliveryRangeCache.clear();
  deliveryRangeCacheTimestamps.clear();
};

/**
 * Invalidate deliveries for a specific date only
 * This is more efficient than invalidating all delivery caches
 * @param {string} dateString - Date in yyyy-MM-dd format
 */
export const invalidateDeliveriesForDate = (dateString) => {
  if (!dateString) {
    return;
  }
  
  let keysDeleted = 0;
  
  // Clear from main cache - any key containing this date
  for (const key of cache.keys()) {
    if (key.startsWith('Delivery_') && key.includes(dateString)) {
      cache.delete(key);
      cacheTimestamps.delete(key);
      keysDeleted++;
    }
  }
  
  // Clear from delivery range cache - any range that includes this date
  for (const key of deliveryRangeCache.keys()) {
    if (key.includes(dateString)) {
      deliveryRangeCache.delete(key);
      deliveryRangeCacheTimestamps.delete(key);
      keysDeleted++;
    }
  }
  
};

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
  
  // Subscribe to mutation events for UI updates
  subscribeMutations
};