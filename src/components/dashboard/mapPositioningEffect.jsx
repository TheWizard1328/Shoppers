/**
 * Extracted map positioning logic from Dashboard.jsx
 * Handles Phase 1, 2, and 3 map bounds/center computation
 */
import { format } from 'date-fns';
import { getFabTargetDriverMapLocation, isDriverOffDuty } from './mapViewPhaseHelpers';
import { collectPhase3SingleDriverCoordinates } from './phase3BoundsHelper';
import { getInterStoreLocationSync, isInterStoreDelivery } from '../utils/interStoreDisplayName';
import { getBoundsSpanKm, getPhaseBoundsMaxZoom } from './mapCycleZoomHelpers';
import { globalFilters } from '../utils/globalFilters';
import { calculateDistance } from './DashboardHelpers';
import { userHasRole } from '../utils/userRoles';

const getEdmDate = () => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return `${p.find(x => x.type === 'year').value}-${p.find(x => x.type === 'month').value}-${p.find(x => x.type === 'day').value}`;
};

export function runMapPositioningEffect({
  mapViewTrigger,
  mapViewPhase,
  mapViewPhaseRef,
  pendingPhaseRef,
  isMapViewLockedRef,
  lastAppliedTriggerRef,
  driverLocationRef,
  nextStopCoordinatesRef,
  deliveriesWithStopOrderRef,
  patientsRef,
  storesRef,
  allDriverLocationsRef,
  appUsersRef,
  deliveriesRef,
  selectedDateRef,
  showAllDriverMarkersRef,
  selectedDriverIdRef,
  citiesRef,
  isPrimaryDeviceRef,
  currentUser,
  isDriver,
  isAdmin,
  isDispatcher,
  isMobile,
  selectedDriverId,
  cities,
  driverLocation,
  allDriverLocations,
  isPrimaryDevice,
  appUsers,
  setShouldFitBounds,
  setMapCenter,
  setMapZoom,
  setIsMapViewLocked,
  getMapPadding,
  immersiveHidden = false,
}) {
  if (mapViewTrigger === 0 || mapViewTrigger === lastAppliedTriggerRef.current) return;
  if (mapViewPhaseRef.current === 0) return;

  lastAppliedTriggerRef.current = mapViewTrigger;
  console.log(`🗺️ [mapPos] phase=${mapViewPhaseRef.current} trigger=${mapViewTrigger}`);

  // CRITICAL GUARD: mapViewPhaseRef.current is the authoritative phase.
  // If it says Phase 1, force pendingPhaseRef back to 1 before resolving.
  if (mapViewPhaseRef.current === 1 && pendingPhaseRef.current !== 1) {
    pendingPhaseRef.current = 1;
  }

  const resolvedPhase = mapViewPhaseRef.current; // always trust the ref, not pendingPhase

  // For phase 2, if no driver location is available, fall back to phase 1
  if (resolvedPhase === 2 &&
    !(isDispatcher && !isAdmin) &&
    !(isAdmin && selectedDriverIdRef.current === 'all') &&
    !getFabTargetDriverMapLocation({
      selectedDriverId: selectedDriverIdRef.current,
      currentUser, isDriver,
      appUsers: appUsersRef.current,
      driverLocation: driverLocationRef.current,
      allDriverLocations: allDriverLocationsRef.current,
      isPrimaryDevice: isPrimaryDeviceRef.current,
    })
  ) {
    // No driver location — skip silently, do not reposition
    return;
  }

  switch (resolvedPhase) {
    case 1: {
      const allCoordinates = [];
      let hasStopMarkers = false;
      let hasDriverMarkers = false;
      const todayStr = getEdmDate();
      const selectedDateStr = format(selectedDateRef.current, 'yyyy-MM-dd');
      const isViewingToday = todayStr === selectedDateStr;
      const shouldShowAllMarkersForBounds = selectedDriverIdRef.current === 'all' || showAllDriverMarkersRef.current;
      const specificDriverId = selectedDriverIdRef.current !== 'all' ? selectedDriverIdRef.current : null;

      if (isViewingToday) {
        if (specificDriverId) {
          // Admin/dispatcher viewing a specific driver — get that driver's location directly from AppUser,
          // regardless of duty status (bounds should reflect the selected driver, not the active user).
          const targetAppUser = appUsersRef.current?.find((au) => au?.user_id === specificDriverId);
          const targetLoc = targetAppUser?.current_latitude && targetAppUser?.current_longitude
            ? { latitude: targetAppUser.current_latitude, longitude: targetAppUser.current_longitude }
            : null;
          // Also check allDriverLocations and live GPS if the selected driver is the current user
          const liveLoc = specificDriverId === currentUser?.id && driverLocationRef.current?.latitude
            ? driverLocationRef.current
            : (allDriverLocationsRef.current || []).find((loc) =>
                loc?.driver_id === specificDriverId || loc?.driverId === specificDriverId
              ) || null;
          const bestLoc = liveLoc || targetLoc;
          if (bestLoc?.latitude && bestLoc?.longitude) { allCoordinates.push([bestLoc.latitude, bestLoc.longitude]); hasDriverMarkers = true; }
        } else {
          const selectedDriverLoc = getFabTargetDriverMapLocation({ selectedDriverId: selectedDriverIdRef.current, currentUser, isDriver, appUsers: appUsersRef.current, driverLocation: driverLocationRef.current, allDriverLocations: allDriverLocationsRef.current, isPrimaryDevice: isPrimaryDeviceRef.current });
          if (selectedDriverLoc?.latitude && selectedDriverLoc?.longitude) { allCoordinates.push([selectedDriverLoc.latitude, selectedDriverLoc.longitude]); hasDriverMarkers = true; }
        }
      }

      const shouldIncludeSharedLocations = !specificDriverId && (shouldShowAllMarkersForBounds || isDispatcher || isAdmin);
      const mapDriverLocationMarkers = window.__mapDriverLocationMarkers || [];

      if (isViewingToday && shouldIncludeSharedLocations) {
        if (isDispatcher && selectedDriverIdRef.current && selectedDriverIdRef.current !== 'all') {
          const assignedDriverAppUser = appUsersRef.current?.find((au) => au?.user_id === selectedDriverIdRef.current);
          if (assignedDriverAppUser?.driver_status === 'on_duty' && assignedDriverAppUser?.current_latitude && assignedDriverAppUser?.current_longitude) {
            allCoordinates.push([assignedDriverAppUser.current_latitude, assignedDriverAppUser.current_longitude]);
            hasDriverMarkers = true;
          }
        }

        const allLocationSources = [...(allDriverLocationsRef.current || []), ...mapDriverLocationMarkers];
        const uniqueLocations = new Map();
        allLocationSources.forEach((loc) => { if (loc?.driver_id && !uniqueLocations.has(loc.driver_id)) uniqueLocations.set(loc.driver_id, loc); });

        Array.from(uniqueLocations.values()).forEach((location) => {
          if (!location?.latitude || !location?.longitude || !location?.driver_id) return;
          const hasLiveLocation = driverLocationRef.current?.latitude && driverLocationRef.current?.longitude && location.driver_id === currentUser?.id;
          if (hasLiveLocation) return;
          const isCurrentUserLocation = isMobile && !isDispatcher && isPrimaryDeviceRef.current && location.driver_id === currentUser?.id;
          if (isCurrentUserLocation) return;
          if (isDispatcher && selectedDriverIdRef.current && selectedDriverIdRef.current !== 'all' && location.driver_id === selectedDriverIdRef.current) return;
          if (appUsersRef.current?.find((au) => au?.user_id === location.driver_id)?.driver_status !== 'on_duty') return;
          if (isDispatcher && !isAdmin) {
            const dispatcherStoreIds = new Set((currentUser?.store_ids || []).map((id) => String(id)));
            const _fin = ['completed', 'failed', 'cancelled', 'returned'];
            const hasActive = deliveriesRef.current.some((d) => d && d.delivery_date === selectedDateStr && d.driver_id === location.driver_id && dispatcherStoreIds.has(String(d.store_id)) && !_fin.includes(d.status));
            if (!hasActive) return;
          }
          allCoordinates.push([location.latitude, location.longitude]);
          hasDriverMarkers = true;
        });
      }

      let deliveriesToMap = [];
      // CRITICAL: specificDriverId always wins — never include other drivers' stops even
      // when showAllDriverMarkers is toggled on. That toggle controls marker visibility,
      // not whose route we're fitting bounds to.
      if (specificDriverId) {
        deliveriesToMap = deliveriesRef.current.filter((d) => d && d.delivery_date === selectedDateStr && d.driver_id === specificDriverId);
      } else if (shouldShowAllMarkersForBounds) {
        let allDateDeliveries = deliveriesRef.current.filter((d) => d && d.delivery_date === selectedDateStr);
        if (isDispatcher && !isAdmin) {
          const dispatcherStoreIds = new Set(currentUser?.store_ids || []);
          const driversWithStoreDeliveries = new Set(allDateDeliveries.filter((d) => d && dispatcherStoreIds.has(d.store_id)).map((d) => d.driver_id).filter(Boolean));
          deliveriesToMap = allDateDeliveries.filter((d) => d && driversWithStoreDeliveries.has(d.driver_id));
        } else {
          deliveriesToMap = allDateDeliveries;
        }
      } else {
        deliveriesToMap = deliveriesWithStopOrderRef.current.length > 0
          ? deliveriesWithStopOrderRef.current
          : deliveriesRef.current.filter((d) => d && d.delivery_date === selectedDateStr);
      }

      const stateHasStops = (deliveriesToMap || []).some((d) => {
        if (!d) return false;
        if (d.patient_id) return patientsRef.current?.some((p) => p?.id === d.patient_id && p.latitude && p.longitude);
        return storesRef.current?.some((s) => s?.id === d.store_id && s.latitude && s.longitude);
      });
      if (stateHasStops) hasStopMarkers = true;

      // PHASE 1 COORDINATE COLLECTION:
      // Always use deliveriesRef.current as the primary (authoritative) source for stop coordinates.
      // Window markers (__mapDeliveryMarkers/__mapPickupMarkers) are only populated from what
      // DeliveryMap has rendered — they may be incomplete at trigger time or missing un-rendered stops.
      // We use deliveriesRef to guarantee ALL stops for the selected driver/date are included in bounds.
      // Window markers are used as a secondary augmentation for any stops resolved via inter-store
      // location overrides (e.g. ISP/ISD pickups with different coords than the store record).
      (deliveriesToMap || []).forEach((d) => {
        if (!d) return;
        if (d.patient_id) { const p = patientsRef.current?.find((p) => p?.id === d.patient_id); if (p?.latitude && p?.longitude) { allCoordinates.push([p.latitude, p.longitude]); hasStopMarkers = true; } }
        else if (d.store_id) { const s = storesRef.current?.find((s) => s?.id === d.store_id); if (s?.latitude && s?.longitude) { allCoordinates.push([s.latitude, s.longitude]); hasStopMarkers = true; } }
      });
      // Augment with window markers for inter-store pickup coordinate overrides (different lat/lon than store record)
      const allWindowMarkers = [...(window.__mapDeliveryMarkers || []), ...(window.__mapPickupMarkers || [])];
      const windowMarkers = specificDriverId
        ? allWindowMarkers.filter((m) => m?.driver_id === specificDriverId)
        : allWindowMarkers;
      windowMarkers.forEach((marker) => {
        if (!marker?.latitude || !marker?.longitude) return;
        // Only add if this coord is meaningfully different from what we already have from deliveriesRef
        // (avoids duplication while still catching inter-store location overrides)
        const isDuplicate = allCoordinates.some(([lat, lon]) => Math.abs(lat - marker.latitude) < 0.0001 && Math.abs(lon - marker.longitude) < 0.0001);
        if (!isDuplicate) { allCoordinates.push([marker.latitude, marker.longitude]); hasStopMarkers = true; }
      });

      // Home markers are intentionally excluded from Phase 1 fitBounds.
      // Driver home locations (Fort Saskatchewan, Strathcona County, etc.) can be far outside
      // the delivery route and skew the bounds zoom level significantly.
      // Bounds are built from delivery stops + live driver locations only.

      const selectedCityId = globalFilters.getSelectedCityId();
      const currentCity = citiesRef.current?.find((c) => c && c.id === selectedCityId);

      // Phase 1 always uses isImmersiveHidden=false (UI is visible, cards are shown)
      const p1Padding = getMapPadding(false);

      if (!hasStopMarkers && !hasDriverMarkers) {
        let userRefLat = null, userRefLon = null;
        if (!isDriverOffDuty(appUsersRef.current, currentUser?.id, currentUser?.driver_status) && driverLocationRef.current?.latitude && driverLocationRef.current?.longitude) { userRefLat = driverLocationRef.current.latitude; userRefLon = driverLocationRef.current.longitude; }
        else if (!isDriverOffDuty(appUsersRef.current, currentUser?.id, currentUser?.driver_status) && currentUser?.current_latitude && currentUser?.current_longitude) { userRefLat = currentUser.current_latitude; userRefLon = currentUser.current_longitude; }
        else if (currentUser?.home_latitude && currentUser?.home_longitude) { userRefLat = currentUser.home_latitude; userRefLon = currentUser.home_longitude; }

        const userCityIds = currentUser?.city_ids || (currentUser?.city_id ? [currentUser.city_id] : []);
        const assignedCities = citiesRef.current?.filter((c) => c && userCityIds.includes(c.id)) || [];
        let closestCity = null;
        if (userRefLat && userRefLon && assignedCities.length > 0) {
          const citiesWithDistance = assignedCities.filter((c) => c?.latitude && c?.longitude).map((city) => ({ city, distance: calculateDistance(userRefLat, userRefLon, city.latitude, city.longitude) })).sort((a, b) => a.distance - b.distance);
          if (citiesWithDistance.length > 0) closestCity = citiesWithDistance[0].city;
        } else if (assignedCities.length > 0) {
          closestCity = assignedCities[0];
        } else if (currentCity?.latitude && currentCity?.longitude) {
          closestCity = currentCity;
        }
        if (closestCity?.latitude && closestCity?.longitude) {
          const targetRadiusKm = 16, latDegPerKm = 1 / 111.32, lonDegPerKm = 1 / (111.32 * Math.cos(closestCity.latitude * Math.PI / 180));
          const latOffset = targetRadiusKm * latDegPerKm, lonOffset = targetRadiusKm * lonDegPerKm;
          const bounds = [[closestCity.latitude - latOffset, closestCity.longitude - lonOffset], [closestCity.latitude + latOffset, closestCity.longitude + lonOffset]];
          setShouldFitBounds({ bounds, options: { ...p1Padding, maxZoom: 17.5, animate: true } });
          setMapCenter(null); setMapZoom(null);
        }
      } else if (allCoordinates.length > 0) {
        // Phase 1: flat maxZoom of 17.5 — let Leaflet fitBounds determine the actual zoom
        // based on the coordinate span and available canvas (after padding). Never force a
        // minimum zoom level; Leaflet picks the correct zoom to fit all markers.
        // Detect and log outlier coordinates (anything outside Edmonton metro ~53±1.5, -113.5±1.5)
        const edmontonLat = 53.5461, edmontonLon = -113.4938;
        const outliers = allCoordinates.filter(([lat, lon]) => Math.abs(lat - edmontonLat) > 1.5 || Math.abs(lon - edmontonLon) > 1.5);
        const normal = allCoordinates.filter(([lat, lon]) => Math.abs(lat - edmontonLat) <= 1.5 && Math.abs(lon - edmontonLon) <= 1.5);
        if (outliers.length > 0) {
          console.warn(`🗺️ [mapPos P1] ⚠️ OUTLIER COORDS (${outliers.length}):`, JSON.stringify(outliers));
          console.warn(`🗺️ [mapPos P1] Window markers raw:`, { delivery: (window.__mapDeliveryMarkers||[]).length, pickup: (window.__mapPickupMarkers||[]).length, home: (window.__mapHomeMarkers||[]).length, driver: (window.__mapDriverLocationMarkers||[]).length });
        }
        console.log(`🗺️ [mapPos P1] fitBounds total=${allCoordinates.length} outliers=${outliers.length} normal=${normal.length}`);
        // Filter outliers — only include coordinates within Edmonton metro area for Phase 1 bounds
        const safeBounds = normal.length >= 2 ? normal : allCoordinates;
        setShouldFitBounds({ bounds: safeBounds, options: { ...p1Padding, maxZoom: 17.5, animate: true } });
        setMapCenter(null); setMapZoom(null);
      } else {
        console.warn(`🗺️ [mapPos P1] NO COORDS — hasStop=${hasStopMarkers} hasDriver=${hasDriverMarkers} deliveries=${deliveriesToMap?.length} allCoords=${allCoordinates.length}`);
      }
      break;
    }

    case 2: {
      // Phase 2 respects immersive mode padding — UI may be hidden
      const p2Padding = getMapPadding(immersiveHidden);

      let _phase2Handled = false;
      if ((isDispatcher && !isAdmin) || (isAdmin && selectedDriverIdRef.current === 'all')) {
        const dispatcherStoreIds2 = new Set((currentUser?.store_ids || []).map((id) => String(id)));
        const selectedDateStr2 = format(selectedDateRef.current, 'yyyy-MM-dd');
        const allDateDeliveries2 = deliveriesRef.current.filter((d) => d && d.delivery_date === selectedDateStr2);
        const finishedStatuses2 = ['completed', 'failed', 'cancelled', 'returned'];
        const activeDriverIds2 = new Set(
          allDateDeliveries2
            .filter((d) => d && dispatcherStoreIds2.has(String(d.store_id)) && !finishedStatuses2.includes(d.status) && d.status !== 'pending')
            .map((d) => d.driver_id).filter(Boolean)
        );
        const phase2DispatcherCoords = [];
        activeDriverIds2.forEach((driverId) => {
          const driverAppUser = appUsersRef.current?.find((au) => au?.user_id === driverId);
          if (driverAppUser?.driver_status === 'on_duty' && driverAppUser?.current_latitude && driverAppUser?.current_longitude) {
            phase2DispatcherCoords.push([driverAppUser.current_latitude, driverAppUser.current_longitude]);
          }
          const driverNextStop = allDateDeliveries2.find((d) => d && d.driver_id === driverId && d.isNextDelivery);
          if (driverNextStop) {
            if (driverNextStop.patient_id) { const patient = patientsRef.current.find((p) => p?.id === driverNextStop.patient_id); if (patient?.latitude && patient?.longitude) phase2DispatcherCoords.push([patient.latitude, patient.longitude]); }
            else if (isInterStoreDelivery(driverNextStop.delivery_id)) { const isl = getInterStoreLocationSync(driverNextStop.delivery_id); if (isl?.store_latitude && isl?.store_longitude) phase2DispatcherCoords.push([isl.store_latitude, isl.store_longitude]); else { const store = storesRef.current.find((s) => s?.id === driverNextStop.store_id); if (store?.latitude && store?.longitude) phase2DispatcherCoords.push([store.latitude, store.longitude]); } }
            else if (driverNextStop.store_id) { const store = storesRef.current.find((s) => s?.id === driverNextStop.store_id); if (store?.latitude && store?.longitude) phase2DispatcherCoords.push([store.latitude, store.longitude]); }
          }
        });
        if (phase2DispatcherCoords.length > 0) {
          setShouldFitBounds({ bounds: phase2DispatcherCoords, options: { ...p2Padding, maxZoom: 17.5, animate: true, duration: 0.9, easeLinearity: 0.15 } });
          setMapCenter(null); setMapZoom(null);
        }
        _phase2Handled = true;
      }

      if (!_phase2Handled) {
        const fabTargetDriverLocation = getFabTargetDriverMapLocation({
          selectedDriverId: selectedDriverIdRef.current, currentUser, isDriver,
          appUsers: appUsersRef.current, driverLocation: driverLocationRef.current,
          allDriverLocations: allDriverLocationsRef.current, isPrimaryDevice: isPrimaryDeviceRef.current,
        });
        if (fabTargetDriverLocation?.latitude && fabTargetDriverLocation?.longitude) {
          const _p2TgtId2 = selectedDriverIdRef.current !== 'all' ? selectedDriverIdRef.current : (isDriver ? currentUser?.id : null);
          const _ns = _p2TgtId2 ? deliveriesRef.current.find((d) => d && d.driver_id === _p2TgtId2 && d.isNextDelivery === true && d.status !== 'pending') : null;
          const _nc = _ns?.patient_id
            ? (() => { const p = patientsRef.current.find((x) => x && x.id === _ns.patient_id); return p?.latitude && p?.longitude ? { lat: p.latitude, lon: p.longitude } : null; })()
            : _ns && isInterStoreDelivery(_ns.delivery_id)
              ? (() => { const isl = getInterStoreLocationSync(_ns.delivery_id); if (isl?.store_latitude && isl?.store_longitude) return { lat: isl.store_latitude, lon: isl.store_longitude }; const s = storesRef.current.find((x) => x && x.id === _ns.store_id); return s?.latitude && s?.longitude ? { lat: s.latitude, lon: s.longitude } : null; })()
              : _ns?.store_id
                ? (() => { const s = storesRef.current.find((x) => x && x.id === _ns.store_id); return s?.latitude && s?.longitude ? { lat: s.latitude, lon: s.longitude } : null; })()
                : (selectedDriverId === currentUser?.id || !_p2TgtId2 ? nextStopCoordinatesRef.current : null);
          const bounds = [
            [fabTargetDriverLocation.latitude, fabTargetDriverLocation.longitude],
            ...(_nc?.lat && _nc?.lon ? [[_nc.lat, _nc.lon]] : []),
          ];
          setShouldFitBounds({ bounds, options: { ...p2Padding, maxZoom: 17.5, animate: true, duration: 0.9, easeLinearity: 0.15 } });
          setMapCenter(null); setMapZoom(null);
        }
      }
      break;
    }

    case 3: {
      const allCoordinatesPhase3 = [];
      const todayStrPhase3 = getEdmDate();
      const selectedDateStrPhase3 = format(selectedDateRef.current, 'yyyy-MM-dd');
      const isViewingTodayPhase3 = todayStrPhase3 === selectedDateStrPhase3;
      const isShowAllOrAllDriversMode = showAllDriverMarkersRef.current || selectedDriverIdRef.current === 'all';
      // CRITICAL: 'returned' must be treated as finished — do NOT include returned stops in phase 3
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

      if (isShowAllOrAllDriversMode) {
        let allDateDeliveries = deliveriesRef.current.filter((d) => d && d.delivery_date === selectedDateStrPhase3);
        if (isDispatcher && !isAdmin && currentUser?.store_ids) {
          const dispatcherStoreIds = new Set(currentUser.store_ids);
          const driversWithStoreDeliveries = new Set(allDateDeliveries.filter((d) => d && dispatcherStoreIds.has(d.store_id)).map((d) => d.driver_id).filter(Boolean));
          allDateDeliveries = allDateDeliveries.filter((d) => d && driversWithStoreDeliveries.has(d.driver_id));
        }
        const incompleteAndPendingAllDrivers = allDateDeliveries.filter((d) => d && !finishedStatuses.includes(d.status));
        const driversWithIncompleteOrPendingStops = new Set(incompleteAndPendingAllDrivers.map((d) => d.driver_id).filter(Boolean));
        incompleteAndPendingAllDrivers.forEach((delivery) => {
          if (delivery.patient_id) { const patient = patientsRef.current.find((p) => p?.id === delivery.patient_id); if (patient?.latitude && patient?.longitude) allCoordinatesPhase3.push([patient.latitude, patient.longitude]); }
          else if (delivery.store_id) { const store = storesRef.current.find((s) => s?.id === delivery.store_id); if (store?.latitude && store?.longitude) allCoordinatesPhase3.push([store.latitude, store.longitude]); }
        });
        if (isViewingTodayPhase3) {
          driversWithIncompleteOrPendingStops.forEach((driverId) => {
            const driverAppUser = appUsersRef.current?.find((au) => au?.user_id === driverId);
            if (driverAppUser?.driver_status === 'on_duty' && driverAppUser?.current_latitude && driverAppUser?.current_longitude) allCoordinatesPhase3.push([driverAppUser.current_latitude, driverAppUser.current_longitude]);
          });
        }
      } else {
        const targetDriverId = selectedDriverIdRef.current !== 'all' ? selectedDriverIdRef.current : null;
        if (!targetDriverId) break;
        // Use full deliveriesRef (all stops) so pending stops not yet in stop-order are included.
        // deliveriesWithStopOrderRef only holds the routed subset; pending un-routed stops would be
        // missing from Phase 3 bounds if we used it here.
        const allDriverDeliveries = deliveriesRef.current.filter(
          (d) => d && d.driver_id === targetDriverId && d.delivery_date === selectedDateStrPhase3
        );
        allCoordinatesPhase3.push(...collectPhase3SingleDriverCoordinates({
          deliveriesWithStopOrder: allDriverDeliveries,
          selectedDateStr: selectedDateStrPhase3,
          patients: patientsRef.current,
          stores: storesRef.current,
          isViewingTodayPhase3,
          getFabTargetDriverMapLocation,
          targetDriverId, currentUser, isDriver,
          appUsers: appUsersRef.current,
          driverLocation: driverLocationRef.current,
          allDriverLocations: allDriverLocationsRef.current,
          isPrimaryDevice: isPrimaryDeviceRef.current,
        }));
      }

      if (allCoordinatesPhase3.length > 0) {
        const spanKm = getBoundsSpanKm(allCoordinatesPhase3);
        const phase3MaxZoom = getPhaseBoundsMaxZoom(spanKm, 12.0);
        // Phase 3: use immersive padding if applicable
        setShouldFitBounds({ bounds: allCoordinatesPhase3, options: { ...getMapPadding(immersiveHidden), maxZoom: phase3MaxZoom, animate: true } });
        setMapCenter(null); setMapZoom(null);
      }
      break;
    }

    default:
      break;
  }
}