import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useDevice } from '@/components/utils/DeviceContext';

const MIN_DRIVER_MOVE_METERS = 0; // 50
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
        cursor: pointer;
        border-radius: 50%;
        background-color: ${fillColor};
        border: ${borderWidth}px solid ${borderColor};
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 3px 10px rgba(0,0,0,0.4);
        animation: driverPulse 2s infinite;
        transition: transform 0.2s ease, box-shadow 0.2s ease;
      ">
        <span style="
          font-size: 8px;
          font-weight: bold;
          color: ${textColor};
          text-transform: uppercase;
          pointer-events: none;
        ">${initial || 'D'}</span>
      </div>
      <style>
        @keyframes driverPulse {
          0%, 100% { transform: scale(1); box-shadow: 0 3px 10px rgba(0,0,0,0.4); }
          50% { transform: scale(1.15); box-shadow: 0 3px 15px rgba(0,0,0,0.5); }
        }
        .driver-marker:hover {
          z-index: 9999 !important;
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

    // FRESHNESS GUARD: never regress to an OLDER location. If the incoming record's
    // timestamp is older than what we already show, keep the existing coordinates AND
    // timestamp. This stops the marker from bouncing between a fresh DB update and a
    // stale cached value (e.g. an un-invalidated offline-DB record arriving after the
    // WebSocket update). Equal-or-newer incoming data is always accepted.
    const incomingHasCoords = user?.current_latitude && user?.current_longitude;
    const incomingIsNewerOrEqual = nextTs >= existingTs;
    const useIncomingCoords = incomingHasCoords && incomingIsNewerOrEqual;
    merged.set(key, {
      ...existing,
      ...user,
      current_latitude: useIncomingCoords ? user.current_latitude : existing?.current_latitude,
      current_longitude: useIncomingCoords ? user.current_longitude : existing?.current_longitude,
      location_updated_at: incomingIsNewerOrEqual
        ? (user?.location_updated_at || existing?.location_updated_at || user?.updated_date || existing?.updated_date)
        : (existing?.location_updated_at || existing?.updated_date || user?.location_updated_at)
    });
  });

  return Array.from(merged.values());
};

const mergeDriversWithCache = (current = [], incoming = [], cacheMap = new Map()) => {
  const merged = mergeVisibleDriversByFreshness(current, incoming);
  const result = new Map(merged.map((user) => [getDriverIdentityKey(user), user]).filter(([key]) => !!key));
  const now = Date.now();

  cacheMap.forEach((cachedUser, key) => {
    if (!key || result.has(key)) return;
    const updatedAt = new Date(cachedUser?.location_updated_at || cachedUser?.updated_date || 0).getTime();
    if (updatedAt > 0 && now - updatedAt <= MARKER_CACHE_TTL_MS) {
      result.set(key, { ...cachedUser, _fromLastKnownCache: true });
    }
  });

  return Array.from(result.values());
};

const MARKER_CACHE_TTL_MS = 3 * 60 * 1000;

const DriverLocationMarkers = ({ users, currentUser, activeDriver, deliveries = [], selectedDate = null }) => {
  const { isMobile } = useDevice();
  const [visibleDrivers, setVisibleDrivers] = useState([]);
  const lastPropUpdateRef = useRef(0);
  const markerRefs = useRef({});
  const prevVisibleIdsRef = useRef(new Set());
  const lastKnownDriversRef = useRef(new Map());
  const [isPrimaryDevice, setIsPrimaryDevice] = useState(true);
  const isPrimaryDeviceRef = useRef(true);

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

    // RULE 0: Primary driver device never shows its own shared AppUser marker.
    // The live GPS dot (blue dot) is the authoritative self-marker on the primary device.
    // CRITICAL: Do NOT gate on isMobile/orientation — the primary device check is
    // device-identity based, not screen-orientation based. Landscape mode on a phone
    // is still a mobile phone and should suppress the shared self-marker.
    const _isPrimary = isPrimaryDeviceRef.current;
    if (isSelf && _isPrimary && isDriver) {
      return false;
    }

      // RULE 1: Self marker on non-primary device — show as long as coordinates exist.
      // If the driver is on_duty or on_break, always show (even if heartbeat is stale/stopped).
      // Only hide when off_duty (coordinates are nulled) or no coordinates available.
      if (isSelf && !_isPrimary) {
        const isActiveStatus = user.driver_status === 'on_duty' || user.driver_status === 'on_break';
        return isActiveStatus || (user.location_updated_at != null);
      }

      // RULE 2: Non-driver self markers (dispatchers, admins) on primary device
      if (isSelf && _isPrimary && !isDriver) {
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
      // Always show on_duty/on_break drivers at their last known location, even if heartbeat stopped.
      const isActiveStatus = user.driver_status === 'on_duty' || user.driver_status === 'on_break';
      return isActiveStatus || hasRecentHeartbeat;
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

      // Keep marker visible if driver is on_duty/on_break even if heartbeat stopped
      const isActiveStatus = user.driver_status === 'on_duty' || user.driver_status === 'on_break';
      return hasDispatcherStoreDelivery && user.status !== 'inactive' && isActiveStatus;
    }

    // RULE 5: Driver sees other drivers ONLY if they are on_duty/on_break AND location sharing is ON.
    // Markers persist at last known location even if heartbeat stops — hidden only when off_duty.
    if (isDriver && !isSelf) {
      if (currentUser?.status === 'inactive') return false;
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
      isPrimaryDeviceRef.current = isPrimary;
      setIsPrimaryDevice(isPrimary);
    };

    checkPrimary();
  }, [currentUser?.id]);

  useEffect(() => {
    const now = Date.now();
    visibleDrivers.forEach((user) => {
      const key = getDriverIdentityKey(user) || user.id;
      if (!key) return;
      lastKnownDriversRef.current.set(key, {
        ...user,
        _fromLastKnownCache: false,
        _lastSeenAt: now
      });
    });

    lastKnownDriversRef.current.forEach((cachedUser, key) => {
      // Only evict off_duty drivers or those whose timestamp is beyond the cache TTL
      // On-duty/on-break drivers persist indefinitely at their last known location
      const isActiveStatus = cachedUser?.driver_status === 'on_duty' || cachedUser?.driver_status === 'on_break';
      if (isActiveStatus) return; // never evict active drivers from cache
      const updatedAt = new Date(cachedUser?.location_updated_at || cachedUser?.updated_date || 0).getTime();
      if (updatedAt > 0 && now - updatedAt > MARKER_CACHE_TTL_MS) {
        lastKnownDriversRef.current.delete(key);
      }
    });
  }, [visibleDrivers]);

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
          // CRITICAL: Never fabricate a timestamp. If location_updated_at is missing, leave it
          // undefined so mergeVisibleDriversByFreshness treats this record as ts=0 (oldest) and
          // will never let it overwrite a record that already has a real timestamp.
          location_updated_at: user.location_updated_at ?? undefined
        }));

      setVisibleDrivers((prev) => {
        const prevList = Array.isArray(prev) ? prev : [];
        const visibleIncoming = normalizedIncoming.filter(shouldShowMarker);

        // CRITICAL: ALWAYS merge incoming into existing state — never replace.
        // Whether this comes from a WebSocket targeted update or SmartRefresh poll,
        // replacing the full list can momentarily show stale positions for drivers
        // not included in the incoming batch, causing the flicker/jump effect.
        const merged = mergeVisibleDriversByFreshness(prevList, visibleIncoming);
        return dedupeVisibleDrivers(merged.filter(shouldShowMarker));
      });
    };

    window.addEventListener('driverLocationsUpdated', handleLocationUpdates);
    return () => window.removeEventListener('driverLocationsUpdated', handleLocationUpdates);
  }, [currentUser, selectedDate, isAdmin, isDispatcher, isDriver, deliveries]);

  useEffect(() => {
    // Normalize and filter the incoming users prop
    const validDrivers = (users || []).filter(user => {
      if (!user || !user.current_latitude || !user.current_longitude) return false;
      if (selectedDate) {
        const todayStr = format(new Date(), 'yyyy-MM-dd');
        const selectedDateStr = selectedDate instanceof Date ? selectedDate.toISOString().split('T')[0] : selectedDate;
        if (selectedDateStr < todayStr) return false;
      }
      return shouldShowMarker(user);
    });

    const incomingDrivers = dedupeVisibleDrivers(validDrivers);
    const incomingKeys = new Set(incomingDrivers.map(d => getDriverIdentityKey(d) || d.id).filter(Boolean));

    // UNIFIED UPDATE: same merge-by-freshness logic as the driverLocationsUpdated event handler.
    // Uses a functional updater (never reads stale closure) so there's no race between the
    // WS event path and the prop path — whichever wrote fresher coords wins and is kept.
    setVisibleDrivers((prev) => {
      // Merge: incoming advances existing if newer, existing wins if fresher (no regression)
      const merged = mergeVisibleDriversByFreshness(prev || [], incomingDrivers);

      // Sync semantics: drop drivers no longer in the prop, UNLESS they have a very recent
      // timestamp that suggests a WS event updated them after this prop snapshot was taken.
      const WS_GRACE_MS = 90 * 1000;
      const result = merged.filter(d => {
        const key = getDriverIdentityKey(d) || d.id;
        if (incomingKeys.has(key)) return shouldShowMarker(d);
        // Not in prop — keep briefly if WS delivered a fresh update we shouldn't discard yet
        const ts = new Date(d.location_updated_at || d.updated_date || 0).getTime();
        return (Date.now() - ts < WS_GRACE_MS) && shouldShowMarker(d);
      });

      return dedupeVisibleDrivers(result);
    });

    prevVisibleIdsRef.current = incomingKeys;

    // Clean up marker refs for drivers that are no longer in the incoming set
    Object.keys(markerRefs.current).forEach(userId => {
      if (!incomingKeys.has(userId)) delete markerRefs.current[userId];
    });

  }, [users, currentUser, isMobile, deliveries, selectedDate, isAdmin, isDispatcher, isDriver]);

  // Listen for location cleared events
  useEffect(() => {
    const handleLocationCleared = (event) => {
      const userId = event.detail?.userId;
      if (userId) {
        setVisibleDrivers(prev => prev.filter(d => d.id !== userId && d.user_id !== userId));
        delete markerRefs.current[userId];
      }
    };

    window.addEventListener('driverLocationCleared', handleLocationCleared);
    return () => window.removeEventListener('driverLocationCleared', handleLocationCleared);
  }, []);

  const getLocationAge = (locationUpdatedAt) => {
    if (!locationUpdatedAt) return 'Unknown';
    try {
      return format(new Date(locationUpdatedAt), 'h:mm:ss a');
    } catch (error) {
      return 'Invalid date';
    }
  };

  // Stable display timestamps — debounced per driver so the popup doesn't flicker
  // when two browser instances receive the same WS event at slightly different times.
  const stableTimestampsRef = useRef(new Map()); // key → { ts: string, committedAt: number }
  const TIMESTAMP_DEBOUNCE_MS = 3000; // only update displayed timestamp if >3s newer

  const getStableTimestamp = (stableKey, locationUpdatedAt) => {
    if (!locationUpdatedAt) return locationUpdatedAt;
    const entry = stableTimestampsRef.current.get(stableKey);
    const incoming = new Date(locationUpdatedAt).getTime();
    if (!entry) {
      stableTimestampsRef.current.set(stableKey, { ts: locationUpdatedAt, committedAt: Date.now() });
      return locationUpdatedAt;
    }
    const existing = new Date(entry.ts).getTime();
    // Only advance the displayed timestamp if the incoming value is meaningfully newer
    if (incoming - existing >= TIMESTAMP_DEBOUNCE_MS) {
      stableTimestampsRef.current.set(stableKey, { ts: locationUpdatedAt, committedAt: Date.now() });
      return locationUpdatedAt;
    }
    return entry.ts;
  };

  // Stable initial positions — used as the React prop for each Marker so the prop never changes
  // (position updates are applied imperatively via setLatLng in the animation effect below).
  const initialPositionsRef = useRef(new Map());

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
      const targetLat = Number(user.current_latitude);
      const targetLng = Number(user.current_longitude);
      if (!Number.isFinite(targetLat) || !Number.isFinite(targetLng)) return;

      if (!initialPositionsRef.current.has(stableKey)) {
        // First time we see this driver — seed the stable position (used as React prop)
        initialPositionsRef.current.set(stableKey, [targetLat, targetLng]);
      }

      // Always animate imperatively — never change the React position prop
      animateMarker(stableKey, targetLat, targetLng);
    });

    // Clean up positions for drivers that are no longer visible
    const visibleKeys = new Set(visibleDrivers.map(u => getDriverIdentityKey(u) || u.id));
    for (const key of initialPositionsRef.current.keys()) {
      if (!visibleKeys.has(key)) initialPositionsRef.current.delete(key);
    }
  }, [visibleDrivers]);

  // Stable icon cache — keyed by driver identity + visual state signature.
  // Reuses the same L.divIcon object as long as staleness/status/deliveryStatus don't change,
  // so Leaflet never tears down and rebuilds the marker DOM element on location-only updates.
  const iconCacheRef = useRef(new Map());
  const getStableIcon = useCallback((stableKey, driverColor, driverStatus, initial, staleness, deliveryStatus) => {
    const iconKey = `${stableKey}|${driverColor}|${driverStatus}|${initial}|${staleness}|${deliveryStatus}`;
    if (!iconCacheRef.current.has(iconKey)) {
      // Evict any old entry for this driver before inserting the new one
      for (const k of iconCacheRef.current.keys()) {
        if (k.startsWith(`${stableKey}|`)) {
          iconCacheRef.current.delete(k);
          break;
        }
      }
      iconCacheRef.current.set(iconKey, createDriverIcon(driverColor, driverStatus, initial, staleness, deliveryStatus));
    }
    return iconCacheRef.current.get(iconKey);
  }, []);

  if (!visibleDrivers || visibleDrivers.length === 0) {
    return null;
  }

  return (
    <>
      <style>
        {`
          @keyframes pulse {
            0% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.5; transform: scale(1.2); }
            100% { opacity: 1; transform: scale(1); }
          }
          .driver-location-marker {
            background: transparent;
            border: none;
          }
        `}
      </style>
      
      {visibleDrivers.map((user) => {
        const lat = Number(user?.current_latitude);
        const lng = Number(user?.current_longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        const isActive = activeDriver?.id === user.id;
        const displayName = user.user_name || user.full_name || 'Unknown Driver';
        const firstName = displayName.split(' ')[0];
        
        const stableKey = getDriverIdentityKey(user) || user.id;
        // Stable timestamp — debounced so popup doesn't flicker when WS events arrive
        // at slightly different times across browser instances
        const stableUpdatedAt = getStableTimestamp(stableKey, user.location_updated_at);

        const currentUserId = currentUser?.id;
        const currentUserUserId = currentUser?.user_id;
        const currentAppUserId = currentUser?.appUserId;
        const userId = user.id || user.user_id;
        // CRITICAL: Match all possible ID formats — AppUser.user_id vs User.id vs appUserId
        // to ensure isSelf is stable across browser instances regardless of which field arrives first
        const isSelf = user.isSelf === true || user._isSelf === true ||
          userId === currentUserId ||
          userId === currentUserUserId ||
          userId === currentAppUserId ||
          user.user_id === currentUserId ||
          user.user_id === currentUserUserId;
        const updatedAtMs = stableUpdatedAt ? new Date(stableUpdatedAt).getTime() : 0;
        const hasRecentHeartbeat = updatedAtMs > 0 && (Date.now() - updatedAtMs) <= 5 * 60 * 1000;
        const isSharedLocation = isSelf && !isPrimaryDeviceRef.current && hasRecentHeartbeat;

        // Use the stable initial position as the React prop — actual movement is applied
        // imperatively via setLatLng in the animation effect, preventing Leaflet from
        // destroying and recreating the marker DOM (and triggering tile reloads) on every update.
        const position = initialPositionsRef.current.get(stableKey) || [lat, lng];
        const staleness = user._staleness || 'fresh';
        const ageMinutes = user._ageMinutes || 0;
        const deliveryStatus = user._deliveryStatus || 'incomplete';
        const zIndexValue = isSharedLocation ? 3000 : (isActive ? 2000 : 1000);
        const driverColor = generateDriverColor(displayName);

        // Use cached icon — avoids Leaflet destroying/recreating the marker DOM on every location update
        const stableIcon = getStableIcon(stableKey, driverColor, user.driver_status, displayName.charAt(0).toUpperCase(), staleness, deliveryStatus);

        return (
          <Marker
            key={stableKey}
            position={position}
            icon={stableIcon}
            zIndexOffset={zIndexValue}
            ref={(ref) => {
              if (ref) markerRefs.current[stableKey] = ref;
            }}
            eventHandlers={{
              mouseover: (e) => e.target.openPopup(),
              mouseout: (e) => e.target.closePopup(),
            }}
          >
            <Popup autoPan={false} closeButton={false} offset={[0, -10]} className="custom-popup">
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
                {user._fromLastKnownCache && (
                  <p className="text-xs text-slate-500 mt-1 italic">
                    📍 Showing last known location
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
                        className="flex-1 px-2 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs rounded transition-colors font-medium flex flex-col items-center gap-0.5"
                        title={`Navigate to ${firstName}'s location`}
                      >
                        <span>📍</span>
                        <span>Goto</span>
                      </button>
                      <button
                        onClick={() => {
                          window.location.href = `tel:${user.phone}`;
                        }}
                        className="flex-1 px-2 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded transition-colors font-medium flex flex-col items-center gap-0.5"
                        title={`Call ${firstName}`}
                      >
                        <span>📞</span>
                        <span>Call</span>
                      </button>
                    </div>
                  </>
                )}
                <p className="text-xs text-slate-600 mt-2">
                  Updated: {getLocationAge(stableUpdatedAt)}
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