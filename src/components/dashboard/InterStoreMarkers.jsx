import React, { useEffect, useMemo, useState } from 'react';
import { Marker, Popup } from 'react-leaflet';
import { Phone, Store, Navigation } from 'lucide-react';
import { useAppData } from '@/components/utils/AppDataContext';
import { globalFilters } from '@/components/utils/globalFilters';
import { getAllLocations } from '@/components/utils/interStoreDisplayName';
import { calculateHaversineDistance } from '@/components/utils/distanceCalculator';
import { formatPhoneNumber } from '@/components/utils/phoneFormatter';
import { userHasRole } from '@/components/utils/userRoles';
import { isInterStoreActive, subscribeInterStore } from './interStoreToggleStore';
import { createInterStoreIcon } from './MapIcons';

const toRad = (v) => (v * Math.PI) / 180;

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

const formatKm = (km) => (km == null ? '—' : `${km.toFixed(1)} km`);

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

/**
 * Active, on-duty drivers with a current GPS fix.
 */
export function resolveActiveDrivers(appUsers) {
  if (!appUsers?.length) return [];
  return appUsers
    .filter((au) => au && Array.isArray(au.app_roles) && au.app_roles.includes('driver'))
    .filter((au) => au.status === 'active')
    .filter((au) => au.driver_status === 'on_duty' || au.driver_status === 'online')
    .filter((au) => au.current_latitude != null && au.current_longitude != null)
    .map((au) => ({
      id: au.user_id || au.id,
      name: au.user_name || 'Unknown',
      lat: +au.current_latitude,
      lng: +au.current_longitude,
    }))
    .filter((d) => !Number.isNaN(d.lat) && !Number.isNaN(d.lng));
}

export default function InterStoreMarkers() {
  const { currentUser, appUsers, stores, cities } = useAppData();
  const [active, setActive] = useState(isInterStoreActive());
  const [locations, setLocations] = useState([]);

  // Subscribe to the toggle store so the button flip re-renders this layer.
  useEffect(() => {
    const unsubscribe = subscribeInterStore(setActive);
    return unsubscribe;
  }, []);

  // Only dispatchers render this layer.
  const isDispatcher =
    currentUser && userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');

  const cityName = useMemo(() => {
    if (!cities?.length) return null;
    const cityId = globalFilters.getSelectedCityId?.();
    if (!cityId || cityId === 'all') return null;
    const city = cities.find((c) => c && c.id === cityId);
    return city?.name || null;
  }, [cities]);

  // Load InterStore locations (offline-first, cached) when the layer is on.
  useEffect(() => {
    if (!active || !isDispatcher || !cityName) {
      setLocations([]);
      return;
    }

    let cancelled = false;
    getAllLocations()
      .then((all) => {
        if (cancelled) return;
        const target = cityName.trim().toLowerCase();
        const filtered = (all || []).filter((loc) => {
          if (!loc) return false;
          if (loc.store_latitude == null || loc.store_longitude == null) return false;
          const locCity = (loc.city || '').trim().toLowerCase();
          if (!locCity) return false;
          return locCity === target;
        });
        setLocations(filtered);
      })
      .catch(() => {
        if (!cancelled) setLocations([]);
      });

    return () => { cancelled = true; };
  }, [active, isDispatcher, cityName]);

  if (!active || !isDispatcher || !locations.length) return null;

  const sessionStore = resolveSessionStore(currentUser, stores);
  const drivers = resolveActiveDrivers(appUsers);
  const icon = createInterStoreIcon();

  return locations.map((loc) => {
    const lat = +loc.store_latitude;
    const lng = +loc.store_longitude;
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;

    const distFromSession = sessionStore
      ? kmBetween(sessionStore.lat, sessionStore.lng, lat, lng)
      : null;

    const driverLines = drivers.map((d) => {
      const leg1 = kmBetween(d.lat, d.lng, lat, lng);
      const leg2 = sessionStore ? kmBetween(lat, lng, sessionStore.lat, sessionStore.lng) : null;
      return { id: d.id, name: d.name, leg1, leg2 };
    });

    return (
      <Marker
        key={loc.id || `${loc.store_name}-${lat},${lng}`}
        position={[lat, lng]}
        icon={icon}
        zIndexOffset={-2000}
        eventHandlers={{
          mouseover: (e) => e.target.openPopup(),
          mouseout: (e) => e.target.closePopup(),
        }}
      >
        <Popup closeButton={false} autoPan={false} offset={[0, -10]} className="custom-popup">
          <div className="min-w-[180px] text-slate-900 dark:text-slate-100">
            <div className="flex items-center gap-1.5">
              <Store className="w-3.5 h-3.5 text-red-600" />
              <h3 className="font-semibold text-xs">{loc.store_name || 'InterStore Location'}</h3>
            </div>

            {loc.store_phone && (
              <div className="flex items-center gap-1.5 mt-1.5">
                <Phone className="w-3 h-3 text-slate-500" />
                <span className="text-[11px]">{formatPhoneNumber(loc.store_phone)}</span>
              </div>
            )}

            {loc.store_number && (
              <div className="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5">
                SDM #: {loc.store_number}
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
                  <div key={d.id} className="text-[11px] flex justify-between gap-2">
                    <span className="truncate">{d.name}</span>
                    <span className="whitespace-nowrap font-medium">
                      → {formatKm(d.leg1)} → {formatKm(d.leg2)}
                    </span>
                  </div>
                ))}
              </>
            )}

            {driverLines.length === 0 && (
              <div className="text-[10px] text-slate-400 mt-2">No active drivers on duty</div>
            )}
          </div>
        </Popup>
      </Marker>
    );
  });
}