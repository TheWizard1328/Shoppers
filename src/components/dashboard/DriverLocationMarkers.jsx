import React, { useEffect, useState, useRef } from 'react';
import L from 'leaflet';
import { Circle, Marker, Popup } from 'react-leaflet';
import { formatDistanceToNow, format } from 'date-fns';
import { userHasRole } from '../utils/userRoles';
import { isMobileDevice } from '../utils/deviceUtils';
import { getCurrentDevice } from '../utils/deviceManager';
import { formatPhoneNumber } from '../utils/phoneFormatter';

// Create driver icon with thin white border ring
const createDriverIcon = (driverStatus = 'on_duty', initial = '', staleness = 'fresh') => {
  const size = 15;
  
  // Determine fill color based on status and staleness
  let fillColor;
  if (staleness === 'very_stale') {
    fillColor = '#DC2626'; // Red for very stale (30+ min)
  } else if (staleness === 'stale') {
    fillColor = '#F59E0B'; // Amber for stale (15-30 min)
  } else if (staleness === 'aging') {
    fillColor = '#FB923C'; // Orange for aging (5-15 min)
  } else if (driverStatus === 'on_break') {
    fillColor = '#3b82f6'; // Blue for on break
  } else {
    fillColor = '#10B981'; // Green for fresh on duty
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
  const isMobile = isMobileDevice();
  const [visibleDrivers, setVisibleDrivers] = useState([]);
  const markersRef = useRef({});
  const prevVisibleIdsRef = useRef(new Set());
  const [isPrimaryDevice, setIsPrimaryDevice] = useState(false);

  const isAdmin = currentUser && userHasRole(currentUser, 'admin');
  const isDispatcher = currentUser && userHasRole(currentUser, 'dispatcher');
  const isDriver = currentUser && userHasRole(currentUser, 'driver');

  // CONSOLIDATED VISIBILITY LOGIC - Single source of truth for marker filtering
  const shouldShowMarker = (user) => {
    if (!user || !user.current_latitude || !user.current_longitude) return false;

    const currentUserId = currentUser?.id;
    const currentUserUserId = currentUser?.user_id;
    const userId = user.id || user.user_id;
    const isSelf = user._isSelf === true || 
                   userId === currentUserId || 
                   userId === currentUserUserId ||
                   user.user_id === currentUserId;

    // RULE 0: NEVER show self marker on primary device
    if (isSelf && isPrimaryDevice) {
      return false;
    }

    // RULE 1: Admin/AppOwner sees ALL online drivers (no location_tracking_enabled check)
    if (isAdmin) {
      return user.driver_status !== 'off_duty' && user.status !== 'inactive';
    }

    // RULE 2: Self marker on non-primary device - show while online
    if (isSelf) {
      return user.driver_status !== 'off_duty' && user.status !== 'inactive';
    }

    // RULE 3: Dispatcher sees assigned drivers when on_duty with location sharing enabled
    if (isDispatcher) {
      if (user.driver_status !== 'on_duty' || !user.location_tracking_enabled) return false;
      
      const dispatcherStoreIds = currentUser?.store_ids || [];
      if (dispatcherStoreIds.length === 0) return false;
      
      const selectedDateStr = selectedDate instanceof Date 
        ? selectedDate.toISOString().split('T')[0]
        : selectedDate;
      const hasDispatcherStoreDeliveries = deliveries?.some(d => 
        d && 
        d.driver_id === userId && 
        d.delivery_date === selectedDateStr &&
        dispatcherStoreIds.includes(d.store_id)
      );
      
      return hasDispatcherStoreDeliveries && user.status !== 'inactive';
    }

    // RULE 4: Driver sees other drivers ONLY if location_tracking_enabled === true
    if (isDriver) {
      if (!user.location_tracking_enabled) return false;
      
      const currentUserCityId = currentUser?.city_id;
      const currentUserCityIds = currentUser?.city_ids || (currentUserCityId ? [currentUserCityId] : []);
      const userCityIds = user.city_ids || (user.city_id ? [user.city_id] : []);
      const isSameCity = userCityIds.some(cityId => currentUserCityIds.includes(cityId));
      
      return isSameCity && user.status !== 'inactive';
    }

    return false;
  };

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
      const { appUsers: updatedAppUsers, singleUpdate, forceAll, fromRealtime } = event.detail || {};
      
      console.log(`📡 [DriverMarkers] Location update event - ${updatedAppUsers?.length || 0} drivers, fromRealtime: ${fromRealtime}`);

      // CRITICAL: Don't show markers for past dates - check immediately
      if (selectedDate) {
        const todayStr = format(new Date(), 'yyyy-MM-dd');
        const selectedDateStr = selectedDate instanceof Date 
          ? selectedDate.toISOString().split('T')[0]
          : selectedDate;
        if (selectedDateStr < todayStr) {
          console.log('⏭️ [DriverMarkers] Past date - skipping marker update');
          return;
        }
      }

      // Handle single driver update
      if (singleUpdate && updatedAppUsers && updatedAppUsers.length === 1) {
        const user = updatedAppUsers[0];
        console.log(`🔔 [DriverMarkers] Single update - ${user.user_name}, coords: ${user.current_latitude}, ${user.current_longitude}, time: ${user.location_updated_at}`);
        
        if (user.current_latitude && user.current_longitude) {
          setVisibleDrivers(prev => {
            const exists = prev.find(d => d && (d.id === user.id || d.user_id === user.user_id));
            if (exists) {
              console.log(`✏️ [DriverMarkers] Updating existing marker for ${user.user_name}`);
              return prev.map(d => (d.id === user.id || d.user_id === user.user_id) ? {
                ...d,
                ...user,
                current_latitude: user.current_latitude,
                current_longitude: user.current_longitude,
                location_updated_at: user.location_updated_at || new Date().toISOString()
              } : d);
            } else {
              console.log(`➕ [DriverMarkers] Adding new marker for ${user.user_name}`);
              return [...prev, user];
            }
          });
        }
        return;
      }

      // CRITICAL: Handle bulk appUsers update with FRESH DATA from event
      if (updatedAppUsers && updatedAppUsers.length > 0) {
        console.log(`📦 [DriverMarkers] Bulk update - processing ${updatedAppUsers.length} drivers`);

        const validDrivers = updatedAppUsers.filter(shouldShowMarker);

        console.log(`📍 [DriverMarkers] Setting ${validDrivers.length} visible drivers`);
        setVisibleDrivers(validDrivers);
      }
    };

    window.addEventListener('driverLocationsUpdated', handleLocationUpdates);
    return () => window.removeEventListener('driverLocationsUpdated', handleLocationUpdates);
  }, [currentUser, isPrimaryDevice, selectedDate, isAdmin, isDispatcher, isDriver, deliveries]);

  useEffect(() => {
    // CRITICAL: The `users` prop comes pre-filtered from driverLocationPoller
    // which already handles all permission checks, status checks, and dispatcher logic
    // We just need to do basic validation and track changes for re-rendering
    
    console.log(`🔍 [DriverMarkers - users prop] Processing ${users?.length || 0} drivers from prop`);
    
    const validDrivers = (users || []).filter(user => {
      if (!user) return false;

      // Skip if no valid coordinates
      if (!user.current_latitude || !user.current_longitude) {
        console.log(`❌ [DriverMarkers - users prop] ${user.user_name || user.id} - no coordinates`);
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

      // CRITICAL: NEVER show self marker on primary device (live location is separate)
      if (isSelf && isPrimaryDevice) {
        console.log(`🚫 [DriverMarkers - users prop] Self marker on primary - blocked`);
        return false;
      }

      // CRITICAL: Don't show OTHER markers for past dates
      if (selectedDate) {
        const todayStr = format(new Date(), 'yyyy-MM-dd');
        const selectedDateStr = selectedDate instanceof Date 
          ? selectedDate.toISOString().split('T')[0]
          : selectedDate;
        if (selectedDateStr < todayStr) {
          return false;
        }
      }

      // VISIBILITY RULES:
      const isOnline = user.driver_status !== 'off_duty';

      if (isAdmin) {
        // Admin sees all online drivers
        return isOnline;
      }

      if (isSelf) {
        // Self on non-primary device - show as long as online
        return isOnline;
      }

      if (isDispatcher) {
        // Dispatcher sees assigned drivers when on_duty only
        if (user.driver_status !== 'on_duty') {
          console.log(`⏭️ [DriverMarkers - users prop] ${user.user_name} not on_duty - dispatcher can't see`);
          return false;
        }
        
        // Check if driver is assigned to any dispatcher stores (via deliveries)
        const dispatcherStoreIds = currentUser?.store_ids || [];
        if (dispatcherStoreIds.length === 0) return false;
        
        const selectedDateStr = selectedDate instanceof Date 
          ? selectedDate.toISOString().split('T')[0]
          : selectedDate;
        const hasDispatcherStoreDeliveries = deliveries?.some(d => 
          d && 
          d.driver_id === userId && 
          d.delivery_date === selectedDateStr &&
          dispatcherStoreIds.includes(d.store_id)
        );
        
        return hasDispatcherStoreDeliveries;
      }

      if (isDriver) {
        // Driver sees other drivers in same city only if location sharing enabled
        if (!user.location_tracking_enabled) {
          console.log(`⏭️ [DriverMarkers - users prop] ${user.user_name} has sharing disabled - driver can't see`);
          return false;
        }
        
        const currentUserCityId = currentUser?.city_id;
        const currentUserCityIds = currentUser?.city_ids || (currentUserCityId ? [currentUserCityId] : []);
        const userCityIds = user.city_ids || (user.city_id ? [user.city_id] : []);
        
        const isSameCity = userCityIds.some(cityId => currentUserCityIds.includes(cityId));
        
        if (!isSameCity) {
          console.log(`⏭️ [DriverMarkers - users prop] ${user.user_name} in different city - driver can't see`);
          return false;
        }
        
        return true;
      }
      
      console.log(`✅ [DriverMarkers - users prop] Including ${user.user_name} - coords: ${user.current_latitude.toFixed(6)}, ${user.current_longitude.toFixed(6)}`);
      return true;
    });
    
    console.log(`📍 [DriverMarkers - users prop] Validated ${validDrivers.length}/${users?.length || 0} drivers`);
    
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
      // Check if coordinates changed at all
      const latDiff = Math.abs((driver.current_latitude || 0) - (existing.current_latitude || 0));
      const lngDiff = Math.abs((driver.current_longitude || 0) - (existing.current_longitude || 0));
      // CRITICAL: Also check if timestamp changed - forces marker popup update
      const timestampChanged = driver.location_updated_at !== existing.location_updated_at;
      
      if (latDiff > 0 || lngDiff > 0 || timestampChanged) {
        console.log(`🔄 [DriverMarkers - users prop] ${driver.user_name} location changed - lat: ${latDiff.toFixed(6)}, lng: ${lngDiff.toFixed(6)}, time changed: ${timestampChanged}`);
      }
      
      return latDiff > 0 || lngDiff > 0 || timestampChanged;
    });
    
    // Only update state if there's an actual meaningful change
    if (idsChanged || locationsChanged) {
      console.log(`🔄 [DriverMarkers - users prop] Updating markers - idsChanged: ${idsChanged}, locationsChanged: ${locationsChanged}`);
      setVisibleDrivers(validDrivers);
      prevVisibleIdsRef.current = newVisibleIds;
    }
    
    // Clean up markers for drivers that are no longer visible
    Object.keys(markersRef.current).forEach(userId => {
      if (!validDrivers.find(d => d.id === userId)) {
        delete markersRef.current[userId];
      }
    });
    
  }, [users, currentUser, isMobile, deliveries, isPrimaryDevice, selectedDate, isAdmin, isDispatcher, isDriver]);

  // Listen for driver status changes to update self marker immediately
  useEffect(() => {
    const handleStatusChange = (event) => {
      const { userId, newStatus } = event.detail || {};
      const currentUserId = currentUser?.id;
      
      if (userId === currentUserId) {
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
      
      if (!userId || !latitude || !longitude) {
        return;
      }
      
      const user = users?.find(u => u && u.id === userId);
      if (!user) {
        return;
      }
      
      // CRITICAL: Check if this is the current user on a non-primary device
      const isCurrentUserMarker = userId === currentUser?.id || userId === currentUser?.user_id;
      const isCurrentUserOnNonPrimaryDevice = isCurrentUserMarker && !isPrimaryDevice;
      
      // CRITICAL: Determine if we should block the self marker based on primary device status
      const shouldBlockSelfMarker = isCurrentUserMarker && isPrimaryDevice;
      
      // CRITICAL: Don't show past date markers
      const todayStr = format(new Date(), 'yyyy-MM-dd');
      const isViewingPastDate = selectedDate && selectedDate < todayStr;
      
      // Apply visibility rules
      const isOnline = user.driver_status !== 'off_duty';
      let shouldShowMarker = false;

      if (isAdmin) {
        // Admin sees all online drivers
        shouldShowMarker = isOnline && user.status !== 'inactive' && !shouldBlockSelfMarker && !isViewingPastDate;
      } else if (isCurrentUserOnNonPrimaryDevice) {
        // Self on non-primary - show as long as online
        shouldShowMarker = isOnline && user.status !== 'inactive' && !isViewingPastDate;
      } else if (isDispatcher) {
        // Dispatcher sees assigned drivers when on_duty
        if (user.driver_status !== 'on_duty') {
          shouldShowMarker = false;
        } else {
          const dispatcherStoreIds = currentUser?.store_ids || [];
          const selectedDateStr = selectedDate instanceof Date 
            ? selectedDate.toISOString().split('T')[0]
            : selectedDate;
          const hasDispatcherStoreDeliveries = deliveries?.some(d => 
            d && 
            d.driver_id === userId && 
            d.delivery_date === selectedDateStr &&
            dispatcherStoreIds.includes(d.store_id)
          );
          shouldShowMarker = hasDispatcherStoreDeliveries && user.status !== 'inactive' && !isViewingPastDate;
        }
      } else if (isDriver) {
        // Driver sees others in same city only if location_tracking_enabled
        const currentUserCityId = currentUser?.city_id;
        const currentUserCityIds = currentUser?.city_ids || (currentUserCityId ? [currentUserCityId] : []);
        const userCityIds = user.city_ids || (user.city_id ? [user.city_id] : []);
        const isSameCity = userCityIds.some(cityId => currentUserCityIds.includes(cityId));
        
        shouldShowMarker = isSameCity && 
                          user.location_tracking_enabled === true && 
                          user.status !== 'inactive' && 
                          !shouldBlockSelfMarker &&
                          !isViewingPastDate;
      }
      
      if (shouldShowMarker) {
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
      }
    };

    window.addEventListener('driverLocationUpdated', handleLocationUpdate);
    return () => window.removeEventListener('driverLocationUpdated', handleLocationUpdate);
  }, [users, currentUser, isMobile, isAdmin, isDispatcher, isDriver, deliveries, selectedDate, isPrimaryDevice]);

  const getLocationAge = (locationUpdatedAt) => {
    if (!locationUpdatedAt) return 'Unknown';
    try {
      return format(new Date(locationUpdatedAt), 'h:mm a');
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
        
        // CRITICAL: Check if this is the current user's shared location (non-primary device)
        const currentUserId = currentUser?.id;
        const currentUserUserId = currentUser?.user_id;
        const userId = user.id || user.user_id;
        const isSelf = userId === currentUserId || userId === currentUserUserId || user.user_id === currentUserId;
        const isSharedLocation = isSelf && !isPrimaryDevice;

        // Use user.id as stable key to prevent flickering during updates
        const stableKey = user.id;

        markersRef.current[user.id] = true;
        
        // Get staleness info from poller
        const staleness = user._staleness || 'fresh';
        const ageMinutes = user._ageMinutes || 0;

        return (
          <Marker
            key={stableKey}
            position={position}
            icon={createDriverIcon(user.driver_status, displayName.charAt(0).toUpperCase(), staleness)}
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
                {staleness !== 'fresh' && staleness !== 'unknown' && (
                  <p className="text-xs text-orange-600 mt-1 font-medium">
                    ⚠️ Location {ageMinutes}min old
                  </p>
                )}
                {staleness === 'unknown' && !user.location_updated_at && (
                  <p className="text-xs text-slate-500 mt-1 italic">
                    📍 Last known location (no timestamp)
                  </p>
                )}
                {!isActive && !isSharedLocation && (
                  <>
                    <div className="flex gap-2 mt-3">
                      <button
                        onClick={() => {
                          const url = `https://www.google.com/maps/dir/?api=1&destination=${user.current_latitude},${user.current_longitude}`;
                          window.open(url, '_blank');
                        }}
                        className="flex-1 px-2 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs rounded transition-colors font-medium"
                        title={`Navigate to ${firstName}'s location`}
                      >
                        📍 Goto
                      </button>
                      <button
                        onClick={() => {
                          window.location.href = `tel:${user.phone}`;
                        }}
                        className="flex-1 px-2 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded transition-colors font-medium"
                        title={`Call ${firstName}`}
                      >
                        📞 Call
                      </button>
                    </div>
                  </>
                )}
                <p className="text-xs text-slate-600 mt-2">
                  Updated: {getLocationAge(user.location_updated_at)}
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