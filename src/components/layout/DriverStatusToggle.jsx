import React, { useState, useEffect, useCallback } from "react";
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

/**
 * 3-way driver status toggle for mobile header
 * Left: Off Duty (Red) - Disables location sharing
 * Center: On Duty (Green) - Enables location sharing
 * Right: On Break (Blue) - Disables location sharing
 */
export default function DriverStatusToggle({ currentUser, onStatusChange, onBreakStart, onBreakEnd }) {
  const [status, setStatus] = useState(currentUser?.driver_status || 'off_duty');
  const [isUpdating, setIsUpdating] = useState(false);
  const [appUserId, setAppUserId] = useState(null);
  const [savedPhaseBeforeBreak, setSavedPhaseBeforeBreak] = useState(null);
  const appDataContext = useAppData();
  const setIsEntityUpdating = appDataContext?.setIsEntityUpdating || (() => {});

  // Find AppUser ID and initialize locationTracker's status on mount
  useEffect(() => {
    const initAppUserAndTracker = async () => {
      if (!currentUser?.id) return;
      
      try {
        const appUsers = await base44.entities.AppUser.filter({ user_id: currentUser.id });
        if (appUsers && appUsers.length > 0) {
          const fetchedAppUser = appUsers[0];
          setAppUserId(fetchedAppUser.id);
          
          // Initialize locationTracker with current driver status
          locationTracker.setDriverStatus(fetchedAppUser.driver_status || 'off_duty');
          console.log(`📍 [DriverStatusToggle] Initialized locationTracker status to: ${fetchedAppUser.driver_status || 'off_duty'}`);
          
          // Sync status locally
          if (fetchedAppUser.driver_status && fetchedAppUser.driver_status !== status) {
            setStatus(fetchedAppUser.driver_status);
          }
        }
      } catch (error) {
        console.error('Failed to find AppUser ID or initialize tracker:', error);
      }
    };
    
    initAppUserAndTracker();
  }, [currentUser?.id]);

  // Sync status from currentUser prop and poll AppUser directly for real-time updates
  // CRITICAL: Skip polling when isUpdating to prevent bouncing during status changes
  useEffect(() => {
    // Don't poll during updates - this was causing the bounce issue
    if (isUpdating) {
      console.log('⏸️ [DriverStatusToggle] Skipping sync - update in progress');
      return;
    }
    
    const syncStatus = async () => {
      // Double-check isUpdating hasn't changed
      if (isUpdating || !currentUser?.id) return;
      
      try {
        // Fetch fresh AppUser data directly
        const appUsers = await base44.entities.AppUser.filter({ user_id: currentUser.id });
        if (appUsers && appUsers.length > 0) {
          const freshStatus = appUsers[0].driver_status;
          if (freshStatus && freshStatus !== status) {
            console.log(`🔄 [DriverStatusToggle] Detected status change: ${status} → ${freshStatus}`);
            setStatus(freshStatus);
            // Update locationTracker's status if it changes externally
            locationTracker.setDriverStatus(freshStatus);
            console.log(`📍 [DriverStatusToggle] Updated locationTracker status to: ${freshStatus}`);
          }
        }
      } catch (error) {
        console.warn('⚠️ [DriverStatusToggle] Could not fetch fresh status:', error);
      }
    };
    
    syncStatus(); // Initial sync
    const interval = setInterval(syncStatus, 3000); // Poll every 3 seconds
    
    return () => clearInterval(interval);
  }, [currentUser?.id, status, isUpdating]);

  // Track pending status to prevent race conditions
  const [pendingStatus, setPendingStatus] = useState(null);
  
  const handleStatusChange = useCallback(async (newStatus) => {
    if (isUpdating || newStatus === status || !appUserId) return;
    
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
      
      // CRITICAL: Call backend function to enforce single active device
      console.log('📱 Calling setDriverStatus backend function...');
      const result = await base44.functions.invoke('setDriverStatus', {
        newStatus,
        deviceId
      });
      
      console.log('✅ Backend status update result:', result.data);
      
      // Invalidate caches to force fresh data fetch
      const { invalidate } = await import('../utils/dataManager');
      invalidate('AppUser');
      invalidate('Delivery');
      
      // Update location tracker based on new status
      const shouldEnableTracking = newStatus === 'on_duty';
      
      if (!shouldEnableTracking) {
        locationTracker.stopTracking();
        locationTracker.setDriverStatus(newStatus);
        console.log('🛑 Location tracking stopped (off duty/on break)');
        
        // If going on break, save current FAB phase and notify Dashboard
            // Note: Backend already cleared isNextDelivery flags in setDriverStatus
            if (newStatus === 'on_break') {
              try {
                // Load user settings to get current FAB phase
                const settings = await loadUserSettings(currentUser.id);
                const currentPhase = settings?.fab_map_cycle_phase || 1;
                setSavedPhaseBeforeBreak(currentPhase);
                console.log(`💾 [DriverStatusToggle] Saved FAB phase before break: ${currentPhase}`);

                // Notify Dashboard to unlock FAB and zoom to phase 1
                fabControlEvents.notifyBreakStart(currentPhase);

                // No need to clear isNextDelivery here - backend already did it
                console.log('ℹ️ [DriverStatusToggle] Backend already cleared isNextDelivery flags');
              } catch (error) {
                console.error('Failed to save phase:', error);
              }
            }
      } else {
        // Going on duty - start location tracking and set next delivery
        try {
          console.log('🟢 Starting location tracking (on duty)...');
          
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
          
          locationTracker.setDriverStatus(newStatus);
          
          await locationTracker.startTracking({
            ...currentUser,
            appUserId: appUserId
          });
          console.log('✅ Location tracking started');
          
          // Set next stop in line when going on duty
          const todayDeliveries = await base44.entities.Delivery.filter({
            driver_id: currentUser?.id,
            delivery_date: today
          });
          
          const incompleteDeliveries = todayDeliveries
            .filter(d => !finishedStatuses.includes(d.status))
            .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
          
          if (incompleteDeliveries.length > 0) {
            const nextStop = incompleteDeliveries[0];
            await base44.entities.Delivery.update(nextStop.id, { isNextDelivery: true });
            console.log(`✅ Set isNextDelivery=true for next stop: ${nextStop.patient_name || 'Pickup'}`);
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
    } finally {
      console.log('▶️ [DRIVER STATUS] Resuming smart refresh');
      
      // CRITICAL: Add delay before clearing isUpdating to prevent sync from overwriting
      setTimeout(() => {
        setIsUpdating(false);
        setPendingStatus(null);
        setIsEntityUpdating(false);
        console.log('✅ [DRIVER STATUS] Driver status change cycle complete');
      }, 500);
    }
  }, [status, isUpdating, appUserId, currentUser, onStatusChange, setIsEntityUpdating]);

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
          "relative flex items-center h-8 w-24 rounded-full bg-slate-200 p-0.5 transition-all",
          isUpdating && "opacity-50 pointer-events-none"
        )}
      >
        {/* Sliding indicator */}
        <div 
          className={cn(
            "absolute h-7 w-8 rounded-full transition-all duration-200 ease-out shadow-sm",
            currentConfig.activeColor,
            status === 'off_duty' && 'left-0.5',
            status === 'on_duty' && 'left-[calc(33.33%-2px)]',
            status === 'on_break' && 'left-[calc(66.66%-4px)]'
          )}
        />
        
        {/* Off Duty button */}
        <button
          onClick={() => handleStatusChange('off_duty')}
          disabled={isUpdating}
          className={cn(
            "relative z-10 flex-1 h-full flex items-center justify-center text-[10px] font-bold rounded-full transition-colors",
            status === 'off_duty' ? 'text-white' : 'text-slate-500 hover:text-slate-700'
          )}
          title="Off Duty - Location sharing disabled"
        >
          Off
        </button>
        
        {/* On Duty button */}
        <button
          onClick={() => handleStatusChange('on_duty')}
          disabled={isUpdating}
          className={cn(
            "relative z-10 flex-1 h-full flex items-center justify-center text-[10px] font-bold rounded-full transition-colors",
            status === 'on_duty' ? 'text-white' : 'text-slate-500 hover:text-slate-700'
          )}
          title="On Duty - Location sharing enabled"
        >
          On
        </button>
        
        {/* On Break button */}
        <button
          onClick={() => handleStatusChange('on_break')}
          disabled={isUpdating}
          className={cn(
            "relative z-10 flex-1 h-full flex items-center justify-center text-[10px] font-bold rounded-full transition-colors",
            status === 'on_break' ? 'text-white' : 'text-slate-500 hover:text-slate-700'
          )}
          title="On Break - Location sharing disabled"
        >
          Break
        </button>
      </div>
    </div>
  );
}