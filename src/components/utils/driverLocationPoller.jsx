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
    
    // Determine if current device is mobile
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    const currentUserId = this.currentUser?.id;
    const currentUserUserId = this.currentUser?.user_id;
    
    // CRITICAL: On desktop, ensure current user's AppUser is in the list for self-marker
    // This handles the case where user is off_duty and not in the filtered appUsers
    let users = Array.isArray(appUsers) ? [...appUsers] : [];
    
    if (!isMobile && currentUser && currentUser.current_latitude && currentUser.current_longitude) {
      // Check if current user is already in the list
      const selfInList = users.some(u => 
        u && (u.user_id === currentUserId || u.id === currentUserId || 
              u.user_id === currentUserUserId || u.id === currentUserUserId)
      );
      
      if (!selfInList) {
        // Add current user to the list so they can see their own marker
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
    const activeDriversWithLocation = users.filter(user => {
      if (!user) return false;

      // Skip inactive users (but NOT for self - driver should see own marker even if inactive)
      const driverId = user.id || user.user_id;
      const isSelf = user.user_id === currentUserId || 
                     user.id === currentUserId || 
                     user.user_id === currentUserUserId ||
                     user.id === currentUserUserId;
      
      if (user.status === 'inactive' && !isSelf) return false;

      // Skip if no valid coordinates
      if (!user.current_latitude || !user.current_longitude) return false;

      // CRITICAL: ALWAYS show own marker on desktop (even if off_duty or tracking disabled)
      // On mobile, the blue GPS dot shows instead, so skip self marker there
      if (isSelf) {
        // Desktop: always show own shared location marker
        if (!isMobile) {
          console.log('📍 [DriverLocationPoller] Including self marker on desktop');
          return true;
        }
        // Mobile: skip self marker (blue GPS dot shows instead)
        return false;
      }

      // For OTHER drivers: require on_duty or on_break status
      if (user.driver_status !== 'on_duty' && user.driver_status !== 'on_break') return false;

      // Location tracking must be enabled for other drivers
      if (user.location_tracking_enabled !== true) return false;

      // Check staleness and idle status for other drivers
      let locationAge = 0;
      if (user.location_updated_at) {
        locationAge = now - new Date(user.location_updated_at).getTime();
        
        // Hide marker if location is >30 min old and driver has no active stops today
        if (locationAge > thirtyMinutesInMs) {
          const driverActiveStops = (deliveries || []).filter(d => 
            d && 
            d.driver_id === driverId && 
            d.delivery_date === todayStr &&
            !['completed', 'failed', 'cancelled', 'returned'].includes(d.status)
          );
          
          if (driverActiveStops.length === 0) {
            return false;
          }
        }
      }

      // NEW FILTERING RULES FOR OTHER DRIVERS
      
      // Admin: show all other drivers
      if (isAdmin) return true;
      
      // Driver: show other drivers in same city
      if (isDriver) {
        return currentUserCityId && user.city_id === currentUserCityId;
      }
      
      // Dispatcher: show active drivers with assigned deliveries
      if (isDispatcher) {
        const dispatcherStoreIds = new Set(this.currentUser.store_ids || []);
        const hasActiveDelivery = (deliveries || []).some(delivery =>
          delivery &&
          delivery.driver_id === driverId &&
          delivery.delivery_date === todayStr &&
          dispatcherStoreIds.has(delivery.store_id) &&
          ['en_route', 'in_transit', 'pending'].includes(delivery.status)
        );
        
        return hasActiveDelivery;
      }

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