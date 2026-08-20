import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Marker, Popup } from 'react-leaflet';
import { Phone, Store, Navigation } from 'lucide-react';
import { useAppData } from '@/components/utils/AppDataContext';
import { globalFilters } from '@/components/utils/globalFilters';
import { getAllLocations } from '@/components/utils/interStoreDisplayName';
import { calculateHaversineDistance } from '@/components/utils/distanceCalculator';
import { formatPhoneNumber } from '@/components/utils/phoneFormatter';
import { userHasRole } from '@/components/utils/userRoles';
import { getInterStoreMode, subscribeInterStore } from './interStoreToggleStore';
import { createInterStoreIcon } from './MapIcons';
import { fabControlEvents } from '@/components/utils/fabControlEvents';

/** Haversine distance in km between two [lat,lng] points. */
const kmBetween = (aLat, aLng, bLat, bLng) => {
  if (
    aLat == null || aLng == null || bLat == null || bLng == null ||
    Number.isNaN(+aLat) || Number.isNaN(+aLng) || Number.isNaN(+bLat) || Number.isNaN(+bLng)
  ) {
    return null;
  }
  const meters = calculateHaversineDistance(+aLat, +aLng, +bLat, +bLng);
  return meters / 1000;
};

const formatKm = (km, estimated = false) =>
  km == null ? '—' : `${estimated ? '~' : ''}${km.toFixed(1)} km`;

/**
 * Resolves the dispatcher's "session store" — the store distance legs are
 * measured back to. Priority: URL ?store= param → globalFilters store id →
 * the dispatcher's single assigned store.
 */
export function resolveSessionStore(currentUser, stores) {
  if (!currentUser || !stores?.length) return null;

  // 1. URL ?store= param (set by the Layout store dropdown)
  let storeId = null;
  try {
    const urlStore = new URLSearchParams(window.location.search).get('store');
    if (urlStore && urlStore !== 'all') storeId = urlStore;
  } catch { /* ignore */ }

  // 2. globalFilters selected store
  if (!storeId) {
    const gfStore = globalFilters.getSelectedStoreId?.();
    if (gfStore && gfStore !== 'all') storeId = gfStore;
  }

  // 3. Single assigned store
  if (!storeId && Array.isArray(currentUser.store_ids) && currentUser.store_ids.length === 1) {
    storeId = currentUser.store_ids[0];
  }

  const store = storeId ? stores.find((s) => s && s.id === storeId) : null;
  if (!store || !store.latitude || !store.longitude) return null;
  return { id: store.id, name: store.name || 'Your store', lat: +store.latitude, lng: +store.longitude };
}

const RADIUS_KM = 20;

/**
 * All drivers for the given city, regardless of duty status.
 *  - on_duty / online → current GPS fix (exact distance)
 *  - on_break         → last known GPS fix from AppUser (~ estimated distance)
 *  - off_duty         → home location (~ estimated distance)
 * Drivers with no resolvable coordinates for their status are skipped.
 */
export function resolveCityDrivers(appUsers, cityId) {
  if (!appUsers?.length || !cityId) return [];
  return appUsers
    .filter((au) => au && Array.isArray(au.app_roles) && au.app_roles.includes('driver'))
    .filter((au) => au.status === 'active')
    .filter((au) => Array.isArray(au.city_ids) ? au.city_ids.includes(cityId) : au.city_id === cityId)
    .map((au) => {
      const status = au.driver_status || 'off_duty';
      let lat = null;
      let lng = null;
      let estimated = false;
      let statusNote = '';

      if (status === 'on_duty' || status === 'online') {
        lat = au.current_latitude;
        lng = au.current_longitude;
        statusNote = 'on duty';
      } else if (status === 'on_break') {
        // last known GPS fix — estimated, prefixed with ~
        lat = au.current_latitude;
        lng = au.current_longitude;
        estimated = true;
        statusNote = 'on break';
      } else {
        // off_duty — use home location, estimated
        lat = au.home_latitude;
        lng = au.home_longitude;
        estimated = true;
        statusNote = 'off duty (home)';
      }

      if (lat == null || lng == null) return null;
      lat = +lat;
      lng = +lng;
      if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
      return { id: au.user_id || au.id, name: au.user_name || 'Unknown', lat, lng, status, statusNote, estimated };
    })
    .filter(Boolean);
}

export default function InterStoreMarkers() {
  const { currentUser, appUsers, stores, deliveries } = useAppData();
  const [mode, setMode] = useState(getInterStoreMode());
  const [locations, setLocations] = useState([]);
  const [dispatcherLoc, setDispatcherLoc] = useState(null);
  const active = mode !== 'off';

  // Subscribe to the toggle store so the button flip re-renders this layer.
  useEffect(() => {
    const unsubscribe = subscribeInterStore(setMode);
    return unsubscribe;
  }, []);

  // Only dispatchers render this layer.
  const isDispatcher =
    currentUser && userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');

  const selectedCityId = useMemo(() => {
    const cityId = globalFilters.getSelectedCityId?.();
    return cityId && cityId !== 'all' ? cityId : null;
  }, []);

  // The dispatcher's session store — the origin for both the 20km InterStore
  // radius filter and the driver leg distance calculations. Computed once per
  // render so the location-loading effect can depend on a stable value.
  const sessionStore = useMemo(
    () => resolveSessionStore(currentUser, stores),
    [currentUser, stores]
  );

  // Incomplete pickup stop coordinates. When an InterStore candidate marker sits on
  // top of an incomplete Store Pickup, the pickup must win z priority (lowest
  // stop_order in its tier ⇒ rendered on top, receives hover). We detect overlap by
  // matching the candidate's geocoded store coords against the pickup's store coords.
  const isIncompletePickupAt = useMemo(() => {
    const FINISHED = ['completed', 'failed', 'cancelled'];
    const storeMap = new Map((stores || []).filter(Boolean).map((s) => [s.id, s]));
    const coords = (deliveries || [])
      .filter((d) => d && !d.patient_id && !FINISHED.includes(d.status))
      .map((d) => {
        const s = storeMap.get(d.store_id);
        return s && s.latitude && s.longitude ? [+s.latitude, +s.longitude] : null;
      })
      .filter(Boolean);
    return (lat, lng, eps = 0.0005) =>
      coords.some(([pLat, pLng]) => Math.abs(pLat - lat) < eps && Math.abs(pLng - lng) < eps);
  }, [deliveries, stores]);

  // Load InterStore locations within a 20km radius of the dispatcher's store.
  useEffect(() => {
    if (!active || !isDispatcher || !sessionStore) {
      setLocations([]);
      setDispatcherLoc(null);
      return;
    }

    let cancelled = false;
    getAllLocations()
      .then((all) => {
        if (cancelled) return;
        // Hide the dispatcher's own store from the marker layer.
        const isOwnStore = (loc) => {
          if (!sessionStore || !loc) return false;
          const nm = (loc.store_name || '').toLowerCase();
          const sn = (sessionStore.name || '').toLowerCase();
          if (nm && sn && (nm === sn || nm.includes(sn) || sn.includes(nm))) return true;
          const km = kmBetween(sessionStore.lat, sessionStore.lng, +loc.store_latitude, +loc.store_longitude);
          return km != null && km < 0.05;
        };
        // The dispatcher's own store — resolved from the FULL list (before the
        // isOwnStore filter removes it) so it can prefill the other half of the
        // From/To when a marker is clicked.
        const ownLoc = (all || []).find((l) => {
          if (!l || !l.store_name || !sessionStore?.name) return false;
          const nm = l.store_name.toLowerCase();
          const sn = sessionStore.name.toLowerCase();
          return nm === sn || nm.includes(sn) || sn.includes(nm);
        }) || null;
        setDispatcherLoc(ownLoc);
        const filtered = (all || []).filter((loc) => {
          if (!loc || loc.store_latitude == null || loc.store_longitude == null) return false;
          if (isOwnStore(loc)) return false;
          const km = kmBetween(sessionStore.lat, sessionStore.lng, +loc.store_latitude, +loc.store_longitude);
          return km != null && km <= RADIUS_KM;
        });
        setLocations(filtered);
      })
      .catch(() => {
        if (!cancelled) { setLocations([]); setDispatcherLoc(null); }
      });

    return () => { cancelled = true; };
  }, [active, isDispatcher, sessionStore]);

  // Once all InterStore markers have mounted for this active session, briefly
  // activate MapViewCycleFAB phase 1 (locked for 500ms) so the map refits its
  // bounds to show every InterStore marker. Fires exactly once per active
  // session — resets when the toggle flips off or the location set empties.
  const didRefitRef = useRef(false);
  useEffect(() => {
    if (!active || !locations.length) {
      didRefitRef.current = false;
      return;
    }
    if (didRefitRef.current) return;
    didRefitRef.current = true;
    // Defer one tick so react-leaflet has actually placed the markers on the
    // map before the phase-1 refit reads the marker layer bounds.
    const t = setTimeout(() => {
      fabControlEvents.resetToPhaseOneAfterDone(500);
    }, 100);
    return () => clearTimeout(t);
  }, [active, locations.length]);

  // Mirror the rendered InterStore marker positions into a window global so the
  // Dashboard's phase-1 bounds fit can union these candidate positions with the
  // driver/stop markers — otherwise phase 1 fits only the selected driver's
  // stops and excludes the InterStore candidates from the bounds.
  useEffect(() => {
    if (!active || !locations.length) {
      window.__mapInterStoreMarkers = [];
      return;
    }
    window.__mapInterStoreMarkers = locations
      .map((loc) => {
        const lat = +loc.store_latitude;
        const lng = +loc.store_longitude;
        if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
        return { latitude: lat, longitude: lng, id: loc.id };
      })
      .filter(Boolean);
    return () => { window.__mapInterStoreMarkers = []; };
  }, [active, locations]);

  // When the InterStore toggle deactivates, refit phase-1 bounds again so the
  // map drops the wide InterStore-inclusive view and returns to the driver/stop
  // bounds. Tracks the previous `active` so it only fires on a real transition.
  const prevActiveRef = useRef(active);
  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = active;
    if (wasActive && !active) {
      window.__mapInterStoreMarkers = [];
      const t = setTimeout(() => {
        fabControlEvents.resetToPhaseOneAfterDone(500);
      }, 100);
      return () => clearTimeout(t);
    }
  }, [active]);

  if (!active || !isDispatcher || !locations.length || !sessionStore) return null;

  const drivers = resolveCityDrivers(appUsers, selectedCityId);
  // Marker fill color matches the active toggle half (pickup = green, dropoff = red).
  const icon = createInterStoreIcon(mode);
  const headerIconColor = mode === 'pickup' ? 'text-emerald-600' : 'text-red-600';

  const buildPrefill = (clickedLoc) => {
    const src = mode === 'pickup' ? clickedLoc : dispatcherLoc;
    const dst = mode === 'pickup' ? dispatcherLoc : clickedLoc;
    return {
      mode,
      sourceId: src?.id || '',
      sourceName: src?.store_name || '',
      sourceNumber: src?.store_number || src?.store_name || '',
      destId: dst?.id || '',
      destName: dst?.store_name || '',
      destNumber: dst?.store_number || dst?.store_name || '',
      storeId: sessionStore?.id || '',
    };
  };

  return locations.map((loc) => {
    const lat = +loc.store_latitude;
    const lng = +loc.store_longitude;
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

    // Yield z priority to an incomplete pickup stop at the same location so the
    // pickup (lowest stop_order in its tier) renders on top and receives hover.
    const overlapsIncompletePickup = isIncompletePickupAt(lat, lng);

    const distFromSession = sessionStore
      ? kmBetween(sessionStore.lat, sessionStore.lng, lat, lng)
      : null;

    const driverLines = drivers
      .map((d) => {
        // leg2 (marker → session store) is always exact; leg1 (driver → marker)
        // is estimated only when the driver's own position is an estimate.
        const leg1 = kmBetween(d.lat, d.lng, lat, lng);
        return { id: d.id, name: d.name, leg1, estimated: d.estimated, statusNote: d.statusNote };
      })
      .sort((a, b) => (a.leg1 ?? Infinity) - (b.leg1 ?? Infinity));

    return (
      <Marker
        key={loc.id || `${loc.store_name}-${lat},${lng}`}
        position={[lat, lng]}
        icon={icon}
        zIndexOffset={overlapsIncompletePickup ? 4000 : 20000}
        eventHandlers={{
          mouseover: (e) => e.target.openPopup(),
          mouseout: (e) => e.target.closePopup(),
          click: () => {
            window.dispatchEvent(new CustomEvent('openInterStoreAddRoute', { detail: buildPrefill(loc) }));
          },
          }}
      >
        <Popup closeButton={false} autoPan={false} offset={[0, -10]} className="custom-popup">
          <div className="min-w-[180px] text-slate-900 dark:text-slate-100">
            <div className="flex items-center gap-1.5">
              <Store className={`w-3.5 h-3.5 ${headerIconColor}`} />
              <h3 className="font-semibold text-xs">{loc.store_name || 'InterStore Location'}</h3>
            </div>

            {(loc.store_phone || loc.store_number) && (
              <div className="flex items-center gap-3 mt-1.5">
                {loc.store_phone && (
                  <span className="flex items-center gap-1">
                    <Phone className="w-3 h-3 text-slate-500" />
                    <span className="text-[11px]">{formatPhoneNumber(loc.store_phone)}</span>
                  </span>
                )}
                {loc.store_number && (
                  <span className="text-[11px] text-slate-600 dark:text-slate-400">SDM #: {loc.store_number}</span>
                )}
              </div>
            )}

            <div className="flex items-center gap-1.5 mt-1.5">
              <Navigation className="w-3 h-3 text-slate-500" />
              <span className="text-[11px]">
                From {sessionStore?.name || 'your store'}: <span className="font-semibold">{formatKm(distFromSession)}</span>
              </span>
            </div>

            {driverLines.length > 0 && (
              <>
                <div className="border-t border-slate-200 dark:border-slate-700 mt-2 mb-1.5" />
                <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">Driver legs</div>
                {driverLines.map((d) => (
                  <div key={d.id} className="text-[11px] flex justify-between gap-2" title={d.statusNote}>
                    <span className="truncate">{d.name}</span>
                    <span className="whitespace-nowrap font-medium">{formatKm(d.leg1, d.estimated)}</span>
                  </div>
                ))}
              </>
            )}

            {driverLines.length === 0 && (
              <div className="text-[10px] text-slate-400 mt-2">No drivers in this city</div>
            )}
          </div>
        </Popup>
      </Marker>
    );
  });
}