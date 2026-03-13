import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline, Pane } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { getStoreColor } from '../utils/colorGenerator';
import { MapPin, Phone, Clock, Package, Truck, StickyNote, UserRoundSearch, Car, Home, Navigation, Activity, User, CheckCircle2, XCircle } from 'lucide-react';
import { userHasRole, isAppOwner } from '../utils/userRoles';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { format } from 'date-fns';
import { isMobileDevice } from '../utils/deviceUtils';
import MapCrosshair from './MapCrosshair';
import DeliveryPopup from './DeliveryPopup';
import { useRouteRecalcSignal } from './useRouteRecalcSignal';
import { base44 } from '@/api/base44Client';
import { formatPhoneNumber } from '../utils/phoneFormatter';
import DriverLocationMarkers from './DriverLocationMarkers';
import MapController from './MapController';
import HereType1Polylines from './HereType1Polylines';
import HereType2Polylines from './HereType2Polylines';
import CompletedBreadcrumbPolylines from './CompletedBreadcrumbPolylines';
import PickupMarkers from './PickupMarkers';
import DeliveryMarkers from './DeliveryMarkers';
import HomeMarkers from './HomeMarkers';
import MapBreadcrumbs from './MapBreadcrumbs';
import { createLiveLocationDot } from './MapIcons';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png'
});

const DRIVER_COLORS = ['', '#1E90FF', '#8A2BE2', '#00CED1', '#FF69B4', '#4B0082', '#A0522D'];
const ZOOM_LEVELS = {
  HIDE_ROUTES: 8,
  SIMPLIFY_ROUTES: 12,
  HIDE_NUMBERS: 11,
  HIDE_CIRCLES: 11,
  FULL_DETAIL: 13
};
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];

export const getDriverColor = (driver) => {
  if (!driver || typeof driver !== 'object' || !driver.id) {
    return '#607D8B';
  }

  const numFixedColors = DRIVER_COLORS.length - 1;
  let effectiveIndex;

  if (typeof driver.sort_order === 'number' && driver.sort_order > 0 && driver.sort_order <= numFixedColors) {
    effectiveIndex = driver.sort_order;
  } else {
    let hash = 0;
    const idString = driver.id.toString();
    for (let i = 0; i < idString.length; i++) {
      hash = idString.charCodeAt(i) + ((hash << 5) - hash);
    }
    effectiveIndex = (Math.abs(hash) % numFixedColors) + 1;
  }

  if (effectiveIndex >= 1 && effectiveIndex <= numFixedColors && DRIVER_COLORS[effectiveIndex]) {
    return DRIVER_COLORS[effectiveIndex];
  }

  const idHash = Math.abs(driver.id.split('').reduce((acc, char) => (acc * 31) + char.charCodeAt(0), 0));
  const safeHueMin = 190;
  const safeHueRange = 140;
  const hue = safeHueMin + (idHash % safeHueRange);
  return `hsl(${hue}, 70%, 50%)`;
};

const getEdmDate = () => {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Edmonton',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  return `${p.find(x => x.type === 'year').value}-${p.find(x => x.type === 'month').value}-${p.find(x => x.type === 'day').value}`;
};

const isFirstTimeDelivery = (d) => d.first_delivery || false;

export default function DeliveryMap({
  deliveries = [],
  allDeliveriesForDate = [],
  selectedDriverId = null,
  selectedDate = null,
  patients = [],
  stores = [],
  users = [],
  currentUser,
  driverLocations = [],
  showOtherDriverDeliveries = false,
  currentDriverLocation = null,
  deliveriesForLocationFilter = [],
  center = [53.5461, -113.4938],
  zoom = 12,
  shouldFitBounds = null,
  onBoundsFitted = null,
  onMarkerClick,
  mapMode = 'auto-follow',
  onMapModeChange,
  autoFitBounds = true,
  showRoutes = true,
  showLegend = false,
  areCardsVisible = false,
  onLegendInteraction = () => {},
  onMapInteraction = () => {},
  onDoubleTap = () => {},
  retractClustersRef,
  stopCardsHeight = 75,
  currentToNextPolyline = null,
  showBreadcrumbs = false,
  breadcrumbsData = { historical: [], current: [] },
  statsCardPositioning = '',
  isStatsCardExpanded = false,
  statsCardRect = null,
  highlightedDeliveryId = null,
  areStopCardsVisible = false,
  onDriverRoutesCalculated = () => {},
  onMapReady = () => {},
  mapViewPhase = 1,
  isMapViewLocked = false
}) {
  const mapRef = useRef(null);
  const [map, setMap] = useState(null);
  const [hoveredMarkerId, setHoveredMarkerId] = useState(null);
  const [fadedMarkerHighlights, setFadedMarkerHighlights] = useState(new Set());
  const markerRefs = useRef({});
  const [hasInitialFit, setHasInitialFit] = useState(false);
  const [currentZoom, setCurrentZoom] = useState(zoom);
  const isMobile = useMemo(() => isMobileDevice(), []);
  const [highlightedRouteId, setHighlightedRouteId] = useState(null);
  const [fannedLocationKey, setFannedLocationKey] = useState(null);
  const legendRef = useRef(null);
  const [legendLeft, setLegendLeft] = useState(null);
  const [showZoomOverlay, setShowZoomOverlay] = useState(false);
  const zoomOverlayTimeoutRef = useRef(null);
  const popupTimeoutRef = useRef(null);
  const [mapCenter, setMapCenter] = useState(center);
  const [visibleBounds, setVisibleBounds] = useState(null);
  const [realtimeAppUsers, setRealtimeAppUsers] = useState(users);
  const { routeLocationSnapshot, routeRecalcVersion } = useRouteRecalcSignal({
    currentDriverLocation,
    realtimeAppUsers,
    currentUserId: currentUser?.id
  });

  useEffect(() => {
    if (retractClustersRef) {
      retractClustersRef.current = () => setFannedLocationKey(null);
    }
  }, [retractClustersRef]);

  const safeDeliveries = Array.isArray(deliveries) ? deliveries : [];
  const safeAllDeliveriesForDate = Array.isArray(allDeliveriesForDate) ? allDeliveriesForDate : [];
  const safePatients = Array.isArray(patients) ? patients : [];
  const safeStores = Array.isArray(stores) ? stores : [];
  const safeDriverLocations = Array.isArray(driverLocations) ? driverLocations : [];

  const prevSafeUsersRef = useRef([]);
  const safeUsers = (() => {
    if (Array.isArray(realtimeAppUsers) && realtimeAppUsers.length > 0) {
      prevSafeUsersRef.current = realtimeAppUsers;
      return realtimeAppUsers;
    }
    return prevSafeUsersRef.current;
  })();

  useEffect(() => {
    (async () => {
      try {
        const { offlineDB } = await import('./../../components/utils/offlineDatabase');
        const offlineAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
        if (offlineAppUsers?.length > 0) setRealtimeAppUsers(offlineAppUsers);
      } catch (e) {}
    })();
  }, []);

  useEffect(() => {
    if (users?.length > 0) setRealtimeAppUsers(users);
  }, [users]);

  const [routeRenderKey, setRouteRenderKey] = useState(0);
  const [polylineRenderKey, setPolylineRenderKey] = useState(0);

  useEffect(() => {
    if (!map) return;
    const handleResize = () => {
      window.dispatchEvent(new CustomEvent('screenResized'));
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, [map]);

  useEffect(() => {
    if (routeRecalcVersion === 0) return;
    console.log('🔵 [Polyline Trigger] Route recalculation signal changed');
    setPolylineRenderKey((prev) => prev + 1);
  }, [routeRecalcVersion]);

  const prevDriverRoutesRef = useRef([]);

  useEffect(() => {
    const handleDriverLocationUpdate = (event) => {
      const { appUsers, singleUpdate, mergeMode } = event.detail;

      const mergeUsers = (prev, updates) => {
        if (!prev?.length) return updates;
        const map = new Map(updates.map(u => [u?.id || u?.user_id, u]));
        const merged = prev.map(u => {
          const k = u?.id || u?.user_id;
          return k && map.has(k) ? map.get(k) : u;
        });
        updates.forEach(u => {
          const k = u?.id || u?.user_id;
          if (k && !prev.some(p => (p?.id || p?.user_id) === k)) merged.push(u);
        });
        return merged;
      };

      if ((mergeMode === 'merge' || singleUpdate || (appUsers?.length > 0)) && appUsers?.length > 0) {
        setRealtimeAppUsers(prev => {
          if (singleUpdate && appUsers.length === 1) {
            const u = appUsers[0];
            return prev?.length ? prev.map(p => (p?.id === u?.id || p?.id === u?.user_id) ? { ...p, ...u } : p) : prev;
          }
          return mergeUsers(prev, appUsers);
        });
        setRouteRenderKey((prev) => prev + 1);
      }
    };

    const handleDeliveriesUpdate = () => {
      prevDriverRoutesRef.current = [];
      setRouteRenderKey((prev) => prev + 1);
      setPolylineRenderKey((prev) => prev + 1);
      setFannedLocationKey(null);
    };

    window.addEventListener('driverLocationsUpdated', handleDriverLocationUpdate);
    window.addEventListener('deliveriesUpdated', handleDeliveriesUpdate);
    window.addEventListener('routeOptimizationComplete', handleDeliveriesUpdate);
    return () => {
      window.removeEventListener('driverLocationsUpdated', handleDriverLocationUpdate);
      window.removeEventListener('deliveriesUpdated', handleDeliveriesUpdate);
      window.removeEventListener('routeOptimizationComplete', handleDeliveriesUpdate);
    };
  }, []);

  const isAllDriversMode = useMemo(() => {
    if (!selectedDriverId || selectedDriverId === 'all') return true;
    if (!safeDeliveries || safeDeliveries.length === 0) return false;
    const uniqueDriverIds = new Set(safeDeliveries.map((delivery) => delivery?.driver_id).filter(Boolean));
    return uniqueDriverIds.size > 1;
  }, [selectedDriverId, safeDeliveries.length]);

  const isSingleDriverMode = useMemo(() => !isAllDriversMode, [isAllDriversMode]);

  const isDriverViewingSelf = useMemo(() => {
    if (!currentUser || !userHasRole(currentUser, 'driver')) return false;
    if (!selectedDriverId || selectedDriverId === 'all') return false;
    return selectedDriverId === currentUser.id;
  }, [currentUser, selectedDriverId]);

  const isDriverViewingSelfToday = useMemo(() => {
    if (!isDriverViewingSelf) return false;
    const today = getEdmDate();
    return selectedDate === today;
  }, [isDriverViewingSelf, selectedDate]);

  const [otherDriverDeliveries, setOtherDriverDeliveries] = useState([]);

  useEffect(() => {
    if (!selectedDate || safeDeliveries.length === 0) return;
    (async () => {
      try {
        const uniqueDriverIds = new Set([...safeDeliveries, ...otherDriverDeliveries].filter(d => d?.driver_id).map(d => d.driver_id));
        if (!uniqueDriverIds.size) return;
        const { offlineDB } = await import('./../../components/utils/offlineDatabase');
        const allAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
        if (!allAppUsers?.length) return;
        setRealtimeAppUsers(prev => {
          const existingMap = new Map(prev.map(u => [u.id, u]));
          allAppUsers.forEach(au => {
            if (uniqueDriverIds.has(au.id) && !existingMap.has(au.id)) existingMap.set(au.id, au);
          });
          return Array.from(existingMap.values());
        });
      } catch (e) {}
    })();
  }, [selectedDate, safeDeliveries.length, otherDriverDeliveries.length]);

  useEffect(() => {
    const handleDeliveriesImported = (event) => {
      const { deliveries: importedDeliveries } = event.detail || {};
      if (importedDeliveries && importedDeliveries.length > 0 && showOtherDriverDeliveries && currentUser) {
        const others = importedDeliveries.filter(d => d && d.driver_id && d.driver_id !== currentUser.id);
        setOtherDriverDeliveries(others);
      }
    };

    const handleDeliveriesUpdatedForMarkers = async (event) => {
      const { triggeredBy, allDrivers, source, fromOtherDriver } = event.detail || {};
      const isAllDriversUpdate = allDrivers || fromOtherDriver || triggeredBy === 'pullToSyncComplete' || triggeredBy === 'periodicRefresh' || triggeredBy === 'manualRefresh' || source === 'realtime_sync' || source === 'route_importer';
      if (!isAllDriversUpdate) return;
      if (!showOtherDriverDeliveries && selectedDriverId !== 'all') return;
      if (!selectedDate) return;

      try {
        const { offlineDB } = await import('./../../components/utils/offlineDatabase');
        let allDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDate);
        if (allDeliveries && allDeliveries.length > 0) {
          const others = allDeliveries.filter(d => d && d.driver_id && d.driver_id !== selectedDriverId);
          setOtherDriverDeliveries([...others]);
        }
      } catch (error) {
        console.error('❌ [DeliveryMap] Failed to refresh markers:', error);
      }
    };

    window.addEventListener('deliveriesImported', handleDeliveriesImported);
    window.addEventListener('deliveriesUpdated', handleDeliveriesUpdatedForMarkers);
    return () => {
      window.removeEventListener('deliveriesImported', handleDeliveriesImported);
      window.removeEventListener('deliveriesUpdated', handleDeliveriesUpdatedForMarkers);
    };
  }, [showOtherDriverDeliveries, currentUser?.id, selectedDriverId, selectedDate]);

  useEffect(() => {
    const fetchOtherDrivers = async () => {
      if (!selectedDate || !showOtherDriverDeliveries || !selectedDriverId || selectedDriverId === 'all') {
        if (!showOtherDriverDeliveries && otherDriverDeliveries.length > 0) {
          setOtherDriverDeliveries([]);
        }
        return;
      }

      try {
        const { offlineDB } = await import('./../../components/utils/offlineDatabase');
        let allDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDate);
        if (!allDeliveries || allDeliveries.length === 0) {
          const { base44 } = await import('@/api/base44Client');
          allDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDate });
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allDeliveries);
        }
        const others = allDeliveries.filter(d => d && d.driver_id && d.driver_id !== selectedDriverId);
        setOtherDriverDeliveries([...others]);
      } catch (error) {
        console.error('❌ [DeliveryMap] Failed to load other drivers:', error);
      }
    };

    fetchOtherDrivers();
  }, [selectedDriverId, selectedDate, showOtherDriverDeliveries]);

  const { pickups, patientDeliveries } = useMemo(() => {
    let deliveriesToShow = safeDeliveries;
    if (showOtherDriverDeliveries && otherDriverDeliveries.length > 0) {
      const deliveriesById = new Map();
      safeDeliveries.forEach(d => { if (d && d.id) deliveriesById.set(d.id, d); });
      otherDriverDeliveries.forEach(d => { if (d && d.id && !deliveriesById.has(d.id)) deliveriesById.set(d.id, d); });
      deliveriesToShow = Array.from(deliveriesById.values());
    }
    return {
      pickups: deliveriesToShow.filter((d) => d && !d.patient_id && d.store_id),
      patientDeliveries: deliveriesToShow.filter((d) => d && d.patient_id)
    };
  }, [safeDeliveries, otherDriverDeliveries, showOtherDriverDeliveries]);

  const frozenDriverOrderRef = useRef(null);
  if (!frozenDriverOrderRef.current) {
    const drivers = safeUsers.filter(u => u && typeof u === 'object' && u.id);
    drivers.sort((a, b) => {
      const sortA = a.sort_order ?? Infinity;
      const sortB = b.sort_order ?? Infinity;
      if (sortA !== sortB) return sortA - sortB;
      const nameA = (a.user_name || a.full_name || '').toLowerCase();
      const nameB = (b.user_name || b.full_name || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });
    frozenDriverOrderRef.current = drivers;
  }

  const stableSortedDrivers = frozenDriverOrderRef.current || [];
  const driverLookupMap = useMemo(() => {
    const map = new Map();
    stableSortedDrivers.forEach(u => map.set(u.id, u));
    return map;
  }, [stableSortedDrivers]);

  const { deliveryMarkers, groupedDeliveryMarkers, pickupMarkers, groupedPickupMarkers, hasIncompleteStops } = useMemo(() => {
    let allDeliveriesForIncompleteCheck = safeDeliveries;
    if (showOtherDriverDeliveries && otherDriverDeliveries.length > 0) {
      allDeliveriesForIncompleteCheck = [...safeDeliveries, ...otherDriverDeliveries];
    }
    const hasIncompleteStops = allDeliveriesForIncompleteCheck.some(d => d && !FINISHED_STATUSES.includes(d.status));

    const deliveryMarkersRaw = patientDeliveries.map((delivery) => {
      if (!delivery) return null;
      const patient = safePatients.find((p) => p && p.id === delivery.patient_id);
      if (!patient?.latitude || !patient?.longitude) return null;
      const driver = safeUsers.find((u) => u && typeof u === 'object' && u.id === delivery.driver_id);
      const store = safeStores.find((s) => s && s.id === delivery.store_id);
      const enrichedDriver = driverLookupMap.get(delivery.driver_id) || driver || (delivery.driver_name ? { id: delivery.driver_id, user_name: delivery.driver_name, full_name: delivery.driver_name } : null);
      const isFirstTime = isFirstTimeDelivery(delivery);
      const patientNameLower = (patient?.full_name || delivery.patient_name || '').toLowerCase();
      const isReturn = patientNameLower.includes('return') || patientNameLower.includes('(rtn)');
      const isCurrentUserDispatcher = userHasRole(currentUser, 'dispatcher');
      const isStopInDispatcherStore = isCurrentUserDispatcher && currentUser.store_ids && store && currentUser.store_ids.includes(store.id);
      const isOtherDriver = selectedDriverId && selectedDriverId !== 'all' && delivery.driver_id !== selectedDriverId;
      const useSimpleCircle = (isCurrentUserDispatcher && !isStopInDispatcherStore) || (showOtherDriverDeliveries && isOtherDriver);
      const isNextInLine = delivery.isNextDelivery || false;

      let hasNoPickup = false;
      if (delivery.patient_id) {
        if (!delivery.puid || delivery.puid.trim() === '') {
          hasNoPickup = true;
        } else {
          const pickupExistsInRoute = safeDeliveries.some(d => d && !d.patient_id && d.stop_id === delivery.puid && d.driver_id === delivery.driver_id);
          const pickupExistsInAllData = safeAllDeliveriesForDate.some(d => d && !d.patient_id && d.stop_id === delivery.puid && d.driver_id === delivery.driver_id);
          hasNoPickup = !pickupExistsInRoute && !pickupExistsInAllData;
        }
      }

      let pinColor;
      if (isStopInDispatcherStore) pinColor = store ? getStoreColor(store) : '#6B7280';
      else if (isAllDriversMode) pinColor = enrichedDriver && typeof enrichedDriver === 'object' ? getDriverColor(enrichedDriver) : '#607D8B';
      else if (hasNoPickup && !isOtherDriver) pinColor = '#FBBF24';
      else if (isOtherDriver) pinColor = store ? getStoreColor(store) : '#6B7280';
      else pinColor = store ? getStoreColor(store) : '#6B7280';

      return {
        ...delivery,
        latitude: patient.latitude,
        longitude: patient.longitude,
        patient,
        driver: enrichedDriver,
        store,
        pinColor,
        number: delivery.display_stop_order || delivery.stop_order || 0,
        isFirstTime,
        isNextInLine,
        markerType: 'delivery',
        useSimpleCircle,
        isOtherDriver,
        isReturn
      };
    }).filter(Boolean);

    const pickupMarkersRaw = pickups.map((pickup) => {
      if (!pickup) return null;
      const store = safeStores.find((s) => s && s.id === pickup.store_id);
      if (!store?.latitude || !store?.longitude) return null;
      const driver = safeUsers.find((u) => u && typeof u === 'object' && u.id === pickup.driver_id);
      const enrichedDriver = driverLookupMap.get(pickup.driver_id) || driver || (pickup.driver_name ? { id: pickup.driver_id, user_name: pickup.driver_name, full_name: pickup.driver_name } : null);
      const isOtherDriver = selectedDriverId && selectedDriverId !== 'all' && pickup.driver_id !== selectedDriverId;
      return {
        ...pickup,
        latitude: store.latitude,
        longitude: store.longitude,
        store,
        pinColor: getStoreColor(store),
        driver: enrichedDriver,
        number: pickup.display_stop_order || pickup.stop_order || 0,
        markerType: 'pickup',
        useSimpleCircle: false,
        isOtherDriver
      };
    }).filter(Boolean);

    const allMarkers = [...deliveryMarkersRaw, ...pickupMarkersRaw];
    const unifiedGrouped = new Map();
    allMarkers.forEach((marker) => {
      if (!marker || typeof marker.latitude !== 'number' || typeof marker.longitude !== 'number') return;
      const key = `${marker.latitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${marker.longitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
      if (!unifiedGrouped.has(key)) unifiedGrouped.set(key, { deliveries: [], pickups: [] });
      const group = unifiedGrouped.get(key);
      if (marker.markerType === 'delivery') group.deliveries.push(marker); else group.pickups.push(marker);
    });

    const locationCounts = new Map();
    unifiedGrouped.forEach((group, key) => locationCounts.set(key, group.deliveries.length + group.pickups.length));

    const deliveryMarkersWithCounts = deliveryMarkersRaw.map((marker) => {
      if (!marker || typeof marker.latitude !== 'number' || typeof marker.longitude !== 'number') return null;
      const key = `${marker.latitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${marker.longitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
      return { ...marker, duplicateCount: locationCounts.get(key) || 1 };
    }).filter(Boolean);

    const pickupMarkersWithCounts = pickupMarkersRaw.map((marker) => {
      if (!marker || typeof marker.latitude !== 'number' || typeof marker.longitude !== 'number') return null;
      const key = `${marker.latitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${marker.longitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
      return { ...marker, duplicateCount: locationCounts.get(key) || 1 };
    }).filter(Boolean);

    const groupedDeliveries = new Map();
    deliveryMarkersWithCounts.forEach((marker) => {
      const key = `${marker.latitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${marker.longitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
      if (!groupedDeliveries.has(key)) groupedDeliveries.set(key, []);
      groupedDeliveries.get(key).push(marker);
    });

    const groupedPickups = new Map();
    pickupMarkersWithCounts.forEach((marker) => {
      const key = `${marker.latitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${marker.longitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
      if (!groupedPickups.has(key)) groupedPickups.set(key, []);
      groupedPickups.get(key).push(marker);
    });

    return {
      deliveryMarkers: deliveryMarkersWithCounts,
      groupedDeliveryMarkers: groupedDeliveries,
      pickupMarkers: pickupMarkersWithCounts,
      groupedPickupMarkers: groupedPickups,
      hasIncompleteStops
    };
  }, [
    patientDeliveries.map(d => `${d?.id}:${d?.status}:${d?.isNextDelivery}:${d?.stop_order}`).join(','),
    pickups.map(p => `${p?.id}:${p?.status}:${p?.isNextDelivery}:${p?.stop_order}`).join(','),
    safeUsers.map(u => u?.id).join(','),
    safeStores.map(s => s?.id).join(','),
    safePatients.map(p => p?.id).join(','),
    isAllDriversMode,
    currentUser?.id,
    isDriverViewingSelf,
    showOtherDriverDeliveries,
    currentZoom
  ]);

  const calculateFannedPositionWrapperWrapper = useCallback((originalLat, originalLng, markerIndex, totalMarkers) => {
    const baseRadius = 0.0008;
    const dynamicRadius = 0.0008;
    const radius = baseRadius + (18 - currentZoom) * dynamicRadius;
    let arcWidth;
    if (totalMarkers <= 2) arcWidth = 90;
    else if (totalMarkers === 3) arcWidth = 120;
    else if (totalMarkers === 4) arcWidth = 140;
    else arcWidth = Math.min(180, 140 + (totalMarkers - 4) * 10);
    const arcWidthRad = (arcWidth * Math.PI) / 180;
    const startAngle = (Math.PI / 2) - (arcWidthRad / 2);
    const endAngle = (Math.PI / 2) + (arcWidthRad / 2);
    const angle = totalMarkers === 1 ? Math.PI / 2 : startAngle + ((totalMarkers - 1 - markerIndex) * ((endAngle - startAngle) / (totalMarkers - 1)));
    return [originalLat + radius * Math.sin(angle), originalLng + radius * Math.cos(angle)];
  }, [currentZoom]);

  const handleMarkerClickForFanning = useCallback((marker, markerType) => {
    const locationKey = `${marker.latitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${marker.longitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
    if (marker.duplicateCount > 1) {
      if (onMapInteraction) onMapInteraction();
      if (fannedLocationKey === locationKey) {
        setFannedLocationKey(null);
        return;
      }
      const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
      const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
      const markersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation].sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
      const bounds = L.latLngBounds([]);
      markersAtLocation.forEach((m, index) => {
        const [fannedLat, fannedLng] = calculateFannedPositionWrapperWrapper(marker.latitude, marker.longitude, index, markersAtLocation.length);
        bounds.extend([fannedLat, fannedLng]);
      });
      if (map) {
        const stopCardsFullContainer = document.querySelector('.horizontal-cards-container');
        const actualHeight = stopCardsFullContainer ? stopCardsFullContainer.getBoundingClientRect().height : 0;
        map.fitBounds(bounds, { paddingTopLeft: [80, 350], paddingBottomRight: [80, Math.max(actualHeight + 20, 80)], maxZoom: 14, animate: true, duration: 0.6 });
        setTimeout(() => setFannedLocationKey(locationKey), 650);
      } else {
        setFannedLocationKey(locationKey);
      }
      return;
    }

    setFannedLocationKey(null);
    if (marker.status === 'pending' && marker.puid) {
      const assignedPickup = pickupMarkers.find(p => p && p.stop_id === marker.puid);
      if (assignedPickup && onMarkerClick) onMarkerClick(assignedPickup);
    } else if (onMarkerClick) {
      onMarkerClick(marker);
    }

    if (map) {
      const targetZoom = isMobile ? 15 : 16;
      const statsCard = document.querySelector('[data-stats-card]');
      const statsCardHeight = statsCard ? statsCard.getBoundingClientRect().height : 0;
      const stopCardsFullContainer = document.querySelector('.horizontal-cards-container');
      const stopCardsActualHeight = stopCardsFullContainer ? stopCardsFullContainer.getBoundingClientRect().height : 0;
      const dynamicTopPadding = statsCardHeight + 350;
      const dynamicBottomPadding = stopCardsActualHeight + 20;
      const mapSize = map.getSize();
      const visibleHeight = mapSize.y - (dynamicTopPadding + dynamicBottomPadding);
      const offsetPixels = visibleHeight * 0.3;
      const markerPoint = map.project([marker.latitude, marker.longitude], targetZoom);
      const offsetCenter = map.unproject([markerPoint.x, markerPoint.y - offsetPixels], targetZoom);
      if (map && map.getCenter && map._loaded && map._mapPane && map._mapPane._leaflet_pos) {
        map.setView(offsetCenter, targetZoom, { animate: true, duration: 0.6 });
      }
      const markerElement = markerRefs.current[`${markerType}-${marker.id}`];
      if (markerElement && markerElement._popup) {
        setTimeout(() => markerElement.openPopup(), 300);
      }
    }

    if (onMapInteraction) onMapInteraction();
  }, [fannedLocationKey, onMarkerClick, currentZoom, map, groupedDeliveryMarkers, groupedPickupMarkers, calculateFannedPositionWrapperWrapper, onMapInteraction, isMobile, pickupMarkers]);

  useEffect(() => {
    if (currentZoom < 11 && fannedLocationKey) setFannedLocationKey(null);
  }, [currentZoom, fannedLocationKey]);

  const isViewingCurrentDate = useMemo(() => {
    const today = getEdmDate();
    if (!selectedDate) return true;
    return selectedDate === today;
  }, [selectedDate]);

  const prevDriverLocationMarkersRef = useRef([]);
  const driverLocationMarkers = useMemo(() => {
    const today = getEdmDate();
    const isViewingTodayOrFuture = !selectedDate || selectedDate >= today;
    if (!isViewingTodayOrFuture) {
      prevDriverLocationMarkersRef.current = [];
      return [];
    }
    if (!safeUsers?.length) return prevDriverLocationMarkersRef.current;

    const isCurrentUserAdmin = currentUser && userHasRole(currentUser, 'admin');
    const isCurrentUserDispatcher = currentUser && userHasRole(currentUser, 'dispatcher');
    const isCurrentUserDriver = currentUser && userHasRole(currentUser, 'driver');
    const isPureDispatcher = isCurrentUserDispatcher && !isCurrentUserDriver && !isCurrentUserAdmin;
    const currentUserCityId = currentUser?.city_id;
    const fiveMinutesInMs = 5 * 60 * 1000;
    const now = Date.now();
    const todayStr = getEdmDate();
    const currentUserId = currentUser?.id;

    const markers = safeUsers.map((user) => {
      if (!user || typeof user !== 'object') return null;
      const driverId = user.id || user.user_id;
      if (!driverId) return null;
      const isCurrentUserMarker = driverId === currentUserId || (currentUser?.user_id && driverId === currentUser.user_id) || (user.user_id && user.user_id === currentUserId);
      if (isMobile && isCurrentUserMarker) return null;
      if (user.status === 'inactive') return null;
      if (!user.current_latitude || !user.current_longitude) return null;
      if (user.location_tracking_enabled !== true && !isCurrentUserMarker) return null;

      let isStaleLocation = true;
      if (user.location_updated_at) isStaleLocation = (now - new Date(user.location_updated_at).getTime()) > fiveMinutesInMs;

      if ((isMobile || !isMobile) && (isCurrentUserDriver || isCurrentUserAdmin) && !isPureDispatcher) {
        if (!isCurrentUserAdmin && currentUserCityId && user.city_id !== currentUserCityId) return null;
      } else if (isPureDispatcher) {
        const dispatcherStoreIds = new Set(currentUser.store_ids || []);
        const hasActiveDelivery = (deliveriesForLocationFilter || []).some(delivery => delivery && delivery.driver_id === driverId && delivery.delivery_date === todayStr && dispatcherStoreIds.has(delivery.store_id) && ['en_route', 'in_transit', 'pending'].includes(delivery.status));
        if (!hasActiveDelivery) return null;
        if (user.location_tracking_enabled !== true) return null;
      } else {
        return null;
      }

      const driverColor = getDriverColor(user);
      const driverName = user.user_name || user.full_name || 'Unknown Driver';
      return {
        id: driverId,
        user_id: driverId,
        driver_id: driverId,
        driverId,
        latitude: user.current_latitude,
        longitude: user.current_longitude,
        location_updated_at: user.location_updated_at,
        driver: user,
        driverColor,
        driverName,
        driverInitial: driverName.charAt(0).toUpperCase(),
        isSelf: isCurrentUserMarker,
        driver_status: user.driver_status,
        location_tracking_enabled: user.location_tracking_enabled,
        isStaleLocation,
        isOnBreak: user.driver_status === 'on_break' && isCurrentUserMarker
      };
    }).filter(Boolean);

    if (markers.length > 0) {
      prevDriverLocationMarkersRef.current = markers;
      return markers;
    }
    return prevDriverLocationMarkersRef.current;
  }, [
    selectedDate,
    isViewingCurrentDate,
    currentUser?.id,
    isMobile,
    safeUsers.map(u => `${u?.id}:${u?.current_latitude?.toFixed(4)}:${u?.current_longitude?.toFixed(4)}:${u?.driver_status}:${u?.location_tracking_enabled}`).join('|'),
    deliveriesForLocationFilter.map(d => `${d?.id}:${d?.driver_id}:${d?.delivery_date}:${d?.status}`).join('|'),
    polylineRenderKey
  ]);

  const currentDriverMarker = useMemo(() => {
    if (!isMobile) return null;
    if (!currentUser) return null;
    const today = getEdmDate();
    const isViewingTodayOrFuture = !selectedDate || selectedDate >= today;
    if (!isViewingTodayOrFuture) return null;

    const isCurrentUserDriver = userHasRole(currentUser, 'driver');
    const isCurrentUserAdmin = userHasRole(currentUser, 'admin');
    const isCurrentUserDispatcher = userHasRole(currentUser, 'dispatcher');
    const isPureDispatcher = isCurrentUserDispatcher && !isCurrentUserDriver && !isCurrentUserAdmin;
    const shouldShowBlueDot = (isCurrentUserDriver || isCurrentUserAdmin) && !isPureDispatcher;
    if (!shouldShowBlueDot) return null;

    let locationData = currentDriverLocation || (() => {
      const appUser = (realtimeAppUsers || []).find((user) => user && (user.user_id === currentUser.id || user.id === currentUser.id));
      return (appUser && appUser.current_latitude && appUser.current_longitude)
        ? { latitude: appUser.current_latitude, longitude: appUser.current_longitude, timestamp: appUser.location_updated_at }
        : null;
    })();

    if (!locationData?.latitude || !locationData?.longitude) {
      if (currentUser.current_latitude && currentUser.current_longitude) {
        locationData = { latitude: currentUser.current_latitude, longitude: currentUser.current_longitude, timestamp: currentUser.location_updated_at };
      } else {
        return null;
      }
    }

    return {
      ...locationData,
      driver: currentUser,
      driverId: currentUser.id,
      driver_id: currentUser.id
    };
  }, [currentDriverLocation, currentUser, isMobile, selectedDate, realtimeAppUsers]);

  const routeAwareCurrentDriverMarker = useMemo(() => {
    if (!currentDriverMarker) return null;
    const driverId = currentDriverMarker.driverId || currentDriverMarker.driver_id;
    const routeLocation = driverId ? routeLocationSnapshot[driverId] : null;
    if (!routeLocation) return currentDriverMarker;
    return {
      ...currentDriverMarker,
      latitude: routeLocation.latitude,
      longitude: routeLocation.longitude,
      timestamp: routeLocation.location_updated_at || currentDriverMarker.timestamp
    };
  }, [currentDriverMarker, routeLocationSnapshot]);

  const routeAwareDriverLocationMarkers = useMemo(() => {
    if (!Array.isArray(driverLocationMarkers) || driverLocationMarkers.length === 0) return driverLocationMarkers;
    return driverLocationMarkers.map((marker) => {
      const driverId = marker?.driverId || marker?.driver_id || marker?.id;
      const routeLocation = driverId ? routeLocationSnapshot[driverId] : null;
      if (!routeLocation) return marker;
      return {
        ...marker,
        latitude: routeLocation.latitude,
        longitude: routeLocation.longitude,
        current_latitude: routeLocation.latitude,
        current_longitude: routeLocation.longitude,
        location_updated_at: routeLocation.location_updated_at || marker.location_updated_at
      };
    });
  }, [driverLocationMarkers, routeLocationSnapshot]);

  const driversWithCompleteRoute = useMemo(() => {
    const result = new Set();
    const driverStopsMap = new Map();
    [...deliveryMarkers, ...pickupMarkers].forEach(m => {
      if (!m || !m.driver_id) return;
      if (!driverStopsMap.has(m.driver_id)) driverStopsMap.set(m.driver_id, { incomplete: [], complete: [] });
      if (FINISHED_STATUSES.includes(m.status)) driverStopsMap.get(m.driver_id).complete.push(m);
      else if (m.status !== 'pending') driverStopsMap.get(m.driver_id).incomplete.push(m);
    });
    driverStopsMap.forEach((stops, driverId) => {
      if (stops.incomplete.length === 0 && stops.complete.length > 0) result.add(driverId);
    });
    return result;
  }, [deliveryMarkers.map(d => `${d?.id}:${d?.status}`).join(','), pickupMarkers.map(p => `${p?.id}:${p?.status}`).join(',')]);

  const prevDriverHomeMarkersRef = useRef([]);
  const driverHomeMarkers = useMemo(() => {
    if (!showRoutes || !currentUser || (selectedDate && selectedDate < getEdmDate())) {
      prevDriverHomeMarkersRef.current = [];
      return [];
    }
    if (!safeUsers?.length) return prevDriverHomeMarkersRef.current;
    if (userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
      prevDriverHomeMarkersRef.current = [];
      return [];
    }

    const isCurrentUserDriver = userHasRole(currentUser, 'driver');
    const isCurrentUserAdmin = userHasRole(currentUser, 'admin');
    const driversToShowHome = new Set();
    const driversToExcludeFromBounds = new Set();
    const deliveriesToCheck = (isCurrentUserAdmin && showOtherDriverDeliveries && otherDriverDeliveries.length > 0) ? [...safeDeliveries, ...otherDriverDeliveries] : safeDeliveries;
    const stopsByDriver = new Map();

    deliveriesToCheck.forEach((delivery) => {
      if (!delivery || !delivery.driver_id) return;
      if (!stopsByDriver.has(delivery.driver_id)) stopsByDriver.set(delivery.driver_id, { deliveries: [], pickups: [] });
      if (delivery.patient_id) stopsByDriver.get(delivery.driver_id).deliveries.push(delivery);
      else stopsByDriver.get(delivery.driver_id).pickups.push(delivery);
    });

    const isShowAllMode = showOtherDriverDeliveries || isAllDriversMode;
    stopsByDriver.forEach((stops, driverId) => {
      if (!isShowAllMode && driverId !== selectedDriverId && !(isCurrentUserAdmin || isAppOwner(currentUser))) return;
      const allStops = [...stops.deliveries, ...stops.pickups];
      const incompleteStops = allStops.filter(s => !FINISHED_STATUSES.includes(s.status) && s.status !== 'pending');
      const completedStops = allStops.filter(s => FINISHED_STATUSES.includes(s.status));
      const unfinishedPickups = stops.pickups.filter(s => !FINISHED_STATUSES.includes(s.status));

      if (showOtherDriverDeliveries && driverId !== currentUser?.id) {
        driversToShowHome.add(driverId);
        return;
      }
      if (allStops.length > 0 && completedStops.length === 0) {
        driversToShowHome.add(driverId);
        return;
      }
      if (incompleteStops.length === 0 && completedStops.length > 0 && unfinishedPickups.length === 0) {
        driversToShowHome.add(driverId);
      }
    });

    if (driversToShowHome.size === 0 && prevDriverHomeMarkersRef.current.length > 0) return prevDriverHomeMarkersRef.current;

    const homeMarkers = [];
    driversToShowHome.forEach((driverId) => {
      if (isSingleDriverMode && driverId !== selectedDriverId) return;
      if (isDriverViewingSelfToday && driverId !== currentUser.id) return;
      const driver = safeUsers.find((u) => u && typeof u === 'object' && u.id === driverId);
      if (driver?.driver_status === 'off_duty') return;
      if (!driver?.home_latitude || !driver?.home_longitude || typeof driver.home_latitude !== 'number' || typeof driver.home_longitude !== 'number' || Number.isNaN(driver.home_latitude) || Number.isNaN(driver.home_longitude)) return;
      const shouldRenderHome = driver.id === selectedDriverId || driver.id === currentUser.id || (showOtherDriverDeliveries && (isAppOwner(currentUser) || isCurrentUserAdmin || isCurrentUserDriver));
      if (shouldRenderHome) {
        homeMarkers.push({
          id: `home-${driverId}`,
          driverId,
          driver,
          latitude: driver.home_latitude,
          longitude: driver.home_longitude,
          driverColor: getDriverColor(driver),
          driverName: driver.user_name || driver.full_name || 'Unknown Driver',
          excludeFromBounds: driversToExcludeFromBounds.has(driverId),
          isRouteComplete: driversWithCompleteRoute.has(driverId)
        });
      }
    });

    const newKey = homeMarkers.map(m => `${m.id}:${m.latitude}:${m.longitude}`).join('|');
    const prevKey = prevDriverHomeMarkersRef.current.map(m => `${m.id}:${m.latitude}:${m.longitude}`).join('|');
    if (newKey === prevKey && prevDriverHomeMarkersRef.current.length > 0) return prevDriverHomeMarkersRef.current;
    if (homeMarkers.length === 0 && prevDriverHomeMarkersRef.current.length > 0) return prevDriverHomeMarkersRef.current;
    prevDriverHomeMarkersRef.current = homeMarkers;
    return homeMarkers;
  }, [showRoutes, currentUser?.id, isViewingCurrentDate, isDriverViewingSelfToday, showOtherDriverDeliveries, JSON.stringify(safeDeliveries.map(d => ({ id: d?.driver_id, status: d?.status }))), JSON.stringify(otherDriverDeliveries.map(d => ({ id: d?.driver_id, status: d?.status }))), JSON.stringify(safeUsers.map(u => ({ id: u?.id, hLat: u?.home_latitude, hLon: u?.home_longitude }))), driversWithCompleteRoute, selectedDriverId, isAllDriversMode]);

  useEffect(() => {
    window.__mapHomeMarkers = driverHomeMarkers;
    window.__mapDriverLocationMarkers = driverLocationMarkers;
    window.__mapDeliveryMarkers = deliveryMarkers;
    window.__mapPickupMarkers = pickupMarkers;
    return () => {
      delete window.__mapHomeMarkers;
      delete window.__mapDriverLocationMarkers;
      delete window.__mapDeliveryMarkers;
      delete window.__mapPickupMarkers;
    };
  }, [driverHomeMarkers, driverLocationMarkers, deliveryMarkers, pickupMarkers]);

  const driverRoutes = useMemo(() => {
    if ((!showRoutes && !showBreadcrumbs) || currentZoom < ZOOM_LEVELS.HIDE_ROUTES) {
      prevDriverRoutesRef.current = [];
      return [];
    }

    const activeStatuses = ['in_transit'];
    const driverOrderMap = new Map();
    stableSortedDrivers.forEach((driver, index) => driverOrderMap.set(driver.id, { driver, sortIndex: index }));
    const routesByDriver = {};
    const allDeliveriesForRoutes = showOtherDriverDeliveries && otherDriverDeliveries.length > 0
      ? [...deliveryMarkers, ...otherDriverDeliveries.map((d) => {
          const patient = safePatients.find((p) => p && p.id === d.patient_id);
          if (!patient?.latitude || !patient?.longitude) return null;
          const driver = safeUsers.find((u) => u && u.id === d.driver_id);
          const store = safeStores.find((s) => s && s.id === d.store_id);
          return { ...d, latitude: patient.latitude, longitude: patient.longitude, patient, driver, store, pinColor: store ? getStoreColor(store) : '#6B7280', markerType: 'delivery' };
        }).filter(Boolean)]
      : deliveryMarkers;

    allDeliveriesForRoutes.forEach((delivery) => {
      if (!delivery) return;
      const driverId = delivery.driver_id || 'unassigned';
      if (!routesByDriver[driverId]) {
        const driverInfo = driverOrderMap.get(driverId);
        let driverForRoute = driverInfo?.driver || driverLookupMap.get(driverId);
        let stableSortIndex = driverInfo?.sortIndex ?? Infinity;
        if (!driverForRoute && delivery.driver_name) {
          driverForRoute = { id: driverId, user_name: delivery.driver_name, full_name: delivery.driver_name };
          stableSortIndex = Infinity;
        }
        routesByDriver[driverId] = {
          driverId,
          driverName: driverForRoute ? (driverForRoute.user_name || driverForRoute.full_name || 'Unknown') : 'Unassigned',
          driver: driverForRoute,
          color: driverForRoute && typeof driverForRoute === 'object' ? getDriverColor(driverForRoute) : '#607D8B',
          stops: [],
          sortOrder: stableSortIndex,
          _driverObj: driverForRoute
        };
      }
      routesByDriver[driverId].stops.push(delivery);
    });

    const sortedRoutes = Object.values(routesByDriver).sort((a, b) => a.sortOrder - b.sortOrder).map((route) => {
      const driverPickups = pickupMarkers.filter((p) => p.driver_id === route.driverId);
      const allDeliveriesFinished = route.stops.every((d) => FINISHED_STATUSES.includes(d.status));
      const allPickupsFinished = driverPickups.every((p) => FINISHED_STATUSES.includes(p.status));
      const isRouteCompleted = allDeliveriesFinished && allPickupsFinished;
      const hasActiveStops = route.stops.some((delivery) => delivery && activeStatuses.includes(delivery.status)) || driverPickups.some((p) => p && activeStatuses.includes(p.status));
      const hasCompletedStops = route.stops.some((d) => FINISHED_STATUSES.includes(d.status)) || driverPickups.some((p) => p && FINISHED_STATUSES.includes(p.status));
      const isRouteStarted = hasActiveStops || hasCompletedStops;
      const deliveriesToRoute = isRouteCompleted ? route.stops : route.stops.filter((delivery) => delivery && !FINISHED_STATUSES.includes(delivery.status) && delivery.status !== 'pending');
      const pickupsToRoute = isRouteCompleted ? driverPickups : driverPickups.filter((p) => p && !FINISHED_STATUSES.includes(p.status) && p.status !== 'pending');
      const patientDeliveryCount = route.stops.filter(d => d && d.patient_id).length;
      const completedOrCancelledAfterHours = driverPickups.filter(p => p && p.after_hours_pickup && (p.status === 'completed' || p.status === 'cancelled')).length;
      const totalDriverStopsWithAfterHours = patientDeliveryCount + completedOrCancelledAfterHours;
      const routeHasActuallyStarted = isRouteStarted;

      let coordinates = [];
      let lastStopCoordinates = null;
      let shouldShowHomeRoute = false;
      let firstStopCoordinates = null;
      let startToFirstStopCoordinates = null;

      if (!(pickupsToRoute.length === 0 && deliveriesToRoute.length === 0)) {
        const allStops = [
          ...pickupsToRoute.map((pickup) => ({ type: 'pickup', stop_order: pickup.display_stop_order || pickup.stop_order || 0, latitude: pickup.latitude, longitude: pickup.longitude, store: pickup.store?.name, time: pickup.delivery_time_start })),
          ...deliveriesToRoute.map((delivery) => ({ type: 'delivery', stop_order: delivery.display_stop_order || delivery.stop_order || 0, latitude: delivery.latitude, longitude: delivery.longitude, patient: delivery.patient?.full_name, time: delivery.delivery_time_start }))
        ];
        allStops.sort((a, b) => a.stop_order - b.stop_order);
        coordinates = allStops.map((stop) => [stop.latitude, stop.longitude]);
        if (allStops.length > 0) firstStopCoordinates = [allStops[0].latitude, allStops[0].longitude];
        if (allStops.length > 0) {
          const lastStop = allStops[allStops.length - 1];
          lastStopCoordinates = [lastStop.latitude, lastStop.longitude];
          shouldShowHomeRoute = !isRouteCompleted && !(userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) && isViewingCurrentDate;
        }

        if (routeHasActuallyStarted && firstStopCoordinates && route.driver && isViewingCurrentDate) {
          let startPoint = null;
          if (currentUser && route.driver.id === currentUser.id && isMobile && currentDriverLocation?.latitude && currentDriverLocation?.longitude) {
            startPoint = [currentDriverLocation.latitude, currentDriverLocation.longitude];
          } else {
            const liveDriverData = realtimeAppUsers.find(u => u && u.id === route.driver.id);
            const lat = liveDriverData?.current_latitude;
            const lng = liveDriverData?.current_longitude;
            const updatedAt = liveDriverData?.location_updated_at;
            if (lat && lng && updatedAt) {
              const locationAge = Date.now() - new Date(updatedAt).getTime();
              if (locationAge < 5 * 60 * 1000) startPoint = [lat, lng];
            }
          }
          if (!startPoint && hasCompletedStops) {
            const completedStopsForDriver = [...route.stops, ...driverPickups].filter((s) => s && FINISHED_STATUSES.includes(s.status) && s.actual_delivery_time).sort((a, b) => new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time));
            if (completedStopsForDriver.length > 0) {
              const lastCompleted = completedStopsForDriver[0];
              startPoint = [lastCompleted.latitude, lastCompleted.longitude];
            }
          }
          if (startPoint) startToFirstStopCoordinates = [startPoint, firstStopCoordinates];
        } else if (!isRouteStarted && firstStopCoordinates && route.driver && !(userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin'))) {
          const isPrimaryMobile = currentUser && route.driver.id === currentUser.id && isMobile && currentDriverLocation?.latitude && currentDriverLocation?.longitude;
          const liveDriverData = realtimeAppUsers.find(u => u && u.id === route.driver.id);
          const hasSharedLocation = liveDriverData?.current_latitude && liveDriverData?.current_longitude;
          if (!(isPrimaryMobile || hasSharedLocation) && route.driver.home_latitude && route.driver.home_longitude) {
            startToFirstStopCoordinates = [[route.driver.home_latitude, route.driver.home_longitude], firstStopCoordinates];
          }
        }
      }

      let routeWeight = 2;
      let routeOpacity = 0.8;
      let showWaypoints = true;
      if (currentZoom < ZOOM_LEVELS.SIMPLIFY_ROUTES) {
        routeWeight = 1.5;
        routeOpacity = 0.6;
        showWaypoints = false;
      } else if (currentZoom >= ZOOM_LEVELS.FULL_DETAIL) {
        routeWeight = 3;
        routeOpacity = 0.9;
      }
      if (isMobile) routeWeight *= 1.25;

      return {
        ...route,
        coordinates,
        lastStopCoordinates,
        shouldShowHomeRoute: isViewingCurrentDate && shouldShowHomeRoute,
        startToFirstStopCoordinates: isViewingCurrentDate ? startToFirstStopCoordinates : null,
        isOriginLine: routeHasActuallyStarted,
        hasPickup: pickupsToRoute.length > 0,
        isCompleted: isRouteCompleted,
        isRouteStarted,
        pickupCount: driverPickups.length,
        totalStops: totalDriverStopsWithAfterHours,
        routeWeight,
        routeOpacity,
        showWaypoints
      };
    });

    prevDriverRoutesRef.current = sortedRoutes;
    return sortedRoutes;
  }, [
    deliveryMarkers.map(d => `${d?.id}:${d?.stop_order}:${d?.status}`).join(','),
    pickupMarkers.map(p => `${p?.id}:${p?.stop_order}:${p?.status}`).join(','),
    showRoutes,
    isAllDriversMode,
    stableSortedDrivers.map(d => `${d?.id}:${d?.sort_order}`).join('|'),
    currentZoom,
    currentUser?.id,
    isMobile,
    currentDriverLocation?.latitude,
    currentDriverLocation?.longitude,
    realtimeAppUsers.map(u => `${u?.id}:${u?.current_latitude?.toFixed(4)}:${u?.current_longitude?.toFixed(4)}`).join('|'),
    isViewingCurrentDate,
    isDriverViewingSelfToday,
    showBreadcrumbs,
    routeRenderKey
  ]);

  useEffect(() => {
    if (onDriverRoutesCalculated) onDriverRoutesCalculated(driverRoutes);
  }, [driverRoutes, onDriverRoutesCalculated]);

  const hasNotifiedMapReady = useRef(false);
  useEffect(() => {
    if (hasNotifiedMapReady.current) return;
    if (!map) return;
    const hasMarkers = deliveryMarkers.length > 0 || pickupMarkers.length > 0;
    const isReady = hasMarkers || safeDeliveries.length === 0;
    if (isReady && onMapReady) {
      hasNotifiedMapReady.current = true;
      onMapReady();
    }
  }, [map, deliveryMarkers.length, pickupMarkers.length, safeDeliveries.length, onMapReady]);

  useEffect(() => {
    if (!statsCardRect) {
      setLegendLeft(null);
      return;
    }
    const statsCardCenterX = statsCardRect.left + (statsCardRect.width / 2);
    if (legendRef.current) {
      setLegendLeft(statsCardCenterX - (legendRef.current.offsetWidth / 2));
    } else {
      setLegendLeft(statsCardCenterX);
    }
  }, [statsCardRect, driverRoutes.length, isStatsCardExpanded]);

  useEffect(() => {
    if (!map || !map.getCenter || !map._loaded || !map._panes || !map._mapPane || !shouldFitBounds) return;
    try {
      if (!map._mapPane._leaflet_pos) return;
    } catch (e) {
      return;
    }
    try {
      const bounds = L.latLngBounds((Array.isArray(shouldFitBounds.bounds) ? shouldFitBounds.bounds : []).filter(p => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])));
      if (!bounds.isValid()) return;
      if (map._leaflet_events?.zoomstart) {
        if (!map._isProgrammaticZoom) Object.defineProperty(map, '_isProgrammaticZoom', { value: { current: false }, writable: true, configurable: true });
        map._isProgrammaticZoom.current = true;
      }
      const opts = shouldFitBounds.options || {};
      try { window._lastProgrammaticMapMove = Date.now(); } catch (_) {}
      map._mapPane._leaflet_pos && map.fitBounds(bounds, { ...opts, paddingTopLeft: opts.paddingTopLeft || [60, 60], paddingBottomRight: opts.paddingBottomRight || [60, 60], animate: true, duration: 0.8 });
      if (onBoundsFitted) onBoundsFitted();
    } catch (error) {
      console.warn('[DeliveryMap] Error during bounds fit:', error);
    }
  }, [map, shouldFitBounds, stopCardsHeight, onBoundsFitted]);

  const handleMarkerDragEnd = useCallback((markerId, event, type) => {
    try { event.target.getLatLng(); } catch (e) {}
  }, []);

  return (
    <div className="absolute inset-0">
      <MapContainer
        center={center || [53.5461, -113.4938]}
        zoom={zoom || (safeDeliveries.length === 0 ? 11 : 12)}
        maxZoom={17.5}
        zoomSnap={0}
        zoomDelta={0.1}
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
        onClick={() => setFannedLocationKey(null)}
        whenReady={(mapInstance) => {
          setMap(mapInstance.target);
          setCurrentZoom(mapInstance.target.getZoom());
          setVisibleBounds(mapInstance.target.getBounds());
        }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url={document.documentElement.classList.contains('dark-theme') || (document.documentElement.classList.contains('auto-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)
            ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            : "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"}
        />

        <MapController onMapInteraction={onMapInteraction} onDoubleTap={onDoubleTap} currentZoom={currentZoom} setCurrentZoom={setCurrentZoom} setShowZoomOverlay={setShowZoomOverlay} zoomOverlayTimeoutRef={zoomOverlayTimeoutRef} setMapCenter={setMapCenter} setVisibleBounds={setVisibleBounds} setFannedLocationKey={setFannedLocationKey} />
        <Pane name="routeBasePane" style={{ zIndex: 430 }} />
        <Pane name="completedBreadcrumbPane" style={{ zIndex: 460 }} />

        {(showRoutes || showBreadcrumbs || (typeof window !== 'undefined' && localStorage.getItem('rxdeliver_show_routes') === 'true')) && (
          <CompletedBreadcrumbPolylines
            driverRoutes={driverRoutes}
            deliveryMarkers={deliveryMarkers}
            pickupMarkers={pickupMarkers}
            selectedDriverId={selectedDriverId}
            isAllDriversMode={isAllDriversMode}
            highlightedDeliveryId={highlightedDeliveryId}
            polylineRenderKey={polylineRenderKey}
            showStoredPolylines={showRoutes}
            showBreadcrumbPolylines={showBreadcrumbs}
          />
        )}

        {fannedLocationKey && (() => {
          const pickupsAtLocation = groupedPickupMarkers.get(fannedLocationKey) || [];
          const deliveriesAtLocation = groupedDeliveryMarkers.get(fannedLocationKey) || [];
          const allMarkersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation].sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
          return allMarkersAtLocation.map((marker, idx) => {
            const [originalLat, originalLng] = fannedLocationKey.split(',').map(Number);
            if (!Number.isFinite(originalLat) || !Number.isFinite(originalLng)) return null;
            const [fannedLat, fannedLng] = calculateFannedPositionWrapperWrapper(originalLat, originalLng, idx, allMarkersAtLocation.length);
            if (!Number.isFinite(fannedLat) || !Number.isFinite(fannedLng)) return null;
            return (
              <Polyline
                key={`radius-${marker.markerType}-${marker.id}-${idx}`}
                positions={[[originalLat, originalLng], [fannedLat, fannedLng]]}
                pathOptions={{ color: '#64748b', weight: 4, opacity: 1, dashArray: '' }}
                pane="overlayPane"
              />
            );
          });
        })()}

        {(() => {
          const HeadingUpRotator = React.lazy(() => import('./HeadingUpRotator'));
          const enabled = false;
          const hasValid = !!(currentDriverMarker && typeof currentDriverMarker.latitude === 'number' && typeof currentDriverMarker.longitude === 'number' && !Number.isNaN(currentDriverMarker.latitude) && !Number.isNaN(currentDriverMarker.longitude));
          return (
            <>
              {enabled && hasValid && (
                <React.Suspense fallback={null}>
                  <HeadingUpRotator isMobile={isMobile} currentDriverMarker={currentDriverMarker} enabled={enabled} />
                </React.Suspense>
              )}
              {hasValid && (
                <Marker
                  key="current-driver-location"
                  position={[currentDriverMarker.latitude, currentDriverMarker.longitude]}
                  icon={createLiveLocationDot()}
                  zIndexOffset={6000}
                  eventHandlers={{
                    click: () => onMarkerClick && onMarkerClick(currentDriverMarker, 'driver'),
                    mouseover: (e) => { e.target.openPopup(); },
                    mouseout: (e) => { e.target.closePopup(); }
                  }}>
                  <Popup autoPan={false} closeButton={false} offset={[0, -10]} className="custom-popup">
                    <div className="min-w-[150px]">
                      <div className="flex items-center gap-1.5">
                        <Navigation className="w-3.5 h-3.5 text-blue-600" />
                        <h3 className="font-semibold text-xs">Your Location</h3>
                      </div>
                      <div className="text-[10px] text-blue-600 mt-1 font-medium flex items-center gap-1">
                        <Activity className="w-3 h-3 animate-pulse" />
                        Live GPS
                      </div>
                      {currentDriverMarker.timestamp && (
                        <div className="flex items-center gap-1 mt-1 text-[11px] text-gray-600">
                          <Clock className="w-3 h-3" />
                          Updated: {format(new Date(currentDriverMarker.timestamp), 'HH:mm:ss')}
                        </div>
                      )}
                    </div>
                  </Popup>
                </Marker>
              )}
            </>
          );
        })()}

        <DriverLocationMarkers users={driverLocationMarkers} currentUser={currentUser} activeDriver={null} deliveries={deliveriesForLocationFilter} selectedDate={selectedDate} />

        {(showRoutes || (typeof window !== 'undefined' && localStorage.getItem('rxdeliver_show_routes') === 'true')) && (
          <>
            <HereType2Polylines
              key={`type2-${selectedDriverId}-${selectedDate}-${showOtherDriverDeliveries ? 'all' : 'single'}`}
              isViewingCurrentDate={isViewingCurrentDate}
              deliveryMarkers={deliveryMarkers}
              pickupMarkers={pickupMarkers}
              driverRoutes={driverRoutes}
              multiDriverMode={selectedDriverId === 'all' || showOtherDriverDeliveries}
              selectedDriverId={selectedDriverId}
            />
            <HereType1Polylines
              key={`type1-${selectedDriverId}-${selectedDate}-${showOtherDriverDeliveries ? 'all' : 'single'}-${routeRecalcVersion}`}
              isViewingCurrentDate={isViewingCurrentDate}
              deliveryMarkers={deliveryMarkers}
              pickupMarkers={pickupMarkers}
              driverHomeMarkers={driverHomeMarkers}
              currentDriverMarker={routeAwareCurrentDriverMarker}
              selectedDriverId={selectedDriverId}
              showAll={isAllDriversMode || showOtherDriverDeliveries}
              driverLocations={routeAwareDriverLocationMarkers}
            />
          </>
        )}

        <HomeMarkers driverHomeMarkers={driverHomeMarkers} map={map} isMobile={isMobile} onMarkerClick={onMarkerClick} />
        <PickupMarkers pickupMarkers={pickupMarkers} groupedPickupMarkers={groupedPickupMarkers} groupedDeliveryMarkers={groupedDeliveryMarkers} routeRenderKey={routeRenderKey} currentZoom={currentZoom} ZOOM_LEVELS={ZOOM_LEVELS} isMobile={isMobile} fannedLocationKey={fannedLocationKey} highlightedDeliveryId={highlightedDeliveryId} fadedMarkerHighlights={fadedMarkerHighlights} setFadedMarkerHighlights={setFadedMarkerHighlights} driversWithCompleteRoute={driversWithCompleteRoute} hasIncompleteStops={hasIncompleteStops} calculateFannedPositionWrapperWrapper={calculateFannedPositionWrapperWrapper} onMarkerClick={onMarkerClick} handleMarkerClickForFanning={handleMarkerClickForFanning} handleMarkerDragEnd={handleMarkerDragEnd} markerRefs={markerRefs} safeStores={safeStores} safePatients={safePatients} safeUsers={safeUsers} />
        <DeliveryMarkers deliveryMarkers={deliveryMarkers} groupedDeliveryMarkers={groupedDeliveryMarkers} groupedPickupMarkers={groupedPickupMarkers} routeRenderKey={routeRenderKey} currentZoom={currentZoom} ZOOM_LEVELS={ZOOM_LEVELS} isMobile={isMobile} fannedLocationKey={fannedLocationKey} setFannedLocationKey={setFannedLocationKey} highlightedDeliveryId={highlightedDeliveryId} fadedMarkerHighlights={fadedMarkerHighlights} setFadedMarkerHighlights={setFadedMarkerHighlights} driversWithCompleteRoute={driversWithCompleteRoute} hasIncompleteStops={hasIncompleteStops} calculateFannedPositionWrapperWrapper={calculateFannedPositionWrapperWrapper} onMarkerClick={onMarkerClick} handleMarkerClickForFanning={handleMarkerClickForFanning} handleMarkerDragEnd={handleMarkerDragEnd} markerRefs={markerRefs} safeStores={safeStores} safePatients={safePatients} safeUsers={safeUsers} stores={stores} />
        {showBreadcrumbs && <MapBreadcrumbs breadcrumbsData={breadcrumbsData} safeUsers={safeUsers} />}
      </MapContainer>

      <MapCrosshair stopCardsHeight={areStopCardsVisible ? stopCardsHeight : 0} statsCardHeight={isMobile ? (isStatsCardExpanded ? 216 : 116) : 0} isMobile={isMobile} />

      {showZoomOverlay && (
        <div className="absolute top-4 left-4 z-[99999] px-4 py-2 rounded-lg shadow-lg transition-opacity duration-300 pointer-events-none" style={{ background: 'var(--text-slate-900)', color: 'var(--bg-white)' }}>
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold">{currentZoom.toFixed(1)}</span>
          </div>
        </div>
      )}

      {showLegend && driverRoutes.length > 0 && (() => {
        const DriverLegend = React.lazy(() => import('./DriverLegend'));
        return (
          <React.Suspense fallback={null}>
            <DriverLegend legendRef={legendRef} legendLeft={legendLeft} isStatsCardExpanded={isStatsCardExpanded} driverRoutes={driverRoutes} highlightedRouteId={highlightedRouteId} setHighlightedRouteId={setHighlightedRouteId} onLegendInteraction={onLegendInteraction} />
          </React.Suspense>
        );
      })()}

      <style>{`
        .custom-popup .leaflet-popup-content-wrapper {
          padding: 6px;
          border-radius: 8px;
          box-shadow: 0 3px 14px var(--shadow-color);
          background: var(--bg-white);
          color: var(--text-slate-900);
        }
        .custom-popup .leaflet-popup-content {
          margin: 0;
          line-height: 1.3;
        }
        .custom-popup .leaflet-popup-tip {
          box-shadow: 0 3px 14px var(--shadow-color);
          background: var(--bg-white);
        }
        .leaflet-popup-pane {
          z-index: 10010 !important;
        }
        .leaflet-popup {
          z-index: 10010 !important;
        }
        .route-popup .leaflet-popup-content-wrapper {
          padding: 4px 8px;
          border-radius: 6px;
          box-shadow: 0 2px 8px var(--shadow-color);
          background: var(--bg-white);
          color: var(--text-slate-900);
          z-index: 999999;
        }
        .route-popup .leaflet-popup-content {
          margin: 0;
          line-height: 1.2;
        }
        .route-popup .leaflet-popup-tip {
          box-shadow: 0 2px 8px var(--shadow-color);
          background: var(--bg-white);
        }
        @keyframes pulseHalo {
          0%, 100% { stroke-width: 2; opacity: 0.85; }
          50% { stroke-width: 4; opacity: 0.3; }
        }
        .pulsating-halo {
          animation: pulseHalo 1s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}