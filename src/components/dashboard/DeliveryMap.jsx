import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMapEvents, Circle } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { getStoreColor, hexToRgba } from '../utils/colorGenerator';
import { sortUsers } from '../utils/sorting';
import { MapPin, Phone, Clock, Package, Truck, StickyNote, UserRoundSearch, Car, Home, Navigation, Activity, User, CheckCircle2, XCircle } from 'lucide-react';
import { userHasRole, isAppOwner } from '../utils/userRoles';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { format } from 'date-fns';
import { isMobileDevice } from '../utils/deviceUtils';
import MapCrosshair from './MapCrosshair';
import DeliveryPopup from './DeliveryPopup';
import { base44 } from '@/api/base44Client';
import { formatPhoneNumber } from '../utils/phoneFormatter';
import DriverLocationMarkers from './DriverLocationMarkers';
import MapController from './MapController';
import HereType1Polylines from './HereType1Polylines';
import HereType2Polylines from './HereType2Polylines';
import PickupMarkers from './PickupMarkers';
import DeliveryMarkers from './DeliveryMarkers';
import HomeMarkers from './HomeMarkers';
import MapBreadcrumbs from './MapBreadcrumbs';
import { createSimpleCircleIcon, createStoreIcon, createDeliveryIcon, createLiveLocationDot, createHomeIcon } from './MapIcons';

// Fix for default icon issue with Webpack
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png'
});

// Driver color palette for "All Drivers" mode - 6 highly distinct colors
// Avoids: greens (completed status), reds/oranges (failed status), yellows
const DRIVER_COLORS = [
  '', // Index 0 - not used, to align with 1-based sort_order/hashing
  '#1E90FF', // Dodger Blue (Index 1)
  '#8A2BE2', // Blue Violet (Index 2)
  '#00CED1', // Dark Cyan/Teal (Index 3)
  '#FF69B4', // Hot Pink (Index 4)
  '#4B0082', // Indigo (Index 5)
  '#A0522D'  // Sienna - Reddish-Brown (Index 6)
];

// Helper function to determine text color for driver colors
const getDriverTextColor = (driverColor) => {
  // Light colors need black text for readability
  if (driverColor === '#00CED1' || driverColor === '#FF69B4') return 'black';
  return 'white';
};

// NEW: Zoom level thresholds for dynamic display
const ZOOM_LEVELS = {
  HIDE_ROUTES: 8, // Below this, hide routes completely (was 10)
  SIMPLIFY_ROUTES: 12, // Below this, simplify route lines
  HIDE_NUMBERS: 11, // Below this, hide stop numbers
  HIDE_CIRCLES: 11, // Below this, hide pickup circles
  FULL_DETAIL: 13 // At or above this, show full detail
};

// Shared finished statuses array
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];

// Generate consistent driver color based on driver's sort_order
// EXPORT this function so it can be imported by Dashboard.jsx
export const getDriverColor = (driver) => {
  if (!driver || typeof driver !== 'object' || !driver.id) {
    console.warn('[DeliveryMap] getDriverColor: Invalid driver or missing ID:', driver);
    return '#607D8B'; // Default blue-grey for invalid/unassigned
  }

  const numFixedColors = DRIVER_COLORS.length - 1; // Exclude the empty index 0

  let effectiveIndex;
  // Prioritize sort_order for fixed colors if provided and positive
  if (typeof driver.sort_order === 'number' && driver.sort_order > 0 && driver.sort_order <= numFixedColors) {
    effectiveIndex = driver.sort_order;
  } else {
    // If sort_order is missing, zero, or beyond fixed palette, use hash of ID for more consistent assignment
    let hash = 0;
    const idString = driver.id.toString();
    for (let i = 0; i < idString.length; i++) {
      hash = idString.charCodeAt(i) + ((hash << 5) - hash);
    }
    effectiveIndex = (Math.abs(hash) % numFixedColors) + 1; // Map hash to 1-based index within fixed palette
  }

  // Try to use a color from the fixed palette first
  // If the effectiveIndex maps to a valid slot in DRIVER_COLORS (1 to numFixedColors), use it.
  if (effectiveIndex >= 1 && effectiveIndex <= numFixedColors && DRIVER_COLORS[effectiveIndex]) {
    return DRIVER_COLORS[effectiveIndex];
  } else {
    // If sort_order maps to an index outside the fixed palette, or if there are more drivers than fixed colors
    // Generate an HSL color based on the hash of the driver ID
    // Restrict hues to cool colors only (avoid greens, reds, oranges, yellows)
    // Safe hue ranges: Blues (190-280), some purples/magentas (280-330)
    const idHash = Math.abs(driver.id.split('').reduce((acc, char) => (acc * 31) + char.charCodeAt(0), 0));
    const safeHueMin = 190; // Start from blue
    const safeHueRange = 140; // 190-330 gives us blues, cyans, purples, and magentas
    const hue = safeHueMin + (idHash % safeHueRange);
    return `hsl(${hue}, 70%, 50%)`; // Bright, vibrant colors with good saturation
  }
};

const getEdmDate = () => { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); return `${p.find(x=>x.type==='year').value}-${p.find(x=>x.type==='month').value}-${p.find(x=>x.type==='day').value}`; };
const isFirstTimeDelivery = (d) => d.first_delivery || false;

export default function DeliveryMap({
  deliveries = [],
  allDeliveriesForDate = [], // NEW PROP: All deliveries for the selected date, regardless of driver
  selectedDriverId = null, // NEW PROP: The ID of the currently selected driver for filtering
  selectedDate = null, // NEW PROP: The selected date (yyyy-MM-dd)
  patients = [],
  stores = [],
  users = [], // This `users` prop is crucial, it contains merged AppUser data
  currentUser,
  driverLocations = [], // Other driver locations - controlled by "Show All" checkbox
  showOtherDriverDeliveries = false, // NEW: Whether to show other drivers' delivery/pickup markers
  currentDriverLocation = null, // NEW: Single driver location for current user
  deliveriesForLocationFilter = [], // NEW: Deliveries for filtering shared location markers
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
  onMapInteraction = () => {}, // NEW: Callback for any map interaction (zoom, pan, cluster click)
  onDoubleTap = () => {}, // NEW: Callback for double-tap on map
  retractClustersRef, // NEW: Ref to allow parent to retract clusters
  stopCardsHeight = 75, // Height of the stop cards container (passed from Dashboard)
  currentToNextPolyline = null, // NEW: Google Maps polyline from current position to next stop
  showBreadcrumbs = false, // NEW: Whether to show breadcrumb trails
  breadcrumbsData = { historical: [], current: [] }, // NEW: Breadcrumbs data {historical: DeliveryBreadcrumbs[], current: []}
  statsCardPositioning = '', // NEW: CSS classes for stats card positioning
  isStatsCardExpanded = false, // NEW: Whether stats card is expanded
  statsCardRect = null, // NEW: Stats card bounding rect for legend positioning
  highlightedDeliveryId = null, // NEW: ID of delivery to highlight (from card hover/selection)
  areStopCardsVisible = false, // NEW: Whether stop cards are visible
  onDriverRoutesCalculated = () => {}, // NEW: Callback to pass driver routes to parent
  onMapReady = () => {}, // NEW: Callback when ALL map elements are rendered
  mapViewPhase = 1,
  isMapViewLocked = false
  }) {
  const mapRef = useRef(null);
  const [map, setMap] = useState(null);
  const [hoveredMarkerId, setHoveredMarkerId] = useState(null);
  const [fadedMarkerHighlights, setFadedMarkerHighlights] = useState(new Set()); // markers hovered/clicked while faded
  const markerRefs = useRef({});
  const [hasInitialFit, setHasInitialFit] = useState(false);
  const [currentZoom, setCurrentZoom] = useState(zoom);
  const isMobile = useMemo(() => isMobileDevice(), []); // MODIFIED: Use isMobileDevice utility function
  const [highlightedRouteId, setHighlightedRouteId] = useState(null);
  const [fannedLocationKey, setFannedLocationKey] = useState(null);
  const legendRef = useRef(null);
  const [legendLeft, setLegendLeft] = useState(null);

  useEffect(() => {
    if (retractClustersRef) {
      retractClustersRef.current = () => setFannedLocationKey(null);
    }
  }, [retractClustersRef]);

  const [showZoomOverlay, setShowZoomOverlay] = useState(false);
  const zoomOverlayTimeoutRef = useRef(null);
  const popupTimeoutRef = useRef(null);
  const [mapCenter, setMapCenter] = useState(center);
  const [visibleBounds, setVisibleBounds] = useState(null);
  const [realtimeAppUsers, setRealtimeAppUsers] = useState(users);

  // Add safety checks for required props - MUST be before useEffect that uses them
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

  // State to force re-render of driverRoutes when deliveries update
  const [routeRenderKey, setRouteRenderKey] = useState(0);

  // Listen for screen orientation/size changes to update map view based on current FAB phase
  useEffect(() => {
    if (!map) return;
    
    const handleResize = () => {
      // Dispatch event to trigger FAB phase re-application
      window.dispatchEvent(new CustomEvent('screenResized'));
    };
    
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);
    
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, [map]);

  // State to force re-render of polylines when driver locations change
  const [polylineRenderKey, setPolylineRenderKey] = useState(0);
  
  // CRITICAL: Force polyline update when currentDriverLocation changes (live GPS on primary device)
  useEffect(() => {
    if (currentDriverLocation?.latitude && currentDriverLocation?.longitude) {
      setPolylineRenderKey(prev => prev + 1);
    }
  }, [currentDriverLocation?.latitude, currentDriverLocation?.longitude]);
  
  // CRITICAL: Create stable dependency string for location tracking
  const realtimeLocationKey = useMemo(() => {
    if (!realtimeAppUsers || realtimeAppUsers.length === 0) return '';
    return realtimeAppUsers.map(u => `${u?.id}:${u?.current_latitude?.toFixed(4)}:${u?.current_longitude?.toFixed(4)}`).join('|');
  }, [realtimeAppUsers]);
  
  // CRITICAL: Force polyline update when realtimeAppUsers location data changes
  useEffect(() => {
    if (!realtimeLocationKey) return;
    
    console.log(`🔵 [Polyline Trigger] realtimeAppUsers location changed - forcing Type 1 polyline re-render`);
    setPolylineRenderKey(prev => prev + 1);
  }, [realtimeLocationKey]);
  
  // Listen for real-time driver location updates from SmartRefreshManager
  useEffect(() => {
    const handleDriverLocationUpdate = (event) => {
      const { appUsers, singleUpdate, mergeMode } = event.detail;

      const mergeUsers = (prev, updates) => {
        if (!prev?.length) return updates;
        const map = new Map(updates.map(u => [u?.id || u?.user_id, u]));
        const merged = prev.map(u => { const k = u?.id || u?.user_id; return k && map.has(k) ? map.get(k) : u; });
        updates.forEach(u => { const k = u?.id || u?.user_id; if (k && !prev.some(p => (p?.id || p?.user_id) === k)) merged.push(u); });
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
        setPolylineRenderKey(p => p + 1);
        setRouteRenderKey(p => p + 1);
        return;
      }
    };

    const handleDeliveriesUpdate = () => { prevDriverRoutesRef.current = []; setRouteRenderKey(p=>p+1); setPolylineRenderKey(p=>p+1); setFannedLocationKey(null); };
    const handleRouteOptimizationComplete = handleDeliveriesUpdate;

    window.addEventListener('driverLocationsUpdated', handleDriverLocationUpdate);
    window.addEventListener('deliveriesUpdated', handleDeliveriesUpdate);
    window.addEventListener('routeOptimizationComplete', handleRouteOptimizationComplete);
    return () => {
      window.removeEventListener('driverLocationsUpdated', handleDriverLocationUpdate);
      window.removeEventListener('deliveriesUpdated', handleDeliveriesUpdate);
      window.removeEventListener('routeOptimizationComplete', handleRouteOptimizationComplete);
    };
  }, []);

  // CRITICAL: Determine mode BEFORE processing markers - must be defined first
  // Use stable string comparison to prevent unnecessary recalculations
  const isAllDriversMode = useMemo(() => {
    if (!selectedDriverId || selectedDriverId === 'all') return true;
    if (!safeDeliveries || safeDeliveries.length === 0) return false;
    const uniqueDriverIds = new Set(safeDeliveries.map((delivery) => delivery?.driver_id).filter(Boolean));
    return uniqueDriverIds.size > 1;
  }, [selectedDriverId, safeDeliveries.length]);

  // CRITICAL: Use isAllDriversMode calculated above
  const isSingleDriverMode = useMemo(() => !isAllDriversMode, [isAllDriversMode]);

  // CRITICAL: Check if current user is a driver viewing their own route (any date)
  const isDriverViewingSelf = useMemo(() => {
    if (!currentUser || !userHasRole(currentUser, 'driver')) return false;
    if (!selectedDriverId || selectedDriverId === 'all') return false;
    return selectedDriverId === currentUser.id;
  }, [currentUser, selectedDriverId]);

  // Legacy: Keep for backwards compatibility with home route logic (today only)
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
        const uniqueDriverIds = new Set([...safeDeliveries, ...otherDriverDeliveries].filter(d=>d?.driver_id).map(d=>d.driver_id));
        if (!uniqueDriverIds.size) return;
        const { offlineDB } = await import('./../../components/utils/offlineDatabase');
        const allAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
        if (!allAppUsers?.length) return;
        setRealtimeAppUsers(prev => {
          const existingMap = new Map(prev.map(u => [u.id, u]));
          allAppUsers.forEach(au => { if (uniqueDriverIds.has(au.id) && !existingMap.has(au.id)) existingMap.set(au.id, au); });
          return Array.from(existingMap.values());
        });
      } catch (e) {}
    })();
  }, [selectedDate, safeDeliveries.length, otherDriverDeliveries.length]);

  // CRITICAL: Listen for deliveriesImported AND deliveriesUpdated events to refresh other drivers' markers
  useEffect(() => {
    const handleDeliveriesImported = (event) => {
      const { deliveries: importedDeliveries } = event.detail || {};
      
      // If deliveries array is provided, use it directly to update otherDriverDeliveries
      if (importedDeliveries && importedDeliveries.length > 0 && showOtherDriverDeliveries && currentUser) {
        const others = importedDeliveries.filter(d => d && d.driver_id && d.driver_id !== currentUser.id);
        setOtherDriverDeliveries(others);
      }
    };
    
    // CRITICAL: Also refresh markers when deliveries are updated via smart refresh or Pull to Sync
    const handleDeliveriesUpdatedForMarkers = async (event) => {
      const { triggeredBy, allDrivers, source, fromOtherDriver } = event.detail || {};
      
      // CRITICAL: Accept 'deliveriesImported' from real-time sync to update placeholder markers
      const isAllDriversUpdate = allDrivers || 
                                  fromOtherDriver ||
                                  triggeredBy === 'pullToSyncComplete' || 
                                  triggeredBy === 'periodicRefresh' || 
                                  triggeredBy === 'manualRefresh' ||
                                  source === 'realtime_sync' ||
                                  source === 'route_importer';
      
      // Only refresh if this update affects all drivers OR from another driver
      if (!isAllDriversUpdate) {
        return;
      }
      
      // Only refresh if showing other drivers
      if (!showOtherDriverDeliveries && selectedDriverId !== 'all') {
        return;
      }
      
      // Skip if no date selected
      if (!selectedDate) {
        return;
      }
      
      try {
        console.log(`🔄 [DeliveryMap] Refreshing markers from offline DB - triggered by ${triggeredBy || 'unknown'}, allDrivers: ${allDrivers}, fromOtherDriver: ${fromOtherDriver}`);
        
        // Load from offline DB (already updated by smart refresh/Pull to Sync/Real-time)
        const { offlineDB } = await import('./../../components/utils/offlineDatabase');
        let allDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDate);
        
        if (allDeliveries && allDeliveries.length > 0) {
          const others = allDeliveries.filter(d => d && d.driver_id && d.driver_id !== selectedDriverId);
          console.log(`✅ [DeliveryMap] Updated otherDriverDeliveries with ${others.length} markers`);
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
      // CRITICAL: Fetch when showOtherDriverDeliveries is true (checkbox checked)
      // Works for ANY user viewing a specific driver (not just drivers viewing self)
      if (!selectedDate || !showOtherDriverDeliveries || !selectedDriverId || selectedDriverId === 'all') {
        // CRITICAL: Clear markers when checkbox is unchecked
        if (!showOtherDriverDeliveries && otherDriverDeliveries.length > 0) {
          setOtherDriverDeliveries([]);
        }
        return;
      }

      try {
        // CRITICAL: Load from offline DB first to prevent rate limiting
        const { offlineDB } = await import('./../../components/utils/offlineDatabase');
        let allDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDate);
        
        // Fallback to API if offline DB doesn't have data for this date
        if (!allDeliveries || allDeliveries.length === 0) {
          const { base44 } = await import('@/api/base44Client');
          allDeliveries = await base44.entities.Delivery.filter({
            delivery_date: selectedDate
          });
          // Save to offline DB for future
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allDeliveries);
        } else {
        }
        
        // Filter to exclude the currently selected driver's deliveries
        const others = allDeliveries.filter(d => d && d.driver_id && d.driver_id !== selectedDriverId);
        
        // CRITICAL: ALWAYS update to force React re-render - use new array reference
        setOtherDriverDeliveries([...others]);
      } catch (error) {
        console.error('❌ [DeliveryMap] Failed to load other drivers:', error);
      }
    };

    fetchOtherDrivers();
  }, [selectedDriverId, selectedDate, showOtherDriverDeliveries]);

  const { pickups, patientDeliveries } = useMemo(() => {
    let deliveriesToShow = safeDeliveries;
    
    // CRITICAL: Include other drivers' deliveries when showOtherDriverDeliveries is true (checkbox checked)
    // Works for ANY user viewing a specific driver (admin, driver, etc.)
    if (showOtherDriverDeliveries && otherDriverDeliveries.length > 0) {
      
      // CRITICAL: De-duplicate by delivery ID to prevent duplicate markers
      const deliveriesById = new Map();
      
      // First, add all main deliveries
      safeDeliveries.forEach(d => {
        if (d && d.id) {
          deliveriesById.set(d.id, d);
        }
      });
      
      // Then, add other drivers' deliveries (won't override existing)
      otherDriverDeliveries.forEach(d => {
        if (d && d.id && !deliveriesById.has(d.id)) {
          deliveriesById.set(d.id, d);
        }
      });
      
      deliveriesToShow = Array.from(deliveriesById.values());
    }
    
    const pickups = deliveriesToShow.filter((d) => d && !d.patient_id && d.store_id);
    const patientDeliveries = deliveriesToShow.filter((d) => d && d.patient_id);
    return { pickups, patientDeliveries };
  }, [safeDeliveries, otherDriverDeliveries, showOtherDriverDeliveries]);



  // CRITICAL: FREEZE driver order on FIRST component mount - NEVER recalculate
  // Don't use useMemo—compute once via ref and always return cached result
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

  // CRITICAL: Create stable driver lookup map using SORTED drivers
  const driverLookupMap = useMemo(() => {
    const map = new Map();
    
    stableSortedDrivers.forEach(u => {
      map.set(u.id, u);
    });
    
    return map;
  }, [stableSortedDrivers]);

  // Get coordinates for deliveries and pickups - Use backend isNextDelivery flag
  const { deliveryMarkers, groupedDeliveryMarkers, pickupMarkers, groupedPickupMarkers, hasIncompleteStops } = useMemo(() => {
    // CRITICAL: Check if route has any incomplete stops - include other drivers' deliveries in Show All mode
    let allDeliveriesForIncompleteCheck = safeDeliveries;
    if (showOtherDriverDeliveries && otherDriverDeliveries.length > 0) {
      allDeliveriesForIncompleteCheck = [...safeDeliveries, ...otherDriverDeliveries];
    }
    const hasIncompleteStops = allDeliveriesForIncompleteCheck.some(d => d && !FINISHED_STATUSES.includes(d.status));

    // Process delivery markers
    const deliveryMarkersRaw = patientDeliveries.map((delivery) => {
      if (!delivery) return null;

      const patient = safePatients.find((p) => p && p.id === delivery.patient_id);
      if (!patient?.latitude || !patient?.longitude) return null;

      const driver = safeUsers.find((u) => u && typeof u === 'object' && u.id === delivery.driver_id);
      const store = safeStores.find((s) => s && s.id === delivery.store_id);

      // CRITICAL: Enrich driver data with denormalized driver_name if driver not found
      // Use lookup map first, then fallback to denormalized driver name
      const enrichedDriver = driverLookupMap.get(delivery.driver_id) || driver || (delivery.driver_name ? { 
        id: delivery.driver_id, 
        user_name: delivery.driver_name,
        full_name: delivery.driver_name 
      } : null);

      const isFirstTime = isFirstTimeDelivery(delivery);
      
      // CRITICAL: Check if this is a return delivery (patient name contains "Return")
      const patientNameLower = (patient?.full_name || delivery.patient_name || '').toLowerCase();
      const isReturn = patientNameLower.includes('return') || patientNameLower.includes('(rtn)');

      const isCurrentUserDispatcher = userHasRole(currentUser, 'dispatcher');
      const isStopInDispatcherStore = isCurrentUserDispatcher && currentUser.store_ids && store && currentUser.store_ids.includes(store.id);

      // CRITICAL: Determine if this marker belongs to another driver (BEFORE using in useSimpleCircle)
      // Works for ANY user (admin, driver, dispatcher) viewing a specific driver
      const isOtherDriver = selectedDriverId && selectedDriverId !== 'all' && delivery.driver_id !== selectedDriverId;

      // CRITICAL: Use simple circle markers for dispatchers viewing other stores, AND for all drivers in Show All mode (other drivers)
      const useSimpleCircle = (isCurrentUserDispatcher && !isStopInDispatcherStore) || (showOtherDriverDeliveries && isOtherDriver);

      // CRITICAL: Use backend isNextDelivery flag directly - set by server for all deliveries
      const isNextInLine = delivery.isNextDelivery || false;
      
      // CRITICAL: Track delivery status and isNextDelivery in stable key
      const stableKey = `${delivery.id}:${delivery.status}:${isNextInLine}:${delivery.stop_order}`;

      // CRITICAL: Check if delivery has a pickup by looking at PUID in ASSIGNED DRIVER'S route
      // Check in both safeDeliveries (current route data) AND allDeliveriesForDate (full data for date)
      let hasNoPickup = false;
      if (delivery.patient_id) {
        // If no PUID at all, definitely no pickup
        if (!delivery.puid || delivery.puid.trim() === '') {
          hasNoPickup = true;
        } else {
          // CRITICAL: Check BOTH safeDeliveries AND allDeliveriesForDate to prevent blinking during smart refresh
          // When smart refresh runs, safeDeliveries may temporarily be empty/incomplete
          const pickupExistsInRoute = safeDeliveries.some(d => 
            d && 
            !d.patient_id && 
            d.stop_id === delivery.puid &&
            d.driver_id === delivery.driver_id
          );
          
          const pickupExistsInAllData = safeAllDeliveriesForDate.some(d => 
            d && 
            !d.patient_id && 
            d.stop_id === delivery.puid &&
            d.driver_id === delivery.driver_id
          );
          
          hasNoPickup = !pickupExistsInRoute && !pickupExistsInAllData;
        }
      }

      // CRITICAL: Determine pin color based on mode - calculate ONCE, before rendering
      let pinColor;
      if (isStopInDispatcherStore) {
        // Dispatcher's own stores - ALWAYS use store colors regardless of driver or PUID
        pinColor = store ? getStoreColor(store) : '#6B7280';
      } else if (isAllDriversMode) {
        // All drivers mode - ALWAYS use driver colors, never yellow
        pinColor = enrichedDriver && typeof enrichedDriver === 'object' ? getDriverColor(enrichedDriver) : '#607D8B';
      } else if (hasNoPickup && !isOtherDriver) {
        // Single driver mode ONLY: Yellow for deliveries without assigned pickup
        pinColor = '#FBBF24';
      } else if (isOtherDriver) {
        // "Show All" mode for drivers - other drivers use STORE COLORS
        pinColor = store ? getStoreColor(store) : '#6B7280';
      } else {
        // Single driver mode - use store colors
        pinColor = store ? getStoreColor(store) : '#6B7280';
      }

      return {
        ...delivery,
        latitude: patient.latitude,
        longitude: patient.longitude,
        patient,
        driver: enrichedDriver, // Use enriched driver
        store,
        pinColor,
        number: delivery.display_stop_order || delivery.stop_order || 0,
        isFirstTime,
        isNextInLine,
        markerType: 'delivery',
        useSimpleCircle,
        isOtherDriver, // NEW
        isReturn // NEW: Flag for return deliveries
      };
    }).filter(Boolean);

    // Process pickup markers
    const pickupMarkersRaw = pickups.map((pickup) => {
      if (!pickup) return null;

      const store = safeStores.find((s) => s && s.id === pickup.store_id);
      if (!store?.latitude || !store?.longitude) return null;

      // FIXED: Find driver by ID only, don't require user_name in find condition
      const driver = safeUsers.find((u) => u && typeof u === 'object' && u.id === pickup.driver_id);

      // CRITICAL: Enrich driver data with denormalized driver_name if driver not found
      // Use lookup map first, then fallback to denormalized driver name
      const enrichedDriver = driverLookupMap.get(pickup.driver_id) || driver || (pickup.driver_name ? { 
        id: pickup.driver_id, 
        user_name: pickup.driver_name,
        full_name: pickup.driver_name 
      } : null);

      // CRITICAL: Pickups should NEVER use simple circles - they always show full store pickup markers
      const useSimpleCircle = false;

      // Store pickups ALWAYS use store colors (both modes)
      const pinColor = getStoreColor(store);

      // CRITICAL: Determine if this marker belongs to another driver
      // Works for ANY user (admin, driver, dispatcher) viewing a specific driver
      const isOtherDriver = selectedDriverId && selectedDriverId !== 'all' && pickup.driver_id !== selectedDriverId;

      // CRITICAL: Pin color for pickups
      // Active driver OR all drivers mode: ALWAYS use store color
      // "Show All" mode for other drivers: use store color
      const pickupPinColor = getStoreColor(store);

      return {
        ...pickup,
        latitude: store.latitude,
        longitude: store.longitude,
        store,
        pinColor: pickupPinColor, // CRITICAL: Always store color for pickups
        driver: enrichedDriver, // Use enriched driver
        number: pickup.display_stop_order || pickup.stop_order || 0,
        markerType: 'pickup',
        useSimpleCircle,
        isOtherDriver // NEW
      };
    }).filter(Boolean);
    
    // UNIFIED: Combine all markers for location counting
    const allMarkers = [...deliveryMarkersRaw, ...pickupMarkersRaw];
    
    // Group ALL markers by locationKey (both pickups and deliveries)
    const unifiedGrouped = new Map();
    allMarkers.forEach((marker) => {
      // CRITICAL: Validate coordinates before calling toFixed
      if (!marker || typeof marker.latitude !== 'number' || typeof marker.longitude !== 'number') {
        console.warn('[DeliveryMap] Invalid marker coordinates:', marker);
        return;
      }
      const key = `${marker.latitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${marker.longitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
      if (!unifiedGrouped.has(key)) {
        unifiedGrouped.set(key, { deliveries: [], pickups: [] });
      }
      const group = unifiedGrouped.get(key);
      if (marker.markerType === 'delivery') {
        group.deliveries.push(marker);
      } else {
        group.pickups.push(marker);
      }
    });

    // Calculate total count at each location (deliveries + pickups)
    const locationCounts = new Map();
    unifiedGrouped.forEach((group, key) => {
      const totalCount = group.deliveries.length + group.pickups.length;
      locationCounts.set(key, totalCount);
    });

    // Add duplicate count to each marker (unified count)
    const deliveryMarkersWithCounts = deliveryMarkersRaw.map((marker) => {
      // CRITICAL: Validate coordinates before calling toFixed
      if (!marker || typeof marker.latitude !== 'number' || typeof marker.longitude !== 'number') {
        console.warn('[DeliveryMap] Invalid delivery marker coordinates:', marker);
        return null;
      }
      const key = `${marker.latitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${marker.longitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
      return {
        ...marker,
        duplicateCount: locationCounts.get(key) || 1
      };
    }).filter(Boolean);

    const pickupMarkersWithCounts = pickupMarkersRaw.map((marker) => {
      // CRITICAL: Validate coordinates before calling toFixed
      if (!marker || typeof marker.latitude !== 'number' || typeof marker.longitude !== 'number') {
        console.warn('[DeliveryMap] Invalid pickup marker coordinates:', marker);
        return null;
      }
      const key = `${marker.latitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${marker.longitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
      return {
        ...marker,
        duplicateCount: locationCounts.get(key) || 1
      };
    }).filter(Boolean);

    // Create separate grouped maps for each type
    const groupedDeliveries = new Map();
    deliveryMarkersWithCounts.forEach((marker) => {
      // CRITICAL: Validate coordinates before calling toFixed
      if (!marker || typeof marker.latitude !== 'number' || typeof marker.longitude !== 'number') return;
      const key = `${marker.latitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${marker.longitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
      if (!groupedDeliveries.has(key)) {
        groupedDeliveries.set(key, []);
      }
      groupedDeliveries.get(key).push(marker);
    });

    const groupedPickups = new Map();
    pickupMarkersWithCounts.forEach((marker) => {
      // CRITICAL: Validate coordinates before calling toFixed
      if (!marker || typeof marker.latitude !== 'number' || typeof marker.longitude !== 'number') return;
      const key = `${marker.latitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${marker.longitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
      if (!groupedPickups.has(key)) {
        groupedPickups.set(key, []);
      }
      groupedPickups.get(key).push(marker);
    });

    return { 
      deliveryMarkers: deliveryMarkersWithCounts, 
      groupedDeliveryMarkers: groupedDeliveries,
      pickupMarkers: pickupMarkersWithCounts,
      groupedPickupMarkers: groupedPickups,
      hasIncompleteStops
    };
  // CRITICAL: Use stable references to prevent re-renders on smart refresh
  // Only recalculate when actual data IDs change, not on every array reference change
  }, [
    // CRITICAL: Track status, isNextDelivery, and stop_order changes for immediate marker updates
    patientDeliveries.map(d => `${d?.id}:${d?.status}:${d?.isNextDelivery}:${d?.stop_order}`).join(','),
    pickups.map(p => `${p?.id}:${p?.status}:${p?.isNextDelivery}:${p?.stop_order}`).join(','),
    // Stable user/store/patient tracking
    safeUsers.map(u => u?.id).join(','),
    safeStores.map(s => s?.id).join(','),
    safePatients.map(p => p?.id).join(','),
    isAllDriversMode,
    currentUser?.id,
    isDriverViewingSelf,
    showOtherDriverDeliveries // CRITICAL: Re-render when checkbox changes
  ]);

  const calculateFannedPositionWrapperWrapper = useCallback((originalLat, originalLng, markerIndex, totalMarkers, stopOrder) => {
    const baseRadius = 0.0008;
    const dynamicRadius = 0.0008;
    const radius = baseRadius + (18 - currentZoom) * dynamicRadius;
    let arcWidth;
    if (totalMarkers <= 2) {
      arcWidth = 90;
    } else if (totalMarkers === 3) {
      arcWidth = 120;
    } else if (totalMarkers === 4) {
      arcWidth = 140;
    } else {
      arcWidth = Math.min(180, 140 + (totalMarkers - 4) * 10);
    }
    const arcWidthRad = (arcWidth * Math.PI) / 180;
    const startAngle = (Math.PI / 2) - (arcWidthRad / 2);
    const endAngle = (Math.PI / 2) + (arcWidthRad / 2);
    let angle;
    if (totalMarkers === 1) {
      angle = Math.PI / 2;
    } else {
      const angleStep = (endAngle - startAngle) / (totalMarkers - 1);
      angle = startAngle + ((totalMarkers - 1 - markerIndex) * angleStep);
    }
    const fannedLat = originalLat + radius * Math.sin(angle);
    const fannedLng = originalLng + radius * Math.cos(angle);
    return [fannedLat, fannedLng];
  }, [currentZoom]);

  // NEW: Handler for marker click to toggle fanning with zoom behavior
  const handleMarkerClickForFanning = useCallback((marker, markerType) => {
    const locationKey = `${marker.latitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${marker.longitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
    
    if (marker.duplicateCount > 1) {
      if (onMapInteraction) onMapInteraction();
      
      // Track cluster click
      base44.analytics.track({
        eventName: 'map_cluster_clicked',
        properties: { 
          cluster_size: marker.duplicateCount,
          action: fannedLocationKey === locationKey ? 'retract' : 'expand'
        }
      });
      
      if (fannedLocationKey === locationKey) {
        // Already fanned - clicking again should retract
        setFannedLocationKey(null);
        return;
      }
      
      const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
      const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
      const markersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation];
      
      markersAtLocation.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
      const bounds = L.latLngBounds([]);
      
      markersAtLocation.forEach((m, index) => {
        const [fannedLat, fannedLng] = calculateFannedPositionWrapperWrapper(
          marker.latitude,
          marker.longitude,
          index,
          markersAtLocation.length,
          m.stop_order
        );
        bounds.extend([fannedLat, fannedLng]);
      });
      
      if (map) {
        // Calculate dynamic bottom padding based on actual stop cards height
        // CRITICAL: Get the FULL container height from the horizontal-cards-container
        const stopCardsFullContainer = document.querySelector('.horizontal-cards-container');
        let dynamicBottomPadding = 80; // Default fallback
        
        if (stopCardsFullContainer) {
          const actualHeight = stopCardsFullContainer.getBoundingClientRect().height;
          dynamicBottomPadding = Math.max(actualHeight + 20, 80); // Add 20px buffer
          console.log(`🗺️ [Cluster Click] Using actual stop cards height: ${actualHeight}px, padding: ${dynamicBottomPadding}px`);
        } else {
          console.log(`⚠️ [Cluster Click] Container not found - using default padding: ${dynamicBottomPadding}px`);
        }
        
        // Center on original cluster location with dynamic padding
        // Large top padding pushes cluster markers toward the lower portion of the screen
        const fitOptions = { 
          paddingTopLeft: [80, 350],
          paddingBottomRight: [80, dynamicBottomPadding],
          maxZoom: 14,
          animate: true,
          duration: 0.6
        };
        
        // Fit to fanned bounds (ensures sufficient zoom for separation)
        bounds.isValid() && (map && map.getCenter && map._loaded && map._mapPane && map._mapPane._leaflet_pos) && map.fitBounds(bounds, fitOptions);

        setTimeout(() => {
          setFannedLocationKey(locationKey);
        }, 650);
      } else {
        setFannedLocationKey(locationKey);
      }
      
      // Don't call onMarkerClick when clicking cluster
      return;
    }
    
    // Retract any expanded cluster
    setFannedLocationKey(null);
    
    // Track marker click
    base44.analytics.track({
      eventName: 'map_marker_clicked',
      properties: { 
        marker_type: markerType,
        status: marker.status
      }
    });
    
    // CRITICAL: For pending deliveries, select the assigned pickup instead
    if (marker.status === 'pending' && marker.puid) {
      const assignedPickup = pickupMarkers.find(p => p && p.stop_id === marker.puid);
      if (assignedPickup && onMarkerClick) {
        onMarkerClick(assignedPickup);
      }
    } else if (onMarkerClick) {
      onMarkerClick(marker);
    }
    
    // Auto-center marker on screen with info balloon on first click
    if (map) {
      // Calculate zoom level based on device type
      const targetZoom = isMobile ? 15 : 16;

      // Calculate dynamic top padding for stats card (actual measured height)
      const statsCard = document.querySelector('[data-stats-card]');
      const statsCardHeight = statsCard ? statsCard.getBoundingClientRect().height : 0;
      // Large top padding pushes the marker DOWN on screen (toward lower half)
      // This leaves room above for the popup balloon to open
      const dynamicTopPadding = statsCardHeight + 350;

      // Keep bottom padding minimal — just enough to clear stop cards
      const stopCardsFullContainer = document.querySelector('.horizontal-cards-container');
      let stopCardsActualHeight = 0;
      if (stopCardsFullContainer) {
        stopCardsActualHeight = stopCardsFullContainer.getBoundingClientRect().height;
      }
      const dynamicBottomPadding = stopCardsActualHeight + 20;

      // Calculate vertical offset to push marker into lower portion of visible area
      // We offset the center point UPWARD so the marker ends up below center
      const mapSize = map.getSize();
      const totalVerticalPadding = dynamicTopPadding + dynamicBottomPadding;
      const visibleHeight = mapSize.y - totalVerticalPadding;
      // Shift center up by ~30% of visible height so marker sits in lower third
      const offsetPixels = visibleHeight * 0.3;
      const markerPoint = map.project([marker.latitude, marker.longitude], targetZoom);
      const offsetCenter = map.unproject([markerPoint.x, markerPoint.y - offsetPixels], targetZoom);

      if (map && map.getCenter && map._loaded && map._mapPane && map._mapPane._leaflet_pos) {
        map.setView(offsetCenter, targetZoom, { animate: true, duration: 0.6 });
      }
      
      // Get marker element and open popup immediately
      const markerElement = markerRefs.current[`${markerType}-${marker.id}`];
      if (markerElement && markerElement._popup) {
        setTimeout(() => {
          markerElement.openPopup();
        }, 300);
      }
    }
    
    // Notify parent that map interaction occurred (marker click)
    if (onMapInteraction) {
      onMapInteraction();
    }
  }, [fannedLocationKey, onMarkerClick, currentZoom, map, groupedDeliveryMarkers, groupedPickupMarkers, calculateFannedPositionWrapperWrapper, onMapInteraction, stopCardsHeight, isMobile]);

  // NEW: Auto-unfan when zooming below level 11
  useEffect(() => {
    if (currentZoom < 11 && fannedLocationKey) {
      setFannedLocationKey(null);
    }
  }, [currentZoom, fannedLocationKey]);

  // Check if viewing current date (for real-time features) - FIXED: treat null as today
  const isViewingCurrentDate = useMemo(() => {
    const today = getEdmDate();
    // If no selectedDate, assume we're viewing today
    if (!selectedDate) return true;
    return selectedDate === today;
  }, [selectedDate]);

  // CRITICAL: Process ALL on_duty drivers from realtimeAppUsers, not just from driverLocations prop
  // This ensures shared markers render even when driverLocations prop is empty
  // Use ref to cache previous markers and only update when actual data changes
  const prevDriverLocationMarkersRef = useRef([]);
  
  const driverLocationMarkers = useMemo(() => {
    // CRITICAL: Only show on today or future dates
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
    
    // CRITICAL: Pure dispatcher = dispatcher role WITHOUT driver or admin
    const isPureDispatcher = isCurrentUserDispatcher && !isCurrentUserDriver && !isCurrentUserAdmin;
    
    const currentUserCityId = currentUser?.city_id;
    const fiveMinutesInMs = 5 * 60 * 1000;
    const now = Date.now();
    const todayStr = getEdmDate();
    const currentUserId = currentUser?.id;

    // CRITICAL: Use realtimeAppUsers as the source of truth (contains merged location data)
    const markers = safeUsers.map((user) => {
      if (!user || typeof user !== 'object') return null;

      const driverId = user.id || user.user_id;
      if (!driverId) return null;

      const isCurrentUserMarker = driverId === currentUserId || 
                                  (currentUser?.user_id && driverId === currentUser.user_id) ||
                                  (user.user_id && user.user_id === currentUserId);

      // CRITICAL: On mobile, ALWAYS skip current user's shared marker (blue GPS dot shows instead)
      if (isMobile && isCurrentUserMarker) {
        return null;
      }

      // CRITICAL: Skip inactive users
      if (user.status === 'inactive') {
        return null;
      }
      
      // CRITICAL: Only show on_duty drivers (exclude off_duty and on_break)
      // if (user.driver_status !== 'on_duty') { return null; }
      
      // CRITICAL: Must have valid coordinates
      if (!user.current_latitude || !user.current_longitude) {
        return null;
      }
      
      // CRITICAL: Location tracking must be enabled (unless viewing self)
      if (user.location_tracking_enabled !== true && !isCurrentUserMarker) {
        return null;
      }

          let isStaleLocation = true;
      if (user.location_updated_at) {
        isStaleLocation = (now - new Date(user.location_updated_at).getTime()) > fiveMinutesInMs;
      }

          if ((isMobile || !isMobile) && (isCurrentUserDriver || isCurrentUserAdmin) && !isPureDispatcher) {
        if (!isCurrentUserAdmin && currentUserCityId && user.city_id !== currentUserCityId) return null;
      } else if (isPureDispatcher) {
        const dispatcherStoreIds = new Set(currentUser.store_ids || []);
        const hasActiveDelivery = (deliveriesForLocationFilter || []).some(delivery =>
          delivery &&
          delivery.driver_id === driverId &&
          delivery.delivery_date === todayStr &&
          dispatcherStoreIds.has(delivery.store_id) &&
          ['en_route', 'in_transit', 'pending'].includes(delivery.status)
        );

        if (!hasActiveDelivery) return null;
        
        // CRITICAL: Dispatchers can ONLY see shared location marker when driver is on_duty
        // on_break = polyline only (handled below), NOT shared marker
        // off_duty = nothing
        // if (user.driver_status !== 'on_duty') return null;
        
        // CRITICAL: Must have location_tracking_enabled = true
        if (user.location_tracking_enabled !== true) return null;
      }
      // No access for other roles
      else {
        return null;
      }
      
      const isOnBreak = user.driver_status === 'on_break' && isCurrentUserMarker;

      const driverColor = getDriverColor(user);
      const driverName = user.user_name || user.full_name || 'Unknown Driver';
      const driverInitial = driverName.charAt(0).toUpperCase();

      return {
        id: driverId,
        user_id: driverId,
        driver_id: driverId,
        driverId: driverId,
        latitude: user.current_latitude,
        longitude: user.current_longitude,
        location_updated_at: user.location_updated_at,
        driver: user,
        driverColor,
        driverName,
        driverInitial,
        isSelf: isCurrentUserMarker,
        driver_status: user.driver_status,
        location_tracking_enabled: user.location_tracking_enabled,
        isStaleLocation,
        isOnBreak
      };
    }).filter(Boolean);

    if (markers.length > 0) { prevDriverLocationMarkersRef.current = markers; return markers; }
    return prevDriverLocationMarkersRef.current;
  // CRITICAL: Include polylineRenderKey to force refresh when locations update
  }, [
    selectedDate, // CRITICAL: Must recalculate when date changes to filter past dates
    isViewingCurrentDate,
    currentUser?.id,
    isMobile,
    // Track user location data with stable key - round coordinates to prevent micro-changes
    safeUsers.map(u => `${u?.id}:${u?.current_latitude?.toFixed(4)}:${u?.current_longitude?.toFixed(4)}:${u?.driver_status}:${u?.location_tracking_enabled}`).join('|'),
    // Include deliveries for filtering idle drivers
    deliveriesForLocationFilter.map(d => `${d?.id}:${d?.driver_id}:${d?.delivery_date}:${d?.status}`).join('|'),
    polylineRenderKey // CRITICAL: Force recalculation when driver locations update
  ]);

  // UPDATED: Process current driver's live location for display - ONLY SHOW ON MOBILE, TODAY OR FUTURE
  const currentDriverMarker = useMemo(() => {
    // CRITICAL: Only show blue dot on mobile devices
    if (!isMobile) {
      return null;
    }

    if (!currentUser) {
      return null;
    }

    // CRITICAL: Check if viewing today or future date - handle null selectedDate as today
    const today = getEdmDate();
    const isViewingTodayOrFuture = !selectedDate || selectedDate >= today;
    
    if (!isViewingTodayOrFuture) {
      return null;
    }

    // CRITICAL: Check user roles
    const isCurrentUserDriver = userHasRole(currentUser, 'driver');
    const isCurrentUserAdmin = userHasRole(currentUser, 'admin');
    const isCurrentUserDispatcher = userHasRole(currentUser, 'dispatcher');
    
    // CRITICAL: Pure dispatcher = dispatcher WITHOUT driver or admin roles
    const isPureDispatcher = isCurrentUserDispatcher && !isCurrentUserDriver && !isCurrentUserAdmin;
    
    // CRITICAL: Show blue dot ONLY for users with driver OR admin role (NOT pure dispatchers)
    const shouldShowBlueDot = (isCurrentUserDriver || isCurrentUserAdmin) && !isPureDispatcher;
    
    if (!shouldShowBlueDot) {
      return null;
    }

    // CRITICAL: Use currentDriverLocation if available, otherwise fall back to user's AppUser location
    let locationData = currentDriverLocation || (function(){ const au = (realtimeAppUsers||[]).find(u => u && (u.user_id === currentUser.id || u.id === currentUser.id)); return (au && au.current_latitude && au.current_longitude) ? { latitude: au.current_latitude, longitude: au.current_longitude, timestamp: au.location_updated_at } : null; })();
    
    if (!locationData?.latitude || !locationData?.longitude) {
      // Fall back to current user's location from AppUser data
      if (currentUser.current_latitude && currentUser.current_longitude) {
        locationData = {
          latitude: currentUser.current_latitude,
          longitude: currentUser.current_longitude,
          timestamp: currentUser.location_updated_at
        };
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
  }, [currentDriverLocation, currentUser, isMobile, selectedDate]);

  // CRITICAL: Calculate drivers with complete routes FIRST - used by both home markers AND polylines
  const driversWithCompleteRoute = useMemo(() => {
    const result = new Set();
    
    // Build map of all driver stops
    const driverStopsMap = new Map();
    [...deliveryMarkers, ...pickupMarkers].forEach(m => {
      if (!m || !m.driver_id) return;
      if (!driverStopsMap.has(m.driver_id)) {
        driverStopsMap.set(m.driver_id, { incomplete: [], complete: [] });
      }
      const finishedStatuses = ['completed', 'failed', 'cancelled'];
      if (finishedStatuses.includes(m.status)) {
        driverStopsMap.get(m.driver_id).complete.push(m);
      } else if (m.status !== 'pending') {
        driverStopsMap.get(m.driver_id).incomplete.push(m);
      }
    });
    
    // Find drivers with complete routes
    driverStopsMap.forEach((stops, driverId) => {
      if (stops.incomplete.length === 0 && stops.complete.length > 0) {
        result.add(driverId);
      }
    });
    
    return result;
  }, [
    deliveryMarkers.map(d => `${d?.id}:${d?.status}`).join(','),
    pickupMarkers.map(p => `${p?.id}:${p?.status}`).join(',')
  ]);

  // NEW: Calculate driver home locations for drivers with active stops - CURRENT DATE ONLY
  // Use ref to cache previous markers and only update when actual data changes
  const prevDriverHomeMarkersRef = useRef([]);
  
  const driverHomeMarkers = useMemo(() => {
    if (!showRoutes || !currentUser || (selectedDate && selectedDate < getEdmDate())) {
      // Hide home markers on past dates; clear any cached markers to avoid stale display
      prevDriverHomeMarkersRef.current = [];
      return [];
    }

    if (!safeUsers?.length) return prevDriverHomeMarkersRef.current;

    // CRITICAL: Dispatchers should not see home locations
    if (userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
      prevDriverHomeMarkersRef.current = [];
      return [];
    }

    // Check if current user is app owner (Base44 platform admin)
    const isCurrentUserDriver = userHasRole(currentUser, 'driver');
    const isCurrentUserAdmin = userHasRole(currentUser, 'admin');
    const finishedStatuses = ['completed', 'failed', 'cancelled'];

    const driversToShowHome = new Set();
    const driversToExcludeFromBounds = new Set(); // CRITICAL: Track home markers to exclude from centering

    // CRITICAL: Check all deliveries to determine which drivers have stops
    const deliveriesToCheck = (isCurrentUserAdmin && showOtherDriverDeliveries && otherDriverDeliveries.length > 0)
      ? [...safeDeliveries, ...otherDriverDeliveries]
      : safeDeliveries;

    // Group all stops (deliveries + pickups) by driver
    const stopsByDriver = new Map();
    
    deliveriesToCheck.forEach((delivery) => {
      if (!delivery || !delivery.driver_id) return;
      if (!stopsByDriver.has(delivery.driver_id)) {
        stopsByDriver.set(delivery.driver_id, { deliveries: [], pickups: [] });
      }
      if (delivery.patient_id) {
        stopsByDriver.get(delivery.driver_id).deliveries.push(delivery);
      } else {
        stopsByDriver.get(delivery.driver_id).pickups.push(delivery);
      }
    });

    // CRITICAL: In single driver mode without "Show All" checked, only show the selected driver's home
    // In all-drivers mode OR show-all mode, show all drivers' homes
    const isShowAllMode = showOtherDriverDeliveries || isAllDriversMode;

    // For each driver, determine if home marker should show
    stopsByDriver.forEach((stops, driverId) => {
      // CRITICAL: Hide other drivers' home markers when not in show-all or all-drivers mode
      // Admins/app owners bypass this to evaluate special visibility rules
      if (!isShowAllMode && driverId !== selectedDriverId && !(isCurrentUserAdmin || isAppOwner(currentUser))) return;
      const allStops = [...stops.deliveries, ...stops.pickups];
      
      // Count incomplete stops (exclude pending)
      const incompleteStops = allStops.filter(s => !finishedStatuses.includes(s.status) && s.status !== 'pending');
      const completedStops = allStops.filter(s => finishedStatuses.includes(s.status));
      
      // CRITICAL: Check if there are ANY unfinished pickups (including pending)
      // Home marker should NOT show until ALL pickups are complete/canceled/failed
      const unfinishedPickups = stops.pickups.filter(s => !finishedStatuses.includes(s.status));

      // Determine if any pickups are actively en route
      const hasEnRoutePickups = stops.pickups.some((s) => s && s.status === 'en_route');

      // ADMIN VISIBILITY: In single-driver view, admins can see other drivers' homes when route not started OR no pickups en_route
      if ((isCurrentUserAdmin || isAppOwner(currentUser)) && driverId !== (currentUser?.id)) {
        const routeNotStarted = (allStops.length > 0 && completedStops.length === 0);
        if (routeNotStarted || !hasEnRoutePickups) {
          driversToShowHome.add(driverId);
          return;
        }
      }

      // SHOW-ALL OVERRIDE: In show-all or all-drivers mode, always show other drivers' homes
      if ((isShowAllMode) && driverId !== (currentUser?.id)) {
        driversToShowHome.add(driverId);
        return;
      }
      
      // RULE 1: Pre-start visibility — show until first stop is completed (regardless of pending/in_transit)
      if (allStops.length > 0 && completedStops.length === 0) {
        driversToShowHome.add(driverId);
        return;
      }
      
      // RULE 2: After-route visibility — show again only when ALL stops complete AND all pickups finished/cancelled
      if (incompleteStops.length === 0 && completedStops.length > 0 && unfinishedPickups.length === 0) {
        driversToShowHome.add(driverId);
        return;
      }
      
      // RULE 3: Hide home marker if some stops are complete and some are incomplete (mid-route)
    });

    if (driversToShowHome.size === 0 && prevDriverHomeMarkersRef.current.length > 0) return prevDriverHomeMarkersRef.current;

    const homeMarkers = [];
    driversToShowHome.forEach((driverId) => {
      // CRITICAL: In single driver mode, ONLY show the selected driver's home marker
      if (isSingleDriverMode && driverId !== selectedDriverId) return;
      
      if (isDriverViewingSelfToday && driverId !== currentUser.id) return;

      // CRITICAL: Find driver in safeUsers (contains merged AppUser data with home coords)
      const driver = safeUsers.find((u) => u && typeof u === 'object' && u.id === driverId);

      // CRITICAL: Validate home coordinates exist and are valid numbers
      if (!driver?.home_latitude || !driver?.home_longitude ||
          typeof driver.home_latitude !== 'number' || typeof driver.home_longitude !== 'number' ||
          isNaN(driver.home_latitude) || isNaN(driver.home_longitude)) {
        // Skip silently - don't spam console for missing home coordinates
        return; // Skip drivers without valid home coordinates
      }

      // CRITICAL: Admins see ALL home markers (for all drivers with active stops)
      // Drivers ALWAYS see their own home marker
      const shouldRenderHome =
        isAppOwner(currentUser) ||
        isCurrentUserAdmin ||
        (isCurrentUserDriver && ((showOtherDriverDeliveries || selectedDriverId === 'all') || driver.id === currentUser.id));
      
      const driverName = driver.user_name || driver.full_name || 'Unknown Driver';

      if (shouldRenderHome) {
        const driverColor = getDriverColor(driver);

        homeMarkers.push({
          id: `home-${driverId}`,
          driverId,
          driver,
          latitude: driver.home_latitude,
          longitude: driver.home_longitude,
          driverColor,
          driverName,
          excludeFromBounds: driversToExcludeFromBounds.has(driverId), // CRITICAL: Flag to exclude from centering
          isRouteComplete: driversWithCompleteRoute.has(driverId) // NEW: Flag to show Go Home button
        });
      }
    });

    // CRITICAL: Only update if home markers actually changed to prevent blinking
    const newKey = homeMarkers.map(m => `${m.id}:${m.latitude}:${m.longitude}`).join('|');
    const prevKey = prevDriverHomeMarkersRef.current.map(m => `${m.id}:${m.latitude}:${m.longitude}`).join('|');
    
    if (newKey === prevKey && prevDriverHomeMarkersRef.current.length > 0) {
      return prevDriverHomeMarkersRef.current;
    }
    
    // CRITICAL: If new markers are empty but we had markers before, preserve them
    // This handles the case where deliveries briefly become empty during refresh
    if (homeMarkers.length === 0 && prevDriverHomeMarkersRef.current.length > 0) {
      return prevDriverHomeMarkersRef.current;
    }
    
    prevDriverHomeMarkersRef.current = homeMarkers;
    return homeMarkers;
  // CRITICAL: Use minimal, stable dependencies to prevent blinking
  }, [
    showRoutes,
    currentUser?.id,
    isViewingCurrentDate,
    isDriverViewingSelfToday,
    showOtherDriverDeliveries,
    // Only track essential data with stable JSON stringify
    JSON.stringify(safeDeliveries.map(d => ({ id: d?.driver_id, status: d?.status }))),
    JSON.stringify(otherDriverDeliveries.map(d => ({ id: d?.driver_id, status: d?.status }))),
    JSON.stringify(safeUsers.map(u => ({ id: u?.id, hLat: u?.home_latitude, hLon: u?.home_longitude }))),
    driversWithCompleteRoute // CRITICAL: Include to update home markers when routes complete
  ]);

  // CRITICAL: Pass home markers, driver locations, AND delivery markers to Dashboard for FAB phase 1 bounds calculation
  useEffect(() => {
    window.__mapHomeMarkers = driverHomeMarkers;
    window.__mapDriverLocationMarkers = driverLocationMarkers;
    // Also pass delivery and pickup markers with their coordinates for bounds calculation
    window.__mapDeliveryMarkers = deliveryMarkers;
    window.__mapPickupMarkers = pickupMarkers;
    
    return () => {
      delete window.__mapHomeMarkers;
      delete window.__mapDriverLocationMarkers;
      delete window.__mapDeliveryMarkers;
      delete window.__mapPickupMarkers;
    };
  }, [driverHomeMarkers, driverLocationMarkers, deliveryMarkers, pickupMarkers]);

  // CRITICAL: Store previous driverRoutes to prevent unnecessary recalculations
  const prevDriverRoutesRef = useRef([]);
  
  // Generate routes for each driver - NOW WITH ZOOM-BASED STYLING, CURRENT DATE ONLY for polylines
  const driverRoutes = useMemo(() => {
    if (!showRoutes || currentZoom < ZOOM_LEVELS.HIDE_ROUTES) {
      prevDriverRoutesRef.current = [];
      return [];
    }
    
    const showLivePolylines = isViewingCurrentDate;
    const isDispatcherNonAdmin = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');

    // Use shared finished statuses
    const activeStatuses = ['in_transit']; // NEW

    // CRITICAL: Pre-build driver lookup with STABLE sort order from stableSortedDrivers
    const driverOrderMap = new Map();
    stableSortedDrivers.forEach((driver, index) => {
      driverOrderMap.set(driver.id, { driver, sortIndex: index });
    });

    // Group deliveries by driver
    const routesByDriver = {};

    // CRITICAL: When showing other drivers, include their deliveries in route calculation
    const allDeliveriesForRoutes = showOtherDriverDeliveries && otherDriverDeliveries.length > 0
      ? [...deliveryMarkers, ...otherDriverDeliveries.map((d) => {
          // Convert raw deliveries to marker format
          const patient = safePatients.find((p) => p && p.id === d.patient_id);
          if (!patient?.latitude || !patient?.longitude) return null;
          const driver = safeUsers.find((u) => u && u.id === d.driver_id);
          const store = safeStores.find((s) => s && s.id === d.store_id);
          return {
            ...d,
            latitude: patient.latitude,
            longitude: patient.longitude,
            patient,
            driver,
            store,
            pinColor: store ? getStoreColor(store) : '#6B7280',
            markerType: 'delivery'
          };
        }).filter(Boolean)]
      : deliveryMarkers;

    allDeliveriesForRoutes.forEach((delivery) => {
    if (!delivery) return;
    const driverId = delivery.driver_id || 'unassigned';
    if (!routesByDriver[driverId]) {
      // CRITICAL: Use stable driver order map
      const driverInfo = driverOrderMap.get(driverId);
      let driverForRoute = driverInfo?.driver || driverLookupMap.get(driverId);
      let stableSortIndex = driverInfo?.sortIndex ?? Infinity;
      
      // CRITICAL: Fallback to denormalized driver name if not in lookup map
      if (!driverForRoute && delivery.driver_name) {
        driverForRoute = {
          id: driverId,
          user_name: delivery.driver_name,
          full_name: delivery.driver_name
        };
        stableSortIndex = Infinity;
      }

      // CRITICAL: Route color ALWAYS uses driver color (for both Type 2 and Type 3 polylines)
      const routeColor = driverForRoute && typeof driverForRoute === 'object' ? getDriverColor(driverForRoute) : '#607D8B';

      const driverDisplayName = driverForRoute ? (driverForRoute.user_name || driverForRoute.full_name || 'Unknown') : 'Unassigned';

      routesByDriver[driverId] = {
        driverId,
        driverName: driverDisplayName,
        driver: driverForRoute,
        color: routeColor,
        stops: [],
        sortOrder: stableSortIndex, // Use stable index instead of dynamic sort_order
        // CRITICAL: Store both the route color AND the driver object for legend lookup
        _driverObj: driverForRoute
      };
    }
    routesByDriver[driverId].stops.push(delivery);
    });

    // Sort stops by stop_order and create route lines
    const sortedRoutes = Object.values(routesByDriver).sort((a, b) => a.sortOrder - b.sortOrder).map((route) => {
    // Find ALL pickup locations for this driver
    const driverPickups = pickupMarkers.filter((p) => p.driver_id === route.driverId);

    // Check if all stops (deliveries + pickups) are finished
    const allDeliveriesFinished = route.stops.every((d) => FINISHED_STATUSES.includes(d.status));
    const allPickupsFinished = driverPickups.every((p) => FINISHED_STATUSES.includes(p.status));
    const isRouteCompleted = allDeliveriesFinished && allPickupsFinished;

    const hasActiveStops = route.stops.some((delivery) => delivery && activeStatuses.includes(delivery.status)) ||
      driverPickups.some((p) => p && activeStatuses.includes(p.status));
    const hasCompletedStops = route.stops.some((d) => FINISHED_STATUSES.includes(d.status)) ||
      driverPickups.some((p) => p && FINISHED_STATUSES.includes(p.status));
    const isRouteStarted = hasActiveStops || hasCompletedStops;

      // CRITICAL POLYLINE RULE: For active routes, filter to incomplete stops. For completed routes, show all
      let deliveriesToRoute = isRouteCompleted ? route.stops : route.stops.filter((delivery) => delivery && !FINISHED_STATUSES.includes(delivery.status) && delivery.status !== 'pending');
      let pickupsToRoute = isRouteCompleted ? driverPickups : driverPickups.filter((p) => p && !FINISHED_STATUSES.includes(p.status) && p.status !== 'pending');

      // CRITICAL: Calculate totalDriverStops using Dashboard stats rules
      // Patient deliveries + completed/cancelled after hours pickups
      const patientDeliveryCount = route.stops.filter(d => d && d.patient_id).length;
      const completedOrCancelledAfterHours = driverPickups.filter(p => {
        if (!p) return false;
        return p.after_hours_pickup && (p.status === 'completed' || p.status === 'cancelled');
      }).length;
      const totalDriverStopsWithAfterHours = patientDeliveryCount + completedOrCancelledAfterHours;

      // Use isRouteStarted that's already defined above
      const routeHasActuallyStarted = isRouteStarted;

      // Build route coordinates by combining ALL stops and sorting by stop order
      let coordinates = [];
      let lastStopCoordinates = null;
      let shouldShowHomeRoute = false;
      let firstStopCoordinates = null; // NEW: Track first stop for pre-route line
      let startToFirstStopCoordinates = null; // NEW: Track route from start to first stop

      if (pickupsToRoute.length === 0 && deliveriesToRoute.length === 0) {
          coordinates = [];
        } else {
          // Combine pickups and deliveries into a single array with stop order info
          const allStops = [
            ...pickupsToRoute.map((pickup) => ({
              type: 'pickup',
              stop_order: pickup.display_stop_order || pickup.stop_order || 0,
              latitude: pickup.latitude,
              longitude: pickup.longitude,
              store: pickup.store?.name,
              time: pickup.delivery_time_start
            })),
            ...deliveriesToRoute.map((delivery) => ({
              type: 'delivery',
              stop_order: delivery.display_stop_order || delivery.stop_order || 0,
              latitude: delivery.latitude,
              longitude: delivery.longitude,
              patient: delivery.patient?.full_name,
              time: delivery.delivery_time_start
            }))];

          allStops.sort((a, b) => a.stop_order - b.stop_order);
          coordinates = allStops.map((stop) => [stop.latitude, stop.longitude]);

          if (allStops.length > 0) {
            const firstStop = allStops[0];
            firstStopCoordinates = [firstStop.latitude, firstStop.longitude];
          }

          if (allStops.length > 0) {
            const lastStop = allStops[allStops.length - 1];
            lastStopCoordinates = [lastStop.latitude, lastStop.longitude];
            shouldShowHomeRoute = !isRouteCompleted && !isDispatcherNonAdmin && showLivePolylines;
          }

          // NEW: Determine starting point for visualization (routeHasActuallyStarted defined above)
          // CRITICAL: Only show starting lines for live routes (current date)

          if (routeHasActuallyStarted && firstStopCoordinates && route.driver && showLivePolylines) {
          let startPoint = null;

          // CRITICAL: For the current user's primary mobile device, use live GPS
          if (currentUser && route.driver.id === currentUser.id && isMobile && currentDriverLocation?.latitude && currentDriverLocation?.longitude) {
            startPoint = [currentDriverLocation.latitude, currentDriverLocation.longitude];
          }
          else {
            // CRITICAL: For ALL other cases (other drivers, self on non-primary device, desktop),
            // look up from realtimeAppUsers - the live source of truth for shared locations.
            // DO NOT use route.driver.current_latitude — it comes from the frozen stableSortedDrivers map.
            const liveDriverData = realtimeAppUsers.find(u => u && u.id === route.driver.id);
            const lat = liveDriverData?.current_latitude;
            const lng = liveDriverData?.current_longitude;
            const updatedAt = liveDriverData?.location_updated_at;

            if (lat && lng && updatedAt) {
              const locationAge = Date.now() - new Date(updatedAt).getTime();
              const fiveMinutesInMs = 5 * 60 * 1000;

              if (locationAge < fiveMinutesInMs) {
                startPoint = [lat, lng];
              }
            }
          }

          if (!startPoint && hasCompletedStops) {
            const completedStopsForDriver = [...route.stops, ...driverPickups]
              .filter((s) => s && FINISHED_STATUSES.includes(s.status) && s.actual_delivery_time)
              .sort((a, b) => new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time));

            if (completedStopsForDriver.length > 0) {
              const lastCompleted = completedStopsForDriver[0];
              startPoint = [lastCompleted.latitude, lastCompleted.longitude];
            }
          }

          if (startPoint) {
            startToFirstStopCoordinates = [startPoint, firstStopCoordinates];
          }
        } else if (!isRouteStarted && firstStopCoordinates && route.driver && !isDispatcherNonAdmin) {
          // CRITICAL: For unstarted routes, only show home-to-first-stop line if NO live location available
          // The blue dashed line from current location to next stop is drawn separately below
          const isPrimaryMobile = currentUser && route.driver.id === currentUser.id && isMobile && currentDriverLocation?.latitude && currentDriverLocation?.longitude;
          const liveDriverData = realtimeAppUsers.find(u => u && u.id === route.driver.id);
          const hasSharedLocation = liveDriverData?.current_latitude && liveDriverData?.current_longitude;
          const hasLiveLocation = isPrimaryMobile || hasSharedLocation;
          
          // Only use home location if no live location is available
          if (!hasLiveLocation && route.driver.home_latitude && route.driver.home_longitude) {
            const startPoint = [route.driver.home_latitude, route.driver.home_longitude];
            startToFirstStopCoordinates = [startPoint, firstStopCoordinates];
          }
          // If live location exists, don't set startToFirstStopCoordinates - the separate blue dashed line handles it
        }
      }

      // NEW: Determine route styling based on zoom
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
      
      // Increase route weight for mobile devices
      if (isMobile) {
        routeWeight *= 1.25;
      }

      // Determine if this is an origin line (bright red) vs pre-route line (dashed)
      const isOriginLine = routeHasActuallyStarted;

      return {
        ...route,
        coordinates,
        lastStopCoordinates, // Add last stop coordinates
        shouldShowHomeRoute: showLivePolylines && shouldShowHomeRoute, // Only show on current date
        startToFirstStopCoordinates: showLivePolylines ? startToFirstStopCoordinates : null, // Only show on current date
        isOriginLine, // NEW: Flag to distinguish origin line from pre-route line
        hasPickup: pickupsToRoute.length > 0,
        isCompleted: isRouteCompleted,
        isRouteStarted, // NEW: Track if route has started
        pickupCount: driverPickups.length,
        totalStops: totalDriverStopsWithAfterHours, // FIXED: Use count including after hours pickups
        // NEW: Zoom-based styling
        routeWeight,
        routeOpacity,
        showWaypoints
      };
    });

    // CRITICAL: Don't cache routes - always return fresh calculation to ensure Type 1 polylines update with driver locations
    prevDriverRoutesRef.current = sortedRoutes;
    return sortedRoutes;
  // CRITICAL: Use stable references for driverRoutes to prevent legend flickering
  }, [
    deliveryMarkers.map(d => `${d?.id}:${d?.stop_order}:${d?.status}`).join(','),
    pickupMarkers.map(p => `${p?.id}:${p?.stop_order}:${p?.status}`).join(','),
    showRoutes,
    isAllDriversMode,
    stableSortedDrivers.map(d => `${d?.id}:${d?.sort_order}`).join('|'), // Stable driver order key
    currentZoom,
    currentUser?.id,
    isMobile,
    currentDriverLocation?.latitude,
    currentDriverLocation?.longitude,
    // CRITICAL: Track realtimeAppUsers location changes so startPoint updates for shared markers
    realtimeAppUsers.map(u => `${u?.id}:${u?.current_latitude?.toFixed(4)}:${u?.current_longitude?.toFixed(4)}`).join('|'),
    isViewingCurrentDate,
    isDriverViewingSelfToday,
    routeRenderKey // CRITICAL: Force recalculation when deliveries update
  ]);
  
  // Pass driver routes to parent component
  useEffect(() => {
    if (onDriverRoutesCalculated) {
      onDriverRoutesCalculated(driverRoutes);
    }
  }, [driverRoutes, onDriverRoutesCalculated]);

  // CRITICAL: Notify parent when map is ready - simplified to prevent infinite loops
  const hasNotifiedMapReady = useRef(false);

  // Notify parent once when map and markers are ready
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

  // NEW: Calculate legend position centered below stats card (AFTER driverRoutes is defined)
  useEffect(() => {
    if (!statsCardRect) {
      setLegendLeft(null);
      return;
    }

    // Calculate the center of the stats card
    const statsCardCenterX = statsCardRect.left + (statsCardRect.width / 2);
    
    // If legendRef is available, account for legend width, otherwise just use stats card center
    if (legendRef.current) {
      const legendWidth = legendRef.current.offsetWidth;
      const calculatedLeft = statsCardCenterX - (legendWidth / 2);
      setLegendLeft(calculatedLeft);
    } else {
      // Fallback: position at stats card center (will be adjusted on next render when ref is available)
      setLegendLeft(statsCardCenterX);
    }
  }, [statsCardRect, driverRoutes.length, isStatsCardExpanded]);

  // Handle dynamic map center and zoom changes - ONLY when shouldFitBounds is explicitly set
  useEffect(() => {
    if (!map || !map.getCenter || !map._loaded || !map._panes || !map._mapPane || !shouldFitBounds) return;
    try {
      if (!map._mapPane._leaflet_pos) return;
    } catch (e) { return; }
    try {
      const bounds = L.latLngBounds((Array.isArray(shouldFitBounds.bounds)?shouldFitBounds.bounds:[]).filter(p=>Array.isArray(p)&&p.length===2&&Number.isFinite(p[0])&&Number.isFinite(p[1])));if(!bounds.isValid())return;
      if (map._leaflet_events?.zoomstart) {
        if (!map._isProgrammaticZoom) Object.defineProperty(map, '_isProgrammaticZoom', { value: { current: false }, writable: true, configurable: true });
        map._isProgrammaticZoom.current = true;
      }
      const opts = shouldFitBounds.options || {};
      try { window._lastProgrammaticMapMove = Date.now(); } catch (_) {}
      map._mapPane._leaflet_pos && map.fitBounds(bounds, { ...opts, paddingTopLeft: opts.paddingTopLeft || [60,60], paddingBottomRight: opts.paddingBottomRight || [60,60], animate: true, duration: 0.8 });
      if (onBoundsFitted) onBoundsFitted();
    } catch (error) { console.warn('[DeliveryMap] Error during bounds fit:', error); }
  }, [map, shouldFitBounds, stopCardsHeight, onBoundsFitted]);

  const handleMarkerDragEnd = useCallback((markerId, event, type) => { try { event.target.getLatLng(); } catch (e) {} }, []);
  const popupTimeoutsRef = useRef({});



  return (
    <div className="absolute inset-0">
      <MapContainer
        center={center || [53.5461, -113.4938]}
        zoom={zoom || (safeDeliveries.length === 0 ? 11 : 12)}
        maxZoom={18}
        zoomSnap={0}
        zoomDelta={0.1}
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
        onClick={() => setFannedLocationKey(null)}
        whenReady={(mapInstance) => {
          console.log('[MapCenter] MapContainer whenReady callback fired');
          setMap(mapInstance.target);
          setCurrentZoom(mapInstance.target.getZoom());
          setVisibleBounds(mapInstance.target.getBounds());
        }}> {/* Close fan on map click */}

        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url={document.documentElement.classList.contains('dark-theme') || 
               (document.documentElement.classList.contains('auto-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)
               ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
               : "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"}
        />

        <MapController onMapInteraction={onMapInteraction} onDoubleTap={onDoubleTap} currentZoom={currentZoom} setCurrentZoom={setCurrentZoom} setShowZoomOverlay={setShowZoomOverlay} zoomOverlayTimeoutRef={zoomOverlayTimeoutRef} setMapCenter={setMapCenter} setVisibleBounds={setVisibleBounds} setFannedLocationKey={setFannedLocationKey} />



        {/* TYPE 3 POLYLINES: Completed routes - dashed lines between all stops */}
        {(showRoutes || (typeof window !== 'undefined' && localStorage.getItem('rxdeliver_show_routes') === 'true')) && driverRoutes.map(route => {
          if (!route.driverId) return null;
          const fin = ['completed','failed','cancelled'];
          const color = ((isAllDriversMode || selectedDriverId === 'all') ? (function(hex,id){const p=['#8A2BE2','#EC4899','#F59E0B','#A855F7','#F43F5E','#FF7F50','#A0522D'];if(!hex||hex[0]!=='#'||hex.length<7)return hex||'#607D8B';const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;if(d===0)return hex;let h;switch(max){case r:h=(g-b)/d+(g<b?6:0);break;case g:h=(b-r)/d+2;break;default:h=(r-g)/d+4;}h*=60;if(h>=180&&h<=250){let x=0;for(const c of String(id||''))x=((x<<5)-x)+c.charCodeAt(0)|0;return p[Math.abs(x)%p.length];}return hex;})(route.color,route.driverId) : route.color);
          const stops = [...pickupMarkers.filter(p=>p&&p.driver_id===route.driverId),...deliveryMarkers.filter(d=>d&&d.driver_id===route.driverId)].sort((a,b)=>(a.stop_order||0)-(b.stop_order||0));
          if (stops.length < 2) return null;
          if (!stops.every(s=>fin.includes(s.status))) return null; // TYPE 3 only for completed
          return stops.slice(0,-1).map((s1,i)=>{
            const s2=stops[i+1];
            if (!s1||!s2||[s1.latitude,s1.longitude,s2.latitude,s2.longitude].some(v=>typeof v!=='number'||isNaN(v))) return null;
            const t1=s1.actual_delivery_time?new Date(s1.actual_delivery_time):s1.delivery_time_eta?new Date(`2000-01-01T${s1.delivery_time_eta}:00`):s1.delivery_time_start?new Date(`2000-01-01T${s1.delivery_time_start}:00`):null;
            const t2=s2.actual_delivery_time?new Date(s2.actual_delivery_time):s2.delivery_time_eta?new Date(`2000-01-01T${s2.delivery_time_eta}:00`):s2.delivery_time_start?new Date(`2000-01-01T${s2.delivery_time_start}:00`):null;
            if(t1&&t2&&Math.abs(t2-t1)/60000>90) return null;
            const isSelRoute=selectedDriverId&&selectedDriverId!=='all'&&route.driverId===selectedDriverId;
            const isHighSeg=highlightedDeliveryId&&(s1.id===highlightedDeliveryId||s2.id===highlightedDeliveryId);
            return <Polyline key={`t3-${route.driverId}-${i}-${polylineRenderKey}-${highlightedDeliveryId||'none'}`} positions={[[s1.latitude,s1.longitude],[s2.latitude,s2.longitude]]} pathOptions={{color,weight:4,opacity:isSelRoute?0.7:isHighSeg?0.85:0.2,dashArray:s2.ampm_deliveries==='AM'?'10, 5':'2, 8',lineJoin:'round',lineCap:'round'}} pane="overlayPane"/>;
          });
        })}



        {/* NEW: Fanning radius lines (thick, solid, grey) - UNIFIED for all markers */}
        {fannedLocationKey && (() => {
          const pickupsAtLocation = groupedPickupMarkers.get(fannedLocationKey) || [];
          const deliveriesAtLocation = groupedDeliveryMarkers.get(fannedLocationKey) || [];
          const allMarkersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation]
            .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
          
          return allMarkersAtLocation.map((marker, idx) => {
            const [originalLat, originalLng] = fannedLocationKey.split(',').map(Number);
            
            // CRITICAL: Validate coordinates
            if (typeof originalLat !== 'number' || typeof originalLng !== 'number' || 
                isNaN(originalLat) || isNaN(originalLng)) {
              return null;
            }
            
            const [fannedLat, fannedLng] = calculateFannedPositionWrapperWrapper(
              originalLat,
              originalLng,
              idx,
              allMarkersAtLocation.length,
              marker.stop_order
            );
            
            if (typeof fannedLat !== 'number' || typeof fannedLng !== 'number' ||
                isNaN(fannedLat) || isNaN(fannedLng)) {
              return null;
            }
            
            return (
              <Polyline
                key={`radius-${marker.markerType}-${marker.id}-${idx}`}
                positions={[
                  [originalLat, originalLng],
                  [fannedLat, fannedLng]
                ]}
                pathOptions={{
                  color: "#64748b", // slate-500
                  weight: 4,
                  opacity: 1,
                  dashArray: ""
                }}
                pane="overlayPane" // Render on overlay pane for Z-index control
              />
            );
          });
        })()}

        {/* ===== RENDER ORDER 1: Live location markers + heading-up ===== */}
        {(() => {
          const HeadingUpRotator = React.lazy(() => import('./HeadingUpRotator'));
          const enabled = false; // rotation disabled - follow-only in Phase 2
          const hasValid = !!(currentDriverMarker && typeof currentDriverMarker.latitude === 'number' && typeof currentDriverMarker.longitude === 'number' && !isNaN(currentDriverMarker.latitude) && !isNaN(currentDriverMarker.longitude));
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

        {/* ===== RENDER ORDER 2: Shared location markers ===== */}
         <DriverLocationMarkers 
           users={driverLocationMarkers}
           currentUser={currentUser}
           activeDriver={null}
           deliveries={deliveriesForLocationFilter}
           selectedDate={selectedDate}
         />

        {/* TYPE 1 POLYLINES (HERE): next leg + home */}
        {(showRoutes || (typeof window !== 'undefined' && localStorage.getItem('rxdeliver_show_routes') === 'true')) && (<><HereType2Polylines isViewingCurrentDate={isViewingCurrentDate} deliveryMarkers={deliveryMarkers} pickupMarkers={pickupMarkers} driverRoutes={driverRoutes} multiDriverMode={selectedDriverId === 'all' || showOtherDriverDeliveries} selectedDriverId={selectedDriverId} /><HereType1Polylines isViewingCurrentDate={isViewingCurrentDate} deliveryMarkers={deliveryMarkers} pickupMarkers={pickupMarkers} driverHomeMarkers={driverHomeMarkers} currentDriverMarker={currentDriverMarker} selectedDriverId={selectedDriverId} showAll={isAllDriversMode || showOtherDriverDeliveries} driverLocations={driverLocationMarkers} /></>) }

        {/* ===== RENDER ORDER 3: Home markers ===== */}
        <HomeMarkers driverHomeMarkers={driverHomeMarkers} map={map} isMobile={isMobile} onMarkerClick={onMarkerClick} />

        {/* ===== RENDER ORDER 4: Route markers (pickups & deliveries) ===== */}
        <PickupMarkers pickupMarkers={pickupMarkers} groupedPickupMarkers={groupedPickupMarkers} groupedDeliveryMarkers={groupedDeliveryMarkers} routeRenderKey={routeRenderKey} currentZoom={currentZoom} ZOOM_LEVELS={ZOOM_LEVELS} isMobile={isMobile} fannedLocationKey={fannedLocationKey} highlightedDeliveryId={highlightedDeliveryId} fadedMarkerHighlights={fadedMarkerHighlights} setFadedMarkerHighlights={setFadedMarkerHighlights} driversWithCompleteRoute={driversWithCompleteRoute} hasIncompleteStops={hasIncompleteStops} calculateFannedPositionWrapperWrapper={calculateFannedPositionWrapperWrapper} onMarkerClick={onMarkerClick} handleMarkerClickForFanning={handleMarkerClickForFanning} handleMarkerDragEnd={handleMarkerDragEnd} markerRefs={markerRefs} safeStores={safeStores} safePatients={safePatients} safeUsers={safeUsers} />

        {/* Patient Delivery Markers */}
        <DeliveryMarkers deliveryMarkers={deliveryMarkers} groupedDeliveryMarkers={groupedDeliveryMarkers} groupedPickupMarkers={groupedPickupMarkers} routeRenderKey={routeRenderKey} currentZoom={currentZoom} ZOOM_LEVELS={ZOOM_LEVELS} isMobile={isMobile} fannedLocationKey={fannedLocationKey} setFannedLocationKey={setFannedLocationKey} highlightedDeliveryId={highlightedDeliveryId} fadedMarkerHighlights={fadedMarkerHighlights} setFadedMarkerHighlights={setFadedMarkerHighlights} driversWithCompleteRoute={driversWithCompleteRoute} hasIncompleteStops={hasIncompleteStops} calculateFannedPositionWrapperWrapper={calculateFannedPositionWrapperWrapper} onMarkerClick={onMarkerClick} handleMarkerClickForFanning={handleMarkerClickForFanning} handleMarkerDragEnd={handleMarkerDragEnd} markerRefs={markerRefs} safeStores={safeStores} safePatients={safePatients} safeUsers={safeUsers} stores={stores} />

        {/* Breadcrumb Trails - Historical and Current */}
        {showBreadcrumbs && <MapBreadcrumbs breadcrumbsData={breadcrumbsData} safeUsers={safeUsers} />}
      </MapContainer>

      {/* Map Crosshair Overlay - Always visible, non-interactive */}
      <MapCrosshair 
        stopCardsHeight={areStopCardsVisible ? stopCardsHeight : 0}
        statsCardHeight={isMobile ? (isStatsCardExpanded ? 216 : 116) : 0}
        isMobile={isMobile} />

      {/* NEW: Zoom Level Overlay */}
      {showZoomOverlay &&
        <div className="absolute top-4 left-4 z-[99999] px-4 py-2 rounded-lg shadow-lg transition-opacity duration-300 pointer-events-none" style={{ background: 'var(--text-slate-900)', color: 'var(--bg-white)' }}>
          <div className="flex items-center gap-2">
            {/* <span className="text-sm font-medium">Zoom Level:</span> */}
            <span className="text-lg font-bold">{currentZoom.toFixed(1)}</span>
          </div>
        </div>
      }

      {/* Driver Legend - Shows driver colors when in "All Drivers" mode */}
      {showLegend && driverRoutes.length > 0 && (
        (() => {
          const DriverLegend = React.lazy(() => import('./DriverLegend'));
          return (
            <React.Suspense fallback={null}>
              <DriverLegend
                legendRef={legendRef}
                legendLeft={legendLeft}
                isStatsCardExpanded={isStatsCardExpanded}
                driverRoutes={driverRoutes}
                highlightedRouteId={highlightedRouteId}
                setHighlightedRouteId={setHighlightedRouteId}
                onLegendInteraction={onLegendInteraction}
              />
            </React.Suspense>
          );
        })()
      )}

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
          0%, 100% {
            stroke-width: 2;
            opacity: 0.85;
          }
          50% {
            stroke-width: 4;
            opacity: 0.3;
          }
        }
        
        .pulsating-halo {
          animation: pulseHalo 1s ease-in-out infinite;
        }
      `}</style>
    </div>
  );
}