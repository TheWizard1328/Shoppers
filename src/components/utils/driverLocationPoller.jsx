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
       console.log(`⏭️ [DriverLocationPoller] Not on Dashboard today - clearing driver markers (page: ${currentPageName}, date: ${selectedDateStr})`);
       this.notifySubscribers([]);
       return;
     }
   }

   console.log(`📍 [DriverLocationPoller] Processing ${appUsers.length} driver locations (forceNotify: ${forceNotify}, currentPage: ${currentPageName})`);
   console.log(`🔍 [DriverLocationPoller] appUsers input:`, appUsers?.map(u => ({
     id: u?.id,
     user_id: u?.user_id,
     user_name: u?.user_name,
     has_coords: !!(u?.current_latitude && u?.current_longitude),
     lat: u?.current_latitude?.toFixed(6),
     lng: u?.current_longitude?.toFixed(6),
     timestamp: u?.location_updated_at,
     driver_status: u?.driver_status,
     location_tracking_enabled: u?.location_tracking_enabled
   })));

   // Count drivers with coordinates
   const driversWithCoords = appUsers.filter(u => u && u.current_latitude && u.current_longitude).length;
   console.log(`📊 [DriverLocationPoller] Input: ${driversWithCoords}/${appUsers.length} drivers have coordinates`);

   // CRITICAL: Clean offline DB of stale location data
   // Only drivers with valid location_tracking_enabled AND location_updated_at should have coordinates
   try {
     const { offlineDB } = await import('./offlineDatabase');
     const allOfflineAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);

     if (allOfflineAppUsers && allOfflineAppUsers.length > 0) {
       // Find AppUsers with stale coordinates (have coords but no recent timestamp or location_tracking_enabled is false)
       const staleCoordsAppUsers = allOfflineAppUsers.filter(u => {
         if (!u.current_latitude || !u.current_longitude) return false; // No coords = OK

         // If they have coords, they must have:
         // 1. A recent location_updated_at timestamp (within last 30 minutes)
         // 2. location_tracking_enabled = true
         const hasRecentTimestamp = u.location_updated_at && 
           (Date.now() - new Date(u.location_updated_at).getTime()) < 30 * 60 * 1000;
         const locationSharingEnabled = u.location_tracking_enabled === true;

         // Stale if: has coords BUT no timestamp OR timestamp is old OR sharing disabled
         return !hasRecentTimestamp || !locationSharingEnabled;
       });

       if (staleCoordsAppUsers.length > 0) {
         console.log(`🧹 [Poller] Cleaning ${staleCoordsAppUsers.length} AppUsers with stale coordinates from offline DB`);

         // Clear coordinates from stale records
         for (const appUser of staleCoordsAppUsers) {
           await offlineDB.save(offlineDB.STORES.APP_USERS, {
             ...appUser,
             current_latitude: null,
             current_longitude: null,
             location_updated_at: null
           });
         }

         console.log(`✅ [Poller] Cleared stale coordinates from ${staleCoordsAppUsers.length} AppUsers`);
       }
     }
   } catch (cleanupError) {
     console.warn('⚠️ [Poller] Failed to clean stale coordinates from offline DB:', cleanupError.message);
   }

   // DEBUG: Log the drivers with coordinates and their settings
   appUsers.filter(u => u && u.current_latitude && u.current_longitude).forEach(u => {
     console.log(`🔍 [Driver Debug] ${u.user_name}:`, {
       driver_status: u.driver_status,
       location_tracking_enabled: u.location_tracking_enabled,
       location_updated_at: u.location_updated_at,
       lat: u.current_latitude?.toFixed(6),
       lng: u.current_longitude?.toFixed(6)
     });
   });

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
    
    // CRITICAL: Calculate staleness for each user (for visual indicators later)
    const currentTime = Date.now();
    users = users.map(user => {
      if (!user.location_updated_at) {
        return { ...user, _locationStale: true, _staleness: 'unknown' };
      }
      
      const lastUpdate = new Date(user.location_updated_at).getTime();
      const ageMs = currentTime - lastUpdate;
      const ageMinutes = Math.floor(ageMs / 60000);
      
      let staleness = 'fresh'; // 0-5 min
      if (ageMinutes > 30) staleness = 'very_stale'; // 30+ min
      else if (ageMinutes > 15) staleness = 'stale'; // 15-30 min
      else if (ageMinutes > 5) staleness = 'aging'; // 5-15 min
      
      return { ...user, _locationStale: ageMinutes > 5, _staleness: staleness, _ageMinutes: ageMinutes };
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
    
    const todayStr = new Date().toISOString().split('T')[0];

    // CRITICAL: Log if user is AppOwner for debugging
     const isUserAppOwner = isAppOwner(this.currentUser);
     console.log(`🔑 [Poller] Current user isAppOwner: ${isUserAppOwner}, role: ${this.currentUser?.role}, app_roles: ${this.currentUser?.app_roles?.join(', ')}`);

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
       // RULE 1: Own location marker - drivers on primary device DON'T see their own shared location
       // ========================================
       if (isSelf) {
         // Drivers on primary device have live location tracking - don't show shared location marker
         if (isDriver && !isDispatcher && !isAdmin) {
           console.log(`⏭️ [Poller] SELF marker BLOCKED - driver on primary device doesn't see own shared location`);
           return false;
         }
         console.log(`✅ [Poller] Including SELF marker (non-driver role)`, {
           userId: user.user_name,
           driver_status: user.driver_status
         });
         return true;
       }

       // ========================================
       // RULE 2: AppOwners - can see ALL drivers regardless of settings
       // ========================================
       // CRITICAL: Check AppOwner FIRST before any other checks
       if (isUserAppOwner) {
         // AppOwners see ALL drivers with coordinates in their city, no filtering
         console.log(`✅ [Poller] AppOwner seeing driver ${user.user_name} - city: ${user.city_id}, status: ${user.driver_status}, location_tracking: ${user.location_tracking_enabled}, staleness: ${user._staleness}`);
         return true;
       }

       // Skip inactive users
       if (user.status === 'inactive') return false;

       // Must be in same city (applies to all roles)
       if (currentUserCityId && user.city_id !== currentUserCityId) return false;

       // ========================================
       // RULE 3: Admins (non-AppOwners) - can only see drivers with location sharing ON
       // ========================================
       if (isAdmin && !isAppOwner(this.currentUser)) {
         // Admins require location_tracking_enabled to be true
         if (!user.location_tracking_enabled) return false;
         console.log(`✅ [Poller] Admin seeing driver ${user.user_name} - location_tracking: enabled, staleness: ${user._staleness}`);
         return true;
       }

       // ========================================
       // RULE 4: Dispatchers viewing assigned drivers
       // ========================================
       if (isDispatcher && !isDriver) {
         // 1. Driver must be On Duty
         if (user.driver_status !== 'on_duty') {
           console.log(`❌ [Poller] Dispatcher - driver ${user.user_name} not on_duty (status: ${user.driver_status})`);
           return false;
         }

         const dispatcherStoreIds = new Set(this.currentUser.store_ids || []);
         console.log(`🔍 [Poller] Dispatcher stores:`, Array.from(dispatcherStoreIds), `Driver: ${user.user_name}`);

         // 2. Driver must have at least 1 en_route OR in_transit delivery from dispatcher's stores (today)
         // Once all stops are complete/failed/cancelled, marker disappears
         const userIdForDeliveryMatch = user.id || user.user_id;
         const matchingDeliveries = (deliveries || []).filter(delivery => {
           if (!delivery) return false;
           if (delivery.driver_id !== userIdForDeliveryMatch && delivery.driver_id !== driverId) return false;
           if (delivery.delivery_date !== todayStr) return false;
           if (!dispatcherStoreIds.has(delivery.store_id)) return false;
           if (!(delivery.status === 'in_transit' || delivery.status === 'en_route')) return false;
           return true;
         });

         if (matchingDeliveries.length === 0) {
           const allDriverDeliveries = (deliveries || []).filter(d => d && (d.driver_id === userIdForDeliveryMatch || d.driver_id === driverId) && d.delivery_date === todayStr);
           console.log(`❌ [Poller] Dispatcher - driver ${user.user_name} has ${allDriverDeliveries.length} total deliveries today, 0 active (en_route/in_transit) from dispatcher stores`);
           return false;
         }

         console.log(`✅ [Poller] Dispatcher seeing driver ${user.user_name} - on_duty with ${matchingDeliveries.length} active deliveries, staleness: ${user._staleness}`);
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

         console.log(`✅ [Poller] Driver seeing other driver ${user.user_name} - location_tracking: enabled, staleness: ${user._staleness}`);
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
        _isOnBreak: isOnBreak && isSelf,
        _staleness: user._staleness || 'fresh',
        _ageMinutes: user._ageMinutes || 0
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