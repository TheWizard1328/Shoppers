/**
 * Logging Helpers - Convert IDs to human-readable names for console logs
 * CRITICAL: All console logs should use these helpers instead of raw IDs
 */

// Cache for entity data to avoid repeated lookups
let appUsersCache = [];
let storesCache = [];
let citiesCache = [];
let patientsCache = [];

/**
 * Update caches with fresh data
 */
export const updateLogCaches = ({ appUsers, stores, cities, patients }) => {
  if (appUsers) appUsersCache = appUsers;
  if (stores) storesCache = stores;
  if (cities) citiesCache = cities;
  if (patients) patientsCache = patients;
};

/**
 * Get AppUser name from ID
 */
export const getAppUserName = (userId) => {
  if (!userId) return 'None';
  const user = appUsersCache.find(u => u?.id === userId);
  return user?.user_name || user?.full_name || `Unknown-User`;
};

/**
 * Get Store name from ID
 */
export const getStoreName = (storeId) => {
  if (!storeId) return 'None';
  const store = storesCache.find(s => s?.id === storeId);
  return store?.name || `Unknown-Store`;
};

/**
 * Get City name from ID
 */
export const getCityName = (cityId) => {
  if (!cityId) return 'None';
  const city = citiesCache.find(c => c?.id === cityId);
  return city?.name || `Unknown-City`;
};

/**
 * Get Patient name from ID
 */
export const getPatientName = (patientId) => {
  if (!patientId) return 'None';
  const patient = patientsCache.find(p => p?.id === patientId);
  return patient?.full_name || `Unknown-Patient`;
};

/**
 * Format a log object with names instead of IDs
 * Example: formatLogObject({ driver_id: '123', store_id: '456' })
 * Returns: { driver: 'John Doe', store: 'Main Store' }
 */
export const formatLogObject = (obj) => {
  const formatted = { ...obj };
  
  // Convert common ID fields to names
  if (obj.driver_id) {
    formatted.driver = getAppUserName(obj.driver_id);
    delete formatted.driver_id;
  }
  if (obj.user_id) {
    formatted.user = getAppUserName(obj.user_id);
    delete formatted.user_id;
  }
  if (obj.store_id) {
    formatted.store = getStoreName(obj.store_id);
    delete formatted.store_id;
  }
  if (obj.city_id) {
    formatted.city = getCityName(obj.city_id);
    delete formatted.city_id;
  }
  if (obj.patient_id) {
    formatted.patient = getPatientName(obj.patient_id);
    delete formatted.patient_id;
  }
  
  return formatted;
};

/**
 * Smart log function that automatically converts IDs to names
 * Usage: smartLog('prefix', '🔵 Processing delivery', { driver_id: '123', store_id: '456' })
 */
export const smartLog = (prefix, message, data) => {
  if (data && typeof data === 'object') {
    console.log(`${prefix} ${message}`, formatLogObject(data));
  } else {
    console.log(`${prefix} ${message}`, data);
  }
};