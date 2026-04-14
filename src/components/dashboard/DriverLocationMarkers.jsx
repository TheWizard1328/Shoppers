import React, { useEffect, useState, useRef } from 'react';

const MIN_DRIVER_MOVE_METERS = 50;
const toRadians = (value) => (value * Math.PI) / 180;
const getDistanceMeters = (lat1, lon1, lat2, lon2) => {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const earthRadiusMeters = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
import L from 'leaflet';
import { Circle, Marker, Popup } from 'react-leaflet';
import { formatDistanceToNow, format } from 'date-fns';
import { userHasRole } from '../utils/userRoles';
import { isMobileDevice } from '../utils/deviceUtils';
import { getCurrentDevice } from '../utils/deviceManager';
import { formatPhoneNumber } from '../utils/phoneFormatter';
import { generateDriverColor, getContrastColor } from '../utils/colorGenerator';

// Create driver/dispatcher icon with border ring based on delivery status
const createDriverIcon = (driverColor = '#2563EB', driverStatus = 'on_duty', initial = '', staleness = 'fresh', deliveryStatus = 'incomplete') => {
  const size = 15;

  let fillColor = '#16A34A';
  if (staleness === 'very_stale' || staleness === 'stale' || staleness === 'aging' || staleness === 'heartbeat_stale') {
    fillColor = '#F59E0B';
  } else if (driverStatus === 'on_break') {
    fillColor = '#2563EB';
  } else if (driverStatus === 'online' || driverStatus === 'on_duty') {
    fillColor = '#16A34A';
  }

  let borderColor = '#FFFFFF';
  if (deliveryStatus === 'completed') {
    borderColor = '#052E16';
  } else if (deliveryStatus === 'failed') {
    borderColor = '#7F1D1D';
  }
  const textColor = getContrastColor(fillColor);
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
            color: ${textColor};
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

const getDriverIdentityKey = (user) => String(
  user?.driver?.user_id || user?.driver?.id || user?.user_id || user?.driver_id || user?.driverId || user?.id || ''
);

const normalizeDriverRecord = (user) => {
  if (!user) return user;
  const identityKey = getDriverIdentityKey(user);
  const markerId = user?.id || user?.driver?.id || identityKey;
  return {
    ...user,
    id: markerId,
    user_id: identityKey || user?.user_id,
    driver_id: user?.driver_id || user?.driverId || markerId
  };
};

const dedupeVisibleDrivers = (drivers = []) => {
  const byIdentity = new Map();
  drivers.filter(Boolean).forEach((item) => {
    const user = normalizeDriverRecord(item);
    const key = getDriverIdentityKey(user);
    if (!key) return;
    const existing = byIdentity.get(key);
    const existingTs = new Date(existing?.location_updated_at || existing?.updated_date || 0).getTime();
    const nextTs = new Date(user?.location_updated_at || user?.updated_date || 0).getTime();
    if (!existing || nextTs >= existingTs) {
      byIdentity.set(key, user);
    }
  });
  return Array.from(byIdentity.values());
};

const mergeVisibleDriversByFreshness = (current = [], incoming = []) => {
  const merged = new Map((current || []).filter(Boolean).map((item) => {
    const user = normalizeDriverRecord(item);
    return [getDriverIdentityKey(user), user];
  }).filter(([key]) => !!key));

  (incoming || []).filter(Boolean).forEach((item) => {
    const user = normalizeDriverRecord(item);
    const key = getDriverIdentityKey(user);
    if (!key) return;
    const existing = merged.get(key);
    const existingTs = new Date(existing?.location_updated_at || existing?.updated_date || 0).getTime();
    const nextTs = new Date(user?.location_updated_at || user?.updated_date || 0).getTime();
    const moveDistance = existing
      ? getDistanceMeters(
          Number(existing?.current_latitude),
          Number(existing?.current_longitude),
          Number(user?.current_latitude),
          Number(user?.current_longitude)
        )
      : Infinity;

    if (!existing) {
      merged.set(key, user);
      return;
    }

    if (nextTs < existingTs) return;

    if (moveDistance < MIN_DRIVER_MOVE_METERS) {
      merged.set(key, {
        ...existing,
        ...user,
        current_latitude: existing?.current_latitude,
        current_longitude: existing?.current_longitude,
        location_updated_at: user?.location_updated_at || existing?.location_updated_at || user?.updated_date || existing?.updated_date
      });
      return;
    }

    merged.set(key, {
      ...existing,
      ...user,
      current_latitude: user?.current_latitude ?? existing?.current_latitude,
      current_longitude: user?.current_longitude ?? existing?.current_longitude,
      location_updated_at: user?.location_updated_at || existing?.location_updated_at || user?.updated_date || existing?.updated_date
    });
  });

  return Array.from(merged.values());
};

const DriverLocationMarkers = ({ users, currentUser, activeDriver, deliveries = [], selectedDate = null }) => {
  const isMobile = isMobileDevice();
  const [visibleDrivers, setVisibleDrivers] = useState([]);
  const lastPropUpdateRef = useRef(0);
  const markersRef = useRef({});
  const prevVisibleIdsRef = useRef(new Set());
  const [isPrimaryDevice, setIsPrimaryDevice] = useState(true);

  const isAdmin = currentUser && userHasRole(currentUser, 'admin');
  const isDispatcher = currentUser && userHasRole(currentUser, 'dispatcher');
  const isDriver = currentUser && userHasRole(currentUser, 'driver');

  // CONSOLIDATED VISIBILITY LOGIC - Single source of truth for marker filtering
  const shouldShowMarker = (user) => {
    if (!user || !user.current_latitude || !user.current_longitude) return false;

    const currentUserId = currentUser?.id;
    const currentUserUserId = currentUser?.user_id;
    const userId = user.id || user.user_id;
    const isSelf = user.isSelf === true ||
                   user._isSelf === true || 
                   userId === currentUserId || 
                   userId === currentUserUserId ||
                   user.user_id === currentUserId;

    // RULE 0: Only the primary mobile driver device hides its own shared marker
    // Secondary devices should still show the shared self marker coming from the primary device
    if (isSelf && isPrimaryDevice && isDriver && isMobile) {
      return false;
    }

      // RULE 1: Self marker on non-primary device - ALWAYS show if coordinates exist (shared from primary),
      // regardless of route state or driver status, as long as heartbeat/location updates are still present
      if (isSelf && !isPrimaryDevice) {
        const updatedAt = user.location_updated_at ? new Date(user.location_updated_at).getTime() : 0;
        const heartbeatIsActive = updatedAt > 0 && (Date.now() - updatedAt) <= 5 * 60 * 1000;
        return heartbeatIsActive;
      }

      // RULE 2: Non-driver self markers (dispatchers, admins) on primary device
      if (isSelf && isPrimaryDevice && !isDriver) {
        return true;
      }

    // RULE 2: Admin/AppOwner can see all shared driver markers except their own on their primary device,
    // as long as the shared marker still has a recent heartbeat (about 62 seconds)
    const isAppOwner = currentUser?.email && 
                      (currentUser.email.endsWith('@rxdeliver.com') || 
                       currentUser.email === 'dan@dcscripts.ca');
    const updatedAt = user.location_updated_at ? new Date(user.location_updated_at).getTime() : 0;
    const hasRecentHeartbeat = updatedAt > 0 && (Date.now() - updatedAt) <= 62 * 1000;
    const allowedDriverStatuses = ['on_duty', 'off_duty', 'on_break'];

    if (isAppOwner || isAdmin) {
      if (!allowedDriverStatuses.includes(user.driver_status)) return false;
      return hasRecentHeartbeat;
    }

    // RULE 4: Dispatcher - hide only if assigned driver is off_duty
    if (isDispatcher && !isSelf) {
      if (user.driver_status === 'off_duty') return false;

      // Dispatcher must have assigned stores
      const rawDispatcherStoreIds = currentUser?.store_ids || [];
      if (rawDispatcherStoreIds.length === 0) return false;

      // CRITICAL: Normalize store IDs to strings for consistent comparison
      const dispatcherStoreIds = new Set(rawDispatcherStoreIds.map(id => String(id)));

      const selectedDateStr = selectedDate instanceof Date 
        ? selectedDate.toISOString().split('T')[0]
        : selectedDate;

      // All possible ID formats for this driver AppUser
      const allDriverIdFormats = [user.id, user.user_id, userId].filter(Boolean);

      // Driver must have at least 1 delivery from dispatcher's stores on selected date
      const hasDispatcherStoreDelivery = deliveries?.some(d => {
        if (!d) return false;
        const driverMatch = allDriverIdFormats.some(fmt => d.driver_id === fmt);
        const dateMatch = d.delivery_date === selectedDateStr;
        // CRITICAL: Normalize delivery store_id to string before comparing
        const storeMatch = dispatcherStoreIds.has(String(d.store_id || ''));

        return driverMatch && dateMatch && storeMatch;
      });

      if (!hasDispatcherStoreDelivery) {
        const driverDeliveries = deliveries?.filter(d => d && allDriverIdFormats.some(fmt => d.driver_id === fmt) && d.delivery_date === selectedDateStr) || [];
        if (driverDeliveries.length > 0) {
          const deliveryStoreIds = [...new Set(driverDeliveries.map(d => String(d.store_id)))];
        }
      }

      return hasDispatcherStoreDelivery && user.status !== 'inactive';
    }

    // RULE 5: Driver sees other drivers ONLY if they are on_duty AND location sharing is ON
    if (isDriver && !isSelf) {
      if (user.driver_status === 'off_duty') return false;
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
      const isPrimary = device === null || (device?.status !== 'inactive' && device?.is_primary_tracker !== false);
      setIsPrimaryDevice(isPrimary);
    };

    checkPrimary();
  }, [currentUser?.id]);

  // Listen for driverLocationsUpdated events to force marker refresh
  useEffect(() => {
    const handleLocationUpdates = (event) => {
      const { appUsers: updatedAppUsers, singleUpdate, forceAll, fromRealtime, fromPoller, mergeMode } = event.detail || {};
      
      if (selectedDate) {
        const todayStr = format(new Date(), 'yyyy-MM-dd');
        const selectedDateStr = selectedDate instanceof Date 
          ? selectedDate.toISOString().split('T')[0]
          : selectedDate;
        if (selectedDateStr < todayStr) {
          return;
        }
      }

      if (!updatedAppUsers || updatedAppUsers.length === 0) return;

      const normalizedIncoming = updatedAppUsers
        .filter(Boolean)
        .map((user) => normalizeDriverRecord(user))
        .map((user) => ({
          ...user,
          current_latitude: user.current_latitude,
          current_longitude: user.current_longitude,
          location_updated_at: user.location_updated_at || new Date().toISOString()
        }));

      setVisibleDrivers((prev) => {
        const prevList = Array.isArray(prev) ? prev : [];
        const visibleIncoming = normalizedIncoming.filter(shouldShowMarker);

        if (fromPoller) {
          return dedupeVisibleDrivers(visibleIncoming);
        }

        const merged = mergeVisibleDriversByFreshness(prevList, visibleIncoming);
        return dedupeVisibleDrivers(merged.filter(shouldShowMarker));
      });
    };

    window.addEventListener('driverLocationsUpdated', handleLocationUpdates);
    return () => window.removeEventListener('driverLocationsUpdated', handleLocationUpdates);
  }, [currentUser, isPrimaryDevice, selectedDate, isAdmin, isDispatcher, isDriver, deliveries]);

  useEffect(() => {
    // CRITICAL: The `users` prop comes pre-filtered from driverLocationPoller
    // which already handles all permission checks, status checks, and dispatcher logic
    // We just need to do basic validation and track changes for re-rendering
    
    const validDrivers = (users || []).filter(user => {
      if (!user) return false;

      // Skip if no valid coordinates
      if (!user.current_latitude || !user.current_longitude) {
        return false;
      }

      // Don't show markers for past dates
      if (selectedDate) {
        const todayStr = format(new Date(), 'yyyy-MM-dd');
        const selectedDateStr = selectedDate instanceof Date 
          ? selectedDate.toISOString().split('T')[0]
          : selectedDate;
        if (selectedDateStr < todayStr) {
          return false;
        }
      }

      return shouldShowMarker(user);
    });
    
    // CRITICAL: Deduplicate self markers on primary device - only keep ONE (the live one)
    const deduplicatedDrivers = dedupeVisibleDrivers(validDrivers);
    const mergedDrivers = mergeVisibleDriversByFreshness(visibleDrivers, deduplicatedDrivers).filter(shouldShowMarker);
    
    const newVisibleIds = new Set(mergedDrivers.map(d => getDriverIdentityKey(d) || d.id));
    const prevIds = prevVisibleIdsRef.current;
    
    const idsChanged = newVisibleIds.size !== prevIds.size || 
      [...newVisibleIds].some(id => !prevIds.has(id)) ||
      [...prevIds].some(id => !newVisibleIds.has(id));
    
    const locationsChanged = mergedDrivers.some(driver => {
      const driverKey = getDriverIdentityKey(driver) || driver.id;
      const existing = visibleDrivers.find(d => (getDriverIdentityKey(d) || d.id) === driverKey);
      if (!existing) return true;
      const latDiff = Math.abs((driver.current_latitude || 0) - (existing.current_latitude || 0));
      const lngDiff = Math.abs((driver.current_longitude || 0) - (existing.current_longitude || 0));
      
      return latDiff > 0 || lngDiff > 0;
    });
    
    if (idsChanged || locationsChanged) {
      setVisibleDrivers(mergedDrivers);
      prevVisibleIdsRef.current = newVisibleIds;
    }
    
    Object.keys(markersRef.current).forEach(userId => {
      if (!mergedDrivers.find(d => (getDriverIdentityKey(d) || d.id) === userId)) {
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
      
      const todayStr = format(new Date(), 'yyyy-MM-dd');
      const isViewingPastDate = selectedDate && selectedDate < todayStr;
      
      if (!isViewingPastDate && shouldShowMarker(user)) {
        setVisibleDrivers(prev => {
          const exists = prev.find(d => d && d.id === userId);
          if (exists) {
            const moveDistance = getDistanceMeters(
              Number(exists.current_latitude),
              Number(exists.current_longitude),
              Number(latitude),
              Number(longitude)
            );
            if (moveDistance < MIN_DRIVER_MOVE_METERS) {
              return prev.map(d => d && d.id === userId ? {
                ...d,
                location_updated_at: new Date(timestamp).toISOString()
              } : d);
            }
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

    const handleSharedSelfLocationUpdate = (event) => {
      const { driver, latitude, longitude, location_updated_at } = event.detail || {};
      if (!driver || !latitude || !longitude) return;

      const driverKey = getDriverIdentityKey(driver);
      if (!driverKey) return;

      setVisibleDrivers(prev => {
        const nextDriver = normalizeDriverRecord({
          ...driver,
          current_latitude: latitude,
          current_longitude: longitude,
          location_updated_at
        });
        const withoutDriver = prev.filter(item => (getDriverIdentityKey(item) || item?.id) !== driverKey);
        return dedupeVisibleDrivers([...withoutDriver, nextDriver]);
      });
    };

    window.addEventListener('driverLocationUpdated', handleLocationUpdate);
    window.addEventListener('driverSharedSelfLocationUpdated', handleSharedSelfLocationUpdate);
    return () => {
      window.removeEventListener('driverLocationUpdated', handleLocationUpdate);
      window.removeEventListener('driverSharedSelfLocationUpdated', handleSharedSelfLocationUpdate);
    };
  }, [users, currentUser, isMobile, isAdmin, isDispatcher, isDriver, deliveries, selectedDate, isPrimaryDevice]);

  const getLocationAge = (locationUpdatedAt) => {
    if (!locationUpdatedAt) return 'Unknown';
    try {
      return format(new Date(locationUpdatedAt), 'h:mm:ss a');
    } catch (error) {
      return 'Invalid date';
    }
  };

  useEffect(() => {
    const animateMarker = (stableKey, targetLat, targetLng) => {
      const marker = markerRefs.current[stableKey];
      if (!marker?.setLatLng || !Number.isFinite(targetLat) || !Number.isFinite(targetLng)) return;
      const start = marker.getLatLng?.();
      if (!start) {
        marker.setLatLng([targetLat, targetLng]);
        return;
      }
      const startLat = Number(start.lat);
      const startLng = Number(start.lng);
      const durationMs = 450;
      const startedAt = performance.now();
      const step = (now) => {
        const progress = Math.min((now - startedAt) / durationMs, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const nextLat = startLat + (targetLat - startLat) * eased;
        const nextLng = startLng + (targetLng - startLng) * eased;
        marker.setLatLng([nextLat, nextLng]);
        if (progress < 1) {
          window.requestAnimationFrame(step);
        }
      };
      window.requestAnimationFrame(step);
    };

    visibleDrivers.forEach((user) => {
      const stableKey = getDriverIdentityKey(user) || user.id;
      animateMarker(stableKey, Number(user.current_latitude), Number(user.current_longitude));
    });
  }, [visibleDrivers]);

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
        const isSelf = user.isSelf === true || user._isSelf === true || userId === currentUserId || userId === currentUserUserId || user.user_id === currentUserId;
        const updatedAtMs = user.location_updated_at ? new Date(user.location_updated_at).getTime() : 0;
        const hasRecentHeartbeat = updatedAtMs > 0 && (Date.now() - updatedAtMs) <= 5 * 60 * 1000;
        const isSharedLocation = isSelf && !isPrimaryDevice && hasRecentHeartbeat;

        // Use user.id as stable key to prevent flickering during updates
        const stableKey = getDriverIdentityKey(user) || user.id;

        // Get staleness info from poller
        const staleness = user._staleness || 'fresh';
        const ageMinutes = user._ageMinutes || 0;
        
        // Get delivery status from user data (most recent delivery status)
        const deliveryStatus = user._deliveryStatus || 'incomplete';
        
        // Higher z-index for self/shared location markers
        const zIndexValue = isSharedLocation ? 3000 : (isActive ? 2000 : 1000);

        const driverColor = generateDriverColor(displayName);

        return (
          <Marker
            key={stableKey}
            position={position}
            icon={createDriverIcon(driverColor, user.driver_status, displayName.charAt(0).toUpperCase(), staleness, deliveryStatus)}
            zIndexOffset={zIndexValue}
            ref={(ref) => {
              if (ref) markerRefs.current[stableKey] = ref;
            }}
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