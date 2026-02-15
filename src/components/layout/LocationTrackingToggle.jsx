import { useState, useEffect, useRef, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { MapPinOff, AlertCircle, Activity, RefreshCw, Satellite, Eye, EyeOff } from "lucide-react";
import { locationTracker } from "../utils/locationTracker";
import { base44 } from "@/api/base44Client";
import { userHasRole, isAppOwner } from "../utils/userRoles";
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
  const consecutiveErrorsRef = useRef(false);
  // CRITICAL: Track toggle state independently to prevent reversion during data refresh
  // Use a key in sessionStorage to persist user's choice across component remounts
  const [isLocationSharingEnabled, setIsLocationSharingEnabled] = useState(() => {
    try {
      const stored = sessionStorage.getItem('locationSharingEnabled');
      if (stored !== null) {
        return stored === 'true';
      }
    } catch (e) {
      // sessionStorage not available
    }
    return user?.location_tracking_enabled || false;
  });
  const isTogglingRef = useRef(false); // Track toggle operation state in ref

  // CRITICAL: Check device/role conditions ONCE on mount with stable values
  const isMobile = useMemo(() => checkIsMobileDevice(), []);
  const isDriver = useMemo(() => user ? userHasRole(user, 'driver') : false, [user]);
  const isAdmin = useMemo(() => user ? userHasRole(user, 'admin') : false, [user]);
  const isOwner = useMemo(() => {
    return user ? isAppOwner(user) : false;
  }, [user]);

  // Always sync localUser with user prop - but respect sessionStorage for toggle state
  useEffect(() => {
    if (user) {
      setLocalUser(user);
      
      // CRITICAL: Only update state if NO sessionStorage value exists (fresh session)
      // This ensures user's toggle choice persists across component remounts
      const stored = sessionStorage.getItem('locationSharingEnabled');
      if (stored === null && !isTogglingRef.current) {
        // No stored choice - use database value
        const dbValue = user.location_tracking_enabled || false;
        setIsLocationSharingEnabled(dbValue);
        sessionStorage.setItem('locationSharingEnabled', String(dbValue));
        console.log('🔄 [LocationSharing] Synced from DB (no stored choice):', dbValue);
      }
    }
  }, [user]);

  // Listen for location sharing disabled event from DriverStatusToggle
  useEffect(() => {
    const handleSharingDisabled = async () => {
      console.log('📍 [LocationSharing] Received locationSharingDisabled event - updating UI');
      setLocalUser(prev => prev ? { ...prev, location_tracking_enabled: false } : prev);
      setIsLocationSharingEnabled(false);
      sessionStorage.setItem('locationSharingEnabled', 'false');
    };

    window.addEventListener('locationSharingDisabled', handleSharingDisabled);
    return () => window.removeEventListener('locationSharingDisabled', handleSharingDisabled);
  }, []);

  // CRITICAL: Always start tracking on mobile devices for drivers/admins/owner
  useEffect(() => {
    if (!localUser?.id) return;
    if (!isMobile && !isOwner) return;
    if (!isDriver && !isAdmin && !isOwner) return;

    const autoStartTracking = async () => {
      // Always auto-start tracking if not already running
      if (!locationTracker.isTracking && !autoStartedRef.current) {
        console.log('🚀 [LocationSharing] Auto-starting location tracking (always on for primary device)');
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
  }, [localUser?.id, isMobile, isDriver, isAdmin, isOwner]);

  // Update tracking status and countdown periodically
  useEffect(() => {
    if (!isOwner && (!isMobile || (!isDriver && !isAdmin))) return;

    const updateStatus = () => {
      const status = locationTracker.getStatus();
      setTrackingStatus(status);

      // Only show error if tracking is actually failing, not during normal operation
      if (status.isTracking) {
        // Tracking is running - clear any errors
        setHasError(false);
        consecutiveErrorsRef.current = 0;
      } else if (!isLocationSharingEnabled) {
        // Sharing is disabled - clear error
        setHasError(false);
        consecutiveErrorsRef.current = 0;
      }

      // CRITICAL: Only show timing info if location sharing is ENABLED
      if (isLocationSharingEnabled && status.lastUpdate > 0) {
        setLastUpdateTime(new Date(status.lastUpdate));

        const timeSinceLastUpdate = Date.now() - status.lastUpdate;
        const timeUntilNextUpdate = Math.max(0, 15000 - timeSinceLastUpdate);
        setNextUpdateIn(Math.ceil(timeUntilNextUpdate / 1000));
      } else {
        // Sharing is OFF - clear timing info
        setLastUpdateTime(null);
        setNextUpdateIn(null);
      }
    };

    updateStatus();
    const interval = setInterval(updateStatus, 1000);

    return () => clearInterval(interval);
  }, [isMobile, isDriver, isAdmin, isOwner, isLocationSharingEnabled]);

  // Check GPS capabilities
  useEffect(() => {
    if (!isOwner && (!isMobile || (!isDriver && !isAdmin))) return;

    if (typeof locationTracker.checkGPSCapabilities === 'function') {
      locationTracker.checkGPSCapabilities().then((capabilities) => {
        setGpsCapabilities(capabilities);
      });
    }
  }, [isMobile, isDriver, isAdmin, isOwner]);

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
    if (isToggling || isTogglingRef.current) {
      console.log('⏸️ [LocationSharing] Toggle already in progress');
      return;
    }

    console.log('🎯 [LocationSharing] Sharing toggle clicked:', checked);

    setIsToggling(true);
    isTogglingRef.current = true; // Set ref immediately
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
        sessionStorage.setItem('locationSharingEnabled', 'true');
        
        // CRITICAL: Signal toggle event for immediate GPS upload
        locationTracker.signalLocationSharingToggle(true);

        // CRITICAL: Start tracking if not already running
        if (!locationTracker.isTracking) {
          try {
            await locationTracker.startTracking({
              ...localUser,
              appUserId: appUserId,
              location_tracking_enabled: true
            });
            console.log('✅ [LocationSharing] Location tracking started');
          } catch (trackError) {
            console.warn('⚠️ [LocationSharing] Could not start tracking:', trackError.message);
          }
        }
        
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
        
        setTimeout(() => setPermissionStatus(''), 3000);
      } else {
        // Disable sharing (but keep tracking coordinates)
        setPermissionStatus('Disabling location sharing...');
        // CRITICAL: Update UI state FIRST (optimistic update)
        setIsLocationSharingEnabled(false);
        sessionStorage.setItem('locationSharingEnabled', 'false');

        // CRITICAL: Signal toggle event for immediate GPS upload
        locationTracker.signalLocationSharingToggle(false);
        
        await base44.entities.AppUser.update(appUserId, {
          location_tracking_enabled: false,
          location_updated_at: null
        });

        // CRITICAL: Update localUser immediately so UI reflects new state
        const updatedUser = {
          ...localUser,
          location_tracking_enabled: false
        };
        setLocalUser(updatedUser);

        setPermissionStatus('Location sharing disabled');
        console.log('✅ [LocationSharing] Sharing disabled (tracking continues)');
        
        setTimeout(() => setPermissionStatus(''), 3000);
      }

    } catch (error) {
      console.error('❌ [LocationSharing] Failed to toggle:', error);
      setPermissionStatus(`Error: ${error.message}`);

      // CRITICAL: Revert optimistic update on error
      setIsLocationSharingEnabled(!checked);
      sessionStorage.setItem('locationSharingEnabled', String(!checked));
      
      // Refresh user state to sync with backend
      setTimeout(() => setPermissionStatus(''), 4000);
    } finally {
      setIsToggling(false);
      // CRITICAL: Clear ref after a delay to ensure backend update has propagated
      setTimeout(() => {
        isTogglingRef.current = false;
      }, 2000);
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
    // CRITICAL: If sharing is OFF, show "Off" not timing info
    if (!isLocationSharingEnabled) return 'Off';
    if (trackingStatus?.isTracking) {
      const timeSinceUpdate = Date.now() - trackingStatus.lastUpdate;
      if (timeSinceUpdate < 60000) {
        return nextUpdateIn !== null ? `Next: ${nextUpdateIn}s` : 'Active';
      }
      if (timeSinceUpdate < 300000) return 'Stale';
      return 'Old Data';
    }
    // CRITICAL: Only show "Starting..." if location sharing is actually enabled
    if (isLocationSharingEnabled) return 'Starting...';
    return 'Off';
  };

  // Conditional return AFTER all hooks
  // CRITICAL: Always show for app owner (regardless of device type or role)
  if (!isOwner && (!isMobile || (!isDriver && !isAdmin))) {
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