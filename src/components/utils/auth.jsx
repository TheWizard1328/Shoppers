import { User } from '@/entities/User';
import { AppUser } from '@/entities/AppUser';
import { createMergedUser } from './driverUtils';
import { getCached } from './dataManager';

// Global cache for user data to prevent repeated API calls
let userCache = {
  data: null,
  timestamp: 0,
  ttl: 600000, // 10 minutes cache
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
 * Gets the effective user, handling impersonation and merging User + AppUser data.
 * @returns {Promise<object|null>} The effective user object (merged User + AppUser) or null if not logged in.
 */
export const getEffectiveUser = async () => {
    const now = Date.now();
    
    // Check if we're offline
    if (!navigator.onLine) {
        console.warn('⚠️ [auth.js] Device is offline, returning cached user data');
        return userCache.data;
    }
    
    // Check if we're in backoff period due to rate limiting
    if (userCache.backoffTime > 0 && (now - userCache.lastFailureTime) < userCache.backoffTime) {
        console.warn(`⏰ [auth.js] Rate limit backoff active. Using cached data. Backoff ends in ${Math.round((userCache.backoffTime - (now - userCache.lastFailureTime)) / 1000)}s`);
        return userCache.data;
    }

    // Return cached data if still valid
    if (userCache.data && (now - userCache.timestamp) < userCache.ttl) {
        return userCache.data;
    }

    // CRITICAL: If a request is already in-flight, wait for it instead of making duplicate call
    if (inflightUserRequest) {
        console.log('⏳ [auth.js] Waiting for in-flight user request to complete...');
        return await inflightUserRequest;
    }

    // Create the in-flight promise
    const fetchUser = async () => {
        let retryCount = 0;
        const maxRetries = 2;
        const baseDelay = 2000;

        while (retryCount < maxRetries) {
            try {
                // Check if we're online before attempting
                if (!navigator.onLine) {
                    console.warn('⚠️ [auth.js] Device is offline, returning cached user data if available');
                    return userCache.data;
                }

                // Get the authenticated user (from User entity - auth data only)
                const authUser = await withTimeout(User.me(), 10000);
            
            if (!authUser) {
                console.warn('⚠️ [auth.js] No user data received (not logged in - Base44 will handle redirect)');
                sessionStorage.removeItem('impersonationId');
                return null;
            }

            // Use cached AppUser list if available to prevent rate limits
            let appUserList;
            const appUserCacheAge = now - appUserListCache.timestamp;
            
            if (appUserListCache.data && appUserCacheAge < appUserListCache.ttl) {
              appUserList = appUserListCache.data;
            } else {
              appUserList = await withTimeout(AppUser.list(), 8000);
              appUserListCache.data = appUserList;
              appUserListCache.timestamp = now;
            }
            
            const appUser = appUserList.find(au => au && au.user_id === authUser.id);
            
            // Check for impersonation BEFORE merging the real user data
            const impersonationId = sessionStorage.getItem('impersonationId');
            
            // Only admins can impersonate and they cannot impersonate themselves
            if (impersonationId && authUser.role === 'admin' && impersonationId !== authUser.id) {
                try {
                    const impersonatedAppUser = appUserList.find(au => au && au.user_id === impersonationId);
                    
                    // Try to get auth user, but gracefully handle if User.list() is forbidden
                    let impersonatedAuthUser = null;
                    try {
                        const allAuthUsers = await withTimeout(User.list(), 8000);
                        impersonatedAuthUser = allAuthUsers.find(u => u && u.id === impersonationId);
                    } catch (userListError) {
                        if (userListError.response?.status === 403) {
                            console.warn('⚠️ [auth.js] User.list() forbidden - using AppUser data only for impersonation');
                        } else {
                            throw userListError;
                        }
                    }
                    
                    if (impersonatedAppUser) {
                        // Use auth user if available, otherwise create merged user from AppUser only
                        const impersonatedMerged = impersonatedAuthUser 
                            ? createMergedUser(impersonatedAuthUser, impersonatedAppUser)
                            : createMergedUser(null, impersonatedAppUser);
                        
                        if (impersonatedMerged) {
                          impersonatedMerged._isImpersonating = true;
                          impersonatedMerged._realUserId = authUser.id;
                          
                          userCache.data = impersonatedMerged;
                          userCache.timestamp = now;
                          userCache.backoffTime = 0;
                          
                          return impersonatedMerged;
                        }
                    } else {
                        console.warn('⚠️ [auth.js] Impersonation target AppUser not found, clearing impersonation.');
                        sessionStorage.removeItem('impersonationId');
                    }
                } catch (impersonationError) {
                    console.warn("⚠️ [auth.js] Failed to load impersonation user, falling back to real user:", impersonationError.message);
                    sessionStorage.removeItem('impersonationId');
                }
            }

            // Merge auth user + app user data
            const mergedUser = createMergedUser(authUser, appUser);

            if (!mergedUser) {
              console.error(`❌ [auth.js] createMergedUser returned null for ${authUser.full_name}!`);
              return null;
            }

            // Update cache on successful fetch
            userCache.data = mergedUser;
            userCache.timestamp = now;
            userCache.backoffTime = 0;
            
            // Set online status for non-driver users (drivers use the status toggle)
            const isDriver = Array.isArray(mergedUser.app_roles) && mergedUser.app_roles.includes('driver');
            const currentStatus = mergedUser.driver_status;
            
            // Only auto-set online for non-drivers who don't already have a status set
            if (!isDriver && (!currentStatus || currentStatus === 'off_duty') && appUser) {
              try {
                console.log(`🟢 [auth.js] Setting online status for non-driver user: ${mergedUser.user_name}`);
                await AppUser.update(appUser.id, { driver_status: 'online' });
                mergedUser.driver_status = 'online';
                // Invalidate AppUser cache so other components pick up the change
                appUserListCache.timestamp = 0;
              } catch (statusError) {
                console.warn(`⚠️ [auth.js] Failed to set online status:`, statusError.message);
              }
            }
            
            return mergedUser;

        } catch (error) {
            retryCount++;
            const errorMessage = error.message || 'Unknown error';
            console.error(`❌ [auth.js] Failed to get effective user (attempt ${retryCount}/${maxRetries}):`, errorMessage);
            
            // If auth error (401/403), don't retry - user is not logged in
            if (error.response?.status === 401 || error.response?.status === 403) {
                console.warn('⚠️ [auth.js] Authentication error - user not logged in');
                sessionStorage.removeItem('impersonationId');
                return null;
            }

            // Handle rate limiting specifically - use aggressive backoff
            if (error.response?.status === 429 || errorMessage.includes('429') || errorMessage.includes('Rate limit')) {
                userCache.lastFailureTime = now;
                // Start with 60s backoff, double each time, max 10 minutes
                userCache.backoffTime = Math.min((userCache.backoffTime || 30000) * 2, 600000);
                console.warn(`⏰ [auth.js] Rate limit detected. Backing off for ${userCache.backoffTime / 1000}s`);
                
                // CRITICAL: Return cached data if available, even if stale
                if (userCache.data) {
                    console.warn('⚠️ [auth.js] Returning cached user data due to rate limit');
                    return userCache.data;
                }
                
                // If no cached data, wait before retry
                const waitTime = Math.min(5000 * retryCount, 15000);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
            
            // Check for timeout or network errors
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
                return userCache.data || null;
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
    
        return userCache.data || null;
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
};

// Function to extend cache TTL when user is active (prevents session timeout during idle)
export const touchUserCache = () => {
    if (userCache.data) {
        userCache.timestamp = Date.now();
    }
};