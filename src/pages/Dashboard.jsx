// Dashboard.js - Delivery Management Dashboard

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { flushSync } from "react-dom";
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
import { offlineDB } from "@/components/utils/offlineDatabase";
import { offlineFirstManager } from "@/components/utils/offlineFirstManager";
import DeliveryMap from "@/components/dashboard/DeliveryMap";
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
import { fabControlEvents } from "@/components/utils/fabControlEvents";
import {
  notifyDriverStarted,
  notifyDriverCompleted,
  notifyDriverFailed,
  notifyDriverRetry,
  notifyDriverReturn,
  getDispatchersForStore } from
"@/components/utils/deliveryMessaging";
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
import ETATracker from '../components/dashboard/ETATracker';
import ETANotification from '../components/dashboard/ETANotification';
import RealTimeRouteOptimizer from '../components/dashboard/RealTimeRouteOptimizer';
import QuickRouteAdjustments from '../components/dashboard/QuickRouteAdjustments';
import { driverActivityMonitor } from '@/components/utils/driverActivityMonitor';
import SmartPrioritizationPanel from '../components/dashboard/SmartPrioritizationPanel';
import DualStatsMarquee from '../components/dashboard/DualStatsMarquee';
import EndOfDayStatsDialog from '../components/dashboard/EndOfDayStatsDialog';
import { toast } from 'sonner';
import PullToSync from '../components/dashboard/PullToSync';

// FIXED: StatBadge - simple component without hooks to avoid violations
const StatBadge = ({ icon: Icon, value, color, label, tooltip, driverCount }) => {
  const colorClasses = {
    blue: "bg-blue-100 text-blue-600",
    purple: "bg-purple-100 text-purple-600",
    emerald: "bg-emerald-100 text-emerald-600",
    green: "bg-green-100 text-green-600",
    red: "bg-red-100 text-red-600",
    slate: "bg-slate-100 text-slate-600"
  };

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

// Helper function to round completion time to NEAREST 5-minute mark
// Rounds to whichever 5-minute mark is closest (up or down)
const roundCompletionTime = (timeISO) => {
  if (!timeISO) return timeISO;

  try {
    const date = new Date(timeISO);
    const minutes = date.getMinutes();

    // Round to nearest 5 minutes
    const roundedMinutes = Math.round(minutes / 5) * 5;
    date.setMinutes(roundedMinutes);
    date.setSeconds(0);
    date.setMilliseconds(0);
    console.log(`⏱️ [Round Time] Rounded to nearest 5min: ${minutes} → ${roundedMinutes} minutes`);

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
      console.log(`📅 [Dashboard Init] Using URL date: ${dateParam}`);
      return new Date(dateParam + 'T00:00:00');
    }

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
  const horizontalStopCardsRef = useRef(null); // Direct ref to HorizontalStopCards component

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
  const cardExpandedAtRef = useRef(null);
  const [showAllDriverMarkers, setShowAllDriverMarkers] = useState(false);
  const [showSmartPrioritization, setShowSmartPrioritization] = useState(false);
  const [performanceStats, setPerformanceStats] = useState(null);
  const [deliveryStats, setDeliveryStats] = useState(null);
  const [liveDistance, setLiveDistance] = useState(0); // Live accumulated distance from liveDistanceTracker
  const [liveTimeOnDuty, setLiveTimeOnDuty] = useState(null); // Live time on duty (null = use backend value)
  const [showEndOfDayStats, setShowEndOfDayStats] = useState(false);
  const [endOfDayDriver, setEndOfDayDriver] = useState(null);
  const [snapshotData, setSnapshotData] = useState(null);

  // ==================== REAL-TIME SUBSCRIPTIONS ====================
  // Subscribe to Patient and Delivery entity changes via WebSockets
  useEffect(() => {
    if (!currentUser || !isDataLoaded) return;

    console.log('🔌 [Real-time] Subscribing to Patient and Delivery changes...');

    // Subscribe to Patient entity changes
    const unsubscribePatients = base44.entities.Patient.subscribe((event) => {
      console.log(`📡 [Real-time Patient] ${event.type} event:`, event.data?.full_name || event.id);
      
      if (event.type === 'create') {
        // Add new patient to offline DB and context
        if (event.data) {
          offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [event.data]).catch(console.error);
          // Refresh data to update context
          refreshData?.();
        }
      } else if (event.type === 'update') {
        // Update patient in offline DB and context
        if (event.data) {
          offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [event.data]).catch(console.error);
          refreshData?.();
        }
      } else if (event.type === 'delete') {
        // Remove patient from offline DB
        offlineDB.deleteRecord(offlineDB.STORES.PATIENTS, event.id).catch(console.error);
        refreshData?.();
      }
    });

    // Subscribe to Delivery entity changes
    const unsubscribeDeliveries = base44.entities.Delivery.subscribe((event) => {
      console.log(`📡 [Real-time Delivery] ${event.type} event:`, event.data?.patient_name || event.id, 'driver:', event.data?.driver_id);
      
      // CRITICAL: Check if this delivery is for the selected date
      const deliveryDate = event.data?.delivery_date;
      const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
      const isForSelectedDate = deliveryDate === selectedDateStr;
      
      // CRITICAL: Determine if this is another driver's change
      const isOwnChange = event.data?.driver_id === currentUser?.id;
      const isOtherDriver = !isOwnChange;
      
      if (event.type === 'create') {
        // Add new delivery to offline DB and context
        if (event.data) {
          offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [event.data]).catch(console.error);
          
          // CRITICAL: For other drivers in All Drivers or Show All mode, fetch full delivery set
          if (isOtherDriver && isForSelectedDate && (selectedDriverId === 'all' || showAllDriverMarkers)) {
            console.log(`🔄 [Real-time] Other driver created delivery - refreshing for ${deliveryDate}`);
            base44.entities.Delivery.filter({ delivery_date: deliveryDate }).then(freshDeliveries => {
              offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries).catch(console.error);
              if (updateDeliveriesLocally) {
                const otherDateDeliveries = deliveries.filter(d => d?.delivery_date !== deliveryDate);
                updateDeliveriesLocally([...otherDateDeliveries, ...freshDeliveries], true);
              }
              // Trigger map and legend update
              window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                detail: { deliveryDate, triggeredBy: 'realtimeCreateOtherDriver' }
              }));
            }).catch(console.error);
          } else {
            // Own change or single driver mode - update incrementally
            if (updateDeliveriesLocally) {
              updateDeliveriesLocally([event.data], false);
            }
            // Trigger map update
            window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
              detail: { deliveryDate: event.data.delivery_date, triggeredBy: 'realtimeCreate' }
            }));
          }
        }
      } else if (event.type === 'update') {
        // Update delivery in offline DB and context
        if (event.data) {
          offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [event.data]).catch(console.error);
          
          // CRITICAL: For other drivers in All Drivers or Show All mode, fetch full delivery set
          if (isOtherDriver && isForSelectedDate && (selectedDriverId === 'all' || showAllDriverMarkers)) {
            console.log(`🔄 [Real-time] Other driver updated delivery - refreshing for ${deliveryDate}`);
            base44.entities.Delivery.filter({ delivery_date: deliveryDate }).then(freshDeliveries => {
              offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries).catch(console.error);
              if (updateDeliveriesLocally) {
                const otherDateDeliveries = deliveries.filter(d => d?.delivery_date !== deliveryDate);
                updateDeliveriesLocally([...otherDateDeliveries, ...freshDeliveries], true);
              }
              // Trigger map and legend update
              window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                detail: { deliveryDate, triggeredBy: 'realtimeUpdateOtherDriver' }
              }));
            }).catch(console.error);
          } else {
            // Own change or single driver mode - update incrementally
            if (updateDeliveriesLocally) {
              updateDeliveriesLocally([event.data], false);
            }
            // Trigger map update
            window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
              detail: { deliveryDate: event.data.delivery_date, triggeredBy: 'realtimeUpdate' }
            }));
          }
        }
      } else if (event.type === 'delete') {
        // Remove delivery from offline DB and context
        offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, event.id).catch(console.error);
        
        // CRITICAL: Fetch fresh data after delete to ensure correct state
        if (isForSelectedDate && (selectedDriverId === 'all' || showAllDriverMarkers)) {
          base44.entities.Delivery.filter({ delivery_date: selectedDateStr }).then(freshDeliveries => {
            offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries).catch(console.error);
            if (updateDeliveriesLocally) {
              const otherDateDeliveries = deliveries.filter(d => d?.delivery_date !== selectedDateStr);
              updateDeliveriesLocally([...otherDateDeliveries, ...freshDeliveries], true);
            }
            window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
              detail: { deliveryDate: selectedDateStr, triggeredBy: 'realtimeDeleteOtherDriver' }
            }));
          }).catch(console.error);
        } else {
          // Single driver mode - simple filter
          if (updateDeliveriesLocally && deliveries) {
            const filtered = deliveries.filter(d => d?.id !== event.id);
            updateDeliveriesLocally(filtered, true);
          }
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
            detail: { triggeredBy: 'realtimeDelete' }
          }));
        }
      }
    });

    return () => {
      console.log('🔌 [Real-time] Unsubscribing from Patient and Delivery changes');
      unsubscribePatients();
      unsubscribeDeliveries();
    };
  }, [currentUser?.id, isDataLoaded, updateDeliveriesLocally, deliveries, refreshData, selectedDate, selectedDriverId, showAllDriverMarkers]);

  // Listen for deliveries imported event to refresh map immediately
  useEffect(() => {
    const handleDeliveriesImported = async (event) => {
      const { deliveries: importedDeliveries, source } = event.detail || {};
      console.log('📥 [Dashboard] Deliveries imported - refreshing map and data');
      
      // Skip if source is Dashboard itself to prevent loops
      if (source === 'dashboard') return;
      
      try {
        const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
        
        // CRITICAL: Always load ALL drivers' deliveries to detect if import is for other drivers
        invalidateDeliveriesForDate(selectedDateStr);
        const freshDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
        console.log(`✅ [Import] Loaded ${freshDeliveries.length} deliveries for ALL drivers`);
        
        // CRITICAL: Check if imported deliveries are for a different driver
        const importedDriverIds = new Set(freshDeliveries.map(d => d?.driver_id).filter(Boolean));
        const isViewingSingleDriver = selectedDriverId !== 'all' && !showAllDriverMarkers;
        const isForOtherDriver = isViewingSingleDriver && !importedDriverIds.has(selectedDriverId);
        
        // Auto-enable "Show All" if importing for other drivers (admin/dispatcher only)
        if (isForOtherDriver && (isAdmin || isDispatcher)) {
          console.log('📍 [Import] Imported for other driver(s) - auto-enabling Show All to display markers');
          setShowAllDriverMarkers(true);
          if (currentUser?.id) {
            saveSetting(currentUser.id, 'show_all_driver_markers', true);
          }
        }
        
        // Update offline DB
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
        
        // Update UI with fresh data
        if (updateDeliveriesLocally) {
          const otherDateDeliveries = deliveries.filter((d) => d && d.delivery_date !== selectedDateStr);
          updateDeliveriesLocally([...otherDateDeliveries, ...freshDeliveries], true);
        }
        
        // CRITICAL: Force refresh ALL AppUsers after import to update all driver markers
        console.log('📍 [Import] Refreshing ALL driver locations after import...');
        const locationUpdates = await smartRefreshManager.refreshDriverLocations(appUsers, true, 'Dashboard', selectedDate);
        const latestAppUsers = locationUpdates?.appUsers || appUsers;
        
        // Dispatch location updates for ALL drivers
        window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
          detail: { appUsers: latestAppUsers, forceAll: true }
        }));
        
        // Force map markers and routes to update
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: { deliveryDate: selectedDateStr, triggeredBy: 'deliveriesImported' }
        }));
        
        // Trigger FAB to re-center map (Phase 1 for 500ms)
        if (mapViewPhase === 1) {
          // Clear any existing timers
          if (mapLockTimeoutRef.current) {
            clearTimeout(mapLockTimeoutRef.current);
            mapLockTimeoutRef.current = null;
          }
          mapLockExpiresAtRef.current = null;
          
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
        }
        
        console.log('✅ [Dashboard] Map updated after import');
      } catch (error) {
        console.error('❌ [Dashboard] Failed to refresh after import:', error);
      }
    };
    
    window.addEventListener('deliveriesImported', handleDeliveriesImported);
    return () => window.removeEventListener('deliveriesImported', handleDeliveriesImported);
  }, [selectedDate, refreshData, showAllDriverMarkers, selectedDriverId, currentUser, deliveries, updateDeliveriesLocally, mapViewPhase]);

  // Listen for performance stats AND delivery stats updates from Layout (QuickStats)
  useEffect(() => {
    const handlePerformanceStatsUpdate = (event) => {
      setPerformanceStats(event.detail);
    };

    const handleDeliveryStatsUpdate = (event) => {
      setDeliveryStats(event.detail);
    };

    // CRITICAL: Listen for live travel_dist updates
    const handleTravelDistUpdate = (event) => {
      const { deliveryId, travel_dist, totalAccumulatedDistance, completedDistance, inProgressDistance } = event.detail;
      console.log(`📏 [Dashboard] Live total distance: ${totalAccumulatedDistance.toFixed(3)} km (${completedDistance.toFixed(3)} completed + ${inProgressDistance.toFixed(3)} in-progress)`);

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
      console.log(`⏱️ [Dashboard] Time on duty: ${formattedTime}`);

      // CRITICAL: Store live time on duty to display on stats card
      setLiveTimeOnDuty(formattedTime);
    };

    window.addEventListener('performanceStatsUpdated', handlePerformanceStatsUpdate);
    window.addEventListener('deliveryStatsUpdated', handleDeliveryStatsUpdate);
    window.addEventListener('travelDistUpdated', handleTravelDistUpdate);
    window.addEventListener('timeOnDutyUpdated', handleTimeOnDutyUpdate);
    return () => {
      window.removeEventListener('performanceStatsUpdated', handlePerformanceStatsUpdate);
      window.removeEventListener('deliveryStatsUpdated', handleDeliveryStatsUpdate);
      window.removeEventListener('travelDistUpdated', handleTravelDistUpdate);
      window.removeEventListener('timeOnDutyUpdated', handleTimeOnDutyUpdate);
    };
  }, [deliveries, updateDeliveriesLocally, performanceStats]);

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

  // CRITICAL: Calculate isDriver early (before useEffect that needs it)
  const isMobile = useMemo(() => isMobileDevice(), []);
  const isDriver = useMemo(() => currentUser ? userHasRole(currentUser, 'driver') : false, [currentUser]);
  const isAdmin = useMemo(() => currentUser ? userHasRole(currentUser, 'admin') : false, [currentUser]);

  // Track dynamically measured heights for map padding
  // CRITICAL: Start at 0, will be measured once cards render
  const [stopCardsBaseHeight, setStopCardsBaseHeight] = useState(0);
  const [statsCardBaseHeight, setstatsCardBaseHeight] = useState(0);
  const measurementTimeoutRef = useRef(null);

  // Computed padding values for consistent map bounds
  // Note: paddingTopLeft = [horizontal, vertical from top]
  //       paddingBottomRight = [horizontal, vertical from bottom]

  const getMapPadding = useCallback(() => {
    const statsCardCurrHeight = statsCardRef.current?.offsetHeight || 75;
    const baseHeight = stopCardsBaseHeight || 0;

    const topPadding = isMobile ?
    statsCardCurrHeight + 25 :
    25;

    const bottomPadding = baseHeight > 0 ? baseHeight + 10 : 25;

    return {
      paddingTopLeft: [25, topPadding],
      paddingBottomRight: [25, bottomPadding]
    };
  }, [isMobile, stopCardsBaseHeight]);

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
        console.log(`📢 [Activity Monitor] ${currentUser.user_name} status auto-updated to ${newStatus}`);
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
  useEffect(() => {
    if (!isMobile || !isDriver || !currentUser?.id) return;

    const initTracking = async () => {
      // Set driver status in tracker
      const driverStatus = currentUser.driver_status || 'off_duty';
      locationTracker.setDriverStatus(driverStatus);
      console.log(`📍 [Dashboard] Set locationTracker status to: ${driverStatus}`);

      // CRITICAL: Always start tracking on mobile (even when off_duty/on_break)
      // Tracker will handle when to update location_updated_at based on status
      if (!locationTracker.isTracking) {
        try {
          const appUsers = await base44.entities.AppUser.filter({ user_id: currentUser.id });
          const appUser = appUsers?.[0];

          if (appUser) {
            console.log('🚀 [Dashboard] Auto-starting location tracking for mobile driver');
            await locationTracker.startTracking({
              ...currentUser,
              appUserId: appUser.id
            });
            console.log('✅ [Dashboard] Location tracking started successfully');

            // CRITICAL: Also start live distance tracker
            if (!liveDistanceTracker.isTracking) {
              liveDistanceTracker.start(currentUser);
              console.log('✅ [Dashboard] Live distance tracker started');

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
  }, [currentUser?.id, isMobile, isDriver]);

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
          const todayStr = format(new Date(), 'yyyy-MM-dd');
          const todayDeliveries = deliveries?.filter((d) => d && d.delivery_date === todayStr) || [];

          if (userHasRole(currentUser, 'dispatcher')) {
            // DISPATCHERS: Check deliveries for their assigned stores on SELECTED date (not just today)
            const selectedDateStr = settings.selected_date || format(new Date(), 'yyyy-MM-dd');
            const dispatcherStoreIds = currentUser.store_ids || [];
            const dateDeliveries = deliveries?.filter((d) =>
            d && d.delivery_date === selectedDateStr && dispatcherStoreIds.includes(d.store_id)
            ) || [];

            // Get unique drivers with deliveries for dispatcher's stores on selected date
            const driversWithDeliveries = new Set(
              dateDeliveries.map((d) => d.driver_id).filter(Boolean)
            );

            if (driversWithDeliveries.size === 1) {
              // Only 1 driver with deliveries - select that driver
              driverToSelect = Array.from(driversWithDeliveries)[0];
            } else if (driversWithDeliveries.size > 1) {
              // Multiple drivers - use "All Drivers"
              driverToSelect = 'all';
            } else {
              // No deliveries for dispatcher's stores - use saved or 'all'
              driverToSelect = settings.selected_driver_id || 'all';
            }
          } else if (userHasRole(currentUser, 'admin')) {
            // Admins - use saved or default
            driverToSelect = settings.selected_driver_id || 'all';
          } else {
            // Other roles - use saved or default
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
    // SNAPSHOT MODE: Use snapshot data instead of live data
    if (isSnapshotModeActive && snapshotData?.deliveries) {
      const dateStr = format(selectedDate, 'yyyy-MM-dd');
      let result = snapshotData.deliveries.filter(d => d && d.delivery_date === dateStr);
      
      // Filter by selected driver
      if (selectedDriverId && selectedDriverId !== 'all') {
        result = result.filter(d => d.driver_id === selectedDriverId);
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

      // CRITICAL: Sort completed by stop_order (imported from active routes), fallback to actual_delivery_time
      completedDeliveries.sort((a, b) => {
        if (!a || !b) return 0;

        // Sort by stop_order if both have it
        if (a.stop_order && b.stop_order) {
          return a.stop_order - b.stop_order;
        }

        // Fallback to actual_delivery_time
        if (!a.actual_delivery_time || !b.actual_delivery_time) return 0;
        return new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time);
      });

      // CRITICAL: Sort incomplete by stop_order (imported from active routes), fallback to ETA
      incompleteDeliveries.sort((a, b) => {
        if (!a || !b) return 0;

        // Sort by stop_order if both have it
        if (a.stop_order && b.stop_order) {
          return a.stop_order - b.stop_order;
        }

        // Fallback to ETA
        const etaA = a.delivery_time_eta || a.delivery_time_start || '99:99';
        const etaB = b.delivery_time_eta || b.delivery_time_start || '99:99';
        return etaA.localeCompare(etaB);
      });

      // Combine: completed + incomplete + pending at end (no special handling for isNextDelivery)
      const sortedDeliveries = [
      ...completedDeliveries,
      ...incompleteDeliveries,
      ...pendingDeliveries];


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

    if (isDispatcher) {
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
      const notes = d.delivery_notes || '';
      const patientName = d.patient_name || '';
      const patientFullName = patient?.full_name || '';
      return notes.toLowerCase().includes('(rtn)') || patientName.toLowerCase().includes('(rtn)') ||
        patientFullName.toLowerCase().includes('(rtn)') || /\breturn\b/i.test(notes) ||
        /\breturn\b/i.test(patientName) || /\breturn\b/i.test(patientFullName);
    };
    
    return patientDeliveriesOnly.length > 0 &&
      patientDeliveriesOnly.every((d) => finishedStatuses.includes(d.status) || isReturn(d));
  }, [filteredDeliveries, patients]);

  // Filter drivers based on role and deliveries
  const driversList = useMemo(() => {
    // CRITICAL: UNIFIED de-duplication - build final map from ALL sources at once
    const finalDriversMap = new Map();
    
    // SOURCE 1: AppUsers (most reliable, has all metadata)
    (appUsers || [])
      .filter((au) => au && au.user_id && au.app_roles?.includes('driver') && au.status === 'active')
      .forEach((au) => {
        const userId = au.user_id;
        const existing = finalDriversMap.get(userId);
        
        // Keep first occurrence or the one with better sort_order
        if (!existing || (au.sort_order || Infinity) < (existing.sort_order || Infinity)) {
          finalDriversMap.set(userId, {
            id: userId,
            user_id: userId,
            user_name: au.user_name,
            full_name: au.user_name,
            app_roles: au.app_roles,
            status: au.status,
            sort_order: au.sort_order,
            _source: 'appUsers'
          });
        }
      });
    
    // SOURCE 2: Drivers prop (full user data for admins) - ONLY add if not already in map
    if (drivers && Array.isArray(drivers)) {
      drivers.forEach((d) => {
        if (!d || !d.id) return;
        if (!finalDriversMap.has(d.id)) {
          finalDriversMap.set(d.id, {
            ...d,
            _source: 'drivers_prop'
          });
        }
      });
    }
    
    // SOURCE 3: Deliveries (fallback for missing drivers) - ONLY add if not already in map
    (deliveries || []).forEach((d) => {
      if (!d || !d.driver_id || !d.driver_name) return;
      if (!finalDriversMap.has(d.driver_id)) {
        finalDriversMap.set(d.driver_id, {
          id: d.driver_id,
          user_id: d.driver_id,
          user_name: d.driver_name,
          full_name: d.driver_name,
          app_roles: ['driver'],
          status: 'active',
          _source: 'deliveries'
        });
      }
    });

    // CRITICAL: Sort drivers by sort_order, then by user_name
    const driversSource = Array.from(finalDriversMap.values()).sort((a, b) => {
      const sortOrderA = a.sort_order ?? Infinity;
      const sortOrderB = b.sort_order ?? Infinity;

      if (sortOrderA !== sortOrderB) {
        return sortOrderA - sortOrderB;
      }

      // If same sort_order, sort alphabetically by user_name
      const nameA = (a.user_name || a.full_name || '').toLowerCase();
      const nameB = (b.user_name || b.full_name || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });

    console.log(`✅ [Dashboard] Built driver list: ${driversSource.length} unique drivers (${finalDriversMap.size} total)`);

    // ADMIN: Get all drivers
    if (userHasRole(currentUser, 'admin')) {
      return driversSource;
    }

    // DISPATCHER: Only show drivers with deliveries for dispatcher's stores ON THE SELECTED DATE
    if (userHasRole(currentUser, 'dispatcher')) {
      const dispatcherStoreIds = currentUser.store_ids || [];
      const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');

      // Get unique driver IDs that have deliveries for dispatcher's stores ON THE SELECTED DATE
      const driversWithStoreDeliveries = new Set(
        deliveries?.
        filter((d) => d && d.delivery_date === selectedDateStr && dispatcherStoreIds.includes(d.store_id)).
        map((d) => d.driver_id).
        filter(Boolean)
      );

      // Only return drivers who have deliveries for dispatcher's stores
      return driversSource.
      filter((d) => d && driversWithStoreDeliveries.has(d.id)).
      map((d) => ({
        ...d,
        _hasDispatcherStoreDeliveries: true
      }));
    }

    // OTHER ROLES: Return all drivers
    return driversSource;
  }, [drivers, appUsers, deliveries, currentUser, selectedDate]);

  // CRITICAL: Show location toggle on mobile devices regardless of layout mode
  const shouldShowLocationToggle = useMemo(() => {
    const isMobileDevice = isMobile; // Already uses isMobileDevice() - detects by user agent
    return isMobileDevice && isDriver && !userHasRole(currentUser, 'dispatcher');
  }, [isMobile, isDriver, currentUser]);

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

  // NOTE: Removed auto-fit bounds effect that was causing map to re-center unexpectedly
  // The FAB handleMapViewCycle now handles all map positioning

  useEffect(() => {
    localStorage.setItem('rxdeliver_show_routes', String(showRoutes));
  }, [showRoutes]);

  // Subscribe to global filter changes AND URL params
  useEffect(() => {
    // Check URL params on mount AND on location changes
    const urlParams = new URLSearchParams(window.location.search);
    const dateParam = urlParams.get('date');

    if (dateParam) {
      console.log(`📅 [Dashboard Effect] URL date param found: ${dateParam}`);
      const dateObj = new Date(dateParam + 'T00:00:00');
      const currentDateStr = format(selectedDate, 'yyyy-MM-dd');

      // Only update if different from current state
      if (dateParam !== currentDateStr) {
        console.log(`📅 [Dashboard Effect] Applying URL date: ${dateParam}`);
        setSelectedDate(dateObj);
        setCalendarMonth(dateObj);
        globalFilters.setSelectedDate(dateParam);
      }
    }

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
      }});
    return unsubscribe;
  }, [window.location.search, selectedDate]); // Listen for driver status break/resume events from DriverStatusToggle
  useEffect(() => {const unsubscribe = fabControlEvents.subscribe((event) => {if (event.type === 'BREAK_START') {
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
      } else if (event.type === 'DONE_BUTTON_CLICKED') {
        // CRITICAL: Done button was clicked - activate Phase 1 for 500ms
        console.log('🎯 [FAB] Done button clicked - activating Phase 1 for 500ms');

        // Clear any existing timers
        if (mapLockTimeoutRef.current) {
          clearTimeout(mapLockTimeoutRef.current);
          mapLockTimeoutRef.current = null;
        }
        mapLockExpiresAtRef.current = null;

        // Set to Phase 1 and lock
        setMapViewPhase(1);
        setIsMapViewLocked(true);
        lastProgrammaticMapMoveRef.current = Date.now();
        window._lastProgrammaticMapMove = Date.now();
        setMapViewTrigger((prev) => prev + 1);

        // Auto-unlock after 500ms
        const lockDuration = 500;
        const expiresAt = Date.now() + lockDuration;
        mapLockExpiresAtRef.current = expiresAt;

        mapLockTimeoutRef.current = window.setTimeout(() => {
          if (mapLockExpiresAtRef.current === expiresAt) {
            setIsMapViewLocked(false);
            mapLockExpiresAtRef.current = null;
            mapLockTimeoutRef.current = null;
            console.log('⏰ [FAB] Phase 1 auto-unlocked after 500ms (Done button)');
          }
        }, lockDuration);
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



  // Listen for screen resize event from DeliveryMap and re-apply FAB phase
  useEffect(() => {
    const handleScreenResized = () => {
      console.log('📱 [Dashboard] Screen resized - re-applying FAB phase');
      
      // CRITICAL: Only auto-center and zoom if on phase 1
      if (mapViewPhase === 1) {
        // Mark as programmatic move
        lastProgrammaticMapMoveRef.current = Date.now();
        window._lastProgrammaticMapMove = Date.now();
        
        // Lock and trigger map view
        setIsMapViewLocked(true);
        setMapViewTrigger((prev) => prev + 1);
        
        // Auto-unlock after 500ms
        setTimeout(() => {
          setIsMapViewLocked(false);
        }, 500);
      }
    };
    
    window.addEventListener('screenResized', handleScreenResized);
    return () => window.removeEventListener('screenResized', handleScreenResized);
  }, [mapViewPhase]);

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

  // Measure stop cards height - whenever cards render or delivery list changes
  useEffect(() => {
    const element = horizontalStopCardsRef.current;
    if (!element) return;

    // Only measure when NO card is expanded (all cards collapsed/condensed)
    if (selectedCardId) return;

    // Wait for cards to render, then measure the actual HorizontalStopCards element
    const timer = setTimeout(() => {
      const height = element.offsetHeight;
      if (height > 0 && height !== stopCardsBaseHeight) {
        console.log(`📏 [Stop Cards] Measured height: ${height}px (previous: ${stopCardsBaseHeight}px)`);
        setStopCardsBaseHeight(height);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [selectedCardId, deliveriesWithStopOrder.length, deliveriesWithStopOrder.map(d => `${d?.id}:${d?.status}`).join(',')]);
  
  // CRITICAL: Re-measure stop cards height after smart refresh or data updates
  useEffect(() => {
    const handleHeightRemeasure = () => {
      if (!horizontalStopCardsRef.current || selectedCardId) return;
      
      setTimeout(() => {
        const element = horizontalStopCardsRef.current;
        if (element) {
          const height = element.offsetHeight;
          if (height > 0 && height !== stopCardsBaseHeight) {
            console.log(`📏 [Height Update] Stop cards height changed: ${stopCardsBaseHeight}px → ${height}px`);
            setStopCardsBaseHeight(height);
          }
        }
      }, 300);
    };
    
    window.addEventListener('deliveriesUpdated', handleHeightRemeasure);
    window.addEventListener('smartRefreshComplete', handleHeightRemeasure);
    
    return () => {
      window.removeEventListener('deliveriesUpdated', handleHeightRemeasure);
      window.removeEventListener('smartRefreshComplete', handleHeightRemeasure);
    };
  }, [selectedCardId, stopCardsBaseHeight]);

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
      // CRITICAL: Silently fail on rate limits - this is non-essential data
      if (error.response?.status === 429 || error.message?.includes('429') || error.message?.includes('Rate limit')) {
        console.log('⏰ [Polyline Count] Rate limited - keeping cached value');
        return;
      }
      console.warn('⚠️ [Polyline Count] Error fetching count:', error.message);
      setDailyPolylineCount(0);
    }
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser || !isAppOwner(currentUser)) return;

    // CRITICAL: Skip initial fetch on mount to reduce API calls
    // Only refresh on interval
    const interval = setInterval(fetchPolylineCount, 300000);
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

          // CRITICAL: Reactivate FAB if Phase 2 is active (desktop only)
          if (mapViewPhaseRef.current === 2 && nextStopCoordinates) {
            console.log('📍 [Desktop Phase 2] Driver location updated - reactivating FAB');

            // CRITICAL: Clear any existing timers FIRST
            if (mapLockTimeoutRef.current) {
              clearTimeout(mapLockTimeoutRef.current);
              mapLockTimeoutRef.current = null;
            }
            mapLockExpiresAtRef.current = null;

            setIsMapViewLocked(true);
            lastProgrammaticMapMoveRef.current = Date.now();
            window._lastProgrammaticMapMove = Date.now();
            setMapViewTrigger((prev) => prev + 1);
          }
        } else {
          setDriverLocation(null);
        }

        return () => {};
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

              const padding = getMapPadding();

              // CRITICAL: Mark as programmatic move to prevent zoom indicator
              window._lastProgrammaticMapMove = Date.now();

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
                    const padding = getMapPadding();
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
  }, [isDriver, currentUser, isMobile, deliveriesWithStopOrder, patients, stores, mapViewPhase, getMapPadding, appUsers]);

  // CRITICAL: Periodic smart refresh - loads deliveries based on "Show All" checkbox and driver selection
  useEffect(() => {
    if (!isDataLoaded || !currentUser || !isFiltersReady) {
      return;
    }

    // CRITICAL: Set current user in smart refresh manager for location polling
    smartRefreshManager.setCurrentUser(currentUser);

    const runPeriodicSmartRefresh = async () => {
      if (showDeliveryForm || showPatientForm || showOptimizationSettings) {
        return; // Skip when forms are open
      }

      const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
      const todayStr = format(new Date(), 'yyyy-MM-dd');
      const isToday = selectedDateStr === todayStr;

      // CRITICAL: ALWAYS load ALL drivers' deliveries for complete map marker data
      // This ensures markers update correctly in Single Driver, All Drivers, and Show All modes
      console.log(`🔄 [Periodic Refresh] Loading ALL drivers for ${selectedDateStr} (isToday: ${isToday})`);

      let freshDeliveries;

      // CRITICAL: ALWAYS fetch from API for today's date (cross-device sync)
      // Only use dataSource preference for historical dates
      if (isToday || dataSource === 'online') {
        console.log(`🌐 [Periodic Refresh] Fetching ALL drivers from API (${isToday ? 'today - cross-device sync' : 'online mode'})`);
        try {
          freshDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
          // CRITICAL: ALWAYS sync to offline DB after API fetch to persist updates
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
          console.log(`✅ [Periodic Refresh] Synced ${freshDeliveries.length} deliveries to offline DB`);
        } catch (apiError) {
          console.warn(`⚠️ [Periodic Refresh] API fetch failed - using offline DB: ${apiError.message}`);
          freshDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr) || [];
        }
      } else {
        // Historical dates - try offline DB first
        freshDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);

        if (!freshDeliveries || freshDeliveries.length === 0) {
          console.log('📥 [Periodic Refresh] Offline DB empty - fetching ALL from API');
          freshDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
        } else {
          console.log(`📦 [Periodic Refresh] Loaded ${freshDeliveries.length} ALL drivers from offline DB`);
          // CRITICAL: Even when using offline data, occasionally refresh from API to catch cross-device updates
          // Refresh every 3 cycles (45 seconds) to stay current
          if (Math.floor(Date.now() / 15000) % 3 === 0) {
            console.log(`🔄 [Periodic Refresh] Syncing offline DB with API for cross-device updates...`);
            try {
              const apiDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
              await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, apiDeliveries);
              freshDeliveries = apiDeliveries;
              console.log(`✅ [Periodic Refresh] Synced ${apiDeliveries.length} deliveries from API to offline DB`);
            } catch (syncError) {
              console.warn(`⚠️ [Periodic Refresh] API sync failed - using cached offline data: ${syncError.message}`);
            }
          }
        }
      }

      // Update context with fresh deliveries
      if (updateDeliveriesLocally && freshDeliveries.length > 0) {
        const otherDateDeliveries = deliveries.filter((d) => d && d.delivery_date !== selectedDateStr);
        updateDeliveriesLocally([...otherDateDeliveries, ...freshDeliveries], true);
        console.log(`✅ [Periodic Refresh] Updated UI with ${freshDeliveries.length} ALL drivers deliveries`);
      }

      // CRITICAL: ALWAYS force full AppUser refresh to get ALL drivers' locations
      // This ensures ALL markers update regardless of selection mode
      const locationUpdates = await smartRefreshManager.refreshDriverLocations(appUsers, true, 'Dashboard', selectedDate, true);

      // Use updated AppUsers or fall back to current context
      const latestAppUsers = locationUpdates?.appUsers || appUsers;

      // CRITICAL: Sync AppUsers to offline DB for cross-device consistency
      if (latestAppUsers && latestAppUsers.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, latestAppUsers);
        console.log(`✅ [Periodic Refresh] Synced ${latestAppUsers.length} AppUsers to offline DB`);
      }

      // CRITICAL: Incremental patient sync - only fetch patients that changed since last refresh
      const uniquePatientIds = [...new Set(freshDeliveries.filter(d => d?.patient_id).map(d => d.patient_id))];
      if (uniquePatientIds.length > 0) {
        try {
          // Get existing patients from offline DB to check timestamps
          const existingPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
          const existingPatientMap = new Map(existingPatients.map(p => [p.id, p.updated_date]));
          
          // Only fetch patients that don't exist or might have been updated
          const patientIdsToFetch = uniquePatientIds.filter(id => {
            const existingTimestamp = existingPatientMap.get(id);
            // Fetch if: not in DB OR was updated in last hour (likely changed)
            if (!existingTimestamp) return true;
            const age = Date.now() - new Date(existingTimestamp).getTime();
            return age < 3600000; // 1 hour
          });
          
          if (patientIdsToFetch.length > 0) {
            const freshPatients = await base44.entities.Patient.filter({ id: { $in: patientIdsToFetch } });
            if (freshPatients && freshPatients.length > 0) {
              await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, freshPatients);
              console.log(`✅ [Periodic Refresh] Synced ${freshPatients.length}/${uniquePatientIds.length} changed patients to offline DB`);
            }
          } else {
            console.log(`⏭️ [Periodic Refresh] All ${uniquePatientIds.length} patients already current in offline DB`);
          }
        } catch (patientError) {
          console.warn(`⚠️ [Periodic Refresh] Failed to sync patients: ${patientError.message}`);
        }
      }

      // CRITICAL: Always process location data for ALL drivers to update markers
      driverLocationPoller.processLocationData(
        currentUser, 
        freshDeliveries, 
        drivers, 
        stores, 
        latestAppUsers, 
        selectedDate, 
        true
      );

      // CRITICAL: ALWAYS dispatch for ALL drivers to ensure complete marker updates
      console.log(`📍 [Periodic Refresh] Dispatching location updates for ALL ${latestAppUsers.length} drivers`);
      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
        detail: { appUsers: latestAppUsers, forceAll: true }
      }));

      // CRITICAL: Force trigger legend and marker refresh
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { deliveryDate: selectedDateStr, triggeredBy: 'periodicRefresh', allDrivers: true }
      }));
    };

    // CRITICAL: Only run on interval, NOT immediately when driver selection changes
    const interval = setInterval(runPeriodicSmartRefresh, 15000);

    return () => clearInterval(interval);
  }, [isDataLoaded, currentUser, isFiltersReady, showAllDriverMarkers, selectedDriverId, selectedDate, showDeliveryForm, showPatientForm, showOptimizationSettings, deliveries, drivers, stores, patients, appUsers, dataSource, updateDeliveriesLocally]);

  // Track other drivers' locations via poller (for all-drivers mode or when checkbox is checked)
  // CRITICAL: Initialize poller once on mount
  useEffect(() => {
    if (!isDataLoaded || !currentUser) {
      return;
    }

    driverLocationPoller.start(() => {


      // Callback provided for future use
    }, currentUser);const unsubscribe = driverLocationPoller.subscribe((locations) => {
      if (!locations || !Array.isArray(locations)) return;

      const currentUserId = currentUser?.id;
      const currentUserUserId = currentUser?.user_id;
      const filteredLocations = isMobile && isDriver ?
      locations.filter((loc) => {
        const locId = loc.driver_id || loc.user_id || loc.id;
        const isSelfMarker = locId === currentUserId ||
        locId === currentUserUserId ||
        loc._isSelf === true;
        if (isSelfMarker) {
          console.log('🚫 [Dashboard] BLOCKING self shared marker on mobile (ID match)', { locId, currentUserId });
          return false;
        }
        return true;
      }) :
      locations;

      console.log(`📍 [Dashboard] Setting ${filteredLocations.length} driver locations (mobile: ${isMobile}, filtered self: ${locations.length - filteredLocations.length})`);

      setAllDriverLocations(filteredLocations);
    });

    // Listen for location update events
    const handleLocationUpdate = () => {
      console.log('📍 [Dashboard] driverLocationsUpdated event received');
    };
    window.addEventListener('driverLocationsUpdated', handleLocationUpdate);

    return () => {
      unsubscribe();
      driverLocationPoller.stop();
      window.removeEventListener('driverLocationsUpdated', handleLocationUpdate);
    };
  }, [isDataLoaded, currentUser?.id, currentUser?.user_id, isMobile, isDriver]);

  // CRITICAL: Separate effect to reprocess location data when dependencies change
  // This ensures the poller has updated data without restarting (which would clear subscribers)
  useEffect(() => {
    if (!isDataLoaded || !currentUser || !deliveries || !drivers || !appUsers) {
      return;
    }

    console.log('📍 [Dashboard] Reprocessing location data - data updated');
    driverLocationPoller.processLocationData(currentUser, deliveries, drivers, stores, appUsers, selectedDate, true);
  }, [isDataLoaded, currentUser?.id, deliveries, drivers, appUsers, stores, selectedDate]);

  // REMOVED: This effect was causing re-processing on every appUsers/deliveries change
  // Location processing is now handled once on mount in the poller initialization effect above // Fetch and display current-to-next polyline for display
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
      console.log('📍 [Polyline] Driver location changed - refreshing polyline');
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
    
    // CRITICAL: Only pause smart refresh (route optimization) when form is open
    // DO NOT pause mutations - the form needs them to save deliveries
    if (showDeliveryForm) {
      console.log('⏸️ [Dashboard] Delivery form opened - pausing smart refresh only');
      smartRefreshManager.pause();
    } else {
      console.log('▶️ [Dashboard] Delivery form closed - resuming smart refresh');
      smartRefreshManager.resume();
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

    // CRITICAL: Auto-center to next delivery card for ALL phases
    setTimeout(() => {
      const nextCard = deliveriesWithStopOrder.find((d) => d && d.isNextDelivery === true);
      if (nextCard) {
        const cardElement = document.getElementById(`stop-card-${nextCard.id}`);
        if (cardElement) {
          cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          console.log(`📍 [FAB Click] Auto-centered to next delivery card (Phase ${newMapViewPhase})`);
        }
      } else {
        // Fallback: if no next delivery, center on first incomplete
        const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned', 'pending'];
        const firstIncomplete = deliveriesWithStopOrder.find((d) =>
        d && !finishedStatuses.includes(d.status)
        );
        if (firstIncomplete) {
          const cardElement = document.getElementById(`stop-card-${firstIncomplete.id}`);
          if (cardElement) {
            cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            console.log('📍 [FAB Click] Auto-centered to first incomplete card');
          }
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
    // CRITICAL: Only run when mapViewTrigger changes - prevent re-runs from data updates
    if (mapViewTrigger === 0 || mapViewTrigger === lastAppliedTriggerRef.current) {
      return;
    }

    if (mapViewPhase === 0) {
      return;
    }

    // Update last applied trigger FIRST
    lastAppliedTriggerRef.current = mapViewTrigger;

    console.log(`🗺️ [Map Position Effect] Running for trigger ${mapViewTrigger}, phase ${mapViewPhase}`);

    // CRITICAL: Only skip phase 2 & 3 if not driver or no location
    // Phase 1 can run for dispatchers/admins without driver location
    if (mapViewPhase > 1 && (!isDriver || !driverLocation)) {
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
        const todayStr = format(new Date(), 'yyyy-MM-dd');
        const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
        const isViewingToday = todayStr === selectedDateStr;

        // CRITICAL: Treat "Show All" mode same as "All Drivers" mode for map bounds
        const shouldShowAllMarkersForBounds = selectedDriverId === 'all' || showAllDriverMarkers;

        // 1. BLUE DOT: Include driver's live location when visible on mobile
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

        // 2. SHARED DRIVER LOCATIONS: Include when in "All Drivers" mode OR "Show All" is checked OR when desktop OR dispatcher
        console.log(`🗺️ [Phase 1] showAllDriverMarkers: ${showAllDriverMarkers}`);
        console.log(`🗺️ [Phase 1] shouldShowAllMarkersForBounds: ${shouldShowAllMarkersForBounds}`);
        console.log(`🗺️ [Phase 1] isViewingToday: ${isViewingToday}`);
        console.log(`🗺️ [Phase 1] isMobile: ${isMobile}`);
        console.log(`🗺️ [Phase 1] isDispatcher: ${isDispatcher}`);
        console.log(`🗺️ [Phase 1] allDriverLocations count: ${allDriverLocations?.length || 0}`);

        // CRITICAL: Always include shared locations for desktop OR "show all" mode OR dispatchers
        const shouldIncludeSharedLocations = !isMobile || shouldShowAllMarkersForBounds || isDispatcher;
        
        // CRITICAL: Also load from window.__mapDriverLocationMarkers (rendered on map)
        const mapDriverLocationMarkers = window.__mapDriverLocationMarkers || [];
        console.log(`🗺️ [Phase 1] Map driver location markers count: ${mapDriverLocationMarkers.length}`);

        if (isViewingToday && shouldIncludeSharedLocations && (allDriverLocations.length > 0 || mapDriverLocationMarkers.length > 0) && (Array.isArray(allDriverLocations) || Array.isArray(mapDriverLocationMarkers))) {
          let addedCount = 0;
          
          // Combine both sources for shared locations
          const allLocationSources = [...(allDriverLocations || []), ...mapDriverLocationMarkers];
          
          // Deduplicate by driver_id
          const uniqueLocations = new Map();
          allLocationSources.forEach(loc => {
            if (loc?.driver_id && !uniqueLocations.has(loc.driver_id)) {
              uniqueLocations.set(loc.driver_id, loc);
            }
          });
          
          Array.from(uniqueLocations.values()).forEach((location) => {
            if (!location?.latitude || !location?.longitude || !location?.driver_id) {
              console.log('⏭️ [Phase 1] Skipping location - missing coords/id:', location);
              return;
            }

            // CRITICAL: Skip current user on mobile (blue dot shows instead) - but NOT for dispatchers
            const isCurrentUserLocation = isMobile && !isDispatcher && location.driver_id === currentUser?.id;
            if (isCurrentUserLocation) {
              console.log('🚫 [Phase 1] Skipping self shared location on mobile (driver):', location.driver_id);
              return;
            }

            // CRITICAL: Phase 1 "Show All" mode - include ALL rendered markers regardless of status
            // No filtering by driver_status or location_tracking_enabled
            // If the marker is rendered on the map, it should be in the bounds

            // Dispatcher filtering - check ALL date deliveries, not just selected driver
            if (isDispatcher && !isAdmin) {
              const dispatcherStoreIds = new Set(currentUser?.store_ids || []);
              const allDateDeliveries = deliveries.filter((d) => d && d.delivery_date === selectedDateStr);
              const hasDeliveryInDispatcherStore = allDateDeliveries.some((delivery) =>
              delivery &&
              delivery.driver_id === location.driver_id &&
              dispatcherStoreIds.has(delivery.store_id)
              );
              if (!hasDeliveryInDispatcherStore) {
                console.log('⏭️ [Phase 1] Skipping location - no dispatcher store delivery:', location.driver_id);
                return;
              }
            }

            allCoordinates.push([location.latitude, location.longitude]);
            hasDriverMarkers = true;
            addedCount++;
            console.log(`✅ [Phase 1] Added shared location: ${location.driver_id} (status: ${location.driver_status}, tracking: ${location.location_tracking_enabled})`);
          });
          console.log(`🗺️ [Phase 1] Added ${addedCount} shared driver locations (from ${uniqueLocations.size} unique sources)`);
        } else {
          console.log(`⏭️ [Phase 1] Not showing shared locations - conditions not met`);
        }

        // 3. HOME LOCATIONS: Use markers from DeliveryMap (already filtered and validated)
        // CRITICAL: These are the actual home markers rendered on the map
        const mapHomeMarkers = window.__mapHomeMarkers || [];
        
        if (mapHomeMarkers.length > 0) {
          console.log(`🏠 [Phase 1] Including ${mapHomeMarkers.length} home markers from map`);
          mapHomeMarkers.forEach((home) => {
            // CRITICAL: Skip markers flagged to exclude from bounds (after first stop completed)
            if (home.excludeFromBounds) {
              console.log(`⏭️ [Phase 1] Skipping home marker ${home.id} from bounds (excludeFromBounds flag)`);
              return;
            }
            
            if (home.latitude && home.longitude) {
              allCoordinates.push([home.latitude, home.longitude]);
              console.log(`✅ [Phase 1] Added home marker for driver ${home.driverName}`);
            }
          });
        } else {
          console.log('⏭️ [Phase 1] No home markers available from map');
        }

        // 4. Add delivery/pickup markers based on mode
        // CRITICAL: When "Show All" is checked OR "All Drivers" selected, show ALL deliveries for date
        let deliveriesToMap = [];

        if (shouldShowAllMarkersForBounds) {
          // Show all deliveries for selected date
          let allDateDeliveries = deliveries.filter((d) => d && d.delivery_date === selectedDateStr);

          // CRITICAL: For dispatchers, ONLY include deliveries from drivers who have stops in dispatcher's stores
          if (isDispatcher && !isAdmin) {
            const dispatcherStoreIds = new Set(currentUser?.store_ids || []);

            // Get drivers who have deliveries in dispatcher's stores
            const driversWithStoreDeliveries = new Set(
              allDateDeliveries.
              filter((d) => d && dispatcherStoreIds.has(d.store_id)).
              map((d) => d.driver_id).
              filter(Boolean)
            );

            // Filter to only show deliveries from those drivers (ALL their stops for the date)
            deliveriesToMap = allDateDeliveries.filter((d) => d && driversWithStoreDeliveries.has(d.driver_id));

            console.log(`🗺️ [Phase 1 - Dispatcher] Filtered to ${deliveriesToMap.length} deliveries from ${driversWithStoreDeliveries.size} drivers with store stops`);
          } else {
            deliveriesToMap = allDateDeliveries;
          }
        } else {
          // Single driver mode - show only that driver's deliveries
          deliveriesToMap = deliveriesWithStopOrder;
        }

        console.log(`🗺️ [Phase 1] Processing ${deliveriesToMap.length} deliveries (mode: ${shouldShowAllMarkersForBounds ? 'All Markers' : 'Single Driver'})`);

        let coordsAdded = 0;

        if (deliveriesToMap && Array.isArray(deliveriesToMap)) {
          deliveriesToMap.forEach((delivery) => {
            if (!delivery) return;

            if (delivery.patient_id) {
              const patient = patients.find((p) => p && p.id === delivery.patient_id);
              if (patient?.latitude && patient?.longitude) {
                allCoordinates.push([patient.latitude, patient.longitude]);
                hasStopMarkers = true;
                coordsAdded++;
              }
            } else if (delivery.store_id) {
              const store = stores.find((s) => s && s.id === delivery.store_id);
              if (store?.latitude && store?.longitude) {
                allCoordinates.push([store.latitude, store.longitude]);
                hasStopMarkers = true;
                coordsAdded++;
              }
            }
          });
          console.log(`🗺️ [Phase 1] Added ${coordsAdded} stop markers`);
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

            const padding = getMapPadding();
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
          const padding = getMapPadding();
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
          console.log(`🗺️ [Phase 1] Fitting ${allCoordinates.length} coordinates (hasStopMarkers: ${hasStopMarkers}, hasDriverMarkers: ${hasDriverMarkers})`);

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
          const baseZoom = 16 - Math.log2(spanKm + 1) * 1.5;
          const screenAdjustment = isMobile ? 0.5 : -0.5;
          const phase1MaxZoom = Math.max(8.0, Math.min(15, Math.round((baseZoom + screenAdjustment) * 10) / 10)).toFixed(1);
          console.log(`🗺️ [Phase 1] maxZoom: ${phase1MaxZoom}, span: ${spanKm.toFixed(2)}km`);

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

      case 2: // "Center on Driver & Next Stop"
        console.clear;
        // Mark that we're doing a programmatic map move (debounces interaction handler)
        lastProgrammaticMapMoveRef.current = Date.now();
        window._lastProgrammaticMapMove = Date.now();

        if (nextStopCoordinates) {
          // CRITICAL: Use actual driver location (blue dot or shared marker), not polyline endpoints
          let driverLat, driverLon;
          
          // Priority 1: Use live GPS location (mobile blue dot)
          if (driverLocation?.latitude && driverLocation?.longitude) {
            driverLat = driverLocation.latitude;
            driverLon = driverLocation.longitude;
          }
          // Priority 2: Use shared location marker (green marker from AppUser)
          else {
            const sharedDriverLocation = allDriverLocations.find(loc => loc.driver_id === currentUser?.id);
            if (sharedDriverLocation?.latitude && sharedDriverLocation?.longitude) {
              driverLat = sharedDriverLocation.latitude;
              driverLon = sharedDriverLocation.longitude;
            }
            // Priority 3: Fall back to current user's location from appUsers
            else if (currentUser?.current_latitude && currentUser?.current_longitude) {
              driverLat = currentUser.current_latitude;
              driverLon = currentUser.current_longitude;
            }
          }
          
          // Only center if we have valid driver coordinates
          if (driverLat && driverLon) {
            const bounds = [
              [driverLat, driverLon],
              [nextStopCoordinates.lat, nextStopCoordinates.lon]
            ];

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
        } else if (driverLocation?.latitude && driverLocation?.longitude) {
          // If no next stop, just center on driver with padding
          const padding = getMapPadding();

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

        // CRITICAL: Check if selected date is in the past
        const todayStrPhase3 = format(new Date(), 'yyyy-MM-dd');
        const selectedDateStrPhase3 = format(selectedDate, 'yyyy-MM-dd');
        const isPastDatePhase3 = selectedDateStrPhase3 < todayStrPhase3;

        // CRITICAL: Check driver status
        const driverPhase3 = users.find((u) => u && u.id === currentUser?.id);
        const isDriverOnDutyPhase3 = driverPhase3 && driverPhase3.driver_status === 'on_duty';

        // CRITICAL: Reactivate Phase 1 if driver is off duty OR date is in the past
        if (!isDriverOnDutyPhase3 || isPastDatePhase3) {
          console.log(`🔄 [Phase 3] Conditions not met (on_duty: ${isDriverOnDutyPhase3}, isPast: ${isPastDatePhase3}) - switching to Phase 1`);
          setMapViewPhase(1);
          setMapViewTrigger((prev) => prev + 1);

          // Set 3-second unlock timer for Phase 1
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
          return;
        }

        if (!driverLocation?.latitude || !driverLocation?.longitude) {
          console.warn('⚠️ [FAB Click] Phase 3 - No driver location available');
          return;
        }

        const padding = getMapPadding();

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
      console.log(`✅ [Render Sequence 3] Map Markers ready (${deliveriesWithStopOrder.length} deliveries, ${patients.length} patients, ${stores.length} stores)`);
      setRenderSequence((prev) => ({ ...prev, mapMarkers: true }));
    }
  }, [renderSequence.fabs, renderSequence.mapMarkers, deliveriesWithStopOrder.length, patients.length, stores.length]);

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

    // CRITICAL: Wait for allDriverLocations to populate OR timeout after 3 seconds
    // This ensures FAB phase 1 sees other drivers' markers on initial load
    const hasSharedLocations = allDriverLocations.length > 0;

    if (hasSharedLocations) {
      console.log(`✅ [Render Sequence 6] Shared Driver Locations ready (${allDriverLocations.length} locations)`);
      setRenderSequence((prev) => ({ ...prev, sharedLocations: true }));
      return;
    }

    // Wait longer for locations to load before timing out
    const timer = setTimeout(() => {
      console.log('⏱️ [Render Sequence 6] Timeout - proceeding without shared locations');
      setRenderSequence((prev) => ({ ...prev, sharedLocations: true }));
    }, 3000); // Increased to 3 seconds

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

    console.log(`🔍 [Render Sequence 7] Checking: ${deliveriesToCheck.length} deliveries, ${uniqueDrivers.size} drivers for ${selectedDateStr}`);

    // CRITICAL: Mark ready when we have data (no artificial waiting)
    if (deliveriesToCheck.length > 0 && patients.length > 0 && stores.length > 0) {
      console.log(`✅ [Render Sequence 7] Data ready - ${deliveriesToCheck.length} deliveries with patient/store data`);
      setRenderSequence((prev) => ({ ...prev, fullDeliveriesLoaded: true }));
      return;
    }

    // Timeout if no deliveries after 2 seconds
    const timer = setTimeout(() => {
      console.log(`⏱️ [Render Sequence 7] Timeout - proceeding (${deliveriesToCheck.length} deliveries)`);
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
  // Apply initial map view on first load - WAIT for full render sequence
  const initialSyncCompletedRef = useRef(false);
  
  useEffect(() => {
    // CRITICAL: Wait for full render sequence INCLUDING full deliveries before activating FAB phase
    if (!renderSequence.fullDeliveriesLoaded || renderSequence.fabPhaseReady) {
      return;
    }

    if (initialMapViewApplied) {
      setRenderSequence((prev) => ({ ...prev, fabPhaseReady: true }));
      return;
    }

    console.log('✅ [Render Sequence 8] All elements rendered - activating FAB phase (skipping sync)');
    
    // DISABLED: Initial sync removed to prevent rate limit loops on F5
    // Dashboard mount effect (line 6914) already handles loading deliveries on mount
    // Periodic refresh (line 1957) keeps data current every 15 seconds
    // This sync was redundant and causing rate limit loops when refreshing

    console.log('✅ [Render Sequence 8] All elements rendered - activating FAB phase');
    console.log(`   - deliveries count: ${deliveries.length}`);
    console.log(`   - allDriverLocations count: ${allDriverLocations.length}`);
    console.log(`   - showAllDriverMarkers: ${showAllDriverMarkers}`);
    console.log(`   - deliveriesWithStopOrder count: ${deliveriesWithStopOrder.length}`);

    // CRITICAL: Ensure we have ALL drivers' deliveries loaded when Show All is checked
    const shouldHaveAllDeliveries = selectedDriverId === 'all' || showAllDriverMarkers;
    const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
    const deliveriesForDate = deliveries.filter((d) => d && d.delivery_date === selectedDateStr);

    console.log(`   - shouldHaveAllDeliveries: ${shouldHaveAllDeliveries}`);
    console.log(`   - deliveriesForDate count: ${deliveriesForDate.length}`);

    // CRITICAL: Notify fabControlEvents that initial data is ready
    // This allows other components to know when dashboard is fully loaded
    fabControlEvents.notifyDataReady();

    // CRITICAL: Delay FAB activation to ensure map has fully rendered all markers
    setTimeout(() => {
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

      // CRITICAL: Check if we have a saved phase from previous session (higher priority)
      let finalPhase = phaseToApply;
      if (savedFabPhaseOnUnmount) {
        console.log(`🗺️ [FAB Initial] Using saved phase ${savedFabPhaseOnUnmount} from previous session`);
        finalPhase = savedFabPhaseOnUnmount;
        sessionStorage.removeItem('rxdeliver_dashboard_fab_phase');
      }

      // Apply the phase
      console.log(`🔵 [FAB Initial] Applying phase ${finalPhase}`);
      setMapViewPhase(finalPhase);
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

      // CRITICAL: Clear any existing timers first
      if (mapLockTimeoutRef.current) {
        clearTimeout(mapLockTimeoutRef.current);
        mapLockTimeoutRef.current = null;
      }
      mapLockExpiresAtRef.current = null;

      // CRITICAL: Returning from another page - delay longer before unlocking
      const wasReturning = !!savedFabPhaseOnUnmount;

      // CRITICAL: Always use 500ms for initial unlock (Phase 1 & 3)
      const lockDuration = 500;

      if (finalPhase === 1 || finalPhase === 3) {
        const expiresAt = Date.now() + lockDuration;
        mapLockExpiresAtRef.current = expiresAt;

        mapLockTimeoutRef.current = setTimeout(() => {
          if (mapLockExpiresAtRef.current === expiresAt) {
            setIsMapViewLocked(false);
            mapLockExpiresAtRef.current = null;
            mapLockTimeoutRef.current = null;
            console.log(`⏰ [FAB Initial] Phase ${finalPhase} auto-unlocked after ${lockDuration}ms`);
          }
        }, lockDuration);

        console.log(`🔵 [FAB Initial] Phase ${finalPhase} locked - will auto-unlock in ${lockDuration}ms`);
      } else if (finalPhase === 2) {
        // Phase 2 - NO timer, stays locked PERMANENTLY
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
    }, 1500); // Delay FAB activation to ensure all markers are rendered and prevent premature triggering
  }, [renderSequence.fullDeliveriesLoaded, renderSequence.fabPhaseReady, initialMapViewApplied, deliveriesWithStopOrder.length, isDriver, driverLocation, deliveriesWithStopOrder, nextStopCoordinates, deliveries.length, allDriverLocations.length, showAllDriverMarkers]);

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

  // Auto-collapse card after 2 minutes
  useEffect(() => {
    if (!selectedCardId || !cardExpandedAtRef.current) return;

    const expandedAt = cardExpandedAtRef.current;
    const twoMinutes = 120000;
    const elapsed = Date.now() - expandedAt;
    const remaining = twoMinutes - elapsed;

    if (remaining <= 0) {
      console.log('⏰ [Auto-Collapse] Card has been expanded for 2+ minutes - collapsing');
      setSelectedCardId(null);
      cardExpandedAtRef.current = null;
      return;
    }

    const timer = setTimeout(() => {
      console.log('⏰ [Auto-Collapse] 2 minutes elapsed - collapsing card');
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
        setTimeout(() => {
          const nextCard = deliveriesWithStopOrder.find((d) => d && d.isNextDelivery === true);
          if (nextCard) {
            const cardElement = document.getElementById(`stop-card-${nextCard.id}`);
            if (cardElement) {
              cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
              console.log('📍 [Smart Refresh - Dispatcher] Auto-centered to next delivery card');
            }
          }
        }, 300);
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
      const { updates } = event.detail || {};

      // CRITICAL: Only reactivate if there were actual delivery or driver changes
      if (!updates || !updates.deliveries && !updates.appUsers) {
        return;
      }

      console.log('🔄 [Smart Refresh Complete] Data updated - reactivating FAB');

      // Auto-center to next delivery card
      setTimeout(() => {
        const nextCard = deliveriesWithStopOrder.find((d) => d && d.isNextDelivery === true);
        if (nextCard) {
          const cardElement = document.getElementById(`stop-card-${nextCard.id}`);
          if (cardElement) {
            cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            console.log('📍 [Smart Refresh Complete] Auto-centered to next delivery card');
          }
        }
      }, 300);

      // CRITICAL: Reactivate FAB if on Phase 1 for 500ms (for all users, not just dispatchers)
      if (mapViewPhase === 1) {
        console.log(`🔵 [Smart Refresh Complete] Reactivating FAB Phase 1 for 500ms`);

        // Clear any existing timers
        if (mapLockTimeoutRef.current) {
          clearTimeout(mapLockTimeoutRef.current);
          mapLockTimeoutRef.current = null;
        }
        mapLockExpiresAtRef.current = null;

        // Lock and trigger map view
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
            console.log(`⏰ [Smart Refresh Complete] FAB auto-unlocked after 500ms`);
          }
        }, lockDuration);
      }
    };
    
    const handleSmartRefreshRestartedEvent = () => {
      console.log('🔄 [Smart Refresh Restarted] Reactivating FAB after import');

      // Auto-center to next delivery card
      setTimeout(() => {
        const nextCard = deliveriesWithStopOrder.find((d) => d && d.isNextDelivery === true);
        if (nextCard) {
          const cardElement = document.getElementById(`stop-card-${nextCard.id}`);
          if (cardElement) {
            cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            console.log('📍 [Smart Refresh Restarted] Auto-centered to next delivery card');
          }
        }
      }, 300);

      // CRITICAL: Reactivate FAB if on Phase 1 for 500ms
      if (mapViewPhase === 1) {
        console.log(`🔵 [Smart Refresh Restarted] Reactivating FAB Phase 1 for 500ms`);

        // Clear any existing timers
        if (mapLockTimeoutRef.current) {
          clearTimeout(mapLockTimeoutRef.current);
          mapLockTimeoutRef.current = null;
        }
        mapLockExpiresAtRef.current = null;

        // Lock and trigger map view
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
            console.log(`⏰ [Smart Refresh Restarted] FAB auto-unlocked after 500ms`);
          }
        }, lockDuration);
      }
    };

    window.addEventListener('smartRefreshComplete', handleSmartRefreshCompleteEvent);
    window.addEventListener('smartRefreshRestarted', handleSmartRefreshRestartedEvent);

    return () => {
      window.removeEventListener('smartRefreshComplete', handleSmartRefreshCompleteEvent);
      window.removeEventListener('smartRefreshRestarted', handleSmartRefreshRestartedEvent);
    };
  }, [mapViewPhase, deliveriesWithStopOrder, selectedCardId]);

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

  // REMOVED: Periodic route optimizer that was causing excessive Google Maps API hits
  // The app already has optimization built in via:
  // - RealTimeRouteOptimizer (event-based)
  // - Manual reoptimize FAB button
  // - Optimization during specific workflows (start delivery, status changes)
  // This 5-minute polling was redundant and causing rate limits

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
      const padding = getMapPadding();
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

      // STEP 2: Load based on data source preference
      const shouldLoadAllDeliveries = showAllDriverMarkers || selectedDriverId === 'all';
      let priorityDeliveries;

      if (dataSource === 'online') {
        // ONLINE MODE: Always fetch from API, skip offline DB
        console.log(`🌐 [Date Change - ONLINE MODE] Fetching from API`);
        if (shouldLoadAllDeliveries) {
          priorityDeliveries = await base44.entities.Delivery.filter({ delivery_date: dateStr });
        } else {
          priorityDeliveries = await base44.entities.Delivery.filter({ delivery_date: dateStr, driver_id: selectedDriverId });
        }
        // Update offline DB in background (don't wait)
        offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, priorityDeliveries).catch(() => {});
      } else {
        // OFFLINE MODE: Try offline DB first, fallback to API
        priorityDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, dateStr);

        if (!priorityDeliveries || priorityDeliveries.length === 0) {
          if (shouldLoadAllDeliveries) {
            console.log('📥 [Date Change] Offline DB empty - fetching ALL from API');
            priorityDeliveries = await base44.entities.Delivery.filter({ delivery_date: dateStr });
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, priorityDeliveries);
          } else {
            console.log(`📥 [Date Change] Offline DB empty - fetching driver ${selectedDriverId} from API`);
            priorityDeliveries = await base44.entities.Delivery.filter({ delivery_date: dateStr, driver_id: selectedDriverId });
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, priorityDeliveries);
          }
        } else {
          console.log(`📦 [Date Change] Using ${priorityDeliveries.length} deliveries from offline DB`);
          if (!shouldLoadAllDeliveries) {
            priorityDeliveries = priorityDeliveries.filter((d) => d.driver_id === selectedDriverId);
          }
        }
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
      // CRITICAL: NO route optimization on date change
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { deliveryDate: dateStr, triggeredBy: 'dateChange' }
      }));

      // STEP 5: Resume UI immediately (don't wait for background loads)
      setIsEntityUpdating(false);

      // CRITICAL: Force stats refresh immediately after date change
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

      // STEP 5.5: Wait for UI to fully render before triggering map
      await new Promise((resolve) => setTimeout(resolve, 300));

      // STEP 6: REMOVED - Keep selected driver when changing dates
      // Users manually select their preferred driver view, don't auto-change it

      // STEP 7: Trigger map view (non-blocking, delayed for rendering)
      setTimeout(() => {
        setIsMapViewLocked(true);
        lastProgrammaticMapMoveRef.current = Date.now();
        window._lastProgrammaticMapMove = Date.now();
        setMapViewTrigger((prev) => prev + 1);

        // CRITICAL: Auto-center to next delivery card after map triggers
        setTimeout(() => {
          const nextCard = deliveriesWithStopOrder.find((d) => d && d.isNextDelivery === true);
          if (nextCard) {
            const cardElement = document.getElementById(`stop-card-${nextCard.id}`);
            if (cardElement) {
              cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
              console.log('📍 [Date Change] Auto-centered to next delivery card');
            }
          }
        }, 300);

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

      // STEP 8: No background loads needed - we already loaded all drivers' deliveries

    } catch (error) {
      console.error('❌ [Dashboard] Date change failed:', error);
    }
  };

  const driverChangeInProgressRef = useRef(false);

  const handleDriverChange = async (driverId) => {
    // CRITICAL: Prevent overlapping driver changes
    if (driverChangeInProgressRef.current) {
      console.log('⚠️ [Driver Change] Already in progress - ignoring duplicate call');
      return;
    }

    driverChangeInProgressRef.current = true;
    hasShownSummaryRef.current.clear();

    // CRITICAL: Increment trigger IMMEDIATELY to block map effect
    const nextTrigger = mapViewTrigger + 1;
    lastAppliedTriggerRef.current = nextTrigger;

    try {
      setIsExpanded(false);
      setIsEntityUpdating(true);

      // CRITICAL: Uncheck "Show All" when switching to "All Drivers" mode to prevent duplicate markers
      if (driverId === 'all' && showAllDriverMarkers) {
        console.log('📍 [Driver Change] Switching to All Drivers - unchecking Show All to prevent duplicate markers');
        setShowAllDriverMarkers(false);
        if (currentUser?.id) {
          saveSetting(currentUser.id, 'show_all_driver_markers', false);
        }
      }

      if (currentUser?.id) {
        saveSetting(currentUser.id, 'selected_driver_id', driverId);
      }

      const dateStr = format(selectedDate, 'yyyy-MM-dd');

      // Load based on data source preference
      let freshDeliveries;
      const shouldLoadAllDeliveries = showAllDriverMarkers || driverId === 'all';

      if (dataSource === 'online') {
        // ONLINE MODE: Always fetch from API
        console.log(`🌐 [Driver Change - ONLINE MODE] Fetching from API`);
        freshDeliveries = shouldLoadAllDeliveries ?
          await base44.entities.Delivery.filter({ delivery_date: dateStr }) :
          await base44.entities.Delivery.filter({ delivery_date: dateStr, driver_id: driverId });
        // Update offline DB in background
        offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries).catch(() => {});
      } else {
        // OFFLINE MODE: Try offline DB first
        freshDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, dateStr);

        if (!freshDeliveries || freshDeliveries.length === 0) {
          console.log(`📥 [Driver Change] Offline DB empty - fetching from API`);
          freshDeliveries = shouldLoadAllDeliveries ?
          await base44.entities.Delivery.filter({ delivery_date: dateStr }) :
          await base44.entities.Delivery.filter({ delivery_date: dateStr, driver_id: driverId });
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
        } else {
          console.log(`📦 [Driver Change] Using ${freshDeliveries.length} deliveries from offline DB`);
          if (!shouldLoadAllDeliveries && driverId !== 'all') {
            freshDeliveries = freshDeliveries.filter((d) => d.driver_id === driverId);
          }
        }
      }

      if (driverId && driverId !== 'all') {
        smartRefreshManager.clearPendingUpdatesForDriver(driverId, dateStr);
      } else {
        smartRefreshManager.clearPendingUpdates();
      }

      // CRITICAL: Batch ALL state updates in a single flushSync to prevent multiple renders
      flushSync(() => {
        setSelectedDriverId(driverId);
        globalFilters.setSelectedDriverId(driverId);

        if (updateDeliveriesLocally) {
          const otherDeliveries = deliveries.filter((d) => d && d.delivery_date !== dateStr);
          const mergedDeliveries = [...otherDeliveries, ...freshDeliveries];
          updateDeliveriesLocally(mergedDeliveries, true);
        }
      });

      // CRITICAL: Wait for React to finish rendering BEFORE dispatching event or triggering map
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      // CRITICAL: NO route optimization on driver change - preserve imported stop order
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { driverId, deliveryDate: dateStr, triggeredBy: 'driverChange' }
      }));

      // CRITICAL: Force stats refresh immediately after driver change
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

      // CRITICAL: Only trigger map ONCE after all state is updated
      if (mapLockTimeoutRef.current) {
        clearTimeout(mapLockTimeoutRef.current);
        mapLockTimeoutRef.current = null;
      }
      mapLockExpiresAtRef.current = null;

      setIsMapViewLocked(true);
      lastProgrammaticMapMoveRef.current = Date.now();
      window._lastProgrammaticMapMove = Date.now();
      setMapViewTrigger(nextTrigger);

      // CRITICAL: Auto-center to next delivery card after map triggers
      setTimeout(() => {
        const nextCard = deliveriesWithStopOrder.find((d) => d && d.isNextDelivery === true);
        if (nextCard) {
          const cardElement = document.getElementById(`stop-card-${nextCard.id}`);
          if (cardElement) {
            cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            console.log('📍 [Driver Change] Auto-centered to next delivery card');
          }
        }
      }, 300);

      if (mapViewPhase === 2) {
        if (mapLockTimeoutRef.current) {
          clearTimeout(mapLockTimeoutRef.current);
          mapLockTimeoutRef.current = null;
        }
        mapLockExpiresAtRef.current = null;
      } else if (mapViewPhase === 1 || mapViewPhase === 3) {
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
    } catch (error) {
      console.error('❌ [Dashboard] Driver change failed:', error);
    } finally {
      setIsEntityUpdating(false);
      driverChangeInProgressRef.current = false;
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
      // Card is being collapsed
      setSelectedCardId(null);
      setHighlightedCardId(null);

      // Restore previous map state and reactivate FAB
      setTimeout(() => {
        if (previousMapState) {
          setShouldFitBounds(previousMapState);
          setPreviousMapState(null);
        }

        setIsMapViewLocked(true);
        setMapViewTrigger((prev) => prev + 1);

        setTimeout(() => {
          setIsMapViewLocked(false);
        }, 100);
      }, 300);

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
      // Card is being expanded

      // CRITICAL: For dispatchers clicking on non-assigned stops, collapse any expanded card first
      if (isDispatcher && currentUser?.store_ids && !currentUser.store_ids.includes(delivery.store_id)) {
        if (selectedCardId) {
          setSelectedCardId(null);
          setHighlightedCardId(null);
          cardExpandedAtRef.current = null;
        }
      }

      // Save current shouldFitBounds state (if any) to restore later
      if (shouldFitBounds) {
        setPreviousMapState(shouldFitBounds);
      }

      setSelectedCardId(delivery.id);
      setHighlightedCardId(delivery.id);
      cardExpandedAtRef.current = Date.now();

      // CRITICAL: Clear timers and unlock FAB
      if (mapLockTimeoutRef.current) {
        clearTimeout(mapLockTimeoutRef.current);
        mapLockTimeoutRef.current = null;
      }
      mapLockExpiresAtRef.current = null;
      setIsMapViewLocked(false);

      // CRITICAL: Wait for card expansion animation, then measure and center on mobile
      const centerMarkerWithPadding = () => {
        if (isMobile) {
          // Measure actual expanded height after animation completes
          setTimeout(() => {
            const container = stopCardsContainerRef.current;
            const actualHeight = container?.offsetHeight || stopCardsBaseHeight || 0;
            console.log(`🗺️ [Card Expand] Measured expanded height: ${actualHeight}px (base: ${stopCardsBaseHeight}px)`);
            
            const statsCardCurrHeight = statsCardRef.current?.offsetHeight || 75;
            const topPadding = statsCardCurrHeight + 25;
            const bottomPadding = actualHeight > 0 ? actualHeight + 10 : 25;
            
            const padding = {
              paddingTopLeft: [25, topPadding],
              paddingBottomRight: [25, bottomPadding]
            };

            // Center on marker with measured padding
            if (delivery.patient_id) {
              const patient = patients.find((p) => p.id === delivery.patient_id);
              if (patient?.latitude && patient?.longitude) {
                setShouldFitBounds({
                  bounds: [[patient.latitude, patient.longitude]],
                  options: {
                    ...padding,
                    maxZoom: 16,
                    animate: true
                  }
                });
                setMapCenter(null);
                setMapZoom(null);
                setIsMapViewLocked(true);
              }
            } else if (delivery.store_id) {
              const store = stores.find((s) => s.id === delivery.store_id);
              if (store?.latitude && store?.longitude) {
                setShouldFitBounds({
                  bounds: [[store.latitude, store.longitude]],
                  options: {
                    ...padding,
                    maxZoom: 16,
                    animate: true
                  }
                });
                setMapCenter(null);
                setMapZoom(null);
                setIsMapViewLocked(true);
              }
            }
          }, 350);
        } else {
          // Desktop: center immediately with standard padding
          const padding = getMapPadding();
          
          if (delivery.patient_id) {
            const patient = patients.find((p) => p.id === delivery.patient_id);
            if (patient?.latitude && patient?.longitude) {
              setShouldFitBounds({
                bounds: [[patient.latitude, patient.longitude]],
                options: {
                  ...padding,
                  maxZoom: 16,
                  animate: true
                }
              });
              setMapCenter(null);
              setMapZoom(null);
              setIsMapViewLocked(true);
            }
          } else if (delivery.store_id) {
            const store = stores.find((s) => s.id === delivery.store_id);
            if (store?.latitude && store?.longitude) {
              setShouldFitBounds({
                bounds: [[store.latitude, store.longitude]],
                options: {
                  ...padding,
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

      centerMarkerWithPadding();

      // CRITICAL: Auto-center card in horizontal scroll - increased delay for reliability
      setTimeout(() => {
        const cardElement = document.getElementById(`stop-card-${delivery.id}`);
        if (cardElement) {
          cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          console.log('📍 [Card Click] Auto-centered to expanded card');
        }
      }, 300);
    }
  };

  const handleSaveDelivery = async (deliveryData) => {
    // Pause ONLY smart refresh and offline sync, NOT mutations
    // Mutations are needed to save deliveries
    console.log('⏸️ [SAVE] Pausing smart refresh and offline sync...');
    setIsEntityUpdating(true);
    pauseOfflineSync();
    smartRefreshManager.pause();
    
    await new Promise((resolve) => setTimeout(resolve, 100));

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

            // CRITICAL: Generate delivery_id for new stops
            const deliveryId = stop.delivery_id || `DID-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            const payload = {
              delivery_id: deliveryId,
              dispatcher_id: currentUser?.id || null,
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

        // CRITICAL: After batch save, check if we should optimize the route
        // Optimization runs once all transitioning stops are in_transit/en_route
        try {
          console.log('🔍 [AddToRoute] Checking if route optimization should run...');

          // Get the driver from the first staged delivery
          const batchDriverId = stagedDeliveries[0]?.driver_id;
          if (batchDriverId) {
            // Fetch all deliveries for this driver on this date
            const allDriverDeliveries = await base44.entities.Delivery.filter({
              driver_id: batchDriverId,
              delivery_date: batchDeliveryDate
            });

            // Check if ALL stops are now in_transit or en_route (no pending, no en_route pickups left)
            const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
            const allActive = allDriverDeliveries.every((d) =>
            d && (d.status === 'in_transit' || d.status === 'en_route' || finishedStatuses.includes(d.status))
            );

            // Check if there are any incomplete stops
            const hasIncompleteStops = allDriverDeliveries.some((d) =>
            d && d.status !== 'pending' && !finishedStatuses.includes(d.status)
            );

            if (allActive && hasIncompleteStops) {
              console.log('✅ [AddToRoute] All stops transitioned to active - optimizing route...');

              const now = new Date();
              const localTimeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

              await base44.functions.invoke('optimizeRouteRealTime', {
                driverId: batchDriverId,
                deliveryDate: batchDeliveryDate,
                currentLocalTime: localTimeString,
                deviceTime: now.toISOString(),
                generatePolyline: true
              });

              console.log('✅ [AddToRoute] Route optimization complete');

              // Refresh to show optimized stop orders and ETAs
              invalidateDeliveriesForDate(batchDeliveryDate);
              await refreshData();
            } else {
              console.log('⏭️ [AddToRoute] Not all stops active yet - skipping optimization');
            }
          }
        } catch (optimizeError) {
          console.warn('⚠️ [AddToRoute] Route optimization failed:', optimizeError.message);
        }

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

        // CRITICAL: Generate delivery_id for new stops
        const deliveryId = stop.delivery_id || `DID-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const payload = {
          delivery_id: deliveryId,
          dispatcher_id: currentUser?.id || null,
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
      console.log('⏳ [SAVE] Waiting 1s before resuming...');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      
      console.log('▶️ [SAVE] Resuming smart refresh and offline sync');
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
      console.log('⏸️ [FAB Reoptimize] Pausing smart refresh, offline sync, and mutations');
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
        invalidateDeliveriesForDate(deliveryDate);
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
      console.log('▶️ [FAB Reoptimize] Resuming smart refresh, offline sync, and mutations');
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

  const handleCreatePatientFromDelivery = (callback, initialData = null) => {
    setEditingPatient(initialData);
    setPatientFormCallback(() => callback);
    setShowPatientForm(true);
  };

  const handleSavePatient = async (patientData, shouldReturnPatient = false) => {
    // Pause ALL update systems
    console.log('⏸️ [PATIENT SAVE] Pausing ALL update systems...');
    setIsEntityUpdating(true);
    pauseOfflineMutations();
    pauseOfflineSync();
    smartRefreshManager.pause();
    
    await new Promise((resolve) => setTimeout(resolve, 100));

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
        // CRITICAL: Merge patientData (which has location fields from PatientForm) with savedPatient (which has the ID)
        // This ensures latitude, longitude, and distance_from_store are passed back to DeliveryForm
        const completePatient = {
          ...patientData,
          ...savedPatient,
          id: savedPatient.id
        };
        console.log('📤 [Dashboard] Returning complete patient with location to DeliveryForm:', {
          id: completePatient.id,
          latitude: completePatient.latitude,
          longitude: completePatient.longitude,
          distance_from_store: completePatient.distance_from_store
        });
        patientFormCallback(completePatient);
      }

      setEditingPatient(null);
      setPatientFormCallback(null);
    } catch (error) {
      console.error('Error saving patient:', error);
      alert(`Failed to save patient: ${error.message || error}`);
      throw error;
    } finally {
      // Resume all systems
      console.log('⏳ [PATIENT SAVE] Waiting 1s before resuming...');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      
      console.log('▶️ [PATIENT SAVE] Resuming ALL update systems');
      resumeOfflineMutations();
      resumeOfflineSync();
      smartRefreshManager.resume();
      
      setIsEntityUpdating(false);
    }
  };

  const triggerPostDeleteOperations = async (driverId, deliveryDate) => {
    console.log('⚙️ [DELETE] Starting background post-delete operations...');
    try {
      setIsEntityUpdating(true);
      pauseOfflineMutations();
      pauseOfflineSync();
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Recalculate stop orders for remaining deliveries
      console.log('🔄 [DELETE] Recalculating stop orders...');
      await recalculateStopOrders(driverId, deliveryDate);
      console.log('  ✅ Stop orders recalculated');

      // Re-optimize route and update ETAs
      console.log('📡 [DELETE] Re-optimizing route and updating ETAs...');
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
        console.log('  ✅ Route optimized');

        await base44.functions.invoke('calculateRealTimeETA', {
          driverId: driverId,
          deliveryDate: deliveryDate,
          currentLocalTime: localTimeString
        });
        console.log('  ✅ ETAs updated');

      } catch (optimizeError) {
        console.warn('  ⚠️ Route optimization/ETA update failed:', optimizeError.message);
      }

      // Refresh data and update map
      console.log('🔄 [DELETE] Refreshing data and updating map...');
      invalidateDeliveriesForDate(deliveryDate);
      await refreshData();

      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { driverId, deliveryDate, triggeredBy: 'deleteDelivery' }
      }));
      console.log('  ✅ Data refreshed and map updated');
      console.log('✅ [DELETE] Background operations complete');

    } catch (error) {
      console.error('❌ [DELETE] Background operations failed:', error);
    } finally {
      console.log('▶️ [DELETE] Resuming smart refresh, offline sync, and mutations');
      resumeOfflineMutations();
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

      // CRITICAL: Delete Square COD item if delivery has COD and is in_transit
      if (targetDelivery.status === 'in_transit' && targetDelivery.cod_total_amount_required > 0 && targetDelivery.patient_id) {
        try {
          console.log('💳 [Delete] Deleting Square COD item for:', deliveryId);
          await base44.functions.invoke('squareDeleteCodItem', {
            deliveryId: deliveryId,
            reason: 'delivery_deleted'
          });
          console.log('✅ [Delete] Square COD item deleted');
        } catch (squareError) {
          console.error('⚠️ [Delete] Failed to delete Square COD item:', squareError);
        }
      }

      // CRITICAL: Use deleteDeliveryLocal which handles UI update, offline DB, and backend sync
      console.log('🗑️ [DELETE] Using deleteDeliveryLocal for complete deletion...');
      const { deleteDeliveryLocal } = await import('../components/utils/offlineMutations');

      // Initiate deletion (returns promise)
      const deletionPromise = deleteDeliveryLocal(deliveryId);
      console.log('  ✅ Delivery deletion initiated (UI will update immediately via mutations)');

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
      console.log('⏸️ [RESTART] Pausing ALL update systems...');
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
      console.log('🔄 [RESTART] Fetching fresh data...');
      invalidate('Delivery');
      const freshDeliveries = await base44.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      });
      
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
      
      // Protect from smart refresh overwrite
      freshDeliveries.forEach(d => {
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
      console.log('⏳ [RESTART] Waiting 1s before resuming...');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      
      console.log('▶️ [RESTART] Resuming ALL update systems');
      resumeOfflineMutations();
      resumeOfflineSync();
      smartRefreshManager.resume();
      
      setIsEntityUpdating(false);
    }
  };

  const handleStatusUpdate = async (deliveryId, newStatus, extraData = {}, skipAutoCenter = false) => {
    console.log('═══════════════════════════════════════════════════');
    console.log('🚀 [STATUS] Starting status update');
    console.log('   Delivery ID:', deliveryId);
    console.log('   New Status:', newStatus);
    console.log('   Extra Data:', extraData);
    console.log('═══════════════════════════════════════════════════');

    // CRITICAL: Declare these outside try block so they're accessible in finally
    let driverId = null;
    let deliveryDate = null;

    // STEP 0: Pause smart refresh and offline sync only (NOT mutations - we bypass them)
    console.log('⏸️ [STATUS] Pausing smart refresh and offline sync...');
    setIsEntityUpdating(true);
    pauseOfflineSync();
    smartRefreshManager.pause();
    
    await new Promise((resolve) => setTimeout(resolve, 100));

    // CRITICAL: Capture current FAB state
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

    // CRITICAL: Pause theme transitions during status updates to prevent UI glitches
    document.documentElement.style.setProperty('--theme-transition-duration', '0s');

    try {
      const targetDelivery = deliveriesWithStopOrder.find((d) => d && d.id === deliveryId);
      if (!targetDelivery) {
        console.error('❌ [STATUS] Delivery not found in deliveriesWithStopOrder');
        console.error('   Looking for ID:', deliveryId);
        console.error('   Available IDs:', deliveriesWithStopOrder.map(d => d?.id));
        throw new Error('Delivery not found');
      }
      
      console.log('✅ [STATUS] Found target delivery:', targetDelivery.patient_name || 'Pickup');

      // CRITICAL: Assign to outer scope variables
      driverId = targetDelivery.driver_id;
      deliveryDate = targetDelivery.delivery_date;
      
      const currentDate = format(new Date(), 'yyyy-MM-dd');
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

      const currentTime = new Date();
      let currentTimeISO = currentTime.toISOString();

      const updateData = { status: newStatus, ...extraData };

      // CRITICAL: Set delivery_time_start to current time + 5 minutes when transitioning to in_transit
      if (newStatus === 'in_transit' || newStatus === 'en_route') {
        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const startMinutes = currentMinutes + 5;
        updateData.delivery_time_start = `${String(Math.floor(startMinutes / 60) % 24).padStart(2, '0')}:${String(startMinutes % 60).padStart(2, '0')}`;
      }

      // CRITICAL: Calculate travel distance from LOCAL data (no API call)
      if (['completed', 'failed', 'cancelled'].includes(newStatus)) {
        updateData.isNextDelivery = false;

        // Get completed stops from LOCAL state
        const finishedStatuses = ['completed', 'failed', 'cancelled'];
        const completedStops = deliveriesWithStopOrder.
        filter((d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate && finishedStatuses.includes(d.status)).
        sort((a, b) => {
          if (!a.actual_delivery_time || !b.actual_delivery_time) return 0;
          return new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time);
        });

        if (completedStops.length === 0) {
          updateData.travel_dist = 0;
          console.log('📏 [Travel Dist] First completed stop - travel_dist = 0 km');
        } else {
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
            console.log(`📏 [Travel Dist] ${updateData.travel_dist} km`);
          } else {
            updateData.travel_dist = 0;
          }
        }
      }

      // CRITICAL: Time rounding for first/last stop
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
          console.log(`⏱️ [TIME ROUNDING] Applied to ${isFirstStop ? 'FIRST' : 'LAST'} stop`);
        }

        updateData.actual_delivery_time = currentTimeISO;
      } else {
        updateData.actual_delivery_time = null;
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

      console.log('📤 [STATUS] Calling updateDeliveryLocal with:', updateData);
      
      // STEP 2: Update delivery status DIRECTLY to database (bypass offline mutations)
      try {
        console.log('💾 [STATUS] Updating database directly...');
        await base44.entities.Delivery.update(deliveryId, updateData);
        console.log('✅ [STATUS] Database updated');
        
        // Update offline DB using bulkSave (save method may not exist)
        const freshDelivery = await base44.entities.Delivery.filter({ id: deliveryId });
        if (freshDelivery && freshDelivery.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [freshDelivery[0]]);
          console.log('✅ [STATUS] Offline DB updated');
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
      console.log('🖥️ [STATUS] Updating UI state directly...');
      if (updateDeliveriesLocally) {
        // CRITICAL: Just update the single delivery that changed, don't wipe and replace all deliveries
        const updatedDelivery = deliveries.find(d => d?.id === deliveryId);
        if (updatedDelivery) {
          updateDeliveriesLocally([{ ...updatedDelivery, ...updateData }], false);
          console.log('✅ [STATUS] UI state updated');
        } else {
          console.warn('⚠️ [STATUS] Delivery not found in deliveries array for UI update');
        }
      } else {
        console.warn('⚠️ [STATUS] updateDeliveriesLocally is not available');
      }
      console.log('✅ [STATUS] UI state updated directly');

      // STEP 4: Update patient's last_delivery_date (background, non-blocking)
      if (['completed', 'failed'].includes(newStatus) && targetDelivery.patient_id) {
        base44.entities.Patient.update(targetDelivery.patient_id, {
          last_delivery_date: deliveryDate
        }).catch((error) => console.warn('⚠️ Patient last_delivery_date update failed:', error));
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

      if (routeComplete && finishedStatuses.includes(newStatus) && targetDelivery.patient_id) {
        console.log('🎉 [STATUS] Route complete - showing end of day stats');
        const completedDriver = users.find((u) => u && u.id === driverId) || currentUser;
        setEndOfDayDriver(completedDriver);
        setShowEndOfDayStats(true);
        
        // CRITICAL: Re-measure stop cards height after route completion
        setTimeout(() => {
          if (horizontalStopCardsRef.current) {
            const newHeight = horizontalStopCardsRef.current.offsetHeight;
            if (newHeight > 0 && newHeight !== stopCardsBaseHeight) {
              console.log(`📏 [Route Complete] Re-measured stop cards height: ${newHeight}px (was ${stopCardsBaseHeight}px)`);
              setStopCardsBaseHeight(newHeight);
            }
          }
        }, 400);
      }

      if (routeComplete && finishedStatuses.includes(newStatus) && targetDelivery.patient_id) {
        const summaryKey = `${driverId}_${deliveryDate}`;
        if (!hasShownSummaryRef.current.has(summaryKey)) {
          setMapViewPhase(1);
          setIsMapViewLocked(true);
          lastProgrammaticMapMoveRef.current = Date.now();
          window._lastProgrammaticMapMove = Date.now();
          setMapViewTrigger((prev) => prev + 1);

          if (currentUser?.id) {
            saveSetting(currentUser.id, 'fab_map_cycle_phase', 1);
          }

          setTimeout(() => setIsMapViewLocked(false), 500);

          // Disable location tracking (background)
          if (locationTracker.isTracking) {
            locationTracker.stopTracking();
          }

          base44.entities.AppUser.filter({ user_id: currentUser.id }).then((appUsersList) => {
            const appUser = appUsersList?.[0];
            if (appUser) {
              base44.entities.AppUser.update(appUser.id, {
                driver_status: 'off_duty',
                location_tracking_enabled: false
              });
            }
          }).catch((error) => console.warn('⚠️ AppUser update failed:', error));

          const completedDriver = users.find((u) => u && u.id === driverId) || currentUser;
          setSummaryDriver(completedDriver);
          setShowRouteSummary(true);
          hasShownSummaryRef.current.add(summaryKey);
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
              console.log('📍 [STATUS] Auto-centered to next delivery card');
            }
          }
        }, 500);
      }

      // STEP 7: Re-lock FAB if needed (instant)
      if (currentPhase === 2) {
        setIsMapViewLocked(true);
        lastProgrammaticMapMoveRef.current = Date.now();
        window._lastProgrammaticMapMove = Date.now();
        setMapViewTrigger((prev) => prev + 1);

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
      console.log('🔄 [STATUS] Starting background sync tasks...');

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
      console.log('🔄 [STATUS] Fetching fresh data...');
      const freshDeliveries = await base44.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      });
      
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
      console.log('   ✅ Saved fresh deliveries to offline DB');

      // Protect deliveries from smart refresh overwrite
      freshDeliveries.forEach(d => {
        if (d?.id) {
          smartRefreshManager.registerPendingUpdate(d.id, driverId, deliveryDate);
        }
      });
      console.log('   ✅ Protected deliveries from smart refresh');

      // STEP 10: Background tasks (non-blocking, run after UI updates)
      if (driverId && deliveryDate) {
        console.log('🔄 [STATUS] Starting background tasks...');
        
        // Background: Recalculate stop orders (don't await)
        recalculateStopOrders(driverId, deliveryDate).catch((error) =>
          console.warn('⚠️ Stop order recalc failed:', error)
        );

        // Background: Update ETAs (mobile drivers only, don't await)
        if (isMobile && userHasRole(currentUser, 'driver') && ['completed', 'failed', 'cancelled'].includes(newStatus)) {
          const now = new Date();
          const localTimeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

          base44.functions.invoke('calculateRealTimeETA', {
            driverId: driverId,
            deliveryDate: deliveryDate,
            currentLocalTime: localTimeString
          }).catch((error) => console.warn('⚠️ ETA update failed:', error));
        }

        console.log('✅ [STATUS] Background tasks started');
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
      // CRITICAL: Resume immediately after database update
      console.log('▶️ [STATUS] Resuming update systems');
      resumeOfflineSync();
      smartRefreshManager.resume();
      setIsEntityUpdating(false);
      
      // CRITICAL: Re-enable theme transitions
      document.documentElement.style.setProperty('--theme-transition-duration', '0.3s');
      console.log('✅ [STATUS] Status update complete - all systems resumed');
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
    console.log('═══════════════════════════════════════════════════');
    console.log('💳 [COD Update] Starting');
    console.log('   Delivery ID:', deliveryId);
    console.log('   Payments:', codPayments);
    console.log('═══════════════════════════════════════════════════');
    
    // CRITICAL: Pause smart refresh to prevent overwrite
    console.log('⏸️ [COD] Pausing smart refresh...');
    setIsEntityUpdating(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    try {
      const delivery = deliveriesWithStopOrder.find((d) => d?.id === deliveryId);
      if (!delivery) {
        console.error('❌ [COD] Delivery not found in deliveriesWithStopOrder');
        throw new Error('Delivery not found');
      }
      
      console.log('✅ [COD] Found delivery:', delivery.patient_name || 'Pickup');
      
      // CRITICAL: Only update cod_payments array - don't touch cod_total_amount_required
      const updateData = {
        cod_payments: codPayments
      };
      
      console.log('📤 [COD] Update payload:', JSON.stringify(updateData, null, 2));
      
      // CRITICAL: Use offline-first mutation system
      console.log('💾 [COD] Updating via offline mutation system...');
      await updateDeliveryLocal(deliveryId, updateData, { skipSmartRefresh: true });
      console.log('✅ [COD] Offline mutation complete');
      
      // CRITICAL: Update UI state immediately with the changes
      if (updateDeliveriesLocally) {
        const updatedDelivery = { ...delivery, ...updateData };
        updateDeliveriesLocally([updatedDelivery], false);
        console.log('✅ [COD] UI state updated');
      }
      
      // Protect from smart refresh overwrite
      smartRefreshManager.registerPendingUpdate(deliveryId, delivery.driver_id, delivery.delivery_date);
      console.log('✅ [COD] Protected from smart refresh');
      
      console.log('✅ [COD Update] Complete');
      
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
      console.log('⏳ [COD] Waiting 2s before resuming...');
      await new Promise((resolve) => setTimeout(resolve, 2000));
      console.log('▶️ [COD] Resuming smart refresh');
      setIsEntityUpdating(false);
    }
  };

  const handleCreateReturn = async ({ originalDelivery, returnPatient, store }) => {
    try {
      // Pause ALL update systems
      console.log('⏸️ [RETURN] Pausing ALL update systems...');
      setIsEntityUpdating(true);
      pauseOfflineMutations();
      pauseOfflineSync();
      smartRefreshManager.pause();
      
      await new Promise((resolve) => setTimeout(resolve, 100));

      const currentDate = format(new Date(), 'yyyy-MM-dd');

      // CRITICAL: Find the patient from the failed delivery
      const failedPatient = patients.find((p) => p?.id === originalDelivery.patient_id);

      // CRITICAL: Generate unique SID
      const existingDeliveriesForDate = deliveries.filter((d) => d && d.delivery_date === currentDate);
      const newSID = generateUniqueSID(existingDeliveriesForDate);

      // CRITICAL: Use PUID from failed delivery to determine correct store and AM/PM
      const puid = originalDelivery.puid;
      let finalStoreId = originalDelivery.store_id;
      let finalAmpm = originalDelivery.ampm_deliveries;

      // If PUID exists, find parent pickup to get correct store/AM-PM
      if (puid) {
        const parentPickup = deliveries.find((d) => d && !d.patient_id && d.stop_id === puid);
        if (parentPickup) {
          finalStoreId = parentPickup.store_id || originalDelivery.store_id;
          finalAmpm = parentPickup.ampm_deliveries || originalDelivery.ampm_deliveries;
        }
      }

      // CRITICAL: Get store abbreviation for TR#
      const returnStore = stores.find((s) => s?.id === finalStoreId);
      const storeAbbr = returnStore?.abbreviation || 'XX';

      // CRITICAL: Generate TR# using same range as failed delivery (store abbr + failed delivery's TR number)
      const failedTR = parseInt(originalDelivery.tracking_number, 10);
      const newTR = isNaN(failedTR) ? `${storeAbbr}99` : `${storeAbbr}${failedTR}`;

      // CRITICAL: Format driver notes with each item on separate lines
      const driverNotes = `From: ${originalDelivery.delivery_date}\nFor: ${failedPatient?.full_name || originalDelivery.patient_name || 'Unknown'}`;

      const returnDeliveryData = {
        patient_id: returnPatient.id,
        store_id: finalStoreId,
        driver_id: originalDelivery.driver_id,
        driver_name: originalDelivery.driver_name,
        delivery_date: currentDate,
        delivery_time_start: originalDelivery.delivery_time_start,
        delivery_time_end: originalDelivery.delivery_time_end,
        status: 'in_transit',
        delivery_notes: driverNotes,
        patient_name: returnPatient.full_name,
        patient_phone: returnPatient.phone || store?.phone || '',
        store_phone: store?.phone || '',
        stop_id: newSID,
        puid: puid,
        tracking_number: newTR,
        ampm_deliveries: finalAmpm
      };

      // Create the return delivery for today
      await createDeliveryLocal(returnDeliveryData);

      // Send notification: Driver initiated return
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

      // Fetch fresh data and save to offline DB
      console.log('🔄 [RETURN] Fetching fresh data...');
      invalidateDeliveriesForDate(originalDelivery.delivery_date);
      invalidateDeliveriesForDate(currentDate);
      invalidate('Delivery');
      
      const freshDeliveries = await base44.entities.Delivery.filter({
        driver_id: originalDelivery.driver_id,
        delivery_date: currentDate
      });
      
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
      
      // Protect from smart refresh overwrite
      freshDeliveries.forEach(d => {
        if (d?.id) {
          smartRefreshManager.registerPendingUpdate(d.id, originalDelivery.driver_id, currentDate);
        }
      });

      await refreshData();

    } catch (error) {
      console.error('❌ [CREATE RETURN] Error:', error);
      throw error;
    } finally {
      // Resume all systems
      console.log('⏳ [RETURN] Waiting 1s before resuming...');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      
      console.log('▶️ [RETURN] Resuming ALL update systems');
      resumeOfflineMutations();
      resumeOfflineSync();
      smartRefreshManager.resume();
      
      setIsEntityUpdating(false);
    }
  };

  const handleStartDelivery = async (deliveryId) => {
    console.log('═══════════════════════════════════════════════════');
    console.log('🚀 [START] ========== STARTING DELIVERY ==========');
    console.log('═══════════════════════════════════════════════════');

    // STEP 0: Pause ALL updates - smart refresh, mutations, offline sync
    console.log('⏸️ [START] Step 0: Pausing ALL update systems...');
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

      console.log(`📦 [START] Delivery: ${deliveryFromUI.patient_name || 'Pickup'} (${deliveryId})`);
      console.log(`   Driver: ${driverId}, Date: ${deliveryDate}, New Status: ${newStatus}`);

      // STEP 1: Clear ALL isNextDelivery flags for this driver/date
      console.log('🔄 [START] Step 1: Clearing all isNextDelivery flags...');
      const allDriverDeliveries = await base44.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      });

      const resetPromises = allDriverDeliveries.
      filter((d) => d.isNextDelivery).
      map((d) => base44.entities.Delivery.update(d.id, { isNextDelivery: false }));

      if (resetPromises.length > 0) {
        await Promise.all(resetPromises);
        console.log(`   ✅ Cleared ${resetPromises.length} isNextDelivery flags`);
      }

      // STEP 2: Set isNextDelivery=true on the selected delivery and update status
      console.log('🎯 [START] Step 2: Setting isNextDelivery=true on selected delivery...');

      // CRITICAL: Calculate stop_order FIRST - this delivery becomes the next after completed stops
      const finishedStatusesStep2 = ['completed', 'failed', 'cancelled', 'returned'];
      const completedStopsStep2 = allDriverDeliveries.filter((d) => finishedStatusesStep2.includes(d.status));
      const nextStopOrderStep2 = completedStopsStep2.length + 1;

      await base44.entities.Delivery.update(deliveryId, {
        isNextDelivery: true,
        status: newStatus,
        stop_order: nextStopOrderStep2
      });
      console.log(`   ✅ isNextDelivery flag set, status updated, and stop_order set to ${nextStopOrderStep2}`);

      // STEP 3: Re-fetch deliveries to ensure we have the latest data with updated isNextDelivery flag
      console.log('📊 [START] Step 3: Re-fetching deliveries to verify isNextDelivery persisted...');
      const refreshedDeliveriesAfterFlag = await base44.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      });

      // Verify the flag is still set
      const verifyNext = refreshedDeliveriesAfterFlag.find((d) => d.id === deliveryId);
      if (!verifyNext?.isNextDelivery) {
        console.error('❌ [START] isNextDelivery flag was lost! Re-applying...');
        await base44.entities.Delivery.update(deliveryId, { isNextDelivery: true });
      } else {
        console.log(`   ✅ Verified isNextDelivery=true on ${deliveryId}`);
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
      console.log(`   ✅ Updated stop_order for ${sortedIncomplete.length} incomplete stops`);

      // STEP 4: Optimize remaining stops AFTER starting this delivery
      console.log('🔄 [START] Step 4: Optimizing remaining stops...');
      try {
        const now = new Date();
        const localTimeString = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        await base44.functions.invoke('optimizeRemainingStops', {
          driverId: driverId,
          deliveryDate: deliveryDate,
          currentLocalTime: localTimeString,
          deviceTime: now.toISOString()
        });
        console.log('   ✅ Remaining stops optimized');
      } catch (optimizeError) {
        console.warn('   ⚠️ Route optimization failed:', optimizeError.message);
      }

      // STEP 5: Update UI immediately after optimization
      console.log('🖥️ [START] Step 5: Updating UI immediately...');
      invalidateDeliveriesForDate(deliveryDate);
      const refreshedDeliveries = await base44.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      });

      // CRITICAL: Find which delivery is NOW marked as next (should be the one we just started)
      const newNextDelivery = refreshedDeliveries.find((d) => d.isNextDelivery === true);
      newNextDeliveryId = newNextDelivery?.id || deliveryId; // Use the refreshed next delivery ID

      console.log(`   🎯 Original clicked ID: ${originalClickedId}`);
      console.log(`   ✨ NEW next delivery ID: ${newNextDeliveryId}`);

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
      console.log(`   ✅ UI updated - new next delivery is: ${newNextDeliveryId}`);

      // STEP 6: Clear and recalculate blue polyline
      console.log('🔵 [START] Step 7: Updating blue polyline...');
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

      // STEP 8: Update this delivery's ETA to current time + 5 minutes
      console.log('⏱️ [START] Step 8: Setting delivery ETA...');
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const etaMinutes = currentMinutes + 5;
      const etaString = `${String(Math.floor(etaMinutes / 60) % 24).padStart(2, '0')}:${String(etaMinutes % 60).padStart(2, '0')}`;

      await base44.entities.Delivery.update(deliveryId, {
        delivery_time_start: etaString,
        delivery_time_eta: etaString
      });
      console.log(`   ✅ ETA set to ${etaString}`);

      console.log('═══════════════════════════════════════════════════');
      console.log('✅ [START] ========== START DELIVERY COMPLETE ==========');
      console.log('═══════════════════════════════════════════════════');

      // STEP 10: Wait for UI to update, then scroll to next delivery card
      console.log('📍 [START] Step 10: Scrolling to next card after optimization...');

      // Wait for optimization to complete and UI to update
      setTimeout(async () => {
        const nextCard = deliveriesWithStopOrder.find((d) => d && d.isNextDelivery === true);
        if (nextCard) {
          const cardElement = document.getElementById(`stop-card-${nextCard.id}`);
          if (cardElement) {
            cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            console.log('   ✅ Scrolled to next delivery card');
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
      // STEP 9: Fetch fresh data and save to offline DB BEFORE resuming
      console.log('🔄 [START] Step 9: Fetching fresh data and saving to offline DB...');
      try {
        const finalRefreshedDeliveries = await base44.entities.Delivery.filter({
          driver_id: deliveriesWithStopOrder.find(d => d?.id === deliveryId)?.driver_id,
          delivery_date: deliveriesWithStopOrder.find(d => d?.id === deliveryId)?.delivery_date
        });

        // Save to offline DB
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, finalRefreshedDeliveries);
        console.log('   ✅ Saved fresh deliveries to offline DB');

        // Protect from smart refresh overwrite
        finalRefreshedDeliveries.forEach(d => {
          if (d?.id) {
            smartRefreshManager.registerPendingUpdate(
              d.id, 
              d.driver_id, 
              d.delivery_date
            );
          }
        });
        console.log('   ✅ Protected deliveries from smart refresh');

        // Update UI incrementally to avoid clearing screen
        if (updateDeliveriesLocally) {
          updateDeliveriesLocally(finalRefreshedDeliveries, false);
        }
        console.log('   ✅ UI updated incrementally');

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
      console.log('⏳ [START] Waiting 5s before resuming update systems...');
      await new Promise((resolve) => setTimeout(resolve, 5000));
      
      // Resume all systems
      console.log('▶️ [START] Resuming ALL update systems');
      resumeOfflineMutations();
      resumeOfflineSync();
      smartRefreshManager.resume();
      
      setIsEntityUpdating(false);
      console.log('✅ [START] All systems resumed');
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

  // Listen for data source changes and reload deliveries for ALL drivers
  useEffect(() => {
    const handleDataSourceChange = async (event) => {
      const { source } = event.detail || {};
      console.log(`🔄 [Dashboard] Data source changed to: ${source}`);
      
      setIsEntityUpdating(true);
      
      try {
        const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
        let freshDeliveries = [];
        
        if (source === 'online') {
          console.log(`🌐 [Data Source Change - ONLINE] Fetching ALL drivers for ${selectedDateStr}`);
          freshDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
          // Update offline DB in background
          offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries).catch(() => {});
        } else {
          console.log(`📦 [Data Source Change - OFFLINE] Loading ALL drivers for ${selectedDateStr}`);
          freshDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
          
          if (!freshDeliveries || freshDeliveries.length === 0) {
            console.log('📥 [Data Source Change] Offline DB empty - fetching from API as fallback');
            freshDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
          } else {
            console.log(`✅ [Data Source Change - OFFLINE] Loaded ${freshDeliveries.length} from offline DB`);
          }
        }
        
        // Update context with fresh data
        console.log(`📋 [Data Source Change] Updating dashboard UI with ${freshDeliveries.length} deliveries`);
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

  // CRITICAL: Load deliveries based on data source preference
  // DISABLED: This was causing duplicate API calls on mount
  // The periodic refresh (line 1957) handles loading deliveries every 15s
  // The render sequence effect handles initial sync if needed
  const hasLoadedOnMountRef = useRef(false);
  
  useEffect(() => {
    if (!currentUser || !isDataLoaded || !isFiltersReady) return;
    if (hasLoadedOnMountRef.current) return; // Only run once
    
    hasLoadedOnMountRef.current = true;
    
    const loadDeliveriesOnMount = async () => {
      console.log(`📦 [Dashboard Mount] Loading deliveries for ${selectedDateStr} (mode: ${dataSource})`);
      
      try {
        let mountDeliveries;
        
        // CRITICAL: Always try offline DB first to avoid rate limits
        mountDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
        
        if (mountDeliveries && mountDeliveries.length > 0) {
          console.log(`✅ [Dashboard Mount] Loaded ${mountDeliveries.length} deliveries from offline DB`);
          
          // Update context immediately
          if (updateDeliveriesLocally) {
            const otherDateDeliveries = deliveries.filter((d) => d && d.delivery_date !== selectedDateStr);
            updateDeliveriesLocally([...otherDateDeliveries, ...mountDeliveries], true);
          }
          setForceRender((prev) => prev + 1);
          return; // Skip API fetch
        }
        
        // Offline DB empty - fetch from API ONLY if in online mode
        if (dataSource === 'online') {
          console.log('🌐 [Dashboard Mount - ONLINE MODE] Fetching from API');
          mountDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, mountDeliveries);
          
          if (mountDeliveries.length > 0 && updateDeliveriesLocally) {
            const otherDateDeliveries = deliveries.filter((d) => d && d.delivery_date !== selectedDateStr);
            updateDeliveriesLocally([...otherDateDeliveries, ...mountDeliveries], true);
            setForceRender((prev) => prev + 1);
          }
        } else {
          console.log('📦 [Dashboard Mount] Offline DB empty - waiting for periodic refresh');
        }
      } catch (error) {
        // CRITICAL: Silently fail on rate limits - periodic refresh will handle it
        if (error.response?.status === 429 || error.message?.includes('429') || error.message?.includes('Rate limit')) {
          console.log('⏰ [Dashboard Mount] Rate limited - waiting for periodic refresh');
          return;
        }
        console.warn('⚠️ [Dashboard Mount] Failed to load deliveries:', error.message);
      }
    };

    loadDeliveriesOnMount();
  }, [currentUser?.id, isDataLoaded, isFiltersReady, selectedDateStr, dataSource]);

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

  // Handle snapshot selection
  const handleSnapshotSelect = (snapshot) => {
    if (!snapshot) return;
    
    setSnapshotData({
      deliveries: snapshot.snapshot_data?.deliveries || [],
      driverLocations: snapshot.snapshot_data?.driverLocations || []
    });
  };

  // Pull-to-sync handler - mobile only
  const handlePullToSync = async () => {
    console.log('🔄 [Pull-to-Sync] Starting sync process...');
    
    const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
    const selectedCityId = globalFilters.getSelectedCityId();
    
    try {
      // STEP 1: Purge deliveries for selected date and city from offline DB
      console.log(`🗑️ [Pull-to-Sync] Purging deliveries for ${selectedDateStr} in city ${selectedCityId}...`);
      
      // Get all deliveries for this date
      const allDateDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
      
      // Filter to only delete deliveries in the selected city
      const cityStoreIds = stores
        .filter(s => s?.city_id === selectedCityId)
        .map(s => s.id);
      
      const deliveriesToDelete = allDateDeliveries.filter(d => 
        d && cityStoreIds.includes(d.store_id)
      );
      
      // Delete from offline DB
      for (const delivery of deliveriesToDelete) {
        await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, delivery.id);
      }
      console.log(`✅ [Pull-to-Sync] Deleted ${deliveriesToDelete.length} deliveries from offline DB`);
      
      // STEP 2: Resync all deliveries for all drivers for selected date and city
      console.log(`📥 [Pull-to-Sync] Fetching fresh deliveries from backend...`);
      const freshDeliveries = await base44.entities.Delivery.filter({ 
        delivery_date: selectedDateStr,
        store_id: { $in: cityStoreIds }
      });
      console.log(`✅ [Pull-to-Sync] Fetched ${freshDeliveries.length} deliveries from backend`);
      
      // Save to offline DB
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
      console.log(`✅ [Pull-to-Sync] Saved deliveries to offline DB`);
      
      // STEP 3: Resync patients related to these deliveries
      const patientIds = [...new Set(freshDeliveries
        .filter(d => d?.patient_id)
        .map(d => d.patient_id)
      )];
      
      if (patientIds.length > 0) {
        console.log(`📥 [Pull-to-Sync] Fetching ${patientIds.length} patients...`);
        const freshPatients = await base44.entities.Patient.filter({
          id: { $in: patientIds }
        });
        
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, freshPatients);
        console.log(`✅ [Pull-to-Sync] Synced ${freshPatients.length} patients`);
      }
      
      // STEP 4: Update UI with fresh data from offline DB
      console.log(`🖥️ [Pull-to-Sync] Updating UI...`);
      
      // Reload from offline DB to ensure consistency
      const finalDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
      
      // Update context based on current selection mode
      if (updateDeliveriesLocally) {
        const otherDateDeliveries = deliveries.filter(d => d?.delivery_date !== selectedDateStr);
        const mergedDeliveries = [...otherDateDeliveries, ...finalDeliveries];
        updateDeliveriesLocally(mergedDeliveries, true);
      }
      
      // STEP 5: Force refresh ALL AppUsers to update driver locations and markers
      console.log(`📍 [Pull-to-Sync] Refreshing driver locations...`);
      const locationUpdates = await smartRefreshManager.refreshDriverLocations(appUsers, true, 'Dashboard', selectedDate, true);
      const latestAppUsers = locationUpdates?.appUsers || appUsers;
      
      // Sync AppUsers to offline DB
      if (latestAppUsers && latestAppUsers.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, latestAppUsers);
      }
      
      // STEP 6: Update map markers for all modes
      console.log(`🗺️ [Pull-to-Sync] Updating map markers...`);
      
      // Dispatch location updates
      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
        detail: { appUsers: latestAppUsers, forceAll: true }
      }));
      
      // Dispatch deliveries update
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { 
          deliveryDate: selectedDateStr, 
          triggeredBy: 'pullToSync',
          allDrivers: true 
        }
      }));
      
      // STEP 7: Reactivate FAB Phase 1 briefly
      setIsMapViewLocked(true);
      lastProgrammaticMapMoveRef.current = Date.now();
      window._lastProgrammaticMapMove = Date.now();
      setMapViewTrigger((prev) => prev + 1);
      
      setTimeout(() => setIsMapViewLocked(false), 500);
      
      console.log(`✅ [Pull-to-Sync] Sync complete!`);
      
      // Show success toast
      toast.success('Data synced', {
        description: `${freshDeliveries.length} deliveries updated`
      });
      
    } catch (error) {
      console.error('❌ [Pull-to-Sync] Sync failed:', error);
      toast.error('Sync failed', {
        description: error.message
      });
    }
  };

  return (
    <PullToSync onSync={handlePullToSync} isActive={isMobile}>
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
              }}
            />
          </div>
        }


      <div className={statsCardPositioning} style={{ zIndex: 600 }}>
        <div className="flex flex-col items-center gap-1 min-w-[340px] max-w-[345px]"

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
            }} className="px-2 py-0.5 rounded-2xl shadow-xl border min-w-[340px] max-w-[345px] cursor-pointer" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', pointerEvents: 'auto', touchAction: 'manipulation', position: 'relative' }}>


            

            <div className="mt-1 mb-2 flex items-center justify-between">
              <div className="pr-1 flex items-center gap-2">
                <h2 className="pl-2 text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>Dashboard</h2>
                {currentUser &&
                <div className="flex items-center gap-1.5">
                  <SmartRefreshIndicator
                    inline={true}
                    onManualRefresh={async () => {
                      console.clear();
                      const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');

                      // CRITICAL: ALWAYS fetch ALL drivers to ensure complete marker updates
                      const shouldFetchAllDrivers = true; // Always true for complete marker data

                      console.log(`🔄 [Manual Refresh] Mode: ALL DRIVERS (always), showAllDriverMarkers: ${showAllDriverMarkers}`);

                      const now = new Date();
                      const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

                      // STEP 1: Smart refresh cycle
                      const currentData = { deliveries, patients, appUsers, stores };
                      const filters = {
                        selectedDate,
                        deliveryFilter: shouldFetchAllDrivers ? {} : { driver_id: activeDriverId },
                        patientFilter: {},
                        activeDriverIds: shouldFetchAllDrivers ? [] : [activeDriverId]
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

                      const updates = await smartRefreshManager.performSmartRefresh(currentData, filters, false, showAllDriverMarkers, 'Dashboard', selectedDate);

                      // STEP 2: Force reload deliveries for ALL drivers - ensures complete marker data
                      console.log(`📥 [Manual Refresh] Fetching ALL drivers for ${selectedDateStr} (mode: ${dataSource})...`);
                      invalidateDeliveriesForDate(selectedDateStr);
                      
                      let finalDeliveries;
                      if (dataSource === 'online') {
                        console.log('🌐 [Manual Refresh - ONLINE MODE] Fetching ALL from API');
                        finalDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
                        offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, finalDeliveries).catch(() => {});
                      } else {
                        finalDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
                        if (!finalDeliveries || finalDeliveries.length === 0) {
                          console.log('📥 [Manual Refresh] Offline DB empty - fetching ALL from API');
                          finalDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
                          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, finalDeliveries);
                        }
                      }
                      
                      console.log(`✅ [Manual Refresh] Loaded ${finalDeliveries.length} deliveries for ${selectedDateStr}`);

                      // STEP 2.5: Force fresh AppUsers from backend
                      console.log('📍 [Refresh Spinner] Loading fresh AppUsers from backend...');
                      const freshAppUsers = await base44.entities.AppUser.list();
                      await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, freshAppUsers);
                      console.log(`   ✅ Loaded ${freshAppUsers.length} fresh AppUsers from backend`);

                      // CRITICAL: Process updated locations through poller to update markers immediately
                      driverLocationPoller.processLocationData(currentUser, finalDeliveries, drivers, stores, freshAppUsers, selectedDate, true);

                      // STEP 3: Route optimization removed from manual refresh
                      // Optimization now only runs on 5-minute timer when driver moves 100m+
                      console.log('⏭️ [Refresh Spinner] Skipping route optimization (runs on timer only)');

                      // STEP 4: Update isNextDelivery flags for active driver only
                      const activeDriverId = selectedDriverId === 'all' ? currentUser?.id : selectedDriverId;
                      const updatedDeliveries = activeDriverId ? 
                        finalDeliveries.filter((d) => d.driver_id === activeDriverId) : 
                        [];

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

                      // STEP 5: Update UI state with ALL deliveries
                      if (updateDeliveriesLocally) {
                        const otherDateDeliveries = deliveries.filter((d) => d && d.delivery_date !== selectedDateStr);
                        const mergedDeliveries = [...otherDateDeliveries, ...finalDeliveries];
                        updateDeliveriesLocally(mergedDeliveries, true);
                      }

                      // CRITICAL: Update offline database with fresh deliveries
                      try {
                        const { offlineDB } = await import('../components/utils/offlineDatabase');
                        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, finalDeliveries);
                        console.log('✅ [Refresh] Updated offline database with fresh deliveries');
                      } catch (dbError) {
                        console.warn('⚠️ [Refresh] Failed to update offline database:', dbError);
                      }

                      // Apply any smart refresh updates (handled by context)
                       if (updates) {
                         console.log('✅ [Manual Refresh] Smart refresh updates received');
                       }

                      // CRITICAL: Dispatch event to update driver location markers for ALL drivers
                      console.log('📍 [Refresh Spinner] Dispatching driverLocationsUpdated event for ALL drivers...');
                      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
                        detail: { appUsers: freshAppUsers, forceAll: true }
                      }));

                      // CRITICAL: Force deliveries update event to refresh map markers
                      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
                        detail: { deliveryDate: selectedDateStr, triggeredBy: 'manualRefresh' }
                      }));

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
                      } else {
                        // CRITICAL: For Phase 1 - trigger re-render to show all new markers
                        setIsMapViewLocked(true);
                        lastProgrammaticMapMoveRef.current = Date.now();
                        window._lastProgrammaticMapMove = Date.now();
                        setMapViewTrigger((prev) => prev + 1);

                        // Auto-unlock after 500ms
                        setTimeout(() => setIsMapViewLocked(false), 500);
                      }

                    }} />
                  
                  {/* Connection Quality Indicator - App Owner Only */}
                  {isAppOwner(currentUser) && <ConnectionIndicator />}
                  
                  {/* Error Flag Indicator - App Owner Only */}
                  {isAppOwner(currentUser) && <ErrorFlagIndicator />}
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
              <DualStatsMarquee
                deliveryStats={deliveryStats}
                localStats={stats}
                isDispatcher={isDispatcher}
                isDriver={isDriver}
                performanceStats={performanceStats}
                liveDistance={liveDistance}
                liveTimeOnDuty={liveTimeOnDuty} />


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
                  <div className="mt-2 pt-2 pb-2 border-t flex items-center gap-2" style={{ borderColor: 'var(--border-slate-200)' }}>
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
                    {isDriver && !isAllDriversMode &&
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                        <Checkbox
                      id="show-all-drivers"
                      checked={showAllDriverMarkers}
                      onCheckedChange={async (checked) => {
                        setShowAllDriverMarkers(checked);
                        if (currentUser?.id) {
                          saveSetting(currentUser.id, 'show_all_driver_markers', checked);
                        }

                        // CRITICAL: Close stats card when checkbox is toggled
                        setIsExpanded(false);

                        // CRITICAL: Respect data source preference when checking "Show All"
                        if (checked) {
                          console.log(`📥 [Show All] Loading deliveries (mode: ${dataSource})...`);
                          setIsEntityUpdating(true);

                          try {
                            const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
                            let allDateDeliveries;
                            
                            if (dataSource === 'online') {
                              console.log('🌐 [Show All - ONLINE MODE] Fetching from API');
                              allDateDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
                              offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allDateDeliveries).catch(() => {});
                            } else {
                              allDateDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
                              
                              if (!allDateDeliveries || allDateDeliveries.length === 0) {
                                console.log('📥 [Show All] Offline DB empty - fetching from API');
                                allDateDeliveries = await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
                                await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, allDateDeliveries);
                              } else {
                                console.log(`📦 [Show All] Using ${allDateDeliveries.length} from offline DB`);
                              }
                            }

                            console.log(`✅ [Show All] Loaded ${allDateDeliveries.length} total deliveries`);

                            // Update context with full deliveries
                            if (updateDeliveriesLocally) {
                              const otherDateDeliveries = deliveries.filter((d) => d && d.delivery_date !== selectedDateStr);
                              const mergedDeliveries = [...otherDateDeliveries, ...allDateDeliveries];
                              updateDeliveriesLocally(mergedDeliveries, true);
                            }

                            // Wait for UI to update
                            await new Promise((resolve) => setTimeout(resolve, 300));

                            // CRITICAL: Force refresh driver locations to update all markers
                            console.log('📍 [Show All] Forcing driver location refresh to update markers...');
                            const locationUpdates = await smartRefreshManager.refreshDriverLocations(appUsers, true);
                            if (locationUpdates?.hasChanges) {
                              console.log('✅ [Show All] Driver locations refreshed');

                              // Process through poller to update markers
                              driverLocationPoller.processLocationData(currentUser, allDateDeliveries, drivers, stores, locationUpdates.appUsers, selectedDate);
                            }

                            // CRITICAL: Force refresh ALL AppUsers when Show All is checked
                            console.log('📍 [Show All Checked] Force refreshing ALL driver locations...');
                            const showAllLocationUpdates = await smartRefreshManager.refreshDriverLocations(appUsers, true, 'Dashboard', selectedDate);
                            const showAllLatestAppUsers = showAllLocationUpdates?.appUsers || appUsers;
                            
                            // Dispatch event to force map to re-render with new markers
                            window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
                              detail: { appUsers: showAllLatestAppUsers, forceAll: true }
                            }));
                          } catch (error) {
                            console.error('❌ [Show All] Failed to load deliveries:', error);
                          } finally {
                            setIsEntityUpdating(false);
                          }
                        }

                        // CRITICAL: Activate Phase 1 immediately when checkbox is toggled
                        console.log('🗺️ [Show All Checkbox] Activating Phase 1');
                        
                        // Clear any existing timers
                        if (mapLockTimeoutRef.current) {
                          clearTimeout(mapLockTimeoutRef.current);
                          mapLockTimeoutRef.current = null;
                        }
                        mapLockExpiresAtRef.current = null;

                        // Set to Phase 1 and lock
                        setMapViewPhase(1);
                        setIsMapViewLocked(true);
                        lastProgrammaticMapMoveRef.current = Date.now();
                        window._lastProgrammaticMapMove = Date.now();

                        // Trigger immediately
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
                            console.log('⏰ [Show All Checkbox] Phase 1 auto-unlocked after 500ms');
                          }
                        }, lockDuration);
                      }}
                      className="h-4 w-4" />

                        <label
                      htmlFor="show-all-drivers"
                      className="text-[10px] leading-tight cursor-pointer"
                      style={{ color: 'var(--text-slate-600)' }}>

                          Show<br />All
                        </label>
                      </div>
                  }

                    <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowOptimizationSettings(true)}
                    className="h-8 w-8 p-0 flex-shrink-0"
                    title="Route Optimization Settings"
                    style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                      <Settings className="w-3.5 h-3.5" />
                    </Button>

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
                      
                      {/* Quick Route Adjustments */}
                      {isDriver && selectedDriverId === currentUser?.id &&
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowQuickAdjustments(true)}
                      className="h-8 gap-1.5 px-2 flex-shrink-0"
                      title="Quick route adjustments"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                          <span className="text-xs">Adjust</span>
                        </Button>
                    }
                      
                      {/* AI Smart Prioritization */}
                      {isDriver && selectedDriverId === currentUser?.id &&
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowSmartPrioritization(true)}
                      className="h-8 gap-1.5 px-2 flex-shrink-0"
                      title="AI delivery prioritization"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                          <Sparkles className="w-3 h-3" />
                          <span className="text-xs">AI</span>
                        </Button>
                    }
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
          <div className="backdrop-blur-sm rounded-lg shadow-lg border px-1 py-1" style={{ background: 'var(--bg-white)', opacity: 0.95, borderColor: 'var(--border-slate-200)' }}
          onMouseEnter={() => handleCardInteraction(true)}
          onMouseLeave={() => handleCardInteraction(false)}>
              <div className="flex flex-wrap gap-x-1 gap-y-1 items-center justify-center">
                {[...driverRoutes].sort((a, b) => (a.driverName || '').localeCompare(b.driverName || '')).map((route) => {
                  // CRITICAL: Use route color and driver name already calculated in DeliveryMap
                  const displayName = route.driverName || 'Unknown';
                  const routeColor = route.color;

                  return (
                    <div
                      key={route.driverId}
                      className="flex items-center gap-1.5">

                        <div
                        className="w-3 h-3 rounded-full border-2 border-white shadow-sm flex-shrink-0"
                        style={{ backgroundColor: routeColor }} />

                        <span className="text-xs font-medium whitespace-nowrap" style={{ color: 'var(--text-slate-700)' }}>
                          {displayName}
                        </span>
                        <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                          ({route.totalStops})
                        </span>
                      </div>);

                    })}
              </div>
            </div>
          }
        </div>
      </div>

      <div className="flex-1 w-full relative min-h-0 overflow-hidden">
        {/* Polyline API hits badge - App Owner only - fixed position */}
        {currentUser && isAppOwner(currentUser) &&
        <div
          className="absolute left-4 z-[140]"
          style={{
            bottom: `${(deliveriesWithStopOrder.length > 0 ? stopCardsBaseHeight : 0) + 15}px`
          }}>
            <div className="px-2 py-1 text-xs font-medium rounded-lg border" style={{ background: 'transparent', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-600)' }}>
              🛣️ {dailyPolylineCount ?? '...'}
            </div>
          </div>
        }

        {/* Desktop: Offline Sync Indicator */}
        {!isMobile && <DashboardOfflineSync currentUser={currentUser} dailyPolylineCount={dailyPolylineCount} isExpanded={isExpanded} stopCardsHeight={stopCardsBaseHeight} />}

        {/* Real-time ETA Tracker - ONLY for mobile drivers viewing their own route */}
        {realTimeETAEnabled && isMobile && isDriver && selectedDriverId === currentUser?.id && selectedDriverId !== 'all' &&
        <ETATracker
          selectedDriverId={selectedDriverId}
          selectedDate={selectedDateStr}
          currentUser={currentUser}
          isActive={!showDeliveryForm && !showPatientForm && !showOptimizationSettings}
          onETAUpdate={(updates) => {
          }} />

        }

        {/* Real-time Route Optimizer - ONLY for mobile drivers viewing their own route */}
        {isMobile && isDriver && selectedDriverId === currentUser?.id && selectedDriverId !== 'all' &&
        <RealTimeRouteOptimizer
          selectedDriverId={selectedDriverId}
          selectedDate={selectedDateStr}
          currentUser={currentUser}
          isActive={!showDeliveryForm && !showPatientForm && !showOptimizationSettings}
          onRouteOptimized={(updates) => {
            console.log('🔄 Route optimization updates:', updates);
          }} />

        }


        {/* ETA Change Notifications - Drivers Only */}
        <ETANotification
          deliveries={filteredDeliveries}
          driverId={selectedDriverId}
          currentUser={currentUser} />


        <div className="absolute inset-0">
          <DeliveryMap
            deliveries={deliveriesWithStopOrder}
            selectedDriverId={selectedDriverId}
            selectedDate={format(selectedDate, 'yyyy-MM-dd')}
            patients={patients}
            stores={stores}
            users={drivers}
            currentUser={currentUser}
            driverLocations={isAllDriversMode ? allDriverLocations : showAllDriverMarkers ? allDriverLocations : allDriverLocations}
            deliveriesForLocationFilter={filteredDeliveries}
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
          className="horizontal-cards-container absolute bottom-0 right-0 z-[150] px-4 pb-1 pointer-events-none flex flex-col justify-end min-h-[145px] max-h-[80vh]"
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

              {/* CRITICAL: Hide stop cards when in "All Drivers" mode */}
              {!isAllDriversMode && (
              <HorizontalStopCards
              ref={horizontalStopCardsRef}
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
                  allDriverDeliveries.every((d) => finishedStatuses.includes(d.status) || checkIsReturn(d));

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
              )
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

      {(isDriver || isDispatcher) &&
      <>
        <MapViewCycleFAB
          onClick={handleMapViewCycle}
          currentPhase={mapViewPhase}
          hasVisibleCards={deliveriesWithStopOrder.length > 0}
          isAIVisible={showAIAssistant && isAIEnabled}
          isLocked={isMapViewLocked}
          stopCardsHeight={stopCardsBaseHeight} />

        {/* Re-optimize Route FAB - Only for drivers viewing their own route */}
        {isDriver && !isAdmin && !isDispatcher && selectedDriverId === currentUser?.id && selectedDriverId !== 'all' &&
        <motion.div
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0, opacity: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 20 }}
          className="fixed z-[140]"
          style={{
            bottom: `${(deliveriesWithStopOrder.length > 0 ? stopCardsBaseHeight : 0) + 15}px`,
            right: '64px'
          }}>
            <Button
            onClick={async () => {
              if (isReoptimizing) return;

              setIsReoptimizing(true);
              setOptimizationMessage('Re-optimizing route...');

              // CRITICAL: Pause smart refresh manager BEFORE optimization
              console.log('⏸️ [FAB Reoptimize] Pausing smart refresh, offline sync, and mutations');
              setIsEntityUpdating(true);
              pauseOfflineMutations();
              pauseOfflineSync();
              await new Promise((resolve) => setTimeout(resolve, 100));

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

              console.log('🚀 [optimizeRemainingStops] incompleteStops.length', incompleteStops.length);

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
                  const padding = getMapPadding();
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
                  invalidateDeliveriesForDate(deliveryDate);
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
                console.log('▶️ [FAB Reoptimize] Resuming smart refresh, offline sync, and mutations');
                resumeOfflineMutations();
                resumeOfflineSync();
                setIsEntityUpdating(false);
                await new Promise((resolve) => setTimeout(resolve, 100));

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
      </div>
    </PullToSync>
  );
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