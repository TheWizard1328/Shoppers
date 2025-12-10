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
      return;
    }

    const now = Date.now();
    const maxStaleTime = 5 * 60 * 1000; // 5 minutes
    
    const isAdmin = this.currentUser && userHasRole(this.currentUser, 'admin');
    const currentUserCityId = this.currentUser?.city_id;
    const currentUserId = this.currentUser?.id;

    // Filter to drivers with on_duty or on_break status AND recent location data
    const activeDriversWithLocation = users.filter(user => {
      if (!user) return false;
      
      // Skip inactive users
      if (user.status === 'inactive') return false;
      
      // CRITICAL: Must be on_duty or on_break
      if (user.driver_status !== 'on_duty' && user.driver_status !== 'on_break') return false;
      
      // Skip if no valid coordinates
      if (!user.current_latitude || !user.current_longitude) return false;
      
      // Check if location data is too old
      if (user.location_updated_at) {
        const locationAge = now - new Date(user.location_updated_at).getTime();
        if (locationAge > maxStaleTime) return false;
      }
      
      // PERMISSION FILTERING:
      // 1. Always show current user's own location (green/orange dot on other devices)
      if (user.id === currentUserId) {
        return true;
      }
      
      // 2. Only show OTHER users if location_tracking_enabled is true (sharing is ON)
      if (user.location_tracking_enabled !== true) return false;
      
      // 3. Admins can see ALL shared locations
      if (isAdmin) {
        return true;
      }
      
      // 4. Non-admins can only see locations from users in the same city
      if (currentUserCityId && user.city_id === currentUserCityId) {
        return true;
      }
      
      return false;
    });

    // Check for location changes and notify subscribers
    let hasChanges = false;
    const newLocations = new Map();

    activeDriversWithLocation.forEach(user => {
      const locationKey = `${user.id}_${user.current_latitude}_${user.current_longitude}_${user.driver_status}`;
      newLocations.set(user.id, locationKey);

      const previousLocation = this.lastLocations.get(user.id);
      if (previousLocation !== locationKey) {
        console.log(`📍 [DriverLocationPoller] Location/status changed for ${user.user_name || user.full_name}`);
        hasChanges = true;
      }
    });

    // Check for removed drivers
    this.lastLocations.forEach((value, userId) => {
      if (!newLocations.has(userId)) {
        console.log(`📍 [DriverLocationPoller] Driver location no longer visible: ${userId}`);
        hasChanges = true;
      }
    });

    if (hasChanges) {
      this.lastLocations = newLocations;
      this.notifySubscribers(activeDriversWithLocation);
    }
  }

  notifySubscribers(activeDriversWithLocation) {
    // Convert array of users to array of location objects
    const locationObjects = activeDriversWithLocation.map(user => ({
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
      location_tracking_enabled: user.location_tracking_enabled
    }));

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