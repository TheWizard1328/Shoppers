import { User } from '@/entities/User';
import { AppUser } from '@/entities/AppUser';
import { createMergedUser } from './driverUtils';
import { getCached } from './dataManager';

// Global cache for user data to prevent repeated API calls
let userCache = {
  data: null,
  timestamp: 0,
  ttl: 120000, // 2 minutes cache to prevent rate limits
  lastFailureTime: 0,
  backoffTime: 0
};

// Separate cache for AppUser list (longer TTL since it changes less frequently)
let appUserListCache = {
  data: null,
  timestamp: 0,
  ttl: 300000 // 5 minutes cache for AppUser list
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
        const age = Math.round((now - userCache.timestamp) / 1000);
        console.log(`✅ [auth.js] Using cached user data (age: ${age}s):`, {
          name: userCache.data.user_name,
          app_roles: userCache.data.app_roles
        });
        return userCache.data;
    }

    // REMOVED: Stale data tolerance - no longer returning old data past TTL
    // Force fresh fetch when cache is expired

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

            console.log(`🔐 [auth.js] Fetching FRESH user data (cache expired or not present)...`);

            // Get the authenticated user (from User entity - auth data only)
            const authUser = await withTimeout(User.me(), 10000);
            
            if (!authUser) {
                console.warn('⚠️ [auth.js] No user data received (not logged in - Base44 will handle redirect)');
                sessionStorage.removeItem('impersonationId');
                return null;
            }

            console.log(`✅ [auth.js] Got authUser:`, {
              id: authUser.id,
              email: authUser.email,
              full_name: authUser.full_name,
              role: authUser.role
            });

            // Use cached AppUser list if available to prevent rate limits
            let appUserList;
            const appUserCacheAge = now - appUserListCache.timestamp;
            
            if (appUserListCache.data && appUserCacheAge < appUserListCache.ttl) {
              console.log(`✅ [auth.js] Using CACHED AppUser list (${appUserListCache.data.length} records, age: ${Math.round(appUserCacheAge / 1000)}s)`);
              appUserList = appUserListCache.data;
            } else {
              console.log(`🔄 [auth.js] Fetching FRESH AppUser list (cache expired or not present)...`);
              appUserList = await withTimeout(AppUser.list(), 8000);
              appUserListCache.data = appUserList;
              appUserListCache.timestamp = now;
              console.log(`✅ [auth.js] Got ${appUserList.length} AppUser records (cached for ${appUserListCache.ttl / 1000}s)`);
            }
            
            const appUser = appUserList.find(au => au && au.user_id === authUser.id);
            
            if (appUser) {
              console.log(`✅ [auth.js] Found AppUser record for ${appUser.user_name}:`, {
                id: appUser.id,
                user_id: appUser.user_id,
                user_name: appUser.user_name,
                app_roles_RAW: appUser.app_roles,
                app_roles_type: typeof appUser.app_roles,
                app_roles_is_array: Array.isArray(appUser.app_roles),
                app_roles_stringified: JSON.stringify(appUser.app_roles)
              });
            } else {
              console.error(`❌ [auth.js] NO AppUser record found for authUser.id:`, authUser.id);
            }

            // Check for impersonation BEFORE merging the real user data
            const impersonationId = sessionStorage.getItem('impersonationId');
            
            // Only admins can impersonate and they cannot impersonate themselves
            if (impersonationId && authUser.role === 'admin' && impersonationId !== authUser.id) {
                console.log('🎭 [auth.js] Impersonation detected:', impersonationId);
                try {
                    const impersonatedAppUser = appUserList.find(au => au && au.user_id === impersonationId);
                    
                    console.log(`🔄 [auth.js] Fetching User list for impersonation...`);
                    const allAuthUsers = await withTimeout(User.list(), 8000);
                    
                    const impersonatedAuthUser = allAuthUsers.find(u => u && u.id === impersonationId);
                    
                    if (impersonatedAuthUser && impersonatedAppUser) {
                        console.log(`✅ [auth.js] Found impersonation target - AppUser app_roles:`, impersonatedAppUser.app_roles);
                        
                        const impersonatedMerged = createMergedUser(impersonatedAuthUser, impersonatedAppUser);
                        
                        if (impersonatedMerged) {
                          impersonatedMerged._isImpersonating = true;
                          impersonatedMerged._realUserId = authUser.id;
                          
                          userCache.data = impersonatedMerged;
                          userCache.timestamp = now;
                          userCache.backoffTime = 0;
                          
                          console.log(`✅ [auth.js] Impersonated user loaded:`, {
                            name: impersonatedMerged.user_name,
                            app_roles: impersonatedMerged.app_roles
                          });
                          return impersonatedMerged;
                        }
                    } else {
                        console.warn('⚠️ [auth.js] Impersonation target not found or invalid, clearing impersonation.');
                        console.warn('   Debug info:', {
                          impersonationId,
                          foundAuthUser: !!impersonatedAuthUser,
                          foundAppUser: !!impersonatedAppUser,
                          allAuthUsersCount: allAuthUsers?.length || 0,
                          allAppUsersCount: appUserList?.length || 0
                        });
                        sessionStorage.removeItem('impersonationId');
                    }
                } catch (impersonationError) {
                    console.warn("⚠️ [auth.js] Failed to load impersonation user, falling back to real user:", impersonationError.message);
                    sessionStorage.removeItem('impersonationId');
                }
            }

            // Merge auth user + app user data
            console.log(`🔀 [auth.js] Merging authUser with appUser for ${authUser.full_name}...`);
            const mergedUser = createMergedUser(authUser, appUser);

            if (!mergedUser) {
              console.error(`❌ [auth.js] createMergedUser returned null for ${authUser.full_name}!`);
              return null;
            }

            console.log(`✅ [auth.js] Final merged user for ${mergedUser.user_name}:`, {
              id: mergedUser.id,
              app_roles_FINAL: mergedUser.app_roles,
              app_roles_type: typeof mergedUser.app_roles,
              app_roles_is_array: Array.isArray(mergedUser.app_roles),
              app_roles_stringified: JSON.stringify(mergedUser.app_roles),
              status: mergedUser.status
            });

            // Update cache on successful fetch
            userCache.data = mergedUser;
            userCache.timestamp = now;
            userCache.backoffTime = 0;
            
            console.log(`✅ [auth.js] User data cached successfully with TTL of ${userCache.ttl}ms`);
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
                console.log(`⏳ [auth.js] Waiting ${waitTime}ms before retry...`);
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
                console.log(`🔄 [auth.js] Retrying in ${delay}ms...`);
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
        ttl: 120000, // 2 minutes
        lastFailureTime: 0,
        backoffTime: 0
    };
    appUserListCache = {
        data: null,
        timestamp: 0,
        ttl: 300000 // 5 minutes
    };
    sessionStorage.removeItem('impersonationId');
    console.log(`🗑️ [auth.js] User cache cleared`);
};