import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';
import { isMobileDevice as checkIsMobileDevice, getUserAgentInfo } from './deviceUtils';
import { getRouteOptimizationSettings } from '../dashboard/RouteOptimizationSettings';
import { liveDistanceTracker } from './liveDistanceTracker';
import { getCurrentDevice, updateDeviceLastActive } from './deviceManager';
import { arrivalTimeDetector } from './arrivalTimeDetector';
import { getLocationProvider } from './locationProviders';
import { getCapacitorPlatform, getNativeLocationAuthorization, isCapacitorNativeApp, requestNativeLocationAuthorization } from './locationProviders/capacitorRuntime';
import { getLocalDateString, getLocalTimestamp } from './localTimeHelper';
import { calculateDistance, calculateDistanceInMeters } from './locationTrackerMath';
import { syncUpdatedAppUser } from './locationTrackerBroadcast';
import { collectBreadcrumbForTracker } from './locationBreadcrumbService';

class LocationTracker {
    constructor() {
        this.watchId = null;
        this.heartbeatInterval = null; // Poll GPS every 15 seconds (drivers) or timestamp-only every 60s (dispatchers/admins)
        this.isTracking = false;
        this.lastPosition = null;
        this.lastUpdate = 0;
        this.lastCoordinateUpdate = 0;
        this.currentUser = null;
        this.appUserId = null;
        this.driverStatus = 'off_duty';
        this.userRoles = []; // Populated on startTracking — drives mode selection
        this.updateInterval = 15000; // 15 seconds GPS polling (drivers only)
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
        this.allowNonPrimaryPolylineRefresh = false;

        // Event-driven updates tracking
        this._pendingEventUpdate = false;
        this._eventUpdateTime = 0;

        // Track current delivery date for arrival detection
        this.currentDeliveryDate = null;
        this.lastEtaRefreshPosition = null;
        this.lastEtaRefreshAt = 0;
        this.minEtaRefreshDistance = 500;
        this.minTimeBetweenEtaRefresh = 120000;
        this.lastPolylineRefreshPosition = null;
        this.lastPolylineRefreshAt = 0;
        this.minPolylineRefreshDistance = 100;
        this.minTimeBetweenPolylineRefresh = 30000;
        this.lastBreadcrumbSavedAt = 0;
        this.breadcrumbSaveInterval = 5000; // 5 seconds — offline DB write frequency
        this.breadcrumbInterval = null; // Independent 5s timer for breadcrumb collection
        this.lastHeartbeatAt = 0;
        this.lastFocusLostAt = 0;

      // Load settings from RouteOptimizationSettings
      this.loadSettings();
    }

  /**
   * Load tracking settings from RouteOptimizationSettings
   */
  loadSettings() {
    try {
      getRouteOptimizationSettings();
      this.updateInterval = 15000; // 15s GPS polling — drivers only
      this.minDistanceChange = 100;
      this.breadcrumbSaveInterval = 5000; // 5s — offline DB write frequency, on_duty drivers only
      console.log(`📍 [LocationTracker] Interval: ${this.updateInterval / 1000}s, breadcrumb: ${this.breadcrumbSaveInterval / 1000}s, distance: ${this.minDistanceChange}m`);
    } catch (error) {
      console.warn('⚠️ Could not load route optimization settings, using defaults');
      this.updateInterval = 15000;
      this.minDistanceChange = 100;
      this.breadcrumbSaveInterval = 5000;
    }
  }

  /**
   * Returns true if the current user is a dispatcher or admin (but NOT a driver).
   * These roles get timestamp-only heartbeat — no GPS polling.
   */
  _isDispatcherOrAdminOnly() {
    const roles = this.userRoles || [];
    const isDriver = roles.includes('driver');
    const isDispatcherOrAdmin = roles.includes('dispatcher') || roles.includes('admin');
    return isDispatcherOrAdmin && !isDriver;
  }

  /**
   * Start a timestamp-only heartbeat for dispatchers/admins.
   * Fires once per 60 seconds — only updates location_updated_at, never coordinates.
   */
  async _startDispatcherHeartbeat() {
    if (!this.appUserId || !this.currentUser) return;
    this._clearHeartbeat();
    this.isTracking = true;
    this._dispatcherHeartbeatMode = true;

    const doHeartbeat = async () => {
      if (!this.isTracking || !this._dispatcherHeartbeatMode) return;
      if (!navigator.onLine || !this.appUserId) return;
      try {
        const nowISO = getLocalTimestamp();
        await base44.entities.AppUser.update(this.appUserId, { location_updated_at: nowISO });
        this.lastHeartbeatAt = Date.now();
        console.log(`💓 [LocationTracker] Dispatcher/Admin heartbeat sent`);
      } catch (err) {
        console.warn('⚠️ [LocationTracker] Dispatcher heartbeat failed:', err?.message);
      }
    };

    // Send immediately on start, then repeat every 60s
    await doHeartbeat();
    this.heartbeatInterval = setInterval(doHeartbeat, 60000);
    console.log(`📍 [LocationTracker] Dispatcher/Admin heartbeat-only mode started (60s interval, no GPS)`);
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

  enableNonPrimaryPolylineRefresh() {
    this.allowNonPrimaryPolylineRefresh = true;
  }

  disableNonPrimaryPolylineRefresh() {
    this.allowNonPrimaryPolylineRefresh = false;
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
   * Start web-only location tracking (heartbeat interval, no native background GPS).
   * Used when driver is off_duty — keeps shared location marker fresh on other devices
   * without draining battery via background tracking.
   */
  async startWebOnlyTracking(user) {
    if (!user) return;
    if (this.isTracking) return; // already tracking (e.g. on_duty)

    this.currentUser = user;
    this.driverStatus = user.driver_status || 'off_duty';
    this.userRoles = Array.isArray(user.app_roles) ? user.app_roles : [];

    // CRITICAL: Check primary device status from the database — do NOT assume primary
    try {
      const currentDevice = await getCurrentDevice(user.id);
      this.isPrimaryDevice = currentDevice !== null && currentDevice?.status !== 'inactive' && currentDevice?.is_primary_tracker === true;
      console.log(`📱 [LocationTracker] Web-only mode — isPrimary: ${this.isPrimaryDevice} (device: ${currentDevice?.device_name || 'NOT REGISTERED'})`);
    } catch (_) {
      this.isPrimaryDevice = false;
    }

    // CRITICAL: Non-primary devices must not run the web-only heartbeat
    if (!this.isPrimaryDevice) {
      console.log(`🚫 [LocationTracker] Non-primary device — skipping web-only tracking`);
      return;
    }

    // Dispatcher/Admin: timestamp-only heartbeat, no GPS
    if (this._isDispatcherOrAdminOnly()) {
      console.log(`📡 [LocationTracker] Dispatcher/Admin web-only — starting timestamp-only heartbeat`);
      try {
        const appUsers = await base44.entities.AppUser.filter({ user_id: user.id });
        if (appUsers && appUsers.length > 0) this.appUserId = user.appUserId || appUsers[0].id;
      } catch (_) {}
      if (!this.appUserId) return;
      await this._startDispatcherHeartbeat();
      return;
    }

    try {
      const appUsers = await base44.entities.AppUser.filter({ user_id: user.id });
      if (appUsers && appUsers.length > 0) {
        this.appUserId = user.appUserId || appUsers[0].id;
      }
    } catch (_) {}

    if (!this.appUserId) return;

    // Get an initial GPS fix
    try {
      const provider = getLocationProvider();
      if (provider.isAvailable()) {
        const pos = await provider.getCurrentPosition({
          enableHighAccuracy: true,
          timeout: 8000,
          maximumAge: 30000,
          requestPermissions: true
        });
        this.lastPosition = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        };
        // Upload initial fix immediately
        await this.updateLocationInDatabase(
          pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy,
          true, false, true
        );
      }
    } catch (_) {}

    // Start a lightweight heartbeat — same 15s interval, no watchPosition / native watcher
    this._clearHeartbeat(); // Guard: ensure no stale interval before starting a new one
    this.isTracking = true;
    this._webOnlyMode = true;
    const providerName = 'WEB-ONLY';
    this.heartbeatInterval = setInterval(async () => {
      if (!this.isTracking || !this._webOnlyMode) return;
      try {
        const provider = getLocationProvider();
        if (provider.isAvailable()) {
          const pos = await provider.getCurrentPosition({
            enableHighAccuracy: true,
            timeout: 5000,
            maximumAge: 0,
            requestPermissions: false
          });
          this.lastPosition = {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy
          };
          await this.updateLocationInDatabase(
            pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy,
            false, false, true
          );
        } else if (this.lastPosition) {
          await this.updateLocationInDatabase(
            this.lastPosition.latitude, this.lastPosition.longitude,
            this.lastPosition.accuracy, false, true, true
          );
        }
      } catch (_) {}
    }, this.updateInterval);

    console.log(`📍 [LocationTracker] Web-only tracking started (off-duty heartbeat every ${this.updateInterval / 1000}s)`);
  }

  /**
   * Enhanced mobile device detection using centralized utility
   */
  isMobileDevice() {
    // Allow Mobile AND Tablet devices (both use touch GPS on phones/tablets).
    // Also allow native app providers regardless of UA detection.
    try {
      const { deviceType } = getUserAgentInfo();
      if (deviceType === 'Mobile' || deviceType === 'Tablet') return true;
    } catch (_) {}
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
    return calculateDistance(lat1, lon1, lat2, lon2);
  }

  // CRITICAL: Clears any running heartbeat interval and nulls the ref.
  // Always call this before setting a new interval to prevent double-interval overlap.
  _clearHeartbeat() {
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
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
    // SKIP this throttle on native — the BackgroundGeolocationService manages its own delivery
    // rate natively and we should not discard positions it worked hard to obtain.
    const isNativeBackground = this.locationProvider?.backgroundCapable === true;
    if (!isNativeBackground && typeof document !== 'undefined' && document.hidden && !forceUpdate && !timestampOnly) {
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

    // CRITICAL: Non-primary devices must not write ANYTHING to AppUser — no coordinates, no timestamps.
    // The primary device is the sole owner of the authoritative GPS record.
    if (!this.isPrimaryDevice) {
      console.log(`🚫 [LocationTracker] NON-PRIMARY DEVICE — skipping all AppUser writes (no coords, no timestamp)`);
      return;
    }

    if (forceUpdate) {
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

      // Primary device always writes full coordinates + timestamp
      const updateData = {
        current_latitude: latitude,
        current_longitude: longitude,
        location_updated_at: nowISO
      };

      // Step 1: Upload this driver's location to API
      const savedAppUser = await base44.entities.AppUser.update(this.appUserId, updateData);
      console.log(`✅ [LocationTracker] UPLOADED TO API - ${userName} (...${userIdLast4}):`, {
        lat: latitude.toFixed(6),
        lon: longitude.toFixed(6),
        timestamp: nowISO,
        appUserId: this.appUserId,
        uploadedData: updateData
      });

      // Step 2: Build the broadcast record from what we just wrote (no extra fetch round-trip).
      // Merge with cached currentUser fields so the record is complete for offline DB + WebSocket.
      const updatedAppUser = {
        ...(this.currentUser || {}),
        id: this.appUserId,
        user_id: this.currentUser?.id,
        ...savedAppUser,
        // Always ensure our freshly-written coordinates + timestamp are authoritative
        current_latitude: latitude,
        current_longitude: longitude,
        location_updated_at: nowISO,
      };

      await syncUpdatedAppUser({ updatedAppUser, currentUser: this.currentUser });

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
      this.lastTimestampUpdate = now;
      this.lastHeartbeatAt = now;
      this.failedUpdateCount = 0;
      this.backoffTime = 0;

      // Breadcrumbs are collected on their own independent 5s timer — not here.

      // CRITICAL: Check for arrival at delivery locations on every GPS/heartbeat update while on duty
      if (this.driverStatus === 'on_duty' && this.currentDeliveryDate) {
        await arrivalTimeDetector.processLocationUpdate(
          latitude,
          longitude,
          this.currentUser?.id,
          this.currentDeliveryDate
        );
      }

      // Type 1 polyline regeneration is handled by explicit route-change flows only.

      if (this.driverStatus === 'on_duty' && this.currentDeliveryDate && this.currentUser?.id) {
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

        if (this.isPrimaryDevice && movedEnough && enoughTimePassed) {
          this.lastEtaRefreshPosition = { latitude, longitude };
          this.lastEtaRefreshAt = now;
          base44.functions.invoke('refreshDriverEtasOnLocationUpdate', {
            driverId: this.currentUser.id,
            deliveryDate: this.currentDeliveryDate,
            isPrimaryDevice: this.isPrimaryDevice,
            routeChangeSource: 'poll',
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

        const previousPolylinePosition = this.lastPolylineRefreshPosition;
        const distanceSincePolylineRefresh = previousPolylinePosition
          ? this.calculateDistanceInMeters(
              previousPolylinePosition.latitude,
              previousPolylinePosition.longitude,
              latitude,
              longitude
            )
          : Infinity;
        const enoughTimeForPolyline = now - this.lastPolylineRefreshAt >= this.minTimeBetweenPolylineRefresh;
        const movedEnoughForPolyline = !previousPolylinePosition || distanceSincePolylineRefresh >= this.minPolylineRefreshDistance;
        const canRefreshPolylineFromThisDevice = this.isPrimaryDevice || this.allowNonPrimaryPolylineRefresh === true;

        if (movedEnoughForPolyline && enoughTimeForPolyline && canRefreshPolylineFromThisDevice) {
          this.lastPolylineRefreshPosition = { latitude, longitude };
          this.lastPolylineRefreshAt = now;
          base44.functions.invoke('regenerateType1Polyline', {
            driverId: this.currentUser.id,
            deliveryDate: this.currentDeliveryDate,
            currentLocation: {
              lat: latitude,
              lon: longitude
            },
            isPrimaryDevice: this.isPrimaryDevice,
            allowNonPrimaryPolylineRefresh: this.allowNonPrimaryPolylineRefresh,
            routeChangeSource: this.allowNonPrimaryPolylineRefresh ? 'accept_all' : 'poll'
          }).catch((polylineError) => {
            console.warn('⚠️ [LocationTracker] Polyline refresh skipped:', polylineError?.message || polylineError);
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

    // CRITICAL: Always update lastPosition so the heartbeat interval has a fresh fix.
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

    if (!this.isTracking) return;

    // CRITICAL: For web watchPosition, GPS callbacks can fire every 1-5s — far more
    // often than our intended 15s interval. Throttle DB uploads here so we only
    // upload once per updateInterval. The heartbeat setInterval is the authoritative
    // 15s upload clock; watchPosition callbacks just keep lastPosition fresh.
    // Exception: native background providers manage their own rate, pass through.
    const isNativeProvider = this.locationProvider?.backgroundCapable === true;
    const timeSinceLastUpload = Date.now() - this.lastUploadTime;
    if (!isNativeProvider && timeSinceLastUpload < this.updateInterval) {
      console.log(`📍 [LocationTracker] watchPosition throttled — ${Math.round((this.updateInterval - timeSinceLastUpload) / 1000)}s until next upload`);
      return;
    }

    await this.updateLocationInDatabase(
      latitude,
      longitude,
      accuracy,
      false,
      false,
      this.isPrimaryDevice
    );
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

    // NOTE: isMobileDevice() gate intentionally removed.
    // GPS tracking is available on ANY device — iOS, Android, PWA, or desktop browser.
    // Whether this device actually WRITES coordinates to the backend is controlled
    // exclusively by isPrimaryDevice (set from the UserDevice DB record below).
    // Desktop browsers without GPS hardware fail gracefully at checkGPSCapabilities().

    if (isCapacitorNativeApp() && getCapacitorPlatform() === 'android') {
      // NOTE: @capacitor-community/background-geolocation does NOT expose requestPermissions().
      // Permission prompting is handled internally by addWatcher(requestPermissions: true).
      // We do NOT block tracking here — the plugin will prompt inline when addWatcher is called.
      // If the user denies, the watcher error callback fires with code NOT_AUTHORIZED.
      console.log('📍 [LocationTracker] Native Android — permission will be requested by addWatcher');
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
    // Capture roles so _isDispatcherOrAdminOnly() works throughout tracking
    this.userRoles = Array.isArray(user.app_roles) ? user.app_roles : [];

    // CRITICAL: Check if this is the primary device BEFORE starting GPS
    try {
      const currentDevice = await getCurrentDevice(user.id);
      // CRITICAL: null device record (not registered yet) means this is the only/primary device.
      // Match the same logic used in DriverLocationMarkers: null → primary, inactive → not primary.
      // CRITICAL: Only devices explicitly set as is_primary_tracker=true in the DB are primary.
      // Unregistered devices (null) are NOT primary — they have no UserDevice record at all.
      this.isPrimaryDevice = currentDevice !== null && currentDevice?.status !== 'inactive' && currentDevice?.is_primary_tracker === true;

      console.log(`✅ [LocationTracker] Device status:`, {
        deviceId: currentDevice?.device_identifier || 'NOT REGISTERED',
        isPrimaryTracker: this.isPrimaryDevice,
        deviceName: currentDevice?.device_name || 'No device record'
      });
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

    // CRITICAL: Non-primary devices must not start GPS tracking at all.
    // Abort here so no watchPosition, no heartbeat interval, and no DB writes ever happen.
    if (!this.isPrimaryDevice) {
      console.log(`🚫 [LocationTracker] Non-primary device — GPS tracking aborted. No data will be uploaded.`);
      return;
    }

    // DISPATCHER / ADMIN ONLY: Skip GPS entirely — just send a timestamp heartbeat once per minute.
    if (this._isDispatcherOrAdminOnly()) {
      console.log(`📡 [LocationTracker] Dispatcher/Admin role — starting timestamp-only heartbeat (no GPS, no coordinates)`);
      await this._startDispatcherHeartbeat();
      return;
    }

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
          this._clearHeartbeat(); // Guard: ensure no stale interval before starting a new one
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
                this.updateLocationInDatabase(
                  this.lastPosition.latitude,
                  this.lastPosition.longitude,
                  this.lastPosition.accuracy,
                  false,
                  true,
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

        // Independent 5s breadcrumb collection timer — decoupled from GPS upload cycle
        if (this.breadcrumbInterval) {
          clearInterval(this.breadcrumbInterval);
          this.breadcrumbInterval = null;
        }
        this.breadcrumbInterval = setInterval(() => {
          if (!this.isTracking || this.driverStatus !== 'on_duty' || !this.lastPosition) return;
          this.collectBreadcrumb(
            this.lastPosition.latitude,
            this.lastPosition.longitude,
            Date.now()
          ).catch((e) => console.warn('⚠️ [Breadcrumb Timer] collectBreadcrumb failed:', e?.message));
        }, this.breadcrumbSaveInterval);

        console.log(`✅ [${providerName} PROVIDER] Location tracking started${useNativeBackgroundWatcher ? ' - streaming native updates' : ` - uploads every ${this.updateInterval/1000}s`} | Breadcrumbs every ${this.breadcrumbSaveInterval/1000}s`);
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
    this._clearHeartbeat();
    if (this.breadcrumbInterval) {
      clearInterval(this.breadcrumbInterval);
      this.breadcrumbInterval = null;
    }
    console.log('💓 [LocationTracker] Stopped heartbeat + breadcrumb intervals');
    this.isTracking = false;
    this._webOnlyMode = false;
    this._dispatcherHeartbeatMode = false;
    this.isPrimaryDevice = false;
    this.userRoles = [];
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
    this.lastPolylineRefreshPosition = null;
    this.lastPolylineRefreshAt = 0;
    this.allowNonPrimaryPolylineRefresh = false;
    this.lastHeartbeatAt = 0;
    this.lastFocusLostAt = 0;
    
    // Clear arrival detection state
    arrivalTimeDetector.clearRecordedArrivals();
  }

  /**
   * Upgrade from web-only (off-duty heartbeat) to full tracking (on_duty/on_break).
   * Stops the lightweight interval and starts the full watchPosition + heartbeat.
   */
  async upgradeToFullTracking(user, deliveryDate = null) {
    if (this._webOnlyMode) {
      // Stop the web-only heartbeat but preserve lastPosition and appUserId
      this._clearHeartbeat();
      this.isTracking = false;
      this._webOnlyMode = false;
    }
    await this.startTracking(user, deliveryDate);
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
    return calculateDistanceInMeters(lat1, lon1, lat2, lon2);
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
      console.log(`🍞 [LocationTracker] Skipping breadcrumb - waiting ${Math.ceil((this.breadcrumbSaveInterval - (timestamp - this.lastBreadcrumbSavedAt)) / 1000)}s for ${this.breadcrumbSaveInterval / 1000}s interval`);
      return;
    }

    try {
      const result = await collectBreadcrumbForTracker({
        driverStatus: this.driverStatus,
        appUserId: this.appUserId,
        currentUser: this.currentUser,
        currentDeliveryDate: this.currentDeliveryDate,
        latitude,
        longitude,
        timestamp
      });

      if (!result) {
        return;
      }

      this.lastBreadcrumbPosition = { latitude, longitude, timestamp };
      this.lastBreadcrumbSavedAt = timestamp;
      console.log(`🍞 [LocationTracker] Collected breadcrumb for ${result.pendingKey}: [${latitude.toFixed(6)}, ${longitude.toFixed(6)}]`);
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

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      locationTracker.lastFocusLostAt = Date.now();
      return;
    }

    const now = Date.now();
    const referenceTime = Math.max(
      locationTracker.lastFocusLostAt || 0,
      locationTracker.lastHeartbeatAt || 0,
      locationTracker.lastBreadcrumbSavedAt || 0,
      locationTracker.lastCoordinateUpdate || 0
    );

    if (
      locationTracker.isTracking &&
      locationTracker.driverStatus === 'on_duty' &&
      referenceTime > 0 &&
      now - referenceTime > 15000
    ) {
      locationTracker.refreshNow({ source: 'visibility-return' });
    }
  });
}