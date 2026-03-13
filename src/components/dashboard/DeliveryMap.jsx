import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, Marker, Pane, Popup, Polyline, TileLayer } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { format } from "date-fns";
import { base44 } from "@/api/base44Client";
import { isMobileDevice } from "../utils/deviceUtils";
import { getStoreColor } from "../utils/colorGenerator";
import { userHasRole, isAppOwner } from "../utils/userRoles";
import MapCrosshair from "./MapCrosshair";
import MapController from "./MapController";
import DriverLocationMarkers from "./DriverLocationMarkers";
import HereType1Polylines from "./HereType1Polylines";
import HereType2Polylines from "./HereType2Polylines";
import CompletedBreadcrumbPolylines from "./CompletedBreadcrumbPolylines";
import PickupMarkers from "./PickupMarkers";
import DeliveryMarkers from "./DeliveryMarkers";
import HomeMarkers from "./HomeMarkers";
import MapBreadcrumbs from "./MapBreadcrumbs";
import { createLiveLocationDot } from "./MapIcons";
import { useRouteRecalcSignal } from "./useRouteRecalcSignal";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png"
});

const DRIVER_COLORS = ["", "#1E90FF", "#8A2BE2", "#00CED1", "#FF69B4", "#4B0082", "#A0522D"];
const FINISHED_STATUSES = ["completed", "failed", "cancelled"];
const ZOOM_LEVELS = { HIDE_ROUTES: 8, SIMPLIFY_ROUTES: 12, HIDE_NUMBERS: 11, HIDE_CIRCLES: 11, FULL_DETAIL: 13 };

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
    if (item?.id) map.set(item.id, item);
  });
  return Array.from(map.values());
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
  isMapViewLocked = false
}) {
  const safeDeliveries = Array.isArray(deliveries) ? deliveries : [];
  const safePatients = Array.isArray(patients) ? patients : [];
  const safeStores = Array.isArray(stores) ? stores : [];
  const isMobile = useMemo(() => isMobileDevice(), []);
  const [map, setMap] = useState(null);
  const [currentZoom, setCurrentZoom] = useState(zoom);
  const [visibleBounds, setVisibleBounds] = useState(null);
  const [showZoomOverlay, setShowZoomOverlay] = useState(false);
  const zoomOverlayTimeoutRef = useRef(null);
  const markerRefs = useRef({});
  const popupTimeoutsRef = useRef({});
  const legendRef = useRef(null);
  const [legendLeft, setLegendLeft] = useState(null);
  const [fannedLocationKey, setFannedLocationKey] = useState(null);
  const [fadedMarkerHighlights, setFadedMarkerHighlights] = useState(new Set());
  const [realtimeAppUsers, setRealtimeAppUsers] = useState(Array.isArray(users) ? users : []);
  const [otherDriverDeliveries, setOtherDriverDeliveries] = useState([]);
  const [routeRenderKey, setRouteRenderKey] = useState(0);
  const [polylineRenderKey, setPolylineRenderKey] = useState(0);
  const hasNotifiedMapReady = useRef(false);
  const prevDriverHomeMarkersRef = useRef([]);
  const prevDriverLocationMarkersRef = useRef([]);
  const prevDriverRoutesRef = useRef([]);

  const isViewingCurrentDate = useMemo(() => !selectedDate || selectedDate === getEdmDate(), [selectedDate]);
  const isAllDriversMode = useMemo(() => {
    if (!selectedDriverId || selectedDriverId === "all") return true;
    return new Set(safeDeliveries.map((d) => d?.driver_id).filter(Boolean)).size > 1;
  }, [selectedDriverId, safeDeliveries]);
  const isSingleDriverMode = !isAllDriversMode;
  const isDriverViewingSelfToday = useMemo(() => {
    if (!currentUser || !userHasRole(currentUser, "driver") || !selectedDriverId || selectedDriverId === "all") return false;
    return currentUser.id === selectedDriverId && (!selectedDate || selectedDate === getEdmDate());
  }, [currentUser, selectedDriverId, selectedDate]);

  const { routeLocationSnapshot, routeRecalcVersion } = useRouteRecalcSignal({
    currentDriverLocation,
    realtimeAppUsers,
    currentUserId: currentUser?.id
  });

  useEffect(() => {
    if (Array.isArray(users) && users.length > 0) setRealtimeAppUsers(users);
  }, [users]);

  useEffect(() => {
    if (!retractClustersRef) return;
    retractClustersRef.current = () => setFannedLocationKey(null);
  }, [retractClustersRef]);

  useEffect(() => {
    if (routeRecalcVersion === 0) return;
    setPolylineRenderKey((value) => value + 1);
  }, [routeRecalcVersion]);

  useEffect(() => {
    const handleDriverLocationUpdate = (event) => {
      const appUsers = event?.detail?.appUsers;
      if (!Array.isArray(appUsers) || appUsers.length === 0) return;
      setRealtimeAppUsers((prev) => {
        const next = new Map((prev || []).map((user) => [user?.id || user?.user_id, user]));
        appUsers.forEach((user) => {
          const key = user?.id || user?.user_id;
          if (key) next.set(key, { ...(next.get(key) || {}), ...user });
        });
        return Array.from(next.values());
      });
      setRouteRenderKey((value) => value + 1);
    };

    const handleDeliveriesUpdate = () => {
      prevDriverRoutesRef.current = [];
      setRouteRenderKey((value) => value + 1);
      setPolylineRenderKey((value) => value + 1);
      setFannedLocationKey(null);
    };

    window.addEventListener("driverLocationsUpdated", handleDriverLocationUpdate);
    window.addEventListener("deliveriesUpdated", handleDeliveriesUpdate);
    window.addEventListener("routeOptimizationComplete", handleDeliveriesUpdate);
    return () => {
      window.removeEventListener("driverLocationsUpdated", handleDriverLocationUpdate);
      window.removeEventListener("deliveriesUpdated", handleDeliveriesUpdate);
      window.removeEventListener("routeOptimizationComplete", handleDeliveriesUpdate);
    };
  }, []);

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
    if (Array.isArray(realtimeAppUsers) && realtimeAppUsers.length > 0) return realtimeAppUsers;
    return Array.isArray(users) ? users : [];
  }, [realtimeAppUsers, users]);

  const driverLookupMap = useMemo(() => {
    const map = new Map();
    safeUsers.forEach((user) => {
      if (user?.id) map.set(user.id, user);
      if (user?.user_id) map.set(user.user_id, user);
    });
    return map;
  }, [safeUsers]);

  const deliveriesToShow = useMemo(() => {
    if (!showOtherDriverDeliveries || otherDriverDeliveries.length === 0) return safeDeliveries;
    return dedupeById([...safeDeliveries, ...otherDriverDeliveries]);
  }, [safeDeliveries, otherDriverDeliveries, showOtherDriverDeliveries]);

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

  const { pickupMarkers, groupedPickupMarkers, deliveryMarkers, groupedDeliveryMarkers, hasIncompleteStops } = useMemo(() => {
    const pickups = [];
    const deliveriesOut = [];
    const allMarkers = [];
    const hasIncomplete = deliveriesToShow.some((delivery) => delivery && !FINISHED_STATUSES.includes(delivery.status));

    deliveriesToShow.forEach((delivery) => {
      if (!delivery) return;
      const store = safeStores.find((item) => item?.id === delivery.store_id) || null;
      const driver = driverLookupMap.get(delivery.driver_id) || (delivery.driver_name ? { id: delivery.driver_id, user_name: delivery.driver_name, full_name: delivery.driver_name } : null);
      const isOtherDriver = !!(selectedDriverId && selectedDriverId !== "all" && delivery.driver_id !== selectedDriverId);
      const isCurrentUserDispatcher = currentUser && userHasRole(currentUser, "dispatcher");
      const isStopInDispatcherStore = !!(isCurrentUserDispatcher && currentUser?.store_ids?.includes(delivery.store_id));

      if (delivery.patient_id) {
        const patient = safePatients.find((item) => item?.id === delivery.patient_id) || null;
        if (!patient?.latitude || !patient?.longitude) return;
        const marker = {
          ...delivery,
          latitude: patient.latitude,
          longitude: patient.longitude,
          patient,
          driver,
          store,
          pinColor: isStopInDispatcherStore
            ? (store ? getStoreColor(store) : "#6B7280")
            : isAllDriversMode
              ? getDriverColor(driver || { id: delivery.driver_id || delivery.id })
              : (store ? getStoreColor(store) : "#6B7280"),
          number: delivery.display_stop_order || delivery.stop_order || 0,
          isFirstTime: !!delivery.first_delivery,
          isNextInLine: !!delivery.isNextDelivery,
          markerType: "delivery",
          useSimpleCircle: (isCurrentUserDispatcher && !isStopInDispatcherStore) || (showOtherDriverDeliveries && isOtherDriver),
          isOtherDriver,
          isReturn: `${patient?.full_name || delivery.patient_name || ""}`.toLowerCase().includes("return")
        };
        deliveriesOut.push(marker);
        allMarkers.push(marker);
        return;
      }

      if (!store?.latitude || !store?.longitude) return;
      const marker = {
        ...delivery,
        latitude: store.latitude,
        longitude: store.longitude,
        store,
        driver,
        pinColor: getStoreColor(store),
        number: delivery.display_stop_order || delivery.stop_order || 0,
        markerType: "pickup",
        useSimpleCircle: false,
        isOtherDriver
      };
      pickups.push(marker);
      allMarkers.push(marker);
    });

    const counts = new Map();
    allMarkers.forEach((marker) => {
      const key = getLocationKey(marker.latitude, marker.longitude, currentZoom);
      counts.set(key, (counts.get(key) || 0) + 1);
    });

    const groupedPickupsMap = new Map();
    const groupedDeliveriesMap = new Map();

    const withCounts = (marker) => ({ ...marker, duplicateCount: counts.get(getLocationKey(marker.latitude, marker.longitude, currentZoom)) || 1 });

    const pickupMarkersWithCounts = pickups.map(withCounts);
    const deliveryMarkersWithCounts = deliveriesOut.map(withCounts);

    pickupMarkersWithCounts.forEach((marker) => {
      const key = getLocationKey(marker.latitude, marker.longitude, currentZoom);
      if (!groupedPickupsMap.has(key)) groupedPickupsMap.set(key, []);
      groupedPickupsMap.get(key).push(marker);
    });

    deliveryMarkersWithCounts.forEach((marker) => {
      const key = getLocationKey(marker.latitude, marker.longitude, currentZoom);
      if (!groupedDeliveriesMap.has(key)) groupedDeliveriesMap.set(key, []);
      groupedDeliveriesMap.get(key).push(marker);
    });

    return {
      pickupMarkers: pickupMarkersWithCounts,
      groupedPickupMarkers: groupedPickupsMap,
      deliveryMarkers: deliveryMarkersWithCounts,
      groupedDeliveryMarkers: groupedDeliveriesMap,
      hasIncompleteStops: hasIncomplete
    };
  }, [deliveriesToShow, safeStores, safePatients, driverLookupMap, selectedDriverId, currentUser, showOtherDriverDeliveries, isAllDriversMode, currentZoom]);

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
      if (isMobile && isSelf) return null;
      if (!isSelf && user.location_tracking_enabled !== true) return null;
      if (!isAdmin && currentUserCityId && user.city_id && user.city_id !== currentUserCityId) return null;
      const resolvedDriverName = driverNameLookupMap.get(user.id) || driverNameLookupMap.get(user.user_id) || user.user_name || user.full_name || "Driver";

      if (isDispatcher) {
        const dispatcherStoreIds = new Set(currentUser?.store_ids || []);
        const hasVisibleDelivery = (deliveriesForLocationFilter || []).some((delivery) => delivery?.driver_id === user.id && delivery?.delivery_date === today && dispatcherStoreIds.has(delivery.store_id) && ["en_route", "in_transit", "pending"].includes(delivery.status));
        if (!hasVisibleDelivery) return null;
      }

      if (!isAdmin && !isDriver && !isDispatcher) return null;

      return {
        id: user.id,
        user_id: user.id,
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
    [...deliveryMarkers, ...pickupMarkers].forEach((stop) => {
      if (!stop?.driver_id) return;
      if (!byDriver.has(stop.driver_id)) byDriver.set(stop.driver_id, { completed: 0, remainingPickups: 0, remainingDeliveries: 0 });
      const state = byDriver.get(stop.driver_id);
      if (FINISHED_STATUSES.includes(stop.status)) {
        state.completed += 1;
      } else if (stop.markerType === "pickup") {
        state.remainingPickups += 1;
      } else if (stop.markerType === "delivery") {
        state.remainingDeliveries += 1;
      }
    });

    const visibilityMap = new Map();
    byDriver.forEach((state, driverId) => {
      const shouldShowHomeMarker = state.completed === 0 || state.remainingPickups === 0;
      visibilityMap.set(driverId, { ...state, shouldShowHomeMarker });
    });
    return visibilityMap;
  }, [deliveryMarkers, pickupMarkers]);

  const driverHomeMarkers = useMemo(() => {
    const hideHomeMarkersForDispatcher = currentUser && userHasRole(currentUser, "dispatcher") && !userHasRole(currentUser, "admin");
    const isPureDriver = currentUser && userHasRole(currentUser, "driver") && !userHasRole(currentUser, "admin") && !userHasRole(currentUser, "dispatcher");

    if (!showRoutes || !currentUser || hideHomeMarkersForDispatcher || (selectedDate && selectedDate < getEdmDate())) {
      prevDriverHomeMarkersRef.current = [];
      return [];
    }

    const visibleDriverIds = new Set([...deliveryMarkers, ...pickupMarkers].map((stop) => stop?.driver_id).filter(Boolean));
    const items = safeUsers.filter((user) => visibleDriverIds.has(user.id) && user.home_latitude && user.home_longitude && user.driver_status !== "off_duty").filter((user) => {
      const homeVisibility = driverHomeVisibilityById.get(user.id);
      if (!homeVisibility?.shouldShowHomeMarker) return false;
      if (isPureDriver && user.id !== currentUser.id && !(showOtherDriverDeliveries || isAllDriversMode)) return false;
      if (showOtherDriverDeliveries || isAllDriversMode) return true;
      return user.id === selectedDriverId || user.id === currentUser.id;
    }).map((user) => ({
      id: `home-${user.id}`,
      driverId: user.id,
      driver: user,
      latitude: user.home_latitude,
      longitude: user.home_longitude,
      driverColor: getDriverColor(user),
      driverName: user.user_name || user.full_name || "Unknown Driver",
      excludeFromBounds: false,
      isRouteComplete: driversWithCompleteRoute.has(user.id)
    }));

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

    const routes = Array.from(byDriver.values()).sort((a, b) => a.sortOrder - b.sortOrder).map((route) => {
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
        totalStops: stops.filter((stop) => stop.markerType === "delivery").length + stops.filter((stop) => stop.after_hours_pickup && ["completed", "cancelled"].includes(stop.status)).length,
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

  useEffect(() => {
    if (!map || !shouldFitBounds) return;
    try {
      const bounds = L.latLngBounds((Array.isArray(shouldFitBounds.bounds) ? shouldFitBounds.bounds : []).filter((point) => Array.isArray(point) && point.length === 2 && Number.isFinite(point[0]) && Number.isFinite(point[1])));
      if (!bounds.isValid()) return;
      map.fitBounds(bounds, { ...(shouldFitBounds.options || {}), paddingTopLeft: shouldFitBounds.options?.paddingTopLeft || [60, 60], paddingBottomRight: shouldFitBounds.options?.paddingBottomRight || [60, 60], animate: true, duration: 0.8 });
      onBoundsFitted?.();
    } catch {}
  }, [map, shouldFitBounds, onBoundsFitted]);

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

  const handleMarkerClickForFanning = useCallback((marker, markerType) => {
    const locationKey = getLocationKey(marker.latitude, marker.longitude, currentZoom);
    if (marker.duplicateCount > 1) {
      onMapInteraction?.();
      if (fannedLocationKey === locationKey) return setFannedLocationKey(null);
      const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
      const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
      const markersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation].sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
      if (map) {
        const bounds = L.latLngBounds([]);
        markersAtLocation.forEach((item, index) => {
          const [lat, lng] = calculateFannedPositionWrapperWrapper(marker.latitude, marker.longitude, index, markersAtLocation.length);
          bounds.extend([lat, lng]);
        });
        if (bounds.isValid()) map.fitBounds(bounds, { paddingTopLeft: [80, 350], paddingBottomRight: [80, 80], maxZoom: 14, animate: true, duration: 0.6 });
        setTimeout(() => setFannedLocationKey(locationKey), 650);
      } else {
        setFannedLocationKey(locationKey);
      }
      return;
    }

    setFannedLocationKey(null);
    if (marker.status === "pending" && marker.puid) {
      const assignedPickup = pickupMarkers.find((pickup) => pickup?.stop_id === marker.puid);
      if (assignedPickup && onMarkerClick) return onMarkerClick(assignedPickup);
    }
    onMarkerClick?.(marker, markerType);
    onMapInteraction?.();
  }, [currentZoom, fannedLocationKey, groupedDeliveryMarkers, groupedPickupMarkers, calculateFannedPositionWrapperWrapper, map, onMarkerClick, onMapInteraction, pickupMarkers]);

  return (
    <div className="absolute inset-0">
      <MapContainer
        center={center || [53.5461, -113.4938]}
        zoom={zoom || (safeDeliveries.length === 0 ? 11 : 12)}
        maxZoom={17.5}
        zoomSnap={0}
        zoomDelta={0.1}
        style={{ height: "100%", width: "100%" }}
        zoomControl={false}
        onClick={() => setFannedLocationKey(null)}
        whenReady={(instance) => {
          setMap(instance.target);
          setCurrentZoom(instance.target.getZoom());
          setVisibleBounds(instance.target.getBounds());
        }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url={document.documentElement.classList.contains("dark-theme") || (document.documentElement.classList.contains("auto-theme") && window.matchMedia("(prefers-color-scheme: dark)").matches)
            ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            : "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"}
        />

        <MapController
          onMapInteraction={onMapInteraction}
          onDoubleTap={onDoubleTap}
          currentZoom={currentZoom}
          setCurrentZoom={setCurrentZoom}
          setShowZoomOverlay={setShowZoomOverlay}
          zoomOverlayTimeoutRef={zoomOverlayTimeoutRef}
          setMapCenter={() => {}}
          setVisibleBounds={setVisibleBounds}
          setFannedLocationKey={setFannedLocationKey}
        />

        <Pane name="routeBasePane" style={{ zIndex: 430 }} />
        <Pane name="completedBreadcrumbPane" style={{ zIndex: 460 }} />

        {(showRoutes || showBreadcrumbs || (typeof window !== "undefined" && localStorage.getItem("rxdeliver_show_routes") === "true")) && (
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

        {currentDriverMarker && (
          <Marker
            key="current-driver-location"
            position={[currentDriverMarker.latitude, currentDriverMarker.longitude]}
            icon={createLiveLocationDot()}
            zIndexOffset={6000}
            eventHandlers={{ click: () => onMarkerClick?.(currentDriverMarker, "driver") }}
          >
            <Popup autoPan={false} closeButton={false} offset={[0, -10]} className="custom-popup">
              <div className="min-w-[150px]">
                <div className="font-semibold text-xs">Your Location</div>
                {currentDriverMarker.timestamp && (
                  <div className="text-[11px] text-gray-600">Updated: {format(new Date(currentDriverMarker.timestamp), "HH:mm:ss")}</div>
                )}
              </div>
            </Popup>
          </Marker>
        )}

        <DriverLocationMarkers
          users={routeAwareDriverLocationMarkers}
          currentUser={currentUser}
          activeDriver={null}
          deliveries={deliveriesForLocationFilter}
          selectedDate={selectedDate}
        />

        {(showRoutes || (typeof window !== "undefined" && localStorage.getItem("rxdeliver_show_routes") === "true")) && (
          <>
            <HereType2Polylines
              key={`type2-${selectedDriverId}-${selectedDate}-${showOtherDriverDeliveries ? "all" : "single"}`}
              isViewingCurrentDate={isViewingCurrentDate}
              deliveryMarkers={deliveryMarkers}
              pickupMarkers={pickupMarkers}
              driverRoutes={driverRoutes}
              multiDriverMode={selectedDriverId === "all" || showOtherDriverDeliveries}
              selectedDriverId={selectedDriverId}
            />
            <HereType1Polylines
              key={`type1-${selectedDriverId}-${selectedDate}-${showOtherDriverDeliveries ? "all" : "single"}-${routeRecalcVersion}`}
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

        <PickupMarkers
          pickupMarkers={pickupMarkers}
          groupedPickupMarkers={groupedPickupMarkers}
          groupedDeliveryMarkers={groupedDeliveryMarkers}
          routeRenderKey={routeRenderKey}
          currentZoom={currentZoom}
          ZOOM_LEVELS={ZOOM_LEVELS}
          isMobile={isMobile}
          fannedLocationKey={fannedLocationKey}
          highlightedDeliveryId={highlightedDeliveryId}
          fadedMarkerHighlights={fadedMarkerHighlights}
          setFadedMarkerHighlights={setFadedMarkerHighlights}
          driversWithCompleteRoute={driversWithCompleteRoute}
          hasIncompleteStops={hasIncompleteStops}
          calculateFannedPositionWrapperWrapper={calculateFannedPositionWrapperWrapper}
          onMarkerClick={onMarkerClick}
          handleMarkerClickForFanning={handleMarkerClickForFanning}
          handleMarkerDragEnd={handleMarkerDragEnd}
          markerRefs={markerRefs}
          safeStores={safeStores}
          safePatients={safePatients}
          safeUsers={safeUsers}
        />

        <DeliveryMarkers
          deliveryMarkers={deliveryMarkers}
          groupedDeliveryMarkers={groupedDeliveryMarkers}
          groupedPickupMarkers={groupedPickupMarkers}
          routeRenderKey={routeRenderKey}
          currentZoom={currentZoom}
          ZOOM_LEVELS={ZOOM_LEVELS}
          isMobile={isMobile}
          fannedLocationKey={fannedLocationKey}
          setFannedLocationKey={setFannedLocationKey}
          highlightedDeliveryId={highlightedDeliveryId}
          fadedMarkerHighlights={fadedMarkerHighlights}
          setFadedMarkerHighlights={setFadedMarkerHighlights}
          driversWithCompleteRoute={driversWithCompleteRoute}
          hasIncompleteStops={hasIncompleteStops}
          calculateFannedPositionWrapperWrapper={calculateFannedPositionWrapperWrapper}
          onMarkerClick={onMarkerClick}
          handleMarkerClickForFanning={handleMarkerClickForFanning}
          handleMarkerDragEnd={handleMarkerDragEnd}
          markerRefs={markerRefs}
          safeStores={safeStores}
          safePatients={safePatients}
          safeUsers={safeUsers}
          stores={stores}
        />

        {showBreadcrumbs && <MapBreadcrumbs breadcrumbsData={breadcrumbsData} currentZoom={currentZoom} safeUsers={safeUsers} />}
      </MapContainer>

      <MapCrosshair stopCardsHeight={areStopCardsVisible ? stopCardsHeight : 0} statsCardHeight={isMobile ? (isStatsCardExpanded ? 216 : 116) : 0} isMobile={isMobile} />
    </div>
  );
}