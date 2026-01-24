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
import { connectionMonitor } from './connectionMonitor';

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
const CACHE_DURATION = 15 * 60 * 1000; // 15 minutes - balance between freshness and rate limit protection

// Advanced caching for frequently accessed entities (Store, AppUser, UserSettings)
const frequentEntityCache = new Map(); // For entities accessed multiple times per session
const frequentEntityTimestamps = new Map();
const FREQUENT_ENTITY_TTL = 5 * 60 * 1000; // 5 minutes for frequently accessed data

// Compressed cache for user settings to reduce API calls
const userSettingsCache = new Map();
const userSettingsCacheTimestamps = new Map();
const USER_SETTINGS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes - user settings rarely change

// Date range-based delivery cache for staged loading
const deliveryRangeCache = new Map();
const deliveryRangeCacheTimestamps = new Map();
const DELIVERY_RANGE_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes for historical data

// Track offline DB load completion
let offlineDBLoadComplete = false;

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

/**
 * Mark offline DB load as complete - allows smart refresh to start
 */
export const markOfflineDBLoadComplete = () => {
  offlineDBLoadComplete = true;
  console.log('✅ [dataManager] Offline DB load complete - smart refresh can now start');
};

/**
 * Check if offline DB load is complete
 */
export const isOfflineDBLoadComplete = () => {
  return offlineDBLoadComplete;
};

/**
 * Get cached data for frequently accessed entities (with shorter TTL)
 * Used for Store, AppUser, and similar entities that are accessed multiple times
 */
export const getFrequentCache = (entityName) => {
  const cacheKey = `${entityName}_frequent`;
  if (frequentEntityCache.has(cacheKey)) {
    const timestamp = frequentEntityTimestamps.get(cacheKey);
    if (timestamp && Date.now() - timestamp < FREQUENT_ENTITY_TTL) {
      console.log(`⚡ [dataManager] Using frequent cache for ${entityName}`);
      return frequentEntityCache.get(cacheKey);
    }
  }
  return null;
};

/**
 * Set frequently accessed entity cache
 */
export const setFrequentCache = (entityName, data) => {
  const cacheKey = `${entityName}_frequent`;
  frequentEntityCache.set(cacheKey, data);
  frequentEntityTimestamps.set(cacheKey, Date.now());
};

/**
 * Invalidate frequent entity cache
 */
export const invalidateFrequentCache = (entityName) => {
  const cacheKey = `${entityName}_frequent`;
  frequentEntityCache.delete(cacheKey);
  frequentEntityTimestamps.delete(cacheKey);
};

export const getData = async (entityName, sortKey = null, queryOrLimit = null, forceRefresh = false) => {
  // Determine if queryOrLimit is a query object or a limit number
  const isQueryObject = queryOrLimit && typeof queryOrLimit === 'object' && !Array.isArray(queryOrLimit);
  const query = isQueryObject ? queryOrLimit : null;
  const limit = !isQueryObject && typeof queryOrLimit === 'number' ? queryOrLimit : null;
  
  const cacheKey = `${entityName}_${sortKey || 'default'}_${JSON.stringify(query) || 'noquery'}_${limit || 'all'}`;
  
  // OFFLINE-FIRST: Try IndexedDB for Patient, Delivery, and Store entities ALWAYS
  // CRITICAL: This prevents rate limits by using local data first
  // NEVER skip offline DB - even on forceRefresh, try offline first then update in background
  if (entityName === 'Patient' || entityName === 'Delivery' || entityName === 'Store') {
    try {
      const storeName = entityName === 'Patient' ? offlineDB.STORES.PATIENTS : 
                        entityName === 'Delivery' ? offlineDB.STORES.DELIVERIES :
                        offlineDB.STORES.STORES;
      let offlineData = await offlineDB.getAll(storeName);
      
      if (offlineData && offlineData.length > 0) {
        console.log(`⚡ [dataManager] Using offline ${entityName}: ${offlineData.length} records`);
        cache.set(cacheKey, offlineData);
        cacheTimestamps.set(cacheKey, Date.now());
        
        // CRITICAL: If forceRefresh=true, update from API in background WITHOUT waiting
        if (forceRefresh) {
          console.log(`🔄 [dataManager] Background API refresh for ${entityName}...`);
          (async () => {
            try {
              await waitForRateLimit();
              const Entity = entities[entityName];
              let freshData;
              
              if (query) {
                freshData = sortKey && limit ? await Entity.filter(query, sortKey, limit) :
                           sortKey ? await Entity.filter(query, sortKey) :
                           await Entity.filter(query);
              } else {
                freshData = sortKey && limit ? await Entity.list(sortKey, limit) :
                           sortKey ? await Entity.list(sortKey) :
                           await Entity.list();
              }
              
              if (freshData && freshData.length > 0) {
                await offlineDB.bulkSave(storeName, freshData);
                console.log(`✅ [dataManager] Background: Updated offline DB with ${freshData.length} ${entityName} records`);
              }
            } catch (bgError) {
              console.warn(`⚠️ [dataManager] Background API refresh failed (non-critical):`, bgError.message);
            }
          })();
        }
        
        return offlineData;
      }
    } catch (offlineError) {
      console.warn(`⚠️ [dataManager] Offline ${entityName} fetch failed, falling back to network:`, offlineError);
    }
  }
  
  // Check in-memory cache before network call (skip on forceRefresh since we handled it above)
  if (cache.has(cacheKey)) {
    const timestamp = cacheTimestamps.get(cacheKey);
    if (timestamp && Date.now() - timestamp < CACHE_DURATION) {
      console.log(`⚡ [dataManager] Using cached ${entityName}: ${cache.get(cacheKey)?.length || 0} records`);
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

      const startTime = Date.now();
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
      
      // Track response time for connection quality
      const responseTime = Date.now() - startTime;
      connectionMonitor.recordResponseTime(responseTime);

      // BACKGROUND: Save to IndexedDB for offline access
      if (entityName === 'Patient' || entityName === 'Delivery' || entityName === 'Store') {
        const storeName = entityName === 'Patient' ? offlineDB.STORES.PATIENTS : 
                          entityName === 'Delivery' ? offlineDB.STORES.DELIVERIES :
                          offlineDB.STORES.STORES;
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
          connectionMonitor.recordError('rate_limit');
          // Exponential backoff for rate limits: 2s, 4s, 8s
          const backoffDelay = Math.min(2000 * Math.pow(2, attempt), 10000);
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
          if (attempt < retries - 1) continue;
        } else {
          connectionMonitor.recordError('network');
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
 * CRITICAL: ALWAYS try offline DB first to prevent rate limits
 * 
 * @param {string} dateStr - Date in yyyy-MM-dd format
 * @param {object} filters - Filters to apply (store_id, driver_id, etc.)
 * @param {boolean} forceRefresh - Force bypass cache
 * @returns {Promise<Array>} - Deliveries for that date
 */
export const loadDeliveriesForDate = async (dateStr, filters = {}, forceRefresh = false) => {
  const cacheKey = `Delivery_date_${dateStr}_${JSON.stringify(filters)}`;
  
  // OFFLINE-FIRST: Try IndexedDB ALWAYS
  // CRITICAL: This prevents rate limits by using local data
  // Even on forceRefresh, return offline data immediately and update in background
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
        console.log(`⚡ [dataManager] Using offline deliveries for ${dateStr}: ${offlineData.length} records`);
        deliveryRangeCache.set(cacheKey, offlineData);
        deliveryRangeCacheTimestamps.set(cacheKey, Date.now());
        
        // CRITICAL: If forceRefresh, update from API in background WITHOUT waiting
        if (forceRefresh) {
          (async () => {
            try {
              await waitForRateLimit();
              const dateFilters = { ...filters, delivery_date: dateStr };
              const freshDeliveries = await Delivery.filter(dateFilters, '-updated_date');
              
              if (freshDeliveries && freshDeliveries.length > 0) {
                await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
                console.log(`✅ [dataManager] Background: Updated ${freshDeliveries.length} deliveries for ${dateStr}`);
              }
            } catch (bgError) {
              console.warn(`⚠️ [dataManager] Background refresh failed (non-critical):`, bgError.message);
            }
          })();
        }
        
        return offlineData;
      }
    } catch (offlineError) {
      console.warn(`⚠️ [dataManager] Offline delivery fetch failed, falling back to network:`, offlineError);
    }
  
  // Check in-memory cache next (before network)
  if (!forceRefresh) {
    const cachedData = deliveryRangeCache.get(cacheKey);
    const cachedTimestamp = deliveryRangeCacheTimestamps.get(cacheKey);
    
    if (cachedData && cachedTimestamp && (Date.now() - cachedTimestamp < DELIVERY_RANGE_CACHE_DURATION)) {
      console.log(`⚡ [dataManager] Using cached deliveries for ${dateStr}: ${cachedData.length} records`);
      return cachedData;
    }
  }
  
  const dateFilters = {
    ...filters,
    delivery_date: dateStr
  };
  
  console.log(`🌐 [dataManager] Fetching deliveries from network for ${dateStr}...`);
  
  try {
    await waitForRateLimit();
    
    const Entity = entities.Delivery;
    const deliveries = await Entity.filter(dateFilters, '-updated_date');
    
    // Cache the result
    deliveryRangeCache.set(cacheKey, deliveries);
    deliveryRangeCacheTimestamps.set(cacheKey, Date.now());

    // BACKGROUND: Save to IndexedDB for future offline use
    offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveries).catch(err => {
    });

    return deliveries;
  } catch (error) {
    // On ANY error, try to return cached/offline data
    if (deliveryRangeCache.has(cacheKey)) {
      console.warn(`⚠️ [dataManager] Network error, using cached data for ${dateStr}`);
      return deliveryRangeCache.get(cacheKey);
    }
    
    // Try offline DB as last resort
    try {
      let offlineData = await offlineDB.getByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', dateStr);
      if (offlineData && offlineData.length > 0) {
        console.warn(`⚠️ [dataManager] Network error, using offline data for ${dateStr}`);
        return offlineData;
      }
    } catch (e) {
      // Ignore offline error
    }
    
    if (error.message?.includes('WebSocket') || error.message?.includes('closed without opened') || 
        error.response?.status === 429 || error.message?.includes('429')) {
      console.warn(`⚠️ [dataManager] Rate limit or WebSocket error for ${dateStr}, returning empty`);
      return [];
    }
    
    console.error(`❌ [dataManager] Error fetching deliveries for ${dateStr}:`, error);
    throw error;
  }
};

/**
 * Load 90 days of deliveries (background) in chunks to avoid rate limits
 */
export const loadFullMonthDeliveries = async (filters = {}, forceRefresh = false) => {
  const today = new Date();
  const deliveryMap = new Map();
  
  // Chunk 1: Past 30 days
  const past30Start = subDays(today, 30);
  const chunk1 = await getDeliveriesForDateRange(
    format(past30Start, 'yyyy-MM-dd'),
    format(today, 'yyyy-MM-dd'),
    filters,
    forceRefresh
  );
  chunk1.forEach(d => deliveryMap.set(d.id, d));
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Chunk 2: Past 31-60 days
  const past60Start = subDays(today, 60);
  const past31Day = subDays(today, 31);
  const chunk2 = await getDeliveriesForDateRange(
    format(past60Start, 'yyyy-MM-dd'),
    format(past31Day, 'yyyy-MM-dd'),
    filters,
    forceRefresh
  );
  chunk2.forEach(d => deliveryMap.set(d.id, d));
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Chunk 3: Past 61-90 days
  const past90Start = subDays(today, 90);
  const past61Day = subDays(today, 61);
  const chunk3 = await getDeliveriesForDateRange(
    format(past90Start, 'yyyy-MM-dd'),
    format(past61Day, 'yyyy-MM-dd'),
    filters,
    forceRefresh
  );
  chunk3.forEach(d => deliveryMap.set(d.id, d));
  
  return Array.from(deliveryMap.values());
};

/**
 * Load deliveries with offline-first strategy:
 * 1. Check offline DB freshness (< 10 min)
 * 2. If fresh, load from offline first, then refresh from online
 * 3. If not fresh, load selected date from online first
 * 4. Background: today + 6 future days, then past 14 days
 * 
 * @param {string} selectedDateStr - Selected date (yyyy-MM-dd)
 * @param {object} priorityFilters - Filters for priority loads
 * @param {object} backgroundFilters - Filters for background data
 * @param {boolean} forceRefresh - Force bypass cache
 * @param {function} onInitialLoadComplete - Callback for instant UI (selected date)
 * @param {function} onFullMonthLoadComplete - Callback for background data
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
  const todayStr = format(today, 'yyyy-MM-dd');
  
  console.log(`📥 [DataManager] Loading deliveries - selected: ${selectedDateStr}`);
  
  // STEP 1: Check if offline DB has data for selected date (use as instant UI)
  let usedOfflineData = false;
  
  if (!forceRefresh) {
    try {
      const offlineDeliveries = await offlineDB.getByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', selectedDateStr);
      
      if (offlineDeliveries && offlineDeliveries.length > 0) {
        console.log(`⚡ [DataManager] Instant UI from offline: ${offlineDeliveries.length} deliveries`);
        onInitialLoadComplete(offlineDeliveries);
        usedOfflineData = true;
        
        // IMMEDIATELY sync with online (no delay) - selected date first
        (async () => {
          try {
            console.log(`🔄 [DataManager] Syncing selected date ${selectedDateStr} with online...`);
            const freshDeliveries = await Delivery.filter({
              delivery_date: selectedDateStr,
              ...priorityFilters
            });
            
            // Update offline DB with fresh data
            if (freshDeliveries.length > 0) {
              await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
            }
            
            // Update UI with fresh data immediately
            console.log(`✅ [DataManager] UI updated with ${freshDeliveries.length} fresh deliveries`);
            onInitialLoadComplete(freshDeliveries);
            
            // Update sync timestamp
            await offlineDB.updateSyncStatus('Delivery', {
              lastSync: new Date().toISOString(),
              status: 'synced'
            });
            
            // Continue with background loading after selected date is synced
            setTimeout(async () => {
              await loadBackgroundDeliveries(selectedDateStr, priorityFilters, onFullMonthLoadComplete, freshDeliveries);
            }, 2000);
          } catch (e) {
            console.warn('⚠️ [DataManager] Online sync failed, using offline data:', e.message);
            // Still do background loading with offline data
            setTimeout(async () => {
              await loadBackgroundDeliveries(selectedDateStr, priorityFilters, onFullMonthLoadComplete, offlineDeliveries);
            }, 2000);
          }
        })();
        
        return offlineDeliveries;
      }
    } catch (err) {
      console.warn('⚠️ [DataManager] Offline check failed:', err.message);
    }
  }
  
  // STEP 2: Fetch selected date from online (not fresh or forced)
  const selectedDateDeliveries = await loadDeliveriesForDate(selectedDateStr, priorityFilters, forceRefresh);
  console.log(`✅ [DataManager] Loaded ${selectedDateDeliveries.length} deliveries for ${selectedDateStr}`);
  
  // Fire instant UI callback
  onInitialLoadComplete(selectedDateDeliveries);
  
  // STEP 3: Background load (today + 6 future, then past 14 days)
  setTimeout(async () => {
    await loadBackgroundDeliveries(selectedDateStr, priorityFilters, onFullMonthLoadComplete, selectedDateDeliveries);
  }, 3000);

  return selectedDateDeliveries;
};

/**
 * Background delivery loading: today + 6 future, then past 14 days
 */
const loadBackgroundDeliveries = async (selectedDateStr, filters, onComplete, initialDeliveries = []) => {
  const today = new Date();
  const deliveryMap = new Map();
  
  // Add initial deliveries
  initialDeliveries.forEach(d => deliveryMap.set(d.id, d));
  
  console.log(`📡 [DataManager] Background: loading today + 6 future days...`);
  
  // Load today + 6 future days
  for (let i = 0; i <= 6; i++) {
    const fetchDate = new Date(today);
    fetchDate.setDate(today.getDate() + i);
    const fetchDateStr = format(fetchDate, 'yyyy-MM-dd');
    
    if (fetchDateStr === selectedDateStr) continue;
    
    try {
      const dateDeliveries = await loadDeliveriesForDate(fetchDateStr, filters, false);
      dateDeliveries.forEach(d => deliveryMap.set(d.id, d));
      
      if (i < 6) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (error) {
      console.warn(`   ⚠️ ${fetchDateStr} failed:`, error.message);
    }
  }
  
  // Update UI with future data
  onComplete(Array.from(deliveryMap.values()));
  
  // Wait before loading historical
  await new Promise(r => setTimeout(r, 2000));
  
  console.log(`📡 [DataManager] Background: loading past 30 days (7 days at a time)...`);
  
  const chunks = [
    { start: 1, end: 7, label: 'Days 1-7' },
    { start: 8, end: 14, label: 'Days 8-14' },
    { start: 15, end: 21, label: 'Days 15-21' },
    { start: 22, end: 30, label: 'Days 22-30' }
  ];
  
  for (const chunk of chunks) {
    try {
      const chunkDeliveries = await getDeliveriesForDateRange(
        format(subDays(today, chunk.end), 'yyyy-MM-dd'),
        format(subDays(today, chunk.start), 'yyyy-MM-dd'),
        filters,
        false
      );
      chunkDeliveries.forEach(d => deliveryMap.set(d.id, d));
      onComplete(Array.from(deliveryMap.values()));
      console.log(`   ✅ ${chunk.label}: ${chunkDeliveries.length} deliveries`);
      
      // 1 second cooldown between chunks
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.warn(`   ⚠️ ${chunk.label} failed:`, e.message);
    }
  }
  
  console.log(`✅ [DataManager] Background complete: ${deliveryMap.size} total deliveries`);
};

/**
 * Invalidate delivery range cache - optionally for specific date only
 */
export const invalidateDeliveryRangeCache = (specificDate = null) => {
  if (specificDate) {
    // Only invalidate cache for this specific date, not everything
    for (const key of deliveryRangeCache.keys()) {
      if (key.includes(specificDate)) {
        deliveryRangeCache.delete(key);
        deliveryRangeCacheTimestamps.delete(key);
      }
    }
    console.log(`🎯 [dataManager] Invalidated delivery cache for ${specificDate} only`);
  } else {
    // Full cache clear (fallback)
    deliveryRangeCache.clear();
    deliveryRangeCacheTimestamps.clear();
  }
};

/**
 * Update specific entity in cache(s) directly
 * This prevents UI flickering by updating the cache immediately
 */
export const updateCache = (entityName, id, newData) => {
  // Update main cache
  for (const key of cache.keys()) {
    if (key.startsWith(`${entityName}_`)) {
      const cachedArray = cache.get(key);
      const index = cachedArray.findIndex(item => item.id === id);
      if (index > -1) {
        cachedArray[index] = newData;
      }
    }
  }
  
  // Update delivery range cache if it's a Delivery entity
  if (entityName === 'Delivery') {
    for (const key of deliveryRangeCache.keys()) {
      const cachedArray = deliveryRangeCache.get(key);
      const index = cachedArray.findIndex(item => item.id === id);
      if (index > -1) {
        cachedArray[index] = newData;
      }
    }
  }
  
  console.log(`⚡ [dataManager] Cache updated for ${entityName} ID: ${id}`);
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