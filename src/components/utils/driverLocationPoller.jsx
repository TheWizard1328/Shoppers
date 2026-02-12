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
     console.log(`⏸️ [DriverLocationPoller] Paused - skipping location processing`);
     return;
   }

   // CRITICAL: Validate appUsers FIRST before any other checks
   if (!appUsers || !Array.isArray(appUsers) || appUsers.length === 0) {
     console.warn('⚠️ [DriverLocationPoller] No appUsers data provided - skipping location processing');
     // Still notify with empty array to clear stale markers
     this.notifySubscribers([]);
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

   console.log(`📍 [DriverLocationPoller] Processing ${appUsers.length} driver locations (forceNotify: ${forceNotify}, currentPage: ${currentPageName})`);

   // Count drivers with coordinates
   const driversWithCoords = appUsers.filter(u => u && u.current_latitude && u.current_longitude).length;
   console.log(`📊 [DriverLocationPoller] Input: ${driversWithCoords}/${appUsers.length} drivers have coordinates`);

   // Update internal current user reference
   this.currentUser = currentUser;

   // Use provided appUsers directly
   let usersData = appUsers;

    // Process location data silently

    const currentUserId = this.currentUser?.id;
    const currentUserUserId = this.currentUser?.user_id;
    
    // CRITICAL: Determine device type early
    const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    let users = Array.isArray(usersData) ? [...usersData] : [];
    
    const now = Date.now();
    const maxStaleTime = 5 * 60 * 1000; // 5 minutes - hide marker if no updates
    
    console.log(`🔍 [Poller] Processing ${users.length} users (no deduplication - from real-time stream)`);
    
    // Filter to only users with valid coordinates
    users = users.filter(user => {
      if (!user.current_latitude || !user.current_longitude) {
        return false;
      }
      return true;
    });
    
    console.log(`✅ [Poller] After coordinate filter: ${users.length} users with valid coordinates`);
    
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

       // Already filtered by coordinates above, no additional timestamp checks needed

       // ========================================
       // RULE 1: Own location marker - VISIBLE ONLY ON NON-PRIMARY DEVICES
       // ========================================
       if (isSelf) {
         // CRITICAL: Non-primary device shows self marker ONLY when "Show All" is OFF
         // Primary device NEVER shows self marker
         // When "Show All" is ON, self marker is suppressed (user sees it via live location layer)
         const isPrimaryDevice = localStorage.getItem(`device_is_primary_${currentUserId}`) === 'true';

         if (isPrimaryDevice) {
           console.log(`🚫 [Poller] SELF marker BLOCKED on PRIMARY device (always hidden)`);
           return false;
         }

         if (!showAllDrivers) {
           console.log(`✅ [Poller] Including SELF marker on NON-PRIMARY device (Show All OFF)`, {
             userId: user.user_name,
             driver_status: user.driver_status
           });
           return true;
         }

         console.log(`🚫 [Poller] SELF marker BLOCKED on NON-PRIMARY device (Show All ON)`);
         return false;
       }

       // Skip inactive users for other drivers
       if (user.status === 'inactive') return false;

       // Must be in same city (admin exempted via city checks in parent)
       if (currentUserCityId && user.city_id !== currentUserCityId) return false;

       // ========================================
       // RULE 2: Admins (AppOwners) - can see all drivers in city if On Duty OR On Break
       // ========================================
       if (isAdmin) {
         // Admin sees drivers if they are On Duty OR On Break (regardless of location_tracking_enabled)
         if (user.driver_status === 'on_duty' || user.driver_status === 'on_break') {
           console.log(`✅ [Poller] Admin seeing driver ${user.user_name} - status: ${user.driver_status}`);
           return true;
         }

         return false;
       }

       // ========================================
       // RULE 3: Dispatchers viewing assigned drivers
       // ========================================
       if (isDispatcher && !isDriver) {
         const dispatcherStoreIds = new Set(this.currentUser.store_ids || []);

         // Check if driver has ANY deliveries for dispatcher's stores (today)
         const hasDeliveriesFromDispatcherStores = (deliveries || []).some(delivery => {
           if (!delivery) return false;
           if (delivery.driver_id !== driverId) return false;
           if (delivery.delivery_date !== todayStr) return false;
           if (!dispatcherStoreIds.has(delivery.store_id)) return false;
           return true;
         });

         if (!hasDeliveriesFromDispatcherStores) {
           return false;
         }

         // Dispatchers see assigned drivers if On Duty OR On Break (even after completing route)
         if (user.driver_status === 'on_duty' || user.driver_status === 'on_break') {
           console.log(`✅ [Poller] Dispatcher seeing assigned driver ${user.user_name} - status: ${user.driver_status}`);
           return true;
         }

         return false;
       }

       // ========================================
       // RULE 4: Drivers viewing other drivers
       // ========================================
       if (isDriver) {
         // Must be in "show all" or "all drivers" mode
         if (!showAllDrivers) {
           return false;
         }

         // Other driver must be On Duty OR On Break
         if (user.driver_status !== 'on_duty' && user.driver_status !== 'on_break') {
           return false;
         }

         // Other driver must have location sharing enabled
         if (user.location_tracking_enabled !== true) {
           return false;
         }

         console.log(`✅ [Poller] Driver seeing other driver ${user.user_name}`);
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

    console.log(`✅ [DriverLocationPoller] Filtered to ${activeDriversWithLocation.length} drivers with valid rules`);
    
    this.lastLocations = newLocations;
    this.notifySubscribers(activeDriversWithLocation, forceNotify);
    }

  notifySubscribers(activeDriversWithLocation, forceNotify = false) {
    console.log(`📡 [Poller] Notifying ${activeDriversWithLocation.length} drivers`);
    
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

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
        detail: { 
          appUsers: activeDriversWithLocation,
          forceAll: forceNotify,
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