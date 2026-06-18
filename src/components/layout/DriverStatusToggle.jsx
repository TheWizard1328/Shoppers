import React, { useState, useEffect, useCallback, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { locationTracker } from "../utils/locationTracker";
import { cn } from "@/lib/utils";
import { triggerRouteOptimization } from "../utils/realTimeRouteOptimizer";
import { format } from "date-fns";
import { toast } from "sonner";
import { useAppData } from "../utils/AppDataContext";
import { fabControlEvents } from "../utils/fabControlEvents";
import { loadUserSettings, getSetting } from "../utils/userSettingsManager";
import { reconcilePendingBreadcrumbsOnDuty } from "../utils/pendingBreadcrumbReconciliation";

// Lazy load broadcastMutation to avoid circular dependency issues
const broadcastMutation = async (entity, action, id, data) => {
  try {
    const { broadcastMutation: broadcast } = await import('../utils/realtimeSync');
    return broadcast(entity, action, id, data);
  } catch (error) {
    console.warn('[DriverStatusToggle] Could not broadcast mutation:', error.message);
  }
};

const getEdmontonDateString = (value = Date.now()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Edmonton',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value));
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${year}-${month}-${day}`;
};

const getTodayDeliveryDateForOnDuty = () => getEdmontonDateString();

const clearStalePendingBreadcrumbs = async (appUserId) => {
  if (!appUserId) return;
  const { offlineDB } = await import('../utils/offlineDatabase');
  const pendingRecord = await offlineDB.getById(offlineDB.STORES.PENDING_BREADCRUMBS, appUserId);
  if (!pendingRecord?.breadcrumbs?.length) return;

  const todayEdmonton = getEdmontonDateString();
  const todaysBreadcrumbs = pendingRecord.breadcrumbs.filter((point) => {
    const timestamp = Array.isArray(point) ? point[2] : null;
    return timestamp && getEdmontonDateString(timestamp) === todayEdmonton;
  });

  if (todaysBreadcrumbs.length === pendingRecord.breadcrumbs.length) return;
  if (todaysBreadcrumbs.length === 0) {
    await offlineDB.deleteRecord(offlineDB.STORES.PENDING_BREADCRUMBS, appUserId);
    return;
  }

  await offlineDB.save(offlineDB.STORES.PENDING_BREADCRUMBS, {
    ...pendingRecord,
    driver_id: appUserId,
    timestamp: todaysBreadcrumbs[todaysBreadcrumbs.length - 1][2],
    breadcrumbs: todaysBreadcrumbs
  });
};

/**
 * 3-way driver status toggle for mobile header
 * Left: Off Duty (Red) - Disables location sharing
 * Center: On Duty (Green) - Enables location sharing
 * Right: On Break (Blue) - Disables location sharing
 *
 * targetUser: optional override — when an admin has a specific driver selected,
 * pass that driver's merged user object here so the toggle operates on them
 * instead of the logged-in user.
 */
export default function DriverStatusToggle({ currentUser, targetUser, onStatusChange, onBreakStart, onBreakEnd, vertical = false }) {
  // If a target driver is selected (admin toggling a specific driver), use them;
  // otherwise fall back to the logged-in user.
  const effectiveUser = targetUser || currentUser;
  // CRITICAL: Move all hooks to top before any conditions - prevents hook mismatch errors
  const [status, setStatus] = useState(null); // Will sync from currentUser prop
  const [isUpdating, setIsUpdating] = useState(false);
  const [pendingStatus, setPendingStatus] = useState(null);
  const [appUserId, setAppUserId] = useState(null);
  const [savedPhaseBeforeBreak, setSavedPhaseBeforeBreak] = useState(null);
  const appDataContext = useAppData();
  const setIsEntityUpdating = appDataContext?.setIsEntityUpdating || (() => {});
  const isTogglingRef = useRef(false);
  const lastRequestedStatusRef = useRef(null);
  // Track when we last received a WebSocket update so the prop sync doesn't overwrite it
  const lastWebSocketUpdateRef = useRef(0);
  // Deduplicate appUserUpdated events — skip if status hasn't changed from last WS value
  const lastWsStatusRef = useRef(null);

  // Find AppUser ID on mount and load from offline DB
  // CRITICAL: If driver is already on_duty or on_break on load, immediately start
  // location tracking and push a fresh GPS fix so the marker is visible right away.
  useEffect(() => {
    const initAppUser = async () => {
      if (!effectiveUser?.id) return;
      
      try {
        // CRITICAL: Try offline DB first
        const { offlineDB } = await import('../utils/offlineDatabase');
        const offlineAppUsers = await offlineDB.getByIndex(offlineDB.STORES.APP_USERS, 'user_id', effectiveUser.id);
        
        let resolvedAppUser = null;

        if (offlineAppUsers && offlineAppUsers.length > 0) {
          resolvedAppUser = offlineAppUsers[0];
          console.log(`💾 [DriverStatusToggle] Loaded from offline DB - status: ${resolvedAppUser.driver_status || 'off_duty'}`);
        } else {
          // Fallback to API if offline DB empty
          const appUsers = await base44.entities.AppUser.filter({ user_id: effectiveUser.id });
          if (appUsers && appUsers.length > 0) {
            resolvedAppUser = appUsers[0];
            await offlineDB.save(offlineDB.STORES.APP_USERS, resolvedAppUser);
            console.log(`📍 [DriverStatusToggle] Initialized from API - status: ${resolvedAppUser.driver_status || 'off_duty'}`);
          }
        }

        if (!resolvedAppUser) return;

        const loadedStatus = resolvedAppUser.driver_status || 'off_duty';
        setAppUserId(resolvedAppUser.id);
        setStatus(loadedStatus);
        // Only update locationTracker for the logged-in user's own status
        if (!targetUser) locationTracker.setDriverStatus(loadedStatus);

        // CRITICAL: Always start location tracking on app load for all driver statuses.
        // - on_duty / on_break → full tracking (watchPosition + native background)
        // - off_duty            → web-only heartbeat (keeps shared marker fresh on other devices)
        // Skip location tracking init when operating on a different driver (admin mode).
        if (targetUser) return;
        const userWithAppUserId = { ...currentUser, appUserId: resolvedAppUser.id };
        if (!locationTracker.isTracking) {
          if (loadedStatus === 'on_duty' || loadedStatus === 'on_break') {
            console.log(`🚀 [DriverStatusToggle] App loaded with status '${loadedStatus}' — starting full tracking`);
            try {
              await locationTracker.startTracking(userWithAppUserId);
              console.log('✅ [DriverStatusToggle] Full tracking started on app load');
            } catch (trackErr) {
              console.warn('⚠️ [DriverStatusToggle] Full tracking failed, falling back to web-only:', trackErr.message);
              await locationTracker.startWebOnlyTracking(userWithAppUserId).catch(() => {});
            }
          } else {
            // off_duty — lightweight web-only heartbeat so marker stays visible on other devices
            console.log(`📍 [DriverStatusToggle] App loaded off_duty — starting web-only location heartbeat`);
            await locationTracker.startWebOnlyTracking(userWithAppUserId).catch((e) => {
              console.warn('⚠️ [DriverStatusToggle] Web-only tracking failed on load:', e.message);
            });
          }
        }

        // CRITICAL: Push fresh location data on app load/refresh.
        // Primary device: force-upload a fresh GPS fix to online+offline DB immediately.
        // Non-primary device: reload AppUsers from offline DB and broadcast so markers
        // reflect the latest persisted location without waiting for a WebSocket event.
        setTimeout(() => {
          if (locationTracker.isPrimaryDevice && locationTracker.isTracking) {
            console.log('📍 [DriverStatusToggle] Pushing fresh GPS fix on app load...');
            locationTracker.refreshNow({ source: 'app-load' }).catch(() => {});
          } else if (!locationTracker.isPrimaryDevice) {
            console.log('📍 [DriverStatusToggle] Non-primary — loading AppUsers from offline DB on app load...');
            offlineDB.getAll(offlineDB.STORES.APP_USERS).then((appUsers) => {
              if (appUsers && appUsers.length > 0) {
                window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
                  detail: { appUsers, fromOfflineDB: true, mergeMode: 'merge' }
                }));
              }
            }).catch(() => {});
          }
        }, 2000);
      } catch (error) {
        console.error('Failed to find AppUser ID:', error);
      }
    };
    
    initAppUser();
  }, [effectiveUser?.id]);

  // Sync from effectiveUser prop changes when not toggling
  // CRITICAL: Skip if a WebSocket update arrived recently (within 5s) - prop may be stale
  useEffect(() => {
    if (!effectiveUser?.driver_status || status === effectiveUser.driver_status) {
      return;
    }

    if (lastRequestedStatusRef.current && effectiveUser.driver_status !== lastRequestedStatusRef.current) {
      console.log(`⏸️ [DriverStatusToggle] Skipping stale prop sync (${effectiveUser.driver_status}) while waiting for ${lastRequestedStatusRef.current}`);
      return;
    }

    if (!isTogglingRef.current) {
      const timeSinceWsUpdate = Date.now() - lastWebSocketUpdateRef.current;
      if (timeSinceWsUpdate < 5000) {
        console.log(`⏸️ [DriverStatusToggle] Skipping stale prop sync (WS update ${timeSinceWsUpdate}ms ago) - keeping WS value: ${status}`);
        return;
      }
    }

    setStatus(effectiveUser.driver_status);
    if (!targetUser) locationTracker.setDriverStatus(effectiveUser.driver_status);
    if (effectiveUser.driver_status === lastRequestedStatusRef.current) {
      lastRequestedStatusRef.current = null;
    }
    console.log(`✅ [DriverStatusToggle] Syncing from effectiveUser prop: ${effectiveUser.driver_status}`);
  }, [effectiveUser?.driver_status, status]);

  // Listen for AppUser entity updates to sync status across devices
  useEffect(() => {
    // PRIMARY: Listen for appUserUpdated CustomEvent (from AppDataContext/cityFilteredRealtimeSync)
    const handleAppUserUpdated = (event) => {
      const { appUser } = event.detail || {};
      
      if (!appUser || !currentUser) return;
      
      // Check if this update is for the current user
      const isCurrentUser = (
        (appUserId && appUser.id === appUserId) ||
        (appUser.user_id === effectiveUser.id)
      );
      
      if (isCurrentUser && typeof appUser.driver_status !== 'undefined') {
        // Deduplicate: skip if this exact status was already processed from a WS event
        if (lastWsStatusRef.current === appUser.driver_status) {
          return;
        }

        if (appUser.driver_status === lastRequestedStatusRef.current) {
          lastRequestedStatusRef.current = null;
        }

        // Skip if still toggling
        if (isTogglingRef.current) {
          return;
        }

        // CRITICAL: Record WS update time so prop sync doesn't immediately overwrite
        lastWebSocketUpdateRef.current = Date.now();
        lastWsStatusRef.current = appUser.driver_status;
        
        // CRITICAL: Only update if the value actually changed
        setStatus(prev => {
          if (prev === appUser.driver_status) {
            return prev;
          }
          if (!targetUser) locationTracker.setDriverStatus(appUser.driver_status);
          return appUser.driver_status;
        });
      }
    };
    
    // FALLBACK: Keep entityMutationBroadcast as optional fallback
    const handleEntityMutationBroadcast = (event) => {
      const { entity, action, id, data } = event.detail || {};
      
      if (entity !== 'AppUser' || !data || !currentUser) return;
      
      const isCurrentUser = (
        (appUserId && id === appUserId) ||
        (appUserId && data?.id === appUserId) ||
        (data?.user_id === effectiveUser.id)
      );
      
      if (isCurrentUser && typeof data.driver_status !== 'undefined') {
        console.log(`📡 [DriverStatusToggle] entityMutationBroadcast fallback - syncing status to: ${data.driver_status}`);

        if (data.driver_status === lastRequestedStatusRef.current) {
          lastRequestedStatusRef.current = null;
        }
        
        if (isTogglingRef.current) {
          return;
        }
        
        setStatus(prev => {
          if (prev === data.driver_status) {
            return prev;
          }
          if (!targetUser) locationTracker.setDriverStatus(data.driver_status);
          return data.driver_status;
        });
      }
    };

    window.addEventListener('appUserUpdated', handleAppUserUpdated);
    window.addEventListener('entityMutationBroadcast', handleEntityMutationBroadcast);
    return () => {
      window.removeEventListener('appUserUpdated', handleAppUserUpdated);
      window.removeEventListener('entityMutationBroadcast', handleEntityMutationBroadcast);
    };
  }, [appUserId, currentUser?.id]);

  const handleStatusChange = useCallback(async (newStatus) => {
    // Don't allow changes while updating OR if already pending
    if (isUpdating || pendingStatus || isTogglingRef.current) {
      console.log('⏸️ [DriverStatusToggle] Change blocked - update in progress');
      return;
    }
    
    // Don't allow if clicking same status
    if (newStatus === status) {
      console.log('⏸️ [DriverStatusToggle] Already on status:', newStatus);
      return;
    }
    
    if (!appUserId) {
      console.error('❌ [DriverStatusToggle] No AppUser ID available');
      return;
    }
    
    // CRITICAL: Set toggling flag to block sync until change completes
    isTogglingRef.current = true;
    
    const today = getTodayDeliveryDateForOnDuty();
    const selectedRouteDate = appDataContext?.deliveries?.find((d) => d?.driver_id === effectiveUser?.id && d?.isNextDelivery)?.delivery_date || today;
    const optimizerDeliveryDate = newStatus === 'on_duty' ? today : selectedRouteDate;
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

    // Check if driver can go off_duty
    // RULE: Can go off duty if NO completed stops (route hasn't started) OR all stops are finished
    if (newStatus === 'off_duty') {
    try {
      const todayDeliveries = await base44.entities.Delivery.filter({
        driver_id: effectiveUser?.id,
        delivery_date: selectedRouteDate
      });
        
        const completedStops = todayDeliveries.filter(d => finishedStatuses.includes(d.status));
        const activeStops = todayDeliveries.filter(d => !finishedStatuses.includes(d.status));
        
        // If there ARE completed stops but also active stops, block going off duty
        // (route is in progress - can't abandon mid-route)
        if (completedStops.length > 0 && activeStops.length > 0) {
          toast.error(`Cannot go off duty with ${activeStops.length} active stop${activeStops.length > 1 ? 's' : ''} (route in progress)`);
          return;
        }
        // If NO completed stops, allow going off duty (route hasn't started yet)
        // If all stops are completed, allow going off duty (route is done)
      } catch (error) {
        console.error('Failed to check active stops:', error);
      }
    }
    
    console.log('⏸️ [DRIVER STATUS] Pausing smart refresh...');
    setIsUpdating(true);
    setPendingStatus(newStatus);
    setIsEntityUpdating(true);
    
    // CRITICAL: Set flag to block activity monitor during status change
    sessionStorage.setItem('driver_status_change_in_progress', Date.now().toString());
    
    await new Promise(resolve => setTimeout(resolve, 100));
    console.log('✅ [DRIVER STATUS] Smart refresh paused');
    
    const previousStatus = status;
    
    try {
      console.log(`🔄 Changing driver status: ${status} -> ${newStatus}`);
      lastRequestedStatusRef.current = newStatus;
      
      // Optimistically update UI
      setStatus(newStatus);
      
      // Get device ID from localStorage
      let deviceId = localStorage.getItem('rxdeliver_device_id');
      if (!deviceId) {
        deviceId = `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        localStorage.setItem('rxdeliver_device_id', deviceId);
      }
      
      // CRITICAL: Pause smart refresh to prevent it from overwriting our changes
      const { smartRefreshManager } = await import('../utils/smartRefreshManager');
      
      // CRITICAL: Protect this AppUser from smart refresh overwrites for 10 seconds
      smartRefreshManager.registerPendingAppUserUpdate(appUserId, 'driver_status');
      
      smartRefreshManager.pause();
      console.log('⏸️ [DriverStatusToggle] Smart refresh paused during status change');
      
      // Prepare update payload based on new status
      const nowTimestamp = new Date().toISOString();
      let updatePayload = {
        driver_status: newStatus,
        location_tracking_enabled: newStatus === 'on_duty'
      };
      
      // Get current GPS if available (for on_duty and on_break)
      let currentLat = effectiveUser?.current_latitude;
      let currentLng = effectiveUser?.current_longitude;
      
      if (newStatus === 'on_duty' || newStatus === 'on_break') {
        if (navigator.geolocation) {
          try {
            const pos = await new Promise((resolve, reject) => {
              navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: true,
                timeout: 3000,
                maximumAge: 0
              });
            });
            currentLat = pos.coords.latitude;
            currentLng = pos.coords.longitude;
            console.log('📍 Got fresh GPS for status update:', { currentLat, currentLng });
          } catch (gpsError) {
            console.warn('📍 Could not get fresh GPS:', gpsError.message);
          }
        }
      }
      
      // CRITICAL: Set all fields based on status
      if (newStatus === 'on_duty') {
        console.log('📍 [DriverStatusToggle] Going ON DUTY - enabling location tracking...');
        // Force-enable routes on map for this device
        try { localStorage.setItem('rxdeliver_show_routes', 'true'); } catch (_) {}
        try { window.dispatchEvent(new CustomEvent('forceEnableRoutes')); } catch (_) {}
        updatePayload.location_tracking_enabled = true;
        updatePayload.location_updated_at = nowTimestamp;
        updatePayload.current_latitude = currentLat;
        updatePayload.current_longitude = currentLng;
      } else if (newStatus === 'on_break') {
        console.log('📍 [DriverStatusToggle] Going ON BREAK - keeping location sharing active...');
        updatePayload.location_tracking_enabled = true; // CRITICAL: Keep sharing enabled for on_break
        updatePayload.current_latitude = currentLat;
        updatePayload.current_longitude = currentLng;
        updatePayload.location_updated_at = nowTimestamp; // CRITICAL: Keep timestamp active for on_break
      } else if (newStatus === 'off_duty') {
        console.log('📍 [DriverStatusToggle] Going OFF DUTY - disabling location sharing...');
        updatePayload.location_tracking_enabled = false;
        updatePayload.current_latitude = null;
        updatePayload.current_longitude = null;
        updatePayload.location_updated_at = null;
      }
      
      // CRITICAL: Update AppUser entity IMMEDIATELY with all fields
      console.log('📝 [DriverStatusToggle] Updating AppUser with:', updatePayload);
      const updatedAppUser = await base44.entities.AppUser.update(appUserId, updatePayload);
      console.log('✅ [DriverStatusToggle] AppUser updated successfully');

      // CRITICAL: Save to offline DB immediately
      const { offlineDB } = await import('../utils/offlineDatabase');
      await offlineDB.save(offlineDB.STORES.APP_USERS, updatedAppUser);
      console.log('💾 [DriverStatusToggle] Saved to offline DB:', updatedAppUser);

      // Build the full broadcast data from the API response + our payload
      const broadcastData = {
        id: appUserId,
        user_id: effectiveUser.id,
        ...updatedAppUser,
        ...updatePayload
      };

      // CRITICAL: Dispatch UI update events directly — do NOT call broadcastMutation here.
      // base44.entities.AppUser.update() already fires a WS event that propagates to other devices.
      // Calling broadcastMutation AFTER the API update poisons the dedupe cache with the same key,
      // causing the real WS event (which other devices rely on) to be silently dropped.
      // Instead, we update local state directly and let the WS subscription handle other devices.
      window.dispatchEvent(new CustomEvent('appUserUpdated', {
        detail: { appUser: broadcastData, fromRealtime: false }
      }));
      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
        detail: { appUsers: [broadcastData], fromRealtime: false, mergeMode: 'merge' }
      }));
      window.dispatchEvent(new CustomEvent('driverStatusChanged', {
        detail: { userId: effectiveUser.id, newStatus }
      }));
      
      // CRITICAL: Call backend function to enforce single active device
      console.log('📱 Calling setDriverStatus backend function...');
      const result = await base44.functions.invoke('setDriverStatus', {
        newStatus,
        deviceId,
        selectedDate: optimizerDeliveryDate,
        disableLocationTracking: newStatus === 'off_duty', // Only disable tracking when off duty
        ...(targetUser ? { targetUserId: effectiveUser.id } : {}) // Admin: target specific driver
      });
      
      const confirmedStatus = result?.data?.driver_status || newStatus;
      setStatus(confirmedStatus);
      if (!targetUser) locationTracker.setDriverStatus(confirmedStatus);
      if (confirmedStatus === lastRequestedStatusRef.current) {
        lastRequestedStatusRef.current = null;
      }
      
      console.log('✅ Backend status update result:', result.data);
      
      // CRITICAL: DO NOT fetch fresh data - trust our update
      // The update was already applied, fetching again can cause race conditions with stale data
      console.log('💾 [DriverStatusToggle] Local app user state already saved, skipping duplicate local mutation update');
      
      // Invalidate caches to force fresh data fetch
      const { invalidate } = await import('../utils/dataManager');
      invalidate('AppUser');
      invalidate('Delivery');
      
      // Update location tracker based on new status (only for the logged-in user's own toggle)
      const shouldEnableTracking = newStatus === 'on_duty' || newStatus === 'on_break';
      
      if (targetUser) {
        // Admin toggling another driver — update local app state so UI reflects change immediately
        console.log(`✅ [DriverStatusToggle] Admin updated driver ${effectiveUser.id} status to ${newStatus}`);

        // Update appUsers locally so driver markers + sidebar reflect new status
        if (appDataContext?.updateAppUsersLocally) {
          appDataContext.updateAppUsersLocally([{ id: appUserId, user_id: effectiveUser.id, ...updatePayload }], false);
        }

        // Dispatch appUserUpdated so all listeners (map markers, legend, etc.) update
        window.dispatchEvent(new CustomEvent('appUserUpdated', {
          detail: { appUser: { id: appUserId, user_id: effectiveUser.id, ...updatedAppUser, ...updatePayload } }
        }));
      } else if (!shouldEnableTracking) {
        // Going OFF DUTY or ON BREAK — downgrade full tracking to web-only heartbeat
        // (keeps shared marker visible on other devices without native background battery drain)
        locationTracker.setDriverStatus(newStatus);
        if (newStatus === 'off_duty' && !locationTracker._webOnlyMode) {
          console.log('📍 [DriverStatusToggle] Going off duty — downgrading to web-only heartbeat');
          locationTracker.stopTracking();
          await locationTracker.startWebOnlyTracking({ ...currentUser, appUserId }).catch(() => {});
        } else {
          console.log('📍 [DriverStatusToggle] Status set to ' + newStatus + ' - location sharing disabled');
        }
        
        // CRITICAL: Dispatch event to force LocationTrackingToggle UI refresh
        window.dispatchEvent(new CustomEvent('locationSharingDisabled'));

        // Hint payroll stats scheduler that a burst may follow
        sessionStorage.setItem('driver_status_change_in_progress', Date.now().toString());
        
        // If going on break, save current FAB phase and notify Dashboard
            // Backend cleared isNextDelivery flags in setDriverStatus
            if (newStatus === 'on_break') {
              try {
                // Load user settings to get current FAB phase
                const settings = await loadUserSettings(currentUser.id);
                const currentPhase = settings?.fab_map_cycle_phase || 1;
                setSavedPhaseBeforeBreak(currentPhase);
                console.log(`💾 [DriverStatusToggle] Saved FAB phase before break: ${currentPhase}`);

                // Notify Dashboard to unlock FAB and zoom to phase 1
                fabControlEvents.notifyBreakStart(currentPhase);

                console.log('✅ [DriverStatusToggle] Backend cleared isNextDelivery flags');
                
                // CRITICAL: Avoid force refresh here because transient backend failures can wipe offline-backed UI state
                if (appDataContext?.refreshData) {
                  console.log('🔄 [DriverStatusToggle] Refreshing after break start without force reset...');
                  await appDataContext.refreshData(false);
                }
              } catch (error) {
                console.error('Failed to save phase:', error);
              }
            }
      } else {
        // Going on duty - start full location tracking and set next delivery
        try {
          console.log('🟢 Starting location tracking (on duty)...');
          await reconcilePendingBreadcrumbsOnDuty({
            driverUserId: currentUser.id,
            appUsers: [{ id: appUserId, user_id: currentUser.id }],
            currentDateStr: today
          });

          // CRITICAL: Set driver status BEFORE starting tracker
          locationTracker.setDriverStatus(newStatus);
          
          // CRITICAL: Upgrade from web-only (off-duty heartbeat) to full tracking,
          // or start fresh if not tracking at all.
          if (locationTracker._webOnlyMode) {
            await locationTracker.upgradeToFullTracking({ ...currentUser, appUserId });
          } else if (!locationTracker.isTracking) {
            await locationTracker.startTracking({ ...currentUser, appUserId });
          }
          // If already full tracking (e.g. coming back from on_break), just keep it running.
          console.log('✅ Location tracking started');
          
          // Restore previous FAB phase if coming back from break
          if (savedPhaseBeforeBreak) {
            console.log(`🔄 [DriverStatusToggle] Restoring FAB phase after break: ${savedPhaseBeforeBreak}`);
            fabControlEvents.notifyBreakEnd(savedPhaseBeforeBreak);
            setSavedPhaseBeforeBreak(null);
          } else {
            // Just went on duty (not from break) - use default phase 1
            console.log('🗺️ [DriverStatusToggle] New on duty session - defaulting to phase 1');
            fabControlEvents.notifyBreakEnd(1);
          }
          
          // CRITICAL: Set isNextDelivery on the first active stop for this driver/date
          try {
            const activeDeliveries = (appDataContext?.deliveries || [])
              .filter((d) => d && d.driver_id === currentUser.id && d.delivery_date === today &&
                !['completed', 'failed', 'cancelled', 'returned', 'pending'].includes(d.status))
              .sort((a, b) => (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0));

            const currentNextDelivery = activeDeliveries.find((d) => d.isNextDelivery);
            const firstActive = activeDeliveries[0] || null;

            if (firstActive && !currentNextDelivery) {
              await base44.entities.Delivery.update(firstActive.id, { isNextDelivery: true }).catch(() => {});
              if (appDataContext?.updateDeliveriesLocally) {
                appDataContext.updateDeliveriesLocally(
                  activeDeliveries.map((d) => ({ ...d, isNextDelivery: d.id === firstActive.id })),
                  false
                );
              }
              console.log('✅ [DriverStatusToggle] Set isNextDelivery on first active stop:', firstActive.id);
            }
          } catch (nextErr) {
            console.warn('⚠️ [DriverStatusToggle] Could not set isNextDelivery:', nextErr?.message);
          }

          // CRITICAL: Avoid full force refresh here because transient backend failures can wipe offline-backed UI state
          if (appDataContext?.refreshData) {
            console.log('🔄 [DriverStatusToggle] Refreshing after going on duty without force reset...');
            await appDataContext.refreshData(false);
          }
          
          // Trigger AI-powered route optimization when going on duty
          console.log('🤖 Triggering AI route optimization after going on duty...');
          
          // Get current GPS location if available
          let currentGPS = null;
          if (navigator.geolocation) {
            try {
              const pos = await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, {
                  enableHighAccuracy: true,
                  timeout: 5000,
                  maximumAge: 0
                });
              });
              currentGPS = {
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude
              };
              console.log('📍 Got current GPS:', currentGPS);
            } catch (gpsError) {
              console.warn('📍 Could not get GPS:', gpsError.message);
            }
          }
          
          await triggerRouteOptimization({
            driverId: currentUser.id,
            deliveryDate: optimizerDeliveryDate,
            currentLocation: currentGPS,
            trigger: 'on_duty',
            onNotification: (notification) => {
              // Show toast notification
              if (notification.type === 'route_optimized') {
                toast.success(notification.message, {
                  description: notification.aiSuggestion
                });
              }
            }
          });
          console.log('✅ AI route optimization completed');
          
        } catch (trackingError) {
          console.warn('⚠️ Could not start location tracking or optimize:', trackingError.message);
        }
      } // end else (own user on duty)
      
      // Notify parent component
      if (onStatusChange) {
        onStatusChange(newStatus);
      }
      
    } catch (error) {
      console.error('❌ Failed to update driver status:', error);
      lastRequestedStatusRef.current = null;
      setStatus(previousStatus);
      if (!targetUser) locationTracker.setDriverStatus(previousStatus);
      toast.error('Failed to update status. Please try again.');
      
      // Resume smart refresh on error
      try {
        const { smartRefreshManager } = await import('../utils/smartRefreshManager');
        smartRefreshManager.resume();
      } catch (e) {}
    } finally {
      console.log('▶️ [DRIVER STATUS] Resuming smart refresh');

      // Clear the burst hint shortly after
      setTimeout(() => { try { sessionStorage.removeItem('driver_status_change_in_progress'); } catch (_) {} }, 1500);

        // CRITICAL: Clear updating flags immediately so UI is responsive
      // Backend status change is already applied
      setIsUpdating(false);
      setIsEntityUpdating(false);
      
      // CRITICAL: Clear the status change flag to allow activity monitor to resume
      sessionStorage.removeItem('driver_status_change_in_progress');
      
      setPendingStatus(null);
      isTogglingRef.current = false;

      // Resume smart refresh after short delay to let status propagate
      setTimeout(async () => {
        try {
          const { smartRefreshManager } = await import('../utils/smartRefreshManager');
          smartRefreshManager.resume();
          console.log('▶️ [DriverStatusToggle] Smart refresh resumed');
        } catch (e) {
          console.warn('⚠️ [DriverStatusToggle] Failed to resume smart refresh:', e);
        }
        
        console.log('✅ [DRIVER STATUS] Driver status change cycle complete');
      }, 500); // Reduced to 500ms since UI is already unblocked
    }
  }, [status, isUpdating, appUserId, effectiveUser, targetUser, currentUser, onStatusChange, setIsEntityUpdating, savedPhaseBeforeBreak, appDataContext]);

  const statusConfig = {
    off_duty: {
      label: 'Off',
      color: 'bg-red-500',
      activeColor: 'bg-red-600',
      textColor: 'text-white',
      position: 'left-0'
    },
    on_duty: {
      label: 'On',
      color: 'bg-emerald-500',
      activeColor: 'bg-emerald-600',
      textColor: 'text-white',
      position: 'left-1/3'
    },
    on_break: {
      label: 'Br',
      color: 'bg-blue-500',
      activeColor: 'bg-blue-600',
      textColor: 'text-white',
      position: 'left-2/3'
    }
  };

  const currentConfig = statusConfig[status] || statusConfig.off_duty;

  return (
    <div className="flex items-center">
      <div 
        className={cn(
          "relative flex items-center rounded-full p-0.5 transition-all",
          vertical ? "flex-col w-8 h-24" : "flex-row h-8 w-24",
          isUpdating && "opacity-50 pointer-events-none"
        )}
        style={{ background: 'var(--bg-slate-200)' }}
      >
        {/* Sliding indicator */}
        <div 
          className={cn(
            "absolute rounded-full transition-all duration-200 ease-out shadow-sm",
            currentConfig.activeColor,
            vertical ? "w-7 h-8" : "h-7 w-8",
            vertical && status === 'off_duty' && 'top-0.5',
            vertical && status === 'on_duty' && 'top-[calc(33.33%-2px)]',
            vertical && status === 'on_break' && 'top-[calc(66.66%-4px)]',
            !vertical && status === 'off_duty' && 'left-0.5',
            !vertical && status === 'on_duty' && 'left-[calc(33.33%-2px)]',
            !vertical && status === 'on_break' && 'left-[calc(66.66%-4px)]'
          )}
        />
        
        {/* Off Duty button */}
        <button
          onClick={() => handleStatusChange('off_duty')}
          disabled={isUpdating}
          className={cn(
            "relative z-10 flex flex-1 items-center justify-center rounded-full font-bold leading-none transition-colors min-h-0",
            vertical ? "h-1/3 w-full text-[9px]" : "h-full text-[10px]",
            status === 'off_duty' ? 'text-white' : ''
          )}
          style={status !== 'off_duty' ? { color: 'var(--text-slate-500)' } : {}}
          title="Off Duty - Location sharing disabled"
        >
          {statusConfig.off_duty.label}
        </button>
        
        {/* On Duty button */}
        <button
          onClick={() => handleStatusChange('on_duty')}
          disabled={isUpdating}
          className={cn(
            "relative z-10 flex flex-1 items-center justify-center rounded-full font-bold leading-none transition-colors min-h-0",
            vertical ? "h-1/3 w-full text-[9px]" : "h-full text-[10px]",
            status === 'on_duty' ? 'text-white' : ''
          )}
          style={status !== 'on_duty' ? { color: 'var(--text-slate-500)' } : {}}
          title="On Duty - Location sharing enabled"
        >
          {statusConfig.on_duty.label}
        </button>
        
        {/* On Break button */}
        <button
          onClick={() => handleStatusChange('on_break')}
          disabled={isUpdating}
          className={cn(
            "relative z-10 flex flex-1 items-center justify-center rounded-full font-bold leading-none transition-colors min-h-0",
            vertical ? "h-1/3 w-full text-[9px]" : "h-full text-[10px]",
            status === 'on_break' ? 'text-white' : ''
          )}
          style={status !== 'on_break' ? { color: 'var(--text-slate-500)' } : {}}
          title="On Break - Location sharing disabled"
        >
          {statusConfig.on_break.label}
        </button>
      </div>
    </div>
  );
}