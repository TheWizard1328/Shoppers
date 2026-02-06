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

    // CRITICAL: Skip processing location data if not on Dashboard or viewing past date
    if (currentPageName && selectedDate) {
      const todayStr = new Date().toISOString().split('T')[0];
      const selectedDateStr = selectedDate instanceof Date 
        ? selectedDate.toISOString().split('T')[0]
        : selectedDate;

      if (currentPageName !== 'Dashboard' || selectedDateStr !== todayStr) {
        console.log(`⏭️ [DriverLocationPoller] Skipping location processing - not on Dashboard today (page: ${currentPageName}, date: ${selectedDateStr})`);
        return;
      }
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
    
    let users = Array.isArray(usersData) ? [...usersData] : [];
    
    if (users.length === 0) {
      // CRITICAL: Still notify subscribers with empty array to clear markers
      this.notifySubscribers([]);
      return;
    }

    const now = Date.now();
    const maxStaleTime = 5 * 60 * 1000; // 5 minutes - hide marker if no updates
    const thirtyMinutesInMs = 30 * 60 * 1000;
    
    const isAdmin = this.currentUser && userHasRole(this.currentUser, 'admin');
    const isDispatcher = this.currentUser && userHasRole(this.currentUser, 'dispatcher');
    const isDriver = this.currentUser && userHasRole(this.currentUser, 'driver');
    const currentUserCityId = this.currentUser?.city_id;
    
    const todayStr = new Date().toISOString().split('T')[0];

    // CRITICAL: Filter drivers based on NEW visibility rules
    const activeDriversWithLocation = users.filter(user => {
      if (!user) return false;

      const driverId = user.id || user.user_id;
      const isSelf = user.user_id === currentUserId || 
                     user.id === currentUserId || 
                     user.user_id === currentUserUserId ||
                     user.id === currentUserUserId;

      // Skip if no valid coordinates
      if (!user.current_latitude || !user.current_longitude) return false;

      // CRITICAL: 5-minute inactivity rule - applies to ALL markers (including own)
      if (user.location_updated_at) {
        const locationAge = now - new Date(user.location_updated_at).getTime();
        if (locationAge > maxStaleTime) {
          console.log(`⏰ [DriverLocationPoller] ${user.user_name} - location stale (${Math.floor(locationAge/60000)} min)`);
          return false;
        }
      } else {
        // No timestamp - hide marker
        return false;
      }

      // ========================================
      // RULE 1: Own location marker - always visible (except on current mobile device with active GPS)
      // ========================================
      if (isSelf) {
        // Skip inactive check for self - always show own marker if active location exists
        // EXCEPTION: On mobile, hide shared marker ONLY if THIS device is actively tracking GPS
        // Use locationTracker.isTracking to detect if GPS is running on THIS specific device
        const isTrackingOnThisDevice = locationTracker.isTracking === true;
        
        if (isMobileDevice && isTrackingOnThisDevice) {
          console.log(`🚫 [DriverLocationPoller] Hiding self marker - GPS actively tracking on THIS device (blue dot shows)`);
          return false;
        }
        
        // Show own marker on all other devices OR if GPS is not actively running
        console.log(`✅ [DriverLocationPoller] Showing self marker - other device or GPS inactive (status: ${user.driver_status})`);
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
          console.log(`🚫 [DriverLocationPoller] Dispatcher: driver ${user.user_name} has no deliveries from dispatcher stores`);
          return false;
        }

        // Dispatchers ALWAYS see their assigned drivers' markers
        // Regardless of driver_status, location_tracking_enabled, or showAllDrivers mode
        console.log(`✅ [DriverLocationPoller] Dispatcher: showing driver ${user.user_name} (has deliveries from dispatcher stores)`);
        return true;
      }

      // ========================================
      // RULE 3: Admins and Drivers viewing other drivers
      // ========================================

      // CRITICAL: Must be in "show all" or "all drivers" mode
      if (!showAllDrivers) {
        console.log(`🚫 [DriverLocationPoller] ${user.user_name} - not in show all/all drivers mode`);
        return false;
      }

      // Must be on_duty or on_break
      if (user.driver_status !== 'on_duty' && user.driver_status !== 'on_break') {
        console.log(`🚫 [DriverLocationPoller] ${user.user_name} - not on duty/break (${user.driver_status})`);
        return false;
      }

      // For non-admin drivers, must have location_tracking_enabled = true
      // Admins bypass this check (admin override)
      if (!isAdmin && user.location_tracking_enabled !== true) {
        console.log(`🚫 [DriverLocationPoller] ${user.user_name} - tracking disabled (driver viewing)`);
        return false;
      }

      // Show marker for admin or driver in show all/all drivers mode
      console.log(`✅ [DriverLocationPoller] ${user.user_name} - visible to ${isAdmin ? 'admin' : 'driver'} (show all mode)`);
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