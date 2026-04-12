import { base44 } from '@/api/base44Client';

const AppUser = base44.entities.AppUser;
const Delivery = base44.entities.Delivery;
const Patient = base44.entities.Patient;
const City = base44.entities.City;
const Store = base44.entities.Store;

let dataCache = new Map();
let pendingRequests = new Map();

const SYNC_STRATEGIES = {
  AppUser: { strategy: 'full', ttl: 600000 },
  City: { strategy: 'full', ttl: 600000 },
  Store: { strategy: 'full', ttl: 600000 },
  Patient: { strategy: 'incremental', ttl: 600000 },
  Delivery: { strategy: 'incremental', ttl: 600000 }
};

const getStrategy = (entityName) => {
  return SYNC_STRATEGIES[entityName] || { strategy: 'incremental', ttl: 30000 };
};

const isCacheValid = (key) => {
  const cached = dataCache.get(key);
  if (!cached) return false;
  return Date.now() - cached.timestamp < cached.ttl;
};

const deduplicateRequest = (key) => {
  if (pendingRequests.has(key)) {
    return pendingRequests.get(key);
  }
  return null;
};

export const fetchAppUsersDedup = async () => {
  const cacheKey = 'AppUser:list';
  if (isCacheValid(cacheKey)) return dataCache.get(cacheKey).data;
  const pending = deduplicateRequest(cacheKey);
  if (pending) return pending;

  const request = AppUser.list().then((data) => {
    const deduped = new Map();
    (data || []).forEach((au) => {
      if (!au || !au.user_id) return;
      const existing = deduped.get(au.user_id);
      if (!existing) {
        deduped.set(au.user_id, au);
        return;
      }
      const newTime = au.location_updated_at ? new Date(au.location_updated_at).getTime() : 0;
      const existingTime = existing.location_updated_at ? new Date(existing.location_updated_at).getTime() : 0;
      if (newTime > existingTime) {
        deduped.set(au.user_id, au);
      }
    });
    const result = Array.from(deduped.values());
    dataCache.set(cacheKey, { data: result, timestamp: Date.now(), ttl: getStrategy('AppUser').ttl });
    pendingRequests.delete(cacheKey);
    return result;
  }).catch((error) => {
    pendingRequests.delete(cacheKey);
    throw error;
  });

  pendingRequests.set(cacheKey, request);
  return request;
};

export const fetchDeliveriesDedup = async (dateStr, filter = {}) => {
  const cacheKey = `Delivery:${dateStr}:${JSON.stringify(filter)}`;
  if (isCacheValid(cacheKey)) return dataCache.get(cacheKey).data;
  const pending = deduplicateRequest(cacheKey);
  if (pending) return pending;

  const request = Delivery.filter({ delivery_date: dateStr, ...filter }).then((data) => {
    dataCache.set(cacheKey, { data: data || [], timestamp: Date.now(), ttl: getStrategy('Delivery').ttl });
    pendingRequests.delete(cacheKey);
    return data || [];
  }).catch((error) => {
    pendingRequests.delete(cacheKey);
    throw error;
  });

  pendingRequests.set(cacheKey, request);
  return request;
};

export const fetchPatientsDedup = async (filter = {}) => {
  const cacheKey = `Patient:${JSON.stringify(filter)}`;
  if (isCacheValid(cacheKey)) return dataCache.get(cacheKey).data;
  const pending = deduplicateRequest(cacheKey);
  if (pending) return pending;

  const request = Patient.filter(filter).then((data) => {
    const clean = (data || []).filter((p) => p && p.id && !p.id.startsWith('temp_'));
    dataCache.set(cacheKey, { data: clean, timestamp: Date.now(), ttl: getStrategy('Patient').ttl });
    pendingRequests.delete(cacheKey);
    return clean;
  }).catch((error) => {
    pendingRequests.delete(cacheKey);
    throw error;
  });

  pendingRequests.set(cacheKey, request);
  return request;
};

export const fetchCitiesDedup = async () => {
  const cacheKey = 'City:list';
  if (isCacheValid(cacheKey)) return dataCache.get(cacheKey).data;
  const pending = deduplicateRequest(cacheKey);
  if (pending) return pending;

  const request = City.list().then((data) => {
    dataCache.set(cacheKey, { data: data || [], timestamp: Date.now(), ttl: getStrategy('City').ttl });
    pendingRequests.delete(cacheKey);
    return data || [];
  }).catch((error) => {
    pendingRequests.delete(cacheKey);
    throw error;
  });

  pendingRequests.set(cacheKey, request);
  return request;
};

export const fetchStoresDedup = async () => {
  const cacheKey = 'Store:list';
  if (isCacheValid(cacheKey)) return dataCache.get(cacheKey).data;
  const pending = deduplicateRequest(cacheKey);
  if (pending) return pending;

  const request = Store.list().then((data) => {
    dataCache.set(cacheKey, { data: data || [], timestamp: Date.now(), ttl: getStrategy('Store').ttl });
    pendingRequests.delete(cacheKey);
    return data || [];
  }).catch((error) => {
    pendingRequests.delete(cacheKey);
    throw error;
  });

  pendingRequests.set(cacheKey, request);
  return request;
};

export const invalidateEntityCache = (entityName) => {
  const keysToDelete = [];
  dataCache.forEach((value, key) => {
    if (key.startsWith(entityName + ':')) keysToDelete.push(key);
  });
  keysToDelete.forEach((key) => dataCache.delete(key));
};

export const clearAllCache = () => {
  dataCache.clear();
};

export const getCacheStats = () => ({
  cacheSize: dataCache.size,
  pendingRequests: pendingRequests.size,
  entries: Array.from(dataCache.keys())
});