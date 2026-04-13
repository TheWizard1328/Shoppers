import { useState, useEffect, useMemo, useCallback, useRef } from "react";
const getEdmDate = () => {const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}-${p.find((x) => x.type === 'day').value}`;};
import { base44 } from "@/api/base44Client";
import { useDashboardPolylineMaintenance } from "@/components/dashboard/useDashboardPolylineMaintenance";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import AddDeliveryButton from "@/components/dashboard/AddDeliveryButton";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Calendar as CalendarIcon, Clock, Truck, CheckCircle, XCircle, Package, Plus, ChevronUp, ChevronDown, RotateCcw as RefreshIcon, Phone, MapPin, X, Settings, Bot, Sparkles, Navigation, Bell, BellOff, Mailbox, ArrowUp, ArrowDown, Binoculars, LocateFixed } from "lucide-react";
import { format, startOfDay } from 'date-fns';
import { getData, invalidate, loadPriorityDeliveriesForSelection } from "@/components/utils/dataManager";
import { offlineDB } from "@/components/utils/offlineDatabase";
import { offlineFirstManager } from "@/components/utils/offlineFirstManager";
import MapSection from "@/components/dashboard/MapSection";
import SnapshotTimeline from "@/components/snapshot/SnapshotTimeline";
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
import { liveDistanceTracker } from "@/components/utils/liveDistanceTracker";
import LocationTrackingToggle from "@/components/layout/LocationTrackingToggle";
import DriverRouteControls from '@/components/dashboard/DriverRouteControls';
import { globalFilters } from "@/components/utils/globalFilters";
import { getDriverNameForComparison } from '@/components/utils/driverUtils';
import { userHasRole, isAppOwner } from '@/components/utils/userRoles';
import { useUser } from '@/components/utils/UserContext';
import { useAppData } from '@/components/utils/AppDataContext';
import { optimizeRoute, calculateRouteStats } from '@/components/utils/routeOptimizer';
import { determineAMPMFromTime } from '@/components/utils/ampmUtils';
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
import { loadBreadcrumbsForDriver } from "@/components/utils/breadcrumbsManager";
import { fabControlEvents } from "@/components/utils/fabControlEvents";
import {
  notifyDriverStarted,
  notifyDriverCompleted,
  notifyDriverFailed,
  notifyDriverRetry,
  notifyDriverReturn,
  getDispatchersForStore } from
"@/components/utils/deliveryMessaging";
import { createStopCardsScrollHandler } from "@/components/dashboard/StopCardsScrollHandler";
import { getNextTrackingNumberInGroup } from "@/components/common/stopCardActionHelpers";
import { buildReturnDeliveryData } from "@/components/utils/returnDeliveryBuilder";
import RouteNotification from "@/components/dashboard/RouteNotification";
import ProactiveAlertSystem from "@/components/dashboard/ProactiveAlertSystem";
import SmartRefreshIndicator from "@/components/layout/SmartRefreshIndicator";
import { offlineManager } from "@/components/utils/offlineManager";
import { offlineDeliveryManager } from "@/components/utils/offlineDeliveryManager";
import ConnectionIndicator from "@/components/dashboard/ConnectionIndicator";
import ErrorFlagIndicator from "@/components/dashboard/ErrorFlagIndicator";
// import OfflineIndicator from "@/components/dashboard/OfflineIndicator";
// import OfflineSyncIndicator from '@/components/layout/OfflineSyncIndicator';
import DashboardOfflineSync from '@/components/dashboard/DashboardOfflineSync';
import ExpandedStatsControls from '@/components/dashboard/ExpandedStatsControls';
import QuickRouteAdjustments from '../components/dashboard/QuickRouteAdjustments';
import { driverActivityMonitor } from '@/components/utils/driverActivityMonitor';
import SmartPrioritizationPanel from '../components/dashboard/SmartPrioritizationPanel';
import ActivePayStats from '../components/dashboard/ActivePayStats';
import EndOfDayStatsDialog from '../components/dashboard/EndOfDayStatsDialog';
import { toast } from 'sonner';
import PullToSync from '../components/dashboard/PullToSync';
import BreadcrumbToggleButton from '@/components/dashboard/BreadcrumbToggleButton';
import DriverLocationBadge from '../components/dashboard/DriverLocationBadge';
import ApiUsageBadge from '@/components/dashboard/ApiUsageBadge';
import RouteActionButtons from '@/components/dashboard/RouteActionButtons';
import DispatcherPickupNotification from '../components/dashboard/DispatcherPickupNotification';
import ReconcileToast from '../components/dashboard/ReconcileToast';
import { useLocalPerformanceStats } from "@/components/dashboard/useLocalPerformanceStats";
import { StatBadge, calculateDistance, generateUniqueSID, addMinutesToTime, roundCompletionTime, populateTemporaryStartTimes } from "@/components/dashboard/DashboardHelpers";import { shouldRefreshUserFromAppUser } from "@/components/utils/appUserRefreshUtils";
import { saveDriverChangedDelivery } from "@/components/utils/saveDriverChangedDelivery";
import { getFabTargetDriverMapLocation, isDriverOffDuty, getSelfDriverLocationForBounds } from "@/components/dashboard/mapViewPhaseHelpers";
import { centerDeliveryCard, centerNextDeliveryCard, getNextDeliveryCard } from '@/components/utils/deliveryCardUtils';
import { loadDashboardOfflineDateData, mergeDeliveriesForDate, hasDeliveryDataForSelection } from '@/components/dashboard/dashboardInitialLoadHelpers';

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
    updateAppUsersLocally, applyDeliveryChangesLocally, applyAppUserChangesLocally, applyPatientChangesLocally,
    forceRefreshDriverDeliveries,
    setIsFormOverlayOpen,
    setIsEntityUpdating,
    setOnSmartRefreshComplete,
    dataReadyForSelectedDate,
    isSnapshotModeActive,
    setIsSnapshotModeActive,
    dataSource
  } = useAppData();

  const isDispatcher = currentUser ? userHasRole(currentUser, 'dispatcher') : false;

  const [selectedDate, setSelectedDate] = useState(() => {
    // CRITICAL: Check URL params first, then globalFilters
    const urlParams = new URLSearchParams(window.location.search);
    const dateParam = urlParams.get('date');

    if (dateParam) {
      return new Date(dateParam + 'T00:00:00');
    }

    // Check saved date
    const saved = globalFilters.getSelectedDate();
    const savedDate = typeof saved === 'string' && saved ? new Date(saved + 'T00:00:00') : null;

    return savedDate || new Date();
  });

  // Track if this is initial page load (not refresh)
  const isInitialPageLoadRef = useRef(true);
  const [selectedDriverId, setSelectedDriverId] = useState(() => new URLSearchParams(window.location.search).get('driver') || globalFilters.getSelectedDriverId() || 'all');
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
  const [patientFormMode, setPatientFormMode] = useState(null); // 'duplicate' | 'newAddress' | null
  const [calendarMonth, setCalendarMonth] = useState(selectedDate);
  const [mapViewPhase, setMapViewPhase] = useState(1); // Will be loaded from user settings
  const [userSettingsLoaded, setUserSettingsLoaded] = useState(false);
  const [initialMapViewApplied, setInitialMapViewApplied] = useState(false);

  // CRITICAL: Render sequence tracking for proper initialization order
  // 1=StatsCard&StopCards, 2=FABs, 3=MapMarkers, 4=RouteLines, 5=DriverLiveLocation, 6=SharedLocations, 7=FullDeliveriesLoaded, 8=FABPhaseActive
  const [renderSequence, setRenderSequence] = useState({
    statsAndCards: false,
    fabs: false,
    mapMarkers: false,
    routeLines: false,
    driverLiveLocation: false,
    sharedLocations: false,
    fullDeliveriesLoaded: false,
    fabPhaseReady: false
  });
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
  const horizontalStopCardsRef = useRef(null); // Direct ref to HorizontalStopCards component

  const mapLockTimeoutRef = useRef(null);
  const mapLockExpiresAtRef = useRef(null); // Timestamp when lock should expire
  const [useAIOptimization, setUseAIOptimization] = useState(true);
  const [driverRoutes, setDriverRoutes] = useState([]);
  const proximityLockedMarkersRef = useRef(new Set()); // Track which markers have been proximity-locked
  const lastProximitySnapTimeRef = useRef(0); // Timestamp of last proximity snap
  const lastUserInteractionRef = useRef(0); // Timestamp of last user interaction (map/card)

  const [highlightedCardId, setHighlightedCardId] = useState(null);
  const [currentToNextPolyline, setCurrentToNextPolyline] = useState(null);
  const [hasRateLimitError, setHasRateLimitError] = useState(false);
  const [realTimeETAEnabled, setRealTimeETAEnabled] = useState(true);
  const [isReoptimizing, setIsReoptimizing] = useState(false);
  const [showQuickAdjustments, setShowQuickAdjustments] = useState(false);
  const cardExpandedAtRef = useRef(null);
  const [showAllDriverMarkers, setShowAllDriverMarkers] = useState(false);
  const [showSmartPrioritization, setShowSmartPrioritization] = useState(false);
  const [showBreadcrumbs, setShowBreadcrumbs] = useState(false);
  const [preferredTravelMode, setPreferredTravelMode] = useState('driving');
  const [breadcrumbsData, setBreadcrumbsData] = useState({ historical: [], current: [] });
  const [performanceStats, setPerformanceStats] = useState(null);
  const [deliveryStats, setDeliveryStats] = useState(null);
  const [liveDistance, setLiveDistance] = useState(0); // Live accumulated distance from liveDistanceTracker
  const [liveTimeOnDuty, setLiveTimeOnDuty] = useState(null); // Live time on duty (null = use backend value)
  const [showEndOfDayStats, setShowEndOfDayStats] = useState(false);
  const [endOfDayDriver, setEndOfDayDriver] = useState(null);
  const [snapshotData, setSnapshotData] = useState(null);
  const [pullToSyncKey, setPullToSyncKey] = useState(0);
  const statusUpdateLockRef = useRef(new Set());

  const handleSnapshotSelect = (data) => {
    setSnapshotData(data || null);
  };
  const [cardsReadyForFAB, setCardsReadyForFAB] = useState(false);
  const [isLoadingPayrollStats, setIsLoadingPayrollStats] = useState(false); // dashboard-disabled: always false

  // CRITICAL: Declare isPrimaryDevice early (before useEffects that need it)
  const [isPrimaryDevice, setIsPrimaryDevice] = useState(false);

  // CRITICAL: Calculate isDriver and isAdmin early (before useEffects that need them)
  const isMobile = useMemo(() => isMobileDevice(), []);

  // Read the bottom nav height from the CSS variable set by Layout (accounts for mobile + tablet portrait)
  const bottomNavHeight = useMemo(() => {
    const val = getComputedStyle(document.documentElement).getPropertyValue('--bottom-nav-height').trim();
    if (!val || val === '0px') return 0;
    // Parse "calc(56px + ...)" → just use 56 as the base, or parse px value directly
    const match = val.match(/(\d+)px/);
    return match ? parseInt(match[1], 10) : 0;
  }, []);
  const isDriver = useMemo(() => currentUser ? userHasRole(currentUser, 'driver') : false, [currentUser]);
  const isAdmin = useMemo(() => currentUser ? userHasRole(currentUser, 'admin') : false, [currentUser]);

  // ==================== REAL-TIME SUBSCRIPTIONS ====================
  useEffect(() => {
    if (!currentUser || !isDataLoaded) return;

    const handleImmediateDeliveryUpdate = async (event) => {
      const { immediate, freshDeliveries } = event.detail || {};

      if (immediate && updateDeliveriesLocally && Array.isArray(freshDeliveries)) {
        const dedupedFresh = Array.from(new Map(freshDeliveries.filter(Boolean).map((d) => [d.id, d])).values());
        updateDeliveriesLocally(dedupedFresh, false);
      }
    };

    const handleDeliveriesImported = async (event) => {
      const { deliveries: importedDeliveries, source } = event.detail || {};
      if (!importedDeliveries || !Array.isArray(importedDeliveries)) return;

      if (updateDeliveriesLocally && deliveries) {
        const dedupedImported = Array.from(new Map(importedDeliveries.filter(Boolean).map((d) => [d.id, d])).values());
        const importedIds = new Set(dedupedImported.map((d) => d?.id).filter(Boolean));
        const otherDeliveries = deliveries.filter((d) => !importedIds.has(d?.id));
        const mergedDeliveries = [...otherDeliveries, ...dedupedImported];

        updateDeliveriesLocally(mergedDeliveries, true);
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: {
            triggeredBy: 'deliveriesImported',
            source: source
          }
        }));
      }
    };

    const handleCenterNextDeliveryCard = () => {
      centerNextDeliveryCard(deliveriesWithStopOrder);
    };

    window.addEventListener('deliveriesUpdated', handleImmediateDeliveryUpdate);
    window.addEventListener('deliveriesImported', handleDeliveriesImported);
    window.addEventListener('centerNextDeliveryCard', handleCenterNextDeliveryCard);

    return () => {
      window.removeEventListener('deliveriesUpdated', handleImmediateDeliveryUpdate);
      window.removeEventListener('deliveriesImported', handleDeliveriesImported);
      window.removeEventListener('centerNextDeliveryCard', handleCenterNextDeliveryCard);
    };
  }, [currentUser?.id, isDataLoaded, updateDeliveriesLocally, deliveries, appUsers, selectedDate]);



  // Listen for performance stats AND delivery stats updates from Layout (QuickStats)
  useEffect(() => {
    const handleDeliveryStatsUpdate = (event) => {
      setDeliveryStats(event.detail);
    };

    // CRITICAL: Listen for smart refresh AppUser updates to refresh currentUser for toggles
    const handleRefreshCurrentUser = () => {
      if (refreshUser) {
        refreshUser();
      }
    };

    // CRITICAL: Listen for manual refresh payroll stats trigger from SmartRefreshIndicator
    const handleRefreshPayrollStatsAfterSync = async () => {return;};

    // CRITICAL: Listen for live travel_dist updates
    const handleTravelDistUpdate = (event) => {
      const { deliveryId, travel_dist, totalAccumulatedDistance, completedDistance, inProgressDistance } = event.detail;
      // Update local deliveries state
      if (updateDeliveriesLocally) {
        const updatedDelivery = deliveries.find((d) => d?.id === deliveryId);
        if (updatedDelivery) {
          updateDeliveriesLocally([{ ...updatedDelivery, travel_dist }], false);
        }
      }

      // CRITICAL: Store total accumulated distance to display on stats card
      setLiveDistance(totalAccumulatedDistance);
    };

    // CRITICAL: Listen for time on duty updates
    const handleTimeOnDutyUpdate = (event) => {
      const { totalMinutes, formattedTime } = event.detail;
      // CRITICAL: Store live time on duty to display on stats card
      setLiveTimeOnDuty(formattedTime);
    };

    window.addEventListener('deliveryStatsUpdated', handleDeliveryStatsUpdate);
    window.addEventListener('travelDistUpdated', handleTravelDistUpdate);
    window.addEventListener('timeOnDutyUpdated', handleTimeOnDutyUpdate);
    window.addEventListener('refreshPayrollStatsAfterSync', handleRefreshPayrollStatsAfterSync);
    window.addEventListener('refreshCurrentUserFromSmartRefresh', handleRefreshCurrentUser);
    return () => {
      window.removeEventListener('deliveryStatsUpdated', handleDeliveryStatsUpdate);
      window.removeEventListener('travelDistUpdated', handleTravelDistUpdate);
      window.removeEventListener('timeOnDutyUpdated', handleTimeOnDutyUpdate);
      window.removeEventListener('refreshPayrollStatsAfterSync', handleRefreshPayrollStatsAfterSync);
      window.removeEventListener('refreshCurrentUserFromSmartRefresh', handleRefreshCurrentUser);
    };
  }, [deliveries, updateDeliveriesLocally, performanceStats, isDriver, isAdmin, currentUser?.id, selectedDriverId, selectedDate, refreshUser]);

  // Track previous map state for restoring when card is collapsed
  const [previousMapState, setPreviousMapState] = useState(null);

  // Track if we've done initial driver selection (prevent re-running on data changes)
  const hasSetInitialDriverDashboard = useRef(false);

  // CRITICAL: Save FAB phase when unmounting, restore when mounting
  const [savedFabPhaseOnUnmount, setSavedFabPhaseOnUnmount] = useState(() => {
    try {
      const saved = sessionStorage.getItem('rxdeliver_dashboard_fab_phase');
      if (saved) {
        const parsed = JSON.parse(saved);
        // Only restore if saved within last 2 minutes
        if (Date.now() - parsed.timestamp < 120000) {
          return parsed.phase;
        }
      }
    } catch (e) {}
    return null;
  });

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

  // Unified FAB reactivation: Phase 1 never reactivates; Phase 2/3 stay locked and trigger map update
  const reactivateFAB = useCallback((source = 'unknown') => {
    if (mapViewPhaseRef.current === 1 || userHasRole(currentUser, 'driver') && isPrimaryDevice === true && (source === 'Smart Refresh Complete' || source === 'Smart Refresh Restarted')) return;
    lastProgrammaticMapMoveRef.current = Date.now();
    window._lastProgrammaticMapMove = Date.now();
    setMapViewTrigger((prev) => prev + 1);
  }, []);

  // Check if current device is primary tracker (state declared at line 379)
  useEffect(() => {
    if (!currentUser?.id) return;

    const checkPrimaryDevice = async () => {
      try {
        const { getCurrentDevice } = await import('@/components/utils/deviceManager');
        const device = await getCurrentDevice(currentUser.id);
        const isPrimary = device === null || device?.status !== 'inactive' && device?.is_primary_tracker !== false;
        setIsPrimaryDevice(isPrimary);
      } catch (error) {
        console.warn('⚠️ [Primary Device Check] Failed - defaulting to primary:', error.message);
        setIsPrimaryDevice(true); // Default to primary on error
      }
    };

    checkPrimaryDevice();
  }, [currentUser?.id]);

  // Track dynamically measured heights for map padding
  // CRITICAL: Start at 0, will be measured once cards render
  const [stopCardsBaseHeight, setStopCardsBaseHeight] = useState(0);
  const [statsCardBaseHeight, setstatsCardBaseHeight] = useState(0);
  const measurementTimeoutRef = useRef(null);

  // Computed padding values for consistent map bounds
  // Note: paddingTopLeft = [horizontal, vertical from top]
  //       paddingBottomRight = [horizontal, vertical from bottom]

  const getMapPadding = useCallback(() => {
    const paddingBuffer = 30;
    const statsCardCurrHeight = statsCardRef.current?.offsetHeight || statsCardBaseHeight || 75;
    const baseHeight = stopCardsBaseHeight || 0;

    const topPadding = isMobile ?
    statsCardCurrHeight + paddingBuffer :
    25;

    const bottomPadding = baseHeight > 0 ? baseHeight + 10 : 25;

    return {
      paddingTopLeft: [25, topPadding],
      paddingBottomRight: [25, bottomPadding]
    };
  }, [isMobile, stopCardsBaseHeight, statsCardBaseHeight]);

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

  // CRITICAL: Auto-start location tracking for mobile drivers (independent of toggle visibility)
  // CONDITION: isMobile && isDriver && isPrimaryDevice
  // NOTE: isPrimaryDevice is set asynchronously, so this effect must re-run when it becomes true
  useEffect(() => {
    if (!isMobile || !isDriver || !currentUser?.id || !isPrimaryDevice || !isDataLoaded) return;

    const initTracking = async () => {
      // Set driver status in tracker
      const driverStatus = currentUser.driver_status || 'off_duty';
      locationTracker.setDriverStatus(driverStatus);

      // CRITICAL: Only start if this is a PRIMARY device
      if (!locationTracker.isTracking) {
        try {
          const appUsers = await base44.entities.AppUser.filter({ user_id: currentUser.id });
          const appUser = appUsers?.[0];

          if (appUser) {
            await locationTracker.startTracking({
              ...currentUser,
              appUserId: appUser.id
            }, format(selectedDate, 'yyyy-MM-dd'));

            // CRITICAL: Also start live distance tracker
            if (!liveDistanceTracker.isTracking) {
              liveDistanceTracker.start(currentUser);
              // CRITICAL: Immediately poll for current stats on mount/refresh
              setTimeout(() => {
                liveDistanceTracker.instantPoll();
              }, 1000); // Wait 1 second for data to settle
            }
          }
        } catch (error) {
          console.warn('⚠️ [Dashboard] Failed to auto-start tracking:', error.message);
        }
      }
    };

    initTracking();

    // Cleanup when unmounting or driver changes
    return () => {
      if (liveDistanceTracker.isTracking) {
        liveDistanceTracker.stop();
      }
    };
  }, [currentUser?.id, isMobile, isDriver, isPrimaryDevice, isDataLoaded]);

  // CRITICAL: Reinitialize GPS when app returns to foreground (after screen off or background)
  useEffect(() => {
    if (!isMobile || !isDriver || !isPrimaryDevice || !isDataLoaded) return;

    let wasHidden = false;

    const handleVisibilityChange = async () => {
      if (document.hidden) {
        wasHidden = true;
        return;
      }

      // App came back to foreground
      if (wasHidden) {
        wasHidden = false;

        try {
          const appUsers = await base44.entities.AppUser.filter({ user_id: currentUser.id });
          const appUser = appUsers?.[0];

          if (appUser) {
            // Check if we should be tracking
            const shouldTrack = appUser.driver_status === 'on_duty' || appUser.driver_status === 'on_break';

            if (shouldTrack && !locationTracker.isTracking) {
              await locationTracker.restartTracking({
                ...currentUser,
                appUserId: appUser.id
              }, format(selectedDate, 'yyyy-MM-dd'));
            }
          }
        } catch (error) {
          console.error('❌ [GPS Reinit] Failed to restart tracking:', error.message);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [currentUser?.id, isMobile, isDriver, isPrimaryDevice, isDataLoaded]);

  // Load user settings on mount - PHASE 1: Load backend values FIRST
  useEffect(() => {
    if (!currentUser?.id || userSettingsLoaded) return;

    const loadSettings = async () => {
      try {
        const settings = await loadUserSettings(currentUser.id);

        // CRITICAL: Load "Show All Markers" setting
        if (settings.show_all_driver_markers !== undefined) {
          setShowAllDriverMarkers(settings.show_all_driver_markers);
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

        // CRITICAL: Non-admin drivers ALWAYS see only their own route (ignore saved settings)
        if (currentUser && userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin') && !userHasRole(currentUser, 'dispatcher')) {
          driverToSelect = currentUser.id;
        }

        // Fall back to smart default based on role and store assignments
        if (!driverToSelect) {
          if (userHasRole(currentUser, 'dispatcher')) {
            driverToSelect = 'all';
          } else if (userHasRole(currentUser, 'admin')) {
            // Admins - use saved or default
            driverToSelect = settings.selected_driver_id || 'all';
          } else {
            // Other roles - use saved or default
            driverToSelect = settings.selected_driver_id || 'all';
          }
        }
        if (currentUser && userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin') && !userHasRole(currentUser, 'dispatcher') || !selectedDriverId || selectedDriverId === 'all') {setSelectedDriverId(driverToSelect);}
        if (currentUser && userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin') && !userHasRole(currentUser, 'dispatcher') || !selectedDriverId || selectedDriverId === 'all') globalFilters.setSelectedDriverId(driverToSelect);

      } catch (error) {
        console.error('❌ [Dashboard] Error loading user settings:', error);
        setUserSettingsLoaded(true);
        hasSetInitialDriverDashboard.current = true;
      }
    };

    loadSettings();
  }, [currentUser?.id, userSettingsLoaded, deliveries]);

  const isAllDriversMode = selectedDriverId === 'all';

  const filteredDeliveries = useMemo(() => {
    // SNAPSHOT MODE: Use snapshot data instead of live data
    if (isSnapshotModeActive && snapshotData?.deliveries) {
      const dateStr = format(selectedDate, 'yyyy-MM-dd');
      let result = snapshotData.deliveries.filter((d) => d && d.delivery_date === dateStr);

      // Filter by selected driver
      if (selectedDriverId && selectedDriverId !== 'all') {
        result = result.filter((d) => d.driver_id === selectedDriverId);
      }

      return result;
    }

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
    if (isDispatcher && !isAdmin && selectedDriverId === 'all') {
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

      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const sortedDeliveries = [...driverDeliveries].sort((a, b) => {
        if (!a || !b) return 0;
        const aPending = a.status === 'pending',bPending = b.status === 'pending';
        if (aPending && !bPending) return 1;
        if (!aPending && bPending) return -1;
        const aOrder = Number(a.stop_order),bOrder = Number(b.stop_order);
        const hasAOrder = Number.isFinite(aOrder) && aOrder > 0,hasBOrder = Number.isFinite(bOrder) && bOrder > 0;
        if (hasAOrder && hasBOrder && aOrder !== bOrder) return aOrder - bOrder;
        const aFinished = finishedStatuses.includes(a.status),bFinished = finishedStatuses.includes(b.status);
        if (aFinished && bFinished) {
          const timeA = a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : Number.MAX_SAFE_INTEGER;
          const timeB = b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : Number.MAX_SAFE_INTEGER;
          if (timeA !== timeB) return timeA - timeB;
        }
        const etaA = a.delivery_time_eta || a.delivery_time_start || '99:99';
        const etaB = b.delivery_time_eta || b.delivery_time_start || '99:99';
        if (etaA !== etaB) return etaA.localeCompare(etaB);
        if (hasAOrder) return -1;
        if (hasBOrder) return 1;
        return 0;
      });

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

    if (isDispatcher && !isAdmin && currentUser?.store_ids) {
      const dispatcherStoreIds = new Set(currentUser.store_ids);
      relevantDeliveries = relevantDeliveries.filter((d) => d && dispatcherStoreIds.has(d.store_id));
    }

    // CRITICAL: Separate patient deliveries from pickups for accurate counting
    const safeDeliveries = relevantDeliveries.filter((d) => d && d.patient_id);
    const allPickups = relevantDeliveries.filter((d) => d && !d.patient_id);

    if (!Array.isArray(safeDeliveries)) return {
      total: 0,
      inTransit: 0,
      enRoute: 0,
      completed: 0,
      failed: 0, returned: 0,
      totalDrivers: 0, inTransitDrivers: 0, completedDrivers: 0, totalPickups: 0
    };

    const patientMap = new Map((patients || []).filter((p) => p && p.id).map((p) => [p.id, p]));

    const isReturn = (delivery) => {
      if (!delivery || delivery.status !== 'completed') return false;
      const patient = patientMap.get(delivery.patient_id);
      const patientAddress = patient?.address || '';
      return patientAddress.toUpperCase().includes('(RTN)');
    };

    // CRITICAL: Total includes patient deliveries AND after hours pickups (all statuses)
    const afterHoursPickupsAll = allPickups.filter((d) => d && d.after_hours_pickup === true);
    const total = safeDeliveries.length + afterHoursPickupsAll.length;

    // CRITICAL: In Transit = deliveries only, En Route = pickups only
    const inTransitDeliveries = safeDeliveries.filter((d) => d && d.status === 'in_transit');
    const enRoutePickups = allPickups.filter((d) => d && d.status === 'en_route');

    const inTransit = inTransitDeliveries.length;
    const enRoute = enRoutePickups.length;

    const completedDeliveries = safeDeliveries.filter((d) => {
      if (!d || d.status !== 'completed') return false;
      if (isReturn(d)) return false;
      return true;
    });

    // CRITICAL: After Hours Pickups count as completed (completed OR cancelled status)
    // Regular pickups (no patient_id, no after_hours_pickup) do NOT count as paid deliveries
    const afterHoursPickupsCompleted = relevantDeliveries.filter((d) =>
    d && !d.patient_id && d.after_hours_pickup === true && (d.status === 'completed' || d.status === 'cancelled')
    ).length;

    const completed = completedDeliveries.length + afterHoursPickupsCompleted;

    const returned = safeDeliveries.filter(isReturn).length;
    const failed = safeDeliveries.filter((d) => {
      if (!d) return false;
      if (d.status === 'failed' && !isReturn(d)) return true;
      if (d.status === 'cancelled' && !d.patient_id) return true;
      return false;
    }).length;

    // CRITICAL: Calculate pickup counts for superscript badges
    const totalPickups = allPickups.length;
    const activePickupsEnRoute = enRoutePickups.length;

    // CRITICAL: Completed pickups count if completed > 0
    const completedPickups = completed > 0 ? allPickups.filter((d) =>
    d && (d.status === 'completed' || d.status === 'cancelled')
    ).length : 0;

    // DISPATCHER: Calculate unique driver counts for superscript (from ALL deliveries including pickups)
    let totalDrivers = 0;
    let inTransitDrivers = 0;
    let completedDrivers = 0;

    if (isDispatcher || isAdmin) {
      // CRITICAL: Count drivers from ALL deliveries (patient deliveries + pickups)
      const allDriverIds = new Set(relevantDeliveries.map((d) => d?.driver_id).filter(Boolean));
      totalDrivers = allDriverIds.size;

      // CRITICAL: Count drivers with ANY in_transit or en_route stops (patient deliveries + pickups)
      // ONLY if inTransit + enRoute > 0
      if (inTransit + enRoute > 0) {
        const inTransitAll = relevantDeliveries.filter((d) => d && (d.status === 'in_transit' || d.status === 'en_route'));
        const inTransitDriverIds = new Set(inTransitAll.map((d) => d?.driver_id).filter(Boolean));
        inTransitDrivers = inTransitDriverIds.size;
      }

      // CRITICAL: Completed drivers = drivers who have ALL their stops completed
      // ONLY count if completed > 0
      if (completed > 0) {
        const finishedStatuses = ['completed', 'failed', 'cancelled'];

        allDriverIds.forEach((driverId) => {
          const driverStops = relevantDeliveries.filter((d) => d?.driver_id === driverId);

          // CRITICAL: Only count if driver has at least one completed delivery (not just failed/cancelled)
          const hasCompletedStops = driverStops.some((d) => d && d.status === 'completed');
          const allFinished = driverStops.length > 0 &&
          driverStops.every((d) => d && finishedStatuses.includes(d.status));

          if (hasCompletedStops && allFinished) {
            completedDrivers++;
          }
        });
      }
    }

    return {
      total, inTransit, enRoute, completed, failed, returned,
      totalDrivers, inTransitDrivers, completedDrivers,
      totalPickups, activePickupsEnRoute, completedPickups
    };
  }, [filteredDeliveries, patients, isDispatcher, currentUser?.store_ids]);

  useLocalPerformanceStats({ currentUser, isDataLoaded, isDispatcher, selectedDriverId, selectedDate, filteredDeliveries, patients, appUsers, setPerformanceStats, setIsLoadingPayrollStats });

  const isDateFinished = useMemo(() => {
    const todayDate = startOfDay(new Date());
    const selected = startOfDay(selectedDate);
    const isPastDate = selected < todayDate;

    if (!isPastDate) return false;

    if (!filteredDeliveries || !Array.isArray(filteredDeliveries)) return false;

    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const allFinished = filteredDeliveries.length > 0 &&
    filteredDeliveries.every((d) => d && finishedStatuses.includes(d.status));

    return allFinished;
  }, [selectedDate, filteredDeliveries]);

  // Check if current route is complete (for stop cards fade prevention)
  const isRouteComplete = useMemo(() => {
    if (!filteredDeliveries || !Array.isArray(filteredDeliveries) || filteredDeliveries.length === 0) return false;

    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const patientDeliveriesOnly = filteredDeliveries.filter((d) => d && d.patient_id);

    const isReturn = (d) => {
      if (!d || !d.patient_id) return false;
      const patient = patients.find((p) => p && p.id === d.patient_id);
      const patientAddress = patient?.address || '';
      return patientAddress.toUpperCase().includes('(RTN)');
    };

    return patientDeliveriesOnly.length > 0 &&
    patientDeliveriesOnly.every((d) => finishedStatuses.includes(d.status) || isReturn(d));
  }, [filteredDeliveries, patients]);

  // Filter drivers based on role - NEVER based on deliveries (except dispatcher)
  const driversList = useMemo(() => {
    // CRITICAL: Build drivers from AppUsers ONLY (most reliable source)
    const driversSource = (appUsers || []).
    filter((au) => au && au.user_id && au.app_roles?.includes('driver') && au.status === 'active').
    map((au) => ({
      id: au.user_id,
      user_id: au.user_id,
      user_name: au.user_name,
      full_name: au.user_name,
      app_roles: au.app_roles,
      status: au.status,
      sort_order: au.sort_order
    })).
    sort((a, b) => {
      const sortOrderA = a.sort_order ?? Infinity;
      const sortOrderB = b.sort_order ?? Infinity;
      if (sortOrderA !== sortOrderB) return sortOrderA - sortOrderB;
      const nameA = (a.user_name || '').toLowerCase();
      const nameB = (b.user_name || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });

    // ADMIN/DRIVER: Show ALL drivers (no filtering)
    if (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver')) {
      return driversSource;
    }

    // DISPATCHER: Show drivers assigned to dispatcher's stores for selected day OR who have deliveries for dispatcher's stores on selected date
    if (userHasRole(currentUser, 'dispatcher')) {
      const dispatcherStoreIds = currentUser.store_ids || [];
      const dispatcherStores = stores?.filter((s) => s && dispatcherStoreIds.includes(s.id)) || [];

      const assignedDriverIds = new Set();

      // CRITICAL: Only add drivers assigned to slots for the selected day of the week
      const selectedDateObj = new Date(selectedDate);
      const dayOfWeek = selectedDateObj.getDay(); // 0=Sunday, 6=Saturday

      const isSaturday = dayOfWeek === 6;
      const isSunday = dayOfWeek === 0;
      const isWeekday = !isSaturday && !isSunday;

      // Add drivers assigned to store slots for THIS DAY ONLY
      dispatcherStores.forEach((store) => {
        if (isSaturday) {
          if (store.saturday_am_driver_id) assignedDriverIds.add(store.saturday_am_driver_id);
          if (store.saturday_pm_driver_id) assignedDriverIds.add(store.saturday_pm_driver_id);
        } else if (isSunday) {
          if (store.sunday_am_driver_id) assignedDriverIds.add(store.sunday_am_driver_id);
          if (store.sunday_pm_driver_id) assignedDriverIds.add(store.sunday_pm_driver_id);
        } else {
          // Weekday
          if (store.weekday_am_driver_id) assignedDriverIds.add(store.weekday_am_driver_id);
          if (store.weekday_pm_driver_id) assignedDriverIds.add(store.weekday_pm_driver_id);
        }
      });

      // CRITICAL: Also add drivers who have ANY deliveries/pickups for dispatcher's stores on selected date
      const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
      const driversWithDeliveries = deliveries?.
      filter((d) => d && d.delivery_date === selectedDateStr && dispatcherStoreIds.includes(d.store_id)).
      map((d) => d.driver_id).
      filter(Boolean);

      driversWithDeliveries?.forEach((driverId) => assignedDriverIds.add(driverId));

      const filteredDrivers = driversSource.filter((d) => assignedDriverIds.has(d.id));
      return filteredDrivers;
    }

    return driversSource;
  }, [appUsers, currentUser, stores, selectedDate, deliveries]);

  useEffect(() => {
    const appUser = appUsers.find((user) => user?.user_id === currentUser?.id);
    if (appUser?.preferred_travel_mode) {
      setPreferredTravelMode(appUser.preferred_travel_mode);
    }
  }, [appUsers, currentUser?.id]);

  const shouldShowLocationToggle = useMemo(() => {
    // Show for all drivers on ALL devices and screen sizes
    return isDriver && !userHasRole(currentUser, 'dispatcher');
  }, [isDriver, currentUser]);

  const isFiltersReady = useMemo(() => globalFilters.isReadyForDataFetch(), []);

  const isDriverDropdownDisabled = useMemo(() => {
    if (!currentUser) return false;

    // ADMIN: Always enable
    if (userHasRole(currentUser, 'admin')) {
      return false;
    }

    // DISPATCHER: Always enable
    if (userHasRole(currentUser, 'dispatcher')) {
      return false;
    }

    // DRIVER: Always disable (drivers can only see their own route)
    if (userHasRole(currentUser, 'driver')) {
      return true;
    }

    return false;
  }, [currentUser]);

  const tooltipValues = useMemo(() => ({
    total: isDispatcher ?
    `Total: ${stats.total} stops (${stats.totalDrivers} drivers)` :
    isDriver && stats.totalPickups > 0 ?
    `Total: ${stats.total} stops (${stats.totalPickups} pickups)` :
    `Total: ${stats.total} stops`,
    inTransit: isDispatcher ?
    `In-Transit: ${stats.inTransit} stops (${stats.inTransitDrivers} drivers)` :
    isDriver && stats.inTransitPickups > 0 ?
    `In-Transit: ${stats.inTransit} stops (${stats.inTransitPickups} pickups)` :
    `In-Transit: ${stats.inTransit} stops`,
    completed: isDispatcher ?
    `Completed: ${stats.completed} stops (${stats.completedDrivers} drivers)` :
    isDriver && stats.completedPickups > 0 ?
    `Completed: ${stats.completed} stops (${stats.completedPickups} pickups)` :
    `Completed: ${stats.completed} stops`,
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
    // Add left offset when snapshot mode is active
    const snapshotOffset = isSnapshotModeActive ? 'left-24' : 'left-2';
    const ratio = screenWidth / cardWidth;

    if (ratio < 2) {
      return 'absolute top-2 left-1/2 -translate-x-1/2';
    } else {
      return `absolute top-2 ${snapshotOffset}`;
    }
  }, [screenWidth, cardWidth, isSnapshotModeActive]);

  // Determine if stats card is centered or in upper left corner
  const isStatsCardCentered = useMemo(() => {
    const ratio = screenWidth / cardWidth;
    return ratio < 2;
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

    // CRITICAL: Don't fade cards when route is complete
    if (show && !isExpanded && !isRouteComplete) {
      fadeTimeoutRef.current = setTimeout(() => {
        setAreCardsVisible(false);
      }, 3000);
    }
  }, [isExpanded, isRouteComplete]);

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
      // Mouse left and not expanded - start 5 second timer to fade
      statsPanelFadeTimeoutRef.current = setTimeout(() => {
        setStatsPanelOpacity(0.5);
      }, 5000);
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
      }, 5000);
    }
  }, [isExpanded]);

  // Auto-fade stats card 5 seconds after initial load/refresh
  useEffect(() => {
    if (!isDataLoaded) return;

    // Start fade timer on initial load
    const initialFadeTimer = setTimeout(() => {
      if (!isExpanded) {
        setStatsPanelOpacity(0.5);
      }
    }, 5000);

    return () => clearTimeout(initialFadeTimer);
  }, [isDataLoaded, isExpanded]);

  // Track when the last programmatic map move happened (to debounce interaction handler)
  const lastProgrammaticMapMoveRef = useRef(0);

  // Track previous values for detecting changes that should trigger map repositioning
  const prevSelectedDriverIdRef = useRef(selectedDriverId);
  const prevSelectedDateRef = useRef(format(selectedDate, 'yyyy-MM-dd'));
  const pendingMapRepositionRef = useRef(false);

  // Effect to detect driver/date changes - DISABLED to prevent double render
  // Map repositioning is now handled directly in handleDriverChange and handleDateChange
  useEffect(() => {
    const currentDateStr = format(selectedDate, 'yyyy-MM-dd');

    // Update refs only (no map trigger)
    prevSelectedDriverIdRef.current = selectedDriverId;
    prevSelectedDateRef.current = currentDateStr;
  }, [selectedDriverId, selectedDate]);

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

  // Persist route visibility and expose completed-route display toggles to the map.
  useEffect(() => {localStorage.setItem('rxdeliver_show_routes', String(showRoutes));window.__dashboardCompletedRouteControls = { setShowRoutes, setShowBreadcrumbs };return () => {delete window.__dashboardCompletedRouteControls;};}, [showRoutes, setShowRoutes, setShowBreadcrumbs]);

  // Subscribe to global filter changes AND URL params
  useEffect(() => {
    // Check URL params on mount AND on location changes
    const urlParams = new URLSearchParams(window.location.search);
    const dateParam = urlParams.get('date');

    if (dateParam) {const dateObj = new Date(dateParam + 'T00:00:00');if (dateParam !== format(selectedDate, 'yyyy-MM-dd')) {setSelectedDate(dateObj);setCalendarMonth(dateObj);globalFilters.setSelectedDate(dateParam);}}
    const driverParam = urlParams.get('driver');if (driverParam && driverParam !== selectedDriverId) {setSelectedDriverId(driverParam);globalFilters.setSelectedDriverId(driverParam);}
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
      }});return unsubscribe;}, [window.location.search, selectedDate]); // Listen for driver status break/resume events from DriverStatusToggle
  useEffect(() => {const clearLock = () => {if (mapLockTimeoutRef.current) {clearTimeout(mapLockTimeoutRef.current);mapLockTimeoutRef.current = null;}mapLockExpiresAtRef.current = null;};const pulsePhaseOne = (ms) => {clearLock();const x = Date.now() + ms;mapLockExpiresAtRef.current = x;setMapViewPhase(1);setIsMapViewLocked(true);lastProgrammaticMapMoveRef.current = Date.now();window._lastProgrammaticMapMove = Date.now();setMapViewTrigger((prev) => prev + 1);mapLockTimeoutRef.current = setTimeout(() => {if (mapLockExpiresAtRef.current === x) {setIsMapViewLocked(false);mapLockExpiresAtRef.current = null;mapLockTimeoutRef.current = null;}}, ms);};const unsubscribe = fabControlEvents.subscribe((event) => {if (event.type === 'BREAK_START') {phaseBeforeBreakRef.current = event.previousPhase;clearLock();setIsMapViewLocked(false);setMapViewPhase(1);setMapViewTrigger((prev) => prev + 1);} else if (event.type === 'BREAK_END') {const phaseToRestore = event.phaseToRestore || 1;setMapViewPhase(phaseToRestore);setIsMapViewLocked(phaseToRestore !== 1);setMapViewTrigger((prev) => prev + 1);clearLock();phaseBeforeBreakRef.current = null;} else if (event.type === 'DONE_BUTTON_CLICKED') {if (mapViewPhaseRef.current !== 1) pulsePhaseOne(3000);} else if (event.type === 'ACCEPT_ALL_CLICKED') pulsePhaseOne(500);else if (event.type === 'REACTIVATE_FAB') {clearLock();setIsMapViewLocked(false);setTimeout(() => {const unlockMs = mapViewPhaseRef.current === 1 ? 500 : null;setIsMapViewLocked(true);lastProgrammaticMapMoveRef.current = Date.now();window._lastProgrammaticMapMove = Date.now();setMapViewTrigger((prev) => prev + 1);if (unlockMs != null) {const x = Date.now() + unlockMs;mapLockExpiresAtRef.current = x;mapLockTimeoutRef.current = setTimeout(() => {if (mapLockExpiresAtRef.current === x) {setIsMapViewLocked(false);mapLockExpiresAtRef.current = null;mapLockTimeoutRef.current = null;}}, unlockMs);}}, 100);} else if (event.type === 'DELIVERY_REALTIME_CREATE_DELETE_PULSE' && mapViewPhaseRef.current === 1) {const eventMatchesDriver = !selectedDriverId || selectedDriverId === 'all' || event.driverId === selectedDriverId;const eventMatchesDate = !selectedDate || !event.deliveryDate || event.deliveryDate === format(selectedDate, 'yyyy-MM-dd');if (event.relevantToCurrentSelection === true && eventMatchesDriver && eventMatchesDate) pulsePhaseOne(500);} else if (event.type === 'REACTIVATE_PHASE_TWO_IF_AVAILABLE') {if (mapViewPhase !== 2 || isMapViewLocked) return;clearLock();setIsMapViewLocked(true);lastProgrammaticMapMoveRef.current = Date.now();window._lastProgrammaticMapMove = Date.now();setMapViewTrigger((prev) => prev + 1);} else if (event.type === 'PHASE2_TEMP_UNLOCK' && mapViewPhase === 2 && isMapViewLocked) {clearLock();setIsMapViewLocked(false);} else if (event.type === 'PHASE2_COMPLETE_RECENTER' && mapViewPhase === 2) {clearLock();setTimeout(() => {const x = Date.now() + 900;setMapViewPhase(2);setIsMapViewLocked(true);lastProgrammaticMapMoveRef.current = Date.now();window._lastProgrammaticMapMove = Date.now();setMapViewTrigger((prev) => prev + 1);mapLockExpiresAtRef.current = x;mapLockTimeoutRef.current = setTimeout(() => {if (mapLockExpiresAtRef.current === x) {setIsMapViewLocked(false);mapLockExpiresAtRef.current = null;mapLockTimeoutRef.current = null;}}, 900);}, 140);}});return unsubscribe;}, [deliveriesWithStopOrder, mapViewPhase, isMapViewLocked]);

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

  // REMOVED: Screen resize no longer triggers FAB phase activation
  // Phase 1 only activates on initial page load/refresh

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
      const el = statsCardRef.current?.parentElement || statsCardRef.current;
      if (!el) return;
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      if (width > 0 && width !== cardWidth) setCardWidth(width);
      if (height > 0 && height !== statsCardBaseHeight) setstatsCardBaseHeight(height);
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

  // CRITICAL: Measure stop cards COLLAPSED height only - never when expanded
  useEffect(() => {
    const element = horizontalStopCardsRef.current;
    if (!element) return;

    // CRITICAL: Only measure when NO card is expanded (ensures we capture base/collapsed height)
    if (selectedCardId) return;

    // CRITICAL: Wait 400ms for card collapse animation to fully complete before measuring
    const timer = setTimeout(() => {
      const height = element.offsetHeight;
      if (height > 0 && height !== stopCardsBaseHeight) {
        setStopCardsBaseHeight(height);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [selectedCardId, deliveriesWithStopOrder.length, deliveriesWithStopOrder.map((d) => `${d?.id}:${d?.status}`).join(',')]);

  // CRITICAL: Re-measure stop cards height ONLY after data updates when cards are collapsed
  useEffect(() => {
    const handleHeightRemeasure = () => {
      // CRITICAL: Skip if any card is expanded - only measure collapsed state
      if (!horizontalStopCardsRef.current || selectedCardId) return;

      // CRITICAL: Wait 400ms for collapse animation to complete
      setTimeout(() => {
        const element = horizontalStopCardsRef.current;
        if (element && !selectedCardId) {
          const height = element.offsetHeight;
          if (height > 0 && height !== stopCardsBaseHeight) {
            setStopCardsBaseHeight(height);
          }
        }
      }, 400);
    };

    window.addEventListener('deliveriesUpdated', handleHeightRemeasure);
    window.addEventListener('smartRefreshComplete', handleHeightRemeasure);

    return () => {
      window.removeEventListener('deliveriesUpdated', handleHeightRemeasure);
      window.removeEventListener('smartRefreshComplete', handleHeightRemeasure);
    };
  }, [selectedCardId, stopCardsBaseHeight]);

  const { dailyPolylineCount } = useDashboardPolylineMaintenance({
    currentUser,
    selectedDate,
    deliveries,
    isDataLoaded,
    dataReadyForSelectedDate,
    isSnapshotModeActive,
    updateDeliveriesLocally
  });

  // Get driver's location for blue dot display
  // MOBILE: Use device GPS
  // NON-MOBILE: Use shared location from AppUser entity
  useEffect(() => {
    if (!isDriver || !currentUser) return;

    let watchId = null;

    const startWatchingPosition = () => {
      // NON-MOBILE: Use shared location from AppUser entity (no device GPS)
      if (!isMobile) {
        // Use AppUser data from context instead of polling
        const appUser = appUsers?.find((au) => au?.user_id === currentUser.id);

        if (appUser?.current_latitude && appUser?.current_longitude && appUser?.location_updated_at) {
          const newLocation = {
            latitude: appUser.current_latitude,
            longitude: appUser.current_longitude,
            timestamp: appUser.location_updated_at,
            accuracy: null,
            source: 'shared_location'
          };
          setDriverLocation(newLocation);

          // NOTE: Removed map re-trigger on WebSocket location update - prevents unwanted rezoom on every location ping
        } else {
          setDriverLocation(null);
        }

        return () => {};
      }

      // MOBILE: Prefer tracker events when native tracking is active
      const syncMobileLocation = (newLocation) => {
        setDriverLocation(newLocation);
        if (!isMobile || !newLocation.latitude || !newLocation.longitude) return;
        const now = Date.now();
        if (mapViewPhaseRef.current === 2 && isMapViewLockedRef.current) {
          if (now - lastProgrammaticMapMoveRef.current > 1200) {lastProgrammaticMapMoveRef.current = now;window._lastProgrammaticMapMove = now;setMapViewTrigger((prev) => prev + 1);}
          const nextCard = deliveriesWithStopOrder.find((d) => d && d.isNextDelivery === true);
          if (nextCard) document.getElementById(`stop-card-${nextCard.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          return;
        }
        if (mapViewPhaseRef.current === 3 && isMapViewLockedRef.current) {
          if (now - lastProgrammaticMapMoveRef.current > 1800) {lastProgrammaticMapMoveRef.current = now;window._lastProgrammaticMapMove = now;setMapViewTrigger((prev) => prev + 1);}
          return;
        }
        if (isMapViewLocked || now - lastUserInteractionRef.current < 300000 || now - lastProximitySnapTimeRef.current < 60000) return;
        for (const delivery of deliveriesWithStopOrder.filter((d) => d && ['in_transit', 'en_route'].includes(d.status))) {
          const patient = delivery.patient_id ? patients.find((p) => p && p.id === delivery.patient_id) : null;
          const store = !delivery.patient_id && delivery.store_id ? stores.find((s) => s && s.id === delivery.store_id) : null;
          const stopLat = patient?.latitude || store?.latitude;
          const stopLon = patient?.longitude || store?.longitude;
          if (!stopLat || !stopLon) continue;
          if (calculateDistance(newLocation.latitude, newLocation.longitude, stopLat, stopLon) > 0.1) continue;
          const cardElement = document.getElementById(`stop-card-${delivery.id}`);
          const container = stopCardsContainerRef.current?.querySelector('.overflow-x-auto');
          if (cardElement && container) {
            const c = container.getBoundingClientRect();
            const r = cardElement.getBoundingClientRect();
            if (Math.abs(r.left + r.width / 2 - (c.left + c.width / 2)) < 50) continue;
          }
          lastProximitySnapTimeRef.current = Date.now();
          cardElement?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          break;
        }
      };

      const trackerStatus = locationTracker.getStatus();
      if (trackerStatus.lastLocation?.latitude && trackerStatus.lastLocation?.longitude) syncMobileLocation({ latitude: trackerStatus.lastLocation.latitude, longitude: trackerStatus.lastLocation.longitude, timestamp: new Date().toISOString(), accuracy: trackerStatus.lastLocation.accuracy, source: trackerStatus.providerName || 'tracker' });
      const handleTrackerPosition = (event) => {
        const { userId, latitude, longitude, timestamp, accuracy, source } = event.detail || {};
        if (userId && userId !== currentUser.id) return;
        if (!latitude || !longitude) return;
        syncMobileLocation({ latitude, longitude, timestamp, accuracy, source: source || 'tracker' });
      };
      window.addEventListener('driverPositionUpdated', handleTrackerPosition);
      if (!trackerStatus.isTracking && navigator.geolocation) {
        watchId = navigator.geolocation.watchPosition(
          (position) => syncMobileLocation({ latitude: position.coords.latitude, longitude: position.coords.longitude, timestamp: new Date(position.timestamp).toISOString(), accuracy: position.coords.accuracy, source: 'device_gps' }),
          (error) => console.warn('⚠️ [Dashboard] GPS error:', error.message),
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
      } else if (!trackerStatus.isTracking) {
        console.warn('⚠️ [Dashboard] Geolocation not available on this device');
      }
      return () => window.removeEventListener('driverPositionUpdated', handleTrackerPosition);
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
  }, [isDriver, currentUser, isMobile, deliveriesWithStopOrder, patients, stores, mapViewPhase, getMapPadding, appUsers]);

  // REMOVED: Driver location updates should NOT trigger FAB reactivation
  // FAB only reactivates on:
  // 1. Manual FAB click
  // 2. Driver/date change
  // 3. Smart refresh complete (with actual data changes)
  // 4. App load/page load
  // GPS location updates are passive and should not trigger map repositioning

  useEffect(() => {
    if (!isDataLoaded || !currentUser || !isFiltersReady) return;
    smartRefreshManager.setCurrentUser(currentUser);
    const runPeriodicSmartRefresh = async () => {
      if (smartRefreshManager.isPaused() || !hasTriggeredPrioritySyncRef.current || showDeliveryForm || showPatientForm || showOptimizationSettings || showAIAssistant) return;
      const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');if (selectedDateStr !== getEdmDate()) return;const filters = { deliveryFilter: { delivery_date: selectedDateStr } };
      try {
        const updates = await smartRefreshManager.performSmartRefresh({ deliveries, patients, stores, cities, appUsers, drivers }, filters, false, showAllDriverMarkers, 'Dashboard', selectedDate);
        if (Array.isArray(updates?.deliveries) && updates.deliveries.length > 0 && updateDeliveriesLocally) updateDeliveriesLocally(updates.deliveries, true);
        const appUsersToProcess = updates?.appUsers?.length ? updates.appUsers : appUsers;
        if (appUsersToProcess?.length) driverLocationPoller.processLocationData(currentUser, updates?.deliveries || deliveries, drivers, stores, appUsersToProcess, selectedDate, true, 'Dashboard', showAllDriverMarkers);
      } catch (error) {
        if (error.response?.status === 429 || error.message?.includes('429') || error.message?.includes('Rate limit')) return;
        console.warn('⚠️ [Periodic Refresh] Error:', error.message);
      }
    };
    const initialDelay = setTimeout(() => {if (format(selectedDate, 'yyyy-MM-dd') !== getEdmDate()) return;runPeriodicSmartRefresh();if (smartRefreshManager?.checkHeartbeatAndSync) smartRefreshManager.checkHeartbeatAndSync();}, 90000);
    const interval = setInterval(async () => {
      runPeriodicSmartRefresh();
      if (smartRefreshManager?.checkHeartbeatAndSync) smartRefreshManager.checkHeartbeatAndSync();
      if (showDeliveryForm || showPatientForm || showOptimizationSettings || showAIAssistant) return;
      const ds = format(selectedDate, 'yyyy-MM-dd');
      if (ds !== getEdmDate()) return;
      const m = await offlineDB.getSyncMetadata('Delivery'),t = new Date(m?.last_sync_time || m?.last_sync_date || m?.last_synced_timestamp || 0).getTime();
      const active = deliveries.some((d) => d && d.delivery_date === ds && !['completed', 'failed', 'cancelled', 'returned'].includes(d.status));
      if (!t || Date.now() - t >= (active ? 60000 : 300000)) window.dispatchEvent(new CustomEvent('triggerPullToSync', { detail: { silent: true, reason: active ? 'today_active_routes' : 'today_completed_routes' } }));
    }, 60000);
    return () => {clearTimeout(initialDelay);clearInterval(interval);};
  }, [isDataLoaded, currentUser?.id, isFiltersReady, deliveries, patients, stores, cities, appUsers, drivers, selectedDate, showAllDriverMarkers, showDeliveryForm, showPatientForm, showOptimizationSettings, showAIAssistant]);

  useEffect(() => {
    const handleDriverLocationUpdate = (event) => {
      const { appUsers: updatedAppUsers, fromPoller, mergeMode } = event.detail || {};
      if (fromPoller || !Array.isArray(updatedAppUsers) || updatedAppUsers.length === 0) return;
      let appUsersToProcess = updatedAppUsers;
      if (mergeMode === 'merge' && appUsers?.length) {
        const updatedMap = new Map(updatedAppUsers.filter((au) => au?.user_id).map((au) => [au.user_id, au]));
        appUsersToProcess = appUsers.map((au) => updatedMap.get(au?.user_id) || au);
        updatedAppUsers.forEach((au) => {if (au?.user_id && !appUsers.some((existing) => existing?.user_id === au.user_id)) appUsersToProcess.push(au);});
      }
      driverLocationPoller.processLocationData(currentUser, deliveries, drivers, stores, appUsersToProcess, selectedDate, true, 'Dashboard', showAllDriverMarkers || selectedDriverId === 'all');
      const phase = mapViewPhaseRef.current,now = Date.now();
      if (format(selectedDate, 'yyyy-MM-dd') === getEdmDate() && isMapViewLockedRef.current && (phase === 2 || phase === 3) && now - lastProgrammaticMapMoveRef.current >= (phase === 2 ? 1200 : 1800)) {
        lastProgrammaticMapMoveRef.current = now;
        window._lastProgrammaticMapMove = now;
        setMapViewTrigger((prev) => prev + 1);
      }
    };
    window.addEventListener('driverLocationsUpdated', handleDriverLocationUpdate);
    return () => window.removeEventListener('driverLocationsUpdated', handleDriverLocationUpdate);
  }, [currentUser, deliveries, drivers, stores, selectedDate, showAllDriverMarkers, appUsers, selectedDriverId]);

  // Track other drivers' locations via poller (for all-drivers mode or when checkbox is checked)
  // CRITICAL: Initialize poller once on mount
  useEffect(() => {
    if (!isDataLoaded || !currentUser) {
      return;
    }

    driverLocationPoller.start(() => {






      // Callback provided for future use
    }, currentUser);const unsubscribe = driverLocationPoller.subscribe((locations) => {if (!locations || !Array.isArray(locations)) return; // CRITICAL: On mobile with active GPS tracking, filter out self marker (blue dot shows instead)
        // On all other devices/scenarios, show the shared marker
        const isTrackingOnThisDevice = locationTracker.isTracking === true;const shouldFilterSelf = isMobile && isDriver && isTrackingOnThisDevice;const filteredLocations = shouldFilterSelf ? locations.filter((loc) => {if (loc._isSelf === true) {return false;}return true;}) : locations;setAllDriverLocations(filteredLocations);});

    return () => {
      unsubscribe();
      driverLocationPoller.stop();
    };
  }, [isDataLoaded, currentUser?.id, currentUser?.user_id, isMobile, isDriver]);

  const completedRouteNotificationsRef = useRef(new Set());
  useEffect(() => {
    const driverId = currentUser && (selectedDriverId !== 'all' ? selectedDriverId : currentUser.id),deliveryDate = format(selectedDate, 'yyyy-MM-dd'),key = `${driverId}:${deliveryDate}`;
    if (!currentUser || !isRouteComplete || !driverId || completedRouteNotificationsRef.current.has(key)) return;
    completedRouteNotificationsRef.current.add(key);
    window.dispatchEvent(new CustomEvent('routeShiftCompleted', { detail: { driverId, deliveryDate } }));
  }, [currentUser?.id, isRouteComplete, selectedDriverId, selectedDate]);
  useEffect(() => {
    if (!currentUser || !selectedDriverId) {
      setCurrentToNextPolyline(null);
      return;
    }
    const todayStr = getEdmDate();
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
        const driver = appUsers.find((u) => u && u.user_id === driverIdToFetch);

        // CRITICAL: Only fetch polyline if driver is on_duty with location tracking enabled
        // Hide polyline when driver is on break
        if (!driver || driver.driver_status === 'on_break' || driver.driver_status !== 'on_duty' || driver.location_tracking_enabled !== true) {
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
      setCurrentToNextPolyline(null);
      return; // Don't fetch polylines if no active deliveries
    }

    fetchPolyline();
    const interval = setInterval(fetchPolyline, 30000);

    // CRITICAL: Listen for driver location changes to refresh polyline immediately
    const handleLocationChange = () => {
      fetchPolyline();
    };
    window.addEventListener('driverLocationChanged', handleLocationChange);

    return () => {
      clearInterval(interval);
      window.removeEventListener('driverLocationChanged', handleLocationChange);
    };
  }, [currentUser?.id, selectedDriverId, selectedDate, filteredDeliveries, patients, stores, appUsers]);

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

    // CRITICAL: Pause smart refresh when ANY form/overlay is open
    if (isAnyFormOpen) {
      smartRefreshManager.pause();
    } else {
      smartRefreshManager.resume();
    }
  }, [showDeliveryForm, showPatientForm, showOptimizationSettings, showAIAssistant, setIsFormOverlayOpen]);

  /* Map Cycle FAB rules (condensed) */
  const handleMapViewCycle = useCallback((forceReactivate = false) => {
    if (!isDriver && !isDispatcher && !isAdmin) return;
    setIsExpanded(false);setSelectedCardId(null);cardExpandedAtRef.current = null;setAreCardsVisible(false);

    const triggerPhase = (phase, unlockMs = null) => {
      setIsMapViewLocked(true);setMapViewPhase(phase);
      lastProgrammaticMapMoveRef.current = Date.now();window._lastProgrammaticMapMove = Date.now();
      setMapViewTrigger((prev) => prev + 1);
      if (currentUser?.id) saveSetting(currentUser.id, 'fab_map_cycle_phase', phase);
      setTimeout(() => {
        centerNextDeliveryCard(deliveriesWithStopOrder);
      }, 300);
      if (mapLockTimeoutRef.current) {clearTimeout(mapLockTimeoutRef.current);mapLockTimeoutRef.current = null;}
      mapLockExpiresAtRef.current = null;
      if (unlockMs != null) {
        const expiresAt = Date.now() + unlockMs;
        mapLockExpiresAtRef.current = expiresAt;
        mapLockTimeoutRef.current = setTimeout(() => {
          if (mapLockExpiresAtRef.current === expiresAt) {
            setIsMapViewLocked(false);mapLockExpiresAtRef.current = null;mapLockTimeoutRef.current = null;
          }
        }, unlockMs);
      }
    };

    if (forceReactivate === true) {
      if (mapLockTimeoutRef.current) {clearTimeout(mapLockTimeoutRef.current);mapLockTimeoutRef.current = null;}
      mapLockExpiresAtRef.current = null;
      if (isMapViewLocked) {
        setIsMapViewLocked(false);
        setTimeout(() => triggerPhase(mapViewPhase, mapViewPhase === 1 ? 500 : null), 100);
        return;
      }
      triggerPhase(mapViewPhase, mapViewPhase === 1 ? 500 : null);
      return;
    }

    const phase2Unavailable = isDriver && (!deliveriesWithStopOrder.some((d) => d && d.driver_id === currentUser?.id && !['completed', 'failed', 'cancelled', 'returned', 'pending'].includes(d.status)) || !nextStopCoordinates);
    let newMapViewPhase = mapViewPhase === 1 ? isMapViewLocked ? phase2Unavailable ? 3 : 2 : 1 : isMapViewLocked ? mapViewPhase % 3 + 1 : mapViewPhase;
    if (isDriver && newMapViewPhase === 3 && (phase2Unavailable || !isMobile && !(allDriverLocations.length > 0 || driverLocation?.latitude && driverLocation?.longitude))) newMapViewPhase = 1;
    triggerPhase(newMapViewPhase, newMapViewPhase === 1 ? 3000 : null);
  }, [mapViewPhase, isMapViewLocked, isDriver, nextStopCoordinates, isDispatcher, isAdmin, isMobile, currentUser, deliveriesWithStopOrder, allDriverLocations, driverLocation]);

  // Track if the current map positioning was triggered by FAB (not by data refresh)
  const mapPositioningTriggerRef = useRef(null);

  // Track a counter to force useEffect to re-run when FAB is clicked
  const [mapViewTrigger, setMapViewTrigger] = useState(0);

  // Track the last trigger value to prevent re-running on every state change
  const lastAppliedTriggerRef = useRef(0);

  useEffect(() => {
    // CRITICAL: Only run when mapViewTrigger changes - prevent re-runs from data updates
    if (mapViewTrigger === 0 || mapViewTrigger === lastAppliedTriggerRef.current) {
      return;
    }

    if (mapViewPhase === 0) {
      return;
    }

    // Update last applied trigger FIRST
    lastAppliedTriggerRef.current = mapViewTrigger;

    // CRITICAL: Only skip phase 2 (driver+next-stop) if not a driver or no location.
    // Phase 3 CAN run for dispatchers (shows incomplete stops for their stores).
    if (mapViewPhase === 2 && !(isDispatcher && !isAdmin || isAdmin && selectedDriverId === 'all') && !getFabTargetDriverMapLocation({ selectedDriverId, currentUser, isDriver, appUsers, driverLocation, allDriverLocations, isPrimaryDevice })) {
      return;
    }

    // REMOVED: Delivery count check - now handled by render sequence effect 7

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
        const todayStr = getEdmDate();
        const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
        const isViewingToday = todayStr === selectedDateStr;

        // CRITICAL: Treat "Show All" mode same as "All Drivers" mode for map bounds
        const shouldShowAllMarkersForBounds = selectedDriverId === 'all' || showAllDriverMarkers;

        // 1. DRIVER LOCATION: Include driver's location (GPS blue dot or shared AppUser location)
        // Covers: mobile GPS, desktop shared location, and cases where GPS hasn't loaded yet
        if (isViewingToday) {
          const selfLoc = getSelfDriverLocationForBounds({ currentUser, appUsers, driverLocation, isMobile, selectedDriverId, isDriver, isDriverOffDuty });
          if (selfLoc?.latitude && selfLoc?.longitude) {allCoordinates.push([selfLoc.latitude, selfLoc.longitude]);hasDriverMarkers = true;}
        }
        const shouldIncludeBlueDot = isMobile && isDriver && !isDriverOffDuty(appUsers, currentUser?.id, currentUser?.driver_status) && isViewingToday && driverLocation?.latitude && driverLocation?.longitude && (selectedDriverId === currentUser?.id || selectedDriverId === 'all');

        // 2. SHARED DRIVER LOCATIONS: Include when in "All Drivers" mode OR "Show All" is checked OR when desktop OR dispatcher
        // CRITICAL: Always include shared locations for desktop OR "show all" mode OR dispatchers OR admins
        const shouldIncludeSharedLocations = !isMobile || shouldShowAllMarkersForBounds || isDispatcher || isAdmin;

        // CRITICAL: Also load from window.__mapDriverLocationMarkers (rendered on map)
        const mapDriverLocationMarkers = window.__mapDriverLocationMarkers || [];

        if (isViewingToday && shouldIncludeSharedLocations) {
          let addedCount = 0;

          // CRITICAL: For dispatchers viewing a single driver, prioritize AppUser data directly
          if (isDispatcher && selectedDriverId && selectedDriverId !== 'all') {
            const assignedDriverAppUser = appUsers?.find((au) => au?.user_id === selectedDriverId);
            if (assignedDriverAppUser?.driver_status === 'on_duty' && assignedDriverAppUser?.current_latitude && assignedDriverAppUser?.current_longitude) {
              allCoordinates.push([assignedDriverAppUser.current_latitude, assignedDriverAppUser.current_longitude]);
              hasDriverMarkers = true;
              addedCount++;
            } else {
              console.warn(`⚠️ [Phase 1 - Dispatcher] Assigned driver has no location data:`, {
                selectedDriverId,
                appUser: assignedDriverAppUser ? 'found' : 'not found',
                has_lat: !!assignedDriverAppUser?.current_latitude,
                has_lng: !!assignedDriverAppUser?.current_longitude
              });
            }
          }

          // Combine both sources for shared locations
          const allLocationSources = [...(allDriverLocations || []), ...mapDriverLocationMarkers];

          // Deduplicate by driver_id
          const uniqueLocations = new Map();
          allLocationSources.forEach((loc) => {
            if (loc?.driver_id && !uniqueLocations.has(loc.driver_id)) {
              uniqueLocations.set(loc.driver_id, loc);
            }
          });

          Array.from(uniqueLocations.values()).forEach((location) => {
            if (!location?.latitude || !location?.longitude || !location?.driver_id) {
              return;
            }

            // CRITICAL: Skip current user's shared marker if live location is available (prioritize GPS)
            const hasLiveLocation = driverLocation?.latitude && driverLocation?.longitude && location.driver_id === currentUser?.id;
            if (hasLiveLocation) {
              return;
            }

            // CRITICAL: Skip current user on mobile (blue dot shows instead) - but NOT for dispatchers
            const isCurrentUserLocation = isMobile && !isDispatcher && isPrimaryDevice && location.driver_id === currentUser?.id;
            if (isCurrentUserLocation) {
              return;
            }

            // CRITICAL: Skip if this is the assigned driver (already added above for dispatchers)
            if (isDispatcher && selectedDriverId && selectedDriverId !== 'all' && location.driver_id === selectedDriverId) {
              return;
            }

            if (appUsers?.find((au) => au?.user_id === location.driver_id)?.driver_status !== 'on_duty') return;
            // CRITICAL: Phase 1 "Show All" mode - include rendered markers in bounds

            // Dispatcher filtering - check ALL date deliveries, not just selected driver
            if (isDispatcher && !isAdmin) {
              const dispatcherStoreIds = new Set((currentUser?.store_ids || []).map((id) => String(id)));
              const allDateDeliveries = deliveries.filter((d) => d && d.delivery_date === selectedDateStr);
              const hasDeliveryInDispatcherStore = allDateDeliveries.some((delivery) =>
              delivery &&
              delivery.driver_id === location.driver_id &&
              dispatcherStoreIds.has(String(delivery.store_id))
              );
              if (!hasDeliveryInDispatcherStore) {
                return;
              }
            }

            allCoordinates.push([location.latitude, location.longitude]);
            hasDriverMarkers = true;
            addedCount++;
          });
        }

        // 3. Add delivery/pickup markers based on mode FIRST so live-driver detection only considers drivers with actual visible stops
        // CRITICAL: When "Show All" is checked OR "All Drivers" selected, show ALL deliveries for date
        let deliveriesToMap = [];

        if (shouldShowAllMarkersForBounds) {
          let allDateDeliveries = deliveries.filter((d) => d && d.delivery_date === selectedDateStr);

          if (isDispatcher && !isAdmin) {
            const dispatcherStoreIds = new Set(currentUser?.store_ids || []);
            const driversWithStoreDeliveries = new Set(
              allDateDeliveries
                .filter((d) => d && dispatcherStoreIds.has(d.store_id))
                .map((d) => d.driver_id)
                .filter(Boolean)
            );
            deliveriesToMap = allDateDeliveries.filter((d) => d && driversWithStoreDeliveries.has(d.driver_id));
          } else {
            deliveriesToMap = allDateDeliveries;
          }
        } else {
          deliveriesToMap = deliveriesWithStopOrder.length > 0 ? deliveriesWithStopOrder : deliveries.filter((d) => d && d.delivery_date === selectedDateStr && (!selectedDriverId || selectedDriverId === 'all' || d.driver_id === selectedDriverId));
        }

        let coordsAdded = 0;
        [...(window.__mapDeliveryMarkers || []), ...(window.__mapPickupMarkers || [])].forEach((marker) => {
          if (!marker?.latitude || !marker?.longitude) return;
          allCoordinates.push([marker.latitude, marker.longitude]);
          hasStopMarkers = true;
          coordsAdded++;
        });

        // 4. HOME LOCATIONS: only suppress home markers when there is a live marker for a driver that actually has visible stops in this view
        const visibleDriverIdsForBounds = new Set((deliveriesToMap || []).map((d) => d?.driver_id).filter(Boolean));
        const mapDriverLocationMarkersForBounds = (window.__mapDriverLocationMarkers || []).filter((marker) => visibleDriverIdsForBounds.has(marker?.driver_id || marker?.driverId || marker?.user_id || marker?.id));
        const mapHomeMarkers = (window.__dashboardMapMarkerHelpers?.getVisibleHomeMarkersForBounds || ((params) => params.mapHomeMarkers || []))({
          mapHomeMarkers: window.__mapHomeMarkers || [],
          mapDeliveryMarkers: (window.__mapDeliveryMarkers || []).filter((marker) => visibleDriverIdsForBounds.has(marker?.driver_id)),
          mapPickupMarkers: (window.__mapPickupMarkers || []).filter((marker) => visibleDriverIdsForBounds.has(marker?.driver_id)),
          currentUser,
          selectedDriverId,
          showAllDriverMarkers,
          userHasRole,
          hasDriverMarkers: mapDriverLocationMarkersForBounds.length > 0
        });
        mapHomeMarkers.forEach((home) => {if (home.latitude && home.longitude) allCoordinates.push([home.latitude, home.longitude]);});

        // Get current city center
        const selectedCityId = globalFilters.getSelectedCityId();
        const currentCity = cities?.find((c) => c && c.id === selectedCityId);

        // CASE 1: No stop markers and no driver markers → center on closest assigned city
        if (!hasStopMarkers && !hasDriverMarkers) {

          // Get user's reference location (current GPS > last known > home base)
          let userRefLat = null;
          let userRefLon = null;
          let locationSource = null;

          if (!isDriverOffDuty(appUsers, currentUser?.id, currentUser?.driver_status) && driverLocation?.latitude && driverLocation?.longitude) {
            userRefLat = driverLocation.latitude;
            userRefLon = driverLocation.longitude;
            locationSource = 'current_gps';
          } else if (!isDriverOffDuty(appUsers, currentUser?.id, currentUser?.driver_status) && currentUser?.current_latitude && currentUser?.current_longitude) {
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

            const padding = getMapPadding();
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
          }
        }

        // CASE 3: Normal case with stop markers
        else if (allCoordinates.length > 0) {

          // Calculate span to determine appropriate maxZoom
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

          const spanKm = maxSpan * 111.0;
          const baseZoom = 16 - Math.log2(spanKm + 1) * 1.2;
          const phase1MaxZoom = Math.max(12.0, Math.min(19, Math.round(baseZoom * 10) / 10));

          const padding = getMapPadding();

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

      case 2: // "Center on Driver & Next Stop" (drivers) OR "All active driver locations + next stops" (dispatchers)
        console.clear;
        // Mark that we're doing a programmatic map move (debounces interaction handler)
        lastProgrammaticMapMoveRef.current = Date.now();
        window._lastProgrammaticMapMove = Date.now();

        if (isDispatcher && !isAdmin || isAdmin && selectedDriverId === 'all') {
          // DISPATCHER PHASE 2: Show all active drivers (for dispatcher's stores) + their next stops
          const dispatcherStoreIds2 = new Set((currentUser?.store_ids || []).map((id) => String(id)));
          const selectedDateStr2 = format(selectedDate, 'yyyy-MM-dd');
          const allDateDeliveries2 = deliveries.filter((d) => d && d.delivery_date === selectedDateStr2);
          const finishedStatuses2 = ['completed', 'failed', 'cancelled', 'returned'];

          // Drivers with active (incomplete) stops in dispatcher's stores
          const activeDriverIds2 = new Set(
            allDateDeliveries2.filter((d) =>
            d && dispatcherStoreIds2.has(String(d.store_id)) && !finishedStatuses2.includes(d.status) && d.status !== 'pending'
            ).map((d) => d.driver_id).filter(Boolean)
          );

          const phase2DispatcherCoords = [];

          activeDriverIds2.forEach((driverId) => {
            const driverAppUser = appUsers?.find((au) => au?.user_id === driverId);
            if (driverAppUser?.driver_status === 'on_duty' && driverAppUser?.current_latitude && driverAppUser?.current_longitude) {
              phase2DispatcherCoords.push([driverAppUser.current_latitude, driverAppUser.current_longitude]);
            }
            // Also include each driver's next stop
            const driverNextStop = allDateDeliveries2.find((d) => d && d.driver_id === driverId && d.isNextDelivery);
            if (driverNextStop) {
              if (driverNextStop.patient_id) {
                const patient = patients.find((p) => p?.id === driverNextStop.patient_id);
                if (patient?.latitude && patient?.longitude) phase2DispatcherCoords.push([patient.latitude, patient.longitude]);
              } else if (driverNextStop.store_id) {
                const store = stores.find((s) => s?.id === driverNextStop.store_id);
                if (store?.latitude && store?.longitude) phase2DispatcherCoords.push([store.latitude, store.longitude]);
              }
            }
          });

          if (phase2DispatcherCoords.length > 0) {
            const padding = getMapPadding();
            setShouldFitBounds({
              bounds: phase2DispatcherCoords,
              options: { ...padding, maxZoom: 17.5, animate: true, duration: 0.9, easeLinearity: 0.15 }
            });
            setMapCenter(null);
            setMapZoom(null);
          }
          break;
        }

        const fabTargetDriverLocation = getFabTargetDriverMapLocation({
          selectedDriverId,
          currentUser,
          isDriver,
          appUsers,
          driverLocation,
          allDriverLocations, isPrimaryDevice
        });

        if (nextStopCoordinates && fabTargetDriverLocation?.latitude && fabTargetDriverLocation?.longitude) {
          const bounds = [
          [fabTargetDriverLocation.latitude, fabTargetDriverLocation.longitude],
          [nextStopCoordinates.lat, nextStopCoordinates.lon]];

          const padding = getMapPadding();

          setShouldFitBounds({ bounds, options: { ...padding, maxZoom: 17.5, animate: true, duration: 0.9, easeLinearity: 0.15 } });
          setMapCenter(null);
          setMapZoom(null);
        } else if (fabTargetDriverLocation?.latitude && fabTargetDriverLocation?.longitude) {
          const padding = getMapPadding();

          setShouldFitBounds({
            bounds: [[fabTargetDriverLocation.latitude, fabTargetDriverLocation.longitude]],
            options: {
              ...padding,
              maxZoom: 17.5,
              animate: true
            }
          });
          setMapCenter(null);
          setMapZoom(null);
        }
        break;

      case 3: // "Center on Incomplete Stops Only + Their Drivers + Pending"
        console.clear;
        const allCoordinatesPhase3 = [];

        // Check if viewing today's date
        const todayStrPhase3 = getEdmDate();
        const selectedDateStrPhase3 = format(selectedDate, 'yyyy-MM-dd');
        const isViewingTodayPhase3 = todayStrPhase3 === selectedDateStrPhase3;

        // CRITICAL: Determine if "Show All" mode OR "All Drivers" mode is active
        const isShowAllOrAllDriversMode = showAllDriverMarkers || selectedDriverId === 'all';

        const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

        if (isShowAllOrAllDriversMode) {
          // MODE 1: Show All / All Drivers - include ALL incomplete + pending stops from ALL drivers
          let allDateDeliveries = deliveries.filter((d) => d && d.delivery_date === selectedDateStrPhase3);

          // CRITICAL: Filter by dispatcher stores if applicable
          if (isDispatcher && !isAdmin && currentUser?.store_ids) {
            const dispatcherStoreIds = new Set(currentUser.store_ids);
            const driversWithStoreDeliveries = new Set(
              allDateDeliveries.
              filter((d) => d && dispatcherStoreIds.has(d.store_id)).
              map((d) => d.driver_id).
              filter(Boolean)
            );
            allDateDeliveries = allDateDeliveries.filter((d) => d && driversWithStoreDeliveries.has(d.driver_id));
          }

          // CRITICAL: Include BOTH incomplete AND pending stops
          const incompleteAndPendingAllDrivers = allDateDeliveries.filter((d) => {
            if (!d) return false;
            if (finishedStatuses.includes(d.status)) return false;
            return true; // Include both in_transit/en_route AND pending
          });

          // CRITICAL: Get unique driver IDs from incomplete + pending deliveries
          const driversWithIncompleteOrPendingStops = new Set(incompleteAndPendingAllDrivers.map((d) => d.driver_id).filter(Boolean));

          // Add incomplete + pending stop coordinates
          incompleteAndPendingAllDrivers.forEach((delivery) => {
            if (delivery.patient_id) {
              const patient = patients.find((p) => p?.id === delivery.patient_id);
              if (patient?.latitude && patient?.longitude) {
                allCoordinatesPhase3.push([patient.latitude, patient.longitude]);
              }
            } else if (delivery.store_id) {
              const store = stores.find((s) => s?.id === delivery.store_id);
              if (store?.latitude && store?.longitude) {
                allCoordinatesPhase3.push([store.latitude, store.longitude]);
              }
            }
          });

          // CRITICAL: Add driver markers ONLY for drivers with incomplete OR pending stops (only if viewing today)
          if (isViewingTodayPhase3) {
            driversWithIncompleteOrPendingStops.forEach((driverId) => {
              const driverAppUser = appUsers?.find((au) => au?.user_id === driverId);
              if (driverAppUser?.driver_status === 'on_duty' && driverAppUser?.current_latitude && driverAppUser?.current_longitude) {
                allCoordinatesPhase3.push([driverAppUser.current_latitude, driverAppUser.current_longitude]);
              }
            });
          }

        } else {
          // MODE 2: Single Driver - include selected driver's incomplete + pending stops
          const targetDriverId = selectedDriverId !== 'all' ? selectedDriverId : currentUser?.id;

          const incompleteAndPendingActiveDriver = deliveriesWithStopOrder.filter((d) => {
            if (!d || d.delivery_date !== selectedDateStrPhase3) return false;
            if (finishedStatuses.includes(d.status)) return false;
            // INCLUDE pending deliveries
            return true;
          });

          // Add incomplete + pending stop coordinates
          incompleteAndPendingActiveDriver.forEach((delivery) => {
            if (delivery.patient_id) {
              const patient = patients.find((p) => p?.id === delivery.patient_id);
              if (patient?.latitude && patient?.longitude) {
                allCoordinatesPhase3.push([patient.latitude, patient.longitude]);
              }
            } else if (delivery.store_id) {
              const store = stores.find((s) => s?.id === delivery.store_id);
              if (store?.latitude && store?.longitude) {
                allCoordinatesPhase3.push([store.latitude, store.longitude]);
              }
            }
          });

          // Add driver marker when on duty (today only) - include GPS fallback if AppUser lacks coords
          if (isViewingTodayPhase3) {const driverAppUser3 = appUsers?.find((au) => au?.user_id === targetDriverId);if (driverAppUser3?.driver_status === 'on_duty') {if (driverAppUser3?.current_latitude && driverAppUser3?.current_longitude) {allCoordinatesPhase3.push([driverAppUser3.current_latitude, driverAppUser3.current_longitude]);} else if (targetDriverId === currentUser?.id && driverLocation?.latitude && driverLocation?.longitude) {allCoordinatesPhase3.push([driverLocation.latitude, driverLocation.longitude]);}}}
        }

        // 3. Only fit bounds if we have actual markers to show (NO city center fallback)
        if (allCoordinatesPhase3.length > 0) {
          const hasVisibleCards = deliveriesWithStopOrder.some((d) => d && d.status !== 'pending');
          const statsCardCurrHeight = statsCardRef.current?.offsetHeight || 75;
          const topPadding = isMobile ? statsCardCurrHeight + 25 : 25;

          let bottomPadding = 25;
          if (hasVisibleCards) {
            const stopCardsContainer = stopCardsContainerRef.current;
            if (stopCardsContainer) {
              const measuredHeight = stopCardsContainer.offsetHeight;
              if (measuredHeight > 0) {
                bottomPadding = measuredHeight + 10;
              }
            } else if (stopCardsBaseHeight > 0) {
              bottomPadding = stopCardsBaseHeight + 10;
            }
          }

          const padding = {
            paddingTopLeft: [25, topPadding],
            paddingBottomRight: [25, bottomPadding]
          };

          let minLat = Infinity,maxLat = -Infinity,minLon = Infinity,maxLon = -Infinity;
          allCoordinatesPhase3.forEach(([lat, lon]) => {
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
            minLon = Math.min(minLon, lon);
            maxLon = Math.max(maxLon, lon);
          });

          const latSpan = maxLat - minLat;
          const lonSpan = maxLon - minLon;
          const maxSpan = Math.max(latSpan, lonSpan);
          const spanKm = maxSpan * 111.0;
          const baseZoom = 16 - Math.log2(spanKm + 1) * 1.2;
          const phase3MaxZoom = Math.max(12.0, Math.min(19, Math.round(baseZoom * 10) / 10));

          setShouldFitBounds({
            bounds: allCoordinatesPhase3,
            options: {
              ...padding,
              maxZoom: phase3MaxZoom,
              animate: true
            }
          });
          setMapCenter(null);
          setMapZoom(null);
        }
        break;

      default:
        break;
    }
  }, [mapViewPhase, driverLocation, nextStopCoordinates, deliveriesWithStopOrder, patients, stores, isDriver, mapViewTrigger, isDispatcher, currentUser, getMapPadding, allDriverLocations, showAllDriverMarkers, appUsers, selectedDriverId, selectedDate, cities, deliveries, isPrimaryDevice]);

  // RENDER SEQUENCE EFFECT 1: Track StatsCard & StopCards ready
  useEffect(() => {
    if (!isDataLoaded || !userSettingsLoaded) return;

    const hasDeliveries = deliveriesWithStopOrder.length > 0;
    const statsCardMeasured = statsCardRef.current?.offsetHeight > 0;
    const stopCardsMeasured = hasDeliveries ? stopCardsBaseHeight > 0 : true;

    if (statsCardMeasured && stopCardsMeasured && !renderSequence.statsAndCards) {
      setRenderSequence((prev) => ({ ...prev, statsAndCards: true }));
    }
  }, [isDataLoaded, userSettingsLoaded, deliveriesWithStopOrder.length, stopCardsBaseHeight, renderSequence.statsAndCards]);

  // RENDER SEQUENCE EFFECT 2: Track FABs ready (after stats/cards)
  useEffect(() => {
    if (!renderSequence.statsAndCards) return;
    if (renderSequence.fabs) return;

    // CRITICAL: Wait for FABs to actually render before marking as ready
    const timer = setTimeout(() => {
      setRenderSequence((prev) => ({ ...prev, fabs: true }));
    }, 300); // Wait 300ms for FABs to mount and render

    return () => clearTimeout(timer);
  }, [renderSequence.statsAndCards, renderSequence.fabs]);

  // RENDER SEQUENCE EFFECT 3: Track Map Markers ready (including ALL delivery/patient markers)
  useEffect(() => {
    if (!renderSequence.fabs) return;
    if (renderSequence.mapMarkers) return;

    // CRITICAL: Map markers ready ONLY when we have deliveries AND patients loaded
    // This ensures both pickup AND patient delivery markers are rendered
    const hasDeliveries = deliveriesWithStopOrder.length > 0;
    const hasPatients = patients.length > 0;
    const hasStores = stores.length > 0;

    const hasRequiredData = hasDeliveries && hasPatients && hasStores || !hasDeliveries && hasStores;

    if (hasRequiredData) {
      setRenderSequence((prev) => ({ ...prev, mapMarkers: true }));
    }
  }, [renderSequence.fabs, renderSequence.mapMarkers, deliveriesWithStopOrder.length, patients.length, stores.length]);

  // RENDER SEQUENCE EFFECT 4: Track Route Lines ready
  useEffect(() => {
    if (!renderSequence.mapMarkers) return;
    if (renderSequence.routeLines) return;

    // Route lines are ready - they render after markers
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
      setRenderSequence((prev) => ({ ...prev, driverLiveLocation: true }));
    }
  }, [renderSequence.routeLines, renderSequence.driverLiveLocation, driverLocation, isDriver]);

  // RENDER SEQUENCE EFFECT 6: Track Shared Driver Locations ready
  useEffect(() => {
    if (!renderSequence.driverLiveLocation) return;
    if (renderSequence.sharedLocations) return;

    // CRITICAL: Check TWO sources for driver locations:
    // 1. allDriverLocations (from poller)
    // 2. window.__mapDriverLocationMarkers (rendered on map by DriverLocationMarkers)
    const mapDriverMarkers = window.__mapDriverLocationMarkers || [];
    const hasSharedLocations = allDriverLocations.length > 0 || mapDriverMarkers.length > 0;

    if (hasSharedLocations) {
      setRenderSequence((prev) => ({ ...prev, sharedLocations: true }));
      return;
    }

    // Reduce timeout to 500ms - markers should be available almost immediately
    const timer = setTimeout(() => {
      setRenderSequence((prev) => ({ ...prev, sharedLocations: true }));
    }, 500);

    return () => clearTimeout(timer);
  }, [renderSequence.driverLiveLocation, renderSequence.sharedLocations, allDriverLocations.length, isDataLoaded]);

  // RENDER SEQUENCE EFFECT 7: Wait for ALL drivers' deliveries for selected date to be ready
  useEffect(() => {
    if (!renderSequence.sharedLocations) return;
    if (renderSequence.fullDeliveriesLoaded) return;

    const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');

    // CRITICAL: Always check full deliveries array when loading/refreshing
    // This ensures "Show All" checkbox has complete data available
    const deliveriesToCheck = deliveries.filter((d) => d && d.delivery_date === selectedDateStr);
    const uniqueDrivers = new Set(deliveriesToCheck.map((d) => d?.driver_id).filter(Boolean));

    // CRITICAL: Mark ready when we have data (no artificial waiting)
    if (deliveriesToCheck.length > 0 && patients.length > 0 && stores.length > 0) {
      setRenderSequence((prev) => ({ ...prev, fullDeliveriesLoaded: true }));
      return;
    }

    // Timeout if no deliveries after 2 seconds
    const timer = setTimeout(() => {
      setRenderSequence((prev) => ({ ...prev, fullDeliveriesLoaded: true }));
    }, 2000);

    return () => clearTimeout(timer);
  }, [renderSequence.sharedLocations, renderSequence.fullDeliveriesLoaded, deliveries, selectedDate, patients.length, stores.length]);

  // Save FAB phase when navigating away from Dashboard
  useEffect(() => {
    return () => {
      // Save current FAB phase to sessionStorage on unmount
      sessionStorage.setItem('rxdeliver_dashboard_fab_phase', JSON.stringify({
        phase: mapViewPhase,
        timestamp: Date.now()
      }));
    };
  }, [mapViewPhase]);

  // RENDER SEQUENCE EFFECT 8: Activate FAB Phase (FINAL STEP)
  // Apply initial map view on first load - WAIT for full render sequence + DOM readiness
  const initialSyncCompletedRef = useRef(false);

  useEffect(() => {
    if (!renderSequence.fullDeliveriesLoaded || renderSequence.fabPhaseReady) return;
    // CRITICAL: Wait for stop cards to be measured in the DOM before activating FAB
    if (!cardsReadyForFAB) return;

    if (initialMapViewApplied) {
      setRenderSequence((prev) => ({ ...prev, fabPhaseReady: true }));
      return;
    }

    // CRITICAL: Ensure we have ALL drivers' deliveries loaded when Show All is checked
    const shouldHaveAllDeliveries = selectedDriverId === 'all' || showAllDriverMarkers;
    const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
    const deliveriesForDate = deliveries.filter((d) => d && d.delivery_date === selectedDateStr);

    // CRITICAL: Notify fabControlEvents that initial data is ready
    // This allows other components to know when dashboard is fully loaded
    fabControlEvents.notifyDataReady();

    // CRITICAL: Use double-rAF + buffer to ensure DOM is fully painted before FAB fires
    requestAnimationFrame(() => {requestAnimationFrame(() => {setTimeout(() => {
          // CRITICAL: Check BOTH filtered view AND full deliveries array to avoid stale closure clearing markers
          const _dateCheck = format(selectedDate, 'yyyy-MM-dd');
          const _hasFullData = hasDeliveryDataForSelection({ deliveries, selectedDateStr: _dateCheck, selectedDriverId });
          if (deliveriesWithStopOrder.length === 0 && !_hasFullData) {
            return;
          }
          const phaseToApply = savedFabPhaseRef.current;

          // For phase 2, require nextStop coordinates
          if (phaseToApply === 2 && !nextStopCoordinates) {
            setMapViewPhase(1);
            setIsMapViewLocked(true);
            setMapViewTrigger((prev) => prev + 1);
            setInitialMapViewApplied(true);
            setRenderSequence((prev) => ({ ...prev, fabPhaseReady: true }));

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
            return;
          }

          // For phase 3, require driver location (dispatchers can use phase 3 freely)
          if (phaseToApply === 3 && (!isDriver && !isDispatcher || !deliveriesWithStopOrder.some((d) => d && !['completed', 'failed', 'cancelled', 'returned', 'pending'].includes(d.status)))) {
            setMapViewPhase(1);
            setIsMapViewLocked(false);
            setMapViewTrigger((prev) => prev + 1);
            setInitialMapViewApplied(true);
            setRenderSequence((prev) => ({ ...prev, fabPhaseReady: true }));

            if (mapLockTimeoutRef.current) {
              clearTimeout(mapLockTimeoutRef.current);
              mapLockTimeoutRef.current = null;
            }
            mapLockExpiresAtRef.current = null;
            return;
          }

          // CRITICAL: Check if we have a saved phase from previous session (higher priority)
          let finalPhase = phaseToApply;
          if (savedFabPhaseOnUnmount) {
            finalPhase = savedFabPhaseOnUnmount;
            sessionStorage.removeItem('rxdeliver_dashboard_fab_phase');
          }

          // Apply the phase
          setMapViewPhase(finalPhase);
          setIsMapViewLocked(finalPhase !== 1);
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

          // Scroll to card with isNextDelivery=true for all phases (helps user orient)
          setTimeout(() => {
            centerNextDeliveryCard(deliveriesWithStopOrder);
          }, 500);
        }, 500);});});
  }, [renderSequence.fullDeliveriesLoaded, renderSequence.fabPhaseReady, initialMapViewApplied, deliveriesWithStopOrder.length, isDriver, driverLocation, deliveriesWithStopOrder, nextStopCoordinates, deliveries.length, allDriverLocations.length, showAllDriverMarkers, cardsReadyForFAB]);

  // CRITICAL: Use a ref to track current lock state to avoid stale closure issues in GPS callback
  const isMapViewLockedRef = useRef(isMapViewLocked);
  useEffect(() => {
    isMapViewLockedRef.current = isMapViewLocked;
  }, [isMapViewLocked]);

  // Auto-collapse card after 2 minutes
  useEffect(() => {
    if (!selectedCardId || !cardExpandedAtRef.current) return;

    const expandedAt = cardExpandedAtRef.current;
    const twoMinutes = 120000;
    const elapsed = Date.now() - expandedAt;
    const remaining = twoMinutes - elapsed;

    if (remaining <= 0) {
      setSelectedCardId(null);
      cardExpandedAtRef.current = null;
      return;
    }

    const timer = setTimeout(() => {
      setSelectedCardId(null);
      cardExpandedAtRef.current = null;
    }, remaining);

    return () => clearTimeout(timer);
  }, [selectedCardId]);

  useEffect(() => {
    if (!setOnSmartRefreshComplete) return;

    const handleSmartRefreshComplete = () => {
      // CRITICAL: For dispatchers, auto-center to next delivery card after smart refresh
      if (isDispatcher && !selectedCardId) {
        handleMapViewCycle(true);
      }
    };

    setOnSmartRefreshComplete(handleSmartRefreshComplete);

    return () => {
      setOnSmartRefreshComplete(null);
    };
  }, [setOnSmartRefreshComplete, isDispatcher, selectedCardId, deliveriesWithStopOrder]);

  // CRITICAL: Listen for smartRefreshComplete and smartRefreshRestarted events to reactivate FAB
  useEffect(() => {
    const handleSmartRefreshCompleteEvent = (event) => {
      const { updates, preserveLocalState } = event.detail || {};
      if (preserveLocalState || !updates || !updates.deliveries && !updates.appUsers) return;

      handleMapViewCycle(true);
    };

    const handleSmartRefreshRestartedEvent = () => {






      // No map repositioning on smart refresh restart - user controls map manually
    };window.addEventListener('smartRefreshComplete', handleSmartRefreshCompleteEvent);window.addEventListener('smartRefreshRestarted', handleSmartRefreshRestartedEvent);return () => {window.removeEventListener('smartRefreshComplete', handleSmartRefreshCompleteEvent);window.removeEventListener('smartRefreshRestarted', handleSmartRefreshRestartedEvent);};}, [mapViewPhase, deliveriesWithStopOrder, selectedCardId]); // Auto-center on next stop on initial load
  const hasAutoSelectedRef = useRef(false);const hasScrolledToNextCardRef = useRef(false); // Set up rate limit error handler
  useEffect(() => {window._setRateLimitError = (hasError) => {
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

  // REMOVED: Periodic route optimizer that was causing excessive Google Maps API hits
  // The app already has optimization built in via:
  // - RealTimeRouteOptimizer (event-based)
  // - Manual reoptimize FAB button
  // - Optimization during specific workflows (start delivery, status changes)
  // This 5-minute polling was redundant and causing rate limits

  // Unified initial driver selection per role rules
  useEffect(() => {
    if (!currentUser || !isDataLoaded || !driversList.length || !userSettingsLoaded || !isFiltersReady) return;
    if (hasSetInitialDriverDashboard.current) return;

    const isAdmin = userHasRole(currentUser, 'admin');
    const isDispatcherRole = userHasRole(currentUser, 'dispatcher');
    const isDriverRole = userHasRole(currentUser, 'driver');

    const driverExists = (id) => !!id && driversList.some((d) => d && d.id === id);

    const saved = globalFilters.getSelectedDriverId();
    const hasSaved = saved && saved !== 'all' && driverExists(saved);

    const dayIdx = new Date(format(selectedDate, 'yyyy-MM-dd') + 'T00:00:00').getDay();
    const isSat = dayIdx === 6;
    const isSun = dayIdx === 0;

    const getDispatcherDefaultDriverId = () => {
      const dispatcherStoreIds = (currentUser?.store_ids || []).map(String);
      const relevantStores = (stores || []).filter((s) => s && dispatcherStoreIds.includes(String(s.id)));
      const ids = new Set();
      for (const store of relevantStores) {
        if (isSat) {
          if (store.saturday_am_enabled && store.saturday_am_driver_id) ids.add(store.saturday_am_driver_id);
          if (store.saturday_pm_enabled && store.saturday_pm_driver_id) ids.add(store.saturday_pm_driver_id);
        } else if (isSun) {
          if (store.sunday_am_enabled && store.sunday_am_driver_id) ids.add(store.sunday_am_driver_id);
          if (store.sunday_pm_enabled && store.sunday_pm_driver_id) ids.add(store.sunday_pm_driver_id);
        } else {
          if (store.weekday_am_enabled && store.weekday_am_driver_id) ids.add(store.weekday_am_driver_id);
          if (store.weekday_pm_enabled && store.weekday_pm_driver_id) ids.add(store.weekday_pm_driver_id);
        }
      }
      const valid = Array.from(ids).filter(driverExists);
      return valid.length === 1 ? valid[0] : null;
    };

    let selection = 'all';

    // Admin + Driver: saved -> own -> all
    if (isAdmin && isDriverRole) {
      if (hasSaved) selection = saved;else
      if (driverExists(currentUser.id)) selection = currentUser.id;else
      selection = 'all';
    }
    // Pure Driver (not admin/dispatcher): always own
    else if (isDriverRole && !isAdmin && !isDispatcherRole) {
      selection = driverExists(currentUser.id) ? currentUser.id : 'all';
    }
    // Dispatcher (admin or not): always all drivers on load/refresh
    else if (isDispatcherRole) {
      selection = 'all';
    }
    // Admin only (not driver): saved -> all
    else if (isAdmin) {
      selection = hasSaved ? saved : 'all';
    } else {
      selection = 'all';
    }

    setSelectedDriverId(selection);
    globalFilters.setSelectedDriverId(selection);
    // Do not persist here; only user-initiated changes should save settings
    hasSetInitialDriverDashboard.current = true;
  }, [currentUser?.id, isDataLoaded, userSettingsLoaded, isFiltersReady, driversList, stores, selectedDate]);

  // CRITICAL: Reset cardsReadyForFAB when driver/date changes, then enable once cards are measured
  useEffect(() => {
    // Reset flag when driver/date changes
    setCardsReadyForFAB(false);
  }, [selectedDriverId, selectedDate]);

  // CRITICAL: Enable FAB repositioning once stop cards are measured
  useEffect(() => {
    if (stopCardsBaseHeight > 0 && !cardsReadyForFAB) {
      setCardsReadyForFAB(true);
    } else if (deliveriesWithStopOrder.length === 0 && !cardsReadyForFAB) {
      // No cards to render - enable immediately
      setCardsReadyForFAB(true);
    } else if (isAllDriversMode && !isDispatcher && !cardsReadyForFAB) {
      // All Drivers mode (non-dispatcher) - cards are hidden, FABs stay at bottom
      setCardsReadyForFAB(true);
    }
  }, [stopCardsBaseHeight, deliveriesWithStopOrder.length, cardsReadyForFAB, isAllDriversMode, isDispatcher]);

  const handleDateChange = async (date) => {
    // CRITICAL: Pause smart refresh immediately
    setIsEntityUpdating(true);setIsExpanded(false);setSelectedCardId(null);cardExpandedAtRef.current = null;setAreCardsVisible(false);setCurrentToNextPolyline(null);setDriverRoutes([]);
    // Reset route summary tracking when date changes
    hasShownSummaryRef.current.clear();

    setSelectedDate(date);
    globalFilters.setSelectedDate(date);
    setIsCalendarOpen(false);

    const dateStr = format(date, 'yyyy-MM-dd');

    try {
      // STEP 1: Clear pending updates for clean slate
      smartRefreshManager.clearPendingUpdates();

      // STEP 2: Load ALL drivers for the selected date so dashboard state stays complete
      const priorityDeliveries = await loadPriorityDeliveriesForSelection(dateStr, 'all', true);

      // STEP 3: Update UI immediately with merge-safe date data
      if (updateDeliveriesLocally) {
        updateDeliveriesLocally([...(deliveries || []).filter((d) => d && d.delivery_date !== dateStr), ...priorityDeliveries], true);

        // CRITICAL: Protect from smart refresh overwrite
        priorityDeliveries.forEach((d) => {
          if (d?.id) {
            smartRefreshManager.registerPendingUpdate(d.id, d.driver_id, dateStr);
          }
        });
      }

      // STEP 4: CRITICAL - Load fresh appUsers and process through poller
      let freshAppUsers = appUsers;

      // Try to load from offline DB first, fallback to current appUsers if empty
      try {
        const offlineAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
        if (offlineAppUsers && offlineAppUsers.length > 0) {
          freshAppUsers = offlineAppUsers;
        }
      } catch (dbError) {
        console.warn('⚠️ [Date Change] Failed to load appUsers from offline DB, using context:', dbError.message);
      }

      // CRITICAL: Use fresh appUsers from offline DB, fallback to context, but ALWAYS pass valid data
      const appUsersToProcess = freshAppUsers && freshAppUsers.length > 0 ? freshAppUsers : appUsers;

      if (appUsersToProcess && appUsersToProcess.length > 0) {
        driverLocationPoller.processLocationData(
          currentUser,
          priorityDeliveries,
          drivers,
          stores,
          appUsersToProcess,
          new Date(dateStr + 'T00:00:00'),
          true,
          'Dashboard',
          showAllDriverMarkers || selectedDriverId === 'all'
        );

        // Dispatch location update event
        window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
          detail: { appUsers: appUsersToProcess, forceAll: true }
        }));
      } else {
        console.warn('⚠️ [Date Change] No appUsers available from offline DB or context - skipping location processing');
      }

      // STEP 5: Dispatch event to force map and stop cards to re-render
      // CRITICAL: NO route optimization on date change
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { deliveryDate: dateStr, triggeredBy: 'dateChange', preserveLocalState: true, freshDeliveries: priorityDeliveries }
      }));

      // CRITICAL: Force stats refresh immediately after date change
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

      // STEP 6: Wait a bit longer so markers are actually rendered before FAB/map trigger
      await new Promise((resolve) => setTimeout(resolve, 650));

      setIsMapViewLocked(mapViewPhase !== 1);
      lastProgrammaticMapMoveRef.current = Date.now();
      window._lastProgrammaticMapMove = Date.now();
      setMapViewTrigger((prev) => prev + 1);

      if (mapLockTimeoutRef.current) {
        clearTimeout(mapLockTimeoutRef.current);
        mapLockTimeoutRef.current = null;
      }
      mapLockExpiresAtRef.current = null;

      centerNextDeliveryCard(deliveriesWithStopOrder);
      fabControlEvents.notifyDataReady();

      // STEP 7: Resume UI after FAB/map trigger is scheduled from fresh data
      setIsEntityUpdating(false);

      // STEP 8: No background loads needed - we already loaded all drivers' deliveries

    } catch (error) {
      console.error('❌ [Dashboard] Date change failed:', error);
      setIsEntityUpdating(false);
    }
  };

  const driverChangeInProgressRef = useRef(false),driverChangeRequestIdRef = useRef(0);

  const handleDriverChange = async (driverId) => {
    const reqId = Date.now();
    driverChangeRequestIdRef.current = reqId;
    driverChangeInProgressRef.current = true;
    hasShownSummaryRef.current.clear();
    const nextTrigger = mapViewTrigger + 1;
    lastAppliedTriggerRef.current = nextTrigger;
    setSelectedDriverId(driverId);globalFilters.setSelectedDriverId(driverId);
    try {
      setIsExpanded(false);setSelectedCardId(null);cardExpandedAtRef.current = null;setAreCardsVisible(false);setCurrentToNextPolyline(null);setDriverRoutes([]);window.dispatchEvent(new CustomEvent('clearRoutePolylines'));
      setIsEntityUpdating(true);

      // CRITICAL: Uncheck "Show All" when switching to "All Drivers" mode to prevent duplicate markers
      if (driverId === 'all' && showAllDriverMarkers) {
        setShowAllDriverMarkers(false);
        if (currentUser?.id) {
          saveSetting(currentUser.id, 'show_all_driver_markers', false);
        }
      }

      if (currentUser?.id) {
        saveSetting(currentUser.id, 'selected_driver_id', driverId);
      }

      const dateStr = format(selectedDate, 'yyyy-MM-dd');

      // Load ALL drivers for the selected date so dashboard state stays complete
      const freshDeliveries = await loadPriorityDeliveriesForSelection(dateStr, 'all', true);

      if (driverChangeRequestIdRef.current !== reqId) return;
      if (driverId && driverId !== 'all') {
        smartRefreshManager.clearPendingUpdatesForDriver(driverId, dateStr);
      } else {
        smartRefreshManager.clearPendingUpdates();
      }

      if (updateDeliveriesLocally) {
        updateDeliveriesLocally(mergeDeliveriesForDate({ deliveries, selectedDateStr: dateStr, freshDeliveries }), true);
      }

      // CRITICAL: Wait for markers to render BEFORE dispatching event or triggering map
      await new Promise((resolve) => setTimeout(resolve, 650));
      if (driverChangeRequestIdRef.current !== reqId) return;

      // CRITICAL: NO route optimization on driver change - preserve imported stop order
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { driverId, deliveryDate: dateStr, triggeredBy: 'driverChange' }
      }));

      // CRITICAL: Force stats refresh immediately after driver change
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

      // CRITICAL: Trigger FAB/map only after priority load + render is complete
      if (mapLockTimeoutRef.current) {
        clearTimeout(mapLockTimeoutRef.current);
        mapLockTimeoutRef.current = null;
      }
      mapLockExpiresAtRef.current = null;

      setIsMapViewLocked(mapViewPhase !== 1);
      lastProgrammaticMapMoveRef.current = Date.now();
      window._lastProgrammaticMapMove = Date.now();
      setMapViewTrigger(nextTrigger);
      centerNextDeliveryCard(deliveriesWithStopOrder);

      if (mapLockTimeoutRef.current) {
        clearTimeout(mapLockTimeoutRef.current);
        mapLockTimeoutRef.current = null;
      }
      mapLockExpiresAtRef.current = null;
    } catch (error) {
      console.error('❌ [Dashboard] Driver change failed:', error);
    } finally {
      if (driverChangeRequestIdRef.current === reqId) {
        setIsEntityUpdating(false);
        driverChangeInProgressRef.current = false;
      }
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
      setSelectedCardId(null);
      setHighlightedCardId(null);
      if (previousMapState?.center && Number.isFinite(previousMapState?.zoom)) {
        setShouldFitBounds(null);setMapCenter(previousMapState.center);setMapZoom(previousMapState.zoom);
        lastProgrammaticMapMoveRef.current = Date.now();window._lastProgrammaticMapMove = Date.now();
      }
      setPreviousMapState(null);
    } else {
      // Card is being expanded

      // CRITICAL: For dispatchers clicking on non-assigned stops, collapse any expanded card first
      if (isDispatcher && currentUser?.store_ids && !currentUser.store_ids.includes(delivery.store_id)) {
        if (selectedCardId) {
          setSelectedCardId(null);
          setHighlightedCardId(null);
          cardExpandedAtRef.current = null;
        }
      }

      setPreviousMapState({ center: Array.isArray(mapCenter) ? [...mapCenter] : null, zoom: mapZoom });

      setSelectedCardId(delivery.id);
      setHighlightedCardId(delivery.id);
      cardExpandedAtRef.current = Date.now();

      if (mapLockTimeoutRef.current) {clearTimeout(mapLockTimeoutRef.current);mapLockTimeoutRef.current = null;}
      mapLockExpiresAtRef.current = null;
      window.__fabRelockPhase = mapViewPhase === 2 || mapViewPhase === 3 ? mapViewPhase : null;
      setIsMapViewLocked(false);

      // CRITICAL: Wait for card expansion animation, then measure and center on mobile
      const centerMarkerWithPadding = () => {
        if (isMobile) {
          // Measure actual expanded height after animation completes
          setTimeout(() => {
            const container = stopCardsContainerRef.current;
            const actualHeight = container?.offsetHeight || stopCardsBaseHeight || 0;

            const statsCardCurrHeight = statsCardRef.current?.offsetHeight || 75;
            const topPadding = statsCardCurrHeight + 25;
            const bottomPadding = actualHeight > 0 ? actualHeight + 10 : 25;

            const padding = {
              paddingTopLeft: [25, topPadding],
              paddingBottomRight: [25, bottomPadding]
            };

            const appUser = appUsers.find((u) => u?.user_id === delivery.driver_id || u?.id === delivery.driver_id),bounds = [];
            if (delivery.patient_id) {
              const patient = patients.find((p) => p.id === delivery.patient_id);
              if (patient?.latitude && patient?.longitude) bounds.push([patient.latitude, patient.longitude]);
            } else if (delivery.store_id) {
              const store = stores.find((s) => s.id === delivery.store_id);
              if (store?.latitude && store?.longitude) bounds.push([store.latitude, store.longitude]);
            }
            if (appUser?.current_latitude && appUser?.current_longitude) bounds.push([appUser.current_latitude, appUser.current_longitude]);
            if (bounds.length) {
              setShouldFitBounds({ bounds, options: { ...padding, maxZoom: 17.5, animate: true, duration: 0.9, easeLinearity: 0.15 } });
              setMapCenter(null);setMapZoom(null);
            }
            if (delivery.isNextDelivery && window.__fabRelockPhase) {setMapViewPhase(window.__fabRelockPhase);setIsMapViewLocked(true);}
          }, 350);
        } else {
          const padding = getMapPadding(),appUser = appUsers.find((u) => u?.user_id === delivery.driver_id || u?.id === delivery.driver_id),bounds = [];
          if (delivery.patient_id) {
            const patient = patients.find((p) => p.id === delivery.patient_id);
            if (patient?.latitude && patient?.longitude) bounds.push([patient.latitude, patient.longitude]);
          } else if (delivery.store_id) {
            const store = stores.find((s) => s.id === delivery.store_id);
            if (store?.latitude && store?.longitude) bounds.push([store.latitude, store.longitude]);
          }
          if (appUser?.current_latitude && appUser?.current_longitude) bounds.push([appUser.current_latitude, appUser.current_longitude]);
          if (bounds.length) {
            setShouldFitBounds({ bounds, options: { ...padding, maxZoom: 17.5, animate: true, duration: 0.9, easeLinearity: 0.15 } });
            setMapCenter(null);setMapZoom(null);
          }
          if (delivery.isNextDelivery && window.__fabRelockPhase) {setMapViewPhase(window.__fabRelockPhase);setIsMapViewLocked(true);}
        }
      };

      centerMarkerWithPadding();

      // CRITICAL: Auto-center card in horizontal scroll - increased delay for reliability
      setTimeout(() => {
        const cardElement = document.getElementById(`stop-card-${delivery.id}`);
        if (cardElement) {
          cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
      }, 300);
    }
  };

  const handleSaveDelivery = async (deliveryData) => {
    setIsEntityUpdating(true);
    pauseOfflineSync();
    smartRefreshManager.pause();
    await new Promise((resolve) => setTimeout(resolve, 100));

    try {
      if (deliveryData._isBatchSave && deliveryData._stagedDeliveries) {
        const { handleBatchSaveDelivery } = await import('@/components/dashboard/handleBatchSaveDelivery');
        await handleBatchSaveDelivery({
          deliveryData, drivers, deliveries, patients, stores, currentUser, selectedDate, invalidate, updateDeliveriesLocally, refreshData, setShowDeliveryForm, setEditingDelivery, hasAutoSelectedRef,
          invalidateDeliveriesForDate: () => {
            invalidate('Delivery');
          }
        });
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
        await saveDriverChangedDelivery({ base44, deliveries, editingDelivery, deliveryData, deliveryDate, driverId, driver, originalDriverId });
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
        invalidate('Delivery');
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
      const isInterStore = deliveryData.patient_name?.toLowerCase().includes('interstore') || deliveryData.delivery_notes?.toLowerCase().includes('interstore');
      const specialStoreNames = ['Lakeland Ridge', 'Sherwood Pk Mall', 'SouthPoint', 'WestPark'];
      const isSpecialStore = deliveryStore && specialStoreNames.includes(deliveryStore.name);
      const storesToCheck = isInterStore ? [] : isSpecialStore ? deliveryStore ? [deliveryStore] : [] : isFirstStop ? assignedStores : deliveryStore ? [deliveryStore] : [];

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
            // CRITICAL: Find NEW en_route pickup - match by store, ampm_deliveries, exclude finished
            const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
            const correspondingPickup = stopsToProcess.find((s) => {
              if (!s) return false;
              if (s.patient_id !== null) return false; // Must be a pickup
              if (s.store_id !== stop.store_id) return false; // Must be same store
              if (s.ampm_deliveries && stop.ampm_deliveries && s.ampm_deliveries !== stop.ampm_deliveries) return false; // Must match AM/PM
              if (finishedStatuses.includes(s.status)) return false; // Skip completed pickups
              return true;
            }) || stopsToProcess.find((s) => {
              // Fallback: new pickups only (just created)
              if (!s || !s.isNew) return false;
              if (s.patient_id !== null) return false;
              if (s.store_id !== stop.store_id) return false;
              return true;
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

        const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
        const aFinished = finishedStatuses.includes(a.status);
        const bFinished = finishedStatuses.includes(b.status);

        // Completed stops first (sorted by their stop_order)
        if (aFinished && !bFinished) return -1;
        if (!aFinished && bFinished) return 1;

        // Both completed - sort by stop_order
        if (aFinished && bFinished && a.stop_order && b.stop_order) {
          return a.stop_order - b.stop_order;
        }

        // Both incomplete - sort by time, new stops get sorted with existing
        const timeA = a.delivery_time_start || '99:99';
        const timeB = b.delivery_time_start || '99:99';
        return timeA.localeCompare(timeB);
      });

      for (const stop of optimizedRoute) {
        if (!stop) continue; // Defensive check

        if (stop.patient_id !== null) {
          const stopPatient = patients.find((p) => p.id === stop.patient_id);

          // CRITICAL: Find NEW en_route pickup - match by store, ampm_deliveries, exclude finished
          const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
          const correspondingPickup = optimizedRoute.find((s) => {
            if (!s) return false;
            if (s.patient_id !== null) return false; // Must be a pickup
            if (s.store_id !== stop.store_id) return false; // Must be same store
            if (s.ampm_deliveries && stop.ampm_deliveries && s.ampm_deliveries !== stop.ampm_deliveries) return false; // Must match AM/PM
            if (finishedStatuses.includes(s.status)) return false; // Skip completed pickups
            return true;
          }) || optimizedRoute.find((s) => {
            // Fallback: new pickups only (just created)
            if (!s || !s.isNew) return false;
            if (s.patient_id !== null) return false;
            if (s.store_id !== stop.store_id) return false;
            return true;
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
        if (!stop) continue;
        if (stop.patient_id === null && stop.delivery_time_start) {
          storeAMPMMap[stop.store_id] = determineAMPMFromTime(stop.delivery_time_start);
        }
      }
      for (const stop of optimizedRoute) {
        if (!stop) continue;
        stop.ampm_deliveries = storeAMPMMap[stop.store_id] || determineAMPMFromTime(stop.delivery_time_start);
      }

      let pickupTRCounter = 0;
      const storePickupTRMap = {};

      for (const stop of optimizedRoute) {
        if (!stop || stop.patient_id !== null) continue;
        stop.tracking_number = String(pickupTRCounter).padStart(2, '0');
        storePickupTRMap[stop.store_id] = pickupTRCounter;
        pickupTRCounter += 20;
      }
      for (const stop of optimizedRoute) {
        if (!stop || stop.patient_id === null) continue;
        const pickupBaseTR = storePickupTRMap[stop.store_id];
        if (pickupBaseTR !== undefined) {
          const before = optimizedRoute.filter((s) => s && s.patient_id !== null && s.store_id === stop.store_id && optimizedRoute.indexOf(s) < optimizedRoute.indexOf(stop)).length;
          stop.tracking_number = String(pickupBaseTR + before + 1).padStart(2, '0');
        } else {
          stop.tracking_number = '99';
        }
      }

      let createdCount = 0;
      let updatedCount = 0;

      for (let i = 0; i < optimizedRoute.length; i++) {
        const stop = optimizedRoute[i];
        if (!stop) continue;
        const stopPatient = patients.find((p) => p && p.id === stop.patient_id);
        const stopStore = stores.find((s) => s && s.id === stop.store_id);
        stop.stop_order = i + 1;
        if (!stop.stop_id) stop.stop_id = generateUniqueSID(allDeliveriesForDate);
        const deliveryId = stop.delivery_id || `DID-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const payload = {
          delivery_id: deliveryId,
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
          barcode_values: Array.isArray(stop.barcode_values) ? stop.barcode_values : [], receipt_barcode_values: Array.isArray(stop.receipt_barcode_values) ? stop.receipt_barcode_values : [],
          ampm_deliveries: stop.ampm_deliveries, prescription_number: stop.prescription_number || '',
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

      // CRITICAL: Force stats refresh after save
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));


      hasAutoSelectedRef.current = false; // Reset to allow auto-selection after saving

    } catch (error) {
      console.error('');
      console.error('❌❌❌ ERROR ❌❌❌');
      console.error('Error saving delivery:', error);
      console.error('Stack trace:', error.stack);
      console.error('');
      alert(`Failed to save delivery: ${error.message}`);
      throw error;
    } finally {
      // Resume smart refresh and offline sync only
      await new Promise((resolve) => setTimeout(resolve, 1000));

      resumeOfflineSync();
      smartRefreshManager.resume();

      setIsEntityUpdating(false);
    }
  };

  const handleReoptimizeRoute = async () => {
    try {
      setIsReoptimizing(true);
      setOptimizationMessage('Re-optimizing route...');

      // CRITICAL: Pause smart refresh manager BEFORE optimization
      setIsEntityUpdating(true);
      pauseOfflineMutations();
      pauseOfflineSync();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const deliveryDate = format(selectedDate, 'yyyy-MM-dd');
      const now = new Date();
      const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      const response = await base44.functions.invoke('optimizeRemainingStops', {
        driverId: currentUser.id,
        deliveryDate: deliveryDate,
        currentLocalTime: currentLocalTime,
        deviceTime: now.toISOString()
      });

      const data = response?.data || response;

      if (data?.success) {
        setOptimizationMessage(`Route optimized! ${data.optimizedCount} stops updated.`);

        // Refresh data to show new order
        invalidate('Delivery');
        await refreshData();

        // CRITICAL: Force map to re-render route lines
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: { driverId: currentUser.id, deliveryDate: deliveryDate, triggeredBy: 'reoptimizeRoute' }
        }));

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
      console.error('❌ [handleReoptimizeRoute] Error:', error);
      setOptimizationMessage(`Error: ${error.message}`);
      setTimeout(() => setOptimizationMessage(null), 5000);
    } finally {
      // CRITICAL: Resume smart refresh, offline sync, and mutations AFTER optimization
      resumeOfflineMutations();
      resumeOfflineSync();
      setIsEntityUpdating(false);
      await new Promise((resolve) => setTimeout(resolve, 100));

      setIsReoptimizing(false);
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
            if (!stop) continue;
            await updateDeliveryLocal(stop.id, { stop_order: i + 1 });
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

  const handleCreatePatientFromDelivery = (callback, initialData = null, mode = null) => {
    setEditingPatient(initialData);
    setPatientFormCallback(() => callback);
    setPatientFormMode(mode); // 'duplicate' | 'newAddress' | null
    setShowPatientForm(true);
  };

  const handleSavePatient = async (patientData) => {
    setShowPatientForm(false);

    if (patientFormCallback && patientData) {
      patientFormCallback(patientData);
    }

    setEditingPatient(null);
    setPatientFormCallback(null);
    setPatientFormMode(null);
  };

  const triggerPostDeleteOperations = async (driverId, deliveryDate) => {
    try {
      setIsEntityUpdating(true);
      pauseOfflineSync();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Recalculate stop orders for remaining deliveries
      await recalculateStopOrders(driverId, deliveryDate);
      // Re-optimize route and update ETAs
      try {
        const now = new Date();
        const localTimeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        await base44.functions.invoke('optimizeRouteRealTime', {
          driverId: driverId,
          deliveryDate: deliveryDate,
          currentLocalTime: localTimeString,
          deviceTime: now.toISOString(),
          generatePolyline: true
        });

        await base44.functions.invoke('calculateRealTimeETA', {
          driverId: driverId,
          deliveryDate: deliveryDate,
          currentLocalTime: localTimeString
        });

      } catch (optimizeError) {
        console.warn('  ⚠️ Route optimization/ETA update failed:', optimizeError.message);
      }

      // Refresh data and update map
      invalidate('Delivery');
      await refreshData();

      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { driverId, deliveryDate, triggeredBy: 'deleteDelivery' }
      }));
    } catch (error) {
      console.error('❌ [DELETE] Background operations failed:', error);
    } finally {
      resumeOfflineSync();
      setIsEntityUpdating(false);
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
      const isPickup = !targetDelivery.patient_id;

      // CRITICAL: If deleting a pickup, also delete any pending deliveries assigned to it
      if (isPickup && targetDelivery.stop_id) {
        const pendingDeliveriesForPickup = deliveriesWithStopOrder.filter((d) =>
        d && d.puid === targetDelivery.stop_id && d.status === 'pending' && d.patient_id
        );

        if (pendingDeliveriesForPickup.length > 0) {
          // Delete all pending deliveries first
          const { deleteDeliveryLocal } = await import('../components/utils/offlineMutations');
          for (const pendingDelivery of pendingDeliveriesForPickup) {
            await deleteDeliveryLocal(pendingDelivery.id);
          }
        }
      }

      // CRITICAL: Delete Square COD item if delivery has COD and is in_transit
      if (targetDelivery.status === 'in_transit' && targetDelivery.cod_total_amount_required > 0 && targetDelivery.patient_id) {
        try {
          await base44.functions.invoke('squareDeleteCodItem', {
            deliveryId: deliveryId,
            reason: 'delivery_deleted'
          });
        } catch (squareError) {
          console.error('⚠️ [Delete] Failed to delete Square COD item:', squareError);
        }
      }

      // CRITICAL: Use deleteDeliveryLocal which handles UI update, offline DB, and backend sync
      const { deleteDeliveryLocal } = await import('../components/utils/offlineMutations');

      // Initiate deletion (returns promise)
      const deletionPromise = deleteDeliveryLocal(deliveryId);

      // Clear selection immediately - this closes the dialog
      if (selectedCardId === deliveryId) {
        setSelectedCardId(null);
      }

      // Trigger background operations without awaiting (fire and forget)
      triggerPostDeleteOperations(driverId, deliveryDate);

      // Ensure the deletion completes in the background
      await deletionPromise;

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
      // Pause ALL update systems
      setIsEntityUpdating(true);
      pauseOfflineMutations();
      pauseOfflineSync();
      smartRefreshManager.pause();

      await new Promise((resolve) => setTimeout(resolve, 100));

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

      // Send notification: Driver retrying delivery
      try {
        const deliveryStore = stores.find((s) => s?.id === originalDelivery?.store_id);
        await notifyDriverRetry({
          driver: currentUser,
          patientName: originalDelivery?.patient_name || 'Unknown',
          delivery: originalDelivery,
          store: deliveryStore,
          appUsers: appUsers
        });
      } catch (notifyError) {
        console.warn('⚠️ [RESTART] Failed to send notification:', notifyError);
      }

      // Recalculate stop orders
      await recalculateStopOrders(driverId, deliveryDate);

      // Fetch fresh data and save to offline DB
      invalidate('Delivery');
      const freshDeliveries = await base44.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      });

      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);

      // Protect from smart refresh overwrite
      freshDeliveries.forEach((d) => {
        if (d?.id) {
          smartRefreshManager.registerPendingUpdate(d.id, driverId, deliveryDate);
        }
      });

      await refreshData();

    } catch (error) {
      console.error('Error restarting delivery:', error);
      alert('Failed to restart delivery. Please try again.');
    } finally {
      // Resume all systems
      await new Promise((resolve) => setTimeout(resolve, 1000));

      resumeOfflineMutations();
      resumeOfflineSync();
      smartRefreshManager.resume();

      setIsEntityUpdating(false);
    }
  };

  const handleStatusUpdate = async (deliveryId, newStatus, extraData = {}, skipAutoCenter = false) => {
    const statusLockKey = `${deliveryId}:${newStatus}`;
    if (statusUpdateLockRef.current.has(statusLockKey)) return;
    statusUpdateLockRef.current.add(statusLockKey);
    let driverId = null,deliveryDate = null,pendingBreadcrumbDriverAppUserId = null;

    // STEP 0: Pause smart refresh and offline sync only (NOT mutations - we bypass them)
    setIsEntityUpdating(true);
    pauseOfflineSync();
    smartRefreshManager.pause();

    await new Promise((resolve) => setTimeout(resolve, 100));

    // CRITICAL: Capture current FAB state
    const wasPhase2Locked = mapViewPhase === 2 && isMapViewLocked;
    const currentPhase = mapViewPhase;

    // CRITICAL: Unlock FAB if in Phase 2 (will be re-locked after status update)
    if (wasPhase2Locked) {
      if (mapLockTimeoutRef.current) {
        clearTimeout(mapLockTimeoutRef.current);
        mapLockTimeoutRef.current = null;
      }
      mapLockExpiresAtRef.current = null;
      setIsMapViewLocked(false);
    }

    // CRITICAL: Pause theme transitions during status updates to prevent UI glitches
    document.documentElement.style.setProperty('--theme-transition-duration', '0s');

    try {
      const targetDelivery = deliveriesWithStopOrder.find((d) => d && d.id === deliveryId);
      if (!targetDelivery) {
        console.error('❌ [STATUS] Delivery not found in deliveriesWithStopOrder');
        console.error('   Looking for ID:', deliveryId);
        console.error('   Available IDs:', deliveriesWithStopOrder.map((d) => d?.id));
        throw new Error('Delivery not found');
      }

      // CRITICAL: Assign to outer scope variables
      driverId = targetDelivery.driver_id;
      deliveryDate = targetDelivery.delivery_date;

      const currentDate = getEdmDate();
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
        invalidate('Delivery');
        await refreshData();
        return;
      }

      const currentTime = new Date();
      // CRITICAL: Always use local time string - never UTC ISO (avoids timezone offset in stored timestamps)
      const _h = String(currentTime.getHours()).padStart(2, '0');
      const _m = String(currentTime.getMinutes()).padStart(2, '0');
      const _s = String(currentTime.getSeconds()).padStart(2, '0');
      const _yr = currentTime.getFullYear();
      const _mo = String(currentTime.getMonth() + 1).padStart(2, '0');
      const _dy = String(currentTime.getDate()).padStart(2, '0');
      let currentTimeISO = `${_yr}-${_mo}-${_dy}T${_h}:${_m}:${_s}`;

      const updateData = { status: newStatus, ...extraData };

      // CRITICAL: Auto-fill COD payment when completing delivery with COD
      if (newStatus === 'completed' && targetDelivery.cod_total_amount_required > 0) {
        const hasCODPayments = targetDelivery.cod_payments &&
        Array.isArray(targetDelivery.cod_payments) &&
        targetDelivery.cod_payments.length > 0 &&
        targetDelivery.cod_payments.some((p) => p?.amount > 0);

        if (!hasCODPayments) {
          updateData.cod_payments = [
          {
            type: 'Cash',
            amount: targetDelivery.cod_total_amount_required
          }];

        }
      }

      // CRITICAL: Set delivery_time_start to current time + 5 minutes when transitioning to in_transit
      if (newStatus === 'in_transit' || newStatus === 'en_route') {
        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const startMinutes = currentMinutes + 5;
        updateData.delivery_time_start = `${String(Math.floor(startMinutes / 60) % 24).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`;
      }

      if (['completed', 'failed', 'cancelled'].includes(newStatus)) {
        updateData.isNextDelivery = false;
        const finishedStatuses = ['completed', 'failed', 'cancelled'];
        const completedStops = deliveriesWithStopOrder.
        filter((d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate && finishedStatuses.includes(d.status)).
        sort((a, b) => {
          if (!a.actual_delivery_time || !b.actual_delivery_time) return 0;
          return new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time);
        });

        if (completedStops.length === 0) updateData.travel_dist = 0;else
        {
          const lastStop = completedStops[completedStops.length - 1];
          let lastLat, lastLon, currentLat, currentLon;
          if (lastStop.patient_id) {
            const lastPatient = patients.find((p) => p && p.id === lastStop.patient_id);
            lastLat = lastPatient?.latitude;
            lastLon = lastPatient?.longitude;
          } else if (lastStop.store_id) {
            const lastStore = stores.find((s) => s && s.id === lastStop.store_id);
            lastLat = lastStore?.latitude;
            lastLon = lastStore?.longitude;
          }
          if (targetDelivery.patient_id) {
            const currentPatient = patients.find((p) => p && p.id === targetDelivery.patient_id);
            currentLat = currentPatient?.latitude;
            currentLon = currentPatient?.longitude;
          } else if (targetDelivery.store_id) {
            const currentStore = stores.find((s) => s && s.id === targetDelivery.store_id);
            currentLat = currentStore?.latitude;
            currentLon = currentStore?.longitude;
          }
          if (lastLat && lastLon && currentLat && currentLon) {
            const distance = calculateDistance(lastLat, lastLon, currentLat, currentLon);
            updateData.travel_dist = Math.round(distance * 100) / 100;
          } else updateData.travel_dist = 0;
        }

        const driverAppUser = (appUsers || []).find((user) => user?.user_id === driverId) || (await base44.entities.AppUser.filter({ user_id: driverId }))[0];
        pendingBreadcrumbDriverAppUserId = driverAppUser?.id || null;
        const pendingBreadcrumbs = pendingBreadcrumbDriverAppUserId ? await offlineDB.getById(offlineDB.STORES.PENDING_BREADCRUMBS, pendingBreadcrumbDriverAppUserId) : null;
        if (Array.isArray(pendingBreadcrumbs?.breadcrumbs) && pendingBreadcrumbs.breadcrumbs.length) {
          updateData.delivery_route_breadcrumbs = JSON.stringify(pendingBreadcrumbs.breadcrumbs);
        }
      }

      // CRITICAL: Time rounding ONLY for first and last stop of the day
      if (['completed', 'failed', 'delivered'].includes(newStatus) || newStatus === 'cancelled' && isPickup) {
        const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
        const allDriverStops = deliveriesWithStopOrder.filter((d) =>
        d && d.driver_id === driverId && d.delivery_date === deliveryDate
        );

        const completedStopsCount = allDriverStops.filter((d) => finishedStatuses.includes(d.status)).length;
        const isFirstStop = completedStopsCount === 0;
        const incompleteStopsCount = allDriverStops.filter((d) => !finishedStatuses.includes(d.status)).length;
        const isLastStop = incompleteStopsCount === 1;

        if (isFirstStop || isLastStop) {
          currentTimeISO = roundCompletionTime(currentTimeISO);
        }

        updateData.actual_delivery_time = currentTimeISO;
      } else {
        updateData.actual_delivery_time = null;
      }

      // CRITICAL: Collapse all expanded stop cards when completing or failing a delivery
      if (['completed', 'failed', 'cancelled'].includes(newStatus)) {
        setSelectedCardId(null);
        setHighlightedCardId(null);
        cardExpandedAtRef.current = null;
      }

      // STEP 1: Update isNextDelivery flags LOCALLY (instant)
      if (['completed', 'failed', 'cancelled'].includes(newStatus)) {
        const allDriverDeliveriesForDate = deliveriesWithStopOrder.filter((d) =>
        d && d.driver_id === driverId && d.delivery_date === deliveryDate
        );

        // Reset flags for other deliveries
        const resetPromises = allDriverDeliveriesForDate.
        filter((d) => d.isNextDelivery && d.id !== deliveryId).
        map((d) => updateDeliveryLocal(d.id, { isNextDelivery: false }, { skipSmartRefresh: true }));

        if (resetPromises.length > 0) {
          await Promise.all(resetPromises);
        }

        // Find next incomplete and mark as next
        const incompleteDeliveries = allDriverDeliveriesForDate.
        filter((d) => d.id !== deliveryId && !['completed', 'failed', 'cancelled'].includes(d.status) && d.status !== 'pending').
        sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

        if (incompleteDeliveries.length > 0) {
          const nextStop = incompleteDeliveries[0];
          await updateDeliveryLocal(nextStop.id, { isNextDelivery: true }, { skipSmartRefresh: true });
        }
      }


      // STEP 2: Update delivery status DIRECTLY to database (bypass offline mutations)
      try {
        await base44.entities.Delivery.update(deliveryId, updateData);
        // CRITICAL: Trigger explicit delivery broadcast for real-time listeners
        window.dispatchEvent(new CustomEvent('deliveryUpdated', {
          detail: {
            deliveryId,
            updates: updateData,
            driverId,
            deliveryDate,
            source: 'statusUpdate'
          }
        }));

        // Update offline DB using bulkSave (save method may not exist)
        const freshDelivery = await base44.entities.Delivery.filter({ id: deliveryId });
        if (freshDelivery?.length > 0) await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [freshDelivery[0]]);
        if (pendingBreadcrumbDriverAppUserId) {
          await offlineDB.deleteRecord(offlineDB.STORES.PENDING_BREADCRUMBS, pendingBreadcrumbDriverAppUserId);
          if (showBreadcrumbs && selectedDriverId === driverId) setBreadcrumbsData((prev) => ({ ...prev, current: [] }));
        }
      } catch (updateError) {
        console.error('═══════════════════════════════════════════════════');
        console.error('❌ [STATUS] Database update FAILED');
        console.error('   Error:', updateError);
        console.error('   Error message:', updateError.message);
        console.error('   Error response:', updateError.response);
        console.error('═══════════════════════════════════════════════════');
        throw updateError;
      }

      // STEP 3: Update UI state directly (no offline DB refresh to avoid timing issues)
      if (updateDeliveriesLocally) {
        // CRITICAL: Just update the single delivery that changed, don't wipe and replace all deliveries
        const updatedDelivery = deliveries.find((d) => d?.id === deliveryId);
        if (updatedDelivery) {
          updateDeliveriesLocally([{ ...updatedDelivery, ...updateData }], false);
        } else {
          console.warn('⚠️ [STATUS] Delivery not found in deliveries array for UI update');
        }
      } else {
        console.warn('⚠️ [STATUS] updateDeliveriesLocally is not available');
      }

      // STEP 4: Update patient's last_delivery_date (background, non-blocking)
      if (['completed', 'failed'].includes(newStatus) && targetDelivery.patient_id) {
        base44.entities.Patient.update(targetDelivery.patient_id, {
          last_delivery_date: deliveryDate
        }).catch((error) => console.warn('⚠️ Patient last_delivery_date update failed:', error));
      }

      // CRITICAL: Update driver's location when completing or failing a stop
      if (['completed', 'failed'].includes(newStatus)) {
        const updateDriverLocation = async () => {
          try {
            // Get stop coordinates
            let stopLat, stopLon;
            if (targetDelivery.patient_id) {
              const patient = patients.find((p) => p?.id === targetDelivery.patient_id);
              stopLat = patient?.latitude;
              stopLon = patient?.longitude;
            } else if (targetDelivery.store_id) {
              const store = stores.find((s) => s?.id === targetDelivery.store_id);
              stopLat = store?.latitude;
              stopLon = store?.longitude;
            }

            if (!stopLat || !stopLon || !driverId) {
              console.warn('⚠️ Missing coordinates or driver ID - skipping location update');
              return;
            }

            // Find AppUser record
            const appUsersList = await base44.entities.AppUser.filter({ user_id: driverId });
            const appUser = appUsersList?.[0];

            if (!appUser) {
              console.warn('⚠️ AppUser not found - skipping location update');
              return;
            }

            const nowISO = new Date().toISOString();

            // Update AppUser with stop coordinates
            await base44.entities.AppUser.update(appUser.id, {
              current_latitude: stopLat,
              current_longitude: stopLon,
              location_updated_at: nowISO
            });

            // Update offline DB
            const updatedAppUser = await base44.entities.AppUser.filter({ id: appUser.id });
            if (updatedAppUser && updatedAppUser.length > 0) {
              await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, [updatedAppUser[0]]);
            }

            // Broadcast update
            window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
              detail: { appUsers: [updatedAppUser[0]], singleUpdate: true }
            }));

            // CRITICAL: Reset smart refresh and location poller timers to prevent immediate duplicate update
            smartRefreshManager.resetTimers();
            driverLocationPoller.resetTimers();
          } catch (error) {
            console.warn('⚠️ Driver location update failed:', error.message);
          }
        };

        updateDriverLocation().catch(console.error);
      }

      // STEP 5: Check route completion and show dialogs (non-blocking)
      const finishedStatuses = ['completed', 'failed', 'cancelled'];
      const isReturnByMarkers = (d) => {
        if (!d || !d.patient_id) return false;
        const patient = patients.find((p) => p && p.id === d.patient_id);
        const notes = d.delivery_notes || '';
        const patientName = d.patient_name || '';
        const patientFullName = patient?.full_name || '';
        return notes.toLowerCase().includes('(rtn)') || patientName.toLowerCase().includes('(rtn)') ||
        patientFullName.toLowerCase().includes('(rtn)') || /\breturn\b/i.test(notes) ||
        /\breturn\b/i.test(patientName) || /\breturn\b/i.test(patientFullName);
      };

      const allDriverDeliveries = deliveriesWithStopOrder.filter((d) =>
      d && d.driver_id === driverId && d.delivery_date === deliveryDate
      );
      const patientDeliveriesOnly = allDriverDeliveries.filter((d) => d && d.patient_id);
      const routeComplete = patientDeliveriesOnly.length > 0 &&
      patientDeliveriesOnly.every((d) => finishedStatuses.includes(d.status) || isReturnByMarkers(d));

      // CRITICAL: Check if this was the last incomplete stop
      const incompleteDeliveriesCount = deliveriesWithStopOrder.filter((d) =>
      d && d.driver_id === driverId && d.delivery_date === deliveryDate &&
      !finishedStatuses.includes(d.status) && d.status !== 'pending'
      ).length;

      const wasLastStop = incompleteDeliveriesCount === 1; // Before this update, there was 1 incomplete (the one we just finished)

      // CRITICAL: For dispatchers, check if ALL drivers assigned to their stores are now done
      let wasLastDispatcherStop = false;
      if (isDispatcher && !isAdmin && wasLastStop) {
        const dispatcherStoreIds = new Set((currentUser?.store_ids || []).map((id) => String(id)));
        const allDateDeliveries = deliveriesWithStopOrder.filter((d) => d && d.delivery_date === deliveryDate);
        // Any incomplete stops (excluding the current one being completed) in dispatcher's stores?
        const remainingDispatcherIncomplete = allDateDeliveries.filter((d) =>
        d && d.id !== deliveryId &&
        dispatcherStoreIds.has(String(d.store_id)) &&
        !finishedStatuses.includes(d.status) && d.status !== 'pending'
        );
        wasLastDispatcherStop = remainingDispatcherIncomplete.length === 0;
      }

      // CRITICAL: If this was the last stop, always flash Phase 1 for 500ms
      if (wasLastStop || wasLastDispatcherStop) {
        if (mapLockTimeoutRef.current) {
          clearTimeout(mapLockTimeoutRef.current);
          mapLockTimeoutRef.current = null;
        }
        mapLockExpiresAtRef.current = null;

        setMapViewPhase(1);
        setIsMapViewLocked(false);
        lastProgrammaticMapMoveRef.current = Date.now();
        window._lastProgrammaticMapMove = Date.now();
        setMapViewTrigger((prev) => prev + 1);

        if (currentUser?.id) {
          saveSetting(currentUser.id, 'fab_map_cycle_phase', 1);
        }
      }

      // CRITICAL: Check if route is complete (current driver only)
      if (routeComplete && finishedStatuses.includes(newStatus) && targetDelivery.patient_id && driverId === currentUser?.id) {
        const summaryKey = `${driverId}_${deliveryDate}`;
        if (!hasShownSummaryRef.current.has(summaryKey)) {
          hasShownSummaryRef.current.add(summaryKey);

          // STEP 1: Collapse all expanded cards immediately
          setSelectedCardId(null);setEndOfDayDriver(currentUser);setShowEndOfDayStats(true);

          // STEP 2: Set map to Phase 1 as an unlocked programmatic view
          setMapViewPhase(1);
          setIsMapViewLocked(false);
          lastProgrammaticMapMoveRef.current = Date.now();
          window._lastProgrammaticMapMove = Date.now();
          setMapViewTrigger((prev) => prev + 1);

          if (currentUser?.id) {
            saveSetting(currentUser.id, 'fab_map_cycle_phase', 1);
          }
          if (mapLockTimeoutRef.current) {
            clearTimeout(mapLockTimeoutRef.current);
            mapLockTimeoutRef.current = null;
          }
          mapLockExpiresAtRef.current = null;

          // STEP 7: Re-measure stop cards height after route completion
          setTimeout(() => {
            if (horizontalStopCardsRef.current) {
              const newHeight = horizontalStopCardsRef.current.offsetHeight;
              if (newHeight > 0 && newHeight !== stopCardsBaseHeight) {
                setStopCardsBaseHeight(newHeight);
              }
            }
          }, 1000);
        }
      }

      // STEP 6: Scroll to next card (delayed to ensure UI updates)
      if (['completed', 'failed', 'cancelled'].includes(newStatus)) {
        setTimeout(() => {
          const nextCard = deliveriesWithStopOrder.find((d) => d && d.isNextDelivery === true);
          if (nextCard) {
            const cardElement = document.getElementById(`stop-card-${nextCard.id}`);
            if (cardElement) {
              cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            }
          }
        }, 500);
      }

      if (currentPhase > 1) {
        setIsMapViewLocked(true);
        if (mapLockTimeoutRef.current) {
          clearTimeout(mapLockTimeoutRef.current);
          mapLockTimeoutRef.current = null;
        }
        mapLockExpiresAtRef.current = null;
      }

      // STEP 8: Force map update event (instant)
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { driverId, deliveryDate, triggeredBy: 'statusUpdate' }
      }));

      // ========== BACKGROUND TASKS (NON-BLOCKING) ==========
      // Background: Update patient last_delivery_date
      if (['completed', 'failed'].includes(newStatus) && targetDelivery.patient_id) {
        base44.entities.Patient.update(targetDelivery.patient_id, {
          last_delivery_date: deliveryDate
        }).catch((error) => console.warn('⚠️ Patient update failed:', error));
      }

      // Background: Send notifications
      if (['completed', 'failed'].includes(newStatus)) {
        const deliveryStore = stores.find((s) => s?.id === targetDelivery?.store_id);
        const patientName = targetDelivery?.patient_name || 'Unknown';

        if (newStatus === 'completed') {
          notifyDriverCompleted({
            driver: currentUser,
            patientName,
            delivery: targetDelivery,
            store: deliveryStore,
            appUsers: appUsers
          }).catch((error) => console.warn('⚠️ Notification failed:', error));
        } else if (newStatus === 'failed') {
          notifyDriverFailed({
            driver: currentUser,
            patientName,
            delivery: targetDelivery,
            store: deliveryStore,
            appUsers: appUsers,
            failureReason: extraData?.delivery_notes || null
          }).catch((error) => console.warn('⚠️ Notification failed:', error));
        }
      }

      // STEP 9: Fetch fresh data and save to offline DB BEFORE any background tasks
      const freshDeliveries = await base44.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      });

      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
      // Protect deliveries from smart refresh overwrite
      freshDeliveries.forEach((d) => {
        if (d?.id) {
          smartRefreshManager.registerPendingUpdate(d.id, driverId, deliveryDate);
        }
      });

      // STEP 10: Background tasks (non-blocking, run after UI updates)
      if (driverId && deliveryDate) {
        // Background: Recalculate stop orders (don't await)
        recalculateStopOrders(driverId, deliveryDate).catch((error) =>
        console.warn('⚠️ Stop order recalc failed:', error)
        );

        if (['completed', 'failed', 'cancelled'].includes(newStatus)) {
          const now = new Date();
          const localTimeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
          base44.functions.invoke('optimizeRouteRealTime', { driverId, deliveryDate, currentLocalTime: localTimeString, deviceTime: now.toISOString() }).then((response) => {const data = response?.data || response;if (!data?.success || !Array.isArray(data.optimizedRoute) || !data.optimizedRoute.length) return;window.dispatchEvent(new CustomEvent('etaUpdated', { detail: { driverId, updates: data.optimizedRoute.map((stop) => ({ deliveryId: stop.deliveryId || stop.delivery_id, newEta: stop.newETA || stop.eta })).filter((stop) => stop.deliveryId && stop.newEta) } }));window.dispatchEvent(new CustomEvent('routeReordered', { detail: { driverId, deliveryDate, source: 'statusUpdateAutoOptimize' } }));window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { driverId, deliveryDate, source: 'statusUpdateAutoOptimize' } }));}).catch((error) => console.warn('⚠️ Route auto-optimization failed:', error));
        }

        // Payroll stats fetch disabled on Dashboard to avoid rate limits; handled only on DriverPayroll page.
      }

    } catch (error) {
      console.error('═══════════════════════════════════════════════════');
      console.error('❌ [STATUS] FINAL ERROR CATCH');
      console.error('   Error:', error);
      console.error('   Error message:', error.message);
      console.error('   Error stack:', error.stack);
      console.error('═══════════════════════════════════════════════════');

      if (error.response?.status === 401 || error.message?.includes('Unauthorized') || error.message?.includes('session')) {
        alert('Your session has expired. The page will now reload.');
        window.location.reload();
        return;
      }

      alert(`Failed to update status: ${error.message || 'Unknown error - check console'}`);
      throw error;
    } finally {
      statusUpdateLockRef.current.delete(statusLockKey);
      resumeOfflineSync();
      smartRefreshManager.resume();
      setIsEntityUpdating(false);
      document.documentElement.style.setProperty('--theme-transition-duration', '0.3s');
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
    // CRITICAL: Pause smart refresh to prevent overwrite
    setIsEntityUpdating(true);
    await new Promise((resolve) => setTimeout(resolve, 100));

    try {
      const delivery = deliveriesWithStopOrder.find((d) => d?.id === deliveryId);
      if (!delivery) {
        console.error('❌ [COD] Delivery not found in deliveriesWithStopOrder');
        throw new Error('Delivery not found');
      }

      // CRITICAL: Only update cod_payments array - don't touch cod_total_amount_required
      const updateData = {
        cod_payments: codPayments
      };

      // CRITICAL: Use offline-first mutation system
      await updateDeliveryLocal(deliveryId, updateData, { skipSmartRefresh: true });

      // CRITICAL: Update UI state immediately with the changes
      if (updateDeliveriesLocally) {
        const updatedDelivery = { ...delivery, ...updateData };
        updateDeliveriesLocally([updatedDelivery], false);
      }

      // Protect from smart refresh overwrite
      smartRefreshManager.registerPendingUpdate(deliveryId, delivery.driver_id, delivery.delivery_date);

    } catch (error) {
      console.error('═══════════════════════════════════════════════════');
      console.error('❌ [COD Update] FAILED');
      console.error('   Error:', error);
      console.error('   Error message:', error.message);
      console.error('   Error stack:', error.stack);
      console.error('═══════════════════════════════════════════════════');
      alert(`Failed to update COD payments: ${error.message}`);
      throw error;
    } finally {
      // Resume smart refresh after 2 seconds
      await new Promise((resolve) => setTimeout(resolve, 2000));
      setIsEntityUpdating(false);
    }
  };

  const handleCreateReturn = async ({ originalDelivery, returnPatient, store }) => {
    try {
      setIsEntityUpdating(true);
      pauseOfflineSync();
      smartRefreshManager.pause();

      await new Promise((resolve) => setTimeout(resolve, 100));

      const currentDate = getEdmDate();
      const failedPatient = patients.find((p) => p?.id === originalDelivery.patient_id);
      const puid = originalDelivery.puid;
      let finalStoreId = originalDelivery.store_id;
      let finalAmpm = originalDelivery.ampm_deliveries;

      if (puid) {
        const parentPickup = deliveries.find((d) => d && !d.patient_id && d.stop_id === puid);
        if (parentPickup) {
          finalStoreId = parentPickup.store_id || originalDelivery.store_id;
          finalAmpm = parentPickup.ampm_deliveries || originalDelivery.ampm_deliveries;
        }
      }

      const routeDate = currentDate;
      const routeDateDeliveries = deliveries.filter((d) => d && d.driver_id === originalDelivery.driver_id && d.delivery_date === routeDate);
      const nextTrackingNumber = getNextTrackingNumberInGroup(originalDelivery.tracking_number, deliveries, originalDelivery.driver_id, routeDate);

      const returnDeliveryData = buildReturnDeliveryData({
        originalDelivery,
        returnPatient,
        store,
        routeDate,
        routeDateDeliveries,
        finalStoreId,
        finalAmpm,
        currentUser,
        generateUniqueSID,
        nextTrackingNumber
      });

      await createDeliveryLocal(returnDeliveryData);

      try {
        await notifyDriverReturn({
          driver: currentUser,
          patientName: returnPatient.full_name,
          delivery: originalDelivery,
          store: store,
          appUsers: appUsers
        });
      } catch (notifyError) {
        console.warn('⚠️ [RETURN] Failed to send notification:', notifyError);
      }

      invalidate('Delivery');
      try {await forceRefreshDriverDeliveries(originalDelivery.driver_id, routeDate);} catch (_) {}
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { triggeredBy: 'return', driverId: originalDelivery.driver_id, deliveryDate: routeDate } }));
      window.dispatchEvent(new CustomEvent('routeOptimizationStarted', { detail: { source: 'return', driverId: originalDelivery.driver_id, deliveryDate: routeDate } }));
      base44.functions.invoke('optimizeRouteRealTime', { driverId: originalDelivery.driver_id, deliveryDate: routeDate, currentLocalTime: `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`, generatePolyline: false }).catch((e) => console.warn('⚠️ [CREATE RETURN] Background optimize failed:', e?.message || e)).finally(() => window.dispatchEvent(new CustomEvent('routeOptimizationComplete', { detail: { source: 'return', driverId: originalDelivery.driver_id, deliveryDate: routeDate } })));

    } catch (error) {
      console.error('❌ [CREATE RETURN] Error:', error);
      throw error;
    } finally {
      resumeOfflineSync();
      smartRefreshManager.resume();
      setIsEntityUpdating(false);
    }
  };

  const handleStartDelivery = async (deliveryId) => {
    // STEP 0: Pause ALL updates - smart refresh, mutations, offline sync
    setIsEntityUpdating(true);
    pauseOfflineMutations();
    pauseOfflineSync();
    smartRefreshManager.pause();

    await new Promise((resolve) => setTimeout(resolve, 100));

    // CRITICAL: Store the ID we clicked on BEFORE any database changes
    const originalClickedId = deliveryId;
    let newNextDeliveryId = deliveryId;

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

      // STEP 1: Clear ALL isNextDelivery flags for this driver/date
      const allDriverDeliveries = await base44.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      });

      const resetPromises = allDriverDeliveries.
      filter((d) => d.isNextDelivery).
      map((d) => base44.entities.Delivery.update(d.id, { isNextDelivery: false }));

      if (resetPromises.length > 0) {
        await Promise.all(resetPromises);
      }

      // STEP 2: Set isNextDelivery=true on the selected delivery and update status
      // CRITICAL: Calculate stop_order FIRST - this delivery becomes the next after completed stops
      const finishedStatusesStep2 = ['completed', 'failed', 'cancelled', 'returned'];
      const completedStopsStep2 = allDriverDeliveries.filter((d) => finishedStatusesStep2.includes(d.status));
      const nextStopOrderStep2 = completedStopsStep2.length + 1;

      const startUpdatePayload = {
        isNextDelivery: true,
        status: newStatus,
        stop_order: nextStopOrderStep2
      };

      await base44.entities.Delivery.update(deliveryId, startUpdatePayload);
      // CRITICAL: Trigger explicit broadcast for real-time listeners on other devices
      window.dispatchEvent(new CustomEvent('deliveryUpdated', {
        detail: {
          deliveryId,
          updates: startUpdatePayload,
          driverId,
          deliveryDate,
          source: 'startDelivery'
        }
      }));

      // STEP 3: Re-fetch deliveries to ensure we have the latest data with updated isNextDelivery flag
      const refreshedDeliveriesAfterFlag = await base44.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      });

      // Verify the flag is still set
      const verifyNext = refreshedDeliveriesAfterFlag.find((d) => d.id === deliveryId);
      if (!verifyNext?.isNextDelivery) {
        console.error('❌ [START] isNextDelivery flag was lost! Re-applying...');
        await base44.entities.Delivery.update(deliveryId, { isNextDelivery: true });
      }

      // Recalculate stop orders for all incomplete stops
      const incompleteStops = refreshedDeliveriesAfterFlag.filter((d) => !finishedStatusesStep2.includes(d.status));

      // Sort incomplete stops: isNextDelivery first, then by ETA
      const sortedIncomplete = incompleteStops.sort((a, b) => {
        if (a.isNextDelivery && !b.isNextDelivery) return -1;
        if (!a.isNextDelivery && b.isNextDelivery) return 1;

        const etaA = a.delivery_time_eta || a.delivery_time_start || '99:99';
        const etaB = b.delivery_time_eta || b.delivery_time_start || '99:99';
        return etaA.localeCompare(etaB);
      });

      // Update stop orders for all incomplete stops
      const startOrder = completedStopsStep2.length + 1;
      for (let i = 0; i < sortedIncomplete.length; i++) {
        const stop = sortedIncomplete[i];
        await base44.entities.Delivery.update(stop.id, {
          stop_order: startOrder + i
        });
      }

      // STEP 4: Optimize remaining stops AFTER starting this delivery
      try {
        const now = new Date();
        const localTimeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        await base44.functions.invoke('optimizeRemainingStops', {
          driverId: driverId,
          deliveryDate: deliveryDate,
          currentLocalTime: localTimeString,
          deviceTime: now.toISOString()
        });
      } catch (optimizeError) {
        console.warn('   ⚠️ Route optimization failed:', optimizeError.message);
      }

      // STEP 5: Update UI immediately after optimization
      invalidate('Delivery');
      const refreshedDeliveries = await base44.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      });

      // CRITICAL: Find which delivery is NOW marked as next (should be the one we just started)
      const newNextDelivery = refreshedDeliveries.find((d) => d.isNextDelivery === true);
      newNextDeliveryId = newNextDelivery?.id || deliveryId; // Use the refreshed next delivery ID

      // Update context immediately
      if (updateDeliveriesLocally) {
        const otherDeliveries = deliveries.filter((d) => d && d.delivery_date !== deliveryDate);
        const mergedDeliveries = [...otherDeliveries, ...refreshedDeliveries];
        updateDeliveriesLocally(mergedDeliveries, true);
      }

      // CRITICAL: Dispatch event to force map markers to re-render immediately
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { driverId, deliveryDate, triggeredBy: 'startDelivery' }
      }));

      // STEP 6: Clear and recalculate blue polyline
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
          }
        }
      } catch (polylineError) {
        console.warn('   ⚠️ Blue polyline update failed:', polylineError.message);
      }

      // STEP 8: Update this delivery's ETA to current time + 5 minutes
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const etaMinutes = currentMinutes + 5;
      const etaString = `${String(Math.floor(etaMinutes / 60) % 24).padStart(2, '0')}:${String(etaMinutes % 60).padStart(2, '0')}`;

      await base44.entities.Delivery.update(deliveryId, {
        delivery_time_start: etaString,
        delivery_time_eta: etaString
      });

      // STEP 10: Wait for UI to update, then scroll to next delivery card
      // Wait for optimization to complete and UI to update
      setTimeout(async () => {
        const nextCard = deliveriesWithStopOrder.find((d) => d && d.isNextDelivery === true);
        if (nextCard) {
          const cardElement = document.getElementById(`stop-card-${nextCard.id}`);
          if (cardElement) {
            cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          }
        }
      }, 800);

      // Send notification: Driver started delivery
      try {
        const deliveryFromUI = deliveriesWithStopOrder.find((d) => d?.id === deliveryId);
        const deliveryStore = stores.find((s) => s?.id === deliveryFromUI?.store_id);
        await notifyDriverStarted({
          driver: currentUser,
          patientName: deliveryFromUI?.patient_name || 'Unknown',
          delivery: deliveryFromUI,
          store: deliveryStore,
          appUsers: appUsers
        });
      } catch (notifyError) {
        console.warn('⚠️ [START] Failed to send notification:', notifyError);
      }

      // REMOVED: Route complete check from handleStartDelivery
      // This is now handled ONLY in handleStatusUpdate to ensure consistency

    } catch (error) {
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
      // STEP 9: Fetch fresh data and save to offline DB BEFORE resuming
      try {
        const finalRefreshedDeliveries = await base44.entities.Delivery.filter({
          driver_id: deliveriesWithStopOrder.find((d) => d?.id === deliveryId)?.driver_id,
          delivery_date: deliveriesWithStopOrder.find((d) => d?.id === deliveryId)?.delivery_date
        });

        // Save to offline DB
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, finalRefreshedDeliveries);

        // Protect from smart refresh overwrite
        finalRefreshedDeliveries.forEach((d) => {
          if (d?.id) {
            smartRefreshManager.registerPendingUpdate(
              d.id,
              d.driver_id,
              d.delivery_date
            );
          }
        });

        // Update UI incrementally to avoid clearing screen
        if (updateDeliveriesLocally) {
          updateDeliveriesLocally(finalRefreshedDeliveries, false);
        }

        // Force map update
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: {
            driverId: finalRefreshedDeliveries[0]?.driver_id,
            deliveryDate: finalRefreshedDeliveries[0]?.delivery_date,
            triggeredBy: 'startDeliveryFinalRefresh'
          }
        }));

      } catch (refreshError) {
        console.error('❌ [START] Failed to fetch fresh data:', refreshError);
      }

      // STEP 10: Wait longer for all writes and UI updates to complete
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Resume all systems
      resumeOfflineMutations();
      resumeOfflineSync();
      smartRefreshManager.resume();

      setIsEntityUpdating(false);
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

    } catch (error) {
      console.error('❌ [AI Optimization] Error applying optimization:', error);
      throw error;
    }
  };

  const handleQuickReorder = async (reorderUpdates) => {
    try {
      setIsEntityUpdating(true);

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

  // Re-enable auto-fade when card collapses (unless route is complete)
  useEffect(() => {
    if (!isExpanded && areCardsVisible && !isRouteComplete) {
      if (fadeTimeoutRef.current) {
        clearTimeout(fadeTimeoutRef.current);
      }
      fadeTimeoutRef.current = setTimeout(() => {
        setAreCardsVisible(false);
      }, 3000);
    }
  }, [isExpanded, areCardsVisible, isRouteComplete]);

  // Force UI refresh when data for selected date becomes available
  const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
  const [forceRender, setForceRender] = useState(0);

  useEffect(() => {
    if (!showBreadcrumbs) return;
    const activeDriverId = showAllDriverMarkers || selectedDriverId === 'all' ? currentUser?.id : selectedDriverId;
    const activeDate = format(selectedDate, 'yyyy-MM-dd');
    const matches = ({ driverId, deliveryDate } = {}) => (!driverId || !activeDriverId || driverId === activeDriverId) && (!deliveryDate || deliveryDate === activeDate);
    const refresh = async (event) => matches(event.detail || {}) && setBreadcrumbsData(await loadBreadcrumbsForDriver(activeDriverId, activeDate, appUsers));
    const append = (event) => {
      const { point, ...detail } = event.detail || {};
      if (!point || !matches(detail)) return;
      setBreadcrumbsData((prev) => prev?.current?.some((p) => Number(p?.timestamp) === Number(point.timestamp)) ? prev : { historical: prev?.historical || [], current: [...(prev?.current || []), point] });
    };
    window.addEventListener('deliveriesUpdated', refresh);window.addEventListener('routeOptimizationComplete', refresh);window.addEventListener('routeReordered', refresh);window.addEventListener('breadcrumbCollected', append);
    return () => {
      window.removeEventListener('deliveriesUpdated', refresh);window.removeEventListener('routeOptimizationComplete', refresh);window.removeEventListener('routeReordered', refresh);window.removeEventListener('breadcrumbCollected', append);
    };
  }, [showBreadcrumbs, showAllDriverMarkers, selectedDriverId, currentUser?.id, selectedDate, appUsers]);

  // Listen for pullToSyncDataReady events - full update regardless of current state
  useEffect(() => {
    const handlePullToSyncDataReady = async (event) => {
      const {
        deliveries: freshDeliveries,
        appUsers: freshAppUsers,
        cities: freshCities,
        stores: freshStores,
        patients: freshPatients
      } = event.detail || {};

      try {
        setCurrentToNextPolyline(null);
        setDriverRoutes([]);
        if (updateDeliveriesLocally && freshDeliveries) {
          const _sd = freshDeliveries[0]?.delivery_date,_si = new Set(freshDeliveries.map((d) => d?.id).filter(Boolean));
          updateDeliveriesLocally([...deliveries.filter((d) => d && (d.delivery_date !== _sd || !_si.has(d.id))), ...freshDeliveries], true);
        }
        if (updateAppUsersLocally && freshAppUsers) {updateAppUsersLocally(freshAppUsers, true);}

        // Force complete UI re-render
        setForceRender((prev) => prev + 1);

        // CRITICAL: Validate freshAppUsers — offline DB may return junk records with user_id=undefined
        const validAppUsers = (freshAppUsers || []).filter((u) => u?.user_id && u.user_id !== 'undefined' && u?.user_name && u.user_name !== 'undefined');
        const appUsersForPoller = validAppUsers.length > 0 ? validAppUsers : appUsers;

        if (appUsersForPoller && appUsersForPoller.length > 0) {
          driverLocationPoller.processLocationData(currentUser, freshDeliveries || [], drivers, stores, appUsersForPoller, selectedDate, true, 'Dashboard', showAllDriverMarkers || selectedDriverId === 'all');
        }

        window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { deliveryDate: format(selectedDate, 'yyyy-MM-dd'), triggeredBy: 'pullToSyncDataReady', forceFullUpdate: true } }));
        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
        setIsMapViewLocked(mapViewPhase !== 1);
        lastProgrammaticMapMoveRef.current = Date.now();
        window._lastProgrammaticMapMove = Date.now();
        setMapViewTrigger((prev) => prev + 1);
        if (mapLockTimeoutRef.current) {
          clearTimeout(mapLockTimeoutRef.current);
          mapLockTimeoutRef.current = null;
        }
        mapLockExpiresAtRef.current = null;


      } catch (error) {
        console.error('❌ [Dashboard] Pull to sync update failed:', error);
      }
    };

    window.addEventListener('pullToSyncDataReady', handlePullToSyncDataReady);
    return () => window.removeEventListener('pullToSyncDataReady', handlePullToSyncDataReady);
  }, [updateDeliveriesLocally, updateAppUsersLocally, selectedDate, currentUser, drivers, stores, showAllDriverMarkers]);

  // Listen for data source changes and reload deliveries for ALL drivers
  useEffect(() => {
    const handleDataSourceChange = async (event) => {
      const { source } = event.detail || {};

      setIsEntityUpdating(true);

      try {
        const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
        let freshDeliveries = [];

        if (source === 'online') {
          freshDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
          // Update offline DB in background
          offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries).catch(() => {});
        } else {
          freshDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);

          if (!freshDeliveries || freshDeliveries.length === 0) {
            freshDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
          }
        }

        // Update context with fresh data
        const otherDateDeliveries = deliveries.filter((d) => d && d.delivery_date !== selectedDateStr);
        const allDeliveries = [...otherDateDeliveries, ...freshDeliveries];
        updateDeliveriesLocally(allDeliveries, true);

        // Force immediate UI refresh
        setForceRender((prev) => prev + 1);

        // Force stats refresh with new data
        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

        // Force map update with new data
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: {
            deliveryDate: selectedDateStr,
            triggeredBy: 'dataSourceChange',
            deliveryCount: freshDeliveries.length
          }
        }));

        // Show success notification
        toast.success(`Loaded from ${source === 'online' ? 'Online' : 'Offline'} source`, {
          description: `${freshDeliveries.length} deliveries for ${format(selectedDate, 'MMM dd')}`
        });

      } catch (error) {
        console.error('❌ [Data Source Change] Failed:', error);
        toast.error('Failed to reload data', {
          description: error.message
        });
      } finally {
        setIsEntityUpdating(false);
      }
    };

    window.addEventListener('dataSourceChanged', handleDataSourceChange);
    return () => window.removeEventListener('dataSourceChanged', handleDataSourceChange);
  }, [selectedDate, updateDeliveriesLocally, deliveries, setForceRender]);

  // CRITICAL: STEP 0 - ALWAYS fetch fresh AppUser data on app load
  const hasPreRenderSyncRef = useRef(false);

  useEffect(() => {
    if (!currentUser || !isFiltersReady) return;
    if (hasPreRenderSyncRef.current) return;

    hasPreRenderSyncRef.current = true;

    const preRenderSync = async () => {
      try {
        const existing = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
        const valid = (existing || []).filter((u) => u?.user_id && u.user_id !== 'undefined');
        if (valid.length !== (existing || []).length) {
          await offlineDB.clearStore(offlineDB.STORES.APP_USERS);
          if (valid.length > 0) await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, valid);
        }
        const cache = await offlineDB.getCacheValidation('AppUser', { scopeKey: 'global', maxAgeMs: 10 * 60 * 1000, minRecordCount: 1 });
        if (cache.isValid) return;
        const freshAppUsers = await base44.entities.AppUser.list();
        await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, freshAppUsers);
        await offlineDB.updateCacheSnapshot('AppUser', freshAppUsers || [], { scopeKey: 'global', syncType: 'startup_full' });
      } catch (error) {console.error('❌ [STEP 0] Pre-render sync failed:', error);}
    };

    preRenderSync();
  }, [currentUser?.id, isFiltersReady]);

  // CRITICAL: STEP 1 - Load everything from offline DB FIRST for instant UI
  // MUST wait for userSettingsLoaded so selectedDate/selectedDriverId are final
  const hasLoadedOfflineDataRef = useRef(false);
  const lastOfflineLoadDateRef = useRef(null);

  useEffect(() => {
    if (!currentUser || !isFiltersReady || !userSettingsLoaded) return;
    if (!hasPreRenderSyncRef.current) return;
    // Re-run if date changed (e.g. user settings loaded a different date)
    if (hasLoadedOfflineDataRef.current && lastOfflineLoadDateRef.current === selectedDateStr) return;
    hasLoadedOfflineDataRef.current = true;
    lastOfflineLoadDateRef.current = selectedDateStr;

    const loadOfflineDataFirst = async () => {
      try {
        await loadDashboardOfflineDateData({
          selectedDateStr,
          deliveries,
          appUsers,
          updateDeliveriesLocally,
          currentUser,
          drivers,
          stores,
          selectedDate,
          driverLocationPoller,
          showAllDriverMarkers,
          setForceRender
        });
      } catch (error) {
        console.warn('⚠️ [STEP 1] Offline DB load failed:', error.message);
      }
    };
    loadOfflineDataFirst();
  }, [currentUser?.id, isDataLoaded, isFiltersReady, userSettingsLoaded, selectedDateStr, hasPreRenderSyncRef.current]);

  const hasTriggeredPrioritySyncRef = useRef('');
  useEffect(() => {
    if (!currentUser || !isDataLoaded || !isFiltersReady || !userSettingsLoaded || !hasPreRenderSyncRef.current || !hasLoadedOfflineDataRef.current || hasTriggeredPrioritySyncRef.current === selectedDateStr) return;
    hasTriggeredPrioritySyncRef.current = selectedDateStr;
    const backgroundPrioritySync = async () => {
      try {
        const today = selectedDateStr === getEdmDate();
        if ((await offlineDB.getCacheValidation('Delivery', { scopeKey: `date:${selectedDateStr}`, maxAgeMs: today ? 60 * 1000 : 10 * 60 * 1000, allowEmpty: true })).isValid) return;
        const { performPrioritySyncBeforeRefresh } = await import('@/components/utils/offlineSync');await performPrioritySyncBeforeRefresh(selectedDateStr, globalFilters.getSelectedCityId(), smartRefreshManager);
        const freshDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);await offlineDB.updateCacheSnapshot('Delivery', freshDeliveries || [], { scopeKey: `date:${selectedDateStr}`, syncType: 'startup_full' });if (updateDeliveriesLocally) {updateDeliveriesLocally(mergeDeliveriesForDate({ deliveries, selectedDateStr, freshDeliveries }), true);}
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { deliveryDate: selectedDateStr, triggeredBy: 'backgroundSyncComplete' } }));
        const isTodaySelected = selectedDateStr === getEdmDate(),m = await offlineDB.getSyncMetadata('Delivery'),t = new Date(m?.last_sync_time || m?.last_sync_date || m?.last_synced_timestamp || 0).getTime();
        const active = (freshDeliveries || []).some((d) => d && !['completed', 'failed', 'cancelled', 'returned'].includes(d.status));
        if (isTodaySelected && (!t || Date.now() - t >= (active ? 60000 : 300000))) setTimeout(() => window.dispatchEvent(new CustomEvent('triggerPullToSync', { detail: { silent: true, reason: active ? 'initial_load_today_active_routes' : 'initial_load_today_completed_routes' } })), 2000);
      } catch (error) {
        if (error.response?.status === 429 || error.message?.includes('429')) return;
        console.warn('⚠️ [Dashboard Mount - STEP 2] Background sync failed:', error.message);
      }
    };
    setTimeout(backgroundPrioritySync, 1000);
  }, [currentUser?.id, isDataLoaded, isFiltersReady, selectedDateStr, userSettingsLoaded, deliveries]);

  useEffect(() => {
    if (!isDataLoaded || !deliveries) return;

    // Check if we have deliveries for the selected date
    const hasDataForDate = deliveries.some((d) => d && d.delivery_date === selectedDateStr);

    if (hasDataForDate) {
      // Force a re-render to update stats and cards immediately
      setForceRender((prev) => prev + 1);
    }
  }, [isDataLoaded, deliveries, selectedDateStr]);

  if (isLoadingUser || !isFiltersReady || !isDataLoaded && !userSettingsLoaded) {
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

  // PLACEHOLDER — replaced below by DashboardView
  return (
    <div className="h-full w-full flex flex-col overflow-hidden" style={{ background: 'var(--bg-slate-50)' }}>

      {/* Snapshot Timeline - Only visible when snapshot mode is active */}
      {isSnapshotModeActive && isAppOwner(currentUser) &&
      <div className="absolute left-0 top-0 bottom-0 z-[250]">
          <SnapshotTimeline
          selectedDate={selectedDate}
          selectedDriverId={selectedDriverId}
          onSnapshotSelect={handleSnapshotSelect}
          onClose={() => {
            setIsSnapshotModeActive(false);
            setSnapshotData(null);
          }} />

        </div>
      }

      <div className={statsCardPositioning} style={{ zIndex: 600 }}>
        <div className="flex flex-col items-center gap-0.5 min-w-[345px] max-w-[345px] relative"

        style={{ opacity: statsPanelOpacity, transition: 'opacity 0.5s ease-in-out' }}
        onMouseEnter={() => handleStatsPanelInteraction(true)}
        onMouseLeave={() => handleStatsPanelInteraction(false)}>

          {/* Pull to Sync - Inside stats card container */}
          <PullToSync
            key={pullToSyncKey}
            selectedDate={selectedDate}
            selectedCityId={globalFilters.getSelectedCityId()}
            selectedDriverId={selectedDriverId}
            showAllDriverMarkers={showAllDriverMarkers}
            statsCardRef={statsCardRef}
            onSyncComplete={async (freshDeliveries, freshPatients, freshAppUsers) => {
              // Update deliveries in context
              if (updateDeliveriesLocally) {
                const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
                const otherDateDeliveries = deliveries.filter((d) => d?.delivery_date !== selectedDateStr);
                updateDeliveriesLocally([...otherDateDeliveries, ...freshDeliveries], true);
              }

              // CRITICAL: Process driver locations through poller to update ALL markers
              // CRITICAL: Filter junk offline DB records (user_id=undefined) before processing — fallback to context
              const appUsersToProcess = (freshAppUsers || []).filter((u) => u?.user_id && u.user_id !== 'undefined').length > 0 ? freshAppUsers.filter((u) => u?.user_id && u.user_id !== 'undefined') : appUsers;

              if (appUsersToProcess && appUsersToProcess.length > 0) {
                driverLocationPoller.processLocationData(
                  currentUser,
                  freshDeliveries,
                  drivers,
                  stores,
                  appUsersToProcess,
                  selectedDate,
                  true, // forceNotify
                  'Dashboard', // currentPageName
                  showAllDriverMarkers
                );
              } else {
                console.warn('⚠️ [Pull to Sync] No appUsers available from sync or context - cannot process locations');
              }

              const validSyncAppUsers = (freshAppUsers || []).filter((u) => u?.user_id && u.user_id !== 'undefined').length > 0 ? freshAppUsers.filter((u) => u?.user_id && u.user_id !== 'undefined') : appUsers;
              window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: validSyncAppUsers, forceAll: true } }));

              // Force map update based on selection mode
              const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
              window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                detail: {
                  deliveryDate: selectedDateStr,
                  triggeredBy: 'pullToSyncComplete',
                  allDrivers: true
                }
              }));

              // Trigger map repositioning based on current phase
              setIsMapViewLocked(mapViewPhase !== 1);
              lastProgrammaticMapMoveRef.current = Date.now();
              window._lastProgrammaticMapMove = Date.now();
              setMapViewTrigger((prev) => prev + 1);

              if (mapLockTimeoutRef.current) {
                clearTimeout(mapLockTimeoutRef.current);
                mapLockTimeoutRef.current = null;
              }
              mapLockExpiresAtRef.current = null;

              // Force stats refresh
              window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

              // Payroll stats refresh disabled on Dashboard.

            }} />

          <motion.div
            ref={statsCardRef} data-spotlight-anchor
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
            }} className="px-1 rounded-2xl shadow-xl border min-w-[350px] max-w-[350px] cursor-pointer"

            style={{
              background: 'var(--bg-white)',
              borderColor: 'var(--border-slate-200)',
              pointerEvents: 'auto',
              touchAction: 'none',
              position: 'relative'
            }}>

            <div className="mt-1 flex items-center justify-between">
              <div className="pr-1 flex items-center gap-2">
                <h2 className="pl-2 text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>Dashboard</h2>
                {currentUser &&
                <div className="flex items-center gap-1.5">
                  <SmartRefreshIndicator
                    inline={true}
                    onManualRefresh={async () => {
                      // CRITICAL: Just trigger offline sync button click instead of manual refresh
                      const syncButton = document.querySelector('[data-offline-sync-button]');
                      if (syncButton) {
                        syncButton.click();
                      } else {
                        console.warn('⚠️ [Manual Refresh] Offline sync button not found');
                      }
                    }} />
                  
                  {/* Connection Quality Indicator */}
                  <ConnectionIndicator />
                  
                  {/* Error Flag Indicator */}
                  <ErrorFlagIndicator />
                </div>
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
                                  const todayDate = new Date();
                                  setCalendarMonth(todayDate);
                                  handleDateChange(todayDate);
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
                      } className="px-2 py-2 rdp" style={{ color: 'var(--text-slate-900)' }} />

                  </PopoverContent>
                </Popover>

                <AddDeliveryButton
                  onClick={() => {
                    setEditingDelivery(null);
                    setShowDeliveryForm(true);
                  }}
                  disabled={(isDriver || isDispatcher) && !isAdmin && !isAppOwner(currentUser) && (() => {const now = new Date();const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());const selectedDay = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate());if (selectedDay < today) return true;if (selectedDay.getTime() === today.getTime()) {const currentTime = now.getHours() * 100 + now.getMinutes();return currentTime >= 2100;}return false;})()}
                  hasRateLimitError={hasRateLimitError} />

              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <ActivePayStats
                deliveryStats={deliveryStats}
                localStats={stats}
                isDispatcher={isDispatcher}
                isDriver={isDriver}
                performanceStats={performanceStats}
                liveDistance={liveDistance}
                liveTimeOnDuty={liveTimeOnDuty}
                isLoadingPayrollStats={isLoadingPayrollStats} />

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

            {isAppOwner(currentUser) && <DriverLocationBadge users={appUsers} />}

            <AnimatePresence>
              {isExpanded &&
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden">
                  <ExpandedStatsControls
                    selectedDriverId={selectedDriverId}
                    handleDriverChange={handleDriverChange}
                    isDriverDropdownDisabled={isDriverDropdownDisabled}
                    driversList={driversList}
                    isDriver={isDriver}
                    isAllDriversMode={isAllDriversMode}
                    showAllDriverMarkers={showAllDriverMarkers} setShowAllDriverMarkers={setShowAllDriverMarkers}
                    currentUser={currentUser}
                    saveSetting={saveSetting}
                    setIsExpanded={setIsExpanded}
                    setSelectedCardId={setSelectedCardId}
                    cardExpandedAtRef={cardExpandedAtRef}
                    setAreCardsVisible={setAreCardsVisible}
                    dataSource={dataSource}
                    selectedDate={selectedDate}
                    base44={base44}
                    offlineDB={offlineDB}
                    deliveries={deliveries}
                    updateDeliveriesLocally={updateDeliveriesLocally}
                    setIsEntityUpdating={setIsEntityUpdating}
                    smartRefreshManager={smartRefreshManager}
                    appUsers={appUsers}
                    driverLocationPoller={driverLocationPoller}
                    drivers={drivers}
                    stores={stores}
                    setMapViewPhase={setMapViewPhase}
                    setIsMapViewLocked={setIsMapViewLocked}
                    lastProgrammaticMapMoveRef={lastProgrammaticMapMoveRef}
                    setMapViewTrigger={setMapViewTrigger}
                    mapLockTimeoutRef={mapLockTimeoutRef}
                    mapLockExpiresAtRef={mapLockExpiresAtRef}
                    setShowOptimizationSettings={setShowOptimizationSettings}
                    showRoutes={showRoutes}
                    setShowRoutes={setShowRoutes}
                    shouldShowLocationToggle={shouldShowLocationToggle}
                    refreshUser={refreshUser}
                    setShowQuickAdjustments={setShowQuickAdjustments}
                    setShowSmartPrioritization={setShowSmartPrioritization}
                    preferredTravelMode={preferredTravelMode}
                    setPreferredTravelMode={setPreferredTravelMode}
                    isRouteComplete={isRouteComplete}
                    isStatsCardCentered={isStatsCardCentered}
                    dailyPolylineCount={dailyPolylineCount}
                    isExpanded={isExpanded}
                    isMobile={isMobile}
                    showBreadcrumbs={showBreadcrumbs}
                    setShowBreadcrumbs={setShowBreadcrumbs}
                    setBreadcrumbsData={setBreadcrumbsData}
                  />
                </motion.div>
              }
                </AnimatePresence>
          </motion.div>

          {/* Driver Legend - positioned directly below stats card */}
          {(() => {
            const dateKey = format(selectedDate, 'yyyy-MM-dd');
            const legendData = isAdmin ? driversList.filter((driver) => deliveries.some((d) => d && d.delivery_date === dateKey && d.driver_id === driver.id)).map((driver) => {const s = (appUsers || []).find((au) => au && au.user_id === driver.id)?.driver_status;const c = s === 'on_duty' ? '#16a34a' : s === 'on_break' ? '#3b82f6' : s === 'off_duty' ? '#dc2626' : '#94a3b8';return { driverId: driver.id, driverName: driver.user_name || driver.full_name || 'Unknown', color: getDriverColor(driver), totalStops: deliveries.filter((d) => d && d.delivery_date === dateKey && d.driver_id === driver.id && d.patient_id && String(d.patient_id).trim() !== '' && (d.status === 'completed' || d.status === 'failed')).length + deliveries.filter((d) => d && d.delivery_date === dateKey && d.driver_id === driver.id && (!d.patient_id || String(d.patient_id).trim() === '') && d.after_hours_pickup === true && (d.status === 'completed' || d.status === 'cancelled')).length, statusRingColor: c };}) : isAllDriversMode ? [...driverRoutes].sort((a, b) => (a.driverName || '').localeCompare(b.driverName || '')) : [];
            if (!legendData.length) return null;
            return <div className="rounded-lg backdrop-blur-sm shadow-lg border" style={{ background: 'var(--bg-white)', opacity: 0.95, borderColor: 'var(--border-slate-200)', width: cardWidth }} onMouseEnter={() => handleCardInteraction(true)} onMouseLeave={() => handleCardInteraction(false)}><div className="flex w-full flex-wrap gap-x-1.5 gap-y-0.5 items-center justify-center">{legendData.map((route) => {const au = (appUsers || []).find((a) => a && a.user_id === route.driverId);const s = au?.driver_status;const isOnline = s === 'on_duty' || s === 'online' || au?.location_updated_at && Date.now() - new Date(au.location_updated_at).getTime() < 300000;const c = s === 'on_duty' ? '#16a34a' : s === 'on_break' ? '#3b82f6' : s === 'off_duty' ? '#dc2626' : '#94a3b8';const bg = isAllDriversMode ? route.color : c;const bd = isAllDriversMode ? `3px solid ${c}` : '0 solid transparent';return <div key={route.driverId} className="flex items-center gap-1.0"><div className="relative flex items-center justify-center w-3 h-3">{isOnline && <div className="opacity-75 rounded-full absolute inset-0 animate-ping" style={{ backgroundColor: c }} />}<div className="rounded-full relative w-3 h-3 shadow-sm flex-shrink-0" style={{ backgroundColor: bg, border: bd }} /></div><span className="text-xs font-medium whitespace-nowrap" style={{ color: 'var(--text-slate-700)' }}>{route.driverName || 'Unknown'}</span><span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>({route.totalStops})</span></div>;})}</div></div>;
          })()}
        </div>
      </div>

      <div className="flex-1 w-full relative min-h-0 overflow-hidden">
        {currentUser && isAppOwner(currentUser) && <ApiUsageBadge currentUser={currentUser} stopCardsHeight={deliveriesWithStopOrder.length > 0 ? stopCardsBaseHeight : 0} showRoutes={showRoutes} showBreadcrumbs={showBreadcrumbs} showCompletedRouteControls={!isMobile && selectedDriverId !== 'all' && filteredDeliveries.length > 0 && filteredDeliveries.every((delivery) => delivery && ['completed', 'failed', 'cancelled', 'returned'].includes(delivery.status))} selectedDate={format(selectedDate, 'yyyy-MM-dd')} selectedDriverIds={selectedDriverId !== 'all' ? [selectedDriverId] : []} />}

        <MapSection
          currentUser={currentUser}
          isDriver={isDriver}
          isDispatcher={isDispatcher}
          isMobile={isMobile}
          deliveries={deliveries}
          patients={patients}
          stores={stores}
          drivers={drivers}
          appUsers={appUsers}
          filteredDeliveries={filteredDeliveries}
          deliveriesWithStopOrder={deliveriesWithStopOrder}
          selectedDate={selectedDate}
          selectedDateStr={selectedDateStr}
          selectedDriverId={selectedDriverId}
          mapCenter={mapCenter}
          mapZoom={mapZoom}
          shouldFitBounds={shouldFitBounds}
          setShouldFitBounds={setShouldFitBounds}
          setMapCenter={setMapCenter}
          setMapZoom={setMapZoom}
          mapMode={mapMode}
          setMapMode={setMapMode}
          driverLocation={driverLocation}
          allDriverLocations={allDriverLocations}
          currentToNextPolyline={currentToNextPolyline}
          showRoutes={showRoutes}
          showAllDriverMarkers={showAllDriverMarkers}
          showBreadcrumbs={showBreadcrumbs}
          breadcrumbsData={breadcrumbsData}
          highlightedCardId={highlightedCardId}
          retractClustersRef={retractClustersRef}
          setDriverRoutes={setDriverRoutes}
          renderSequence={renderSequence}
          setRenderSequence={setRenderSequence}
          stopCardsBaseHeight={stopCardsBaseHeight}
          handleMarkerClick={handleMarkerClick}
          handleCardInteraction={handleCardInteraction}
          areCardsVisible={areCardsVisible}
          handleMapViewCycle={handleMapViewCycle}
          isStatsCardCentered={isStatsCardCentered}
          dailyPolylineCount={dailyPolylineCount}
          isExpanded={isExpanded}
          polylineResetKey={selectedDateStr}
          realTimeETAEnabled={realTimeETAEnabled}
          showDeliveryForm={showDeliveryForm}
          showPatientForm={showPatientForm}
          showOptimizationSettings={showOptimizationSettings}
          preferredTravelMode={preferredTravelMode}
          onTravelModeChange={setPreferredTravelMode}
        />
        <div
          ref={stopCardsContainerRef}
          className="horizontal-cards-container absolute bottom-0 right-0 z-[1000] isolate px-4 pb-1 pointer-events-none flex flex-col justify-end max-h-[80vh]"
          style={{ left: isSnapshotModeActive ? '5rem' : '0' }}
          onClick={() => {
            if (retractClustersRef.current) {
              retractClustersRef.current();
            }
          }}>
            
            {/* Optimization Message Banner - Above Stop Cards */}
            <AnimatePresence>
              {optimizationMessage &&
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className="flex justify-center mb-2 pointer-events-auto">
                <div className="rounded-lg shadow-2xl border-2 border-emerald-500 p-3 flex items-center gap-3 max-w-[90vw]" style={{ background: 'var(--bg-white)' }}>
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
            
            <div
            className="overflow-x-auto overflow-y-visible scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent pointer-events-auto"
            style={isMobile ? { scrollSnapType: 'x mandatory' } : {}}
            onWheel={(e) => {window.__isUserCardSwipe = true;if ((mapViewPhase === 2 || mapViewPhase === 3) && isMapViewLocked) {if (mapLockTimeoutRef.current) clearTimeout(mapLockTimeoutRef.current);mapLockTimeoutRef.current = null;mapLockExpiresAtRef.current = null;setIsMapViewLocked(false);}if (!isMobile) {e.preventDefault();e.currentTarget.scrollLeft += e.deltaY;}}}
            onTouchStart={() => {
              lastUserInteractionRef.current = Date.now();
              window.__isUserCardSwipe = true;if ((mapViewPhase === 2 || mapViewPhase === 3) && isMapViewLocked) {if (mapLockTimeoutRef.current) clearTimeout(mapLockTimeoutRef.current);mapLockTimeoutRef.current = null;mapLockExpiresAtRef.current = null;setIsMapViewLocked(false);}
            }}
            onScroll={isMobile ? createStopCardsScrollHandler({ deliveriesWithStopOrder, patients, stores, appUsers, mapViewPhase, isMapViewLocked, setIsMapViewLocked, setMapViewPhase, setShouldFitBounds, setMapCenter, setMapZoom, getMapPadding, mapLockTimeoutRef, mapLockExpiresAtRef }) : undefined}>

              {/* CRITICAL: Hide stop cards when in "All Drivers" mode (except for dispatchers) */}
              {(!isAllDriversMode || isDispatcher) &&
            <HorizontalStopCards
              ref={horizontalStopCardsRef}
              pickupCards={deliveriesWithStopOrder.
              filter((delivery) => delivery && delivery.status !== 'pending') // Hide pending deliveries from cards
              .map((delivery) => {
                if (!delivery) return delivery;

                // For pickups with status 'en_route', attach pending deliveries
                if (!delivery.patient_id && delivery.status === 'en_route' && delivery.stop_id) {
                  // CRITICAL: Match by stop_id (not puid) - pending deliveries have puid that matches pickup's stop_id
                  let pendingDeliveriesForPickup = deliveriesWithStopOrder.filter((d) =>
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

                // CRITICAL: For drivers, mark all deliveries as stripped when route is complete
                // EXCEPT for InterStore deliveries and regular Store Pickups
                if (isDriver && !isDispatcher && !isAdmin) {
                  const finishedStatuses = ['completed', 'failed', 'cancelled'];
                  const allDriverDeliveries = deliveriesWithStopOrder.filter((d) =>
                  d && d.driver_id === currentUser.id
                  );

                  // Helper to detect returns by markers
                  const checkIsReturn = (d) => {
                    if (!d || !d.patient_id) return false;
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
                  allDriverDeliveries.every((d) => finishedStatuses.includes(d.status) || d.status === 'completed' && checkIsReturn(d));

                  if (routeComplete) {
                    // CRITICAL: Check if this is an InterStore delivery or Store Pickup
                    const isInterStore = delivery.patient_name?.toLowerCase().includes('interstore') ||
                    delivery.delivery_notes?.toLowerCase().includes('interstore');
                    const isStorePickup = !delivery.patient_id;

                    // Don't strip InterStore deliveries or Store Pickups
                    if (!isInterStore && !isStorePickup) {
                      return {
                        ...delivery,
                        _isStripped: true
                      };
                    }
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
              onSelectionChange={() => {}}
              selectedDeliveryIds={{}}
              stopOrder={{}}
              showDriverName={isAllDriversMode}
              getDriverColor={getDriverColor}
              onEdit={handleEditDelivery}
              onEditPatient={handleEditPatient}
              onDelete={handleDeleteDelivery}
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

            }

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
          initialDriverId={selectedDriverId !== 'all' ? selectedDriverId : undefined} onCreatePatient={handleCreatePatientFromDelivery} />
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
          duplicateMode={patientFormMode}
          onSave={handleSavePatient}
          onCancel={() => {
            setShowPatientForm(false);
            setEditingPatient(null);
            setPatientFormCallback(null);
            setPatientFormMode(null);
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

      {/* CRITICAL: Render FABs with high z-index to ensure proper layering above cards */}
      {(isDriver || isDispatcher) &&
      <>
        <MapViewCycleFAB
          onClick={handleMapViewCycle}
          currentPhase={mapViewPhase}
          hasVisibleCards={deliveriesWithStopOrder.length > 0}
          isAIVisible={showAIAssistant && isAIEnabled}
          isLocked={isMapViewLocked}
          stopCardsHeight={cardsReadyForFAB ? stopCardsBaseHeight : 0} />

        <RouteActionButtons
          currentUser={currentUser}
          selectedDriverId={selectedDriverId}
          selectedDate={selectedDate}
          deliveriesWithStopOrder={deliveriesWithStopOrder}
          filteredDeliveries={filteredDeliveries}
          cardsReadyForFAB={cardsReadyForFAB}
          stopCardsBaseHeight={stopCardsBaseHeight}
          isDateFinished={isDateFinished}
          isReoptimizing={isReoptimizing}
          setIsReoptimizing={setIsReoptimizing}
          setOptimizationMessage={setOptimizationMessage}
          setIsEntityUpdating={setIsEntityUpdating}
          refreshData={refreshData}
          setIsMapViewLocked={setIsMapViewLocked}
          setMapViewTrigger={setMapViewTrigger} />

      </>
      }

      <AnimatePresence>
        {showRouteSummary &&
        <RouteSummaryModal
          deliveries={filteredDeliveries}
          patients={patients}
          stores={stores}
          driver={summaryDriver || currentUser}
          onClose={async () => {
            setShowRouteSummary(false);
            setSummaryDriver(null);

            // Refresh user to update UI after driver status changed
            if (isDriver && currentUser?.id) {
              await refreshUser();
            }
          }} />
        }
      </AnimatePresence>

      {/* End of Day Stats Dialog */}
      <AnimatePresence>
        {showEndOfDayStats &&
        <EndOfDayStatsDialog
          isOpen={showEndOfDayStats}
          onClose={() => {
            setShowEndOfDayStats(false);
            setEndOfDayDriver(null);
          }}
          deliveries={filteredDeliveries}
          driver={endOfDayDriver || currentUser}
          deliveryDate={format(selectedDate, 'yyyy-MM-dd')} />
        }
      </AnimatePresence>

      {false && <RouteNotification
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
        }} />}


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

      {/* Reconcile Toast - shows when offline DB data is updated via reconciliation */}
      <ReconcileToast />

      {/* Dispatcher Pickup Notification - alerts when driver is en route to their store */}
      <DispatcherPickupNotification
        deliveries={deliveries}
        stores={stores}
        appUsers={appUsers}
        currentUser={currentUser}
        isDispatcher={isDispatcher} />

      {/* Quick Route Adjustments Dialog */}
      {isDriver &&
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
      
      {/* AI Smart Prioritization Dialog */}
      {isDriver &&
      <Dialog open={showSmartPrioritization} onOpenChange={setShowSmartPrioritization}>
          <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto z-[10001]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
                <Sparkles className="w-5 h-5 text-purple-600" />
                AI Route Intelligence
              </DialogTitle>
            </DialogHeader>
            
            <SmartPrioritizationPanel
            driverId={currentUser?.id}
            deliveryDate={selectedDateStr}
            currentUser={currentUser}
            onApplySuggestion={async (suggestion) => {
              if (suggestion.action?.type === 'move_to_next') {
                // Move the urgent delivery to next position
                const deliveryToMove = deliveriesWithStopOrder.find((d) => d?.id === suggestion.deliveryId);
                if (deliveryToMove) {
                  await handleStartDelivery(deliveryToMove.id);
                  setShowSmartPrioritization(false);
                }
              }
            }} />

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