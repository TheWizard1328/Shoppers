import { base44 } from '@/api/base44Client';
import { isMobileDevice as checkIsMobileDevice } from './deviceUtils';
import { getRouteOptimizationSettings } from '../dashboard/RouteOptimizationSettings';
import { liveDistanceTracker } from './liveDistanceTracker';

// Lazy load broadcastMutation to avoid circular dependency issues
const broadcastMutation = async (entity, action, id, data) => {
  try {
    const { broadcastMutation: broadcast } = await import('./realtimeSync');
    return broadcast(entity, action, id, data);
  } catch (error) {
    console.warn('[LocationTracker] Could not broadcast mutation:', error.message);
  }
};

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
    this.updateInterval = 15000; // 15 seconds heartbeat for live tracking (can be overridden by settings)
    this.coordinateUpdateInterval = 15000; // 15 seconds max without coordinate update (ensures fresh markers)
    this.minDistanceChange = 50; // 50 meters (can be overridden by settings)
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
    } catch (error) {
      console.warn('⚠️ Could not load route optimization settings, using defaults');
    }
  }

  /**
   * Set driver duty status - controls whether location_updated_at is updated
   * CRITICAL: We no longer stop tracking when off_duty - we just stop updating the timestamp
   * This allows coordinates to still be saved for the driver's desktop self-marker
   */
  setDriverStatus(status) {
    const previousStatus = this.driverStatus;
    this.driverStatus = status;
    
    console.log(`📍 [LocationTracker] Driver status changed: ${previousStatus} → ${status}`);
    
    // CRITICAL: Update liveDistanceTracker's driver status too
    if (liveDistanceTracker.isTracking) {
      liveDistanceTracker.updateDriverStatus(status);
    }
    
    // CRITICAL: Do NOT stop tracking when going off_duty/on_break
    // We still want to update coordinates so driver can see their marker on desktop
    // We just won't update location_updated_at when not on_duty
    
    return status === 'on_duty' || status === 'on_break';
  }

  /**
   * Check if tracking should be active based on driver status
   * CRITICAL: Now returns true for all statuses on mobile - we always track coordinates
   * The difference is whether we update location_updated_at (only on_duty/on_break)
   */
  shouldTrack() {
    // Always return true on mobile - we track coordinates regardless of status
    // The updateLocationInDatabase method handles whether to update location_updated_at
    return true;
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
      this.deviceCapabilities = {
        hasGeolocation: false,
        hasHighAccuracy: false,
        error: 'Geolocation API not available'
      };
      return this.deviceCapabilities;
    }

    return new Promise((resolve) => {
      
      const timeoutId = setTimeout(() => {
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
    
    // CRITICAL: Check if driver is on duty - this is the primary control
    // Only update when on_duty (not on_break or off_duty)
    const isOnDuty = this.driverStatus === 'on_duty';
    
    if (!isOnDuty) {
      console.log(`⏸️ [LocationTracker] Skipping update - driver status is ${this.driverStatus} (not on_duty)`);
      // Still update lastPosition for distance calculations
      this.lastPosition = { latitude, longitude, accuracy };
      return;
    }
    
    // Check if we're in backoff period
    if (this.backoffTime > 0 && (now - this.lastUpdate) < this.backoffTime) {
      console.log('⏸️ [LocationTracker] Skipping update - in backoff period');
      return;
    }

    // Check if enough time has passed since last heartbeat update
    if (now - this.lastUpdate < this.updateInterval) {
      return;
    }

    // Determine if we should update coordinates (not just timestamp)
    let shouldUpdateCoordinates = false;
    let distance = 0;
    
    // CRITICAL: Check if current user's stored coordinates are missing or null
    const storedLat = this.currentUser?.current_latitude;
    const storedLng = this.currentUser?.current_longitude;
    const hasStoredCoords = storedLat != null && storedLng != null && 
                           !isNaN(storedLat) && !isNaN(storedLng);

    if (this.lastPosition) {
      distance = this.calculateDistance(
        this.lastPosition.latitude,
        this.lastPosition.longitude,
        latitude,
        longitude
      );

      // Update coordinates if: 
      // 1. Stored coords are missing/null
      // 2. Significant movement (200m+)
      // 3. Normal movement threshold met (50m)
      // 4. 10 seconds since last coordinate update (ensures fresh markers)
      const timeSinceCoordinateUpdate = now - this.lastCoordinateUpdate;
      const significantMovement = distance >= 200; // 200m threshold for forced update
      
      shouldUpdateCoordinates = !hasStoredCoords || 
                                significantMovement || 
                                distance >= this.minDistanceChange || 
                                timeSinceCoordinateUpdate >= this.coordinateUpdateInterval;
      
      if (shouldUpdateCoordinates) {
        if (!hasStoredCoords) {
          console.log(`📍 [LocationTracker] Updating coordinates - stored coords missing/null`);
        } else if (significantMovement) {
          console.log(`📍 [LocationTracker] Updating coordinates - significant movement ${distance.toFixed(0)}m (>200m)`);
        } else if (timeSinceCoordinateUpdate >= this.coordinateUpdateInterval) {
          console.log(`📍 [LocationTracker] Updating coordinates - time threshold met (${Math.floor(timeSinceCoordinateUpdate/1000)}s)`);
        } else {
          console.log(`📍 [LocationTracker] Updating coordinates - moved ${distance.toFixed(0)}m`);
        }
      }
    } else {
      // First update - always update coordinates
      shouldUpdateCoordinates = true;
      console.log('🚀 [LocationTracker] First location update');
    }

    try {
      // Check if online before attempting update
      if (!navigator.onLine) {
        return;
      }

      // CRITICAL: Ensure we have AppUser ID
      if (!this.appUserId) {
        return;
      }

      // Build update object
      const updateData = {};
      
      // CRITICAL: Always update location_updated_at when on_duty
      // Use local time without timezone offset (YYYY-MM-DDTHH:MM:SS)
      if (isOnDuty) {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        updateData.location_updated_at = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
      }

      // CRITICAL: Update coordinates when on_duty
      if (shouldUpdateCoordinates) {
        updateData.current_latitude = latitude;
        updateData.current_longitude = longitude;
        this.lastCoordinateUpdate = now;
        console.log(`📍 [LocationTracker] Updating coordinates (on_duty: ${isOnDuty})`);
      }
      
      // Skip update if nothing to update
      if (Object.keys(updateData).length === 0) {
        console.log(`⏸️ [LocationTracker] No updates to send`);
        return;
      }
      
      // Update AppUser entity
      const updatedAppUser = await base44.entities.AppUser.update(this.appUserId, updateData);
      
      // CRITICAL: Broadcast location update to other devices via WebSocket
      // This ensures other users see driver location changes instantly
      broadcastMutation('AppUser', 'update', this.appUserId, updatedAppUser);
      
      // CRITICAL: Update the currentUser reference with new coordinates
      // so the driverLocationPoller has access to them
      if (this.currentUser) {
        this.currentUser.current_latitude = latitude;
        this.currentUser.current_longitude = longitude;
        if (isOnDuty) {
          this.currentUser.location_updated_at = updateData.location_updated_at;
        }
        
        // CRITICAL: Update liveDistanceTracker's currentUser reference too
        if (liveDistanceTracker.isTracking && liveDistanceTracker.currentUser) {
          liveDistanceTracker.currentUser.current_latitude = latitude;
          liveDistanceTracker.currentUser.current_longitude = longitude;
        }
      }

      this.lastUpdate = now;
      this.lastSuccessfulUpdate = now;
      
      // Always update lastPosition to have the latest GPS reading for distance calculations
      this.lastPosition = { latitude, longitude, accuracy };
      
      this.failedUpdateCount = 0;
      this.backoffTime = 0; // Reset backoff on success
      
      console.log(`✅ [LocationTracker] Location updated - Coords: ${shouldUpdateCoordinates ? 'YES' : 'NO (heartbeat only)'}, Accuracy: ${accuracy?.toFixed(0)}m`);

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
              location_updated_at: null // null is appropriate here (clearing timestamp)
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
    } else {
      // Try to find AppUser record
      try {
        const appUsers = await base44.entities.AppUser.filter({ user_id: user.id });
        if (appUsers && appUsers.length > 0) {
          this.appUserId = appUsers[0].id;
        } else {
          throw new Error('User profile not properly configured. Please contact support.');
        }
      } catch (error) {
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
      
      this.watchId = navigator.geolocation.watchPosition(
        (position) => {
          this.handleLocationSuccess(position);
          
          if (!this.isTracking) {
            this.isTracking = true;
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

    });
  }

  stopTracking() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
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
    
  }

  async restartTracking(user) {
    this.stopTracking();
    
    // Small delay to ensure clean restart
    await new Promise(resolve => setTimeout(resolve, 500));
    
    try {
      await this.startTracking(user);
    } catch (error) {
      console.error('❌ Failed to restart tracking:', error);
      throw error;
    }
  }

  async toggleTracking(user) {
    const newStatus = !user?.location_tracking_enabled;
    
    try {
      if (newStatus) {
        // Turning ON
        
        // Check if online first
        if (!navigator.onLine) {
          throw new Error('Device is offline. Please check your internet connection.');
        }
        
        // Get or find AppUser ID first
        let appUserId = user.appUserId;
        if (!appUserId) {
          const appUsers = await base44.entities.AppUser.filter({ user_id: user.id });
          if (appUsers && appUsers.length > 0) {
            appUserId = appUsers[0].id;
          } else {
            throw new Error('User profile not found. Please contact support.');
          }
        }
        
        // FIRST: Update AppUser entity to set location_tracking_enabled = true
        await base44.entities.AppUser.update(appUserId, {
          location_tracking_enabled: true
        });
        
        // THEN: Try to start tracking
        try {
          await this.startTracking(user);
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
        
        return true;
        
      } else {
        // Turning OFF
        
        // Stop tracking first
        this.stopTracking();
        
        // Get AppUser ID
        let appUserId = user.appUserId;
        if (!appUserId) {
          const appUsers = await base44.entities.AppUser.filter({ user_id: user.id });
          if (appUsers && appUsers.length > 0) {
            appUserId = appUsers[0].id;
          }
        }
        
        // CRITICAL: When turning off location sharing on MOBILE:
        // - Set location_tracking_enabled = false
        // - Set location_updated_at = null (signals sharing is OFF to other users)
        // - Keep coordinates (driver can still see on desktop)
        if (navigator.onLine && appUserId) {
          console.log('🔴 [LocationTracker] Turning OFF location sharing - keeping coords but clearing timestamp');
          await base44.entities.AppUser.update(appUserId, {
            location_tracking_enabled: false,
            location_updated_at: null
            // CRITICAL: Do NOT clear current_latitude/current_longitude
            // Driver needs these to see their own marker on desktop
          });
          
          // CRITICAL: Update currentUser ref to reflect change
          if (this.currentUser) {
            this.currentUser.location_tracking_enabled = false;
            this.currentUser.location_updated_at = null;
          }
        } else {
          console.warn('⚠️ Device offline or no AppUser ID, tracking stopped locally only');
        }
        
        // Dispatch event to notify UI that location sharing was turned off
        window.dispatchEvent(new CustomEvent('driverLocationCleared', {
          detail: { userId: user.id }
        }));
        
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