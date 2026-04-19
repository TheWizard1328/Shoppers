import { base44 } from '@/api/base44Client';
import { createMergedUser } from './driverUtils';
import { offlineDB } from './offlineDatabase';

const clearLegacyHereLocalStorageCache = () => {
  try {
    const keysToRemove = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && (key.startsWith('here_') || key === 'rxdeliver_last_error' || key === 'base44_from_url')) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  } catch (_) {}
};

clearLegacyHereLocalStorageCache();

// Global cache for user data to prevent repeated API calls
let userCache = {
  data: null,
  timestamp: 0,
  ttl: 1800000, // 30 minutes cache
  lastFailureTime: 0,
  backoffTime: 0
};

// Separate cache for AppUser list (longer TTL since it changes less frequently)
let appUserListCache = {
  data: null,
  timestamp: 0,
  ttl: 900000 // 15 minutes cache for AppUser list
};

// CRITICAL: Track in-flight requests to prevent duplicate API calls
let inflightUserRequest = null;

const AUTH_BOOT_CACHE_KEY = 'rxdeliver_auth_boot_cache';
const EFFECTIVE_USER_CACHE_KEY = 'effectiveUserCache';
const AUTH_BOOT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const readStorageJson = (storage, key) => {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeStorageJson = (storage, key, value) => {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {}
};

const removeStorageKey = (storage, key) => {
  try {
    storage.removeItem(key);
  } catch {}
};

const getPersistedEffectiveUser = () => {
  const cached = readStorageJson(sessionStorage, EFFECTIVE_USER_CACHE_KEY) || readStorageJson(localStorage, EFFECTIVE_USER_CACHE_KEY);
  return cached?.user || null;
};

const persistEffectiveUser = (user) => {
  if (!user) return;
  const payload = { user, timestamp: Date.now() };
  writeStorageJson(sessionStorage, EFFECTIVE_USER_CACHE_KEY, payload);
  writeStorageJson(localStorage, EFFECTIVE_USER_CACHE_KEY, payload);
};

const getFreshCachedAuthUser = () => {
  const cached = readStorageJson(localStorage, AUTH_BOOT_CACHE_KEY) || readStorageJson(sessionStorage, AUTH_BOOT_CACHE_KEY);
  if (!cached?.user || !cached?.timestamp) return null;
  if ((Date.now() - cached.timestamp) > AUTH_BOOT_CACHE_TTL_MS) return null;
  return cached.user;
};

const persistAuthUser = (authUser) => {
  if (!authUser) return;
  const payload = { user: authUser, timestamp: Date.now() };
  writeStorageJson(localStorage, AUTH_BOOT_CACHE_KEY, payload);
  writeStorageJson(sessionStorage, AUTH_BOOT_CACHE_KEY, payload);
};

const getOfflineAppUser = async (userId) => {
  if (!userId) return null;
  const appUsers = await offlineDB.getByIndex(offlineDB.STORES.APP_USERS, 'user_id', userId);
  return Array.isArray(appUsers) && appUsers.length > 0 ? appUsers[0] : null;
};

const getAppUserByUserId = async (userId) => {
  const cachedAppUser = await getOfflineAppUser(userId);
  if (cachedAppUser) return cachedAppUser;

  const appUsers = await withTimeout(base44.entities.AppUser.filter({ user_id: userId }), 8000);
  if (appUsers && appUsers.length > 0) {
    await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, appUsers);
    return appUsers[0];
  }

  return null;
};

const cacheResolvedUser = (user) => {
  userCache.data = user;
  userCache.timestamp = Date.now();
  userCache.backoffTime = 0;
  persistEffectiveUser(user);
  return user;
};

/**
 * Creates a promise that rejects after a specified timeout
 */
const withTimeout = (promise, timeoutMs = 10000) => {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('timeout exceeded')), timeoutMs);
  });
  
  return Promise.race([promise, timeoutPromise]);
};

/**
 * Gets the effective user by merging User + AppUser data.
 * @returns {Promise<object|null>} The effective user object (merged User + AppUser) or null if not logged in.
 */
export const getEffectiveUser = async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const hasAccessTokenInUrl = !!urlParams.get('access_token');

    if (hasAccessTokenInUrl) {
        userCache.data = null;
        userCache.timestamp = 0;
        inflightUserRequest = null;
        removeStorageKey(sessionStorage, EFFECTIVE_USER_CACHE_KEY);
        removeStorageKey(localStorage, EFFECTIVE_USER_CACHE_KEY);
        removeStorageKey(sessionStorage, AUTH_BOOT_CACHE_KEY);
        removeStorageKey(localStorage, AUTH_BOOT_CACHE_KEY);
    }

    const now = Date.now();
    const persistedEffectiveUser = hasAccessTokenInUrl ? null : getPersistedEffectiveUser();

    if (!navigator.onLine) {
        console.warn('⚠️ [auth.js] Device is offline, returning cached user data');
        return userCache.data || persistedEffectiveUser;
    }

    if (userCache.backoffTime > 0 && (now - userCache.lastFailureTime) < userCache.backoffTime) {
        console.warn(`⏰ [auth.js] Rate limit backoff active. Using cached data. Backoff ends in ${Math.round((userCache.backoffTime - (now - userCache.lastFailureTime)) / 1000)}s`);
        return userCache.data || persistedEffectiveUser;
    }

    if (userCache.data && (now - userCache.timestamp) < userCache.ttl) {
        return userCache.data;
    }

    if (inflightUserRequest) {
        console.log('⏳ [auth.js] Waiting for in-flight user request to complete...');
        return await inflightUserRequest;
    }

    const fetchUser = async () => {
        let retryCount = 0;
        const maxRetries = 2;
        const baseDelay = 2000;

        const cachedAuthUser = hasAccessTokenInUrl ? null : getFreshCachedAuthUser();
        if (cachedAuthUser) {
          try {
            const cachedAppUser = await getOfflineAppUser(cachedAuthUser.id);
            if (cachedAppUser) {
              const mergedCachedUser = createMergedUser(cachedAuthUser, cachedAppUser);
              if (mergedCachedUser) {
                return cacheResolvedUser(mergedCachedUser);
              }
            }
          } catch (cacheError) {
            console.warn('⚠️ [auth.js] Failed to resolve boot cache, falling back to API:', cacheError.message);
          }
        }

        while (retryCount < maxRetries) {
            if (persistedEffectiveUser) return cacheResolvedUser(persistedEffectiveUser);
            try {
                if (!navigator.onLine) {
                    console.warn('⚠️ [auth.js] Device is offline, returning cached user data if available');
                    return userCache.data || persistedEffectiveUser;
                }

                const authUser = await withTimeout(base44.auth.me(), 10000);
                persistAuthUser(authUser);

                if (!authUser) {
                    console.warn('⚠️ [auth.js] No user data received (not logged in - Base44 will handle redirect)');
                    sessionStorage.removeItem('impersonationId');
                    return null;
                }

                const appUser = await getAppUserByUserId(authUser.id);
                if (!appUser) {
                    console.warn(`⚠️ [auth.js] No AppUser found for ${authUser.full_name}`);
                    return null;
                }

                const mergedUser = createMergedUser(authUser, appUser);
                if (!mergedUser) {
                  console.error(`❌ [auth.js] createMergedUser returned null for ${authUser.full_name}!`);
                  return null;
                }

                cacheResolvedUser(mergedUser);

                const isDriver = Array.isArray(mergedUser.app_roles) && mergedUser.app_roles.includes('driver');
                const currentStatus = mergedUser.driver_status;

                if (!isDriver && (!currentStatus || currentStatus === 'off_duty') && appUser) {
                  try {
                    console.log(`🟢 [auth.js] Setting online status for non-driver user: ${mergedUser.user_name}`);
                    await base44.entities.AppUser.update(appUser.id, { driver_status: 'online' });
                    mergedUser.driver_status = 'online';
                    await offlineDB.save(offlineDB.STORES.APP_USERS, { ...appUser, driver_status: 'online' });
                    persistEffectiveUser(mergedUser);
                  } catch (statusError) {
                    console.warn('⚠️ [auth.js] Failed to set online status:', statusError.message);
                  }
                }

                return mergedUser;

            } catch (error) {
                retryCount++;
                const errorMessage = error.message || 'Unknown error';
                console.error(`❌ [auth.js] Failed to get effective user (attempt ${retryCount}/${maxRetries}):`, errorMessage);

                if (error.response?.status === 401 || error.response?.status === 403) {
                    console.warn('⚠️ [auth.js] Authentication error - user not logged in');
                    sessionStorage.removeItem('impersonationId');
                    return null;
                }

                if (error.response?.status === 429 || errorMessage.includes('429') || errorMessage.includes('Rate limit')) {
                    userCache.lastFailureTime = Date.now();
                    userCache.backoffTime = Math.min((userCache.backoffTime || 60000) * 2, 1800000);
                    console.warn(`⏰ [auth.js] Rate limit detected. Backing off for ${userCache.backoffTime / 1000}s`);

                    if (userCache.data) {
                        console.warn('⚠️ [auth.js] Returning cached user data due to rate limit');
                        return userCache.data;
                    }

                    if (persistedEffectiveUser) {
                        console.warn('⚠️ [auth.js] Returning persisted user data due to rate limit');
                        return persistedEffectiveUser;
                    }

                    const waitTime = Math.min(5000 * retryCount, 15000);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                }

                const isTimeoutOrNetworkError =
                    errorMessage.includes('timeout exceeded') ||
                    errorMessage.includes('Network Error') ||
                    errorMessage.includes('fetch') ||
                    errorMessage.includes('Failed to fetch') ||
                    error.code === 'NETWORK_ERROR' ||
                    error.name === 'NetworkError';

                if (isTimeoutOrNetworkError) {
                    console.warn('⚠️ [auth.js] Timeout or connectivity issues detected');

                    if (userCache.data) {
                        console.warn('⚠️ [auth.js] Returning cached user data due to network error');
                        return userCache.data;
                    }

                    if (persistedEffectiveUser) {
                        console.warn('⚠️ [auth.js] Returning persisted user data due to network error');
                        return persistedEffectiveUser;
                    }

                    if (retryCount >= maxRetries) {
                        console.warn('⚠️ [auth.js] All retries exhausted due to timeout/network issues. Continuing without user data.');
                        return null;
                    }

                    const delay = baseDelay * retryCount;
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }

                if (retryCount >= maxRetries) {
                    console.error('❌ [auth.js] All retries exhausted.');
                    return userCache.data || persistedEffectiveUser || null;
                }

                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        return userCache.data || persistedEffectiveUser || null;
    };

    inflightUserRequest = fetchUser();

    try {
        const result = await inflightUserRequest;
        return result;
    } finally {
        inflightUserRequest = null;
    }
};

// Helper function to check if user data is available
export const isUserDataAvailable = async () => {
    try {
        if (userCache.data && (Date.now() - userCache.timestamp) < userCache.ttl) {
            return true;
        }
        
        const user = await getEffectiveUser();
        return user !== null;
    } catch (error) {
        console.warn('⚠️ [auth.js] User data availability check failed:', error.message);
        return userCache.data !== null;
    }
};

// Function to clear user cache when logging out
export const clearUserCache = () => {
    userCache = {
        data: null,
        timestamp: 0,
        ttl: 600000, // 10 minutes
        lastFailureTime: 0,
        backoffTime: 0
    };
    appUserListCache = {
        data: null,
        timestamp: 0,
        ttl: 900000 // 15 minutes
    };
    inflightUserRequest = null;
    sessionStorage.removeItem('impersonationId');
    removeStorageKey(sessionStorage, EFFECTIVE_USER_CACHE_KEY);
    removeStorageKey(localStorage, EFFECTIVE_USER_CACHE_KEY);
    removeStorageKey(sessionStorage, AUTH_BOOT_CACHE_KEY);
    removeStorageKey(localStorage, AUTH_BOOT_CACHE_KEY);
};

// Function to extend cache TTL when user is active (prevents session timeout during idle)
export const touchUserCache = () => {
    if (userCache.data) {
        userCache.timestamp = Date.now();
        persistEffectiveUser(userCache.data);
    }
};