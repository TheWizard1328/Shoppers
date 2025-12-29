import { userHasRole } from './userRoles';

class DriverLocationPoller {
  constructor() {
    this.pollingInterval = null;
    this.subscribers = new Set();
    this.lastLocations = new Map();
    this.isPolling = false;
    this.requestDataRefresh = null; // Callback to request data refresh from parent
    this.currentUser = null;
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

    console.log('🎯 [DriverLocationPoller] Initialized (no polling - using smartRefreshManager)');
  }

  stop() {
    this.isPolling = false;
    this.lastLocations.clear();
    console.log('🛑 [DriverLocationPoller] Stopped');
  }

  /**
   * Process incoming location data from parent component
   * Filters drivers based on sharing settings and user permissions
   * @param {Object} currentUser - Current authenticated user
   * @param {Array} deliveries - Array of delivery objects
   * @param {Array} drivers - Array of driver objects
   * @param {Array} stores - Array of store objects
   * @param {Array} appUsers - Array of AppUser objects with location data
   * @param {Date} selectedDate - Currently selected date
   */
  processLocationData(currentUser, deliveries, drivers, stores, appUsers, selectedDate) {
    // Update internal current user reference
    this.currentUser = currentUser;

    // Log incoming data count (reduced verbosity)
    if (appUsers?.length > 0) {
      console.log(`📍 [DriverLocationPoller] Processing ${appUsers.length} appUsers`);
    }

    // Determine if current device is mobile
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    const currentUserId = this.currentUser?.id;
    const currentUserUserId = this.currentUser?.user_id;
    
    // CRITICAL: Determine device type early
    const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    // CRITICAL: On desktop, ensure current user's AppUser is in the list for self-marker
    // On mobile, NEVER add self to the list (blue GPS dot shows instead)
    let users = Array.isArray(appUsers) ? [...appUsers] : [];
    
    if (!isMobileDevice && currentUser && currentUser.current_latitude && currentUser.current_longitude) {
      // Check if current user is already in the list
      const selfInList = users.some(u => 
        u && (u.user_id === currentUserId || u.id === currentUserId || 
              u.user_id === currentUserUserId || u.id === currentUserUserId)
      );
      
      if (!selfInList) {
        // Add current user to the list so they can see their own marker (DESKTOP ONLY)
        console.log('📍 [DriverLocationPoller] Adding current user to list for self-marker (desktop, off_duty)');
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
    // 1. Current user (self) on desktop: ALWAYS show (any status, any tracking setting)
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

      // RULE 1: Current user (self) - NEVER show on mobile (blue GPS dot shows instead)
      // Desktop: show own marker regardless of status/tracking
      if (isSelf) {
        if (isMobileDevice) {
          // Mobile: ALWAYS block self marker - blue GPS dot is shown by the map component
          return false;
        }
        // Desktop: always show own shared location marker regardless of status/tracking
        console.log('✅ [DriverLocationPoller] Including self marker on DESKTOP (status: ' + user.driver_status + ', tracking: ' + user.location_tracking_enabled + ')');
        return true;
      }

      // RULE 4: All other drivers must be in same city
      if (currentUserCityId && user.city_id !== currentUserCityId) {
        return false;
      }

      // CRITICAL: Check location_updated_at to ensure location exists
      if (!user.location_updated_at) {
        console.log(`🚫 [DriverLocationPoller] Hiding ${user.user_name} - no location_updated_at`);
        return false;
      }

      const locationAge = now - new Date(user.location_updated_at).getTime();

      // DEBUG: Log driver status for troubleshooting
      console.log(`🔍 [DriverLocationPoller] ${user.user_name} status check: driver_status=${user.driver_status}, location_tracking_enabled=${user.location_tracking_enabled}`);

      // RULE 3: Dispatcher special handling - check BEFORE location_tracking_enabled filter
      // CRITICAL: Dispatchers can see driver markers if driver is NOT off_duty
      // Location sharing setting is ignored for dispatchers - they always see active drivers
      if (isDispatcher && !isAdmin) {
        const dispatcherStoreIds = new Set(this.currentUser.store_ids || []);
        
        // For dispatchers: driver must have assigned stops (pickups OR deliveries) AND NOT be off_duty
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
        
        console.log(`🔍 [DriverLocationPoller] Dispatcher check for ${user.user_name}: hasAssignedStops=${hasAssignedStops}, status=${user.driver_status}, storeIds=${Array.from(dispatcherStoreIds).join(',')}`);
        
        if (!hasAssignedStops) {
          console.log(`🚫 [DriverLocationPoller] Hiding ${user.user_name} for dispatcher - no assigned stops for their stores`);
          return false;
        }
        
        // CRITICAL: Must NOT be explicitly off_duty (on_duty, on_break, online, or undefined all visible)
        // undefined status means driver_status field wasn't loaded - treat as potentially active
        if (user.driver_status === 'off_duty') {
          console.log(`🚫 [DriverLocationPoller] Hiding ${user.user_name} for dispatcher - driver is off_duty`);
          return false;
        }
        
        // CRITICAL: Show marker if driver has assigned stops and is NOT off_duty
        // This includes on_duty, on_break, online, AND undefined (data not yet loaded)
        console.log(`✅ [DriverLocationPoller] Showing ${user.user_name} to dispatcher (status: ${user.driver_status || 'undefined'}, sharing: ${user.location_tracking_enabled})`);
        return true;
      }

      // CRITICAL: For non-dispatchers, location_tracking_enabled MUST be true
      // This prevents showing markers when sharing is turned off
      if (user.location_tracking_enabled !== true) {
        console.log(`🚫 [DriverLocationPoller] Hiding ${user.user_name} - location sharing is OFF`);
        return false;
      }
      
      // RULE 2: For other users (admin or driver viewing other drivers)
      // Must be on_duty or on_break AND location_tracking_enabled = true
      if (user.driver_status !== 'on_duty' && user.driver_status !== 'on_break') return false;

      // Admin: show all on_duty/on_break drivers with sharing enabled
      if (isAdmin) return true;

      // Driver (non-dispatcher): show other drivers in same city with sharing enabled
      if (isDriver && !isDispatcher) return true;

      return false;
    });
    
    console.log(`📍 [DriverLocationPoller] Found ${activeDriversWithLocation.length} active drivers with location`);

    // CRITICAL: ALWAYS notify subscribers with current locations to prevent disappearing markers
    // Don't check for changes - just broadcast the current state every time
    console.log(`📍 [DriverLocationPoller] Broadcasting ${activeDriversWithLocation.length} driver locations`);
    
    const newLocations = new Map();
    activeDriversWithLocation.forEach(user => {
      const locationKey = `${user.id}_${user.current_latitude}_${user.current_longitude}_${user.driver_status}`;
      newLocations.set(user.id, locationKey);
    });
    
    this.lastLocations = newLocations;
    this.notifySubscribers(activeDriversWithLocation);
  }

  notifySubscribers(activeDriversWithLocation) {
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
        _isSelf: isSelf, // Flag to identify own marker
        _isOnBreak: isOnBreak && isSelf // Special flag for styling own marker when on break
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
    console.log(`✅ [DriverLocationPoller] New subscriber added (total: ${this.subscribers.size})`);

    // Return unsubscribe function
    return () => {
      this.subscribers.delete(callback);
      console.log(`🗑️ [DriverLocationPoller] Subscriber removed (total: ${this.subscribers.size})`);
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