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
    
    const users = appUsers;
    if (!Array.isArray(users) || users.length === 0) {
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
    const currentUserId = this.currentUser?.id;
    const currentUserUserId = this.currentUser?.user_id;
    
    // Determine if current device is mobile
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    const todayStr = new Date().toISOString().split('T')[0];

    // CRITICAL: Filter to drivers with location data
    const activeDriversWithLocation = users.filter(user => {
      if (!user) return false;

      // Skip inactive users
      if (user.status === 'inactive') return false;

      // Only show on_duty or on_break drivers
      if (user.driver_status !== 'on_duty' && user.driver_status !== 'on_break') return false;

      // Skip if no valid coordinates
      if (!user.current_latitude || !user.current_longitude) return false;

      const driverId = user.id || user.user_id;
      const isSelf = user.user_id === currentUserId || 
                     user.id === currentUserId || 
                     user.user_id === currentUserUserId ||
                     user.id === currentUserUserId;

      // Location tracking must be enabled (unless it's your own marker)
      if (user.location_tracking_enabled !== true && !isSelf) return false;

      // Check staleness and idle status
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

      // ROLE-BASED PERMISSION FILTERING:
      
      // 1. Admins see all on_duty/on_break drivers in selected city
      if (isAdmin) {
        return true;
      }
      
      // 2. Dispatchers see drivers with en_route/in_transit/pending deliveries for their stores
      if (isDispatcher && !isAdmin) {
        const dispatcherStoreIds = new Set(this.currentUser.store_ids || []);
        const hasActiveDelivery = (deliveries || []).some(delivery =>
          delivery &&
          delivery.driver_id === driverId &&
          delivery.delivery_date === todayStr &&
          dispatcherStoreIds.has(delivery.store_id) &&
          ['en_route', 'in_transit', 'pending'].includes(delivery.status)
        );
        
        if (!hasActiveDelivery) {
          return false;
        }
        return true;
      }
      
      // 3. Drivers on mobile see all drivers in same city (excluding self - blue dot shows instead)
      if (isDriver && isMobile) {
        if (isSelf) {
          return false; // Skip self on mobile - blue GPS dot shows instead
        }
        // Show other drivers in same city
        return currentUserCityId && user.city_id === currentUserCityId;
      }
      
      // 4. Drivers on desktop see all drivers in same city (including self)
      if (isDriver && !isMobile) {
        return currentUserCityId && user.city_id === currentUserCityId;
      }
      
      // 5. Admin/Drivers on mobile - skip self
      if (isAdmin && isDriver && isMobile && isSelf) {
        return false;
      }
      
      // 6. Admin/Drivers on desktop - show self
      if (isAdmin && isDriver && !isMobile) {
        return currentUserCityId && user.city_id === currentUserCityId;
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