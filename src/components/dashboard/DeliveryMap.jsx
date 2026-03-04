import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import * as ReactExports from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMapEvents, Circle } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { getStoreColor, hexToRgba } from '../utils/colorGenerator';
import { sortUsers } from '../utils/sorting';
import MapModeControl from "./MapModeControl";
import { MapPin, Phone, Clock, Package, Truck, StickyNote, UserRoundSearch, Car, Home, Navigation, Activity, User, CheckCircle2, XCircle } from 'lucide-react';
import { userHasRole, isAppOwner } from '../utils/userRoles';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { format } from 'date-fns';
import { createRoot } from 'react-dom/client';
import { getStoredRouteCoordinates } from '../utils/routePolylineManager';
import { isMobileDevice } from '../utils/deviceUtils';
import MapCrosshair from './MapCrosshair';
import SpecialSymbolsBadges from '../utils/SpecialSymbolsBadges';
import { base44 } from '@/api/base44Client';
import { formatPhoneNumber } from '../utils/phoneFormatter';
import DriverLocationMarkers from './DriverLocationMarkers';

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
  HIDE_ROUTES: 10, // Below this, hide routes completely
  SIMPLIFY_ROUTES: 12, // Below this, simplify route lines
  HIDE_NUMBERS: 11, // Below this, hide stop numbers
  HIDE_CIRCLES: 11, // Below this, hide pickup circles
  FULL_DETAIL: 13 // At or above this, show full detail
};

// Shared finished statuses array
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

import { createSimpleCircleIcon, createStoreIcon, createDeliveryIcon, createLiveLocationDot, createHomeIcon } from './MapIcons';

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

// Helper function to check if a delivery is a first-time delivery
const isFirstTimeDelivery = (delivery) => {
  return delivery.first_delivery || false;
};

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
  onMapReady = () => {} // NEW: Callback when ALL map elements are rendered
}) {
  const mapRef = useRef(null);
  const [map, setMap] = useState(null);
  const [hoveredMarkerId, setHoveredMarkerId] = useState(null);
  const [fadedMarkerHighlights, setFadedMarkerHighlights] = useState(new Set()); // markers hovered/clicked while faded
  const markerRefs = useRef({});
  const [hasInitialFit, setHasInitialFit] = useState(false);
  const [currentZoom, setCurrentZoom] = useState(zoom);
  const isMobile = useMemo(() => isMobileDevice(), []); // MODIFIED: Use isMobileDevice utility function
  const [googleRouteCoordinates, setGoogleRouteCoordinates] = useState(null);
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
  
  // CRITICAL: Use previous cached users if current is empty to prevent flickering
  const prevSafeUsersRef = useRef([]);
  const safeUsers = (() => {
    if (Array.isArray(realtimeAppUsers) && realtimeAppUsers.length > 0) {
      // Log first few users to debug "Unknown" issue
      console.log(`✅ [DeliveryMap] safeUsers updated with ${realtimeAppUsers.length} users:`, 
        realtimeAppUsers.slice(0, 3).map(u => ({
          id: u?.id?.slice(-4),
          name: u?.user_name || u?.full_name || 'NO NAME',
          lat: u?.current_latitude?.toFixed(5),
          lon: u?.current_longitude?.toFixed(5)
        }))
      );
      prevSafeUsersRef.current = realtimeAppUsers;
      return realtimeAppUsers;
    } else if (prevSafeUsersRef.current.length > 0) {
      console.warn(`⚠️ [DeliveryMap] realtimeAppUsers empty - preserving ${prevSafeUsersRef.current.length} cached users`);
      return prevSafeUsersRef.current;
    } else {
      console.error(`❌ [DeliveryMap] No users available - both current and cache are empty!`);
      return [];
    }
  })();

  // CRITICAL: Initialize realtimeAppUsers from offline DB on mount
  // This ensures we ALWAYS have AppUser data regardless of parent prop
  useEffect(() => {
    const loadAppUsersFromOfflineDB = async () => {
      try {
        const { offlineDB } = await import('./../../components/utils/offlineDatabase');
        const offlineAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
        
        if (offlineAppUsers && offlineAppUsers.length > 0) {
          console.log(`✅ [DeliveryMap] Loaded ${offlineAppUsers.length} AppUsers from offline DB on mount`);
          setRealtimeAppUsers(offlineAppUsers);
        } else {
          console.warn(`⚠️ [DeliveryMap] No AppUsers in offline DB - will use prop when available`);
        }
      } catch (error) {
        console.error('❌ [DeliveryMap] Failed to load AppUsers from offline DB:', error);
      }
    };
    
    // Load immediately on mount
    loadAppUsersFromOfflineDB();
  }, []); // Empty deps - only run on mount

  // CRITICAL: Update from users prop OR listen to WebSocket events
  // Don't clear realtimeAppUsers when users becomes temporarily empty during refresh
  useEffect(() => {
    if (users && users.length > 0) {
      console.log(`✅ [DeliveryMap] Updating realtimeAppUsers with ${users.length} users from prop`);
      setRealtimeAppUsers(users);
    } else if (users && users.length === 0 && realtimeAppUsers.length > 0) {
      // Don't clear - preserve existing data during temporary empty state
      console.warn(`⚠️ [DeliveryMap] users prop is empty but realtimeAppUsers has ${realtimeAppUsers.length} - preserving existing data`);
    }
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

      // CRITICAL: Handle merge mode - merge single driver update with existing realtimeAppUsers
      if (mergeMode === 'merge' && appUsers && appUsers.length > 0) {
        console.log(`🔀 [DeliveryMap] Merge mode - combining ${appUsers.length} updated drivers with existing`);
        
        setRealtimeAppUsers(prev => {
          if (!prev || prev.length === 0) {
            console.warn(`⚠️ [DeliveryMap] Merge mode but realtimeAppUsers empty - using updated data as-is`);
            return appUsers;
          }
          
          // Create map of updated drivers
          const updatedMap = new Map();
          appUsers.forEach(au => {
            if (au?.user_id || au?.id) {
              updatedMap.set(au.user_id || au.id, au);
            }
          });
          
          // Merge: replace updated drivers, keep others
          const merged = prev.map(u => {
            const userId = u?.user_id || u?.id;
            if (userId && updatedMap.has(userId)) {
              return updatedMap.get(userId);
            }
            return u;
          });
          
          // Add any new drivers not in existing list
          appUsers.forEach(au => {
            const userId = au?.user_id || au?.id;
            if (userId && !prev.some(u => (u?.user_id || u?.id) === userId)) {
              merged.push(au);
            }
          });
          
          console.log(`✅ [DeliveryMap] Merged: ${appUsers.length} updated + ${prev.length - appUsers.length} existing = ${merged.length} total`);
          return merged;
        });
        
        // CRITICAL: Force polyline re-render
        setPolylineRenderKey(prev => prev + 1);
        setRouteRenderKey(prev => prev + 1);
        return;
      }

      // CRITICAL: Handle single driver updates (from status toggle, locationTracker, etc.)
      // singleUpdate is a boolean flag; the actual updated user is in appUsers[0]
      if (singleUpdate && appUsers && appUsers.length === 1) {
        const updatedUser = appUsers[0];
        console.log(`🔄 [DeliveryMap] Single AppUser update:`, updatedUser?.user_name || updatedUser?.id);
        setRealtimeAppUsers(prev => {
          // CRITICAL: Don't update if prev is empty - preserve data
          if (!prev || prev.length === 0) {
            console.warn(`⚠️ [DeliveryMap] Skipping single update - realtimeAppUsers is empty`);
            return prev;
          }
          // Match by id OR user_id (locationTracker uses AppUser.id, not User.id)
          return prev.map(u => 
            (u?.id === updatedUser?.id || u?.id === updatedUser?.user_id) ? { ...u, ...updatedUser } : u
          );
        });
        // CRITICAL: Force polyline re-render when driver location changes
        setPolylineRenderKey(prev => prev + 1);
        // CRITICAL: Force delivery marker refresh to update status colors
        setRouteRenderKey(prev => prev + 1);
        return;
      }

      // CRITICAL: Handle bulk updates (from smart refresh or other events) - merge with existing
      if (appUsers && appUsers.length > 0) {
        console.log(`🔄 [DeliveryMap] Bulk AppUser update: ${appUsers.length} users`);
        
        setRealtimeAppUsers(prev => {
          if (!prev || prev.length === 0) {
            console.log(`📥 [DeliveryMap] No existing drivers - using ${appUsers.length} updated drivers`);
            return appUsers;
          }
          
          // Create map of updated drivers for efficient lookup
          const updatedMap = new Map();
          appUsers.forEach(au => {
            const userId = au?.id || au?.user_id;
            if (userId) {
              updatedMap.set(userId, au);
            }
          });
          
          // Merge: update existing drivers, keep ones not in update
          const merged = prev.map(u => {
            const userId = u?.id || u?.user_id;
            return userId && updatedMap.has(userId) ? updatedMap.get(userId) : u;
          });
          
          // Add any new drivers not in existing list
          appUsers.forEach(au => {
            const userId = au?.id || au?.user_id;
            if (userId && !prev.some(u => (u?.id || u?.user_id) === userId)) {
              merged.push(au);
            }
          });
          
          console.log(`✅ [DeliveryMap] Merged: ${appUsers.length} updated + ${prev.filter(u => !updatedMap.has(u?.id || u?.user_id)).length} existing = ${merged.length} total`);
          return merged;
        });
        // CRITICAL: Force polyline re-render when driver locations change
        setPolylineRenderKey(prev => prev + 1);
        // CRITICAL: Force delivery marker refresh to update status colors
        setRouteRenderKey(prev => prev + 1);
      } else if (appUsers && Array.isArray(appUsers) && appUsers.length === 0) {
        // CRITICAL: Only log warning if this is actually an empty array, not undefined
        console.log(`⚠️ [DeliveryMap] Received empty appUsers array - preserving existing ${realtimeAppUsers.length} users`);
      }
    };

    // NEW: Listen for delivery updates to force complete route recalculation
    const handleDeliveriesUpdate = (event) => {
      // CRITICAL: Clear cached routes to force full recalculation
      prevDriverRoutesRef.current = [];
      // Force re-render by incrementing BOTH keys
      setRouteRenderKey(prev => prev + 1);
      setPolylineRenderKey(prev => prev + 1);
    };

    // NEW: Listen for route optimization completion to refresh map
    const handleRouteOptimizationComplete = (event) => {
      prevDriverRoutesRef.current = [];
      setRouteRenderKey(prev => prev + 1);
      setPolylineRenderKey(prev => prev + 1);
    };

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
    const today = format(new Date(), 'yyyy-MM-dd');
    return selectedDate === today;
  }, [isDriverViewingSelf, selectedDate]);

  const [otherDriverDeliveries, setOtherDriverDeliveries] = useState([]);

  // CRITICAL: Load AppUser data for ALL drivers with deliveries on selected date
  // This ensures Type 1 polylines for other drivers can access fresh location data
  useEffect(() => {
    const loadAllDriverAppUsers = async () => {
      if (!selectedDate || safeDeliveries.length === 0) return;

      try {
        // Get all unique driver IDs from deliveries (including other drivers)
        const uniqueDriverIds = new Set(
          [...safeDeliveries, ...otherDriverDeliveries]
            .filter(d => d && d.driver_id)
            .map(d => d.driver_id)
        );

        if (uniqueDriverIds.size === 0) return;

        console.log(`📥 [DeliveryMap] Loading AppUser data for ${uniqueDriverIds.size} drivers with deliveries...`);

        // Fetch AppUser for each driver ID
        const { offlineDB } = await import('./../../components/utils/offlineDatabase');
        const allAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);

        if (!allAppUsers || allAppUsers.length === 0) {
          console.warn(`⚠️ [DeliveryMap] No AppUsers in offline DB - Type 1 polylines may use stale data`);
          return;
        }

        // Merge with existing realtimeAppUsers - add any missing drivers
        setRealtimeAppUsers(prev => {
          const existingMap = new Map(prev.map(u => [u.id, u]));
          
          allAppUsers.forEach(appUser => {
            if (uniqueDriverIds.has(appUser.id) && !existingMap.has(appUser.id)) {
              existingMap.set(appUser.id, appUser);
            }
          });

          const merged = Array.from(existingMap.values());
          console.log(`✅ [DeliveryMap] Loaded AppUsers for all delivery drivers: ${merged.length} total`);
          return merged;
        });
      } catch (error) {
        console.error('❌ [DeliveryMap] Failed to load all driver AppUsers:', error);
      }
    };

    loadAllDriverAppUsers();
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

  // NEW: Fetch Google route polyline for display
  useEffect(() => {
  const fetchGoogleRoute = async () => {
  // Only fetch if:
  // 1. We have deliveries to display
  // 2. We're in single driver mode
  // 3. showRoutes is enabled
  if (!safeDeliveries.length || !isSingleDriverMode || !showRoutes) {
    setGoogleRouteCoordinates(null);
    return;
  }

  // Get the driver ID from deliveries
  const driverId = safeDeliveries[0]?.driver_id;
  if (!driverId) {
    setGoogleRouteCoordinates(null);
    return;
  }

  // Get delivery date
  const deliveryDate = safeDeliveries[0]?.delivery_date;
  if (!deliveryDate) {
    setGoogleRouteCoordinates(null);
    return;
  }

  // Check if route has started (has in-transit or completed stops)
  const hasStarted = safeDeliveries.some((d) =>
    ['in_transit', ...FINISHED_STATUSES].includes(d.status)
  );

      if (hasStarted) {
        setGoogleRouteCoordinates(null);
        return;
      }

      try {
        const coordinates = await getStoredRouteCoordinates(
          driverId,
          deliveryDate,
          'to_first_stop'
        );

        if (coordinates && coordinates.length > 0) {
          const leafletCoords = coordinates.map((coord) => [coord.lat, coord.lng]);
          setGoogleRouteCoordinates(leafletCoords);
        } else {
          setGoogleRouteCoordinates(null);
        }
      } catch (error) {
        setGoogleRouteCoordinates(null);
      }
    };

    fetchGoogleRoute();
  }, [safeDeliveries, isSingleDriverMode, showRoutes]);

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
    if (currentZoom < 11 || currentZoom > 18) {
      return [originalLat, originalLng];
    }
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
      const bounds = L.latLngBounds([marker.latitude, marker.longitude]);
      
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
        const fitOptions = { 
          paddingTopLeft: [80, 80],
          paddingBottomRight: [80, dynamicBottomPadding],
          maxZoom: 14,
          animate: true,
          duration: 0.6
        };
        
        // Create bounds around just the original cluster point
        const clusterBounds = L.latLngBounds([
          [marker.latitude, marker.longitude],
          [marker.latitude, marker.longitude]
        ]);
        
        (map && map.getCenter && map._loaded && map._mapPane && map._mapPane._leaflet_pos) && map.fitBounds(clusterBounds, fitOptions);
        
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
      const dynamicTopPadding = statsCardHeight + 40; // Increased buffer to prevent centering too high

      // Calculate dynamic bottom padding for message balloon
      const messageBalloonsHeight = 120; // Approximate height of popup balloon + padding
      const stopCardsFullContainer = document.querySelector('.horizontal-cards-container');
      let dynamicBottomPadding = messageBalloonsHeight + 20; // Add buffer

      if (stopCardsFullContainer) {
        const actualHeight = stopCardsFullContainer.getBoundingClientRect().height;
        dynamicBottomPadding = Math.max(actualHeight + messageBalloonsHeight + 20, messageBalloonsHeight + 20);
      }

      // Create a small bounds box centered on the marker
      const markerBounds = L.latLngBounds([
        [marker.latitude, marker.longitude],
        [marker.latitude, marker.longitude]
      ]);

      // Center map with proper zoom and offset to show balloon fully
      // Using uneven padding to keep marker high on screen with space below for cards
      const panOptions = {
        paddingTopLeft: [60, dynamicTopPadding + 50],
        paddingBottomRight: [60, dynamicBottomPadding],
        animate: true,
        duration: 0.6,
        maxZoom: targetZoom
      };

        (map && map.getCenter && map._loaded && map._mapPane && map._mapPane._leaflet_pos) && map.fitBounds(markerBounds, panOptions);
      
      // Set the zoom to target zoom level
      setTimeout(() => {
        if (map && map.getZoom && map._loaded && map._mapPane && map._mapPane._leaflet_pos && map.getZoom() < targetZoom) {
          map.setZoom(targetZoom, { animate: true, duration: 0.3 });
        }
      }, 600);
      
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
    const today = format(new Date(), 'yyyy-MM-dd');
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
    const today = format(new Date(), 'yyyy-MM-dd');
    const isViewingTodayOrFuture = !selectedDate || selectedDate >= today;
    
    if (!isViewingTodayOrFuture) {
      prevDriverLocationMarkersRef.current = [];
      return [];
    }

    // CRITICAL: If safeUsers is empty, preserve previous markers to prevent flickering
    if (!safeUsers || safeUsers.length === 0) {
      console.warn(`⚠️ [DeliveryMap] safeUsers is empty - preserving ${prevDriverLocationMarkersRef.current.length} previous markers`);
      return prevDriverLocationMarkersRef.current;
    }

    const isCurrentUserAdmin = currentUser && userHasRole(currentUser, 'admin');
    const isCurrentUserDispatcher = currentUser && userHasRole(currentUser, 'dispatcher');
    const isCurrentUserDriver = currentUser && userHasRole(currentUser, 'driver');
    
    // CRITICAL: Pure dispatcher = dispatcher role WITHOUT driver or admin
    const isPureDispatcher = isCurrentUserDispatcher && !isCurrentUserDriver && !isCurrentUserAdmin;
    
    const currentUserCityId = currentUser?.city_id;
    const fiveMinutesInMs = 5 * 60 * 1000;
    const now = Date.now();
    const todayStr = format(new Date(), 'yyyy-MM-dd');
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

      // CRITICAL: Check staleness
      let isStaleLocation = false;
      let locationAge = 0;
      if (user.location_updated_at) {
        locationAge = now - new Date(user.location_updated_at).getTime();
        isStaleLocation = locationAge > fiveMinutesInMs;
      } else {
        isStaleLocation = true;
      }

      // CRITICAL: Show other drivers in same city (admins see all cities)
      // Self is already filtered out above on mobile
      if (isMobile && (isCurrentUserDriver || isCurrentUserAdmin) && !isPureDispatcher) {
        if (!isCurrentUserAdmin && currentUserCityId && user.city_id !== currentUserCityId) {
          return null;
        }
      }
      // CRITICAL: RULE 2 - Desktop drivers/admins: show ALL drivers (including self)
      else if (!isMobile && (isCurrentUserDriver || isCurrentUserAdmin) && !isPureDispatcher) {
        // Show all drivers in same city (admins see all cities)
        if (!isCurrentUserAdmin && currentUserCityId && user.city_id !== currentUserCityId) {
          return null;
        }
      }
      // CRITICAL: RULE 3 - Pure dispatchers: Only show drivers with active deliveries in their stores
      // CRITICAL: Dispatchers can ONLY see shared location marker when driver is on_duty
      // on_break = show polyline only, NOT shared marker
      // off_duty = show nothing
      else if (isPureDispatcher) {
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

    // CRITICAL: Only update cache if we have valid markers
    if (markers.length > 0) {
      console.log(`✅ [DeliveryMap] driverLocationMarkers: ${markers.length} markers calculated`);
      prevDriverLocationMarkersRef.current = markers;
      return markers;
    } else if (prevDriverLocationMarkersRef.current.length > 0) {
      // No new markers but we had markers before - preserve them
      console.warn(`⚠️ [DeliveryMap] No new markers calculated - preserving ${prevDriverLocationMarkersRef.current.length} previous markers`);
      return prevDriverLocationMarkersRef.current;
    } else {
      // No markers at all
      return [];
    }
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
    const today = format(new Date(), 'yyyy-MM-dd');
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
      driver: currentUser
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
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
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
    if (!showRoutes || !currentUser || (selectedDate && selectedDate < format(new Date(), 'yyyy-MM-dd'))) {
      // Hide home markers on past dates; clear any cached markers to avoid stale display
      prevDriverHomeMarkersRef.current = [];
      return [];
    }

    // CRITICAL: If safeUsers is empty, preserve previous markers
    if (!safeUsers || safeUsers.length === 0) {
      console.warn(`⚠️ [DeliveryMap] safeUsers empty in driverHomeMarkers - preserving ${prevDriverHomeMarkersRef.current.length} previous markers`);
      return prevDriverHomeMarkersRef.current;
    }

    // CRITICAL: Dispatchers should not see home locations
    if (userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
      prevDriverHomeMarkersRef.current = [];
      return [];
    }

    // Check if current user is app owner (Base44 platform admin)
    const isCurrentUserDriver = userHasRole(currentUser, 'driver');
    const isCurrentUserAdmin = userHasRole(currentUser, 'admin');
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

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
      if (!isShowAllMode && driverId !== selectedDriverId) return;
      const allStops = [...stops.deliveries, ...stops.pickups];
      
      // Count incomplete stops (exclude pending)
      const incompleteStops = allStops.filter(s => !finishedStatuses.includes(s.status) && s.status !== 'pending');
      const completedStops = allStops.filter(s => finishedStatuses.includes(s.status));
      
      // CRITICAL: Check if there are ANY unfinished pickups (including pending)
      // Home marker should NOT show until ALL pickups are complete/canceled/failed
      const unfinishedPickups = stops.pickups.filter(s => !finishedStatuses.includes(s.status));
      
      // RULE 1: Show home marker if ALL stops are incomplete (route not started)
      if (incompleteStops.length > 0 && completedStops.length === 0) {
        driversToShowHome.add(driverId);
        return;
      }
      
      // RULE 2: Show home marker if ALL stops are complete AND all pickups are finished
      // CRITICAL: Don't show home marker if there are ANY unfinished pickups (pending or incomplete)
      if (incompleteStops.length === 0 && completedStops.length > 0 && unfinishedPickups.length === 0) {
        driversToShowHome.add(driverId);
        return;
      }
      
      // RULE 3: Hide home marker if some stops are complete and some are incomplete (mid-route)
    });

    // CRITICAL: If no drivers found but we have cached markers, preserve them during refresh
    // This prevents flickering when deliveries array briefly becomes empty during smart refresh
    if (driversToShowHome.size === 0 && prevDriverHomeMarkersRef.current.length > 0) {
      return prevDriverHomeMarkersRef.current;
    }

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
        (isCurrentUserDriver && driver.id === currentUser.id && (selectedDriverId === 'all' || selectedDriverId === currentUser.id));
      
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
    if (!map) {
      return;
    }

    // SAFETY: Ensure map is fully loaded before attempting operations
    if (!map.getCenter || !map._loaded) {
      return;
    }

    // CRITICAL: Verify map panes exist before operations
    if (!map._panes || !map._mapPane) {
      console.warn('[DeliveryMap] Map panes not initialized, skipping bounds fit');
      return;
    }

    // CRITICAL: Only apply map changes when shouldFitBounds is explicitly set
    // This prevents auto-centering when other props changes
    if (!shouldFitBounds) {
      return;
    }

    // CRITICAL: Verify map pane element exists (prevents _leaflet_pos error during unmount/zoom transitions)
    try {
      if (!map._mapPane || !map._mapPane._leaflet_pos) {
        console.warn('[DeliveryMap] Map pane position not available yet, skipping bounds fit');
        return;
      }
    } catch (e) {
      return;
    }

    try {
      const bounds = L.latLngBounds(shouldFitBounds.bounds);
      
      // CRITICAL: Mark this as a programmatic zoom BEFORE calling fitBounds
      // Use a ref that persists across the entire zoom operation (zoomstart -> zoomend)
      // Access the MapController's ref through a closure
      if (map._leaflet_events?.zoomstart) {
        // Store flag globally on map instance so MapController can access it
        if (!map._isProgrammaticZoom) {
          Object.defineProperty(map, '_isProgrammaticZoom', {
            value: { current: false },
            writable: true,
            configurable: true
          });
        }
        map._isProgrammaticZoom.current = true;
      }
      
      // CRITICAL: Use padding values directly from Dashboard.js - don't override
      const modifiedOptions = { 
        ...shouldFitBounds.options,
        animate: true,
        duration: 0.8 // Smooth 800ms animation
      };
      
      (map && map.getCenter && map._loaded && map._mapPane && map._mapPane._leaflet_pos) && map.fitBounds(bounds, modifiedOptions);

      if (onBoundsFitted && typeof onBoundsFitted === 'function') {
        onBoundsFitted();
      }
    } catch (error) {
      console.warn('[DeliveryMap] Error during bounds fit:', error);
    }
  }, [map, shouldFitBounds, stopCardsHeight, onBoundsFitted]);

  // Handle marker drag end
  const handleMarkerDragEnd = useCallback((markerId, event, type) => {
    try {
      const newLatLng = event.target.getLatLng();
    } catch (error) {}
  }, []);

  // Track popup visibility timeouts for driver location markers
  const popupTimeoutsRef = useRef({});
  
  const handleDriverLocationPopupHover = (locationId, isHovering) => {
    if (isHovering) {
      // Clear timeout when hovering over popup
      if (popupTimeoutsRef.current[locationId]) {
        clearTimeout(popupTimeoutsRef.current[locationId]);
        popupTimeoutsRef.current[locationId] = null;
      }
    } else {
      // Set 2-second delay before closing when leaving popup
      popupTimeoutsRef.current[locationId] = setTimeout(() => {
        const markers = document.querySelectorAll(`[data-driver-location-id="${locationId}"] .leaflet-popup`);
        markers.forEach(m => {
          const closeBtn = m.querySelector('.leaflet-popup-close-button');
          if (closeBtn) closeBtn.click();
        });
      }, 2000);
    }
  };



  return (
    <div className="absolute inset-0">
      <MapContainer
        key="delivery-map-container"
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

        {(() => { const MC = React.lazy(() => import('./MapController')); return (<React.Suspense fallback={null}><MC /></React.Suspense>); })()}

        {/* NEW: Draw Google Directions route polyline (if available) - CURRENT DATE ONLY, ONLY if route NOT started */}
        {/* CRITICAL: This is the PRE-ROUTE polyline (before any stops started). Once route starts, we use currentToNextPolyline instead */}
        {isViewingCurrentDate && googleRouteCoordinates && googleRouteCoordinates.length > 1 && !currentToNextPolyline &&
          <Polyline
            positions={googleRouteCoordinates}
            pathOptions={{
              color: '#2563eb',
              weight: 5,
              opacity: 1,
              dashArray: '10, 5',
              lineJoin: 'round',
              lineCap: 'round'
            }} />

        }

        {/* TYPE 2 & 3 POLYLINES: Colored lines connecting stops in stop_order sequence */}
         {showRoutes && (() => {
           // CRITICAL: Return cached polylines if safeUsers is empty
           if (!safeUsers || safeUsers.length === 0) {
             console.warn(`⚠️ [DeliveryMap] safeUsers empty in Type 2/3 polylines - skipping render`);
             return null;
           }
           
           const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
           const polylines = [];
           
           // Helper: Calculate time difference between two stops in minutes
           const getTimeDifferenceMinutes = (stop1, stop2) => {
             // For completed stops, use actual_delivery_time
             const time1 = stop1.actual_delivery_time 
               ? new Date(stop1.actual_delivery_time)
               : stop1.delivery_time_eta 
                 ? new Date(`2000-01-01T${stop1.delivery_time_eta}:00`)
                 : stop1.delivery_time_start 
                   ? new Date(`2000-01-01T${stop1.delivery_time_start}:00`)
                   : null;
             
             const time2 = stop2.actual_delivery_time 
               ? new Date(stop2.actual_delivery_time)
               : stop2.delivery_time_eta 
                 ? new Date(`2000-01-01T${stop2.delivery_time_eta}:00`)
                 : stop2.delivery_time_start 
                   ? new Date(`2000-01-01T${stop2.delivery_time_start}:00`)
                   : null;
             
             if (!time1 || !time2) return 0;
             
             return Math.abs(time2 - time1) / (1000 * 60); // Convert to minutes
           };

           driverRoutes.forEach(route => {
             if (!route.driverId) return;

             // CRITICAL: Use route.color for this driver's unique color
             const driverPolylineColor = route.color;

             // CRITICAL: deliveryMarkers and pickupMarkers ALREADY include other drivers when showOtherDriverDeliveries is true
             // No need to merge otherDriverDeliveries again - just filter by driver ID
             const sourceDeliveries = deliveryMarkers.filter(d => d && d.driver_id === route.driverId);
             const sourcePickups = pickupMarkers.filter(p => p && p.driver_id === route.driverId);
            
            const allDriverStops = [...sourcePickups, ...sourceDeliveries]
              .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
            
            if (allDriverStops.length < 2) return;
            
            // Check if route is completed
            const isRouteCompleted = allDriverStops.every(s => finishedStatuses.includes(s.status));
            
            // TYPE 3: For completed routes, show all stops connected (ANY DATE)
            if (isRouteCompleted) {
              for (let i = 0; i < allDriverStops.length - 1; i++) {
                const stop1 = allDriverStops[i];
                const stop2 = allDriverStops[i + 1];
                
                if (!stop1 || !stop2) continue;
                
                // CRITICAL: Validate coordinates
                if (typeof stop1.latitude !== 'number' || typeof stop1.longitude !== 'number' ||
                    typeof stop2.latitude !== 'number' || typeof stop2.longitude !== 'number' ||
                    isNaN(stop1.latitude) || isNaN(stop1.longitude) ||
                    isNaN(stop2.latitude) || isNaN(stop2.longitude)) {
                  console.warn('[DeliveryMap] Skipping TYPE 3 polyline with invalid coordinates');
                  continue;
                }
                
                // CRITICAL: Skip polyline if time gap > 90 minutes
                const timeDiffMinutes = getTimeDifferenceMinutes(stop1, stop2);
                if (timeDiffMinutes > 90) {
                  console.log(`⏭️ [TYPE 3] Skipping polyline - ${timeDiffMinutes.toFixed(0)} min gap exceeds 90 min threshold`);
                  continue;
                }
                
                const isAM = stop2.ampm_deliveries === 'AM';
                const dashArray = isAM ? '10, 5' : '2, 8';
                
                // FADE: Segment is highlighted if either endpoint is the highlighted stop
                // CRITICAL: Don't fade segments for the selected driver's complete route
                const isSegmentHighlighted = highlightedDeliveryId &&
                  (stop1.id === highlightedDeliveryId || stop2.id === highlightedDeliveryId);
                const isSelectedDriverRoute = selectedDriverId && selectedDriverId !== 'all' && route.driverId === selectedDriverId;
                const type3Opacity = isSelectedDriverRoute ? 0.7 : isSegmentHighlighted ? 0.85 : 0.2;
                
                polylines.push(
                  <Polyline
                    key={`type3-${route.driverId}-${i}-${polylineRenderKey}-${highlightedDeliveryId || 'none'}`}
                    positions={[
                      [stop1.latitude, stop1.longitude],
                      [stop2.latitude, stop2.longitude]
                    ]}
                    pathOptions={{
                      color: driverPolylineColor,
                      weight: 4,
                      opacity: type3Opacity,
                      dashArray: dashArray,
                      lineJoin: 'round',
                      lineCap: 'round'
                    }}
                    pane="overlayPane"
                  />
                );
              }
            } else if (isViewingCurrentDate) {
              // TYPE 2: For active routes, only show on CURRENT DATE
              // TYPE 2 ONLY: For incomplete routes, show only incomplete segments (no TYPE 3)
              
              // Split stops into completed and incomplete
              const completedStops = allDriverStops.filter(s => finishedStatuses.includes(s.status));
              const incompleteStops = allDriverStops.filter(s => !finishedStatuses.includes(s.status) && s.status !== 'pending');
              
              // CRITICAL: Skip TYPE 3 for incomplete routes - only TYPE 2 is shown
              // TYPE 2: Draw incomplete segments (from next stop onwards)
              // CRITICAL: For other drivers, isNextDelivery may not be set - find first incomplete stop instead
              let nextStop = incompleteStops.find(s => s.isNextDelivery === true);
              
              // If no isNextDelivery flag, use first incomplete stop (for other drivers in Show All mode)
              if (!nextStop && incompleteStops.length > 0) {
                nextStop = incompleteStops[0];
              }
              
              const nextStopIndex = nextStop ? incompleteStops.indexOf(nextStop) : 0;
              
              for (let i = nextStopIndex; i < incompleteStops.length - 1; i++) {
                const stop1 = incompleteStops[i];
                const stop2 = incompleteStops[i + 1];
                
                if (!stop1 || !stop2) continue;
                
                // CRITICAL: Validate coordinates
                if (typeof stop1.latitude !== 'number' || typeof stop1.longitude !== 'number' ||
                    typeof stop2.latitude !== 'number' || typeof stop2.longitude !== 'number' ||
                    isNaN(stop1.latitude) || isNaN(stop1.longitude) ||
                    isNaN(stop2.latitude) || isNaN(stop2.longitude)) {
                  console.warn('[DeliveryMap] Skipping TYPE 2 polyline with invalid coordinates');
                  continue;
                }
                
                // CRITICAL: Skip polyline if time gap > 90 minutes
                const timeDiffMinutes = getTimeDifferenceMinutes(stop1, stop2);
                if (timeDiffMinutes > 90) {
                  console.log(`⏭️ [TYPE 2] Skipping polyline - ${timeDiffMinutes.toFixed(0)} min gap exceeds 90 min threshold`);
                  continue;
                }
                
                const isAM = stop2.ampm_deliveries === 'AM';
                const dashArray = isAM ? '10, 5' : '2, 8';
                
                // CRITICAL: Type 2 polylines should NOT be blue - use non-blue color
                const type2Color = driverPolylineColor === '#1E90FF' || driverPolylineColor === '#00CED1' || driverPolylineColor === '#3B82F6'
                  ? '#8A2BE2' // Blue Violet instead of blue
                  : driverPolylineColor;
                
                polylines.push(
                  <Polyline
                    key={`type2-${route.driverId}-${i}-${polylineRenderKey}`}
                    positions={[
                      [stop1.latitude, stop1.longitude],
                      [stop2.latitude, stop2.longitude]
                    ]}
                    pathOptions={{
                      color: type2Color,
                      weight: 4,
                      opacity: 0.7,
                      dashArray: dashArray,
                      lineJoin: 'round',
                      lineCap: 'round'
                    }}
                    pane="overlayPane"
                  />
                );
              }
            }
          });

          // CRITICAL: Type 1 polyline for drivers with complete routes (to home) - ONLY CURRENT DATE
          if (isViewingCurrentDate) {
            // Helper to get driver name (defined in parent scope)
            const getDriverNameComplete = (driverId) => {
              const driver = safeUsers.find(u => u && u.id === driverId);
              return driver ? (driver.user_name || driver.full_name || `Driver-${driverId}`) : `Unknown-${driverId}`;
            };
            
            console.log('🔵 [Type1Poly-Complete] Processing driversWithCompleteRoute:', Array.from(driversWithCompleteRoute).map(id => getDriverNameComplete(id)));
            
            // Handled by HereType1Polylines component
            driversWithCompleteRoute.forEach(() => {});
            
            console.log(`🔵 [Type1Poly-Complete] Total polylines to HOME: ${polylines.filter(p => p.key?.includes('type1-home')).length}`);
          }

console.log(`🔵 [Type1Poly] FINAL: Returning ${polylines.length} total Type 1 polylines`);
return polylines.length > 0 ? polylines : null;
})()}



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
          if (!currentDriverMarker) return (
            <React.Suspense fallback={null}>
              <HeadingUpRotator isMobile={isMobile} currentDriverMarker={currentDriverMarker} />
            </React.Suspense>
          );
          if (!currentDriverMarker.latitude || !currentDriverMarker.longitude ||
              typeof currentDriverMarker.latitude !== 'number' || typeof currentDriverMarker.longitude !== 'number' ||
              isNaN(currentDriverMarker.latitude) || isNaN(currentDriverMarker.longitude)) {
            return null;
          }
          return (
            <>
              <React.Suspense fallback={null}>
                <HeadingUpRotator isMobile={isMobile} currentDriverMarker={currentDriverMarker} />
              </React.Suspense>
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
        {isViewingCurrentDate && (
          (() => {
            const HereType1Polylines = React.lazy(() => import('./HereType1Polylines'));
            return (
              <React.Suspense fallback={null}>
                <HereType1Polylines
                  isViewingCurrentDate={isViewingCurrentDate}
                  deliveryMarkers={deliveryMarkers}
                  pickupMarkers={pickupMarkers}
                  driverHomeMarkers={driverHomeMarkers}
                />
              </React.Suspense>
            );
          })()
        )}

        {/* ===== RENDER ORDER 3: Home markers ===== */}
        {driverHomeMarkers.map((home) => {
          // CRITICAL: Validate coordinates before rendering marker
          if (!home.latitude || !home.longitude ||
              typeof home.latitude !== 'number' || typeof home.longitude !== 'number' ||
              isNaN(home.latitude) || isNaN(home.longitude)) {
            return null;
          }
          
          return (
            <Marker
              key={home.id}
              position={[home.latitude, home.longitude]}
              icon={createHomeIcon(home.driverColor)}
              zIndexOffset={4000}
              eventHandlers={{
                click: (e) => {
                  if (onMarkerClick) onMarkerClick(home, 'home');
                  
                  // Center marker on click
                  if (map) {
                    const targetZoom = isMobile ? 15 : 16;
                    const statsCard = document.querySelector('[data-stats-card]');
                    const statsCardHeight = statsCard ? statsCard.getBoundingClientRect().height : 0;
                    const dynamicTopPadding = statsCardHeight + 20;
                    
                    const messageBalloonsHeight = 120;
                    const stopCardsFullContainer = document.querySelector('.horizontal-cards-container');
                    let dynamicBottomPadding = messageBalloonsHeight + 20;
                    
                    if (stopCardsFullContainer) {
                      const actualHeight = stopCardsFullContainer.getBoundingClientRect().height;
                      dynamicBottomPadding = Math.max(actualHeight + messageBalloonsHeight + 20, messageBalloonsHeight + 20);
                    }
                    
                    const markerBounds = L.latLngBounds([
                      [home.latitude, home.longitude],
                      [home.latitude, home.longitude]
                    ]);
                    
                    (map && map.getCenter && map._loaded && map._mapPane && map._mapPane._leaflet_pos) && map.fitBounds(markerBounds, {
                      paddingTopLeft: [60, dynamicTopPadding + 50],
                      paddingBottomRight: [60, dynamicBottomPadding],
                      animate: true,
                      duration: 0.6,
                      maxZoom: targetZoom
                    });
                    
                    setTimeout(() => {
                      if (map && map.getZoom && map._loaded && map._mapPane && map._mapPane._leaflet_pos && map.getZoom() < targetZoom) {
                        map.setZoom(targetZoom, { animate: true, duration: 0.3 });
                      }
                      e.target.openPopup();
                    }, 600);
                  }
                },
                mouseover: (e) => {
                  e.target.openPopup();
                },
                mouseout: (e) => {
                  e.target.closePopup();
                }
              }}>

              <Popup
                autoPan={false}
                closeButton={false}
                offset={[0, -20]}
                className="custom-popup">

                <div className="min-w-[150px]">
                  <div className="flex items-center gap-1.5">
                    <Home className="w-3.5 h-3.5 text-emerald-600" />
                    <h3 className="font-semibold text-xs">{home.driverName}</h3>
                  </div>
                  <p className="text-[11px] text-gray-600 mt-1">Final Destination (Home)</p>
                  
                  {home.isRouteComplete && (
                    <button
                      onClick={() => {
                        const url = `https://www.google.com/maps/dir/?api=1&destination=${home.latitude},${home.longitude}`;
                        window.open(url, '_blank');
                      }}
                      className="w-full mt-3 px-2 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs rounded flex items-center justify-center gap-2 transition-colors"
                    >
                      <Navigation className="w-3.5 h-3.5" />
                      Go Home
                    </button>
                  )}
                </div>
              </Popup>
            </Marker>
          );
        })}

        {/* ===== RENDER ORDER 4: Route markers (pickups & deliveries) ===== */}
        {/* Store Pickup Markers - NOW WITH FANNING AND HIGHLIGHT HALOS */}
        {pickupMarkers.map((pickup, index) => {
          const locationKey = `${pickup.latitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${pickup.longitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
          const isClustered = pickup.duplicateCount > 1;
          const isFanned = fannedLocationKey === locationKey;
          const isHighlighted = highlightedDeliveryId === pickup.id;
          
          // FADE RULES:
          // 1. Selected driver markers = always 100% (no fade)
          // 2. Other driver incomplete markers = 75%
          // 3. In-progress route finished markers = 50%
          // 4. Completed route finished markers for selected driver = 100% (no fade)
          // 5. Hover/click on faded marker = 85%
          const isFinishedForFade = FINISHED_STATUSES.includes(pickup.status);
          const isSelectedDriverMarker = !pickup.isOtherDriver;
          const isSelectedRouteComplete = isSelectedDriverMarker && driversWithCompleteRoute.has(pickup.driver_id);
          const isRouteInProgress = !driversWithCompleteRoute.has(pickup.driver_id) && hasIncompleteStops;
          const isUserHoveringFaded = fadedMarkerHighlights.has(pickup.id);
          const isPickupFaded = isFinishedForFade && !isHighlighted && !isSelectedRouteComplete && !isSelectedDriverMarker;
          const isPickupInProgressFade = isFinishedForFade && isSelectedDriverMarker && !isSelectedRouteComplete && isRouteInProgress;
          const isPickupHighlightedFinished = (isPickupFaded || isPickupInProgressFade) && (isHighlighted || isUserHoveringFaded);
          
          // Calculate position based on fanning state
          let markerPosition = [pickup.latitude, pickup.longitude];
          let dynamicZIndex;
          
          const isFinished = FINISHED_STATUSES.includes(pickup.status);
          const isPending = pickup.status === 'pending';

          if (isPending) {
            // Rule 0: Pending markers ALWAYS on top (highest z-index)
            dynamicZIndex = 5000 + (500 - (pickup.number || 500));
          } else if (isFinished) {
            // Rule 2: Finished markers are at the bottom.
            // Order them by stop order so #1 is still on top of #2 if both are finished.
            dynamicZIndex = 100 + (500 - (pickup.number || 500));
          } else {
            // Rule 1: Reverse stop order for active markers.
            dynamicZIndex = 1000 + (500 - (pickup.number || 500));
          }
          
          if (isFanned && isClustered) {
            // FIXED: Get ALL markers (pickups AND deliveries) at this location
            const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
            const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
            const allMarkersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation]
              .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
            
            const clusterIndex = allMarkersAtLocation.findIndex(p => p.id === pickup.id);
            markerPosition = calculateFannedPositionWrapperWrapper(
              pickup.latitude, 
              pickup.longitude, 
              clusterIndex, 
              allMarkersAtLocation.length,
              pickup.stop_order
            );
            
            // Calculate z-index: incomplete stops first, then by stop_order
            const isFinished = FINISHED_STATUSES.includes(pickup.status);
            const incompleteMarkers = allMarkersAtLocation.filter(p => !FINISHED_STATUSES.includes(p.status));
            
            if (isFinished) {
              // Finished stops get lower z-index
              dynamicZIndex = 2000 - allMarkersAtLocation.length - clusterIndex;
            } else {
              // Incomplete stops: lowest stop_order gets highest z-index
              const incompleteIndex = incompleteMarkers.findIndex(p => p.id === pickup.id);
              dynamicZIndex = 3000 + (incompleteMarkers.length - incompleteIndex);
            }
          }
          
          return [
            // CRITICAL: Store zone circles ALWAYS visible (removed zoom check)
            !isFanned &&
            <Circle
              key={`pickup-circle-${pickup.id}`}
              center={[pickup.latitude, pickup.longitude]}
              radius={2500}
              pathOptions={{
                color: pickup.pinColor,
                fillColor: 'transparent',
                fillOpacity: 0,
                weight: 2,
                opacity: document.documentElement.classList.contains('dark-theme') || 
                         (document.documentElement.classList.contains('auto-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)
                         ? 0.4 : 0.2
              }} />,
            
            // Tiny pulsating halo for highlighted pickup markers
            isHighlighted && !isFanned &&
            <Circle
              key={`pickup-halo-${pickup.id}`}
              center={[pickup.latitude, pickup.longitude]}
              radius={40}
              pathOptions={{
                color: pickup.pinColor,
                fillColor: 'transparent',
                fillOpacity: 0,
                weight: 2,
                opacity: 0.9,
                className: 'pulsating-halo'
              }} />,

            <Marker
              key={`pickup-${pickup.id}`}
              position={markerPosition}
              icon={pickup.useSimpleCircle ? createSimpleCircleIcon(pickup.status, pickup.status === 'pending' ? null : pickup.number, currentZoom, isMobile, pickup.pinColor, pickup.isOtherDriver, pickup.duplicateCount, pickup.isNextDelivery, isPickupFaded || isPickupInProgressFade, isPickupHighlightedFinished) : createStoreIcon(
                pickup.status, 
                pickup.pinColor, 
                isFanned, 
                pickup.status === 'pending' ? null : pickup.number, 
                currentZoom,
                pickup.duplicateCount,
                isMobile,
                highlightedDeliveryId === pickup.id,
                pickup.isNextDelivery,
                hasIncompleteStops,
                false,
                isPickupFaded || isPickupInProgressFade,
                isPickupHighlightedFinished
              )}
              zIndexOffset={dynamicZIndex}
              draggable={!pickup.useSimpleCircle && !pickup.isOtherDriver && isFanned}
              eventHandlers={pickup.isOtherDriver ? {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                  if (isPickupFaded) setFadedMarkerHighlights(prev => new Set([...prev, pickup.id]));
                },
                mouseover: (e) => {
                  e.target.openPopup();
                  if (isPickupFaded || isPickupInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, pickup.id]));
                },
                mouseout: (e) => {
                  e.target.closePopup();
                  setFadedMarkerHighlights(prev => { const n = new Set(prev); n.delete(pickup.id); return n; });
                }
              } : pickup.useSimpleCircle ? {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                  if (isPickupInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, pickup.id]));
                },
                mouseover: (e) => {
                  e.target.openPopup();
                  if (isPickupInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, pickup.id]));
                },
                mouseout: (e) => {
                  e.target.closePopup();
                  setFadedMarkerHighlights(prev => { const n = new Set(prev); n.delete(pickup.id); return n; });
                }
              } : {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                  if (isPickupInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, pickup.id]));
                  if (isFanned && onMarkerClick) {
                    onMarkerClick(pickup);
                  } else {
                    handleMarkerClickForFanning(pickup, 'pickup');
                  }
                },
                mouseover: (e) => {
                  e.target.openPopup();
                  if (isPickupInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, pickup.id]));
                },
                mouseout: (e) => {
                  e.target.closePopup();
                  setFadedMarkerHighlights(prev => { const n = new Set(prev); n.delete(pickup.id); return n; });
                },
                dragend: (e) => handleMarkerDragEnd(pickup.id, e, 'pickup')
              }}
              ref={(ref) => {
                if (ref) {
                  markerRefs.current[`pickup-${pickup.id}`] = ref;
                }
              }}>

              {/* Show popup for non-clustered markers or expanded cluster markers */}
              {!pickup.useSimpleCircle && !pickup.isOtherDriver && (
                isClustered && !isFanned ? (
                  // Clustered markers show unified popup with all marker info and clickable stops
                  <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
                    <div className="min-w-[200px] max-w-[300px] space-y-2">
                      <div className="font-semibold text-sm pb-1 border-b" style={{ color: 'var(--text-slate-900)', borderColor: 'var(--border-slate-200)' }}>
                        {pickup.duplicateCount} stops at this location
                      </div>
                      {(() => {
                        const locationKey = `${pickup.latitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${pickup.longitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
                        const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
                        const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
                        const allMarkersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation]
                          .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

                        return allMarkersAtLocation.map((m, idx) => {
                          const isFinished = FINISHED_STATUSES.includes(m.status);
                          const finishedTime = m.actual_delivery_time ? format(new Date(m.actual_delivery_time), 'HH:mm') : null;
                          const itemName = m.markerType === 'pickup' ? 'Store Pickup' : (m.patient?.full_name || 'Patient');

                          return (
                            <div 
                              key={`cluster-item-${m.id}`} 
                              className="text-xs py-1.5 border-b last:border-0 cursor-pointer hover:bg-slate-50 transition-colors px-1 -mx-1 rounded space-y-0.5"
                              style={{ borderColor: 'var(--border-slate-200)' }}
                              onClick={() => {
                                // CRITICAL: Close cluster popup immediately
                                const popups = document.querySelectorAll('.leaflet-popup');
                                popups.forEach(p => p.remove());

                                // Center card for clicked stop
                                const cardElement = document.getElementById(`stop-card-${m.id}`);
                                if (cardElement) {
                                  cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                                }
                              }}
                            >
                              <div className="flex items-center gap-1.5 font-medium" style={{ color: 'var(--text-slate-900)' }}>
                                <Truck className="w-3.5 h-3.5" />
                                {m.driver?.user_name || 'Unknown'}
                              </div>
                              <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-slate-600)' }}>
                                <Home className="w-3.5 h-3.5" />
                                {m.store?.name || 'Store'}
                              </div>
                              {isFinished && finishedTime ? (
                                <div className="flex items-center justify-between text-[11px]">
                                  <span style={{ color: 'var(--text-slate-900)' }}>{itemName}</span>
                                  <span className="text-emerald-600">{finishedTime}</span>
                                </div>
                              ) : m.delivery_time_eta ? (
                                <div className="flex items-center justify-between text-[11px]">
                                  <span style={{ color: 'var(--text-slate-900)' }}>{itemName}</span>
                                  <span style={{ color: 'var(--text-slate-600)' }}>ETA: {m.delivery_time_eta}</span>
                                </div>
                              ) : (
                                <div className="text-[11px]" style={{ color: 'var(--text-slate-900)' }}>
                                  {itemName}
                                </div>
                              )}
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </Popup>
                ) : (
                  // Non-clustered or fanned markers show full details
                  <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
                    {(() => { const DP = React.lazy(() => import('./DeliveryPopup')); return (<React.Suspense fallback={null}><DP delivery={pickup} isPickup={true} /></React.Suspense>); })()}
                  </Popup>
                )
              )}
              {/* Simple popup for dispatcher's simple circle markers (other stores) */}
              {pickup.useSimpleCircle && !pickup.isOtherDriver && (
                <Popup autoPan={false} closeButton={false} offset={[0, -10]} className="custom-popup">
                  <div className="min-w-[150px] space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                        <Home className="w-3.5 h-3.5" />
                        {pickup.store?.name || 'Store'}
                      </div>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        pickup.status === 'completed' ? 'text-emerald-700 bg-emerald-100' :
                        pickup.status === 'failed' || pickup.status === 'cancelled' ? 'text-red-700 bg-red-100' :
                        pickup.status === 'returned' ? 'text-orange-700 bg-orange-100' :
                        pickup.status === 'in_transit' ? 'text-blue-700 bg-blue-100' :
                        'text-slate-600 bg-slate-100'
                      }`}>
                        {pickup.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-slate-600)' }}>
                      <Truck className="w-3.5 h-3.5" />
                      {pickup.driver?.user_name || 'Unknown Driver'}
                    </div>
                    {(() => {
                      const isFinished = FINISHED_STATUSES.includes(pickup.status);
                      const finishedTime = pickup.actual_delivery_time ? format(new Date(pickup.actual_delivery_time), 'HH:mm') : null;
                      
                      if (isFinished && finishedTime) {
                        return (
                          <div className="flex items-center gap-1 text-xs text-emerald-600">
                            <Clock className="w-3.5 h-3.5" />
                            {finishedTime}
                          </div>
                        );
                      } else if (pickup.delivery_time_eta) {
                        return (
                          <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-slate-600)' }}>
                            ETA: {pickup.delivery_time_eta}
                          </div>
                        );
                      }
                      return null;
                    })()}
                  </div>
                </Popup>
              )}
              {/* NEW: Popup for other drivers' pickups - grouped by driver+store */}
              {pickup.isOtherDriver && (
                isClustered && !isFanned ? (
                  // Clustered other driver pickups - grouped by driver+store
                  <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
                    <div className="min-w-[200px] max-w-[300px] space-y-0">
                      <div className="font-semibold text-sm pb-1 border-b mb-1" style={{ color: 'var(--text-slate-900)', borderColor: 'var(--border-slate-200)' }}>
                        {pickup.duplicateCount} stops at this location
                      </div>
                      {(() => {
                        const locationKey = `${pickup.latitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${pickup.longitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
                        const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
                        const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
                        const allMarkersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation]
                          .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
                        
                        // Group by driver + store
                        const groups = [];
                        let currentGroup = null;
                        
                        allMarkersAtLocation.forEach((m) => {
                          const driverId = m.driver?.user_name || 'Unknown';
                          const storeId = m.store?.name || 'Store';
                          const key = `${driverId}|${storeId}`;
                          
                          if (!currentGroup || currentGroup.key !== key) {
                            currentGroup = { key, driver: driverId, store: storeId, items: [] };
                            groups.push(currentGroup);
                          }
                          currentGroup.items.push(m);
                        });
                        
                        return groups.map((group, groupIdx) => (
                          <div key={`group-${groupIdx}`}>
                            <div className="px-1 pt-1 pb-1.5 space-y-0.5">
                              <div className="flex items-center gap-1.5 font-medium text-xs" style={{ color: 'var(--text-slate-900)' }}>
                                <Truck className="w-3.5 h-3.5 flex-shrink-0" />
                                {group.driver}
                              </div>
                              <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-slate-600)' }}>
                                <Home className="w-3.5 h-3.5 flex-shrink-0" />
                                {group.store}
                              </div>
                            </div>
                            <div className="border-b" style={{ borderColor: 'var(--border-slate-200)' }} />
                            <div className="px-1 py-1.5 space-y-1">
                              {group.items.map((m) => {
                                const isFinished = FINISHED_STATUSES.includes(m.status);
                                const isFailed = m.status === 'failed' || m.status === 'cancelled';
                                const finishedTime = m.actual_delivery_time ? format(new Date(m.actual_delivery_time), 'HH:mm') : null;
                                const itemName = m.markerType === 'pickup' ? 'Store Pickup' : (m.patient?.full_name || 'Patient');
                                
                                return (
                                  <div 
                                    key={`item-${m.id}`} 
                                    className="text-xs cursor-pointer hover:bg-slate-50 transition-colors px-1 py-0.5 rounded flex items-center justify-between"
                                    onClick={() => {
                                      const popups = document.querySelectorAll('.leaflet-popup');
                                      popups.forEach(p => p.remove());
                                      const cardElement = document.getElementById(`stop-card-${m.id}`);
                                      if (cardElement) {
                                        cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                                      }
                                    }}
                                  >
                                    <div className="flex items-center gap-1.5" style={{ color: 'var(--text-slate-900)' }}>
                                      <User className="w-3 h-3 flex-shrink-0" />
                                      <span>{itemName}</span>
                                    </div>
                                    <div className="flex items-center gap-1">
                                      {isFinished && finishedTime ? (
                                        <>
                                          <span className="text-emerald-600">{finishedTime}</span>
                                          {isFailed ? (
                                            <XCircle className="w-3.5 h-3.5 text-red-600 flex-shrink-0" />
                                          ) : (
                                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                                          )}
                                        </>
                                      ) : m.delivery_time_eta ? (
                                        <>
                                          <span style={{ color: 'var(--text-slate-600)' }}>{m.delivery_time_eta}</span>
                                          <Clock className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-slate-500)' }} />
                                        </>
                                      ) : null}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            {groupIdx < groups.length - 1 && (
                              <div className="border-b" style={{ borderColor: 'var(--border-slate-200)' }} />
                            )}
                          </div>
                        ));
                      })()}
                    </div>
                  </Popup>
                ) : (
                  // Non-clustered other driver pickup - same layout as clustered
                  <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
                    <div className="min-w-[200px] max-w-[300px] space-y-0">
                      <div className="px-1 pt-1 pb-1.5 space-y-0.5">
                        <div className="flex items-center gap-1.5 font-medium text-xs" style={{ color: 'var(--text-slate-900)' }}>
                          <Truck className="w-3.5 h-3.5 flex-shrink-0" />
                          {pickup.driver?.user_name || 'Unknown'}
                        </div>
                        <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-slate-600)' }}>
                          <Home className="w-3.5 h-3.5 flex-shrink-0" />
                          {pickup.store?.name || 'Store'}
                        </div>
                      </div>
                      <div className="border-b" style={{ borderColor: 'var(--border-slate-200)' }} />
                      <div className="px-1 py-1.5">
                        {(() => {
                          const isFinished = FINISHED_STATUSES.includes(pickup.status);
                          const isFailed = pickup.status === 'failed' || pickup.status === 'cancelled';
                          const finishedTime = pickup.actual_delivery_time ? format(new Date(pickup.actual_delivery_time), 'HH:mm') : null;
                          const itemName = 'Store Pickup';
                          
                          return (
                            <div className="text-xs flex items-center justify-between">
                              <div className="flex items-center gap-1.5" style={{ color: 'var(--text-slate-900)' }}>
                                <User className="w-3 h-3 flex-shrink-0" />
                                <span>{itemName}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                {isFinished && finishedTime ? (
                                  <>
                                    <span className="text-emerald-600">{finishedTime}</span>
                                    {isFailed ? (
                                      <XCircle className="w-3.5 h-3.5 text-red-600 flex-shrink-0" />
                                    ) : (
                                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                                    )}
                                  </>
                                ) : pickup.delivery_time_eta ? (
                                  <>
                                    <span style={{ color: 'var(--text-slate-600)' }}>{pickup.delivery_time_eta}</span>
                                    <Clock className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-slate-500)' }} />
                                  </>
                                ) : null}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  </Popup>
                )
              )}
            </Marker>
          ];
        })}

        {/* Patient Delivery Markers - NOW WITH FANNING AND HIGHLIGHT HALOS */}
        {deliveryMarkers.map((delivery, index) => {
          const locationKey = `${delivery.latitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${delivery.longitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
          const isClustered = delivery.duplicateCount > 1;
          const isFanned = fannedLocationKey === locationKey;
          const isHighlighted = highlightedDeliveryId === delivery.id;
          
          // FADE RULES:
          // 1. Selected driver markers = always 100% (no fade)
          // 2. Other driver incomplete markers = 75%
          // 3. In-progress route finished markers = 50%
          // 4. Completed route finished markers for selected driver = 100% (no fade)
          // 5. Hover/click on faded marker = 85%
          const isFinishedForFade = FINISHED_STATUSES.includes(delivery.status);
          const isSelectedDriverMarker = !delivery.isOtherDriver;
          const isSelectedRouteComplete = isSelectedDriverMarker && driversWithCompleteRoute.has(delivery.driver_id);
          const isRouteInProgress = !driversWithCompleteRoute.has(delivery.driver_id) && hasIncompleteStops;
          const isUserHoveringFaded = fadedMarkerHighlights.has(delivery.id);
          const isDeliveryFaded = isFinishedForFade && !isHighlighted && !isSelectedRouteComplete && !isSelectedDriverMarker;
          const isDeliveryInProgressFade = isFinishedForFade && isSelectedDriverMarker && !isSelectedRouteComplete && isRouteInProgress;
          const isDeliveryHighlightedFinished = (isDeliveryFaded || isDeliveryInProgressFade) && (isHighlighted || isUserHoveringFaded);
          
          // Calculate position based on fanning state
          let markerPosition = [delivery.latitude, delivery.longitude];
          let dynamicZIndex;

          const isFinished = FINISHED_STATUSES.includes(delivery.status);
          const isNext = delivery.isNextInLine;
          const isPending = delivery.status === 'pending';

          if (isPending) {
            // Rule 0: Pending markers ALWAYS on top (highest z-index)
            dynamicZIndex = 5000 + (500 - (delivery.number || 500));
          } else if (isFinished) {
            dynamicZIndex = 100 + (500 - (delivery.number || 500));
          } else {
            dynamicZIndex = 1000 + (500 - (delivery.number || 500));
          }
          
          // Rule 3: Next marker is on top of everything except pending.
          if (isNext && !isPending) {
            dynamicZIndex = 2000;
          }
          
          if (isFanned && isClustered) {
            // FIXED: Get ALL markers (pickups AND deliveries) at this location
            const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
            const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
            const allMarkersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation]
              .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
            
            const clusterIndex = allMarkersAtLocation.findIndex(d => d && d.id === delivery.id);
            markerPosition = calculateFannedPositionWrapperWrapper(
              delivery.latitude, 
              delivery.longitude, 
              clusterIndex, 
              allMarkersAtLocation.length,
              delivery.stop_order
            );
            
            // Calculate z-index: incomplete stops first, then by stop_order
            const isFinished = FINISHED_STATUSES.includes(delivery.status);
            const incompleteMarkers = allMarkersAtLocation.filter(d => !FINISHED_STATUSES.includes(d.status));
            
            if (isFinished) {
              // Finished stops get lower z-index
              dynamicZIndex = 2000 - allMarkersAtLocation.length - clusterIndex;
            } else {
              // Incomplete stops: lowest stop_order gets highest z-index
              const incompleteIndex = incompleteMarkers.findIndex(d => d.id === delivery.id);
              dynamicZIndex = 3000 + (incompleteMarkers.length - incompleteIndex);
            }
          }
          
          return [
            // Tiny pulsating halo for highlighted delivery markers
            isHighlighted && !isFanned &&
            <Circle
              key={`delivery-halo-${delivery.id}`}
              center={[delivery.latitude, delivery.longitude]}
              radius={40}
              pathOptions={{
                color: delivery.pinColor,
                fillColor: 'transparent',
                fillOpacity: 0,
                weight: 2,
                opacity: 0.9,
                className: 'pulsating-halo'
              }} />,
            
            // Tiny pulsating halo for highlighted delivery's store marker
            isHighlighted && !isFanned && delivery.store_id && (() => {
              const deliveryStore = stores.find(s => s?.id === delivery.store_id);
              if (!deliveryStore?.latitude || !deliveryStore?.longitude) return null;
              return (
                <Circle
                  key={`delivery-store-halo-${delivery.id}`}
                  center={[deliveryStore.latitude, deliveryStore.longitude]}
                  radius={40}
                  pathOptions={{
                    color: delivery.pinColor,
                    fillColor: 'transparent',
                    fillOpacity: 0,
                    weight: 2,
                    opacity: 0.9,
                    className: 'pulsating-halo'
                  }}
                />
              );
            })(),
            
            <Marker
              key={`delivery-${delivery.id}`}
              position={markerPosition}
              icon={delivery.useSimpleCircle ? createSimpleCircleIcon(delivery.isReturn ? 'returned' : delivery.status, delivery.status === 'pending' ? null : delivery.number, currentZoom, isMobile, delivery.pinColor, true, delivery.duplicateCount, delivery.isNextInLine, isDeliveryFaded || isDeliveryInProgressFade, isDeliveryHighlightedFinished) : delivery.isOtherDriver ? createSimpleCircleIcon(delivery.isReturn ? 'returned' : delivery.status, delivery.status === 'pending' ? null : delivery.number, currentZoom, isMobile, delivery.pinColor, true, delivery.duplicateCount, delivery.isNextInLine, isDeliveryFaded || isDeliveryInProgressFade, isDeliveryHighlightedFinished) : createDeliveryIcon(
                delivery.status,
                delivery.pinColor,
                isFanned,
                delivery.status === 'pending' ? null : delivery.number,
                delivery.isFirstTime,
                delivery.duplicateCount,
                currentZoom,
                isMobile,
                delivery.isNextInLine,
                isHighlighted,
                hasIncompleteStops,
                delivery.ampm_deliveries === 'PM',
                delivery.isOtherDriver,
                delivery.isReturn,
                isDeliveryFaded || isDeliveryInProgressFade,
                isDeliveryHighlightedFinished
              )}
              zIndexOffset={dynamicZIndex}
              draggable={!delivery.useSimpleCircle && !delivery.isOtherDriver && isFanned}
              eventHandlers={delivery.isOtherDriver ? {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                  if (isDeliveryFaded) setFadedMarkerHighlights(prev => new Set([...prev, delivery.id]));
                },
                mouseover: (e) => {
                  e.target.openPopup();
                  if (isDeliveryFaded || isDeliveryInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, delivery.id]));
                },
                mouseout: (e) => {
                  e.target.closePopup();
                  setFadedMarkerHighlights(prev => { const n = new Set(prev); n.delete(delivery.id); return n; });
                }
              } : delivery.useSimpleCircle ? {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                  if (isDeliveryInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, delivery.id]));
                },
                mouseover: (e) => {
                  e.target.openPopup();
                  if (isDeliveryInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, delivery.id]));
                },
                mouseout: (e) => {
                  e.target.closePopup();
                  setFadedMarkerHighlights(prev => { const n = new Set(prev); n.delete(delivery.id); return n; });
                }
              } : {
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                  if (isDeliveryInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, delivery.id]));
                  if (isFanned && onMarkerClick) {
                    onMarkerClick(delivery);
                  } else {
                    handleMarkerClickForFanning(delivery, 'delivery');
                  }
                },
                mouseover: (e) => {
                  e.target.openPopup();
                  if (isDeliveryInProgressFade) setFadedMarkerHighlights(prev => new Set([...prev, delivery.id]));
                },
                mouseout: (e) => {
                  e.target.closePopup();
                  setFadedMarkerHighlights(prev => { const n = new Set(prev); n.delete(delivery.id); return n; });
                },
                dragend: (e) => handleMarkerDragEnd(delivery.id, e, 'delivery')
              }}
              ref={(ref) => {
                if (ref) {
                  markerRefs.current[`delivery-${delivery.id}`] = ref;
                }
              }}>

              {/* Show popup for non-clustered markers or expanded cluster markers */}
              {!delivery.useSimpleCircle && !delivery.isOtherDriver && (
                isClustered && !isFanned ? (
                  // Clustered markers show unified popup with all marker info and clickable stops
                  <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
                    <div className="min-w-[200px] max-w-[300px] space-y-2">
                      <div className="font-semibold text-sm pb-1 border-b" style={{ color: 'var(--text-slate-900)', borderColor: 'var(--border-slate-200)' }}>
                        {delivery.duplicateCount} stops at this location
                      </div>
                      {(() => {
                        const locationKey = `${delivery.latitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${delivery.longitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
                        const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
                        const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
                        const allMarkersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation]
                          .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
                        
                        // Find first incomplete stop
                        const firstIncomplete = allMarkersAtLocation.find(m => !FINISHED_STATUSES.includes(m.status));
                        
                        return allMarkersAtLocation.map((m, idx) => {
                          const isFinished = FINISHED_STATUSES.includes(m.status);
                          const finishedTime = m.actual_delivery_time ? format(new Date(m.actual_delivery_time), 'HH:mm') : null;
                          const isFirstIncomplete = m.id === firstIncomplete?.id;
                          const itemName = m.markerType === 'pickup' ? 'Store Pickup' : (m.patient?.full_name || 'Patient');
                          
                          return (
                            <div 
                              key={`cluster-item-${m.id}`} 
                              className="text-xs py-1.5 border-b last:border-0 cursor-pointer hover:bg-slate-50 transition-colors px-1 -mx-1 rounded space-y-0.5"
                              style={{ borderColor: 'var(--border-slate-200)' }}
                              onClick={() => {
                                // CRITICAL: Close cluster popup immediately
                                const popups = document.querySelectorAll('.leaflet-popup');
                                popups.forEach(p => p.remove());
                                
                                // Center card for clicked stop
                                const cardElement = document.getElementById(`stop-card-${m.id}`);
                                if (cardElement) {
                                  cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                                }
                              }}
                            >
                              <div className="flex items-center gap-1.5 font-medium" style={{ color: 'var(--text-slate-900)' }}>
                                <Truck className="w-3.5 h-3.5" />
                                {m.driver?.user_name || 'Unknown'}
                              </div>
                              <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-slate-600)' }}>
                                <Home className="w-3.5 h-3.5" />
                                {m.store?.name || 'Store'}
                              </div>
                              {isFinished && finishedTime ? (
                                <div className="flex items-center justify-between text-[11px]">
                                  <span style={{ color: 'var(--text-slate-900)' }}>{itemName}</span>
                                  <span className="text-emerald-600">{finishedTime}</span>
                                </div>
                              ) : m.delivery_time_eta ? (
                                <div className="flex items-center justify-between text-[11px]">
                                  <span style={{ color: 'var(--text-slate-900)' }}>{itemName}</span>
                                  <span style={{ color: 'var(--text-slate-600)' }}>ETA: {m.delivery_time_eta}</span>
                                </div>
                              ) : (
                                <div className="text-[11px]" style={{ color: 'var(--text-slate-900)' }}>
                                  {itemName}
                                </div>
                              )}
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </Popup>
                ) : (
                  // Non-clustered or fanned markers show full details
                  <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
                    {(() => { const DP = React.lazy(() => import('./DeliveryPopup')); return (<React.Suspense fallback={null}><DP delivery={delivery} isPickup={false} /></React.Suspense>); })()}
                  </Popup>
                )
              )}
              {/* Simple popup for dispatcher's simple circle markers (other stores) */}
              {delivery.useSimpleCircle && !delivery.isOtherDriver && (
                <Popup autoPan={false} closeButton={false} offset={[0, -10]} className="custom-popup">
                  <div className="min-w-[150px] space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--text-slate-900)' }}>
                        <Home className="w-3.5 h-3.5" />
                        {delivery.store?.name || 'Store'}
                      </div>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                        delivery.status === 'completed' ? 'text-emerald-700 bg-emerald-100' :
                        delivery.status === 'failed' || delivery.status === 'cancelled' ? 'text-red-700 bg-red-100' :
                        delivery.status === 'returned' ? 'text-orange-700 bg-orange-100' :
                        delivery.status === 'in_transit' ? 'text-blue-700 bg-blue-100' :
                        'text-slate-600 bg-slate-100'
                      }`}>
                        {delivery.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-slate-600)' }}>
                      <Truck className="w-3.5 h-3.5" />
                      {delivery.driver?.user_name || 'Unknown Driver'}
                    </div>
                    {(() => {
                      const isFinished = FINISHED_STATUSES.includes(delivery.status);
                      const finishedTime = delivery.actual_delivery_time ? format(new Date(delivery.actual_delivery_time), 'HH:mm') : null;
                      
                      if (isFinished && finishedTime) {
                        return (
                          <div className="flex items-center gap-1 text-xs text-emerald-600">
                            <Clock className="w-3.5 h-3.5" />
                            {finishedTime}
                          </div>
                        );
                      } else if (delivery.delivery_time_eta) {
                        return (
                          <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-slate-600)' }}>
                            ETA: {delivery.delivery_time_eta}
                          </div>
                        );
                      }
                      return null;
                    })()}
                  </div>
                </Popup>
              )}
              {/* NEW: Popup for other drivers' deliveries - with unified cluster view */}
              {delivery.isOtherDriver && (
                isClustered && !isFanned ? (
                  // Clustered other driver markers - grouped by driver+store
                  <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
                    <div className="min-w-[200px] max-w-[300px] space-y-0">
                      <div className="font-semibold text-sm pb-1 border-b mb-1" style={{ color: 'var(--text-slate-900)', borderColor: 'var(--border-slate-200)' }}>
                        {delivery.duplicateCount} stops at this location
                      </div>
                      {(() => {
                        const locationKey = `${delivery.latitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)},${delivery.longitude.toFixed(currentZoom >= ZOOM_LEVELS.FULL_DETAIL ? 6 : currentZoom >= ZOOM_LEVELS.SIMPLIFY_ROUTES ? 4 : currentZoom >= ZOOM_LEVELS.HIDE_NUMBERS ? 3 : 2)}`;
                        const pickupsAtLocation = groupedPickupMarkers.get(locationKey) || [];
                        const deliveriesAtLocation = groupedDeliveryMarkers.get(locationKey) || [];
                        const allMarkersAtLocation = [...pickupsAtLocation, ...deliveriesAtLocation]
                          .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
                        
                        // Group by driver + store
                        const groups = [];
                        let currentGroup = null;
                        
                        allMarkersAtLocation.forEach((m) => {
                          const driverId = m.driver?.user_name || 'Unknown';
                          const storeId = m.store?.name || 'Store';
                          const key = `${driverId}|${storeId}`;
                          
                          if (!currentGroup || currentGroup.key !== key) {
                            currentGroup = { key, driver: driverId, store: storeId, items: [] };
                            groups.push(currentGroup);
                          }
                          currentGroup.items.push(m);
                        });
                        
                        return groups.map((group, groupIdx) => (
                          <div key={`group-${groupIdx}`}>
                            <div className="px-1 pt-1 pb-1.5 space-y-0.5">
                              <div className="flex items-center gap-1.5 font-medium text-xs" style={{ color: 'var(--text-slate-900)' }}>
                                <Truck className="w-3.5 h-3.5 flex-shrink-0" />
                                {group.driver}
                              </div>
                              <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-slate-600)' }}>
                                <Home className="w-3.5 h-3.5 flex-shrink-0" />
                                {group.store}
                              </div>
                            </div>
                            <div className="border-b" style={{ borderColor: 'var(--border-slate-200)' }} />
                            <div className="px-1 py-1.5 space-y-1">
                              {group.items.map((m) => {
                                const isFinished = FINISHED_STATUSES.includes(m.status);
                                const isFailed = m.status === 'failed' || m.status === 'cancelled';
                                const finishedTime = m.actual_delivery_time ? format(new Date(m.actual_delivery_time), 'HH:mm') : null;
                                const itemName = m.markerType === 'pickup' ? 'Store Pickup' : (m.patient?.full_name || 'Patient');
                                
                                return (
                                  <div 
                                    key={`item-${m.id}`} 
                                    className="text-xs cursor-pointer hover:bg-slate-50 transition-colors px-1 py-0.5 rounded flex items-center justify-between"
                                    onClick={() => {
                                      const popups = document.querySelectorAll('.leaflet-popup');
                                      popups.forEach(p => p.remove());
                                      const cardElement = document.getElementById(`stop-card-${m.id}`);
                                      if (cardElement) {
                                        cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                                      }
                                    }}
                                  >
                                    <div className="flex items-center gap-1.5" style={{ color: 'var(--text-slate-900)' }}>
                                      <User className="w-3 h-3 flex-shrink-0" />
                                      <span>{itemName}</span>
                                    </div>
                                    <div className="flex items-center gap-1">
                                      {isFinished && finishedTime ? (
                                        <>
                                          <span className="text-emerald-600">{finishedTime}</span>
                                          {isFailed ? (
                                            <XCircle className="w-3.5 h-3.5 text-red-600 flex-shrink-0" />
                                          ) : (
                                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                                          )}
                                        </>
                                      ) : m.delivery_time_eta ? (
                                        <>
                                          <span style={{ color: 'var(--text-slate-600)' }}>{m.delivery_time_eta}</span>
                                          <Clock className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-slate-500)' }} />
                                        </>
                                      ) : null}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            {groupIdx < groups.length - 1 && (
                              <div className="border-b" style={{ borderColor: 'var(--border-slate-200)' }} />
                            )}
                          </div>
                        ));
                      })()}
                    </div>
                  </Popup>
                ) : (
                  // Non-clustered other driver delivery - same layout as clustered
                  <Popup autoPan={false} closeButton={false} offset={[0, -20]} className="custom-popup">
                    <div className="min-w-[200px] max-w-[300px] space-y-0">
                      <div className="px-1 pt-1 pb-1.5 space-y-0.5">
                        <div className="flex items-center gap-1.5 font-medium text-xs" style={{ color: 'var(--text-slate-900)' }}>
                          <Truck className="w-3.5 h-3.5 flex-shrink-0" />
                          {delivery.driver?.user_name || 'Unknown'}
                        </div>
                        <div className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-slate-600)' }}>
                          <Home className="w-3.5 h-3.5 flex-shrink-0" />
                          {delivery.store?.name || 'Store'}
                        </div>
                      </div>
                      <div className="border-b" style={{ borderColor: 'var(--border-slate-200)' }} />
                      <div className="px-1 py-1.5">
                        {(() => {
                          const isFinished = FINISHED_STATUSES.includes(delivery.status);
                          const isFailed = delivery.status === 'failed' || delivery.status === 'cancelled';
                          const finishedTime = delivery.actual_delivery_time ? format(new Date(delivery.actual_delivery_time), 'HH:mm') : null;
                          const itemName = delivery.patient?.full_name || 'Patient';
                          
                          return (
                            <div className="text-xs flex items-center justify-between">
                              <div className="flex items-center gap-1.5" style={{ color: 'var(--text-slate-900)' }}>
                                <User className="w-3 h-3 flex-shrink-0" />
                                <span>{itemName}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                {isFinished && finishedTime ? (
                                  <>
                                    <span className="text-emerald-600">{finishedTime}</span>
                                    {isFailed ? (
                                      <XCircle className="w-3.5 h-3.5 text-red-600 flex-shrink-0" />
                                    ) : (
                                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                                    )}
                                  </>
                                ) : delivery.delivery_time_eta ? (
                                  <>
                                    <span style={{ color: 'var(--text-slate-600)' }}>{delivery.delivery_time_eta}</span>
                                    <Clock className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-slate-500)' }} />
                                  </>
                                ) : null}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  </Popup>
                )
              )}
            </Marker>
          ];
        })}

        {/* Breadcrumb Trails - Historical and Current */}
        {showBreadcrumbs && (() => {
          const breadcrumbCircles = [];
          
          // Process historical breadcrumbs from DeliveryBreadcrumbs entity
          if (breadcrumbsData.historical && breadcrumbsData.historical.length > 0) {
            breadcrumbsData.historical.forEach((trail, trailIdx) => {
              if (!trail || !trail.breadcrumbs || !Array.isArray(trail.breadcrumbs)) return;
              
              // Get driver for this trail to use their polyline color
              const trailDriver = safeUsers.find(u => u && u.id === trail.driver_id);
              const breadcrumbColor = trailDriver ? getDriverColor(trailDriver) : '#607D8B';
              
              // Each breadcrumb is [lat, lng, timestamp_ms]
              trail.breadcrumbs.forEach(([lat, lng, timestamp], idx) => {
                if (typeof lat !== 'number' || typeof lng !== 'number' || isNaN(lat) || isNaN(lng)) {
                  return;
                }
                
                breadcrumbCircles.push(
                  <Circle
                    key={`historical-breadcrumb-${trail.id}-${idx}`}
                    center={[lat, lng]}
                    radius={4} // Medium size dots - adjust if needed
                    pathOptions={{
                      color: breadcrumbColor,
                      fillColor: breadcrumbColor,
                      fillOpacity: 0.6,
                      weight: 1,
                      opacity: 0.8
                    }}
                  />
                );
              });
            });
          }
          
          // Process current/real-time breadcrumbs from offline database
          if (breadcrumbsData.current && breadcrumbsData.current.length > 0) {
            const currentBreadcrumbColor = '#3B82F6'; // Blue for current tracking
            
            breadcrumbsData.current.forEach((breadcrumb, idx) => {
              // Current breadcrumbs have structure: {driver_id, delivery_date, lat, lng, timestamp, accuracy}
              if (!breadcrumb || typeof breadcrumb.lat !== 'number' || typeof breadcrumb.lng !== 'number') return;
              
              breadcrumbCircles.push(
                <Circle
                  key={`current-breadcrumb-${idx}`}
                  center={[breadcrumb.lat, breadcrumb.lng]}
                  radius={5} // Slightly larger for real-time tracking
                  pathOptions={{
                    color: currentBreadcrumbColor,
                    fillColor: currentBreadcrumbColor,
                    fillOpacity: 0.8,
                    weight: 1.5,
                    opacity: 1
                  }}
                />
              );
            });
          }
          
          return breadcrumbCircles.length > 0 ? breadcrumbCircles : null;
        })()}
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