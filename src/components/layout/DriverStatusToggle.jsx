import React, { useState, useEffect, useCallback, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { locationTracker } from "../utils/locationTracker";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useAppData } from "../utils/AppDataContext";
import { fabControlEvents } from "../utils/fabControlEvents";
import { loadUserSettings } from "../utils/userSettingsManager";
import { reconcilePendingBreadcrumbsOnDuty } from "../utils/pendingBreadcrumbReconciliation";
import { globalFilters } from "../utils/globalFilters";

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
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(value));
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
};

const getTodayStr = () => getEdmontonDateString();

const buildUpdatePayload = (newStatus, currentLat, currentLng) => {
  const nowTimestamp = new Date().toISOString();
  if (newStatus === 'on_duty') {
    return { driver_status: newStatus, location_tracking_enabled: true, location_updated_at: nowTimestamp, current_latitude: currentLat, current_longitude: currentLng };
  }
  if (newStatus === 'on_break') {
    return { driver_status: newStatus, location_tracking_enabled: true, location_updated_at: nowTimestamp, current_latitude: currentLat, current_longitude: currentLng };
  }
  // off_duty
  return { driver_status: newStatus, location_tracking_enabled: false, location_updated_at: null, current_latitude: null, current_longitude: null };
};

const getFreshGPS = async (timeout = 3000) => {
  if (!navigator.geolocation) return null;
  try {
    const pos = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout, maximumAge: 0 })
    );
    return { lat: pos.coords.latitude, lng: pos.coords.longitude };
  } catch {
    return null;
  }
};

/**
 * 3-way driver status toggle.
 * targetUser: optional — admin toggling a specific driver. Falls back to currentUser.
 * effectiveUser is always the driver being toggled; isOwnUser gates location tracker calls.
 */
export default function DriverStatusToggle({ currentUser, targetUser, onStatusChange, vertical = false }) {
  const effectiveUser = targetUser || currentUser;
  const isOwnUser = !targetUser;

  const [status, setStatus] = useState(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [pendingStatus, setPendingStatus] = useState(null);
  const [appUserId, setAppUserId] = useState(null);
  const [savedPhaseBeforeBreak, setSavedPhaseBeforeBreak] = useState(null);

  const appDataContext = useAppData();
  const setIsEntityUpdating = appDataContext?.setIsEntityUpdating || (() => {});

  const isTogglingRef = useRef(false);
  const lastRequestedStatusRef = useRef(null);
  const lastWebSocketUpdateRef = useRef(0);
  const lastWsStatusRef = useRef(null);

  // ── Init: load AppUser from offline DB (or API fallback), set status + start tracking ──
  useEffect(() => {
    const init = async () => {
      if (!effectiveUser?.id) return;
      try {
        const { offlineDB } = await import('../utils/offlineDatabase');
        let resolvedAppUser = null;

        const offlineResults = await offlineDB.getByIndex(offlineDB.STORES.APP_USERS, 'user_id', effectiveUser.id);
        if (offlineResults?.length > 0) {
          resolvedAppUser = offlineResults[0];
        } else {
          const apiResults = await base44.entities.AppUser.filter({ user_id: effectiveUser.id });
          if (apiResults?.length > 0) {
            resolvedAppUser = apiResults[0];
            await offlineDB.save(offlineDB.STORES.APP_USERS, resolvedAppUser);
          }
        }

        if (!resolvedAppUser) return;

        const loadedStatus = resolvedAppUser.driver_status || 'off_duty';
        setAppUserId(resolvedAppUser.id);
        setStatus(loadedStatus);

        // Location tracking only applies to the logged-in user's own device
        if (!isOwnUser) return;

        locationTracker.setDriverStatus(loadedStatus);
        const userWithId = { ...currentUser, appUserId: resolvedAppUser.id };

        if (!locationTracker.isTracking) {
          if (loadedStatus === 'on_duty' || loadedStatus === 'on_break') {
            await locationTracker.startTracking(userWithId).catch(async () => {
              await locationTracker.startWebOnlyTracking(userWithId).catch(() => {});
            });
          } else {
            await locationTracker.startWebOnlyTracking(userWithId).catch(() => {});
          }
        }

        setTimeout(() => {
          if (locationTracker.isPrimaryDevice && locationTracker.isTracking) {
            locationTracker.refreshNow({ source: 'app-load' }).catch(() => {});
          } else if (!locationTracker.isPrimaryDevice) {
            offlineDB.getAll(offlineDB.STORES.APP_USERS).then(users => {
              if (users?.length > 0) {
                window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: users, fromOfflineDB: true, mergeMode: 'merge' } }));
              }
            }).catch(() => {});
          }
        }, 2000);
      } catch (error) {
        console.error('[DriverStatusToggle] Init failed:', error);
      }
    };
    init();
  }, [effectiveUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync from prop (skips if WS update was recent or a toggle is pending) ──
  useEffect(() => {
    if (!effectiveUser?.driver_status || status === effectiveUser.driver_status) return;
    if (lastRequestedStatusRef.current && effectiveUser.driver_status !== lastRequestedStatusRef.current) return;
    if (!isTogglingRef.current && Date.now() - lastWebSocketUpdateRef.current < 5000) return;

    setStatus(effectiveUser.driver_status);
    if (isOwnUser) locationTracker.setDriverStatus(effectiveUser.driver_status);
    if (effectiveUser.driver_status === lastRequestedStatusRef.current) lastRequestedStatusRef.current = null;
  }, [effectiveUser?.driver_status, status]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Listen for AppUser updates from WS / mutation broadcast ──
  useEffect(() => {
    const applyStatusUpdate = (newDriverStatus) => {
      if (isTogglingRef.current) return;
      if (lastWsStatusRef.current === newDriverStatus) return;
      if (newDriverStatus === lastRequestedStatusRef.current) lastRequestedStatusRef.current = null;

      lastWebSocketUpdateRef.current = Date.now();
      lastWsStatusRef.current = newDriverStatus;

      setStatus(prev => {
        if (prev === newDriverStatus) return prev;
        if (isOwnUser) locationTracker.setDriverStatus(newDriverStatus);
        return newDriverStatus;
      });
    };

    const handleAppUserUpdated = (event) => {
      const { appUser } = event.detail || {};
      if (!appUser || typeof appUser.driver_status === 'undefined') return;
      const isMatch = (appUserId && appUser.id === appUserId) || appUser.user_id === effectiveUser?.id;
      if (isMatch) applyStatusUpdate(appUser.driver_status);
    };

    const handleEntityMutationBroadcast = (event) => {
      const { entity, id, data } = event.detail || {};
      if (entity !== 'AppUser' || !data || typeof data.driver_status === 'undefined') return;
      const isMatch = (appUserId && (id === appUserId || data.id === appUserId)) || data.user_id === effectiveUser?.id;
      if (isMatch) applyStatusUpdate(data.driver_status);
    };

    window.addEventListener('appUserUpdated', handleAppUserUpdated);
    window.addEventListener('entityMutationBroadcast', handleEntityMutationBroadcast);
    return () => {
      window.removeEventListener('appUserUpdated', handleAppUserUpdated);
      window.removeEventListener('entityMutationBroadcast', handleEntityMutationBroadcast);
    };
  }, [appUserId, effectiveUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Main toggle handler ──
  const handleStatusChange = useCallback(async (newStatus) => {
    if (isUpdating || pendingStatus || isTogglingRef.current) return;
    if (newStatus === status) return;
    if (!appUserId) { console.error('[DriverStatusToggle] No AppUser ID'); return; }

    isTogglingRef.current = true;

    const today = getTodayStr();
    // Use the globally selected date (what the admin/driver has selected in the UI) as the authoritative route date
    const selectedRouteDate = globalFilters.getSelectedDate() || today;
    const optimizerDate = newStatus === 'on_duty' ? today : selectedRouteDate;

    // Block going off_duty mid-route
    if (newStatus === 'off_duty') {
      try {
        const todayDeliveries = await base44.entities.Delivery.filter({ driver_id: effectiveUser?.id, delivery_date: selectedRouteDate });
        // Only block if a stop is actively in progress (en_route or in_transit)
        const inProgressStops = todayDeliveries.filter(d => d.status === 'en_route' || d.status === 'in_transit');
        if (inProgressStops.length > 0) {
          toast.error(`Cannot go off duty — ${inProgressStops.length} stop${inProgressStops.length > 1 ? 's' : ''} currently in progress`);
          isTogglingRef.current = false;
          return;
        }
      } catch (error) {
        console.error('[DriverStatusToggle] Could not check active stops:', error);
      }
    }

    setIsUpdating(true);
    setPendingStatus(newStatus);
    setIsEntityUpdating(true);
    sessionStorage.setItem('driver_status_change_in_progress', Date.now().toString());
    await new Promise(resolve => setTimeout(resolve, 100));

    const previousStatus = status;
    let updatePayload = null;

    try {
      lastRequestedStatusRef.current = newStatus;
      lastWsStatusRef.current = null;
      setStatus(newStatus); // optimistic

      let deviceId = localStorage.getItem('rxdeliver_device_id');
      if (!deviceId) {
        deviceId = `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        localStorage.setItem('rxdeliver_device_id', deviceId);
      }

      const { smartRefreshManager } = await import('../utils/smartRefreshManager');
      smartRefreshManager.registerPendingAppUserUpdate(appUserId, 'driver_status');
      smartRefreshManager.pause();

      // Get fresh GPS for on_duty / on_break
      let gps = { lat: effectiveUser?.current_latitude, lng: effectiveUser?.current_longitude };
      if (newStatus === 'on_duty' || newStatus === 'on_break') {
        const freshGps = await getFreshGPS(3000);
        if (freshGps) gps = freshGps;
      }

      updatePayload = buildUpdatePayload(newStatus, gps.lat, gps.lng);

      if (newStatus === 'on_duty') {
        try { localStorage.setItem('rxdeliver_show_routes', 'true'); } catch (_) {}
        try { window.dispatchEvent(new CustomEvent('forceEnableRoutes')); } catch (_) {}
      }

      // Persist to API + offline DB
      const updatedAppUser = await base44.entities.AppUser.update(appUserId, updatePayload);
      const { offlineDB } = await import('../utils/offlineDatabase');
      // CRITICAL: Merge the API response with the EXISTING offline DB record AND the
      // update payload. IndexedDB `put` REPLACES the entire record — it does NOT merge.
      // If the SDK response omits fields (app_roles, user_name, etc.), saving just the
      // response + updatePayload would permanently lose those fields in the offline DB.
      // Future reads via getEffectiveUser/getAppUserByUserId would then return a merged
      // user with empty app_roles, causing "No Role" in the sidebar and null driver_status.
      const existingRecord = await offlineDB.getById(offlineDB.STORES.APP_USERS, appUserId).catch(() => ({})) || {};
      const safeRecord = { ...existingRecord, ...updatedAppUser, ...updatePayload, id: appUserId };
      await offlineDB.save(offlineDB.STORES.APP_USERS, safeRecord);

      // Clear isNextDelivery flags when going off_duty or on_break
      if (newStatus === 'off_duty' || newStatus === 'on_break') {
        try {
          // Fetch fresh from API — local cache may be stale or filtered differently
          const routeDeliveries = await base44.entities.Delivery.filter({
            driver_id: effectiveUser.id,
            delivery_date: optimizerDate,
          });
          const flagged = (routeDeliveries || []).filter(d => d?.isNextDelivery === true);
          if (flagged.length > 0) {
            await Promise.all(flagged.map(d =>
              base44.entities.Delivery.update(d.id, { isNextDelivery: false }).catch(() => null)
            ));
            if (appDataContext?.updateDeliveriesLocally) {
              appDataContext.updateDeliveriesLocally(flagged.map(d => ({ ...d, isNextDelivery: false })), false);
            }
            console.log(`[DriverStatusToggle] Cleared isNextDelivery on ${flagged.length} stops for driver ${effectiveUser.id} on ${optimizerDate}`);
          }
        } catch (e) { console.warn('[DriverStatusToggle] Could not clear isNextDelivery flags:', e?.message); }
      }

      // Call backend (handles isNextDelivery clearing, single-device enforcement, etc.)
      const result = await base44.functions.invoke('setDriverStatus', {
        newStatus,
        deviceId,
        selectedDate: optimizerDate,
        disableLocationTracking: newStatus === 'off_duty',
        targetUserId: effectiveUser.id,
      });

      const confirmedStatus = result?.data?.driver_status || newStatus;
      setStatus(confirmedStatus);
      if (isOwnUser) locationTracker.setDriverStatus(confirmedStatus);
      if (confirmedStatus === lastRequestedStatusRef.current) lastRequestedStatusRef.current = null;

      // NOTE: Do NOT invalidate('AppUser') here — it triggers hasCurrentUserRefreshImpact
      // in Layout which causes a full data reload + sidebar wipe. The optimistic update
      // and broadcastMutation at the end of this handler are sufficient to sync all UI.
      const { invalidate } = await import('../utils/dataManager');
      invalidate('Delivery');

      // ── Location tracker side-effects (own device only) ──
      if (isOwnUser) {
        if (newStatus === 'off_duty') {
          locationTracker.setDriverStatus(newStatus);
          if (!locationTracker._webOnlyMode) {
            locationTracker.stopTracking();
            await locationTracker.startWebOnlyTracking({ ...currentUser, appUserId }).catch(() => {});
          }
          window.dispatchEvent(new CustomEvent('locationSharingDisabled'));
        } else if (newStatus === 'on_break') {
          locationTracker.setDriverStatus(newStatus);
          window.dispatchEvent(new CustomEvent('locationSharingDisabled'));
          try {
            const settings = await loadUserSettings(currentUser.id);
            const currentPhase = settings?.fab_map_cycle_phase || 1;
            setSavedPhaseBeforeBreak(currentPhase);
            fabControlEvents.notifyBreakStart(currentPhase);
          } catch (e) { console.error('[DriverStatusToggle] Break phase save failed:', e); }
        } else if (newStatus === 'on_duty') {
          await reconcilePendingBreadcrumbsOnDuty({
            driverUserId: currentUser.id,
            appUsers: [{ id: appUserId, user_id: currentUser.id }],
            currentDateStr: today
          });
          locationTracker.setDriverStatus(newStatus);
          if (locationTracker._webOnlyMode) {
            await locationTracker.upgradeToFullTracking({ ...currentUser, appUserId });
          } else if (!locationTracker.isTracking) {
            await locationTracker.startTracking({ ...currentUser, appUserId });
          }

          // Restore FAB phase
          if (savedPhaseBeforeBreak) {
            fabControlEvents.notifyBreakEnd(savedPhaseBeforeBreak);
            setSavedPhaseBeforeBreak(null);
          } else {
            fabControlEvents.notifyBreakEnd(1);
          }

          // Trigger the manual FAB reoptimize flow — it correctly assigns isNextDelivery
          // and updates stop order via the proven optimization path.
          fabControlEvents.notifyOnDutyFromToggle();
        }
      }

      if (onStatusChange) onStatusChange(newStatus);

    } catch (error) {
      console.error('[DriverStatusToggle] Failed to update status:', error);
      lastRequestedStatusRef.current = null;
      setStatus(previousStatus);
      if (isOwnUser) locationTracker.setDriverStatus(previousStatus);
      // CRITICAL: Revert the offline DB to match the reverted React state.
      // The frontend AppUser.update may have succeeded but the backend function
      // (setDriverStatus) failed — leaving the offline DB with the new status
      // while the UI shows the old one. Without this revert, getEffectiveUser()
      // would read the stale new status from offline DB.
      if (appUserId && previousStatus) {
        try {
          const { offlineDB } = await import('../utils/offlineDatabase');
          const existingAppUser = await offlineDB.getById(offlineDB.STORES.APP_USERS, appUserId);
          if (existingAppUser && existingAppUser.driver_status !== previousStatus) {
            await offlineDB.save(offlineDB.STORES.APP_USERS, { ...existingAppUser, driver_status: previousStatus });
          }
        } catch (_) {}
      }
      toast.error('Failed to update status. Please try again.');
      try {
        const { smartRefreshManager } = await import('../utils/smartRefreshManager');
        smartRefreshManager.resume();
      } catch (_) {}
    } finally {
      setIsUpdating(false);
      setIsEntityUpdating(false);
      setPendingStatus(null);
      sessionStorage.removeItem('driver_status_change_in_progress');
      isTogglingRef.current = false;

      // Broadcast UI updates NOW — isTogglingRef is cleared so listeners won't drop them
      if (appUserId && updatePayload) {
        const finalData = { id: appUserId, user_id: effectiveUser.id, ...updatePayload };
        if (appDataContext?.updateAppUsersLocally) {
          appDataContext.updateAppUsersLocally([finalData], false);
        }
        window.dispatchEvent(new CustomEvent('appUserUpdated', { detail: { appUser: finalData } }));
        window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: [finalData], mergeMode: 'merge' } }));
        window.dispatchEvent(new CustomEvent('driverStatusChanged', { detail: { userId: effectiveUser.id, newStatus: updatePayload.driver_status } }));
        // Ensure other devices receive the update via WS broadcast
        broadcastMutation('AppUser', 'update', appUserId, finalData);
      }

      setTimeout(async () => {
        try {
          const { smartRefreshManager } = await import('../utils/smartRefreshManager');
          smartRefreshManager.resume();
        } catch (_) {}
      }, 500);
    }
  }, [status, isUpdating, appUserId, effectiveUser, isOwnUser, currentUser, onStatusChange, setIsEntityUpdating, savedPhaseBeforeBreak, appDataContext]); // eslint-disable-line react-hooks/exhaustive-deps

  const statusConfig = {
    off_duty:  { label: 'Off', activeColor: 'bg-red-600' },
    on_duty:   { label: 'On',  activeColor: 'bg-emerald-600' },
    on_break:  { label: 'Br',  activeColor: 'bg-blue-600' },
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
        <div className={cn(
          "absolute rounded-full transition-all duration-200 ease-out shadow-sm",
          currentConfig.activeColor,
          vertical ? "w-7 h-8" : "h-7 w-8",
          vertical && status === 'off_duty'  && 'top-0.5',
          vertical && status === 'on_duty'   && 'top-[calc(33.33%-2px)]',
          vertical && status === 'on_break'  && 'top-[calc(66.66%-4px)]',
          !vertical && status === 'off_duty' && 'left-0.5',
          !vertical && status === 'on_duty'  && 'left-[calc(33.33%-2px)]',
          !vertical && status === 'on_break' && 'left-[calc(66.66%-4px)]'
        )} />

        {Object.entries(statusConfig).map(([key, cfg]) => (
          <button
            key={key}
            onClick={() => handleStatusChange(key)}
            disabled={isUpdating}
            className={cn(
              "relative z-10 flex flex-1 items-center justify-center rounded-full font-bold leading-none transition-colors min-h-0",
              vertical ? "h-1/3 w-full text-[9px]" : "h-full text-[10px]",
              status === key ? 'text-white' : ''
            )}
            style={status !== key ? { color: 'var(--text-slate-500)' } : {}}
          >
            {cfg.label}
          </button>
        ))}
      </div>
    </div>
  );
}