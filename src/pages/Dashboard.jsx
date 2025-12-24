// Dashboard.js - Delivery Management Dashboard

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Calendar as CalendarIcon, Clock, Truck, CheckCircle, XCircle, Package, Plus, ChevronUp, ChevronDown, RotateCcw as RefreshIcon, Phone, MapPin, X, Settings, Bot, Sparkles, Navigation, Bell, BellOff, Mailbox, ArrowUp, ArrowDown } from "lucide-react";
import { format, startOfDay } from 'date-fns';
import { getData, invalidate, invalidateDeliveriesForDate } from "@/components/utils/dataManager";
import DeliveryMap from "@/components/dashboard/DeliveryMap";
import { getDriverColor } from "@/components/dashboard/DeliveryMap";
import HorizontalStopCards from "@/components/dashboard/HorizontalStopCards";
import DeliveryForm from "@/components/deliveries/DeliveryForm";
import PatientForm from "@/components/patients/PatientForm";
import {
  createDeliveryLocal,
  updateDeliveryLocal,
  batchCreateDeliveriesLocal,
  pauseOfflineMutations,
  resumeOfflineMutations } from

"@/components/utils/offlineMutations";
import { pauseOfflineSync, resumeOfflineSync } from "@/components/utils/offlineSync";
import RouteOptimizationSettings, { getRouteOptimizationSettings } from "@/components/dashboard/RouteOptimizationSettings";
import { sortUsers } from "@/components/utils/sorting";
import { AnimatePresence, motion } from "framer-motion";
import { locationTracker } from "@/components/utils/locationTracker";
import LocationTrackingToggle from "@/components/layout/LocationTrackingToggle";
import { globalFilters } from "@/components/utils/globalFilters";
import { getDriverNameForComparison } from '@/components/utils/driverUtils';
import { userHasRole, isAppOwner } from '@/components/utils/userRoles';
import { useUser } from '@/components/utils/UserContext';
import { useAppData } from '@/components/utils/AppDataContext';
import { optimizeRoute, calculateRouteStats } from '@/components/utils/routeOptimizer';
import { flushSync } from "react-dom";
import { determineAMPMFromTime } from '@/components/utils/ampmUtils';
import AIDriverAssistant from "@/components/dashboard/AIDriverAssistant";
import MapViewCycleFAB from "@/components/dashboard/MapViewCycleFAB";
import { getOrGenerateRoutePolyline, getStoredRouteCoordinates } from "@/components/utils/routePolylineManager";
import { determinePolylineSegment, fetchPolylineForSegment } from "@/components/utils/dynamicPolylineManager";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { driverLocationPoller } from "@/components/utils/driverLocationPoller";
import { getAvailableDrivers } from "@/components/utils/driverSelectors";
import RouteSummaryModal from "@/components/dashboard/RouteSummaryModal";
import { isMobileDevice } from "@/components/utils/deviceUtils";
import { smartRefreshManager } from "@/components/utils/smartRefreshManager";
import { reorderStops } from "@/components/utils/stopReorderer";
import { recalculateAndUpdateStopOrders, updateNextDeliveryFlags } from "@/components/utils/stopOrderManager";
import { loadUserSettings, saveSetting, getSetting } from "@/components/utils/userSettingsManager";
import { fabControlEvents } from "@/components/utils/fabControlEvents";
import RouteNotification from "@/components/dashboard/RouteNotification";
import ProactiveAlertSystem from "@/components/dashboard/ProactiveAlertSystem";
import SmartRefreshIndicator from "@/components/layout/SmartRefreshIndicator";
import { offlineManager } from "@/components/utils/offlineManager";
import { offlineDeliveryManager } from "@/components/utils/offlineDeliveryManager";
import OfflineIndicator from "@/components/dashboard/OfflineIndicator";
import OfflineSyncIndicator from '@/components/layout/OfflineSyncIndicator';
import DashboardOfflineSync from '@/components/dashboard/DashboardOfflineSync';
import ETATracker from '../components/dashboard/ETATracker';
import ETANotification from '../components/dashboard/ETANotification';
import RealTimeRouteOptimizer from '../components/dashboard/RealTimeRouteOptimizer';
import QuickRouteAdjustments from '../components/dashboard/QuickRouteAdjustments';
import { driverActivityMonitor } from '@/components/utils/driverActivityMonitor';

// FIXED: StatBadge - always render with consistent hook structure
const StatBadge = ({ icon: Icon, value, color, label, tooltip, driverCount }) => {
  // ALWAYS calculate color class (hook-like behavior should be consistent)
  const colorClasses = useMemo(() => ({
    blue: "bg-blue-100 text-blue-600",
    purple: "bg-purple-100 text-purple-600",
    emerald: "bg-emerald-100 text-emerald-600",
    green: "bg-green-100 text-green-600",
    red: "bg-red-100 text-red-600",
    slate: "bg-slate-100 text-slate-600"
  }), []);

  const badge =
  <div className="px-1 flex items-center gap-2 cursor-help">
      <div className={`p-1.5 rounded-lg ${colorClasses[color]}`}>
        <Icon className="w-3.5 h-3.5" />
      </div>
      <div className="relative">
        {driverCount !== undefined && driverCount > 0 &&
      <span className="absolute -top-1 -right-1 text-[9px] font-bold" style={{ color: 'var(--text-slate-500)' }}>
            {driverCount}
          </span>
      }
        <span className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>{value}</span>
      </div>
    </div>;


  // ALWAYS render Tooltip with all hooks, just conditionally show content
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {badge}
        </TooltipTrigger>
        <TooltipContent className="z-[9999] border" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-900)', borderColor: 'var(--border-slate-300)' }}>
          <p>{tooltip || ''}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>);

};

// Helper function to calculate distance between two coordinates (Haversine formula)
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
  Math.sin(dLat / 2) * Math.sin(dLat / 2) +
  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
  Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in kilometers
};

// Helper function to generate unique SID (3-character alphanumeric)
const generateUniqueSID = (existingDeliveriesForDate) => {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const existingSIDs = new Set(
    (existingDeliveriesForDate || []).
    map((delivery) => delivery && delivery.stop_id).
    filter(Boolean)
  );

  let sid;
  let attempts = 0;
  const maxAttempts = 10000; // Safety limit

  do {
    sid = '';
    for (let i = 0; i < 3; i++) {
      sid += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    attempts++;
    if (attempts > maxAttempts) {
      throw new Error('Unable to generate unique SID after maximum attempts');
    }
  } while (existingSIDs.has(sid));

  return sid;
};

// Helper function to add minutes to time string (HH:mm format)
const addMinutesToTime = (timeString, minutes) => {
  if (!timeString) return null;
  const [hours, mins] = timeString.split(':').map(Number);
  const totalMinutes = hours * 60 + mins + minutes;
  const newHours = Math.floor(totalMinutes / 60) % 24;
  const newMins = totalMinutes % 60;
  return `${String(newHours).padStart(2, '0')}:${String(newMins).padStart(2, '0')}`;
};

// Helper function to round completion time to nearest 5-minute mark
// For first delivery: round DOWN to nearest 5 minutes
// For last delivery: round UP to next 5 minutes
const roundCompletionTime = (timeISO, isFirst, isLast) => {
  if (!timeISO) return timeISO;

  try {
    const date = new Date(timeISO);
    const minutes = date.getMinutes();

    if (isFirst) {
      // Round down to nearest 5 minutes
      const roundedMinutes = Math.floor(minutes / 5) * 5;
      date.setMinutes(roundedMinutes);
      date.setSeconds(0);
      date.setMilliseconds(0);
      console.log(`⏱️ [Round Time] First delivery - rounded DOWN: ${minutes} → ${roundedMinutes} minutes`);
    } else if (isLast) {
      // Round up to next 5 minutes
      const roundedMinutes = Math.ceil(minutes / 5) * 5;
      date.setMinutes(roundedMinutes);
      date.setSeconds(0);
      date.setMilliseconds(0);
      console.log(`⏱️ [Round Time] Last delivery - rounded UP: ${minutes} → ${roundedMinutes} minutes`);
    }

    return date.toISOString();
  } catch (error) {
    console.error('Error rounding completion time:', error);
    return timeISO;
  }
};

// Helper function to populate temporary start times for deliveries with blank time windows
const populateTemporaryStartTimes = (deliveries, stores) => {
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

  // Create a copy to avoid mutating original
  const deliveriesCopy = deliveries.map((d) => ({ ...d }));

  deliveriesCopy.forEach((delivery) => {
    // Only process patient deliveries (not pickups)
    if (!delivery.patient_id) return;

    // Skip if delivery already has a delivery_time_start
    if (delivery.delivery_time_start) return;

    // Find the parent store's pickup
    const parentPickup = deliveriesCopy.find((d) =>
    !d.patient_id &&
    d.store_id === delivery.store_id &&
    d.driver_id === delivery.driver_id
    );

    if (parentPickup) {
      // If pickup is completed, use completion time + 5 minutes
      if (finishedStatuses.includes(parentPickup.status) && parentPickup.actual_delivery_time) {
        const completionTime = format(new Date(parentPickup.actual_delivery_time), 'HH:mm');
        delivery.delivery_time_start = addMinutesToTime(completionTime, 5);
      }
      // If pickup is not completed, use its ETA or start time + 5 minutes
      else if (parentPickup.delivery_time_eta) {
        delivery.delivery_time_start = addMinutesToTime(parentPickup.delivery_time_eta, 5);
      } else if (parentPickup.delivery_time_start) {
        delivery.delivery_time_start = addMinutesToTime(parentPickup.delivery_time_start, 5);
      }
    }
  });

  return deliveriesCopy;
};

function Dashboard() {
  const { currentUser, isLoadingUser, refreshUser } = useUser();
  const {
    deliveries,
    patients,
    stores,
    drivers,
    users,
    cities,
    appUsers,
    isDataLoaded,
    refreshData,
    updateDeliveriesLocally,
    forceRefreshDriverDeliveries,
    setIsFormOverlayOpen,
    setIsEntityUpdating,
    setOnSmartRefreshComplete,
    dataReadyForSelectedDate
  } = useAppData();

  const isDispatcher = currentUser ? userHasRole(currentUser, 'dispatcher') : false;

  const [selectedDate, setSelectedDate] = useState(() => {
    const saved = globalFilters.getSelectedDate();
    return typeof saved === 'string' && saved ? new Date(saved + 'T00:00:00') : new Date();
  });
  // Driver selection state - initialized from globalFilters, then overridden by user settings
  const [selectedDriverId, setSelectedDriverId] = useState('all');
  const [isExpanded, setIsExpanded] = useState(false);
  const [showRoutes, setShowRoutes] = useState(() => {
    const saved = localStorage.getItem('rxdeliver_show_routes');
    return saved !== null ? saved === 'true' : true;
  });
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [optimizationMessage, setOptimizationMessage] = useState(null);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [selectedCardId, setSelectedCardId] = useState(null);
  const [showDeliveryForm, setShowDeliveryForm] = useState(false);
  const [editingDelivery, setEditingDelivery] = useState(null);
  const [mapCenter, setMapCenter] = useState([53.5461, -113.4938]);
  const [mapZoom, setMapZoom] = useState(11);
  const [shouldFitBounds, setShouldFitBounds] = useState(null);
  const [mapMode, setMapMode] = useState('auto-follow');
  const [showOptimizationSettings, setShowOptimizationSettings] = useState(false);
  const [isAIEnabled, setIsAIEnabled] = useState(() => {
    const saved = localStorage.getItem('rxdeliver_ai_enabled');
    return saved !== null ? saved === 'true' : true;
  });
  const [showAIAssistant, setShowAIAssistant] = useState(false);
  const [driverLocation, setDriverLocation] = useState(null);
  const [hasUnreadAIAlerts, setHasUnreadAIAlerts] = useState(false);
  const [showPatientForm, setShowPatientForm] = useState(false);
  const [editingPatient, setEditingPatient] = useState(null);
  const [patientFormCallback, setPatientFormCallback] = useState(null);
  const [calendarMonth, setCalendarMonth] = useState(selectedDate);
  const [mapViewPhase, setMapViewPhase] = useState(1); // Will be loaded from user settings
  const [userSettingsLoaded, setUserSettingsLoaded] = useState(false);
  const [initialMapViewApplied, setInitialMapViewApplied] = useState(false);

  // CRITICAL: Render sequence tracking for proper initialization order
  // 1=StatsCard&StopCards, 2=FABs, 3=MapMarkers, 4=RouteLines, 5=DriverLiveLocation, 6=SharedLocations, 7=FABPhaseActive
  const [renderSequence, setRenderSequence] = useState({
    statsAndCards: false,
    fabs: false,
    mapMarkers: false,
    routeLines: false,
    driverLiveLocation: false,
    sharedLocations: false,
    fabPhaseReady: false
  });
  const [googleApiKey, setGoogleApiKey] = useState(null);
  const [allDriverLocations, setAllDriverLocations] = useState([]);
  const [screenWidth, setScreenWidth] = useState(window.innerWidth);
  const [cardWidth, setCardWidth] = useState(340);
  const [areCardsVisible, setAreCardsVisible] = useState(false);
  const [statsPanelOpacity, setStatsPanelOpacity] = useState(1);
  const statsPanelFadeTimeoutRef = useRef(null);
  const fadeTimeoutRef = useRef(null);
  const statsCardRef = useRef(null);
  const [isMapViewLocked, setIsMapViewLocked] = useState(false);
  const retractClustersRef = useRef(null);
  const [showRouteSummary, setShowRouteSummary] = useState(false);
  const hasShownSummaryRef = useRef(new Set()); // Track which driver-date combinations have shown summary
  const [summaryDriver, setSummaryDriver] = useState(null); // Store which driver's summary to show
  const stopCardsContainerRef = useRef(null);

  const mapLockTimeoutRef = useRef(null);
  const mapLockExpiresAtRef = useRef(null); // Timestamp when lock should expire
  const [useAIOptimization, setUseAIOptimization] = useState(true);
  const [driverRoutes, setDriverRoutes] = useState([]);
  const proximityLockedMarkersRef = useRef(new Set()); // Track which markers have been proximity-locked
  const lastProximitySnapTimeRef = useRef(0); // Timestamp of last proximity snap
  const lastUserInteractionRef = useRef(0); // Timestamp of last user interaction (map/card)

  const [dailyPolylineCount, setDailyPolylineCount] = useState(null);
  const [highlightedCardId, setHighlightedCardId] = useState(null);
  const [currentToNextPolyline, setCurrentToNextPolyline] = useState(null);
  const [hasRateLimitError, setHasRateLimitError] = useState(false);
  const [realTimeETAEnabled, setRealTimeETAEnabled] = useState(true);
  const [isReoptimizing, setIsReoptimizing] = useState(false);
  const [showQuickAdjustments, setShowQuickAdjustments] = useState(false);
  const [showAllDriverMarkers, setShowAllDriverMarkers] = useState(() => {
    const saved = localStorage.getItem('rxdeliver_show_all_driver_markers');
    return saved !== null ? saved === 'true' : false;
  });

  // Track previous map state for restoring when card is collapsed
  const [previousMapState, setPreviousMapState] = useState(null);

  // Track if we've done initial driver selection (prevent re-running on data changes)
  const hasSetInitialDriverDashboard = useRef(false);

  // Track phase before break for restoration
  const phaseBeforeBreakRef = useRef(null);

  // Store saved FAB phase from user settings (applied after data loads)
  const savedFabPhaseRef = useRef(1);

  // Route optimization notification
  const [routeNotification, setRouteNotification] = useState(null);

  // CRITICAL: Track map view phase in ref for GPS callback (avoid stale closure)
  const mapViewPhaseRef = useRef(mapViewPhase);
  useEffect(() => {
    mapViewPhaseRef.current = mapViewPhase;
  }, [mapViewPhase]);

  // CRITICAL: Calculate isDriver early (before useEffect that needs it)
  const isMobile = useMemo(() => isMobileDevice(), []);
  const isDriver = useMemo(() => currentUser ? userHasRole(currentUser, 'driver') : false, [currentUser]);
  const isAdmin = useMemo(() => currentUser ? userHasRole(currentUser, 'admin') : false, [currentUser]);

  // Track dynamically measured heights for map padding
  const [stopCardsBaseHeight, setStopCardsBaseHeight] = useState(0);
  const [statsCardBaseHeight, setstatsCardBaseHeight] = useState(0);
  const measurementTimeoutRef = useRef(null);

  // Computed padding values for consistent map bounds
  // Note: paddingTopLeft = [horizontal, vertical from top]
  //       paddingBottomRight = [horizontal, vertical from bottom]

  const getMapPadding = useCallback((cardExpanded = false) => {
    // Get actual rendered heights from refs
    const statsCardCurrHeight = statsCardRef.current?.offsetHeight || 116;
    const stopCardsCurrHeight = stopCardsContainerRef.current?.offsetHeight || 150;
    const hasVisibleCards = deliveriesWithStopOrder.length > 0;

    const topPadding = isMobile ?
    statsCardCurrHeight + 30 :
    30; // Desktop: Exclude stats card

    const bottomPadding = hasVisibleCards ?
    cardExpanded ? stopCardsCurrHeight + 10 : stopCardsBaseHeight + 10 :
    20;

    console.log('[Padding] - cardExpanded:', cardExpanded);
    console.log('[Padding] - hasVisibleCards:', hasVisibleCards);
    console.log('[Padding] - top:', topPadding, 'bottom:', bottomPadding);
    console.log('[Padding] - statsCardBaseHeight:', statsCardBaseHeight);
    console.log('[Padding] - stopCardsBaseHeight:', stopCardsBaseHeight);
    console.log('[Padding] - statsCardCurrHeight:', statsCardCurrHeight);
    console.log('[Padding] - stopCardsCurrHeight:', stopCardsCurrHeight);

    return {
      paddingTopLeft: [25, topPadding],
      paddingBottomRight: [25, bottomPadding]
    };
  }, [isMobile, areCardsVisible, stopCardsBaseHeight]);

  // Start driver activity monitor for pure drivers
  useEffect(() => {
    if (!currentUser) return;

    const isPureDriver = userHasRole(currentUser, 'driver') && 
                        !userHasRole(currentUser, 'admin') && 
                        !userHasRole(currentUser, 'dispatcher');

    if (isPureDriver) {
      driverActivityMonitor.start(currentUser);

      // Listen for auto-status updates
      const handleAutoStatusUpdate = (event) => {
        const { newStatus } = event.detail;
        console.log(`📢 [Dashboard] Driver status auto-updated to ${newStatus}`);
        // Refresh user data to reflect new status
        if (refreshUser) {
          refreshUser();
        }
      };

      window.addEventListener('driverStatusAutoUpdated', handleAutoStatusUpdate);

      return () => {
        driverActivityMonitor.stop();
        window.removeEventListener('driverStatusAutoUpdated', handleAutoStatusUpdate);
      };
    }
  }, [currentUser?.id, refreshUser]);

  // Load user settings on mount - PHASE 1: Load backend values FIRST
  useEffect(() => {
    if (!currentUser?.id || userSettingsLoaded) return;

    const loadSettings = async () => {
      try {
        const settings = await loadUserSettings(currentUser.id);

        // Apply saved date selection FIRST (before FAB phase)
        if (settings.selected_date) {
          const savedDate = new Date(settings.selected_date + 'T00:00:00');
          setSelectedDate(savedDate);
          globalFilters.setSelectedDate(savedDate);
          setCalendarMonth(savedDate);
        }

        // CRITICAL: Store FAB phase from settings but DON'T apply until deliveries are loaded
        if (settings.fab_map_cycle_phase) {
          // Don't set phase yet - will be applied in initial load effect when data is ready
          // Store in ref to access later
          savedFabPhaseRef.current = settings.fab_map_cycle_phase;
        } else {
          savedFabPhaseRef.current = 1; // Default to phase 1 if no saved preference
        }

        // CRITICAL: Mark settings as loaded BEFORE setting driver
        // This prevents race conditions with auto-selection logic
        setUserSettingsLoaded(true);
        hasSetInitialDriverDashboard.current = true;

        // Now apply saved driver selection (after marking as loaded)
        // Priority for drivers (not admin): ALWAYS select their own name (ignore saved settings)
        // Priority for admins/dispatchers: Use saved settings or smart defaults
        let driverToSelect = null;

        // CRITICAL: Non-admin drivers ALWAYS see only their own route
        if (currentUser && userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin')) {
          driverToSelect = currentUser.id;
        }

        // Fall back to smart default based on role and store assignments
        if (!driverToSelect) {
          const todayStr = format(new Date(), 'yyyy-MM-dd');
          const todayDeliveries = deliveries?.filter((d) => d && d.delivery_date === todayStr) || [];

          if (todayDeliveries.length > 0) {
            // Group deliveries by store to check for shared stores
            const storeDriverMap = new Map(); // Map<storeId, Set<driverId>>
            todayDeliveries.forEach((d) => {
              if (!d.store_id || !d.driver_id) return;
              if (!storeDriverMap.has(d.store_id)) {
                storeDriverMap.set(d.store_id, new Set());
              }
              storeDriverMap.get(d.store_id).add(d.driver_id);
            });

            // Check if any store has multiple drivers
            const hasSharedStore = Array.from(storeDriverMap.values()).some((driverSet) => driverSet.size > 1);

            if (userHasRole(currentUser, 'dispatcher')) {
              // DISPATCHERS: Use "All Drivers" if multiple drivers share the same store
              if (hasSharedStore) {
                driverToSelect = 'all';
              } else {
                // Single driver per store - select the first driver
                const allDriverIds = new Set(todayDeliveries.map((d) => d.driver_id).filter(Boolean));
                if (allDriverIds.size === 1) {
                  driverToSelect = Array.from(allDriverIds)[0];
                } else {
                  driverToSelect = settings.selected_driver_id || 'all';
                }
              }
            } else if (userHasRole(currentUser, 'admin')) {
              // Admins - use saved or default
              driverToSelect = settings.selected_driver_id || 'all';
            } else {
              // Other roles - use saved or default
              driverToSelect = settings.selected_driver_id || 'all';
            }
          } else {
            // No deliveries today - use saved setting or 'all'
            driverToSelect = settings.selected_driver_id || 'all';
          }
        }
        setSelectedDriverId(driverToSelect);
        globalFilters.setSelectedDriverId(driverToSelect);

      } catch (error) {
        console.error('❌ [Dashboard] Error loading user settings:', error);
        setUserSettingsLoaded(true);
        hasSetInitialDriverDashboard.current = true;
      }
    };

    loadSettings();
  }, [currentUser?.id, userSettingsLoaded]);

  const isAllDriversMode = selectedDriverId === 'all';

  const filteredDeliveries = useMemo(() => {
    if (!deliveries || !Array.isArray(deliveries)) return [];

    const dateStr = format(selectedDate, 'yyyy-MM-dd');

    // Filter by date and driver
    let result = deliveries.filter((d) => {
      if (!d) return false;
      if (d.delivery_date !== dateStr) return false;

      // Only filter by selected driver if not "all"
      if (selectedDriverId && selectedDriverId !== 'all') {
        if (d.driver_id !== selectedDriverId) return false;
      }

      return true;
    });

    // DISPATCHER: When viewing "All Drivers", only show deliveries for drivers who have stops in dispatcher's stores
    if (isDispatcher && selectedDriverId === 'all') {
      const dispatcherStoreIds = currentUser?.store_ids || [];

      // Get drivers who have deliveries in dispatcher's stores
      const driversWithStoreDeliveries = new Set(
        result.filter((d) => d && dispatcherStoreIds.includes(d.store_id)).
        map((d) => d.driver_id).
        filter(Boolean)
      );

      // Filter to only show deliveries from those drivers
      result = result.filter((d) => d && driversWithStoreDeliveries.has(d.driver_id));
    }

    return result;
  }, [deliveries, selectedDate, selectedDriverId, isDispatcher, currentUser]);

  const deliveriesWithStopOrder = useMemo(() => {
    if (!filteredDeliveries || !Array.isArray(filteredDeliveries) || filteredDeliveries.length === 0) return [];

    const groupedByDriver = {};
    filteredDeliveries.forEach((delivery) => {
      if (!delivery) return;
      const driverId = delivery.driver_id || 'unassigned';
      if (!groupedByDriver[driverId]) {
        groupedByDriver[driverId] = [];
      }
      groupedByDriver[driverId].push(delivery);
    });

    const result = [];
    Object.keys(groupedByDriver).forEach((driverId) => {
      const driverDeliveries = groupedByDriver[driverId];

      // CRITICAL: Separate pending from active deliveries
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const pendingDeliveries = driverDeliveries.filter((d) => d && d.status === 'pending');
      const activeDeliveries = driverDeliveries.filter((d) => d && d.status !== 'pending');

      const completedDeliveries = activeDeliveries.filter((d) => d && finishedStatuses.includes(d.status));
      const incompleteDeliveries = activeDeliveries.filter((d) => d && !finishedStatuses.includes(d.status));

      // Sort completed by actual_delivery_time
      completedDeliveries.sort((a, b) => {
        if (!a || !b) return 0;
        if (!a.actual_delivery_time || !b.actual_delivery_time) return 0;
        return new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time);
      });

      // Find the isNextDelivery delivery
      const nextDeliveryIdx = incompleteDeliveries.findIndex((d) => d && d.isNextDelivery === true);
      const nextDelivery = nextDeliveryIdx >= 0 ? incompleteDeliveries.splice(nextDeliveryIdx, 1)[0] : null;

      // Sort remaining incomplete by ETA
      incompleteDeliveries.sort((a, b) => {
        if (!a || !b) return 0;
        const etaA = a.delivery_time_eta || a.delivery_time_start || '99:99';
        const etaB = b.delivery_time_eta || b.delivery_time_start || '99:99';
        return etaA.localeCompare(etaB);
      });

      // Combine: completed + nextDelivery + remaining + pending at end
      const sortedDeliveries = [
        ...completedDeliveries,
        ...(nextDelivery ? [nextDelivery] : []),
        ...incompleteDeliveries,
        ...pendingDeliveries // CRITICAL: Add pending deliveries at the end
      ];

      // CRITICAL: Include ALL deliveries (including pending) in result
      let displayCounter = 1;

      sortedDeliveries.forEach((delivery) => {
        if (!delivery) return;

        // Only assign display_stop_order to non-pending deliveries
        if (delivery.status !== 'pending') {
          result.push({
            ...delivery,
            display_stop_order: displayCounter
          });
          displayCounter++;
        } else {
          // CRITICAL: Pending deliveries MUST be included in result for projected_deliveries attachment
          result.push({
            ...delivery,
            display_stop_order: null
          });
        }
      });
    });

    return result;
  }, [filteredDeliveries]);



  const stats = useMemo(() => {
    // DISPATCHER: Filter to only dispatcher's store deliveries
    let relevantDeliveries = filteredDeliveries || [];
    
    if (isDispatcher && currentUser?.store_ids) {
      const dispatcherStoreIds = new Set(currentUser.store_ids);
      relevantDeliveries = relevantDeliveries.filter(d => d && dispatcherStoreIds.has(d.store_id));
    }

    // CRITICAL: Exclude store pickups (deliveries without patient_id) from all counts
    const safeDeliveries = relevantDeliveries.filter(d => d && d.patient_id);
    
    if (!Array.isArray(safeDeliveries)) return {
      total: 0,
      inTransit: 0,
      completed: 0,
      failed: 0, returned: 0,
      totalDrivers: 0, inTransitDrivers: 0, completedDrivers: 0, totalPickups: 0
    };

    const patientMap = new Map((patients || []).filter((p) => p && p.id).map((p) => [p.id, p]));

    const isReturn = (delivery) => {
      if (!delivery) return false;
      const patient = patientMap.get(delivery.patient_id);
      const notes = delivery.delivery_notes || '';
      const patientName = delivery.patient_name || '';
      const patientFullName = patient?.full_name || '';

      if (notes.toLowerCase().includes('(rtn)') || patientName.toLowerCase().includes('(rtn)') || patientFullName.toLowerCase().includes('(rtn)')) {
        return true;
      }

      const returnRegex = /\breturn\b/i;
      return returnRegex.test(notes) || returnRegex.test(patientName) || returnRegex.test(patientFullName);
    };

    const total = safeDeliveries.length;

    const inTransitDeliveries = safeDeliveries.filter((d) => d && (d.status === 'in_transit' || d.status === 'en_route'));
    const inTransit = inTransitDeliveries.length;

    const completedDeliveries = safeDeliveries.filter((d) => {
      if (!d || d.status !== 'completed') return false;
      if (isReturn(d)) return false;
      return true;
    });
    const completed = completedDeliveries.length;

    const returned = safeDeliveries.filter(isReturn).length;
    const failed = safeDeliveries.filter((d) => {
      if (!d) return false;
      if (d.status === 'failed' && !isReturn(d)) return true;
      if (d.status === 'cancelled' && !d.patient_id) return true;
      return false;
    }).length;

    // CRITICAL: Calculate pickup counts for drivers (total, in_transit, completed pickups)
    const totalPickups = relevantDeliveries.filter(d => d && !d.patient_id).length;
    const inTransitPickups = relevantDeliveries.filter(d => 
      d && !d.patient_id && (d.status === 'in_transit' || d.status === 'en_route')
    ).length;
    const completedPickups = relevantDeliveries.filter(d => 
      d && !d.patient_id && d.status === 'completed'
    ).length;

    // DISPATCHER: Calculate unique driver counts for superscript (from all deliveries, not just patient deliveries)
    let totalDrivers = 0;
    let inTransitDrivers = 0;
    let completedDrivers = 0;

    if (isDispatcher) {
      const allDriverIds = new Set(relevantDeliveries.map(d => d?.driver_id).filter(Boolean));
      totalDrivers = allDriverIds.size;

      const inTransitAll = relevantDeliveries.filter((d) => d && (d.status === 'in_transit' || d.status === 'en_route'));
      const inTransitDriverIds = new Set(inTransitAll.map(d => d?.driver_id).filter(Boolean));
      inTransitDrivers = inTransitDriverIds.size;

      const completedAll = relevantDeliveries.filter((d) => {
        if (!d || d.status !== 'completed') return false;
        if (isReturn(d)) return false;
        return true;
      });
      const completedDriverIds = new Set(completedAll.map(d => d?.driver_id).filter(Boolean));
      completedDrivers = completedDriverIds.size;
    }

    return { 
      total, inTransit, completed, failed, returned, 
      totalDrivers, inTransitDrivers, completedDrivers, 
      totalPickups, inTransitPickups, completedPickups 
    };
  }, [filteredDeliveries, patients, isDispatcher, currentUser?.store_ids]);

  const isDateFinished = useMemo(() => {
    const today = startOfDay(new Date());
    const selected = startOfDay(selectedDate);
    const isPastDate = selected < today;

    if (!isPastDate) return false;

    if (!filteredDeliveries || !Array.isArray(filteredDeliveries)) return false;

    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const allFinished = filteredDeliveries.length > 0 &&
    filteredDeliveries.every((d) => d && finishedStatuses.includes(d.status));

    return allFinished;
  }, [selectedDate, filteredDeliveries]);

  // Filter drivers based on role and deliveries
  const driversList = useMemo(() => {
    if (!drivers || !Array.isArray(drivers)) {
      return [];
    }

    // ADMIN: Get all drivers
    if (userHasRole(currentUser, 'admin')) {
      return drivers;
    }

    // DISPATCHER: Show all drivers in the same city, highlight those with dispatcher's store deliveries for SELECTED DATE
    if (userHasRole(currentUser, 'dispatcher')) {
      const dispatcherCityId = currentUser.city_id;
      const dispatcherStoreIds = currentUser.store_ids || [];
      const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');

      // Get all drivers in the same city
      const driversInCity = drivers.filter((d) => d && d.city_id === dispatcherCityId);

      // Get unique driver IDs that have deliveries for dispatcher's stores ON THE SELECTED DATE (for highlighting)
      const driversWithStoreDeliveries = new Set(
        deliveries?.
        filter((d) => d && d.delivery_date === selectedDateStr && dispatcherStoreIds.includes(d.store_id)).
        map((d) => d.driver_id).
        filter(Boolean)
      );

      // Enrich drivers with hasStoreDeliveries flag for green highlighting
      return driversInCity.map((d) => ({
        ...d,
        _hasDispatcherStoreDeliveries: driversWithStoreDeliveries.has(d.id)
      }));
    }

    // OTHER ROLES: Return all drivers
    return drivers;
  }, [drivers, currentUser, deliveries, selectedDate]);

  const shouldShowLocationToggle = useMemo(() =>
  isMobile && isDriver && !userHasRole(currentUser, 'dispatcher'),
  [isMobile, isDriver, currentUser]
  );

  const isFiltersReady = useMemo(() => globalFilters.isReadyForDataFetch(), []);

  const isDriverDropdownDisabled = useMemo(() => {
    if (!currentUser) return false;

    // Always enable for admins and dispatchers
    if (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) {
      return false;
    }

    // For drivers: only enable if another driver shares a store with them on the selected date
    if (userHasRole(currentUser, 'driver')) {
      const dateStr = format(selectedDate, 'yyyy-MM-dd');
      const todayDeliveries = deliveries?.filter((d) => d && d.delivery_date === dateStr) || [];

      // Get stores this driver has deliveries from
      const myStores = new Set(
        todayDeliveries.filter((d) => d.driver_id === currentUser.id).map((d) => d.store_id)
      );

      // Check if any other driver has deliveries from the same stores
      const hasSharedStore = todayDeliveries.some((d) =>
      d.driver_id !== currentUser.id && myStores.has(d.store_id)
      );

      // Enable dropdown if there's a shared store, disable otherwise
      return !hasSharedStore;
    }

    return false;
  }, [currentUser, selectedDate, deliveries]);

  const tooltipValues = useMemo(() => ({
    total: isDispatcher 
      ? `Total: ${stats.total} stops (${stats.totalDrivers} drivers)` 
      : (isDriver && stats.totalPickups > 0)
        ? `Total: ${stats.total} stops (${stats.totalPickups} pickups)`
        : `Total: ${stats.total} stops`,
    inTransit: isDispatcher 
      ? `In-Transit: ${stats.inTransit} stops (${stats.inTransitDrivers} drivers)` 
      : (isDriver && stats.inTransitPickups > 0)
        ? `In-Transit: ${stats.inTransit} stops (${stats.inTransitPickups} pickups)`
        : `In-Transit: ${stats.inTransit} stops`,
    completed: isDispatcher 
      ? `Completed: ${stats.completed} stops (${stats.completedDrivers} drivers)` 
      : (isDriver && stats.completedPickups > 0)
        ? `Completed: ${stats.completed} stops (${stats.completedPickups} pickups)`
        : `Completed: ${stats.completed} stops`,
    failed: `${stats.failed} Failed / ${stats.returned} Returned`
  }), [stats, isDispatcher, isDriver]);

  const nextStop = useMemo(() => {
    if (!isDriver || !currentUser || !filteredDeliveries || !Array.isArray(filteredDeliveries) || filteredDeliveries.length === 0) return null;

    // CRITICAL: Use the backend's isNextDelivery flag for accuracy (should never be pending)
    const nextDeliveryFromBackend = filteredDeliveries.find((d) =>
    d && d.isNextDelivery === true && d.driver_id === currentUser.id && d.status !== 'pending'
    );

    if (nextDeliveryFromBackend) {
      return nextDeliveryFromBackend;
    }

    // Fallback: if backend hasn't marked one yet, find first incomplete (EXCLUDE PENDING)
    const unfinishedStops = filteredDeliveries.filter((d) => {
      if (!d) return false;
      return d.driver_id === currentUser.id &&
      !['completed', 'failed', 'cancelled', 'returned', 'pending'].includes(d.status);
    });

    if (unfinishedStops.length === 0) return null;

    const sortedStops = [...unfinishedStops].sort((a, b) => {
      if (!a || !b) return 0;
      if (a.stop_order && b.stop_order) return a.stop_order - b.stop_order;
      return (a.delivery_time_start || '').localeCompare(b.delivery_time_start || '');
    });

    return sortedStops[0];
  }, [isDriver, filteredDeliveries, currentUser]);

  const nextStopCoordinates = useMemo(() => {
    if (!nextStop) return null;

    if (nextStop.patient_id) {
      const patient = patients.find((p) => p && p.id === nextStop.patient_id);
      if (patient?.latitude && patient?.longitude) {
        return { lat: patient.latitude, lon: patient.longitude };
      }
    } else if (nextStop.store_id) {
      const store = stores.find((s) => s && s.id === nextStop.store_id);
      if (store?.latitude && store?.longitude) {
        return { lat: store.latitude, lon: store.longitude };
      }
    }

    return null;
  }, [nextStop, patients, stores]);

  const statsCardPositioning = useMemo(() => {
    const ratio = screenWidth / cardWidth;

    if (ratio < 2) {
      return 'absolute top-2 left-1/2 -translate-x-1/2 z-[600]';
    } else {
      return 'absolute top-2 left-2 z-[600]';
    }
  }, [screenWidth, cardWidth]);

  const optimizationMessagePositioning = useMemo(() => {
    // Always center below stats card
    return 'absolute left-1/2 -translate-x-1/2 z-[9998] max-w-[90vw]';
  }, []);

  const handleCardInteraction = useCallback((show) => {
    if (fadeTimeoutRef.current) {
      clearTimeout(fadeTimeoutRef.current);
      fadeTimeoutRef.current = null;
    }

    setAreCardsVisible(show);

    if (show && !isExpanded) {
      fadeTimeoutRef.current = setTimeout(() => {
        setAreCardsVisible(false);
      }, 3000);
    }
  }, [isExpanded]);

  // Stats panel fade effect - fades to 50% opacity 3 seconds after mouse leaves (when not expanded)
  const handleStatsPanelInteraction = useCallback((isHovering) => {
    // Clear any existing fade timeout
    if (statsPanelFadeTimeoutRef.current) {
      clearTimeout(statsPanelFadeTimeoutRef.current);
      statsPanelFadeTimeoutRef.current = null;
    }

    if (isHovering || isExpanded) {
      // Mouse over or expanded - full opacity
      setStatsPanelOpacity(1);
    } else {
      // Mouse left and not expanded - start 3 second timer to fade
      statsPanelFadeTimeoutRef.current = setTimeout(() => {
        setStatsPanelOpacity(0.5);
      }, 3000);
    }
  }, [isExpanded]);

  // When isExpanded changes, update opacity accordingly
  useEffect(() => {
    if (isExpanded) {
      setStatsPanelOpacity(1);
      if (statsPanelFadeTimeoutRef.current) {
        clearTimeout(statsPanelFadeTimeoutRef.current);
        statsPanelFadeTimeoutRef.current = null;
      }
    } else {
      // When collapsing, start fade timer
      statsPanelFadeTimeoutRef.current = setTimeout(() => {
        setStatsPanelOpacity(0.5);
      }, 3000);
    }
  }, [isExpanded]);

  // Track when the last programmatic map move happened (to debounce interaction handler)
  const lastProgrammaticMapMoveRef = useRef(0);

  // Track previous values for detecting changes that should trigger map repositioning
  const prevSelectedDriverIdRef = useRef(selectedDriverId);
  const prevSelectedDateRef = useRef(format(selectedDate, 'yyyy-MM-dd'));
  const pendingMapRepositionRef = useRef(false);

  // Effect to detect driver/date changes and trigger repositioning AFTER data loads
  useEffect(() => {
    const currentDateStr = format(selectedDate, 'yyyy-MM-dd');

    // Check if driver or date changed
    const driverChanged = prevSelectedDriverIdRef.current !== selectedDriverId;
    const dateChanged = prevSelectedDateRef.current !== currentDateStr;

    // Update refs
    prevSelectedDriverIdRef.current = selectedDriverId;
    prevSelectedDateRef.current = currentDateStr;

    // Only reposition if we actually have data loaded
    if ((driverChanged || dateChanged) && isDataLoaded && deliveriesWithStopOrder.length > 0) {
      // Trigger immediately without the flag system
      if (mapViewPhase > 0) {
        setMapViewTrigger((prev) => prev + 1);
      }
    }
  }, [selectedDriverId, selectedDate, isDataLoaded, deliveriesWithStopOrder.length, mapViewPhase]);



  // CRITICAL: Track map view phase in ref for handleMapInteraction (avoid stale closure)
  const mapViewPhaseForInteractionRef = useRef(mapViewPhase);
  useEffect(() => {
    mapViewPhaseForInteractionRef.current = mapViewPhase;
  }, [mapViewPhase]);

  const handleMapInteraction = useCallback((isUserInteraction = false) => {
    // PHASE 2 NO LONGER UNLOCKS ON MAP INTERACTION
    // It stays permanently locked until FAB is clicked to change phases
    // This simplifies the logic and prevents accidental unlocks

    // Record user interaction time (prevents proximity snap for 5 minutes)
    if (isUserInteraction) {
      lastUserInteractionRef.current = Date.now();
    }
  }, []);

  // NOTE: Removed auto-fit bounds effect that was causing map to re-center unexpectedly
  // The FAB handleMapViewCycle now handles all map positioning

  useEffect(() => {
    localStorage.setItem('rxdeliver_show_routes', String(showRoutes));
  }, [showRoutes]);

  useEffect(() => {
    const unsubscribe = globalFilters.subscribe((newFilters) => {

      if (newFilters.selectedDate) {
        const dateObj = typeof newFilters.selectedDate === 'string' ?
        new Date(newFilters.selectedDate + 'T00:00:00') :
        new Date(newFilters.selectedDate);
        setSelectedDate(dateObj);
        setCalendarMonth(dateObj);
      }

      if (newFilters.selectedDriverId !== undefined) {


        // This subscription handles changes from other components
      }});return unsubscribe;
  }, []); // Listen for driver status break/resume events from DriverStatusToggle
  useEffect(() => {
    const unsubscribe = fabControlEvents.subscribe((event) => {
      if (event.type === 'BREAK_START') {
        console.log('🗺️ [Dashboard] Driver going on break - unlocking FAB and zooming to phase 1');
        // Save current phase for later restoration
        phaseBeforeBreakRef.current = event.previousPhase;
        // Clear any timers
        if (mapLockTimeoutRef.current) {
          clearTimeout(mapLockTimeoutRef.current);
          mapLockTimeoutRef.current = null;
        }
        mapLockExpiresAtRef.current = null;

        // Unlock FAB and set to phase 1
        setIsMapViewLocked(false);
        setMapViewPhase(1);
        setMapViewTrigger((prev) => prev + 1); // Trigger zoom out to all markers

      } else if (event.type === 'BREAK_END') {

        // Restore the saved phase
        const phaseToRestore = event.phaseToRestore || 1;
        setMapViewPhase(phaseToRestore);

        // Lock the FAB and trigger map view
        setIsMapViewLocked(true);
        setMapViewTrigger((prev) => prev + 1);

        // Set up appropriate timer based on restored phase
        if (phaseToRestore === 1 || phaseToRestore === 3) {
          const lockDuration = 3000;
          const expiresAt = Date.now() + lockDuration;
          mapLockExpiresAtRef.current = expiresAt;

          mapLockTimeoutRef.current = window.setTimeout(() => {
            if (mapLockExpiresAtRef.current === expiresAt) {
              setIsMapViewLocked(false);
              mapLockExpiresAtRef.current = null;
              mapLockTimeoutRef.current = null;
            }
          }, lockDuration);
        }
        // Phase 2 stays locked permanently

        phaseBeforeBreakRef.current = null;
      } else if (event.type === 'DATA_READY') {
        // CRITICAL: Data has fully loaded - reactivate FAB with current phase
        console.log(`🔄 [FAB] Data ready - reactivating Phase ${mapViewPhase}`);

        // Lock FAB and trigger map view
        setIsMapViewLocked(true);
        lastProgrammaticMapMoveRef.current = Date.now();
        window._lastProgrammaticMapMove = Date.now();
        setMapViewTrigger((prev) => prev + 1);

        // CRITICAL: Handle timer logic based on phase - ONLY set timers for Phase 1 & 3
        if (mapViewPhase === 2) {
          // Phase 2 - NO timer at all, stays locked permanently
          // CRITICAL: Clear any existing timers to prevent accidental unlock
          if (mapLockTimeoutRef.current) {
            clearTimeout(mapLockTimeoutRef.current);
            mapLockTimeoutRef.current = null;
          }
          mapLockExpiresAtRef.current = null;

        } else if (mapViewPhase === 1 || mapViewPhase === 3) {
          // Phase 1 & 3 - Clear any existing timers first, then set new timer
          if (mapLockTimeoutRef.current) {
            clearTimeout(mapLockTimeoutRef.current);
            mapLockTimeoutRef.current = null;
          }
          mapLockExpiresAtRef.current = null;

          const lockDuration = 3000;
          const expiresAt = Date.now() + lockDuration;
          mapLockExpiresAtRef.current = expiresAt;

          mapLockTimeoutRef.current = window.setTimeout(() => {
            if (mapLockExpiresAtRef.current === expiresAt) {
              setIsMapViewLocked(false);
              mapLockExpiresAtRef.current = null;
              mapLockTimeoutRef.current = null;
              console.log(`⏰ [FAB] Phase ${mapViewPhase} auto-unlocked after data ready`);
            }
          }, lockDuration);
        }
      }
    });

    return unsubscribe;
  }, [deliveriesWithStopOrder, mapViewPhase]);

  useEffect(() => {
    return () => {
      if (fadeTimeoutRef.current) {
        clearTimeout(fadeTimeoutRef.current);
      }
      if (mapLockTimeoutRef.current) {
        clearTimeout(mapLockTimeoutRef.current);
      }
      if (statsPanelFadeTimeoutRef.current) {
        clearTimeout(statsPanelFadeTimeoutRef.current);
      }
    };
  }, []);



  useEffect(() => {
    let resizeTimeout;
    const handleResize = () => {
      setScreenWidth(window.innerWidth);

      // Debounce the map re-center to avoid excessive updates during resize
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        // Trigger map to re-center based on current FAB phase
        if (isMapViewLocked && mapViewPhase > 0) {
          setMapViewTrigger((prev) => prev + 1);
        }
      }, 300);
    };

    const measureStatsCard = () => {
      if (statsCardRef.current) {
        const width = statsCardRef.current.offsetWidth;
        const height = statsCardRef.current.offsetHeight;

        if (width > 0 && width !== cardWidth) {
          setCardWidth(width);
        }
        if (height > 0 && height !== statsCardBaseHeight) {
          setstatsCardBaseHeight(height);
        }
      }
    };

    const measureStopCards = () => {
      if (stopCardsContainerRef.current && !selectedCardId) {
        // Only measure when no card is expanded to capture actual rendered base height
        const height = stopCardsContainerRef.current.offsetHeight;
        if (height > 0) {
          setStopCardsBaseHeight(height);
        }
      }
    };

    // Measure on mount and when card selection changes
    measureStatsCard();

    window.addEventListener('resize', handleResize);
    window.addEventListener('resize', measureStatsCard);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('resize', measureStatsCard);
      clearTimeout(resizeTimeout);
    };
  }, [cardWidth, isExpanded, screenWidth, isMapViewLocked, mapViewPhase]);

  // Measure HorizontalStopCards container height when in non-expanded state
  useEffect(() => {
    // Clear any pending measurement
    if (measurementTimeoutRef.current) {
      clearTimeout(measurementTimeoutRef.current);
    }

    // Only measure when no card is expanded
    if (!selectedCardId && stopCardsContainerRef.current && deliveriesWithStopOrder.length > 0) {
      // Wait for render and animations to settle
      measurementTimeoutRef.current = setTimeout(() => {
        if (stopCardsContainerRef.current && !selectedCardId) {
          const height = stopCardsContainerRef.current.offsetHeight;
          if (height > 0) {
            setStopCardsBaseHeight(height);
          }
        }
      }, 400);
    }

    return () => {
      if (measurementTimeoutRef.current) {
        clearTimeout(measurementTimeoutRef.current);
      }
    };
  }, [selectedCardId, deliveriesWithStopOrder.length, currentUser?.id]);

  useEffect(() => {
    const fetchGoogleApiKey = async () => {
      try {
        const response = await base44.functions.invoke('getGoogleMapsKey');
        if (response.data && response.data.apiKey) {
          setGoogleApiKey(response.data.apiKey);
        }
      } catch (error) {
        console.error('Error fetching Google API key:', error);
      }
    };

    fetchGoogleApiKey();
  }, []);

  // Fetch daily API call count from GoogleAPILog for app owner badge
  const fetchPolylineCount = useCallback(async () => {
    if (!currentUser || !isAppOwner(currentUser)) return;

    try {
      const todayStr = format(new Date(), 'yyyy-MM-dd');
      const todayStart = new Date(todayStr + 'T00:00:00').toISOString();
      const todayEnd = new Date(todayStr + 'T23:59:59').toISOString();

      // Fetch all Google API calls for today
      const apiLogs = await base44.entities.GoogleAPILog.filter({
        timestamp: { $gte: todayStart, $lte: todayEnd }
      });

      setDailyPolylineCount(apiLogs?.length || 0);
    } catch (error) {
      console.error('Error fetching API call count:', error);
      setDailyPolylineCount(0);
    }
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser || !isAppOwner(currentUser)) return;

    fetchPolylineCount();

    // Refresh every 30 seconds
    const interval = setInterval(fetchPolylineCount, 30000);
    return () => clearInterval(interval);
  }, [currentUser, fetchPolylineCount]);

  // Get driver's location for blue dot display
  // MOBILE: Use device GPS
  // NON-MOBILE: Use shared location from AppUser entity
  useEffect(() => {
    if (!isDriver || !currentUser) return;

    let watchId = null;

    const startWatchingPosition = () => {
      // NON-MOBILE: Use shared location from AppUser entity (no device GPS)
      if (!isMobile) {
        console.log('🖥️ [Dashboard] Non-mobile device - using shared location from AppUser');
        
        // Set up interval to poll AppUser for shared location
        const pollSharedLocation = async () => {
          try {
            const appUsers = await base44.entities.AppUser.filter({ user_id: currentUser.id });
            const appUser = appUsers?.[0];
            
            if (appUser?.current_latitude && appUser?.current_longitude && appUser?.location_updated_at) {
              const newLocation = {
                latitude: appUser.current_latitude,
                longitude: appUser.current_longitude,
                timestamp: appUser.location_updated_at,
                accuracy: null, // Shared location doesn't have accuracy
                source: 'shared_location'
              };
              setDriverLocation(newLocation);
            } else {
              setDriverLocation(null);
            }
          } catch (error) {
            console.warn('⚠️ [Dashboard] Failed to fetch shared location:', error);
          }
        };
        
        // Initial poll
        pollSharedLocation();
        
        // Poll every 30 seconds
        const interval = setInterval(pollSharedLocation, 30000);
        return () => clearInterval(interval);
      }
      
      // MOBILE: Use device GPS
      if (!navigator.geolocation) {
        console.warn('⚠️ [Dashboard] Geolocation not available on this device');
        return;
      }

      watchId = navigator.geolocation.watchPosition(
        (position) => {
          const newLocation = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            timestamp: new Date(position.timestamp).toISOString(),
            accuracy: position.coords.accuracy,
            source: 'device_gps'
          };

          setDriverLocation(newLocation);

          // CRITICAL: Auto-zoom when within 100m of in_transit/en_route stop (mobile only)
          // Phase 2: continuous re-centering ONLY when locked (FAB blue)
          // When user pans/zooms, handleMapInteraction unlocks FAB, stopping re-centering
          // Other phases: proximity snap only (if unlocked)
          if (isMobile && newLocation.latitude && newLocation.longitude) {
            const now = Date.now();

            // PHASE 2 LOCKED: Continuous re-centering (every location update)
            // CRITICAL: Only re-center if FAB is locked - user pan/zoom unlocks FAB via handleMapInteraction
            // CRITICAL: Use ref to get current lock state (closure captures stale state)
            if (mapViewPhaseRef.current === 2 && isMapViewLockedRef.current && nextStopCoordinates) {
              console.log('📍 [Phase 2 Auto] Re-centering on driver & next stop');

              const bounds = [
              [newLocation.latitude, newLocation.longitude],
              [nextStopCoordinates.lat, nextStopCoordinates.lon]];


              const padding = getMapPadding(false);
              setShouldFitBounds({
                bounds,
                options: {
                  ...padding,
                  maxZoom: 17.5,
                  animate: true,
                  duration: 0.5
                }
              });
              setMapCenter(null);
              setMapZoom(null);
              return; // Skip proximity snap logic below
            }

            // PROXIMITY SNAP: Only when FAB is unlocked (gray) and user has been idle
            // Check if 5 minutes have passed since last user interaction (map/card)
            const timeSinceUserInteraction = now - lastUserInteractionRef.current;
            const interactionCooldown = 300000; // 5 minutes

            // Also check 60 seconds since last auto-snap
            const timeSinceLastSnap = now - lastProximitySnapTimeRef.current;
            const snapCooldown = 60000; // 60 seconds

            if (!isMapViewLocked && timeSinceUserInteraction >= interactionCooldown && timeSinceLastSnap >= snapCooldown) {
              const activeStatuses = ['in_transit', 'en_route'];
              const activeDeliveries = deliveriesWithStopOrder.filter((d) =>
              d && activeStatuses.includes(d.status)
              );

              // Check each active delivery for proximity
              for (const delivery of activeDeliveries) {
                let stopLat, stopLon;

                if (delivery.patient_id) {
                  const patient = patients.find((p) => p && p.id === delivery.patient_id);
                  stopLat = patient?.latitude;
                  stopLon = patient?.longitude;
                } else if (delivery.store_id) {
                  const store = stores.find((s) => s && s.id === delivery.store_id);
                  stopLat = store?.latitude;
                  stopLon = store?.longitude;
                }

                if (stopLat && stopLon) {
                  const distanceKm = calculateDistance(
                    newLocation.latitude,
                    newLocation.longitude,
                    stopLat,
                    stopLon
                  );

                  // Within 100m (0.1km)
                  if (distanceKm <= 0.1) {
                    // Check if card is currently centered on screen
                    const cardElement = document.getElementById(`stop-card-${delivery.id}`);
                    let isCardCentered = false;

                    if (cardElement && stopCardsContainerRef.current) {
                      const container = stopCardsContainerRef.current.querySelector('.overflow-x-auto');
                      if (container) {
                        const containerRect = container.getBoundingClientRect();
                        const cardRect = cardElement.getBoundingClientRect();

                        const containerCenter = containerRect.left + containerRect.width / 2;
                        const cardCenter = cardRect.left + cardRect.width / 2;
                        const distanceFromCenter = Math.abs(cardCenter - containerCenter);

                        // Consider centered if within 50px of center
                        isCardCentered = distanceFromCenter < 50;
                      }
                    }

                    if (isCardCentered) {
                      continue;
                    }

                    // Record the snap time (prevents any snaps for 60 seconds)
                    lastProximitySnapTimeRef.current = Date.now();

                    // Center map on the nearby marker
                    const padding = getMapPadding(false);
                    setShouldFitBounds({
                      bounds: [[stopLat, stopLon]],
                      options: {
                        ...padding,
                        maxZoom: 17,
                        animate: true
                      }
                    });
                    setMapCenter(null);
                    setMapZoom(null);

                    // Scroll to the associated card
                    setTimeout(() => {
                      const cardElement = document.getElementById(`stop-card-${delivery.id}`);
                      if (cardElement) {
                        cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                      }
                    }, 300);

                    break; // Only zoom to first nearby stop
                  }
                }
              }
            } else {
              if (timeSinceUserInteraction < interactionCooldown) {
                const remainingMinutes = Math.ceil((interactionCooldown - timeSinceUserInteraction) / 60000);
              } else {
                const remainingSeconds = Math.ceil((snapCooldown - timeSinceLastSnap) / 1000);
              }
            }
          }
        },
        (error) => {
          console.warn('⚠️ [Dashboard] GPS error:', error.message);
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0
        }
      );
    };

    const cleanup = startWatchingPosition();

    return () => {
      if (cleanup) {
        cleanup(); // For non-mobile interval cleanup
      }
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
      }
    };
  }, [isDriver, currentUser, isMobile, deliveriesWithStopOrder, patients, stores, mapViewPhase, getMapPadding]);

  // Track other drivers' locations via poller (for all-drivers mode or when checkbox is checked)
  useEffect(() => {
    if (!isDataLoaded || !currentUser || !deliveries || !drivers) {
      return;
    }

    driverLocationPoller.start(() => {
      // Callback provided for future use, but not actively calling refreshData
      // to prevent triggering auto-selection every 15 seconds
    });
    
    const unsubscribe = driverLocationPoller.subscribe((locations) => {
      if (!locations || !Array.isArray(locations)) return;
      setAllDriverLocations(locations);
    });
    
    return () => {
      unsubscribe();
      driverLocationPoller.stop();
    };
  }, [isDataLoaded, currentUser, deliveries, drivers]);
  
  useEffect(() => {
    if (!isDataLoaded || !currentUser || !deliveries || !drivers) {
      return;
    }
    const appUsers = users?.filter((u) => u.user_id) || [];
    driverLocationPoller.processLocationData(currentUser, deliveries, drivers, stores, appUsers, selectedDate);
  }, [isDataLoaded, currentUser, deliveries, drivers, stores, users, selectedDate]); // Fetch and display current-to-next polyline for display
  // This polyline is generated by the backend (optimizeDriverRoute) and stored in DriverRoutePolyline entity
  // It shows the route from last completed stop (or home) to the next stop
  useEffect(() => {
    if (!currentUser || !selectedDriverId) {
      setCurrentToNextPolyline(null);
      return;
    }
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
    if (todayStr !== selectedDateStr) {
      setCurrentToNextPolyline(null);
      return;
    }
    const driverIdToFetch = selectedDriverId !== 'all' ? selectedDriverId : currentUser?.id;
    if (!driverIdToFetch) {
      setCurrentToNextPolyline(null);
      return;
    }

    const fetchPolyline = async () => {
      try {
        const driverDeliveries = filteredDeliveries.filter((d) => d && d.driver_id === driverIdToFetch);
        const driver = users.find((u) => u && u.id === driverIdToFetch);

        // CRITICAL: Only fetch polyline if driver is on_duty with location tracking enabled
        if (!driver || driver.driver_status !== 'on_duty' || driver.location_tracking_enabled !== true) {
          setCurrentToNextPolyline(null);
          return;
        }

        const segment = determinePolylineSegment(driverDeliveries, driver, patients, stores);

        if (segment) {
          const polyline = await fetchPolylineForSegment(
            segment.originLat,
            segment.originLon,
            segment.destLat,
            segment.destLon
          );

          setCurrentToNextPolyline(polyline);
        } else {
          setCurrentToNextPolyline(null);
        }
      } catch (error) {
        console.error('❌ [Polyline] Error:', error);
        setCurrentToNextPolyline(null);
      }
    };

    // Only set up periodic fetch if we actually have active deliveries
    const hasActiveDeliveries = filteredDeliveries.some((d) =>
    d && !['completed', 'failed', 'cancelled', 'returned'].includes(d.status)
    );

    if (!hasActiveDeliveries) {
      return; // Don't fetch polylines if no active deliveries
    }

    fetchPolyline();
    const interval = setInterval(fetchPolyline, 30000);
    return () => clearInterval(interval);
  }, [currentUser?.id, selectedDriverId, selectedDate, filteredDeliveries, patients, stores, users]);

  useEffect(() => {
    if (!currentUser || !userHasRole(currentUser, 'driver') || showAIAssistant || !isAIEnabled) {
      return;
    }

    const checkAlerts = async () => {
      try {
        if (!filteredDeliveries || !Array.isArray(filteredDeliveries)) {// Defensive check
          setHasUnreadAIAlerts(false);
          return;
        }

        const activeDeliveries = filteredDeliveries.filter((d) => {
          if (!d) return false; // Defensive check
          return !['completed', 'failed', 'cancelled', 'returned'].includes(d.status);
        });

        if (activeDeliveries.length === 0) {
          setHasUnreadAIAlerts(false);
          return;
        }

        const now = new Date();
        const currentTime = format(now, 'HH:mm');

        const urgentCount = activeDeliveries.filter((d) => {
          if (!d || !d.delivery_time_end) return false; // Defensive check
          try {
            const [hours, minutes] = currentTime.split(':').map(Number);
            const [endHours, endMinutes] = d.delivery_time_end.split(':').map(Number);
            const currentTotalMinutes = hours * 60 + minutes;
            const endTotalMinutes = endHours * 60 + endMinutes;
            const remaining = endTotalMinutes - currentTotalMinutes;
            return remaining > 0 && remaining <= 45;
          } catch (error) {
            // Handle cases where delivery_time_end might be malformed
            console.warn("Invalid delivery_time_end for AI alert check:", d.delivery_time_end, error);
            return false;
          }
        }).length;

        if (urgentCount > 0) {
          setHasUnreadAIAlerts(true);
        } else {
          setHasUnreadAIAlerts(false);
        }
      } catch (error) {
        console.error('Error checking AI alerts:', error);
      }
    };

    checkAlerts();

    const interval = setInterval(checkAlerts, 10 * 60 * 1000);

    return () => clearInterval(interval);
  }, [currentUser, filteredDeliveries, showAIAssistant, isAIEnabled]);

  useEffect(() => {
    if (showAIAssistant) {
      setHasUnreadAIAlerts(false);
    }
  }, [showAIAssistant]);

  useEffect(() => {
    const isAnyFormOpen = showDeliveryForm || showPatientForm || showOptimizationSettings || showAIAssistant;
    if (setIsFormOverlayOpen) {
      setIsFormOverlayOpen(isAnyFormOpen);
    }
  }, [showDeliveryForm, showPatientForm, showOptimizationSettings, showAIAssistant, setIsFormOverlayOpen]);

  /**
   * MAP CYCLE FAB - RULES:
   * 
   * PHASE 1: Show all markers (drivers, stops, home locations)
   *   - Locked for 3 seconds, then auto-unlocks
   *   - After unlock: free roam mode (user can pan/zoom)
   * 
   * PHASE 2: Center on driver + next stop (continuous tracking)
   *   - STAYS LOCKED PERMANENTLY until user manually pans/zooms the map
   *   - Continuously re-centers on driver & next stop as location updates
   *   - Manual map interaction unlocks FAB (turns gray)
   * 
   * PHASE 3: Center on driver only
   *   - Locked for 3 seconds, then auto-unlocks
   *   - After unlock: free roam mode (user can pan/zoom)
   * 
   * CLICKING FAB:
   *   - If UNLOCKED (gray): Re-activate current phase (re-lock + re-center)
   *   - If LOCKED (blue): Advance to next phase
   */
  const handleMapViewCycle = useCallback(() => {
    // CRITICAL: Allow dispatchers and admins to use FAB
    if (!isDriver && !isDispatcher && !isAdmin) {
      return;
    }

    let newMapViewPhase;

    // CLICKING UNLOCKED FAB (gray) → Re-activate current phase
    if (!isMapViewLocked) {
      newMapViewPhase = mapViewPhase;
      console.log(`🔄 [FAB] Re-activating Phase ${newMapViewPhase} (was unlocked)`);
    } else {
      // CLICKING LOCKED FAB (blue) → Advance to next phase
      const nextPhase = mapViewPhase % 3 + 1;

      // Non-drivers always stay on Phase 1
      if (!isDriver) {
        newMapViewPhase = 1;
      } else {
        newMapViewPhase = nextPhase;

        // Skip phase 2 if no next stop coordinates
        if (newMapViewPhase === 2 && !nextStopCoordinates) {
          newMapViewPhase = 3;
        }
        // Skip phase 3 if not on mobile
        if (newMapViewPhase === 3 && !isMobile) {
          newMapViewPhase = 1;
        }
        // Double-check phase 2 validity
        if (newMapViewPhase === 2 && !nextStopCoordinates) {
          newMapViewPhase = 1;
        }
      }
      console.log(`➡️ [FAB] Advancing to Phase ${newMapViewPhase}`);
    }

    // CRITICAL: Set lock IMMEDIATELY and update phase
    console.log(`🔒 [FAB Click] Locking FAB for Phase ${newMapViewPhase}`);
    setIsMapViewLocked(true);
    setMapViewPhase(newMapViewPhase);

    // CRITICAL: Mark this as programmatic BEFORE triggering map view
    lastProgrammaticMapMoveRef.current = Date.now();
    window._lastProgrammaticMapMove = Date.now();

    // Trigger map repositioning AFTER marking as programmatic
    setMapViewTrigger((prev) => prev + 1);

    // Save to user settings
    if (currentUser?.id) {
      saveSetting(currentUser.id, 'fab_map_cycle_phase', newMapViewPhase);
    }

    // Scroll to next delivery card
    setTimeout(() => {
      const nextCard = deliveriesWithStopOrder.find((d) => d && d.isNextDelivery === true);
      if (nextCard) {
        const cardElement = document.getElementById(`stop-card-${nextCard.id}`);
        if (cardElement) {
          cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
      }
    }, 300);

    // PHASE 1 & 3: Set timer for 3-second auto-unlock
    // PHASE 2: NO TIMER - stays locked permanently
    if (newMapViewPhase === 1 || newMapViewPhase === 3) {
      const lockDuration = 3000;
      const expiresAt = Date.now() + lockDuration;
      mapLockExpiresAtRef.current = expiresAt;

      mapLockTimeoutRef.current = setTimeout(() => {
        if (mapLockExpiresAtRef.current === expiresAt) {
          setIsMapViewLocked(false);
          mapLockExpiresAtRef.current = null;
          mapLockTimeoutRef.current = null;
          console.log(`⏰ [FAB] Phase ${newMapViewPhase} auto-unlocked after 3 seconds`);
        }
      }, lockDuration);

      console.log(`🔵 [FAB] Phase ${newMapViewPhase} locked - will auto-unlock in 3 seconds`);
    } else if (newMapViewPhase === 2) {
      // Phase 2 - NO timer, stays locked PERMANENTLY until FAB is clicked again
      // CRITICAL: Clear any existing timers to prevent accidental unlock
      if (mapLockTimeoutRef.current) {
        clearTimeout(mapLockTimeoutRef.current);
        mapLockTimeoutRef.current = null;
      }
      mapLockExpiresAtRef.current = null;

      console.log(`🔵 [FAB] Phase 2 locked PERMANENTLY - unlocks only when FAB is clicked to change phase`);
    }
  }, [mapViewPhase, isMapViewLocked, isDriver, nextStopCoordinates, isDispatcher, isAdmin, isMobile, currentUser, deliveriesWithStopOrder]);

  // Track if the current map positioning was triggered by FAB (not by data refresh)
  const mapPositioningTriggerRef = useRef(null);

  // Track a counter to force useEffect to re-run when FAB is clicked
  const [mapViewTrigger, setMapViewTrigger] = useState(0);

  // Track the last trigger value to prevent re-running on every state change
  const lastAppliedTriggerRef = useRef(0);

  useEffect(() => {

    // CRITICAL: Only run map positioning when mapViewTrigger changes (FAB clicked or data reloaded)
    // Skip if mapViewTrigger hasn't changed to prevent re-running
    if (mapViewTrigger === 0 || mapViewTrigger === lastAppliedTriggerRef.current) {
      return;
    }

    // Skip if mapViewPhase is 0 (reset state - should not happen with new logic)
    if (mapViewPhase === 0) {
      return;
    }

    // Update last applied trigger
    lastAppliedTriggerRef.current = mapViewTrigger;

    // CRITICAL: Only skip phase 2 & 3 if not driver or no location
    // Phase 1 can run for dispatchers/admins without driver location
    if (mapViewPhase > 1 && (!isDriver || !driverLocation)) {
      return;
    }

    // Mark that this positioning is from a FAB interaction (prevents unlock on programmatic map moves)
    mapPositioningTriggerRef.current = 'fab';
    lastProgrammaticMapMoveRef.current = Date.now();
    window._lastProgrammaticMapMove = Date.now();

    // NOTE: Timer is now started in handleMapViewCycle, not here
    // This useEffect only handles map repositioning

    switch (mapViewPhase) {
      case 1: // "Show All Stops"
        console.clear;
        const allCoordinates = [];
        let hasStopMarkers = false;
        let hasDriverMarkers = false;

        // Check if viewing today's date
        const todayStr = format(new Date(), 'yyyy-MM-dd');
        const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
        const isViewingToday = todayStr === selectedDateStr;

        // CRITICAL: Check if driver is viewing their own route specifically
        // FIXED: Allow any user (even admin/dispatcher) when they select themselves
        const isDriverViewingSelfToday =
        selectedDriverId === currentUser?.id &&
        selectedDriverId !== 'all' &&
        isViewingToday;

        // 1. BLUE DOT: Include driver's live location when visible on mobile
        // The blue dot is rendered when: mobile + driver + viewing today + viewing self
        const shouldIncludeBlueDot =
        isMobile &&
        isDriver &&
        isViewingToday &&
        driverLocation?.latitude &&
        driverLocation?.longitude && (
        selectedDriverId === currentUser?.id || selectedDriverId === 'all');

        if (shouldIncludeBlueDot) {
          allCoordinates.push([driverLocation.latitude, driverLocation.longitude]);
          hasDriverMarkers = true;
        }

        // 2. SHARED DRIVER LOCATIONS: Only include if checkbox is checked (for drivers) or in all-drivers mode
        if (isViewingToday && allDriverLocations && Array.isArray(allDriverLocations)) {
          allDriverLocations.forEach((location) => {
            if (!location?.latitude || !location?.longitude || !location?.driver_id) return;

            // Skip current user on mobile (blue dot shows instead when viewing self)
            if (isMobile && location.driver_id === currentUser?.id) return;

            // CRITICAL: For drivers viewing self, only include if showAllDriverMarkers is true
            if (isDriverViewingSelfToday && !showAllDriverMarkers) {
              return; // Don't include any shared locations unless checkbox is checked
            }

            // Must be on_duty and have tracking enabled
            if (location.driver_status !== 'on_duty') return;
            if (location.location_tracking_enabled !== true) return;

            // Dispatcher filtering
            if (isDispatcher && !isAdmin) {
              const dispatcherStoreIds = new Set(currentUser?.store_ids || []);
              const hasDeliveryInDispatcherStore = deliveriesWithStopOrder.some((delivery) =>
              delivery &&
              delivery.driver_id === location.driver_id &&
              dispatcherStoreIds.has(delivery.store_id)
              );
              if (!hasDeliveryInDispatcherStore) return;
            }

            allCoordinates.push([location.latitude, location.longitude]);
            hasDriverMarkers = true;
          });
        }

        // 3. HOME LOCATIONS: Only when viewing own route as driver
        const isDispatcherNonAdmin = isDispatcher && !isAdmin;
        if (isViewingToday && !isDispatcherNonAdmin && isDriverViewingSelfToday) {
          // Only include current driver's home when viewing their own route
          if (currentUser?.home_latitude && currentUser?.home_longitude) {
            const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
            const hasActiveStops = deliveriesWithStopOrder.some((d) =>
            d && !finishedStatuses.includes(d.status) && d.driver_id === currentUser.id
            );

            if (hasActiveStops) {
              allCoordinates.push([currentUser.home_latitude, currentUser.home_longitude]);
            }
          }
        }

        // 4. Add all VISIBLE delivery/pickup markers for current driver
        if (deliveriesWithStopOrder && Array.isArray(deliveriesWithStopOrder)) {
          deliveriesWithStopOrder.forEach((delivery) => {
            if (!delivery) return;

            if (delivery.patient_id) {
              const patient = patients.find((p) => p && p.id === delivery.patient_id);
              if (patient?.latitude && patient?.longitude) {
                allCoordinates.push([patient.latitude, patient.longitude]);
                hasStopMarkers = true;
              }
            } else if (delivery.store_id) {
              const store = stores.find((s) => s && s.id === delivery.store_id);
              if (store?.latitude && store?.longitude) {
                allCoordinates.push([store.latitude, store.longitude]);
                hasStopMarkers = true;
              }
            }
          });
        }

        // 5. CRITICAL: Include other drivers' markers AND home markers ONLY if checkbox is checked
        const isDriverViewingSelfAnyDate = isDriver && selectedDriverId === currentUser?.id && selectedDriverId !== 'all';
        
        if (isDriverViewingSelfAnyDate && showAllDriverMarkers) {
          // 5a. Add other drivers' delivery/pickup markers
          if (deliveries && Array.isArray(deliveries)) {
            deliveries.forEach((delivery) => {
              if (!delivery) return;

              // CRITICAL: Only include deliveries for the selected date
              if (delivery.delivery_date !== selectedDateStr) {
                return;
              }

              // Skip own deliveries (already included in deliveriesWithStopOrder)
              if (delivery.driver_id === currentUser?.id) {
                return;
              }

              // CRITICAL: Skip if no driver assigned
              if (!delivery.driver_id) return;

              if (delivery.patient_id) {
                const patient = patients.find((p) => p && p.id === delivery.patient_id);
                if (patient?.latitude && patient?.longitude) {
                  allCoordinates.push([patient.latitude, patient.longitude]);
                  hasStopMarkers = true;
                }
              } else if (delivery.store_id) {
                const store = stores.find((s) => s && s.id === delivery.store_id);
                if (store?.latitude && store?.longitude) {
                  allCoordinates.push([store.latitude, store.longitude]);
                  hasStopMarkers = true;
                }
              }
            });
          }

          // 5b. Add other drivers' home markers if they have active stops
          if (isViewingToday && users && Array.isArray(users)) {
            const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
            const otherDriversWithStops = new Set();
            
            // Find all drivers with active stops on this date (excluding current user)
            deliveries.forEach((d) => {
              if (!d || d.delivery_date !== selectedDateStr) return;
              if (d.driver_id === currentUser?.id) return;
              if (!finishedStatuses.includes(d.status)) {
                otherDriversWithStops.add(d.driver_id);
              }
            });

            // Add home locations for those drivers
            otherDriversWithStops.forEach((driverId) => {
              const driver = users.find((u) => u && u.id === driverId);
              if (driver?.home_latitude && driver?.home_longitude) {
                allCoordinates.push([driver.home_latitude, driver.home_longitude]);
              }
            });
          }
        }

        // Get current city center
        const selectedCityId = globalFilters.getSelectedCityId();
        const currentCity = cities?.find((c) => c && c.id === selectedCityId);

        // CASE 1: No stop markers and no driver markers → center on closest assigned city
        if (!hasStopMarkers && !hasDriverMarkers) {

          // Get user's reference location (current GPS > last known > home base)
          let userRefLat = null;
          let userRefLon = null;
          let locationSource = null;

          if (driverLocation?.latitude && driverLocation?.longitude) {
            userRefLat = driverLocation.latitude;
            userRefLon = driverLocation.longitude;
            locationSource = 'current_gps';
          } else if (currentUser?.current_latitude && currentUser?.current_longitude) {
            userRefLat = currentUser.current_latitude;
            userRefLon = currentUser.current_longitude;
            locationSource = 'last_known';
          } else if (currentUser?.home_latitude && currentUser?.home_longitude) {
            userRefLat = currentUser.home_latitude;
            userRefLon = currentUser.home_longitude;
            locationSource = 'home_base';
          }

          // Get user's assigned city IDs
          const userCityIds = currentUser?.city_ids || (currentUser?.city_id ? [currentUser.city_id] : []);
          const assignedCities = cities?.filter((c) => c && userCityIds.includes(c.id)) || [];

          let closestCity = null;

          if (userRefLat && userRefLon && assignedCities.length > 0) {
            // Find the closest assigned city to user's reference location
            const citiesWithDistance = assignedCities.
            filter((c) => c?.latitude && c?.longitude).
            map((city) => ({
              city,
              distance: calculateDistance(userRefLat, userRefLon, city.latitude, city.longitude)
            })).
            sort((a, b) => a.distance - b.distance);

            if (citiesWithDistance.length > 0) {
              closestCity = citiesWithDistance[0].city;
            }
          } else if (assignedCities.length > 0) {
            closestCity = assignedCities[0];
          } else if (currentCity?.latitude && currentCity?.longitude) {
            closestCity = currentCity;
          }

          // Center on the closest city
          if (closestCity?.latitude && closestCity?.longitude) {
            const targetRadiusKm = 16;
            const latDegPerKm = 1 / 111.32;
            const lonDegPerKm = 1 / (111.32 * Math.cos(closestCity.latitude * Math.PI / 180));

            const latOffset = targetRadiusKm * latDegPerKm;
            const lonOffset = targetRadiusKm * lonDegPerKm;

            const bounds = [
            [closestCity.latitude - latOffset, closestCity.longitude - lonOffset],
            [closestCity.latitude + latOffset, closestCity.longitude + lonOffset]];

            const padding = getMapPadding(false);
            setShouldFitBounds({
              bounds,
              options: {
                ...padding,
                maxZoom: 12,
                animate: true
              }
            });
            setMapCenter(null);
            setMapZoom(null);
          }
        }
        // CASE 2: Drivers but no stop markers → center on drivers + city center
        else if (!hasStopMarkers && hasDriverMarkers && currentCity?.latitude && currentCity?.longitude) {
          allCoordinates.push([currentCity.latitude, currentCity.longitude]);
          const padding = getMapPadding(false);
          setShouldFitBounds({
            bounds: allCoordinates,
            options: {
              ...padding,
              maxZoom: 14,
              animate: true
            }
          });
          setMapCenter(null);
          setMapZoom(null);
        }
        // CASE 3: Normal case with stop markers
        else if (allCoordinates.length > 0) {

          // Calculate span to determine appropriate maxZoom
          // Prevent over-zooming when stops are close together
          // Prevent under-zooming when stops are far apart
          let minLat = Infinity,maxLat = -Infinity,minLon = Infinity,maxLon = -Infinity;
          allCoordinates.forEach(([lat, lon]) => {
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
            minLon = Math.min(minLon, lon);
            maxLon = Math.max(maxLon, lon);
          });

          const latSpan = maxLat - minLat;
          const lonSpan = maxLon - minLon;
          const maxSpan = Math.max(latSpan, lonSpan);

          // Dynamic zoom calculation based on geographic spread and screen size
          // Convert degrees to km (1 degree ≈ 111km) and use logarithmic scale
          // Mobile needs tighter zoom (higher numbers), desktop can zoom out more (lower numbers)
          const spanKm = maxSpan * 111.0;
          const baseZoom = 16 - Math.log2(spanKm + 1) * 1.5;
          const screenAdjustment = isMobile ? 0.5 : -0.5; // Mobile +0.5 zoom, Desktop -0.5 zoom
          const phase1MaxZoom = Math.max(8.0, Math.min(15, Math.round((baseZoom + screenAdjustment) * 10) / 10)).toFixed(1);
          console.info('phase1MaxZoom: ', phase1MaxZoom);

          const padding = getMapPadding(false);

          setShouldFitBounds({
            bounds: allCoordinates,
            options: {
              ...padding,
              maxZoom: phase1MaxZoom,
              animate: true
            }
          });
          setMapCenter(null);
          setMapZoom(null);
        }
        break;

      case 2: // "Center on Driver & Next Stop"
        console.clear;
        // Mark that we're doing a programmatic map move (debounces interaction handler)
        lastProgrammaticMapMoveRef.current = Date.now();
        window._lastProgrammaticMapMove = Date.now();

        if (nextStopCoordinates) {
          const bounds = [
          [driverLocation.latitude, driverLocation.longitude],
          [nextStopCoordinates.lat, nextStopCoordinates.lon]];


          // CRITICAL: Only include viewed user's home location if home IS the next stop
          // (i.e., the next stop coordinates match the viewed user's home coordinates)
          // For impersonation, use selectedDriverId to get the viewed user's home
          const viewedUserPhase2 = selectedDriverId && selectedDriverId !== 'all' ?
          users.find((u) => u && u.id === selectedDriverId) :
          currentUser;

          if (viewedUserPhase2?.home_latitude && viewedUserPhase2?.home_longitude) {
            const isHomeNextStop =
            Math.abs(nextStopCoordinates.lat - viewedUserPhase2.home_latitude) < 0.0001 &&
            Math.abs(nextStopCoordinates.lon - viewedUserPhase2.home_longitude) < 0.0001;
          }

          const padding = getMapPadding(false);
          setShouldFitBounds({
            bounds,
            options: {
              ...padding,
              maxZoom: 17.5,
              animate: true
            }
          });
          setMapCenter(null);
          setMapZoom(null);
        } else {
          // If no next stop, just center on driver with padding
          const padding = getMapPadding(false);
          setShouldFitBounds({
            bounds: [[driverLocation.latitude, driverLocation.longitude]],
            options: {
              ...padding,
              maxZoom: 15,
              animate: true
            }
          });
          setMapCenter(null);
          setMapZoom(null);
        }
        break;

      case 3: // "Center on Driver"
        console.clear;

        if (!driverLocation?.latitude || !driverLocation?.longitude) {
          console.warn('⚠️ [FAB Click] Phase 3 - No driver location available');
          return;
        }

        // Use fitBounds with driver location to apply bottom padding
        const padding = getMapPadding(false);
        setShouldFitBounds({
          bounds: [[driverLocation.latitude, driverLocation.longitude]],
          options: {
            ...padding,
            maxZoom: 15,
            animate: true
          }
        });
        setMapCenter(null);
        setMapZoom(null);
        break;

      default:
        break;
    }
  }, [mapViewPhase, driverLocation, nextStopCoordinates, deliveriesWithStopOrder, patients, stores, isDriver, mapViewTrigger, isDispatcher, currentUser, getMapPadding]);

  // RENDER SEQUENCE EFFECT 1: Track StatsCard & StopCards ready
  useEffect(() => {
    if (!isDataLoaded || !userSettingsLoaded) return;

    const hasDeliveries = deliveriesWithStopOrder.length > 0;
    const statsCardMeasured = statsCardRef.current?.offsetHeight > 0;
    const stopCardsMeasured = hasDeliveries ? stopCardsBaseHeight > 0 : true;

    if (statsCardMeasured && stopCardsMeasured && !renderSequence.statsAndCards) {
      console.log('✅ [Render Sequence 1] StatsCard & StopCards ready');
      setRenderSequence((prev) => ({ ...prev, statsAndCards: true }));
    }
  }, [isDataLoaded, userSettingsLoaded, deliveriesWithStopOrder.length, stopCardsBaseHeight, renderSequence.statsAndCards]);

  // RENDER SEQUENCE EFFECT 2: Track FABs ready (after stats/cards)
  useEffect(() => {
    if (!renderSequence.statsAndCards) return;
    if (renderSequence.fabs) return;

    // FABs render immediately after stats/cards - just mark as ready
    console.log('✅ [Render Sequence 2] FABs ready');
    setRenderSequence((prev) => ({ ...prev, fabs: true }));
  }, [renderSequence.statsAndCards, renderSequence.fabs]);

  // RENDER SEQUENCE EFFECT 3: Track Map Markers ready (including home locations)
  useEffect(() => {
    if (!renderSequence.fabs) return;
    if (renderSequence.mapMarkers) return;

    // Map markers are ready once we have deliveries data and stores/patients loaded
    const hasRequiredData = deliveriesWithStopOrder.length > 0 || stores.length > 0;

    if (hasRequiredData) {
      console.log('✅ [Render Sequence 3] Map Markers ready');
      setRenderSequence((prev) => ({ ...prev, mapMarkers: true }));
    }
  }, [renderSequence.fabs, renderSequence.mapMarkers, deliveriesWithStopOrder.length, stores.length]);

  // RENDER SEQUENCE EFFECT 4: Track Route Lines ready
  useEffect(() => {
    if (!renderSequence.mapMarkers) return;
    if (renderSequence.routeLines) return;

    // Route lines are ready - they render after markers
    console.log('✅ [Render Sequence 4] Route Lines ready');
    setRenderSequence((prev) => ({ ...prev, routeLines: true }));
  }, [renderSequence.mapMarkers, renderSequence.routeLines]);

  // RENDER SEQUENCE EFFECT 5: Track Driver Live Location ready
  useEffect(() => {
    if (!renderSequence.routeLines) return;
    if (renderSequence.driverLiveLocation) return;

    // Driver live location is ready when we have location OR user is not a driver
    const hasLocation = driverLocation?.latitude && driverLocation?.longitude;
    const notDriverOrHasLocation = !isDriver || hasLocation;

    if (notDriverOrHasLocation) {
      console.log('✅ [Render Sequence 5] Driver Live Location ready');
      setRenderSequence((prev) => ({ ...prev, driverLiveLocation: true }));
    }
  }, [renderSequence.routeLines, renderSequence.driverLiveLocation, driverLocation, isDriver]);

  // RENDER SEQUENCE EFFECT 6: Track Shared Driver Locations ready
  useEffect(() => {
    if (!renderSequence.driverLiveLocation) return;
    if (renderSequence.sharedLocations) return;

    // Shared locations are loaded via driverLocationPoller - consider ready after poller starts
    // or if allDriverLocations has been populated
    const hasSharedLocations = allDriverLocations.length > 0 || !isDataLoaded;

    // Always mark as ready after a short delay to not block forever
    const timer = setTimeout(() => {
      console.log('✅ [Render Sequence 6] Shared Driver Locations ready');
      setRenderSequence((prev) => ({ ...prev, sharedLocations: true }));
    }, allDriverLocations.length > 0 ? 0 : 500);

    return () => clearTimeout(timer);
  }, [renderSequence.driverLiveLocation, renderSequence.sharedLocations, allDriverLocations.length, isDataLoaded]);

  // RENDER SEQUENCE EFFECT 7: Activate FAB Phase (FINAL STEP)
  // Apply initial map view on first load - WAIT for full render sequence
  useEffect(() => {
    // CRITICAL: Wait for full render sequence before activating FAB phase
    if (!renderSequence.sharedLocations || renderSequence.fabPhaseReady) {
      return;
    }

    if (initialMapViewApplied) {
      setRenderSequence((prev) => ({ ...prev, fabPhaseReady: true }));
      return;
    }

    console.log('✅ [Render Sequence 7] All elements rendered - activating FAB phase');

    // CRITICAL: Notify fabControlEvents that initial data is ready
    // This allows other components to know when dashboard is fully loaded
    fabControlEvents.notifyDataReady();

    // CASE 1: No deliveries - set phase 1 locked, will unlock on pan/zoom
    if (deliveriesWithStopOrder.length === 0) {
      setMapViewPhase(1);
      setIsMapViewLocked(true);
      setInitialMapViewApplied(true);
      setRenderSequence((prev) => ({ ...prev, fabPhaseReady: true }));

      if (mapLockTimeoutRef.current) {
        clearTimeout(mapLockTimeoutRef.current);
        mapLockTimeoutRef.current = null;
      }
      mapLockExpiresAtRef.current = null;

      setMapViewTrigger((prev) => prev + 1);
      console.log('🔵 [FAB Initial] No deliveries - Phase 1 locked, will unlock on pan/zoom');
      return;
    }

    // CASE 2: Has deliveries - apply saved phase
    const phaseToApply = savedFabPhaseRef.current;

    // For phase 2, require nextStop coordinates
    if (phaseToApply === 2 && !nextStopCoordinates) {
      console.log('⚠️ [FAB Initial] Phase 2 requested but no next stop - using Phase 1');
      setMapViewPhase(1);
      setIsMapViewLocked(true);
      setMapViewTrigger((prev) => prev + 1);
      setInitialMapViewApplied(true);
      setRenderSequence((prev) => ({ ...prev, fabPhaseReady: true }));

      const lockDuration = 3000;
      const expiresAt = Date.now() + lockDuration;
      mapLockExpiresAtRef.current = expiresAt;
      mapLockTimeoutRef.current = setTimeout(() => {
        if (mapLockExpiresAtRef.current === expiresAt) {
          setIsMapViewLocked(false);
          mapLockExpiresAtRef.current = null;
          mapLockTimeoutRef.current = null;
          console.log(`⏰ [FAB Initial] Phase 1 auto-unlocked after 3 seconds`);
        }
      }, lockDuration);
      return;
    }

    // For phase 3, require driver location
    if (phaseToApply === 3 && (!isDriver || !driverLocation)) {
      console.log('⚠️ [FAB Initial] Phase 3 requested but no driver location - using Phase 1');
      setMapViewPhase(1);
      setIsMapViewLocked(true);
      setMapViewTrigger((prev) => prev + 1);
      setInitialMapViewApplied(true);
      setRenderSequence((prev) => ({ ...prev, fabPhaseReady: true }));

      const lockDuration = 3000;
      const expiresAt = Date.now() + lockDuration;
      mapLockExpiresAtRef.current = expiresAt;
      mapLockTimeoutRef.current = setTimeout(() => {
        if (mapLockExpiresAtRef.current === expiresAt) {
          setIsMapViewLocked(false);
          mapLockExpiresAtRef.current = null;
          mapLockTimeoutRef.current = null;
          console.log(`⏰ [FAB Initial] Phase 1 auto-unlocked after 3 seconds`);
        }
      }, lockDuration);
      return;
    }

    // Apply the saved phase
    console.log(`🔵 [FAB Initial] Applying saved phase ${phaseToApply}`);
    setMapViewPhase(phaseToApply);
    setIsMapViewLocked(true);
    setInitialMapViewApplied(true);
    setRenderSequence((prev) => ({ ...prev, fabPhaseReady: true }));

    // Clear existing timers
    if (mapLockTimeoutRef.current) {
      clearTimeout(mapLockTimeoutRef.current);
      mapLockTimeoutRef.current = null;
    }
    mapLockExpiresAtRef.current = null;

    // Trigger map view
    setMapViewTrigger((prev) => prev + 1);

    // Set timer for phase 1 & 3, permanent lock for phase 2
    if (phaseToApply === 1 || phaseToApply === 3) {
      const lockDuration = 3000;
      const expiresAt = Date.now() + lockDuration;
      mapLockExpiresAtRef.current = expiresAt;

      mapLockTimeoutRef.current = setTimeout(() => {
        if (mapLockExpiresAtRef.current === expiresAt) {
          setIsMapViewLocked(false);
          mapLockExpiresAtRef.current = null;
          mapLockTimeoutRef.current = null;
          console.log(`⏰ [FAB Initial] Phase ${phaseToApply} auto-unlocked after 3 seconds`);
        }
      }, lockDuration);

      console.log(`🔵 [FAB Initial] Phase ${phaseToApply} locked - will auto-unlock in 3 seconds`);
    } else if (phaseToApply === 2) {
      // Phase 2 - NO timer, stays locked PERMANENTLY
      // CRITICAL: Clear any timers to prevent accidental unlock
      if (mapLockTimeoutRef.current) {
        clearTimeout(mapLockTimeoutRef.current);
        mapLockTimeoutRef.current = null;
      }
      mapLockExpiresAtRef.current = null;
      console.log(`🔵 [FAB Initial] Phase 2 locked PERMANENTLY - unlocks only on FAB click`);
    }

    // Scroll to card with isNextDelivery=true for all phases (helps user orient)
    setTimeout(() => {
      const nextDelivery = deliveriesWithStopOrder.find((d) => d && d.isNextDelivery === true);

      if (nextDelivery) {
        const cardElement = document.getElementById(`stop-card-${nextDelivery.id}`);
        if (cardElement) {
          cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          console.log(`📍 [FAB Initial] Scrolled to next delivery card for Phase ${phaseToApply}`);
        }
      }
    }, 500);
  }, [renderSequence.sharedLocations, renderSequence.fabPhaseReady, initialMapViewApplied, deliveriesWithStopOrder.length, isDriver, driverLocation, deliveriesWithStopOrder, nextStopCoordinates]);

  // CRITICAL: Dedicated effect to scroll to next delivery card on initial load
  // This runs AFTER cards are rendered and handles ALL phases
  // CHANGED: Only center (scroll), do NOT select the card
  useEffect(() => {
    // Skip if already scrolled or data not ready
    if (hasScrolledToNextCardRef.current || !isDataLoaded || deliveriesWithStopOrder.length === 0) {
      return;
    }

    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const incompleteDeliveries = deliveriesWithStopOrder.
    filter((d) => d && !finishedStatuses.includes(d.status)).
    sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

    if (incompleteDeliveries.length === 0) {
      hasScrolledToNextCardRef.current = true;
      return;
    }

    const nextDelivery = incompleteDeliveries[0];

    // Wait for cards to render, then scroll
    const scrollTimer = setTimeout(() => {
      const cardElement = document.getElementById(`stop-card-${nextDelivery.id}`);
      if (cardElement) {
        cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      } else {
        console.warn(`⚠️ [Card Scroll Effect] Card not found: stop-card-${nextDelivery.id}`);
        // Try again after more delay
        setTimeout(() => {
          const retryElement = document.getElementById(`stop-card-${nextDelivery.id}`);
          if (retryElement) {
            retryElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          }
        }, 500);
      }
      hasScrolledToNextCardRef.current = true;
    }, 500); // 500ms delay to ensure cards are rendered

    return () => clearTimeout(scrollTimer);
  }, [isDataLoaded, deliveriesWithStopOrder]);

  // CRITICAL: Use a ref to track current lock state to avoid stale closure issues in GPS callback
  const isMapViewLockedRef = useRef(isMapViewLocked);
  useEffect(() => {
    isMapViewLockedRef.current = isMapViewLocked;
  }, [isMapViewLocked]);

  useEffect(() => {
    if (!setOnSmartRefreshComplete) return;

    const handleSmartRefreshComplete = () => {
      // CRITICAL: Smart refresh should NEVER reposition the map
      // Map only repositions when FAB is clicked (mapViewTrigger changes)
      // This prevents the map from re-centering during background refreshes
      console.log('🔄 [Smart Refresh] Complete - skipping map reposition');
    };

    setOnSmartRefreshComplete(handleSmartRefreshComplete);

    return () => {
      setOnSmartRefreshComplete(null);
    };
  }, [setOnSmartRefreshComplete]);

  // Auto-center on next stop on initial load
  const hasAutoSelectedRef = useRef(false);

  const hasScrolledToNextCardRef = useRef(false);

  // Set up rate limit error handler
  useEffect(() => {
    window._setRateLimitError = (hasError) => {
      setHasRateLimitError(hasError);
      if (hasError) {
        // Auto-clear after 10 seconds
        setTimeout(() => {
          setHasRateLimitError(false);
        }, 10000);
      }
    };

    return () => {
      delete window._setRateLimitError;
    };
  }, []);

  // Periodic ETA optimizer - runs every 15 minutes for current driver, only if moved 500m+
  const lastETAUpdateLocationRef = useRef(null);

  // Periodic ETA optimizer - ONLY for mobile drivers viewing their own route
  useEffect(() => {
    // CRITICAL: Only run for mobile devices with driver role viewing their own route
    if (!isMobile || !userHasRole(currentUser, 'driver') || !currentUser) {
      return;
    }
    
    if (!isDataLoaded || selectedDriverId !== currentUser.id || selectedDriverId === 'all') {
      return;
    }

    const runETAOptimizer = async () => {
      try {
        const dateStr = format(selectedDate, 'yyyy-MM-dd');

        // CRITICAL: Don't run optimizer if no deliveries loaded yet
        if (!filteredDeliveries || filteredDeliveries.length === 0) {
          return;
        }

        // Check if route is complete - stop running optimizer if no incomplete stops
        const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
        const hasIncompleteStops = filteredDeliveries.some((d) =>
        d && !finishedStatuses.includes(d.status)
        );

        if (!hasIncompleteStops) {
          return;
        }

        // CRITICAL: Only update if driver has moved 500m+ since last ETA update
        if (driverLocation?.latitude && driverLocation?.longitude) {
          if (lastETAUpdateLocationRef.current) {
            const distanceMoved = calculateDistance(
              lastETAUpdateLocationRef.current.lat,
              lastETAUpdateLocationRef.current.lon,
              driverLocation.latitude,
              driverLocation.longitude
            ) * 1000; // Convert km to meters

            if (distanceMoved < 500) {
              console.log(`⏭️ [ETA - Periodic] Skipping update - driver moved only ${Math.round(distanceMoved)}m (< 500m)`);
              return;
            }
            console.log(`✅ [ETA - Periodic] Driver moved ${Math.round(distanceMoved)}m - updating ETAs`);
          }

          // Store current location for next comparison
          lastETAUpdateLocationRef.current = {
            lat: driverLocation.latitude,
            lon: driverLocation.longitude
          };
        }

        // Get current local time in HH:mm format
        const now = new Date();
        const localTimeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        console.log('📡 [ETA - Periodic] Calling calculateRealTimeETA for mobile driver...');
        const response = await base44.functions.invoke('calculateRealTimeETA', {
          driverId: currentUser.id,
          deliveryDate: dateStr,
          currentLocalTime: localTimeString // Backend calculates and saves ETAs directly
        });
        console.log('✅ [ETA - Periodic] calculateRealTimeETA completed');
        // Backend now handles all ETA calculations and database updates - no need to recalculate here

      } catch (error) {
        console.warn('⚠️ [ETA - Periodic] Periodic ETA optimizer failed:', error);
      }
    };

    // Run after initial delay (2 minutes) to avoid competing with data load
    const initialTimer = setTimeout(runETAOptimizer, 120000);

    // Then run every 15 minutes
    const interval = setInterval(runETAOptimizer, 900000);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [isMobile, isDriver, isDataLoaded, currentUser, selectedDriverId, selectedDate, filteredDeliveries, driverLocation]);

  useEffect(() => {
    // CRITICAL: Skip auto-center if initial FAB phase has been applied
    if (initialMapViewApplied) {
      return;
    }

    // Auto-center on next stop when data is ready
    // CHANGED: Only scroll to center card, do NOT select it
    if (!hasAutoSelectedRef.current && isDataLoaded && deliveriesWithStopOrder.length > 0 && !isLoadingUser) {
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

      // Find first incomplete delivery
      const incompleteDeliveries = deliveriesWithStopOrder.
      filter((d) => d && !finishedStatuses.includes(d.status)).
      sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

      if (incompleteDeliveries.length === 0) {
        return;
      }

      const nextDelivery = incompleteDeliveries[0];
      // CHANGED: Do NOT set selectedCardId - only scroll to center
      // setSelectedCardId(nextDelivery.id); // REMOVED

      // Scroll card into view after a longer delay to ensure cards are rendered
      setTimeout(() => {
        const cardElement = document.getElementById(`stop-card-${nextDelivery.id}`);
        if (cardElement) {
          cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
      }, 300);

      // Center map on this delivery using fitBounds for bottom padding
      const padding = getMapPadding(false);
      if (nextDelivery.patient_id) {
        const patient = patients.find((p) => p && p.id === nextDelivery.patient_id);
        if (patient?.latitude && patient?.longitude) {
          setShouldFitBounds({
            bounds: [[patient.latitude, patient.longitude]],
            options: {
              ...padding,
              maxZoom: 15,
              animate: true
            }
          });
          setMapCenter(null);
          setMapZoom(null);
        }
      } else if (nextDelivery.store_id) {
        const store = stores.find((s) => s && s.id === nextDelivery.store_id);
        if (store?.latitude && store?.longitude) {
          setShouldFitBounds({
            bounds: [[store.latitude, store.longitude]],
            options: {
              ...padding,
              maxZoom: 15,
              animate: true
            }
          });
          setMapCenter(null);
          setMapZoom(null);
        }
      }

      hasAutoSelectedRef.current = true;
    }
  }, [isDataLoaded, deliveriesWithStopOrder, isLoadingUser, patients, stores, initialMapViewApplied, getMapPadding]);

  // PHASE 4: Apply driver selection AFTER data is loaded
  // Only for pure drivers who MUST see their own route (override settings)
  useEffect(() => {
    if (!currentUser || !isDataLoaded || !driversList.length || !userSettingsLoaded) {
      return;
    }

    // Skip if already initialized from settings
    if (hasSetInitialDriverDashboard.current) {
      return;
    }

    const isPureDriver = userHasRole(currentUser, 'driver') &&
    !userHasRole(currentUser, 'admin') &&
    !userHasRole(currentUser, 'dispatcher');

    if (isPureDriver) {
      const isInDriversList = driversList.some((d) => d && d.id === currentUser.id);

      if (isInDriversList) {
        setSelectedDriverId(currentUser.id);
        globalFilters.setSelectedDriverId(currentUser.id);
      } else {
        setSelectedDriverId('all');
        globalFilters.setSelectedDriverId('all');
      }
    }

    hasSetInitialDriverDashboard.current = true;
  }, [currentUser, isDataLoaded, driversList, userSettingsLoaded]);

  useEffect(() => {
    const savedDriverId = globalFilters.getSelectedDriverId();

    if (savedDriverId && savedDriverId !== selectedDriverId) {
      setSelectedDriverId(savedDriverId);
    }
  }, [selectedDriverId]); // Add selectedDriverId as dependency

  const handleDateChange = async (date) => {
    // CRITICAL: Pause smart refresh immediately
    setIsEntityUpdating(true);

    // Reset route summary tracking when date changes
    hasShownSummaryRef.current.clear();

    setSelectedDate(date);
    globalFilters.setSelectedDate(date);
    setIsCalendarOpen(false);

    const dateStr = format(date, 'yyyy-MM-dd');

    // Save to user settings (async, don't wait)
    if (currentUser?.id) {
      saveSetting(currentUser.id, 'selected_date', dateStr);
    }

    try {
      // STEP 1: Clear pending updates for clean slate
      smartRefreshManager.clearPendingUpdates();

      // STEP 2: Priority load - selected driver first for instant UI
      let priorityDeliveries;
      if (selectedDriverId && selectedDriverId !== 'all') {
        priorityDeliveries = await base44.entities.Delivery.filter({
          delivery_date: dateStr,
          driver_id: selectedDriverId
        });
      } else {
        priorityDeliveries = await base44.entities.Delivery.filter({
          delivery_date: dateStr
        });
      }

      // STEP 3: Update UI immediately with priority data using flushSync for instant render
      if (updateDeliveriesLocally) {
        const otherDateDeliveries = deliveries.filter((d) => d && d.delivery_date !== dateStr);
        const mergedDeliveries = [...otherDateDeliveries, ...priorityDeliveries];
        flushSync(() => {
          updateDeliveriesLocally(mergedDeliveries, true);
        });
      }

      // STEP 4: Dispatch event to force map and stop cards to re-render
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { 
        detail: { deliveryDate: dateStr, triggeredBy: 'dateChange' } 
      }));

      // STEP 5: Resume UI immediately (don't wait for background loads)
      setIsEntityUpdating(false);

      // STEP 5.5: Wait for UI to fully render before triggering map
      await new Promise(resolve => setTimeout(resolve, 300));

      // STEP 6: Auto-select driver based on role
      const today = startOfDay(new Date());
      const selected = startOfDay(date);
      const isPastDate = selected < today;

      let autoSelectedDriver = null;

      if (userHasRole(currentUser, 'admin')) {
        const driversWithStops = new Set(priorityDeliveries.map((d) => d.driver_id).filter(Boolean));
        const adminHasStops = priorityDeliveries.some((d) => d && d.driver_id === currentUser.id);

        if (driversWithStops.size === 1) {
          autoSelectedDriver = Array.from(driversWithStops)[0];
        } else if (driversWithStops.size > 1 && (isPastDate || !adminHasStops)) {
          autoSelectedDriver = 'all';
        } else {
          autoSelectedDriver = 'all';
        }
      } else if (userHasRole(currentUser, 'dispatcher')) {
        const dispatcherStoreIds = currentUser.store_ids || [];
        const storeDeliveries = priorityDeliveries.filter((d) => d && dispatcherStoreIds.includes(d.store_id));
        const driversWithStops = new Set(storeDeliveries.map((d) => d.driver_id).filter(Boolean));

        if (driversWithStops.size > 1) {
          autoSelectedDriver = 'all';
        } else if (driversWithStops.size === 1) {
          autoSelectedDriver = Array.from(driversWithStops)[0];
        } else {
          autoSelectedDriver = 'all';
        }
      } else if (userHasRole(currentUser, 'driver')) {
        autoSelectedDriver = currentUser.id;
      } else {
        autoSelectedDriver = 'all';
      }

      if (autoSelectedDriver && autoSelectedDriver !== selectedDriverId) {
        setSelectedDriverId(autoSelectedDriver);
        globalFilters.setSelectedDriverId(autoSelectedDriver);
        if (currentUser?.id) {
          saveSetting(currentUser.id, 'selected_driver_id', autoSelectedDriver);
        }
      }

      // STEP 7: Trigger map view (non-blocking, delayed for rendering)
      setTimeout(() => {
        setIsMapViewLocked(true);
        lastProgrammaticMapMoveRef.current = Date.now();
        window._lastProgrammaticMapMove = Date.now();
        setMapViewTrigger((prev) => prev + 1);

        // CRITICAL: Handle timer logic - ONLY Phase 1 & 3 get timers, Phase 2 stays locked
        if (mapViewPhase === 2) {
          // Phase 2 - NO timer at all, stays locked PERMANENTLY
          if (mapLockTimeoutRef.current) {
            clearTimeout(mapLockTimeoutRef.current);
            mapLockTimeoutRef.current = null;
          }
          mapLockExpiresAtRef.current = null;
          console.log('🔵 [Date Change] Phase 2 - NO TIMER - stays locked until FAB click');
        } else if (mapViewPhase === 1 || mapViewPhase === 3) {
          // Phase 1 & 3 - Set 3-second unlock timer
          const lockDuration = 3000;
          const expiresAt = Date.now() + lockDuration;
          mapLockExpiresAtRef.current = expiresAt;

          mapLockTimeoutRef.current = setTimeout(() => {
            if (mapLockExpiresAtRef.current === expiresAt) {
              setIsMapViewLocked(false);
              mapLockExpiresAtRef.current = null;
              mapLockTimeoutRef.current = null;
            }
          }, lockDuration);
        }

        // CRITICAL: Notify that date change data is ready
        fabControlEvents.notifyDataReady();
      }, 500); // Increased delay to ensure rendering is complete

      // STEP 8: Background loads (non-blocking)
      Promise.all([
      // Load other dates in background if needed
      selectedDriverId !== 'all' ? base44.entities.Delivery.filter({ delivery_date: dateStr }) : Promise.resolve(null)]
      ).then(([allDateDeliveries]) => {
        if (allDateDeliveries && updateDeliveriesLocally) {
          const otherDateDeliveries = deliveries.filter((d) => d && d.delivery_date !== dateStr);
          updateDeliveriesLocally([...otherDateDeliveries, ...allDateDeliveries]);
        }
      }).catch((err) => console.warn('Background loads failed:', err));

    } catch (error) {
      console.error('❌ [Dashboard] Date change failed:', error);
    }
  };

  const handleDriverChange = async (driverId) => {
    // Reset route summary tracking when driver changes
    hasShownSummaryRef.current.clear();

    // CRITICAL: Update state immediately for instant UI response
    flushSync(() => {
      setSelectedDriverId(driverId);
    });
    globalFilters.setSelectedDriverId(driverId);
    setIsExpanded(false);

    // Save to user settings
    if (currentUser?.id) {
      saveSetting(currentUser.id, 'selected_driver_id', driverId);
    }

    // CRITICAL: Instant refresh when driver changes
    setIsEntityUpdating(true);

    try {
      const dateStr = format(selectedDate, 'yyyy-MM-dd');

      let freshDeliveries;
      if (driverId && driverId !== 'all') {
        freshDeliveries = await base44.entities.Delivery.filter({
          driver_id: driverId,
          delivery_date: dateStr
        });
        smartRefreshManager.clearPendingUpdatesForDriver(driverId, dateStr);
      } else {
        // For "all drivers", fetch all deliveries for the date
        freshDeliveries = await base44.entities.Delivery.filter({
          delivery_date: dateStr
        });
        smartRefreshManager.clearPendingUpdates();
      }

      // Update context with fresh deliveries using flushSync for instant render
      if (updateDeliveriesLocally) {
        const otherDeliveries = deliveries.filter((d) =>
        d && d.delivery_date !== dateStr
        );
        const mergedDeliveries = [...otherDeliveries, ...freshDeliveries];
        flushSync(() => {
          updateDeliveriesLocally(mergedDeliveries, true);
        });
      }

      // Dispatch event to force map and stop cards to re-render
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { 
        detail: { driverId, deliveryDate: dateStr, triggeredBy: 'driverChange' } 
      }));

      // CRITICAL: Lock FAB and trigger map view after data loads and UI renders
      setTimeout(() => {

        // Clear existing timers
        if (mapLockTimeoutRef.current) {
          clearTimeout(mapLockTimeoutRef.current);
          mapLockTimeoutRef.current = null;
        }
        mapLockExpiresAtRef.current = null;

        // Lock FAB and trigger map view
        setIsMapViewLocked(true);
        setMapViewTrigger((prev) => prev + 1);

        // CRITICAL: Handle timer logic - ONLY Phase 1 & 3 get timers, Phase 2 stays locked
        if (mapViewPhase === 2) {
          // Phase 2 - NO timer at all, stays locked PERMANENTLY
          if (mapLockTimeoutRef.current) {
            clearTimeout(mapLockTimeoutRef.current);
            mapLockTimeoutRef.current = null;
          }
          mapLockExpiresAtRef.current = null;
          console.log('🔵 [Driver Change] Phase 2 - NO TIMER - stays locked until FAB click');
        } else if (mapViewPhase === 1 || mapViewPhase === 3) {
          // Phase 1 & 3 - Set 3-second unlock timer
          const lockDuration = 3000;
          const expiresAt = Date.now() + lockDuration;
          mapLockExpiresAtRef.current = expiresAt;

          mapLockTimeoutRef.current = setTimeout(() => {
            if (mapLockExpiresAtRef.current === expiresAt) {
              setIsMapViewLocked(false);
              mapLockExpiresAtRef.current = null;
              mapLockTimeoutRef.current = null;
            }
          }, lockDuration);
        }

        // CRITICAL: Notify that driver change data is ready
        fabControlEvents.notifyDataReady();
      }, 500); // Increased delay to ensure rendering is complete
    } catch (error) {
      console.error('❌ [Dashboard] Instant refresh failed:', error);
    } finally {
      setIsEntityUpdating(false);
    }
  };

  const handleAIToggle = () => {
    const newValue = !isAIEnabled;
    setIsAIEnabled(newValue);
    localStorage.setItem('rxdeliver_ai_enabled', String(newValue));

    if (!newValue) {
      setShowAIAssistant(false);
      setHasUnreadAIAlerts(false);
    }
  };

  const handleMarkerClick = (delivery) => {
    // Minimize any expanded stop card when tapping on a map marker
    setSelectedCardId(null);

    // CRITICAL: Clear timers and unlock FAB
    if (mapLockTimeoutRef.current) {
      clearTimeout(mapLockTimeoutRef.current);
      mapLockTimeoutRef.current = null;
    }
    mapLockExpiresAtRef.current = null;
    setIsMapViewLocked(false);

    // CRITICAL: Disable proximity snap for 5 minutes after marker click
    lastUserInteractionRef.current = Date.now();

    const cardElement = document.getElementById(`stop-card-${delivery.id}`);
    if (cardElement) {
      cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  };

  const handleCardClick = (delivery) => {
    if (!delivery || !delivery.id) {
      return;
    }

    // CRITICAL: Disable proximity snap for 5 minutes when card is clicked
    lastUserInteractionRef.current = Date.now();

    if (selectedCardId === delivery.id) {
      // Card is being collapsed - restore previous map state and reactivate FAB phase
      if (previousMapState) {
        setShouldFitBounds(previousMapState);
        setPreviousMapState(null);
      }
      setSelectedCardId(null);
      setHighlightedCardId(null);

      // CRITICAL: Reactivate FAB phase to recenter/zoom map, then unlock after 100ms
      setIsMapViewLocked(true);
      setMapViewTrigger((prev) => prev + 1);

      // Unlock after brief 100ms delay to allow map to recenter
      setTimeout(() => {
        setIsMapViewLocked(false);
      }, 100);

      // Scroll to card with isNextDelivery=true
      setTimeout(() => {
        const nextCard = deliveriesWithStopOrder.find((d) => d && d.isNextDelivery === true);

        if (nextCard) {
          const cardElement = document.getElementById(`stop-card-${nextCard.id}`);
          if (cardElement) {
            cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          }
        }
      }, 300);
    } else {
      // Card is being expanded - save current map state first

      // Save current shouldFitBounds state (if any) to restore later
      if (shouldFitBounds) {
        setPreviousMapState(shouldFitBounds);
      }

      setSelectedCardId(delivery.id);
      setHighlightedCardId(delivery.id);

      // CRITICAL: Clear timers and unlock FAB
      if (mapLockTimeoutRef.current) {
        clearTimeout(mapLockTimeoutRef.current);
        mapLockTimeoutRef.current = null;
      }
      mapLockExpiresAtRef.current = null;
      setIsMapViewLocked(false);

      // CRITICAL: Use expanded height for padding calculation
      const expandedPadding = getMapPadding(true);

      if (delivery.patient_id) {
        // Patient delivery - center on patient marker only (not store)
        const patient = patients.find((p) => p.id === delivery.patient_id);
        if (patient?.latitude && patient?.longitude) {
          setShouldFitBounds({
            bounds: [[patient.latitude, patient.longitude]],
            options: {
              ...expandedPadding,
              maxZoom: 16,
              animate: true
            }
          });
          setMapCenter(null);
          setMapZoom(null);
          setIsMapViewLocked(true);
        }
      } else if (delivery.store_id) {
        // Pickup - center on store marker only
        const store = stores.find((s) => s.id === delivery.store_id);
        if (store?.latitude && store?.longitude) {
          setShouldFitBounds({
            bounds: [[store.latitude, store.longitude]],
            options: {
              ...expandedPadding,
              maxZoom: 16,
              animate: true
            }
          });
          setMapCenter(null);
          setMapZoom(null);
          setIsMapViewLocked(true);
        }
      }
    }
  };

  const handleSaveDelivery = async (deliveryData) => {
    try {
      if (deliveryData._isBatchSave && deliveryData._stagedDeliveries) {
        const stagedDeliveries = deliveryData._stagedDeliveries;

        if (!stagedDeliveries || stagedDeliveries.length === 0) {
          console.warn('[AddToRoute] ⚠️ No staged deliveries found!');
          return;
        }

        const deliveriesByDriver = {};
        stagedDeliveries.forEach((delivery) => {
          if (!delivery) return;

          const driverId = delivery.driver_id && delivery.driver_id.trim() !== '' ? delivery.driver_id : 'unassigned';
          if (!deliveriesByDriver[driverId]) {
            deliveriesByDriver[driverId] = [];
          }
          deliveriesByDriver[driverId].push(delivery);
        });

        Object.entries(deliveriesByDriver).forEach(([dId, dels]) => {
          const dr = drivers.find((d) => d && d.id === dId);
        });

        for (const [driverId, driverDeliveries] of Object.entries(deliveriesByDriver)) {
          if (driverId === 'unassigned') {
            continue;
          }

          const driver = drivers.find((d) => d && d.id === driverId);
          if (!driver) {
            console.warn(`[AddToRoute] ⚠️ Driver not found: ${driverId}`);
            continue;
          }

          const isDriverAssignedToSlot = (store, slotPrefix) => {
            const enabledField = `${slotPrefix}_enabled`;
            if (!store[enabledField]) return false;

            const idField = `${slotPrefix}_driver_id`;
            const nameField = `${slotPrefix}_driver`;

            if (store[idField] && driver.id) return store[idField] === driver.id;
            if (store[nameField] && driver.user_name) {
              return store[nameField].toLowerCase().trim() === driver.user_name.toLowerCase().trim();
            }
            return false;
          };

          const deliveryDate = driverDeliveries[0].delivery_date;
          const allDeliveriesForDate = (deliveries || []).filter((delivery) => {
            if (!delivery) return false;
            return delivery.delivery_date === deliveryDate;
          });
          const driverDeliveriesForDate = allDeliveriesForDate.filter((delivery) => {
            if (!delivery) return false;
            return delivery.driver_id === driverId;
          });

          const stopsToProcess = [];

          for (const existingDelivery of driverDeliveriesForDate) {
            if (!existingDelivery) continue;

            const enriched = { ...existingDelivery, isNew: false };

            if (existingDelivery.patient_id) {
              const existingPatient = patients.find((p) => p.id === existingDelivery.patient_id);
              if (existingPatient?.latitude && existingPatient?.longitude) {
                enriched.latitude = existingPatient.latitude;
                enriched.longitude = existingPatient.longitude;
              }
            } else {
              const existingStore = stores.find((s) => s.id === existingDelivery.store_id);
              if (existingStore?.latitude && existingStore?.longitude) {
                enriched.latitude = existingStore.latitude;
                enriched.longitude = existingStore.longitude;
              }
            }

            stopsToProcess.push(enriched);
          }

          const dateObj = new Date(deliveryDate + 'T00:00:00');
          const dayOfWeek = dateObj.getDay();
          const isSaturday = dayOfWeek === 6;
          const isSunday = dayOfWeek === 0;

          const isFirstStop = driverDeliveriesForDate.length === 0;

          // CRITICAL: Always create pickups for ALL assigned stores when adding deliveries (batch mode)
          const assignedStores = (stores || []).filter((store) => {// Defensive check
            if (!store) return false;
            if (isSaturday) {
              return isDriverAssignedToSlot(store, 'saturday_am') || isDriverAssignedToSlot(store, 'saturday_pm');
            } else if (isSunday) {
              return isDriverAssignedToSlot(store, 'sunday_am') || isDriverAssignedToSlot(store, 'sunday_pm');
            } else {
              return isDriverAssignedToSlot(store, 'weekday_am') || isDriverAssignedToSlot(store, 'weekday_pm');
            }
          });

          const storesToCheck = assignedStores;

          for (const store of storesToCheck) {
            if (isSaturday ? isDriverAssignedToSlot(store, 'saturday_am') :
            isSunday ? isDriverAssignedToSlot(store, 'sunday_am') :
            isDriverAssignedToSlot(store, 'weekday_am')) {

              const existingAMPickup = stopsToProcess.find((delivery) => {
                if (!delivery) return false;
                return delivery.store_id === store.id && !delivery.patient_id && delivery.ampm_deliveries === 'AM';
              });

              if (!existingAMPickup) {
                const amPickupTime = isSaturday ? store.saturday_am_start || '09:00' :
                isSunday ? store.sunday_am_start || '09:00' :
                store.weekday_am_start || '09:00';
                const amPickupEndTime = isSaturday ? store.saturday_am_end || '12:00' :
                isSunday ? store.sunday_am_end || '12:00' :
                store.weekday_am_end || '12:00';

                stopsToProcess.push({
                  isNew: true,
                  patient_id: null,
                  store_id: store.id,
                  driver_id: driverId,
                  driver_name: driver.user_name || driver.full_name,
                  delivery_date: deliveryDate,
                  delivery_time_start: amPickupTime,
                  delivery_time_end: amPickupEndTime,
                  ampm_deliveries: 'AM',
                  status: 'en_route',
                  delivery_notes: `Store Pickup for ${store.name}`,
                  latitude: store.latitude,
                  longitude: store.longitude,
                  patient_name: '',
                  patient_phone: '',
                  store_phone: store.phone || '',
                  extra_time: 15
                });

              }
            }

            if (isSaturday ? isDriverAssignedToSlot(store, 'saturday_pm') :
            isSunday ? isDriverAssignedToSlot(store, 'sunday_pm') :
            isDriverAssignedToSlot(store, 'weekday_pm')) {

              const existingPMPickup = stopsToProcess.find((delivery) => {
                if (!delivery) return false;
                return delivery.store_id === store.id && !delivery.patient_id && delivery.ampm_deliveries === 'PM';
              });

              if (!existingPMPickup) {
                const pmPickupTime = isSaturday ? store.saturday_pm_start || '13:00' :
                isSunday ? store.sunday_pm_start || '13:00' :
                store.weekday_pm_start || '13:00';
                const pmPickupEndTime = isSaturday ? store.saturday_pm_end || '17:00' :
                isSunday ? store.sunday_pm_end || '17:00' :
                store.weekday_pm_end || '17:00';

                stopsToProcess.push({
                  isNew: true,
                  patient_id: null,
                  store_id: store.id,
                  driver_id: driverId,
                  driver_name: driver.user_name || driver.full_name,
                  delivery_date: deliveryDate,
                  delivery_time_start: pmPickupTime,
                  delivery_time_end: pmPickupEndTime,
                  ampm_deliveries: 'PM',
                  status: 'en_route',
                  delivery_notes: `Store Pickup for ${store.name}`,
                  latitude: store.latitude,
                  longitude: store.longitude,
                  patient_name: '',
                  patient_phone: '',
                  store_phone: store.phone || '',
                  extra_time: 15
                });

              }
            }
          }

          for (const newDelivery of driverDeliveries) {
            if (!newDelivery) continue;

            const patient = patients.find((p) => p && p.id === newDelivery.patient_id);
            if (!patient) {
              console.warn(`[AddToRoute]   ⚠️ Patient not found: ${newDelivery.patient_id}`);
              continue;
            }

            const deliveryStore = stores.find((s) => s.id === newDelivery.store_id);
            if (!deliveryStore) {
              console.warn(`[AddToRoute]   ⚠️ Store not found for patient: ${newDelivery.store_id}`);
              continue;
            }

            // CRITICAL: Use the status from DeliveryForm (already converted from 'Staged' to 'pending' or 'in_transit')
            // Do NOT override with hardcoded 'pending' - respect what DeliveryForm sent
            stopsToProcess.push({
              isNew: true,
              ...newDelivery,
              status: newDelivery.status || 'pending', // Use delivered status or fallback to 'pending'
              latitude: patient.latitude,
              longitude: patient.longitude,
              extra_time: newDelivery.extra_time || 5
            });

          }

          // NOTE: Route optimization and ETA updates are NOT run here.
          // They are triggered later when stops are transitioned from 'pending' to 'in_transit'
          // via the Assign/Accept All button or Start Delivery action.
          console.log('📝 [AddToRoute] Saving pending deliveries - optimization will run when stops are started');

          for (const stop of stopsToProcess) {
            if (!stop || !stop.isNew) continue;

            if (!stop.patient_id) {
              if (!stop.stop_id) {
                stop.stop_id = generateUniqueSID(allDeliveriesForDate);
              }
              stop.puid = stop.stop_id;
              const stopStore = stores.find((s) => s.id === stop.store_id);
            }
          }

          for (const stop of stopsToProcess) {
            if (!stop || !stop.isNew || !stop.patient_id) continue;

            const correspondingPickup = stopsToProcess.find((p) =>
            p && !p.patient_id &&
            p.store_id === stop.store_id &&
            p.ampm_deliveries === stop.ampm_deliveries &&
            p.stop_id
            );

            if (correspondingPickup) {
              stop.puid = correspondingPickup.stop_id;
              const patient = patients.find((p) => p.id === stop.patient_id);
            } else {
              console.warn(`[AddToRoute]   ⚠️ No matching pickup found for ${stop.patient_name}`);
            }
          }

          for (const stop of stopsToProcess) {
            if (!stop) continue;

            if (stop.patient_id !== null) {
              const stopPatient = patients.find((p) => p.id === stop.patient_id);

              // CRITICAL: Find the corresponding pickup by matching BOTH store_id AND ampm_deliveries
              const correspondingPickup = stopsToProcess.find((s) => {
                if (!s) return false;
                return s.store_id === stop.store_id &&
                s.patient_id === null &&
                s.ampm_deliveries === stop.ampm_deliveries;
              });

              if (stopPatient?.time_window_start) {
                stop.delivery_time_start = stopPatient.time_window_start;
              } else if (correspondingPickup && correspondingPickup.delivery_time_start) {
                stop.delivery_time_start = addMinutesToTime(correspondingPickup.delivery_time_start, 5);
              } else {
                stop.delivery_time_start = stop.delivery_time_start || '10:00';
              }

              // CRITICAL: Only set delivery_time_end for NEW deliveries or if patient has explicit time window
              if (stopPatient?.time_window_end) {
                stop.delivery_time_end = stopPatient.time_window_end;
              }
              // DISABLED: No longer auto-assign 9:00 PM default - leave blank if patient has no time window
            }
          }

          const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
          const completedStops = stopsToProcess.filter((s) => s && finishedStatuses.includes(s.status));
          const incompleteStops = stopsToProcess.filter((s) => s && !finishedStatuses.includes(s.status));

          // Sort completed by actual time
          completedStops.sort((a, b) => {
            if (!a || !b) return 0;
            if (!a.actual_delivery_time || !b.actual_delivery_time) return 0;
            return new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time);
          });

          // CRITICAL: Sort incomplete stops - pending deliveries ALWAYS LAST
          incompleteStops.sort((a, b) => {
            if (!a || !b) return 0;

            const isAPickup = !a.patient_id;
            const isBPickup = !b.patient_id;
            const isAPending = a.status === 'pending';
            const isBPending = b.status === 'pending';

            // CRITICAL: Pending deliveries ALWAYS go last
            if (isAPending && !isBPending) return 1;
            if (!isAPending && isBPending) return -1;

            // For non-pending stops, sort by time
            const timeA = a.delivery_time_start || a.delivery_time_eta || '99:99';
            const timeB = b.delivery_time_start || b.delivery_time_eta || '99:99';

            if (timeA !== timeB) {
              return timeA.localeCompare(timeB);
            }

            // CRITICAL: Same time - pickups before deliveries from same store
            if (a.store_id === b.store_id) {
              if (isAPickup && !isBPickup) return -1;
              if (!isAPickup && isBPickup) return 1;

              // If both are deliveries from same store, sort by distance
              if (!isAPickup && !isBPickup) {
                const storeForSort = stores.find((s) => s && s.id === a.store_id);
                if (storeForSort?.latitude && storeForSort?.longitude && a.latitude && a.longitude && b.latitude && b.longitude) {
                  const distA = calculateDistance(storeForSort.latitude, storeForSort.longitude, a.latitude, a.longitude);
                  const distB = calculateDistance(storeForSort.latitude, storeForSort.longitude, b.latitude, b.longitude);
                  return distA - distB;
                }
              }
            }

            return 0;
          });

          const optimizedRoute = [...completedStops, ...incompleteStops];
          let windowsProcessed = 0;
          for (const stop of optimizedRoute) {
            if (!stop) continue;

            if (stop.patient_id !== null) {
              const stopPatient = patients.find((p) => p.id === stop.patient_id);

              // CRITICAL: Find the corresponding pickup by matching BOTH store_id AND ampm_deliveries
              const correspondingPickup = optimizedRoute.find((s) => {
                if (!s) return false;
                return s.store_id === stop.store_id &&
                s.patient_id === null &&
                s.ampm_deliveries === stop.ampm_deliveries;
              });

              if (stopPatient?.time_window_start) {
                stop.delivery_time_start = stopPatient.time_window_start;
              } else if (correspondingPickup) {
                const pickupStartPlus5 = addMinutesToTime(correspondingPickup.delivery_time_start, 5);
                const pickupETAPlus5 = correspondingPickup.estimated_arrival ?
                addMinutesToTime(correspondingPickup.estimated_arrival, 5) : null;

                if (pickupETAPlus5 && pickupETAPlus5 > pickupStartPlus5) {
                  stop.delivery_time_start = pickupETAPlus5;
                } else if (pickupStartPlus5) {
                  stop.delivery_time_start = pickupStartPlus5;
                }
              }

              // CRITICAL: Only set delivery_time_end if patient has explicit time window
              if (stopPatient?.time_window_end) {
                stop.delivery_time_end = stopPatient.time_window_end;
              }
              // DISABLED: No longer auto-assign default end times - leave blank if patient has no time window
              windowsProcessed++;
            }
          }

          // First, set AM/PM on all pickups based on their scheduled time
          for (const stop of optimizedRoute) {
            if (!stop) continue;

            if (stop.patient_id === null && stop.delivery_time_start) {
              const ampm = determineAMPMFromTime(stop.delivery_time_start);
              stop.ampm_deliveries = ampm;
              if (!stop.puid && stop.stop_id) {
                stop.puid = stop.stop_id;
              }
            }
          }

          // Then, set AM/PM on all deliveries based on their PICKUP's time slot (not their own time)
          for (const stop of optimizedRoute) {
            if (!stop) continue;

            if (stop.patient_id !== null) {
              // Find the corresponding pickup for this store
              const correspondingPickup = optimizedRoute.find((p) =>
              p && !p.patient_id && p.store_id === stop.store_id
              );

              if (correspondingPickup && correspondingPickup.ampm_deliveries) {
                // CRITICAL: Use pickup's AM/PM designation, not delivery's own time
                stop.ampm_deliveries = correspondingPickup.ampm_deliveries;
                if (!stop.puid && correspondingPickup.stop_id) {
                  stop.puid = correspondingPickup.stop_id;
                }
              } else {
                // Fallback: if no pickup found, determine from delivery time
                const ampm = determineAMPMFromTime(stop.delivery_time_start);
                stop.ampm_deliveries = ampm;
                console.warn(`[AddToRoute]   ⚠️ No pickup found for ${patients.find((pt) => pt.id === stop.patient_id)?.full_name}, using delivery time for AM/PM`);
              }
            }
          }

          let pickupTRCounter = 0;
          const storePickupTRMap = {};

          // First pass: Assign TR# to pickups (existing and new)
          for (const stop of optimizedRoute) {
            if (!stop) continue;

            if (stop.patient_id === null) {
              const mapKey = `${stop.store_id}-${stop.ampm_deliveries}`;
              // If pickup already has TR# (existing), preserve it
              if (stop.tracking_number && !stop.isNew) {
                const existingTR = parseInt(stop.tracking_number, 10);
                if (!isNaN(existingTR)) {
                  storePickupTRMap[mapKey] = existingTR;
                  continue;
                }
              }

              // Assign new TR# for new pickups
              const trNumber = String(pickupTRCounter).padStart(2, '0');
              stop.tracking_number = trNumber;
              storePickupTRMap[mapKey] = pickupTRCounter;
              pickupTRCounter += 20;
            }
          }

          // Second pass: Assign TR# to deliveries (both active and pending)
          for (const stop of optimizedRoute) {
            if (!stop) continue;

            if (stop.patient_id !== null) {
              const mapKey = `${stop.store_id}-${stop.ampm_deliveries}`;
              const pickupBaseTR = storePickupTRMap[mapKey];

              if (pickupBaseTR !== undefined) {
                // Count deliveries from this store and same AM/PM slot that come before this one
                const deliveriesBeforeThis = optimizedRoute.filter((s) => {
                  if (!s) return false;
                  return s.patient_id !== null &&
                  s.store_id === stop.store_id &&
                  s.ampm_deliveries === stop.ampm_deliveries &&
                  optimizedRoute.indexOf(s) < optimizedRoute.indexOf(stop);
                }).length;

                const trNumber = String(pickupBaseTR + deliveriesBeforeThis + 1).padStart(2, '0');
                stop.tracking_number = trNumber;

                const patient = patients.find((p) => p.id === stop.patient_id);
              } else {
                stop.tracking_number = '99';
                console.warn(`[AddToRoute]     No pickup found for delivery (${mapKey}), using TR#99`);
              }
            }
          }

          const deliveriesToCreate = [];
          const deliveriesToUpdate = [];

          for (let i = 0; i < optimizedRoute.length; i++) {
            const stop = optimizedRoute[i];
            if (!stop) continue; // Defensive check

            const stopPatient = patients.find((p) => p && p.id === stop.patient_id);
            const stopStore = stores.find((s) => s && s.id === stop.store_id);

            stop.stop_order = i + 1;

            if (!stop.stop_id) {
              stop.stop_id = generateUniqueSID(allDeliveriesForDate);
            }

            const payload = {
              patient_id: stop.patient_id || null,
              store_id: stop.store_id,
              driver_id: driverId,
              driver_name: driver.user_name || driver.full_name,
              delivery_date: stop.delivery_date,
              delivery_time_start: stop.delivery_time_start,
              delivery_time_end: stop.delivery_time_end,
              delivery_time_eta: stop.estimated_arrival || stop.delivery_time_start,
              time_window_start: stop.time_window_start || stop.delivery_time_start,
              time_window_end: stop.time_window_end || stop.delivery_time_end,
              status: stop.status,
              stop_id: stop.stop_id,
              puid: stop.puid || null,
              stop_order: stop.stop_order,
              tracking_number: stop.tracking_number,
              delivery_notes: stop.delivery_notes || '',
              patient_name: stop.patient_id ? stopPatient?.full_name || '' : '',
              patient_phone: stop.patient_id ? stopPatient?.phone || '' : '',
              store_phone: stopStore?.phone || '',
              cod_payments: stop.cod_payments || null,
              cod_total_amount_required: stop.cod_total_amount_required || 0,
              ampm_deliveries: stop.ampm_deliveries,
              prescription_number: stop.prescription_number || '',
              delivery_instructions: stop.delivery_instructions || '',
              unit_number: stop.unit_number || '',
              mailbox_ok: stop.mailbox_ok || false,
              call_upon_arrival: stop.call_upon_arrival || false,
              ring_bell: stop.ring_bell || false,
              dont_ring_bell: stop.dont_ring_bell || false,
              back_door: stop.back_door || false,
              signature_needed: stop.signature_needed || false,
              fridge_item: stop.fridge_item || false,
              oversized: stop.oversized || false,
              extra_time: stop.extra_time || 5,
              first_delivery: stop.first_delivery || false
            };

            if (stop.isNew) {
              deliveriesToCreate.push(payload);
            } else {
              deliveriesToUpdate.push({
                id: stop.id,
                updates: {
                  stop_id: payload.stop_id,
                  puid: payload.puid,
                  stop_order: payload.stop_order,
                  tracking_number: payload.tracking_number,
                  delivery_time_start: payload.delivery_time_start,
                  delivery_time_end: payload.delivery_time_end,
                  delivery_time_eta: payload.delivery_time_eta,
                  time_window_start: payload.time_window_start,
                  time_window_end: payload.time_window_end,
                  ampm_deliveries: payload.ampm_deliveries
                }
              });
            }
          }

          if (deliveriesToCreate.length > 0) {
            await batchCreateDeliveriesLocal(deliveriesToCreate);
          }

          if (deliveriesToUpdate.length > 0) {
            for (const { id, updates } of deliveriesToUpdate) {
              if (!id || !updates) continue;
              await updateDeliveryLocal(id, updates);
            }
          }

          // NOTE: Route optimizer is NOT run here - deliveries are saved as 'pending'.
          // Optimization runs when stops are transitioned to 'in_transit' status.

          // CRITICAL: Skip all post-save operations - these will be handled by background sync
          // The deliveries are already created and mutations are queued
          // Smart refresh will handle updating isNextDelivery flags when it resumes
          console.log('[AddToRoute] ✅ Deliveries created - skipping post-save operations (handled by background sync)');

        }

        invalidate('Delivery');

        // CRITICAL: Update context from offline database (avoid API call)
        const batchDeliveryDate = stagedDeliveries[0]?.delivery_date || format(selectedDate, 'yyyy-MM-dd');
        
        // Wait for offline mutations to complete (they run asynchronously)
        await new Promise((resolve) => setTimeout(resolve, 500));
        
        // Refresh data will pull from offline DB first
        await refreshData();

        // Don't close form - let DeliveryForm handle it
        return;
      }

      const isEditing = !!editingDelivery;
      const deliveryDate = deliveryData.delivery_date;
      const driverId = deliveryData.driver_id;
      const originalDriverId = deliveryData._originalDriverId;
      const driverWasChanged = deliveryData._driverWasChanged;

      const isPickup = !deliveryData.patient_id;

      const driver = drivers.find((d) => d && d.id === driverId);
      if (!driver) {
        throw new Error('Driver not found');
      }

      const isDriverAssignedToSlot = (store, slotPrefix) => {
        const enabledField = `${slotPrefix}_enabled`;
        if (!store[enabledField]) return false;

        const idField = `${slotPrefix}_driver_id`;
        const nameField = `${slotPrefix}_driver`;

        if (store[idField] && driver.id) return store[idField] === driver.id;
        if (store[nameField] && driver.user_name) {
          return store[nameField].toLowerCase().trim() === driver.user_name.toLowerCase().trim();
        }
        return false;
      };

      if (isEditing && driverWasChanged) {
        await base44.entities.Delivery.update(editingDelivery.id, deliveryData);
        invalidate('Delivery');

        await handleDualDriverOptimization(originalDriverId, driverId, deliveryDate);

        await refreshData();
        setShowDeliveryForm(false);
        setEditingDelivery(null);
        hasAutoSelectedRef.current = false; // Reset flag to allow auto-selection after driver transfer
        return;
      }

      if (isEditing && !driverWasChanged) {
        await updateDeliveryLocal(editingDelivery.id, deliveryData);

        // Fetch fresh deliveries for this driver and date
        const freshDeliveries = await base44.entities.Delivery.filter({
          delivery_date: deliveryDate,
          driver_id: driverId
        });

        const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

        // Separate completed and incomplete deliveries
        const completedDeliveries = freshDeliveries.filter((d) => d && finishedStatuses.includes(d.status));
        const incompleteDeliveries = freshDeliveries.filter((d) => d && !finishedStatuses.includes(d.status));

        // Keep completed deliveries in their original order (don't touch them)
        // Find the highest stop_order among completed deliveries
        let startingStopOrder = 0;
        if (completedDeliveries.length > 0) {
          startingStopOrder = Math.max(...completedDeliveries.map((d) => d.stop_order || 0));
        }

        // Sort incomplete deliveries by ETA
        // CRITICAL: Sort incomplete deliveries - pending ALWAYS LAST
        const sortedIncomplete = [...incompleteDeliveries].sort((a, b) => {
          if (!a || !b) return 0;

          const isAPending = a.status === 'pending';
          const isBPending = b.status === 'pending';

          // Pending deliveries always go last
          if (isAPending && !isBPending) return 1;
          if (!isAPending && isBPending) return -1;

          // For non-pending, sort by ETA
          const etaA = a.delivery_time_eta || a.delivery_time_start || '99:99';
          const etaB = b.delivery_time_eta || b.delivery_time_start || '99:99';
          return etaA.localeCompare(etaB);
        });

        // Update only incomplete stop orders
        for (let i = 0; i < sortedIncomplete.length; i++) {
          const stop = sortedIncomplete[i];
          if (!stop) continue;

          await updateDeliveryLocal(stop.id, {
            stop_order: startingStopOrder + i + 1
          });
        }


        // OPTIMIZED: Only invalidate cache for the specific date instead of all deliveries
        invalidateDeliveriesForDate(deliveryDate);
        await refreshData();

        setShowDeliveryForm(false);
        setEditingDelivery(null);
        return;
      }

      const allDeliveriesForDate = (deliveries || []).filter((delivery) => {// Defensive check
        if (!delivery) return false;
        return delivery.delivery_date === deliveryDate;
      });
      const driverDeliveriesForDate = allDeliveriesForDate.filter((delivery) => {// Defensive check
        if (!delivery) return false;
        return delivery.driver_id === driverId;
      });

      const dateObj = new Date(deliveryDate + 'T00:00:00');
      const dayOfWeek = dateObj.getDay();
      const isSaturday = dayOfWeek === 6;
      const isSunday = dayOfWeek === 0;
      const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek];

      const assignedStores = (stores || []).filter((store) => {// Defensive check
        if (!store) return false;
        if (isSaturday) {
          return isDriverAssignedToSlot(store, 'saturday_am') || isDriverAssignedToSlot(store, 'saturday_pm');
        } else if (isSunday) {
          return isDriverAssignedToSlot(store, 'sunday_am') || isDriverAssignedToSlot(store, 'sunday_pm');
        } else {
          return isDriverAssignedToSlot(store, 'weekday_am') || isDriverAssignedToSlot(store, 'weekday_pm');
        }
      });

      assignedStores.forEach((store, idx) => {
        if (!store) return; // Defensive check
      });

      const stopsToProcess = [];

      for (const existingDelivery of driverDeliveriesForDate) {
        if (!existingDelivery) continue; // Defensive check

        const enriched = { ...existingDelivery, isNew: false };

        if (existingDelivery.patient_id) {
          const existingPatient = patients.find((p) => p && p.id === existingDelivery.patient_id);
          if (existingPatient?.latitude && existingPatient?.longitude) {
            enriched.latitude = existingPatient.latitude;
            enriched.longitude = existingPatient.longitude;
          }
          // Copy delivery preferences from patient if not already set
          enriched.call_upon_arrival = existingDelivery.call_upon_arrival ?? existingPatient?.call_upon_arrival;
          enriched.ring_bell = existingDelivery.ring_bell ?? existingPatient?.ring_bell;
          enriched.dont_ring_bell = existingDelivery.dont_ring_bell ?? existingPatient?.dont_ring_bell;
          enriched.mailbox_ok = existingDelivery.mailbox_ok ?? existingPatient?.mailbox_ok;
        } else {
          const existingStore = stores.find((s) => s && s.id === existingDelivery.store_id);
          if (existingStore?.latitude && existingStore?.longitude) {
            enriched.latitude = existingStore.latitude;
            enriched.longitude = existingStore.longitude;
          }
        }

        stopsToProcess.push(enriched);
      }

      const isFirstStop = driverDeliveriesForDate.length === 0;
      const deliveryStore = stores.find((s) => s.id === deliveryData.store_id);
      const storesToCheck = isFirstStop ? assignedStores : deliveryStore ? [deliveryStore] : [];

      for (const store of storesToCheck) {
        const isAssignedToAM = isSaturday ? isDriverAssignedToSlot(store, 'saturday_am') :
        isSunday ? isDriverAssignedToSlot(store, 'sunday_am') :
        isDriverAssignedToSlot(store, 'weekday_am');

        const isAssignedToPM = isSaturday ? isDriverAssignedToSlot(store, 'saturday_pm') :
        isSunday ? isDriverAssignedToSlot(store, 'sunday_pm') :
        isDriverAssignedToSlot(store, 'weekday_pm');

        if (isAssignedToAM) {
          const existingAMPickup = stopsToProcess.find((delivery) => {
            if (!delivery) return false; // Defensive check
            return delivery.store_id === store.id && !delivery.patient_id && delivery.ampm_deliveries === 'AM';
          });

          if (!existingAMPickup) {
            const amPickupTime = isSaturday ? store.saturday_am_start || '09:00' :
            isSunday ? store.sunday_am_start || '09:00' :
            store.weekday_am_start || '09:00';
            const amPickupEndTime = isSaturday ? store.saturday_am_end || '12:00' :
            isSunday ? store.sunday_am_end || '12:00' :
            store.weekday_am_end || '12:00';

            const amPickup = {
              isNew: true,
              patient_id: null,
              store_id: store.id,
              driver_id: driverId,
              driver_name: driver.user_name || driver.full_name,
              delivery_date: deliveryDate,
              delivery_time_start: amPickupTime,
              delivery_time_end: amPickupEndTime,
              ampm_deliveries: 'AM',
              status: 'en_route',
              delivery_notes: `Store Pickup for ${store.name}`,
              latitude: store.latitude,
              longitude: store.longitude,
              patient_name: '',
              patient_phone: '',
              store_phone: store.phone || '',
              extra_time: 15
            };

            stopsToProcess.push(amPickup);
          }
        }

        if (isAssignedToPM) {
          const existingPMPickup = stopsToProcess.find((delivery) => {
            if (!delivery) return false; // Defensive check
            return delivery.store_id === store.id && !delivery.patient_id && delivery.ampm_deliveries === 'PM';
          });

          if (!existingPMPickup) {
            const pmPickupTime = isSaturday ? store.saturday_pm_start || '13:00' :
            isSunday ? store.sunday_pm_start || '13:00' :
            store.weekday_pm_start || '13:00';
            const pmPickupEndTime = isSaturday ? store.saturday_pm_end || '17:00' :
            isSunday ? store.sunday_pm_end || '17:00' :
            store.weekday_pm_end || '17:00';

            const pmPickup = {
              isNew: true,
              patient_id: null,
              store_id: store.id,
              driver_id: driverId,
              driver_name: driver.user_name || driver.full_name,
              delivery_date: deliveryDate,
              delivery_time_start: pmPickupTime,
              delivery_time_end: pmPickupEndTime,
              ampm_deliveries: 'PM',
              status: 'en_route',
              delivery_notes: `Store Pickup for ${store.name}`,
              latitude: store.latitude,
              longitude: store.longitude,
              patient_name: '',
              patient_phone: '',
              store_phone: store.phone || '',
              extra_time: 15
            };

            stopsToProcess.push(pmPickup);
          }
        }
      }

      if (!isPickup) {
        const patient = patients.find((p) => p.id === deliveryData.patient_id);
        if (!patient) {
          throw new Error('Patient not found');
        }

        if (!deliveryStore) {
          throw new Error('Store not found for patient');
        }

        const newDelivery = {
          isNew: true,
          ...deliveryData,
          status: 'en_route',
          latitude: patient.latitude,
          longitude: patient.longitude,
          extra_time: deliveryData.extra_time || 5
        };

        stopsToProcess.push(newDelivery);
      } else {
        const pickupStore = stores.find((s) => s.id === deliveryData.store_id);
        if (!pickupStore) {
          throw new Error('Store not found for pickup');
        }

        const newPickup = {
          isNew: true,
          ...deliveryData,
          patient_id: null,
          status: 'en_route',
          delivery_notes: deliveryData.delivery_notes || `Store Pickup for ${pickupStore.name}`,
          latitude: pickupStore.latitude,
          longitude: pickupStore.longitude,
          extra_time: deliveryData.extra_time || 15
        };

        stopsToProcess.push(newPickup);
      }

      for (const stop of stopsToProcess) {
        if (!stop) continue; // Defensive check

        if (stop.patient_id !== null) {
          const stopPatient = patients.find((p) => p.id === stop.patient_id);

          if (stopPatient?.time_window_start) {
            stop.delivery_time_start = stopPatient.time_window_start;
          } else {
            const correspondingPickup = stopsToProcess.find((s) => {
              if (!s) return false; // Defensive check
              return s.store_id === stop.store_id && s.patient_id === null;
            });
            if (correspondingPickup && correspondingPickup.delivery_time_start) {
              stop.delivery_time_start = addMinutesToTime(correspondingPickup.delivery_time_start, 5);
            } else {
              stop.delivery_time_start = stop.delivery_time_start || '10:00';
            }
          }

          if (stopPatient?.time_window_end) {
            stop.delivery_time_end = stopPatient.time_window_end;
          }
          // DISABLED: No longer auto-assign 9:00 PM default - leave blank if patient has no time window
        }
      }

      // Sort stops by existing stop_order or delivery_time_start
      const optimizedRoute = [...stopsToProcess].sort((a, b) => {
        if (!a || !b) return 0;

        // First, sort by stop_order if both have it
        if (a.stop_order && b.stop_order) {
          return a.stop_order - b.stop_order;
        }

        // Then by delivery_time_start
        const timeA = a.delivery_time_start || '99:99';
        const timeB = b.delivery_time_start || '99:99';
        return timeA.localeCompare(timeB);
      });

      const routeStats = calculateRouteStats(optimizedRoute, stores, patients);
      optimizedRoute.forEach((stop, index) => {
        if (!stop) return; // Defensive check
        const stopPatient = patients.find((p) => p.id === stop.patient_id);
        const stopStore = stores.find((s) => s.id === stop.store_id);
        const stopName = stop.patient_id ? stopPatient?.full_name : `${stopStore?.name} Pickup`;
        const eta = stop.estimated_arrival || stop.delivery_time_start || 'N/A';
      });

      for (const stop of optimizedRoute) {
        if (!stop) continue; // Defensive check

        if (stop.patient_id !== null) {
          const stopPatient = patients.find((p) => p.id === stop.patient_id);
          const correspondingPickup = stopsToProcess.find((s) => {
            if (!s) return false; // Defensive check
            return s.store_id === stop.store_id && s.patient_id === null;
          });

          if (stopPatient?.time_window_start) {
            stop.delivery_time_start = stopPatient.time_window_start;
          } else if (correspondingPickup) {
            const pickupStartPlus5 = addMinutesToTime(correspondingPickup.delivery_time_start, 5);
            const pickupETAPlus5 = correspondingPickup.estimated_arrival ?
            addMinutesToTime(correspondingPickup.estimated_arrival, 5) :
            null;

            if (pickupETAPlus5 && pickupETAPlus5 > pickupStartPlus5) {
              stop.delivery_time_start = pickupETAPlus5;
            } else if (pickupStartPlus5) {
              stop.delivery_time_start = pickupStartPlus5;
            }
          }

          if (stopPatient?.time_window_end) {
            stop.delivery_time_end = stopPatient.time_window_end;
          }
          // DISABLED: No longer auto-assign default end times - leave blank if patient has no time window
        }
      }

      const storeAMPMMap = {};
      for (const stop of optimizedRoute) {
        if (!stop) continue; // Defensive check

        if (stop.patient_id === null && stop.delivery_time_start) {
          const ampm = determineAMPMFromTime(stop.delivery_time_start);
          storeAMPMMap[stop.store_id] = ampm;

          const stopStore = stores.find((s) => s.id === stop.store_id);
        }
      }

      for (const stop of optimizedRoute) {
        if (!stop) continue; // Defensive check

        if (stop.patient_id === null) {
          stop.ampm_deliveries = storeAMPMMap[stop.store_id] || determineAMPMFromTime(stop.delivery_time_start);
        } else {
          stop.ampm_deliveries = storeAMPMMap[stop.store_id] || determineAMPMFromTime(stop.delivery_time_start);
        }

        const stopName = stop.patient_id ?
        patients.find((p) => p.id === stop.patient_id)?.full_name :
        stores.find((s) => s.id === stop.store_id)?.name + ' Pickup';
      }

      let pickupTRCounter = 0;
      const storePickupTRMap = {};

      for (const stop of optimizedRoute) {
        if (!stop) continue; // Defensive check

        if (stop.patient_id === null) {
          const trNumber = String(pickupTRCounter).padStart(2, '0');
          stop.tracking_number = trNumber;
          storePickupTRMap[stop.store_id] = pickupTRCounter;

          const stopStore = stores.find((s) => s.id === stop.store_id);
          pickupTRCounter += 20;
        }
      }

      for (const stop of optimizedRoute) {
        if (!stop) continue; // Defensive check

        if (stop.patient_id !== null) {
          const pickupBaseTR = storePickupTRMap[stop.store_id];
          if (pickupBaseTR !== undefined) {
            const deliveriesBeforeThis = optimizedRoute.filter((s) => {
              if (!s) return false; // Defensive check
              return s.patient_id !== null &&
              s.store_id === stop.store_id &&
              optimizedRoute.indexOf(s) < optimizedRoute.indexOf(stop);
            }).length;

            const trNumber = String(pickupBaseTR + deliveriesBeforeThis + 1).padStart(2, '0');
            stop.tracking_number = trNumber;

            const stopPatient = patients.find((p) => p.id === stop.patient_id);
          } else {
            stop.tracking_number = '99';
            console.warn(`   ⚠️ No pickup found for delivery, keeping/using TR#${stop.tracking_number}`);
          }
        }
      }

      let createdCount = 0;
      let updatedCount = 0;

      for (let i = 0; i < optimizedRoute.length; i++) {
        const stop = optimizedRoute[i];
        if (!stop) continue; // Defensive check

        const stopPatient = patients.find((p) => p && p.id === stop.patient_id);
        const stopStore = stores.find((s) => s && s.id === stop.store_id);
        const stopName = stop.patient_id ? stopPatient?.full_name : `${stopStore?.name} Pickup`;

        stop.stop_order = i + 1;

        if (!stop.stop_id) {
          stop.stop_id = generateUniqueSID(allDeliveriesForDate);
        }

        const payload = {
          patient_id: stop.patient_id || null,
          store_id: stop.store_id,
          driver_id: driverId,
          driver_name: driver.user_name || driver.full_name,
          delivery_date: stop.delivery_date,
          delivery_time_start: stop.delivery_time_start,
          delivery_time_end: stop.delivery_time_end,
          delivery_time_eta: stop.estimated_arrival || stop.delivery_time_start,
          time_window_start: stop.time_window_start || stop.delivery_time_start,
          time_window_end: stop.time_window_end || stop.delivery_time_end,
          status: stop.status,
          stop_id: stop.stop_id,
          puid: stop.puid || null,
          stop_order: stop.stop_order,
          tracking_number: stop.tracking_number,
          delivery_notes: stop.delivery_notes || '',
          patient_name: stop.patient_id ? stopPatient?.full_name || '' : '',
          patient_phone: stop.patient_id ? stopPatient?.phone || '' : '',
          store_phone: stopStore?.phone || '',
          cod_payments: stop.cod_payments || null,
          cod_total_amount_required: stop.cod_total_amount_required || 0,
          ampm_deliveries: stop.ampm_deliveries,
          prescription_number: stop.prescription_number || '',
          delivery_instructions: stop.delivery_instructions || '',
          unit_number: stop.unit_number || '',
          mailbox_ok: stop.mailbox_ok || false,
          call_upon_arrival: stop.call_upon_arrival || false,
          ring_bell: stop.ring_bell || false,
          dont_ring_bell: stop.dont_ring_bell || false,
          back_door: stop.back_door || false,
          signature_needed: stop.signature_needed || false,
          fridge_item: stop.fridge_item || false,
          oversized: stop.oversized || false,
          extra_time: stop.extra_time || 5,
          first_delivery: stop.first_delivery || false
        };

        if (stop.isNew) {
          await base44.entities.Delivery.create(payload);
          createdCount++;
        } else {
          const updatePayload = {
            stop_id: payload.stop_id,
            puid: payload.puid,
            stop_order: payload.stop_order,
            delivery_time_start: payload.delivery_time_start,
            delivery_time_end: payload.delivery_time_end,
            delivery_time_eta: payload.delivery_time_eta,
            time_window_start: payload.time_window_start,
            time_window_end: payload.time_window_end,
            ampm_deliveries: payload.ampm_deliveries
          };

          // Only include tracking_number if stop doesn't have one yet (new stop)
          if (!stop.tracking_number || stop.tracking_number === '' || stop.tracking_number === '99') {
            updatePayload.tracking_number = payload.tracking_number;
          }

          await base44.entities.Delivery.update(stop.id, updatePayload);
          updatedCount++;
        }
      }

      invalidate('Delivery');
      await refreshData();

      hasAutoSelectedRef.current = false; // Reset to allow auto-selection after saving

    } catch (error) {
      console.error('');
      console.error('❌❌❌ ERROR ❌❌❌');
      console.error('Error saving delivery:', error);
      console.error('Stack trace:', error.stack);
      console.error('');
      alert(`Failed to save delivery: ${error.message}`);
      throw error;
    }
  };

  const handleReoptimizeRoute = async () => {
    try {
      setIsOptimizing(true);
      setOptimizationMessage("Fetching latest data...");

      const deliveryDate = format(selectedDate, 'yyyy-MM-dd');

      const today = startOfDay(new Date());
      const selected = startOfDay(selectedDate);
      const isPastDate = selected < today;
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

      let isDateFinished = false;

      const [latestDeliveries, latestPatients, latestStores, latestAppUsers, latestAuthUsers] = await Promise.all([
      base44.entities.Delivery.filter({ delivery_date: deliveryDate }),
      base44.entities.Patient.list(),
      base44.entities.Store.list(),
      base44.entities.AppUser.list(),
      base44.entities.User.list()]
      );

      const allMergedUsers = latestAuthUsers.map((authUser) => {
        if (!authUser) return null; // Defensive check
        const appUser = latestAppUsers.find((au) => au && au.user_id === authUser.id);
        if (appUser) {
          return {
            ...authUser,
            ...appUser,
            id: authUser.id,
            user_name: appUser.user_name || authUser.full_name,
            app_roles: appUser.app_roles || []
          };
        }
        return authUser;
      }).filter(Boolean);

      isDateFinished = isPastDate &&
      latestDeliveries.length > 0 &&
      latestDeliveries.every((d) => d && finishedStatuses.includes(d.status)); // Defensive check

      if (isDateFinished) {
        setOptimizationMessage("Refreshing data for past date...");

        invalidate('Delivery');
        await refreshData();

        setOptimizationMessage("Data refreshed for past date...");
        setTimeout(() => setOptimizationMessage(null), 3000);
        setIsOptimizing(false);
        return;
      }

      let driversToOptimize = [];

      if (selectedDriverId === 'all') {
        const uniqueDriverIds = [...new Set(
          (latestDeliveries || []).
          filter((d) => d && !finishedStatuses.includes(d.status)) // Defensive check
          .map((d) => d && d.driver_id) // Defensive check
          .filter(Boolean)
        )];

        driversToOptimize = uniqueDriverIds.
        map((driverId) => (allMergedUsers || []).find((u) => u && u.id === driverId)) // Defensive check
        .filter(Boolean);

      } else {
        const selectedDriver = (allMergedUsers || []).find((u) => u && u.id === selectedDriverId); // Defensive check
        if (selectedDriver) {
          driversToOptimize = [selectedDriver];
        }
      }

      if (driversToOptimize.length === 0) {
        setOptimizationMessage("No active routes to optimize.");
        setTimeout(() => setOptimizationMessage(null), 3000);
        invalidate('Delivery');
        await refreshData();
        setIsOptimizing(false);
        return;
      }

      let shouldOptimize = false;

      if (isAppOwner(currentUser)) {
        shouldOptimize = true;
        setOptimizationMessage(`App Owner: Optimizing ${driversToOptimize.length} driver route(s)...`);
      } else
      if (userHasRole(currentUser, 'admin')) {
        if (selectedDriverId !== 'all' && selectedDriverId !== currentUser.id) {
          shouldOptimize = false;
          setOptimizationMessage("Admin: Refreshing data for selected driver...");
        } else {
          shouldOptimize = true;
          setOptimizationMessage(`Admin: Optimizing ${driversToOptimize.length} driver route(s)...`);
        }
      } else
      if (userHasRole(currentUser, 'driver')) {
        if (selectedDriverId === 'all' || selectedDriverId !== currentUser.id) {
          shouldOptimize = false;
          setOptimizationMessage("Driver: Data refreshed. Only your route can be optimized.");
        } else {
          shouldOptimize = true;
          setOptimizationMessage("Driver: Optimizing your route...");
        }
      } else
      if (userHasRole(currentUser, 'dispatcher')) {
        shouldOptimize = false;
        setOptimizationMessage("Dispatcher: Refreshing data...");
      }

      if (shouldOptimize) {
        let totalUpdated = 0;
        let totalDistance = 0;
        let totalTime = 0;

        for (const driver of driversToOptimize) {
          setOptimizationMessage(`Calculating optimal route for ${driver.user_name || driver.full_name}...`);

          const driverDeliveries = (latestDeliveries || []).filter((d) => d && d.driver_id === driver.id); // Defensive check
          const activeDeliveries = driverDeliveries.filter((d) => d && !finishedStatuses.includes(d.status)); // Defensive check

          if (activeDeliveries.length === 0) {
            continue;
          }

          let startLocation = null;
          let startTime = null;
          let startSource = null;

          // Check if route has started (has completed or in-transit stops)
          const completedStops = driverDeliveries.filter((d) => d && d.status === 'completed' && d.actual_delivery_time);
          const inTransitStops = activeDeliveries.filter((d) => d && d.status === 'in_transit');
          const hasStarted = completedStops.length > 0 || inTransitStops.length > 0;

          if (hasStarted) {
            // Priority 1: Use driver's current location from AppUser if available and recent
            const driverAppUser = (allMergedUsers || []).find((u) => u && u.id === driver.id);
            if (driverAppUser?.current_latitude && driverAppUser?.current_longitude && driverAppUser?.location_updated_at) {
              const locationAge = Date.now() - new Date(driverAppUser.location_updated_at).getTime();
              const fiveMinutesInMs = 5 * 60 * 1000;

              if (locationAge < fiveMinutesInMs) {
                startLocation = {
                  lat: driverAppUser.current_latitude,
                  lon: driverAppUser.current_longitude
                };
                startTime = format(new Date(), 'HH:mm');
                startSource = 'driver_current_location';
              }
            }

            // Priority 2: Use last completed stop location if current location not available
            if (!startLocation && completedStops.length > 0) {
              completedStops.sort((a, b) => {
                if (!a || !b) return 0;
                return new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time);
              });
              const lastCompleted = completedStops[0];

              const location = lastCompleted.patient_id ?
              latestPatients.find((p) => p.id === lastCompleted.patient_id) :
              latestStores.find((s) => s.id === lastCompleted.store_id);

              if (location?.latitude && location?.longitude) {
                startLocation = { lat: location.latitude, lon: location.longitude };
                startTime = format(new Date(), 'HH:mm');
                startSource = 'last_completed_stop';
              }
            }

            // Priority 3: Use first active stop as fallback
            if (!startLocation) {
              const sortedActive = [...activeDeliveries].sort((a, b) => {
                if (!a || !b) return 0;
                if (a.stop_order && b.stop_order) return a.stop_order - b.stop_order;
                return (a.delivery_time_start || '99:99').localeCompare(b.delivery_time_start || '99:99');
              });

              const firstStop = sortedActive[0];
              const location = firstStop.patient_id ?
              latestPatients.find((p) => p.id === firstStop.patient_id) :
              latestStores.find((s) => s.id === firstStop.store_id);

              if (location?.latitude && location?.longitude) {
                startLocation = { lat: location.latitude, lon: location.longitude };
                startTime = firstStop.delivery_time_start || '09:00';
                startSource = 'first_active_stop';
              }
            }
          } else {
            // Route hasn't started - use first stop or driver home

            const sortedActive = [...activeDeliveries].sort((a, b) => {
              if (!a || !b) return 0;
              if (a.stop_order && b.stop_order) return a.stop_order - b.stop_order;
              return (a.delivery_time_start || '99:99').localeCompare(b.delivery_time_start || '99:99');
            });

            const firstStop = sortedActive[0];
            const location = firstStop?.patient_id ?
            latestPatients.find((p) => p.id === firstStop.patient_id) :
            latestStores.find((s) => s && s.id === firstStop?.store_id);

            if (location?.latitude && location?.longitude) {
              startLocation = { lat: location.latitude, lon: location.longitude };
              startTime = firstStop.delivery_time_start || '09:00';
              startSource = 'first_stop';
            }

            // Fallback to driver home if no stops have coordinates
            if (!startLocation) {
              const driverHomeLocation = (allMergedUsers || []).find((u) => u && u.id === driver.id);
              if (driverHomeLocation?.home_latitude && driverHomeLocation?.home_longitude) {
                startLocation = { lat: driverHomeLocation.home_latitude, lon: driverHomeLocation.home_longitude };
                startTime = format(new Date(), 'HH:mm');
                startSource = 'driver_home';
              }
            }
          }

          if (startLocation) {
          }

          for (const stop of activeDeliveries) {
            if (!stop) continue; // Defensive check

            if (stop.patient_id !== null) {
              const stopPatient = latestPatients.find((p) => p.id === stop.patient_id);

              if (stopPatient?.time_window_start) {
                stop.delivery_time_start = stopPatient.time_window_start;
              } else {
                const correspondingPickup = activeDeliveries.find((s) => {
                  if (!s) return false; // Defensive check
                  return s.store_id === stop.store_id && s.patient_id === null;
                });
                if (correspondingPickup && correspondingPickup.delivery_time_start) {
                  stop.delivery_time_start = addMinutesToTime(correspondingPickup.delivery_time_start, 5);
                } else {
                  stop.delivery_time_start = stop.delivery_time_start || '10:00';
                }
              }

              if (stopPatient?.time_window_end) {
                stop.delivery_time_end = stopPatient.time_window_end;
              } else {
                stop.delivery_time_end = '21:00';
              }
            }
          }

          setOptimizationMessage(`Calculating optimal route for ${driver.user_name || driver.full_name}...`);

          const activeWithTempTimes = populateTemporaryStartTimes(activeDeliveries, latestStores);
          const optimizedRoute = optimizeRoute(activeWithTempTimes, latestStores, latestPatients, {
            useAdvancedOptimization: true,
            respectManualOrder: false,
            startLocation: startLocation,
            startTime: startTime,
            driverHome: driver.home_latitude && driver.home_longitude ? {
              lat: driver.home_latitude,
              lon: driver.home_longitude
            } : null
          });

          const routeStats = calculateRouteStats(optimizedRoute, latestStores, latestPatients);

          totalDistance += routeStats.totalDistance;
          totalTime += routeStats.totalTime;

          optimizedRoute.forEach((stop, index) => {
            if (!stop) return; // Defensive check
            const stopPatient = latestPatients.find((p) => p && p.id === stop.patient_id);
            const stopStore = latestStores.find((s) => s && s.id === stop.store_id);
            const stopName = stop.patient_id ? stopPatient?.full_name : `${stopStore?.name} Pickup`;
            const eta = stop.estimated_arrival || stop.delivery_time_start || 'N/A';
          });

          for (const stop of optimizedRoute) {
            if (!stop) continue; // Defensive check

            if (stop.patient_id !== null) {
              const stopPatient = latestPatients.find((p) => p.id === stop.patient_id);
              const correspondingPickup = optimizedRoute.find((s) => {
                if (!s) return false; // Defensive check
                return s.store_id === stop.store_id && s.patient_id === null;
              });

              if (stopPatient?.time_window_start) {
                stop.delivery_time_start = stopPatient.time_window_start;
              } else if (correspondingPickup) {
                const pickupStartPlus5 = addMinutesToTime(correspondingPickup.delivery_time_start, 5);
                const pickupETAPlus5 = correspondingPickup.estimated_arrival ?
                addMinutesToTime(correspondingPickup.estimated_arrival, 5) :
                null;

                if (pickupETAPlus5 && pickupETAPlus5 > pickupStartPlus5) {
                  stop.delivery_time_start = pickupETAPlus5;
                } else if (pickupStartPlus5) {
                  stop.delivery_time_start = pickupStartPlus5;
                }
              }

              if (stopPatient?.time_window_end) {
                stop.delivery_time_end = stopPatient.time_window_end;
              } else {
                stop.delivery_time_end = stop.delivery_time_start ? addMinutesToTime(stop.delivery_time_start, 60) : '21:00';
              }
            }
          }

          const storeAMPMMap = {};
          for (const stop of optimizedRoute) {
            if (!stop) continue; // Defensive check

            if (stop.patient_id === null && stop.delivery_time_start) {
              const ampm = determineAMPMFromTime(stop.delivery_time_start);
              storeAMPMMap[stop.store_id] = ampm;

              const stopStore = latestStores.find((s) => s.id === stop.store_id);
            }
          }

          for (const stop of optimizedRoute) {
            if (!stop) continue; // Defensive check

            if (stop.patient_id === null) {
              stop.ampm_deliveries = storeAMPMMap[stop.store_id] || determineAMPMFromTime(stop.delivery_time_start);
            } else {
              stop.ampm_deliveries = storeAMPMMap[stop.store_id] || determineAMPMFromTime(stop.delivery_time_start);
            }

            const stopName = stop.patient_id ?
            latestPatients.find((p) => p.id === stop.patient_id)?.full_name :
            latestStores.find((s) => s.id === stop.store_id)?.name + ' Pickup';
          }

          const lockedStatuses = ['in_transit', 'completed', 'failed', 'cancelled', 'returned'];

          let pickupTRCounter = 0;
          const storePickupTRMap = {};

          for (const stop of optimizedRoute) {
            if (!stop) continue; // Defensive check

            if (stop.patient_id === null) {
              if (lockedStatuses.includes(stop.status)) {
                if (stop.tracking_number) {
                  const trValue = parseInt(stop.tracking_number, 10);
                  if (!isNaN(trValue)) {
                    storePickupTRMap[stop.store_id] = trValue;
                  }
                }
              } else {
                const trNumber = String(pickupTRCounter).padStart(2, '0');
                stop.tracking_number = trNumber;
                storePickupTRMap[stop.store_id] = pickupTRCounter;

                const stopStore = latestStores.find((s) => s.id === stop.store_id);
                pickupTRCounter += 20;
              }
            }
          }

          for (const stop of optimizedRoute) {
            if (!stop) continue; // Defensive check

            if (stop.patient_id !== null) {
              if (lockedStatuses.includes(stop.status)) {
                const stopPatient = latestPatients.find((p) => p.id === stop.patient_id);
              } else {
                const pickupBaseTR = storePickupTRMap[stop.store_id];
                if (pickupBaseTR !== undefined) {
                  const deliveriesBeforeThis = optimizedRoute.filter((s) => {
                    if (!s) return false; // Defensive check
                    return s.patient_id !== null &&
                    s.store_id === stop.store_id &&
                    !lockedStatuses.includes(s.status) &&
                    optimizedRoute.indexOf(s) < optimizedRoute.indexOf(stop);
                  }).length;

                  const trNumber = String(pickupBaseTR + deliveriesBeforeThis + 1).padStart(2, '0');
                  stop.tracking_number = trNumber;

                  const stopPatient = latestPatients.find((p) => p.id === stop.patient_id);
                } else {
                  stop.tracking_number = stop.tracking_number || '99';
                  console.warn(`   ⚠️ No pickup found for delivery, keeping/using TR#${stop.tracking_number}`);
                }
              }
            }
          }

          setOptimizationMessage(`Updating database for ${driver.user_name || driver.full_name}...`);

          const completedDeliveries = driverDeliveries.filter((d) => d && finishedStatuses.includes(d.status));

          const sortedCompleted = [...completedDeliveries].sort((a, b) => {
            if (!a || !b) return 0; // Defensive check
            return new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time);
          });

          const finalSortedRoute = [...sortedCompleted, ...optimizedRoute];

          finalSortedRoute.forEach((stop, idx) => {
            if (!stop) return; // Defensive check
            const stopPatient = latestPatients.find((p) => p && p.id === stop.patient_id);
            const stopStore = latestStores.find((s) => s && s.id === stop.store_id);
            const stopName = stop.patient_id ? stopPatient?.full_name : `${stopStore?.name} Pickup`;
            const isComplete = finishedStatuses.includes(stop.status);
          });

          for (let i = 0; i < finalSortedRoute.length; i++) {
            const stop = finalSortedRoute[i];
            if (!stop) continue; // Defensive check

            const sequentialStopOrder = i + 1;

            const updatePayload = {
              stop_order: sequentialStopOrder
            };

            if (!finishedStatuses.includes(stop.status)) {
              updatePayload.delivery_time_eta = stop.estimated_arrival || stop.delivery_time_start;
              updatePayload.delivery_time_start = stop.delivery_time_start;
              updatePayload.delivery_time_end = stop.delivery_time_end;
              updatePayload.ampm_deliveries = stop.ampm_deliveries;

              // CRITICAL: Only update TR# during reoptimization for stops that don't have a valid TR# yet
              const hasValidTR = stop.tracking_number && stop.tracking_number !== '' && stop.tracking_number !== '99';
              if (!hasValidTR) {
                updatePayload.tracking_number = stop.tracking_number;
              }
            }

            await updateDeliveryLocal(stop.id, updatePayload);
            totalUpdated++;

            const stopName = stop.patient_id ?
            latestPatients.find((p) => p.id === stop.patient_id)?.full_name :
            latestStores.find((s) => s.id === stop.store_id)?.name + ' Pickup';
          }

        }

        setOptimizationMessage(`Successfully optimized ${driversToOptimize.length} route(s)!`);
      }

      invalidate('Delivery');
      await refreshData();

      hasAutoSelectedRef.current = false; // Reset to allow auto-selection after refresh

      setTimeout(() => setOptimizationMessage(null), 5000);

    } catch (error) {
      console.error('');
      console.error('❌❌❌ ERROR ❌❌❌');
      console.error('Error in route optimization:', error);
      console.error('Stack trace:', error.stack);
      console.error('');

      setOptimizationMessage(`Error: ${error.message}`);
      setTimeout(() => setOptimizationMessage(null), 8000);

      invalidate('Delivery');
      await refreshData();
    } finally {
      setIsOptimizing(false);
    }
  };

  const handleDualDriverOptimization = async (originalDriverId, newDriverId, deliveryDate) => {
    const driversToOptimize = [originalDriverId, newDriverId].filter(Boolean);

    for (const driverId of driversToOptimize) {
      const driver = drivers.find((d) => d && d.id === driverId);
      if (!driver) continue;

      const driverDeliveries = await base44.entities.Delivery.filter({
        delivery_date: deliveryDate,
        driver_id: driverId
      });

      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

      const completedDeliveries = (driverDeliveries || []).filter((d) => d && finishedStatuses.includes(d.status)); // Defensive check
      const incompleteDeliveries = (driverDeliveries || []).filter((d) => d && !finishedStatuses.includes(d.status)); // Defensive check

      if (incompleteDeliveries.length === 0) {
        if (completedDeliveries.length > 0) {
          const sortedCompleted = [...completedDeliveries].sort((a, b) => {
            if (!a || !b) return 0; // Defensive check
            return new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time);
          });
          for (let i = 0; i < sortedCompleted.length; i++) {
            const stop = sortedCompleted[i];
            if (!stop) continue; // Defensive check
            await updateDeliveryLocal(stop.id, { stop_order: i + 1 });
            const stopName = stop.patient_id ?
            patients.find((p) => p && p.id === stop.patient_id)?.full_name :
            stores.find((s) => s && s.id === stop.store_id)?.name + ' Pickup';
          }
        }
        continue;
      }

      const enrichedIncomplete = incompleteDeliveries.map((d) => {
        if (!d) return null; // Defensive check

        const enrichedStop = { ...d };
        if (d.patient_id) {
          const patient = patients.find((p) => p && p.id === d.patient_id);
          if (patient?.latitude && patient?.longitude) {
            enrichedStop.latitude = patient.latitude;
            enrichedStop.longitude = patient.longitude;
          }
        } else {
          const store = stores.find((s) => s && s.id === d.store_id);
          if (store?.latitude && store?.longitude) {
            enrichedStop.latitude = store.latitude;
            enrichedStop.longitude = store.longitude;
          }
        }
        return enrichedStop;
      }).filter((d) => d && d.latitude && d.longitude);

      const enrichedWithTempTimes = populateTemporaryStartTimes(enrichedIncomplete, stores);
      const optimizedRoute = optimizeRoute(enrichedWithTempTimes, stores, patients, {
        useAdvancedOptimization: true,
        respectManualOrder: false,
        driverHome: driver.home_latitude && driver.home_longitude ? {
          lat: driver.home_latitude,
          lon: driver.home_longitude
        } : null
      });

      const sortedCompleted = [...completedDeliveries].sort((a, b) => {
        if (!a || !b) return 0; // Defensive check
        return new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time);
      });

      const finalSortedRoute = [...sortedCompleted, ...optimizedRoute];

      finalSortedRoute.forEach((stop, idx) => {
        if (!stop) return; // Defensive check
        const stopPatient = patients.find((p) => p && p.id === stop.patient_id);
        const stopStore = stores.find((s) => s && s.id === stop.store_id);
        const stopName = stop.patient_id ? stopPatient?.full_name : `${stopStore?.name} Pickup`;
        const isComplete = finishedStatuses.includes(stop.status);
      });

      for (let i = 0; i < finalSortedRoute.length; i++) {
        const stop = finalSortedRoute[i];
        if (!stop) continue; // Defensive check
        const sequentialStopOrder = i + 1;

        const updatePayload = {
          stop_order: sequentialStopOrder
        };

        if (!finishedStatuses.includes(stop.status)) {
          updatePayload.delivery_time_eta = stop.estimated_arrival || stop.delivery_time_start;
          updatePayload.delivery_time_start = stop.delivery_time_start;
          updatePayload.delivery_time_end = stop.delivery_time_end;
          updatePayload.ampm_deliveries = stop.ampm_deliveries;

          // CRITICAL: Only update TR# during reoptimization for stops that are:
          // 1. NOT in_transit, completed, failed, cancelled, or returned (these are locked)
          // 2. Don't have a TR# yet (new stops) OR have placeholder TR# (99)
          const hasValidTR = stop.tracking_number && stop.tracking_number !== '' && stop.tracking_number !== '99';
          if (!hasValidTR) {
            updatePayload.tracking_number = stop.tracking_number;
          }
        }

        await updateDeliveryLocal(stop.id, updatePayload);

        const stopName = stop.patient_id ?
        patients.find((p) => p.id === stop.patient_id)?.full_name :
        stores.find((s) => s.id === stop.store_id)?.name + ' Pickup';
      }

    }

  };

  const handleEditDelivery = (delivery) => {
    setEditingDelivery(delivery);
    setShowDeliveryForm(true);
  };

  const handleEditPatient = (patient) => {
    setEditingPatient(patient);
    setPatientFormCallback(null);
    setShowPatientForm(true);
  };

  const handleCreatePatientFromDelivery = (callback) => {
    setEditingPatient(null);
    setPatientFormCallback(() => callback);
    setShowPatientForm(true);
  };

  const handleSavePatient = async (patientData, shouldReturnPatient = false) => {
    try {
      let savedPatient;

      if (editingPatient) {
        await base44.entities.Patient.update(editingPatient.id, patientData);
        savedPatient = { ...editingPatient, ...patientData };
      } else {
        savedPatient = await base44.entities.Patient.create(patientData);
      }

      invalidate('Patient');
      await refreshData();

      setShowPatientForm(false);

      if (patientFormCallback && savedPatient && !editingPatient) {
        patientFormCallback(savedPatient);
      }

      setEditingPatient(null);
      setPatientFormCallback(null);
    } catch (error) {
      console.error('Error saving patient:', error);
      alert(`Failed to save patient: ${error.message || error}`);
      throw error;
    }
  };

  const handleDeleteDelivery = async (deliveryId) => {
    try {
      const targetDelivery = deliveriesWithStopOrder.find((d) => d && d.id === deliveryId);

      if (!targetDelivery) {
        console.error('❌ [DELETE Handler] Delivery not found');
        throw new Error('Delivery not found');
      }

      const driverId = targetDelivery.driver_id;
      const deliveryDate = targetDelivery.delivery_date;

      // Step 1: Delete from offline database
      console.log('🗑️ [DELETE] Step 1: Deleting from offline DB...');
      const { offlineDB } = await import('../components/utils/offlineDatabase');
      await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, deliveryId);
      console.log('  ✅ Removed from offline DB');

      // Step 2: Delete from online entity
      console.log('🗑️ [DELETE] Step 2: Deleting from online entity...');
      await base44.entities.Delivery.delete(deliveryId);
      console.log('  ✅ Removed from online entity');

      // Step 3: Update UI immediately
      console.log('🗑️ [DELETE] Step 3: Updating UI...');
      if (updateDeliveriesLocally) {
        const updatedDeliveries = deliveries.filter((d) => d && d.id !== deliveryId);
        updateDeliveriesLocally(updatedDeliveries, true);
      }

      // Clear selection if this card was selected
      if (selectedCardId === deliveryId) {
        setSelectedCardId(null);
      }
      console.log('  ✅ UI updated');

      // Step 4: Run smart refresh
      console.log('🗑️ [DELETE] Step 4: Running smart refresh...');
      smartRefreshManager.lastRefreshTimes = {
        driverLocation: 0,
        activeDeliveries: 0,
        todayDeliveries: 0,
        appUsers: 0,
        patients: 0,
        stores: 0
      };
      console.log('  ✅ Smart refresh triggered');

      console.log('✅ [DELETE] Complete');

    } catch (error) {
      console.error('❌ [DELETE Handler] Error:', error);
      alert('Failed to delete delivery. Please try again.');
      throw error;
    }
  };

  const recalculateStopOrders = async (driverId, deliveryDate) => {
    return await recalculateAndUpdateStopOrders(driverId, deliveryDate);
  };

  const handleRestartDelivery = async (deliveryId) => {
    try {

      // Get original delivery from state
      const originalDelivery = deliveriesWithStopOrder.find((d) => d && d.id === deliveryId);
      if (!originalDelivery) {
        throw new Error('Delivery not found');
      }

      const driverId = originalDelivery.driver_id;
      const deliveryDate = originalDelivery.delivery_date;

      const isPickup = !originalDelivery.patient_id;
      const newStatus = isPickup ? 'en_route' : 'in_transit';

      // IMPORTANT: Restart sets status to in_transit/en_route (active) on the SAME delivery
      // It does NOT duplicate or change date - that's handled by Retry button for failed deliveries
      await updateDeliveryLocal(deliveryId, {
        status: newStatus,
        actual_delivery_time: null,
        delivery_notes: ''
      });

      // Recalculate stop orders
      await recalculateStopOrders(driverId, deliveryDate);

      invalidate('Delivery');
      await refreshData();

    } catch (error) {
      console.error('Error restarting delivery:', error);
      alert('Failed to restart delivery. Please try again.');
    }
  };

  const handleStatusUpdate = async (deliveryId, newStatus, extraData = {}, skipAutoCenter = false) => {
    // CRITICAL: Capture current FAB state BEFORE setting entity updating
    const wasPhase2Locked = mapViewPhase === 2 && isMapViewLocked;
    const currentPhase = mapViewPhase;

    // CRITICAL: Unlock FAB if in Phase 2 (will be re-locked after status update)
    if (wasPhase2Locked) {
      console.log('🔓 [STATUS] Phase 2 detected - unlocking FAB temporarily');
      if (mapLockTimeoutRef.current) {
        clearTimeout(mapLockTimeoutRef.current);
        mapLockTimeoutRef.current = null;
      }
      mapLockExpiresAtRef.current = null;
      setIsMapViewLocked(false);
    }

    setIsEntityUpdating(true);

    // Wait 100ms to ensure smart refresh has paused before proceeding
    await new Promise((resolve) => setTimeout(resolve, 100));

    try {
      const targetDelivery = deliveriesWithStopOrder.find((d) => d && d.id === deliveryId);
      if (!targetDelivery) {
        throw new Error('Delivery not found');
      }

      // CRITICAL: Force refresh latest deliveries for this driver/date BEFORE updating
      try {
        await forceRefreshDriverDeliveries(targetDelivery.driver_id, targetDelivery.delivery_date);
      } catch (refreshError) {
        console.warn('⚠️ [STATUS UPDATE] Pre-refresh failed, continuing anyway:', refreshError.message);
      }

      const currentDate = format(new Date(), 'yyyy-MM-dd');
      const deliveryDate = targetDelivery.delivery_date;
      const isPickup = !targetDelivery.patient_id;
      const isRetry = targetDelivery.status === 'failed' && (newStatus === 'in_transit' || newStatus === 'en_route');

      if (isRetry) {
        // ALWAYS duplicate a failed delivery when retrying - regardless of date
        const patient = patients.find((p) => p && p.id === targetDelivery.patient_id);
        const store = stores.find((s) => s && s.id === targetDelivery.store_id);

        const retryDeliveryData = {
          patient_id: targetDelivery.patient_id,
          store_id: targetDelivery.store_id,
          driver_id: targetDelivery.driver_id,
          driver_name: targetDelivery.driver_name,
          delivery_date: currentDate,
          delivery_time_start: targetDelivery.delivery_time_start,
          delivery_time_end: targetDelivery.delivery_time_end,
          status: isPickup ? 'en_route' : 'in_transit',
          delivery_notes: `RETRY From: ${targetDelivery.delivery_date}`,
          patient_name: patient?.full_name || targetDelivery.patient_name || '',
          patient_phone: patient?.phone || targetDelivery.patient_phone || '',
          store_phone: store?.phone || targetDelivery.store_phone || '',
          prescription_number: targetDelivery.prescription_number || '',
          delivery_instructions: targetDelivery.delivery_instructions || '',
          unit_number: targetDelivery.unit_number || '',
          cod_total_amount_required: targetDelivery.cod_total_amount_required || 0,
          signature_needed: targetDelivery.signature_needed || false,
          fridge_item: targetDelivery.fridge_item || false,
          oversized: targetDelivery.oversized || false,
          first_delivery: targetDelivery.first_delivery || false,
          mailbox_ok: targetDelivery.mailbox_ok || false,
          call_upon_arrival: targetDelivery.call_upon_arrival || false,
          ring_bell: targetDelivery.ring_bell || false,
          dont_ring_bell: targetDelivery.dont_ring_bell || false,
          back_door: targetDelivery.back_door || false
        };

        // Create the duplicate delivery for today
        await createDeliveryLocal(retryDeliveryData);
        // Invalidate caches for both the original date and today
        invalidateDeliveriesForDate(targetDelivery.delivery_date);
        invalidateDeliveriesForDate(currentDate);
        invalidate('Delivery');
        await refreshData();
        return;
      }

      const driverId = targetDelivery.driver_id;
      const currentTime = new Date();
      let currentTimeISO = currentTime.toISOString();
      const currentTimeHHMM = format(currentTime, 'HH:mm');

      const updateData = { status: newStatus, ...extraData };

      // CRITICAL: Set delivery_time_start to current time + 5 minutes when transitioning to in_transit
      if (newStatus === 'in_transit' || newStatus === 'en_route') {
        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const startMinutes = currentMinutes + 5;
        updateData.delivery_time_start = `${String(Math.floor(startMinutes / 60) % 24).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`;
      }

      // CRITICAL: Always clear isNextDelivery flag when completing/failing deliveries
      if (['completed', 'failed', 'cancelled'].includes(newStatus)) {
        updateData.isNextDelivery = false;
      }

      // CRITICAL: Cancelled pickups are treated as completed (with timestamp)
      if (['completed', 'failed', 'delivered'].includes(newStatus) || newStatus === 'cancelled' && isPickup) {
        // CRITICAL: Check if this is first or last delivery for rounding
        const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
        const allDriverDeliveries = deliveriesWithStopOrder.filter((d) =>
        d && d.driver_id === driverId && d.delivery_date === targetDelivery.delivery_date
        );

        // First delivery = first one being completed (all others still incomplete)
        const completedCount = allDriverDeliveries.filter((d) => finishedStatuses.includes(d.status)).length;
        const isFirstDelivery = completedCount === 0;

        // Last delivery = this is the last incomplete one
        const incompleteCount = allDriverDeliveries.filter((d) => !finishedStatuses.includes(d.status)).length;
        const isLastDelivery = incompleteCount === 1; // This one will be the last after completion

        // Round the timestamp if first or last
        if (isFirstDelivery || isLastDelivery) {
          currentTimeISO = roundCompletionTime(currentTimeISO, isFirstDelivery, isLastDelivery);
        }

        updateData.actual_delivery_time = currentTimeISO;
      } else {
        updateData.actual_delivery_time = null;
      }

      // CRITICAL: Update isNextDelivery flags BEFORE updating status (so UI shows correct next stop immediately)
      if (['completed', 'failed', 'cancelled'].includes(newStatus)) {
        // Reset all isNextDelivery flags for this driver/date
        const allDriverDeliveriesForDate = deliveriesWithStopOrder.filter((d) =>
        d && d.driver_id === driverId && d.delivery_date === deliveryDate
        );

        const resetPromises = allDriverDeliveriesForDate.
        filter((d) => d.isNextDelivery && d.id !== deliveryId).
        map((d) => updateDeliveryLocal(d.id, { isNextDelivery: false }));

        if (resetPromises.length > 0) {
          await Promise.all(resetPromises);
        }

        // Find the next incomplete delivery (excluding the one being completed) and mark as next (SKIP PENDING)
        const incompleteDeliveries = allDriverDeliveriesForDate.
        filter((d) => d.id !== deliveryId && !['completed', 'failed', 'cancelled'].includes(d.status) && d.status !== 'pending').
        sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

        if (incompleteDeliveries.length > 0) {
          const nextStop = incompleteDeliveries[0];
          await updateDeliveryLocal(nextStop.id, { isNextDelivery: true });
        }
      }

      await updateDeliveryLocal(deliveryId, updateData);
      // STEP 1.5: Update patient's last_delivery_date if completed or failed
      if (['completed', 'failed'].includes(newStatus) && targetDelivery.patient_id) {
        try {
          await base44.entities.Patient.update(targetDelivery.patient_id, {
            last_delivery_date: targetDelivery.delivery_date
          });
        } catch (error) {
          console.error('❌ Failed to update patient last_delivery_date:', error);
        }
      }

      // Check if route is complete - finished statuses OR returns (identified by markers)
      const finishedStatuses = ['completed', 'failed', 'cancelled'];

      // Helper to detect return deliveries by markers
      const isReturnByMarkers = (d) => {
        if (!d || d.patient_id) return false; // Returns are pickups
        const patient = patients.find((p) => p && p.id === d.patient_id);
        const notes = d.delivery_notes || '';
        const patientName = d.patient_name || '';
        const patientFullName = patient?.full_name || '';
        return notes.toLowerCase().includes('(rtn)') ||
        patientName.toLowerCase().includes('(rtn)') ||
        patientFullName.toLowerCase().includes('(rtn)') ||
        /\breturn\b/i.test(notes) ||
        /\breturn\b/i.test(patientName) ||
        /\breturn\b/i.test(patientFullName);
      };

      const allDriverDeliveries = deliveriesWithStopOrder.filter((d) =>
      d && d.driver_id === driverId && d.delivery_date === targetDelivery.delivery_date
      );
      const routeComplete = allDriverDeliveries.length > 0 &&
      allDriverDeliveries.every((d) => finishedStatuses.includes(d.status) || isReturnByMarkers(d));

      if (routeComplete && finishedStatuses.includes(newStatus)) {
        const summaryKey = `${driverId}_${targetDelivery.delivery_date}`;
        if (!hasShownSummaryRef.current.has(summaryKey)) {
          console.log('🎉 [STATUS UPDATE] Route complete - showing summary');
          const completedDriver = users.find((u) => u && u.id === driverId) || currentUser;
          setSummaryDriver(completedDriver);
          setShowRouteSummary(true);
          hasShownSummaryRef.current.add(summaryKey);
        }
      }

      // CRITICAL: Update ETAs for mobile drivers only when completing/failing stops
      const shouldUpdateETAs = isMobile && userHasRole(currentUser, 'driver') && ['completed', 'failed', 'cancelled'].includes(newStatus);

      if (shouldUpdateETAs) {
        console.log('⏱️ [STATUS UPDATE - ETA] Mobile driver completing stop - updating ETAs');
        try {
          // Get current local time in HH:mm format
          const now = new Date();
          const localTimeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

          const response = await base44.functions.invoke('calculateRealTimeETA', {
            driverId: targetDelivery.driver_id,
            deliveryDate: deliveryDate,
            currentLocalTime: localTimeString // Backend calculates and saves ETAs directly
          });
          console.log('✅ [STATUS UPDATE] ETAs updated by backend');
          
          // CRITICAL: Force map to re-render route lines after ETA update
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', { 
            detail: { driverId: targetDelivery.driver_id, deliveryDate: deliveryDate, triggeredBy: 'statusUpdateETA' } 
          }));
        } catch (etaError) {
          console.warn('⚠️ [STATUS UPDATE] ETA update failed:', etaError);
        }
      }

      // CRITICAL: Recalculate stop orders after status change
      await recalculateStopOrders(targetDelivery.driver_id, deliveryDate);

      // CRITICAL: Force full data refresh to sync UI
      invalidateDeliveriesForDate(deliveryDate);
      await refreshData();
      
      // CRITICAL: Force map to re-render route lines after data refresh
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { 
        detail: { driverId: targetDelivery.driver_id, deliveryDate: deliveryDate, triggeredBy: 'statusUpdate' } 
      }));

      if (!skipAutoCenter) {
        hasAutoSelectedRef.current = false;
      }

      // CRITICAL: Only re-lock and re-trigger FAB if original phase was Phase 2
      if (currentPhase === 2) {
        console.log(`🔒 [STATUS] Re-locking FAB to Phase 2 after status update`);
        setIsMapViewLocked(true);
        lastProgrammaticMapMoveRef.current = Date.now();
        window._lastProgrammaticMapMove = Date.now();
        setMapViewTrigger((prev) => prev + 1);
        
        // Phase 2 stays locked permanently - clear any timers
        if (mapLockTimeoutRef.current) {
          clearTimeout(mapLockTimeoutRef.current);
          mapLockTimeoutRef.current = null;
        }
        mapLockExpiresAtRef.current = null;
      } else {
        // Phase 1 & 3 - don't reactivate, leave as-is
        console.log(`🔓 [STATUS] Phase ${currentPhase} - leaving unlocked after status update`);
      }

      // CRITICAL: Scroll to next delivery card after status update (completion)
      if (['completed', 'failed', 'cancelled'].includes(newStatus)) {
        setTimeout(() => {
          // Find the card with isNextDelivery=true from updated deliveries
          const nextCardElement = document.querySelector('[data-is-next-delivery="true"]');
          if (nextCardElement) {
            nextCardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            console.log('📍 [STATUS] Scrolled to next delivery card after completion');
          } else {
            // Fallback: find by querying deliveries that were just updated
            const finishedStatuses = ['completed', 'failed', 'cancelled'];
            const incompleteDeliveries = deliveriesWithStopOrder.filter((d) =>
            d && d.id !== deliveryId && !finishedStatuses.includes(d.status) && d.status !== 'pending'
            ).sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

            if (incompleteDeliveries.length > 0) {
              const nextDelivery = incompleteDeliveries[0];
              const cardElement = document.getElementById(`stop-card-${nextDelivery.id}`);
              if (cardElement) {
                cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                console.log('📍 [STATUS] Scrolled to next delivery card (fallback) after completion');
              }
            }
          }
        }, 500); // Wait for UI to update with new isNextDelivery flags
      }
    } catch (error) {
      console.error('');
      console.error('❌❌❌ ERROR ❌❌❌');
      console.error('Error updating delivery status:', error);
      console.error('Stack trace:', error.stack);
      console.error('');

      // CRITICAL: Handle session expiration errors
      if (error.response?.status === 401 || error.message?.includes('Unauthorized') || error.message?.includes('session')) {
        alert('Your session has expired. The page will now reload.');
        window.location.reload();
        return;
      }

      alert('Failed to update delivery status. Please try again.');
    } finally {
      setIsEntityUpdating(false);

      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const handleNotesUpdate = async (deliveryId, notes) => {
    try {
      await updateDeliveryLocal(deliveryId, {
        delivery_notes: notes
      });

      invalidate('Delivery');
      await refreshData();
    } catch (error) {
      console.error('Error updating delivery notes:', error);
      alert('Failed to update notes. Please try again.');
    }
  };

  const handleCODUpdate = async (deliveryId, codPayments, skipAutoCenter = false) => {
    try {
      await updateDeliveryLocal(deliveryId, {
        cod_payments: codPayments
      });

      invalidate('Delivery');
      await refreshData();
    } catch (error) {
      console.error('Error updating COD payments:', error);
      alert('Failed to update COD payments. Please try again.');
      throw error;
    }
  };

  const handleCreateReturn = async ({ originalDelivery, returnPatient, store }) => {
    try {
      const currentDate = format(new Date(), 'yyyy-MM-dd');
      const returnDeliveryData = {
        patient_id: returnPatient.id,
        store_id: originalDelivery.store_id,
        driver_id: originalDelivery.driver_id,
        driver_name: originalDelivery.driver_name,
        delivery_date: currentDate,
        delivery_time_start: originalDelivery.delivery_time_start,
        delivery_time_end: originalDelivery.delivery_time_end,
        status: 'in_transit',
        delivery_notes: `PATIENT RETURN From: ${originalDelivery.delivery_date}`,
        patient_name: returnPatient.full_name,
        patient_phone: returnPatient.phone || store?.phone || '',
        store_phone: store?.phone || ''
      };

      // Create the return delivery for today
      await createDeliveryLocal(returnDeliveryData);
      // Invalidate caches for both dates
      invalidateDeliveriesForDate(originalDelivery.delivery_date);
      invalidateDeliveriesForDate(currentDate);
      invalidate('Delivery');
      await refreshData();

    } catch (error) {
      console.error('❌ [CREATE RETURN] Error:', error);
      throw error;
    }
  };

  const handleStartDelivery = async (deliveryId) => {
    console.log('═══════════════════════════════════════════════════');
    console.log('🚀 [START] ========== STARTING DELIVERY ==========');
    console.log('═══════════════════════════════════════════════════');

    // STEP 0: Pause smart refresh to prevent race conditions
    console.log('⏸️ [START] Step 0: Pausing smart refresh manager...');
    setIsEntityUpdating(true);
    pauseOfflineMutations();
    pauseOfflineSync();
    await new Promise((resolve) => setTimeout(resolve, 100));

    try {
      const deliveryFromUI = deliveriesWithStopOrder.find((d) => d?.id === deliveryId);
      if (!deliveryFromUI) {
        console.error('❌ [START ERROR] Delivery not found in local state');
        throw new Error('Delivery not found in local state');
      }

      const driverId = deliveryFromUI.driver_id;
      const deliveryDate = deliveryFromUI.delivery_date;
      const isPickup = !deliveryFromUI.patient_id;
      const newStatus = isPickup ? 'en_route' : 'in_transit';

      console.log(`📦 [START] Delivery: ${deliveryFromUI.patient_name || 'Pickup'} (${deliveryId})`);
      console.log(`   Driver: ${driverId}, Date: ${deliveryDate}, New Status: ${newStatus}`);

      // STEP 1: Clear ALL isNextDelivery flags for this driver/date
      console.log('🔄 [START] Step 1: Clearing all isNextDelivery flags...');
      const allDriverDeliveries = await base44.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      });

      const resetPromises = allDriverDeliveries
        .filter((d) => d.isNextDelivery)
        .map((d) => base44.entities.Delivery.update(d.id, { isNextDelivery: false }));
      
      if (resetPromises.length > 0) {
        await Promise.all(resetPromises);
        console.log(`   ✅ Cleared ${resetPromises.length} isNextDelivery flags`);
      }

      // STEP 2: Set isNextDelivery=true on the selected delivery
      console.log('🎯 [START] Step 2: Setting isNextDelivery=true on selected delivery...');
      await base44.entities.Delivery.update(deliveryId, { 
        isNextDelivery: true,
        status: newStatus
      });
      console.log('   ✅ isNextDelivery flag set and status updated');

      // STEP 3: Calculate stop_order - this delivery becomes the next after completed stops
      console.log('📊 [START] Step 3: Calculating stop_order...');
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const completedStops = allDriverDeliveries.filter((d) => finishedStatuses.includes(d.status));
      const nextStopOrder = completedStops.length + 1;
      
      await base44.entities.Delivery.update(deliveryId, { 
        stop_order: nextStopOrder 
      });
      console.log(`   ✅ Assigned stop_order=${nextStopOrder} (after ${completedStops.length} completed stops)`);

      // STEP 4: Update UI immediately (before optimization)
      console.log('🖥️ [START] Step 4: Updating UI immediately...');
      invalidateDeliveriesForDate(deliveryDate);
      await forceRefreshDriverDeliveries(driverId, deliveryDate);
      
      // CRITICAL: Dispatch event to force map markers to re-render immediately
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { 
        detail: { driverId, deliveryDate, triggeredBy: 'startDelivery' } 
      }));
      console.log('   ✅ UI and map markers updated with new isNextDelivery and stop_order');

      // STEP 5: Clear and recalculate blue polyline
      console.log('🔵 [START] Step 5: Updating blue polyline...');
      setCurrentToNextPolyline(null);
      
      try {
        const driver = users.find((u) => u && u.id === driverId);
        if (driver && driver.driver_status === 'on_duty' && driver.location_tracking_enabled === true) {
          const freshDeliveries = await base44.entities.Delivery.filter({
            driver_id: driverId,
            delivery_date: deliveryDate
          });
          const segment = determinePolylineSegment(freshDeliveries, driver, patients, stores);
          
          if (segment) {
            const polyline = await fetchPolylineForSegment(
              segment.originLat,
              segment.originLon,
              segment.destLat,
              segment.destLon
            );
            setCurrentToNextPolyline(polyline);
            console.log('   ✅ Blue polyline updated');
          }
        }
      } catch (polylineError) {
        console.warn('   ⚠️ Blue polyline update failed:', polylineError.message);
      }

      // STEP 6: Update this delivery's ETA to current time + 5 minutes
      console.log('⏱️ [START] Step 6: Setting delivery ETA...');
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const etaMinutes = currentMinutes + 5;
      const etaString = `${String(Math.floor(etaMinutes / 60) % 24).padStart(2, '0')}:${String(etaMinutes % 60).padStart(2, '0')}`;
      
      await base44.entities.Delivery.update(deliveryId, {
        delivery_time_start: etaString,
        delivery_time_eta: etaString
      });
      console.log(`   ✅ ETA set to ${etaString}`);

      // STEP 7: Re-optimize the route from this delivery onward
      console.log('🔄 [START] Step 7: Re-optimizing route from this delivery onward...');
      try {
        const localTimeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        
        const optimizeResponse = await base44.functions.invoke('optimizeRouteRealTime', {
          driverId: driverId,
          deliveryDate: deliveryDate,
          currentLocalTime: localTimeString,
          deviceTime: now.toISOString()
        });

        const optimizeData = optimizeResponse?.data || optimizeResponse;
        console.log(`   ✅ Route optimization: ${optimizeData?.success ? 'success' : 'error'}`);
        
        // CRITICAL: Force map to re-render route lines after optimization
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', { 
          detail: { driverId: driverId, deliveryDate: deliveryDate, triggeredBy: 'startDeliveryOptimization' } 
        }));
      } catch (optimizeError) {
        console.warn('   ⚠️ Route optimization failed:', optimizeError.message);
      }

      // STEP 8: Update ETAs for all remaining stops (mobile drivers only)
      if (isMobile && userHasRole(currentUser, 'driver')) {
        console.log('⏱️ [START] Step 8: Updating ETAs for all stops...');
        try {
          const localTimeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
          
          await base44.functions.invoke('calculateRealTimeETA', {
            driverId: driverId,
            deliveryDate: deliveryDate,
            currentLocalTime: localTimeString
          });
          console.log('   ✅ ETAs updated');
          
          // CRITICAL: Force map to re-render route lines after ETA update
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', { 
            detail: { driverId: driverId, deliveryDate: deliveryDate, triggeredBy: 'startDeliveryETA' } 
          }));
        } catch (etaError) {
          console.warn('   ⚠️ ETA calculation failed:', etaError.message);
        }
      }

      // STEP 9: Final UI refresh and database sync
      console.log('🔄 [START] Step 9: Final UI refresh and database sync...');
      invalidateDeliveriesForDate(deliveryDate);
      await forceRefreshDriverDeliveries(driverId, deliveryDate);
      await refreshData();
      console.log('   ✅ UI and database synced');
      
      // CRITICAL: Force map to re-render route lines after data refresh
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { 
        detail: { driverId: driverId, deliveryDate: deliveryDate, triggeredBy: 'startDeliveryFinalRefresh' } 
      }));

      // STEP 10: Scroll to the started delivery card
      console.log('📍 [START] Step 10: Scrolling to started delivery card...');
      setTimeout(() => {
        const cardElement = document.getElementById(`stop-card-${deliveryId}`);
        if (cardElement) {
          cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          console.log('   ✅ Scrolled to card');
        }
      }, 300);

      console.log('═══════════════════════════════════════════════════');
      console.log('✅ [START] ========== START DELIVERY COMPLETE ==========');
      console.log('═══════════════════════════════════════════════════');

      // Check if route is complete after starting
      const allDriverDeliveriesForStart = deliveries.filter((d) =>
      d && d.driver_id === driverId && d.delivery_date === deliveryDate
      );

      // Helper to detect returns by markers (no status check)
      const checkIsReturn = (d) => {
        if (!d || d.patient_id) return false;
        const patient = patients.find((p) => p && p.id === d.patient_id);
        const notes = d.delivery_notes || '';
        const patientName = d.patient_name || '';
        const patientFullName = patient?.full_name || '';
        return notes.toLowerCase().includes('(rtn)') ||
        patientName.toLowerCase().includes('(rtn)') ||
        patientFullName.toLowerCase().includes('(rtn)') ||
        /\breturn\b/i.test(notes) ||
        /\breturn\b/i.test(patientName) ||
        /\breturn\b/i.test(patientFullName);
      };

      const routeComplete = allDriverDeliveriesForStart.length > 0 &&
      allDriverDeliveriesForStart.every((d) => finishedStatuses.includes(d.status) || checkIsReturn(d));

      if (routeComplete) {
        const summaryKey = `${driverId}_${deliveryDate}`;
        if (!hasShownSummaryRef.current.has(summaryKey)) {
          console.log('🎉 [START] Route complete - showing summary');
          const completedDriver = users.find((u) => u && u.id === driverId) || currentUser;
          setSummaryDriver(completedDriver);
          setShowRouteSummary(true);
          hasShownSummaryRef.current.add(summaryKey);
        }
      }

    } catch (error) {
      console.log('');
      console.log('═══════════════════════════════════════════════════');
      console.error('❌❌❌ [START] === ERROR OCCURRED ===');
      console.error('Error type:', error.constructor.name);
      console.error('Error message:', error.message);
      console.error('Error response:', error.response);
      console.error('Error status:', error.response?.status);
      console.error('Full error:', error);
      console.error('Stack trace:', error.stack);
      console.log('═══════════════════════════════════════════════════');
      console.log('');

      if (error.response?.status === 401 || error.message?.includes('Unauthorized') || error.message?.includes('session')) {
        alert('Your session has expired. The page will now reload.');
        window.location.reload();
        return;
      }

      alert(`Failed to start delivery: ${error.message}`);
    } finally {
      // CRITICAL: Resume offline database operations after optimization
      resumeOfflineMutations();
      resumeOfflineSync();

      setIsEntityUpdating(false);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const handleAcceptAIOptimization = async (updates) => {
    try {
      '🤖 [AI Optimization] Accepting AI route suggestions:', updates;

      for (const update of updates) {
        await updateDeliveryLocal(update.id, {
          stop_order: update.stop_order
        });
      }

      invalidate('Delivery');
      await refreshData();

      console.log('✅ [AI Optimization] Route updated successfully');
    } catch (error) {
      console.error('❌ [AI Optimization] Error applying optimization:', error);
      throw error;
    }
  };

  const handleQuickReorder = async (reorderUpdates) => {
    try {
      setIsEntityUpdating(true);

      console.log('🔄 [Quick Reorder] Swapping stop orders:', reorderUpdates);

      // Update stop orders in parallel
      for (const update of reorderUpdates) {
        await updateDeliveryLocal(update.id, { stop_order: update.stop_order });
      }

      // Recalculate ETAs after reordering
      const deliveryDate = format(selectedDate, 'yyyy-MM-dd');
      const now = new Date();
      const localTimeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      const response = await base44.functions.invoke('calculateRealTimeETA', {
        driverId: currentUser.id,
        deliveryDate: deliveryDate,
        currentLocalTime: localTimeString // Backend calculates and saves ETAs directly
      });
      // Backend now handles all ETA calculations and database updates - no need to recalculate here

      invalidate('Delivery');
      await refreshData();

      console.log('✅ [Quick Reorder] Complete');
    } catch (error) {
      console.error('❌ [Quick Reorder] Error:', error);
      alert('Failed to reorder stops. Please try again.');
    } finally {
      setIsEntityUpdating(false);
    }
  };

  const handleAddDelay = async (deliveryId, delayMinutes) => {
    try {
      setIsEntityUpdating(true);

      console.log(`⏱️ [Add Delay] Adding ${delayMinutes} minutes to stop ${deliveryId}`);

      const delivery = deliveriesWithStopOrder.find((d) => d && d.id === deliveryId);
      if (!delivery) return;

      // Add delay to this stop's ETA and all subsequent stops
      const deliveryDate = format(selectedDate, 'yyyy-MM-dd');
      const allDriverDeliveries = await base44.entities.Delivery.filter({
        driver_id: currentUser.id,
        delivery_date: deliveryDate
      }, 'stop_order');

      const targetStopOrder = delivery.stop_order;
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned', 'pending'];

      for (const d of allDriverDeliveries) {
        if (!d || finishedStatuses.includes(d.status)) continue;
        if ((d.stop_order || 0) < targetStopOrder) continue;

        // Add delay to ETA
        const currentETA = d.delivery_time_eta || d.delivery_time_start;
        if (currentETA) {
          const [hours, mins] = currentETA.split(':').map(Number);
          const totalMinutes = hours * 60 + mins + delayMinutes;
          const newETA = `${String(Math.floor(totalMinutes / 60) % 24).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;

          await base44.entities.Delivery.update(d.id, { delivery_time_eta: newETA });
        }
      }

      invalidate('Delivery');
      await refreshData();

      console.log(`✅ [Add Delay] ${delayMinutes} minutes added to remaining stops`);
    } catch (error) {
      console.error('❌ [Add Delay] Error:', error);
      alert('Failed to add delay. Please try again.');
    } finally {
      setIsEntityUpdating(false);
    }
  };

  // CRITICAL: Add click handler BEFORE early return to ensure hooks are always called
  // Also handles collapsing stats card when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (isExpanded && statsCardRef.current && !statsCardRef.current.contains(event.target)) {
        setIsExpanded(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isExpanded]);

  // Re-enable auto-fade when card collapses
  useEffect(() => {
    if (!isExpanded && areCardsVisible) {
      if (fadeTimeoutRef.current) {
        clearTimeout(fadeTimeoutRef.current);
      }
      fadeTimeoutRef.current = setTimeout(() => {
        setAreCardsVisible(false);
      }, 3000);
    }
  }, [isExpanded, areCardsVisible]);

  // Force UI refresh when data for selected date becomes available
  const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
  const [forceRender, setForceRender] = useState(0);

  useEffect(() => {
    if (!isDataLoaded || !deliveries) return;

    // Check if we have deliveries for the selected date
    const hasDataForDate = deliveries.some((d) => d && d.delivery_date === selectedDateStr);

    if (hasDataForDate) {
      // Force a re-render to update stats and cards immediately
      setForceRender((prev) => prev + 1);
    }
  }, [isDataLoaded, deliveries, selectedDateStr]);

  if (isLoadingUser || !isDataLoaded || !isFiltersReady) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-4 border-emerald-600 border-t-transparent rounded-full mx-auto mb-4"></div>
          <p className="text-slate-600">
            {!isFiltersReady ? 'Initializing filters...' : 'Loading dashboard data...'}
          </p>
        </div>
      </div>);

  }

  return (
    <div className="h-full w-full flex flex-col overflow-hidden" style={{ background: 'var(--bg-slate-50)' }}>
      <AnimatePresence>
        {optimizationMessage &&
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          className={optimizationMessagePositioning}
          style={{ top: isExpanded ? '216px' : '116px' }}>

            <div className="rounded-lg shadow-2xl border-2 border-emerald-500 p-3 flex items-center gap-3" style={{ background: 'var(--bg-white)' }}>
              {isOptimizing &&
            <div className="animate-spin w-4 h-4 border-3 border-emerald-500 border-t-transparent rounded-full flex-shrink-0"></div>
            }
              <p className="font-medium flex-1 text-sm" style={{ color: 'var(--text-slate-900)' }}>{optimizationMessage}</p>
              {!isOptimizing &&
            <button
              onClick={() => setOptimizationMessage(null)}
              className="text-slate-400 hover:text-slate-600 flex-shrink-0">

                  <X className="w-3.5 h-3.5" style={{ color: 'var(--text-slate-400)' }} />
                </button>
            }
            </div>
          </motion.div>
        }
      </AnimatePresence>

      <div className={statsCardPositioning}>
        <div className="flex flex-col items-center gap-1 z-[200] max-w-[340px]"

        style={{ opacity: statsPanelOpacity, transition: 'opacity 0.5s ease-in-out' }}
        onMouseEnter={() => handleStatsPanelInteraction(true)}
        onMouseLeave={() => handleStatsPanelInteraction(false)}>

          <motion.div
            ref={statsCardRef}
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
            onMouseEnter={() => handleCardInteraction(true)}
            onMouseLeave={() => handleCardInteraction(false)}
            onClick={(e) => {
              e.stopPropagation();
              handleCardInteraction(true);
              if (retractClustersRef.current) {
                retractClustersRef.current();
              }
            }} className="px-2 py-2 rounded-2xl shadow-xl border min-w-[340px] cursor-pointer" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', pointerEvents: 'auto', touchAction: 'manipulation', position: 'relative' }}>


            

            <div className="flex items-center justify-between mb-2">
              <div className="pr-1 flex items-center gap-2">
                <h2 className="pl-2 text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>Dashboard</h2>
                {currentUser &&
                <SmartRefreshIndicator
                  inline={true}
                  onManualRefresh={async () => {
                    // CRITICAL: Only affect active driver on mobile devices
                    if (!isMobile) {
                      return;
                    }

                    console.clear();
                    // Determine active driver ID
                    const activeDriverId = selectedDriverId === 'all' ? currentUser?.id : selectedDriverId;

                    if (!activeDriverId) {
                      return;
                    }

                    const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
                    const now = new Date();
                    const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

                    // STEP 1: Smart refresh cycle
                    const currentData = { deliveries, patients, appUsers, stores };
                    const filters = {
                      selectedDate,
                      deliveryFilter: { driver_id: activeDriverId },
                      patientFilter: {},
                      activeDriverIds: [activeDriverId]
                    };

                    const cityStoreIds = stores.map((s) => s?.id).filter(Boolean);
                    if (cityStoreIds.length > 0) {
                      filters.deliveryFilter.store_id = { $in: cityStoreIds };
                      filters.patientFilter.store_id = { $in: cityStoreIds };
                    }

                    smartRefreshManager.lastRefreshTimes = {
                      driverLocation: 0,
                      activeDeliveries: 0,
                      todayDeliveries: 0,
                      appUsers: 0,
                      patients: 0,
                      stores: 0
                    };

                    const updates = await smartRefreshManager.performSmartRefresh(currentData, filters, false);

                    // STEP 2: Run recursive route optimization (includes ETA updates)
                    try {
                      console.log('🔄 [Refresh Spinner] Running optimizeRouteRealTime...');
                      const optimizeResponse = await base44.functions.invoke('optimizeRouteRealTime', {
                        driverId: activeDriverId,
                        deliveryDate: selectedDateStr,
                        currentLocalTime: currentLocalTime,
                        generatePolyline: false
                      });
                      console.log('✅ [Refresh Spinner] Route optimized - ETAs updated by backend');
                      
                      // CRITICAL: Force map to re-render route lines
                      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { 
                        detail: { driverId: activeDriverId, deliveryDate: selectedDateStr, triggeredBy: 'refreshOptimization' } 
                      }));
                    } catch (optimizeError) {
                      console.warn('⚠️ [Refresh Spinner] Route optimizer failed:', optimizeError);
                    }

                    // STEP 3: Force reload deliveries for active driver
                    invalidateDeliveriesForDate(selectedDateStr);
                    const freshDeliveries = await base44.entities.Delivery.filter({
                      delivery_date: selectedDateStr,
                      driver_id: activeDriverId
                    });

                    // STEP 4: Update isNextDelivery flags for active driver
                    const updatedDeliveries = await base44.entities.Delivery.filter({
                      delivery_date: selectedDateStr,
                      driver_id: activeDriverId
                    }, 'stop_order');

                    // Reset all isNextDelivery flags for this driver
                    const resetPromises = updatedDeliveries.
                    filter((d) => d.isNextDelivery).
                    map((d) => base44.entities.Delivery.update(d.id, { isNextDelivery: false }));
                    await Promise.all(resetPromises);

                    // Find first incomplete and mark as next (NO reordering, SKIP PENDING)
                    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
                    const firstIncomplete = updatedDeliveries.
                    filter((d) => !finishedStatuses.includes(d.status) && d.status !== 'pending').
                    sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0];

                    if (firstIncomplete) {
                      await base44.entities.Delivery.update(firstIncomplete.id, { isNextDelivery: true });
                    }

                    // STEP 5: Reload fresh data and update UI
                    invalidateDeliveriesForDate(selectedDateStr);
                    const finalDeliveries = await base44.entities.Delivery.filter({
                      delivery_date: selectedDateStr
                    });

                    // Update UI state
                    if (updateDeliveriesLocally) {
                      const otherDateDeliveries = deliveries.filter((d) => d && d.delivery_date !== selectedDateStr);
                      const mergedDeliveries = [...otherDateDeliveries, ...finalDeliveries];
                      updateDeliveriesLocally(mergedDeliveries);
                    }

                    // CRITICAL: Update offline database with fresh deliveries
                    try {
                      const { offlineDB } = await import('../components/utils/offlineDatabase');
                      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, finalDeliveries);
                      console.log('✅ [Refresh] Updated offline database with fresh deliveries');
                    } catch (dbError) {
                      console.warn('⚠️ [Refresh] Failed to update offline database:', dbError);
                    }

                    // Apply any smart refresh updates
                    if (updates) {
                      if (updates.patients) {
                        setPatients(updates.patients);
                      }
                      if (updates.appUsers) {
                        setAppUsers(updates.appUsers);
                      }
                      if (updates.stores) {
                        setStores(updates.stores);
                      }
                    }

                    // CRITICAL: Only re-lock and re-trigger FAB if current phase is Phase 2
                    if (mapViewPhase === 2) {
                      console.log(`🔒 [Refresh Spinner] Re-locking FAB to Phase 2 after optimization`);
                      setIsMapViewLocked(true);
                      lastProgrammaticMapMoveRef.current = Date.now();
                      window._lastProgrammaticMapMove = Date.now();
                      setMapViewTrigger((prev) => prev + 1);
                      
                      // Phase 2 stays locked permanently - clear any timers
                      if (mapLockTimeoutRef.current) {
                        clearTimeout(mapLockTimeoutRef.current);
                        mapLockTimeoutRef.current = null;
                      }
                      mapLockExpiresAtRef.current = null;
                    }

                  }} />

                }
              </div>

              <div className="flex items-center gap-3">
                <Popover open={isCalendarOpen} onOpenChange={(open) => {
                  setIsCalendarOpen(open);
                  if (open) {
                    setCalendarMonth(selectedDate);
                  }
                }} modal={true}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="bg-transparent px-3 text-xs font-medium rounded-md inline-flex items-center justify-center whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 shadow-sm gap-2 h-8" style={{ pointerEvents: 'auto', touchAction: 'manipulation', background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
                      <CalendarIcon className="w-3.5 h-3.5" />
                      <span className="text-sm">{format(selectedDate, 'EEE MMM dd')}</span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0 z-[10001]" align="end" style={{ pointerEvents: 'auto', background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
                    <Calendar
                      mode="single"
                      selected={selectedDate}
                      onSelect={(date) => {
                        if (!date) return;
                        // Exit if clicking on already selected date
                        if (format(date, 'yyyy-MM-dd') === format(selectedDate, 'yyyy-MM-dd')) {
                          setIsCalendarOpen(false);
                          return;
                        }
                        handleDateChange(date);
                      }}
                      month={calendarMonth}
                      onMonthChange={setCalendarMonth}
                      footer={
                      <div className="px-3 pb-2 pt-1 border-t" style={{ borderColor: 'var(--border-slate-200)' }}>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                type="button"
                                onClick={() => {
                                  const today = new Date();
                                  setCalendarMonth(today);
                                  handleDateChange(today);
                                }}
                                className="w-full flex items-center justify-center gap-1 p-1.5 rounded text-xs"
                                style={{
                                  color: 'var(--text-slate-600)',
                                  '&:hover': {
                                    background: 'var(--bg-slate-100)',
                                    color: 'var(--text-slate-800)'
                                  }
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.background = 'var(--bg-slate-100)';
                                  e.currentTarget.style.color = 'var(--text-slate-800)';
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.background = 'transparent';
                                  e.currentTarget.style.color = 'var(--text-slate-600)';
                                }}>
                                  <Clock className="w-3 h-3" />
                                  Today
                                </button>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>Go to today</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
                      } className="rdp p-3" style={{ color: 'var(--text-slate-900)' }} />

                  </PopoverContent>
                </Popover>

                <Button
                  onClick={() => {
                    setEditingDelivery(null);
                    setShowDeliveryForm(true);
                  }}
                  size="sm"
                  className={`h-8 w-8 p-0 transition-colors ${hasRateLimitError ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-500 hover:bg-emerald-600'}`}
                  disabled={isDateFinished}
                  title={hasRateLimitError ? 'Rate limit detected - please wait' : 'Add delivery'}>
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 flex-wrap">
                <StatBadge
                  icon={Package}
                  value={stats.total}
                  driverCount={isDispatcher ? stats.totalDrivers : (isDriver && stats.totalPickups > 0 ? stats.totalPickups : undefined)}
                  color="blue"
                  label="Total"
                  tooltip={tooltipValues.total} />
                <StatBadge
                  icon={Truck}
                  value={stats.inTransit}
                  driverCount={isDispatcher ? stats.inTransitDrivers : (isDriver && stats.inTransitPickups > 0 ? stats.inTransitPickups : undefined)}
                  color="purple"
                  label="In Transit"
                  tooltip={tooltipValues.inTransit} />
                <StatBadge
                  icon={CheckCircle}
                  value={stats.completed}
                  driverCount={isDispatcher ? stats.completedDrivers : (isDriver && stats.completedPickups > 0 ? stats.completedPickups : undefined)}
                  color="green"
                  label="Completed"
                  tooltip={tooltipValues.completed} />
                <StatBadge
                  icon={XCircle}
                  value={`${stats.failed}/${stats.returned}`}
                  color="red"
                  label="Failed/Returned"
                  tooltip={tooltipValues.failed} />
              </div>

              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsExpanded(!isExpanded);
                }}
                className="h-8 w-8 p-0 flex-shrink-0">
                {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </Button>
            </div>


            <AnimatePresence>
              {isExpanded &&
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden">
                  <div className="mt-2 pt-2 border-t flex items-center gap-2" style={{ borderColor: 'var(--border-slate-200)' }}>
                    <Select
                    value={selectedDriverId}
                    onValueChange={handleDriverChange}
                    disabled={isDriverDropdownDisabled}>

                      <SelectTrigger className="flex h-8 w-full items-center justify-between rounded-md border px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1 flex-1" style={{ pointerEvents: 'auto', touchAction: 'manipulation', background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                        <SelectValue placeholder="All Drivers" />
                      </SelectTrigger>
                      <SelectContent className="z-[10001]" style={{ pointerEvents: 'auto', background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
                        <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Drivers</SelectItem>
                        {driversList.map((driver) =>
                      <SelectItem key={driver.id} value={driver.id} style={{ color: driver._hasDispatcherStoreDeliveries ? '#047857' : 'var(--text-slate-900)', fontWeight: driver._hasDispatcherStoreDeliveries ? '700' : '400' }}>
                            {driver.user_name || driver.full_name}
                          </SelectItem>
                      )}
                      </SelectContent>
                    </Select>

                    {/* Show All Drivers Checkbox - Only for drivers in single driver mode */}
                    {isDriver && !isAllDriversMode && (
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <Checkbox
                          id="show-all-drivers"
                          checked={showAllDriverMarkers}
                          onCheckedChange={(checked) => {
                            setShowAllDriverMarkers(checked);
                            localStorage.setItem('rxdeliver_show_all_driver_markers', String(checked));
                            
                            // CRITICAL: Re-trigger FAB phase 1 to re-fit bounds with/without other drivers' markers
                            // Delay activation to allow state to propagate, then unlock after 500ms
                            if (mapViewPhase === 1) {
                              // Clear any existing timers
                              if (mapLockTimeoutRef.current) {
                                clearTimeout(mapLockTimeoutRef.current);
                                mapLockTimeoutRef.current = null;
                              }
                              mapLockExpiresAtRef.current = null;
                              
                              // Delay FAB activation by 300ms to allow markers to update
                              setTimeout(() => {
                                setIsMapViewLocked(true);
                                lastProgrammaticMapMoveRef.current = Date.now();
                                window._lastProgrammaticMapMove = Date.now();
                                setMapViewTrigger((prev) => prev + 1);
                                
                                // Auto-unlock after 500ms
                                const lockDuration = 500;
                                const expiresAt = Date.now() + lockDuration;
                                mapLockExpiresAtRef.current = expiresAt;
                                mapLockTimeoutRef.current = setTimeout(() => {
                                  if (mapLockExpiresAtRef.current === expiresAt) {
                                    setIsMapViewLocked(false);
                                    mapLockExpiresAtRef.current = null;
                                    mapLockTimeoutRef.current = null;
                                  }
                                }, lockDuration);
                              }, 300);
                            }
                          }}
                          className="h-4 w-4"
                        />
                        <label
                          htmlFor="show-all-drivers"
                          className="text-[10px] leading-tight cursor-pointer"
                          style={{ color: 'var(--text-slate-600)' }}
                        >
                          Show<br />All
                        </label>
                      </div>
                    )}

                    <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowOptimizationSettings(true)}
                    className="h-8 w-8 p-0 flex-shrink-0"
                    title="Route Optimization Settings"
                    style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                      <Settings className="w-3.5 h-3.5" />
                    </Button>

                  {/* Quick Route Adjustments - Driver Mobile Only */}
                  {/*isMobile && */}
                  {isDriver && selectedDriverId === currentUser?.id &&
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowQuickAdjustments(true)}
                    className="h-8 gap-1.5 px-2 flex-shrink-0"
                    title="Quick route adjustments"
                    style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                      {/*<ArrowUp className="w-3 h-3" />
                      <ArrowDown className="w-3 h-3" />*/}
                      <span className="text-xs">Adjust</span>
                    </Button>
                  }

                    <Button
                    variant="default"
                    size="sm"
                    onClick={() => {
                      setShowRoutes(!showRoutes);
                      setIsExpanded(false);
                    }}
                    className="gap-2 h-8 flex-shrink-0 bg-emerald-600 hover:bg-emerald-700 text-white">
                      <Truck className="w-3.5 h-3.5" />
                      {showRoutes ? 'Hide' : 'Show'}
                    </Button>
                  </div>

                  {shouldShowLocationToggle &&
                <>
                      <div className="border-t border-slate-200 mt-2 pt-2"></div>
                      <div className="flex items-center gap-2">
                        <LocationTrackingToggle
                      user={currentUser}
                      onToggle={async () => {
                        await refreshUser();
                      }} />
                      </div>
                    </>
                }

                  {/* Mobile: Offline Sync Indicator in expanded section */}
                  {isMobile &&
                <>
                      <div className="border-t border-slate-200 mt-2 pt-2"></div>
                      <DashboardOfflineSync currentUser={currentUser} dailyPolylineCount={dailyPolylineCount} isExpanded={isExpanded} />
                    </>
                }
                </motion.div>
              }
                </AnimatePresence>
          </motion.div>

          {/* Driver Legend - positioned directly below stats card */}
          {isAllDriversMode && driverRoutes.length > 0 &&
          <div className="backdrop-blur-sm rounded-lg shadow-lg border px-2 py-2" style={{ background: 'var(--bg-white)', opacity: 0.95, borderColor: 'var(--border-slate-200)' }}
            onMouseEnter={() => handleCardInteraction(true)}
            onMouseLeave={() => handleCardInteraction(false)}>
              <div className="flex flex-wrap gap-x-2 gap-y-1.5 items-center justify-center">
                {driverRoutes.map((route) =>
              <div
                key={route.driverId}
                className="flex items-center gap-1.5">

                      <div
                  className="w-3 h-3 rounded-full border-2 border-white shadow-sm flex-shrink-0"
                  style={{ backgroundColor: route.color }} />

                      <span className="text-xs font-medium whitespace-nowrap" style={{ color: 'var(--text-slate-700)' }}>
                        {route.driverName}
                      </span>
                      <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                        ({route.stops.length})
                      </span>
                    </div>
              )}
              </div>
            </div>
          }
        </div>
      </div>

      <div className="flex-1 w-full relative min-h-0 overflow-hidden">
        {/* Polyline API hits badge - App Owner only - positioned above stop cards like FAB but on left */}
        {currentUser && isAppOwner(currentUser) &&
        <div
          className="absolute left-4 z-[140]"
          style={{
            bottom: `${deliveriesWithStopOrder.length > 0 && stopCardsBaseHeight > 0 ? stopCardsBaseHeight + 15 : 25}px`
          }}>
            <div className="px-2 py-1 text-xs font-medium rounded-lg border" style={{ background: 'transparent', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-600)' }}>
              🛣️ {dailyPolylineCount ?? '...'}
            </div>
          </div>
        }

        {/* Desktop: Offline Sync Indicator */}
        {!isMobile && <DashboardOfflineSync currentUser={currentUser} dailyPolylineCount={dailyPolylineCount} isExpanded={isExpanded} />}

        {/* Real-time ETA Tracker */}
        {realTimeETAEnabled && selectedDriverId && selectedDriverId !== 'all' &&
        <ETATracker
          selectedDriverId={selectedDriverId}
          selectedDate={selectedDateStr}
          currentUser={currentUser}
          isActive={!showDeliveryForm && !showPatientForm && !showOptimizationSettings}
          onETAUpdate={(updates) => {
          }} />

        }

        {/* Real-time Route Optimizer */}
        <RealTimeRouteOptimizer
          selectedDriverId={selectedDriverId}
          selectedDate={selectedDateStr}
          currentUser={currentUser}
          isActive={!showDeliveryForm && !showPatientForm && !showOptimizationSettings}
          onRouteOptimized={(updates) => {
            console.log('🔄 Route optimization updates:', updates);
          }} />


        {/* ETA Change Notifications */}
        <ETANotification
          deliveries={filteredDeliveries}
          driverId={selectedDriverId} />


        <div className="absolute inset-0">
          <DeliveryMap
            deliveries={deliveriesWithStopOrder}
            selectedDriverId={selectedDriverId}
            selectedDate={format(selectedDate, 'yyyy-MM-dd')}
            patients={patients}
            stores={stores}
            users={drivers}
            currentUser={currentUser}
            driverLocations={isAllDriversMode ? [] : (showAllDriverMarkers ? allDriverLocations : [])}
            showOtherDriverDeliveries={showAllDriverMarkers}
            currentDriverLocation={driverLocation}
            currentToNextPolyline={currentToNextPolyline}
            center={mapCenter}
            zoom={mapZoom}
            shouldFitBounds={shouldFitBounds}
            onBoundsFitted={() => setShouldFitBounds(null)}
            onMarkerClick={handleMarkerClick}
            mapMode={mapMode}
            onMapModeChange={setMapMode}
            autoFitBounds={true}
            showRoutes={showRoutes}
            showLegend={false}
            areCardsVisible={areCardsVisible}
            onLegendInteraction={handleCardInteraction}
            googleApiKey={googleApiKey}
            onDriverRoutesCalculated={setDriverRoutes}
            onMapInteraction={handleMapInteraction}
            onDoubleTap={handleMapViewCycle}
            retractClustersRef={retractClustersRef}
            areStopCardsVisible={deliveriesWithStopOrder.length > 0}
            highlightedDeliveryId={highlightedCardId}
            stopCardsHeight={stopCardsBaseHeight}
            onMapReady={() => {
              // CRITICAL: Mark map rendering complete (Sequence 3-6 done)
              if (!renderSequence.mapMarkers) {
                setRenderSequence((prev) => ({
                  ...prev,
                  mapMarkers: true,
                  routeLines: true,
                  driverLiveLocation: true,
                  sharedLocations: true
                }));
              }
            }} />
        </div>

        <div
          ref={stopCardsContainerRef}
          className="horizontal-cards-container absolute bottom-0 left-0 right-0 z-[150] px-4 pb-1 pointer-events-none flex flex-col justify-end min-h-[145px] max-h-[80vh]"
          onClick={() => {
            if (retractClustersRef.current) {
              retractClustersRef.current();
            }
          }}>
          <div
            className="overflow-x-auto overflow-y-visible scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent pointer-events-auto"
            style={isMobile ? { scrollSnapType: 'x mandatory' } : {}}
            onWheel={(e) => {
              e.currentTarget.scrollLeft += e.deltaY;
            }}
            onTouchStart={() => {
              // Disable proximity snap when user starts scrolling cards
              lastUserInteractionRef.current = Date.now();
            }}
            onScroll={(e) => {
              if (!isMobile) return;

              // Debounce the scroll snap
              const container = e.currentTarget;
              if (container._scrollTimeout) {
                clearTimeout(container._scrollTimeout);
              }

              container._scrollTimeout = setTimeout(() => {
                const containerRect = container.getBoundingClientRect();
                const containerCenter = containerRect.left + containerRect.width / 2;

                // Find the card closest to center
                const cards = container.querySelectorAll('[id^="stop-card-"]');
                let closestCard = null;
                let closestDistance = Infinity;

                cards.forEach((card) => {
                  const cardRect = card.getBoundingClientRect();
                  const cardCenter = cardRect.left + cardRect.width / 2;
                  const distance = Math.abs(cardCenter - containerCenter);

                  if (distance < closestDistance) {
                    closestDistance = closestDistance;
                    closestCard = card;
                  }
                });

                // Only snap if card is more than 30px off center
                if (closestCard && closestDistance > 30) {
                  closestCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                }
              }, 150);
            }}>

            <HorizontalStopCards
              pickupCards={deliveriesWithStopOrder.
              filter((delivery) => delivery && delivery.status !== 'pending') // Hide pending deliveries from cards
              .map((delivery) => {
                if (!delivery) return delivery;

                // For pickups with status 'en_route', attach pending deliveries
                if (!delivery.patient_id && delivery.status === 'en_route' && delivery.stop_id) {
                  // CRITICAL: Match by stop_id (not puid) - pending deliveries have puid that matches pickup's stop_id
                  const pendingDeliveriesForPickup = deliveriesWithStopOrder.filter((d) =>
                  d &&
                  d.puid === delivery.stop_id &&
                  d.status === 'pending' &&
                  d.patient_id // Only patient deliveries, not other pickups
                  );

                  if (pendingDeliveriesForPickup.length > 0) {
                    return {
                      ...delivery,
                      projected_deliveries: pendingDeliveriesForPickup
                    };
                  }
                }

                // CRITICAL: For dispatchers, mark deliveries from other stores as stripped
                // This shows them as simplified cards so dispatchers can see the full driver route
                if (isDispatcher && currentUser.store_ids && currentUser.store_ids.length > 0) {
                  if (!currentUser.store_ids.includes(delivery.store_id)) {
                    return {
                      ...delivery,
                      _isStripped: true
                    };
                  }
                }

                // CRITICAL: For drivers, mark all deliveries as stripped when route is complete
                if (isDriver && !isDispatcher && !isAdmin) {
                  const finishedStatuses = ['completed', 'failed', 'cancelled'];
                  const allDriverDeliveries = deliveriesWithStopOrder.filter((d) =>
                  d && d.driver_id === currentUser.id
                  );

                  // Helper to detect returns by markers
                  const checkIsReturn = (d) => {
                    if (!d || d.patient_id) return false;
                    const patient = patients.find((p) => p && p.id === d.patient_id);
                    const notes = d.delivery_notes || '';
                    const patientName = d.patient_name || '';
                    const patientFullName = patient?.full_name || '';
                    return notes.toLowerCase().includes('(rtn)') ||
                    patientName.toLowerCase().includes('(rtn)') ||
                    patientFullName.toLowerCase().includes('(rtn)') ||
                    /\breturn\b/i.test(notes) ||
                    /\breturn\b/i.test(patientName) ||
                    /\breturn\b/i.test(patientFullName);
                  };

                  const routeComplete = allDriverDeliveries.length > 0 &&
                  allDriverDeliveries.every((d) => finishedStatuses.includes(d.status) || checkIsReturn(d));

                  if (routeComplete) {
                    return {
                      ...delivery,
                      _isStripped: true
                    };
                  }
                }

                return delivery;
              })}
              onCardClick={handleCardClick}
              selectedCardId={selectedCardId}
              stores={stores}
              drivers={drivers}
              patients={patients}
              currentUser={currentUser}
              onSelectionChange={() => flushSync(() => {})}
              selectedDeliveryIds={{}}
              stopOrder={{}}
              showDriverName={isAllDriversMode}
              getDriverColor={getDriverColor}
              onEditDelivery={handleEditDelivery}
              onEditPatient={handleEditPatient}
              onDeleteDelivery={handleDeleteDelivery}
              onRestart={handleRestartDelivery}
              onStatusUpdate={handleStatusUpdate}
              onNotesUpdate={handleNotesUpdate}
              onCODUpdate={handleCODUpdate}
              onCreateReturn={handleCreateReturn}
              onStartDelivery={handleStartDelivery}
              allDeliveries={deliveries}
              selectedDate={selectedDate}
              onDriverStatusChange={async (newStatus) => {
                await refreshUser();
              }} />

          </div>
        </div>
      </div>

      <AnimatePresence>
        {showDeliveryForm &&
        <DeliveryForm
          delivery={editingDelivery}
          patients={patients}
          stores={stores}
          drivers={drivers}
          onSave={handleSaveDelivery}
          onCancel={() => {
            setShowDeliveryForm(false);
            setEditingDelivery(null);
          }}
          suggestedDate={format(selectedDate, 'yyyy-MM-dd')}
          currentUser={currentUser}
          allDeliveries={deliveries}
          onCreatePatient={handleCreatePatientFromDelivery} />
        }
      </AnimatePresence>

      <AnimatePresence>
        {showPatientForm &&
        <PatientForm
          patient={editingPatient}
          stores={stores}
          cities={[]}
          currentUser={currentUser}
          allPatients={patients}
          onSave={handleSavePatient}
          onCancel={() => {
            setShowPatientForm(false);
            setEditingPatient(null);
            setPatientFormCallback(null);
          }}
          returnPatientOnSave={!!patientFormCallback} />

        }
      </AnimatePresence>

      <Dialog open={showOptimizationSettings} onOpenChange={setShowOptimizationSettings}>
        <DialogContent className="max-w-2xl max-h-[90vh] p-0 z-[10000]">
          <RouteOptimizationSettings
            onClose={() => setShowOptimizationSettings(false)}
            currentUser={currentUser} />

        </DialogContent>
      </Dialog>

      <AnimatePresence>
        {showAIAssistant && isAIEnabled && userHasRole(currentUser, 'driver') &&
        <AIDriverAssistant
          currentUser={currentUser}
          deliveries={filteredDeliveries}
          patients={patients}
          stores={stores}
          drivers={drivers}
          currentLocation={driverLocation}
          selectedDate={selectedDate}
          onClose={() => setShowAIAssistant(false)} />

        }
      </AnimatePresence>

      {(isDriver || isDispatcher) && (deliveriesWithStopOrder.length === 0 || stopCardsBaseHeight > 0) &&
      <>
        <MapViewCycleFAB
          onClick={handleMapViewCycle}
          currentPhase={mapViewPhase}
          hasVisibleCards={deliveriesWithStopOrder.length > 0}
          isAIVisible={showAIAssistant && isAIEnabled}
          isLocked={isMapViewLocked}
          stopCardsHeight={stopCardsBaseHeight} />

        {/* Re-optimize Route FAB - Only for drivers viewing their own route */}
        {isDriver && selectedDriverId === currentUser?.id && selectedDriverId !== 'all' &&
        <motion.div
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0, opacity: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 20 }}
          className="fixed z-[140]"
          style={{
            bottom: `${deliveriesWithStopOrder.length > 0 && stopCardsBaseHeight > 0 ? stopCardsBaseHeight + 15 : 25}px`,
            right: '64px' // Position to the left of MapViewCycleFAB
          }}>
            <Button
            onClick={async () => {
              if (isReoptimizing) return;

              setIsReoptimizing(true);
              setOptimizationMessage('Re-optimizing route with Google Maps...');

              // STEP 0: Unlock FAB if it's on phase 2 (permanently locked)
              if (mapViewPhase === 2 && isMapViewLocked) {
                if (mapLockTimeoutRef.current) {
                  clearTimeout(mapLockTimeoutRef.current);
                  mapLockTimeoutRef.current = null;
                }
                mapLockExpiresAtRef.current = null;
                setIsMapViewLocked(false);
              }

              // STEP 1: Zoom out to show all incomplete/pending stops
              const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
              const incompleteStops = deliveriesWithStopOrder.filter((d) =>
              d && !finishedStatuses.includes(d.status)
              );

              if (incompleteStops.length > 0) {
                const allCoordinates = [];

                // Add driver's current location if available
                if (driverLocation?.latitude && driverLocation?.longitude) {
                  allCoordinates.push([driverLocation.latitude, driverLocation.longitude]);
                }

                // Add driver's home location
                if (currentUser?.home_latitude && currentUser?.home_longitude) {
                  allCoordinates.push([currentUser.home_latitude, currentUser.home_longitude]);
                }

                // Add all incomplete stop coordinates
                incompleteStops.forEach((stop) => {
                  if (stop.patient_id) {
                    const patient = patients.find((p) => p && p.id === stop.patient_id);
                    if (patient?.latitude && patient?.longitude) {
                      allCoordinates.push([patient.latitude, patient.longitude]);
                    }
                  } else if (stop.store_id) {
                    const store = stores.find((s) => s && s.id === stop.store_id);
                    if (store?.latitude && store?.longitude) {
                      allCoordinates.push([store.latitude, store.longitude]);
                    }
                  }
                });

                if (allCoordinates.length > 0) {
                  const padding = getMapPadding(false);
                  setShouldFitBounds({
                    bounds: allCoordinates,
                    options: {
                      ...padding,
                      maxZoom: 14,
                      animate: true
                    }
                  });
                  setMapCenter(null);
                  setMapZoom(null);
                }
              }

              try {
                const deliveryDate = format(selectedDate, 'yyyy-MM-dd');

                const response = await base44.functions.invoke('reoptimizeFullRoute', {
                  driverId: currentUser.id,
                  deliveryDate: deliveryDate
                });

                const data = response?.data || response;

                if (data?.success) {
                  setOptimizationMessage(`Route optimized! ${data.optimizedCount} stops updated.`);

                  // Refresh data to show new order
                  invalidateDeliveriesForDate(deliveryDate);
                  await refreshData();

                  // Trigger map view update
                  setIsMapViewLocked(true);
                  setMapViewTrigger((prev) => prev + 1);

                  setTimeout(() => {
                    setOptimizationMessage(null);
                    setIsMapViewLocked(false);
                  }, 3000);
                } else {
                  setOptimizationMessage(data?.error || 'Optimization failed');
                  setTimeout(() => setOptimizationMessage(null), 5000);
                }
              } catch (error) {
                console.error('❌ [ReoptimizeRoute] Error:', error);
                setOptimizationMessage(`Error: ${error.message}`);
                setTimeout(() => setOptimizationMessage(null), 5000);
              } finally {
                setIsReoptimizing(false);
              }
            }}
            disabled={isReoptimizing || isDateFinished || !filteredDeliveries.some((d) => d && d.status === 'in_transit')}
            title="Re-optimize entire route using Google Maps"
            className={`inline-flex items-center justify-center whitespace-nowrap text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 text-primary-foreground h-10 w-10 rounded-lg shadow-2xl p-0 relative transition-all duration-200 ${
            isReoptimizing ?
            'bg-amber-500 hover:bg-amber-600' :
            'bg-emerald-600 hover:bg-emerald-700'}`
            }
            style={{ pointerEvents: 'auto', touchAction: 'manipulation' }}>
              {isReoptimizing ?
            <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" /> :

            <Navigation className="w-5 h-5 text-white" />
            }
            </Button>
          </motion.div>
        }
      </>
      }

      <AnimatePresence>
        {showRouteSummary &&
        <RouteSummaryModal
          deliveries={filteredDeliveries}
          patients={patients}
          stores={stores}
          driver={summaryDriver || currentUser}
          onClose={() => {
            setShowRouteSummary(false);
            setSummaryDriver(null);
          }} />
        }
      </AnimatePresence>

      <RouteNotification
        notification={routeNotification}
        onDismiss={() => setRouteNotification(null)}
        onNavigate={() => {
          // Navigate to next stop when notification is clicked
          const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
          const nextIncomplete = deliveriesWithStopOrder.find((d) =>
          d && d.isNextDelivery && !finishedStatuses.includes(d.status)
          );
          if (nextIncomplete) {
            const cardElement = document.getElementById(`stop-card-${nextIncomplete.id}`);
            if (cardElement) {
              cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            }
          }
        }} />


      {/* Proactive Alert System - monitors route for potential issues */}
      {isDriver && isAIEnabled &&
      <ProactiveAlertSystem
        currentUser={currentUser}
        deliveries={filteredDeliveries}
        patients={patients}
        stores={stores}
        driverLocation={driverLocation}
        isEnabled={isAIEnabled}
        onAlert={(alerts) => {
        }} />

      }

      {/* Quick Route Adjustments Dialog */}
      {isMobile && isDriver &&
      <Dialog open={showQuickAdjustments} onOpenChange={setShowQuickAdjustments}>
          <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto z-[10001]">
            <DialogHeader>
              <DialogTitle>Quick Route Adjustments</DialogTitle>
            </DialogHeader>
            
            {deliveriesWithStopOrder.filter((d) =>
          d && !['completed', 'failed', 'cancelled', 'returned', 'pending'].includes(d.status) &&
          d.driver_id === currentUser?.id
          ).length === 0 ?
          <p className="text-sm text-slate-500 py-4">No active stops to adjust</p> :

          <QuickRouteAdjustments
            deliveries={deliveriesWithStopOrder}
            currentUser={currentUser}
            patients={patients}
            stores={stores}
            onReorder={handleQuickReorder}
            onAddDelay={handleAddDelay} />

          }
          </DialogContent>
        </Dialog>
      }
    </div>);

}

async function geocodeAddress(address) {
  if (!address) return null;

  try {
    const response = await base44.functions.invoke('getGoogleMapsKey');
    const apiKey = response.data?.apiKey;

    if (!apiKey) {
      console.error('❌ [Geocoding] Google Maps API key not configured');
      return null;
    }

    const encodedAddress = encodeURIComponent(address);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodedAddress}&key=${apiKey}`;

    const geoResponse = await fetch(url);
    const data = await geoResponse.json();

    if (data.status === 'OK' && data.results && Array.isArray(data.results) && data.results.length > 0) {// Defensive check
      const location = data.results[0].geometry.location;
      return { lat: location.lat, lon: location.lng };
    } else {
      return null;
    }
  } catch (error) {
    console.error('Error geocoding:', error);
    return null;
  }
}

export default Dashboard;