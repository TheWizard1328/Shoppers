import { base44 } from '@/api/base44Client';
import { isMobileDevice as checkIsMobileDevice } from './deviceUtils';
import { getRouteOptimizationSettings } from '../dashboard/RouteOptimizationSettings';
import { liveDistanceTracker } from './liveDistanceTracker';
import { getCurrentDevice, updateDeviceLastActive } from './deviceManager';

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
      this.heartbeatInterval = null; // Poll GPS every 5 seconds
      this.isTracking = false;
      this.lastPosition = null;
      this.lastUpdate = 0;
      this.lastCoordinateUpdate = 0;
      this.currentUser = null;
      this.appUserId = null;
      this.driverStatus = 'off_duty';
      this.updateInterval = 5000; // 5 seconds GPS polling
      this.coordinateUpdateInterval = 5000; // 5 seconds between coordinate updates

      // Distance threshold - only upload if moved > 200m
      this.minDistanceChange = 200; // 200 meters minimum movement to trigger upload

      // Deduplication - prevent duplicate updates within 2 seconds
      this.lastUploadTime = 0;
      this.minTimeBetweenUploads = 2000; // 2 second minimum between uploads

      this.failedUpdateCount = 0;
      this.maxFailedUpdates = 3;
      this.backoffTime = 0;
      this.lastSuccessfulUpdate = 0;
      this.deviceCapabilities = null;

      // Event-driven updates tracking
      this._pendingEventUpdate = false;
      this._eventUpdateTime = 0;
    
    // Load settings from RouteOptimizationSettings
    this.loadSettings();
  }

  /**
   * Load tracking settings from RouteOptimizationSettings
   */
  loadSettings() {
    try {
      const settings = getRouteOptimizationSettings();
      // CRITICAL: Always use locked 15-second interval regardless of settings
      this.updateInterval = this._lockedUpdateInterval || 15000;

      if (settings.minMovementDistanceMeters) {
        this.minDistanceChange = settings.minMovementDistanceMeters;
      }

      console.log(`📍 [LocationTracker] Interval locked to ${this.updateInterval / 1000}s (primary device)`);
    } catch (error) {
      console.warn('⚠️ Could not load route optimization settings, using defaults');
      this.updateInterval = 15000; // Default 15 seconds
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

  async updateLocationInDatabase(latitude, longitude, accuracy, forceUpdate = false) {
    const now = Date.now();

    // Check if we're in backoff period (unless forced)
    if (!forceUpdate && this.backoffTime > 0 && (now - this.lastUpdate) < this.backoffTime) {
      console.log('⏸️ [LocationTracker] Skipping update - in backoff period');
      return;
    }

    const timeForHeartbeat = (now - this.lastUpdate) >= this.updateInterval;

    // CRITICAL: Skip timing check if forceUpdate=true (called from heartbeat interval)
    if (!forceUpdate && !timeForHeartbeat) {
      const secondsRemaining = Math.ceil((this.updateInterval - (now - this.lastUpdate)) / 1000);
      console.log(`⏳ [LocationTracker] Waiting ${secondsRemaining}s until next heartbeat`);
      return; // Silently skip if heartbeat not due
    }

    if (forceUpdate) {
      console.log(`💓 [LocationTracker] Forced heartbeat update - uploading coordinates + timestamp (stationary)`);
    } else {
      console.log(`⏰ [LocationTracker] GPS-triggered update - uploading coordinates + timestamp (moving)`);
    }

    let distance = 0;
    const timeSinceLastUpdate = now - this.lastUpdate;
    if (this.lastPosition) {
      distance = this.calculateDistance(
        this.lastPosition.latitude,
        this.lastPosition.longitude,
        latitude,
        longitude
      );
      console.log(`📍 [LocationTracker] Heartbeat update - moved ${distance.toFixed(0)}m (${Math.floor(timeSinceLastUpdate/1000)}s since last)`);
    } else {
      console.log('🚀 [LocationTracker] First location update');
    }

    // CRITICAL: Set lastUpdate AFTER logging to show accurate time difference
    this.lastUpdate = now;

    try {
      // Check if online before attempting update
      if (!navigator.onLine) {
        console.log('❌ [LocationTracker] Device offline - skipping upload');
        return;
      }

      if (!this.appUserId || !this.currentUser) {
        console.log('❌ [LocationTracker] Missing appUserId or currentUser - skipping upload');
        return;
      }

      const nowISO = new Date().toISOString();

      const userName = this.currentUser?.user_name || this.currentUser?.full_name || 'Unknown';
      const userIdLast4 = this.currentUser?.id ? this.currentUser.id.slice(-4) : '????';
      
      console.log(`📤 [LocationTracker] Uploading location for ${userName} (...${userIdLast4}):`, {
        lat: latitude.toFixed(6),
        lng: longitude.toFixed(6),
        timestamp: nowISO
      });

      // CRITICAL: Primary device always uploads coordinates + timestamp
      const updateData = {
        current_latitude: latitude,
        current_longitude: longitude,
        location_updated_at: nowISO
      };

      // Step 1: Upload this driver's location to API
      const updatedAppUser = await base44.entities.AppUser.update(this.appUserId, updateData);
      console.log(`✅ [LocationTracker] UPLOADED TO API - ${userName} (...${userIdLast4}):`, {
        lat: latitude.toFixed(6),
        lon: longitude.toFixed(6),
        timestamp: nowISO,
        appUserId: this.appUserId,
        response: updatedAppUser ? 'SUCCESS' : 'FAILED',
        uploadedData: updateData
      });

      if (!updatedAppUser) {
        console.error('❌ [LocationTracker] API upload returned falsy response!');
      }

      // Step 2: Fetch ALL AppUsers from API to ensure cross-device sync
      // CRITICAL: All devices need the same fresh data, not just their own offline DB
      const allAppUsers = await base44.entities.AppUser.list();
      console.log(`📥 [LocationTracker] Fetched ${allAppUsers.length} AppUsers from API after upload`);
      
      // Verify current driver is in the list with updated coordinates
      const currentDriverInList = allAppUsers.find(au => au.id === this.appUserId);
      if (currentDriverInList) {
        console.log(`✅ [LocationTracker] Current driver found in API response:`, {
          lat: currentDriverInList.current_latitude?.toFixed(6),
          lon: currentDriverInList.current_longitude?.toFixed(6),
          timestamp: currentDriverInList.location_updated_at
        });
      } else {
        console.error(`❌ [LocationTracker] Current driver ${this.appUserId} NOT found in API response!`);
      }

      // Step 3: Save ALL AppUsers to offline DB (ensures all devices have same fresh data)
      try {
        const { offlineDB } = await import('./offlineDatabase');
        await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, allAppUsers);
        console.log(`💾 [LocationTracker] Saved ${allAppUsers.length} AppUsers to offline DB`);
        
        // Verify offline DB was updated
        const offlineCurrentDriver = allAppUsers.find(au => au.id === this.appUserId);
        if (offlineCurrentDriver) {
          console.log(`✅ [LocationTracker] Verified in offline DB:`, {
            lat: offlineCurrentDriver.current_latitude?.toFixed(6),
            lon: offlineCurrentDriver.current_longitude?.toFixed(6),
            timestamp: offlineCurrentDriver.location_updated_at
          });
        }
      } catch (offlineError) {
        console.error('❌ [LocationTracker] FAILED TO SYNC to offline DB:', offlineError.message);
      }

      // Dispatch event with ALL fresh AppUsers from API
      if (typeof window !== 'undefined') {
        console.log(`📡 [LocationTracker] Dispatching driverLocationsUpdated with ${allAppUsers.length} drivers from API`);
        window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
          detail: { appUsers: allAppUsers, fromLocationTracker: true }
        }));
      }

      // CRITICAL: Always update UserDevice last_active_at for primary tracker
      const currentDevice = await getCurrentDevice(this.currentUser.id);
      if (currentDevice) {
        await updateDeviceLastActive(this.currentUser.id);
        console.log(`✅ [LocationTracker] Updated device last_active_at`);
      }

      // Update currentUser reference
      if (this.currentUser) {
        this.currentUser.current_latitude = latitude;
        this.currentUser.current_longitude = longitude;
        this.currentUser.location_updated_at = nowISO;

        // Update liveDistanceTracker's currentUser reference
        if (liveDistanceTracker.isTracking && liveDistanceTracker.currentUser) {
          liveDistanceTracker.currentUser.current_latitude = latitude;
          liveDistanceTracker.currentUser.current_longitude = longitude;
        }
      }

      // NOTE: lastUpdate already set BEFORE upload to prevent double-uploads
      this.lastSuccessfulUpdate = now;
      this.lastCoordinateUpdate = now;
      this.lastPosition = { latitude, longitude, accuracy };
      this.failedUpdateCount = 0;
      this.backoffTime = 0;

      console.log(`✅✅✅ [LocationTracker] UPLOAD COMPLETE - Next in ${this.updateInterval/1000}s`);

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
            const updateData = {
              location_tracking_enabled: false,
              current_latitude: null,
              current_longitude: null,
              location_updated_at: null
            };
            await base44.entities.AppUser.update(this.appUserId, updateData);

            // CRITICAL: DUAL-WRITE - Save to offline DB immediately
            try {
              const { offlineDB } = await import('./offlineDatabase');
              const appUser = await base44.entities.AppUser.filter({ id: this.appUserId });
              if (appUser && appUser.length > 0) {
                await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, [appUser[0]]);
              }
            } catch (offlineError) {
              console.warn('⚠️ [LocationTracker] Failed to sync disabled tracking to offline DB:', offlineError.message);
            }
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
    console.log(`📍 [LocationTracker] GPS position received - lat: ${latitude.toFixed(6)}, lon: ${longitude.toFixed(6)}, accuracy: ${accuracy?.toFixed(0)}m`);
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
      console.log('📍 [LocationTracker] Already tracking - skipping start');
      return;
    }

    const userName = user.user_name || user.full_name || 'Unknown';
    const userIdLast4 = user.id ? user.id.slice(-4) : '????';

    console.log(`🚀 [LocationTracker] Starting location tracking for ${userName} (...${userIdLast4}) - PRIMARY device always tracks while app is open`);

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
      console.log('📍 [LocationTracker] Starting watchPosition with high accuracy GPS...');
      this.watchId = navigator.geolocation.watchPosition(
        (position) => {
          this.handleLocationSuccess(position);
          
          if (!this.isTracking) {
            this.isTracking = true;
            console.log('✅ [LocationTracker] GPS watch established successfully');
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

      // CRITICAL: PRIMARY DEVICE RULE - Always upload location every 15s while app is open
      // This happens regardless of:
      // - driver_status (on_duty, off_duty, on_break)
      // - location_tracking_enabled toggle
      // - Other settings or toggles
      // The primary device is the source of truth for this driver's location
      this.heartbeatInterval = setInterval(() => {
        if (this.lastPosition && this.isTracking) {
          console.log('💓 [LocationTracker] Heartbeat tick - PRIMARY device uploading coordinates (always on while app is open)');
          this.updateLocationInDatabase(
            this.lastPosition.latitude,
            this.lastPosition.longitude,
            this.lastPosition.accuracy,
            true // forceUpdate = true to bypass timing checks
          );
        }
      }, this.updateInterval);
      console.log(`💓 [LocationTracker] Started ${this.updateInterval/1000}s heartbeat - PRIMARY ALWAYS LOGS regardless of toggles/status`);
    });
  }

  stopTracking() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log('💓 [LocationTracker] Stopped heartbeat interval');
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