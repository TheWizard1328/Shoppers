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

/**
 * Patches transient fields (e.g. driver_status) onto the in-memory effective
 * user cache AND the persisted effective-user caches (session + local).
 *
 * WHY: getEffectiveUser() is backed by a 30-minute TTL cache. When a driver
 * toggles on_duty/off_duty/on_break (via DriverStatusToggle OR the Start
 * button's ensureDriverOnline), the IDB AppUser record and the React
 * currentUser state are updated — but userCache.data still holds the OLD
 * driver_status. Any consumer calling getEffectiveUser() mid-session (AppSidebar
 * refresh, SettingsMenu, ETATracker, EOD guards) receives the stale status, and
 * components that setCurrentUser() with it (e.g. the DriverStatusToggle's
 * prop-sync effect) revert the toggle UI back to the stale status — the
 * "Start toggles me on duty then flips me back off" bug.
 *
 * This patch is state-level only: the authoritative record (IDB AppUser + server)
 * is written by the toggle itself. We only keep the caches coherent with it.
 */
export const patchEffectiveUserCacheFields = (fields) => {
  if (!fields || typeof fields !== 'object') return;
  if (userCache.data) {
    userCache.data = { ...userCache.data, ...fields };
  }
  try {
    const persisted = getPersistedEffectiveUser();
    if (persisted) {
      persistEffectiveUser({ ...persisted, ...fields });
    }
  } catch {}
};

const getFreshCachedAuthUser = () => {
  const cached = readStorageJson(localStorage, AUTH_BOOT_CACHE_KEY) || readStorageJson(sessionStorage, AUTH_BOOT_CACHE_KEY);
  if (!cached?.user || !cached?.timestamp) return null;
  if ((Date.now() - cached.timestamp) > AUTH_BOOT_CACHE_TTL_MS) return null;
  // CRITICAL: If the access token has changed since the cache was created
  // (e.g. Base44's "View As User" feature swapped the token), invalidate
  // the cache. This forces a fresh base44.auth.me() call with the new token,
  // which returns the impersonated user instead of the previous admin user.
  const currentToken = (typeof localStorage !== 'undefined' && localStorage.getItem('base44_access_token')) || '';
  if (cached.token && cached.token !== currentToken) {
    console.warn('[auth.js] Access token changed since boot cache was created — invalidating cache (likely View As User)');
    removeStorageKey(localStorage, AUTH_BOOT_CACHE_KEY);
    removeStorageKey(sessionStorage, AUTH_BOOT_CACHE_KEY);
    return null;
  }
  return cached.user;
};

const persistAuthUser = (authUser) => {
  if (!authUser) return;
  // CRITICAL: Store the access token alongside the cached auth user so that
  // getFreshCachedAuthUser can detect when the token has changed (e.g. when
  // Base44's "View As User" feature swaps the token). Without this, the 24h
  // boot cache would keep returning the previous admin user even after the
  // token has changed, causing the app to run with admin permissions instead
  // of the impersonated user's permissions.
  const currentToken = (typeof localStorage !== 'undefined' && localStorage.getItem('base44_access_token')) || '';
  const payload = { user: authUser, timestamp: Date.now(), token: currentToken };
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

const hasIdentityChanged = (nextAuthUser, cachedUser) => {
  if (!nextAuthUser || !cachedUser) return false;
  return String(nextAuthUser.id || '') !== String(cachedUser.id || cachedUser.user_id || '');
};

const clearPersistedUserCaches = () => {
  removeStorageKey(sessionStorage, EFFECTIVE_USER_CACHE_KEY);
  removeStorageKey(localStorage, EFFECTIVE_USER_CACHE_KEY);
  removeStorageKey(sessionStorage, AUTH_BOOT_CACHE_KEY);
  removeStorageKey(localStorage, AUTH_BOOT_CACHE_KEY);
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
    const now = Date.now();
    const persistedEffectiveUser = getPersistedEffectiveUser();

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

        const cachedAuthUser = getFreshCachedAuthUser();
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
          try {
            if (!navigator.onLine) {
              console.warn('⚠️ [auth.js] Device is offline, returning cached user data if available');
              return userCache.data || persistedEffectiveUser;
            }

            const authUser = await withTimeout(base44.auth.me(), 10000);
            const cachedResolvedUser = userCache.data || persistedEffectiveUser;
            if (hasIdentityChanged(authUser, cachedResolvedUser)) {
              console.warn('🔄 [auth.js] Auth identity changed, clearing cached user state');
              userCache.data = null;
              userCache.timestamp = 0;
              clearPersistedUserCaches();
            }
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
                    const nowIso = new Date().toISOString();
                    await base44.entities.AppUser.update(appUser.id, {
                      driver_status: 'online',
                      last_seen_at: nowIso,
                    });
                    mergedUser.last_seen_at = nowIso;
                    mergedUser.driver_status = 'online';
                    await offlineDB.save(offlineDB.STORES.APP_USERS, { ...appUser, driver_status: 'online', last_seen_at: nowIso });
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
    clearPersistedUserCaches();
};

// Function to extend cache TTL when user is active (prevents session timeout during idle)
export const touchUserCache = () => {
    if (userCache.data) {
        userCache.timestamp = Date.now();
        persistEffectiveUser(userCache.data);
    }
};