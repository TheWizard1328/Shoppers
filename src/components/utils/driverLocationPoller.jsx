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

    // CRITICAL: ALWAYS pull fresh data from API - don't use stale prop data at all
    let usersData = null;
    
    // CRITICAL: Use provided appUsers - don't make additional API calls to avoid rate limits
    usersData = appUsers;
    
    // If we still don't have data, skip processing
    if (!usersData || usersData.length === 0) {
      console.warn('⚠️ [DriverLocationPoller] No data available to process');
      return;
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
      // RULE 1: Own location marker - ALWAYS visible regardless of any status/toggle
      // ========================================
      if (isSelf) {
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
    // CRITICAL: Create unique key from location data to detect changes
    const currentKey = activeDriversWithLocation
      .map(u => `${u.id}:${u.location_updated_at}:${u.current_latitude},${u.current_longitude}`)
      .sort()
      .join('|');
    
    console.log(`🔍 [Poller] Notify check - currentKey: ${currentKey.substring(0, 100)}..., forceNotify: ${forceNotify}, lastKey: ${this._lastNotifiedKey?.substring(0, 100) || 'NONE'}...`);
    
    // Skip notification if data hasn't changed (prevents duplicate notifications)
    // BUT always notify on forceNotify to ensure fresh data propagates
    if (currentKey === this._lastNotifiedKey && !forceNotify) {
      console.log('⏭️ [Poller] Skipping notification - data unchanged and not forced');
      return;
    }
    
    this._lastNotifiedKey = currentKey;
    console.log(`📡 [Poller] SENDING NOTIFICATION with ${activeDriversWithLocation.length} drivers (forceNotify: ${forceNotify})`);
    
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

    // Notify callback subscribers
    this.subscribers.forEach(callback => {
      try {
        callback(locationObjects);
      } catch (error) {
        console.error('Error notifying driver location subscriber:', error);
      }
    });

    // CRITICAL: Also dispatch window event for markers component
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
        detail: { 
          appUsers: activeDriversWithLocation,
          forceAll: forceNotify
        }
      }));
      console.log(`📡 [Poller] Dispatched driverLocationsUpdated with ${activeDriversWithLocation.length} drivers (key: ${currentKey.substring(0, 50)}...)`);
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