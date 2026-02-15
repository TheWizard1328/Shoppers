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

  // REMOVED: Auto-start tracking (Dashboard handles GPS tracking for mobile devices)

  // REMOVED: Status update interval (simplified to just on/off toggle)

  // REMOVED: GPS capabilities check (not needed for simple visibility toggle)

  // REMOVED: Status change notification (not needed)

  // REMOVED: refreshUserState (not needed)

  const handleToggle = async (checked) => {
    if (isToggling || isTogglingRef.current) {
      console.log('⏸️ [LocationSharing] Toggle already in progress');
      return;
    }

    console.log('🎯 [LocationSharing] Sharing toggle clicked:', checked);

    setIsToggling(true);
    isTogglingRef.current = true;
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
        // TURNING ON: Make location visible to other drivers
        setPermissionStatus('Enabling location sharing...');
        setIsLocationSharingEnabled(true);
        sessionStorage.setItem('locationSharingEnabled', 'true');
        
        await base44.entities.AppUser.update(appUserId, {
          location_tracking_enabled: true
        });

        // Signal for immediate GPS upload
        if (locationTracker.signalLocationSharingToggle) {
          locationTracker.signalLocationSharingToggle(true);
        }

        const updatedUser = {
          ...localUser,
          location_tracking_enabled: true
        };
        setLocalUser(updatedUser);

        setPermissionStatus('Location sharing enabled!');
        console.log('✅ [LocationSharing] Others can now see my location');
        
        setTimeout(() => setPermissionStatus(''), 3000);
      } else {
        // TURNING OFF: Hide location from other drivers
        setPermissionStatus('Disabling location sharing...');
        setIsLocationSharingEnabled(false);
        sessionStorage.setItem('locationSharingEnabled', 'false');
        
        await base44.entities.AppUser.update(appUserId, {
          location_tracking_enabled: false
        });

        // Signal toggle event
        if (locationTracker.signalLocationSharingToggle) {
          locationTracker.signalLocationSharingToggle(false);
        }

        const updatedUser = {
          ...localUser,
          location_tracking_enabled: false
        };
        setLocalUser(updatedUser);

        setPermissionStatus('Location sharing disabled');
        console.log('✅ [LocationSharing] Location hidden from others (GPS still active)');
        
        setTimeout(() => setPermissionStatus(''), 3000);
      }

    } catch (error) {
      console.error('❌ [LocationSharing] Failed to toggle:', error);
      setPermissionStatus(`Error: ${error.message}`);

      setIsLocationSharingEnabled(!checked);
      sessionStorage.setItem('locationSharingEnabled', String(!checked));
      
      setTimeout(() => setPermissionStatus(''), 4000);
    } finally {
      setIsToggling(false);
      setTimeout(() => {
        isTogglingRef.current = false;
      }, 2000);
    }
  };

  // REMOVED: Force refresh (not needed for simple visibility toggle)

  // REMOVED: Status display functions (simplified to just on/off)

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
    <div className="flex items-center gap-2">
      <div className="flex flex-col">
        <Label htmlFor="location-toggle" className="text-xs font-medium text-slate-700 leading-tight">
          Share Location
        </Label>
        <Label htmlFor="location-toggle" className="text-[10px] text-slate-500 leading-tight">
          With Other Drivers
        </Label>
      </div>
      <Switch
        id="location-toggle"
        checked={isSharingEnabled}
        onCheckedChange={handleToggle}
        disabled={isToggling}
        className="data-[state=checked]:bg-emerald-500" />
    </div>
  );
}