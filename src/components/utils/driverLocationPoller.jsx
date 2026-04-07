import { userHasRole, isAppOwner } from './userRoles';
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
    this._lastNotifyTs = 0; // Throttle broadcast to reduce UI churn
  }

  /**
   * Pause location processing (e.g., during imports)
   */
  pause() {
    this.isPaused = true;
  }

  /**
   * Resume location processing
   */
  resume() {
    this.isPaused = false;
  }

  /**
   * Initialize the poller with current user context
   * @param {Function} requestDataRefresh - Callback to trigger data refresh in parent (deprecated)
   * @param {Object} currentUser - The current authenticated user
   */
  start(requestDataRefresh, currentUser) {
    if (this.isPolling) {
      return;
    }

    this.requestDataRefresh = requestDataRefresh;
    this.currentUser = currentUser;
    this.isPolling = true;
  }

  stop() {
    this.isPolling = false;
    this.lastLocations.clear();
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

   // CRITICAL: Validate appUsers FIRST before any other checks
   if (!appUsers || !Array.isArray(appUsers) || appUsers.length === 0) {
     // Still notify with empty array to clear stale markers
     this.notifySubscribers([]);
     return;
   }

   // CRITICAL: Only poll/process automatic location updates on Dashboard while viewing today.
   // For past/future dates, rely on existing websocket-synced data and skip polling.
   const todayStr = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
   const selectedDateKey = selectedDate instanceof Date
     ? `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`
     : (selectedDate || todayStr);
   if (!forceNotify && (currentPageName !== 'Dashboard' || selectedDateKey !== todayStr)) {
     return;
   }

   // Count drivers with coordinates
   const driversWithCoords = appUsers.filter(u => u && u.current_latitude && u.current_longitude).length;

   // REMOVED: Stale coordinate cleanup was wiping ALL AppUser coordinates on every poll
   // because the offline DB contains thousands of non-driver AppUser records with no timestamps.
   // This was causing GPS markers to disappear immediately after being set.


   // Update internal current user reference
   this.currentUser = currentUser;

   // Use provided appUsers directly, but guard against stale offline overwrites by preferring newest timestamps
   // CRITICAL: Filter out junk records from offline DB (records with undefined/missing user_id or user_name)
   let usersData = (appUsers?.slice?.() || []).filter(u => u && u.id && u.user_id && u.user_id !== 'undefined' && u.user_name && u.user_name !== 'undefined');

   if (usersData.length < (appUsers?.length || 0)) {
     const rejected = (appUsers?.length || 0) - usersData.length;
     console.warn(`⚠️ [DriverLocationPoller] Rejected ${rejected} junk AppUser records (missing user_id/user_name)`);
   }

   // Last-write-wins: if duplicates by id exist with different timestamps, keep the freshest
   const byId = new Map();
   const ts = (u) => {
     const t = u?.location_updated_at || u?.updated_date || u?.created_date;
     return t ? new Date(t).getTime() : 0;
   };
   for (const u of usersData) {
     if (!u || !u.id) continue;
     const cur = byId.get(u.id);
     if (!cur || ts(u) >= ts(cur)) {
       byId.set(u.id, u);
     }
   }
   usersData = Array.from(byId.values());

    // Process location data silently

    const currentUserId = this.currentUser?.id;
    const currentUserUserId = this.currentUser?.user_id;
    
    // CRITICAL: Determine device type early
    const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    let users = Array.isArray(usersData) ? [...usersData] : [];
    
    const now = Date.now();
    const maxStaleTime = 5 * 60 * 1000; // 5 minutes - hide marker if no updates
    
    // Filter to only users with valid coordinates
    users = users.filter(user => {
      if (!user.current_latitude || !user.current_longitude) {
        return false;
      }
      return true;
    });
    
    // CRITICAL: Calculate staleness for each user (for visual indicators later)
    const currentTime = Date.now();
    users = users.map(user => {
      if (!user.location_updated_at) {
        return { ...user, _locationStale: true, _staleness: 'unknown', _ageSeconds: null };
      }
      
      const lastUpdate = new Date(user.location_updated_at).getTime();
      const ageMs = currentTime - lastUpdate;
      const ageSeconds = Math.floor(ageMs / 1000);
      const ageMinutes = Math.floor(ageMs / 60000);
      
      let staleness = 'fresh';
      if (ageSeconds > 60) staleness = 'heartbeat_stale';
      if (ageMinutes > 30) staleness = 'very_stale';
      else if (ageMinutes > 15) staleness = 'stale';
      else if (ageMinutes > 5) staleness = 'aging';
      
      return { ...user, _locationStale: ageSeconds > 60, _staleness: staleness, _ageMinutes: ageMinutes, _ageSeconds: ageSeconds };
    });
    
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
    
    const selectedDateStr = selectedDate instanceof Date
      ? `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`
      : selectedDate || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;

    // CRITICAL: Log if user is AppOwner for debugging
     const isUserAppOwner = isAppOwner(this.currentUser);

     // CRITICAL: Filter drivers based on NEW visibility rules
     const activeDriversWithLocation = users.filter(user => {
       if (!user) return false;

       const driverId = user.id || user.user_name;
       const isSelf = user.user_name === currentUserId || 
                        user.id === currentUserId || 
                        user.user_id === currentUserId ||
                        user.user_name === currentUserUserId ||
                        user.id === currentUserUserId ||
                        user.user_id === currentUserUserId;

       // Skip if no valid coordinates
       if (!user.current_latitude || !user.current_longitude) {
         return false;
       }

       // Already filtered by coordinates above, no additional timestamp checks needed

       // ========================================
       // RULE 1: Own location marker - drivers on primary device DON'T see their own shared location
       // ========================================
       if (isSelf) {
         if (isDriver && !isDispatcher && !isAdmin && locationTracker.isTracking === true) {
           return false;
         }
         return true;
       }

       // ========================================
       // RULE 2: AppOwners - can see ALL drivers regardless of settings
       // ========================================
       // CRITICAL: Check AppOwner FIRST before any other checks
       if (isUserAppOwner) {
         // AppOwners see ALL drivers with coordinates in their city, no filtering
         return true;
       }

       // Skip inactive users
       if (user.status === 'inactive') return false;

       // Must be in same city (applies to all roles)
       // CRITICAL: Support both city_id (string) and city_ids (array) on AppUser
       if (currentUserCityId) {
         const userCityIds = user.city_ids && user.city_ids.length > 0 ? user.city_ids : (user.city_id ? [user.city_id] : []);
         if (!userCityIds.includes(currentUserCityId)) return false;
       }

       // ========================================
       // RULE 3: Admins (non-AppOwners) - can only see drivers with location sharing ON
       // ========================================
       if (isAdmin && !isAppOwner(this.currentUser)) {
         // Admins require location_tracking_enabled to be true
         if (!user.location_tracking_enabled) return false;
         return true;
       }

       // ========================================
       // RULE 4: Dispatchers viewing assigned drivers
       // ========================================
       if (isDispatcher && !isDriver) {
         // 1. Driver must be On Duty
         if (user.driver_status !== 'on_duty') {
           return false;
         }

         // CRITICAL: Normalize dispatcher store IDs to strings for consistent comparison
         const rawDispatcherStoreIds = this.currentUser.store_ids || [];
         const dispatcherStoreIds = new Set(rawDispatcherStoreIds.map(id => String(id)));

         // All possible IDs for this AppUser
         const userIdForDeliveryMatch = user.id || user.user_id;
         const allDriverIdFormats = [userIdForDeliveryMatch, driverId, user.user_id, user.user_user_id].filter(Boolean);

         // 2. Driver must have at least 1 en_route OR in_transit delivery from dispatcher's stores on selected date
         const matchingDeliveries = (deliveries || []).filter(delivery => {
           if (!delivery) return false;

           const driverMatch = allDriverIdFormats.some(fmt => delivery.driver_id === fmt);
           const dateMatch = delivery.delivery_date === selectedDateStr;
           const deliveryStoreIdStr = String(delivery.store_id || '');
           const storeMatch = dispatcherStoreIds.has(deliveryStoreIdStr);
           const statusMatch = delivery.status === 'in_transit' || delivery.status === 'en_route';

           return driverMatch && dateMatch && storeMatch && statusMatch;
         });

         if (matchingDeliveries.length === 0) {
           const allDriverDeliveries = (deliveries || []).filter(d => d && allDriverIdFormats.some(fmt => d.driver_id === fmt) && d.delivery_date === selectedDateStr);
           if (allDriverDeliveries.length > 0) {
             // Log store IDs of those deliveries to help debug
             const deliveryStoreIds = [...new Set(allDriverDeliveries.map(d => d.store_id))];
           }
           return false;
         }
         return true;
       }

       // ========================================
       // RULE 5: Drivers viewing other drivers
       // ========================================
       if (isDriver) {
         // Must be in "show all" or "all drivers" mode
         if (!showAllDrivers) {
           return false;
         }

         // Other driver must have location_tracking_enabled = true
         if (!user.location_tracking_enabled) {
           return false;
         }
         return true;
       }

       return false;
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
    // Throttle notifications to max ~4fps to reduce re-render churn
    const now = Date.now();
    if (!forceNotify && now - this._lastNotifyTs < 250) {
      return;
    }
    this._lastNotifyTs = now;
    const currentUserId = this.currentUser?.id;
    const currentUserUserId = this.currentUser?.user_id;

    const locationObjects = activeDriversWithLocation.map(user => {
      const isSelf = user.user_name === currentUserId || 
                     user.id === currentUserId ||
                     user.user_id === currentUserId ||
                     user.user_name === currentUserUserId ||
                     user.id === currentUserUserId ||
                     user.user_id === currentUserUserId;
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
        _isOnBreak: isOnBreak && isSelf,
        _staleness: user._staleness || 'fresh',
        _ageMinutes: user._ageMinutes || 0,
        _ageSeconds: user._ageSeconds || 0
      };
    });

    this.subscribers.forEach(callback => {
      try {
        callback(locationObjects);
      } catch (error) {
        console.error('Error notifying driver location subscriber:', error);
      }
    });

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
        detail: { 
          appUsers: activeDriversWithLocation,
          forceAll: forceNotify,
          singleUpdate: activeDriversWithLocation.length === 1 && !forceNotify, // CRITICAL: Single driver update
          fromPoller: true // CRITICAL: Flag to prevent infinite recursion
        }
      }));
    }
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