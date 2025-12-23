import React, { useEffect, useState, useRef } from 'react';
import L from 'leaflet';
import { Circle, Marker, Popup } from 'react-leaflet';
import { formatDistanceToNow } from 'date-fns';
import { userHasRole } from '../utils/userRoles';
import { isMobileDevice } from '../utils/deviceUtils';

const DriverLocationMarkers = ({ users, currentUser, activeDriver }) => {
  const isMobile = isMobileDevice();
  const [visibleDrivers, setVisibleDrivers] = useState([]);
  const markersRef = useRef({});

  useEffect(() => {
    // Filter drivers to show based on sharing settings and user permissions
    const now = Date.now();
    const maxStaleTime = 5 * 60 * 1000; // 5 minutes
    
    const isAdmin = currentUser && userHasRole(currentUser, 'admin');
    const currentUserCityId = currentUser?.city_id;
    
    const validDrivers = (users || []).filter(user => {
      if (!user) return false;
      
      // CRITICAL: On mobile, don't show the current user's shared location marker
      // They already have the live blue location marker from the browser's geolocation
      if (isMobile && currentUser && user.id === currentUser.id) {
        return false;
      }
      
      // Skip inactive users
      if (user.status === 'inactive') {
        return false;
      }
      
      // CRITICAL: Only show if location_tracking_enabled is true (sharing is ON)
      if (user.location_tracking_enabled !== true) {
        return false;
      }
      
      // Skip if no valid coordinates
      if (!user.current_latitude || !user.current_longitude) {
        return false;
      }
      
      // Check if location data is too old (stale)
      if (user.location_updated_at) {
        const locationAge = now - new Date(user.location_updated_at).getTime();
        if (locationAge > maxStaleTime) {
          return false;
        }
      }
      
      // PERMISSION FILTERING:
      // 1. Admins can see ALL shared locations
      if (isAdmin) {
        return true;
      }
      
      // 2. Non-admins can only see locations from users in the same city
      if (currentUserCityId && user.city_id === currentUserCityId) {
        return true;
      }
      
      // No permission to see this location
      return false;
    });
    
    setVisibleDrivers(validDrivers);
    
    // Clean up markers for drivers that are no longer visible
    Object.keys(markersRef.current).forEach(userId => {
      if (!validDrivers.find(d => d.id === userId)) {
        delete markersRef.current[userId];
      }
    });
    
  }, [users, currentUser]);

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
      
      // CRITICAL: On mobile, don't show the current user's shared location marker
      const isCurrentUserOnMobile = isMobile && currentUser && userId === currentUser.id;
      
      if (user.location_tracking_enabled === true && user.status !== 'inactive' && canView && !isCurrentUserOnMobile) {
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
  }, [users, currentUser]);

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
        
        markersRef.current[user.id] = true;
        
        return (
          <Marker
            key={user.id}
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