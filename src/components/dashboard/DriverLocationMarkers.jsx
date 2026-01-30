import React, { useEffect, useState, useRef } from 'react';
import L from 'leaflet';
import { Circle, Marker, Popup } from 'react-leaflet';
import { formatDistanceToNow } from 'date-fns';
import { userHasRole } from '../utils/userRoles';
import { isMobileDevice } from '../utils/deviceUtils';

const DriverLocationMarkers = ({ users, currentUser, activeDriver, deliveries = [] }) => {
  const isMobile = isMobileDevice();
  const [visibleDrivers, setVisibleDrivers] = useState([]);
  const markersRef = useRef({});
  const prevVisibleIdsRef = useRef(new Set());

  // Listen for driverLocationsUpdated events to force marker refresh
  useEffect(() => {
    const handleLocationUpdates = (event) => {
      const { appUsers: updatedAppUsers, forceAll } = event.detail || {};
      
      if (!updatedAppUsers || updatedAppUsers.length === 0) {
        console.warn('⚠️ [DriverLocationMarkers] Empty AppUsers in event');
        return;
      }
      
      console.log(`📍 [DriverLocationMarkers] Received location update event: ${updatedAppUsers.length} AppUsers (forceAll: ${forceAll})`);
      
      // Trigger a re-render by setting users state
      // This will cause the main effect below to re-run with fresh data
      if (forceAll) {
        console.log('🔄 [DriverLocationMarkers] Force updating ALL driver markers');
      }
    };
    
    window.addEventListener('driverLocationsUpdated', handleLocationUpdates);
    return () => window.removeEventListener('driverLocationsUpdated', handleLocationUpdates);
  }, []);

  useEffect(() => {
    // CRITICAL: The `users` prop comes pre-filtered from driverLocationPoller
    // which already handles all permission checks, status checks, and dispatcher logic
    // We just need to do basic validation and track changes for re-rendering
    
    console.log('📍 [DriverLocationMarkers] Effect triggered', {
      isMobile,
      usersCount: users?.length || 0,
      currentUserId: currentUser?.id,
      users: users?.map(u => ({
        id: u?.id,
        name: u?.user_name || u?.full_name,
        lat: u?.current_latitude,
        lng: u?.current_longitude,
        _isSelf: u?._isSelf,
        tracking: u?.location_tracking_enabled,
        status: u?.driver_status
      }))
    });
    
    const validDrivers = (users || []).filter(user => {
      if (!user) return false;

      // Skip if no valid coordinates
      if (!user.current_latitude || !user.current_longitude) {
        console.log('🚫 [DriverLocationMarkers] Missing coordinates', { 
          id: user.id, 
          name: user.user_name 
        });
        return false;
      }
      
      // CRITICAL: Only block self marker on mobile if live GPS tracking is active
      // If tracking is off or driver is off-duty, show the shared marker
      const currentUserId = currentUser?.id;
      const currentUserUserId = currentUser?.user_id;
      const userId = user.id || user.user_id;
      const isSelf = user._isSelf === true || 
                     userId === currentUserId || 
                     userId === currentUserUserId ||
                     user.user_id === currentUserId;
      
      if (isMobile && isSelf) {
        // Check if live GPS tracking is active (blue dot showing)
        const isLiveTrackingActive = currentUser?.driver_status === 'on_duty' && 
                                     currentUser?.location_tracking_enabled === true;
        
        if (isLiveTrackingActive) {
          console.log('🚫 [DriverLocationMarkers] Blocking self shared marker - live GPS active', {
            userId,
            currentUserId,
            userName: user.user_name || user.full_name,
            driver_status: currentUser?.driver_status,
            location_tracking_enabled: currentUser?.location_tracking_enabled
          });
          return false;
        } else {
          console.log('✅ [DriverLocationMarkers] Showing self shared marker - live GPS inactive', {
            userId,
            driver_status: currentUser?.driver_status,
            location_tracking_enabled: currentUser?.location_tracking_enabled
          });
        }
      }
      
      console.log('✅ [DriverLocationMarkers] Including driver', {
        id: user.id,
        name: user.user_name || user.full_name,
        isSelf,
        isMobile
      });
      return true;
    });
    
    console.log(`📍 [DriverLocationMarkers] Processing ${validDrivers.length} drivers from poller (from ${users?.length || 0} total)`);
    
    // CRITICAL: Check if the set of visible driver IDs has actually changed
    // This prevents flickering caused by array reference changes during smart refresh
    const newVisibleIds = new Set(validDrivers.map(d => d.id));
    const prevIds = prevVisibleIdsRef.current;
    
    const idsChanged = newVisibleIds.size !== prevIds.size || 
      [...newVisibleIds].some(id => !prevIds.has(id)) ||
      [...prevIds].some(id => !newVisibleIds.has(id));
    
    // Check if any driver's location has significantly changed
    const locationsChanged = validDrivers.some(driver => {
      const existing = visibleDrivers.find(d => d.id === driver.id);
      if (!existing) return true;
      // Only consider it changed if coordinates differ by more than a tiny amount
      const latDiff = Math.abs((driver.current_latitude || 0) - (existing.current_latitude || 0));
      const lngDiff = Math.abs((driver.current_longitude || 0) - (existing.current_longitude || 0));
      return latDiff > 0.00001 || lngDiff > 0.00001;
    });
    
    // Only update state if there's an actual meaningful change
    if (idsChanged || locationsChanged) {
      console.log(`📍 [DriverLocationMarkers] Updating visible drivers: ${validDrivers.map(d => d.user_name).join(', ')}`);
      setVisibleDrivers(validDrivers);
      prevVisibleIdsRef.current = newVisibleIds;
    }
    
    // Clean up markers for drivers that are no longer visible
    Object.keys(markersRef.current).forEach(userId => {
      if (!validDrivers.find(d => d.id === userId)) {
        delete markersRef.current[userId];
      }
    });
    
  }, [users, currentUser, isMobile, deliveries]);

  // Listen for location cleared events
  useEffect(() => {
    const handleLocationCleared = (event) => {
      const userId = event.detail?.userId;
      if (userId && markersRef.current[userId]) {
        setVisibleDrivers(prev => prev.filter(d => d.id !== userId));
        delete markersRef.current[userId];
      }
    };

    window.addEventListener('driverLocationCleared', handleLocationCleared);
    return () => window.removeEventListener('driverLocationCleared', handleLocationCleared);
  }, []);

  // Listen for driver location updates to refresh markers
  useEffect(() => {
    const handleLocationUpdate = (event) => {
      const { userId, latitude, longitude, timestamp } = event.detail || {};
      
      console.log('📍 [DriverLocationMarkers] Received location update:', { userId, latitude, longitude, timestamp });
      
      if (!userId || !latitude || !longitude) {
        console.warn('⚠️ [DriverLocationMarkers] Invalid location update data');
        return;
      }
      
      const user = users?.find(u => u && u.id === userId);
      if (!user) {
        console.warn('⚠️ [DriverLocationMarkers] User not found in users list:', userId);
        return;
      }
      
      // Check permissions before adding/updating
      const isAdmin = currentUser && userHasRole(currentUser, 'admin');
      const currentUserCityId = currentUser?.city_id;
      const canView = isAdmin || (currentUserCityId && user.city_id === currentUserCityId);
      
      console.log('🔐 [DriverLocationMarkers] Permission check:', { 
        isAdmin, 
        canView, 
        location_tracking_enabled: user.location_tracking_enabled,
        status: user.status 
      });
      
      // CRITICAL: Only block current user's shared marker if live GPS tracking is active
      const isCurrentUserOnMobile = isMobile && currentUser && userId === currentUser.id;
      const isLiveTrackingActive = currentUser?.driver_status === 'on_duty' && 
                                   currentUser?.location_tracking_enabled === true;
      const shouldBlockSelfMarker = isCurrentUserOnMobile && isLiveTrackingActive;
      
      if (user.location_tracking_enabled === true && user.status !== 'inactive' && canView && !shouldBlockSelfMarker) {
        console.log('✅ [DriverLocationMarkers] Adding/updating visible driver:', user.user_name || user.full_name);
        setVisibleDrivers(prev => {
          const exists = prev.find(d => d && d.id === userId);
          if (exists) {
            return prev.map(d => d && d.id === userId ? { 
              ...d, 
              current_latitude: latitude, 
              current_longitude: longitude, 
              location_updated_at: new Date(timestamp).toISOString() 
            } : d);
          } else {
            return [...prev, { 
              ...user, 
              current_latitude: latitude, 
              current_longitude: longitude, 
              location_updated_at: new Date(timestamp).toISOString() 
            }];
          }
        });
      } else {
        console.log('❌ [DriverLocationMarkers] Not showing driver - permissions/status check failed');
      }
    };

    window.addEventListener('driverLocationUpdated', handleLocationUpdate);
    return () => window.removeEventListener('driverLocationUpdated', handleLocationUpdate);
  }, [users, currentUser, isMobile]);

  const createDriverIcon = (user, isActive) => {
    const displayName = user.user_name || user.full_name || 'U';
    const firstInitial = displayName.charAt(0).toUpperCase();
    const size = isActive ? 18 : 14;
    const color = isActive ? '#10b981' : '#3b82f6';
    const pulseClass = isActive ? 'driver-marker-pulse' : '';
    
    return L.divIcon({
      className: 'driver-location-marker',
      html: `
        <div class="${pulseClass}" style="position: relative; display: flex; align-items: center; justify-content: center;">
          <div style="
            width: ${size * 2}px; 
            height: ${size * 2}px; 
            background: ${color}; 
            border: 3px solid white; 
            border-radius: 50%; 
            display: flex; 
            align-items: center; 
            justify-content: center;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
            font-weight: bold;
            color: white;
            font-size: ${size}px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          ">${firstInitial}</div>
          ${isActive ? `<div style="position: absolute; top: -4px; left: -4px; width: ${size * 2 + 8}px; height: ${size * 2 + 8}px; border-radius: 50%; border: 2px solid ${color}; animation: pulse 2s infinite;"></div>` : ''}
        </div>
      `,
      iconSize: [size * 2 + 8, size * 2 + 8],
      iconAnchor: [size + 4, size + 4],
    });
  };

  const getLocationAge = (locationUpdatedAt) => {
    if (!locationUpdatedAt) return 'Unknown';
    try {
      return formatDistanceToNow(new Date(locationUpdatedAt), { addSuffix: true });
    } catch (error) {
      return 'Invalid date';
    }
  };

  if (!visibleDrivers || visibleDrivers.length === 0) {
    return null;
  }

  return (
    <>
      <style>
        {`
          @keyframes pulse {
            0% {
              opacity: 1;
              transform: scale(1);
            }
            50% {
              opacity: 0.5;
              transform: scale(1.2);
            }
            100% {
              opacity: 1;
              transform: scale(1);
            }
          }
          .driver-location-marker {
            background: transparent;
            border: none;
          }
        `}
      </style>
      
      {visibleDrivers.map((user) => {
        const isActive = activeDriver?.id === user.id;
        const position = [user.current_latitude, user.current_longitude];
        const displayName = user.user_name || user.full_name || 'Unknown Driver';
        const firstName = displayName.split(' ')[0];
        
        // CRITICAL: Use stable key that includes lat/lng to force React to unmount stale markers
        // This prevents ghost markers and shadows from old positions
        const stableKey = `${user.id}_${user.current_latitude}_${user.current_longitude}`;
        
        markersRef.current[user.id] = true;
        
        return (
          <Marker
            key={stableKey}
            position={position}
            icon={createDriverIcon(user, isActive)}
            zIndexOffset={isActive ? 2000 : 1000}
          >
            <Popup>
              <div className="text-sm">
                <p className="font-semibold">{firstName}</p>
                <p className="text-xs text-slate-600">
                  Updated: {getLocationAge(user.location_updated_at)}
                </p>
                <p className="text-xs text-emerald-600 font-medium mt-1">
                  📍 Location Shared
                </p>
              </div>
            </Popup>
          </Marker>
        );
      })}
    </>
  );
};

export default DriverLocationMarkers;