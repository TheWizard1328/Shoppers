import { userHasRole } from './userRoles';

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
   * @param {Object} currentUser - Current authenticated user
   * @param {Array} deliveries - Array of delivery objects
   * @param {Array} drivers - Array of driver objects
   * @param {Array} stores - Array of store objects
   * @param {Array} appUsers - Array of AppUser objects with location data (fallback if offline DB fails)
   * @param {Date} selectedDate - Currently selected date
   */
  async processLocationData(currentUser, deliveries, drivers, stores, appUsers, selectedDate, forceNotify = false) {
    // Skip processing if paused (e.g., during imports)
    if (this.isPaused) {
      return;
    }

    // Update internal current user reference
    this.currentUser = currentUser;
    
    // CRITICAL: Load appUsers from offline DB first to prevent rate limiting
    let usersData = appUsers;
    try {
      const { offlineDB } = await import('./offlineDatabase');
      const offlineAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
      
      if (offlineAppUsers && offlineAppUsers.length > 0) {
        console.log(`📦 [DriverLocationPoller] Loaded ${offlineAppUsers.length} AppUsers from offline DB`);
        usersData = offlineAppUsers;
      } else {
        console.log(`📡 [DriverLocationPoller] Using ${appUsers?.length || 0} AppUsers from props (offline DB empty)`);
      }
    } catch (offlineError) {
      console.warn('⚠️ [DriverLocationPoller] Failed to load from offline DB, using props:', offlineError.message);
    }

    // Log incoming data count (reduced verbosity)
    if (usersData?.length > 0) {
      console.log(`📍 [DriverLocationPoller] Processing ${usersData.length} appUsers (force: ${forceNotify})`);
    }

    // Determine if current device is mobile
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    const currentUserId = this.currentUser?.id;
    const currentUserUserId = this.currentUser?.user_id;
    
    // CRITICAL: Determine device type early
    const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    // CRITICAL: On desktop, ensure current user's AppUser is in the list for self-marker
    // On mobile, NEVER add self to the list (blue GPS dot shows instead)
    let users = Array.isArray(usersData) ? [...usersData] : [];
    
    if (!isMobileDevice && currentUser && currentUser.current_latitude && currentUser.current_longitude) {
      // Check if current user is already in the list
      const selfInList = users.some(u => 
        u && (u.user_id === currentUserId || u.id === currentUserId || 
              u.user_id === currentUserUserId || u.id === currentUserUserId)
      );
      
      if (!selfInList) {
        // Add current user to the list so they can see their own marker (DESKTOP ONLY)
        console.log('📍 [DriverLocationPoller] Adding current user to list for self-marker (desktop)');
        users.push({
          id: currentUser.id,
          user_id: currentUser.user_id || currentUser.id,
          user_name: currentUser.user_name || currentUser.full_name,
          current_latitude: currentUser.current_latitude,
          current_longitude: currentUser.current_longitude,
          location_updated_at: currentUser.location_updated_at,
          driver_status: currentUser.driver_status,
          location_tracking_enabled: currentUser.location_tracking_enabled,
          status: currentUser.status,
          city_id: currentUser.city_id
        });
      }
    }
    
    if (users.length === 0) {
      // CRITICAL: Still notify subscribers with empty array to clear markers
      this.notifySubscribers([]);
      return;
    }

    const now = Date.now();
    const maxStaleTime = 5 * 60 * 1000; // 5 minutes
    const thirtyMinutesInMs = 30 * 60 * 1000;
    
    const isAdmin = this.currentUser && userHasRole(this.currentUser, 'admin');
    const isDispatcher = this.currentUser && userHasRole(this.currentUser, 'dispatcher');
    const isDriver = this.currentUser && userHasRole(this.currentUser, 'driver');
    const currentUserCityId = this.currentUser?.city_id;
    
    const todayStr = new Date().toISOString().split('T')[0];

    // CRITICAL: Filter to drivers with location data using the new rules
    // RULES:
    // 1. Current user (self): ALWAYS show on desktop (any status, any tracking setting)
    // 2. Other drivers: on_duty OR on_break, location_tracking_enabled = true, location_updated_at recent
    // 3. Dispatchers: drivers with assigned stops, on_duty OR on_break, location_tracking_enabled = true
    // 4. All must be in same city
    const activeDriversWithLocation = users.filter(user => {
      if (!user) return false;

      const driverId = user.id || user.user_id;
      const isSelf = user.user_id === currentUserId || 
                     user.id === currentUserId || 
                     user.user_id === currentUserUserId ||
                     user.id === currentUserUserId;

      // Skip inactive users (but NOT for self - driver should see own marker even if inactive)
      if (user.status === 'inactive' && !isSelf) return false;

      // Skip if no valid coordinates
      if (!user.current_latitude || !user.current_longitude) return false;

      // CRITICAL: Current user (self) - ALWAYS show regardless of driver_status or location_tracking_enabled
      // This allows the user to see their shared location from any device
      // DriverLocationMarkers will handle blocking on mobile to prevent overlap with GPS dot
      if (isSelf) {
        console.log(`✅ [DriverLocationPoller] Including self marker - status: ${user.driver_status}, tracking: ${user.location_tracking_enabled}`);
        return true;
      }

      // RULE 4: All other drivers must be in same city
      if (currentUserCityId && user.city_id !== currentUserCityId) {
        return false;
      }

      // CRITICAL: Check location_updated_at to ensure location exists
      if (!user.location_updated_at) {
        return false;
      }

      const locationAge = now - new Date(user.location_updated_at).getTime();

      // DEBUG: Log driver status for troubleshooting

      // RULE 3: Dispatcher special handling - check BEFORE location_tracking_enabled filter
      // CRITICAL: Dispatchers see driver markers when driver has assigned stops AND (on_duty OR on_break)
      if (isDispatcher && !isAdmin && !isDriver) {
        const dispatcherStoreIds = new Set(this.currentUser.store_ids || []);
        
        // For dispatchers: driver must have assigned stops (pickups OR deliveries)
        // Check if driver has ANY active stops for dispatcher's stores
        const hasAssignedStops = (deliveries || []).some(delivery => {
          if (!delivery) return false;
          if (delivery.driver_id !== driverId) return false;
          if (delivery.delivery_date !== todayStr) return false;
          if (!dispatcherStoreIds.has(delivery.store_id)) return false;
          // Include all non-terminal statuses (pending, en_route, in_transit)
          if (['completed', 'failed', 'cancelled', 'returned'].includes(delivery.status)) return false;
          return true;
        });
        
        if (!hasAssignedStops) {
          console.log(`🚫 [DriverLocationPoller] Dispatcher: driver ${user.user_name} has no active stops in assigned stores`);
          return false;
        }
        
        // CRITICAL: Dispatchers see shared location marker when driver is on_duty OR on_break
        // off_duty = show nothing
        if (user.driver_status !== 'on_duty' && user.driver_status !== 'on_break') {
          console.log(`🚫 [DriverLocationPoller] Dispatcher: driver ${user.user_name} is ${user.driver_status}, not on_duty/on_break`);
          return false;
        }
        
        // CRITICAL: For dispatchers, also check that location_tracking_enabled is true
        if (user.location_tracking_enabled !== true) {
          console.log(`🚫 [DriverLocationPoller] Dispatcher: driver ${user.user_name} has location_tracking_enabled = ${user.location_tracking_enabled}`);
          return false;
        }
        
        // Driver is on_duty/on_break with assigned stops and sharing enabled - show shared location marker
        console.log(`✅ [DriverLocationPoller] Dispatcher: showing driver ${user.user_name} - ${user.driver_status} with active stops`);
        return true;
      }

      // CRITICAL: For non-dispatchers, location_tracking_enabled MUST be true
      // This prevents showing markers when sharing is turned off
      if (user.location_tracking_enabled !== true) {
        console.log(`🚫 [DriverLocationPoller] ${user.user_name} - tracking disabled (${user.location_tracking_enabled})`);
        return false;
      }
      
      // RULE 2: For other users (admin or driver viewing other drivers)
      // Must be on_duty or on_break AND location_tracking_enabled = true
      if (user.driver_status !== 'on_duty' && user.driver_status !== 'on_break') {
        console.log(`🚫 [DriverLocationPoller] ${user.user_name} - not on duty/break (${user.driver_status})`);
        return false;
      }

      // Admin: show all on_duty/on_break drivers with sharing enabled
      if (isAdmin) {
        console.log(`✅ [DriverLocationPoller] ${user.user_name} - admin view (${user.driver_status})`);
        return true;
      }

      // Driver (non-dispatcher): show other drivers in same city with sharing enabled
      if (isDriver && !isDispatcher) {
        console.log(`✅ [DriverLocationPoller] ${user.user_name} - driver view (${user.driver_status})`);
        return true;
      }

      console.log(`🚫 [DriverLocationPoller] ${user.user_name} - no permission match`);
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
    // Convert array of users to array of location objects
    const currentUserId = this.currentUser?.id;
    const currentUserUserId = this.currentUser?.user_id;

    const locationObjects = activeDriversWithLocation.map(user => {
      const isSelf = user.user_id === currentUserId || 
                     user.id === currentUserId ||
                     user.user_id === currentUserUserId ||
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

    // CRITICAL: ALWAYS notify to prevent disappearing markers
    // The deduplication check was causing markers to disappear
    console.log(`📢 [DriverLocationPoller] Notifying subscribers - ${locationObjects.length} locations`);

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