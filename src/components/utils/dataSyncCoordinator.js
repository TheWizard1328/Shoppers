/**
 * Data Sync Coordinator - Centralizes data fetching to eliminate redundant API calls
 * 
 * Deduplicates concurrent requests for the same entity
 * Classifies entities by sync strategy (full vs incremental)
 * Caches results to prevent duplicate API calls within short time windows
 */

import { AppUser } from '@/entities/AppUser';
import { Delivery } from '@/entities/Delivery';
import { Patient } from '@/entities/Patient';
import { City } from '@/entities/City';
import { Store } from '@/entities/Store';

const CACHE_TTL = 10000; // 10 seconds - short cache to avoid stale data

// Cache for deduplication
let dataCache = new Map();
let pendingRequests = new Map();

const SYNC_STRATEGIES = {
  // FULL SYNC: Always fetch all records (smaller datasets, less frequent)
  AppUser: { strategy: 'full', ttl: 30000 },
  City: { strategy: 'full', ttl: 30000 },
  Store: { strategy: 'full', ttl: 30000 },
  
  // INCREMENTAL: Only fetch updated records (large datasets)
  Patient: { strategy: 'incremental', ttl: 60000 },
  Delivery: { strategy: 'incremental', ttl: 20000 }
};

/**
 * Get sync strategy for entity
 */
const getStrategy = (entityName) => {
  return SYNC_STRATEGIES[entityName] || { strategy: 'incremental', ttl: 30000 };
};

/**
 * Check cache validity
 */
const isCacheValid = (key) => {
  const cached = dataCache.get(key);
  if (!cached) return false;
  return Date.now() - cached.timestamp < cached.ttl;
};

/**
 * Deduplicate concurrent requests - if another request is in progress, wait for it
 */
const deduplicateRequest = (key) => {
  if (pendingRequests.has(key)) {
    return pendingRequests.get(key);
  }
  return null;
};

/**
 * Fetch AppUsers with deduplication
 */
export const fetchAppUsersDedup = async () => {
  const cacheKey = 'AppUser:list';
  
  // Check cache
  if (isCacheValid(cacheKey)) {
    return dataCache.get(cacheKey).data;
  }
  
  // Check if already fetching
  const pending = deduplicateRequest(cacheKey);
  if (pending) {
    return pending;
  }
  
  // New request
  const request = AppUser.list().then(data => {
    // CRITICAL: Deduplicate by user_id (keep most recent by location_updated_at)
    const deduped = new Map();
    (data || []).forEach(au => {
      if (!au || !au.user_id) return;
      const existing = deduped.get(au.user_id);
      if (!existing) {
        deduped.set(au.user_id, au);
      } else {
        const newTime = au.location_updated_at ? new Date(au.location_updated_at).getTime() : 0;
        const existingTime = existing.location_updated_at ? new Date(existing.location_updated_at).getTime() : 0;
        if (newTime > existingTime) {
          deduped.set(au.user_id, au);
        }
      }
    });
    
    const result = Array.from(deduped.values());
    
    // Cache result
    dataCache.set(cacheKey, {
      data: result,
      timestamp: Date.now(),
      ttl: getStrategy('AppUser').ttl
    });
    
    pendingRequests.delete(cacheKey);
    return result;
  }).catch(error => {
    pendingRequests.delete(cacheKey);
    throw error;
  });
  
  pendingRequests.set(cacheKey, request);
  return request;
};

/**
 * Fetch Deliveries for a specific date with deduplication
 */
export const fetchDeliveriesDedup = async (dateStr, filter = {}) => {
  const cacheKey = `Delivery:${dateStr}:${JSON.stringify(filter)}`;
  
  // Check cache
  if (isCacheValid(cacheKey)) {
    return dataCache.get(cacheKey).data;
  }
  
  // Check if already fetching
  const pending = deduplicateRequest(cacheKey);
  if (pending) {
    return pending;
  }
  
  // New request
  const request = Delivery.filter({ delivery_date: dateStr, ...filter })
    .then(data => {
      // Cache result
      dataCache.set(cacheKey, {
        data: data || [],
        timestamp: Date.now(),
        ttl: getStrategy('Delivery').ttl
      });
      
      pendingRequests.delete(cacheKey);
      return data || [];
    })
    .catch(error => {
      pendingRequests.delete(cacheKey);
      throw error;
    });
  
  pendingRequests.set(cacheKey, request);
  return request;
};

/**
 * Fetch Patients with deduplication
 */
export const fetchPatientsDedup = async (filter = {}) => {
  const cacheKey = `Patient:${JSON.stringify(filter)}`;
  
  // Check cache
  if (isCacheValid(cacheKey)) {
    return dataCache.get(cacheKey).data;
  }
  
  // Check if already fetching
  const pending = deduplicateRequest(cacheKey);
  if (pending) {
    return pending;
  }
  
  // New request
  const request = Patient.filter(filter)
    .then(data => {
      const clean = (data || []).filter(p => p && p.id && !p.id.startsWith('temp_'));
      
      // Cache result
      dataCache.set(cacheKey, {
        data: clean,
        timestamp: Date.now(),
        ttl: getStrategy('Patient').ttl
      });
      
      pendingRequests.delete(cacheKey);
      return clean;
    })
    .catch(error => {
      pendingRequests.delete(cacheKey);
      throw error;
    });
  
  pendingRequests.set(cacheKey, request);
  return request;
};

/**
 * Fetch Cities with deduplication
 */
export const fetchCitiesDedup = async () => {
  const cacheKey = 'City:list';
  
  // Check cache
  if (isCacheValid(cacheKey)) {
    return dataCache.get(cacheKey).data;
  }
  
  // Check if already fetching
  const pending = deduplicateRequest(cacheKey);
  if (pending) {
    return pending;
  }
  
  // New request
  const request = City.list()
    .then(data => {
      // Cache result
      dataCache.set(cacheKey, {
        data: data || [],
        timestamp: Date.now(),
        ttl: getStrategy('City').ttl
      });
      
      pendingRequests.delete(cacheKey);
      return data || [];
    })
    .catch(error => {
      pendingRequests.delete(cacheKey);
      throw error;
    });
  
  pendingRequests.set(cacheKey, request);
  return request;
};

/**
 * Fetch Stores with deduplication
 */
export const fetchStoresDedup = async () => {
  const cacheKey = 'Store:list';
  
  // Check cache
  if (isCacheValid(cacheKey)) {
    return dataCache.get(cacheKey).data;
  }
  
  // Check if already fetching
  const pending = deduplicateRequest(cacheKey);
  if (pending) {
    return pending;
  }
  
  // New request
  const request = Store.list()
    .then(data => {
      // Cache result
      dataCache.set(cacheKey, {
        data: data || [],
        timestamp: Date.now(),
        ttl: getStrategy('Store').ttl
      });
      
      pendingRequests.delete(cacheKey);
      return data || [];
    })
    .catch(error => {
      pendingRequests.delete(cacheKey);
      throw error;
    });
  
  pendingRequests.set(cacheKey, request);
  return request;
};

/**
 * Invalidate cache for entity
 */
export const invalidateEntityCache = (entityName) => {
  // Find all cache keys for this entity and remove them
  const keysToDelete = [];
  dataCache.forEach((value, key) => {
    if (key.startsWith(entityName + ':')) {
      keysToDelete.push(key);
    }
  });
  
  keysToDelete.forEach(key => dataCache.delete(key));
  console.log(`🧹 [DataSyncCoordinator] Invalidated cache for ${entityName} (${keysToDelete.length} entries)`);
};

/**
 * Clear all caches
 */
export const clearAllCache = () => {
  dataCache.clear();
  console.log('🧹 [DataSyncCoordinator] Cleared all data cache');
};

/**
 * Get cache statistics
 */
export const getCacheStats = () => ({
  cacheSize: dataCache.size,
  pendingRequests: pendingRequests.size,
  entries: Array.from(dataCache.keys())
});