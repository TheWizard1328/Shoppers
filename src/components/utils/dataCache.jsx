// Simple data cache to prevent excessive API calls
const dataCache = {
  users: { data: null, timestamp: 0, ttl: 60000 }, // 1 minute TTL
  patients: { data: null, timestamp: 0, ttl: 30000 }, // 30 seconds TTL
  deliveries: { data: null, timestamp: 0, ttl: 10000 }, // 10 seconds TTL
  stores: { data: null, timestamp: 0, ttl: 60000 }, // 1 minute TTL
  cities: { data: null, timestamp: 0, ttl: 300000 }, // 5 minutes TTL
};

const isExpired = (cacheEntry) => {
  return Date.now() - cacheEntry.timestamp > cacheEntry.ttl;
};

export const getCachedData = (key) => {
  const entry = dataCache[key];
  if (entry && entry.data && !isExpired(entry)) {
    console.log(`✅ [Cache] Using cached ${key} data`);
    return entry.data;
  }
  return null;
};

export const setCachedData = (key, data) => {
  dataCache[key] = {
    data,
    timestamp: Date.now(),
    ttl: dataCache[key].ttl
  };
  console.log(`💾 [Cache] Cached ${key} data (${data?.length || 0} items)`);
};

export const clearCache = () => {
  Object.keys(dataCache).forEach(key => {
    dataCache[key].data = null;
    dataCache[key].timestamp = 0;
  });
  console.log('🗑️ [Cache] Cleared all cached data');
};