import React, { useState, useEffect, useRef, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { MapPinOff, AlertCircle, Activity, RefreshCw, Satellite, Eye, EyeOff } from "lucide-react";
import { locationTracker } from "../utils/locationTracker";
import { base44 } from "@/api/base44Client";
import { userHasRole } from "../utils/userRoles";
import { isMobileDevice as checkIsMobileDevice } from "../utils/deviceUtils";

export default function LocationTrackingToggle({ user, onUserUpdate, onLocationStatusChange }) {
  // CRITICAL FIX: ALL HOOKS MUST BE AT THE TOP, BEFORE ANY CONDITIONAL RETURNS
  const [isToggling, setIsToggling] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState('');
  const [trackingStatus, setTrackingStatus] = useState(null);
  const [localUser, setLocalUser] = useState(user);
  const [lastUpdateTime, setLastUpdateTime] = useState(null);
  const [nextUpdateIn, setNextUpdateIn] = useState(null);
  const [hasError, setHasError] = useState(false);
  const [gpsCapabilities, setGpsCapabilities] = useState(null);
  const autoStartedRef = useRef(false);
  const consecutiveErrorsRef = useRef(0);
  // CRITICAL: Track toggle state independently to prevent reversion during data refresh
  const [isLocationSharingEnabled, setIsLocationSharingEnabled] = useState(user?.location_tracking_enabled || false);

  // CRITICAL: Check device/role conditions ONCE on mount with stable values
  const isMobile = useMemo(() => checkIsMobileDevice(), []);
  const isDriver = useMemo(() => user ? userHasRole(user, 'driver') : false, [user]);
  const isAdmin = useMemo(() => user ? userHasRole(user, 'admin') : false, [user]);

  // Always sync localUser with user prop
  useEffect(() => {
    if (user) {
      console.log('🔄 [LocationSharing] Syncing localUser with user prop:', {
        location_tracking_enabled: user.location_tracking_enabled,
        driver_status: user.driver_status,
        current_latitude: user.current_latitude,
        current_longitude: user.current_longitude
      });
      setLocalUser(user);
      
      // CRITICAL: Only update isLocationSharingEnabled if NOT currently toggling
      // This prevents state reversion during toggle operation
      if (!isToggling) {
        setIsLocationSharingEnabled(user.location_tracking_enabled || false);
      }
    }
  }, [user, user?.driver_status, user?.location_tracking_enabled, isToggling]);

  // Listen for location sharing disabled event from DriverStatusToggle
  useEffect(() => {
    const handleSharingDisabled = async () => {
      console.log('📍 [LocationSharing] Received locationSharingDisabled event - updating UI');
      setLocalUser(prev => prev ? { ...prev, location_tracking_enabled: false } : prev);
      setIsLocationSharingEnabled(false);
    };

    window.addEventListener('locationSharingDisabled', handleSharingDisabled);
    return () => window.removeEventListener('locationSharingDisabled', handleSharingDisabled);
  }, []);

  // CRITICAL: Always start tracking on mobile devices for drivers/admins
  useEffect(() => {
    if (!isMobile || (!isDriver && !isAdmin) || !localUser?.id) return;

    const autoStartTracking = async () => {
      // Always auto-start tracking if not already running
      if (!locationTracker.isTracking && !autoStartedRef.current) {
        console.log('🚀 [LocationSharing] Auto-starting location tracking (always on for mobile drivers)');
        autoStartedRef.current = true;

        try {
          await locationTracker.startTracking(localUser);
          console.log('✅ [LocationSharing] Auto-start successful');
        } catch (error) {
          console.error('❌ [LocationSharing] Auto-start failed:', error);
          setPermissionStatus('Location access denied');
          setTimeout(() => setPermissionStatus(''), 3000);
        }
      }
    };

    autoStartTracking();
  }, [localUser?.id, isMobile, isDriver, isAdmin]);

  // Update tracking status and countdown periodically
  useEffect(() => {
    if (!isMobile || (!isDriver && !isAdmin)) return;

    const updateStatus = () => {
      const status = locationTracker.getStatus();
      setTrackingStatus(status);

      // Only show error if tracking is actually failing, not during normal operation
      if (status.isTracking) {
        // Tracking is running - clear any errors
        setHasError(false);
        consecutiveErrorsRef.current = 0;
      } else if (!localUser?.location_tracking_enabled) {
        // Sharing is disabled - clear error
        setHasError(false);
        consecutiveErrorsRef.current = 0;
      }

      // Update UI with timing info
      if (status.lastUpdate > 0) {
        setLastUpdateTime(new Date(status.lastUpdate));

        const timeSinceLastUpdate = Date.now() - status.lastUpdate;
        const timeUntilNextUpdate = Math.max(0, 30000 - timeSinceLastUpdate);
        setNextUpdateIn(Math.ceil(timeUntilNextUpdate / 1000));
      } else {
        setLastUpdateTime(null);
        setNextUpdateIn(null);
      }
    };

    updateStatus();
    const interval = setInterval(updateStatus, 1000);

    return () => clearInterval(interval);
  }, [isMobile, isDriver, isAdmin, localUser]);

  // Check GPS capabilities
  useEffect(() => {
    if (!isMobile || (!isDriver && !isAdmin)) return;

    if (typeof locationTracker.checkGPSCapabilities === 'function') {
      locationTracker.checkGPSCapabilities().then((capabilities) => {
        setGpsCapabilities(capabilities);
      });
    }
  }, [isMobile, isDriver, isAdmin]);

  // Determine location status and notify parent
  useEffect(() => {
    if (!onLocationStatusChange) return;

    const status = hasError ? 'error' :
    trackingStatus?.isTracking && Date.now() - trackingStatus.lastUpdate > 60000 ? 'stale' :
    'active';

    onLocationStatusChange(status);
  }, [hasError, trackingStatus, onLocationStatusChange]);

  const refreshUserState = async () => {
    try {
      console.log('🔄 [LocationSharing] Refreshing user state...');

      const authUser = await base44.auth.me();
      const appUsers = await base44.entities.AppUser.filter({ user_id: authUser.id });

      if (appUsers && appUsers.length > 0) {
        const appUser = appUsers[0];
        const mergedUser = {
          ...authUser,
          ...appUser,
          id: authUser.id,
          appUserId: appUser.id,
          user_name: appUser.user_name || authUser.full_name,
          app_roles: appUser.app_roles || []
        };

        setLocalUser(mergedUser);

        if (onUserUpdate) {
          onUserUpdate(mergedUser);
        }

        return mergedUser;
      }

      return authUser;
    } catch (error) {
      console.error('❌ [LocationSharing] Failed to refresh user state:', error);
      return null;
    }
  };

  const handleToggle = async (checked) => {
    if (isToggling) return;

    console.log('🎯 [LocationSharing] Sharing toggle clicked:', checked);

    setIsToggling(true);
    setPermissionStatus('');
    consecutiveErrorsRef.current = 0;
    setHasError(false);

    try {
      // Get AppUser ID
      let appUserId = localUser.appUserId;
      if (!appUserId) {
        const appUsers = await base44.entities.AppUser.filter({ user_id: localUser.id });
        if (appUsers && appUsers.length > 0) {
          appUserId = appUsers[0].id;
        }
      }

      if (!appUserId) {
        throw new Error('User profile not found');
      }

      if (checked) {
        // Enable sharing
        setPermissionStatus('Enabling location sharing...');
        // CRITICAL: Update UI state FIRST (optimistic update)
        setIsLocationSharingEnabled(true);
        
        await base44.entities.AppUser.update(appUserId, {
          location_tracking_enabled: true
        });

        // CRITICAL: Update localUser immediately so UI reflects new state
        const updatedUser = {
          ...localUser,
          location_tracking_enabled: true
        };
        setLocalUser(updatedUser);

        setPermissionStatus('Location sharing enabled!');
        console.log('✅ [LocationSharing] Sharing enabled');
      } else {
        // Disable sharing (but keep tracking)
        setPermissionStatus('Disabling location sharing...');
        // CRITICAL: Update UI state FIRST (optimistic update)
        setIsLocationSharingEnabled(false);
        
        await base44.entities.AppUser.update(appUserId, {
          location_tracking_enabled: false
        });

        // CRITICAL: Update localUser immediately so UI reflects new state
        const updatedUser = {
          ...localUser,
          location_tracking_enabled: false
        };
        setLocalUser(updatedUser);

        setPermissionStatus('Location sharing disabled');
        console.log('✅ [LocationSharing] Sharing disabled (tracking continues)');
      }

      // Refresh user state in background (don't await - let it happen async)
      refreshUserState().finally(() => {
        setTimeout(() => setPermissionStatus(''), 3000);
      });

    } catch (error) {
      console.error('❌ [LocationSharing] Failed to toggle:', error);
      setPermissionStatus(`Error: ${error.message}`);

      // CRITICAL: Revert optimistic update on error
      setIsLocationSharingEnabled(!checked);
      
      // Refresh user state to sync with backend
      refreshUserState().finally(() => {
        setTimeout(() => setPermissionStatus(''), 4000);
      });
    } finally {
      setIsToggling(false);
    }
  };

  const handleForceRefresh = async () => {
    if (isToggling) return;

    setIsToggling(true);
    setPermissionStatus('Refreshing location...');
    consecutiveErrorsRef.current = 0;
    setHasError(false);

    try {
      await locationTracker.restartTracking(localUser);
      setPermissionStatus('Location refreshed!');
    } catch (error) {
      console.error('Failed to refresh location:', error);
      setPermissionStatus('Refresh failed');
    } finally {
      setIsToggling(false);
      setTimeout(() => setPermissionStatus(''), 3000);
    }
  };

  const getStatusColor = () => {
    if (hasError) return 'text-red-500';
    if (trackingStatus?.isTracking) {
      const timeSinceUpdate = Date.now() - trackingStatus.lastUpdate;
      if (timeSinceUpdate < 60000) return 'text-emerald-500';
      if (timeSinceUpdate < 300000) return 'text-yellow-500';
      return 'text-orange-500';
    }
    return 'text-slate-400';
  };

  const getStatusIcon = () => {
    if (hasError) return <AlertCircle className="h-3 w-3 text-red-500" />;
    if (trackingStatus?.isTracking) {
      const timeSinceUpdate = Date.now() - trackingStatus.lastUpdate;
      if (timeSinceUpdate < 60000) {
        return <Activity className="h-3 w-3 text-emerald-500 animate-pulse" />;
      }
    }
    return <AlertCircle className="h-3 w-3 text-orange-500" />;
  };

  const getStatusText = () => {
    if (hasError) return 'Error';
    if (trackingStatus?.isTracking) {
      const timeSinceUpdate = Date.now() - trackingStatus.lastUpdate;
      if (timeSinceUpdate < 60000) {
        return nextUpdateIn !== null ? `Next: ${nextUpdateIn}s` : 'Active';
      }
      if (timeSinceUpdate < 300000) return 'Stale';
      return 'Old Data';
    }
    return 'Starting...';
  };

  // Conditional return AFTER all hooks
  if (!isMobile || (!isDriver && !isAdmin)) {
    return null;
  }

  if (!localUser) {
    return null;
  }

  // CRITICAL: Use independent state to prevent reversion during data refresh
  const isSharingEnabled = isLocationSharingEnabled;

  return (
    <div className="bg-transparent p-2 rounded-lg flex items-center gap-2 backdrop-blur-sm border border-white/40">
      <div className="flex items-center gap-2">
        {getStatusIcon()}
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <Label htmlFor="location-toggle" className="text-xs font-medium text-slate-700 cursor-pointer">
              Location Sharing
            </Label>
            <Switch
              id="location-toggle"
              checked={isSharingEnabled}
              onCheckedChange={handleToggle}
              disabled={isToggling}
              className="data-[state=checked]:bg-emerald-500" />

            {isSharingEnabled ?
            <Eye className="h-3 w-3 text-emerald-600" /> :
            <EyeOff className="h-3 w-3 text-slate-400" />
            }
          </div>
          <div className="flex items-center gap-2 text-[10px]">
            <span className={`font-medium ${getStatusColor()}`}>
              {getStatusText()}
            </span>
            {lastUpdateTime && !hasError &&
            <span className="text-slate-500">
                {lastUpdateTime.toLocaleTimeString()}
              </span>
            }
          </div>
        </div>
      </div>
      
      <Button
        variant="ghost"
        size="icon"
        onClick={handleForceRefresh}
        disabled={isToggling}
        className="h-7 w-7"
        title="Force refresh location">

        <RefreshCw className={`h-3 w-3 ${isToggling ? 'animate-spin' : ''}`} />
      </Button>
      
      {permissionStatus &&
      <span className="text-[10px] text-slate-600 ml-2">
          {permissionStatus}
        </span>
      }
    </div>);

}