import { base44 } from '@/api/base44Client';
import { isMobileDevice as checkIsMobileDevice } from './deviceUtils';
import { getRouteOptimizationSettings } from '../dashboard/RouteOptimizationSettings';

class LocationTracker {
  constructor() {
    this.watchId = null;
    this.isTracking = false;
    this.lastPosition = null;
    this.lastUpdate = 0;
    this.lastCoordinateUpdate = 0; // NEW: Track coordinate updates separately
    this.currentUser = null;
    this.appUserId = null;
    this.driverStatus = 'off_duty'; // Track driver duty status
    this.updateInterval = 30000; // 30 seconds heartbeat (can be overridden by settings)
    this.coordinateUpdateInterval = 300000; // 5 minutes max without coordinate update
    this.minDistanceChange = 50; // meters (can be overridden by settings)
    this.failedUpdateCount = 0;
    this.maxFailedUpdates = 3;
    this.backoffTime = 0;
    this.lastSuccessfulUpdate = 0;
    this.deviceCapabilities = null;
    
    // Load settings from RouteOptimizationSettings
    this.loadSettings();
  }

  /**
   * Load tracking settings from RouteOptimizationSettings
   */
  loadSettings() {
    try {
      const settings = getRouteOptimizationSettings();
      if (settings.locationUpdateIntervalSeconds) {
        this.updateInterval = settings.locationUpdateIntervalSeconds * 1000;
      }
      if (settings.minMovementDistanceMeters) {
        this.minDistanceChange = settings.minMovementDistanceMeters;
      }
      console.log(`📍 LocationTracker settings loaded: interval=${this.updateInterval}ms, minDistance=${this.minDistanceChange}m`);
    } catch (error) {
      console.warn('⚠️ Could not load route optimization settings, using defaults');
    }
  }

  /**
   * Set driver duty status - controls whether tracking is active
   */
  setDriverStatus(status) {
    const previousStatus = this.driverStatus;
    this.driverStatus = status;
    console.log(`🔄 Driver status changed: ${previousStatus} -> ${status}`);
    
    // If going off duty or on break, stop tracking
    if (status !== 'on_duty' && this.isTracking) {
      console.log('🛑 Stopping tracking due to status change');
      this.stopTracking();
    }
    
    return status === 'on_duty';
  }

  /**
   * Check if tracking should be active based on driver status
   */
  shouldTrack() {
    return this.driverStatus === 'on_duty';
  }

  /**
   * Enhanced mobile device detection using centralized utility
   * Returns true only if device is a true mobile device (phone/tablet with mobile OS)
   */
  isMobileDevice() {
    return checkIsMobileDevice();
  }

  /**
   * Check if device has GPS capabilities with high accuracy
   * This requires geolocation permission, so it's checked during tracking start
   */
  async checkGPSCapabilities() {
    if (this.deviceCapabilities !== null) {
      return this.deviceCapabilities;
    }

    if (!navigator.geolocation) {
      console.log('❌ No geolocation API available');
      this.deviceCapabilities = {
        hasGeolocation: false,
        hasHighAccuracy: false,
        error: 'Geolocation API not available'
      };
      return this.deviceCapabilities;
    }

    return new Promise((resolve) => {
      console.log('🔍 Testing GPS capabilities...');
      
      const timeoutId = setTimeout(() => {
        console.log('⏱️ GPS capability test timed out');
        this.deviceCapabilities = {
          hasGeolocation: true,
          hasHighAccuracy: false,
          error: 'GPS test timed out'
        };
        resolve(this.deviceCapabilities);
      }, 5000); // 5 second timeout

      navigator.geolocation.getCurrentPosition(
        (position) => {
          clearTimeout(timeoutId);
          const accuracy = position.coords.accuracy;
          const hasHighAccuracy = accuracy && accuracy < 100; // < 100m is considered "high accuracy"
          
          console.log(`✅ GPS capabilities detected: accuracy ${accuracy?.toFixed(1)}m`);
          
          this.deviceCapabilities = {
            hasGeolocation: true,
            hasHighAccuracy: hasHighAccuracy,
            accuracy: accuracy,
            error: null
          };
          resolve(this.deviceCapabilities);
        },
        (error) => {
          clearTimeout(timeoutId);
          console.log('❌ GPS capability test failed:', error.message);
          
          this.deviceCapabilities = {
            hasGeolocation: true,
            hasHighAccuracy: false,
            error: error.message
          };
          resolve(this.deviceCapabilities);
        },
        {
          enableHighAccuracy: true,
          timeout: 5000,
          maximumAge: 0
        }
      );
    });
  }

  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) *
      Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  async updateLocationInDatabase(latitude, longitude, accuracy) {
    const now = Date.now();
    
    // Check if driver is on duty - if not, don't update
    if (!this.shouldTrack()) {
      console.log('⏭️ Skipping location update - driver not on duty');
      return;
    }
    
    // Check if we're in backoff period
    if (this.backoffTime > 0 && (now - this.lastUpdate) < this.backoffTime) {
      console.log(`⏳ In backoff period, skipping update. Next update in ${Math.round((this.backoffTime - (now - this.lastUpdate)) / 1000)}s`);
      return;
    }

    // Check if enough time has passed since last heartbeat update
    if (now - this.lastUpdate < this.updateInterval) {
      console.log('⏭️ Skipping heartbeat update - too soon since last update');
      return;
    }

    // Determine if we should update coordinates (not just timestamp)
    let shouldUpdateCoordinates = false;
    let distance = 0;

    if (this.lastPosition) {
      distance = this.calculateDistance(
        this.lastPosition.latitude,
        this.lastPosition.longitude,
        latitude,
        longitude
      );

      // Update coordinates if: significant movement OR 5 minutes since last coordinate update
      const timeSinceCoordinateUpdate = now - this.lastCoordinateUpdate;
      shouldUpdateCoordinates = distance >= this.minDistanceChange || timeSinceCoordinateUpdate >= this.coordinateUpdateInterval;
      
      if (!shouldUpdateCoordinates) {
        console.log(`📍 Heartbeat update only - movement ${distance.toFixed(1)}m < ${this.minDistanceChange}m and ${Math.round(timeSinceCoordinateUpdate / 1000)}s < ${this.coordinateUpdateInterval / 1000}s`);
      } else {
        console.log(`📍 Coordinate update - movement ${distance.toFixed(1)}m or time ${Math.round(timeSinceCoordinateUpdate / 1000)}s`);
      }
    } else {
      // First update - always update coordinates
      shouldUpdateCoordinates = true;
    }

    try {
      // Check if online before attempting update
      if (!navigator.onLine) {
        console.warn('⚠️ Device is offline, skipping location update');
        return;
      }

      // CRITICAL: Ensure we have AppUser ID
      if (!this.appUserId) {
        console.error('❌ No AppUser ID available, cannot update location');
        return;
      }

      console.log(`📤 Updating location in database (${shouldUpdateCoordinates ? 'coordinates + timestamp' : 'timestamp only'})...`);
      
      // Build update object
      const updateData = {
        location_updated_at: new Date().toISOString() // Always update timestamp for heartbeat
      };

      // Only update coordinates if movement threshold met or timeout reached
      if (shouldUpdateCoordinates) {
        updateData.current_latitude = latitude;
        updateData.current_longitude = longitude;
        this.lastCoordinateUpdate = now;
      }
      
      // Update AppUser entity
      await base44.entities.AppUser.update(this.appUserId, updateData);

      this.lastUpdate = now;
      this.lastSuccessfulUpdate = now;
      
      // Always update lastPosition to have the latest GPS reading for distance calculations
      this.lastPosition = { latitude, longitude, accuracy };
      
      this.failedUpdateCount = 0;
      this.backoffTime = 0; // Reset backoff on success

      console.log(`✅ Location ${shouldUpdateCoordinates ? 'coordinates and timestamp' : 'timestamp'} updated successfully in AppUser database`);

      window.dispatchEvent(new CustomEvent('driverLocationUpdated', {
        detail: {
          userId: this.currentUser?.id,
          latitude,
          longitude,
          accuracy,
          timestamp: now,
          isRealtime: true,
          isCoordinateUpdate: shouldUpdateCoordinates
        }
      }));

    } catch (error) {
      this.failedUpdateCount++;
      console.error(`❌ Failed to update location (attempt ${this.failedUpdateCount}/${this.maxFailedUpdates}):`, error);

      // Implement exponential backoff
      if (error.response?.status === 429 || error.message?.includes('429') || error.message?.includes('Rate limit')) {
        this.backoffTime = Math.min(60000 * Math.pow(2, this.failedUpdateCount), 300000); // Max 5 min
        console.warn(`⏰ Rate limited. Backing off for ${this.backoffTime / 1000}s`);
      } else if (error.message?.includes('Network Error') || !navigator.onLine) {
        this.backoffTime = 30000; // 30 second backoff for network errors
        console.warn(`🔌 Network error. Backing off for ${this.backoffTime / 1000}s`);
      } else {
        this.backoffTime = 10000; // 10 second backoff for other errors
      }

      // If too many failures, stop tracking
      if (this.failedUpdateCount >= this.maxFailedUpdates) {
        console.error('❌ Too many failed updates, stopping location tracking');
        this.stopTracking();
        
        // Update database to reflect stopped tracking
        try {
          if (this.appUserId) {
            await base44.entities.AppUser.update(this.appUserId, {
              location_tracking_enabled: false,
              current_latitude: null,
              current_longitude: null,
              location_updated_at: null
            });
          }
        } catch (dbError) {
          console.error('Failed to update database after tracking failure:', dbError);
        }
        
        window.dispatchEvent(new CustomEvent('locationTrackingError', {
          detail: {
            message: 'Location updates failed multiple times. Tracking has been stopped.',
            error: error.message
          }
        }));
      }
    }
  }

  handleLocationSuccess(position) {
    const { latitude, longitude, accuracy } = position.coords;
    
    console.log(`📍 Location obtained: ${latitude.toFixed(6)}, ${longitude.toFixed(6)} (±${accuracy?.toFixed(1)}m)`);

    this.updateLocationInDatabase(latitude, longitude, accuracy);
  }

  handleLocationError(error) {
    console.error('❌ Location error:', error);

    let errorMessage = 'Unknown location error';
    switch (error.code) {
      case error.PERMISSION_DENIED:
        errorMessage = 'Location permission denied. Please enable location access in your browser settings.';
        this.stopTracking();
        break;
      case error.POSITION_UNAVAILABLE:
        errorMessage = 'Location information unavailable. Please check your device GPS.';
        break;
      case error.TIMEOUT:
        errorMessage = 'Location request timed out. Retrying...';
        break;
    }

    window.dispatchEvent(new CustomEvent('locationTrackingError', {
      detail: { message: errorMessage, code: error.code }
    }));

    return { success: false, message: errorMessage, code: error.code };
  }

  async startTracking(user) {
    if (!user) {
      throw new Error('User is required to start tracking');
    }

    if (!this.isMobileDevice()) {
      throw new Error('Location tracking is only available on mobile devices (phones/tablets)');
    }

    if (this.isTracking) {
      console.log('⚠️ Already tracking location');
      return;
    }

    if (!navigator.geolocation) {
      throw new Error('Geolocation is not supported by this browser');
    }

    // Check if online
    if (!navigator.onLine) {
      throw new Error('Device is offline. Please check your internet connection.');
    }

    this.currentUser = user;
    
    // Get or find AppUser ID
    if (user.appUserId) {
      this.appUserId = user.appUserId;
      console.log('✅ Using appUserId from user object:', this.appUserId);
    } else {
      // Try to find AppUser record
      try {
        const appUsers = await base44.entities.AppUser.filter({ user_id: user.id });
        if (appUsers && appUsers.length > 0) {
          this.appUserId = appUsers[0].id;
          console.log('✅ Found AppUser ID:', this.appUserId);
        } else {
          console.error('❌ No AppUser record found for user:', user.id);
          throw new Error('User profile not properly configured. Please contact support.');
        }
      } catch (error) {
        console.error('❌ Failed to fetch AppUser:', error);
        throw new Error('Failed to load user profile. Please try again.');
      }
    }
    
    this.failedUpdateCount = 0;
    this.backoffTime = 0;
    this.lastCoordinateUpdate = 0; // Reset coordinate update timer

    // Test GPS capabilities
    const capabilities = await this.checkGPSCapabilities();
    if (!capabilities.hasGeolocation) {
      throw new Error('GPS is not available on this device');
    }
    
    if (!capabilities.hasHighAccuracy) {
      console.warn('⚠️ GPS accuracy may be limited on this device');
    }

    return new Promise((resolve, reject) => {
      console.log('🎯 Starting watchPosition...');
      
      this.watchId = navigator.geolocation.watchPosition(
        (position) => {
          console.log('✅ watchPosition success callback triggered');
          this.handleLocationSuccess(position);
          
          if (!this.isTracking) {
            this.isTracking = true;
            console.log('✅ First location acquired, tracking now active');
            resolve();
          }
        },
        (error) => {
          console.error('❌ watchPosition error callback triggered:', error);
          const result = this.handleLocationError(error);
          
          if (!this.isTracking) {
            reject(result);
          }
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0
        }
      );

      console.log('🎯 watchPosition registered with ID:', this.watchId);
    });
  }

  stopTracking() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      console.log('🛑 Cleared watch ID:', this.watchId);
      this.watchId = null;
    }
    this.isTracking = false;
    this.lastPosition = null;
    this.lastUpdate = 0;
    this.lastCoordinateUpdate = 0;
    this.currentUser = null;
    this.appUserId = null;
    this.failedUpdateCount = 0;
    this.backoffTime = 0;
    
    console.log('🛑 Location tracking stopped');
  }

  async restartTracking(user) {
    console.log('🔄 Restarting location tracking...');
    this.stopTracking();
    
    // Small delay to ensure clean restart
    await new Promise(resolve => setTimeout(resolve, 500));
    
    try {
      await this.startTracking(user);
      console.log('✅ Location tracking restarted successfully');
    } catch (error) {
      console.error('❌ Failed to restart tracking:', error);
      throw error;
    }
  }

  async toggleTracking(user) {
    const newStatus = !user?.location_tracking_enabled;
    
    console.log(`🔄 Toggling location tracking: ${user?.location_tracking_enabled} -> ${newStatus} for`, user?.user_name || user?.full_name);
    
    try {
      if (newStatus) {
        // Turning ON
        console.log('🟢 Enabling location tracking...');
        
        // Check if online first
        if (!navigator.onLine) {
          throw new Error('Device is offline. Please check your internet connection.');
        }
        
        // Get or find AppUser ID first
        let appUserId = user.appUserId;
        if (!appUserId) {
          console.log('🔍 Looking up AppUser ID for user:', user.id);
          const appUsers = await base44.entities.AppUser.filter({ user_id: user.id });
          if (appUsers && appUsers.length > 0) {
            appUserId = appUsers[0].id;
            console.log('✅ Found AppUser ID:', appUserId);
          } else {
            throw new Error('User profile not found. Please contact support.');
          }
        }
        
        // FIRST: Update AppUser entity to set location_tracking_enabled = true
        console.log('💾 Saving location_tracking_enabled = true to AppUser database...');
        await base44.entities.AppUser.update(appUserId, {
          location_tracking_enabled: true
        });
        console.log('✅ AppUser database updated: location_tracking_enabled = true');
        
        // THEN: Try to start tracking
        try {
          console.log('🎯 Starting location tracking...');
          await this.startTracking(user);
          console.log('✅ Location tracking started successfully');
        } catch (trackingError) {
          console.error('❌ Failed to start tracking:', trackingError);
          
          // If it's a permission error or device capability error, revert the database change
          if (trackingError.code === 1) { // PERMISSION_DENIED
            console.warn('⚠️ Location permission denied by user. Reverting database change...');
            
            await base44.entities.AppUser.update(appUserId, {
              location_tracking_enabled: false
            });
            
            window.dispatchEvent(new CustomEvent('locationPermissionDenied', { 
              detail: { message: this.handleLocationError(trackingError).message } 
            }));
            return false;
          }
          
          if (trackingError.message?.includes('only available on mobile devices') || 
              trackingError.message?.includes('GPS is not available')) {
            console.warn('⚠️ Device does not support location tracking:', trackingError.message);
            
            await base44.entities.AppUser.update(appUserId, {
              location_tracking_enabled: false
            });
            
            window.dispatchEvent(new CustomEvent('locationPermissionDenied', { 
              detail: { message: trackingError.message } 
            }));
            return false;
          }
          
          throw trackingError;
        }
        
        console.log('✅ Location tracking enabled successfully');
        return true;
        
      } else {
        // Turning OFF
        console.log('🔴 Disabling location tracking...');
        
        // Stop tracking first
        this.stopTracking();
        
        // Get AppUser ID
        let appUserId = user.appUserId;
        if (!appUserId) {
          console.log('🔍 Looking up AppUser ID for user:', user.id);
          const appUsers = await base44.entities.AppUser.filter({ user_id: user.id });
          if (appUsers && appUsers.length > 0) {
            appUserId = appUsers[0].id;
          }
        }
        
        // Then update AppUser entity AND clear location data
        if (navigator.onLine && appUserId) {
          console.log('💾 Saving location_tracking_enabled = false and clearing location data in AppUser...');
          await base44.entities.AppUser.update(appUserId, {
            location_tracking_enabled: false,
            current_latitude: null,
            current_longitude: null,
            location_updated_at: null
          });
          console.log('✅ AppUser database updated: tracking disabled and location cleared');
        } else {
          console.warn('⚠️ Device offline or no AppUser ID, tracking stopped locally only');
        }
        
        // Dispatch event to notify UI that location was cleared
        window.dispatchEvent(new CustomEvent('driverLocationCleared', {
          detail: { userId: user.id }
        }));
        
        console.log('✅ Location tracking disabled and location data cleared');
        return false;
      }
    } catch (error) {
      console.error('❌ Failed to toggle location tracking:', error);
      // Ensure tracking is stopped if enabling failed
      if (newStatus) {
        this.stopTracking();
      }
      throw error;
    }
  }

  getStatus() {
    return {
      isTracking: this.isTracking,
      driverStatus: this.driverStatus,
      lastUpdate: this.lastUpdate,
      lastSuccessfulUpdate: this.lastSuccessfulUpdate,
      lastCoordinateUpdate: this.lastCoordinateUpdate,
      lastLocation: this.lastPosition,
      hasPosition: this.lastPosition !== null,
      failedUpdateCount: this.failedUpdateCount,
      backoffTime: this.backoffTime,
      isOnline: navigator.onLine,
      deviceCapabilities: this.deviceCapabilities,
      updateInterval: this.updateInterval,
      minDistanceChange: this.minDistanceChange
    };
  }

  /**
   * Reload settings from RouteOptimizationSettings (call when settings change)
   */
  reloadSettings() {
    this.loadSettings();
  }
}

export const locationTracker = new LocationTracker();