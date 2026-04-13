import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';
import { isMobileDevice as checkIsMobileDevice } from './deviceUtils';
import { getRouteOptimizationSettings } from '../dashboard/RouteOptimizationSettings';
import { liveDistanceTracker } from './liveDistanceTracker';
import { getCurrentDevice, updateDeviceLastActive } from './deviceManager';
import { arrivalTimeDetector } from './arrivalTimeDetector';
import { getLocationProvider } from './locationProviders';
import { getCapacitorPlatform, getNativeLocationAuthorization, isCapacitorNativeApp, requestNativeLocationAuthorization } from './locationProviders/capacitorRuntime';
import { getLocalDateString, getLocalTimestamp } from './localTimeHelper';

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

        // Distance threshold - only upload if moved at least 100m
        this.minDistanceChange = 100; // 100 meters minimum movement to trigger upload

        // Deduplication - prevent duplicate updates within 2 seconds
        this.lastUploadTime = 0;
        this.minTimeBetweenUploads = 2000; // 2 second minimum between uploads

        // Heartbeat timestamp updates - keep location fresh even when stationary
        this.lastTimestampUpdate = 0;
        this.timestampUpdateInterval = 120000; // 2 minutes - balanced heartbeat to prevent stale mode

        this.failedUpdateCount = 0;
        this.maxFailedUpdates = 3;
        this.backoffTime = 0;
        this.lastSuccessfulUpdate = 0;
        this.deviceCapabilities = null;
        this.locationProvider = getLocationProvider();
        this.isPrimaryDevice = false;

        // Event-driven updates tracking
        this._pendingEventUpdate = false;
        this._eventUpdateTime = 0;

        // Track current delivery date for arrival detection
        this.currentDeliveryDate = null;
        this.lastEtaRefreshPosition = null;
        this.lastEtaRefreshAt = 0;
        this.minEtaRefreshDistance = 500;
        this.minTimeBetweenEtaRefresh = 120000;
        this.lastBreadcrumbSavedAt = 0;
        this.breadcrumbSaveInterval = 30000;

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

      // 100m minimum movement threshold
      this.minDistanceChange = 100;

      console.log(`📍 [LocationTracker] Interval: ${this.updateInterval / 1000}s, distance threshold: ${this.minDistanceChange}m`);
    } catch (error) {
      console.warn('⚠️ Could not load route optimization settings, using defaults');
      this.updateInterval = 15000; // Default 15 seconds
      this.minDistanceChange = 100; // Default 100m
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

  shouldKeepNativeTrackingAlive() {
    return this.isPrimaryDevice && (this.driverStatus === 'on_duty' || this.driverStatus === 'on_break');
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
    return checkIsMobileDevice() || this.locationProvider?.backgroundCapable === true;
  }

  /**
   * Check if device has GPS capabilities with high accuracy
   */
  async checkGPSCapabilities() {
    if (this.deviceCapabilities !== null) {
      return this.deviceCapabilities;
    }

    const provider = getLocationProvider();
    this.locationProvider = provider;

    if (!provider.isAvailable()) {
      this.deviceCapabilities = {
        hasGeolocation: false,
        hasHighAccuracy: false,
        error: 'Location provider not available'
      };
      return this.deviceCapabilities;
    }

    try {
      const position = await provider.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 5000,
        maximumAge: 0,
        requestPermissions: true
      });
      const accuracy = position.coords.accuracy;
      const hasHighAccuracy = accuracy && accuracy < 100;

      this.deviceCapabilities = {
        hasGeolocation: true,
        hasHighAccuracy,
        accuracy,
        error: null,
        provider: provider.name
      };
    } catch (error) {
      this.deviceCapabilities = {
        hasGeolocation: true,
        hasHighAccuracy: false,
        error: error.message,
        provider: provider.name
      };
    }

    return this.deviceCapabilities;
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

    // Background throttle: when app is not visible, limit coordinate uploads (battery saver)
    if (typeof document !== 'undefined' && document.hidden && !forceUpdate && !timestampOnly) {
      if (now - this.lastCoordinateUpdate < 60000) { // at most once per 60s while hidden
        console.log('⏸️ [LocationTracker] Page hidden - skipping upload to save battery');
        return;
      }
    }

    // CRITICAL: On-duty drivers always upload coordinates every poll cycle.
    // Distance is still calculated for logging/analytics only.
    let distance = 0;
    if (this.lastPosition) {
      distance = this.calculateDistance(
        this.lastPosition.latitude,
        this.lastPosition.longitude,
        latitude,
        longitude
      );
    }

    if (timestampOnly) {
      console.log(`💓 [LocationTracker] HEARTBEAT UPDATE - refreshing timestamp only (keeping driver online)`);
    } else if (forceUpdate) {
      console.log(`💓 [LocationTracker] EVENT-DRIVEN UPDATE - uploading coordinates + timestamp`);
    } else {
      console.log(`⏰ [LocationTracker] GPS update - moved ${distance.toFixed(0)}m, uploading coordinates + timestamp (threshold ${this.minDistanceChange}m)`);
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

      const nowISO = getLocalTimestamp();

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

      // Step 3: Save to offline DB (dual-write) AND dispatch to in-memory context before broadcasting
      try {
        const { offlineDB } = await import('./offlineDatabase');
        await offlineDB.save(offlineDB.STORES.APP_USERS, updatedAppUser);
        console.log(`💾 [LocationTracker] Saved AppUser to offline DB`);

        // Immediately dispatch to AppDataContext via custom event so UI prefers newest
        window.dispatchEvent(new CustomEvent('appUserUpdated', {
          detail: { appUser: updatedAppUser, fromLocationTracker: true }
        }));
      } catch (offlineError) {
        console.error('❌ [LocationTracker] FAILED TO SYNC to offline DB:', offlineError.message);
      }

      // Step 4: Dispatch locally and broadcast so other devices update immediately
      if (typeof window !== 'undefined') {
        console.log(`📡 [LocationTracker] Dispatching driverLocationsUpdated for ${userName}`);
        window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
          detail: { 
            appUsers: [updatedAppUser], 
            singleUpdate: true,
            fromLocationTracker: true,
            mergeMode: 'merge' // Ensures this is treated as single targeted update, not full replacement
          }
        }));
      }
      await broadcastMutation('AppUser', 'update', updatedAppUser.id, updatedAppUser);

      // CRITICAL: Always update UserDevice last_active_at for primary tracker
      const currentDevice = await getCurrentDevice(this.currentUser.id);
      if (currentDevice) {
        await updateDeviceLastActive(this.currentUser.id, currentDevice);
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

      // CRITICAL: Breadcrumbs run on their own 30s cycle while on duty.
      if (this.driverStatus === 'on_duty') {
        await this.collectBreadcrumb(latitude, longitude, Date.now());
      }

      // CRITICAL: Check for arrival at delivery locations when on_duty
      if (!timestampOnly && this.driverStatus === 'on_duty' && this.currentDeliveryDate) {
        await arrivalTimeDetector.processLocationUpdate(
          latitude, 
          longitude, 
          this.currentUser?.id, 
          this.currentDeliveryDate
        );
      }

      // CRITICAL: Trigger Type 1 polyline regeneration on location upload (backend will check deviation/origin change)
      if (!timestampOnly && this.driverStatus === 'on_duty' && this.currentUser?.id && this.currentDeliveryDate) {
        base44.functions.invoke('regenerateType1Polyline', {
          driverId: this.currentUser.id,
          deliveryDate: this.currentDeliveryDate,
          currentLocation: { lat: latitude, lng: longitude }
        }).catch((polylineError) => {
          console.warn('⚠️ [LocationTracker] Type 1 polyline regeneration skipped:', polylineError?.message || polylineError);
        });
      }

      if (!timestampOnly && this.driverStatus === 'on_duty' && this.currentDeliveryDate && this.currentUser?.id) {
        const previousEtaPosition = this.lastEtaRefreshPosition;
        const distanceSinceEtaRefresh = previousEtaPosition
          ? this.calculateDistanceInMeters(
              previousEtaPosition.latitude,
              previousEtaPosition.longitude,
              latitude,
              longitude
            )
          : Infinity;
        const enoughTimePassed = now - this.lastEtaRefreshAt >= this.minTimeBetweenEtaRefresh;
        const movedEnough = !previousEtaPosition || distanceSinceEtaRefresh >= this.minEtaRefreshDistance;

        if (movedEnough && enoughTimePassed) {
          this.lastEtaRefreshPosition = { latitude, longitude };
          this.lastEtaRefreshAt = now;
          base44.functions.invoke('refreshDriverEtasOnLocationUpdate', {
            data: {
              ...updatedAppUser,
              previous_latitude: previousEtaPosition?.latitude ?? null,
              previous_longitude: previousEtaPosition?.longitude ?? null
            },
            old_data: previousEtaPosition ? {
              current_latitude: previousEtaPosition.latitude,
              current_longitude: previousEtaPosition.longitude
            } : null
          }).catch((etaError) => {
            console.warn('⚠️ [LocationTracker] ETA refresh skipped:', etaError?.message || etaError);
          });
        }
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

      // If too many upload failures, keep native tracking alive on the primary device.
      if (this.failedUpdateCount >= this.maxFailedUpdates) {
        const keepTrackingAlive = this.shouldKeepNativeTrackingAlive();
        console.error(`❌ Too many failed updates, ${keepTrackingAlive ? 'keeping native tracking alive' : 'stopping location tracking'}`);

        if (!keepTrackingAlive) {
          this.stopTracking();
        }

        try {
          if (this.appUserId) {
            // Preserve last known coordinates - only disable visibility flag after repeated upload failures
            const updateData = {
              location_tracking_enabled: false
            };
            await base44.entities.AppUser.update(this.appUserId, updateData);

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
            message: keepTrackingAlive
              ? 'Location uploads failed multiple times. Tracking is still running on this primary device, but sharing was turned off.'
              : 'Location updates failed multiple times. Tracking has been stopped but last location preserved.',
            error: error.message
          }
        }));
      }
    }
  }

  async handleLocationSuccess(position) {
    const { latitude, longitude, accuracy } = position.coords;
    const timestamp = position.timestamp || Date.now();
    console.log(`📍 [LocationTracker] GPS position received - lat: ${latitude.toFixed(6)}, lon: ${longitude.toFixed(6)}, accuracy: ${accuracy?.toFixed(0)}m`);
    this.lastPosition = { latitude, longitude, accuracy };

    if (typeof window !== 'undefined') {
      const detail = {
        userId: this.currentUser?.id,
        latitude,
        longitude,
        accuracy,
        timestamp: getLocalTimestamp(),
        source: this.locationProvider?.name || 'web'
      };
      window.dispatchEvent(new CustomEvent('driverPositionUpdated', { detail }));
      window.dispatchEvent(new CustomEvent('driverLocationChanged', { detail }));
    }

    if (this.isTracking && this.locationProvider?.backgroundCapable) {
    await this.updateLocationInDatabase(
    latitude,
    longitude,
    accuracy,
    false,
    false,
    this.isPrimaryDevice
    );
    }
  }

  handleLocationError(error) {
    console.error('❌ Location error:', error);

    let errorMessage = 'Unknown location error';
    const errorCode = error?.code;

    if (errorCode === 1 || errorCode === 'NOT_AUTHORIZED') {
      errorMessage = 'Location permission denied. Please enable location access on your device.';
      this.stopTracking();
    } else if (errorCode === 2 || errorCode === 'POSITION_UNAVAILABLE') {
      errorMessage = 'Location information unavailable. Please check your device GPS.';
    } else if (errorCode === 3 || errorCode === 'TIMEOUT') {
      errorMessage = 'Location request timed out. Retrying...';
    }

    window.dispatchEvent(new CustomEvent('locationTrackingError', {
      detail: { message: errorMessage, code: errorCode }
    }));

    return { success: false, message: errorMessage, code: errorCode };
  }

  async startTracking(user, deliveryDate = null) {
    if (!user) {
      throw new Error('User is required to start tracking');
    }

    if (!this.isMobileDevice()) {
      throw new Error('Location tracking is only available on mobile devices (phones/tablets)');
    }

    if (isCapacitorNativeApp() && getCapacitorPlatform() === 'android') {
      const nativePermission = await requestNativeLocationAuthorization();
      if (!nativePermission.granted) {
        throw new Error('Location permission denied. Please allow location access in Android settings.');
      }
    }

    if (this.isTracking) {
      console.log('📍 [LocationTracker] Already tracking - skipping start');
      return;
    }

    // Set delivery date for arrival tracking
    if (deliveryDate) {
      this.currentDeliveryDate = deliveryDate;
    }

    const userName = user.user_name || user.full_name || 'Unknown';
    const userIdLast4 = user.id ? user.id.slice(-4) : '????';

    console.log(`🚀 [LocationTracker] Starting location tracking for ${userName} (...${userIdLast4})`);

    this.locationProvider = getLocationProvider();

    if (!this.locationProvider.isAvailable()) {
      throw new Error('Location services are not available on this device');
    }

    if (!navigator.onLine) {
      throw new Error('Device is offline. Please check your internet connection.');
    }

    this.currentUser = user;

    // CRITICAL: Check if this is the primary device BEFORE starting GPS
    try {
      const currentDevice = await getCurrentDevice(user.id);
      // If no device record found, treat as primary (default behavior)
      this.isPrimaryDevice = currentDevice === null || currentDevice?.is_primary_tracker !== false;

      console.log(`✅ [LocationTracker] Device status:`, {
        deviceId: currentDevice?.device_identifier || 'NOT REGISTERED',
        isPrimaryTracker: this.isPrimaryDevice,
        deviceName: currentDevice?.device_name || 'No device record - treating as PRIMARY'
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
    this.lastBreadcrumbSavedAt = 0;

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
    return new Promise(async (resolve, reject) => {
      try {
        const providerName = (this.locationProvider?.name || 'web').toUpperCase();
        console.log(`📍 [${providerName} PROVIDER] Starting location watch...`);

        this.watchId = await this.locationProvider.watchPosition(
          async (position) => {
            if (!this.isTracking) {
              this.isTracking = true;
              console.log(`✅ [${providerName} PROVIDER] GPS watch established - uploading initial location now`);

              console.log(`🚀 [${providerName} PROVIDER] Initial location upload:`, {
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
                true,
                false,
                true
              );

              resolve();
              return;
            }

            await this.handleLocationSuccess(position);
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
            timeout: 30000,
            maximumAge: 0,
            requestPermissions: true,
            distanceFilter: 0,
            interval: 15000,
            fastestInterval: 10000,
            backgroundTitle: 'RxDeliver location tracking',
            backgroundMessage: 'Tracking delivery location in the background.'
          }
        );

        const useNativeBackgroundWatcher = this.locationProvider?.backgroundCapable === true;

        if (!useNativeBackgroundWatcher) {
          this.heartbeatInterval = setInterval(() => {
            if (this.isTracking) {
              if (this.lastPosition) {
                console.log(`💓 [${providerName} PROVIDER] Poll interval - uploading location`, {
                  lat: this.lastPosition.latitude.toFixed(6),
                  lng: this.lastPosition.longitude.toFixed(6),
                  accuracy: this.lastPosition.accuracy?.toFixed(0) + 'm',
                  appUserId: this.appUserId
                });

                this._pendingEventUpdate = false;
                const shouldRefreshTimestampOnly = this.driverStatus !== 'off_duty';
                this.updateLocationInDatabase(
                  this.lastPosition.latitude,
                  this.lastPosition.longitude,
                  this.lastPosition.accuracy,
                  false,
                  shouldRefreshTimestampOnly,
                  this.isPrimaryDevice
                );
              } else {
                console.log(`⏭️ [${providerName} PROVIDER] Poll: No cached GPS position - requesting fresh fix...`);
                this.locationProvider.getCurrentPosition({
                  enableHighAccuracy: true,
                  timeout: 5000,
                  maximumAge: 0,
                  requestPermissions: true
                }).then((pos) => {
                  this.lastPosition = {
                    latitude: pos.coords.latitude,
                    longitude: pos.coords.longitude,
                    accuracy: pos.coords.accuracy
                  };
                  console.log(`📍 [${providerName} PROVIDER] Got fresh GPS fix on demand:`, this.lastPosition.latitude.toFixed(6), this.lastPosition.longitude.toFixed(6));
                  this.updateLocationInDatabase(
                    pos.coords.latitude,
                    pos.coords.longitude,
                    pos.coords.accuracy,
                    false,
                    false,
                    this.isPrimaryDevice
                  );
                }).catch((err) => console.warn(`⚠️ [${providerName} PROVIDER] On-demand GPS fix failed:`, err.message));
              }
            }
          }, this.updateInterval);
        }

        console.log(`✅ [${providerName} PROVIDER] Location tracking started${useNativeBackgroundWatcher ? ' - streaming native updates' : ` - uploads every ${this.updateInterval/1000}s`}`);
      } catch (error) {
        console.error('❌ Failed to start location provider:', error);
        reject(this.handleLocationError(error));
      }
    });
  }

  stopTracking() {
    if (this.watchId !== null) {
      const activeWatchId = this.watchId;
      this.watchId = null;
      Promise.resolve(this.locationProvider?.clearWatch(activeWatchId)).catch((error) => {
        console.warn('⚠️ [LocationTracker] Failed to clear location watch:', error?.message || error);
      });
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
    this.currentDeliveryDate = null;
    this.lastBreadcrumbPosition = null;
    this.lastBreadcrumbSavedAt = 0;
    this.lastEtaRefreshPosition = null;
    this.lastEtaRefreshAt = 0;
    
    // Clear arrival detection state
    arrivalTimeDetector.clearRecordedArrivals();
  }

  async restartTracking(user, deliveryDate = null) {
    this.stopTracking();
    await new Promise(resolve => setTimeout(resolve, 500));
    
    try {
      await this.startTracking(user, deliveryDate);
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
        // TURNING OFF: Hide location from other drivers only
        console.log('🔴 [Location Sharing] Disabling visibility only - background tracking stays active on the primary device');
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
  async clearStalePendingBreadcrumbs() {
    this.lastBreadcrumbPosition = null;
  }

  async collectBreadcrumb(latitude, longitude, timestamp) {
    if (this.driverStatus !== 'on_duty' || !this.appUserId || !this.currentUser?.id) {
      return;
    }

    if (this.lastBreadcrumbSavedAt && timestamp - this.lastBreadcrumbSavedAt < this.breadcrumbSaveInterval) {
      console.log(`🍞 [LocationTracker] Skipping breadcrumb - waiting ${Math.ceil((this.breadcrumbSaveInterval - (timestamp - this.lastBreadcrumbSavedAt)) / 1000)}s for 30s interval`);
      return;
    }


    try {
      const { offlineDB } = await import('./offlineDatabase');
      const { buildPendingBreadcrumbKey } = await import('./pendingBreadcrumbsManager');

      const deliveryDate = this.currentDeliveryDate || getLocalDateString();
      const deliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, deliveryDate);
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const driverDeliveries = (deliveries || []).filter((delivery) => delivery?.driver_id === this.currentUser.id);
      const activeDelivery = driverDeliveries.find((delivery) => delivery?.isNextDelivery === true)
        || driverDeliveries
          .filter((delivery) => !finishedStatuses.includes(delivery?.status) && delivery?.status !== 'pending')
          .sort((a, b) => Number(a?.stop_order || 0) - Number(b?.stop_order || 0))[0];

      if (!activeDelivery?.id) {
        return;
      }

      const stopOrder = Number(activeDelivery?.stop_order || activeDelivery?.display_stop_order || 0);
      const pendingKey = buildPendingBreadcrumbKey({
        appUserId: this.appUserId,
        deliveryId: activeDelivery.id,
        stopOrder
      });

      const existingBreadcrumbs = await offlineDB.getById(offlineDB.STORES.PENDING_BREADCRUMBS, pendingKey);
      const breadcrumbPoint = [latitude, longitude, timestamp];

      let initialPoints = [];
      if (!existingBreadcrumbs?.breadcrumbs?.length) {
        // New leg starting — prepend the previous finished stop's GPS coords as the origin point
        const finishedStatuses2 = ['completed', 'failed', 'cancelled', 'returned'];
        const previousFinishedStop = driverDeliveries
          .filter((d) => finishedStatuses2.includes(d?.status) && (d?.stop_order || 0) < stopOrder)
          .sort((a, b) => Number(b?.stop_order || 0) - Number(a?.stop_order || 0))[0];

        if (previousFinishedStop) {
          // Try to get coords from the patient/store associated with the previous stop
          let prevLat = null;
          let prevLon = null;

          if (previousFinishedStop.patient_id) {
            const patients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
            const prevPatient = (patients || []).find((p) => p?.id === previousFinishedStop.patient_id);
            prevLat = prevPatient?.latitude;
            prevLon = prevPatient?.longitude;
          } else if (previousFinishedStop.store_id) {
            const stores = await offlineDB.getAll(offlineDB.STORES.STORES);
            const prevStore = (stores || []).find((s) => s?.id === previousFinishedStop.store_id);
            prevLat = prevStore?.latitude;
            prevLon = prevStore?.longitude;
          }

          if (prevLat && prevLon) {
            // Point 1: last finished stop location (use its actual_delivery_time as timestamp, or slightly before now)
            const originTimestamp = previousFinishedStop.actual_delivery_time
              ? new Date(previousFinishedStop.actual_delivery_time).getTime()
              : timestamp - 60000;
            initialPoints.push([prevLat, prevLon, originTimestamp]);
            // Point 2: driver's current location (this GPS ping) — becomes the second point
            // (breadcrumbPoint below will be added as normal)
          }
        }
      }

      const breadcrumbData = {
        id: pendingKey,
        driver_id: this.currentUser.id,
        owner_driver_id: this.appUserId,
        driver_user_id: this.currentUser.id,
        delivery_id: activeDelivery.id,
        delivery_date: activeDelivery.delivery_date,
        stop_order: stopOrder,
        stop_label: `Stop ${stopOrder || 0}`,
        timestamp,
        breadcrumbs: existingBreadcrumbs?.breadcrumbs?.length
          ? [...existingBreadcrumbs.breadcrumbs, breadcrumbPoint]
          : [...initialPoints, breadcrumbPoint]
      };

      await offlineDB.save(offlineDB.STORES.PENDING_BREADCRUMBS, breadcrumbData);
      try {
        const liveRecord = await base44.entities.PendingBreadcrumbLive.filter({
          driver_id: this.currentUser.id,
          delivery_id: activeDelivery.id
        });
        if (liveRecord && liveRecord[0]?.id) {
          await base44.entities.PendingBreadcrumbLive.update(liveRecord[0].id, {
            stop_order: stopOrder,
            breadcrumbs: breadcrumbData.breadcrumbs
          });
        } else {
          await base44.entities.PendingBreadcrumbLive.create({
            driver_id: this.currentUser.id,
            delivery_id: activeDelivery.id,
            stop_order: stopOrder,
            breadcrumbs: breadcrumbData.breadcrumbs
          });
        }
      } catch (error) {
        const isRateLimited = error?.response?.status === 429 || error?.status === 429 || error?.message?.includes('429') || error?.message?.toLowerCase?.().includes('rate limit');
        if (!isRateLimited) {
          console.warn(`⚠️ [LocationTracker] Live breadcrumb write skipped:`, error.message);
        } else {
          console.warn(`⚠️ [LocationTracker] Live breadcrumb rate-limited, skipping this point`);
        }
      }
      this.lastBreadcrumbPosition = { latitude, longitude, timestamp };
      this.lastBreadcrumbSavedAt = timestamp;
      window.dispatchEvent(new CustomEvent('breadcrumbCollected', {
        detail: {
          driverId: this.currentUser?.id,
          appUserId: this.appUserId,
          deliveryId: activeDelivery.id,
          deliveryDate: activeDelivery.delivery_date,
          stopOrder,
          point: { lat: latitude, lng: longitude, timestamp }
        }
      }));
      console.log(`🍞 [LocationTracker] Collected breadcrumb for ${pendingKey}: [${latitude.toFixed(6)}, ${longitude.toFixed(6)}]`);
    } catch (error) {
      console.warn(`⚠️ [LocationTracker] Failed to collect breadcrumb:`, error.message);
    }
  }

  /**
   * Set current delivery date for arrival tracking
   * Call this from Dashboard when date changes
   */
  setDeliveryDate(deliveryDate) {
    this.currentDeliveryDate = deliveryDate;
    console.log(`📅 [LocationTracker] Set delivery date for arrival tracking: ${deliveryDate}`);
  }

  async refreshNow(options = {}) {
    if (!this.isTracking || !this.currentUser || !this.appUserId) return false;

    try {
      const position = await this.locationProvider.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 5000,
        maximumAge: 0,
        requestPermissions: false
      });

      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;
      const accuracy = position.coords.accuracy;

      this.lastPosition = { latitude, longitude, accuracy };

      await this.updateLocationInDatabase(
        latitude,
        longitude,
        accuracy,
        true,
        false,
        this.isPrimaryDevice
      );

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('driverLocationFocusRefresh', {
          detail: {
            userId: this.currentUser?.id,
            latitude,
            longitude,
            accuracy,
            source: options.source || 'focus'
          }
        }));
      }

      return true;
    } catch (error) {
      console.warn('⚠️ [LocationTracker] Immediate refresh failed:', error?.message || error);
      return false;
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
       providerName: this.locationProvider?.name || 'web',
       updateInterval: this.updateInterval,
       minDistanceChange: this.minDistanceChange
     };
   }

   reloadSettings() {
     this.loadSettings();
   }
}

export const locationTracker = new LocationTracker();