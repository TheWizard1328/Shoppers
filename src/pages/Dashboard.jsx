import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useDevice } from '@/components/utils/DeviceContext';
import { base44 } from "@/api/base44Client";
import { useDashboardPolylineMaintenance } from "@/components/dashboard/useDashboardPolylineMaintenance";
import { format, startOfDay } from 'date-fns';
import { invalidate, loadPriorityDeliveriesForSelection } from "@/components/utils/dataManager";
import { offlineDB } from "@/components/utils/offlineDatabase";
import DashboardScreen from '@/features/dashboard/components/DashboardScreen';
import { useDashboardViewModel } from '@/features/dashboard/services/dashboardViewModel';
import HorizontalStopCards from "@/components/dashboard/HorizontalStopCards";
import DeliveryForm from "@/components/deliveries/DeliveryForm";
import PatientForm from "@/components/patients/PatientForm";
import {
  updateDeliveryLocal,
  pauseOfflineMutations,
  resumeOfflineMutations } from "@/components/utils/offlineMutations";
import { pauseOfflineSync, resumeOfflineSync } from "@/components/utils/offlineSync";
import RouteOptimizationSettings from "@/components/dashboard/RouteOptimizationSettings";
import { locationTracker } from "@/components/utils/locationTracker";
import { getCurrentDevice } from '@/components/utils/deviceManager';
import { liveDistanceTracker } from "@/components/utils/liveDistanceTracker";
import { globalFilters } from "@/components/utils/globalFilters";
import { userHasRole } from '@/components/utils/userRoles';
import { useUser } from '@/components/utils/UserContext';
import { useAppData } from '@/components/utils/AppDataContext';
import { optimizeRoute } from '@/components/utils/routeOptimizer';
import { determinePolylineSegment, fetchPolylineForSegment } from "@/components/utils/dynamicPolylineManager";
import { driverLocationPoller } from "@/components/utils/driverLocationPoller";

import { smartRefreshManager } from "@/components/utils/smartRefreshManager";
import { recalculateAndUpdateStopOrders } from "@/components/utils/stopOrderManager";
import { loadUserSettings, saveSetting } from "@/components/utils/userSettingsManager";
import useLiveBreadcrumbsSync from '@/components/dashboard/useLiveBreadcrumbsSync';
import { fabControlEvents } from "@/components/utils/fabControlEvents";
import { notifyDriverRetry } from "@/components/utils/deliveryMessaging";
import RouteNotification from "@/components/dashboard/RouteNotification";
import { driverActivityMonitor } from '@/components/utils/driverActivityMonitor';
import { toast } from 'sonner';
import PullToSync from '../components/dashboard/PullToSync';
import SkippedStopsDialog from '../components/dashboard/SkippedStopsDialog';
import { useLocalPerformanceStats } from "@/components/dashboard/useLocalPerformanceStats";
import { calculateDistance, populateTemporaryStartTimes, buildMapPadding } from "@/components/dashboard/DashboardHelpers";
import { getFabTargetDriverMapLocation, isDriverOffDuty } from "@/components/dashboard/mapViewPhaseHelpers";
import { getInterStoreLocationSync, isInterStoreDelivery } from "@/components/utils/interStoreDisplayName";
import { collectPhase3SingleDriverCoordinates } from "@/components/dashboard/phase3BoundsHelper";
import { loadDashboardOfflineDateData, mergeDeliveriesForDate, hasDeliveryDataForSelection, ensureTempLogsForDate } from '@/components/dashboard/dashboardInitialLoadHelpers';
import useDriverLocationSync from '@/components/dashboard/useDriverLocationSync';
import { getBoundsSpanKm, getPhaseBoundsMaxZoom } from '@/components/dashboard/mapCycleZoomHelpers';
import { handleNotesUpdate as _handleNotesUpdate, handleCODUpdate as _handleCODUpdate } from '@/components/dashboard/handleSimpleDeliveryUpdates';
import { handleCreateReturn as _handleCreateReturn } from '@/components/dashboard/handleCreateReturn';
import { handleStatusUpdate as _handleStatusUpdateImpl } from '@/components/dashboard/handleStatusUpdate';
import { useFabControlEventHandler } from '@/components/dashboard/useFabControlEventHandler';
import { useStopCardsBaseHeight } from '@/components/dashboard/useStopCardsBaseHeight';
import { useStopCardCollapseTimer } from '@/components/utils/stopCardCollapseManager';

const getEdmDate=()=>{const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/Edmonton',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());return`${p.find(x=>x.type==='year').value}-${p.find(x=>x.type==='month').value}-${p.find(x=>x.type==='day').value}`;};const centerNextDeliveryCard=()=>{window.dispatchEvent(new CustomEvent('centerNextDeliveryCard'));};
function Dashboard() {
  const { currentUser, isLoadingUser, refreshUser } = useUser();
  const { deliveries, patients, stores, drivers, users, cities, appUsers, isDataLoaded, refreshData, updateDeliveriesLocally, updateAppUsersLocally, applyDeliveryChangesLocally, forceRefreshDriverDeliveries, setIsFormOverlayOpen, setIsEntityUpdating: _setIsEntityUpdatingCtx, dataReadyForSelectedDate, isSnapshotModeActive, setIsSnapshotModeActive, dataSource, initialFabPhase } = useAppData();
  const [isEntityUpdating, setIsEntityUpdating] = useState(false);
  // Keep context and local state in sync so Layout's overlay detection still works
  const _setIsEntityUpdatingBoth = (v) => { setIsEntityUpdating(v); _setIsEntityUpdatingCtx?.(v); };
  const isDispatcher = currentUser ? userHasRole(currentUser, 'dispatcher') : false;
  const [selectedDate, setSelectedDate] = useState(() => { const urlParams = new URLSearchParams(window.location.search); const dateParam = urlParams.get('date'); if (dateParam) return new Date(dateParam + 'T00:00:00'); const saved = globalFilters.getSelectedDate(); const savedDate = typeof saved === 'string' && saved ? new Date(saved + 'T00:00:00') : null; return savedDate || new Date(); });
  const [selectedDriverId, setSelectedDriverId] = useState(() => new URLSearchParams(window.location.search).get('driver') || globalFilters.getSelectedDriverId() || 'all');
  const [isExpanded, setIsExpanded] = useState(false);
  const [showRoutes, setShowRoutes] = useState(() => { const saved = localStorage.getItem('rxdeliver_show_routes'); return saved !== null ? saved === 'true' : true; });
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  const [optimizationMessage, setOptimizationMessage] = useState(null);
  const [selectedCardId, setSelectedCardId] = useState(null);
  const [showDeliveryForm, setShowDeliveryForm] = useState(false);
  const [editingDelivery, setEditingDelivery] = useState(null);
  const [mapCenter, setMapCenter] = useState([53.5461, -113.4938]);
  const [mapZoom, setMapZoom] = useState(11);
  const [shouldFitBounds, setShouldFitBounds] = useState(null);
  const [mapMode, setMapMode] = useState('auto-follow');
  const [showOptimizationSettings, setShowOptimizationSettings] = useState(false);
  const [isAIEnabled, setIsAIEnabled] = useState(() => { const saved = localStorage.getItem('rxdeliver_ai_enabled'); return saved !== null ? saved === 'true' : true; });
  const [showAIAssistant, setShowAIAssistant] = useState(false);
  const [driverLocation, setDriverLocation] = useState(null);
  const [hasUnreadAIAlerts, setHasUnreadAIAlerts] = useState(false);
  const [showPatientForm, setShowPatientForm] = useState(false);
  const [editingPatient, setEditingPatient] = useState(null);
  const [patientFormCallback, setPatientFormCallback] = useState(null);
  const [patientFormMode, setPatientFormMode] = useState(null);
  const [calendarMonth, setCalendarMonth] = useState(selectedDate);
  const [mapViewPhase, setMapViewPhase] = useState(1);
  const [userSettingsLoaded, setUserSettingsLoaded] = useState(true);
  const [initialMapViewApplied, setInitialMapViewApplied] = useState(false);
  // renderSequence refactor: only the two flags consumed by child components need to
  // be state. The other 6 are pure internal sequencing gates — converting them to
  // refs eliminates 6 out of 7 re-renders in the load/date-change cascade.
  const [rsMapMarkersReady, setRsMapMarkersReady] = useState(false);
  const [rsFabPhaseReady, setRsFabPhaseReady] = useState(false);
  const rsStatsAndCardsRef    = useRef(false);
  const rsFabsRef             = useRef(false);
  const rsRouteLinesRef       = useRef(false);
  const rsDriverLiveLocRef    = useRef(false);
  const rsSharedLocationsRef  = useRef(false);
  const rsFullDeliveriesRef   = useRef(false);
  // Stable object passed to child components — shape is unchanged so no consumer
  // needs to be updated. Re-created only when the two stateful flags flip.
  const renderSequence = useMemo(() => ({
    statsAndCards:       rsStatsAndCardsRef.current,
    fabs:                rsFabsRef.current,
    mapMarkers:          rsMapMarkersReady,
    routeLines:          rsRouteLinesRef.current,
    driverLiveLocation:  rsDriverLiveLocRef.current,
    sharedLocations:     rsSharedLocationsRef.current,
    fullDeliveriesLoaded: rsFullDeliveriesRef.current,
    fabPhaseReady:       rsFabPhaseReady,
  }), [rsMapMarkersReady, rsFabPhaseReady]);
  // setRenderSequence shim — keeps MapSection.jsx and DashboardView.jsx working
  // without changes. Only mapMarkers and fabPhaseReady trigger re-renders; the
  // rest are written to refs silently.
  const setRenderSequence = useCallback((updater) => {
    const current = {
      statsAndCards:       rsStatsAndCardsRef.current,
      fabs:                rsFabsRef.current,
      mapMarkers:          rsMapMarkersReady,
      routeLines:          rsRouteLinesRef.current,
      driverLiveLocation:  rsDriverLiveLocRef.current,
      sharedLocations:     rsSharedLocationsRef.current,
      fullDeliveriesLoaded: rsFullDeliveriesRef.current,
      fabPhaseReady:       rsFabPhaseReady,
    };
    const next = typeof updater === 'function' ? updater(current) : updater;
    // Write non-stateful flags to refs (no re-render)
    rsStatsAndCardsRef.current   = next.statsAndCards   ?? current.statsAndCards;
    rsFabsRef.current            = next.fabs            ?? current.fabs;
    rsRouteLinesRef.current      = next.routeLines      ?? current.routeLines;
    rsDriverLiveLocRef.current   = next.driverLiveLocation ?? current.driverLiveLocation;
    rsSharedLocationsRef.current = next.sharedLocations ?? current.sharedLocations;
    rsFullDeliveriesRef.current  = next.fullDeliveriesLoaded ?? current.fullDeliveriesLoaded;
    // Only call state setters if the stateful flags actually changed
    if (next.mapMarkers !== undefined && next.mapMarkers !== rsMapMarkersReady) setRsMapMarkersReady(next.mapMarkers);
    if (next.fabPhaseReady !== undefined && next.fabPhaseReady !== rsFabPhaseReady) setRsFabPhaseReady(next.fabPhaseReady);
  }, [rsMapMarkersReady, rsFabPhaseReady]);
  const [allDriverLocations, setAllDriverLocations] = useState([]);
  const screenWidth = window.innerWidth;
  const cardWidth = 340;
  const [areCardsVisible, setAreCardsVisible] = useState(false);
  const [statsPanelOpacity, setStatsPanelOpacity] = useState(1);
  const statsPanelFadeTimeoutRef = useRef(null);
  const fadeTimeoutRef = useRef(null);
  const statsCardRef = useRef(null);
  const [isMapViewLocked, setIsMapViewLocked] = useState(false);
  const retractClustersRef = useRef(null);
  const [showRouteSummary, setShowRouteSummary] = useState(false);
  const hasShownSummaryRef = useRef(new Set());
  const [summaryDriver, setSummaryDriver] = useState(null);
  const stopCardsContainerRef = useRef(null);
  const horizontalStopCardsRef = useRef(null);
  const mapLockTimeoutRef = useRef(null);
  const mapLockExpiresAtRef = useRef(null);
  const [driverRoutes, setDriverRoutes] = useState([]);
  const lastProximitySnapTimeRef = useRef(0);
  const lastUserInteractionRef = useRef(0);
  // Set to true when user manually pans/zooms while in phase 2/3 — prevents handleMapViewCycle
  // from immediately re-locking back to the phase. Cleared when driver taps FAB to cycle.
  const mapUserUnlockedRef = useRef(false);
  const [highlightedCardId, setHighlightedCardId] = useState(null);
  const [currentToNextPolyline, setCurrentToNextPolyline] = useState(null);
  const [hasRateLimitError, setHasRateLimitError] = useState(false);
  const [realTimeETAEnabled] = useState(true);
  const [isReoptimizing, setIsReoptimizing] = useState(false);
  const [showQuickAdjustments, setShowQuickAdjustments] = useState(false);
  const cardExpandedAtRef = useRef(null);
  const [showAllDriverMarkers, setShowAllDriverMarkers] = useState(false);
  const [showBreadcrumbs, setShowBreadcrumbs] = useState(false); const [mapStyle, setMapStyle] = useState('explore');
  const preferredTravelMode = useMemo(() => {
    const targetId = selectedDriverId !== 'all' ? selectedDriverId : currentUser?.id;
    const appUser = appUsers.find((u) => u?.user_id === targetId);
    const mode = appUser?.preferred_travel_mode || 'driving';
    return ['driving', 'cycling', 'pedestrian'].includes(mode) ? mode : 'driving';
  }, [appUsers, selectedDriverId, currentUser?.id]);
  const [breadcrumbsData, setBreadcrumbsData] = useState({ historical: [], current: [] });
  const [performanceStats, setPerformanceStats] = useState(null);
  const [deliveryStats] = useState(null); const [liveDistance] = useState(0); const [liveTimeOnDuty] = useState(null);
  const [showEndOfDayStats, setShowEndOfDayStats] = useState(false);
  const [endOfDayDriver, setEndOfDayDriver] = useState(null);
  const shownEodKeysRef = useRef(new Set());
  const appUsersRef_eod = useRef(appUsers);
  const currentUserRef_eod = useRef(currentUser);
  useEffect(() => { appUsersRef_eod.current = appUsers; }, [appUsers]);
  useEffect(() => { currentUserRef_eod.current = currentUser; }, [currentUser]);
  useEffect(() => {
    const handler = (e) => {
      const { driverId, deliveryDate } = e?.detail || {};
      if (!driverId || !deliveryDate) return;
      const summaryKey = `${driverId}_${deliveryDate}`;
      if (shownEodKeysRef.current.has(summaryKey)) return;
      shownEodKeysRef.current.add(summaryKey);
      const driverAppUser = appUsersRef_eod.current.find((au) => au?.user_id === driverId);
      setEndOfDayDriver(driverAppUser || currentUserRef_eod.current);
      setShowEndOfDayStats(true);
    };
    window.addEventListener('showRouteSummary', handler);
    return () => window.removeEventListener('showRouteSummary', handler);
  }, []); // stable mount-once listener; uses refs for always-fresh appUsers/currentUser
  const [snapshotData, setSnapshotData] = useState(null);
  const [pullToSyncKey] = useState(0);
  const [skippedStopsDialogData, setSkippedStopsDialogData] = useState(null);
  const statusUpdateLockRef = useRef(new Set());
  const [cardsReadyForFAB, setCardsReadyForFAB] = useState(false);
  const [isLoadingPayrollStats, setIsLoadingPayrollStats] = useState(false);
  const [isPrimaryDevice, setIsPrimaryDevice] = useState(false);
  const { isMobile } = useDevice();
  const bottomNavHeight = useMemo(() => { const val = getComputedStyle(document.documentElement).getPropertyValue('--bottom-nav-height').trim(); if (!val || val === '0px') return 0; const match = val.match(/(\d+)px/); return match ? parseInt(match[1], 10) : 0; }, []);
  const isDriver = useMemo(() => currentUser ? userHasRole(currentUser, 'driver') : false, [currentUser]);
  const isAdmin = useMemo(() => currentUser ? userHasRole(currentUser, 'admin') : false, [currentUser]);
  const [stopCardsBaseHeight, setStopCardsBaseHeight] = useState(0);
  const [statsCardBaseHeight, setStatsCardBaseHeight] = useState(0);
  const phaseBeforeBreakRef = useRef(null);
  const initialFabPhaseAppliedRef = useRef(null);
  const [routeNotification, setRouteNotification] = useState(null);
  const mapViewPhaseRef = useRef(1);
  const driverLocationRef = useRef(null);
  const nextStopCoordinatesRef = useRef(null);
  const deliveriesWithStopOrderRef = useRef([]);
  const patientsRef = useRef([]);
  const storesRef = useRef([]);
  const allDriverLocationsRef = useRef([]);
  const appUsersRef = useRef([]);
  const deliveriesRef = useRef([]);
  const selectedDateRef = useRef(null);
  const showAllDriverMarkersRef = useRef(false);
  const selectedDriverIdRef = useRef(null);
  const citiesRef = useRef([]);
  const isPrimaryDeviceRef = useRef(false);
  const pendingPhaseRef = useRef(1);
  const isMapViewLockedRef = useRef(false);
  const lastProgrammaticMapMoveRef = useRef(0);
  const [mapViewTrigger, setMapViewTrigger] = useState(0);
  const [previousMapState, setPreviousMapState] = useState(null);
  const hasSetInitialDriverDashboard = useRef(false);
  const hasAutoSelectedRef = useRef(false);
  const isFiltersReady = useMemo(() => globalFilters.isReadyForDataFetch(), []);
  const isAllDriversMode = selectedDriverId === 'all';
  const [forceRender, setForceRender] = useState(0);
  // Consolidate 11 ref-sync effects into one — refs don't trigger renders so there
  // is no correctness reason to keep them separate; this saves 10 scheduler ticks
  // on every periodic refresh that updates deliveries + appUsers + patients together.
  useEffect(() => {
    driverLocationRef.current = driverLocation;
    patientsRef.current = patients;
    storesRef.current = stores;
    allDriverLocationsRef.current = allDriverLocations;
    appUsersRef.current = appUsers;
    deliveriesRef.current = deliveries;
    selectedDateRef.current = selectedDate;
    showAllDriverMarkersRef.current = showAllDriverMarkers;
    selectedDriverIdRef.current = selectedDriverId;
    citiesRef.current = cities;
    isPrimaryDeviceRef.current = isPrimaryDevice;
  }, [driverLocation, patients, stores, allDriverLocations, appUsers, deliveries, selectedDate, showAllDriverMarkers, selectedDriverId, cities, isPrimaryDevice]);

  // Resolve primary-device status from the DB once we have a logged-in driver.
  // Without this, isPrimaryDevice stays false forever and immersive mode never activates.
  useEffect(() => {
    if (!isDriver || !currentUser?.id) return;
    let cancelled = false;
    getCurrentDevice(currentUser.id).then((device) => {
      if (cancelled) return;
      const primary = device != null && device.status !== 'inactive' && device.is_primary_tracker === true;
      setIsPrimaryDevice(primary);
      isPrimaryDeviceRef.current = primary;
      if (typeof window !== 'undefined') window.__isPrimaryDevice = primary;
    }).catch(() => {
      // Leave as false on error — safe default
    });
    return () => { cancelled = true; };
  }, [isDriver, currentUser?.id]);
  useEffect(() => { isMapViewLockedRef.current = isMapViewLocked; }, [isMapViewLocked]);

  const filteredDeliveries = useMemo(() => {
    if (isSnapshotModeActive && snapshotData?.deliveries) { const dateStr = format(selectedDate, 'yyyy-MM-dd'); let result = snapshotData.deliveries.filter((d) => d && d.delivery_date === dateStr); if (selectedDriverId && selectedDriverId !== 'all') { result = result.filter((d) => d.driver_id === selectedDriverId); } return result; }
    if (!deliveries || !Array.isArray(deliveries)) return [];
    const dateStr = format(selectedDate, 'yyyy-MM-dd');
    let result = deliveries.filter((d) => { if (!d || d.delivery_date !== dateStr) return false; if (selectedDriverId && selectedDriverId !== 'all' && d.driver_id !== selectedDriverId) return false; return true; });
    if (isDispatcher && !isAdmin && (selectedDriverId === 'all' || selectedDriverId === '')) { const _ds = new Set(currentUser?.store_ids || []); const _allowedDriverIds = new Set(result.filter((x) => x && _ds.has(x.store_id)).map((x) => x.driver_id).filter(Boolean)); result = result.filter((d) => d && (d.is_cycling_marker || _allowedDriverIds.has(d.driver_id))); }
    return result;
  }, [deliveries, selectedDate, selectedDriverId, isDispatcher, currentUser, isSnapshotModeActive, snapshotData]);

  const deliveriesWithStopOrder = useMemo(() => {
    if (!filteredDeliveries || filteredDeliveries.length === 0) return [];

    const FINISHED = ['completed', 'failed', 'cancelled', 'returned'];

    // Group by driver
    const groupedByDriver = {};
    filteredDeliveries.forEach((delivery) => {
      if (!delivery) return;
      const dId = delivery.driver_id || 'unassigned';
      if (!groupedByDriver[dId]) groupedByDriver[dId] = [];
      groupedByDriver[dId].push(delivery);
    });

    const result = [];

    Object.keys(groupedByDriver).forEach((dId) => {
      const stops = groupedByDriver[dId];

      // Partition finished vs incomplete
      const finished   = stops.filter(d => d && FINISHED.includes(d.status));
      const incomplete = stops.filter(d => d && !FINISHED.includes(d.status));

      // Finished: sort by actual_delivery_time ASC — cycling markers follow the same rule
      const sortedFinished = [...finished].sort((a, b) => {
        const ta = a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : Number.MAX_SAFE_INTEGER;
        const tb = b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : Number.MAX_SAFE_INTEGER;
        if (ta !== tb) return ta - tb;
        return (Number(a.stop_order) || 0) - (Number(b.stop_order) || 0);
      });

      // Incomplete: pending last; within non-pending sort by stop_order (preserves optimizer result)
      // Cycling markers (is_cycling_marker=true) are never treated as pending — sort like active stops
      const sortedIncomplete = [...incomplete].sort((a, b) => {
        const aPending = a.status === 'pending' && !a.is_cycling_marker;
        const bPending = b.status === 'pending' && !b.is_cycling_marker;
        if (aPending && !bPending) return 1;
        if (!aPending && bPending) return -1;

        const ao = Number(a.stop_order), bo = Number(b.stop_order);
        const hao = Number.isFinite(ao) && ao > 0;
        const hbo = Number.isFinite(bo) && bo > 0;
        if (hao && hbo) return ao - bo;
        if (hao) return -1;
        if (hbo) return 1;
        // No stop_order: fall back to ETA string
        const ea = a.delivery_time_eta || a.delivery_time_start || '99:99';
        const eb = b.delivery_time_eta || b.delivery_time_start || '99:99';
        return ea.localeCompare(eb);
      });

      // Merge finished-first then incomplete; assign display_stop_order 1..N sequentially
      const ordered = [...sortedFinished, ...sortedIncomplete];
      let dc = 1;
      ordered.forEach((d) => {
        if (!d) return;
        // Pending regular stops get no badge; everything else (including cycling markers) gets one
        const showNumber = d.status !== 'pending' || d.is_cycling_marker;
        result.push({ ...d, display_stop_order: showNumber ? dc++ : null });
      });
    });

    return result;
  }, [filteredDeliveries]);

  // Consolidate computed-value ref syncs into one effect
  useEffect(() => {
    deliveriesWithStopOrderRef.current = deliveriesWithStopOrder;
  }, [deliveriesWithStopOrder]);

  const stats = useMemo(() => {
    let rd = filteredDeliveries || [];
    if (isDispatcher && !isAdmin && currentUser?.store_ids) { const ds = new Set(currentUser.store_ids); rd = rd.filter((d) => d && ds.has(d.store_id)); }
    const isISD=(d)=>String(d?.delivery_id||'').toUpperCase().startsWith('ISD-');
    const isISP=(d)=>String(d?.delivery_id||'').toUpperCase().startsWith('ISP-');
    // sd = patient deliveries + ISD (count as deliveries); ap = store pickups + ISP (count as pickups)
    const sd=rd.filter((d)=>d&&!d.is_cycling_marker&&(d.patient_id||isISD(d))); const ap=rd.filter((d)=>d&&!d.is_cycling_marker&&!d.patient_id&&!isISD(d));
    if (!Array.isArray(sd)) return {total:0,inTransit:0,enRoute:0,completed:0,failed:0,returned:0,totalDrivers:0,inTransitDrivers:0,completedDrivers:0,totalPickups:0,completedPickups:0};
    const pm=new Map((patients||[]).filter((p)=>p&&p.id).map((p)=>[p.id,p]));
    const isRtn=(d)=>d&&d.status==='completed'&&(pm.get(d.patient_id)?.address||'').toUpperCase().includes('(RTN)');
    const total=sd.length+ap.filter((d)=>d&&(d.after_hours_pickup||isISP(d))).length;
    const inTransitIsdIsp=rd.filter((d)=>d&&!d.is_cycling_marker&&(isISD(d)||isISP(d))&&(d.status==='in_transit'||d.status==='en_route')).length;
    const completedIsdIsp=rd.filter((d)=>d&&!d.is_cycling_marker&&(isISD(d)||isISP(d))&&d.status==='completed').length;
    const inTransit=sd.filter((d)=>d&&d.status==='in_transit').length+inTransitIsdIsp; const enRoute=ap.filter((d)=>d&&!isISP(d)&&d.status==='en_route').length;
    const completed=sd.filter((d)=>d&&d.status==='completed'&&!isRtn(d)).length+rd.filter((d)=>d&&!d.patient_id&&(d.after_hours_pickup||isISP(d))&&(d.status==='completed'||d.status==='cancelled')).length;
    const returned=sd.filter(isRtn).length; const failed=sd.filter((d)=>d&&((d.status==='failed'&&!isRtn(d))||(d.status==='cancelled'&&!d.patient_id))).length+ap.filter((d)=>d&&isISP(d)&&d.status==='failed').length;
    const completedPickups=ap.filter((d)=>d&&!isISP(d)&&(d.status==='completed'||d.status==='cancelled')).length;
    const totalPickups=ap.filter((d)=>d&&!isISP(d)).length;
    const isdIspCount=rd.filter((d)=>d&&!d.is_cycling_marker&&(isISD(d)||isISP(d))).length;
    let totalDrivers=0,inTransitDrivers=0,completedDrivers=0;
    if(isDispatcher||isAdmin){const aids=new Set(rd.map((d)=>d?.driver_id).filter(Boolean));totalDrivers=aids.size;inTransitDrivers=new Set(rd.filter((d)=>d&&(d.status==='in_transit'||d.status==='en_route')).map((d)=>d?.driver_id).filter(Boolean)).size;aids.forEach((did)=>{const ds=rd.filter((d)=>d?.driver_id===did);if(ds.some((d)=>d&&d.status==='completed')&&ds.every((d)=>d&&['completed','failed','cancelled'].includes(d.status)))completedDrivers++;});}
    return {total,inTransit,enRoute,activePickupsEnRoute:enRoute,completed,failed,returned,totalDrivers,inTransitDrivers,completedDrivers,totalPickups,completedPickups,isdIspCount,inTransitIsdIsp,completedIsdIsp};
  }, [filteredDeliveries, patients, isDispatcher, currentUser?.store_ids, isAdmin]);

  const isDateFinished = useMemo(() => { const tod = startOfDay(new Date()); const sel = startOfDay(selectedDate); if (sel >= tod) return false; return filteredDeliveries.length > 0 && filteredDeliveries.every((d) => d && ['completed','failed','cancelled'].includes(d.status)); }, [selectedDate, filteredDeliveries]);
  const isRouteComplete = useMemo(() => { if (!filteredDeliveries || filteredDeliveries.length === 0) return false; const pds = filteredDeliveries.filter((d) => d && d.patient_id); const isRtn = (d) => (patients.find((p) => p && p.id === d.patient_id)?.address || '').toUpperCase().includes('(RTN)'); return pds.length > 0 && pds.every((d) => ['completed','failed','cancelled'].includes(d.status) || isRtn(d)); }, [filteredDeliveries, patients]);
  // Stable set of driver IDs that have deliveries on the selected date — split out so
  // driversList only re-runs when driver-identity data changes, not on every delivery write.
  const activeDriverIdsOnDate = useMemo(() => {
    const _ds = format(selectedDate, 'yyyy-MM-dd');
    const set = new Set();
    (deliveries || []).forEach((d) => {
      if (d && d.delivery_date === _ds && d.driver_id) set.add(d.driver_id);
    });
    return set;
  }, [deliveries, selectedDate]);

  const driversList = useMemo(() => {
    const _ds = format(selectedDate, 'yyyy-MM-dd');
    const _iok = isAdmin ? activeDriverIdsOnDate : new Set();
    const src = (appUsers || [])
      .filter((au) => au && au.user_id && au.app_roles?.includes('driver') && (au.status === 'active' || _iok.has(au.user_id)))
      .map((au) => ({ ...au, id: au.user_id }))
      .sort((a, b) => { const sa = a.sort_order ?? Infinity, sb = b.sort_order ?? Infinity; return sa !== sb ? sa - sb : (a.user_name || '').toLowerCase().localeCompare((b.user_name || '').toLowerCase()); });
    if (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver')) return src;
    if (userHasRole(currentUser, 'dispatcher')) {
      const sid = String((currentUser.store_ids || [])[0] || '');
      const st = stores?.find((s) => s && String(s.id) === sid);
      const aids = new Set();
      if (st) {
        const di = new Date(selectedDate).getDay();
        if (di === 6) { if (st.saturday_am_driver_id) aids.add(st.saturday_am_driver_id); if (st.saturday_pm_driver_id) aids.add(st.saturday_pm_driver_id); }
        else if (di === 0) { if (st.sunday_am_driver_id) aids.add(st.sunday_am_driver_id); if (st.sunday_pm_driver_id) aids.add(st.sunday_pm_driver_id); }
        else { if (st.weekday_am_driver_id) aids.add(st.weekday_am_driver_id); if (st.weekday_pm_driver_id) aids.add(st.weekday_pm_driver_id); }
      }
      // Also include any driver that actually has a delivery for this dispatcher's store on this date
      (deliveries || []).filter((d) => d && d.delivery_date === _ds && String(d.store_id) === sid).forEach((d) => { if (d.driver_id) aids.add(d.driver_id); });
      (window.__dispatcherOverrideDriverIds?.[_ds] || []).forEach((id) => aids.add(id));
      return src.filter((d) => aids.has(d.id) || aids.has(d.user_id));
    }
    return src;
  }, [appUsers, currentUser, stores, selectedDate, activeDriverIdsOnDate, isAdmin]);
  const isDriverDropdownDisabled = useMemo(() => !currentUser || userHasRole(currentUser,'admin') ? false : userHasRole(currentUser,'dispatcher') ? false : !!userHasRole(currentUser,'driver'), [currentUser]);
  const statsCardPositioning = useMemo(() => { const snapshotOffset = isSnapshotModeActive ? 'left-24' : 'left-2'; return (screenWidth / cardWidth) < 2 ? 'absolute top-2 left-1/2 -translate-x-1/2' : `absolute top-2 ${snapshotOffset}`; }, [screenWidth, cardWidth, isSnapshotModeActive]);
  const isStatsCardCentered = useMemo(() => (screenWidth / cardWidth) < 2, [screenWidth, cardWidth]);
  const nextStop = useMemo(() => { if (!isDriver || !currentUser || !filteredDeliveries || filteredDeliveries.length === 0) return null; if (isRouteComplete) return null; const next = filteredDeliveries.find((d) => d && d.isNextDelivery === true && d.driver_id === currentUser.id && d.status !== 'pending' && !['completed','failed','cancelled'].includes(d.status)); if (next) return next; const unf = filteredDeliveries.filter((d) => d && d.driver_id === currentUser.id && !['completed','failed','cancelled','pending'].includes(d.status)); if (!unf.length) return null; return [...unf].sort((a, b) => a.stop_order && b.stop_order ? a.stop_order - b.stop_order : (a.delivery_time_start || '').localeCompare(b.delivery_time_start || ''))[0]; }, [isDriver, filteredDeliveries, currentUser, isRouteComplete]);
  const nextStopCoordinates = useMemo(() => { if (!nextStop) return null; if (nextStop.is_cycling_marker && nextStop.cycling_latitude && nextStop.cycling_longitude) return { lat: nextStop.cycling_latitude, lon: nextStop.cycling_longitude }; if (nextStop.patient_id) { const p = patients.find((p) => p && p.id === nextStop.patient_id); if (p?.latitude && p?.longitude) return { lat: p.latitude, lon: p.longitude }; } else if (isInterStoreDelivery(nextStop.delivery_id)) { const isl = getInterStoreLocationSync(nextStop.delivery_id); if (isl?.store_latitude && isl?.store_longitude) return { lat: isl.store_latitude, lon: isl.store_longitude }; const s = stores.find((s) => s && s.id === nextStop.store_id); if (s?.latitude && s?.longitude) return { lat: s.latitude, lon: s.longitude }; } else if (nextStop.store_id) { const s = stores.find((s) => s && s.id === nextStop.store_id); if (s?.latitude && s?.longitude) return { lat: s.latitude, lon: s.longitude }; } return null; }, [nextStop, patients, stores]);
  // nextStopCoordinatesRef kept as inline sync — fires only when nextStopCoordinates changes
  useEffect(() => { nextStopCoordinatesRef.current = nextStopCoordinates; }, [nextStopCoordinates]);
  const getMapPadding = useCallback((isImmersiveHidden = false) => buildMapPadding({ isMobile, isImmersiveHidden, statsCardHeight: statsCardRef.current?.offsetHeight, statsCardBaseHeight, stopCardsBaseHeight, bottomNavHeight }), [isMobile, stopCardsBaseHeight, statsCardBaseHeight, bottomNavHeight]);
  const handleCardInteraction = useCallback((show) => { if (fadeTimeoutRef.current) { clearTimeout(fadeTimeoutRef.current); fadeTimeoutRef.current = null; } setAreCardsVisible(show); if (show && !isExpanded && !isRouteComplete) fadeTimeoutRef.current = setTimeout(() => setAreCardsVisible(false), 3000); }, [isExpanded, isRouteComplete]);
  const handleStatsPanelInteraction = useCallback((isHovering) => { if (!isMobile) return; if (statsPanelFadeTimeoutRef.current) { clearTimeout(statsPanelFadeTimeoutRef.current); statsPanelFadeTimeoutRef.current = null; } if (isHovering || isExpanded) setStatsPanelOpacity(1); else statsPanelFadeTimeoutRef.current = setTimeout(() => setStatsPanelOpacity(0.5), 5000); }, [isExpanded, isMobile]);
  useEffect(() => { if (!isMobile) { setStatsPanelOpacity(1); return; } if (isExpanded) { setStatsPanelOpacity(1); if (statsPanelFadeTimeoutRef.current) { clearTimeout(statsPanelFadeTimeoutRef.current); statsPanelFadeTimeoutRef.current = null; } } else statsPanelFadeTimeoutRef.current = setTimeout(() => setStatsPanelOpacity(0.5), 5000); }, [isExpanded, isMobile]);
  useEffect(() => { if (!isMobile || !isDataLoaded) return; const t = setTimeout(() => { if (!isExpanded) setStatsPanelOpacity(0.5); }, 5000); return () => clearTimeout(t); }, [isDataLoaded, isExpanded, isMobile]);
  const handleReoptimizeRouteRef = useRef(null);
  useFabControlEventHandler({ mapViewPhaseRef, isMapViewLockedRef, pendingPhaseRef, mapLockTimeoutRef, mapLockExpiresAtRef, lastProgrammaticMapMoveRef, phaseBeforeBreakRef, mapUserUnlockedRef, lastUserInteractionRef, setMapViewPhase, setIsMapViewLocked, setMapViewTrigger, onOnDutyFromToggle: () => handleReoptimizeRouteRef.current?.() });
  useLocalPerformanceStats({ currentUser, isDataLoaded, isDispatcher, selectedDriverId, selectedDate, filteredDeliveries, patients, appUsers, setPerformanceStats, setIsLoadingPayrollStats });
  const { dailyPolylineCount } = useDashboardPolylineMaintenance({ currentUser, selectedDate, deliveries, isDataLoaded, dataReadyForSelectedDate, isSnapshotModeActive, updateDeliveriesLocally });
  useLiveBreadcrumbsSync({ showBreadcrumbs, showAllDriverMarkers, selectedDriverId, currentUser, selectedDate, appUsers, setBreadcrumbsData });
  useDriverLocationSync({ isDriver, currentUser, appUsers, isMobile, isPrimaryDevice, deliveriesWithStopOrder, patients, stores, mapViewPhaseRef, isMapViewLockedRef, lastProgrammaticMapMoveRef, lastUserInteractionRef, lastProximitySnapTimeRef, stopCardsContainerRef, setMapViewTrigger, setDriverLocation, calculateDistance, locationTracker, pendingPhaseRef, driverLocationRef, selectedDriverId });
  useStopCardsBaseHeight({ horizontalStopCardsRef, selectedCardId, deliveriesWithStopOrder, stopCardsBaseHeight, setStopCardsBaseHeight, statsCardRef, setStatsCardBaseHeight });

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
      const active = deliveries.some((d) => d && d.delivery_date === ds && !['completed', 'failed', 'cancelled'].includes(d.status));
      if (!t || Date.now() - t >= (active ? 60000 : 300000)) window.dispatchEvent(new CustomEvent('triggerPullToSync', { detail: { silent: true, reason: active ? 'today_active_routes' : 'today_completed_routes' } }));
    }, 60000);
    return () => {clearTimeout(initialDelay);clearInterval(interval);};
  }, [isDataLoaded, currentUser?.id, isFiltersReady, deliveries, patients, stores, cities, appUsers, drivers, selectedDate, showAllDriverMarkers, showDeliveryForm, showPatientForm, showOptimizationSettings, showAIAssistant]);

  // driverLocationsUpdated — merge appUser location data and run the poller.
  // Map re-panning for phase 2/3 is exclusively owned by useDriverLocationSync
  // (syncMobileLocation) which already has the correct minInterval guard.
  // Removing setMapViewTrigger from here eliminates the double-bounce on FAB click.
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
        const shouldFilterSelf = isMobile && isDriver;const filteredLocations = shouldFilterSelf ? locations.filter((loc) => {if (loc._isSelf === true) {return false;}return true;}) : locations;setAllDriverLocations(filteredLocations);});

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

          setCurrentToNextPolyline(Array.isArray(polyline) && polyline.length > 1 ? polyline : null);
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
    d && !['completed', 'failed', 'cancelled'].includes(d.status)
    );

    if (!hasActiveDeliveries) {
      setCurrentToNextPolyline(null);
      return; // Don't fetch polylines if no active deliveries
    }

    fetchPolyline();

    const handlePolylineUpdated = () => {
      fetchPolyline();
    };
    window.addEventListener('routeReordered', handlePolylineUpdated);

    return () => {
      window.removeEventListener('routeReordered', handlePolylineUpdated);
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
          return !['completed', 'failed', 'cancelled'].includes(d.status);
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
  // CRITICAL: Read phase and lock state from REFS, not closure values.
  // ── handleMapViewCycle — the ONLY source of phase advancement ────────────
  const handleMapViewCycle = useCallback(() => {
    if (!isDriver && !isDispatcher && !isAdmin) return;

    // Collapse any open stop card
    setIsExpanded(false);
    setSelectedCardId(null);
    cardExpandedAtRef.current = null;
    setAreCardsVisible(false);

    // CRITICAL: FAB was tapped intentionally — always clear free-pan mode so the
    // state machine below can advance/re-lock normally. goPhase() also clears it,
    // but we need it cleared BEFORE the isCurrentlyLocked checks run.
    mapUserUnlockedRef.current = false;

    const phase = mapViewPhaseRef.current;
    const lockExpired = !mapLockExpiresAtRef.current || mapLockExpiresAtRef.current <= Date.now();

    const goPhase = (nextPhase, shouldLock, unlockMs = null) => {
      if (mapLockTimeoutRef.current) { clearTimeout(mapLockTimeoutRef.current); mapLockTimeoutRef.current = null; }
      mapLockExpiresAtRef.current = null;
      // CRITICAL: Whenever goPhase fires for a real cycle advance, clear the free-pan flag.
      // This means the driver explicitly tapped the FAB — re-enable auto phase follow.
      mapUserUnlockedRef.current = false;
      mapViewPhaseRef.current = nextPhase;
      isMapViewLockedRef.current = shouldLock;
      pendingPhaseRef.current = nextPhase;
      setMapViewPhase(nextPhase);
      setIsMapViewLocked(shouldLock);
      lastProgrammaticMapMoveRef.current = Date.now();
      window._lastProgrammaticMapMove = Date.now();
      setMapViewTrigger((p) => p + 1);
      if (currentUser?.id) saveSetting(currentUser.id, 'fab_map_cycle_phase', nextPhase);
      setTimeout(() => { setAreCardsVisible(true); centerNextDeliveryCard(deliveriesWithStopOrder); }, 500);
      if (unlockMs != null) {
        const exp = Date.now() + unlockMs;
        mapLockExpiresAtRef.current = exp;
        mapLockTimeoutRef.current = setTimeout(() => {
          if (mapLockExpiresAtRef.current === exp) {
            isMapViewLockedRef.current = false; setIsMapViewLocked(false);
            mapLockExpiresAtRef.current = null; mapLockTimeoutRef.current = null;
          }
        }, unlockMs);
      }
    };

    // Phase availability checks — always read from refs/current values, never stale closures
    const tgtId = selectedDriverId !== 'all' ? selectedDriverId : (isDriver ? currentUser?.id : null);
    const tgtAppUser = tgtId ? appUsers.find((au) => au?.user_id === tgtId) : null;
    const tgtOffDuty = tgtAppUser ? tgtAppUser.driver_status === 'off_duty' : false;
    const p2HasStop = !tgtOffDuty && (tgtId
      ? deliveriesWithStopOrder.some((d) => d && d.driver_id === tgtId && d.isNextDelivery && !['completed', 'failed', 'cancelled'].includes(d.status))
      : false);
    const p2Available = p2HasStop && getFabTargetDriverMapLocation({ selectedDriverId, currentUser, isDriver, appUsers, driverLocation, allDriverLocations, isPrimaryDevice });
    const _rd = tgtId ? deliveriesWithStopOrder.filter((d) => d && d.driver_id === tgtId) : deliveriesWithStopOrder;
    // Phase 3: any non-finished stop means the route is still active
    const p3Available = _rd.length === 0 || _rd.some((d) => d && !['completed', 'failed', 'cancelled', 'returned'].includes(d.status));
    // Determine if the selected driver has any stops at all
    const _tgtDeliveries = tgtId
      ? deliveriesWithStopOrder.filter((d) => d && d.driver_id === tgtId)
      : deliveriesWithStopOrder;
    const hasAnyStops = _tgtDeliveries.length > 0;

    // Phase 1 lock: 250ms when driver has zero stops (fast unlock, city-center view),
    // 3s when p2 or p3 exist so cycling is meaningful
    const hasAnyPhase = p2Available || p3Available;
    const p1LockMs = (hasAnyPhase || hasAnyStops) ? 3000 : 250;

    // State machine: phases 2/3 re-lock current phase when unlocked; advance only when locked.
    const isCurrentlyLocked = isMapViewLockedRef.current;
    if (phase === 1 && lockExpired)  { goPhase(1, true, p1LockMs); return; }
    if (phase === 1 && !lockExpired) { goPhase(p2Available ? 2 : p3Available ? 3 : 1, true, hasAnyPhase ? null : p1LockMs); return; }
    if (phase === 2 && !isCurrentlyLocked) {
      goPhase(2, true); return; // re-activate (was unlocked by marker click or similar)
    }
    if (phase === 2 && isCurrentlyLocked)  { goPhase(p3Available ? 3 : 1, true, p3Available ? null : p1LockMs); return; }
    if (phase === 3 && !isCurrentlyLocked) {
      goPhase(3, true); return;
    }
    goPhase(1, true, p1LockMs);
  }, [isDriver, isDispatcher, isAdmin, currentUser, deliveriesWithStopOrder,
      selectedDriverId, appUsers, driverLocation, allDriverLocations, isPrimaryDevice]);

  // Track the last trigger value to prevent re-running on every state change
  const lastAppliedTriggerRef = useRef(0);

  useEffect(() => {
    const activePhase = pendingPhaseRef.current;
    console.log(`🟡 [map FAB start] t=${mapViewTrigger} pending=${activePhase} phaseRef=${mapViewPhaseRef.current} state=${mapViewPhase} locked=${isMapViewLockedRef.current}`);

    // CRITICAL: Only run when mapViewTrigger changes - prevent re-runs from data updates
    if (mapViewTrigger === 0 || mapViewTrigger === lastAppliedTriggerRef.current) {
      console.log(`🟡 [map return 1] t=${mapViewTrigger} pending=${activePhase} phaseRef=${mapViewPhaseRef.current} state=${mapViewPhase} locked=${isMapViewLockedRef.current}`);
      return;
    }

    if (mapViewPhaseRef.current === 0) {
      console.log(`🟡 [map return 2] t=${mapViewTrigger} pending=${activePhase} phaseRef=${mapViewPhaseRef.current} state=${mapViewPhase} locked=${isMapViewLockedRef.current}`);
      return;
    }

    // Update last applied trigger FIRST
    lastAppliedTriggerRef.current = mapViewTrigger;

    // CRITICAL: Only skip phase 2 (driver+next-stop) if not a driver or no location.
    // Phase 3 CAN run for dispatchers (shows incomplete stops for their stores).
    if (mapViewPhaseRef.current === 2 && !(isDispatcher && !isAdmin || isAdmin && selectedDriverId === 'all') && !getFabTargetDriverMapLocation({ selectedDriverId, currentUser, isDriver, appUsers, driverLocation, allDriverLocations, isPrimaryDevice })) {
      console.log(`🟡 [map return 3] t=${mapViewTrigger} pending=${activePhase} phaseRef=${mapViewPhaseRef.current} state=${mapViewPhase} locked=${isMapViewLockedRef.current}`);
      return;
    }

    lastProgrammaticMapMoveRef.current = Date.now();
    window._lastProgrammaticMapMove = Date.now();

    // NOTE: Timer is now started in handleMapViewCycle, not here
    // This useEffect only handles map repositioning

    switch (activePhase) {
      case 1: { // "Show All Stops"
        console.clear;
        console.log(`🟡 [map phase 1] t=${mapViewTrigger} pending=${activePhase} phaseRef=${mapViewPhaseRef.current} state=${mapViewPhase} locked=${isMapViewLockedRef.current}`);
        const allCoordinates = [];
        let hasStopMarkers = false;
        let hasDriverMarkers = false;
        const todayStr = getEdmDate();
        const selectedDateStr = format(selectedDateRef.current, 'yyyy-MM-dd');
        const isViewingToday = todayStr === selectedDateStr;

        // CRITICAL: Treat "Show All" mode same as "All Drivers" mode for map bounds
        const shouldShowAllMarkersForBounds = selectedDriverIdRef.current === 'all' || showAllDriverMarkersRef.current;

        // 1. DRIVER LOCATION: Include the SELECTED driver's location only (not active user if different driver selected)
        if (isViewingToday) {
          const selectedDriverLoc = getFabTargetDriverMapLocation({ selectedDriverId: selectedDriverIdRef.current, currentUser, isDriver, appUsers: appUsersRef.current, driverLocation: driverLocationRef.current, allDriverLocations: allDriverLocationsRef.current, isPrimaryDevice: isPrimaryDeviceRef.current });
          if (selectedDriverLoc?.latitude && selectedDriverLoc?.longitude) {allCoordinates.push([selectedDriverLoc.latitude, selectedDriverLoc.longitude]);hasDriverMarkers = true;}
        }
        const shouldIncludeBlueDot = isMobile && isDriver && !isDriverOffDuty(appUsersRef.current, currentUser?.id, currentUser?.driver_status) && isViewingToday && driverLocationRef.current?.latitude && driverLocationRef.current?.longitude && (selectedDriverId === currentUser?.id || selectedDriverIdRef.current === 'all');

        // 2. SHARED DRIVER LOCATIONS: Skip when a specific driver is selected — their location was already added above.
        const shouldIncludeSharedLocations = !(selectedDriverIdRef.current && selectedDriverIdRef.current !== 'all') && (shouldShowAllMarkersForBounds || isDispatcher || isAdmin);

        // CRITICAL: Also load from window.__mapDriverLocationMarkers (rendered on map)
        const mapDriverLocationMarkers = window.__mapDriverLocationMarkers || [];

        if (isViewingToday && shouldIncludeSharedLocations) {
          let addedCount = 0;

          // CRITICAL: For dispatchers viewing a single driver, prioritize AppUser data directly
          if (isDispatcher && selectedDriverIdRef.current && selectedDriverIdRef.current !== 'all') {
            const assignedDriverAppUser = appUsersRef.current?.find((au) => au?.user_id === selectedDriverIdRef.current);
            if (assignedDriverAppUser?.driver_status === 'on_duty' && assignedDriverAppUser?.current_latitude && assignedDriverAppUser?.current_longitude) {
              allCoordinates.push([assignedDriverAppUser.current_latitude, assignedDriverAppUser.current_longitude]);
              hasDriverMarkers = true;
              addedCount++;
            } else {
              console.warn(`⚠️ [Phase 1 - Dispatcher] Assigned driver has no location data:`, {
                selectedDriverId: selectedDriverIdRef.current,
                appUser: assignedDriverAppUser ? 'found' : 'not found',
                has_lat: !!assignedDriverAppUser?.current_latitude,
                has_lng: !!assignedDriverAppUser?.current_longitude
              });
            }
          }

          // Combine both sources for shared locations
          const allLocationSources = [...(allDriverLocationsRef.current || []), ...mapDriverLocationMarkers];

          // Deduplicate by driver_id
          const uniqueLocations = new Map();
          allLocationSources.forEach((loc) => {
            if (loc?.driver_id && !uniqueLocations.has(loc.driver_id)) {
              uniqueLocations.set(loc.driver_id, loc);
            }
          });

          Array.from(uniqueLocations.values()).forEach((location) => {
            if (!location?.latitude || !location?.longitude || !location?.driver_id) {
              console.log(`🟡 [map phase 1 exit 1] t=${mapViewTrigger} pending=${activePhase} phaseRef=${mapViewPhaseRef.current} state=${mapViewPhase} locked=${isMapViewLockedRef.current}`);
              return;
            }

            // CRITICAL: Skip current user's shared marker if live location is available (prioritize GPS)
            const hasLiveLocation = driverLocationRef.current?.latitude && driverLocationRef.current?.longitude && location.driver_id === currentUser?.id;
            if (hasLiveLocation) {
              console.log(`🟡 [map phase 1 exit 2] t=${mapViewTrigger} pending=${activePhase} phaseRef=${mapViewPhaseRef.current} state=${mapViewPhase} locked=${isMapViewLockedRef.current}`);
              return;
            }

            // CRITICAL: Skip current user on mobile (blue dot shows instead) - but NOT for dispatchers
            const isCurrentUserLocation = isMobile && !isDispatcher && isPrimaryDeviceRef.current && location.driver_id === currentUser?.id;
            if (isCurrentUserLocation) {
              console.log(`🟡 [map phase 1 exit 3] t=${mapViewTrigger} pending=${activePhase} phaseRef=${mapViewPhaseRef.current} state=${mapViewPhase} locked=${isMapViewLockedRef.current}`);
              return;
            }

            // CRITICAL: Skip if this is the assigned driver (already added above for dispatchers)
            if (isDispatcher && selectedDriverIdRef.current && selectedDriverIdRef.current !== 'all' && location.driver_id === selectedDriverIdRef.current) {
              console.log(`🟡 [map phase 1 exit 4] t=${mapViewTrigger} pending=${activePhase} phaseRef=${mapViewPhaseRef.current} state=${mapViewPhase} locked=${isMapViewLockedRef.current}`);
              return;
            }

            if (appUsersRef.current?.find((au) => au?.user_id === location.driver_id)?.driver_status !== 'on_duty') {
              console.log(`🟡 [map phase 1 exit 5] t=${mapViewTrigger} pending=${activePhase} phaseRef=${mapViewPhaseRef.current} state=${mapViewPhase} locked=${isMapViewLockedRef.current}`);
              return;
            }
            // CRITICAL: Phase 1 "Show All" mode - include rendered markers in bounds

            // Dispatcher filtering - only active deliveries in dispatcher's stores
            if (isDispatcher && !isAdmin) {
              const dispatcherStoreIds = new Set((currentUser?.store_ids || []).map((id) => String(id)));
              const _fin = ['completed', 'failed', 'cancelled'];
              const hasActive = deliveriesRef.current.some((d) =>
              d && d.delivery_date === selectedDateStr &&
              d.driver_id === location.driver_id &&
              dispatcherStoreIds.has(String(d.store_id)) && !_fin.includes(d.status)
              );
              if (!hasActive) {
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
          let allDateDeliveries = deliveriesRef.current.filter((d) => d && d.delivery_date === selectedDateStr);

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
          deliveriesToMap = deliveriesWithStopOrderRef.current.length > 0 ? deliveriesWithStopOrderRef.current : deliveriesRef.current.filter((d) => d && d.delivery_date === selectedDateStr && (!selectedDriverId || selectedDriverIdRef.current === 'all' || d.driver_id === selectedDriverIdRef.current));
        }

        let coordsAdded = 0;
        // CRITICAL: Set hasStopMarkers from React state first — window.__mapDeliveryMarkers
        // is populated by the map component AFTER rendering, so it may be empty when this
        // effect fires immediately after a trigger. Reading from React state prevents the
        // ghost bounce to city/home centering caused by stale window globals.
        const stateHasStops = (deliveriesToMap || []).some((d) => {
          if (!d) return false;
          if (d.patient_id) return patientsRef.current?.some((p) => p?.id === d.patient_id && p.latitude && p.longitude);
          return storesRef.current?.some((s) => s?.id === d.store_id && s.latitude && s.longitude);
        });
        if (stateHasStops) hasStopMarkers = true;
        // Add coordinates from window markers (rendered positions) — supplemental
        const windowMarkers = [...(window.__mapDeliveryMarkers || []), ...(window.__mapPickupMarkers || [])];
        if (windowMarkers.length > 0) {
          windowMarkers.forEach((marker) => {
            if (!marker?.latitude || !marker?.longitude) return;
            allCoordinates.push([marker.latitude, marker.longitude]);
            hasStopMarkers = true;
            coordsAdded++;
          });
        } else if (stateHasStops) {
          // Window markers not yet rendered — build coords from React state as fallback
          (deliveriesToMap || []).forEach((d) => {
            if (!d) return;
            if (d.patient_id) {
              const p = patientsRef.current?.find((p) => p?.id === d.patient_id);
              if (p?.latitude && p?.longitude) { allCoordinates.push([p.latitude, p.longitude]); coordsAdded++; }
            } else if (d.store_id) {
              const s = storesRef.current?.find((s) => s?.id === d.store_id);
              if (s?.latitude && s?.longitude) { allCoordinates.push([s.latitude, s.longitude]); coordsAdded++; }
            }
          });
        }

        // 4. HOME LOCATIONS: only add home markers when there are actual stops visible.
        // If there are no stops for the selected driver, skip home markers entirely so
        // the "no stops" fallback (city-center view) triggers correctly below.
        const visibleDriverIdsForBounds = new Set((deliveriesToMap || []).map((d) => d?.driver_id).filter(Boolean));
        if (hasStopMarkers) {
          const mapDriverLocationMarkersForBounds = (window.__mapDriverLocationMarkers || []).filter((marker) => visibleDriverIdsForBounds.has(marker?.driver_id || marker?.driverId || marker?.user_id || marker?.id));
          const mapHomeMarkers = (window.__dashboardMapMarkerHelpers?.getVisibleHomeMarkersForBounds || ((params) => params.mapHomeMarkers || []))({
            mapHomeMarkers: window.__mapHomeMarkers || [],
            mapDeliveryMarkers: (window.__mapDeliveryMarkers || []).filter((marker) => visibleDriverIdsForBounds.has(marker?.driver_id)),
            mapPickupMarkers: (window.__mapPickupMarkers || []).filter((marker) => visibleDriverIdsForBounds.has(marker?.driver_id)),
            currentUser,
            selectedDriverId: selectedDriverIdRef.current,
            showAllDriverMarkers: showAllDriverMarkersRef.current,
            userHasRole,
            hasDriverMarkers: mapDriverLocationMarkersForBounds.length > 0
          });
          mapHomeMarkers.forEach((home) => {if (home.latitude && home.longitude) allCoordinates.push([home.latitude, home.longitude]);});
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

          if (!isDriverOffDuty(appUsersRef.current, currentUser?.id, currentUser?.driver_status) && driverLocationRef.current?.latitude && driverLocationRef.current?.longitude) {
            userRefLat = driverLocationRef.current.latitude;
            userRefLon = driverLocationRef.current.longitude;
            locationSource = 'current_gps';
          } else if (!isDriverOffDuty(appUsersRef.current, currentUser?.id, currentUser?.driver_status) && currentUser?.current_latitude && currentUser?.current_longitude) {
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

          const spanKm = getBoundsSpanKm(allCoordinates);
          const phase1MaxZoom = Math.min(18, getPhaseBoundsMaxZoom(spanKm) + (!isMobile ? 0.7 : 0));

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
        break; } // end case 1

      case 2: { // "Center on Driver & Next Stop" (drivers) OR "All active driver locations + next stops" (dispatchers)
        console.clear;
        console.log(`🟡 [map phase 2 start] t=${mapViewTrigger} pending=${activePhase} phaseRef=${mapViewPhaseRef.current} state=${mapViewPhase} locked=${isMapViewLockedRef.current}`);
        // CRITICAL: Do NOT stamp lastProgrammaticMapMoveRef here.
        // Stamping inside the switch effect resets the GPS interval clock on every pan
        // (including REACTIVATE_FAB-triggered ones), causing the very next GPS tick to
        // pass the minInterval guard immediately and fire a second setShouldFitBounds call.
        // The stamp belongs only in syncMobileLocation (GPS source) and explicit trigger sites.

        let _phase2Handled = false;
        if (isDispatcher && !isAdmin || isAdmin && selectedDriverIdRef.current === 'all') {
          const dispatcherStoreIds2 = new Set((currentUser?.store_ids || []).map((id) => String(id)));
          const selectedDateStr2 = format(selectedDateRef.current, 'yyyy-MM-dd');
          const allDateDeliveries2 = deliveriesRef.current.filter((d) => d && d.delivery_date === selectedDateStr2);
          const finishedStatuses2 = ['completed', 'failed', 'cancelled'];
          const activeDriverIds2 = new Set(
            allDateDeliveries2.filter((d) =>
            d && dispatcherStoreIds2.has(String(d.store_id)) && !finishedStatuses2.includes(d.status) && d.status !== 'pending'
            ).map((d) => d.driver_id).filter(Boolean)
          );
          const phase2DispatcherCoords = [];
          activeDriverIds2.forEach((driverId) => {
            const driverAppUser = appUsersRef.current?.find((au) => au?.user_id === driverId);
            if (driverAppUser?.driver_status === 'on_duty' && driverAppUser?.current_latitude && driverAppUser?.current_longitude) {
              phase2DispatcherCoords.push([driverAppUser.current_latitude, driverAppUser.current_longitude]);
            }
            const driverNextStop = allDateDeliveries2.find((d) => d && d.driver_id === driverId && d.isNextDelivery);
            if (driverNextStop) {
              if (driverNextStop.is_cycling_marker && driverNextStop.cycling_latitude && driverNextStop.cycling_longitude) { phase2DispatcherCoords.push([driverNextStop.cycling_latitude, driverNextStop.cycling_longitude]); }
              else if (driverNextStop.patient_id) { const patient = patientsRef.current.find((p) => p?.id === driverNextStop.patient_id); if (patient?.latitude && patient?.longitude) phase2DispatcherCoords.push([patient.latitude, patient.longitude]); }
              else if (isInterStoreDelivery(driverNextStop.delivery_id)) { const isl = getInterStoreLocationSync(driverNextStop.delivery_id); if (isl?.store_latitude && isl?.store_longitude) phase2DispatcherCoords.push([isl.store_latitude, isl.store_longitude]); else { const s = storesRef.current.find((x) => x && x.id === driverNextStop.store_id); if (s?.latitude && s?.longitude) phase2DispatcherCoords.push([s.latitude, s.longitude]); } }
              else if (driverNextStop.store_id) { const store = storesRef.current.find((s) => s?.id === driverNextStop.store_id); if (store?.latitude && store?.longitude) phase2DispatcherCoords.push([store.latitude, store.longitude]); }
            }
          });
          if (phase2DispatcherCoords.length > 0) {
            const padding = getMapPadding(false);
            setShouldFitBounds({ bounds: phase2DispatcherCoords, options: { ...padding, maxZoom: 17.5, animate: true, duration: 0.9, easeLinearity: 0.15 } });
            setMapCenter(null);
            setMapZoom(null);
          }
          _phase2Handled = true;
        }

        if (!_phase2Handled) {
        const fabTargetDriverLocation = getFabTargetDriverMapLocation({ selectedDriverId: selectedDriverIdRef.current, currentUser, isDriver, appUsers: appUsersRef.current, driverLocation: driverLocationRef.current, allDriverLocations: allDriverLocationsRef.current, isPrimaryDevice: isPrimaryDeviceRef.current });
        if (fabTargetDriverLocation?.latitude && fabTargetDriverLocation?.longitude) {
          const _p2TgtId2 = selectedDriverIdRef.current !== 'all' ? selectedDriverIdRef.current : (isDriver ? currentUser?.id : null); const _selectedDateStr2 = format(selectedDateRef.current, 'yyyy-MM-dd'); const _ns = _p2TgtId2 ? deliveriesRef.current.find((d) => d && d.delivery_date === _selectedDateStr2 && d.driver_id === _p2TgtId2 && d.isNextDelivery === true && d.status !== 'pending') : null;
          const _nc = _ns?.patient_id ? (() => { const p = patientsRef.current.find((x) => x && x.id === _ns.patient_id); return p?.latitude && p?.longitude ? { lat: p.latitude, lon: p.longitude } : null; })() : _ns && isInterStoreDelivery(_ns.delivery_id) ? (() => { const isl = getInterStoreLocationSync(_ns.delivery_id); if (isl?.store_latitude && isl?.store_longitude) return { lat: isl.store_latitude, lon: isl.store_longitude }; const s = storesRef.current.find((x) => x && x.id === _ns.store_id); return s?.latitude && s?.longitude ? { lat: s.latitude, lon: s.longitude } : null; })() : _ns?.store_id ? (() => { const s = storesRef.current.find((x) => x && x.id === _ns.store_id); return s?.latitude && s?.longitude ? { lat: s.latitude, lon: s.longitude } : null; })() : (selectedDriverId === currentUser?.id || !_p2TgtId2 ? nextStopCoordinatesRef.current : null);
          const bounds = [[fabTargetDriverLocation.latitude, fabTargetDriverLocation.longitude], ...(_nc?.lat && _nc?.lon ? [[_nc.lat, _nc.lon]] : [])];
          setShouldFitBounds({ bounds, options: { ...getMapPadding(false), maxZoom: 17.5, animate: true, duration: 0.9, easeLinearity: 0.15 } });
          setMapCenter(null); setMapZoom(null);
        } } // end if (!_phase2Handled)
        break; } // end case 2

      case 3: { // "Center on Incomplete Stops Only + Their Drivers + Pending"
        console.clear;
        console.log(`🟡 [map phase 3 start] t=${mapViewTrigger} pending=${activePhase} phaseRef=${mapViewPhaseRef.current} state=${mapViewPhase} locked=${isMapViewLockedRef.current}`);
        const allCoordinatesPhase3 = [];

        // Check if viewing today's date
        const todayStrPhase3 = getEdmDate();
        const selectedDateStrPhase3 = format(selectedDateRef.current, 'yyyy-MM-dd');
        const isViewingTodayPhase3 = todayStrPhase3 === selectedDateStrPhase3;

        // CRITICAL: Determine if "Show All" mode OR "All Drivers" mode is active
        const isShowAllOrAllDriversMode = showAllDriverMarkersRef.current || selectedDriverIdRef.current === 'all';

        const finishedStatuses = ['completed', 'failed', 'cancelled'];

        if (isShowAllOrAllDriversMode) {
          // MODE 1: Show All / All Drivers - include ALL incomplete + pending stops from ALL drivers
          let allDateDeliveries = deliveriesRef.current.filter((d) => d && d.delivery_date === selectedDateStrPhase3);

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
            if (!d) {
              console.log(`🟡 [map phase 3 exit 1] t=${mapViewTrigger} pending=${activePhase} phaseRef=${mapViewPhaseRef.current} state=${mapViewPhase} locked=${isMapViewLockedRef.current}`);
              return false;
            }
            if (finishedStatuses.includes(d.status)) {
              console.log(`🟡 [map phase 3 exit 2] t=${mapViewTrigger} pending=${activePhase} phaseRef=${mapViewPhaseRef.current} state=${mapViewPhase} locked=${isMapViewLockedRef.current}`);
              return false;
            }
            return true; // Include both in_transit/en_route AND pending
          });

          // CRITICAL: Get unique driver IDs from incomplete + pending deliveries
          const driversWithIncompleteOrPendingStops = new Set(incompleteAndPendingAllDrivers.map((d) => d.driver_id).filter(Boolean));

          // Add incomplete + pending stop coordinates
          incompleteAndPendingAllDrivers.forEach((delivery) => {
            if (delivery.is_cycling_marker && delivery.cycling_latitude && delivery.cycling_longitude) {
              allCoordinatesPhase3.push([delivery.cycling_latitude, delivery.cycling_longitude]);
            } else if (delivery.patient_id) {
              const patient = patientsRef.current.find((p) => p?.id === delivery.patient_id);
              if (patient?.latitude && patient?.longitude) {
                allCoordinatesPhase3.push([patient.latitude, patient.longitude]);
              }
            } else if (delivery.store_id) {
              const store = storesRef.current.find((s) => s?.id === delivery.store_id);
              if (store?.latitude && store?.longitude) {
                allCoordinatesPhase3.push([store.latitude, store.longitude]);
              }
            }
          });

          // CRITICAL: Add driver markers ONLY for drivers with incomplete OR pending stops (only if viewing today)
          if (isViewingTodayPhase3) {
            driversWithIncompleteOrPendingStops.forEach((driverId) => {
              const driverAppUser = appUsersRef.current?.find((au) => au?.user_id === driverId);
              if (driverAppUser?.driver_status === 'on_duty' && driverAppUser?.current_latitude && driverAppUser?.current_longitude) {
                allCoordinatesPhase3.push([driverAppUser.current_latitude, driverAppUser.current_longitude]);
              }
            });
          }

        } else {
          // MODE 2: Single Driver - use selected driver only, never fall back to active user
          const targetDriverId = selectedDriverIdRef.current !== 'all' ? selectedDriverIdRef.current : null; if (!targetDriverId) break;
          allCoordinatesPhase3.push(
            ...collectPhase3SingleDriverCoordinates({
              deliveriesWithStopOrder: deliveriesWithStopOrderRef.current,
              selectedDateStr: selectedDateStrPhase3,
              patients: patientsRef.current,
              stores: storesRef.current,
              isViewingTodayPhase3,
              getFabTargetDriverMapLocation,
              targetDriverId,
              currentUser,
              isDriver,
              appUsers: appUsersRef.current,
              driverLocation: driverLocationRef.current,
              allDriverLocations: allDriverLocationsRef.current,
              isPrimaryDevice: isPrimaryDeviceRef.current,
            })
          );
        }

        // 3. Only fit bounds if we have actual markers to show (NO city center fallback)
        if (allCoordinatesPhase3.length > 0) {
          const padding = getMapPadding(false);

          const spanKm = getBoundsSpanKm(allCoordinatesPhase3);
          const phase3MaxZoom = getPhaseBoundsMaxZoom(spanKm, 12.0);

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
        break; } // end case 3

      default:
        break;
    }
  // CRITICAL: mapViewTrigger is the ONLY dep that should run the effect body.
  // All data values (driverLocation, appUsers, etc.) are accessed via refs below
  // so the effect never re-fires on GPS updates or delivery changes — only on
  // an explicit trigger increment from goPhase() or a background re-pan.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapViewTrigger]);

  // RENDER SEQUENCE EFFECT 1: Track StatsCard & StopCards ready
  // Uses ref flag — no re-render on flip; just unblocks effect 2.
  useEffect(() => {
    if (!isDataLoaded || !userSettingsLoaded) return;
    if (rsStatsAndCardsRef.current) return;
    const hasDeliveries = deliveriesWithStopOrder.length > 0;
    const statsCardMeasured = statsCardRef.current?.offsetHeight > 0;
    const stopCardsMeasured = hasDeliveries ? stopCardsBaseHeight > 0 : true;
    if (statsCardMeasured && stopCardsMeasured) {
      rsStatsAndCardsRef.current = true;
    }
  }, [isDataLoaded, userSettingsLoaded, deliveriesWithStopOrder.length, stopCardsBaseHeight]);

  // RENDER SEQUENCE EFFECT 2: Track FABs ready (after stats/cards)
  // Pure ref-flag cascade — no re-render needed to unlock effect 3.
  useEffect(() => {
    if (!rsStatsAndCardsRef.current) return;
    if (rsFabsRef.current) return;
    const timer = setTimeout(() => {
      rsFabsRef.current = true;
    }, 300);
    return () => clearTimeout(timer);
  }, [rsStatsAndCardsRef.current, rsFabsRef.current]);

  // RENDER SEQUENCE EFFECT 3: Track Map Markers ready — THIS one triggers a re-render
  // (mapMarkers is consumed by MapSection). All gates before it are ref-checks only.
  useEffect(() => {
    if (!rsFabsRef.current) return;
    if (rsMapMarkersReady) return;
    const hasDeliveries = deliveriesWithStopOrder.length > 0;
    const hasPatients = patients.length > 0;
    const hasStores = stores.length > 0;
    const hasRequiredData = (hasDeliveries && hasPatients && hasStores) || (!hasDeliveries && hasStores);
    if (hasRequiredData) {
      rsRouteLinesRef.current = true;
      rsDriverLiveLocRef.current = true;
      setRsMapMarkersReady(true);
    }
  }, [rsFabsRef.current, rsMapMarkersReady, deliveriesWithStopOrder.length, patients.length, stores.length]);

  // Effect 4 (routeLines) collapsed into effect 3 — rsRouteLinesRef set there.

  // RENDER SEQUENCE EFFECT 5: driverLiveLocation — ref-only gate for sharedLocations.
  // For non-drivers this is always true (set in effect 3). For drivers, wait for GPS.
  useEffect(() => {
    if (!rsRouteLinesRef.current) return;
    if (rsDriverLiveLocRef.current) return;
    const hasLocation = driverLocation?.latitude && driverLocation?.longitude;
    if (!isDriver || hasLocation) {
      rsDriverLiveLocRef.current = true;
    }
  }, [rsRouteLinesRef.current, rsDriverLiveLocRef.current, driverLocation, isDriver]);

  // RENDER SEQUENCE EFFECT 6: sharedLocations — ref-only gate; unlocks fullDeliveriesLoaded.
  useEffect(() => {
    if (!rsDriverLiveLocRef.current) return;
    if (rsSharedLocationsRef.current) return;
    const mapDriverMarkers = window.__mapDriverLocationMarkers || [];
    const hasSharedLocations = allDriverLocations.length > 0 || mapDriverMarkers.length > 0;
    if (hasSharedLocations) {
      rsSharedLocationsRef.current = true;
      return;
    }
    const timer = setTimeout(() => { rsSharedLocationsRef.current = true; }, 500);
    return () => clearTimeout(timer);
  }, [rsDriverLiveLocRef.current, rsSharedLocationsRef.current, allDriverLocations.length, isDataLoaded]);

  // RENDER SEQUENCE EFFECT 7: fullDeliveriesLoaded — final gate before fabPhase.
  // CRITICAL: once set it must NEVER reset from background refreshes — that's why
  // rsFullDeliveriesRef is a ref (not state). The fabPhase effect below reads it
  // directly on each of its own re-runs so no cascade re-render is needed here.
  useEffect(() => {
    if (!rsSharedLocationsRef.current) return;
    if (rsFullDeliveriesRef.current) return;
    const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
    const deliveriesToCheck = deliveries.filter((d) => d && d.delivery_date === selectedDateStr);
    if (deliveriesToCheck.length > 0 && patients.length > 0 && stores.length > 0) {
      rsFullDeliveriesRef.current = true;
      return;
    }
    const timer = setTimeout(() => { rsFullDeliveriesRef.current = true; }, 2000);
    return () => clearTimeout(timer);
  // CRITICAL: deliveries intentionally NOT in deps — see original comment above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rsSharedLocationsRef.current, rsFullDeliveriesRef.current, selectedDate, patients.length, stores.length]);

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

  // ── Initial FAB application after data sequence loads ────────────────────
  // Sets the saved phase on the FAB/refs first, then fires the map trigger in a
  // separate setTimeout so React has committed the phase state before the
  // mapViewTrigger effect (which reads pendingPhaseRef) runs.
  const _applyFabPhase = () => {
    const dateStr = format(selectedDate, 'yyyy-MM-dd');
    const hasData = deliveriesWithStopOrder.length > 0 ||
      hasDeliveryDataForSelection({ deliveries, selectedDateStr: dateStr, selectedDriverId });
    if (!hasData) return;
    const _sp = ([1,2,3].includes(Number(initialFabPhase))) ? Number(initialFabPhase) : 1;
    if (mapLockTimeoutRef.current) { clearTimeout(mapLockTimeoutRef.current); mapLockTimeoutRef.current = null; }
    mapLockExpiresAtRef.current = null;
    // Phases 2 & 3: restore locked so map positions to saved phase and next FAB click cycles forward.
    // Phase 1: start unlocked so first click re-locks it (standard phase-1 entry behavior).
    const shouldLock = _sp > 1;
    mapViewPhaseRef.current = _sp; isMapViewLockedRef.current = shouldLock; pendingPhaseRef.current = _sp;
    setMapViewPhase(_sp); setIsMapViewLocked(shouldLock);
    setInitialMapViewApplied(true);
    setRsFabPhaseReady(true);
    lastProgrammaticMapMoveRef.current = Date.now();
    window._lastProgrammaticMapMove = Date.now();
    // CRITICAL: Fire the map trigger in a separate task so React has committed the
    // phase state (setMapViewPhase above) and the map's useEffect([mapViewTrigger])
    // is subscribed before it reads pendingPhaseRef. Without this separation the
    // trigger and the phase-set land in the same batch, the map effect fires before
    // pendingPhaseRef reflects the saved phase, and the map doesn't reposition.
    setTimeout(() => {
      setMapViewTrigger((p) => p + 1);
    }, 150);
  };

useEffect(() => {
    // Read ref directly — no re-render cascade needed; this effect fires when
    // cardsReadyForFAB (state) or rsFabPhaseReady (state) changes.
    if (!rsFullDeliveriesRef.current || rsFabPhaseReady) return;
    if (!cardsReadyForFAB) return;
    if (initialMapViewApplied) { setRsFabPhaseReady(true); return; }
    const currentDateDriverCombo = `${format(selectedDate, 'yyyy-MM-dd')}-${selectedDriverId}`;
    if (initialFabPhaseAppliedRef.current === currentDateDriverCombo) {
        setRsFabPhaseReady(true);
        return;
    }
    fabControlEvents.notifyDataReady();
    setTimeout(() => {
        _applyFabPhase();
        initialFabPhaseAppliedRef.current = currentDateDriverCombo;
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent('centerNextDeliveryCard'));
        }, 800);
    }, 1500);
  }, [rsFullDeliveriesRef.current, rsFabPhaseReady, initialMapViewApplied, cardsReadyForFAB]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { window._mapViewPhaseRef = mapViewPhaseRef; window._pendingPhaseRef = pendingPhaseRef; window._selectedDriverIdRef = selectedDriverIdRef; }, []);

  // Auto-collapse card after 2 minutes (or 500ms on terminal action / outside click)
  useStopCardCollapseTimer({ selectedCardId, cardExpandedAtRef, setSelectedCardId });


  // Unified initial driver selection per role rules
  useEffect(() => {
    if (!currentUser || !isDataLoaded || !driversList.length || !userSettingsLoaded || !isFiltersReady) return;
    if (hasSetInitialDriverDashboard.current) return;

    const isAdmin = userHasRole(currentUser, 'admin');
    const isDispatcherRole = userHasRole(currentUser, 'dispatcher');
    const isDriverRole = userHasRole(currentUser, 'driver');

    const driverExists = (id) => !!id && driversList.some((d) => d && (d.id === id || d.user_id === id));

    const saved = globalFilters.getSelectedDriverId();
    const hasSaved = saved && saved !== 'all' && driverExists(saved);

    let selection = 'all';

    if (isAdmin && isDriverRole) { if (hasSaved) selection = saved; else if (driverExists(currentUser.id)) selection = currentUser.id; else selection = 'all'; }
    else if (isDriverRole && !isAdmin && !isDispatcherRole) { selection = driverExists(currentUser.id) ? currentUser.id : 'all'; }
    else if (isAdmin) { selection = hasSaved ? saved : 'all'; }
    else { selection = 'all'; }
    if (!isDispatcherRole) { setSelectedDriverId(selection); globalFilters.setSelectedDriverId(selection); hasSetInitialDriverDashboard.current = true; return; }
    // DISPATCHER: single store — existing pickup driver → schedule override → store default driver → ''
    hasSetInitialDriverDashboard.current = true;
    {const _ds=format(selectedDate,'yyyy-MM-dd'),_dayIdx=new Date(_ds+'T00:00:00').getDay(),_isSat=_dayIdx===6,_isSun=_dayIdx===0;const _storeId=String((currentUser?.store_ids||[])[0]||'');const _store=(stores||[]).find((s)=>s&&String(s.id)===_storeId);const _driverInAppUsers=(id)=>!!id&&appUsers.some((au)=>au?.user_id===id&&au?.app_roles?.includes('driver'));const _storeDefault=()=>{if(!_store)return'';if(_isSat)return _store.saturday_am_driver_id||_store.saturday_pm_driver_id||'';if(_isSun)return _store.sunday_am_driver_id||_store.sunday_pm_driver_id||'';return _store.weekday_am_driver_id||_store.weekday_pm_driver_id||'';};const _apply=(_f)=>{setSelectedDriverId(_f);globalFilters.setSelectedDriverId(_f);};if(!_storeId){_apply('');return;}// Priority 1: driver who already has a pickup for this store on this date
    const _pickupDriver=(deliveries||[]).find((d)=>d&&d.delivery_date===_ds&&d.store_id===_storeId&&!d.patient_id&&d.driver_id&&!['cancelled','failed'].includes(d.status))?.driver_id||'';if(_pickupDriver&&_driverInAppUsers(_pickupDriver)){_apply(_pickupDriver);return;}base44.entities.DriverScheduleOverride.filter({date:_ds,store_id:_storeId}).then((_ov)=>{const _ovId=(_ov||[]).find((o)=>o&&String(o.store_id)===_storeId)?.driver_id||'';if(!window.__dispatcherOverrideDriverIds)window.__dispatcherOverrideDriverIds={};window.__dispatcherOverrideDriverIds[_ds]=_ovId?[_ovId]:[];_apply(_ovId&&_driverInAppUsers(_ovId)?_ovId:_storeDefault());}).catch(()=>{_apply(_storeDefault());});}
  }, [currentUser?.id, isDataLoaded, userSettingsLoaded, isFiltersReady, driversList, stores, selectedDate]);

  // On driver/date change: reset all ref-flags and both stateful flags
  useEffect(() => {
    setCardsReadyForFAB(false);
    initialFabPhaseAppliedRef.current = null;
    // Reset all ref-flags (non-stateful)
    rsStatsAndCardsRef.current   = false;
    rsFabsRef.current            = false;
    rsRouteLinesRef.current      = false;
    rsDriverLiveLocRef.current   = false;
    rsSharedLocationsRef.current = false;
    rsFullDeliveriesRef.current  = false;
    // Reset stateful flags (triggers re-render once — not 7 times)
    setRsMapMarkersReady(false);
    setRsFabPhaseReady(false);
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
    setIsExpanded(false);setSelectedCardId(null);cardExpandedAtRef.current = null;setAreCardsVisible(false);setCurrentToNextPolyline(null);setDriverRoutes([]);
    hasShownSummaryRef.current.clear();setIsCalendarOpen(false);
    setSelectedDate(date);
    globalFilters.setSelectedDate(date, currentUser?.id);
    const dateStr = format(date, 'yyyy-MM-dd');
    setIsEntityUpdating(true);
    smartRefreshManager.clearPendingUpdates();
    try {
      // Delegate to Layout's triggerFullDataLoad — runs the full 4-step UI-safe sync
      // (globalFilters.setSelectedDate above already invalidated the 5-min cooldown)
      // (offline snapshot → lock UI → fetch fresh data → unlock + apply)
      await refreshData(true);
      // Refresh driver location markers with new date context
      const _aus = await offlineDB.getAll(offlineDB.STORES.APP_USERS).catch(() => appUsers);
      const _ap = (_aus?.length > 0 ? _aus : appUsers);
      if (_ap?.length > 0) {
        driverLocationPoller.processLocationData(currentUser, (deliveries||[]).filter((d)=>d?.delivery_date===dateStr), drivers, stores, _ap, new Date(dateStr+'T00:00:00'), true, 'Dashboard', showAllDriverMarkers||selectedDriverId==='all');
        window.dispatchEvent(new CustomEvent('driverLocationsUpdated', { detail: { appUsers: _ap, forceAll: true } }));
      }
      // Dispatcher: existing pickup driver → schedule override → store default driver
      if (isDispatcher && !isAdmin) { const _dayIdx=new Date(dateStr+'T00:00:00').getDay(),_isSat=_dayIdx===6,_isSun=_dayIdx===0;const _storeId=String((currentUser?.store_ids||[])[0]||'');const _store=(stores||[]).find((s)=>s&&String(s.id)===_storeId);const _driverInAU=(id)=>!!id&&appUsers.some((au)=>au?.user_id===id&&au?.app_roles?.includes('driver'));const _def=()=>{if(!_store)return'';if(_isSat)return _store.saturday_am_driver_id||_store.saturday_pm_driver_id||'';if(_isSun)return _store.sunday_am_driver_id||_store.sunday_pm_driver_id||'';return _store.weekday_am_driver_id||_store.weekday_pm_driver_id||'';};let _f='';if(_storeId){// Priority 1: driver with existing store pickup for this date
      const _pd=(deliveries||[]).find((d)=>d&&d.delivery_date===dateStr&&d.store_id===_storeId&&!d.patient_id&&d.driver_id&&!['cancelled','failed'].includes(d.status))?.driver_id||'';if(_pd&&_driverInAU(_pd)){_f=_pd;}else{try{const _ov=await base44.entities.DriverScheduleOverride.filter({date:dateStr,store_id:_storeId});const _ovId=(_ov||[]).find((o)=>o&&String(o.store_id)===_storeId)?.driver_id||'';if(!window.__dispatcherOverrideDriverIds)window.__dispatcherOverrideDriverIds={};window.__dispatcherOverrideDriverIds[dateStr]=_ovId?[_ovId]:[];_f=_ovId&&_driverInAU(_ovId)?_ovId:'';if(!_f)_f=_def();}catch(_){_f=_def();}}}setSelectedDriverId(_f);globalFilters.setSelectedDriverId(_f); }
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
      await new Promise((r) => setTimeout(r, 300));
      if (mapLockTimeoutRef.current) { clearTimeout(mapLockTimeoutRef.current); mapLockTimeoutRef.current = null; }
      mapLockExpiresAtRef.current = null;
      // Do NOT setIsMapViewLocked here — lock state is exclusively owned by triggerPhase/handleMapViewCycle.
      // Overriding it here can flip phase=1 into a locked state, causing the next cycle to advance to phase 2.
      lastProgrammaticMapMoveRef.current = Date.now();window._lastProgrammaticMapMove = Date.now();
      setMapViewTrigger((prev) => prev + 1);
      centerNextDeliveryCard(deliveriesWithStopOrder);
      fabControlEvents.notifyDataReady();
    } catch (error) {
      console.error('❌ [Dashboard] Date change failed:', error);
    } finally {
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
    setSelectedDriverId(driverId);globalFilters.setSelectedDriverId(driverId, currentUser?.id);
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

      if (typeof window.__fabFlashUpdate === 'function') window.__fabFlashUpdate('route_change');
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

      mapViewPhaseRef.current = 1; isMapViewLockedRef.current = true; pendingPhaseRef.current = 1;
      setMapViewPhase(1); setIsMapViewLocked(true);
      lastProgrammaticMapMoveRef.current = Date.now(); window._lastProgrammaticMapMove = Date.now();
      setMapViewTrigger(nextTrigger); centerNextDeliveryCard(deliveriesWithStopOrder);
      fabControlEvents.notifyDoneButtonClicked(250);
      if (mapLockTimeoutRef.current) { clearTimeout(mapLockTimeoutRef.current); mapLockTimeoutRef.current = null; }
      const _exp = Date.now() + 250; mapLockExpiresAtRef.current = _exp;
      mapLockTimeoutRef.current = setTimeout(() => { if (mapLockExpiresAtRef.current === _exp) { isMapViewLockedRef.current = false; setIsMapViewLocked(false); mapLockExpiresAtRef.current = null; mapLockTimeoutRef.current = null; } }, 250);
    } catch (error) {
      console.error('❌ [Dashboard] Driver change failed:', error);
    } finally {
      if (driverChangeRequestIdRef.current === reqId) {
        setIsEntityUpdating(false);
        driverChangeInProgressRef.current = false;
      }
    }
  };

  // KITT bar phased messages: activate on button click, show 3 phases, clear on done
  const kittTimeoutRef = useRef(null);
  useEffect(() => {
    const handleOptStart = (e) => {
      // All sources now fire through the coordinator — no source filter needed
      if (kittTimeoutRef.current) { clearTimeout(kittTimeoutRef.current); kittTimeoutRef.current = null; }
      setOptimizationMessage('Optimizing Route…');
    };
    const handleOptPhase = (e) => {
      const { phase } = e.detail || {};
      if (phase === 'polylines') {
        setOptimizationMessage('Generating Route Lines…');
      }
    };
    // Listen for the coordinator/debouncer's optimizationRunning event to show/hide the KITT bar
    const handleOptRunning = (e) => {
      const { active } = e.detail || {};
      if (active) {
        if (kittTimeoutRef.current) { clearTimeout(kittTimeoutRef.current); kittTimeoutRef.current = null; }
        setOptimizationMessage('Optimizing Route…');
      } else {
        // active=false means the debouncer finished — clear if coordinator didn't already
        if (kittTimeoutRef.current) { clearTimeout(kittTimeoutRef.current); kittTimeoutRef.current = null; }
        setOptimizationMessage(null);
      }
    };
    const handleOptComplete = (e) => {
      const { source, optimizedCount } = e.detail || {};
      // If optimizedCount is present, this is from the coordinator (success) — show final message
      // If not present, this is a safety-net from the call site's finally block — just clear
      if (optimizedCount != null) {
        const count = optimizedCount || 0;
        setOptimizationMessage(`${count} Stops Optimized`);
      // Clear after 3 seconds
        if (kittTimeoutRef.current) clearTimeout(kittTimeoutRef.current);
        kittTimeoutRef.current = setTimeout(() => {
          setOptimizationMessage(null);
          kittTimeoutRef.current = null;
        }, 3000);
      } else {
        // Safety-net: coordinator threw, just clear the bar
        if (kittTimeoutRef.current) clearTimeout(kittTimeoutRef.current);
        setOptimizationMessage(null);
        kittTimeoutRef.current = null;
      }
    };
    window.addEventListener('routeOptimizationStarted', handleOptStart);
    window.addEventListener('routeOptimizationPhase', handleOptPhase);
    window.addEventListener('routeOptimizationComplete', handleOptComplete);
    window.addEventListener('optimizationRunning', handleOptRunning);
    return () => {
      window.removeEventListener('routeOptimizationStarted', handleOptStart);
      window.removeEventListener('routeOptimizationPhase', handleOptPhase);
      window.removeEventListener('routeOptimizationComplete', handleOptComplete);
      window.removeEventListener('optimizationRunning', handleOptRunning);
      if (kittTimeoutRef.current) clearTimeout(kittTimeoutRef.current);
    };
  }, []);

  // BUG FIX: OptimizationSpinner (the global bottom-right "Optimizing Route" KITT bar)
  // used to show for ANY driver/date optimization happening anywhere in the app — so a
  // driver doing a harmless Staged→Pending flip on their own screen could see the orange
  // banner because a completely unrelated optimization (another driver's Accept All, a
  // dispatcher batch save, etc.) happened to be running in the background at the same
  // moment. Broadcast the currently-viewed driver+date so the spinner can filter to only
  // the route the current user is actually looking at.
  useEffect(() => {
    const dateStr = format(selectedDate, 'yyyy-MM-dd');
    window.__currentDashboardContext = {
      driverId: selectedDriverId === 'all' ? null : selectedDriverId,
      deliveryDate: dateStr,
    };
    window.dispatchEvent(new CustomEvent('dashboardContextChanged', { detail: window.__currentDashboardContext }));
    return () => {
      window.__currentDashboardContext = null;
      window.dispatchEvent(new CustomEvent('dashboardContextChanged', { detail: null }));
    };
  }, [selectedDriverId, selectedDate]);

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
    console.log(`🟠 [map phase unlocked] reason=marker-click phase=${mapViewPhaseRef.current}`);
    setIsMapViewLocked(false);
    lastUserInteractionRef.current = Date.now();

    const cardElement = document.getElementById(`stop-card-${delivery.id}`);
    if (cardElement) {
      cardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }

    // Auto-open Patient History panel for dispatchers clicking their own store's patient markers
    if (
      delivery.patient_id &&
      isDispatcher &&
      !isAdmin &&
      currentUser?.store_ids?.includes(delivery.store_id)
    ) {
      setTimeout(() => {
        const patient = patients.find((p) => p && p.id === delivery.patient_id);
        window.dispatchEvent(new CustomEvent('openPatientHistoryPanel', {
          detail: { patientId: delivery.patient_id, patient }
        }));
      }, 400);
    }
  };

  // Collapse expanded stop card when Patient History panel is closed
  useEffect(() => {
    const handlePatientHistoryPanelClosed = () => {
      setSelectedCardId(null);
      setHighlightedCardId(null);
      cardExpandedAtRef.current = null;
      if (previousMapState?.center && previousMapState?.zoom) {
        setMapCenter(previousMapState.center);
        setMapZoom(previousMapState.zoom);
        setShouldFitBounds(null);
      }
      setPreviousMapState(null);
    };
    window.addEventListener('patientHistoryPanelClosed', handlePatientHistoryPanelClosed);
    return () => window.removeEventListener('patientHistoryPanelClosed', handlePatientHistoryPanelClosed);
  }, [previousMapState]);

  // BUG FIX: collapseExpandedStopCardsForDriver()/collapseAllStopCards() only ever reached
  // HorizontalStopCards.jsx's local handler, which forwards to the onSelectionChange prop
  // (DashboardView.jsx's handleStopCardSelectionChange — the BULK CHECKBOX selection map,
  // which no-ops on a null id) instead of ever touching Dashboard's own `selectedCardId`.
  // So any caller relying purely on that event (e.g. the COD Save/Save & Complete flow,
  // which never goes through handleStatusUpdate.jsx's direct setSelectedCardId(null) call)
  // never actually collapsed the card — it looked like a timing issue but the event simply
  // never reached the real state. Listen for it here too so the event is a real, authoritative
  // collapse regardless of which flow dispatches it.
  useEffect(() => {
    const handleCollapseAllStopCardsEvent = (event) => {
      if (!selectedCardId) return;
      const targetDriverId = event?.detail?.driverId;
      if (targetDriverId) {
        const selectedDelivery = (deliveries || []).find((d) => d?.id === selectedCardId);
        if (selectedDelivery?.driver_id && selectedDelivery.driver_id !== targetDriverId) return;
      }
      setSelectedCardId(null);
      setHighlightedCardId(null);
      cardExpandedAtRef.current = null;
      if (previousMapState?.center && previousMapState?.zoom) {
        setMapCenter(previousMapState.center);
        setMapZoom(previousMapState.zoom);
        setShouldFitBounds(null);
      }
      setPreviousMapState(null);
    };
    window.addEventListener('collapseAllStopCards', handleCollapseAllStopCardsEvent);
    return () => window.removeEventListener('collapseAllStopCards', handleCollapseAllStopCardsEvent);
  }, [selectedCardId, deliveries, previousMapState]);

  const handleCardClick = (delivery) => {
    if (!delivery || !delivery.id) {
      return;
    }

    // CRITICAL: Disable proximity snap for 5 minutes when card is clicked
    lastUserInteractionRef.current = Date.now();

    if (selectedCardId === delivery.id) {
      // Collapsing: restore map to pre-expansion state
      setSelectedCardId(null); setHighlightedCardId(null); cardExpandedAtRef.current = null;
      if (previousMapState?.center && previousMapState?.zoom) { setMapCenter(previousMapState.center); setMapZoom(previousMapState.zoom); setShouldFitBounds(null); }
      setPreviousMapState(null);
      window.dispatchEvent(new CustomEvent('collapseStatsCard'));
      return;
    } else {
      // Card is being expanded
      if (isDispatcher && currentUser?.store_ids && !currentUser.store_ids.includes(delivery.store_id)) {
        if (selectedCardId) { setSelectedCardId(null); setHighlightedCardId(null); cardExpandedAtRef.current = null; }
      }
      setPreviousMapState({ center: Array.isArray(mapCenter) ? [...mapCenter] : null, zoom: mapZoom });

      // Collapse the stats card when a stop card expands or collapses (mutual exclusion)
      if (isExpanded) setIsExpanded(false);
      window.dispatchEvent(new CustomEvent('collapseStatsCard'));
      setSelectedCardId(delivery.id);
      setHighlightedCardId(delivery.id);
      cardExpandedAtRef.current = Date.now();

      // Card expand — do NOT touch lock state. FAB phase is the user's choice;
      // expanding a card is a map inspection action, not a phase transition.

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
            // Only relock if: (a) the current phase hasn't changed since card was clicked,
            // (b) the relock phase is 2 or 3 (never relock phase 1 — that's FAB-exclusive),
            // (c) the delivery is still the next delivery.

          }, 350);
        } else {
          const padding = getMapPadding(false),appUser = appUsers.find((u) => u?.user_id === delivery.driver_id || u?.id === delivery.driver_id),bounds = [];
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
    const { handleSaveDelivery: _doSave } = await import('@/components/dashboard/handleSaveDelivery');
    return _doSave(deliveryData, { editingDelivery, drivers, deliveries, patients, stores, currentUser, selectedDate, updateDeliveriesLocally, applyDeliveryChangesLocally, refreshData, setShowDeliveryForm, setEditingDelivery, hasAutoSelectedRef, setIsEntityUpdating, smartRefreshManager, handleDualDriverOptimization });
  };

  const handleReoptimizeRoute = async () => {
    handleReoptimizeRouteRef.current = handleReoptimizeRoute;
    const mod = await import('@/components/dashboard/handleReoptimizeRoute');
    // CRITICAL: Use the selected driver ID (not currentUser.id) so admins viewing
    // a specific driver's route optimize that driver — not themselves.
    const targetDriverId = selectedDriverId && selectedDriverId !== 'all' ? selectedDriverId : currentUser.id;
    return mod.handleReoptimizeRoute({
      currentUser, selectedDate, appUsers, format,
      driverId: targetDriverId,
      setIsReoptimizing, setOptimizationMessage, setIsEntityUpdating, setSkippedStopsDialogData,
      refreshData, isMapViewLockedRef, setIsMapViewLocked, setMapViewTrigger,
      // Pass local in-memory data to the client-side route engine
      deliveries: deliveriesRef.current, patients: patientsRef.current, stores: storesRef.current,
    });
  };

  const handleDualDriverOptimization = async (originalDriverId, newDriverId, deliveryDate) => {
    const fin = ['completed', 'failed', 'cancelled'];
    for (const driverId of [originalDriverId, newDriverId].filter(Boolean)) {
      const driver = drivers.find((d) => d && d.id === driverId);
      if (!driver) continue;
      const driverDeliveries = await base44.entities.Delivery.filter({ delivery_date: deliveryDate, driver_id: driverId });
      const completed = (driverDeliveries || []).filter((d) => d && fin.includes(d.status));
      const incomplete = (driverDeliveries || []).filter((d) => d && !fin.includes(d.status));
      // Sort completed ascending by actual_delivery_time (earliest = stop 1)
      const sortedCompleted = [...completed].sort((a, b) => {
        const ta = a.actual_delivery_time ? new Date(a.actual_delivery_time).getTime() : Number.MAX_SAFE_INTEGER;
        const tb = b.actual_delivery_time ? new Date(b.actual_delivery_time).getTime() : Number.MAX_SAFE_INTEGER;
        return ta - tb;
      });
      if (incomplete.length === 0) {
        for (let i = 0; i < sortedCompleted.length; i++) if (sortedCompleted[i]) await updateDeliveryLocal(sortedCompleted[i].id, { stop_order: i + 1 });
        continue;
      }
      // Enrich incomplete stops — cycling markers use cycling_latitude/longitude
      const cyclingMarkersIncomplete = incomplete.filter((d) => d && d.is_cycling_marker);
      const regularIncomplete = incomplete.filter((d) => d && !d.is_cycling_marker);
      const enriched = regularIncomplete.map((d) => { if (!d) return null; const e = { ...d }; if (d.patient_id) { const p = patients.find((x) => x && x.id === d.patient_id); if (p?.latitude) { e.latitude = p.latitude; e.longitude = p.longitude; } } else { const s = stores.find((x) => x && x.id === d.store_id); if (s?.latitude) { e.latitude = s.latitude; e.longitude = s.longitude; } } return e; }).filter((d) => d && d.latitude && d.longitude);
      const optimized = optimizeRoute(populateTemporaryStartTimes(enriched, stores), stores, patients, { useAdvancedOptimization: true, respectManualOrder: false, driverHome: driver.home_latitude ? { lat: driver.home_latitude, lon: driver.home_longitude } : null });
      // Merge: completed (asc) → optimized regular stops → cycling markers slotted by their existing stop_order
      const incompleteWithCycling = [...optimized, ...cyclingMarkersIncomplete].sort((a, b) => (Number(a.stop_order) || 99999) - (Number(b.stop_order) || 99999));
      const final = [...sortedCompleted, ...incompleteWithCycling];
      for (let i = 0; i < final.length; i++) {
        const s = final[i]; if (!s) continue;
        const upd = { stop_order: i + 1 };
        if (!fin.includes(s.status)) { upd.delivery_time_eta = s.estimated_arrival || s.delivery_time_start; upd.delivery_time_start = s.delivery_time_start; upd.delivery_time_end = s.delivery_time_end; upd.ampm_deliveries = s.ampm_deliveries; if (!s.tracking_number || s.tracking_number === '99') upd.tracking_number = s.tracking_number; }
        await updateDeliveryLocal(s.id, upd);
      }
    }
  };

  const handleEditDelivery = (delivery) => {
    // Pause any pending debounced optimization for this driver+date
    // so we don't fire mid-edit if the user is chaining edits quickly.
    if (delivery?.driver_id && delivery?.delivery_date) {
      import('@/components/utils/optimizationDebouncer').then(({ pauseDeferredOptimization }) => {
        pauseDeferredOptimization(delivery.driver_id, delivery.delivery_date);
      }).catch(() => {});
    }
    setEditingDelivery(delivery || null);
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

  const triggerPostDeleteOperations = async (driverId, deliveryDate, wasNextDelivery) => {
    try {
      setIsEntityUpdating(true); pauseOfflineSync(); await new Promise((r) => setTimeout(r, 100));
      await recalculateStopOrders(driverId, deliveryDate);

      const { performRouteOptimization } = await import('@/components/utils/routeOptimizationCoordinator');
      const driverAppUser = appUsers.find((au) => au?.user_id === driverId);
      const currentLocation = driverAppUser?.current_latitude && driverAppUser?.current_longitude
        ? { lat: driverAppUser.current_latitude, lon: driverAppUser.current_longitude }
        : null;
      // Snapshot current deliveries for the engine (excluding the deleted one — already removed locally)
      const driverDeliveries = (deliveriesRef.current || []).filter(
        (d) => d && d.driver_id === driverId && d.delivery_date === deliveryDate
      );

      const result = await performRouteOptimization({
        driverId,
        deliveryDate,
        currentLocation,
        deliveries: driverDeliveries,
        patients: patientsRef.current,
        stores: storesRef.current,
        appUsers,
        source: 'delete_delivery',
        // If the deleted stop was NOT the next delivery, skip full re-optimization —
        // just regenerate polylines in existing stop order.
        skipOptimize: !wasNextDelivery,
        preserveExistingOrder: !wasNextDelivery,
      });

      if (result.success && Array.isArray(result.freshDeliveries) && result.freshDeliveries.length > 0) {
        updateDeliveriesLocally?.(result.freshDeliveries, false);
      } else {
        invalidate('Delivery'); await refreshData();
      }
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', { detail: { driverId, deliveryDate, triggeredBy: 'deleteDelivery', alreadyOptimized: true } }));
    } catch (e) { console.error('❌ [DELETE] Background ops failed:', e); } finally { resumeOfflineSync(); setIsEntityUpdating(false); }
  };

  const handleDeleteDelivery = async (deliveryId) => {
    const targetDelivery = deliveriesWithStopOrder.find((d) => d && d.id === deliveryId);
    if (!targetDelivery) { console.error('❌ [DELETE] Not found'); throw new Error('Delivery not found'); }
    const { driverId: _did, delivery_date: _dd, patient_id: _pid, stop_id: _sid, status: _st, cod_total_amount_required: _cod, isNextDelivery: _isNext } = { driverId: targetDelivery.driver_id, ...targetDelivery };
    // Only trigger full re-optimization if this was an active (non-pending) stop
    const _isActive = _st && !['pending', 'completed', 'failed', 'cancelled'].includes(_st);
    const _wasNext = _isActive && !!_isNext;
    if (!_pid && _sid) {
      const pending = deliveriesWithStopOrder.filter((d) => d && d.puid === _sid && d.status === 'pending' && d.patient_id);
      if (pending.length) { const { deleteDeliveryLocal: ddl } = await import('../components/utils/offlineMutations'); for (const p of pending) await ddl(p.id); }
    }
    if (_st === 'in_transit' && _cod > 0 && _pid) await base44.functions.invoke('squareDeleteCodItem', { deliveryId, reason: 'delivery_deleted' }).catch((e) => console.error('⚠️ Square delete failed:', e));
    const { deleteDeliveryLocal } = await import('../components/utils/offlineMutations');
    const p = deleteDeliveryLocal(deliveryId);
    if (selectedCardId === deliveryId) setSelectedCardId(null);
    if (_isActive) triggerPostDeleteOperations(_did, _dd, _wasNext);
    await p;
  };

  const recalculateStopOrders = async (driverId, deliveryDate) => recalculateAndUpdateStopOrders(driverId, deliveryDate);

  const handleRestartDelivery = async (deliveryId) => {
    try {
      setIsEntityUpdating(true); pauseOfflineMutations(); pauseOfflineSync(); smartRefreshManager.pause();
      await new Promise((r) => setTimeout(r, 100));
      const d = deliveriesWithStopOrder.find((x) => x && x.id === deliveryId);
      if (!d) throw new Error('Delivery not found');
      await updateDeliveryLocal(deliveryId, { status: !d.patient_id ? 'en_route' : 'in_transit', actual_delivery_time: null, delivery_notes: '' });
      notifyDriverRetry({ driver: currentUser, patientName: d?.patient_name || 'Unknown', delivery: d, store: stores.find((s) => s?.id === d?.store_id), appUsers }).catch((e) => console.warn('⚠️ notify failed:', e));
      await recalculateStopOrders(d.driver_id, d.delivery_date);
      invalidate('Delivery');
      const fresh = await base44.entities.Delivery.filter({ driver_id: d.driver_id, delivery_date: d.delivery_date });
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, fresh);
      fresh.forEach((x) => { if (x?.id) smartRefreshManager.registerPendingUpdate(x.id, d.driver_id, d.delivery_date); });
      await refreshData();
    } catch (e) { console.error('Error restarting delivery:', e); alert('Failed to restart delivery. Please try again.'); }
    finally { await new Promise((r) => setTimeout(r, 1000)); resumeOfflineMutations(); resumeOfflineSync(); smartRefreshManager.resume(); setIsEntityUpdating(false); }
  };

  const handleStatusUpdate = async (deliveryId, newStatus, extraData = {}, skipAutoCenter = false) => {
    return _handleStatusUpdateImpl(deliveryId, newStatus, extraData, skipAutoCenter, {
      statusUpdateLockRef, deliveriesWithStopOrder, mapViewPhase, isMapViewLocked,
      mapLockTimeoutRef, mapLockExpiresAtRef, isMapViewLockedRef, mapViewPhaseRef, pendingPhaseRef,
      setIsMapViewLocked, setIsEntityUpdating, setSelectedCardId, setHighlightedCardId,
      cardExpandedAtRef, showBreadcrumbs, selectedDriverId, setBreadcrumbsData,
      stopCardsBaseHeight, horizontalStopCardsRef, setStopCardsBaseHeight,
      setMapViewPhase, setMapViewTrigger, lastProgrammaticMapMoveRef,
      updateDeliveriesLocally, currentUser, patients, stores, appUsers, drivers,
      isDispatcher, isAdmin, saveSetting, setEndOfDayDriver, setShowEndOfDayStats,
      hasShownSummaryRef, refreshData,
    });
  };

  const handleNotesUpdate = (deliveryId, notes) => _handleNotesUpdate(deliveryId, notes, { refreshData });
  const handleCODUpdate = (deliveryId, codPayments) => _handleCODUpdate(deliveryId, codPayments, { deliveriesWithStopOrder, updateDeliveriesLocally, setIsEntityUpdating });

  const handleCreateReturn = (args) => _handleCreateReturn(args, { currentUser, deliveries, patients, appUsers, setIsEntityUpdating, forceRefreshDriverDeliveries });

  const handleStartDelivery = async (deliveryId) => {
    const { handleStartDelivery: _doStart } = await import('@/components/dashboard/handleStartDelivery');
    return _doStart({ deliveryId, deliveriesWithStopOrder, deliveries, users, patients, stores, appUsers, currentUser, driverLocation, updateDeliveriesLocally, setIsEntityUpdating, setCurrentToNextPolyline });
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
      pauseOfflineMutations();
      pauseOfflineSync();
      const { handleQuickReorder: _doQuickReorder } = await import('@/components/dashboard/handleQuickReorder');
      await _doQuickReorder(reorderUpdates, selectedDate, currentUser, updateDeliveryLocal, { appUsers });
      setShowQuickAdjustments(false);
    } catch (error) {
      console.error('❌ [Quick Reorder] Error:', error);
      alert('Failed to reorder stops. Please try again.');
    } finally {
      resumeOfflineMutations();
      resumeOfflineSync();
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
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'pending'];

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
        // INTENTIONALLY no setMapViewTrigger here.
        // Pull-to-sync only refreshes data — it must never reposition the map.
        // Map repositioning is exclusively owned by FAB click, GPS updates, date/driver changes.
      } catch (error) { console.error('❌ [Dashboard] Pull to sync update failed:', error); }
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
        // Ensure temp logs exist in IDB for the selected date — fetches from server if missing
        ensureTempLogsForDate({ selectedDateStr, currentUser }).catch(() => {});
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
        const active = (freshDeliveries || []).some((d) => d && !['completed', 'failed', 'cancelled'].includes(d.status));
        if (isTodaySelected && (!t || Date.now() - t >= (active ? 60000 : 300000))) setTimeout(() => window.dispatchEvent(new CustomEvent('triggerPullToSync', { detail: { silent: true, reason: active ? 'initial_load_today_active_routes' : 'initial_load_today_completed_routes' } })), 2000);
      } catch (error) {
        if (error.response?.status === 429 || error.message?.includes('429')) return;
        console.warn('⚠️ [Dashboard Mount - STEP 2] Background sync failed:', error.message);
      }
    };
    setTimeout(backgroundPrioritySync, 1000);
  }, [currentUser?.id, isDataLoaded, isFiltersReady, selectedDateStr, userSettingsLoaded, deliveries]);

  // Intentionally removed: the previous effect called setForceRender on every
  // delivery array change (including GPS-driven appUser updates that indirectly
  // touch the deliveries reference), causing full Dashboard re-renders on every
  // GPS tick and manifesting as map flickering. filteredDeliveries and
  // deliveriesWithStopOrder are derived via useMemo and already update correctly
  // when deliveries changes — the extra forceRender is not needed.

  const dashboardViewModel = useDashboardViewModel({
    isLoadingUser,
    isFiltersReady,
    isDataLoaded,
    userSettingsLoaded,
    currentUser, isDriver, isAdmin, isDispatcher, isMobile,
    deliveries, patients, stores, drivers, appUsers, cities,
    filteredDeliveries, deliveriesWithStopOrder, stats, driversList,
    selectedDate, selectedDriverId, calendarMonth, setCalendarMonth,
    isCalendarOpen, setIsCalendarOpen, handleDateChange, handleDriverChange,
    isDriverDropdownDisabled, isAllDriversMode, isDateFinished,
    mapCenter, mapZoom, shouldFitBounds, setShouldFitBounds, setMapCenter, setMapZoom,
    mapMode, setMapMode, mapViewPhase, setMapViewPhase, isMapViewLocked, setIsMapViewLocked,
    driverLocation, allDriverLocations, currentToNextPolyline, driverRoutes, setDriverRoutes, nextStopCoordinates,
    showRoutes, setShowRoutes, showAllDriverMarkers, setShowAllDriverMarkers,
    showBreadcrumbs, setShowBreadcrumbs, breadcrumbsData, setBreadcrumbsData,
    highlightedCardId, retractClustersRef, renderSequence, setRenderSequence,
    stopCardsBaseHeight, statsCardBaseHeight, statsCardRef, cardsReadyForFAB,
    mapLockTimeoutRef, mapLockExpiresAtRef, lastProgrammaticMapMoveRef,
    mapViewPhaseRef, isMapViewLockedRef,
    handleMapViewCycle, mapViewTrigger, setMapViewTrigger, getMapPadding,
    statsPanelOpacity, isExpanded, setIsExpanded, areCardsVisible,
    handleStatsPanelInteraction, handleCardInteraction, isStatsCardCentered,
    statsCardPositioning, pullToSyncKey, stopCardsContainerRef, horizontalStopCardsRef,
    optimizationMessage, setOptimizationMessage, isReoptimizing, setIsReoptimizing,
    setIsEntityUpdating: _setIsEntityUpdatingBoth, isEntityUpdating, hasRateLimitError, updateDeliveriesLocally, updateAppUsersLocally,
    selectedCardId, handleCardClick, handleMarkerClick,
    showDeliveryForm, setShowDeliveryForm, editingDelivery, setEditingDelivery, defaultToPickupMode: !!editingDelivery && !editingDelivery.patient_id,
    showPatientForm, setShowPatientForm, editingPatient, setEditingPatient,
    patientFormCallback, setPatientFormCallback, patientFormMode, setPatientFormMode,
    showOptimizationSettings, setShowOptimizationSettings,
    showQuickAdjustments, setShowQuickAdjustments,
    handleSaveDelivery, handleSavePatient, handleEditDelivery, handleEditPatient,
    handleDeleteDelivery, handleRestartDelivery, handleStatusUpdate, handleNotesUpdate,
    handleCODUpdate, handleCreateReturn, handleStartDelivery,
    handleCreatePatientFromDelivery, handleQuickReorder, handleAddDelay, handleAcceptAIOptimization,
    showRouteSummary, setShowRouteSummary, summaryDriver, setSummaryDriver,
    showEndOfDayStats, setShowEndOfDayStats, endOfDayDriver, setEndOfDayDriver,
    routeNotification, setRouteNotification,
    isSnapshotModeActive, setIsSnapshotModeActive, snapshotData, setSnapshotData,
    performanceStats, deliveryStats, liveDistance, liveTimeOnDuty, isLoadingPayrollStats,
    dailyPolylineCount, isAIEnabled, showAIAssistant, preferredTravelMode, realTimeETAEnabled,
    mapStyle, setMapStyle, refreshUser, refreshData, dataSource,
    isPrimaryDevice,
  });

  return (<><DashboardScreen {...dashboardViewModel} /><SkippedStopsDialog isOpen={!!skippedStopsDialogData} skippedStops={skippedStopsDialogData} onClose={() => setSkippedStopsDialogData(null)} /></>);
}

export default Dashboard;