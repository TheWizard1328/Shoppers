// Redeployed on 2026-05-21 - Via Superagent The Boss
import React, { useState, useEffect, Fragment, useMemo, useCallback, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
// import "./components/utils/globalErrorHandler";
import { createPageUrl } from "./utils";
import { format, getData, invalidate, loadDeliveries } from './components/utils/dataManager';
import { smartRefreshManager } from './components/utils/smartRefreshManager';
import { backgroundSyncManager } from './components/utils/backgroundSyncManager';
import { offlineDB } from './components/utils/offlineDatabase';
import {
  LayoutDashboard, Users, Package, MapPin, Truck, Bell, HeartPulse, Building, Building2, BarChart3,
  LogOut, UserCheck, Clock, CheckCircle, AlertCircle, ChevronDown, Undo2, Menu, X, RefreshCw, Phone,
  BellRing, Settings, Home, Wrench, UserCog, Stethoscope, MoreVertical, MessageCircle, DollarSign,
  Smartphone } from
"lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from
"@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { getEffectiveUser, clearUserCache } from "./components/utils/auth";
import { base44 } from '@/api/base44Client';
import { motion, AnimatePresence } from "framer-motion";
import { userHasRole, getPrimaryRole, formatRoles, isAppOwner } from './components/utils/userRoles';
import { getDriverDisplayName } from './components/utils/driverUtils';
import { formatPhoneNumber } from './components/utils/phoneFormatter';
import { sortUsers, sortStores } from './components/utils/sorting';
import { UserProvider } from './components/utils/UserContext';
import { AppDataProvider } from './components/utils/AppDataContext';
import MobileHeader from './components/layout/MobileHeader';
import PageTransition from './components/layout/PageTransition';
import { ResizableDivider } from './components/ui/resizable-divider';
import { globalFilters } from './components/utils/globalFilters';
import { syncOnFilterChange, isUiLocked } from './components/utils/filterChangeSync';
import { getActiveDriversForCity, getAvailableDrivers } from './components/utils/driverSelectors';
// Removed: getCitiesWithinRadius - no longer using geographic filtering
import { getUserAgentInfo, isMobileDeviceForTheme } from './components/utils/deviceUtils';
import { DeviceProvider, useDevice } from './components/utils/DeviceContext';

import DriverStatusToggle from './components/layout/DriverStatusToggle';
import LocationTrackingToggle from './components/layout/LocationTrackingToggle';
import AppErrorBoundary from './components/layout/AppErrorBoundary';
import { loadUserSettings, saveSetting, clearSettingsCache, getDeviceType, getDeviceIdentifier } from './components/utils/userSettingsManager';
import useAutoThemeSync from './components/utils/useAutoThemeSync';
import DeviceSelectionModal from './components/devices/DeviceSelectionModal';
import SmartRefreshIndicator from './components/layout/SmartRefreshIndicator';
import { isMobileDevice } from './components/utils/deviceUtils';
import { QrCode } from 'lucide-react';
import { toast } from 'sonner';
import { performInitialSync, processPendingMutations, performBackgroundSync } from './components/utils/offlineSync';
import { requestThrottler } from './components/utils/requestThrottler';
import OfflineSyncIndicator from './components/layout/OfflineSyncIndicator';
import { subscribeMutations } from './components/utils/entityMutations';
import { realtimeSync, subscribeToRealtime } from './components/utils/realtimeSync';
import { calculateUserCodTotal, calculateRouteCodBalance } from './components/utils/codTotalCalculator';
import BatteryIndicator from './components/layout/BatteryIndicator';
import SettingsMenu from './components/layout/SettingsMenu';
import { getCompanyBranding, applyBrandingStyles } from './components/utils/brandingManager';
// OptimizationSpinner removed — replaced by the black KITT bar above stop cards in DashboardView
import PatientViewOverlay from './components/patient-portal/PatientViewOverlay';
import MobileBottomNav from './components/layout/MobileBottomNav';
import SidebarUserFooter from './components/layout/SidebarUserFooter';
import AdminNavigationSection from './components/layout/AdminNavigationSection';
import AppLoadingScreen from './components/layout/AppLoadingScreen';
import SidebarDivider from './components/layout/SidebarDivider';
import SidebarSectionLabel from './components/layout/SidebarSectionLabel';
import getAdminNavigationItems from './components/layout/getAdminNavigationItems';
import { getLayoutStyles } from './components/layout/layoutStyles';
import { useWakeLockAndVisibility } from './components/layout/useWakeLockAndVisibility';
import { mergePatients } from './components/layout/layoutDataHelpers';
import { initializeAppLoadDataFlow, executeAppLoadDataSync } from './components/layout/AppLoadDataManager';
import { initPushNotifications } from '@/components/utils/pushNotifications';
import { initializeGlobalFilters, createMergedUser, hasCurrentUserRefreshImpact } from './components/layout/initializeGlobalFilters';
import { usePayrollBadge } from './components/layout/usePayrollBadge';
import { useLayoutEventHandlers } from './components/layout/useLayoutEventHandlers';
import { useLayoutInit } from './components/layout/useLayoutInit';
import AppSidebar from './components/layout/AppSidebar';
import GlobalOverlays from './components/layout/GlobalOverlays';

// App version will be loaded from AppSettings
const DEFAULT_APP_VERSION = 'v1.0.0';

import QuickStats from './components/layout/DashboardQuickStats';
import { initTileCacheManager } from '@/components/utils/tileCacheManager';

const CollapsibleSidebarLink = ({ title, icon: Icon, children, open, onToggle, count, isActive }) => {
  return (
    <div>
      <div
        onClick={onToggle}
        className={`group hover:bg-slate-50 transition-all duration-200 rounded-xl mb-1 cursor-pointer flex items-center justify-between gap-3 px-4 py-3 ${
        isActive ? 'bg-slate-100 text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`
        }>

        <div className="flex items-center gap-3">
          {Icon && <Icon className="w-5 h-5" />}
          <span className="font-semibold">{title}</span>
          {count !== undefined && <Badge variant="secondary" className="bg-slate-200 text-slate-600">{count}</Badge>}
        </div>
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </div>
      <AnimatePresence>
        {open &&
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.15, ease: "easeInOut" }}
          className="overflow-hidden pl-6">

            <div className="py-2 border-l border-slate-200 space-y-1">
              {children}
            </div>
          </motion.div>
        }
      </AnimatePresence>
    </div>);

};

export default function Layout({ children, currentPageName }) {
  const location = useLocation();
  const [currentUser, setCurrentUser] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [isLoadingLayout, setIsLoadingLayout] = useState(true);
  const [hasAccess, setHasAccess] = useState(false);

  const [initialGlobalFiltersSet, setInitialGlobalFiltersSet] = useState(false);
  const [showCitySelectionPopup, setShowCitySelectionPopup] = useState(false);

  const skipInitialFullDataLoadRef = useRef(false);

  const [isFormOverlayOpen, setIsFormOverlayOpen] = useState(false);
  const [isEntityUpdating, setIsEntityUpdating] = useState(false);
  const [smartRefreshActivity, setSmartRefreshActivity] = useState({ active: false, updatedEntities: [] });
  const [showPatientImport, setShowPatientImport] = useState(false);
  const [showDeliveryImport, setShowDeliveryImport] = useState(false);

  const [deliveries, setDeliveries] = useState([]);
  const [patients, setPatients] = useState([]);
  const [cities, setCities] = useState([]);
  const [stores, setStores] = useState([]);
  const [users, setUsers] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [appUsers, setAppUsers] = useState([]);
  const [selectedStoreId, setSelectedStoreId] = useState(null);
  const [openMenu, setOpenMenu] = useState(null);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [catalogItems, setCatalogItems] = useState([]);
  const [totalCodsDue, setTotalCodsDue] = useState(0);
  const [squareLocationConfigs, setSquareLocationConfigs] = useState([]);
  const [squareTransactions, setSquareTransactions] = useState([]);

  // Persisted FAB map cycle phase — loaded from UserSettings on boot, saved on every manual change
  const [initialFabPhase, setInitialFabPhase] = useState(1);

  // ── Device layout — single source of truth via DeviceContext ────────────
  // DeviceProvider (wrapping the return) handles all detection + tablet orientation.
  // Destructure here so the rest of this component keeps working without changes.
  const { isMobile, isTabletPortrait, deviceType, os } = useDevice();
  const isMobileDeviceForUI = isMobile; // alias kept for components that reference this name

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [screenWidth, setScreenWidth] = useState(window.innerWidth);
  const [cardWidth, setCardWidth] = useState(300);

  const refreshIntervalRef = useRef(null);
  const wakeLockRef = useRef(null);
  const onSmartRefreshCompleteRef = useRef(null);
  const type1PolylineRefreshRef = useRef(new Map());

  // Remove unused driverLocationIntervalRef - now handled by unified refresh

  const [sidebarWidth, setSidebarWidth] = useState(260); // Will be loaded from user settings
  const [themePreference, setThemePreference] = useState('auto');
  const [userSettingsLoaded, setUserSettingsLoaded] = useState(false);

  useAutoThemeSync(themePreference);
  const [dataSource, setDataSource] = useState('offline'); // 'offline' or 'online'
  const [branding, setBranding] = useState({
    logo_url: '',
    favicon_url: '',
    primary_color: '#000000',
    secondary_color: '#FFFFFF',
    accent_color: '#0066CC'
  });

  const handleThemeChange = async (newTheme) => {
    setThemePreference(newTheme);
    if (currentUser?.id) {
      saveSetting(currentUser.id, 'theme_preference', newTheme);
    }
  };

  const handleDataSourceChange = async (newSource) => {
    setDataSource(newSource);
    if (currentUser?.id) {
      saveSetting(currentUser.id, 'data_source', newSource);
    }

    // Dispatch event for Dashboard to re-load data from selected source
    window.dispatchEvent(new CustomEvent('dataSourceChanged', {
      detail: { source: newSource }
    }));
  };
  const [showMessaging, setShowMessaging] = useState(false);
  const [unreadMessageCount, setUnreadMessageCount] = useState(0);
  const [initialConversation, setInitialConversation] = useState(null);
  const [appVersion, setAppVersion] = useState(DEFAULT_APP_VERSION);
  const [adminImportEnabled, setAdminImportEnabled] = useState(false);

  const [showInviteQRModal, setShowInviteQRModal] = useState(false);
  const [deviceRegistered, setDeviceRegistered] = useState(false);
  const [showDeviceSelectionModal, setShowDeviceSelectionModal] = useState(false);
  const [deviceTypeDetected, setDeviceTypeDetected] = useState(null);
  const [isSettingUpDevice, setIsSettingUpDevice] = useState(false);
  const [showInitRetryHint, setShowInitRetryHint] = useState(false);

  // ─── Web Push: subscribe as soon as possible ────────────────────────────────
  // If permission is already granted → subscribe immediately.
  // If permission is 'default' (not yet asked) → wait for first user gesture
  // so the browser permission prompt feels natural (iOS/Android requirement).
  useEffect(() => {
    if (!currentUser?.id || typeof Notification === 'undefined') return;

    if (Notification.permission === 'granted') {
      // Already permitted — subscribe right away (safe to call repeatedly, idempotent)
      initPushNotifications(currentUser.id).catch(() => {});
      return;
    }

    if (Notification.permission !== 'default') return; // 'denied' — nothing to do

    // Not yet asked — request on first meaningful gesture
    const handleFirstGesture = () => {
      document.removeEventListener('pointerdown', handleFirstGesture, true);
      document.removeEventListener('keydown', handleFirstGesture, true);
      initPushNotifications(currentUser.id).catch(() => {});
    };
    document.addEventListener('pointerdown', handleFirstGesture, true);
    document.addEventListener('keydown', handleFirstGesture, true);
    return () => {
      document.removeEventListener('pointerdown', handleFirstGesture, true);
      document.removeEventListener('keydown', handleFirstGesture, true);
    };
  }, [currentUser?.id]);

  // ─── Deep-link: open chat from push notification tap ────────────────────
  useEffect(() => {
    if (!currentUser?.id) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const openChatUserId = params.get('openChat');
      if (!openChatUserId) return;
      const openChatName = params.get('openChatName') || 'User';
      const conversationId = [currentUser.id, openChatUserId].sort().join('_');
      setInitialConversation({ conversationId, otherUserId: openChatUserId, otherUserName: decodeURIComponent(openChatName) });
      setShowMessaging(true);
      params.delete('openChat');
      params.delete('openChatName');
      const newSearch = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${newSearch ? `?${newSearch}` : ''}${window.location.hash}`);
    } catch (_) {}
  }, [currentUser?.id]);

  // AppSettings sync via WebSocket realtime only (no polling)
  // adminImportEnabled updates are received through the realtimeSync WebSocket subscription
  // The realtimeSync module subscribes to AppSettings entity changes and dispatches events
  useEffect(() => {
    if (!currentUser) return;
    if (isAppOwner(currentUser)) return; // App owner controls the toggle directly

    const handleAppSettingsUpdate = (event) => {
      const updated = event.detail?.data || event.detail;
      if (!updated) return;
      if (updated.setting_key === 'refresh_intervals' && updated.setting_value) {
        const newValue = updated.setting_value.adminImportEnabled === true;
        setAdminImportEnabled(newValue);
      }
    };

    window.addEventListener('appSettingsUpdated', handleAppSettingsUpdate);
    return () => window.removeEventListener('appSettingsUpdated', handleAppSettingsUpdate);
  }, [currentUser]);

  // ATOMIC INIT: Unified loading state - keeps spinner until device+auth+data confirmed
  // ─── App bootstrap + sync lifecycle ────────────────────────────────────
  // Extracted to useLayoutInit (init sequence, cleanup, retry timer, bg sync).
  useLayoutInit({
    isLoadingLayout, isFormOverlayOpen, dataLoaded, currentUser, currentPageName,
    setIsLoadingLayout, setDeviceTypeDetected, setHasAccess, setCurrentUser,
    setDataLoaded, setDeviceRegistered, setSidebarWidth, setThemePreference,
    setDataSource, setUserSettingsLoaded, setAppVersion, setAdminImportEnabled,
    setBranding, setCities, setShowCitySelectionPopup, setSquareLocationConfigs,
    setCatalogItems, setSquareTransactions, setDeliveries, setPatients,
    setAppUsers, setStores, setInitialGlobalFiltersSet, setShowInitRetryHint,
    setInitialFabPhase,
  });

  // Real-time sync broadcasts removed - relying on smart refresh only

  // Pause sync managers when forms are open
  useEffect(() => {
    if (isFormOverlayOpen) {
      smartRefreshManager.pause();
      backgroundSyncManager.pause();
    } else {
      smartRefreshManager.resume();
      backgroundSyncManager.resume();
    }
  }, [isFormOverlayOpen]);

  // Listen for pause/resume sync events from dialogs
  useEffect(() => {
    const handlePauseSync = () => {
      smartRefreshManager.pause();
      backgroundSyncManager.pause();
    };
    const handleResumeSync = () => {
      smartRefreshManager.resume();
      backgroundSyncManager.resume();
    };
    window.addEventListener('pauseBackgroundSync', handlePauseSync);
    window.addEventListener('resumeBackgroundSync', handleResumeSync);
    return () => {
      window.removeEventListener('pauseBackgroundSync', handlePauseSync);
      window.removeEventListener('resumeBackgroundSync', handleResumeSync);
    };
  }, []);

  // ─── Event Subscriptions are wired after callbacks are defined (see below) ───

  // Mirror squareLocationConfigs to window for synchronous access in Square POS launcher
  useEffect(() => {
    window.__squareLocationConfigCache = squareLocationConfigs;
  }, [squareLocationConfigs]);

  // Recalculate COD total whenever catalog items or user changes
  useEffect(() => {
    if (!currentUser || catalogItems.length === 0) {
      setTotalCodsDue(0);
      return;
    }

    const codTotal = calculateUserCodTotal(currentUser, catalogItems, squareLocationConfigs, stores, squareTransactions);
    setTotalCodsDue(codTotal);
  }, [currentUser, catalogItems, squareLocationConfigs, stores, squareTransactions]);

  // SquareTransaction realtime updates are handled from cached/offline data only

  // CRITICAL: Message polling DISABLED - causes rate limits
  // Messages will only load when user opens messaging panel

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (sidebarOpen) {
          setSidebarOpen(false);
        } else if (collapsed) {
          setCollapsed(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    const handleClickOutside = (event) => {
      if (sidebarOpen && isMobile) {
        const sidebar = document.querySelector('.app-sidebar');
        const menuButton = event.target.closest('button');

        // Don't close if clicking the menu button itself
        if (menuButton && menuButton.querySelector('.lucide-menu, .lucide-x')) {
          return;
        }

        if (sidebar && !sidebar.contains(event.target)) {
          setSidebarOpen(false);
        }
      }
    };
    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
      }
    };
  }, [sidebarOpen, isMobile]);

  // Ref to track if we're currently reloading data due to AppUser change
  const isReloadingFromAppUserChange = useRef(false);
  const needsDataReload = useRef(false);

  // Granular delivery update function for immediate UI synchronization
  const updateDeliveriesLocally = useCallback((newDeliveries, isFullReplacement = false) => {
    if (isFullReplacement) {
      setDeliveries((prev) => {
        const next = newDeliveries?.filter(Boolean).length || !prev.length ? [...(newDeliveries || []).filter(Boolean)] : prev;
        // Sync window.__appDeliveries SYNCHRONOUSLY so flushRealtimeBatch sees latest
        // state immediately — before the useEffect in AppDataContext fires after paint.
        if (typeof window !== 'undefined') window.__appDeliveries = next;
        return next;
      });
    } else {
      setDeliveries((prevDeliveries) => {
        const merged = new Map((prevDeliveries || []).filter(Boolean).map((delivery) => [delivery.id, delivery]));
        (newDeliveries || []).filter(Boolean).forEach((delivery) => {
          if (!delivery?.id) return;
          const existing = merged.get(delivery.id);
          merged.set(delivery.id, existing ? { ...existing, ...delivery } : delivery);
        });
        const next = Array.from(merged.values());
        // Sync window.__appDeliveries SYNCHRONOUSLY so flushRealtimeBatch sees latest
        // state immediately — before the useEffect in AppDataContext fires after paint.
        if (typeof window !== 'undefined') window.__appDeliveries = next;
        return next;
      });
    }
  }, []);

  // Granular AppUser update function for immediate UI synchronization
  const updateAppUsersLocally = useCallback((newAppUsers, isFullReplacement = false) => {
    if (isFullReplacement) {
      setAppUsers((prev) => newAppUsers?.filter(Boolean).length || !prev.length ? [...newAppUsers.filter(Boolean)] : prev);
    } else {
      setAppUsers((prevAppUsers) => {
        const updatesMap = new Map(newAppUsers.map((u) => [u.id, u]));
        return prevAppUsers.map((appUser) => {
          if (!appUser) return appUser;
          const update = updatesMap.get(appUser.id);
          if (update) return { ...appUser, ...update };
          return appUser;
        });
      });
    }
  }, []);

  // Callback to update state from smartRefreshManager
  const updateAppDataState = useCallback(async (updates) => {
    if (isFormOverlayOpen) return;

    if (updates.deliveries && updates.deliveries.length === 0 && deliveries.length > 0) return;
    if (updates.patients && updates.patients.length === 0 && patients.length > 0) return;

    if (updates.deliveries) updateDeliveriesLocally(updates.deliveries, false); // CRITICAL: merge, never replace — prevents wiping other drivers' stops
    if (updates.patients) setPatients(updates.patients);
    // CRITICAL: Merge stores — never replace. SmartRefresh may return a city-scoped
    // subset; a full replacement would wipe stores from other cities/pages.
    if (updates.stores && updates.stores.length > 0) {
      setStores((prev) => {
        const map = new Map((prev || []).filter(Boolean).map((s) => [s.id, s]));
        updates.stores.forEach((s) => { if (s?.id) map.set(s.id, s); });
        return sortStores(Array.from(map.values()));
      });
    }
    if (updates.appUsers) {

      if (currentUser && !isReloadingFromAppUserChange.current) {
        const updatedAppUserForCurrentUser = updates.appUsers.find((au) => au && au.user_id === currentUser.id);

        // CRITICAL: Never reload for driver_status / location-only changes.
        // DriverStatusToggle writes these fields; a full reload would wipe sidebar + all data.
        const RELOAD_SKIP_KEYS = new Set(['driver_status', 'location_tracking_enabled', 'current_latitude', 'current_longitude', 'location_updated_at', 'updated_date', 'id', 'user_id']);
        const hasOnlyTransientChanges = updatedAppUserForCurrentUser &&
          Object.keys(updatedAppUserForCurrentUser).every(k => RELOAD_SKIP_KEYS.has(k));

        if (updatedAppUserForCurrentUser && !hasOnlyTransientChanges) {
          if (hasCurrentUserRefreshImpact(currentUser, updatedAppUserForCurrentUser)) {
            isReloadingFromAppUserChange.current = true;
            setAppUsers(updates.appUsers);
            clearUserCache();
            invalidate('AppUser');
            const refreshedUser = await getEffectiveUser();

            if (refreshedUser) {
              invalidate('Store');
              invalidate('Patient');
              invalidate('Delivery');
              invalidate('User');
              setCurrentUser(refreshedUser);
              needsDataReload.current = true;
            }

            isReloadingFromAppUserChange.current = false;
            return;
          }
        }
      }

      setAppUsers(updates.appUsers);
    }
    if (updates.users) setUsers(updates.users);
  }, [currentUser, isFormOverlayOpen, deliveries, patients, updateDeliveriesLocally]);

  const triggerFullDataLoadRef = useRef();

  // ─── Event Subscriptions ────────────────────────────────────────────────
  // Placed here so all callbacks (triggerFullDataLoad, updateDeliveriesLocally, etc.) are defined first.
  useLayoutEventHandlers({
    currentUser, currentPageName, initialGlobalFiltersSet, dataLoaded,
    isFormOverlayOpen, deliveries, patients, appUsers, stores, cities, drivers,
    setDeliveries, setPatients, setAppUsers, setStores, setCities, setUsers,
    setCatalogItems, setCurrentUser, setShowMessaging, setInitialConversation,
    setUnreadMessageCount,
    triggerFullDataLoad: triggerFullDataLoadRef, updateDeliveriesLocally, updateAppUsersLocally, updateAppDataState,
  });

  // CRITICAL: Background sync moved to useEffect with proper dependencies

  useWakeLockAndVisibility({ currentPageName, initialGlobalFiltersSet, currentUser, dataLoaded, isFormOverlayOpen, stores });

  // CRITICAL: Rapid reload from offline DB when page changes
  useEffect(() => {
    if (!initialGlobalFiltersSet || !currentUser || !dataLoaded) return;

    const reloadPageData = async () => {
      try {
        const mod = await import('./components/utils/pageDataReloader');
        const filters = { selectedDate: globalFilters.getSelectedDate(), selectedCityId: globalFilters.getSelectedCityId(), selectedDriverId: globalFilters.getSelectedDriverId(), currentUser };
        await mod.pageDataReloader.reloadPageData(currentPageName, filters);
      } catch (_) {/* non-critical — pages filter data locally */}
    };

    reloadPageData();

    // Force immediate refresh when navigating to Dashboard
    if (currentPageName === 'Dashboard') {
      smartRefreshManager.lastRefreshTimes = {
        driverLocation: 0,
        activeDeliveries: 0,
        todayDeliveries: 0,
        appUsers: 0,
        patients: 0,
        stores: 0
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPageName]);

  useEffect(() => {
    const handleResize = () => {
      setScreenWidth(window.innerWidth);

      if (!isMobile && sidebarOpen) {
        setSidebarOpen(false);
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [sidebarOpen, isMobile]);

  const updatePolylineOnRefresh = async (driverId, dateStr, currentLocation = null) => {
    if (!driverId || driverId === 'all') return;

    try {
      const deliveryDate = dateStr || format(new Date(), 'yyyy-MM-dd');
      const refreshKey = `${driverId}:${deliveryDate}`;
      const lastRefreshAt = type1PolylineRefreshRef.current.get(refreshKey) || 0;
      if (Date.now() - lastRefreshAt < 30000) return;

      let nextLocation = currentLocation;
      if (!nextLocation?.lat || !nextLocation?.lon) {
        const appUsers = await base44.entities.AppUser.filter({ user_id: driverId });
        const driverAppUser = appUsers?.[0];
        if (!driverAppUser?.current_latitude || !driverAppUser?.current_longitude) return;
        nextLocation = {
          lat: Number(driverAppUser.current_latitude),
          lon: Number(driverAppUser.current_longitude)
        };
      }

      type1PolylineRefreshRef.current.set(refreshKey, Date.now());
      await base44.functions.invoke('regenerateType1Polyline', {
        driverId,
        deliveryDate,
        currentLocation: nextLocation
      });
    } catch (error) {

      // Silent fail
    }}; //const currentUser = currentUser;
  const handleCitySelected = useCallback(async (cityId) => {try {globalFilters.setSelectedCityId(cityId);const today = new Date();globalFilters.setSelectedDate(today);const refreshedUser = await getEffectiveUser();if (refreshedUser) {
          setCurrentUser(refreshedUser);
          globalFilters.setSelectedDriverId('all');
        }

        setShowCitySelectionPopup(false);
        setInitialGlobalFiltersSet(true);
      } catch (error) {
        alert('Failed to save city selection. Please try again.');
        setShowCitySelectionPopup(true);
      }
    }, []);

  const triggerFullDataLoad = useCallback(async (forceRefresh = false) => {
    if (isFormOverlayOpen) return;
    if (triggerFullDataLoad.isRunning) return;

    // COOLDOWN GUARD: skip automatic syncs within 5 minutes of last refresh.
    // forceRefresh=true (city change, pull-to-sync, connection recovery) always bypasses.
    if (!globalFilters.isRefreshNeeded(forceRefresh)) {
      console.log('⏳ [Layout] triggerFullDataLoad skipped — within 5-min cooldown');
      return;
    }

    triggerFullDataLoad.isRunning = true;

    try {
      const selectedCityId = globalFilters.getSelectedCityId();
      const selectedDateStr = globalFilters.getSelectedDate();

      if (!currentUser || !selectedCityId || selectedCityId === 'waiting-for-selection') {
        setDataLoaded(false);
        return;
      }

      // CRITICAL: Load Square data from offline DB first (non-blocking, no API call)
      const { offlineDB } = await import('./components/utils/offlineDatabase');
      const [sqConfigs, sqTx, sqCatalog] = await Promise.all([
      offlineDB.getAll(offlineDB.STORES.SQUARE_LOCATION_CONFIGS),
      offlineDB.getAll(offlineDB.STORES.SQUARE_TRANSACTIONS),
      offlineDB.getAll(offlineDB.STORES.SQUARE_CATALOG_ITEMS)]
      );
      setSquareLocationConfigs(sqConfigs || []);
      setCatalogItems(sqCatalog || []);
      setSquareTransactions(sqTx || []);

      // Helper — applies a complete dataset to all state in one pass (single UI update)
      const applyFullDataToState = ({ deliveries, patients, appUsers, stores, cities }) => {
      if (cities && cities.length > 0) setCities(cities.sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity)));
      if (stores && stores.length > 0) setStores(stores.sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity)));
      // CRITICAL: Merge patients to preserve full patient DB during syncs
      if (patients) setPatients((prev) => mergePatients(prev, patients));
      // Stamp AppUsers as refreshed so the SmartRefresh poll cooldown starts from now
      if (appUsers && appUsers.length > 0 && typeof smartRefreshManager?.stampAppUsersAsRefreshed === 'function') {
        smartRefreshManager.stampAppUsersAsRefreshed(appUsers);
      }
      const mergedUsersMap = new Map();
        if (currentUser) mergedUsersMap.set(currentUser.id, currentUser);
        (appUsers || []).forEach((appUser) => {
          if (!appUser || mergedUsersMap.has(appUser.user_id)) return;
          const pseudoUser = createMergedUser(null, appUser);
          if (pseudoUser) mergedUsersMap.set(pseudoUser.id, pseudoUser);
        });
        const initialUsers = Array.from(mergedUsersMap.values()).filter(Boolean);
        const activeDrivers = sortUsers(initialUsers.filter((user) =>
        user && Array.isArray(user.app_roles) && (
        user.app_roles.includes('driver') || user.app_roles.includes('admin')) &&
        user.user_name && user.status === 'active'
        ));
        setUsers(initialUsers);
        setDrivers(activeDrivers);
        if (appUsers && appUsers.length > 0) setAppUsers(appUsers);
        // CRITICAL: Merge deliveries — never replace. A full replacement wipes other
        // drivers' data if the incoming set is date-scoped or city-filtered.
        updateDeliveriesLocally(deliveries || [], false);
        setDataLoaded(true);
        setTotalCodsDue(calculateUserCodTotal(currentUser, sqCatalog || [], sqConfigs || [], stores, sqTx || []));
      };

      // ── 4-STEP UI-SAFE FILTER CHANGE SYNC ───────────────────────────────────
      // Step 1: Snapshot offline DB → UI immediately (no "Unknown" flash)
      // Step 2: Lock UI
      // Step 3: Sync patients + deliveries from server
      // Step 4: Unlock + push fresh data
      await syncOnFilterChange(
        selectedDateStr,
        selectedCityId,
        // applySnapshot (Step 1 — immediate offline render)
        (snapshotData) => {
          console.log(`📸 [Layout] Applying offline snapshot: ${snapshotData.deliveries?.length || 0} deliveries, ${snapshotData.patients?.length || 0} patients`);
          applyFullDataToState(snapshotData);
        },
        // applyFresh (Step 4 — after sync completes)
        (freshData) => {
          console.log(`✅ [Layout] Applying fresh sync data: ${freshData.deliveries?.length || 0} deliveries, ${freshData.patients?.length || 0} patients`);
          applyFullDataToState(freshData);
          globalFilters.markRefreshComplete();
        }
      );

    } catch (error) {
      console.warn('⚠️ [Layout] Full data reload failed - preserving current dashboard data:', error?.message || error);
      setDataLoaded(true);
    } finally {
      triggerFullDataLoad.isRunning = false;
    }
  }, [currentUser, isFormOverlayOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  triggerFullDataLoadRef.current = triggerFullDataLoad;

  // Initialize the SW tile cache manager once when the user and city are known
  useEffect(() => {
    if (!currentUser) return;
    const cityId = globalFilters.getSelectedCityId();
    if (!cityId || cityId === 'all' || cityId === 'waiting-for-selection') return;
    initTileCacheManager(cityId).catch(() => {});
    // Flush pending tile discoveries when driver backgrounds the app
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        import('@/components/utils/tileCoverageManager')
          .then(m => m.flushPendingDiscoveries())
          .catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [currentUser]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe this device to Web Push once the user is known.
  //
  // IMPORTANT: Notification.requestPermission() must run inside a real user
  // gesture (tap/click) — iOS Safari and modern mobile Chrome silently ignore
  // (or auto-deny) permission requests fired from a useEffect on page load,
  // so calling initPushNotifications() directly here would never actually
  // prompt anyone. Instead:
  //   - if permission is already 'granted' (returning user), re-subscribe
  //     silently right away — no gesture needed for an already-granted permission.
  //   - if permission is 'default' (never asked), wait for the user's very next
  //     tap anywhere in the app and fire the request from inside that gesture.
  useEffect(() => {
    if (!currentUser?.id || typeof Notification === 'undefined') return;

    if (Notification.permission === 'granted') {
      initPushNotifications(currentUser.id).catch(() => {});
      return;
    }

    if (Notification.permission !== 'default') return; // 'denied' — nothing to do

    const handleFirstGesture = () => {
      document.removeEventListener('pointerdown', handleFirstGesture, true);
      document.removeEventListener('keydown', handleFirstGesture, true);
      initPushNotifications(currentUser.id).catch(() => {});
    };
    document.addEventListener('pointerdown', handleFirstGesture, true);
    document.addEventListener('keydown', handleFirstGesture, true);
    return () => {
      document.removeEventListener('pointerdown', handleFirstGesture, true);
      document.removeEventListener('keydown', handleFirstGesture, true);
    };
  }, [currentUser?.id]);

  // Deep-link handler: a push notification for a chat message opens the app at
  // /?openChat=<senderId>&openChatName=<encoded name>. Open that conversation once
  // the messaging state setters and currentUser are ready, then clean the URL.
  useEffect(() => {
    if (!currentUser?.id) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const openChatUserId = params.get('openChat');
      if (!openChatUserId) return;
      const openChatName = params.get('openChatName') || 'User';
      const conversationId = [currentUser.id, openChatUserId].sort().join('_');
      setInitialConversation({ conversationId, otherUserId: openChatUserId, otherUserName: decodeURIComponent(openChatName) });
      setShowMessaging(true);
      params.delete('openChat');
      params.delete('openChatName');
      const newSearch = params.toString();
      const newUrl = `${window.location.pathname}${newSearch ? `?${newSearch}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', newUrl);
    } catch (_) {
      // Non-fatal — worst case the deep link query param just lingers in the URL
    }
  }, [currentUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const initialDataLoadFiredRef = useRef(false);
  useEffect(() => {
    if (!initialGlobalFiltersSet || !currentUser) return;
    if (!globalFilters.isReadyForDataFetch()) return;
    // CRITICAL: Only fire ONCE. WebSocket currentUser updates must NOT retrigger full reload.
    if (initialDataLoadFiredRef.current && !needsDataReload.current) return;
    initialDataLoadFiredRef.current = true;
    const forceRefresh = needsDataReload.current;
    if (forceRefresh) needsDataReload.current = false;
    triggerFullDataLoadRef.current(forceRefresh);
  }, [initialGlobalFiltersSet, currentUser]);
  useEffect(() => {
    if (!dataLoaded) return;
    const unsubscribe = globalFilters.subscribe(() => {});
    return unsubscribe;
  }, [dataLoaded]);

  const filteredDeliveries = useMemo(() => {
    if (!deliveries.length || !currentUser) return [];
    let data = deliveries.filter((delivery) => delivery);

    if (selectedStoreId && selectedStoreId !== 'all') {
      data = data.filter((delivery) => delivery && delivery.store_id === selectedStoreId);
    }

    if (userHasRole(currentUser, 'admin')) {

      // Admins see all
    } else if (userHasRole(currentUser, 'dispatcher')) {const sIds = currentUser.store_ids || [];if (selectedStoreId && selectedStoreId !== 'all' && !sIds.includes(selectedStoreId)) return [];const relIds = selectedStoreId && selectedStoreId !== 'all' ? [selectedStoreId] : sIds;const pIds = new Set(patients.filter((p) => p && relIds.includes(p.store_id)).map((p) => p.id));data = data.filter((d) => d && (d.patient_id ? pIds.has(d.patient_id) : relIds.includes(d.store_id)));} else if (userHasRole(currentUser, 'driver')) {data = data.filter((d) => d && d.driver_id === currentUser.id);if (selectedStoreId && selectedStoreId !== 'all' && currentUser.store_id !== selectedStoreId) return [];}return data;
  }, [deliveries, currentUser, patients, selectedStoreId]);

  const filteredPatients = useMemo(() => {
    if (!patients.length || !currentUser) return [];
    let data = patients.filter((patient) => patient);

    if (selectedStoreId && selectedStoreId !== 'all') {
      data = data.filter((p) => p && p.store_id === selectedStoreId);
    }

    if (userHasRole(currentUser, 'admin')) {

      // Admins see all
    } else if (userHasRole(currentUser, 'dispatcher')) {const sIds = currentUser.store_ids || [];if (selectedStoreId && selectedStoreId !== 'all' && !sIds.includes(selectedStoreId)) return [];const relIds = selectedStoreId && selectedStoreId !== 'all' ? [selectedStoreId] : sIds;data = data.filter((p) => p && relIds.includes(p.store_id));} else if (userHasRole(currentUser, 'driver')) {const sIds = currentUser.store_ids || (currentUser.store_id ? [currentUser.store_id] : []);if (sIds.length > 0) {const relIds = selectedStoreId && selectedStoreId !== 'all' ? [selectedStoreId] : sIds;data = data.filter((p) => p && relIds.includes(p.store_id));}}return data;}, [patients, currentUser, selectedStoreId]); // Route count - for dispatchers: unique dates with at least 1 delivery for their stores (YTD)
  // for others: count driver-routes (each driver-date combination) for the selected month
  const totalRoutesCount = useMemo(() => {if (!deliveries || deliveries.length === 0 || !currentUser) return 0;
      const selectedDateStr = globalFilters.getSelectedDate();
      if (!selectedDateStr) return 0;

      const selectedDate = new Date(selectedDateStr + 'T00:00:00');
      const selectedYear = selectedDate.getFullYear();
      const selectedMonth = selectedDate.getMonth();

      // CRITICAL: Filter deliveries based on user role
      let relevantDeliveries = deliveries;

      if (userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
        // DISPATCHERS: Count unique dates with at least 1 delivery in their stores (YTD)
        const dispatcherStoreIds = new Set(currentUser.store_ids || []);

        // Filter to deliveries from dispatcher's stores only
        const storeDeliveries = deliveries.filter((d) => d && dispatcherStoreIds.has(d.store_id));

        // Get unique dates in the current year
        const uniqueDates = new Set();
        storeDeliveries.forEach((delivery) => {
          if (!delivery || !delivery.delivery_date) return;

          const deliveryDate = new Date(delivery.delivery_date + 'T00:00:00');
          if (deliveryDate.getFullYear() !== selectedYear) return;

          uniqueDates.add(delivery.delivery_date);
        });

        return uniqueDates.size;
      } else if (userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin')) {
        // Drivers: only count their own routes
        relevantDeliveries = relevantDeliveries.filter((d) => d && d.driver_id === currentUser.id);
      }

      // For admins and drivers: For each date in the selected month, count unique drivers
      const dateDriverMap = new Map();

      relevantDeliveries.forEach((delivery) => {
        if (!delivery || !delivery.delivery_date || !delivery.driver_id) return;

        const deliveryDate = new Date(delivery.delivery_date + 'T00:00:00');
        if (deliveryDate.getFullYear() !== selectedYear ||
        deliveryDate.getMonth() !== selectedMonth) return;

        const dateKey = delivery.delivery_date;
        if (!dateDriverMap.has(dateKey)) {
          dateDriverMap.set(dateKey, new Set());
        }
        dateDriverMap.get(dateKey).add(delivery.driver_id);
      });

      // Sum up the number of drivers across all dates
      let totalRoutes = 0;
      dateDriverMap.forEach((driverSet) => {
        totalRoutes += driverSet.size;
      });

      return totalRoutes;
    }, [deliveries, currentUser]);

  const getPatientStoreData = useCallback(() => {
    if (!stores.length || !patients.length) return [];
    const sortedStores = [...stores].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));

    let relevantPatients = patients;
    if (userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
      const sIds = new Set(currentUser.store_ids || []);
      relevantPatients = patients.filter((p) => p && sIds.has(p.store_id));
    }

    return sortedStores.map((store) => ({
      ...store,
      patientCount: relevantPatients.filter((p) => p && p.store_id === store.id).length
    }));
  }, [stores, patients, currentUser]);

  const getLatestDateWithDeliveries = useCallback((driverId = null) => {
    let relevantDeliveries = filteredDeliveries.filter((delivery) => delivery);
    if (driverId) {
      const driver = users.find((u) => u && u.id === driverId);
      if (driver) {
        relevantDeliveries = relevantDeliveries.filter((delivery) => delivery && delivery.driver_id === driver.id);
      }
    }

    if (!relevantDeliveries || relevantDeliveries.length === 0) {
      return format(new Date(), 'yyyy-MM-dd');
    }

    const dates = [...new Set(relevantDeliveries.filter((delivery) => delivery && delivery.delivery_date).map((delivery) => delivery.delivery_date))];
    dates.sort((a, b) => b.localeCompare(a));

    return dates[0] || format(new Date(), 'yyyy-MM-dd');
  }, [filteredDeliveries, users]);

  const patientStoreData = getPatientStoreData();

  const [entityCounts, setEntityCounts] = useState({ patients: '...', companies: '...', cities: '...', stores: '...', users: '...' });

  useEffect(() => {if (!currentUser || !dataLoaded) return;setEntityCounts({ patients: patients.length, cities: cities.length, stores: stores.length, users: users.length });}, [currentUser, dataLoaded, patients.length, cities.length, stores.length, users.length]);

  // CRITICAL: Keep drivers + users in sync with appUsers at ALL times.
  // applyFullDataToState sets them during triggerFullDataLoad, but appUsers is seeded
  // much earlier (from offlineDB in useLayoutInit). This effect bridges that gap so the
  // sidebar, delivery form, and bulk edit form always have a populated drivers list.
  useEffect(() => {
    if (!appUsers || appUsers.length === 0) return;
    const mergedUsersMap = new Map();
    if (currentUser) mergedUsersMap.set(currentUser.id, currentUser);
    appUsers.forEach((appUser) => {
      if (!appUser || mergedUsersMap.has(appUser.user_id)) return;
      const pseudoUser = createMergedUser(null, appUser);
      if (pseudoUser) mergedUsersMap.set(pseudoUser.id, pseudoUser);
    });
    const allUsers = Array.from(mergedUsersMap.values()).filter(Boolean);
    const activeDrivers = sortUsers(allUsers.filter((u) =>
      u && Array.isArray(u.app_roles) &&
      (u.app_roles.includes('driver') || u.app_roles.includes('admin')) &&
      u.user_name && u.status === 'active'
    ));
    setUsers(allUsers);
    setDrivers(activeDrivers);
  }, [appUsers, currentUser]);
  const currentPayrollNetPay = usePayrollBadge(currentUser, appUsers, dataLoaded);

  // Calculate online user counts based on heartbeat (location_updated_at < 5 min = online)
  const onlineCounts = useMemo(() => {
    const ONLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();

    const isHeartbeatActive = (au) => {
      if (!au?.location_updated_at) return false;
      return (now - new Date(au.location_updated_at).getTime()) < ONLINE_THRESHOLD_MS;
    };

    // Stores: a store is "online" if it has at least one dispatcher with an active heartbeat
    const onlineStores = new Set();
    appUsers.forEach((au) => {
      if (au?.app_roles?.includes('dispatcher') && isHeartbeatActive(au)) {
        au.store_ids?.forEach((storeId) => onlineStores.add(storeId));
      }
    });

    // Drivers online = active heartbeat AND on_duty/online status
    const onlineDrivers = appUsers.filter(
      (au) => au?.app_roles?.includes('driver') &&
        (au.driver_status === 'on_duty' || au.driver_status === 'online') &&
        isHeartbeatActive(au)
    );

    // All active users (dispatchers/admins online + drivers on_duty) by heartbeat
    const totalActiveUsers = appUsers.filter((au) => {
      if (!isHeartbeatActive(au)) return false;
      const isDriver = au?.app_roles?.includes('driver');
      if (isDriver) return au.driver_status === 'on_duty' || au.driver_status === 'online';
      return true; // dispatchers and admins count if heartbeat is active
    });

    const onlineNonDriverNonDispatcherUsers = appUsers.filter(
      (au) =>
      !au?.app_roles?.includes('driver') &&
      !au?.app_roles?.includes('dispatcher') &&
      isHeartbeatActive(au)
    );

    return {
      onlineStoresCount: onlineStores.size,
      onlineDriversCount: onlineDrivers.length,
      totalActiveUsersCount: totalActiveUsers.length,
      onlineNonDriverNonDispatcherUsersCount: onlineNonDriverNonDispatcherUsers.length
    };
  }, [appUsers, stores]);

  const adminNavigationItems = useMemo(() => getAdminNavigationItems({
    currentUser, entityCounts, onlineCounts, stores, drivers, users, adminImportEnabled
  }), [currentUser, entityCounts, onlineCounts, stores, drivers, users, adminImportEnabled]);

  const constructUrlWithParams = useCallback((baseUrl) => {
    const currentParams = new URLSearchParams(location.search);
    const url = new URL(baseUrl, window.location.origin);

    const cityParam = currentParams.get('city');
    if (cityParam) {
      url.searchParams.set("city", cityParam);
    }

    if (selectedStoreId && selectedStoreId !== 'all') {
      url.searchParams.set("store", selectedStoreId);
    } else {
      url.searchParams.delete("store");
    }

    return url.pathname + url.search;
  }, [location.search, selectedStoreId]);

  const getOverviewUrl = useCallback((pageName) => {
    const currentParams = new URLSearchParams(location.search);
    const url = new URL(createPageUrl(pageName), window.location.origin);

    const cityParam = currentParams.get('city');
    if (cityParam) {
      url.searchParams.set("city", cityParam);
    }

    if (selectedStoreId && selectedStoreId !== 'all') {
      url.searchParams.set("store", selectedStoreId);
    } else {
      url.searchParams.delete("store");
    }

    if (pageName === 'Deliveries') {
      const latestDate = getLatestDateWithDeliveries();
      url.searchParams.set("date", latestDate);
    }

    url.searchParams.delete('driver');
    url.searchParams.delete('search');
    return url.pathname + url.search;
  }, [location.search, selectedStoreId, getLatestDateWithDeliveries]);

  const getRouteNavigationUrl = useCallback((pageName) => {
    const currentParams = new URLSearchParams(location.search);
    const url = new URL(createPageUrl(pageName), window.location.origin);

    const cityParam = currentParams.get('city');
    if (cityParam) {
      url.searchParams.set("city", cityParam);
    }

    if (selectedStoreId && selectedStoreId !== 'all') {
      url.searchParams.set("store", selectedStoreId);
    } else {
      url.searchParams.delete("store");
    }

    if (pageName === 'Deliveries') {
      // CRITICAL: Use year/month only, not date
      const latestDate = getLatestDateWithDeliveries();
      const [y, m] = latestDate.split('-');
      url.searchParams.set("year", y);
      url.searchParams.set("month", m);
      return url.pathname + url.search;
    }

    return getOverviewUrl(pageName);
  }, [location.search, selectedStoreId, getLatestDateWithDeliveries, getOverviewUrl]);

  const handleStoreChange = useCallback((storeId) => {
    setSelectedStoreId(storeId);
    const urlParams = new URLSearchParams(window.location.search);
    if (storeId === 'all' || !storeId) {
      urlParams.delete('store');
    } else {
      urlParams.set('store', storeId);
    }
    window.history.replaceState({}, '', `${window.location.pathname}?${urlParams.toString()}`);
  }, []);

  const availableStoresForSelect = useMemo(() => {
    if (!currentUser || !stores.length) return [];

    let userStores = [];
    if (userHasRole(currentUser, 'admin')) {
      userStores = stores;
    } else if (currentUser.store_ids && currentUser.store_ids.length > 0) {
      userStores = stores.filter((store) => store && currentUser.store_ids.includes(store.id));
    } else if (currentUser.store_id) {
      userStores = stores.filter((store) => store && store.id === currentUser.store_id);
    }

    if (userHasRole(currentUser, 'admin') && userStores.length > 1) {
      return [{ id: 'all', name: 'All Stores' }, ...userStores];
    }
    return userStores;
  }, [currentUser, stores]);

  const deliveryDates = useMemo(() => {
    if (!deliveries || deliveries.length === 0) {
      return [];
    }

    const dateCountMap = {};
    deliveries.forEach((delivery) => {
      if (delivery && delivery.delivery_date) {
        if (!dateCountMap[delivery.delivery_date]) {
          dateCountMap[delivery.delivery_date] = 0;
        }
        dateCountMap[delivery.delivery_date]++;
      }
    });

    const dates = Object.keys(dateCountMap).map((dateStr) => {
      const [year, month, day] = dateStr.split('-').map(Number);
      const dateObj = new Date(year, month - 1, day);
      return {
        date: dateObj,
        dateStr: dateStr,
        count: dateCountMap[dateStr]
      };
    });

    dates.sort((a, b) => b.date.getTime() - a.date.getTime());

    return dates;
  }, [deliveries]);

  return (
    <AppErrorBoundary>
      <style>{getLayoutStyles({ branding, sidebarWidth })}</style>

      {/* Connection Recovery Banner - auto-shows on connection issues */}
      {/* ─── Global Overlays (modals, panels, banners) ────────────────────── */}
      <GlobalOverlays
        sidebarOpen={sidebarOpen}
        showMessaging={showMessaging}
        showInviteQRModal={showInviteQRModal}
        showCitySelectionPopup={showCitySelectionPopup}
        isFormOverlayOpen={isFormOverlayOpen}
        deviceRegistered={deviceRegistered}
        setDeviceRegistered={setDeviceRegistered}
        showInitRetryHint={showInitRetryHint}
        currentUser={currentUser}
        cities={cities}
        users={users}
        stores={stores}
        initialConversation={initialConversation}
        unreadMessageCount={unreadMessageCount}
        onRequestCloseOverlay={() => {
          if (sidebarOpen) setSidebarOpen(false);
          if (showMessaging) { setShowMessaging(false); setInitialConversation(null); }
          if (showInviteQRModal) setShowInviteQRModal(false);
          if (isFormOverlayOpen) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        }}
        handleCitySelected={handleCitySelected}
        setShowMessaging={setShowMessaging}
        setInitialConversation={setInitialConversation}
        setUnreadMessageCount={setUnreadMessageCount}
        setShowInviteQRModal={setShowInviteQRModal}
        setSidebarOpen={setSidebarOpen}
      />

      {isLoadingLayout ?
      <AppLoadingScreen showRetryHint={showInitRetryHint} onRetry={() => window.location.reload()} /> :
      !hasAccess || !currentUser ?
      <div className="h-screen flex items-center justify-center bg-slate-50">
          <div className="text-center p-8">
            <h2 className="2xl font-bold text-slate-900 mb-4">RxDeliver</h2>
            <p className="text-slate-600 mb-6">Redirecting to login...</p>
            <p className="text-sm text-slate-500">If you're not redirected automatically, please refresh the page.</p>
          </div>
        </div> :

      <UserProvider initialUser={currentUser}>
           <AppDataProvider value={{
          deliveries: deliveries || [], patients: patients || [], stores: stores || [], drivers: drivers || [], users: users || [], appUsers: appUsers || [], cities: cities || [], currentUser,
          squareLocationConfigs: squareLocationConfigs || [],
          isDataLoaded: dataLoaded, refreshData: triggerFullDataLoadRef.current, updateDeliveriesLocally, updateAppUsersLocally,
          applyDeliveryChangesLocally: ({ upserts = [], deleteIds = [] }) => setDeliveries((prev) => {const map = new Map((prev || []).filter(Boolean).map((item) => [item?.id, item]).filter(([id]) => !!id));(deleteIds || []).forEach((id) => map.delete(id));(upserts || []).forEach((item) => {if (item?.id) map.set(item.id, map.has(item.id) ? { ...map.get(item.id), ...item } : item);});return Array.from(map.values());}),
          applyAppUserChangesLocally: ({ upserts = [], deleteIds = [] }) => setAppUsers((prev) => {const map = new Map((prev || []).filter(Boolean).map((item) => [item?.id, item]).filter(([id]) => !!id));(deleteIds || []).forEach((id) => map.delete(id));(upserts || []).forEach((item) => {if (item?.id) map.set(item.id, map.has(item.id) ? { ...map.get(item.id), ...item } : item);});return Array.from(map.values());}),
          applyPatientChangesLocally: ({ upserts = [], deleteIds = [] }) => setPatients((prev) => {const map = new Map((prev || []).filter(Boolean).map((item) => [item?.id, item]).filter(([id]) => !!id));(deleteIds || []).forEach((id) => map.delete(id));(upserts || []).forEach((item) => {if (item?.id) map.set(item.id, map.has(item.id) ? { ...map.get(item.id), ...item } : item);});return Array.from(map.values());}),
          updatePatientsLocally: ({ upserts = [], deleteIds = [] }) => setPatients((prev) => {const map = new Map((prev || []).filter(Boolean).map((item) => [item?.id, item]).filter(([id]) => !!id));(deleteIds || []).forEach((id) => map.delete(id));(upserts || []).forEach((item) => {if (item?.id) map.set(item.id, map.has(item.id) ? { ...map.get(item.id), ...item } : item);});return Array.from(map.values());}),
          isFormOverlayOpen: isFormOverlayOpen, setIsFormOverlayOpen: setIsFormOverlayOpen, isEntityUpdating: isEntityUpdating, setIsEntityUpdating: setIsEntityUpdating,
          smartRefreshActivity: smartRefreshActivity, setSmartRefreshActivity: setSmartRefreshActivity, setOnSmartRefreshComplete: (callback) => {onSmartRefreshCompleteRef.current = callback;},
          dataReadyForSelectedDate: dataLoaded, dataSource: dataSource,
          // Persisted FAB map phase — read by Dashboard on mount to restore last user-set phase
          initialFabPhase: initialFabPhase,
        }}>
            <div className={`app-container ${isTabletPortrait ? 'tablet-portrait' : isMobile ? 'mobile-device' : 'desktop-device'}`}>
              {(isMobile || isTabletPortrait) && sidebarOpen &&
            <div
              className="sidebar-overlay"
              onClick={() => setSidebarOpen(false)} />
            }

                {/* Sidebar */}
                <AppSidebar
                  sidebarOpen={sidebarOpen}
                  setSidebarOpen={setSidebarOpen}
                  branding={branding}
                  appVersion={appVersion}
                  currentUser={currentUser}
                  setCurrentUser={setCurrentUser}
                  currentPageName={currentPageName}
                  stores={stores}
                  cities={cities}
                  drivers={drivers}
                  users={users}
                  appUsers={appUsers}
                  patients={patients}
                  filteredDeliveries={filteredDeliveries}
                  deliveries={deliveries}
                  screenWidth={screenWidth}
                  unreadMessageCount={unreadMessageCount}
                  setUnreadMessageCount={setUnreadMessageCount}
                  setShowMessaging={setShowMessaging}
                  setInitialConversation={setInitialConversation}
                  setShowInviteQRModal={setShowInviteQRModal}
                  entityCounts={entityCounts}
                  adminNavigationItems={adminNavigationItems}
                  adminImportEnabled={adminImportEnabled}
                  setAdminImportEnabled={setAdminImportEnabled}
                  themePreference={themePreference}
                  handleThemeChange={handleThemeChange}
                  setShowPatientImport={setShowPatientImport}
                  setShowDeliveryImport={setShowDeliveryImport}
                  constructUrlWithParams={constructUrlWithParams}
                  getRouteNavigationUrl={getRouteNavigationUrl}
                  getOverviewUrl={getOverviewUrl}
                  currentPayrollNetPay={currentPayrollNetPay}
                  onlineCounts={onlineCounts}
                  totalRoutesCount={totalRoutesCount}
                />

                {/* Resizable Divider for Sidebar - Only on desktop */}
                {!isMobile &&
            <ResizableDivider
              storageKey="rxdeliver_sidebar_width"
              defaultWidth={260}
              minWidth={200}
              maxWidth={400}
              onWidthChange={(width) => {
                setSidebarWidth(width);
                // Save to user settings (debounced via localStorage in ResizableDivider, but also save to backend)
                if (currentUser?.id) {
                  saveSetting(currentUser.id, 'sidebar_width', width);
                }
              }} />
            }

              {/* Main Content Area */}
              <div className="main-content-area">

                {/* Mobile Header - Integrated header with logo/back button + controls */}
                {(isMobile || isTabletPortrait) &&
              <MobileHeader
                logo={branding.logo_url}
                sidebarOpen={sidebarOpen}
                unreadMessageCount={unreadMessageCount}
                onMessagingClick={() => setShowMessaging(true)}
                isMobile={isMobile}
                isTabletPortrait={isTabletPortrait}
                currentUser={currentUser}
                themePreference={themePreference}
                onThemeChange={handleThemeChange}
                cities={cities}
                onInviteQRClick={() => setShowInviteQRModal(true)}
                onCurrentUserUpdate={async () => {
                  clearUserCache();
                  const refreshedUser = await getEffectiveUser();
                  if (refreshedUser) {
                    setCurrentUser(refreshedUser);
                  }
                }}
                isOverlayOpen={sidebarOpen || showMessaging || showInviteQRModal || showCitySelectionPopup || isFormOverlayOpen} />
              }

                    <main className="flex-1 overflow-hidden relative flex flex-col" style={{ background: 'var(--bg-slate-50)' }}>
                    <PageTransition>
                      {children}
                    </PageTransition>
                    </main>

                    {/* Mobile Bottom Nav - inside main-content-area so flex column shrinks main naturally */}
                    {/* Bottom nav shows only on mobile phones (portrait) and tablet-portrait — never in landscape */}
                    {!sidebarOpen && currentUser && isMobile &&
              <MobileBottomNav currentUser={currentUser} currentPageName={currentPageName} onSidebarToggle={() => setSidebarOpen(true)} />
              }
              </div>
            </div>
          </AppDataProvider>
          </UserProvider>
      }

      {/* OptimizationSpinner removed — KITT bar now in DashboardView */}
      <PatientViewOverlay />
    </AppErrorBoundary>);
}