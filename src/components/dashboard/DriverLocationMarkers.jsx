import React, { useEffect, useState, useRef } from 'react';
import L from 'leaflet';
import { Circle, Marker, Popup } from 'react-leaflet';
import { formatDistanceToNow, format } from 'date-fns';
import { userHasRole } from '../utils/userRoles';
import { isMobileDevice } from '../utils/deviceUtils';
import { getCurrentDevice } from '../utils/deviceManager';

// Create driver icon with thin white border ring
const createDriverIcon = (driverStatus = 'on_duty', initial = '', isStaleLocation = false) => {
  const size = 15;
  
  // Determine fill color based on status and staleness
  let fillColor;
  if (isStaleLocation) {
    fillColor = '#EA580C'; // Orange for stale location
  } else if (driverStatus === 'on_break') {
    fillColor = '#3b82f6'; // Blue for on break
  } else {
    fillColor = '#10B981'; // Green for on duty
  }
  
  // Thin white border ring
  const borderColor = '#FFFFFF';
  const borderWidth = 2;
  
  return L.divIcon({
    html: `
      <div class="driver-marker" style="
        position: relative;
        width: ${size}px;
        height: ${size}px;
      ">
        <div style="
          background-color: ${fillColor};
          border: ${borderWidth}px solid ${borderColor};
          border-radius: 50%;
          width: ${size}px;
          height: ${size}px;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 3px 10px rgba(0,0,0,0.4);
          animation: driverPulse 2s infinite;
          cursor: pointer;
          transition: transform 0.2s ease, box-shadow 0.2s ease;
        ">
          <span style="
            font-size: 8px;
            font-weight: bold;
            color: white;
            text-transform: uppercase;
          ">${initial || 'D'}</span>
        </div>
      </div>
      <style>
        @keyframes driverPulse {
          0%, 100% { transform: scale(1); box-shadow: 0 3px 10px rgba(0,0,0,0.4); }
          50% { transform: scale(1.15); box-shadow: 0 3px 15px rgba(0,0,0,0.5); }
        }
        .driver-marker:hover {
          z-index: 9999 !important;
        }
        .driver-marker:hover > div {
          transform: scale(1.2);
          box-shadow: 0 5px 20px rgba(0,0,0,0.6) !important;
        }
        .leaflet-marker-icon:has(.driver-marker:hover) {
          z-index: 9999 !important;
        }
      </style>
    `,
    className: 'custom-driver-icon',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
};

const DriverLocationMarkers = ({ users, currentUser, activeDriver, deliveries = [], selectedDate = null }) => {
  console.log('🚀 [DriverLocationMarkers] COMPONENT RENDERING', {
    usersCount: users?.length || 0,
    users: users?.map(u => ({
      name: u?.user_name,
      status: u?.driver_status,
      timestamp: u?.location_updated_at
    }))
  });
  
  const isMobile = isMobileDevice();
  const [visibleDrivers, setVisibleDrivers] = useState([]);
  const markersRef = useRef({});
  const prevVisibleIdsRef = useRef(new Set());
  const [isPrimaryDevice, setIsPrimaryDevice] = useState(false);

  // Check if current device is primary tracker
  useEffect(() => {
    if (!currentUser?.id) return;

    const checkPrimary = async () => {
      const device = await getCurrentDevice(currentUser.id);
      setIsPrimaryDevice(device?.is_primary_tracker || false);
    };

    checkPrimary();
  }, [currentUser?.id]);

  // Listen for driverLocationsUpdated events to force marker refresh
  useEffect(() => {
    const handleLocationUpdates = (event) => {
      const { appUsers: updatedAppUsers, singleUpdate, forceAll } = event.detail || {};

      console.log(`📍 [DriverLocationMarkers] driverLocationsUpdated event:`, { 
        appUsersCount: updatedAppUsers?.length || 0,
        hasSingleUpdate: !!singleUpdate,
        forceAll
      });

      // CRITICAL: Don't show markers for past dates - check immediately
      if (selectedDate) {
        const todayStr = format(new Date(), 'yyyy-MM-dd');
        if (selectedDate < todayStr) {
          console.log(`⏭️ [DriverLocationMarkers] Ignoring event for past date: ${selectedDate}`);
          return;
        }
      }

      // Handle single driver update
      if (singleUpdate) {
        const { current_latitude, current_longitude, location_updated_at, user_id, id } = singleUpdate;
        const userId = id || user_id;

        if (userId && current_latitude && current_longitude) {
          console.log(`📍 [DriverLocationMarkers] Updating single driver: ${userId}`);
          setVisibleDrivers(prev => {
            const exists = prev.find(d => d && d.id === userId);
            if (exists) {
              const updated = prev.map(d => d && d.id === userId ? {
                ...d,
                current_latitude,
                current_longitude,
                location_updated_at: location_updated_at || new Date().toISOString()
              } : d);
              console.log(`📍 [DriverLocationMarkers] Updated single driver in visibleDrivers`);
              return updated;
            }
            console.log(`⚠️ [DriverLocationMarkers] Driver ${userId} not in visibleDrivers, skipping`);
            return prev;
          });
        }
        return;
      }

      // CRITICAL: Handle bulk appUsers update with FRESH DATA from event
      if (updatedAppUsers && updatedAppUsers.length > 0) {
        console.log(`📍 [DriverLocationMarkers] Bulk update: processing ${updatedAppUsers.length} drivers with FRESH data`);

        const validDrivers = updatedAppUsers.filter(user => {
          if (!user) return false;
          if (!user.current_latitude || !user.current_longitude) return false;

          // CRITICAL: Only show on_duty drivers - don't show on_break or off_duty
          if (user.driver_status !== 'on_duty') {
            return false;
          }

          const currentUserId = currentUser?.id;
          const currentUserUserId = currentUser?.user_id;
          const userId = user.id || user.user_id;
          const isSelf = userId === currentUserId || userId === currentUserUserId || user.user_id === currentUserId;

          if (isSelf && isPrimaryDevice) {
            return false;
          }

          return true;
        });

        console.log(`📍 [DriverLocationMarkers] Setting ${validDrivers.length} drivers - timestamps:`, 
          validDrivers.map(u => `${u.user_name}: ${u.location_updated_at}`));
        setVisibleDrivers(validDrivers);
      }
    };

    window.addEventListener('driverLocationsUpdated', handleLocationUpdates);
    return () => window.removeEventListener('driverLocationsUpdated', handleLocationUpdates);
  }, [currentUser, isPrimaryDevice, selectedDate]);

  useEffect(() => {
    // CRITICAL: The `users` prop comes pre-filtered from driverLocationPoller
    // which already handles all permission checks, status checks, and dispatcher logic
    // We just need to do basic validation and track changes for re-rendering
    
    console.log('📍 [DriverLocationMarkers] Effect triggered', {
      isMobile,
      usersCount: users?.length || 0,
      currentUserId: currentUser?.id,
      selectedDate,
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

      // CRITICAL: Don't show markers for past dates
      if (selectedDate) {
        const todayStr = format(new Date(), 'yyyy-MM-dd');
        if (selectedDate < todayStr) {
          return false;
        }
      }

      // Skip if no valid coordinates
      if (!user.current_latitude || !user.current_longitude) {
        console.log('🚫 [DriverLocationMarkers] Missing coordinates', { 
          id: user.id, 
          name: user.user_name 
        });
        return false;
      }
      
      // CRITICAL: Don't show markers for off-duty drivers
      if (user.driver_status === 'off_duty') {
        return false;
      }
      
      // CRITICAL: Check if this is the current user viewing the map
      const currentUserId = currentUser?.id;
      const currentUserUserId = currentUser?.user_id;
      const userId = user.id || user.user_id;
      const isSelf = user._isSelf === true || 
                     userId === currentUserId || 
                     userId === currentUserUserId ||
                     user.user_id === currentUserId;
      
      // CRITICAL: Only block self marker if this device is the PRIMARY tracker
      // All non-primary devices should ALWAYS show the shared location marker
      if (isSelf && isPrimaryDevice) {
        console.log('🚫 [DriverLocationMarkers] Blocking self marker - this is the primary tracking device', {
          userId,
          userName: user.user_name || user.full_name,
          isPrimaryDevice
        });
        return false;
      }
      
      if (isSelf && !isPrimaryDevice) {
        console.log('✅ [DriverLocationMarkers] Showing self shared marker - non-primary device', {
          userId,
          userName: user.user_name || user.full_name,
          isPrimaryDevice
        });
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
    
    // Check if any driver's location OR timestamp has changed
    const locationsChanged = validDrivers.some(driver => {
      const existing = visibleDrivers.find(d => d.id === driver.id);
      if (!existing) return true;
      // Check if coordinates differ by more than a tiny amount
      const latDiff = Math.abs((driver.current_latitude || 0) - (existing.current_latitude || 0));
      const lngDiff = Math.abs((driver.current_longitude || 0) - (existing.current_longitude || 0));
      // CRITICAL: Also check if timestamp changed - forces marker popup update
      const timestampChanged = driver.location_updated_at !== existing.location_updated_at;
      return latDiff > 0.00001 || lngDiff > 0.00001 || timestampChanged;
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

  // Listen for driver status changes to update self marker immediately
  useEffect(() => {
    const handleStatusChange = (event) => {
      const { userId, newStatus } = event.detail || {};
      const currentUserId = currentUser?.id;
      
      if (userId === currentUserId) {
        console.log(`🎨 [DriverLocationMarkers] Self status changed to ${newStatus} - updating marker color`);
        setVisibleDrivers(prev => prev.map(driver => 
          (driver.id === userId || driver.user_id === userId) 
            ? { 
                ...driver, 
                driver_status: newStatus,
                location_updated_at: new Date().toISOString() // CRITICAL: Update timestamp to prevent stale detection
              }
            : driver
        ));
      }
    };

    window.addEventListener('driverStatusChanged', handleStatusChange);
    return () => window.removeEventListener('driverStatusChanged', handleStatusChange);
  }, [currentUser?.id]);

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
      
      // CRITICAL: Check if this is the current user on a non-primary device
      const isCurrentUserMarker = userId === currentUser?.id || userId === currentUser?.user_id;
      const isCurrentUserOnNonPrimaryDevice = isCurrentUserMarker && !isPrimaryDevice;
      
      // CRITICAL: Determine if we should block the self marker based on primary device status
      const shouldBlockSelfMarker = isCurrentUserMarker && isPrimaryDevice;
      
      // CRITICAL: Don't show off-duty drivers or past date markers
      const todayStr = format(new Date(), 'yyyy-MM-dd');
      const isViewingPastDate = selectedDate && selectedDate < todayStr;
      const isOffDuty = user.driver_status === 'off_duty';
      
      const shouldShowMarker = (user.location_tracking_enabled === true || isCurrentUserOnNonPrimaryDevice) && 
                               user.status !== 'inactive' && 
                               canView && 
                               !shouldBlockSelfMarker &&
                               !isOffDuty &&
                               !isViewingPastDate;
      
      if (shouldShowMarker) {
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

  const getLocationAge = (locationUpdatedAt) => {
    if (!locationUpdatedAt) return 'Unknown';
    try {
      return formatDistanceToNow(new Date(locationUpdatedAt), { addSuffix: true });
    } catch (error) {
      return 'Invalid date';
    }
  };

  console.log('═══════════════════════════════════════════════════');
  console.log('🗺️ [DriverLocationMarkers RENDER START]');
  console.log('   visibleDriversCount:', visibleDrivers?.length || 0);
  console.log('   visibleDrivers data:', visibleDrivers?.map(u => ({
    name: u.user_name || u.full_name,
    status: u.driver_status,
    timestamp: u.location_updated_at,
    lat: u.current_latitude,
    lng: u.current_longitude
  })));
  console.log('═══════════════════════════════════════════════════');

  if (!visibleDrivers || visibleDrivers.length === 0) {
    console.log('❌ [DriverLocationMarkers] No visible drivers - returning null');
    return null;
  }

  console.log(`✅ [DriverLocationMarkers] Rendering ${visibleDrivers.length} markers...`);

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
        
        console.log('═══════════════════════════════════════════════════');
        console.log(`🗺️ [Rendering Marker] ${displayName}`);
        console.log('   driver_status:', user.driver_status);
        console.log('   location_updated_at:', user.location_updated_at);
        console.log('   current_latitude:', user.current_latitude);
        console.log('   current_longitude:', user.current_longitude);
        console.log('   location_tracking_enabled:', user.location_tracking_enabled);
        console.log('═══════════════════════════════════════════════════');
        
        // CRITICAL: Check if this is the current user's shared location (non-primary device)
        const currentUserId = currentUser?.id;
        const currentUserUserId = currentUser?.user_id;
        const userId = user.id || user.user_id;
        const isSelf = userId === currentUserId || userId === currentUserUserId || user.user_id === currentUserId;
        const isSharedLocation = isSelf && !isPrimaryDevice;

        // Use user.id as stable key to prevent flickering during updates
        const stableKey = user.id;

        markersRef.current[user.id] = true;
        
        // Calculate staleness for icon
        const locationAge = user.location_updated_at ? 
          Date.now() - new Date(user.location_updated_at).getTime() : Infinity;
        const isStaleLocation = locationAge > 5 * 60 * 1000;

        return (
          <Marker
            key={stableKey}
            position={position}
            icon={createDriverIcon(user.driver_status, displayName.charAt(0).toUpperCase(), isStaleLocation)}
            zIndexOffset={isActive ? 2000 : 1000}
          >
            <Popup>
              <div className="text-sm">
                <p className="font-semibold">{displayName}</p>
                {isSharedLocation && (
                  <p className="text-xs text-slate-500 mt-1 italic">
                    📍 Shared location from primary device
                  </p>
                )}
                {user.phone && (
                  <p className="text-xs mt-2">
                    <a href={`tel:${user.phone}`} className="text-blue-600 hover:text-blue-700 underline font-medium">
                      📞 {user.phone}
                    </a>
                  </p>
                )}
                <p className="text-xs text-slate-600 mt-1">
                  Updated: {getLocationAge(user.location_updated_at)}
                </p>
                <button
                  onClick={() => {
                    // Open native navigation app
                    const url = `https://www.google.com/maps/dir/?api=1&destination=${user.current_latitude},${user.current_longitude}`;
                    window.open(url, '_blank');
                  }}
                  className="w-full mt-3 px-2 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs rounded flex items-center justify-center gap-2 transition-colors"
                  title={`Navigate to ${firstName}'s location`}
                >
                  📍 Go to {firstName}
                </button>
              </div>
            </Popup>
          </Marker>
        );
      })}
    </>
  );
};

export default DriverLocationMarkers;