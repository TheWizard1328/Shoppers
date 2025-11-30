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
import { Calendar as CalendarIcon, Clock, Truck, CheckCircle, XCircle, Package, Plus, ChevronUp, ChevronDown, RotateCcw as RefreshIcon, Phone, MapPin, X, Settings, Bot, Sparkles } from "lucide-react";
import { format, startOfDay } from 'date-fns';
import { getData, invalidate, invalidateDeliveriesForDate } from "@/components/utils/dataManager";
import DeliveryMap from "@/components/dashboard/DeliveryMap";
import { getDriverColor } from "@/components/dashboard/DeliveryMap";
import HorizontalStopCards from "@/components/dashboard/HorizontalStopCards";
import DeliveryForm from "@/components/deliveries/DeliveryForm";
import PatientForm from "@/components/patients/PatientForm";
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
import AIAssistantFAB from "@/components/dashboard/AIAssistantFAB";
import MapViewCycleFAB from "@/components/dashboard/MapViewCycleFAB";
import AIRouteOptimizer from "@/components/dashboard/AIRouteOptimizer";
import AIRoutePlanner from "@/components/dashboard/AIRoutePlanner";
import { getOrGenerateRoutePolyline } from "@/components/utils/routePolylineManager";
import { Input } from "@/components/ui/input";
import { driverLocationPoller } from "@/components/utils/driverLocationPoller";
import { getAvailableDrivers } from "@/components/utils/driverSelectors";
import RouteSummaryModal from "@/components/dashboard/RouteSummaryModal";
import { isMobileDevice } from "@/components/utils/deviceUtils";
import { optimizeDriverRoute } from "@/functions/optimizeDriverRoute";
import { loadUserSettings, saveSetting, getSetting } from "@/components/utils/userSettingsManager";

// FIXED: StatBadge - always render with consistent hook structure
const StatBadge = ({ icon: Icon, value, color, label, tooltip }) => {
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
      <span className="text-lg font-bold text-slate-900">{value}</span>
    </div>;


  // ALWAYS render Tooltip with all hooks, just conditionally show content
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {badge}
      </TooltipTrigger>
      <TooltipContent className="animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-999 overflow-hidden rounded-md border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md origin-[--radix-tooltip-content-transform-origin]">
        <p>{tooltip || ''}</p>
      </TooltipContent>
    </Tooltip>);

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
    (existingDeliveriesForDate || [])
      .map((delivery) => delivery && delivery.stop_id)
      .filter(Boolean)
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

// Helper function to populate temporary start times for deliveries with blank time windows
const populateTemporaryStartTimes = (deliveries, stores) => {
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
  
  // Create a copy to avoid mutating original
  const deliveriesCopy = deliveries.map(d => ({ ...d }));
  
  deliveriesCopy.forEach(delivery => {
    // Only process patient deliveries (not pickups)
    if (!delivery.patient_id) return;
    
    // Skip if delivery already has a delivery_time_start
    if (delivery.delivery_time_start) return;
    
    // Find the parent store's pickup
    const parentPickup = deliveriesCopy.find(d => 
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
    isDataLoaded,
    refreshData,
    setIsFormOverlayOpen,
    setOnSmartRefreshComplete
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
  const [googleApiKey, setGoogleApiKey] = useState(null);
  const [allDriverLocations, setAllDriverLocations] = useState([]);
  const [screenWidth, setScreenWidth] = useState(window.innerWidth);
  const [cardWidth, setCardWidth] = useState(340);
  const [areCardsVisible, setAreCardsVisible] = useState(false);
  const fadeTimeoutRef = useRef(null);
  const statsCardRef = useRef(null);
  const [isMapViewLocked, setIsMapViewLocked] = useState(false);
  const retractClustersRef = useRef(null);
  const [showRouteSummary, setShowRouteSummary] = useState(false);
  const hasShownSummaryRef = useRef(false);
  const stopCardsContainerRef = useRef(null);

  const STOP_CARDS_BASE_HEIGHT = 145; // Fixed non-expanded height for map padding
  const StopCardsHeight = STOP_CARDS_BASE_HEIGHT + 80;

  const mapLockTimeoutRef = useRef(null);
  const mapLockExpiresAtRef = useRef(null); // Timestamp when lock should expire
  const [showAIRoutePlanner, setShowAIRoutePlanner] = useState(false);
  const [useAIOptimization, setUseAIOptimization] = useState(true);
  const [isAIAnalyzing, setIsAIAnalyzing] = useState(false);
  const [statsCardRect, setStatsCardRect] = useState(null);
  const [scrollToNextCardAfter, setScrollToNextCardAfter] = useState(null);
  const [dailyPolylineCount, setDailyPolylineCount] = useState(null);
  const [highlightedCardId, setHighlightedCardId] = useState(null);
  
  // Track if we've done initial driver selection (prevent re-running on data changes)
  const hasSetInitialDriverDashboard = useRef(false);

  // CRITICAL: Calculate isDriver early (before useEffect that needs it)
  const isMobile = useMemo(() => isMobileDevice(), []);
  const isDriver = useMemo(() => currentUser ? userHasRole(currentUser, 'driver') : false, [currentUser]);
  const isAdmin = useMemo(() => currentUser ? userHasRole(currentUser, 'admin') : false, [currentUser]);

  // Load user settings on mount - PHASE 1: Load backend values FIRST
  useEffect(() => {
    if (!currentUser?.id || userSettingsLoaded) return;
    
    const loadSettings = async () => {
      try {
        console.log('📋 [Dashboard] PHASE 1: Loading user settings from backend...');
        const settings = await loadUserSettings(currentUser.id);
        console.log('📋 [Dashboard] Loaded user settings:', settings);
        
        // Apply FAB map cycle phase
        if (settings.fab_map_cycle_phase) {
          console.log(`🗺️ [Dashboard] Restoring FAB phase from settings: ${settings.fab_map_cycle_phase}`);
          setMapViewPhase(settings.fab_map_cycle_phase);
          
          // CRITICAL: For phase 2, lock the FAB immediately when settings are loaded
          if (settings.fab_map_cycle_phase === 2) {
            console.log(`🔒 [Settings Load] Phase 2 detected - locking FAB immediately`);
            setIsMapViewLocked(true);
            mapLockExpiresAtRef.current = null;
            mapLockTimeoutRef.current = null;
          }
        }
        
        // CRITICAL: Mark settings as loaded BEFORE setting driver
        // This prevents race conditions with auto-selection logic
        setUserSettingsLoaded(true);
        hasSetInitialDriverDashboard.current = true;
        
        // Now apply saved driver selection (after marking as loaded)
        // Use 'all' as default if no saved selection
        const driverToSelect = settings.selected_driver_id || 'all';
        console.log(`👤 [Dashboard] PHASE 1 Complete: Setting driver to: ${driverToSelect}`);
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

    // CRITICAL: For dispatchers in "All Drivers" mode, only show deliveries from drivers who have deliveries for dispatcher's stores
    if (isDispatcher && selectedDriverId === 'all' && currentUser.store_ids && currentUser.store_ids.length > 0) {
      const dispatcherStoreIds = currentUser.store_ids;
      
      // Get deliveries for dispatcher's stores on this date
      const storeDeliveries = deliveries.filter(d => 
        d && 
        d.delivery_date === dateStr && 
        dispatcherStoreIds.includes(d.store_id)
      );
      
      // Get unique driver IDs who have deliveries for these stores
      const relevantDriverIds = new Set(
        storeDeliveries.map(d => d.driver_id).filter(Boolean)
      );
      
      // Return ALL deliveries for these drivers on this date (including other stores)
      return deliveries.filter((d) => {
        if (!d) return false;
        if (d.delivery_date !== dateStr) return false;
        if (!d.driver_id || !relevantDriverIds.has(d.driver_id)) return false;
        return true;
      });
    }

    // For other roles or single driver mode
    return deliveries.filter((d) => {
      if (!d) return false;
      if (d.delivery_date !== dateStr) return false;
      if (selectedDriverId && selectedDriverId !== 'all') {
        if (d.driver_id !== selectedDriverId) return false;
      }
      return true;
    });
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
      const driverDeliveries = groupedByDriver[driverId].sort((a, b) => {
        if (!a || !b) return 0; // Defensive check for null/undefined objects during sort
        const stopOrderA = a.stop_order ?? Infinity;
        const stopOrderB = b.stop_order ?? Infinity;

        if (stopOrderA !== stopOrderB) {
          return stopOrderA - stopOrderB;
        }

        const timeA = a.delivery_time_start || '';
        const timeB = b.delivery_time_start || '';
        return timeA.localeCompare(timeB);
      });

      // CRITICAL: Exclude pending deliveries from display_stop_order numbering
      const nonPendingDeliveries = driverDeliveries.filter(d => d && d.status !== 'pending');
      let displayCounter = 1;

      driverDeliveries.forEach((delivery) => {
        if (!delivery) return;
        
        // Only assign display_stop_order to non-pending deliveries
        if (delivery.status !== 'pending') {
          result.push({
            ...delivery,
            display_stop_order: displayCounter
          });
          displayCounter++;
        } else {
          // Pending deliveries still get added to result, but without display_stop_order
          result.push({
            ...delivery,
            display_stop_order: null
          });
        }
      });
    });

    return result;
  }, [filteredDeliveries]);

  useEffect(() => {
    if (scrollToNextCardAfter && deliveriesWithStopOrder.length > 0) {
        setTimeout(() => {
            const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
            const incompleteDeliveries = deliveriesWithStopOrder.filter(d => d && !finishedStatuses.includes(d.status));
            
            const inTransitIndex = incompleteDeliveries.findIndex(d => d.status === 'in_transit');

            if (inTransitIndex !== -1 && inTransitIndex + 1 < incompleteDeliveries.length) {
                const nextCard = incompleteDeliveries[inTransitIndex + 1];
                if (nextCard) {
                    console.log(`[Auto-Center] Scrolling to next card: ${nextCard.patient_name || 'Pickup'}`);
                    const cardElement = document.getElementById(`stop-card-${nextCard.id}`);
                    if (cardElement) {
                        cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                    }
                }
            }
            setScrollToNextCardAfter(null); // Reset the trigger
        }, 500);
    }
}, [deliveriesWithStopOrder, scrollToNextCardAfter]);

  const stats = useMemo(() => {
    const safeDeliveries = filteredDeliveries || [];
    if (!Array.isArray(safeDeliveries)) return { total: 0, inTransit: 0, completed: 0, failed: 0, returned: 0 };
    
    const patientMap = new Map((patients || []).filter(p => p && p.id).map((p) => [p.id, p]));
    
    const isReturn = (delivery) => {
      if (!delivery) return false;
      const patient = patientMap.get(delivery.patient_id);
      const notesReturn = (delivery.delivery_notes || '').toLowerCase().includes('return');
      const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
      return notesReturn || addressReturn;
    };
    
    const total = safeDeliveries.length;
    const inTransit = safeDeliveries.filter((d) => d && (d.status === 'in_transit' || d.status === 'en_route')).length;
    const completed = safeDeliveries.filter((d) => d && ['completed', 'delivered'].includes(d.status)).length;
    const returned = safeDeliveries.filter(isReturn).length;
    const failed = safeDeliveries.filter((d) => d && d.status === 'failed' && !isReturn(d)).length;

    return { total, inTransit, completed, failed, returned };
  }, [filteredDeliveries, patients]);

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

  // CRITICAL: Dispatchers in "All Drivers" mode only see drivers with deliveries for their stores
  const driversList = useMemo(() => {
    console.log('🔍 [Dashboard driversList] Computing driver list...');
    console.log('  - drivers array length:', drivers?.length || 0);
    console.log('  - currentUser:', currentUser?.user_name || currentUser?.full_name);
    console.log('  - currentUser.app_roles:', currentUser?.app_roles);
    console.log('  - Is dispatcher?', userHasRole(currentUser, 'dispatcher'));
    console.log('  - Is admin?', userHasRole(currentUser, 'admin'));
    
    if (!drivers || !Array.isArray(drivers)) {
      console.log('⚠️ [Dashboard driversList] No drivers array, returning empty');
      return [];
    }
    
    // Admins get all drivers
    if (userHasRole(currentUser, 'admin')) {
      console.log('✅ [Dashboard driversList] Admin - returning all drivers');
      return drivers;
    }
    
    // CRITICAL: Dispatchers in "All Drivers" mode - filter to drivers with deliveries for their stores
    if (userHasRole(currentUser, 'dispatcher') && selectedDriverId === 'all') {
      const dispatcherStoreIds = currentUser.store_ids || [];
      const dateStr = format(selectedDate, 'yyyy-MM-dd');
      
      console.log('🔍 [Dashboard driversList] Dispatcher in All Drivers mode');
      console.log('  - Dispatcher stores:', dispatcherStoreIds);
      console.log('  - Selected date:', dateStr);
      
      // Get deliveries for the selected date and dispatcher's stores
      const relevantDeliveries = deliveries.filter(d => 
        d && 
        d.delivery_date === dateStr && 
        dispatcherStoreIds.includes(d.store_id)
      );
      
      // Get unique driver IDs from these deliveries
      const driverIdsWithDeliveries = new Set(
        relevantDeliveries.map(d => d.driver_id).filter(Boolean)
      );
      
      console.log('  - Drivers with deliveries for dispatcher stores:', Array.from(driverIdsWithDeliveries));
      
      // Filter drivers to only those with deliveries
      const filteredDrivers = drivers.filter(d => d && driverIdsWithDeliveries.has(d.id));
      
      console.log(`✅ [Dashboard driversList] Dispatcher - filtered to ${filteredDrivers.length} drivers with deliveries`);
      return filteredDrivers;
    }
    
    // For dispatchers in single driver mode or other users
    console.log('✅ [Dashboard driversList] Returning all drivers');
    return drivers;
  }, [drivers, currentUser, selectedDriverId, deliveries, selectedDate]);

  const shouldShowLocationToggle = useMemo(() =>
    isMobile && isDriver && !userHasRole(currentUser, 'dispatcher'),
    [isMobile, isDriver, currentUser]
  );

  const isFiltersReady = useMemo(() => globalFilters.isReadyForDataFetch(), []);

  const isDriverDropdownDisabled = useMemo(() => {
    if (!currentUser) return false;
    
    // Enable for admins and dispatchers
    if (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) {
      return false;
    }
    
    // Disable only for pure drivers (driver role but not admin or dispatcher)
    const isPureDriver = userHasRole(currentUser, 'driver');
    return isPureDriver;
  }, [currentUser]);

  const tooltipValues = useMemo(() => ({
    total: "Total Scheduled Deliveries",
    inTransit: "In-Transit Deliveries",
    completed: "Completed Deliveries",
    failed: `${stats.failed} Failed / ${stats.returned}`
  }), [stats.failed, stats.returned]);

  const nextStop = useMemo(() => {
    if (!isDriver || !currentUser || !filteredDeliveries || !Array.isArray(filteredDeliveries) || filteredDeliveries.length === 0) return null;

    const unfinishedStops = filteredDeliveries.filter((d) => {
      if (!d) return false;
      return d.driver_id === currentUser.id &&
        !['completed', 'failed', 'cancelled', 'returned'].includes(d.status);
    });

    if (unfinishedStops.length === 0) return null;

    const sortedStops = [...unfinishedStops].sort((a, b) => {
      if (!a || !b) return 0; // Defensive check
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
      return 'absolute top-2 left-1/2 -translate-x-1/2 z-[20]';
    } else {
      return 'absolute top-2 right-2 z-[20]';
    }
  }, [screenWidth, cardWidth]);

  const optimizationMessagePositioning = useMemo(() => {
    const ratio = screenWidth / cardWidth;
    
    if (ratio < 2) {
      return 'absolute left-1/2 -translate-x-1/2 z-[9998] min-w-[340px]';
    } else {
      return 'absolute right-2 z-[9998] min-w-[340px]';
    }
  }, [screenWidth, cardWidth]);

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

  // Track when the last programmatic map move happened (to debounce interaction handler)
  const lastProgrammaticMapMoveRef = useRef(0);

  const handleMapInteraction = useCallback(() => {
    console.log('🗺️ [Map Interaction] Called');
    console.log('  - Current lock state:', isMapViewLocked);
    console.log('  - Current phase:', mapViewPhase);
    
    // Always clear lock when user interacts with map
    if (mapLockTimeoutRef.current) {
      clearTimeout(mapLockTimeoutRef.current);
      mapLockTimeoutRef.current = null;
    }
    mapLockExpiresAtRef.current = null;
    
    // Always unlock when user pans or zooms - this makes FAB turn gray
    console.log('✅ [Map Interaction] User interacted - unlocking map (FAB turns gray)');
    setIsMapViewLocked(false);
  }, [isMapViewLocked, mapViewPhase]);

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
      }
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    return () => {
      if (fadeTimeoutRef.current) {
        clearTimeout(fadeTimeoutRef.current);
      }
      if (mapLockTimeoutRef.current) {
        clearTimeout(mapLockTimeoutRef.current);
      }
    };
  }, []);



  useEffect(() => {
    const handleResize = () => {
      setScreenWidth(window.innerWidth);
    };

    const measureStatsCard = () => {
      if (statsCardRef.current) {
        const rect = statsCardRef.current.getBoundingClientRect();
        const width = statsCardRef.current.offsetWidth;
        
        if (width > 0 && width !== cardWidth) {
          setCardWidth(width);
        }
        
        // Store the card's position and dimensions for legend positioning
        setStatsCardRect({
          left: rect.left,
          width: rect.width
        });
      }
    };

    // Measure on mount and when expanded state changes
    measureStatsCard();

    window.addEventListener('resize', handleResize);
    window.addEventListener('resize', measureStatsCard);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('resize', measureStatsCard);
    };
  }, [cardWidth, isExpanded, screenWidth]);

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

  // Fetch daily polyline count for app owner badge
  const fetchPolylineCount = useCallback(async () => {
    if (!currentUser || !isAppOwner(currentUser)) return;
    
    try {
      const todayStr = format(new Date(), 'yyyy-MM-dd');
      const polylines = await base44.entities.DriverRoutePolyline.filter({
        delivery_date: todayStr
      });
      
      if (polylines && polylines.length > 0) {
        // Find the highest daily_generation_count
        const maxCount = Math.max(...polylines.map(p => p.daily_generation_count || 0));
        setDailyPolylineCount(maxCount);
      } else {
        setDailyPolylineCount(0);
      }
    } catch (error) {
      console.error('Error fetching polyline count:', error);
    }
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser || !isAppOwner(currentUser)) return;

    fetchPolylineCount();
    
    // Refresh every 30 seconds
    const interval = setInterval(fetchPolylineCount, 30000);
    return () => clearInterval(interval);
  }, [currentUser, fetchPolylineCount]);

  // Get driver's device GPS location for blue dot display (always, regardless of duty status)
  useEffect(() => {
    if (!isDriver || !currentUser) return;

    let watchId = null;

    const startWatchingPosition = () => {
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
            source: 'device_gps' // Always from device for drivers
          };
          
          setDriverLocation(newLocation);
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

    startWatchingPosition();

    return () => {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
      }
    };
  }, [isDriver, currentUser]);

  // Track other drivers' locations via poller (for all-drivers mode)
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

    const appUsers = users?.filter(u => u.user_id) || [];
    driverLocationPoller.processLocationData(currentUser, deliveries, drivers, stores, appUsers, selectedDate);
  }, [isDataLoaded, currentUser, deliveries, drivers, stores, users, selectedDate]);

  useEffect(() => {
    // CRITICAL: Only generate polylines on MOBILE devices
    if (!isMobile) {
      console.log('⏸️ [Dashboard] Skipping polyline generation: not a mobile device');
      return;
    }
    
    // CRITICAL: Only generate polylines when driver is on_duty
    if (!currentUser || !userHasRole(currentUser, 'driver')) {
      return;
    }
    
    // Must be on_duty to generate polylines (this is the Google API cost-incurring operation)
    if (currentUser.driver_status !== 'on_duty') {
      console.log('⏸️ [Dashboard] Skipping polyline generation: driver_status is', currentUser.driver_status);
      return;
    }
    
    if (!driverLocation || !nextStop) {
      return;
    }

    if (!googleApiKey) {
      return;
    }

    const hasStarted = filteredDeliveries.some((d) => {
      if (!d) return false; // Defensive check
      return ['in_transit', 'completed', 'cancelled', 'returned'].includes(d.status);
    });

    if (hasStarted) {
      return;
    }

    const generateRoutePolylineForMap = async () => {
      try {
        if (!nextStopCoordinates) {
          return;
        }

        const deliveryDate = format(selectedDate, 'yyyy-MM-dd');

        await getOrGenerateRoutePolyline({
          driverId: currentUser.id,
          deliveryDate: deliveryDate,
          startPoint: {
            lat: driverLocation.latitude,
            lon: driverLocation.longitude
          },
          endPoint: {
            lat: nextStopCoordinates.lat,
            lon: nextStopCoordinates.lon
          },
          routeType: 'to_first_stop',
          googleApiKey: googleApiKey,
          forceRefresh: false
        });
        
        // Refresh polyline count after generating
        fetchPolylineCount();
      } catch (error) {
        console.error('Error generating route polyline:', error);
      }
    };

    const timer = setTimeout(generateRoutePolylineForMap, 2000);

    return () => clearTimeout(timer);
  }, [currentUser, driverLocation, nextStop, nextStopCoordinates, selectedDate, googleApiKey, filteredDeliveries, isMobile, fetchPolylineCount]);

  useEffect(() => {
    if (!currentUser || !userHasRole(currentUser, 'driver') || showAIAssistant || !isAIEnabled) {
      return;
    }

    const checkAlerts = async () => {
      try {
        if (!filteredDeliveries || !Array.isArray(filteredDeliveries)) { // Defensive check
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

  const handleMapViewCycle = useCallback(() => {
    console.log('🎯 [FAB Click] handleMapViewCycle called');
    console.log('  [FAB Click] Current phase:', mapViewPhase);
    console.log('  [FAB Click] Is locked:', isMapViewLocked);
    console.log('  [FAB Click] Is dispatcher:', isDispatcher);
    console.log('  [FAB Click] Is driver:', isDriver);
    
    // CRITICAL: Allow dispatchers to use FAB (they don't need driverLocation)
    if (!isDriver && !isDispatcher) {
      console.log('⏭️ [FAB Click] Skipping handleMapViewCycle - not driver or dispatcher');
      return;
    }
    
    // For drivers, require location
    if (isDriver && !driverLocation) {
      console.log('⏭️ [FAB Click] Skipping handleMapViewCycle - driver has no location');
      return;
    }

    // Clear any existing timeout first
    if (mapLockTimeoutRef.current) {
      console.log('🧹 [FAB Click] Clearing existing timeout');
      clearTimeout(mapLockTimeoutRef.current);
      mapLockTimeoutRef.current = null;
    }
    mapLockExpiresAtRef.current = null;

    let newMapViewPhase;
    
    if (isMapViewLocked) {
      // LOCKED (blue) FAB clicked → advance to next phase
      newMapViewPhase = (mapViewPhase % 3) + 1;
      
      // CRITICAL: Dispatchers always skip phase 2 and 3 (driver-specific phases)
      if (isDispatcher && !isDriver) {
        newMapViewPhase = 1; // Dispatchers always stay on Phase 1 (All Stops)
        console.log('📋 [FAB Click] Dispatcher - staying on Phase 1 (All Stops)');
      } else {
        // Skip phase 2 if no next stop coordinates (drivers only)
        if (newMapViewPhase === 2 && !nextStopCoordinates) {
          newMapViewPhase = 3;
        }
        
        // Skip phase 3 if not on mobile (driver marker not visible on desktop)
        if (newMapViewPhase === 3 && !isMobile) {
          newMapViewPhase = 1;
        }
      }
      
      console.log(`➡️ [FAB Click] LOCKED - Advancing phase: ${mapViewPhase} → ${newMapViewPhase}`);
    } else {
      // UNLOCKED (gray) FAB clicked → reactivate current phase (no phase change)
      newMapViewPhase = mapViewPhase;
      console.log(`🔄 [FAB Click] UNLOCKED - Reactivating current phase: ${mapViewPhase}`);
    }

    // Set lock to TRUE and trigger map repositioning
    console.log(`🟢 [FAB Click] Setting isMapViewLocked = true (FAB turns green)`);
    setIsMapViewLocked(true);
    setMapViewPhase(newMapViewPhase);
    
    // Save to user settings (async, don't wait)
    if (currentUser?.id) {
      saveSetting(currentUser.id, 'fab_map_cycle_phase', newMapViewPhase);
    }
    
    setMapViewTrigger(prev => prev + 1);
    
    // Phase 2: Persistent lock (NO timer at all) - stays locked until user pans/zooms or clicks FAB again
    // Phase 1 and 3: 3-second auto-unlock timer
    if (newMapViewPhase === 2) {
      // Phase 2: NO expiry timestamp - this means handleMapInteraction will ALWAYS unlock it on user interaction
      // But since there's no timer, the FAB stays blue until user actually interacts
      mapLockExpiresAtRef.current = null;
      mapLockTimeoutRef.current = null;
      console.log(`🔒 [FAB Click] Phase 2 - Persistent lock (FAB stays blue until user pans/zooms or clicks FAB)`);
    } else {
      // Phase 1 and 3: 3-second auto-unlock timer
      const lockDuration = 3000; // 3 seconds
      const expiresAt = Date.now() + lockDuration;
      mapLockExpiresAtRef.current = expiresAt;
      console.log(`⏰ [FAB Click] Phase ${newMapViewPhase} - Starting ${lockDuration}ms timer, expires at: ${expiresAt}`);
      
      const phaseAtTimeOfClick = newMapViewPhase;
      
      mapLockTimeoutRef.current = window.setTimeout(() => {
        if (mapLockExpiresAtRef.current === expiresAt) {
          console.log(`⚫ [FAB Timer] Phase ${phaseAtTimeOfClick} - ${lockDuration}ms elapsed, unlocking (FAB turns gray)`);
          setIsMapViewLocked(false);
          mapLockExpiresAtRef.current = null;
          mapLockTimeoutRef.current = null;
        } else {
          console.log(`⏭️ [FAB Timer] Timer fired but expiry was reset - ignoring`);
        }
      }, lockDuration);
      
      console.log(`⏰ [FAB Click] Timer started with ID: ${mapLockTimeoutRef.current}`);
    }
  }, [mapViewPhase, isMapViewLocked, isDriver, driverLocation, nextStopCoordinates]);

  // Track if the current map positioning was triggered by FAB (not by data refresh)
  const mapPositioningTriggerRef = useRef(null);

  // Track a counter to force useEffect to re-run when FAB is clicked
  const [mapViewTrigger, setMapViewTrigger] = useState(0);

  useEffect(() => {
    console.log(`🗺️ [Map Position] useEffect triggered - phase: ${mapViewPhase}, locked: ${isMapViewLocked}, trigger: ${mapViewTrigger}`);
    
    // Skip if mapViewPhase is 0 (reset state - should not happen with new logic)
    if (mapViewPhase === 0) {
      console.log('⏭️ [FAB Click] Skipping map positioning - phase is 0');
      return;
    }
    
    // CRITICAL: Only skip phase 2 & 3 if not driver or no location
    // Phase 1 can run for dispatchers/admins without driver location
    if (mapViewPhase > 1 && (!isDriver || !driverLocation)) {
      console.log('⏭️ [Map Position] Skipping phase 2/3 - not driver or no location');
      return;
    }

    // CRITICAL: Don't require lock check - this prevents FAB from working after unlock
    // Instead, only run when mapViewTrigger changes (FAB was clicked)
    
    // Mark that this positioning is from a FAB interaction
    mapPositioningTriggerRef.current = 'fab';

    console.log(`🗺️ [FAB Click] Applying Phase ${mapViewPhase}...`);
    
    // NOTE: Timer is now started in handleMapViewCycle, not here
    // This useEffect only handles map repositioning

    switch (mapViewPhase) {
      case 1: // "Show All Stops"
        console.log('📍 [FAB Click] Phase 1: Show All Stops (temporary lock)');
        const allCoordinates = [];
        let hasStopMarkers = false;
        let hasDriverMarkers = false;

        // CRITICAL: Only add driver locations if their marker is actually visible on the map
        // Get driver IDs that have deliveries displayed
        const driversWithVisibleDeliveries = new Set(
          deliveriesWithStopOrder
            .filter(d => d && d.driver_id)
            .map(d => d.driver_id)
        );

        // Check if viewing today's date
        const todayStr = format(new Date(), 'yyyy-MM-dd');
        const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
        const isViewingToday = todayStr === selectedDateStr;

        // Determine if current driver's marker is visible:
        // - Must be on mobile device (driver markers only show on mobile for current driver)
        // - Must have visible deliveries
        // - Must be a driver role
        // - Must be viewing TODAY's date (driver location irrelevant for past/future dates)
        const isCurrentDriverMarkerVisible = 
          isMobile && 
          isDriver && 
          isViewingToday &&
          driversWithVisibleDeliveries.has(currentUser?.id);

        // Add current driver location only if their marker is visible AND viewing today
        if (driverLocation?.latitude && driverLocation?.longitude) {
          if (isCurrentDriverMarkerVisible) {
            allCoordinates.push([driverLocation.latitude, driverLocation.longitude]);
            hasDriverMarkers = true;
            console.log('📍 [FAB Click] Including current driver location (marker visible on mobile, viewing today)');
          } else {
            console.log('⏭️ [FAB Click] Skipping current driver location (mobile:', isMobile, ', isDriver:', isDriver, ', isToday:', isViewingToday, ', hasDeliveries:', driversWithVisibleDeliveries.has(currentUser?.id), ')');
          }
        }

        // Add driver's home location if visible on map (for single driver mode)
        // Only include home location when viewing TODAY (irrelevant for past/future dates)
        if (currentUser?.home_latitude && currentUser?.home_longitude && !isAllDriversMode && isViewingToday) {
          // Check if route has active stops (home should be visible)
          const hasActiveStops = deliveriesWithStopOrder.some(d => 
            d && !['completed', 'failed', 'cancelled', 'returned'].includes(d.status)
          );
          // Home location visibility follows same rules as driver marker
          if (hasActiveStops && isCurrentDriverMarkerVisible) {
            allCoordinates.push([currentUser.home_latitude, currentUser.home_longitude]);
            console.log('🏠 [FAB Click] Including driver home location in bounds');
          }
        }

        // Add all other driver locations only if they have visible deliveries (shared locations from poller)
        if (allDriverLocations && Array.isArray(allDriverLocations)) {
          allDriverLocations.forEach((location) => {
            if (location?.latitude && location?.longitude && location?.driver_id) {
              // Shared driver locations are visible if they have deliveries on the map
              if (driversWithVisibleDeliveries.has(location.driver_id)) {
                allCoordinates.push([location.latitude, location.longitude]);
                hasDriverMarkers = true;
                console.log('📍 [FAB Click] Including shared driver location:', location.driver_id);
              }
            }
          });
        }

        // Add all delivery/pickup markers
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

        // Get current city center
        const selectedCityId = globalFilters.getSelectedCityId();
        const currentCity = cities?.find((c) => c && c.id === selectedCityId);

        // CASE 1: No stop markers and no driver markers → center on closest assigned city
        if (!hasStopMarkers && !hasDriverMarkers) {
          console.log('🗺️ [FAB Click] Phase 1 - No markers found, finding closest city...');
          
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
          const assignedCities = cities?.filter(c => c && userCityIds.includes(c.id)) || [];
          
          console.log(`📍 [FAB Click] User ref location: ${locationSource} [${userRefLat?.toFixed(4)}, ${userRefLon?.toFixed(4)}]`);
          console.log(`🏙️ [FAB Click] User assigned cities: ${assignedCities.map(c => c.name).join(', ') || 'none'}`);
          
          let closestCity = null;
          
          if (userRefLat && userRefLon && assignedCities.length > 0) {
            // Find the closest assigned city to user's reference location
            const citiesWithDistance = assignedCities
              .filter(c => c?.latitude && c?.longitude)
              .map(city => ({
                city,
                distance: calculateDistance(userRefLat, userRefLon, city.latitude, city.longitude)
              }))
              .sort((a, b) => a.distance - b.distance);
            
            if (citiesWithDistance.length > 0) {
              closestCity = citiesWithDistance[0].city;
              console.log(`✅ [FAB Click] Closest city: ${closestCity.name} (${citiesWithDistance[0].distance.toFixed(1)}km away)`);
              citiesWithDistance.forEach(({ city, distance }) => {
                console.log(`   - ${city.name}: ${distance.toFixed(1)}km`);
              });
            }
          } else if (assignedCities.length > 0) {
            closestCity = assignedCities[0];
            console.log(`✅ [FAB Click] No user location - using first assigned city: ${closestCity.name}`);
          } else if (currentCity?.latitude && currentCity?.longitude) {
            closestCity = currentCity;
            console.log(`✅ [FAB Click] No assigned cities - using current city: ${closestCity.name}`);
          }
          
          // Center on the closest city
          if (closestCity?.latitude && closestCity?.longitude) {
            console.log(`🗺️ [FAB Click] Centering on ${closestCity.name} with 16km view radius`);
            
            const targetRadiusKm = 16;
            const latDegPerKm = 1 / 111.32;
            const lonDegPerKm = 1 / (111.32 * Math.cos(closestCity.latitude * Math.PI / 180));
            
            const latOffset = targetRadiusKm * latDegPerKm;
            const lonOffset = targetRadiusKm * lonDegPerKm;
            
            const bounds = [
              [closestCity.latitude - latOffset, closestCity.longitude - lonOffset],
              [closestCity.latitude + latOffset, closestCity.longitude + lonOffset]
            ];
            
            setShouldFitBounds({ 
              bounds, 
              options: { 
                paddingTopLeft: [50, 100],
                paddingBottomRight: [50, STOP_CARDS_BASE_HEIGHT + 50],
                maxZoom: 12,
                animate: false
              } 
            });
            setMapCenter(null);
            setMapZoom(null);
          }
        }
        // CASE 2: Drivers but no stop markers → center on drivers + city center
        else if (!hasStopMarkers && hasDriverMarkers && currentCity?.latitude && currentCity?.longitude) {
          console.log('🗺️ [FAB Click] Phase 1 - Drivers but no stops, centering on drivers + city center');
          allCoordinates.push([currentCity.latitude, currentCity.longitude]);
          console.log('  [FAB Click] Total coordinates:', allCoordinates.length);
          console.log('  [FAB Click] Bottom padding:', STOP_CARDS_BASE_HEIGHT + 50);
          setShouldFitBounds({ 
            bounds: allCoordinates, 
            options: { 
              paddingTopLeft: [50, 100],
              paddingBottomRight: [50, STOP_CARDS_BASE_HEIGHT + 50],
              maxZoom: 14 
            } 
          });
          setMapCenter(null);
          setMapZoom(null);
        }
        // CASE 3: Normal case with stop markers
        else if (allCoordinates.length > 0) {
          console.log('🗺️ [FAB Click] Phase 1 - Fitting bounds to', allCoordinates.length, 'coordinates');
          console.log('  [FAB Click] Bottom padding:', STOP_CARDS_BASE_HEIGHT + 50);
          
          // Calculate span to determine appropriate maxZoom
          // Prevent over-zooming when stops are close together
          // Prevent under-zooming when stops are far apart
          let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
          allCoordinates.forEach(([lat, lon]) => {
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
            minLon = Math.min(minLon, lon);
            maxLon = Math.max(maxLon, lon);
          });
          
          const latSpan = maxLat - minLat;
          const lonSpan = maxLon - minLon;
          const maxSpan = Math.max(latSpan, lonSpan);
          
          // Determine maxZoom based on geographic spread
          // ~0.01 degrees = ~1km, ~0.1 degrees = ~10km
          let phase1MaxZoom = 14; // Default - good for city-wide view
          if (maxSpan < 0.005) {
            // Very close together (< 500m) - allow closer zoom but cap at 15
            phase1MaxZoom = 15;
          } else if (maxSpan < 0.02) {
            // Close together (< 2km) - zoom 14
            phase1MaxZoom = 14;
          } else if (maxSpan < 0.1) {
            // Medium spread (< 10km) - zoom 13
            phase1MaxZoom = 13;
          } else {
            // Wide spread (> 10km) - zoom 12
            phase1MaxZoom = 12;
          }
          
          console.log(`  [FAB Click] Span: ${(maxSpan * 111).toFixed(1)}km, maxZoom: ${phase1MaxZoom}`);
          
          setShouldFitBounds({ 
            bounds: allCoordinates, 
            options: { 
              paddingTopLeft: [50, 100],
              paddingBottomRight: [50, STOP_CARDS_BASE_HEIGHT + 50],
              maxZoom: phase1MaxZoom
            } 
          });
          setMapCenter(null);
          setMapZoom(null);
        }
        break;

      case 2: // "Center on Driver & Next Stop"
        console.log('📍 [FAB Click] Phase 2: Center on Driver & Next Stop (persistent lock - continuous update)');
        // Mark that we're doing a programmatic map move (debounces interaction handler)
        lastProgrammaticMapMoveRef.current = Date.now();
        
        if (nextStopCoordinates) {
          const bounds = [
            [driverLocation.latitude, driverLocation.longitude],
            [nextStopCoordinates.lat, nextStopCoordinates.lon]
          ];
          
          // CRITICAL: Only include driver's home location if home IS the next stop
          // (i.e., the next stop coordinates match the driver's home coordinates)
          if (currentUser?.home_latitude && currentUser?.home_longitude) {
            const isHomeNextStop = 
              Math.abs(nextStopCoordinates.lat - currentUser.home_latitude) < 0.0001 &&
              Math.abs(nextStopCoordinates.lon - currentUser.home_longitude) < 0.0001;
            
            if (isHomeNextStop) {
              console.log('🏠 [FAB Click] Phase 2 - Home IS the next stop, including in bounds');
              // Home is already included via nextStopCoordinates, no need to add again
            } else {
              console.log('🏠 [FAB Click] Phase 2 - Home is NOT the next stop, excluding from bounds');
            }
          }

          // Calculate visual center offset: add extra padding to shift view UP to account for stop cards
          // This way the actual driver+stop midpoint is centered in the VISIBLE map area (above stop cards)
          // Increased multiplier from 1.0 to 1.5 for more aggressive upward shift
          const visualCenterOffset = Math.round(STOP_CARDS_BASE_HEIGHT * 1.5);
          const bottomPadding = STOP_CARDS_BASE_HEIGHT + 120 + visualCenterOffset;

          console.log('🗺️ [FAB Click] Phase 2 - Fitting bounds to driver + next stop');
          console.log('  [FAB Click] Driver:', [driverLocation.latitude, driverLocation.longitude]);
          console.log('  [FAB Click] Next Stop:', [nextStopCoordinates.lat, nextStopCoordinates.lon]);
          console.log('  [FAB Click] Stop cards height:', STOP_CARDS_BASE_HEIGHT);
          console.log('  [FAB Click] Visual center offset:', visualCenterOffset);
          console.log('  [FAB Click] Bottom padding:', bottomPadding);
          setShouldFitBounds({ 
            bounds, 
            options: { 
              paddingTopLeft: [50, 50],
              paddingBottomRight: [50, bottomPadding],
              maxZoom: 16 
            } 
          });
          setMapCenter(null);
          setMapZoom(null);
        } else {
          // If no next stop, just center on driver
          console.log('⚠️ [FAB Click] Phase 2: No next stop found, centering on driver only');
          setMapCenter([driverLocation.latitude, driverLocation.longitude]);
          setMapZoom(15);
          setShouldFitBounds(null);
        }
        break;

      case 3: // "Center on Driver"
        console.log('📍 [FAB Click] Phase 3: Center on Driver (zoom 15, temporary lock)');
        
        if (!driverLocation?.latitude || !driverLocation?.longitude) {
          console.warn('⚠️ [FAB Click] Phase 3 - No driver location available');
          return;
        }
        
        console.log('🗺️ [FAB Click] Phase 3 - Centering on driver location');
        console.log('  [FAB Click] Center:', [driverLocation.latitude, driverLocation.longitude]);
        console.log('  [FAB Click] Zoom: 15');
        console.log('  [FAB Click] Bottom padding:', StopCardsHeight);
        
        // Use fitBounds with driver location to apply bottom padding
        setShouldFitBounds({ 
          bounds: [[driverLocation.latitude, driverLocation.longitude]], 
          options: { 
            paddingTopLeft: [50, 50],
            paddingBottomRight: [50, StopCardsHeight],
            maxZoom: 15,
            animate: false
          } 
        });
        setMapCenter(null);
        setMapZoom(null);
        break;

      default:
        break;
    }
  }, [mapViewPhase, driverLocation, nextStopCoordinates, deliveriesWithStopOrder, patients, stores, isDriver, STOP_CARDS_BASE_HEIGHT, mapViewTrigger, isDispatcher, StopCardsHeight]);

  // Apply initial map view on first load - SKIP if settings already handled it
  useEffect(() => {
    // CRITICAL: If no deliveries, ensure FAB is unlocked and set to phase 1, NO LOCK
    // BUT don't re-center map - let the FAB phase 1 logic handle centering on closest city
    if (isDataLoaded && deliveriesWithStopOrder.length === 0) {
      // Skip if already applied to prevent duplicate centering
      if (initialMapViewApplied) {
        console.log('⏭️ [Initial Load] Already applied, skipping');
        return;
      }
      
      console.log('🗺️ [Initial Load] No deliveries - setting FAB to phase 1 and unlocked');
      setMapViewPhase(1);
      setIsMapViewLocked(false);
      setInitialMapViewApplied(true);
      
      // CRITICAL: Clear any lock timers/expiry when no deliveries
      if (mapLockTimeoutRef.current) {
        clearTimeout(mapLockTimeoutRef.current);
        mapLockTimeoutRef.current = null;
      }
      mapLockExpiresAtRef.current = null;
      
      // CRITICAL: Trigger FAB phase 1 logic which will center on CLOSEST city
      // Don't manually set mapCenter here - let the mapViewPhase useEffect handle it
      console.log('🗺️ [Initial Load] Triggering FAB phase 1 for closest city centering');
      setMapViewTrigger(prev => prev + 1);
      return;
    }
    
    // CRITICAL: Skip if user settings were loaded and applied phase 2 (settings take priority)
    // For phase 2 loaded from settings, we need to trigger map view, SELECT next stop marker (not just highlight), and auto-scroll to next card
    if (userSettingsLoaded && mapViewPhase === 2 && !initialMapViewApplied && isDataLoaded && deliveriesWithStopOrder.length > 0 && isDriver && driverLocation && STOP_CARDS_BASE_HEIGHT > 0) {
      console.log(`🗺️ [Initial Load] Phase 2 from settings - triggering map view and selecting next stop`);
      
      // Find the next delivery to select its marker
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const incompleteDeliveries = deliveriesWithStopOrder
        .filter(d => d && !finishedStatuses.includes(d.status))
        .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
      
      // Trigger map repositioning FIRST
      setMapViewTrigger(prev => prev + 1);
      setInitialMapViewApplied(true);
      
      // THEN select card and scroll after a delay to ensure DOM is ready
      if (incompleteDeliveries.length > 0) {
        const nextDelivery = incompleteDeliveries[0];
        console.log(`📍 [Initial Load Phase 2] Will select next stop: ${nextDelivery.patient_name || 'Pickup'} (id: ${nextDelivery.id})`);
        
        // Delay setting selectedCardId to ensure HorizontalStopCards is rendered
        setTimeout(() => {
          setSelectedCardId(nextDelivery.id);
          console.log(`📍 [Initial Load Phase 2] Set selectedCardId: ${nextDelivery.id}`);
          
          // Additional backup scroll
          setTimeout(() => {
            const cardElement = document.getElementById(`stop-card-${nextDelivery.id}`);
            if (cardElement) {
              cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
              console.log(`📍 [Initial Load Phase 2] Scrolled to card: ${nextDelivery.id}`);
            } else {
              console.warn(`⚠️ [Initial Load Phase 2] Card not found: stop-card-${nextDelivery.id}`);
            }
          }, 300);
        }, 100);
      }
      
      return;
    }
    
    // CRITICAL: Skip if user settings were loaded and applied a non-phase-2 phase (settings take priority)
    if (userSettingsLoaded && mapViewPhase !== 1) {
      console.log(`⏭️ [Initial Load] Skipping - phase ${mapViewPhase} already set from user settings`);
      setInitialMapViewApplied(true);
      return;
    }
    
    // CRITICAL: Apply initial map view when data is ready
    if (!initialMapViewApplied && isDataLoaded && deliveriesWithStopOrder.length > 0 && isDriver && driverLocation) {
      console.log('🗺️ [Initial Load] Applying Phase 1 (Show All Stops)');
      console.log(`📏 [Initial Load] Stop cards height: ${STOP_CARDS_BASE_HEIGHT}px`);
      
      // Clear any existing timeout
      if (mapLockTimeoutRef.current) {
        clearTimeout(mapLockTimeoutRef.current);
        mapLockTimeoutRef.current = null;
      }
      mapLockExpiresAtRef.current = null;
      
      setIsMapViewLocked(true);
      setMapViewPhase(1);
      setMapViewTrigger(prev => prev + 1);
      setInitialMapViewApplied(true);
      
      // Start 3-second timer for initial phase 1 with expiry timestamp
      const lockDuration = 3000;
      const expiresAt = Date.now() + lockDuration;
      mapLockExpiresAtRef.current = expiresAt;
      console.log(`⏰ [Initial Load] Starting ${lockDuration}ms timer for Phase 1, expires at:`, expiresAt);
      
      mapLockTimeoutRef.current = window.setTimeout(() => {
        if (mapLockExpiresAtRef.current === expiresAt) {
          console.log(`⚫ [Initial Load] Phase 1 auto-unlocking after ${lockDuration}ms`);
          setIsMapViewLocked(false);
          mapLockExpiresAtRef.current = null;
          mapLockTimeoutRef.current = null;
        } else {
          console.log('⏭️ [Initial Load] Timer fired but expiry was reset - ignoring');
        }
      }, lockDuration);
    }
  }, [initialMapViewApplied, isDataLoaded, deliveriesWithStopOrder.length, isDriver, driverLocation, userSettingsLoaded, mapViewPhase]);

  // CRITICAL: Dedicated effect to scroll to next delivery card on initial load
  // This runs AFTER cards are rendered and handles ALL phases
  // CHANGED: Only center (scroll), do NOT select the card
  useEffect(() => {
    // Skip if already scrolled or data not ready
    if (hasScrolledToNextCardRef.current || !isDataLoaded || deliveriesWithStopOrder.length === 0) {
      return;
    }
    
    console.log('🎯 [Card Scroll Effect] Checking if should scroll to next card...');
    
    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
    const incompleteDeliveries = deliveriesWithStopOrder
      .filter(d => d && !finishedStatuses.includes(d.status))
      .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
    
    if (incompleteDeliveries.length === 0) {
      console.log('⏭️ [Card Scroll Effect] No incomplete deliveries');
      hasScrolledToNextCardRef.current = true;
      return;
    }
    
    const nextDelivery = incompleteDeliveries[0];
    console.log(`📍 [Card Scroll Effect] Next delivery: ${nextDelivery.patient_name || 'Pickup'} (id: ${nextDelivery.id})`);
    console.log(`📍 [Card Scroll Effect] Will center but NOT select`);
    
    // Wait for cards to render, then scroll
    const scrollTimer = setTimeout(() => {
      const cardElement = document.getElementById(`stop-card-${nextDelivery.id}`);
      if (cardElement) {
        cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        console.log(`✅ [Card Scroll Effect] Scrolled to next card (NOT selected): ${nextDelivery.id}`);
      } else {
        console.warn(`⚠️ [Card Scroll Effect] Card not found: stop-card-${nextDelivery.id}`);
        // Try again after more delay
        setTimeout(() => {
          const retryElement = document.getElementById(`stop-card-${nextDelivery.id}`);
          if (retryElement) {
            retryElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            console.log(`✅ [Card Scroll Effect] Retry scroll succeeded (NOT selected): ${nextDelivery.id}`);
          }
        }, 500);
      }
      hasScrolledToNextCardRef.current = true;
    }, 500); // 500ms delay to ensure cards are rendered
    
    return () => clearTimeout(scrollTimer);
  }, [isDataLoaded, deliveriesWithStopOrder]);

  // Register smart refresh callback to update map when in phase 2 (locked)
  useEffect(() => {
    if (!setOnSmartRefreshComplete) return;
    
    const handleSmartRefreshComplete = () => {
      // CRITICAL: Only re-apply map view if:
      // 1. Phase 2 is active
      // 2. Map is LOCKED (blue FAB)
      // 3. We have driver location and next stop coordinates
      if (mapViewPhase === 2 && isMapViewLocked && isDriver && driverLocation && nextStopCoordinates) {
        console.log('🗺️ [Smart Refresh] Phase 2 + LOCKED - re-centering map on driver + next stop');
        
        // Mark that we're doing a programmatic map move (debounces interaction handler)
        lastProgrammaticMapMoveRef.current = Date.now();
        
        const bounds = [
          [driverLocation.latitude, driverLocation.longitude],
          [nextStopCoordinates.lat, nextStopCoordinates.lon]
        ];
        
        // CRITICAL: Only include driver's home location if home IS the next stop
        if (currentUser?.home_latitude && currentUser?.home_longitude) {
          const isHomeNextStop = 
            Math.abs(nextStopCoordinates.lat - currentUser.home_latitude) < 0.0001 &&
            Math.abs(nextStopCoordinates.lon - currentUser.home_longitude) < 0.0001;
          
          if (isHomeNextStop) {
            console.log('🏠 [Smart Refresh] Phase 2 - Home IS the next stop');
            // Home is already included via nextStopCoordinates
          } else {
            console.log('🏠 [Smart Refresh] Phase 2 - Home is NOT the next stop, excluding from bounds');
          }
        }
        
        // Same increased padding as FAB click for phase 2 continuous updates
        const visualCenterOffset = Math.round(STOP_CARDS_BASE_HEIGHT * 1.5);
        const bottomPadding = STOP_CARDS_BASE_HEIGHT + 120 + visualCenterOffset;
        
        setShouldFitBounds({ 
          bounds, 
          options: { 
            paddingTopLeft: [50, 50],
            paddingBottomRight: [50, bottomPadding],
            maxZoom: 16 
          } 
        });
        setMapCenter(null);
        setMapZoom(null);
      } else if (mapViewPhase === 2 && !isMapViewLocked) {
        console.log('🗺️ [Smart Refresh] Phase 2 but UNLOCKED (gray FAB) - NOT re-centering map');
      }
    };
    
    setOnSmartRefreshComplete(handleSmartRefreshComplete);
    
    return () => {
      setOnSmartRefreshComplete(null);
    };
  }, [setOnSmartRefreshComplete, mapViewPhase, isMapViewLocked, isDriver, driverLocation, nextStopCoordinates]);

  // Auto-center on next stop on initial load
  const hasAutoSelectedRef = useRef(false);

  const hasScrolledToNextCardRef = useRef(false);



  useEffect(() => {
    // CRITICAL: Skip auto-center if initial FAB phase has been applied
    if (initialMapViewApplied) {
      console.log('⏭️ [Auto-Center] Skipping - initial map view already applied via FAB');
      return;
    }
    
    // Auto-center on next stop when data is ready
    // CHANGED: Only scroll to center card, do NOT select it
    if (!hasAutoSelectedRef.current && isDataLoaded && deliveriesWithStopOrder.length > 0 && !isLoadingUser) {
      console.log('🎯 [Auto-Center] Checking for next stop to auto-center...');
      
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      
      // Find first incomplete delivery
      const incompleteDeliveries = deliveriesWithStopOrder
        .filter(d => d && !finishedStatuses.includes(d.status))
        .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
      
      if (incompleteDeliveries.length > 0) {
        const nextDelivery = incompleteDeliveries[0];
        console.log(`✅ [Auto-Center] Auto-centering on: ${nextDelivery.patient_name || 'Pickup'} (stop_order: ${nextDelivery.stop_order})`);
        console.log(`📍 [Auto-Center] Will center but NOT select card`);
        
        // CHANGED: Do NOT set selectedCardId - only scroll to center
        // setSelectedCardId(nextDelivery.id); // REMOVED
        
        // Scroll card into view after a longer delay to ensure cards are rendered
        setTimeout(() => {
          const cardElement = document.getElementById(`stop-card-${nextDelivery.id}`);
          if (cardElement) {
            cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            console.log(`📍 [Auto-Center] Scrolled to next card (NOT selected): ${nextDelivery.id}`);
          } else {
            console.warn(`⚠️ [Auto-Center] Card element not found: stop-card-${nextDelivery.id}`);
          }
        }, 300);
        
        // Center map on this delivery using fitBounds for bottom padding
        if (nextDelivery.patient_id) {
          const patient = patients.find((p) => p && p.id === nextDelivery.patient_id);
          if (patient?.latitude && patient?.longitude) {
            setShouldFitBounds({ 
              bounds: [[patient.latitude, patient.longitude]], 
              options: { 
                paddingTopLeft: [50, 50],
                paddingBottomRight: [50, StopCardsHeight],
                maxZoom: 15 
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
                paddingTopLeft: [50, 50],
                paddingBottomRight: [50, StopCardsHeight],
                maxZoom: 15 
              } 
            });
            setMapCenter(null);
            setMapZoom(null);
          }
        }
        
        hasAutoSelectedRef.current = true;
      }
    }
  }, [isDataLoaded, deliveriesWithStopOrder, isLoadingUser, patients, stores, initialMapViewApplied]);

  // PHASE 4: Apply driver selection AFTER data is loaded
  // Only for pure drivers who MUST see their own route (override settings)
  useEffect(() => {
    if (!currentUser || !isDataLoaded || !driversList.length || !userSettingsLoaded) {
      return;
    }

    // Skip if already initialized from settings
    if (hasSetInitialDriverDashboard.current) {
      console.log('⏭️ [Dashboard] PHASE 4: Skipping - driver already set from settings');
      return;
    }

    console.log('🎯 [Dashboard] PHASE 4: Checking if pure driver needs forced self-selection...');

    const isPureDriver = userHasRole(currentUser, 'driver') && 
                         !userHasRole(currentUser, 'admin') && 
                         !userHasRole(currentUser, 'dispatcher');
    
    if (isPureDriver) {
      console.log('🚗 [Dashboard] Pure driver detected - forcing self-selection (ignoring saved settings)');
      const isInDriversList = driversList.some(d => d && d.id === currentUser.id);

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
  }, [globalFilters.getSelectedDriverId()]);

  const handleDateChange = (date) => {
    setSelectedDate(date);
    globalFilters.setSelectedDate(date);
    setIsCalendarOpen(false);
    
    // Save to user settings
    if (currentUser?.id) {
      const dateStr = format(date, 'yyyy-MM-dd');
      console.log('💾 [Dashboard] Saving date selection to user settings:', dateStr);
      saveSetting(currentUser.id, 'selected_date', dateStr);
    }
    
    // CRITICAL: Reactivate current FAB phase when date changes
    // This ensures the map repositions to show the new date's data
    if (mapViewPhase > 0) {
      console.log(`📅 [Date Change] Reactivating FAB phase ${mapViewPhase}`);
      setIsMapViewLocked(true);
      setMapViewTrigger(prev => prev + 1);
      
      // Set appropriate lock behavior based on phase
      if (mapViewPhase === 2) {
        // Phase 2: Persistent lock
        mapLockExpiresAtRef.current = null;
        mapLockTimeoutRef.current = null;
      } else {
        // Phase 1 and 3: 3-second auto-unlock timer
        const lockDuration = 3000;
        const expiresAt = Date.now() + lockDuration;
        mapLockExpiresAtRef.current = expiresAt;
        
        if (mapLockTimeoutRef.current) {
          clearTimeout(mapLockTimeoutRef.current);
        }
        
        mapLockTimeoutRef.current = window.setTimeout(() => {
          if (mapLockExpiresAtRef.current === expiresAt) {
            console.log(`⚫ [Date Change] Phase ${mapViewPhase} auto-unlocking`);
            setIsMapViewLocked(false);
            mapLockExpiresAtRef.current = null;
            mapLockTimeoutRef.current = null;
          }
        }, lockDuration);
      }
    }
  };

  const handleDriverChange = (driverId) => {
    console.log('👤 [Dashboard] Driver changed to:', driverId);
    setSelectedDriverId(driverId);
    globalFilters.setSelectedDriverId(driverId);
    setIsExpanded(false);
    
    // Save to user settings
    if (currentUser?.id) {
      console.log('💾 [Dashboard] Saving driver selection to user settings:', driverId);
      saveSetting(currentUser.id, 'selected_driver_id', driverId);
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
    
    const cardElement = document.getElementById(`stop-card-${delivery.id}`);
    if (cardElement) {
      cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  };

  const handleCardClick = (delivery) => {
    if (!delivery || !delivery.id) {
      return;
    }

    if (selectedCardId === delivery.id) {
      setSelectedCardId(null);
    } else {
      setSelectedCardId(delivery.id);

      // CRITICAL: If FAB is locked on phase 2, unlock it when user selects a card
      // This allows user interaction to break out of continuous driver tracking
      if (isMapViewLocked && mapViewPhase === 2) {
        console.log('🔓 [Card Click] Unlocking FAB phase 2 - user selected a card');
        setIsMapViewLocked(false);
      }

      if (delivery.patient_id) {
        const patient = patients.find((p) => p.id === delivery.patient_id);
        const store = stores.find((s) => s.id === delivery.store_id);
        
        if (patient?.latitude && patient?.longitude && store?.latitude && store?.longitude) {
          const bounds = [
            [patient.latitude, patient.longitude],
            [store.latitude, store.longitude]
          ];
          
          // Use increased padding for card clicks too
          const visualCenterOffset = Math.round(STOP_CARDS_BASE_HEIGHT * 1.5);
          const bottomPadding = STOP_CARDS_BASE_HEIGHT + 120 + visualCenterOffset;
          
          setShouldFitBounds({ 
            bounds, 
            options: { 
              paddingTopLeft: [50, 50],
              paddingBottomRight: [50, bottomPadding],
              maxZoom: 16 
            } 
          });
          setMapCenter(null);
          setMapZoom(null);
          setIsMapViewLocked(true);
        } else if (patient?.latitude && patient?.longitude) {
          const visualCenterOffset = Math.round(STOP_CARDS_BASE_HEIGHT * 1.5);
          const bottomPadding = STOP_CARDS_BASE_HEIGHT + 120 + visualCenterOffset;
          
          setShouldFitBounds({ 
            bounds: [[patient.latitude, patient.longitude]], 
            options: { 
              paddingTopLeft: [50, 50],
              paddingBottomRight: [50, bottomPadding],
              maxZoom: 15 
            } 
          });
          setMapCenter(null);
          setMapZoom(null);
          setIsMapViewLocked(true);
        }
      } else if (delivery.store_id) {
        const store = stores.find((s) => s.id === delivery.store_id);
        if (store?.latitude && store?.longitude) {
          const visualCenterOffset = Math.round(STOP_CARDS_BASE_HEIGHT * 1.5);
          const bottomPadding = STOP_CARDS_BASE_HEIGHT + 120 + visualCenterOffset;
          
          setShouldFitBounds({ 
            bounds: [[store.latitude, store.longitude]], 
            options: { 
              paddingTopLeft: [50, 50],
              paddingBottomRight: [50, bottomPadding],
              maxZoom: 15 
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
    console.log('[AddToRoute] 🎯 Dashboard: handleSaveDelivery called');
    console.log('[AddToRoute] 📦 Delivery data keys:', Object.keys(deliveryData));
    console.log('[AddToRoute] 📦 _isBatchSave:', deliveryData._isBatchSave);
    console.log('[AddToRoute] 📦 _stagedDeliveries length:', deliveryData._stagedDeliveries?.length);
    
    try {
      if (deliveryData._isBatchSave && deliveryData._stagedDeliveries) {
        console.log('');
        console.log('[AddToRoute] ═══════════════════════════════════');
        console.log('[AddToRoute] 📦 Processing batch delivery creation');
        console.log(`[AddToRoute] 📊 Total deliveries to create: ${deliveryData._stagedDeliveries.length}`);
        console.log('[AddToRoute] ═══════════════════════════════════');
        
        const stagedDeliveries = deliveryData._stagedDeliveries;
        
        if (!stagedDeliveries || stagedDeliveries.length === 0) {
          console.warn('[AddToRoute] ⚠️ No staged deliveries found!');
          return;
        }
        
        const deliveriesByDriver = {};
        stagedDeliveries.forEach(delivery => {
          if (!delivery) return;
          
          const driverId = (delivery.driver_id && delivery.driver_id.trim() !== '') ? delivery.driver_id : 'unassigned';
          if (!deliveriesByDriver[driverId]) {
            deliveriesByDriver[driverId] = [];
          }
          deliveriesByDriver[driverId].push(delivery);
        });
        
        console.log(`[AddToRoute] 👥 Deliveries grouped by ${Object.keys(deliveriesByDriver).length} driver(s)`);
        Object.entries(deliveriesByDriver).forEach(([dId, dels]) => {
          const dr = drivers.find(d => d && d.id === dId);
          console.log(`[AddToRoute]    - ${dr?.user_name || dId}: ${dels.length} deliveries`);
        });
        
        for (const [driverId, driverDeliveries] of Object.entries(deliveriesByDriver)) {
          if (driverId === 'unassigned') {
            console.log('[AddToRoute] ⚠️ Skipping unassigned deliveries');
            continue;
          }
          
          const driver = drivers.find(d => d && d.id === driverId);
          if (!driver) {
            console.warn(`[AddToRoute] ⚠️ Driver not found: ${driverId}`);
            continue;
          }
          
          console.log('');
          console.log('[AddToRoute] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log(`[AddToRoute] ----- Adding new stops to ${driver.user_name || driver.full_name} route -----`);
          console.log('[AddToRoute] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          
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
          
          console.log('');
          console.log('[AddToRoute] STEP 1: Analyzing new deliveries');
          console.log(`[AddToRoute]   - Processing ${driverDeliveries.length} new deliveries`);
          console.log(`[AddToRoute]   - Delivery date: ${deliveryDate}`);
          
          const allDeliveriesForDate = (deliveries || []).filter((delivery) => {
            if (!delivery) return false;
            return delivery.delivery_date === deliveryDate;
          });
          const driverDeliveriesForDate = allDeliveriesForDate.filter((delivery) => {
            if (!delivery) return false;
            return delivery.driver_id === driverId;
          });
          
          console.log('');
          console.log('[AddToRoute] STEP 2: Loading existing route data');
          console.log(`[AddToRoute]   - Found ${driverDeliveriesForDate.length} existing deliveries for this driver/date`);
          
          const stopsToProcess = [];
          
          console.log('');
          console.log('[AddToRoute] STEP 3: Adding existing deliveries to route processing');
          
          for (const existingDelivery of driverDeliveriesForDate) {
            if (!existingDelivery) continue;
            
            const enriched = { ...existingDelivery, isNew: false };
            
            if (existingDelivery.patient_id) {
              const existingPatient = patients.find(p => p.id === existingDelivery.patient_id);
              if (existingPatient?.latitude && existingPatient?.longitude) {
                enriched.latitude = existingPatient.latitude;
                enriched.longitude = existingPatient.longitude;
              }
            } else {
              const existingStore = stores.find(s => s.id === existingDelivery.store_id);
              if (existingStore?.latitude && existingStore?.longitude) {
                enriched.latitude = existingStore.latitude;
                enriched.longitude = existingStore.longitude;
              }
            }
            
            stopsToProcess.push(enriched);
          }
          
          console.log(`[AddToRoute]   - Added ${driverDeliveriesForDate.length} existing stops`);
          
          const dateObj = new Date(deliveryDate + 'T00:00:00');
          const dayOfWeek = dateObj.getDay();
          const isSaturday = dayOfWeek === 6;
          const isSunday = dayOfWeek === 0;
          
          const isFirstStop = driverDeliveriesForDate.length === 0;
          
          console.log('');
          console.log('[AddToRoute] STEP 4: Determining required store pickups');
          
          // CRITICAL: Always create pickups for ALL assigned stores when adding deliveries (batch mode)
          const assignedStores = (stores || []).filter(store => { // Defensive check
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
          
          console.log(`[AddToRoute]   - Checking ${storesToCheck.length} assigned stores for required pickups`);
          
          console.log('');
          for (const store of storesToCheck) {
            console.log(`[AddToRoute]   - Checking store: ${store.name}`);
            
            if (isSaturday ? isDriverAssignedToSlot(store, 'saturday_am') :
                isSunday ? isDriverAssignedToSlot(store, 'sunday_am') :
                isDriverAssignedToSlot(store, 'weekday_am')) {
              
              const existingAMPickup = stopsToProcess.find(delivery => {
                if (!delivery) return false;
                return delivery.store_id === store.id && !delivery.patient_id && delivery.ampm_deliveries === 'AM';
              });
              
              if (!existingAMPickup) {
                const amPickupTime = isSaturday ? (store.saturday_am_start || '09:00') :
                  isSunday ? (store.sunday_am_start || '09:00') :
                  (store.weekday_am_start || '09:00');
                const amPickupEndTime = isSaturday ? (store.saturday_am_end || '12:00') :
                  isSunday ? (store.sunday_am_end || '12:00') :
                  (store.weekday_am_end || '12:00');
                
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
                
                console.log(`   ➕ NEW AM PICKUP: ${store.name}`);
              }
            }
            
            if (isSaturday ? isDriverAssignedToSlot(store, 'saturday_pm') :
                isSunday ? isDriverAssignedToSlot(store, 'sunday_pm') :
                isDriverAssignedToSlot(store, 'weekday_pm')) {
              
              const existingPMPickup = stopsToProcess.find(delivery => {
                if (!delivery) return false;
                return delivery.store_id === store.id && !delivery.patient_id && delivery.ampm_deliveries === 'PM';
              });
              
              if (!existingPMPickup) {
                const pmPickupTime = isSaturday ? (store.saturday_pm_start || '13:00') :
                  isSunday ? (store.sunday_pm_start || '13:00') :
                  (store.weekday_pm_start || '13:00');
                const pmPickupEndTime = isSaturday ? (store.saturday_pm_end || '17:00') :
                  isSunday ? (store.sunday_pm_end || '17:00') :
                  (store.weekday_pm_end || '17:00');
                
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
                
                console.log(`   ➕ NEW PM PICKUP: ${store.name}`);
              }
            }
          }
          
          for (const newDelivery of driverDeliveries) {
            if (!newDelivery) continue;
            
            const patient = patients.find(p => p && p.id === newDelivery.patient_id);
            if (!patient) {
              console.warn(`[AddToRoute]   ⚠️ Patient not found: ${newDelivery.patient_id}`);
              continue;
            }
            
            const deliveryStore = stores.find(s => s.id === newDelivery.store_id);
            if (!deliveryStore) {
              console.warn(`[AddToRoute]   ⚠️ Store not found for patient: ${newDelivery.store_id}`);
              continue;
            }
            
            stopsToProcess.push({
              isNew: true,
              ...newDelivery,
              status: 'pending',
              latitude: patient.latitude,
              longitude: patient.longitude,
              extra_time: newDelivery.extra_time || 5
            });
            
            console.log(`[AddToRoute]   ✅ Added delivery: ${patient.full_name} (from ${deliveryStore.name})`);
          }
          
          console.log('');
          console.log(`[AddToRoute] STEP 6: Processing complete - ${stopsToProcess.length} total stops prepared`);
          console.log(`[AddToRoute]   - Existing stops: ${stopsToProcess.filter(s => !s.isNew).length}`);
          console.log(`[AddToRoute]   - New stops: ${stopsToProcess.filter(s => s.isNew).length}`);
          
          console.log('');
          console.log('[AddToRoute] STEP 7: Assigning stop IDs and PUIDs');
          
          for (const stop of stopsToProcess) {
            if (!stop || !stop.isNew) continue;
            
            if (!stop.patient_id) {
              if (!stop.stop_id) {
                stop.stop_id = generateUniqueSID(allDeliveriesForDate);
              }
              stop.puid = stop.stop_id;
              const stopStore = stores.find(s => s.id === stop.store_id);
              console.log(`[AddToRoute]   - Pickup ${stopStore?.name}: stop_id=${stop.stop_id}, PUID=${stop.puid}`);
            }
          }
          
          for (const stop of stopsToProcess) {
            if (!stop || !stop.isNew || !stop.patient_id) continue;
            
            const correspondingPickup = stopsToProcess.find(p => 
              p && !p.patient_id && 
              p.store_id === stop.store_id && 
              p.ampm_deliveries === stop.ampm_deliveries &&
              p.stop_id
            );
            
            if (correspondingPickup) {
              stop.puid = correspondingPickup.stop_id;
              const patient = patients.find(p => p.id === stop.patient_id);
              console.log(`[AddToRoute]   - Delivery ${patient?.full_name}: PUID=${stop.puid}`);
            } else {
              console.warn(`[AddToRoute]   ⚠️ No matching pickup found for ${stop.patient_name}`);
            }
          }
          
          console.log('');
          console.log('[AddToRoute] STEP 8: Normalizing delivery time windows');
          for (const stop of stopsToProcess) {
            if (!stop) continue;
            
            if (stop.patient_id !== null) {
              const stopPatient = patients.find(p => p.id === stop.patient_id);
              
              // CRITICAL: Find the corresponding pickup by matching BOTH store_id AND ampm_deliveries
              const correspondingPickup = stopsToProcess.find(s => {
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
              } else if (stop.isNew && !stop.delivery_time_end) {
                // Only set default end time for NEW deliveries that don't have one
                stop.delivery_time_end = '21:00';
              }
              // Leave existing delivery_time_end unchanged for non-new stops
            }
          }
          
          console.log('');
          console.log('[AddToRoute] STEP 9: Sorting stops (no optimization - simple sort by store, time, and distance)');
          
          // Sort stops: 
          // 1. Completed deliveries first (by actual_delivery_time)
          // 2. Then incomplete stops grouped by store, sorted by delivery_time_start and distance from store
          const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
          const completedStops = stopsToProcess.filter(s => s && finishedStatuses.includes(s.status));
          const incompleteStops = stopsToProcess.filter(s => s && !finishedStatuses.includes(s.status));
          
          // Sort completed by actual time
          completedStops.sort((a, b) => {
            if (!a || !b) return 0;
            if (!a.actual_delivery_time || !b.actual_delivery_time) return 0;
            return new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time);
          });
          
          // Sort incomplete: first by delivery_time_start, then by distance from store
          incompleteStops.sort((a, b) => {
            if (!a || !b) return 0;
            
            // Sort by delivery_time_start first
            const timeA = a.delivery_time_start || a.delivery_time_eta || '99:99';
            const timeB = b.delivery_time_start || b.delivery_time_eta || '99:99';
            
            if (timeA !== timeB) {
              return timeA.localeCompare(timeB);
            }
            
            // If times equal, sort by distance from store (for same-store deliveries)
            if (a.store_id === b.store_id) {
              const storeForSort = stores.find(s => s && s.id === a.store_id);
              if (storeForSort?.latitude && storeForSort?.longitude && a.latitude && a.longitude && b.latitude && b.longitude) {
                const distA = calculateDistance(storeForSort.latitude, storeForSort.longitude, a.latitude, a.longitude);
                const distB = calculateDistance(storeForSort.latitude, storeForSort.longitude, b.latitude, b.longitude);
                return distA - distB;
              }
            }
            
            return 0;
          });
          
          const optimizedRoute = [...completedStops, ...incompleteStops];
          console.log(`[AddToRoute]   ✅ Stops sorted (${optimizedRoute.length} total)`);
          
          console.log('');
          console.log('[AddToRoute] STEP 10: Finalizing delivery time windows');
          let windowsProcessed = 0;
          for (const stop of optimizedRoute) {
            if (!stop) continue;
            
            if (stop.patient_id !== null) {
              const stopPatient = patients.find(p => p.id === stop.patient_id);
              
              // CRITICAL: Find the corresponding pickup by matching BOTH store_id AND ampm_deliveries
              const correspondingPickup = optimizedRoute.find(s => {
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
              
              // CRITICAL: Only set delivery_time_end for NEW deliveries or if patient has explicit time window
              if (stopPatient?.time_window_end) {
                stop.delivery_time_end = stopPatient.time_window_end;
              } else if (stop.isNew && !stop.delivery_time_end) {
                // Only set default end time for NEW deliveries
                stop.delivery_time_end = stop.delivery_time_start ? 
                  addMinutesToTime(stop.delivery_time_start, 60) : '21:00';
              }
              // Leave existing delivery_time_end unchanged for non-new stops
              windowsProcessed++;
            }
          }
          
          console.log(`[AddToRoute]   - Processed ${windowsProcessed} delivery time windows`);
          
          console.log('');
          console.log('[AddToRoute] STEP 11: Determining AM/PM delivery periods and assigning PUIDs');
          
          // First, set AM/PM on all pickups and assign their stop_id as PUID
          for (const stop of optimizedRoute) {
            if (!stop) continue;
            
            if (stop.patient_id === null && stop.delivery_time_start) {
              const ampm = determineAMPMFromTime(stop.delivery_time_start);
              stop.ampm_deliveries = ampm;
              if (!stop.puid && stop.stop_id) {
                stop.puid = stop.stop_id;
              }
              console.log(`[AddToRoute]   - Pickup ${stores.find(s => s.id === stop.store_id)?.name}: ${ampm} slot, PUID=${stop.puid}`);
            }
          }
          
          // Then, set AM/PM on all deliveries and assign their PUID based on matching pickup
          for (const stop of optimizedRoute) {
            if (!stop) continue;
            
            if (stop.patient_id !== null) {
              // Determine AM/PM based on delivery start time
              const ampm = determineAMPMFromTime(stop.delivery_time_start);
              stop.ampm_deliveries = ampm;
              
              // Find the corresponding pickup for this store + AM/PM combination
              if (!stop.puid) {
                const correspondingPickup = optimizedRoute.find(p => 
                  p && !p.patient_id && 
                  p.store_id === stop.store_id && 
                  p.ampm_deliveries === ampm &&
                  p.stop_id
                );
                if (correspondingPickup) {
                  stop.puid = correspondingPickup.stop_id;
                  console.log(`[AddToRoute]   - Delivery ${patients.find(pt => pt.id === stop.patient_id)?.full_name}: ${ampm} slot, PUID=${stop.puid}`);
                } else {
                  console.warn(`[AddToRoute]   ⚠️ No matching ${ampm} pickup found for ${patients.find(pt => pt.id === stop.patient_id)?.full_name}`);
                }
              }
            }
          }
          
          console.log('');
          console.log('[AddToRoute] STEP 12: Assigning tracking numbers (TR#)');
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
                  console.log(`[AddToRoute]     Pickup ${stores.find(s => s.id === stop.store_id)?.name} (${stop.ampm_deliveries}): Keeping existing TR#${stop.tracking_number}`);
                  continue;
                }
              }
              
              // Assign new TR# for new pickups
              const trNumber = String(pickupTRCounter).padStart(2, '0');
              stop.tracking_number = trNumber;
              storePickupTRMap[mapKey] = pickupTRCounter;
              console.log(`[AddToRoute]     Pickup ${stores.find(s => s.id === stop.store_id)?.name} (${stop.ampm_deliveries}): NEW TR#${trNumber}`);
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
                const deliveriesBeforeThis = optimizedRoute.filter(s => {
                  if (!s) return false;
                  return s.patient_id !== null &&
                    s.store_id === stop.store_id &&
                    s.ampm_deliveries === stop.ampm_deliveries &&
                    optimizedRoute.indexOf(s) < optimizedRoute.indexOf(stop);
                }).length;
                
                const trNumber = String(pickupBaseTR + deliveriesBeforeThis + 1).padStart(2, '0');
                stop.tracking_number = trNumber;
                
                const patient = patients.find(p => p.id === stop.patient_id);
                console.log(`[AddToRoute]     Delivery ${patient?.full_name}: TR#${trNumber} (${stop.status})`);
              } else {
                stop.tracking_number = '99';
                console.warn(`[AddToRoute]     No pickup found for delivery (${mapKey}), using TR#99`);
              }
            }
          }
          
          console.log('\n🏗️ Saving to database...');
          const deliveriesToCreate = [];
          const deliveriesToUpdate = [];
          
          for (let i = 0; i < optimizedRoute.length; i++) {
            const stop = optimizedRoute[i];
            if (!stop) continue; // Defensive check
            
            const stopPatient = patients.find(p => p && p.id === stop.patient_id);
            const stopStore = stores.find(s => s && s.id === stop.store_id);
            
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
          
          console.log(`[AddToRoute]   - Creating ${deliveriesToCreate.length} new stops`);
          console.log(`[AddToRoute]   - Updating ${deliveriesToUpdate.length} existing stops`);
          
          if (deliveriesToCreate.length > 0) {
            deliveriesToCreate.forEach((d, idx) => {
              console.log(`[AddToRoute]     ${idx + 1}. ${d.patient_name || 'Pickup'} - Stop#${d.stop_order}, TR#${d.tracking_number}`);
            });
            await base44.entities.Delivery.bulkCreate(deliveriesToCreate);
            console.log(`[AddToRoute]   ✅ Created ${deliveriesToCreate.length} new deliveries`);
          }
          
          if (deliveriesToUpdate.length > 0) {
            for (const { id, updates } of deliveriesToUpdate) {
              if (!id || !updates) continue;
              await base44.entities.Delivery.update(id, updates);
            }
            console.log(`[AddToRoute]   ✅ Updated ${deliveriesToUpdate.length} existing deliveries`);
          }
          
          console.log('');
          console.log(`[AddToRoute] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
          console.log(`[AddToRoute] ----- Route additions complete for ${driver.user_name} -----`);
          console.log('[AddToRoute] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        }
        
        console.log('');
        console.log('[AddToRoute] ═══════════════════════════════════');
        console.log('[AddToRoute] ✅ BATCH SAVE COMPLETE - All routes processed');
        console.log('[AddToRoute] ═══════════════════════════════════');
        
        invalidate('Delivery');
        await refreshData();
        
        console.log('[AddToRoute] ✅ Data refreshed - new deliveries visible');
        
        // Don't close form - let DeliveryForm handle it
        return;
      }
      
      console.log('');
      console.log('═══════════════════════════════════');
      console.log('🎬 [SAVE DELIVERY] Starting with driver transfer detection');
      console.log('═══════════════════════════════════');

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

      console.log(`📋 Driver: ${driver.user_name}, Date: ${deliveryDate}, Editing: ${isEditing}, Is Pickup: ${isPickup}`);
      console.log(`🔄 Driver Transfer: ${driverWasChanged ? `Yes (${originalDriverId} → ${driverId})` : 'No'}`);

      if (isEditing && driverWasChanged) {
        console.log('');
        console.log('🔄 [DRIVER TRANSFER] Editing with driver change - dual optimization (NO pickup creation)');
        console.log('─────────────────────────────────');

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
        console.log('✏️ EDIT MODE: Updating existing delivery (no driver change) - reordering incomplete stops only');
        await base44.entities.Delivery.update(editingDelivery.id, deliveryData);
        
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
          startingStopOrder = Math.max(...completedDeliveries.map(d => d.stop_order || 0));
        }
        
        // Sort incomplete deliveries by ETA
        const sortedIncomplete = [...incompleteDeliveries].sort((a, b) => {
          if (!a || !b) return 0;
          const etaA = a.delivery_time_eta || a.delivery_time_start || '99:99';
          const etaB = b.delivery_time_eta || b.delivery_time_start || '99:99';
          return etaA.localeCompare(etaB);
        });
        
        console.log(`🔄 Reordering ${sortedIncomplete.length} incomplete stops (starting from stop_order ${startingStopOrder + 1})`);
        
        // Update only incomplete stop orders
        for (let i = 0; i < sortedIncomplete.length; i++) {
          const stop = sortedIncomplete[i];
          if (!stop) continue;
          
          await base44.entities.Delivery.update(stop.id, {
            stop_order: startingStopOrder + i + 1
          });
        }
        
        console.log('✅ Incomplete stop orders updated');
        
        // OPTIMIZED: Only invalidate cache for the specific date instead of all deliveries
        invalidateDeliveriesForDate(deliveryDate);
        await refreshData();

        setShowDeliveryForm(false);
        setEditingDelivery(null);
        return;
      }

      console.log('');
      console.log('🏗️ STEP 1: Get existing deliveries for this driver (NEW delivery only)');
      console.log('─────────────────────────────────');

      const allDeliveriesForDate = (deliveries || []).filter((delivery) => { // Defensive check
        if (!delivery) return false;
        return delivery.delivery_date === deliveryDate;
      });
      const driverDeliveriesForDate = allDeliveriesForDate.filter((delivery) => { // Defensive check
        if (!delivery) return false;
        return delivery.driver_id === driverId;
      });

      console.log(`📊 Existing deliveries on ${deliveryDate}:`);
      console.log(`  - Total for date: ${allDeliveriesForDate.length}`);
      console.log(`  - For this driver: ${driverDeliveriesForDate.length}`);

      console.log('');
      console.log('🏗️ STEP 2: Get assigned stores for driver');
      console.log('─────────────────────────────────');

      const dateObj = new Date(deliveryDate + 'T00:00:00');
      const dayOfWeek = dateObj.getDay();
      const isSaturday = dayOfWeek === 6;
      const isSunday = dayOfWeek === 0;
      const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek];

      console.log(`📅 Day of week: ${dayName} (${dayOfWeek})`);

      const assignedStores = (stores || []).filter((store) => { // Defensive check
        if (!store) return false;
        if (isSaturday) {
          return isDriverAssignedToSlot(store, 'saturday_am') || isDriverAssignedToSlot(store, 'saturday_pm');
        } else if (isSunday) {
          return isDriverAssignedToSlot(store, 'sunday_am') || isDriverAssignedToSlot(store, 'sunday_pm');
        } else {
          return isDriverAssignedToSlot(store, 'weekday_am') || isDriverAssignedToSlot(store, 'weekday_pm');
        }
      });

      console.log(`🏪 Found ${assignedStores.length} assigned stores for driver:`);
      assignedStores.forEach((store, idx) => {
        if (!store) return; // Defensive check
        console.log(`   ${idx + 1}. ${store.name} (${store.abbreviation})`);
      });

      console.log('');
      console.log('🏗️ STEP 3: Build complete stops list (existing + pickups + new)');
      console.log('─────────────────────────────────');

      const stopsToProcess = [];

      console.log(`📦 Adding ${driverDeliveriesForDate.length} existing deliveries:`);
      for (const existingDelivery of driverDeliveriesForDate) {
        if (!existingDelivery) continue; // Defensive check
        
        const enriched = { ...existingDelivery, isNew: false };

        if (existingDelivery.patient_id) {
          const existingPatient = patients.find((p) => p.id === existingDelivery.patient_id);
          if (existingPatient?.latitude && existingPatient?.longitude) {
            enriched.latitude = existingPatient.latitude;
            enriched.longitude = existingPatient.longitude;
          }
          console.log(`   ✅ Delivery: ${existingPatient?.full_name} [${enriched.latitude?.toFixed(7)}, ${enriched.longitude?.toFixed(7)}]`);
        } else {
          const existingStore = stores.find((s) => s.id === existingDelivery.store_id);
          if (existingStore?.latitude && existingStore?.longitude) {
            enriched.latitude = existingStore.latitude;
            enriched.longitude = existingStore.longitude;
          }
          console.log(`   ✅ Pickup: ${existingStore?.name} [${enriched.latitude?.toFixed(7)}, ${enriched.longitude?.toFixed(7)}]`);
        }

        stopsToProcess.push(enriched);
      }

      console.log('');
      console.log('🚛 Checking for pickup stops:');

      const isFirstStop = driverDeliveriesForDate.length === 0;
      const deliveryStore = stores.find((s) => s.id === deliveryData.store_id);

      console.log(`📋 Route Context: ${isFirstStop ? 'FIRST STOP - checking all assigned stores' : `EXISTING ROUTE - checking only ${deliveryStore?.name || 'delivery store'}`}`);

      const storesToCheck = isFirstStop ? assignedStores : (deliveryStore ? [deliveryStore] : []);

      console.log(`🏪 Stores to check for pickups: ${storesToCheck.length}`);

      for (const store of storesToCheck) {
        console.log(`\n  🔍 Checking ${store.name}...`);

        const isAssignedToAM = isSaturday ? isDriverAssignedToSlot(store, 'saturday_am') :
          isSunday ? isDriverAssignedToSlot(store, 'sunday_am') :
            isDriverAssignedToSlot(store, 'weekday_am');

        const isAssignedToPM = isSaturday ? isDriverAssignedToSlot(store, 'saturday_pm') :
          isSunday ? isDriverAssignedToSlot(store, 'sunday_pm') :
            isDriverAssignedToSlot(store, 'weekday_pm');

        console.log(`     Driver assigned to: ${isAssignedToAM ? 'AM' : ''} ${isAssignedToPM ? 'PM' : ''} ${!isAssignedToAM && !isAssignedToPM ? 'NONE' : ''}`);

        if (isAssignedToAM) {
          const existingAMPickup = stopsToProcess.find((delivery) => {
            if (!delivery) return false; // Defensive check
            return delivery.store_id === store.id && !delivery.patient_id && delivery.ampm_deliveries === 'AM';
          });

          if (!existingAMPickup) {
            const amPickupTime = isSaturday ? (store.saturday_am_start || '09:00') :
              isSunday ? (store.sunday_am_start || '09:00') :
                (store.weekday_am_start || '09:00');
            const amPickupEndTime = isSaturday ? (store.saturday_am_end || '12:00') :
              isSunday ? (store.sunday_am_end || '12:00') :
                (store.weekday_am_end || '12:00');

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
            console.log(`     ➕ NEW AM PICKUP: ${store.name} at ${amPickup.delivery_time_start} [${amPickup.latitude?.toFixed(7)}, ${amPickup.longitude?.toFixed(7)}]`);
          } else {
            console.log(`     ✅ Existing AM pickup: ${store.name} (${existingAMPickup.status})`);
          }
        }

        if (isAssignedToPM) {
          const existingPMPickup = stopsToProcess.find((delivery) => {
            if (!delivery) return false; // Defensive check
            return delivery.store_id === store.id && !delivery.patient_id && delivery.ampm_deliveries === 'PM';
          });
          
          if (!existingPMPickup) {
            const pmPickupTime = isSaturday ? (store.saturday_pm_start || '13:00') :
              isSunday ? (store.sunday_pm_start || '13:00') :
                (store.weekday_pm_start || '13:00');
            const pmPickupEndTime = isSaturday ? (store.saturday_pm_end || '17:00') :
              isSunday ? (store.sunday_pm_end || '17:00') :
                (store.weekday_pm_end || '17:00');

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
            console.log(`     ➕ NEW PM PICKUP: ${store.name} at ${pmPickup.delivery_time_start} [${pmPickup.latitude?.toFixed(7)}, ${pmPickup.longitude?.toFixed(7)}]`);
          } else {
            console.log(`     ✅ Existing PM pickup: ${store.name} (${existingPMPickup.status})`);
          }
        }
      }

      if (!isPickup) {
        console.log('');
        console.log('📍 Adding new patient delivery:');
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
        console.log(`   ➕ NEW DELIVERY: ${patient.full_name} from ${deliveryStore.name} [${newDelivery.latitude?.toFixed(7)}, ${newDelivery.longitude?.toFixed(7)}]`);
      } else {
        console.log('');
        console.log('📍 Adding new store pickup:');
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
        console.log(`   ➕ NEW PICKUP: ${pickupStore.name} [${newPickup.latitude?.toFixed(7)}, ${newPickup.longitude?.toFixed(7)}]`);
      }

      console.log('');
      console.log(`📊 Total stops to process: ${stopsToProcess.length}`);
      console.log(`   - New: ${stopsToProcess.filter((s) => s && s.isNew).length}`); // Defensive check
      console.log(`   - Existing: ${stopsToProcess.filter((s) => s && !s.isNew).length}`); // Defensive check

      console.log('');
      console.log('🏗️ STEP 4: Normalize time windows before optimization');
      console.log('─────────────────────────────────');

      for (const stop of stopsToProcess) {
        if (!stop) continue; // Defensive check
        
        if (stop.patient_id !== null) {
          const stopPatient = patients.find((p) => p.id === stop.patient_id);

          if (stopPatient?.time_window_start) {
            stop.delivery_time_start = stopPatient.time_window_start;
            console.log(`   ⏰ Using patient time window start for ${stopPatient?.full_name}: ${stop.delivery_time_start}`);
          } else {
            const correspondingPickup = stopsToProcess.find((s) => {
              if (!s) return false; // Defensive check
              return s.store_id === stop.store_id && s.patient_id === null;
            });
            if (correspondingPickup && correspondingPickup.delivery_time_start) {
              stop.delivery_time_start = addMinutesToTime(correspondingPickup.delivery_time_start, 5);
              console.log(`   ⏰ Using pickup + 5min for ${stopPatient?.full_name}: ${stop.delivery_time_start}`);
            } else {
              stop.delivery_time_start = stop.delivery_time_start || '10:00';
              console.log(`   ⏰ Keeping/default start time for ${stopPatient?.full_name}: ${stop.delivery_time_start}`);
            }
          }

          if (stopPatient?.time_window_end) {
            stop.delivery_time_end = stopPatient.time_window_end;
            console.log(`   ⏰ Using patient time window end for ${stopPatient?.full_name}: ${stop.delivery_time_end}`);
          } else {
            stop.delivery_time_end = '21:00';
            console.log(`   ⏰ Default end time for ${stopPatient?.full_name}: ${stop.delivery_time_end}`);
          }
        }
      }

      console.log('');
      console.log('🏗️ STEP 5: ROUTE ORDERING (AI optimization disabled - manual order)');
      console.log('─────────────────────────────────');

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
      
      console.log('📋 Manual ordering applied (no AI optimization during save)');

      const routeStats = calculateRouteStats(optimizedRoute, stores, patients);
      console.log('📊 Route Statistics:');
      console.log(`   - Total Distance: ${routeStats.totalDistance.toFixed(2)} km`);
      console.log(`   - Estimated Time: ${routeStats.totalTime.toFixed(0)} minutes`);
      console.log(`   - Average Time/Stop: ${routeStats.averageTimePerStop.toFixed(0)} minutes`);
      console.log(`   - Number of Stops: ${routeStats.numberOfStops}`);

      console.log('');
      console.log('📋 FINAL OPTIMIZED ROUTE (pickup-before-delivery enforced during optimization):');
      console.log('─────────────────────────────────');
      optimizedRoute.forEach((stop, index) => {
        if (!stop) return; // Defensive check
        const stopPatient = patients.find((p) => p.id === stop.patient_id);
        const stopStore = stores.find((s) => s.id === stop.store_id);
        const stopName = stop.patient_id ? stopPatient?.full_name : `${stopStore?.name} Pickup`;
        const eta = stop.estimated_arrival || stop.delivery_time_start || 'N/A';
        console.log(`   ${index + 1}) ${stopName} - ETA: ${eta}`);
      });

      console.log('');
      console.log('🏗️ STEP 6: Set final time windows post-optimization');
      console.log('─────────────────────────────────');

      for (const stop of optimizedRoute) {
        if (!stop) continue; // Defensive check
        
        if (stop.patient_id !== null) {
          const stopPatient = patients.find((p) => p.id === stop.patient_id);
          const correspondingPickup = optimizedRoute.find((s) => {
            if (!s) return false; // Defensive check
            return s.store_id === stop.store_id && s.patient_id === null;
          });

          if (stopPatient?.time_window_start) {
            stop.delivery_time_start = stopPatient.time_window_start;
            console.log(`   ⏰ Final start for ${stopPatient?.full_name}: ${stop.delivery_time_start} (patient window)`);
          } else if (correspondingPickup) {
            const pickupStartPlus5 = addMinutesToTime(correspondingPickup.delivery_time_start, 5);
            const pickupETAPlus5 = correspondingPickup.estimated_arrival ?
              addMinutesToTime(correspondingPickup.estimated_arrival, 5) :
              null;

            if (pickupETAPlus5 && pickupETAPlus5 > pickupStartPlus5) {
              stop.delivery_time_start = pickupETAPlus5;
              console.log(`   ⏰ Final start for ${stopPatient?.full_name}: ${stop.delivery_time_start} (pickup ETA + 5min)`);
            } else if (pickupStartPlus5) {
              stop.delivery_time_start = pickupStartPlus5;
              console.log(`   ⏰ Final start for ${stopPatient?.full_name}: ${stop.delivery_time_start} (pickup start + 5min)`);
            }
          }

          if (stopPatient?.time_window_end) {
            stop.delivery_time_end = stopPatient.time_window_end;
            console.log(`   ⏰ Final end for ${stopPatient?.full_name}: ${stop.delivery_time_end} (patient window)`);
          } else {
            stop.delivery_time_end = stop.delivery_time_start ? addMinutesToTime(stop.delivery_time_start, 60) : '21:00';
            console.log(`   ⏰ Final end for ${stopPatient?.full_name}: ${stop.delivery_time_end} (start + 60min or default)`);
          }
        }
      }

      console.log('');
      console.log('🏗️ STEP 7: Determine AM/PM from pickup times');
      console.log('─────────────────────────────────');

      const storeAMPMMap = {};
      for (const stop of optimizedRoute) {
        if (!stop) continue; // Defensive check
        
        if (stop.patient_id === null && stop.delivery_time_start) {
          const ampm = determineAMPMFromTime(stop.delivery_time_start);
          storeAMPMMap[stop.store_id] = ampm;

          const stopStore = stores.find((s) => s.id === stop.store_id);
          console.log(`   🏪 Pickup ${stopStore?.name}: ${stop.delivery_time_start} → ${ampm}`);
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
        console.log(`   📍 ${stopName}: ${stop.ampm_deliveries}`);
      }

      console.log('');
      console.log('🏗️ STEP 8: Assign TR# (00, 20, 40... for pickups)');
      console.log('─────────────────────────────────');

      let pickupTRCounter = 0;
      const storePickupTRMap = {};

      for (const stop of optimizedRoute) {
        if (!stop) continue; // Defensive check
        
        if (stop.patient_id === null) {
          const trNumber = String(pickupTRCounter).padStart(2, '0');
          stop.tracking_number = trNumber;
          storePickupTRMap[stop.store_id] = pickupTRCounter;

          const stopStore = stores.find((s) => s.id === stop.store_id);
          console.log(`   🚛 Pickup TR# assigned: ${stopStore?.name} -> TR#${trNumber}`);

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
            console.log(`   📦 Delivery TR# assigned: ${stopPatient?.full_name} -> TR#${trNumber}`);
          } else {
            stop.tracking_number = '99';
            console.warn(`   ⚠️ No pickup found for delivery, using TR#99`);
          }
        }
      }

      console.log('');
      console.log('🏗️ STEP 9: Assign stop_order, SID, and save to database');
      console.log('─────────────────────────────────');

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

        console.log(`   ${i + 1}. ${stopName} (SID: ${stop.stop_id}, TR#: ${stop.tracking_number}, ETA: ${stop.estimated_arrival || stop.delivery_time_start}, ${stop.ampm_deliveries})`);

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
          // CRITICAL: Only update TR# for existing stops during single delivery save if:
          // 1. This is a NEW stop (doesn't have a TR# yet), OR
          // 2. Manual admin edit (handled separately in DeliveryForm)
          // NEVER auto-update TR# for existing stops with TR#s during route optimization
          const updatePayload = {
            stop_id: payload.stop_id,
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

      console.log('');
      console.log('🏗️ STEP 10: Update UI');
      console.log('─────────────────────────────────');

      invalidate('Delivery');
      await refreshData();
      setScrollToNextCardAfter(deliveryId);
      
      hasAutoSelectedRef.current = false; // Reset to allow auto-selection after saving

      setShowDeliveryForm(false);
      setEditingDelivery(null);

      console.log('');
      console.log('═══════════════════════════════════');
      console.log('✅ Route optimization complete!');
      console.log(`   - Created: ${createdCount} new stops`);
      console.log(`   - Updated: ${updatedCount} existing stops`);
      console.log(`   - Total route: ${optimizedRoute.length} stops`);
      console.log(`   - Total distance: ${routeStats.totalDistance.toFixed(2)} km`);
      console.log(`   - Total time: ${routeStats.totalTime.toFixed(0)} minutes`);
      console.log('═══════════════════════════════════');
      console.log('');

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

      console.log('');
      console.log('═══════════════════════════════════');
      console.log('🔄 [REOPTIMIZE] Starting route optimization with built-in constraints');
      console.log('═══════════════════════════════════');

      const deliveryDate = format(selectedDate, 'yyyy-MM-dd');

      const today = startOfDay(new Date());
      const selected = startOfDay(selectedDate);
      const isPastDate = selected < today;
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      
      let isDateFinished = false;
      
      console.log('🏗️ STEP 1: Fetching latest data from database');
      console.log('─────────────────────────────────');

      const [latestDeliveries, latestPatients, latestStores, latestAppUsers, latestAuthUsers] = await Promise.all([
        base44.entities.Delivery.filter({ delivery_date: deliveryDate }),
        base44.entities.Patient.list(),
        base44.entities.Store.list(),
        base44.entities.AppUser.list(),
        base44.entities.User.list()]
      );

      console.log(`✅ Fetched ${latestDeliveries.length} deliveries, ${latestPatients.length} patients, ${latestStores.length} stores`);

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

      console.log(`✅ Merged ${allMergedUsers.length} users`);

      isDateFinished = isPastDate && 
                       latestDeliveries.length > 0 && 
                       latestDeliveries.every((d) => d && finishedStatuses.includes(d.status)); // Defensive check

      if (isDateFinished) {
        console.log('⚠️ Past finished date detected - data refresh only, skipping optimization');
        setOptimizationMessage("Refreshing data for past date...");
        
        invalidate('Delivery');
        await refreshData();

        console.log('⏭️ Skipping all optimization logic for past finished date');
        console.log('✅ Screen refreshed (past date - no optimization)');

        setOptimizationMessage("Data refreshed for past date...");
        setTimeout(() => setOptimizationMessage(null), 3000);
        setIsOptimizing(false);
        return;
      }

      console.log('');
      console.log('🏗️ STEP 2: Identifying drivers for optimization');
      console.log('─────────────────────────────────');

      let driversToOptimize = [];

      if (selectedDriverId === 'all') {
        const uniqueDriverIds = [...new Set(
          (latestDeliveries || [])
            .filter((d) => d && !finishedStatuses.includes(d.status)) // Defensive check
            .map((d) => d && d.driver_id) // Defensive check
            .filter(Boolean)
        )];

        driversToOptimize = uniqueDriverIds
          .map((driverId) => (allMergedUsers || []).find((u) => u && u.id === driverId)) // Defensive check
          .filter(Boolean);

        console.log(`📊 All Drivers mode: Found ${driversToOptimize.length} drivers with active deliveries`);
      } else {
        const selectedDriver = (allMergedUsers || []).find((u) => u && u.id === selectedDriverId); // Defensive check
        if (selectedDriver) {
          driversToOptimize = [selectedDriver];
          console.log(`📊 Single driver mode: ${selectedDriver.user_name || selectedDriver.full_name}`);
        }
      }

      if (driversToOptimize.length === 0) {
        console.log('⚠️ No drivers with active deliveries found');
        setOptimizationMessage("No active routes to optimize.");
        setTimeout(() => setOptimizationMessage(null), 3000);
        invalidate('Delivery');
        await refreshData();
        setIsOptimizing(false);
        return;
      }

      console.log('');
      console.log('🏗️ STEP 3: Applying role-based optimization rules');
      console.log('─────────────────────────────────');
      console.log(`👤 Current User: ${currentUser.user_name || currentUser.full_name}`);
      console.log(`🎭 Roles: ${currentUser.app_roles?.join(', ') || 'none'}`);
      console.log(`👑 Is App Owner: ${isAppOwner(currentUser)}`);

      let shouldOptimize = false;

      if (isAppOwner(currentUser)) {
        shouldOptimize = true;
        console.log('✅ RULE 1: App Owner - Full optimization of all selected drivers');
        setOptimizationMessage(`App Owner: Optimizing ${driversToOptimize.length} driver route(s)...`);
      } else
        if (userHasRole(currentUser, 'admin')) {
          if (selectedDriverId !== 'all' && selectedDriverId !== currentUser.id) {
            shouldOptimize = false;
            console.log('✅ RULE 2: Admin viewing other driver - Data refresh only');
            setOptimizationMessage("Admin: Refreshing data for selected driver...");
          } else {
            shouldOptimize = true;
            console.log('✅ RULE 2: Admin viewing own route or all - Full optimization');
            setOptimizationMessage(`Admin: Optimizing ${driversToOptimize.length} driver route(s)...`);
          }
        } else
          if (userHasRole(currentUser, 'driver')) {
            if (selectedDriverId === 'all' || selectedDriverId !== currentUser.id) {
              shouldOptimize = false;
              console.log('✅ RULE 3: Driver viewing others - Data refresh only');
              setOptimizationMessage("Driver: Data refreshed. Only your route can be optimized.");
            } else {
              shouldOptimize = true;
              console.log('✅ RULE 3: Driver viewing own route - Full optimization');
              setOptimizationMessage("Driver: Optimizing your route...");
            }
          } else
            if (userHasRole(currentUser, 'dispatcher')) {
              shouldOptimize = false;
              console.log('✅ RULE 4: Dispatcher - Data refresh only');
              setOptimizationMessage("Dispatcher: Refreshing data...");
            }

      if (shouldOptimize) {
        console.log('');
        console.log('🏗️ STEP 4: Starting optimization loop');
        console.log('─────────────────────────────────');

        let totalUpdated = 0;
        let totalDistance = 0;
        let totalTime = 0;

        for (const driver of driversToOptimize) {
          console.log(`\n🚗 Processing driver: ${driver.user_name || driver.full_name}`);

          if (driver.home_latitude && driver.home_longitude) {
            console.log(`🏠 Driver home: [${driver.home_latitude.toFixed(7)}, ${driver.home_longitude.toFixed(7)}]`);
          } else {
            console.log(`⚠️ Driver home location not set`);
          }

          setOptimizationMessage(`Calculating optimal route for ${driver.user_name || driver.full_name}...`);

          const driverDeliveries = (latestDeliveries || []).filter((d) => d && d.driver_id === driver.id); // Defensive check
          const activeDeliveries = driverDeliveries.filter((d) => d && !finishedStatuses.includes(d.status)); // Defensive check

          console.log(`📦 Active deliveries: ${activeDeliveries.length}`);

          if (activeDeliveries.length === 0) {
            console.log('⏭️ No active deliveries, skipping...');
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
            console.log(`🚛 Route has started (${completedStops.length} completed, ${inTransitStops.length} in-transit)`);

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
                console.log(`   ✅ Using driver's current location (${Math.round(locationAge / 1000)}s old)`);
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
                console.log(`   ✅ Using last completed stop location at ${startTime}`);
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
                console.log(`   ✅ Using first active stop at ${startTime}`);
              }
            }
          } else {
            // Route hasn't started - use first stop or driver home
            console.log(`🏁 Route not started yet`);

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
              console.log(`   ✅ Using first stop at ${startTime}`);
            }

            // Fallback to driver home if no stops have coordinates
            if (!startLocation) {
              const driverHomeLocation = (allMergedUsers || []).find((u) => u && u.id === driver.id);
              if (driverHomeLocation?.home_latitude && driverHomeLocation?.home_longitude) {
                startLocation = { lat: driverHomeLocation.home_latitude, lon: driverHomeLocation.home_longitude };
                startTime = format(new Date(), 'HH:mm');
                startSource = 'driver_home';
                console.log(`   ✅ Using driver home at ${startTime}`);
              }
            }
          }

          if (startLocation) {
            console.log(`📍 Starting: ${startLocation.lat.toFixed(7)}, ${startLocation.lon.toFixed(7)} at ${startTime} (${startSource})`);
          }

          console.log('');
          console.log('🏗️ STEP 4a: Normalize time windows before optimization');
          console.log('─────────────────────────────────');

          for (const stop of activeDeliveries) {
            if (!stop) continue; // Defensive check
            
            if (stop.patient_id !== null) {
              const stopPatient = latestPatients.find((p) => p.id === stop.patient_id);

              if (stopPatient?.time_window_start) {
                stop.delivery_time_start = stopPatient.time_window_start;
                console.log(`   ⏰ Using patient time window start for ${stopPatient?.full_name}: ${stop.delivery_time_start}`);
              } else {
                const correspondingPickup = activeDeliveries.find((s) => {
                  if (!s) return false; // Defensive check
                  return s.store_id === stop.store_id && s.patient_id === null;
                });
                if (correspondingPickup && correspondingPickup.delivery_time_start) {
                  stop.delivery_time_start = addMinutesToTime(correspondingPickup.delivery_time_start, 5);
                  console.log(`   ⏰ Using pickup + 5min for ${stopPatient?.full_name}: ${stop.delivery_time_start}`);
                } else {
                  stop.delivery_time_start = stop.delivery_time_start || '10:00';
                  console.log(`   ⏰ Keeping/default start time for ${stopPatient?.full_name}: ${stop.delivery_time_start}`);
                }
              }

              if (stopPatient?.time_window_end) {
                stop.delivery_time_end = stopPatient.time_window_end;
                console.log(`   ⏰ Using patient time window end for ${stopPatient?.full_name}: ${stop.delivery_time_end}`);
              } else {
                stop.delivery_time_end = '21:00';
                console.log(`   ⏰ Default end time for ${stopPatient?.full_name}: ${stop.delivery_time_end}`);
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
          console.log(`📊 Stats: ${routeStats.totalDistance.toFixed(1)} km, ${routeStats.totalTime} min`);

          totalDistance += routeStats.totalDistance;
          totalTime += routeStats.totalTime;

          console.log('');
          console.log('📋 FINAL OPTIMIZED ROUTE (pickup-before-delivery built-in):');
          console.log('─────────────────────────────────');
          optimizedRoute.forEach((stop, index) => {
            if (!stop) return; // Defensive check
            const stopPatient = latestPatients.find((p) => p && p.id === stop.patient_id);
            const stopStore = latestStores.find((s) => s && s.id === stop.store_id);
            const stopName = stop.patient_id ? stopPatient?.full_name : `${stopStore?.name} Pickup`;
            const eta = stop.estimated_arrival || stop.delivery_time_start || 'N/A';
            console.log(`   ${index + 1}) ${stopName} - ETA: ${eta}`);
          });

          console.log('');
          console.log('🏗️ STEP 4b: Set final time windows post-optimization');
          console.log('─────────────────────────────────');

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
                console.log(`   ⏰ Final start for ${stopPatient?.full_name}: ${stop.delivery_time_start} (patient window)`);
              } else if (correspondingPickup) {
                const pickupStartPlus5 = addMinutesToTime(correspondingPickup.delivery_time_start, 5);
                const pickupETAPlus5 = correspondingPickup.estimated_arrival ?
                  addMinutesToTime(correspondingPickup.estimated_arrival, 5) :
                  null;

                if (pickupETAPlus5 && pickupETAPlus5 > pickupStartPlus5) {
                  stop.delivery_time_start = pickupETAPlus5;
                  console.log(`   ⏰ Final start for ${stopPatient?.full_name}: ${stop.delivery_time_start} (pickup ETA + 5min)`);
                } else if (pickupStartPlus5) {
                  stop.delivery_time_start = pickupStartPlus5;
                  console.log(`   ⏰ Final start for ${stopPatient?.full_name}: ${stop.delivery_time_start} (pickup start + 5min)`);
                }
              }

              if (stopPatient?.time_window_end) {
                stop.delivery_time_end = stopPatient.time_window_end;
                console.log(`   ⏰ Final end for ${stopPatient?.full_name}: ${stop.delivery_time_end} (patient window)`);
              } else {
                stop.delivery_time_end = stop.delivery_time_start ? addMinutesToTime(stop.delivery_time_start, 60) : '21:00';
                console.log(`   ⏰ Final end for ${stopPatient?.full_name}: ${stop.delivery_time_end} (start + 60min or default)`);
              }
            }
          }

          console.log('');
          console.log('🏗️ STEP 4c: Determine AM/PM from pickup times');
          console.log('─────────────────────────────────');

          const storeAMPMMap = {};
          for (const stop of optimizedRoute) {
            if (!stop) continue; // Defensive check
            
            if (stop.patient_id === null && stop.delivery_time_start) {
              const ampm = determineAMPMFromTime(stop.delivery_time_start);
              storeAMPMMap[stop.store_id] = ampm;

              const stopStore = latestStores.find((s) => s.id === stop.store_id);
              console.log(`   🏪 Pickup ${stopStore?.name}: ${stop.delivery_time_start} → ${ampm}`);
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
            console.log(`   📍 ${stopName}: ${stop.ampm_deliveries}`);
          }

          console.log('');
          console.log('🏗️ STEP 4d: Generate TR# for active stops');
          console.log('─────────────────────────────────');

          const lockedStatuses = ['in_transit', 'completed', 'failed', 'cancelled', 'returned'];

          let pickupTRCounter = 0;
          const storePickupTRMap = {};

          for (const stop of optimizedRoute) {
            if (!stop) continue; // Defensive check
            
            if (stop.patient_id === null) {
              if (lockedStatuses.includes(stop.status)) {
                console.log(`   🔒 Pickup TR# locked: ${latestStores.find((s) => s.id === stop.store_id)?.name} -> TR#${stop.tracking_number} (${stop.status})`);
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
                console.log(`   🚛 Pickup TR# assigned: ${stopStore?.name} -> TR#${trNumber}`);

                pickupTRCounter += 20;
              }
            }
          }

          for (const stop of optimizedRoute) {
            if (!stop) continue; // Defensive check
            
            if (stop.patient_id !== null) {
              if (lockedStatuses.includes(stop.status)) {
                const stopPatient = latestPatients.find((p) => p.id === stop.patient_id);
                console.log(`   🔒 Delivery TR# locked: ${stopPatient?.full_name} -> TR#${stop.tracking_number} (${stop.status})`);
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
                  console.log(`   📦 Delivery TR# assigned: ${stopPatient?.full_name} -> TR#${trNumber}`);
                } else {
                  stop.tracking_number = stop.tracking_number || '99';
                  console.warn(`   ⚠️ No pickup found for delivery, keeping/using TR#${stop.tracking_number}`);
                }
              }
            }
          }

          console.log('');
          console.log('🏗️ STEP 4e: Updating database with optimized data');
          console.log('─────────────────────────────────');

          setOptimizationMessage(`Updating database for ${driver.user_name || driver.full_name}...`);

          console.log('');
          console.log('🏗️ STEP 4f: Creating final sequential stop order (completed + incomplete)');
          console.log('─────────────────────────────────');

          const completedDeliveries = driverDeliveries.filter((d) => d && finishedStatuses.includes(d.status));

          const sortedCompleted = [...completedDeliveries].sort((a, b) => {
            if (!a || !b) return 0; // Defensive check
            return new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time);
          });

          console.log(`📊 Driver has ${sortedCompleted.length} completed stops to preserve order`);

          const finalSortedRoute = [...sortedCompleted, ...optimizedRoute];

          console.log('📋 Final sequential route order:');
          finalSortedRoute.forEach((stop, idx) => {
            if (!stop) return; // Defensive check
            const stopPatient = latestPatients.find((p) => p && p.id === stop.patient_id);
            const stopStore = latestStores.find((s) => s && s.id === stop.store_id);
            const stopName = stop.patient_id ? stopPatient?.full_name : `${stopStore?.name} Pickup`;
            const isComplete = finishedStatuses.includes(stop.status);
            console.log(`   #${idx + 1}. ${stopName} - ${isComplete ? `✅ Done` : `⏰ ETA: ${stop.estimated_arrival || stop.delivery_time_start}`}`);
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

              await base44.entities.Delivery.update(stop.id, updatePayload);
            totalUpdated++;

            const stopName = stop.patient_id ?
              latestPatients.find((p) => p.id === stop.patient_id)?.full_name :
              latestStores.find((s) => s.id === stop.store_id)?.name + ' Pickup';
            console.log(`   ✅ Updated stop #${sequentialStopOrder}: ${stopName}`);
          }

          console.log(`✅ Updated ${finalSortedRoute.length} stops for ${driver.user_name || driver.full_name} (sequential #1 to #${finalSortedRoute.length})`);
        }

        console.log('');
        console.log('═══════════════════════════════════');
        console.log('✅ Optimization complete!');
        console.log(`   - Drivers processed: ${driversToOptimize.length}`);
        console.log(`   - Total stops updated: ${totalUpdated}`);
        console.log(`   - Total distance: ${totalDistance.toFixed(1)} km`);
        console.log(`   - Total time: ${totalTime} minutes`);
        console.log('═══════════════════════════════════');

        setOptimizationMessage(`Successfully optimized ${driversToOptimize.length} route(s)!`);
      } else {
        console.log('');
        console.log('⏭️ Skipping optimization, data refresh only');
      }

      console.log('');
      console.log('🏗️ STEP 5: Refreshing screen');
      console.log('─────────────────────────────────');

      invalidate('Delivery');
      await refreshData();
      setScrollToNextCardAfter(deliveryId);
      
      hasAutoSelectedRef.current = false; // Reset to allow auto-selection after refresh

      console.log('✅ Screen refreshed');
      console.log('');

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
      setScrollToNextCardAfter(deliveryId);
    } finally {
      setIsOptimizing(false);
    }
  };

  const handleDualDriverOptimization = async (originalDriverId, newDriverId, deliveryDate) => {
    console.log('');
    console.log('═══════════════════════════════════');
    console.log('🔄 [DUAL OPTIMIZATION] Starting for both drivers');
    console.log('═══════════════════════════════════');

    const driversToOptimize = [originalDriverId, newDriverId].filter(Boolean);

    for (const driverId of driversToOptimize) {
      const driver = drivers.find((d) => d && d.id === driverId);
      if (!driver) continue;

      console.log(`\n🚗 Optimizing route for: ${driver.user_name || driver.full_name}`);

      const driverDeliveries = await base44.entities.Delivery.filter({
        delivery_date: deliveryDate,
        driver_id: driverId
      });

      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

      const completedDeliveries = (driverDeliveries || []).filter((d) => d && finishedStatuses.includes(d.status)); // Defensive check
      const incompleteDeliveries = (driverDeliveries || []).filter((d) => d && !finishedStatuses.includes(d.status)); // Defensive check

      console.log(`📊 Completed: ${completedDeliveries.length}, Incomplete: ${incompleteDeliveries.length}`);


      if (incompleteDeliveries.length === 0) {
        console.log('⏭️ No incomplete deliveries, skipping optimization for remaining stops');

        if (completedDeliveries.length > 0) {
          const sortedCompleted = [...completedDeliveries].sort((a, b) => {
            if (!a || !b) return 0; // Defensive check
            return new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time);
          });
          for (let i = 0; i < sortedCompleted.length; i++) {
            const stop = sortedCompleted[i];
            if (!stop) continue; // Defensive check
            await base44.entities.Delivery.update(stop.id, { stop_order: i + 1 });
            const stopName = stop.patient_id ?
              patients.find((p) => p && p.id === stop.patient_id)?.full_name :
              stores.find((s) => s && s.id === stop.store_id)?.name + ' Pickup'; // Fixed: store.id should be stop.store_id
            console.log(`   ✅ Updated completed stop #${i + 1}: ${stopName}`);
          }
          console.log(`✅ Updated ${sortedCompleted.length} completed stops for ${driver.user_name}`);
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
        return new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time);
      });

      const finalSortedRoute = [...sortedCompleted, ...optimizedRoute];

      console.log('📋 Final sequential route order for dual optimization:');
      finalSortedRoute.forEach((stop, idx) => {
        if (!stop) return; // Defensive check
        const stopPatient = patients.find((p) => p && p.id === stop.patient_id);
        const stopStore = stores.find((s) => s && s.id === stop.store_id);
        const stopName = stop.patient_id ? stopPatient?.full_name : `${stopStore?.name} Pickup`;
        const isComplete = finishedStatuses.includes(stop.status);
        console.log(`   #${idx + 1}. ${stopName} - ${isComplete ? `✅ Done at ${format(new Date(stop.actual_delivery_time), 'HH:mm')}` : `⏰ ETA: ${stop.estimated_arrival || stop.delivery_time_start}`}`);
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

        await base44.entities.Delivery.update(stop.id, updatePayload);

        const stopName = stop.patient_id ?
          patients.find((p) => p.id === stop.patient_id)?.full_name :
          stores.find((s) => s.id === stop.store_id)?.name + ' Pickup';
        console.log(`   ✅ Updated stop #${sequentialStopOrder}: ${stopName}`);
      }

      console.log(`✅ Updated ${finalSortedRoute.length} stops for ${driver.user_name} (sequential #1 to #${finalSortedRoute.length})`);
    }

    console.log('');
    console.log('═══════════════════════════════════');
    console.log('✅ Dual optimization complete!');
    console.log('═══════════════════════════════════');
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
      await base44.entities.Delivery.delete(deliveryId);
      invalidate('Delivery');
      await refreshData();
      setScrollToNextCardAfter(deliveryId);

      if (selectedCardId === deliveryId) {
        setSelectedCardId(null);
      }
    } catch (error) {
      console.error('Error deleting delivery:', error);
      alert('Failed to delete delivery. Please try again.');
    }
  };

  const handleRestartDelivery = async (deliveryId) => {
    try {
      console.log('🔄 [RESTART DELIVERY] Starting restart process');
      
      // Get original delivery from state
      const originalDelivery = deliveriesWithStopOrder.find((d) => d && d.id === deliveryId);
      if (!originalDelivery) {
        throw new Error('Delivery not found');
      }
      
      console.log(`📦 Original delivery: ${originalDelivery.patient_name || 'Store Pickup'}`);
      console.log(`📅 Original date: ${originalDelivery.delivery_date}`);
      
      // IMPORTANT: Restart now just resets status to pending on the SAME delivery
      // It does NOT duplicate or change date - that's handled by Retry button for failed deliveries
      await base44.entities.Delivery.update(deliveryId, {
        status: 'pending',
        actual_delivery_time: null,
        delivery_notes: ''
      });

      invalidate('Delivery');
      await refreshData();
      setScrollToNextCardAfter(deliveryId);
      
      console.log('✅ [RESTART DELIVERY] Complete');
    } catch (error) {
      console.error('Error restarting delivery:', error);
      alert('Failed to restart delivery. Please try again.');
    }
  };

  const handleStatusUpdate = async (deliveryId, newStatus, extraData = {}, skipAutoCenter = false) => {
    try {
      console.log('');
      console.log('═══════════════════════════════════');
      console.log('✅ [STATUS UPDATE] Starting status update logic');
      console.log('═══════════════════════════════════');

      const targetDelivery = deliveriesWithStopOrder.find((d) => d && d.id === deliveryId);
      if (!targetDelivery) {
        throw new Error('Delivery not found');
      }
      
      // Store current map view phase BEFORE any async operations
      const savedMapViewPhase = mapViewPhase;

      // CRITICAL: Check if this is a retry of a failed delivery
      const currentDate = format(new Date(), 'yyyy-MM-dd');
      const isPickup = !targetDelivery.patient_id;
      const isRetry = targetDelivery.status === 'failed' && (newStatus === 'in_transit' || newStatus === 'en_route');

      if (isRetry) {
        // ALWAYS duplicate a failed delivery when retrying - regardless of date
        console.log('🔄 [RETRY DELIVERY] Creating duplicate delivery for today');
        console.log(`   Original date: ${targetDelivery.delivery_date} → New date: ${currentDate}`);

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
        await base44.entities.Delivery.create(retryDeliveryData);
        console.log('✅ [RETRY DELIVERY] Duplicate delivery created for today');

        // Call backend optimizer for today's route
        try {
          await optimizeDriverRoute({
            driverId: targetDelivery.driver_id,
            deliveryDate: currentDate,
            currentLocation: driverLocation ? {
              lat: driverLocation.latitude,
              lon: driverLocation.longitude
            } : null,
            clientCurrentTime: format(new Date(), 'HH:mm') // Send device's current time
          });
          console.log('✅ [RETRY DELIVERY] Backend optimizer called for today');
        } catch (optError) {
          console.warn('⚠️ [RETRY DELIVERY] Backend optimizer failed:', optError.message);
        }

        // Invalidate caches for both the original date and today
        invalidateDeliveriesForDate(targetDelivery.delivery_date);
        invalidateDeliveriesForDate(currentDate);
        invalidate('Delivery');
        await refreshData();
        return;
      }

      const driverId = targetDelivery.driver_id;
      const deliveryDate = targetDelivery.delivery_date;
      const currentTime = new Date();
      const currentTimeISO = currentTime.toISOString();
      const currentTimeHHMM = format(currentTime, 'HH:mm');

      console.log(`📦 Updating: ${targetDelivery.patient_name || 'Store Pickup'}`);
      console.log(`⏰ Update time (ISO): ${currentTimeISO}`);
      console.log(`⏰ Update time (HH:mm): ${currentTimeHHMM}`);
      console.log(`🚗 Driver: ${targetDelivery.driver_name}`);
      console.log(`#️⃣ Stop Order: ${targetDelivery.stop_order}`);

      const updateData = { status: newStatus, ...extraData };

      if (['completed', 'failed', 'delivered'].includes(newStatus)) {
        updateData.actual_delivery_time = currentTimeISO;
      } else {
        updateData.actual_delivery_time = null;
      }

      console.log('');
      console.log('🏗️ STEP 1: Updating delivery status');
      await base44.entities.Delivery.update(deliveryId, updateData);
      console.log('✅ Delivery status updated');
      
      // STEP 1.5: Update patient's last_delivery_date if completed or failed
      if (['completed', 'failed'].includes(newStatus) && targetDelivery.patient_id) {
        console.log('🗓️ Updating patient last_delivery_date to', targetDelivery.delivery_date);
        try {
          await base44.entities.Patient.update(targetDelivery.patient_id, {
            last_delivery_date: targetDelivery.delivery_date
          });
          console.log('✅ Patient last_delivery_date updated');
        } catch (error) {
          console.error('❌ Failed to update patient last_delivery_date:', error);
        }
      }

      // CRITICAL: Recalculate ETAs for remaining stops when ANY delivery is finished
      const finishedStatusesTrigger = ['completed', 'failed', 'cancelled', 'returned'];
      if (finishedStatusesTrigger.includes(newStatus) && driverId) {
        console.log('');
        console.log('🏗️ STEP 2: Calling backend route optimizer for ETA recalculation + next stop selection');

        // Use backend function for route optimization (faster, server-side)
        // The optimizer will automatically determine and set the next best stop based on distance/time
        try {
          const optimizationResult = await optimizeDriverRoute({
            driverId: driverId,
            deliveryDate: deliveryDate,
            currentLocation: driverLocation ? {
              lat: driverLocation.latitude,
              lon: driverLocation.longitude
            } : null,
            completedDeliveryId: deliveryId,
            clientCurrentTime: format(new Date(), 'HH:mm'), // Send device's current time
            generatePolyline: true, // Generate polyline on complete
            selectNextStop: true // NEW: Tell optimizer to select next best stop
          });
          
          console.log('✅ Backend optimization result:', optimizationResult.data);

          // Refresh polyline count after backend optimization
          fetchPolylineCount();

          if (optimizationResult.data?.routeComplete) {
            console.log('✅ Route complete - no more stops');
            invalidate('Delivery');
            await refreshData();
            
            // Show route summary modal only for completed status
            if (newStatus === 'completed' && !hasShownSummaryRef.current) {
              setShowRouteSummary(true);
              hasShownSummaryRef.current = true;
            }
            
            return;
          }
        } catch (backendError) {
          console.warn('⚠️ Backend optimization failed, falling back to frontend:', backendError.message);
          
          // Fallback to frontend optimization if backend fails
          const freshDeliveries = await base44.entities.Delivery.filter({
            delivery_date: deliveryDate,
            driver_id: driverId
          });

          const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
          const completedDeliveries = freshDeliveries.filter((d) => d && finishedStatuses.includes(d.status));
          const incompleteDeliveries = freshDeliveries.filter((d) => d && !finishedStatuses.includes(d.status));

          if (incompleteDeliveries.length === 0) {
            invalidate('Delivery');
            await refreshData();
            if (!hasShownSummaryRef.current) {
              setShowRouteSummary(true);
              hasShownSummaryRef.current = true;
            }
            return;
          }

          // Simple ETA recalculation for fallback
          const sortedCompleted = [...completedDeliveries].sort((a, b) => 
            new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time)
          );
          
          let startLocation = null;
          if (sortedCompleted.length > 0) {
            const lastCompleted = sortedCompleted[sortedCompleted.length - 1];
            if (lastCompleted.patient_id) {
              const patient = patients.find((p) => p.id === lastCompleted.patient_id);
              if (patient?.latitude && patient?.longitude) {
                startLocation = { lat: patient.latitude, lon: patient.longitude };
              }
            } else if (lastCompleted.store_id) {
              const store = stores.find((s) => s.id === lastCompleted.store_id);
              if (store?.latitude && store?.longitude) {
                startLocation = { lat: store.latitude, lon: store.longitude };
              }
            }
          }
          
          // Recalculate ETAs
          const enrichedIncomplete = incompleteDeliveries.map((delivery) => {
            if (!delivery) return null;
            const enriched = { ...delivery };
            if (delivery.patient_id) {
              const patient = patients.find((p) => p && p.id === delivery.patient_id);
              if (patient?.latitude && patient?.longitude) {
                enriched.latitude = patient.latitude;
                enriched.longitude = patient.longitude;
              }
            } else {
              const store = stores.find((s) => s && s.id === delivery.store_id);
              if (store?.latitude && store?.longitude) {
                enriched.latitude = store.latitude;
                enriched.longitude = store.longitude;
              }
            }
            return enriched;
          }).filter((d) => d && d.latitude && d.longitude);

          enrichedIncomplete.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));

          if (startLocation) {
            let currentLat = startLocation.lat;
            let currentLon = startLocation.lon;
            let currentTimeMinutes = new Date().getHours() * 60 + new Date().getMinutes();

            for (const stop of enrichedIncomplete) {
              const distance = calculateDistance(currentLat, currentLon, stop.latitude, stop.longitude);
              const travelTime = Math.ceil(distance * 2);
              const stopTime = stop.extra_time || 5;
              
              currentTimeMinutes += travelTime + stopTime;
              const etaHours = Math.floor(currentTimeMinutes / 60) % 24;
              const etaMins = currentTimeMinutes % 60;
              stop.delivery_time_eta = `${String(etaHours).padStart(2, '0')}:${String(etaMins).padStart(2, '0')}`;
              
              currentLat = stop.latitude;
              currentLon = stop.longitude;
            }
          }

          const finalSortedRoute = [...sortedCompleted, ...enrichedIncomplete];
          for (let i = 0; i < finalSortedRoute.length; i++) {
            const stop = finalSortedRoute[i];
            if (!stop) continue;
            const updatePayload = { stop_order: i + 1 };
            if (!finishedStatuses.includes(stop.status)) {
              updatePayload.delivery_time_eta = stop.delivery_time_eta || stop.delivery_time_start;
            }
            await base44.entities.Delivery.update(stop.id, updatePayload);
          }
        }

        console.log('');
        console.log('═══════════════════════════════════');
        console.log('✅ Completion logic complete!');
        console.log('═══════════════════════════════════');
      }

      invalidate('Delivery');
      await refreshData();
      
      if (!skipAutoCenter) {
        setScrollToNextCardAfter(deliveryId);
        hasAutoSelectedRef.current = false; // Reset to allow auto-selection after status update
      }
      
      // Note: Don't re-trigger map view after status update - let user control via FAB
    } catch (error) {
      console.error('');
      console.error('❌❌❌ ERROR ❌❌❌');
      console.error('Error updating delivery status:', error);
      console.error('Stack trace:', error.stack);
      console.error('');
      alert('Failed to update delivery status. Please try again.');
    }
  };

  const handleNotesUpdate = async (deliveryId, notes) => {
    try {
      await base44.entities.Delivery.update(deliveryId, {
        delivery_notes: notes
      });

      invalidate('Delivery');
      await refreshData();
      setScrollToNextCardAfter(deliveryId);
    } catch (error) {
      console.error('Error updating delivery notes:', error);
      alert('Failed to update notes. Please try again.');
    }
  };

  const handleCODUpdate = async (deliveryId, codPayments, skipAutoCenter = false) => {
    try {
      await base44.entities.Delivery.update(deliveryId, {
        cod_payments: codPayments
      });

      invalidate('Delivery');
      await refreshData();
      
      // Only trigger auto-center if not skipped (e.g., COD save should NOT auto-center)
      if (!skipAutoCenter) {
        setScrollToNextCardAfter(deliveryId);
      }
    } catch (error) {
      console.error('Error updating COD payments:', error);
      alert('Failed to update COD payments. Please try again.');
      throw error;
    }
  };

  const handleCreateReturn = async ({ originalDelivery, returnPatient, store }) => {
    try {
      console.log('🔄 [CREATE RETURN] Creating new return delivery for today');
      console.log(`   Original date: ${originalDelivery.delivery_date}`);
      
      const currentDate = format(new Date(), 'yyyy-MM-dd');
      console.log(`   Return date: ${currentDate}`);

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
      await base44.entities.Delivery.create(returnDeliveryData);
      console.log('✅ [CREATE RETURN] Return delivery created for today');
      
      // Call backend optimizer for today's route
      try {
        await optimizeDriverRoute({
          driverId: originalDelivery.driver_id,
          deliveryDate: currentDate,
          currentLocation: driverLocation ? {
            lat: driverLocation.latitude,
            lon: driverLocation.longitude
          } : null,
          clientCurrentTime: format(new Date(), 'HH:mm') // Send device's current time
        });
        console.log('✅ [CREATE RETURN] Backend optimizer called for today');
      } catch (optError) {
        console.warn('⚠️ [CREATE RETURN] Backend optimizer failed:', optError.message);
      }
      
      // Invalidate caches for both dates
      invalidateDeliveriesForDate(originalDelivery.delivery_date);
      invalidateDeliveriesForDate(currentDate);
      invalidate('Delivery');
      await refreshData();
      
      console.log('✅ [CREATE RETURN] Return delivery created successfully');
    } catch (error) {
      console.error('❌ [CREATE RETURN] Error:', error);
      throw error;
    }
  };

  const handleStartDelivery = async (deliveryId) => {
    console.log('');
    console.log('═══════════════════════════════════');
    console.log('🚀 [START DELIVERY] Beginning 6-step process');
    console.log('═══════════════════════════════════');
    
    try {
      // Get delivery from UI state
      const deliveryFromUI = deliveriesWithStopOrder.find((d) => d && d.id === deliveryId);
      if (!deliveryFromUI) throw new Error('Delivery not found');
      
      const driverId = deliveryFromUI.driver_id;
      const deliveryDate = deliveryFromUI.delivery_date;
      if (!driverId || !deliveryDate) throw new Error('Missing driver or date on delivery');
      
      const isPickup = !deliveryFromUI.patient_id;
      const newStatus = isPickup ? 'en_route' : 'in_transit';
      
      console.log(`📦 Starting: ${deliveryFromUI.patient_name || 'Store Pickup'}`);
      console.log(`🚗 Driver: ${deliveryFromUI.driver_name}`);
      
      // Store current map view phase BEFORE any async operations
      const savedMapViewPhase = mapViewPhase;
      
      // ═══════════════════════════════════
      // STEP 1: Set isNextStop = true for this stop, false for others
      // ═══════════════════════════════════
      console.log('');
      console.log('🏗️ STEP 1: Setting isNextStop flag');
      // Note: isNextStop is handled via stop_order positioning - the started stop becomes #1 among incomplete
      
      // ═══════════════════════════════════
      // STEP 2: Store the stop_id for auto-centering later
      // ═══════════════════════════════════
      console.log('🏗️ STEP 2: Storing stop_id for auto-center');
      const storedStopId = deliveryFromUI.stop_id || deliveryId;
      console.log(`   Stored stop_id: ${storedStopId}`);
      
      // ═══════════════════════════════════
      // STEP 3: Calculate ETA using driver's current location or last completed stop
      // ═══════════════════════════════════
      console.log('🏗️ STEP 3: Calculating ETA for started stop');
      
      // Fetch fresh data from database
      const allDriverDeliveries = await base44.entities.Delivery.filter({
        delivery_date: deliveryDate,
        driver_id: driverId,
      });
      
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const completedStops = allDriverDeliveries
        .filter(d => d && finishedStatuses.includes(d.status) && d.actual_delivery_time)
        .sort((a, b) => new Date(b.actual_delivery_time) - new Date(a.actual_delivery_time));
      
      let startLocation = null;
      let startTime = format(new Date(), 'HH:mm');
      
      // Priority 1: Use driver's current GPS location if available
      if (driverLocation?.latitude && driverLocation?.longitude) {
        startLocation = { lat: driverLocation.latitude, lon: driverLocation.longitude };
        console.log(`   ✅ Using driver's current GPS location`);
      }
      // Priority 2: Use last completed stop's location
      else if (completedStops.length > 0) {
        const lastCompleted = completedStops[0];
        const location = lastCompleted.patient_id
          ? patients.find(p => p && p.id === lastCompleted.patient_id)
          : stores.find(s => s && s.id === lastCompleted.store_id);
        
        if (location?.latitude && location?.longitude) {
          startLocation = { lat: location.latitude, lon: location.longitude };
          console.log(`   ✅ Using last completed stop location`);
        }
      }
      
      // Calculate ETA for the started stop
      let calculatedETA = startTime;
      if (startLocation) {
        const targetLocation = isPickup
          ? stores.find(s => s && s.id === deliveryFromUI.store_id)
          : patients.find(p => p && p.id === deliveryFromUI.patient_id);
        
        if (targetLocation?.latitude && targetLocation?.longitude) {
          const distance = calculateDistance(
            startLocation.lat, startLocation.lon,
            targetLocation.latitude, targetLocation.longitude
          );
          const travelTimeMinutes = Math.ceil(distance * 2); // ~2 min per km
          const now = new Date();
          const etaDate = new Date(now.getTime() + travelTimeMinutes * 60000);
          calculatedETA = format(etaDate, 'HH:mm');
          console.log(`   📍 Distance: ${distance.toFixed(2)} km, Travel: ${travelTimeMinutes} min`);
        }
      }
      console.log(`   ⏰ Calculated ETA: ${calculatedETA}`);
      
      // ═══════════════════════════════════
      // STEP 4: Re-optimize remaining stops using backend function (UPDATED)
      // ═══════════════════════════════════
      console.log('🏗️ STEP 4: Calling backend optimizer for remaining stops');
      
      // First, update the started delivery status
      await base44.entities.Delivery.update(deliveryId, {
        status: newStatus,
        isNextDelivery: true
      });
      
      // Use backend function for route optimization
      try {
        const optimizationResult = await optimizeDriverRoute({
          driverId: driverId,
          deliveryDate: deliveryDate,
          currentLocation: driverLocation ? {
            lat: driverLocation.latitude,
            lon: driverLocation.longitude
          } : null,
          startedDeliveryId: deliveryId,
          clientCurrentTime: format(new Date(), 'HH:mm'), // Send device's current time
          generatePolyline: true // Generate polyline on start
        });
        
        console.log('✅ Backend optimization result:', optimizationResult.data);
        
        // Refresh polyline count after backend optimization
        fetchPolylineCount();
      } catch (backendError) {
        console.warn('⚠️ Backend optimization failed, using fallback:', backendError.message);
        
        // Fallback: simple sequential update
        const remainingIncomplete = allDriverDeliveries.filter(d =>
          d && !finishedStatuses.includes(d.status) && d.id !== deliveryId
        );
        
        // Get the highest stop_order among completed stops
        const lastCompletedStopOrder = completedStops.length > 0
          ? Math.max(...completedStops.map(d => d.stop_order || 0))
          : 0;
        
        const startedStopOrder = lastCompletedStopOrder + 1;
        
        // Update started delivery
        await base44.entities.Delivery.update(deliveryId, {
          stop_order: startedStopOrder,
          delivery_time_eta: calculatedETA
        });
        
        // Simple sequential ordering for remaining
        remainingIncomplete.sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0));
        
        for (let i = 0; i < remainingIncomplete.length; i++) {
          const stop = remainingIncomplete[i];
          if (!stop) continue;
          await base44.entities.Delivery.update(stop.id, {
            stop_order: startedStopOrder + i + 1,
            isNextDelivery: false
          });
        }
      }
      
      // ═══════════════════════════════════
      // STEP 5: Update stop cards on screen
      // ═══════════════════════════════════
      console.log('🏗️ STEP 5: Refreshing UI');
      invalidate('Delivery');
      await refreshData();
      
      // Collapse any expanded card
      setSelectedCardId(null);
      
      // ═══════════════════════════════════
      // STEP 6: Auto-center on the started delivery card
      // ═══════════════════════════════════
      console.log('🏗️ STEP 6: Auto-centering on started delivery card');
      setTimeout(() => {
        const cardElement = document.getElementById(`stop-card-${deliveryId}`);
        if (cardElement) {
          cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          console.log(`   ✅ Scrolled to card: stop-card-${deliveryId}`);
        }
      }, 300);
      
      console.log('');
      console.log('═══════════════════════════════════');
      console.log('✅ [START DELIVERY] Complete!');
      console.log('═══════════════════════════════════');
      
      // Note: Don't re-trigger map view after start delivery - let user control via FAB
      
    } catch (error) {
      console.error('❌ [START DELIVERY] Error:', error);
      alert('Failed to start delivery. Please try again.');
    }
  };

  const handleAcceptAIOptimization = async (updates) => {
    try {
      console.log('🤖 [AI Optimization] Accepting AI route suggestions:', updates);
      
      for (const update of updates) {
        await base44.entities.Delivery.update(update.id, {
          stop_order: update.stop_order
        });
      }
      
      invalidate('Delivery');
      await refreshData();
      setScrollToNextCardAfter(deliveryId);
      
      console.log('✅ [AI Optimization] Route updated successfully');
    } catch (error) {
      console.error('❌ [AI Optimization] Error applying optimization:', error);
      throw error;
    }
  };

  // CRITICAL: Add click handler BEFORE early return to ensure hooks are always called
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
    <div className="h-full w-full flex flex-col bg-slate-50 overflow-hidden">
      <AnimatePresence>
        {optimizationMessage &&
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className={optimizationMessagePositioning}
            style={{ top: isExpanded ? '216px' : '116px' }}>

            <div className="bg-white rounded-lg shadow-2xl border-2 border-emerald-500 p-3 flex items-center gap-3">
              {isOptimizing &&
                <div className="animate-spin w-4 h-4 border-3 border-emerald-500 border-t-transparent rounded-full flex-shrink-0"></div>
              }
              <p className="text-slate-900 font-medium flex-1 text-sm">{optimizationMessage}</p>
              {!isOptimizing &&
                <button
                  onClick={() => setOptimizationMessage(null)}
                  className="text-slate-400 hover:text-slate-600 flex-shrink-0">

                  <X className="w-3.5 h-3.5" />
                </button>
              }
            </div>
          </motion.div>
        }
      </AnimatePresence>

      <div className={statsCardPositioning}>
        <motion.div
          ref={statsCardRef}
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: areCardsVisible ? 1 : 0.4, y: 0 }}
          transition={{ duration: 0.3 }}
          onMouseEnter={() => handleCardInteraction(true)}
          onMouseLeave={() => handleCardInteraction(false)}
          onClick={(e) => {
            e.stopPropagation();
            handleCardInteraction(true);
            if (retractClustersRef.current) {
              retractClustersRef.current();
            }
          }} 
          className={`bg-white px-2 py-2 rounded-2xl shadow-xl border min-w-[340px] cursor-pointer z-[8888] ${
            currentUser?.location_tracking_enabled ? 'border-2 border-emerald-500' : 'border-slate-200'
          }`}>



          <div className="flex items-center justify-between mb-4">
            <h2 className="text-slate-900 pr-3 pl-3 text-lg font-bold">Dashboard</h2>

            <div className="flex items-center gap-2">
              <Popover open={isCalendarOpen} onOpenChange={(open) => {
                setIsCalendarOpen(open);
                if (open) {
                  setCalendarMonth(selectedDate);
                }
              }}>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-2 h-8 px-3">
                    <CalendarIcon className="w-3.5 h-3.5" />
                    <span className="text-sm">{format(selectedDate, 'EEE MMM dd')}</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
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
                      <div className="px-3 pb-2 pt-1 border-t border-slate-100">
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
                                className="w-full flex items-center justify-center gap-1 p-1.5 rounded hover:bg-slate-100 text-slate-600 hover:text-slate-800 text-xs">
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
                    } />

                </PopoverContent>
              </Popover>

              {(isAppOwner(currentUser) || isDriver) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowAIRoutePlanner(true)}
                  disabled={
                    isOptimizing || 
                    isAIAnalyzing ||
                    filteredDeliveries.length === 0
                  }
                  className="h-8 w-8 p-0"
                  title="AI Route Planner">
                  <Sparkles className={`w-3.5 h-3.5 text-purple-600 ${isAIAnalyzing ? 'animate-spin' : ''}`} />
                </Button>
              )}

              <Button
                onClick={() => {
                  setEditingDelivery(null);
                  setShowDeliveryForm(true);
                }}
                size="sm"
                className="bg-emerald-500 hover:bg-emerald-600 h-8 w-8 p-0"
                disabled={isDateFinished}>
                <Plus className="w-4 h-4" />
              </Button>
            </div>
          </div>

          <TooltipProvider>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 flex-wrap">
                <StatBadge
                  icon={Package}
                  value={stats.total}
                  color="blue"
                  label="Total"
                  tooltip={tooltipValues.total} />
                <StatBadge
                  icon={Truck}
                  value={stats.inTransit}
                  color="purple"
                  label="In Transit"
                  tooltip={tooltipValues.inTransit} />
                <StatBadge
                  icon={CheckCircle}
                  value={stats.completed}
                  color="green"
                  label="Completed"
                  tooltip={tooltipValues.completed} />
                <StatBadge
                  icon={XCircle}
                  value={`${stats.failed} / ${stats.returned}`}
                  color="red"
                  label="Failed/Returned"
                  tooltip={tooltipValues.failed} />
              </div>

              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 flex-shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsExpanded(!isExpanded);
                }}>
                {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </Button>
            </div>
          </TooltipProvider>


          <AnimatePresence>
            {isExpanded &&
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden">
                <div className="mt-2 pt-2 border-t border-slate-200 flex items-center gap-2">
                  <Select 
                      value={selectedDriverId} 
                      onValueChange={handleDriverChange}
                      disabled={isDriverDropdownDisabled}
                    >
                      <SelectTrigger className="flex h-8 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1 flex-1">
                        <SelectValue placeholder="All Drivers" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Drivers</SelectItem>
                        {driversList.map((driver) =>
                          <SelectItem key={driver.id} value={driver.id}>
                            {driver.user_name || driver.full_name}
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowOptimizationSettings(true)}
                      className="h-8 w-8 p-0 flex-shrink-0"
                      title="Route Optimization Settings">
                      <Settings className="w-3.5 h-3.5" />
                    </Button>

                    {userHasRole(currentUser, 'driver') &&
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleAIToggle}
                        className={`h-8 w-8 p-0 flex-shrink-0 relative ${isAIEnabled ? 'bg-purple-100 border-purple-300' : ''}`}
                        title={isAIEnabled ? "Disable AI Assistant" : "Enable AI Assistant"}>
                        <Bot className={`w-3.5 h-3.5 ${isAIEnabled ? 'text-purple-600' : 'text-slate-400'}`} />
                        {hasUnreadAIAlerts && isAIEnabled &&
                          <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full border-2 border-white"></span>
                        }
                      </Button>
                    }

                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => {
                        setShowRoutes(!showRoutes);
                        setIsExpanded(false);
                      }}
                      className="gap-2 h-8 flex-shrink-0">
                      <Truck className="w-3.5 h-3.5" />
                      {showRoutes ? 'Hide Routes' : 'Show Routes'}
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

                  {userHasRole(currentUser, 'driver') && isExpanded && (isMobile && stats.inTransit > 0) && (
                    <div className="mt-3 pt-3 border-t border-slate-200">
                      <AIRouteOptimizer
                        deliveries={filteredDeliveries}
                        currentDriverLocation={driverLocation}
                        stores={stores}
                        patients={patients}
                        onAcceptOptimization={handleAcceptAIOptimization}
                        currentUser={currentUser}
                        isVisible={isExpanded}
                      />
                    </div>
                  )}
                </motion.div>
              }
            </AnimatePresence>
        </motion.div>
      </div>

      <div className="flex-1 w-full relative min-h-0">
        {/* Polyline API hits badge - App Owner only */}
        {currentUser && isAppOwner(currentUser) && dailyPolylineCount !== null && (
          <div className="absolute top-2 left-2 z-[20]">
            <div className="bg-white/90 backdrop-blur-sm rounded-lg px-2 py-1 shadow-sm border border-slate-200 text-xs font-medium text-slate-600">
              🛣️ {dailyPolylineCount}
            </div>
          </div>
        )}
        
        <div className="absolute inset-0 overflow-hidden">
          <DeliveryMap
            deliveries={deliveriesWithStopOrder}
            patients={patients}
            stores={stores}
            users={drivers}
            currentUser={currentUser}
            driverLocations={isAllDriversMode ? allDriverLocations : []}
            currentDriverLocation={driverLocation}
            center={mapCenter}
            zoom={mapZoom}
            shouldFitBounds={shouldFitBounds}
            onBoundsFitted={() => setShouldFitBounds(null)}
            onMarkerClick={handleMarkerClick}
            mapMode={mapMode}
            onMapModeChange={setMapMode}
            autoFitBounds={true}
            showRoutes={showRoutes}
            showLegend={isAllDriversMode}
            areCardsVisible={areCardsVisible}
            onLegendInteraction={handleCardInteraction}
            statsCardPositioning={statsCardPositioning}
            isStatsCardExpanded={isExpanded}
            statsCardRect={statsCardRect}
            googleApiKey={googleApiKey}
            onMapInteraction={handleMapInteraction}
            retractClustersRef={retractClustersRef}
            STOP_CARDS_BASE_HEIGHT={STOP_CARDS_BASE_HEIGHT}
            areStopCardsVisible={deliveriesWithStopOrder.length > 0} />

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
                
                cards.forEach(card => {
                  const cardRect = card.getBoundingClientRect();
                  const cardCenter = cardRect.left + cardRect.width / 2;
                  const distance = Math.abs(cardCenter - containerCenter);
                  
                  if (distance < closestDistance) {
                    closestDistance = distance;
                    closestCard = card;
                  }
                });
                
                // Only snap if card is more than 30px off center
                if (closestCard && closestDistance > 30) {
                  closestCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                }
              }, 150);
            }}
          >
            <HorizontalStopCards
              pickupCards={deliveriesWithStopOrder
                .filter(delivery => delivery && delivery.status !== 'pending') // Hide pending deliveries from cards
                .map(delivery => {
                  if (!delivery) return delivery;
                  
                  // For pickups with status 'en_route', attach pending deliveries
                  if (!delivery.patient_id && delivery.status === 'en_route' && delivery.puid) {
                    const pendingDeliveriesForPickup = (deliveries || []).filter(d => 
                      d && 
                      d.puid === delivery.puid && 
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
                  
                  if (!isDispatcher || !currentUser.store_ids || currentUser.store_ids.length === 0) {
                    return delivery;
                  }
                  
                  // If delivery is from a store not in dispatcher's store_ids, mark as stripped
                  if (!currentUser.store_ids.includes(delivery.store_id)) {
                    return {
                      ...delivery,
                      _isStripped: true
                    };
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
                console.log('Driver status auto-changed to:', newStatus);
                await refreshUser();
              }}
            />
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

      {!showAIAssistant && isAIEnabled && userHasRole(currentUser, 'driver') &&
        <AIAssistantFAB
          onClick={() => setShowAIAssistant(true)}
          hasUnreadAlerts={hasUnreadAIAlerts}
          hasVisibleCards={deliveriesWithStopOrder.length > 0} />

      }

      {(isDriver || isDispatcher) &&
        <MapViewCycleFAB
          onClick={handleMapViewCycle}
          currentPhase={mapViewPhase}
          hasVisibleCards={deliveriesWithStopOrder.length > 0}
          isAIVisible={showAIAssistant && isAIEnabled}
          isLocked={isMapViewLocked} />

      }

      <AnimatePresence>
        {showRouteSummary &&
          <RouteSummaryModal
            deliveries={filteredDeliveries}
            patients={patients}
            stores={stores}
            onClose={() => {
              setShowRouteSummary(false);
              hasShownSummaryRef.current = false;
            }} />
        }
      </AnimatePresence>

      <AnimatePresence>
        {showAIRoutePlanner &&
          <AIRoutePlanner
            deliveries={deliveries}
            patients={patients}
            stores={stores}
            drivers={drivers}
            currentUser={currentUser}
            selectedDate={selectedDate}
            selectedDriverId={selectedDriverId}
            onAnalyzingChange={setIsAIAnalyzing}
            onApplyOptimization={async (updates, options = {}) => {
              try {
                console.log('🤖 [AI Route Planner] Applying route optimization:', updates);
                
                // STEP 1: Update stop orders
                console.log('🏗️ STEP 1: Updating stop orders');
                for (const update of updates) {
                  await base44.entities.Delivery.update(update.id, {
                    stop_order: update.stop_order
                  });
                }
                console.log(`✅ Updated ${updates.length} stop orders`);
                
                // STEP 2: Recalculate ETAs if requested
                if (options.recalculateETAs) {
                  console.log('🏗️ STEP 2: Recalculating ETAs');
                  
                  // Get the driver ID from first update
                  const firstDelivery = deliveries.find(d => d && d.id === updates[0]?.id);
                  if (firstDelivery?.driver_id) {
                    try {
                      await optimizeDriverRoute({
                        driverId: firstDelivery.driver_id,
                        deliveryDate: format(selectedDate, 'yyyy-MM-dd'),
                        currentLocation: driverLocation ? {
                          lat: driverLocation.latitude,
                          lon: driverLocation.longitude
                        } : null,
                        clientCurrentTime: format(new Date(), 'HH:mm') // Send device's current time
                      });
                      console.log('✅ ETAs recalculated via backend optimizer');
                    } catch (etaError) {
                      console.warn('⚠️ Backend ETA calculation failed:', etaError.message);
                    }
                  }
                }
                
                // STEP 3: Refresh data
                console.log('🏗️ STEP 3: Refreshing data');
                invalidate('Delivery');
                await refreshData();
                
                // STEP 4: Auto-center on next delivery card
                if (options.autoCenterNext) {
                  console.log('🏗️ STEP 4: Auto-centering on next delivery');
                  setTimeout(() => {
                    // Find the isNextDelivery card
                    const allCards = document.querySelectorAll('[id^="stop-card-"]');
                    for (const card of allCards) {
                      const cardId = card.id.replace('stop-card-', '');
                      // After refresh, check the fresh deliveries
                      const nextDeliveryCard = deliveriesWithStopOrder.find(d => 
                        d && d.id === cardId && d.isNextDelivery
                      );
                      if (nextDeliveryCard) {
                        card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                        console.log(`✅ Auto-centered on next delivery: ${nextDeliveryCard.patient_name || 'Pickup'}`);
                        break;
                      }
                    }
                  }, 500);
                }
                
                console.log('✅ [AI Route Planner] Route updated successfully');
              } catch (error) {
                console.error('❌ [AI Route Planner] Error:', error);
                throw error;
              }
            }}
            onClose={() => setShowAIRoutePlanner(false)} />
        }
      </AnimatePresence>
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

    if (data.status === 'OK' && data.results && Array.isArray(data.results) && data.results.length > 0) { // Defensive check
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