import { userHasRole } from './userRoles';
import { locationTracker } from './locationTracker';

class DriverLocationPoller {
  constructor() {
    this.pollingInterval = null;
    this.subscribers = new Set();
    this.lastLocations = new Map();
    this.isPolling = false;
    this.isPaused = false; // Pause flag for imports
    this.requestDataRefresh = null; // Callback to request data refresh from parent
    this.currentUser = null;
    this._lastNotifiedKey = null; // CRITICAL: Track last notification to prevent duplicates
  }

  /**
   * Pause location processing (e.g., during imports)
   */
  pause() {
    this.isPaused = true;
    console.log('⏸️ [DriverLocationPoller] Paused');
  }

  /**
   * Resume location processing
   */
  resume() {
    this.isPaused = false;
    console.log('▶️ [DriverLocationPoller] Resumed');
  }

  /**
   * Initialize the poller with current user context
   * @param {Function} requestDataRefresh - Callback to trigger data refresh in parent (deprecated)
   * @param {Object} currentUser - The current authenticated user
   */
  start(requestDataRefresh, currentUser) {
    if (this.isPolling) {
      console.log('⏭️ [DriverLocationPoller] Already initialized');
      return;
    }

    this.requestDataRefresh = requestDataRefresh;
    this.currentUser = currentUser;
    this.isPolling = true;
  }

  stop() {
    this.isPolling = false;
    this.lastLocations.clear();
    console.log('🛑 [DriverLocationPoller] Stopped');
  }

  /**
    * Process incoming location data from parent component
    * Filters drivers based on sharing settings and user permissions
    * CRITICAL: Loads appUsers from offline DB first to prevent rate limiting
    * CRITICAL: Skips processing if selected date is in past or not on Dashboard
    * @param {Object} currentUser - Current authenticated user
    * @param {Array} deliveries - Array of delivery objects
    * @param {Array} drivers - Array of driver objects
    * @param {Array} stores - Array of store objects
    * @param {Array} appUsers - Array of AppUser objects with location data (fallback if offline DB fails)
    * @param {Date} selectedDate - Currently selected date
    * @param {string} currentPageName - Current page name (to check if on Dashboard)
    * @param {boolean} showAllDrivers - Whether "show all" or "all drivers" mode is active
    */
  async processLocationData(currentUser, deliveries, drivers, stores, appUsers, selectedDate, forceNotify = false, currentPageName = null, showAllDrivers = false) {
    // Skip processing if paused (e.g., during imports)
    if (this.isPaused) {
      return;
    }

    // CRITICAL: Skip page/date check when forceNotify=true (smart refresh with fresh data)
    // Only enforce Dashboard/today check for automatic polling cycles
    if (!forceNotify && currentPageName && selectedDate) {
      const todayStr = new Date().toISOString().split('T')[0];
      const selectedDateStr = selectedDate instanceof Date 
        ? selectedDate.toISOString().split('T')[0]
        : selectedDate;

      if (currentPageName !== 'Dashboard' || selectedDateStr !== todayStr) {
        console.log(`⏭️ [DriverLocationPoller] Skipping location processing - not on Dashboard today (page: ${currentPageName}, date: ${selectedDateStr})`);
        return;
      }
    }
    
    console.log(`📍 [DriverLocationPoller] Processing ${appUsers.length} driver locations (forceNotify: ${forceNotify})`);
    
    // DEBUG: Log first few users to see what data we're getting
    if (appUsers.length > 0) {
      console.log(`📊 [Poller] Sample appUsers data:`, appUsers.slice(0, 2).map(u => ({
        user_name: u.user_name,
        location_updated_at: u.location_updated_at,
        driver_status: u.driver_status,
        location_tracking_enabled: u.location_tracking_enabled,
        current_latitude: u.current_latitude,
        current_longitude: u.current_longitude,
        id: u.id,
        user_id: u.user_id
      })));
    } else {
      console.warn(`⚠️ [Poller] No appUsers data provided to processLocationData!`);
    }

    // Update internal current user reference
    this.currentUser = currentUser;

    // CRITICAL: When forceNotify=true, always pull fresh data from API FIRST
    let usersData = appUsers;
    if (forceNotify) {
      console.log('📍 [DriverLocationPoller] forceNotify=true - pulling fresh data from API');
      try {
        const { base44 } = await import('@/api/base44Client');
        const freshAppUsers = await base44.entities.AppUser.list();
        console.log(`📡 [DriverLocationPoller] Pulled ${freshAppUsers.length} fresh AppUsers from API`);
        
        // Save to offline DB immediately
        const { offlineDB } = await import('./offlineDatabase');
        await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, freshAppUsers);
        console.log(`💾 [DriverLocationPoller] Synced fresh data to offline DB`);
        
        usersData = freshAppUsers;
      } catch (apiError) {
        console.warn('⚠️ [DriverLocationPoller] Failed to pull fresh data from API:', apiError.message);
        // Fall back to provided appUsers
      }
    } else if (!forceNotify) {
      try {
        const { offlineDB } = await import('./offlineDatabase');
        const offlineAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);

        if (offlineAppUsers && offlineAppUsers.length > 0) {
          // Merge both sources, deduplicating by user ID
          const userMap = new Map();
          
          // First, add offline users to map
          offlineAppUsers.forEach(user => {
            if (user && (user.id || user.user_name)) {
              const userId = user.id || user.user_name;
              userMap.set(userId, user);
            }
          });
          
          // Then, add/override with online users (prioritizing newer data)
          appUsers.forEach(user => {
            if (user && (user.id || user.user_name)) {
              const userId = user.id || user.user_name;
              const existingUser = userMap.get(userId);
              
              // If no existing user OR online data has newer location timestamp
              if (!existingUser) {
                userMap.set(userId, user);
              } else if (user.location_updated_at && existingUser.location_updated_at) {
                const onlineTimestamp = new Date(user.location_updated_at).getTime();
                const offlineTimestamp = new Date(existingUser.location_updated_at).getTime();
                
                // Use online data if it's newer
                if (onlineTimestamp > offlineTimestamp) {
                  userMap.set(userId, user);
                }
              } else if (user.location_updated_at && !existingUser.location_updated_at) {
                // Online has timestamp, offline doesn't - use online
                userMap.set(userId, user);
              }
            }
          });
          
          usersData = Array.from(userMap.values());
          console.log(`📍 [DriverLocationPoller] Merged offline+online data: ${usersData.length} unique users`);
        }
      } catch (offlineError) {
        console.warn('⚠️ [DriverLocationPoller] Failed to load from offline DB, using props:', offlineError.message);
      }
    } else {
      console.log('📍 [DriverLocationPoller] forceNotify=true - using provided fresh appUsers, skipping offline DB load');
    }

    // Process location data silently

    const currentUserId = this.currentUser?.id;
    const currentUserUserId = this.currentUser?.user_id;
    
    // CRITICAL: Determine device type early
    const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    let users = Array.isArray(usersData) ? [...usersData] : [];
    
    const now = Date.now();
    const maxStaleTime = 5 * 60 * 1000; // 5 minutes - hide marker if no updates
    
    console.log(`🔍 [Poller] Processing ${users.length} users before deduplication/filtering`);
    
    // CRITICAL: First deduplicate by user ID across ALL users (including stale), keeping most recent
    const userMap = new Map();
    users.forEach(user => {
      if (!user || !(user.id || user.user_name)) return;
      
      const userId = user.id || user.user_name;
      const existingUser = userMap.get(userId);
      
      if (!existingUser) {
        userMap.set(userId, user);
      } else {
        // Keep the user with the most recent location timestamp
        const newTimestamp = user.location_updated_at ? new Date(user.location_updated_at).getTime() : 0;
        const existingTimestamp = existingUser.location_updated_at ? new Date(existingUser.location_updated_at).getTime() : 0;
        
        if (newTimestamp > existingTimestamp) {
          console.log(`⚠️ [Poller] Duplicate user ${userId} - keeping NEWER: ${user.location_updated_at} (vs old: ${existingUser.location_updated_at})`);
          userMap.set(userId, user);
        } else {
          console.log(`⚠️ [Poller] Duplicate user ${userId} - keeping EXISTING: ${existingUser.location_updated_at} (vs old: ${user.location_updated_at})`);
        }
      }
    });
    
    users = Array.from(userMap.values());
    console.log(`✅ [Poller] After deduplication: ${users.length} unique users`);
    
    // CRITICAL: Now filter out stale locations (older than 5 minutes)
    users = users.filter(user => {
      // Skip users without location timestamps or coordinates
      if (!user.location_updated_at || !user.current_latitude || !user.current_longitude) {
        return false;
      }
      
      // Check if location is too old (more than 5 minutes)
      const locationAge = now - new Date(user.location_updated_at).getTime();
      const ageMinutes = Math.floor(locationAge / 60000);
      
      if (locationAge > maxStaleTime) {
        console.log(`⏭️ [Poller] Skipping user ${user.user_name} - location too old (${ageMinutes} min): ${user.location_updated_at}`);
        return false; // Skip stale locations entirely
      }
      
      console.log(`✅ [Poller] Including user ${user.user_name} - fresh location (${ageMinutes} min old): ${user.location_updated_at}`);
      return true;
    });
    
    console.log(`✅ [Poller] After staleness filter: ${users.length} users with fresh locations`);
    
    if (users.length === 0) {
      // CRITICAL: Still notify subscribers with empty array to clear markers
      this.notifySubscribers([]);
      return;
    }
    const thirtyMinutesInMs = 30 * 60 * 1000;
    
    const isAdmin = this.currentUser && userHasRole(this.currentUser, 'admin');
    const isDispatcher = this.currentUser && userHasRole(this.currentUser, 'dispatcher');
    const isDriver = this.currentUser && userHasRole(this.currentUser, 'driver');
    const currentUserCityId = this.currentUser?.city_id;
    
    const todayStr = new Date().toISOString().split('T')[0];

    // CRITICAL: Filter drivers based on NEW visibility rules
    const activeDriversWithLocation = users.filter(user => {
      if (!user) return false;

      const driverId = user.id || user.user_name;
      const isSelf = user.user_name === currentUserId || 
                     user.id === currentUserId || 
                     user.user_name === currentUserUserId ||
                     user.id === currentUserUserId;

      // CRITICAL: Check self BEFORE coordinates to enable debugging
      if (isSelf) {
        console.log(`🔍 [Poller] SELF MARKER CHECK:`, {
          userId: user.user_name,
          hasCoordinates: !!(user.current_latitude && user.current_longitude),
          current_latitude: user.current_latitude,
          current_longitude: user.current_longitude,
          location_updated_at: user.location_updated_at,
          driver_status: user.driver_status,
          location_tracking_enabled: user.location_tracking_enabled
        });
      }

      // Skip if no valid coordinates
      if (!user.current_latitude || !user.current_longitude) {
        if (isSelf) {
          console.log(`❌ [Poller] SELF marker BLOCKED - no coordinates in AppUser entity`);
        }
        return false;
      }

      // CRITICAL: 5-minute inactivity rule - applies to ALL markers (including own)
      if (user.location_updated_at) {
        const locationAge = now - new Date(user.location_updated_at).getTime();
        if (locationAge > maxStaleTime) {
          if (isSelf) {
            const ageMinutes = Math.floor(locationAge / 60000);
            const ageHours = Math.floor(ageMinutes / 60);
            const ageDays = Math.floor(ageHours / 24);
            console.log(`❌ [Poller] SELF marker BLOCKED - location too old:`, {
              location_updated_at: user.location_updated_at,
              ageMinutes,
              ageHours,
              ageDays,
              maxStaleMinutes: maxStaleTime / 60000
            });
          }
          return false;
        }
      } else {
        if (isSelf) {
          console.log(`❌ [Poller] SELF marker BLOCKED - no location_updated_at timestamp`);
        }
        return false;
      }

      // ========================================
      // RULE 1: Own location marker - ALWAYS visible regardless of any status/toggle
      // ========================================
      if (isSelf) {
        // CRITICAL: ALWAYS include self marker
        // - Primary device filtering happens in DriverLocationMarkers (blocks self marker)
        // - Non-primary devices ALWAYS show shared location marker
        // - Bypasses driver_status check (on_duty/off_duty/on_break)
        // - Bypasses location_tracking_enabled toggle
        // - Bypasses active deliveries check
        console.log(`✅ [Poller] Including SELF marker - bypasses all checks`, {
          userId: user.user_name,
          driver_status: user.driver_status,
          location_tracking_enabled: user.location_tracking_enabled
        });
        return true;
      }

      // Skip inactive users for other drivers
      if (user.status === 'inactive') return false;

      // Must be in same city (admin exempted via city checks in parent)
      if (currentUserCityId && user.city_id !== currentUserCityId) return false;

      // ========================================
      // RULE 2: Dispatchers viewing assigned drivers
      // ========================================
      if (isDispatcher && !isAdmin && !isDriver) {
        const dispatcherStoreIds = new Set(this.currentUser.store_ids || []);

        // Check if driver has ANY deliveries for dispatcher's stores (today)
        const hasDeliveriesFromDispatcherStores = (deliveries || []).some(delivery => {
          if (!delivery) return false;
          if (delivery.driver_id !== driverId) return false;
          if (delivery.delivery_date !== todayStr) return false;
          if (!dispatcherStoreIds.has(delivery.store_id)) return false;
          return true; // Include all deliveries, not just active ones
        });

        if (!hasDeliveriesFromDispatcherStores) {
          return false;
        }

        // Dispatchers ALWAYS see their assigned drivers' markers
        // Regardless of driver_status, location_tracking_enabled, or showAllDrivers mode
        return true;
      }

      // ========================================
      // RULE 3: Admins and Drivers viewing other drivers
      // ========================================

      // CRITICAL: Must be in "show all" or "all drivers" mode
      if (!showAllDrivers) {
        return false;
      }

      // Must be on_duty or on_break
      if (user.driver_status !== 'on_duty' && user.driver_status !== 'on_break') {
        return false;
      }

      // For non-admin drivers, must have location_tracking_enabled = true
      // Admins bypass this check (admin override)
      if (!isAdmin && user.location_tracking_enabled !== true) {
        return false;
      }

      // Show marker for admin or driver in show all/all drivers mode
      return true;
    });

    // CRITICAL: ALWAYS notify subscribers with current locations to prevent disappearing markers
    // Don't check for changes - just broadcast the current state every time

    const newLocations = new Map();
    activeDriversWithLocation.forEach(user => {
      const locationKey = `${user.id}_${user.current_latitude}_${user.current_longitude}_${user.driver_status}`;
      newLocations.set(user.id, locationKey);
    });

    this.lastLocations = newLocations;
    this.notifySubscribers(activeDriversWithLocation, forceNotify);
    }

  notifySubscribers(activeDriversWithLocation, forceNotify = false) {
    // Convert array of users to array of location objects
    const currentUserId = this.currentUser?.id;
    const currentUserUserId = this.currentUser?.user_id;

    const locationObjects = activeDriversWithLocation.map(user => {
      const isSelf = user.user_name === currentUserId || 
                     user.id === currentUserId ||
                     user.user_name === currentUserUserId ||
                     user.id === currentUserUserId;
      const isOnBreak = user.driver_status === 'on_break';

      return {
        id: user.id,
        user_id: user.id,
        driver_id: user.id,
        user_name: user.user_name || user.full_name,
        latitude: user.current_latitude,
        longitude: user.current_longitude,
        current_latitude: user.current_latitude,
        current_longitude: user.current_longitude,
        location_updated_at: user.location_updated_at,
        driver_status: user.driver_status,
        location_tracking_enabled: user.location_tracking_enabled,
        _isSelf: isSelf,
        _isOnBreak: isOnBreak && isSelf
      };
    });

    this.subscribers.forEach(callback => {
      try {
        callback(locationObjects);
      } catch (error) {
        console.error('Error notifying driver location subscriber:', error);
      }
    });
  }

  subscribe(callback) {
    if (typeof callback !== 'function') {
      console.error('Subscriber callback must be a function');
      return () => {};
    }

    this.subscribers.add(callback);

    // Return unsubscribe function
    return () => {
      this.subscribers.delete(callback);
    };
  }

  getStatus() {
    return {
      isPolling: this.isPolling,
      subscriberCount: this.subscribers.size,
      trackedDriverCount: this.lastLocations.size
    };
  }
}

export const driverLocationPoller = new DriverLocationPoller();