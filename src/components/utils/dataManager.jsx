import { Patient } from '@/entities/Patient';
import { Delivery } from '@/entities/Delivery';
import { User } from '@/entities/User';
import { City } from '@/entities/City';
import { Store } from '@/entities/Store';
import { AppUser } from '@/entities/AppUser';
import { Company } from '@/entities/Company';
import { SquareLocationConfig } from '@/entities/SquareLocationConfig';
import { SquareTransaction } from '@/entities/SquareTransaction';
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
import { connectionMonitor } from './connectionMonitor';
import { getOfflineStoreName, isOfflineManagedEntity } from './offlineEntityRegistry';
import { readEntityOffline } from './offlineReadPolicy';
import { backgroundSyncManager } from './backgroundSyncManager';

const entities = {
  Patient,
  Delivery,
  User,
  City,
  Store,
  AppUser,
  Company,
  SquareLocationConfig,
  SquareTransaction
};

// CRITICAL: NO IN-MEMORY CACHE - Use offline DB exclusively
// Deleted all cache layers to prevent stale data and reappearing deleted items

// Track offline DB load completion
let offlineDBLoadComplete = false;

// Rate limit protection - track last API call time and global rate limit pause
let lastApiCallTime = 0;
const MIN_API_INTERVAL = 3000; // 3 seconds between API calls to prevent rate limiting
let globalRateLimitUntil = 0;

const waitForRateLimit = async () => {
  const now = Date.now();
  
  // Check if we're in a global rate limit pause (triggered by 429 error)
  if (now < globalRateLimitUntil) {
    const waitTime = globalRateLimitUntil - now;
    console.warn(`⏸️ [DataManager] Global rate limit active - waiting ${Math.ceil(waitTime/1000)}s`);
    await new Promise(resolve => setTimeout(resolve, Math.min(waitTime, 1000)));
    return;
  }
  
  const timeSinceLastCall = now - lastApiCallTime;
  if (timeSinceLastCall < MIN_API_INTERVAL) {
    const waitTime = MIN_API_INTERVAL - timeSinceLastCall;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  lastApiCallTime = Date.now();
};

export const markOfflineDBLoadComplete = () => {
  offlineDBLoadComplete = true;
};

export const isOfflineDBLoadComplete = () => {
  return offlineDBLoadComplete;
};

// NO FREQUENT CACHE - removed

export const getData = async (entityName, sortKey = null, queryOrLimit = null, forceRefresh = false) => {
  const isQueryObject = queryOrLimit && typeof queryOrLimit === 'object' && !Array.isArray(queryOrLimit);
  const query = isQueryObject ? queryOrLimit : null;
  const limit = !isQueryObject && typeof queryOrLimit === 'number' ? queryOrLimit : null;

  const offlineData = await readEntityOffline(entityName, { sortKey, query, limit });

  if ((isOfflineManagedEntity(entityName) || entityName === 'SquareLocationConfig' || entityName === 'SquareTransaction') && offlineData.length > 0) {
    if (forceRefresh) {
      backgroundSyncManager.requestEntitySync(entityName, { query, reason: 'forced_refresh' });
    }
    return offlineData;
  }

  if (isOfflineManagedEntity(entityName) || entityName === 'SquareLocationConfig' || entityName === 'SquareTransaction') {
    backgroundSyncManager.requestEntitySync(entityName, { query, reason: 'offline_miss' });
    return offlineData;
  }

  let retries = 3;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await waitForRateLimit();
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      const Entity = entities[entityName];
      if (!Entity) return [];

      const startTime = Date.now();
      let data;
      if (query) {
        if (sortKey && limit) data = await Entity.filter(query, sortKey, limit);
        else if (sortKey) data = await Entity.filter(query, sortKey);
        else data = await Entity.filter(query);
      } else {
        const defaultLimit = (entityName === 'SquareTransaction') ? 100 : limit;
        if (sortKey && defaultLimit) data = await Entity.list(sortKey, defaultLimit);
        else if (sortKey) data = await Entity.list(sortKey);
        else if (defaultLimit) data = await Entity.list('-updated_date', defaultLimit);
        else data = await Entity.list();
      }

      connectionMonitor.recordResponseTime(Date.now() - startTime);
      return data;
    } catch (error) {
      if (error.response?.status === 403 || error.message?.includes('403')) return [];
      if (attempt < retries - 1 && (error.message?.includes('Network Error') || error.code === 'NETWORK_ERROR')) continue;
      if (error.response?.status === 429 || error.message?.includes('429')) {
        connectionMonitor.recordError('rate_limit');
        globalRateLimitUntil = Date.now() + 120000;
        await new Promise(resolve => setTimeout(resolve, Math.min(2000 * Math.pow(2, attempt), 10000)));
        if (attempt < retries - 1) continue;
      } else {
        connectionMonitor.recordError('network');
      }
      break;
    }
  }

  return [];
};

// NO CACHE OPERATIONS - all removed
export const invalidate = (entityName) => {
  // No-op - no cache to invalidate
};

export const getCached = (entityName) => {
  return null;
};

export const setCached = (entityName, data) => {
  // No-op - no cache to set
};

/**
 * Get deliveries for a specific date range - NO CACHE, always from offline DB or API
 */
export const getDeliveriesForDateRange = async (startDate, endDate, filters = {}, forceRefresh = false) => {
  try {
    const allOfflineDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    const filtered = allOfflineDeliveries.filter(d => {
      if (!d?.delivery_date) return false;
      if (d.delivery_date < startDate || d.delivery_date > endDate) return false;
      for (const [key, value] of Object.entries(filters)) {
        if (d[key] !== value) return false;
      }
      return true;
    });

    if (forceRefresh || filtered.length === 0) {
      backgroundSyncManager.requestEntitySync('Delivery', {
        query: {
          ...filters,
          delivery_date: { $gte: startDate, $lte: endDate }
        },
        reason: filtered.length === 0 ? 'delivery_range_miss' : 'delivery_range_refresh'
      });
    }

    return filtered;
  } catch (offlineError) {
    backgroundSyncManager.requestEntitySync('Delivery', {
      query: {
        ...filters,
        delivery_date: { $gte: startDate, $lte: endDate }
      },
      reason: 'delivery_range_error'
    });
    return [];
  }
};

/**
 * Load deliveries for a specific date - NO CACHE, always from offline DB or API
 */
export const loadDeliveriesForDate = async (dateStr, filters = {}, forceRefresh = false) => {
  const { driver_id, ...filtersWithoutDriver } = filters;

  try {
    let offlineData = await offlineDB.getByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', dateStr);
    if (filtersWithoutDriver.store_id) {
      const storeIds = filtersWithoutDriver.store_id.$in || [filtersWithoutDriver.store_id];
      offlineData = offlineData.filter(d => storeIds.includes(d.store_id));
    }

    if (forceRefresh || offlineData.length === 0) {
      backgroundSyncManager.requestEntitySync('Delivery', {
        query: { ...filtersWithoutDriver, delivery_date: dateStr },
        reason: offlineData.length === 0 ? 'delivery_date_miss' : 'delivery_date_refresh'
      });
    }

    return offlineData || [];
  } catch (offlineError) {
    backgroundSyncManager.requestEntitySync('Delivery', {
      query: { ...filtersWithoutDriver, delivery_date: dateStr },
      reason: 'delivery_date_error'
    });
    return [];
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
  
  if (!forceRefresh) {
    try {
      const offlineDeliveries = await offlineDB.getByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', selectedDateStr);
      
      if (offlineDeliveries && offlineDeliveries.length > 0) {
        setTimeout(() => {
          onInitialLoadComplete(offlineDeliveries);
        }, 0);
        
        return offlineDeliveries;
      }
    } catch (err) {}
  }
  
  const selectedDateDeliveries = await loadDeliveriesForDate(selectedDateStr, priorityFilters, forceRefresh);
  
  setTimeout(() => {
    onInitialLoadComplete(selectedDateDeliveries);
  }, 0);
  
  loadFullMonthDeliveries(backgroundFilters, false)
    .then(onFullMonthLoadComplete)
    .catch(err => {});

  return selectedDateDeliveries;
};

/**
 * Background delivery loading: today + 6 future, then past 14 days
 */
const loadBackgroundDeliveries = async (selectedDateStr, filters, onComplete, initialDeliveries = []) => {
  const today = new Date();
  const deliveryMap = new Map();
  
  initialDeliveries.forEach(d => deliveryMap.set(d.id, d));
  
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
    } catch (error) {}
  }
  
  onComplete(Array.from(deliveryMap.values()));
  await new Promise(r => setTimeout(r, 2000));
  
  const chunks = [
    { start: 1, end: 7 },
    { start: 8, end: 14 },
    { start: 15, end: 21 },
    { start: 22, end: 30 }
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
      
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {}
  }
};

// NO CACHE OPERATIONS - all removed
export const invalidateDeliveryRangeCache = (specificDate = null) => {
  // No-op
};

export const updateCache = (entityName, id, newData) => {
  // No-op
};

export const removeDeletedFromCache = (entityName, deletedIds) => {
  // No-op
};

export const invalidateDeliveriesForDate = (dateString) => {
  // No-op
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