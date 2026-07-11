import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, Marker, Pane, Polyline, Popup, TileLayer } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

const IntegerZoomTileLayer = L.TileLayer.extend({
  _getZoomForUrl() {
    const zoom = L.TileLayer.prototype._getZoomForUrl.call(this);
    return Math.round(zoom);
  }
});
import { format } from "date-fns";
import { base44 } from "@/api/base44Client";


const buildHereLightTileUrl = (apiKey) => `https://maps.hereapi.com/v3/base/mc/{z}/{x}/{y}/png?style=explore.day&size=512&apiKey=${apiKey}`;
const buildHereDarkTileUrl = (apiKey) => `https://maps.hereapi.com/v3/base/mc/{z}/{x}/{y}/png?style=explore.night&size=512&apiKey=${apiKey}`;
const buildHereSatelliteTileUrl = (apiKey) => `https://maps.hereapi.com/v3/base/mc/{z}/{x}/{y}/jpeg?style=satellite.day&size=512&apiKey=${apiKey}`;
const buildHereHybridBaseTileUrl = (apiKey) => `https://maps.hereapi.com/v3/base/mc/{z}/{x}/{y}/jpeg?style=satellite.day&size=512&apiKey=${apiKey}`;
const buildHereHybridOverlayTileUrl = (apiKey) => `https://maps.hereapi.com/v3/base/mc/{z}/{x}/{y}/png?style=hybrid.day&size=512&apiKey=${apiKey}`;
import { isMobileDevice } from "../utils/deviceUtils";
import { getHereApiKey } from "../utils/hereApiKeyStore";
import { getStoreColor } from "../utils/colorGenerator";
import { userHasRole } from "../utils/userRoles";
import { sortUsers } from "../utils/sorting";
import MapCrosshair from "./MapCrosshair";
import MapController from "./MapController";
import DriverLocationMarkers from "./DriverLocationMarkers";
import HereTileUsageTracker from "./HereTileUsageTracker";
import HereType1Polylines from "./HereType1Polylines";
import HereType2Polylines from "./HereType2Polylines";
import CompletedBreadcrumbPolylines from "./CompletedBreadcrumbPolylines";
import PickupMarkers from "./PickupMarkers";
import DeliveryMarkers from "./DeliveryMarkers";
import HomeMarkers from "./HomeMarkers";
import MapBreadcrumbs from "./MapBreadcrumbs";
import { createLiveLocationDot } from "./MapIcons";
import { useRouteRecalcSignal } from "./useRouteRecalcSignal";
import { getInterStoreLocationSync, isInterStoreDelivery } from "../utils/interStoreDisplayName";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png"
});

const DRIVER_COLORS = ["", "#1E90FF", "#8A2BE2", "#00CED1", "#FF69B4", "#4B0082", "#A0522D"];
const FINISHED_STATUSES = ["completed", "failed", "cancelled"];
const ZOOM_LEVELS = { HIDE_ROUTES: 8, SIMPLIFY_ROUTES: 12, HIDE_NUMBERS: 11, HIDE_CIRCLES: 11, FULL_DETAIL: 13 };
const getDistanceMeters = (previousLocation, nextLocation) => {
  if (!previousLocation?.latitude || !previousLocation?.longitude) return Infinity;
  if (!nextLocation?.latitude || !nextLocation?.longitude) return 0;
  const toRadians = (value) => value * Math.PI / 180;
  const earthRadiusMeters = 6371000;
  const lat1 = toRadians(previousLocation.latitude);
  const lat2 = toRadians(nextLocation.latitude);
  const deltaLat = toRadians(nextLocation.latitude - previousLocation.latitude);
  const deltaLon = toRadians(nextLocation.longitude - previousLocation.longitude);
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const hasDriverMovedEnoughForPhase2 = (previousLocation, nextLocation, minimumMeters = 50) => {
  if (!nextLocation?.latitude || !nextLocation?.longitude) return false;
  if (!previousLocation?.latitude || !previousLocation?.longitude) return true;
  return getDistanceMeters(previousLocation, nextLocation) > minimumMeters;
};

const getEdmDate = () => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Edmonton",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  return `${parts.find((p) => p.type === "year").value}-${parts.find((p) => p.type === "month").value}-${parts.find((p) => p.type === "day").value}`;
};

export const getDriverColor = (driver) => {
  if (!driver?.id) return "#607D8B";
  const paletteSize = DRIVER_COLORS.length - 1;
  let index = driver.sort_order;
  if (!(typeof index === "number" && index > 0 && index <= paletteSize)) {
    let hash = 0;
    for (const char of String(driver.id)) hash = char.charCodeAt(0) + ((hash << 5) - hash);
    index = (Math.abs(hash) % paletteSize) + 1;
  }
  return DRIVER_COLORS[index] || "#607D8B";
};

const getLocationKey = (lat, lng, zoom) => {
  const precision = zoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : zoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : zoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2;
  return `${Number(lat).toFixed(precision)},${Number(lng).toFixed(precision)}`;
};

const dedupeById = (items) => {
  const map = new Map();
  (items || []).forEach((item) => {
    if (!item?.id) return;
    const existing = map.get(item.id);
    if (!existing) {
      map.set(item.id, item);
      return;
    }
    const existingTime = new Date(existing.updated_date || existing.location_updated_at || existing.created_date || 0).getTime();
    const nextTime = new Date(item.updated_date || item.location_updated_at || item.created_date || 0).getTime();
    if (nextTime >= existingTime) {
      map.set(item.id, item);
    }
  });
  return Array.from(map.values());
};

const getAppUserTimestamp = (user) => {
  const value = user?.location_updated_at || user?.updated_date || user?.created_date;
  return value ? new Date(value).getTime() : 0;
};

const mergeAppUsersByFreshness = (currentUsers = [], incomingUsers = []) => {
  const merged = new Map((currentUsers || []).map((user) => [user?.id || user?.user_id, user]).filter(([key]) => !!key));
  (incomingUsers || []).forEach((user) => {
    const key = user?.id || user?.user_id;
    if (!key) return;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, user);
      return;
    }
    if (getAppUserTimestamp(user) < getAppUserTimestamp(existing)) return;

    const movedEnough = hasDriverMovedEnoughForPhase2(
      {
        latitude: Number(existing?.current_latitude),
        longitude: Number(existing?.current_longitude)
      },
      {
        latitude: Number(user?.current_latitude),
        longitude: Number(user?.current_longitude)
      },
      50
    );

    if (!movedEnough) {
      merged.set(key, {
        ...existing,
        ...user,
        current_latitude: existing?.current_latitude,
        current_longitude: existing?.current_longitude
      });
      return;
    }

    merged.set(key, { ...existing, ...user });
  });
  return Array.from(merged.values());
};

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
  setMapCenter = null,
  setMapZoom = null,
  shouldFitBounds = null,
  onBoundsFitted = null,
  onMarkerClick,
  mapMode = "auto-follow",
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
  statsCardPositioning = "",
  isStatsCardExpanded = false,
  statsCardRect = null,
  highlightedDeliveryId = null,
  areStopCardsVisible = false,
  onDriverRoutesCalculated = () => {},
  onMapReady = () => {},
  mapViewPhase = 1,
  isMapViewLocked = false,
  topOverlayHeight = 0,
  immersiveHidden = false,
  mapStyle = "explore"
}) {
  const safeDeliveries = Array.isArray(deliveries) ? deliveries : [];
  const safeAllDeliveriesForDate = Array.isArray(allDeliveriesForDate) ? allDeliveriesForDate : [];
  const safePatients = Array.isArray(patients) ? patients : [];
  const safeStores = Array.isArray(stores) ? stores : [];
  const isMobile = useMemo(() => isMobileDevice(), []);
  const [map, setMap] = useState(null);
  const [mapReady, setMapReady] = useState(false);
  const fanCanvasRenderer = useRef(null);
  const [fanRendererReady, setFanRendererReady] = useState(false);
  const [currentZoom, setCurrentZoom] = useState(zoom);
  const [visibleBounds, setVisibleBounds] = useState(null);
  const [showZoomOverlay, setShowZoomOverlay] = useState(false);
  const zoomOverlayTimeoutRef = useRef(null);
  const markerRefs = useRef({});
  const popupTimeoutsRef = useRef({});
  const lastTappedRef = useRef({ id: null, time: 0 });
  const legendRef = useRef(null);
  const [legendLeft, setLegendLeft] = useState(null);
  const [fannedLocationKey, setFannedLocationKey] = useState(null);
  const [fadedMarkerHighlights, setFadedMarkerHighlights] = useState(new Set());
  const [realtimeAppUsers, setRealtimeAppUsers] = useState(Array.isArray(users) ? users : []);
  const [otherDriverDeliveries, setOtherDriverDeliveries] = useState([]);
  const [routeRenderKey, setRouteRenderKey] = useState(0);
  const [polylineRenderKey, setPolylineRenderKey] = useState(0);
  const [measuredTopOverlayHeight, setMeasuredTopOverlayHeight] = useState(0);
  // Seed immediately from the singleton — prevents blank map on first render
  const [hereApiKey, setHereApiKey] = useState(() => getHereApiKey() || null);
  const [tileLayerInstanceKey, setTileLayerInstanceKey] = useState(0);
  const prevTileConfigRef = useRef({ style: null, base: null, overlay: null });
  // Track last non-zero stopCardsHeight so the crosshair position doesn't shift when
  // immersive mode zeros it out (areStopCardsVisible → false → stopCardsHeight prop → 0)
  const stableCrosshairHeightRef = useRef(stopCardsHeight > 0 ? stopCardsHeight : 75);
  if (stopCardsHeight > 0) stableCrosshairHeightRef.current = stopCardsHeight;
  const hasNotifiedMapReady = useRef(false);
  const prevDriverHomeMarkersRef = useRef([]);
  const prevDriverLocationMarkersRef = useRef([]);
  const prevDriverRoutesRef = useRef([]);

  const isViewingCurrentDate = useMemo(() => !selectedDate || selectedDate === getEdmDate(), [selectedDate]);
  const isAllDriversMode = useMemo(() => {
    // Treat empty string as "no driver selected" for dispatchers — NOT as all-drivers mode
    if (selectedDriverId === "all") return true;
    if (!selectedDriverId) return false;
    return new Set(safeDeliveries.map((d) => d?.driver_id).filter(Boolean)).size > 1;
  }, [selectedDriverId, safeDeliveries]);

  const { routeLocationSnapshot, routeRecalcVersion } = useRouteRecalcSignal({
    currentDriverLocation,
    realtimeAppUsers,
    currentUserId: currentUser?.id
  });

  useEffect(() => {
    if (Array.isArray(users) && users.length > 0) {
      setRealtimeAppUsers((prev) => mergeAppUsersByFreshness(prev, users));
    }
  }, [users]);

  useEffect(() => {
    let mounted = true;

    const loadHereApiKey = async () => {
      const { getOrFetchHereApiKey, clearHereApiKeyCache } = await import('@/components/utils/hereApiKeyStore');
      const key = await getOrFetchHereApiKey();
      if (mounted && key) {
        // Only update state (and thus re-render tiles) when the actual key value changes
        setHereApiKey(prev => (prev === key ? prev : key));
      }
    };

    const handleAppSettingsUpdated = async () => {
      // API key selection changed — bust the cache and re-fetch
      const { clearHereApiKeyCache, getOrFetchHereApiKey } = await import('@/components/utils/hereApiKeyStore');
      clearHereApiKeyCache();
      const key = await getOrFetchHereApiKey();
      if (mounted && key) {
        setHereApiKey(prev => (prev === key ? prev : key));
      }
    };

    loadHereApiKey();
    window.addEventListener("appSettingsUpdated", handleAppSettingsUpdated);

    return () => {
      mounted = false;
      window.removeEventListener("appSettingsUpdated", handleAppSettingsUpdated);
    };
  }, []);

  useEffect(() => {
    if (!retractClustersRef) return;
    retractClustersRef.current = () => setFannedLocationKey(null);
  }, [retractClustersRef]);

  useEffect(() => {
    if (routeRecalcVersion === 0 || mapViewPhase !== 2) return;
    setPolylineRenderKey((value) => value + 1);
  }, [routeRecalcVersion, mapViewPhase]);

  const effectiveTopOverlayHeight = topOverlayHeight || measuredTopOverlayHeight;
  useEffect(() => {
    const measureTopOverlay = () => {
      const anchor = document.querySelector('[data-spotlight-anchor]');
      const overlayContainer = anchor?.parentElement;
      const nextHeight = overlayContainer?.offsetHeight || anchor?.offsetHeight || 0;
      if (nextHeight > 0) {
        setMeasuredTopOverlayHeight(nextHeight);
      }
    };

    measureTopOverlay();
    window.addEventListener('resize', measureTopOverlay);
    return () => window.removeEventListener('resize', measureTopOverlay);
  }, [isStatsCardExpanded, highlightedDeliveryId]);

  useEffect(() => {
    const handleDriverLocationUpdate = (event) => {
      const appUsers = event?.detail?.appUsers;
      if (!Array.isArray(appUsers) || appUsers.length === 0) return;
      setRealtimeAppUsers((prev) => mergeAppUsersByFreshness(prev, appUsers));
    };

    const handleDeliveriesUpdate = () => {
      prevDriverRoutesRef.current = [];
      setRouteRenderKey((value) => value + 1);
      setFannedLocationKey(null);
    };

    // Center map on store when Accept All / Assign All is triggered
    const handleCenterMapOnStore = (event) => {
      const { lat, lng, radiusKm = 3 } = event.detail || {};
      if (!map || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
      // Convert radius in km to a zoom level: zoom = log2(earth_circumference_px / (radiusKm * 2 * tile_size_ratio))
      // Practical approximation: 3km radius ≈ zoom 13.5 for most screen sizes
      const radiusZoom = Math.round((14.5 - Math.log2(radiusKm)) * 10) / 10;
      window._lastProgrammaticMapMove = Date.now() + 1500;
      map.setView([lat, lng], radiusZoom, { animate: true, duration: 0.6 });
    };

    window.addEventListener("driverLocationsUpdated", handleDriverLocationUpdate);
    window.addEventListener("deliveriesUpdated", handleDeliveriesUpdate);
    window.addEventListener("routeOptimizationComplete", handleDeliveriesUpdate);
    window.addEventListener("centerMapOnStore", handleCenterMapOnStore);
    return () => {
      window.removeEventListener("driverLocationsUpdated", handleDriverLocationUpdate);
      window.removeEventListener("deliveriesUpdated", handleDeliveriesUpdate);
      window.removeEventListener("routeOptimizationComplete", handleDeliveriesUpdate);
      window.removeEventListener("centerMapOnStore", handleCenterMapOnStore);
    };
  }, [map]);

  useEffect(() => {
    if (!selectedDate || !showOtherDriverDeliveries || !selectedDriverId || selectedDriverId === "all") {
      setOtherDriverDeliveries([]);
      return;
    }
    (async () => {
      try {
        const { offlineDB } = await import("./../../components/utils/offlineDatabase");
        let rows = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDate);
        if (!rows || rows.length === 0) {
          rows = await base44.entities.Delivery.filter({ delivery_date: selectedDate });
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, rows || []);
        }
        setOtherDriverDeliveries((rows || []).filter((row) => row?.driver_id && row.driver_id !== selectedDriverId));
      } catch {
        setOtherDriverDeliveries([]);
      }
    })();
  }, [selectedDate, selectedDriverId, showOtherDriverDeliveries]);

  const safeUsers = useMemo(() => {
    const mergedUsers = Array.isArray(realtimeAppUsers) && realtimeAppUsers.length > 0 ? [...realtimeAppUsers] : [...(Array.isArray(users) ? users : [])];
    const selectedDriverKey = selectedDriverId && selectedDriverId !== "all" ? selectedDriverId : null;
    if (selectedDriverKey && currentUser?.id === selectedDriverKey) {
      const existingIndex = mergedUsers.findIndex((user) => user?.id === selectedDriverKey || user?.user_id === selectedDriverKey);
      if (existingIndex >= 0) {
        mergedUsers[existingIndex] = { ...mergedUsers[existingIndex], ...currentUser };
      } else {
        mergedUsers.push(currentUser);
      }
    }
    return mergedUsers;
  }, [realtimeAppUsers, users, currentUser, selectedDriverId]);

  const driverTravelModes = useMemo(() => {
    const modes = {};
    safeUsers.forEach((user) => {
      const mode = user?.preferred_travel_mode;
      if (user?.id) modes[user.id] = mode;
      if (user?.user_id) modes[user.user_id] = mode;
    });
    return modes;
  }, [safeUsers]);

  const driverLookupMap = useMemo(() => {
    const map = new Map();
    safeUsers.forEach((user) => {
      if (user?.id) map.set(user.id, user);
      if (user?.user_id) map.set(user.user_id, user);
    });
    return map;
  }, [safeUsers]);

  const deliveriesToShow = useMemo(() => {
    if (!showOtherDriverDeliveries) {
      return safeDeliveries;
    }

    const fallbackDeliveriesForSelectedDate = selectedDate
      ? safeAllDeliveriesForDate.filter((delivery) => delivery?.delivery_date === selectedDate)
      : safeAllDeliveriesForDate;
    const baseDeliveries = safeDeliveries.length > 0 ? safeDeliveries : fallbackDeliveriesForSelectedDate;
    if (otherDriverDeliveries.length === 0) return baseDeliveries;
    return dedupeById([...baseDeliveries, ...otherDriverDeliveries]);
  }, [safeDeliveries, safeAllDeliveriesForDate, otherDriverDeliveries, showOtherDriverDeliveries, selectedDate]);

  const driverNameLookupMap = useMemo(() => {
    const map = new Map();
    safeUsers.forEach((user) => {
      const resolvedName = user?.user_name || user?.full_name || user?.driverName || user?.driver_name;
      if (!resolvedName) return;
      if (user?.id) map.set(user.id, resolvedName);
      if (user?.user_id) map.set(user.user_id, resolvedName);
    });
    deliveriesToShow.forEach((delivery) => {
      const resolvedName = delivery?.driver_name || delivery?.driver?.user_name || delivery?.driver?.full_name;
      if (!resolvedName || !delivery?.driver_id || map.has(delivery.driver_id)) return;
      map.set(delivery.driver_id, resolvedName);
    });
    return map;
  }, [safeUsers, deliveriesToShow]);

  // Step 1: Build stable marker objects — does NOT depend on currentZoom.
  // This prevents zoom changes from rebuilding all markers and flickering the map.
  const { rawPickupMarkers, rawDeliveryMarkers, hasIncompleteStops } = useMemo(() => {
    const pickups = [];
    const deliveriesOut = [];
    const hasIncomplete = deliveriesToShow.some((delivery) => delivery && !FINISHED_STATUSES.includes(delivery.status));

    deliveriesToShow.forEach((delivery) => {
      if (!delivery) return;

      if (delivery.is_cycling_marker) {
        // Prefer dedicated cycling_latitude/longitude; fall back to plain latitude/longitude
        // so markers still render even if the backend omits the cycling_ prefix fields.
        const cycLat = Number(delivery.cycling_latitude ?? delivery.latitude);
        const cycLng = Number(delivery.cycling_longitude ?? delivery.longitude);
        if (!Number.isFinite(cycLat) || !Number.isFinite(cycLng)) {
          console.warn('[DeliveryMap] cycling marker missing coords, skipped:', delivery.id, {
            cycling_latitude: delivery.cycling_latitude,
            cycling_longitude: delivery.cycling_longitude,
            latitude: delivery.latitude,
            longitude: delivery.longitude,
          });
          return;
        }
        const driver = driverLookupMap.get(delivery.driver_id) || (delivery.driver_name ? { id: delivery.driver_id, user_name: delivery.driver_name, full_name: delivery.driver_name } : null);
        const isStart = delivery.delivery_notes === 'Cycling Route Start';
        deliveriesOut.push({
          ...delivery,
          latitude: cycLat,
          longitude: cycLng,
          driver,
          pinColor: isStart ? '#16a34a' : '#dc2626',
          number: delivery.display_stop_order || delivery.stop_order || 0,
          markerType: 'cycling',
          isOtherDriver: !!(selectedDriverId && selectedDriverId !== "all" && delivery.driver_id !== selectedDriverId),
        });
        return;
      }

      const store = safeStores.find((item) => item?.id === delivery.store_id) || null;
      const driver = driverLookupMap.get(delivery.driver_id) || (delivery.driver_name ? { id: delivery.driver_id, user_name: delivery.driver_name, full_name: delivery.driver_name } : null);
      const isOtherDriver = !!(selectedDriverId && selectedDriverId !== "all" && delivery.driver_id !== selectedDriverId);
      const isCurrentUserDispatcher = currentUser && userHasRole(currentUser, "dispatcher");
      const isStopInDispatcherStore = !!(isCurrentUserDispatcher && currentUser?.store_ids?.includes(delivery.store_id));
      const useDispatcherPlaceholder = isCurrentUserDispatcher && !isStopInDispatcherStore;

      if (delivery.patient_id) {
        const patient = safePatients.find((item) => item?.id === delivery.patient_id) || null;
        if (!patient?.latitude || !patient?.longitude) return;
        deliveriesOut.push({
          ...delivery,
          latitude: patient.latitude,
          longitude: patient.longitude,
          patient,
          driver,
          store,
          pinColor: isAllDriversMode
              ? getDriverColor(driver || { id: delivery.driver_id || delivery.id })
              : (store ? getStoreColor(store) : "#6B7280"),
          number: delivery.display_stop_order || delivery.stop_order || 0,
          isFirstTime: !!delivery.first_delivery,
          isNextInLine: !!delivery.isNextDelivery,
          markerType: "delivery",
          useSimpleCircle: (showOtherDriverDeliveries && isOtherDriver) || useDispatcherPlaceholder,
          isOtherDriver: isOtherDriver || useDispatcherPlaceholder,
          isReturn: `${patient?.full_name || delivery.patient_name || ""}`.toLowerCase().includes("return")
        });
        return;
      }

      let pickupLat = store?.latitude;
      let pickupLng = store?.longitude;
      const isInterStore = isInterStoreDelivery(delivery.delivery_id);
      if (isInterStore) {
        const interStoreLoc = getInterStoreLocationSync(delivery.delivery_id);
        if (interStoreLoc?.store_latitude && interStoreLoc?.store_longitude) {
          pickupLat = interStoreLoc.store_latitude;
          pickupLng = interStoreLoc.store_longitude;
        }
      }
      if (!pickupLat || !pickupLng) return;
      pickups.push({
        ...delivery,
        latitude: pickupLat,
        longitude: pickupLng,
        store,
        driver,
        pinColor: getStoreColor(store),
        number: delivery.display_stop_order || delivery.stop_order || 0,
        markerType: "pickup",
        isInterStorePickup: isInterStore,
        useSimpleCircle: false,
        isOtherDriver
      });
    });

    return { rawPickupMarkers: pickups, rawDeliveryMarkers: deliveriesOut, hasIncompleteStops: hasIncomplete };
  }, [deliveriesToShow, safeStores, safePatients, driverLookupMap, selectedDriverId, currentUser, showOtherDriverDeliveries, isAllDriversMode]);

  // Step 2: Apply zoom-dependent duplicate counts and grouping maps separately.
  // Zoom changes only recompute counts/groups — the stable marker objects from Step 1 are reused.
  const { pickupMarkers, groupedPickupMarkers, deliveryMarkers, groupedDeliveryMarkers } = useMemo(() => {
    const allMarkers = [...rawPickupMarkers, ...rawDeliveryMarkers];
    const counts = new Map();
    allMarkers.forEach((marker) => {
      const key = getLocationKey(marker.latitude, marker.longitude, currentZoom);
      counts.set(key, (counts.get(key) || 0) + 1);
    });

    const groupedPickupsMap = new Map();
    const groupedDeliveriesMap = new Map();

    const pickupMarkersWithCounts = rawPickupMarkers.map((marker) => {
      const key = getLocationKey(marker.latitude, marker.longitude, currentZoom);
      if (!groupedPickupsMap.has(key)) groupedPickupsMap.set(key, []);
      const withCount = { ...marker, duplicateCount: counts.get(key) || 1 };
      groupedPickupsMap.get(key).push(withCount);
      return withCount;
    });

    const deliveryMarkersWithCounts = rawDeliveryMarkers.map((marker) => {
      const key = getLocationKey(marker.latitude, marker.longitude, currentZoom);
      if (!groupedDeliveriesMap.has(key)) groupedDeliveriesMap.set(key, []);
      const withCount = { ...marker, duplicateCount: counts.get(key) || 1 };
      groupedDeliveriesMap.get(key).push(withCount);
      return withCount;
    });

    return {
      pickupMarkers: pickupMarkersWithCounts,
      groupedPickupMarkers: groupedPickupsMap,
      deliveryMarkers: deliveryMarkersWithCounts,
      groupedDeliveryMarkers: groupedDeliveriesMap,
    };
  }, [rawPickupMarkers, rawDeliveryMarkers, currentZoom]);

  const driverLocationMarkers = useMemo(() => {
    const today = getEdmDate();
    if (selectedDate && selectedDate < today) {
      prevDriverLocationMarkersRef.current = [];
      return [];
    }

    const isAdmin = currentUser && userHasRole(currentUser, "admin");
    const isDriver = currentUser && userHasRole(currentUser, "driver");
    const isDispatcher = currentUser && userHasRole(currentUser, "dispatcher") && !isAdmin && !isDriver;
    const currentUserId = currentUser?.id;
    const currentUserCityId = currentUser?.city_id;
    const now = Date.now();
    const fiveMinutesMs = 5 * 60 * 1000;

    const markers = safeUsers.map((user) => {
      if (!user?.id || user.status === "inactive") return null;
      if (!user.current_latitude || !user.current_longitude) return null;
      const isSelf = user.id === currentUserId || user.user_id === currentUserId;
      if (!isSelf && user.location_tracking_enabled !== true) return null;
      if (!isAdmin && currentUserCityId && user.city_id && user.city_id !== currentUserCityId) return null;
      if (!showOtherDriverDeliveries && selectedDriverId && selectedDriverId !== "all" && !isSelf && user.id !== selectedDriverId && user.user_id !== selectedDriverId) return null;
      if (!showOtherDriverDeliveries && selectedDriverId && selectedDriverId !== "all" && isSelf && selectedDriverId !== currentUserId) return null;
      const resolvedDriverName = driverNameLookupMap.get(user.id) || driverNameLookupMap.get(user.user_id) || user.user_name || user.full_name || "Driver";

      if (isDispatcher) {
        const dispatcherStoreIds = new Set(currentUser?.store_ids || []);
        const hasVisibleDelivery = (deliveriesForLocationFilter || []).some((delivery) => delivery?.driver_id === user.id && delivery?.delivery_date === today && dispatcherStoreIds.has(delivery.store_id) && ["en_route", "in_transit", "pending"].includes(delivery.status));
        if (!hasVisibleDelivery) return null;
      }

      if (!isAdmin && !isDriver && !isDispatcher) return null;

      return {
        id: user.id,
        user_id: user.user_id || user.id,
        driver_id: user.id,
        driverId: user.id,
        latitude: user.current_latitude,
        longitude: user.current_longitude,
        current_latitude: user.current_latitude,
        current_longitude: user.current_longitude,
        location_updated_at: user.location_updated_at,
        user_name: resolvedDriverName,
        full_name: resolvedDriverName,
        driver: user,
        driverColor: getDriverColor(user),
        driverName: resolvedDriverName,
        driverInitial: resolvedDriverName.charAt(0).toUpperCase(),
        isSelf,
        driver_status: user.driver_status,
        location_tracking_enabled: user.location_tracking_enabled,
        isStaleLocation: !user.location_updated_at || now - new Date(user.location_updated_at).getTime() > fiveMinutesMs,
        isOnBreak: user.driver_status === "on_break" && isSelf
      };
    }).filter(Boolean);

    if (markers.length > 0) {
      prevDriverLocationMarkersRef.current = markers;
      return markers;
    }
    return prevDriverLocationMarkersRef.current;
  }, [safeUsers, currentUser, deliveriesForLocationFilter, selectedDate, isMobile, driverNameLookupMap]);

  const currentDriverMarker = useMemo(() => {
    if (!isMobile || !currentUser) return null;
    const today = getEdmDate();
    if (selectedDate && selectedDate < today) return null;

    const isCurrentUserDriver = userHasRole(currentUser, "driver");
    const isCurrentUserAdmin = userHasRole(currentUser, "admin");
    const isCurrentUserDispatcher = userHasRole(currentUser, "dispatcher");
    const isPureDispatcher = isCurrentUserDispatcher && !isCurrentUserDriver && !isCurrentUserAdmin;
    if (!(isCurrentUserDriver || isCurrentUserAdmin) || isPureDispatcher) return null;

    let locationData = currentDriverLocation;
    if (!locationData?.latitude || !locationData?.longitude) {
      const appUser = safeUsers.find((user) => user && (user.user_id === currentUser.id || user.id === currentUser.id));
      if (appUser?.current_latitude && appUser?.current_longitude) {
        locationData = { latitude: appUser.current_latitude, longitude: appUser.current_longitude, timestamp: appUser.location_updated_at };
      } else if (currentUser.current_latitude && currentUser.current_longitude) {
        locationData = { latitude: currentUser.current_latitude, longitude: currentUser.current_longitude, timestamp: currentUser.location_updated_at };
      } else {
        return null;
      }
    }

    return { ...locationData, driver: currentUser, driverId: currentUser.id, driver_id: currentUser.id };
  }, [currentDriverLocation, safeUsers, currentUser, isMobile, selectedDate]);

  const routeAwareCurrentDriverMarker = useMemo(() => {
    if (!currentDriverMarker) return null;
    const routeLocation = routeLocationSnapshot[currentDriverMarker.driverId || currentDriverMarker.driver_id];
    if (!routeLocation) return currentDriverMarker;
    return { ...currentDriverMarker, latitude: routeLocation.latitude, longitude: routeLocation.longitude, timestamp: routeLocation.location_updated_at || currentDriverMarker.timestamp };
  }, [currentDriverMarker, routeLocationSnapshot]);

  const routeAwareDriverLocationMarkers = useMemo(() => {
    return (driverLocationMarkers || []).map((marker) => {
      const routeLocation = routeLocationSnapshot[marker.driverId || marker.driver_id || marker.id];
      return routeLocation
        ? { ...marker, latitude: routeLocation.latitude, longitude: routeLocation.longitude, current_latitude: routeLocation.latitude, current_longitude: routeLocation.longitude, location_updated_at: routeLocation.location_updated_at || marker.location_updated_at }
        : marker;
    });
  }, [driverLocationMarkers, routeLocationSnapshot]);

  const [isDarkTheme, setIsDarkTheme] = useState(() =>
    document.documentElement.classList.contains("dark-theme") ||
    (document.documentElement.classList.contains("auto-theme") && window.matchMedia("(prefers-color-scheme: dark)").matches)
  );

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const dark = document.documentElement.classList.contains("dark-theme") ||
        (document.documentElement.classList.contains("auto-theme") && window.matchMedia("(prefers-color-scheme: dark)").matches);
      setIsDarkTheme(prev => prev === dark ? prev : dark);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const tileLayerConfig = useMemo(() => {
    if (!hereApiKey) return null;
    if (mapStyle === "satellite") {
      return { base: buildHereSatelliteTileUrl(hereApiKey), overlay: null };
    }
    if (mapStyle === "hybrid") {
      return {
        base: buildHereHybridBaseTileUrl(hereApiKey),
        overlay: buildHereHybridOverlayTileUrl(hereApiKey)
      };
    }
    return {
      base: isDarkTheme ? buildHereDarkTileUrl(hereApiKey) : buildHereLightTileUrl(hereApiKey),
      overlay: null
    };
  }, [hereApiKey, mapStyle, isDarkTheme]);

  const driversWithCompleteRoute = useMemo(() => {
    const byDriver = new Map();
    [...deliveryMarkers, ...pickupMarkers].forEach((stop) => {
      if (!stop?.driver_id) return;
      if (!byDriver.has(stop.driver_id)) byDriver.set(stop.driver_id, { complete: 0, incomplete: 0 });
      if (FINISHED_STATUSES.includes(stop.status)) byDriver.get(stop.driver_id).complete += 1;
      else if (stop.status !== "pending") byDriver.get(stop.driver_id).incomplete += 1;
    });
    const result = new Set();
    byDriver.forEach((value, key) => {
      if (value.incomplete === 0 && value.complete > 0) result.add(key);
    });
    return result;
  }, [deliveryMarkers, pickupMarkers]);

  const driverHomeVisibilityById = useMemo(() => {
    const byDriver = new Map();

    safeUsers.forEach((user) => {
      const driverKey = user?.id || user?.user_id;
      const hasHomeCoords = Number.isFinite(Number(user?.home_latitude)) && Number.isFinite(Number(user?.home_longitude));
      if (driverKey && hasHomeCoords) {
        byDriver.set(driverKey, { completed: 0, remainingPickups: 0, remainingDeliveries: 0 });
      }
    });

    [...deliveryMarkers, ...pickupMarkers].forEach((stop) => {
      if (!stop?.driver_id) return;
      if (!byDriver.has(stop.driver_id)) byDriver.set(stop.driver_id, { completed: 0, remainingPickups: 0, remainingDeliveries: 0 });
      const state = byDriver.get(stop.driver_id);
      if (FINISHED_STATUSES.includes(stop.status)) state.completed += 1;
      else if (stop.markerType === "pickup") state.remainingPickups += 1;
      else if (stop.markerType === "delivery") state.remainingDeliveries += 1;
    });

    const visibilityMap = new Map();
    byDriver.forEach((state, driverId) => {
      const driver = safeUsers.find((user) => (user?.id || user?.user_id) === driverId);
      const isOnDuty = ['on_duty', 'online'].includes(String(driver?.driver_status || '').toLowerCase());
      const isCurrentDriver = driverId === currentUser?.id;
      visibilityMap.set(driverId, {
        ...state,
        shouldShowHomeMarker: isCurrentDriver || isOnDuty || state.completed === 0 || (state.remainingPickups === 0)
      });
    });
    return visibilityMap;
  }, [deliveryMarkers, pickupMarkers, safeUsers, currentUser, selectedDriverId]);

  const driverHomeMarkers = useMemo(() => {
    const isPureDriver = currentUser && userHasRole(currentUser, "driver") && !userHasRole(currentUser, "admin") && !userHasRole(currentUser, "dispatcher");

    if (!showRoutes || !currentUser || (selectedDate && selectedDate < getEdmDate())) {
      prevDriverHomeMarkersRef.current = [];
      return [];
    }

    const visibleDriverIds = new Set([...deliveryMarkers, ...pickupMarkers].map((stop) => stop?.driver_id).filter(Boolean));
    const routeDriverIds = new Set(Array.from(driverHomeVisibilityById.entries()).filter(([, state]) => (state.completed > 0 || state.remainingPickups > 0 || state.remainingDeliveries > 0)).map(([driverId]) => driverId));
    const isDispatcher = currentUser && userHasRole(currentUser, "dispatcher") && !userHasRole(currentUser, "admin") && !userHasRole(currentUser, "driver");
    const items = safeUsers.filter((user) => {
      const driverKey = user?.id || user?.user_id;
      const hasHomeCoords = Number.isFinite(Number(user?.home_latitude)) && Number.isFinite(Number(user?.home_longitude));
      if (!driverKey || !hasHomeCoords) return false;
      const homeVisibility = driverHomeVisibilityById.get(driverKey);
      const hasVisibleStops = visibleDriverIds.has(driverKey) || routeDriverIds.has(driverKey);
      const isCurrentDriverUser = driverKey === currentUser.id && userHasRole(currentUser, "driver");
      const isSelectedDriver = !!(selectedDriverId && selectedDriverId !== "all" && driverKey === selectedDriverId);
      const isAdminViewer = currentUser && userHasRole(currentUser, "admin");
      if (isCurrentDriverUser) {
        return true;
      }
      if (!homeVisibility?.shouldShowHomeMarker) return false;
      if (isAdminViewer && isSelectedDriver) return true;
      if (isPureDriver && driverKey !== currentUser.id && !(showOtherDriverDeliveries || isAllDriversMode)) return false;
      if (isDispatcher) {
        if (!(showOtherDriverDeliveries || isAllDriversMode)) return false;
        return hasVisibleStops;
      }
      if (showOtherDriverDeliveries || isAllDriversMode) return hasVisibleStops;
      return hasVisibleStops;
    }).map((user) => {
      const driverKey = user?.id || user?.user_id;
      return {
        id: `home-${driverKey}`,
        driverId: driverKey,
        driver: user,
        latitude: Number(user.home_latitude),
        longitude: Number(user.home_longitude),
        driverColor: getDriverColor(user),
        driverName: user.user_name || user.full_name || "Unknown Driver",
        excludeFromBounds: false,
        isRouteComplete: driversWithCompleteRoute.has(driverKey)
      };
    });

    prevDriverHomeMarkersRef.current = items;
    return items;
  }, [showRoutes, currentUser, selectedDate, deliveryMarkers, pickupMarkers, safeUsers, selectedDriverId, showOtherDriverDeliveries, isAllDriversMode, driversWithCompleteRoute, driverHomeVisibilityById]);

  useEffect(() => {
    window.__mapHomeMarkers = driverHomeMarkers;
    window.__mapDriverLocationMarkers = routeAwareDriverLocationMarkers;
    window.__mapDeliveryMarkers = deliveryMarkers;
    window.__mapPickupMarkers = pickupMarkers;
    return () => {
      delete window.__mapHomeMarkers;
      delete window.__mapDriverLocationMarkers;
      delete window.__mapDeliveryMarkers;
      delete window.__mapPickupMarkers;
    };
  }, [driverHomeMarkers, routeAwareDriverLocationMarkers, deliveryMarkers, pickupMarkers]);

  const driverRoutes = useMemo(() => {
    if ((!showRoutes && !showBreadcrumbs) || currentZoom < ZOOM_LEVELS.HIDE_ROUTES) {
      prevDriverRoutesRef.current = [];
      return [];
    }

    const byDriver = new Map();
    [...pickupMarkers, ...deliveryMarkers].forEach((stop) => {
      if (!stop?.driver_id) return;
      if (!byDriver.has(stop.driver_id)) {
        const driver = driverLookupMap.get(stop.driver_id) || stop.driver || { id: stop.driver_id };
        byDriver.set(stop.driver_id, {
          driverId: stop.driver_id,
          driverName: driver.user_name || driver.full_name || stop.driver_name || "Unknown",
          driver,
          color: getDriverColor(driver),
          sortOrder: driver.sort_order ?? 9999,
          stops: []
        });
      }
      byDriver.get(stop.driver_id).stops.push(stop);
    });

    const routes = sortUsers(Array.from(byDriver.values()).map((route) => ({
      ...route,
      user_name: route.driver?.user_name || route.driver?.full_name || route.driverName,
      sort_order: route.driver?.sort_order ?? route.sortOrder,
    }))).map((route) => {
      const stops = [...route.stops].sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
      const incomplete = stops.filter((stop) => !FINISHED_STATUSES.includes(stop.status) && stop.status !== "pending");
      const completed = stops.filter((stop) => FINISHED_STATUSES.includes(stop.status));
      const isRouteCompleted = incomplete.length === 0 && completed.length > 0;
      const coordinates = (isRouteCompleted ? stops : incomplete).map((stop) => [stop.latitude, stop.longitude]);
      const firstStop = (isRouteCompleted ? stops : incomplete)[0] || null;
      const lastStop = (isRouteCompleted ? stops : incomplete).slice(-1)[0] || null;
      const routeLocation = routeLocationSnapshot[route.driverId];
      const shouldShowDriverHomeMarker = driverHomeVisibilityById.get(route.driverId)?.shouldShowHomeMarker === true;
      const startPoint = routeLocation ? [routeLocation.latitude, routeLocation.longitude] : (shouldShowDriverHomeMarker && route.driver?.home_latitude && route.driver?.home_longitude ? [route.driver.home_latitude, route.driver.home_longitude] : null);
      return {
        ...route,
        coordinates,
        lastStopCoordinates: lastStop ? [lastStop.latitude, lastStop.longitude] : null,
        shouldShowHomeRoute: shouldShowDriverHomeMarker && !!lastStop && !isRouteCompleted && isViewingCurrentDate,
        startToFirstStopCoordinates: startPoint && firstStop ? [startPoint, [firstStop.latitude, firstStop.longitude]] : null,
        isOriginLine: completed.length > 0,
        hasPickup: stops.some((stop) => stop.markerType === "pickup"),
        isCompleted: isRouteCompleted,
        isRouteStarted: completed.length > 0 || incomplete.length > 0,
        pickupCount: stops.filter((stop) => stop.markerType === "pickup").length,
        totalStops: stops.filter((stop) => {
          if (stop.markerType !== "delivery" || !["completed", "failed"].includes(stop.status)) return false;
          const isReturn = `${stop.patient?.full_name || ''}${stop.delivery_notes || ''}${stop.patient?.notes || ''}`.toUpperCase().includes('(RTN)');
          return !isReturn;
        }).length,
        routeWeight: currentZoom < ZOOM_LEVELS.SIMPLIFY_ROUTES ? (isMobile ? 1.875 : 1.5) : (currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? (isMobile ? 3.75 : 3) : (isMobile ? 2.5 : 2)),
        routeOpacity: currentZoom < ZOOM_LEVELS.SIMPLIFY_ROUTES ? 0.6 : currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 0.9 : 0.8,
        showWaypoints: currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES
      };
    });

    prevDriverRoutesRef.current = routes;
    return routes;
  }, [pickupMarkers, deliveryMarkers, driverLookupMap, showRoutes, showBreadcrumbs, currentZoom, isMobile, routeLocationSnapshot, isViewingCurrentDate, driverHomeVisibilityById]);

  useEffect(() => {
    onDriverRoutesCalculated?.(driverRoutes);
  }, [driverRoutes, onDriverRoutesCalculated]);

  const completedRouteDriverIds = useMemo(() => new Set((driverRoutes || []).filter((route) => route?.isCompleted).map((route) => route.driverId).filter(Boolean)), [driverRoutes]);
  const completedRouteDriverRoutes = useMemo(() => (driverRoutes || []).filter((route) => route?.isCompleted), [driverRoutes]);
  const completedRouteDeliveryMarkers = useMemo(() => (deliveryMarkers || []).filter((marker) => completedRouteDriverIds.has(marker?.driver_id)), [deliveryMarkers, completedRouteDriverIds]);
  const completedRoutePickupMarkers = useMemo(() => (pickupMarkers || []).filter((marker) => completedRouteDriverIds.has(marker?.driver_id)), [pickupMarkers, completedRouteDriverIds]);

  useEffect(() => {
    if (hasNotifiedMapReady.current || !map) return;
    if (deliveryMarkers.length > 0 || pickupMarkers.length > 0 || safeDeliveries.length === 0) {
      hasNotifiedMapReady.current = true;
      onMapReady?.();
    }
  }, [map, deliveryMarkers.length, pickupMarkers.length, safeDeliveries.length, onMapReady]);

  useEffect(() => {
    if (!statsCardRect) return setLegendLeft(null);
    const centerX = statsCardRect.left + statsCardRect.width / 2;
    setLegendLeft(legendRef.current ? centerX - legendRef.current.offsetWidth / 2 : centerX);
  }, [statsCardRect, driverRoutes.length, isStatsCardExpanded]);

  // Guards against overlapping animated fitBounds calls: if GPS/shared-marker ticks
  // arrive faster than the current pan/zoom animation can finish, calling fitBounds
  // again immediately makes Leaflet cancel and restart the transition mid-flight —
  // which visually looks like the map freezing/stuttering instead of following.
  // Fix: never start a second animation while one is in flight. Instead, remember
  // the newest request and apply it the instant the in-flight one settles (via
  // Leaflet's own 'moveend' event) — so the map always converges on the truly
  // latest position with zero dropped updates and no artificial delay/timer.
  const fitBoundsInFlightRef = useRef(false);
  const latestFitBoundsRef = useRef(null);

  useEffect(() => {
    if (!map || !shouldFitBounds) return;
    latestFitBoundsRef.current = shouldFitBounds;

    if (fitBoundsInFlightRef.current) {
      // An animation from a very recent tick is still playing — the in-flight
      // handler below will pick up this newer target the moment it settles.
      onBoundsFitted?.();
      return;
    }

    const runFit = (request) => {
      try {
        const bounds = L.latLngBounds((Array.isArray(request.bounds) ? request.bounds : []).filter((point) => Array.isArray(point) && point.length === 2 && Number.isFinite(point[0]) && Number.isFinite(point[1])));
        if (!bounds.isValid()) return;

        const opts = request.options || {};
        const requestedMaxZoom = typeof opts.maxZoom === 'number' ? opts.maxZoom : 17.5;
        const paddingTopLeft    = opts.paddingTopLeft    || [60, 60];
        const paddingBottomRight= opts.paddingBottomRight|| [60, 60];
        const currentZoom = map.getZoom();

        // BUG FIX: the old check only asked "is the map CURRENTLY zoomed in near max?" —
        // it never asked "do the NEW bounds actually need that same tight zoom?". That meant
        // cycling from a tight Phase 2/3 view (e.g. zoom 17.9 on one stop) to Phase 1 (which
        // needs to zoom OUT to fit the whole city) would wrongly take the "just pan, keep zoom"
        // shortcut below — recentering correctly but leaving the zoom stuck at the old tight level.
        // Fix: compute what zoom Leaflet would ACTUALLY pick for the new bounds (via
        // getBoundsZoom, which is a pure calculation — it doesn't move the map), clamped to
        // requestedMaxZoom. Only take the "skip fitBounds" shortcut when that computed zoom is
        // ALSO already at/above max — i.e. the new bounds genuinely want the same tight zoom we're
        // already at, so a real fitBounds call would get clamped and silently skip the pan anyway.
        let targetZoomForBounds = requestedMaxZoom;
        try {
          const avgPadding = L.point(
            (paddingTopLeft[0] + paddingBottomRight[0]) / 2,
            (paddingTopLeft[1] + paddingBottomRight[1]) / 2
          );
          targetZoomForBounds = Math.min(map.getBoundsZoom(bounds, false, avgPadding), requestedMaxZoom);
        } catch {}

        const alreadyAtOrAboveMaxZoom = currentZoom >= requestedMaxZoom - 0.05 && targetZoomForBounds >= requestedMaxZoom - 0.05;

        fitBoundsInFlightRef.current = true;
        let settled = false;
        let safetyTimer = null;
        const settle = () => {
          if (settled) return;
          settled = true;
          if (safetyTimer) clearTimeout(safetyTimer);
          map.off('moveend', settle);
          fitBoundsInFlightRef.current = false;
          const latest = latestFitBoundsRef.current;
          if (latest && latest !== request) runFit(latest);
        };
        map.once('moveend', settle);
        // Safety net: 'moveend' should always fire (even a zero-distance panBy fires it
        // synchronously), but a backgrounded tab can pause/delay the animation's
        // completion indefinitely. Force-clear the in-flight flag after the requested
        // animation duration (+ margin) so a missed event can never permanently jam
        // the follow — it just picks up the latest position a little late instead.
        const animMs = Math.round(((opts.duration != null ? opts.duration : (alreadyAtOrAboveMaxZoom ? 0.5 : 0.9)) * 1000)) + 600;
        safetyTimer = setTimeout(settle, animMs);

        // When the map is already at or above maxZoom AND the new bounds also want that same
        // max zoom, Leaflet's fitBounds clamps the zoom to maxZoom and — since the bounds
        // already fit within the current viewport at that zoom — silently skips the pan entirely.
        // Phase 2 and Phase 3 both hit this when the driver is zoomed all the way in. Fix: detect
        // that case and do a direct setView to the padding-adjusted center of the bounds instead
        // of calling fitBounds.
        if (alreadyAtOrAboveMaxZoom) {
          const center = bounds.getCenter();
          // Adjust center to compensate for asymmetric padding so the bounds center
          // appears visually centred within the padded viewport area.
          // BUG FIX: this must match Leaflet's OWN _getBoundsCenterZoom convention —
          // paddingOffset = (paddingBottomRight - paddingTopLeft) / 2, added to the
          // projected point. The previous (paddingTopLeft - paddingBottomRight) sign
          // was inverted, which pushed the effective center in the wrong direction
          // (most visible at max zoom during close-range live GPS follow, where this
          // branch fires almost every tick) — the driver/stop pair rendered off-center
          // instead of within the visible (unobscured) portion of the viewport.
          const horizShift = (paddingBottomRight[0] - paddingTopLeft[0]) / 2;
          const vertShift  = (paddingBottomRight[1] - paddingTopLeft[1]) / 2;
          const projected = map.project(center, currentZoom);
          const adjusted  = map.unproject(L.point(projected.x + horizShift, projected.y + vertShift), currentZoom);
          map.setView(adjusted, currentZoom, { animate: opts.animate !== false, duration: opts.duration || 0.5 });
          // Stamp so moveend/zoomend guards don't treat this as a user-gesture unlock
          window._lastProgrammaticMapMove = Date.now() + 1500;
        } else {
          // Normal path — zoom out (or stay) and pan to fit all bounds points
          map.fitBounds(bounds, { ...opts, paddingTopLeft, paddingBottomRight, animate: true });
          // Apply the -0.1 reduction to the zoom Leaflet actually chose so the final
          // render is always slightly zoomed out from the computed best-fit level
          const fittedZoom = map.getZoom();
          map.setZoom(fittedZoom, { animate: true });
          window._lastProgrammaticMapMove = Date.now() + 1500;
        }
      } catch {
        fitBoundsInFlightRef.current = false;
      }
    };

    runFit(shouldFitBounds);
    onBoundsFitted?.();
  }, [map, shouldFitBounds, onBoundsFitted]);

  useEffect(() => {
    if (!map || !tileLayerConfig?.base || !map._loaded || !map._container || !map._mapPane) return;
    const prev = prevTileConfigRef.current;
    // Only remount TileLayer when style or URL actually changes — never on initial load
    const styleChanged = prev.style !== null && prev.style !== mapStyle;
    const baseChanged = prev.base !== null && prev.base !== tileLayerConfig.base;
    const overlayChanged = prev.overlay !== null && prev.overlay !== (tileLayerConfig.overlay ?? null);
    prevTileConfigRef.current = { style: mapStyle, base: tileLayerConfig.base, overlay: tileLayerConfig.overlay ?? null };
    if (styleChanged || baseChanged || overlayChanged) {
      setTileLayerInstanceKey((value) => value + 1);
    }
  }, [mapStyle, tileLayerConfig?.base, tileLayerConfig?.overlay, map]);

  // This effect only fires when FAB/positioning logic explicitly sets center/zoom via setMapCenter/setMapZoom.
  // It is never triggered by user map interaction (moveend no longer echoes center back).
  useEffect(() => {
    if (!map || !map._loaded || !map._container || !Array.isArray(center) || center.length !== 2 || !Number.isFinite(zoom)) return;
    if (mapViewPhase === 2 && isMapViewLocked) return;
    const currentCenter = map.getCenter();
    const sameCenter = Math.abs(currentCenter.lat - center[0]) < 0.000001 && Math.abs(currentCenter.lng - center[1]) < 0.000001;
    const sameZoom = Math.abs(map.getZoom() - zoom) < 0.01;
    if (sameCenter && sameZoom) return;
    window._lastProgrammaticMapMove = Date.now() + 1500;
    map.setView(center, zoom, { animate: true, duration: 0.5 });
  }, [map, center, zoom, mapViewPhase, isMapViewLocked]);

  useEffect(() => {
    if (!map) return;

    const updateCrosshairCoords = () => {
      const topObscured = isMobile ? (immersiveHidden ? 0 : (effectiveTopOverlayHeight || (isStatsCardExpanded ? 216 : 116))) : 0;
      const bottomObscured = immersiveHidden ? 0 : ((areStopCardsVisible && !immersiveHidden) ? stopCardsHeight : 0);
      const verticalShift = Math.round((bottomObscured - topObscured) / 2) + 5;
      const size = map.getSize();
      const point = L.point(size.x / 2, size.y / 2 - verticalShift);
      const latLng = map.containerPointToLatLng(point);

      window.__mapCrosshairCoords = {
        latitude: latLng.lat,
        longitude: latLng.lng
      };
    };

    updateCrosshairCoords();
    map.on('move', updateCrosshairCoords);
    map.on('zoom', updateCrosshairCoords);
    map.on('resize', updateCrosshairCoords);

    return () => {
      map.off('move', updateCrosshairCoords);
      map.off('zoom', updateCrosshairCoords);
      map.off('resize', updateCrosshairCoords);
    };
  }, [map, isMobile, isStatsCardExpanded, areStopCardsVisible, stopCardsHeight, effectiveTopOverlayHeight]);

  const calculateFannedPositionWrapperWrapper = useCallback((originalLat, originalLng, markerIndex, totalMarkers) => {
    const radius = 0.0008 + (18 - currentZoom) * 0.0008;
    const arcWidth = totalMarkers <= 2 ? 90 : totalMarkers === 3 ? 120 : totalMarkers === 4 ? 140 : Math.min(180, 140 + (totalMarkers - 4) * 10);
    const arcWidthRad = (arcWidth * Math.PI) / 180;
    const startAngle = Math.PI / 2 - arcWidthRad / 2;
    const endAngle = Math.PI / 2 + arcWidthRad / 2;
    const angle = totalMarkers === 1 ? Math.PI / 2 : startAngle + ((totalMarkers - 1 - markerIndex) * ((endAngle - startAngle) / (totalMarkers - 1)));
    return [originalLat + radius * Math.sin(angle), originalLng + radius * Math.cos(angle)];
  }, [currentZoom]);

  const handleMarkerDragEnd = useCallback(() => {}, []);

  // Pan map so marker appears slightly below center (accounts for stop cards at bottom)
  const panToMarkerOffset = useCallback((lat, lng) => {
    if (!map) return;
    window._lastProgrammaticMapMove = Date.now();
    const targetZoom = Math.max(currentZoom, 15);
    const size = map.getSize();
    const topObscured = isMobile ? (immersiveHidden ? 0 : (effectiveTopOverlayHeight || 116)) : 0;
    const bottomObscured = immersiveHidden ? 0 : ((areStopCardsVisible && !immersiveHidden) ? stopCardsHeight : 0);
    // Place marker slightly below the vertical midpoint of the visible area
    const verticalCenter = topObscured + (size.y - topObscured - bottomObscured) * 0.38;
    const point = map.project([lat, lng], targetZoom);
    const newCenter = map.unproject(L.point(point.x, point.y - (size.y / 2 - verticalCenter)), targetZoom);
    map.setView(newCenter, targetZoom, { animate: true }); // false
  }, [map, currentZoom, isMobile, effectiveTopOverlayHeight, areStopCardsVisible, stopCardsHeight]);

  const handleMarkerClickForFanning = useCallback((marker, markerType) => {
    const locationKey = getLocationKey(marker.latitude, marker.longitude, currentZoom);
    const now = Date.now();
    const SECOND_INTERACTION_MS = isMobile ? 600 : 2000;
    const isSecondTap = lastTappedRef.current.id === locationKey && (now - lastTappedRef.current.time) < SECOND_INTERACTION_MS;
    lastTappedRef.current = { id: locationKey, time: now };

    // --- CLUSTERED ---
    if (marker.duplicateCount > 1) {
      onMapInteraction?.();

      // Desktop: first click centers/zooms AND fans out; clicking again collapses
      if (!isMobile) {
        if (fannedLocationKey === locationKey) return setFannedLocationKey(null);
        // Scroll stop card + pan/zoom to marker
        const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
        const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
        const allAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation].sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
        const incompleteAtLocation = allAtLocation.filter(m => !FINISHED_STATUSES.includes(m.status));
        const targetStop = incompleteAtLocation[0] || allAtLocation[0];
        if (targetStop?.id) {
          window.dispatchEvent(new CustomEvent('centerStopCard', { detail: { deliveryId: targetStop.id, fromMarkerClick: true } }));
          onMarkerClick?.(targetStop, markerType);
        }
        panToMarkerOffset(marker.latitude, marker.longitude);
        setTimeout(() => setFannedLocationKey(locationKey), 550);
        return;
      }

      // Mobile: second tap fans out
      if (isSecondTap) {
        if (fannedLocationKey === locationKey) return setFannedLocationKey(null);
        setFannedLocationKey(locationKey);
        return;
      }

      // Mobile: first tap — center the lowest-order incomplete stop card + pan map
      const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
      const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
      const allAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation].sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
      const incompleteAtLocation = allAtLocation.filter(m => !FINISHED_STATUSES.includes(m.status));
      const targetStop = incompleteAtLocation[0] || allAtLocation[0];
      if (targetStop?.id) {
        window.dispatchEvent(new CustomEvent('centerStopCard', { detail: { deliveryId: targetStop.id, fromMarkerClick: true } }));
        onMarkerClick?.(targetStop, markerType);
      }
      panToMarkerOffset(marker.latitude, marker.longitude);
      return;
    }

    // --- NON-CLUSTERED ---
    setFannedLocationKey(null);

    if (isSecondTap) {
      // Second tap: open popup
      const refKey = markerType === 'pickup' ? `pickup-${marker.id}` : `delivery-${marker.id}`;
      const markerRef = markerRefs.current[refKey];
      if (markerRef) markerRef.openPopup();
      return;
    }

    // First tap: center stop card + pan map, no popup
    if (marker.status === "pending" && marker.puid) {
      const assignedPickup = pickupMarkers.find((pickup) => pickup?.stop_id === marker.puid);
      if (assignedPickup) {
        if (assignedPickup?.id) window.dispatchEvent(new CustomEvent('centerStopCard', { detail: { deliveryId: assignedPickup.id, fromMarkerClick: true } }));
        onMarkerClick?.(assignedPickup);
        panToMarkerOffset(marker.latitude, marker.longitude);
        return;
      }
    }
    if (marker?.id) {
        window.dispatchEvent(new CustomEvent('centerStopCard', { detail: { deliveryId: marker.id, fromMarkerClick: true } }));
      }
      onMarkerClick?.(marker, markerType);
      panToMarkerOffset(marker.latitude, marker.longitude);
      onMapInteraction?.();
  }, [currentZoom, fannedLocationKey, groupedDeliveryMarkers, groupedPickupMarkers, calculateFannedPositionWrapperWrapper, map, onMarkerClick, onMapInteraction, pickupMarkers, isMobile, panToMarkerOffset, effectiveTopOverlayHeight, areStopCardsVisible, stopCardsHeight]);

  return (
    <div className="absolute inset-0">
      <HereTileUsageTracker mapStyle={mapStyle} apiKeyReady={!!tileLayerConfig?.base} />
      <MapContainer
        center={center || [53.5461, -113.4938]}
        zoom={zoom || (safeDeliveries.length === 0 ? 11 : 12)}
        maxZoom={18}
        zoomSnap={0}
        zoomDelta={0.1}
        style={{ height: "100%", width: "100%" }}
        zoomControl={false}
        doubleClickZoom={false}
        onClick={() => setFannedLocationKey(null)}
        whenReady={(instance) => {
          if (!instance?.target?._loaded || !instance?.target?._container || !instance?.target?._panes) return;
          setMap(instance.target);
          setCurrentZoom(instance.target.getZoom());
          setVisibleBounds(instance.target.getBounds());
          // Defer one animation frame so Leaflet fully settles pixel/world bounds
          // before any vector layer children mount and call _clipPoints / addLayer.
          if (!fanCanvasRenderer.current) {
            fanCanvasRenderer.current = L.canvas({ padding: 0.5, tolerance: 5 });
          }
          requestAnimationFrame(() => {
            setFanRendererReady(true);
            setMapReady(true);
          });
        }}
      >
        {tileLayerConfig?.base && (
          <TileLayer
            ref={(layer) => {
              if (layer && !(layer instanceof IntegerZoomTileLayer)) {
                Object.setPrototypeOf(layer, IntegerZoomTileLayer.prototype);
              }
            }}
            key={`base-${mapStyle}-${tileLayerInstanceKey}-${tileLayerConfig.base}`}
            attribution='&copy; <a href="https://www.here.com/">HERE</a>'
            url={tileLayerConfig.base}
            tileSize={512}
            zoomOffset={-1}
            maxNativeZoom={17}
            updateWhenZooming={false}
            keepBuffer={isMobile ? 1 : 2}
            className="integer-zoom-tile-layer"
          />
        )}
        {tileLayerConfig?.overlay && (
          <TileLayer
            ref={(layer) => {
              if (layer && !(layer instanceof IntegerZoomTileLayer)) {
                Object.setPrototypeOf(layer, IntegerZoomTileLayer.prototype);
              }
            }}
            key={`overlay-${mapStyle}-${tileLayerInstanceKey}-${tileLayerConfig.overlay}`}
            url={tileLayerConfig.overlay}
            tileSize={512}
            zoomOffset={-1}
            maxNativeZoom={17}
            opacity={1}
            updateWhenZooming={false}
            keepBuffer={isMobile ? 1 : 2}
            className="integer-zoom-tile-layer"
          />
        )}

        <MapController
          onMapInteraction={onMapInteraction}
          onDoubleTap={onDoubleTap}
          currentZoom={currentZoom}
          setCurrentZoom={setCurrentZoom}
          setShowZoomOverlay={setShowZoomOverlay}
          zoomOverlayTimeoutRef={zoomOverlayTimeoutRef}
          setMapCenter={setMapCenter}
          setMapZoom={setMapZoom}
          setVisibleBounds={setVisibleBounds}
          setFannedLocationKey={setFannedLocationKey}
          mapViewPhase={mapViewPhase}
          currentUser={currentUser}
          immersiveHidden={immersiveHidden}

        />

        <Pane name="routeBasePane" style={{ zIndex: 430 }} />
        <Pane name="activeRoutePane" style={{ zIndex: 450 }} />
        <Pane name="completedBreadcrumbPane" style={{ zIndex: 460 }} />
        <Pane name="currentLegPane" style={{ zIndex: 470 }} />

        {mapReady && !showBreadcrumbs && (showRoutes || (typeof window !== "undefined" && localStorage.getItem("rxdeliver_show_routes") === "true")) && (
          <CompletedBreadcrumbPolylines
            driverRoutes={completedRouteDriverRoutes}
            deliveryMarkers={completedRouteDeliveryMarkers}
            pickupMarkers={completedRoutePickupMarkers}
            driverHomeMarkers={driverHomeMarkers}
            selectedDriverId={selectedDriverId}
            isAllDriversMode={isAllDriversMode}
            highlightedDeliveryId={highlightedDeliveryId}
            polylineRenderKey={polylineRenderKey}
            showStoredPolylines={showRoutes}
            showBreadcrumbPolylines={false}
            driverTravelModes={driverTravelModes}
          />
        )}

        {currentDriverMarker && (
          <Marker key="current-driver-location" position={[currentDriverMarker.latitude, currentDriverMarker.longitude]} icon={createLiveLocationDot()} zIndexOffset={6000} eventHandlers={{ click: () => onMarkerClick?.(currentDriverMarker, "driver") }}>
            <Popup autoPan={false} closeButton={false} offset={[0, -10]} className="custom-popup">
              <div className="min-w-[150px]">
                <div className="font-semibold text-xs">Your Location</div>
                {currentDriverMarker.timestamp && <div className="text-[11px] text-gray-600">Updated: {format(new Date(currentDriverMarker.timestamp), "HH:mm:ss")}</div>}
              </div>
            </Popup>
          </Marker>
        )}

        {mapReady && (
          <DriverLocationMarkers users={routeAwareDriverLocationMarkers} currentUser={currentUser} activeDriver={null} deliveries={deliveriesForLocationFilter} selectedDate={selectedDate} />
        )}

        {mapReady && !showBreadcrumbs && (showRoutes || (typeof window !== "undefined" && localStorage.getItem("rxdeliver_show_routes") === "true")) && (
          <>
            <HereType2Polylines key={`type2-${selectedDriverId}-${selectedDate}-${showOtherDriverDeliveries ? "all" : "single"}`} isViewingCurrentDate={isViewingCurrentDate} deliveryMarkers={deliveryMarkers} pickupMarkers={pickupMarkers} driverRoutes={driverRoutes} multiDriverMode={selectedDriverId === "all" || showOtherDriverDeliveries} selectedDriverId={selectedDriverId} driverTravelModes={driverTravelModes} />
            <HereType1Polylines key={`type1-${selectedDriverId}-${selectedDate}-${showOtherDriverDeliveries ? "all" : "single"}`} isViewingCurrentDate={isViewingCurrentDate} deliveryMarkers={deliveryMarkers} pickupMarkers={pickupMarkers} driverHomeMarkers={driverHomeMarkers} currentDriverMarker={routeAwareCurrentDriverMarker} selectedDriverId={selectedDriverId} showAll={isAllDriversMode || showOtherDriverDeliveries} driverLocations={routeAwareDriverLocationMarkers} appUsers={safeUsers} driverTravelModes={driverTravelModes} selectedDate={selectedDate} isDispatcher={!!(currentUser && userHasRole(currentUser, "dispatcher") && !userHasRole(currentUser, "admin") && !userHasRole(currentUser, "driver"))} />
          </>
        )}

        {mapReady && (
          <HomeMarkers driverHomeMarkers={driverHomeMarkers} map={map} isMobile={isMobile} onMarkerClick={onMarkerClick} />
        )}

        {/* Fan lines: draw lines from cluster origin to each fanned marker */}
        {mapReady && fanRendererReady && fannedLocationKey && (() => {
          const [originLat, originLng] = fannedLocationKey.split(',').map(Number);
          if (!originLat || !originLng) return null;
          const pickupsAtLocation = groupedPickupMarkers.get(fannedLocationKey) || [];
          const deliveriesAtLocation = groupedDeliveryMarkers.get(fannedLocationKey) || [];
          const allAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation]
            .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
          return allAtLocation.map((marker, index) => {
            const [fanLat, fanLng] = calculateFannedPositionWrapperWrapper(originLat, originLng, index, allAtLocation.length);
            return (
              <Polyline
                key={`fan-line-${marker.id}`}
                positions={[[originLat, originLng], [fanLat, fanLng]]}
                renderer={fanCanvasRenderer.current}
                pathOptions={{ color: marker.pinColor || '#64748b', weight: 1.5, opacity: 0.5, dashArray: '4 4' }}
              />
            );
          });
        })()}

        {mapReady && (
          <PickupMarkers pickupMarkers={pickupMarkers} groupedPickupMarkers={groupedPickupMarkers} groupedDeliveryMarkers={groupedDeliveryMarkers} routeRenderKey={routeRenderKey} currentZoom={currentZoom} ZOOM_LEVELS={ZOOM_LEVELS} isMobile={isMobile} fannedLocationKey={fannedLocationKey} highlightedDeliveryId={highlightedDeliveryId} fadedMarkerHighlights={fadedMarkerHighlights} setFadedMarkerHighlights={setFadedMarkerHighlights} driversWithCompleteRoute={driversWithCompleteRoute} hasIncompleteStops={hasIncompleteStops} calculateFannedPositionWrapperWrapper={calculateFannedPositionWrapperWrapper} onMarkerClick={onMarkerClick} handleMarkerClickForFanning={handleMarkerClickForFanning} handleMarkerDragEnd={handleMarkerDragEnd} markerRefs={markerRefs} safeStores={safeStores} safePatients={safePatients} safeUsers={safeUsers} />
        )}

        {mapReady && (
          <DeliveryMarkers deliveryMarkers={deliveryMarkers} groupedDeliveryMarkers={groupedDeliveryMarkers} groupedPickupMarkers={groupedPickupMarkers} routeRenderKey={routeRenderKey} currentZoom={currentZoom} ZOOM_LEVELS={ZOOM_LEVELS} isMobile={isMobile} fannedLocationKey={fannedLocationKey} setFannedLocationKey={setFannedLocationKey} highlightedDeliveryId={highlightedDeliveryId} fadedMarkerHighlights={fadedMarkerHighlights} setFadedMarkerHighlights={setFadedMarkerHighlights} driversWithCompleteRoute={driversWithCompleteRoute} hasIncompleteStops={hasIncompleteStops} calculateFannedPositionWrapperWrapper={calculateFannedPositionWrapperWrapper} onMarkerClick={onMarkerClick} handleMarkerClickForFanning={handleMarkerClickForFanning} handleMarkerDragEnd={handleMarkerDragEnd} markerRefs={markerRefs} safeStores={safeStores} safePatients={safePatients} safeUsers={safeUsers} stores={stores} />
        )}

        {mapReady && showBreadcrumbs && <MapBreadcrumbs breadcrumbsData={breadcrumbsData} currentZoom={currentZoom} />}
      </MapContainer>

      <MapCrosshair stopCardsHeight={stableCrosshairHeightRef.current} statsCardHeight={isMobile ? (effectiveTopOverlayHeight || (isStatsCardExpanded ? 216 : 116)) : 0} isMobile={isMobile} immersiveHidden={immersiveHidden} />
    </div>
  );
}