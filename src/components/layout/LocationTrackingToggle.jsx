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
  const isTogglingRef = useRef(false); // Track toggle operation state in ref

  // CRITICAL: Check role conditions ONCE on mount with stable values
  const isDriver = useMemo(() => user ? userHasRole(user, 'driver') : false, [user]);
  const isAdmin = useMemo(() => user ? userHasRole(user, 'admin') : false, [user]);
  const isOwner = useMemo(() => {
    return user ? isAppOwner(user) : false;
  }, [user]);

  // Always sync localUser with user prop and update toggle state from real data
  useEffect(() => {
    if (user) {
      setLocalUser(user);
    }
  }, [user]);

  // Listen for AppUser entity updates from WebSocket
  useEffect(() => {
    const handleAppUserUpdate = (event) => {
      const { entity, action, id, data } = event.detail || {};
      
      if (entity !== 'AppUser' || !data) return;
      
      // CRITICAL: Check multiple ID fields to catch the update
      // - id: AppUser record ID
      // - data.id: AppUser record ID
      // - data.user_id: Reference to User entity
      const isCurrentUser = localUser && (
        id === localUser.appUserId || 
        id === localUser.id ||
        data?.id === localUser.appUserId || 
        data?.id === localUser.id ||
        data?.user_id === localUser.id ||
        data?.user_id === localUser.user_id
      );
      
      if (isCurrentUser && typeof data.location_tracking_enabled !== 'undefined') {
        console.log(`📡 [LocationSharing] WebSocket update - syncing toggle to: ${data.location_tracking_enabled}`);
        setLocalUser(prev => prev ? { ...prev, location_tracking_enabled: data.location_tracking_enabled } : prev);
      }
    };

    window.addEventListener('entityMutationBroadcast', handleAppUserUpdate);
    return () => window.removeEventListener('entityMutationBroadcast', handleAppUserUpdate);
  }, [localUser?.id, localUser?.appUserId, localUser?.user_id]);

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
        
        const updatedAppUser = await base44.entities.AppUser.update(appUserId, {
          location_tracking_enabled: true
        });

        // CRITICAL: Broadcast to other devices via WebSocket
        const { broadcastMutation } = await import('../utils/realtimeSync');
        broadcastMutation('AppUser', 'update', appUserId, updatedAppUser);

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
        
        const updatedAppUser = await base44.entities.AppUser.update(appUserId, {
          location_tracking_enabled: false
        });

        // CRITICAL: Broadcast to other devices via WebSocket
        const { broadcastMutation } = await import('../utils/realtimeSync');
        broadcastMutation('AppUser', 'update', appUserId, updatedAppUser);

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
  // CRITICAL: Show for drivers and admins on ALL devices (no device type restriction)
  if (!isDriver && !isAdmin && !isOwner) {
    return null;
  }

  if (!localUser) {
    return null;
  }

  // CRITICAL: Always derive state from localUser to reflect real-time updates
  const isSharingEnabled = localUser?.location_tracking_enabled || false;

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