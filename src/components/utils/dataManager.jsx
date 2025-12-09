import { Patient } from '@/entities/Patient';
import { Delivery } from '@/entities/Delivery';
import { Store } from '@/entities/Store';
import { User } from '@/entities/User';
import { City } from '@/entities/City';
import { AppUser } from '@/entities/AppUser';
import { format, subDays } from 'date-fns';
import { offlineDB } from './offlineDatabase';

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
const MIN_API_INTERVAL = 150; // Minimum 150ms between API calls

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
        console.log(`📱 [dataManager] Using offline ${entityName} data (${offlineData.length} records)`);
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
      console.log(`✅ [dataManager] Using cached ${entityName} data for key: ${cacheKey}`);
      return cache.get(cacheKey);
    }
  }

  if (forceRefresh) {
    console.log(`🔄 [dataManager] Forcing refresh for ${entityName} (bypassing cache for key: ${cacheKey})`);
  } else if (cache.has(cacheKey)) {
    console.log(`⚠️ [dataManager] Cache for ${entityName} (key: ${cacheKey}) expired or invalid, refetching.`);
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
        console.log(`⏳ [dataManager] Retry attempt ${attempt + 1}/${retries} for ${entityName} after ${delay}ms delay`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      const Entity = entities[entityName];
      if (!Entity) {
        console.error(`[dataManager] Entity ${entityName} not found`);
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
          console.warn(`⚠️ [dataManager] Failed to save ${entityName} to IndexedDB:`, err);
        });
      }

      console.log(`✅ [dataManager] Fetched ${data?.length || 0} ${entityName} records for key: ${cacheKey}`);
      return data;
      
    } catch (error) {
        lastError = error;

        // Handle WebSocket errors gracefully (return cached data if available)
        if (error.message?.includes('WebSocket') || error.message?.includes('closed without opened')) {
          console.warn(`⚠️ [dataManager] WebSocket connection issue for ${entityName}, using cached data`);
          if (cache.has(cacheKey)) {
            console.log(`   ↩️ Returning cached ${entityName} (from key: ${cacheKey})`);
            return cache.get(cacheKey);
          }
          cache.set(cacheKey, []);
          cacheTimestamps.set(cacheKey, Date.now());
          return [];
        }

        // CRITICAL: Handle 403 Forbidden gracefully (user doesn't have permission)
        if (error.response?.status === 403 || error.message?.includes('403')) {
          console.warn(`🔒 [dataManager] Access forbidden for ${entityName} (user lacks permission) - returning empty array`);
          cache.set(cacheKey, []);
          cacheTimestamps.set(cacheKey, Date.now());
          return [];
        }

        console.error(`❌ [dataManager] Error fetching ${entityName} (attempt ${attempt + 1}/${retries}):`, error.message);

        if (attempt < retries - 1 && (error.message?.includes('Network Error') || error.code === 'NETWORK_ERROR')) {
          continue;
        }

        if (error.response?.status === 429 || error.message?.includes('429')) {
          // Exponential backoff for rate limits: 2s, 4s, 8s
          const backoffDelay = Math.min(2000 * Math.pow(2, attempt), 10000);
          console.warn(`⏰ [dataManager] Rate limited (429), waiting ${backoffDelay}ms before retry`);
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
          if (attempt < retries - 1) continue;
        }

        break;
      }
  }
  
  console.warn(`⚠️ [dataManager] All attempts failed for ${entityName} (key: ${cacheKey}), checking for stale cache`);
  if (cache.has(cacheKey)) {
    console.warn(`⚠️ [dataManager] Returning stale cached data for ${entityName} (key: ${cacheKey})`);
    return cache.get(cacheKey);
  }
  
  console.error(`❌ [dataManager] No data available for ${entityName} (key: ${cacheKey})`);
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
    console.log(`🗑️ [dataManager] Invalidated cache for ${entityName} (${keysToDelete.length} keys deleted)`);
  } else {
    console.log(`ℹ️ [dataManager] No cache entries found to invalidate for ${entityName}`);
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
  console.log(`💾 [dataManager] Cached ${data?.length || 0} ${entityName} records for key: ${cacheKey}`);
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
      console.log(`📦 [dataManager] Using cached deliveries for ${startDate} to ${endDate} (${cachedData.length} records)`);
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
  
  console.log(`🔄 [dataManager] Fetching deliveries for ${startDate} to ${endDate}...`);
  
  try {
    // CRITICAL: Wait for rate limit before making API call
    await waitForRateLimit();
    
    const Entity = entities.Delivery;
    const deliveries = await Entity.filter(rangeFilters, '-updated_date');
    
    // Cache the result
    deliveryRangeCache.set(cacheKey, deliveries);
    deliveryRangeCacheTimestamps.set(cacheKey, Date.now());
    
    console.log(`✅ [dataManager] Loaded ${deliveries.length} deliveries for ${startDate} to ${endDate}`);
    return deliveries;
  } catch (error) {
    // Handle WebSocket errors gracefully
    if (error.message?.includes('WebSocket') || error.message?.includes('closed without opened')) {
      console.warn(`⚠️ [dataManager] WebSocket connection issue for ${startDate} to ${endDate}, using cached data`);
      if (deliveryRangeCache.has(cacheKey)) {
        return deliveryRangeCache.get(cacheKey);
      }
      return [];
    }
    
    console.error(`❌ [dataManager] Error fetching deliveries for ${startDate} to ${endDate}:`, error);
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
        console.log(`📱 [dataManager] Using offline deliveries for ${dateStr} (${offlineData.length} records)`);
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
      console.log(`📦 [dataManager] Using cached deliveries for ${dateStr} (${cachedData.length} records)`);
      return cachedData;
    }
  }
  
  const dateFilters = {
    ...filters,
    delivery_date: dateStr
  };
  
  console.log(`🚀 [dataManager] PRIORITY: Loading deliveries for ${dateStr}...`);
  
  try {
    await waitForRateLimit();
    
    const Entity = entities.Delivery;
    const deliveries = await Entity.filter(dateFilters, '-updated_date');
    
    // Cache the result
    deliveryRangeCache.set(cacheKey, deliveries);
    deliveryRangeCacheTimestamps.set(cacheKey, Date.now());

    // BACKGROUND: Save to IndexedDB
    offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries).catch(err => {
      console.warn('⚠️ [dataManager] Failed to save deliveries to IndexedDB:', err);
    });

    console.log(`✅ [dataManager] PRIORITY: Loaded ${deliveries.length} deliveries for ${dateStr}`);
    return deliveries;
  } catch (error) {
    if (error.message?.includes('WebSocket') || error.message?.includes('closed without opened')) {
      console.warn(`⚠️ [dataManager] WebSocket issue for ${dateStr}, using cached data`);
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
 * Load full month of deliveries (background)
 */
export const loadFullMonthDeliveries = async (filters = {}, forceRefresh = false) => {
  const today = new Date();
  const todayStr = format(today, 'yyyy-MM-dd');
  const last30Days = subDays(today, 30);
  const last30DaysStr = format(last30Days, 'yyyy-MM-dd');

  console.log(`🚀 [dataManager] Background: Loading full 30 days of deliveries (${last30DaysStr} to ${todayStr})`);
  const deliveries = await getDeliveriesForDateRange(last30DaysStr, todayStr, filters, forceRefresh);
  console.log(`✅ [dataManager] Background: Loaded ${deliveries.length} deliveries for full month`);
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
  console.log(`🚀 [dataManager] PRIORITY 1: Loading selected date deliveries (${selectedDateStr}) - ALL drivers for city`);
  const selectedDateDeliveries = await loadDeliveriesForDate(selectedDateStr, priorityFilters, forceRefresh);
  console.log(`✅ [dataManager] PRIORITY 1 Complete: ${selectedDateDeliveries.length} deliveries for selected date`);
  
  // CRITICAL: Immediately refresh UI with selected date data
  console.log(`⚡ [dataManager] Calling onInitialLoadComplete to refresh UI NOW`);
  onInitialLoadComplete(selectedDateDeliveries);
  
  // BACKGROUND: Load future + past data after UI is ready
  setTimeout(async () => {
    try {
      // Wait 1 second before starting background loads
      console.log(`⏱️ [dataManager] Waiting 1 second before background loads...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Load next 7 days with 500ms pause between dates
      console.log(`🚀 [dataManager] BACKGROUND: Loading next 7 days - ALL drivers...`);
      const futureDeliveries = [];
      for (let i = 1; i <= 7; i++) {
        const futureDate = new Date(today);
        futureDate.setDate(today.getDate() + i);
        const futureDateStr = format(futureDate, 'yyyy-MM-dd');
        
        try {
          const dayDeliveries = await loadDeliveriesForDate(futureDateStr, priorityFilters, forceRefresh);
          futureDeliveries.push(...dayDeliveries);
          console.log(`  ✅ Loaded ${dayDeliveries.length} deliveries for ${futureDateStr}`);
          
          if (i < 7) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (error) {
          console.error(`  ❌ Error loading ${futureDateStr}:`, error);
          if (error.response?.status === 429 || error.message?.includes('429')) {
            console.warn(`⏰ Rate limit - waiting 3s before continuing...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }
      }
      console.log(`✅ [dataManager] BACKGROUND: Loaded ${futureDeliveries.length} future deliveries`);
      
      // Wait 1 second before loading past data
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Load past 30 days with 500ms pause between dates
      const last30Days = subDays(today, 30);
      const yesterdayStr = format(subDays(today, 1), 'yyyy-MM-dd');
      console.log(`🚀 [dataManager] BACKGROUND: Loading past 30 days (${format(last30Days, 'yyyy-MM-dd')} to ${yesterdayStr})`);
      
      const pastDeliveries = [];
      for (let i = 29; i >= 1; i--) {
        const date = subDays(today, i);
        const dateStr = format(date, 'yyyy-MM-dd');
        
        try {
          const dayDeliveries = await loadDeliveriesForDate(dateStr, backgroundFilters, forceRefresh);
          pastDeliveries.push(...dayDeliveries);
          console.log(`  ✅ Loaded ${dayDeliveries.length} deliveries for ${dateStr} (${i} days ago)`);
          
          if (i > 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } catch (dateError) {
          console.error(`  ❌ Error loading ${dateStr}:`, dateError);
          if (dateError.response?.status === 429 || dateError.message?.includes('429')) {
            console.warn(`⏰ Rate limit - waiting 3s before continuing...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }
      }
      console.log(`✅ [dataManager] BACKGROUND: Loaded ${pastDeliveries.length} past deliveries`);
      
      // Combine all: past + selected + future
      const allDeliveries = [...pastDeliveries, ...selectedDateDeliveries, ...futureDeliveries];
      onFullMonthLoadComplete(allDeliveries);
      console.log(`✅ [dataManager] BACKGROUND COMPLETE: Total ${allDeliveries.length} deliveries loaded`);
    } catch (error) {
      console.error('❌ [dataManager] Error in background load:', error);
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
  console.log(`🗑️ [dataManager] Invalidated all delivery range caches`);
};

/**
 * Invalidate deliveries for a specific date only
 * This is more efficient than invalidating all delivery caches
 * @param {string} dateString - Date in yyyy-MM-dd format
 */
export const invalidateDeliveriesForDate = (dateString) => {
  if (!dateString) {
    console.warn('⚠️ [dataManager] invalidateDeliveriesForDate called without date');
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
  
  console.log(`🗑️ [dataManager] Invalidated ${keysDeleted} cache entries for date: ${dateString}`);
};