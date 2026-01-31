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
    this.lastCoordinateUpdate = 0;
    this.currentUser = null;
    this.appUserId = null;
    this.driverStatus = 'off_duty';
    this.updateInterval = 15000; // 15 seconds heartbeat
    this.coordinateUpdateInterval = 15000; // 15 seconds max without coordinate update
    this.minDistanceChange = 100; // 100 meters (can be overridden by settings)
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
   * Set driver duty status - tracked for reference but doesn't control location updates
   */
  setDriverStatus(status) {
    const previousStatus = this.driverStatus;
    this.driverStatus = status;
    
    console.log(`📍 [LocationTracker] Driver status changed: ${previousStatus} → ${status}`);
    
    // CRITICAL: Update liveDistanceTracker's driver status too
    if (liveDistanceTracker.isTracking) {
      liveDistanceTracker.updateDriverStatus(status);
    }
    
    return status === 'on_duty' || status === 'on_break';
  }

  /**
   * Check if tracking should be active
   * CRITICAL: Always returns true - we track as long as app is open
   */
  shouldTrack() {
    return true;
  }

  /**
   * Enhanced mobile device detection using centralized utility
   */
  isMobileDevice() {
    return checkIsMobileDevice();
  }

  /**
   * Check if device has GPS capabilities with high accuracy
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
      }, 5000);

      navigator.geolocation.getCurrentPosition(
        (position) => {
          clearTimeout(timeoutId);
          const accuracy = position.coords.accuracy;
          const hasHighAccuracy = accuracy && accuracy < 100;
          
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
    
    // Check if we're in backoff period
    if (this.backoffTime > 0 && (now - this.lastUpdate) < this.backoffTime) {
      console.log('⏸️ [LocationTracker] Skipping update - in backoff period');
      return;
    }

    // CRITICAL: Check if driver has moved enough from last position
    const hasMovedEnough = this.lastPosition ? 
                            this.calculateDistance(this.lastPosition.latitude, this.lastPosition.longitude, latitude, longitude) >= this.minDistanceChange : 
                            true; // First update - always proceed

    const timeForHeartbeat = (now - this.lastUpdate) >= this.updateInterval;
    const timeForCoordinateUpdate = (now - this.lastCoordinateUpdate) >= this.coordinateUpdateInterval;

    // Skip if neither movement nor time thresholds are met
    if (!hasMovedEnough && !timeForHeartbeat && !timeForCoordinateUpdate) {
      return;
    }

    let distance = 0;
    if (this.lastPosition) {
      distance = this.calculateDistance(
        this.lastPosition.latitude,
        this.lastPosition.longitude,
        latitude,
        longitude
      );
      
      if (distance >= this.minDistanceChange) {
        console.log(`📍 [LocationTracker] Updating - moved ${distance.toFixed(0)}m`);
      } else if (timeForCoordinateUpdate) {
        console.log(`📍 [LocationTracker] Updating - time threshold met (${Math.floor((now - this.lastCoordinateUpdate)/1000)}s)`);
      }
    } else {
      console.log('🚀 [LocationTracker] First location update');
    }

    try {
      // Check if online before attempting update
      if (!navigator.onLine) {
        return;
      }

      if (!this.appUserId) {
        return;
      }

      // CRITICAL: Always update coordinates and timestamp when app is open and movement occurs
      const nowFormatted = new Date();
      const year = nowFormatted.getFullYear();
      const month = String(nowFormatted.getMonth() + 1).padStart(2, '0');
      const day = String(nowFormatted.getDate()).padStart(2, '0');
      const hours = String(nowFormatted.getHours()).padStart(2, '0');
      const minutes = String(nowFormatted.getMinutes()).padStart(2, '0');
      const seconds = String(nowFormatted.getSeconds()).padStart(2, '0');
      
      const updateData = {
        current_latitude: latitude,
        current_longitude: longitude,
        location_updated_at: `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`
      };
      
      // Update AppUser entity
      const updatedAppUser = await base44.entities.AppUser.update(this.appUserId, updateData);
      
      // Broadcast location update to other devices
      broadcastMutation('AppUser', 'update', this.appUserId, updatedAppUser);
      
      // Update currentUser reference
      if (this.currentUser) {
        this.currentUser.current_latitude = latitude;
        this.currentUser.current_longitude = longitude;
        this.currentUser.location_updated_at = updateData.location_updated_at;
        
        // Update liveDistanceTracker's currentUser reference
        if (liveDistanceTracker.isTracking && liveDistanceTracker.currentUser) {
          liveDistanceTracker.currentUser.current_latitude = latitude;
          liveDistanceTracker.currentUser.current_longitude = longitude;
        }
      }

      this.lastUpdate = now;
      this.lastSuccessfulUpdate = now;
      this.lastCoordinateUpdate = now;
      this.lastPosition = { latitude, longitude, accuracy };
      this.failedUpdateCount = 0;
      this.backoffTime = 0;
      
      console.log(`✅ [LocationTracker] Location updated - Accuracy: ${accuracy?.toFixed(0)}m`);

      window.dispatchEvent(new CustomEvent('driverLocationUpdated', {
        detail: {
          userId: this.currentUser?.id,
          latitude,
          longitude,
          accuracy,
          timestamp: now,
          isRealtime: true,
          isCoordinateUpdate: true
        }
      }));

    } catch (error) {
      this.failedUpdateCount++;

      // Implement exponential backoff
      if (error.response?.status === 429 || error.message?.includes('429') || error.message?.includes('Rate limit')) {
        this.backoffTime = Math.min(60000 * Math.pow(2, this.failedUpdateCount), 300000);
        console.warn(`⏰ Rate limited. Backing off for ${this.backoffTime / 1000}s`);
      } else if (error.message?.includes('Network Error') || !navigator.onLine) {
        this.backoffTime = 30000;
        console.warn(`🔌 Network error. Backing off for ${this.backoffTime / 1000}s`);
      } else {
        this.backoffTime = 10000;
      }

      // If too many failures, stop tracking
      if (this.failedUpdateCount >= this.maxFailedUpdates) {
        console.error('❌ Too many failed updates, stopping location tracking');
        this.stopTracking();
        
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

    if (!navigator.onLine) {
      throw new Error('Device is offline. Please check your internet connection.');
    }

    this.currentUser = user;
    
    // Get or find AppUser ID
    if (user.appUserId) {
      this.appUserId = user.appUserId;
    } else {
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
    this.lastCoordinateUpdate = 0;

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
        
        // Update AppUser entity to set location_tracking_enabled = true
        await base44.entities.AppUser.update(appUserId, {
          location_tracking_enabled: true
        });
        
        // Try to start tracking
        try {
          await this.startTracking(user);
        } catch (trackingError) {
          console.error('❌ Failed to start tracking:', trackingError);
          
          if (trackingError.code === 1) {
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
        this.stopTracking();
        
        let appUserId = user.appUserId;
        if (!appUserId) {
          const appUsers = await base44.entities.AppUser.filter({ user_id: user.id });
          if (appUsers && appUsers.length > 0) {
            appUserId = appUsers[0].id;
          }
        }
        
        if (navigator.onLine && appUserId) {
          console.log('🔴 [LocationTracker] Turning OFF location sharing');
          await base44.entities.AppUser.update(appUserId, {
            location_tracking_enabled: false,
            location_updated_at: null
          });
          
          if (this.currentUser) {
            this.currentUser.location_tracking_enabled = false;
            this.currentUser.location_updated_at = null;
          }
        } else {
          console.warn('⚠️ Device offline or no AppUser ID, tracking stopped locally only');
        }
        
        window.dispatchEvent(new CustomEvent('driverLocationCleared', {
          detail: { userId: user.id }
        }));
        
        return false;
      }
    } catch (error) {
      console.error('❌ Failed to toggle location tracking:', error);
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

  reloadSettings() {
    this.loadSettings();
  }
}

export const locationTracker = new LocationTracker();