import { Patient } from '@/entities/Patient';
import { Delivery } from '@/entities/Delivery';
import { Store } from '@/entities/Store';
import { User } from '@/entities/User';
import { City } from '@/entities/City';
import { AppUser } from '@/entities/AppUser';
import { format, subDays } from 'date-fns';

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
const CACHE_DURATION = 5 * 60 * 1000;

// Date range-based delivery cache for staged loading
const deliveryRangeCache = new Map();
const deliveryRangeCacheTimestamps = new Map();
const DELIVERY_RANGE_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes for historical data

export const getData = async (entityName, sortKey = null, queryOrLimit = null, forceRefresh = false) => {
  // Determine if queryOrLimit is a query object or a limit number
  const isQueryObject = queryOrLimit && typeof queryOrLimit === 'object' && !Array.isArray(queryOrLimit);
  const query = isQueryObject ? queryOrLimit : null;
  const limit = !isQueryObject && typeof queryOrLimit === 'number' ? queryOrLimit : null;
  
  const cacheKey = `${entityName}_${sortKey || 'default'}_${JSON.stringify(query) || 'noquery'}_${limit || 'all'}`;
  
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
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
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
          const backoffDelay = 5000 * (attempt + 1);
          console.warn(`⏰ [dataManager] Rate limited, waiting ${backoffDelay}ms`);
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
 * Three-stage delivery loading for optimized initial load times
 * Stage 1: Today + next 7 days (returned immediately after today loads)
 * Stage 2: Last 30 days, 1 week at a time (background, calls onStage2Complete after each week)
 * Stage 3: Remaining past data, 1 week at a time with 1s pause (background, calls onStage3Complete after each week)
 * 
 * @param {object} filters - Filters to apply (store_id, driver_id, etc.)
 * @param {function} onStage2Complete - Callback with Stage 2 deliveries (called after each week)
 * @param {function} onStage3Complete - Callback with Stage 3 deliveries (called after each week)
 * @param {number} yearsBack - How many past years to load (default: 2)
 * @param {boolean} forceRefresh - Force bypass cache
 * @returns {Promise<Array>} - Stage 1 deliveries (today + next 7 days)
 */
export const loadDeliveriesThreeStage = async (filters = {}, onStage2Complete = null, onStage3Complete = null, yearsBack = 2, forceRefresh = false) => {
  const today = new Date();
  const currentYear = today.getFullYear();
  const todayStr = format(today, 'yyyy-MM-dd');
  
  // Stage 1: Today + next 7 days (priority - return immediately)
  console.log(`🚀 [dataManager] === STAGE 1: Loading today + next 7 days ===`);
  
  // Load today first
  const todayDeliveries = await getDeliveriesForDateRange(todayStr, todayStr, filters, forceRefresh);
  console.log(`✅ [dataManager] Stage 1a: Today loaded (${todayDeliveries.length} deliveries)`);
  
  // Then load next 7 days one by one with small delays
  const stage1Deliveries = [...todayDeliveries];
  for (let i = 1; i <= 7; i++) {
    // Small delay between requests to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 150));
    
    const futureDate = new Date(today);
    futureDate.setDate(futureDate.getDate() + i);
    const futureDateStr = format(futureDate, 'yyyy-MM-dd');
    
    try {
      const dayDeliveries = await getDeliveriesForDateRange(futureDateStr, futureDateStr, filters, forceRefresh);
      stage1Deliveries.push(...dayDeliveries);
      console.log(`✅ [dataManager] Stage 1: Day +${i} loaded (${dayDeliveries.length} deliveries)`);
    } catch (error) {
      console.warn(`⚠️ [dataManager] Stage 1: Failed to load day +${i}:`, error.message);
    }
  }
  
  console.log(`✅ [dataManager] Stage 1 complete: ${stage1Deliveries.length} total deliveries`);
  
  // Stage 2 & 3: Background loading
  const loadStage2And3 = async () => {
    try {
      // Stage 2: Last 30 days, 1 week at a time
      console.log(`🔄 [dataManager] === STAGE 2: Loading last 30 days (1 week at a time) ===`);
      
      for (let weekNum = 0; weekNum < 4; weekNum++) {
        const weekEndOffset = (weekNum * 7) + 1; // 1, 8, 15, 22
        const weekStartOffset = weekEndOffset + 6; // 7, 14, 21, 28
        
        // Don't go beyond 30 days
        const actualStartOffset = Math.min(weekStartOffset, 30);
        
        const weekEnd = subDays(today, weekEndOffset);
        const weekStart = subDays(today, actualStartOffset);
        
        const weekStartStr = format(weekStart, 'yyyy-MM-dd');
        const weekEndStr = format(weekEnd, 'yyyy-MM-dd');
        
        if (weekStartStr > weekEndStr) continue; // Skip invalid ranges
        
        try {
          const weekDeliveries = await getDeliveriesForDateRange(weekStartStr, weekEndStr, filters, forceRefresh);
          console.log(`✅ [dataManager] Stage 2: Week ${weekNum + 1} loaded (${weekStartStr} to ${weekEndStr}): ${weekDeliveries.length} deliveries`);
          
          if (onStage2Complete && weekDeliveries.length > 0) {
            onStage2Complete(weekDeliveries);
          }
        } catch (error) {
          console.warn(`⚠️ [dataManager] Stage 2: Week ${weekNum + 1} failed:`, error.message);
        }
      }
      
      console.log(`✅ [dataManager] Stage 2 complete`);
      
      // Stage 3: Remaining historical data (31+ days ago to yearsBack)
      console.log(`🔄 [dataManager] === STAGE 3: Loading historical data (1 week at a time with 1s pause) ===`);
      
      // Calculate start date (yearsBack years ago, Jan 1)
      const historyStartYear = currentYear - yearsBack;
      const historyStart = new Date(historyStartYear, 0, 1);
      
      // End at 31 days ago (where Stage 2 stopped)
      const historyEnd = subDays(today, 31);
      
      if (historyStart <= historyEnd) {
        // Load week by week from most recent to oldest
        let currentWeekEnd = new Date(historyEnd);
        let weekCount = 0;
        
        while (currentWeekEnd >= historyStart) {
          const currentWeekStart = new Date(currentWeekEnd);
          currentWeekStart.setDate(currentWeekStart.getDate() - 6);
          
          // Don't go before historyStart
          if (currentWeekStart < historyStart) {
            currentWeekStart.setTime(historyStart.getTime());
          }
          
          const weekStartStr = format(currentWeekStart, 'yyyy-MM-dd');
          const weekEndStr = format(currentWeekEnd, 'yyyy-MM-dd');
          
          try {
            // 1 second pause between weeks to avoid rate limiting
            if (weekCount > 0) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            const weekDeliveries = await getDeliveriesForDateRange(weekStartStr, weekEndStr, filters, false);
            weekCount++;
            
            if (weekDeliveries.length > 0) {
              console.log(`✅ [dataManager] Stage 3: Week ${weekCount} loaded (${weekStartStr} to ${weekEndStr}): ${weekDeliveries.length} deliveries`);
              
              if (onStage3Complete) {
                onStage3Complete(weekDeliveries);
              }
            }
          } catch (error) {
            console.warn(`⚠️ [dataManager] Stage 3: Week ${weekCount + 1} failed:`, error.message);
          }
          
          // Move to previous week
          currentWeekEnd = new Date(currentWeekStart);
          currentWeekEnd.setDate(currentWeekEnd.getDate() - 1);
        }
        
        console.log(`✅ [dataManager] Stage 3 complete: ${weekCount} weeks processed`);
      } else {
        console.log(`ℹ️ [dataManager] Stage 3 skipped: no historical data before 31 days ago`);
      }
      
      console.log(`✅ [dataManager] === ALL STAGES COMPLETE ===`);
      
    } catch (error) {
      console.error(`❌ [dataManager] Error in Stage 2/3 background loading:`, error);
    }
  };
  
  // Start Stage 2 & 3 in background (non-blocking)
  loadStage2And3();
  
  // Return Stage 1 immediately
  return stage1Deliveries;
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