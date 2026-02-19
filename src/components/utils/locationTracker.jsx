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
      this.heartbeatInterval = null; // Poll GPS every 15 seconds
      this.isTracking = false;
      this.lastPosition = null;
      this.lastUpdate = 0;
      this.lastCoordinateUpdate = 0;
      this.currentUser = null;
      this.appUserId = null;
      this.driverStatus = 'off_duty';
      this.updateInterval = 15000; // 15 seconds GPS polling
      this.coordinateUpdateInterval = 15000; // 15 seconds between coordinate updates

      // Distance threshold - only upload if moved > 200m
      this.minDistanceChange = 200; // 200 meters minimum movement to trigger upload

      // Deduplication - prevent duplicate updates within 2 seconds
      this.lastUploadTime = 0;
      this.minTimeBetweenUploads = 2000; // 2 second minimum between uploads

      // Heartbeat timestamp updates - keep location fresh even when stationary
      this.lastTimestampUpdate = 0;
      this.timestampUpdateInterval = 60000; // 1 minute - update timestamp to prevent stale mode

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
      // Interval locked to 15 seconds for primary device polling
      this.updateInterval = 15000; // 15 seconds GPS polling

      // 200m minimum movement threshold
      this.minDistanceChange = 200;

      console.log(`📍 [LocationTracker] Interval: ${this.updateInterval / 1000}s, distance threshold: ${this.minDistanceChange}m`);
    } catch (error) {
      console.warn('⚠️ Could not load route optimization settings, using defaults');
      this.updateInterval = 15000; // Default 15 seconds
      this.minDistanceChange = 200; // Default 200m
    }
  }

  /**
   * Set driver duty status - track for immediate GPS upload on status change
   */
  setDriverStatus(status) {
    const previousStatus = this.driverStatus;
    this.driverStatus = status;
    
    console.log(`📍 [LocationTracker] Driver status changed: ${previousStatus} → ${status}`);
    
    // EVENT-DRIVEN: Mark for immediate update on next poll
    this._pendingEventUpdate = true;
    this._eventUpdateTime = Date.now();
    
    // CRITICAL: Update liveDistanceTracker's driver status too
    if (liveDistanceTracker.isTracking) {
      liveDistanceTracker.updateDriverStatus(status);
    }
    
    return status === 'on_duty' || status === 'on_break';
  }

  /**
   * Signal that a stop event occurred (completion, failure, cancellation)
   * Triggers immediate GPS upload on next poll
   */
  signalStopEvent(eventType = 'completion') {
    console.log(`🎯 [LocationTracker] Stop event: ${eventType} - marking for GPS upload`);
    this._pendingEventUpdate = true;
    this._eventUpdateTime = Date.now();
  }

  /**
   * Signal that location sharing was toggled
   * Triggers immediate GPS upload on next poll
   */
  signalLocationSharingToggle(enabled) {
    console.log(`📍 [LocationTracker] Location sharing toggled: ${enabled ? 'ON' : 'OFF'} - marking for GPS upload`);
    this._pendingEventUpdate = true;
    this._eventUpdateTime = Date.now();
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

  async updateLocationInDatabase(latitude, longitude, accuracy, forceUpdate = false, timestampOnly = false, isPrimaryDevice = false) {
    const now = Date.now();

    // Check if we're in backoff period (unless forced)
    if (!forceUpdate && !timestampOnly && this.backoffTime > 0 && (now - this.lastUpdate) < this.backoffTime) {
      console.log('⏸️ [LocationTracker] Skipping update - in backoff period');
      return;
    }

    // CRITICAL: Check deduplication - prevent duplicate uploads within 2 seconds
    if (!forceUpdate && !timestampOnly && (now - this.lastUploadTime) < this.minTimeBetweenUploads) {
      const msRemaining = this.minTimeBetweenUploads - (now - this.lastUploadTime);
      console.log(`⏳ [LocationTracker] Dedup: Waiting ${msRemaining}ms to prevent duplicate upload`);
      return;
    }

    // CRITICAL: Check distance threshold - SKIP for primary devices (always update)
    let distance = 0;
    if (this.lastPosition && !forceUpdate && !timestampOnly && !isPrimaryDevice) {
      distance = this.calculateDistance(
        this.lastPosition.latitude,
        this.lastPosition.longitude,
        latitude,
        longitude
      );

      if (distance < this.minDistanceChange) {
        console.log(`📍 [LocationTracker] Moved only ${distance.toFixed(0)}m - waiting for ${this.minDistanceChange}m threshold`);
        return; // Skip update if distance below threshold
      }
    } else if (isPrimaryDevice && this.lastPosition) {
      distance = this.calculateDistance(
        this.lastPosition.latitude,
        this.lastPosition.longitude,
        latitude,
        longitude
      );
      console.log(`📍 [PRIMARY DEVICE] Uploading regardless of distance (moved ${distance.toFixed(0)}m)`);
    }

    if (timestampOnly) {
      console.log(`💓 [LocationTracker] HEARTBEAT UPDATE - refreshing timestamp only (keeping driver online)`);
    } else if (forceUpdate) {
      console.log(`💓 [LocationTracker] EVENT-DRIVEN UPDATE - uploading coordinates + timestamp`);
    } else {
      console.log(`⏰ [LocationTracker] GPS update - moved ${distance.toFixed(0)}m, uploading coordinates + timestamp`);
    }

    // CRITICAL: Set lastUpdate BEFORE attempting upload for deduplication
    this.lastUpdate = now;
    this.lastUploadTime = now; // Track for deduplication

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

      // CRITICAL: Debug timestamp to detect future timestamps
      const now = new Date();
      const timestampDate = new Date(nowISO);
      const timeDiffMs = timestampDate.getTime() - now.getTime();
      const timeDiffSec = Math.round(timeDiffMs / 1000);

      console.log(`📤 [LocationTracker] Uploading location for ${userName} (...${userIdLast4}):`, {
        lat: latitude.toFixed(6),
        lng: longitude.toFixed(6),
        timestamp: nowISO,
        timestampOnly,
        timeDiffFromNow: `${timeDiffSec >= 0 ? '+' : ''}${timeDiffSec}s`,
        isFuture: timeDiffMs > 1000,
        localTime: now.toISOString()
      });

      // CRITICAL: Timestamp-only updates just refresh location_updated_at (keep coordinates)
      const updateData = timestampOnly ? {
        location_updated_at: nowISO
      } : {
        current_latitude: latitude,
        current_longitude: longitude,
        location_updated_at: nowISO
      };

      // Step 1: Upload this driver's location to API
      await base44.entities.AppUser.update(this.appUserId, updateData);
      console.log(`✅ [LocationTracker] UPLOADED TO API - ${userName} (...${userIdLast4}):`, {
        lat: latitude.toFixed(6),
        lon: longitude.toFixed(6),
        timestamp: nowISO,
        appUserId: this.appUserId,
        uploadedData: updateData
      });

      // Step 2: Fetch FULL AppUser data (to ensure coordinates are complete)
      const fullAppUser = await base44.entities.AppUser.filter({ id: this.appUserId });
      const updatedAppUser = fullAppUser && fullAppUser.length > 0 ? fullAppUser[0] : null;
      
      if (!updatedAppUser) {
        console.error(`❌ [LocationTracker] Failed to fetch updated AppUser after upload!`);
        return;
      }

      console.log(`✅ [LocationTracker] Fetched full AppUser data:`, {
        lat: updatedAppUser.current_latitude?.toFixed(6),
        lon: updatedAppUser.current_longitude?.toFixed(6),
        timestamp: updatedAppUser.location_updated_at,
        location_tracking_enabled: updatedAppUser.location_tracking_enabled
      });

      // Step 3: Save to offline DB
      try {
        const { offlineDB } = await import('./offlineDatabase');
        await offlineDB.save(offlineDB.STORES.APP_USERS, updatedAppUser);
        console.log(`💾 [LocationTracker] Saved AppUser to offline DB`);
      } catch (offlineError) {
        console.error('❌ [LocationTracker] FAILED TO SYNC to offline DB:', offlineError.message);
      }

      // Step 4: Dispatch event to update other devices via WebSocket
      if (typeof window !== 'undefined') {
        console.log(`📡 [LocationTracker] Dispatching driverLocationsUpdated for ${userName}`);
        window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
          detail: { 
            appUsers: [updatedAppUser], 
            singleUpdate: true,
            fromLocationTracker: true
          }
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
      if (!timestampOnly) {
        this.lastCoordinateUpdate = now;
        this.lastPosition = { latitude, longitude, accuracy };
      }
      this.lastTimestampUpdate = now; // Track timestamp updates separately
      this.failedUpdateCount = 0;
      this.backoffTime = 0;

      // CRITICAL: Collect breadcrumbs on coordinate updates (not timestamp-only) when on_duty
      if (!timestampOnly && this.driverStatus === 'on_duty') {
        await this.collectBreadcrumb(latitude, longitude, Date.now());
      }

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
            // CRITICAL: PRESERVE last known coordinates - only disable tracking flag
            const updateData = {
              location_tracking_enabled: false
              // Keep current_latitude, current_longitude, and location_updated_at intact
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
            message: 'Location updates failed multiple times. Tracking has been stopped but last location preserved.',
            error: error.message
          }
        }));
      }
    }
  }

  handleLocationSuccess(position) {
    const { latitude, longitude, accuracy } = position.coords;
    console.log(`📍 [LocationTracker] GPS position received - lat: ${latitude.toFixed(6)}, lon: ${longitude.toFixed(6)}, accuracy: ${accuracy?.toFixed(0)}m`);
    // Note: watchPosition callback doesn't upload - heartbeat interval handles all uploads
    // This just stores the position for the interval to use
    this.lastPosition = { latitude, longitude, accuracy };
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

    console.log(`🚀 [LocationTracker] Starting location tracking for ${userName} (...${userIdLast4})`);

    if (!navigator.geolocation) {
      throw new Error('Geolocation is not supported by this browser');
    }

    if (!navigator.onLine) {
      throw new Error('Device is offline. Please check your internet connection.');
    }

    this.currentUser = user;

    // CRITICAL: Check if this is the primary device BEFORE starting GPS
    try {
      const currentDevice = await getCurrentDevice(user.id);
      this.isPrimaryDevice = currentDevice?.is_primary_tracker !== false;

      console.log(`✅ [LocationTracker] Device status:`, {
        deviceId: currentDevice?.device_identifier,
        isPrimaryTracker: this.isPrimaryDevice,
        deviceName: currentDevice?.device_name
      });
      
      // CRITICAL: ALL devices with location tracking enabled can upload locations
      // Primary device is used for tie-breaking if multiple devices update simultaneously
      // This allows multi-device location sharing
    } catch (error) {
      console.error('❌ [LocationTracker] Device check FAILED - aborting GPS start:', error.message);
      throw new Error('Failed to verify device status. Please try again.');
    }
    
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

    // Breadcrumb tracking
    this.lastBreadcrumbPosition = null;
    this.minBreadcrumbDistance = 100; // 100 meters

    // Test GPS capabilities
    const capabilities = await this.checkGPSCapabilities();
    if (!capabilities.hasGeolocation) {
      throw new Error('GPS is not available on this device');
    }
    
    if (!capabilities.hasHighAccuracy) {
      console.warn('⚠️ GPS accuracy may be limited on this device');
    }

    // CRITICAL: At this point isPrimaryDevice is confirmed true, proceed with GPS
    return new Promise((resolve, reject) => {
      console.log('📍 [PRIMARY DEVICE] Starting watchPosition with high accuracy GPS...');
      this.watchId = navigator.geolocation.watchPosition(
        async (position) => {
          this.handleLocationSuccess(position);

          if (!this.isTracking) {
            this.isTracking = true;
            console.log('✅ [PRIMARY DEVICE] GPS watch established - uploading initial location now');

            // CRITICAL: Upload initial location immediately on refresh/load
            console.log('🚀 [PRIMARY DEVICE] Initial location upload:', {
              lat: position.coords.latitude.toFixed(6),
              lng: position.coords.longitude.toFixed(6),
              accuracy: position.coords.accuracy?.toFixed(0) + 'm',
              timestamp: new Date(position.timestamp).toISOString(),
              appUserId: this.appUserId
            });

            await this.updateLocationInDatabase(
              position.coords.latitude,
              position.coords.longitude,
              position.coords.accuracy,
              true, // forceUpdate
              false, // full update
              true // isPrimaryDevice
            );

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

      // Poll GPS every 15 seconds - guaranteed primary device at this point
      this.heartbeatInterval = setInterval(() => {
        if (this.isTracking) {
          if (this.lastPosition) {
            console.log('💓 [PRIMARY DEVICE] Poll interval - uploading location', {
              lat: this.lastPosition.latitude.toFixed(6),
              lng: this.lastPosition.longitude.toFixed(6),
              accuracy: this.lastPosition.accuracy?.toFixed(0) + 'm',
              appUserId: this.appUserId
            });

            this._pendingEventUpdate = false;
            this.updateLocationInDatabase(
              this.lastPosition.latitude,
              this.lastPosition.longitude,
              this.lastPosition.accuracy,
              true, // forceUpdate - skip all checks
              false, // full update with coordinates
              true // isPrimaryDevice flag
            );
          } else {
            // No GPS fix yet — try to get a fresh position directly
            console.log('⏭️ [PRIMARY DEVICE] Poll: No cached GPS position - requesting fresh fix...');
            if (navigator.geolocation) {
              navigator.geolocation.getCurrentPosition(
                (pos) => {
                  this.lastPosition = {
                    latitude: pos.coords.latitude,
                    longitude: pos.coords.longitude,
                    accuracy: pos.coords.accuracy
                  };
                  console.log('📍 [PRIMARY DEVICE] Got fresh GPS fix on demand:', this.lastPosition.latitude.toFixed(6), this.lastPosition.longitude.toFixed(6));
                  this.updateLocationInDatabase(
                    pos.coords.latitude,
                    pos.coords.longitude,
                    pos.coords.accuracy,
                    true, false, true
                  );
                },
                (err) => console.warn('⚠️ [PRIMARY DEVICE] On-demand GPS fix failed:', err.message),
                { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
              );
            }
          }
        }
      }, this.updateInterval);

      console.log(`✅ [PRIMARY DEVICE] Location tracking started - uploads every ${this.updateInterval/1000}s`);
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
    this.isPrimaryDevice = false; // Reset flag
    this.lastPosition = null;
    this.lastUpdate = 0;
    this.lastCoordinateUpdate = 0;
    this.lastTimestampUpdate = 0;
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

  /**
   * Toggle location sharing visibility
   * CRITICAL: This ONLY toggles location_tracking_enabled flag (visibility control)
   * It does NOT start/stop GPS tracking - that's handled by Dashboard auto-start
   * Primary mobile devices always track GPS, this just controls if others can see it
   */
  async toggleLocationSharing(user) {
    const newStatus = !user?.location_tracking_enabled;

    try {
      if (!navigator.onLine) {
        throw new Error('Device is offline. Please check your internet connection.');
      }

      // Get or find AppUser ID
      let appUserId = user.appUserId;
      if (!appUserId) {
        const appUsers = await base44.entities.AppUser.filter({ user_id: user.id });
        if (appUsers && appUsers.length > 0) {
          appUserId = appUsers[0].id;
        } else {
          throw new Error('User profile not found. Please contact support.');
        }
      }

      if (newStatus) {
        // TURNING ON: Make location visible to other drivers
        console.log('🟢 [Location Sharing] Enabling - others can now see my location');
        await base44.entities.AppUser.update(appUserId, {
          location_tracking_enabled: true
        });

        // Signal location tracker for immediate GPS upload
        this.signalLocationSharingToggle(true);

        return true;
      } else {
        // TURNING OFF: Hide location from other drivers
        console.log('🔴 [Location Sharing] Disabling - hiding location from others (preserving coordinates)');
        await base44.entities.AppUser.update(appUserId, {
          location_tracking_enabled: false
          // Keep coordinates and location_updated_at intact for stale marker display
        });

        // Signal location tracker
        this.signalLocationSharingToggle(false);

        if (this.currentUser) {
          this.currentUser.location_tracking_enabled = false;
        }

        window.dispatchEvent(new CustomEvent('driverLocationVisibilityChanged', {
          detail: { userId: user.id, visible: false }
        }));

        return false;
      }
    } catch (error) {
      console.error('❌ Failed to toggle location sharing:', error);
      throw error;
    }
  }

  /**
   * Calculate distance between two coordinates in meters (Haversine)
   */
  calculateDistanceInMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth's radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Distance in meters
  }

  /**
    * Collect GPS breadcrumbs (offline-first strategy)
    * CRITICAL: Only saves if driver is on_duty
    * Stores [lat, lng, timestamp_ms] in offline DB, associated with driver_id
    */
  async collectBreadcrumb(latitude, longitude, timestamp) {
    // CRITICAL: Only collect breadcrumbs if driver is on_duty
    if (this.driverStatus !== 'on_duty') {
      return;
    }

    try {
      const { offlineDB } = await import('./offlineDatabase');

      // Get or create breadcrumb collection for this driver
      const existingBreadcrumbs = await offlineDB.getById(offlineDB.STORES.PENDING_BREADCRUMBS, this.appUserId);

      const breadcrumbPoint = [latitude, longitude, timestamp];

      const breadcrumbData = {
        driver_id: this.appUserId,
        timestamp: timestamp,
        breadcrumbs: existingBreadcrumbs?.breadcrumbs ? [...existingBreadcrumbs.breadcrumbs, breadcrumbPoint] : [breadcrumbPoint]
      };

      await offlineDB.save(offlineDB.STORES.PENDING_BREADCRUMBS, breadcrumbData);
      console.log(`🍞 [LocationTracker] Collected breadcrumb for driver ${this.appUserId}: [${latitude.toFixed(6)}, ${longitude.toFixed(6)}]`);
    } catch (error) {
      console.warn(`⚠️ [LocationTracker] Failed to collect breadcrumb:`, error.message);
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