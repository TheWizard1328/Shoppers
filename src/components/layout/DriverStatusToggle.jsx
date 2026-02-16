import React, { useState, useEffect, useCallback, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { locationTracker } from "../utils/locationTracker";
import { cn } from "@/lib/utils";
import { optimizeDriverRoute } from "@/functions/optimizeDriverRoute";
import { triggerRouteOptimization } from "../utils/realTimeRouteOptimizer";
import { format } from "date-fns";
import { toast } from "sonner";
import { useAppData } from "../utils/AppDataContext";
import { fabControlEvents } from "../utils/fabControlEvents";
import { loadUserSettings, getSetting } from "../utils/userSettingsManager";

// Lazy load broadcastMutation to avoid circular dependency issues
const broadcastMutation = async (entity, action, id, data) => {
  try {
    const { broadcastMutation: broadcast } = await import('../utils/realtimeSync');
    return broadcast(entity, action, id, data);
  } catch (error) {
    console.warn('[DriverStatusToggle] Could not broadcast mutation:', error.message);
  }
};

/**
 * 3-way driver status toggle for mobile header
 * Left: Off Duty (Red) - Disables location sharing
 * Center: On Duty (Green) - Enables location sharing
 * Right: On Break (Blue) - Disables location sharing
 */
export default function DriverStatusToggle({ currentUser, onStatusChange, onBreakStart, onBreakEnd, vertical = false }) {
  // CRITICAL: Move all hooks to top before any conditions - prevents hook mismatch errors
  const [status, setStatus] = useState(null); // Will sync from currentUser prop
  const [isUpdating, setIsUpdating] = useState(false);
  const [pendingStatus, setPendingStatus] = useState(null);
  const [appUserId, setAppUserId] = useState(null);
  const [savedPhaseBeforeBreak, setSavedPhaseBeforeBreak] = useState(null);
  const appDataContext = useAppData();
  const setIsEntityUpdating = appDataContext?.setIsEntityUpdating || (() => {});
  const isTogglingRef = useRef(false);

  // Find AppUser ID on mount
  useEffect(() => {
    const initAppUser = async () => {
      if (!currentUser?.id) return;
      
      try {
        const appUsers = await base44.entities.AppUser.filter({ user_id: currentUser.id });
        if (appUsers && appUsers.length > 0) {
          const fetchedAppUser = appUsers[0];
          setAppUserId(fetchedAppUser.id);
          // Initialize status from AppUser entity
          setStatus(fetchedAppUser.driver_status || 'off_duty');
          locationTracker.setDriverStatus(fetchedAppUser.driver_status || 'off_duty');
          console.log(`📍 [DriverStatusToggle] Initialized status to: ${fetchedAppUser.driver_status || 'off_duty'}`);
        }
      } catch (error) {
        console.error('Failed to find AppUser ID:', error);
      }
    };
    
    initAppUser();
  }, [currentUser?.id]);

  // Sync from currentUser prop changes when not toggling
  useEffect(() => {
    if (!isTogglingRef.current && currentUser?.driver_status && status !== currentUser.driver_status) {
      setStatus(currentUser.driver_status);
      locationTracker.setDriverStatus(currentUser.driver_status);
      console.log(`✅ [DriverStatusToggle] Syncing from currentUser prop: ${currentUser.driver_status}`);
    }
  }, [currentUser?.driver_status, status]);

  // Listen for AppUser entity updates from WebSocket to sync status across devices
  useEffect(() => {
    const handleAppUserUpdate = (event) => {
      const { entity, action, id, data } = event.detail || {};
      
      if (entity !== 'AppUser' || !data || !currentUser) return;
      
      // CRITICAL: Check multiple ID fields to catch the update
      const isCurrentUser = (
        (appUserId && id === appUserId) ||
        (appUserId && data?.id === appUserId) ||
        (data?.user_id === currentUser.id)
      );
      
      if (isCurrentUser && typeof data.driver_status !== 'undefined') {
        console.log(`📡 [DriverStatusToggle] WebSocket update - syncing status to: ${data.driver_status}`);
        
        // Skip if still toggling
        if (isTogglingRef.current) {
          console.log('⏸️ [DriverStatusToggle] Still toggling - will sync after toggle completes');
          return;
        }
        
        // CRITICAL: Only update if the value actually changed
        setStatus(prev => {
          if (prev === data.driver_status) {
            return prev; // No change - keep current state
          }
          locationTracker.setDriverStatus(data.driver_status);
          return data.driver_status;
        });
      }
    };

    window.addEventListener('entityMutationBroadcast', handleAppUserUpdate);
    return () => window.removeEventListener('entityMutationBroadcast', handleAppUserUpdate);
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
    
    const today = format(new Date(), 'yyyy-MM-dd');
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    
    // Check if driver can go off_duty
    // RULE: Can go off duty if NO completed stops (route hasn't started) OR all stops are finished
    if (newStatus === 'off_duty') {
      try {
        const todayDeliveries = await base44.entities.Delivery.filter({
          driver_id: currentUser?.id,
          delivery_date: today
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
      let currentLat = currentUser?.current_latitude;
      let currentLng = currentUser?.current_longitude;
      
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
        // Keep coordinates but clear timestamp to signal sharing is OFF
        updatePayload.current_latitude = currentLat;
        updatePayload.current_longitude = currentLng;
        updatePayload.location_updated_at = null; // CRITICAL: Null timestamp = not sharing
      }
      
      // CRITICAL: Update AppUser entity IMMEDIATELY with all fields
      console.log('📝 [DriverStatusToggle] Updating AppUser with:', updatePayload);
      const updatedAppUser = await base44.entities.AppUser.update(appUserId, updatePayload);
      console.log('✅ [DriverStatusToggle] AppUser updated successfully');

      // CRITICAL: Save to offline DB immediately
      const { offlineDB } = await import('../utils/offlineDatabase');
      await offlineDB.save(offlineDB.STORES.APP_USERS, updatedAppUser);
      console.log('💾 [DriverStatusToggle] Saved to offline DB:', updatedAppUser);

      // CRITICAL: Broadcast status change to other devices via WebSocket
      // Ensure we broadcast ALL the fields we just updated
      const broadcastData = {
        id: appUserId,
        user_id: currentUser.id,
        ...updatedAppUser,
        ...updatePayload // Include our update payload to guarantee all fields are present
      };
      broadcastMutation('AppUser', 'update', appUserId, broadcastData);
      console.log('📡 [DriverStatusToggle] Broadcasted update:', broadcastData);
      
      // CRITICAL: Dispatch event to update self marker color immediately
      window.dispatchEvent(new CustomEvent('driverStatusChanged', {
        detail: { userId: currentUser.id, newStatus }
      }));
      
      // CRITICAL: Call backend function to enforce single active device
      console.log('📱 Calling setDriverStatus backend function...');
      const result = await base44.functions.invoke('setDriverStatus', {
        newStatus,
        deviceId,
        disableLocationTracking: newStatus === 'off_duty' // Only disable tracking when off duty
      });
      
      console.log('✅ Backend status update result:', result.data);
      
      // CRITICAL: DO NOT fetch fresh data - trust our update
      // The update was already applied, fetching again can cause race conditions with stale data
      console.log('💾 [DriverStatusToggle] Updating local offline database with our changes...');
      const { updateAppUserLocal } = await import('../utils/offlineMutations');
      try {
        await updateAppUserLocal(appUserId, updatePayload);
        console.log('✅ [DriverStatusToggle] Local offline database updated');
      } catch (offlineError) {
        console.warn('⚠️ [DriverStatusToggle] Failed to update local database:', offlineError);
      }
      
      // Invalidate caches to force fresh data fetch
      const { invalidate } = await import('../utils/dataManager');
      invalidate('AppUser');
      invalidate('Delivery');
      
      // Update location tracker based on new status
      const shouldEnableTracking = newStatus === 'on_duty' || newStatus === 'on_break';
      
      if (!shouldEnableTracking) {
        // Going OFF DUTY - stop sharing location
        locationTracker.setDriverStatus(newStatus);
        console.log('📍 [DriverStatusToggle] Status set to ' + newStatus + ' - location sharing disabled');
        
        // CRITICAL: Dispatch event to force LocationTrackingToggle UI refresh
        window.dispatchEvent(new CustomEvent('locationSharingDisabled'));
        
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
                
                // CRITICAL: Force refresh deliveries to show updated UI
                if (appDataContext?.refreshData) {
                  console.log('🔄 [DriverStatusToggle] Forcing delivery refresh after break start...');
                  await appDataContext.refreshData(true);
                }
              } catch (error) {
                console.error('Failed to save phase:', error);
              }
            }
      } else {
        // Going on duty - start location tracking and set next delivery
        try {
          console.log('🟢 Starting location tracking (on duty)...');
          
          // CRITICAL: Set driver status BEFORE starting tracker
          locationTracker.setDriverStatus(newStatus);
          
          // CRITICAL: Start location tracking (even if toggle isn't visible)
          // This ensures GPS updates continue in the background
          await locationTracker.startTracking({
            ...currentUser,
            appUserId: appUserId
          });
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
          
          // Backend already set isNextDelivery flag and triggered ETA recalculation
          console.log('✅ [DriverStatusToggle] Backend set isNextDelivery flag and recalculated ETAs');
          
          // CRITICAL: Force refresh deliveries to show updated isNextDelivery and ETAs
          if (appDataContext?.refreshData) {
            console.log('🔄 [DriverStatusToggle] Forcing delivery refresh after going on duty...');
            await appDataContext.refreshData(true);
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
            deliveryDate: today,
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
      }
      
      // Notify parent component
      if (onStatusChange) {
        onStatusChange(newStatus);
      }
      
    } catch (error) {
      console.error('❌ Failed to update driver status:', error);
      setStatus(previousStatus);
      toast.error('Failed to update status. Please try again.');
      
      // Resume smart refresh on error
      try {
        const { smartRefreshManager } = await import('../utils/smartRefreshManager');
        smartRefreshManager.resume();
      } catch (e) {}
    } finally {
      console.log('▶️ [DRIVER STATUS] Resuming smart refresh');
      
      // CRITICAL: Clear updating flags immediately so UI is responsive
      // Backend status change is already applied
      setPendingStatus(null);
      setIsUpdating(false);
      setIsEntityUpdating(false);
      
      // CRITICAL: Clear the status change flag to allow activity monitor to resume
      sessionStorage.removeItem('driver_status_change_in_progress');
      
      // Resume smart refresh after short delay to let status propagate
      setTimeout(async () => {
        try {
          const { smartRefreshManager } = await import('../utils/smartRefreshManager');
          smartRefreshManager.resume();
          console.log('▶️ [DriverStatusToggle] Smart refresh resumed');
        } catch (e) {
          console.warn('⚠️ [DriverStatusToggle] Failed to resume smart refresh:', e);
        }
        
        // CRITICAL: Clear toggling flag after delay
        isTogglingRef.current = false;
        console.log('✅ [DRIVER STATUS] Driver status change cycle complete');
      }, 500); // Reduced to 500ms since UI is already unblocked
    }
  }, [status, isUpdating, appUserId, currentUser, onStatusChange, setIsEntityUpdating, savedPhaseBeforeBreak, appDataContext]);

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
      label: 'Break',
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
            "relative z-10 flex-1 flex items-center justify-center text-[10px] font-bold rounded-full transition-colors",
            vertical ? "w-full" : "h-full",
            status === 'off_duty' ? 'text-white' : ''
          )}
          style={status !== 'off_duty' ? { color: 'var(--text-slate-500)' } : {}}
          title="Off Duty - Location sharing disabled"
        >
          Off
        </button>
        
        {/* On Duty button */}
        <button
          onClick={() => handleStatusChange('on_duty')}
          disabled={isUpdating}
          className={cn(
            "relative z-10 flex-1 flex items-center justify-center text-[10px] font-bold rounded-full transition-colors",
            vertical ? "w-full" : "h-full",
            status === 'on_duty' ? 'text-white' : ''
          )}
          style={status !== 'on_duty' ? { color: 'var(--text-slate-500)' } : {}}
          title="On Duty - Location sharing enabled"
        >
          On
        </button>
        
        {/* On Break button */}
        <button
          onClick={() => handleStatusChange('on_break')}
          disabled={isUpdating}
          className={cn(
            "relative z-10 flex-1 flex items-center justify-center text-[10px] font-bold rounded-full transition-colors",
            vertical ? "w-full" : "h-full",
            status === 'on_break' ? 'text-white' : ''
          )}
          style={status !== 'on_break' ? { color: 'var(--text-slate-500)' } : {}}
          title="On Break - Location sharing disabled"
        >
          Break
        </button>
      </div>
    </div>
  );
}