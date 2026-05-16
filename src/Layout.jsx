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
import CitySelectionPopup from './components/cities/CitySelectionPopup';
import { getActiveDriversForCity, getAvailableDrivers } from './components/utils/driverSelectors';
import DeviceRegistration from './components/devices/DeviceRegistration';
// Removed: getCitiesWithinRadius - no longer using geographic filtering
import { getUserAgentInfo, isMobileDeviceForTheme } from './components/utils/deviceUtils';

import DriverStatusToggle from './components/layout/DriverStatusToggle';
import LocationTrackingToggle from './components/layout/LocationTrackingToggle';
import AppErrorBoundary from './components/layout/AppErrorBoundary';
import { loadUserSettings, saveSetting, clearSettingsCache, getDeviceType, getDeviceIdentifier } from './components/utils/userSettingsManager';
import useAutoThemeSync from './components/utils/useAutoThemeSync';
import DeviceSelectionModal from './components/devices/DeviceSelectionModal';
import MessagingPanel from './components/messaging/MessagingPanel';
import SmartRefreshIndicator from './components/layout/SmartRefreshIndicator';
import { isMobileDevice } from './components/utils/deviceUtils';
import MessageNotificationBalloon from './components/messaging/MessageNotificationBalloon';
import InviteQRCodeModal from './components/common/InviteQRCodeModal';
import { QrCode } from 'lucide-react';
import { initializeDailyCleanup } from './components/utils/messageCleaner';
import { toast } from 'sonner';
import { performInitialSync, processPendingMutations, performBackgroundSync } from './components/utils/offlineSync';
import { requestThrottler } from './components/utils/requestThrottler';
import OfflineSyncIndicator from './components/layout/OfflineSyncIndicator';
import ConnectionRecoveryBanner from './components/layout/ConnectionRecoveryBanner';
import { subscribeMutations } from './components/utils/entityMutations';
import { realtimeSync, subscribeToRealtime } from './components/utils/realtimeSync';
import ConflictManager from './components/dashboard/ConflictManager';
import PWAInstallPrompt from './components/common/PWAInstallPrompt';
import { calculateUserCodTotal, calculateRouteCodBalance } from './components/utils/codTotalCalculator';
import BatteryIndicator from './components/layout/BatteryIndicator';
import SettingsMenu from './components/layout/SettingsMenu';
import { getCompanyBranding, applyBrandingStyles } from './components/utils/brandingManager';
import OptimizationSpinner from './components/common/OptimizationSpinner';
import WebSocketDiagnosticsCard from './components/layout/WebSocketDiagnosticsCard';
import MobileBottomNav from './components/layout/MobileBottomNav';
import MobileOverlayBackHandler from './components/layout/MobileOverlayBackHandler';
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
import { initializeGlobalFilters, createMergedUser, hasCurrentUserRefreshImpact } from './components/layout/initializeGlobalFilters';
import { usePayrollBadge } from './components/layout/usePayrollBadge';

// App version will be loaded from AppSettings
const DEFAULT_APP_VERSION = 'v1.0.0';

import QuickStats from './components/layout/DashboardQuickStats';

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
  const { deviceType, os } = getUserAgentInfo();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isMobile = deviceType === 'Mobile'; // CRITICAL: Use deviceType directly, not screen width
  const isMobileDeviceForUI = isMobileDevice(); // CRITICAL: For UI controls - always true for mobile devices
  const [screenWidth, setScreenWidth] = useState(window.innerWidth);
  const [cardWidth, setCardWidth] = useState(300);
  const [isTabletPortrait, setIsTabletPortrait] = useState(false);

  // Detect tablet orientation - portrait = always mobile view, landscape = desktop view
  useEffect(() => {
    const detectTabletOrientation = () => {
      if (deviceType !== 'Tablet') {
        setIsTabletPortrait(false);
        return;
      }

      // Tablet detected - check orientation
      const isPortrait = window.matchMedia('(orientation: portrait)').matches;
      setIsTabletPortrait(isPortrait);
    };

    detectTabletOrientation();
    window.addEventListener('orientationchange', detectTabletOrientation);
    window.addEventListener('resize', detectTabletOrientation);

    return () => {
      window.removeEventListener('orientationchange', detectTabletOrientation);
      window.removeEventListener('resize', detectTabletOrientation);
    };
  }, [deviceType]);

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
  const initAutoRefreshTimerRef = useRef(null);
  const initRetryHintTimerRef = useRef(null);

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
  useEffect(() => {
    const init = async () => {
      setIsLoadingLayout(true);
      try {
        setDeviceTypeDetected(getDeviceType());
        const fetchedUser = await requestThrottler.queue(() => getEffectiveUser(), 'critical', 'getEffectiveUser');
        if (!fetchedUser) {setHasAccess(false);setCurrentUser(null);setIsLoadingLayout(false);setDataLoaded(true);return;}
        const deviceIdentifier = getDeviceIdentifier();
        const todayStr = format(new Date(), 'yyyy-MM-dd');
        const cachedReg = localStorage.getItem(`rxdeliver_device_registered_${deviceIdentifier}`);
        let manifest = {},isDeviceRegistered = false;
        try {
          const mr = await requestThrottler.queue(() => base44.functions.invoke('getBootstrapManifest', { deviceIdentifier, todayStr }), 'critical', 'getBootstrapManifest');
          manifest = mr?.data || mr || {};
          isDeviceRegistered = manifest.deviceRegistered === true;
        } catch (e) {if (cachedReg === 'true') {isDeviceRegistered = true;} else throw e;}
        // KEEP LOADING SPINNER while waiting for device registration
        if (!isDeviceRegistered && cachedReg !== 'true') {setCurrentUser(fetchedUser);return;}
        localStorage.setItem(`rxdeliver_device_registered_${deviceIdentifier}`, 'true');
        setDeviceRegistered(true);
        try {
          const s = await requestThrottler.queue(() => loadUserSettings(fetchedUser.id), 'critical', 'loadUserSettings');
          if (s.sidebar_width) setSidebarWidth(s.sidebar_width);
          if (s.theme_preference && isMobileDeviceForTheme()) setThemePreference(s.theme_preference);else setThemePreference('light');
          if (s.data_source) setDataSource(s.data_source);
          // Role-based initial filter prioritization
          initializeGlobalFilters(fetchedUser, s);
          setUserSettingsLoaded(true);
        } catch {setUserSettingsLoaded(true);}
        const ms = manifest.appSettings || {};
        smartRefreshManager._enabled = ms.smartRefreshEnabled !== false;
        smartRefreshManager._initialized = true;
        if (ms.appVersion) {const v = ms.appVersion;setAppVersion(`v${v.major}.${v.minor}.${v.build}`);}
        setAdminImportEnabled(ms.adminImportEnabled === true);
        // Seed HERE API key from bootstrap manifest to avoid redundant backend calls
        if (ms.hereApiKey) {
          if (typeof window !== 'undefined') window.__hereApiKey = ms.hereApiKey;
          const { seedHereApiKey } = await import('./components/utils/hereApiKeyStore');
          seedHereApiKey(ms.hereApiKey);
        }
        if (userHasRole(fetchedUser, 'dispatcher') && fetchedUser.status === 'inactive') {
          sessionStorage.clear();clearUserCache();clearSettingsCache();
          alert('Access Denied: Your account is currently inactive. Please contact an administrator.');
          try {await base44.auth.logout();} catch (e) {}
          window.location.href = '/';return;
        }
        setCurrentUser(fetchedUser);setHasAccess(true);
        if (fetchedUser?.company_id) {try {const b = await getCompanyBranding(fetchedUser.company_id);setBranding(b);applyBrandingStyles(b);} catch {}}
        const citiesData = (Array.isArray(manifest.cities) ? [...manifest.cities] : []).sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
        setCities(citiesData);
        let initialCityId = citiesData.find((c) => c && c.id === fetchedUser.city_id)?.id || null;
        if (!initialCityId && userHasRole(fetchedUser, 'admin') && citiesData.length > 0) initialCityId = citiesData[0].id;
        if (!initialCityId) {setShowCitySelectionPopup(true);globalFilters.setSelectedCityId('waiting-for-selection');setIsLoadingLayout(false);return;}
        globalFilters.setSelectedCityId(initialCityId);
        const { offlineDB: odb } = await import('./components/utils/offlineDatabase');
        setSquareLocationConfigs((await odb.getAll(odb.STORES.SQUARE_LOCATION_CONFIGS)) || []);
        setCatalogItems((await odb.getAll(odb.STORES.SQUARE_CATALOG_ITEMS)) || []);
        setSquareTransactions((await odb.getAll(odb.STORES.SQUARE_TRANSACTIONS)) || []);
        // Ensure fallback defaults if initializeGlobalFilters didn't run (e.g. error path)
        if (!globalFilters.getSelectedDate()) globalFilters.setSelectedDate(format(new Date(), 'yyyy-MM-dd'));
        if (!globalFilters.getSelectedDriverId()) globalFilters.setSelectedDriverId('all');

        // STEP 1: Load data from offline DB FIRST for immediate UI display
        try {
          const [offlineDels, offlinePats, offlineAppUsers, offlineStores, offlineCities] = await Promise.all([
          offlineDB.getAll(offlineDB.STORES.DELIVERIES).catch(() => []),
          offlineDB.getAll(offlineDB.STORES.PATIENTS).catch(() => []),
          offlineDB.getAll(offlineDB.STORES.APP_USERS).catch(() => []),
          offlineDB.getAll(offlineDB.STORES.STORES).catch(() => []),
          offlineDB.getAll(offlineDB.STORES.CITIES).catch(() => [])]
          );
          if (offlineDels?.length) setDeliveries(offlineDels);
          if (offlinePats?.length) setPatients(offlinePats);
          if (offlineAppUsers?.length) setAppUsers(offlineAppUsers);
          if (offlineStores?.length) setStores(offlineStores.sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity)));
          if (offlineCities?.length) setCities(offlineCities.sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity)));
          console.log(`✅ [Init] Offline DB loaded: ${offlineDels?.length || 0} deliveries, ${offlinePats?.length || 0} patients`);
        } catch (e) {console.warn('⚠️ Offline DB load failed:', e.message);}
        const { markOfflineDBLoadComplete } = await import('./components/utils/dataManager');
        markOfflineDBLoadComplete();
        setInitialGlobalFiltersSet(true);setDataLoaded(true);
        setIsLoadingLayout(false); // Release loading gate ONLY after all prerequisites confirmed
      } catch (error) {
        const isAuth = error.response?.status === 401 || error.response?.status === 403 || error.message?.includes('Unauthorized') || error.message?.includes('Forbidden');
        if (isAuth) {setHasAccess(false);} else {console.warn('⚠️ Init error:', error.message);setHasAccess(true);}
        setIsLoadingLayout(false);setDataLoaded(true);
      }
    };
    init();
  }, []);

  // Initialize daily message cleanup
  useEffect(() => {
    initializeDailyCleanup();
  }, []);

  useEffect(() => {
    if (isLoadingLayout) {
      setShowInitRetryHint(false);
      initRetryHintTimerRef.current = setTimeout(() => setShowInitRetryHint(true), 15000);
      initAutoRefreshTimerRef.current = setTimeout(() => window.location.reload(), 60000);
    } else {
      setShowInitRetryHint(false);
      if (initRetryHintTimerRef.current) clearTimeout(initRetryHintTimerRef.current);
      if (initAutoRefreshTimerRef.current) clearTimeout(initAutoRefreshTimerRef.current);
    }

    return () => {
      if (initRetryHintTimerRef.current) clearTimeout(initRetryHintTimerRef.current);
      if (initAutoRefreshTimerRef.current) clearTimeout(initAutoRefreshTimerRef.current);
    };
  }, [isLoadingLayout]);

  // Real-time sync broadcasts removed - relying on smart refresh only

  // Initialize background sync manager
  useEffect(() => {
    if (!currentUser || !dataLoaded || currentPageName !== 'Dashboard') return backgroundSyncManager.stop();

    // Start background sync manager after data is loaded
    const startBackgroundSync = async () => {
      try {
        await backgroundSyncManager.loadConfig();
        backgroundSyncManager.start();
        console.log('✅ [Layout] Background sync manager started');
      } catch (error) {
        console.warn('⚠️ [Layout] Failed to start background sync:', error);
      }
    };

    // Delay start by 2 minutes to let initial data settle
    const timer = setTimeout(startBackgroundSync, 120000);

    return () => {
      clearTimeout(timer);
      backgroundSyncManager.stop();
    };
  }, [currentUser, dataLoaded, currentPageName]);

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

  // Initialize offline database sync
  useEffect(() => {
    if (!currentUser) return;

    // CRITICAL: Background sync - run ONCE after init, skip if already running
    let bgSyncHasRun = false;
    const bgSyncTimer = setTimeout(async () => {
      if (currentPageName !== 'Dashboard' || !initialGlobalFiltersSet || !currentUser || !dataLoaded || isFormOverlayOpen || bgSyncHasRun) return;
      bgSyncHasRun = true;

      const selectedDateStr = globalFilters.getSelectedDate() || format(new Date(), 'yyyy-MM-dd');
      const cityStoreIds = stores.map((s) => s?.id).filter(Boolean);

      console.log('🔄 [Layout] Starting ONE-TIME background sync for current month...');
      const { performBackgroundSync } = await import('./components/utils/offlineSync');
      performBackgroundSync(selectedDateStr, cityStoreIds).catch(() => {});
    }, 60000);

    // Set up periodic mutation processing (every 60 seconds to avoid rate limits)
    const mutationSyncInterval = setInterval(() => {
      processPendingMutations().catch(() => {});
    }, 60000);

    // Subscribe to ALL entity mutations and refresh UI IMMEDIATELY
    const unsubscribeMutations = subscribeMutations(async (mutation) => {
      console.log('🔔 [Layout] Mutation received:', mutation.entity, mutation.type, mutation.id);

      // CRITICAL: Handle 'replace' mutations to swap temp IDs with real backend IDs
      if (mutation.type === 'replace') {
        if (mutation.entity === 'Patient') {
          setPatients((prev) => prev.map((p) => p?.id === mutation.oldId ? mutation.data : p));
        } else if (mutation.entity === 'Delivery') {
          setDeliveries((prev) => prev.map((d) => d?.id === mutation.oldId ? mutation.data : d));
        }
        return;
      }

      // CRITICAL: Handle 'delete' mutations - update UI only after offline DB deletion completes
      if (mutation.type === 'delete') {
        if (mutation.entity === 'Patient') {
          await offlineDB.deleteRecord(offlineDB.STORES.PATIENTS, mutation.id).catch(() => {});
          setPatients((prev) => prev.filter((p) => p?.id !== mutation.id));
        } else if (mutation.entity === 'Delivery') {
          await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, mutation.id).catch(() => {});
          setDeliveries((prev) => prev.filter((d) => d?.id !== mutation.id));
        } else if (mutation.entity === 'Store') {
          await offlineDB.deleteRecord(offlineDB.STORES.STORES, mutation.id).catch(() => {});
          setStores((prev) => prev.filter((s) => s?.id !== mutation.id));
        } else if (mutation.entity === 'City') {
          await offlineDB.deleteRecord(offlineDB.STORES.CITIES, mutation.id).catch(() => {});
          setCities((prev) => prev.filter((c) => c?.id !== mutation.id));
        } else if (mutation.entity === 'AppUser') {
          await offlineDB.deleteRecord(offlineDB.STORES.APP_USERS, mutation.id).catch(() => {});
          setAppUsers((prev) => prev.filter((a) => a?.id !== mutation.id));
          setUsers((prev) => prev.filter((u) => u?.id !== mutation.id));
        }
        return;
      }

      // CRITICAL: Handle 'batch_delete' mutations - update UI only after offline DB deletions complete
      if (mutation.type === 'batch_delete') {
        const idsToDelete = new Set(mutation.ids || []);
        if (mutation.entity === 'Delivery') {
          await Promise.all((mutation.ids || []).map((id) =>
          offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, id).catch(() => {})
          ));
          setDeliveries((prev) => prev.filter((d) => !idsToDelete.has(d?.id)));
        }
        return;
      }

      // CRITICAL: Handle 'create' and 'update' mutations
      if (mutation.type === 'create') {
        if (mutation.entity === 'Patient') {
          setPatients((prev) => {
            const exists = prev.some((p) => p?.id === mutation.id);
            return exists ? prev : [...prev, mutation.data];
          });
        } else if (mutation.entity === 'Delivery') {
          setDeliveries((prev) => {
            const exists = prev.some((d) => d?.id === mutation.id);
            return exists ? prev : [...prev, mutation.data];
          });
        } else if (mutation.entity === 'Store') {
          setStores((prev) => {
            const exists = prev.some((s) => s?.id === mutation.id);
            return exists ? prev : [...prev, mutation.data];
          });
        } else if (mutation.entity === 'City') {
          setCities((prev) => {
            const exists = prev.some((c) => c?.id === mutation.id);
            return exists ? prev : [...prev, mutation.data];
          });
        } else if (mutation.entity === 'AppUser') {
          setAppUsers((prev) => {
            const exists = prev.some((a) => a?.id === mutation.id);
            return exists ? prev : [...prev, mutation.data];
          });

          // CRITICAL: Immediately dispatch location update for new AppUser
          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
            detail: { appUsers: null, singleUpdate: mutation.data }
          }));
        }
      } else if (mutation.type === 'update') {
        if (mutation.entity === 'Patient') {
          setPatients((prev) => prev.map((p) => p?.id === mutation.id ? { ...p, ...mutation.data } : p));
        } else if (mutation.entity === 'Delivery') {
          setDeliveries((prev) => prev.map((d) => d?.id === mutation.id ? { ...d, ...mutation.data } : d));
        } else if (mutation.entity === 'Store') {
          setStores((prev) => prev.map((s) => s?.id === mutation.id ? { ...s, ...mutation.data } : s));
        } else if (mutation.entity === 'City') {
          setCities((prev) => prev.map((c) => c?.id === mutation.id ? { ...c, ...mutation.data } : c));
        } else if (mutation.entity === 'AppUser') {
          setAppUsers((prev) => prev.map((a) => a?.id === mutation.id ? { ...a, ...mutation.data } : a));

          // CRITICAL: Immediately dispatch location update for AppUser changes
          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
            detail: { appUsers: null, singleUpdate: mutation.data }
          }));
        }
      }
    });

    // Listen for offline sync completion to refresh UI
    const handleSyncComplete = () => {
      // CRITICAL: Just invalidate caches, DON'T trigger full reload
      // performBackgroundSync already loaded fresh data into offline DB
      invalidate('Patient');
      invalidate('Delivery');
      // Skip triggerFullDataLoad to prevent duplicate API calls
    };
    window.addEventListener('offlineSyncComplete', handleSyncComplete);

    // Listen for messaging requests from map markers
    const handleOpenMessaging = (event) => {
      const { otherUserId, otherUserName } = event.detail || {};
      setInitialConversation(otherUserId && otherUserName ? { otherUserId, otherUserName } : null);
      setUnreadMessageCount(0);setShowMessaging(true);
    };
    const handleOpenMessagingPanel = () => {setInitialConversation(null);setUnreadMessageCount(0);setShowMessaging(true);};
    window.addEventListener('openMessaging', handleOpenMessaging);window.addEventListener('openMessagingPanel', handleOpenMessagingPanel);

    // Listen for user role changes and update UI immediately
    const handleUserRolesChanged = async (event) => {
      const { appUsers: changedAppUsers } = event.detail || {};
      if (!changedAppUsers || changedAppUsers.length === 0) return;

      console.log(`🔐 [Layout] User roles changed - updating UI and navigation`);

      // Update appUsers state with new roles
      setAppUsers((prev) => {
        const map = new Map(prev.map((u) => [u.id, u]));
        changedAppUsers.forEach((updated) => {
          const existing = map.get(updated.id);
          if (existing) {
            map.set(updated.id, { ...existing, ...updated });
          }
        });
        return Array.from(map.values());
      });

      // Update merged users with new roles for navigation
      setUsers((prev) => {
        const map = new Map(prev.map((u) => [u.id, u]));
        changedAppUsers.forEach((updated) => {
          const existing = map.get(updated.user_id || updated.id);
          if (existing) {
            map.set(existing.id, { ...existing, app_roles: updated.app_roles });
          }
        });
        return Array.from(map.values());
      });

      // Update current user's roles if they changed
      if (currentUser && changedAppUsers.some((u) => u.user_id === currentUser.id)) {
        const updatedCurrentUser = changedAppUsers.find((u) => u.user_id === currentUser.id);
        if (updatedCurrentUser) {
          setCurrentUser({
            ...currentUser,
            app_roles: updatedCurrentUser.app_roles
          });
        }
      }

      // Force UI refresh for sidebar navigation
      window.dispatchEvent(new CustomEvent('navigationUpdate'));
    };
    window.addEventListener('userRolesChanged', handleUserRolesChanged);

    // Listen for conflict events and show resolution UI
    const handleConflict = async (event) => {
      const { conflicts } = event.detail || {};
      if (!conflicts || conflicts.length === 0) return;

      // Import conflict resolver dynamically
      const { getPendingConflicts, resolveConflictManually } = await import('./components/utils/offlineConflictResolver');
      const { default: ConflictResolutionDialog } = await import('./components/offline/ConflictResolutionDialog');

      // Show conflict resolution dialog
      // This will be handled by a global conflict manager
      console.log(`⚠️ [Layout] ${conflicts.length} conflicts detected`);
    };
    window.addEventListener('dataConflictsDetected', handleConflict);

    // Listen for offline deletions and update UI immediately
    const handleOfflineDeliveriesDeleted = (event) => {
      const { deletedIds } = event.detail || {};
      if (deletedIds && deletedIds.length > 0) {
        console.log(`🗑️ [Layout] Removing ${deletedIds.length} deleted deliveries from UI`);
        setDeliveries((prevDeliveries) => prevDeliveries.filter((d) => !deletedIds.includes(d?.id)));
      }
    };
    window.addEventListener('offlineDeliveriesDeleted', handleOfflineDeliveriesDeleted);

    // Listen for import completion to update UI immediately
    const handleDeliveriesImported = async (event) => {
      const { deliveries, source } = event.detail || {};
      // CRITICAL: Only process if deliveries array is provided and non-empty
      // Skip if source is 'layout' to prevent infinite loops
      if (deliveries && deliveries.length > 0 && source !== 'layout') {
        console.log(`📥 [Layout] Received ${deliveries.length} imported deliveries - syncing patients FIRST`);

        // CRITICAL: Sync patient data FIRST before updating deliveries
        // This ensures all patient references are available when markers render
        try {
          invalidate('Patient');
          const freshPatients = await getData('Patient', null, null, true);
          setPatients(freshPatients);
          console.log(`✅ [Layout] Patient data synced: ${freshPatients.length} patients`);
        } catch (error) {
          console.error('❌ [Layout] Failed to sync patients after import:', error);
        }

        // Now update deliveries
        setDeliveries((prevDeliveries) => {
          const map = new Map(prevDeliveries.map((d) => [d.id, d]));
          deliveries.forEach((d) => map.set(d.id, d));
          return Array.from(map.values());
        });

        // CRITICAL: Force dispatch driverLocationsUpdated to update map markers immediately
        // This ensures "Show All" checkbox shows updated markers for other drivers
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
            detail: { appUsers }
          }));
        }, 500);
      }
    };
    window.addEventListener('deliveriesImported', handleDeliveriesImported);

    // Listen for delivery updates from DeliveryForm and trigger refresh
    const handleDeliveriesUpdated = async (event) => {
      // CRITICAL: Ignore intermediate events while filter-change sync is running
      if (isUiLocked()) {
        console.log('🔒 [Layout] deliveriesUpdated ignored — UI locked during filter-change sync');
        return;
      }
      const { deliveryId, driverId, deliveryDate, triggeredBy, freshDeliveries, preserveLocalState, deletedIds, deletedId, fullReplacement } = event.detail || {};
      const skipReloadTriggers = ['batchSaveImmediate', 'driver_location_update', 'driverLocationUpdate', 'pullToSyncDataReady', 'pullToSyncComplete', 'initialDataReady'];
      if (preserveLocalState || skipReloadTriggers.includes(triggeredBy)) {
        // CRITICAL: Always remove deleted IDs even when preserving local state (cross-device realtime deletes)
        const idsToRemove = new Set([...(deletedIds || []), ...(deletedId ? [deletedId] : [])]);
        if (idsToRemove.size > 0) setDeliveries((prev) => prev.filter((d) => !idsToRemove.has(d?.id)));
        if (freshDeliveries?.length > 0) setDeliveries((prev) => {const map = new Map(prev.filter((d) => !idsToRemove.has(d?.id)).map((d) => [d?.id, d]).filter(([id]) => !!id));freshDeliveries.forEach((d) => {if (d?.id && !idsToRemove.has(d.id)) map.set(d.id, d);});return Array.from(map.values());});
        return;
      }
      console.log(`🔄 [Layout] Delivery updated event: ${deliveryId} (${triggeredBy}) - fullReplacement: ${fullReplacement}`);
      if (freshDeliveries?.length > 0) {
        // CRITICAL: When fullReplacement is true (route optimization), replace entire array to preserve stop_order
        if (fullReplacement) {
          setDeliveries((prev) => [...freshDeliveries].filter(Boolean));
        } else {
          // Merge mode for partial updates
          setDeliveries((prev) => {
            const map = new Map((prev || []).filter(Boolean).map((d) => [d?.id, d]).filter(([id]) => !!id));
            freshDeliveries.forEach((d) => {if (d?.id) map.set(d.id, d);});
            return Array.from(map.values());
          });
        }
      }
    };
    window.addEventListener('deliveriesUpdated', handleDeliveriesUpdated);

    // CRITICAL: Update patients/stores/appUsers in UI immediately when pullToSync completes
    const handlePullToSyncDataReady = (event) => {
      if (isUiLocked()) {
        console.log('🔒 [Layout] pullToSyncDataReady ignored — UI locked during filter-change sync');
        return;
      }
      const { patients: freshPatients, stores: freshStores, appUsers: freshAppUsers } = event.detail || {};
      if (freshPatients && freshPatients.length > 0) {
        setPatients((prev) => mergePatients(prev, freshPatients));
      }
      if (freshStores && freshStores.length > 0) setStores(freshStores);
      if (freshAppUsers && freshAppUsers.length > 0) {
        setAppUsers((prev) => {const m = new Map(prev.map((u) => [u.id, u]));freshAppUsers.forEach((u) => {if (u?.id) m.set(u.id, u);});return Array.from(m.values());});
      }
    };
    window.addEventListener('pullToSyncDataReady', handlePullToSyncDataReady);

    // AUTO-RECOVERY: Listen for force refresh after connection recovery
    const handleForceDataRefresh = async () => {
      console.log('🔄 [Layout] Force data refresh after connection recovery - COMPREHENSIVE MODE');

      // CRITICAL: Invalidate ALL data caches to ensure fresh fetch
      invalidate('Delivery');
      invalidate('Patient');
      invalidate('AppUser');
      invalidate('Store');
      invalidate('User');
      invalidate('City');

      // CRITICAL: Clear the user cache to force fresh user data fetch
      clearUserCache();
      clearSettingsCache();

      // CRITICAL: Force immediate data reload with validation
      if (triggerFullDataLoadRef.current) {
        console.log('📥 [Recovery] Starting full data reload...');
        await triggerFullDataLoadRef.current(true);
        console.log('✅ [Recovery] Full data reload complete');
      }

      // Wait for data to settle
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // CRITICAL: Validate we have complete data BEFORE updating UI
      const hasValidData =
      users.length > 0 &&
      drivers.length > 0 &&
      stores.length > 0 &&
      cities.length > 0 &&
      appUsers.length > 0;

      if (!hasValidData) {
        console.warn('⚠️ [Recovery] Data incomplete after reload - retrying...');
        // Retry once
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await triggerFullDataLoadRef.current(true);
      }

      // Refresh stats after data is loaded
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

      // CRITICAL: Force refresh ALL UI elements including COD data
      console.log('🎨 [Recovery] Refreshing all UI elements...');

      // Refresh COD data
      base44.functions.invoke('squareSyncCatalogItems', {}).then((response) => {
        const items = response?.data?.items || response?.items || [];
        setCatalogItems(items);
      }).catch(() => {});

      // Force dispatch driverLocationsUpdated to update map markers
      setTimeout(async () => {
        // Refresh driver locations to ensure colors are correct
        const locationUpdates = await smartRefreshManager.refreshDriverLocations(appUsers, true);
        if (locationUpdates?.hasChanges) {
          setAppUsers(locationUpdates.appUsers);
        }

        window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
          detail: { appUsers: locationUpdates?.appUsers || appUsers }
        }));

        console.log('✅ [Recovery] UI refresh complete');
      }, 1500);
    };
    window.addEventListener('forceDataRefresh', handleForceDataRefresh);

    realtimeSync.connect();

    return () => {
      clearTimeout(bgSyncTimer);
      clearInterval(mutationSyncInterval);
      unsubscribeMutations();
      realtimeSync.disconnect();
      window.removeEventListener('offlineSyncComplete', handleSyncComplete);
      window.removeEventListener('userRolesChanged', handleUserRolesChanged);
      window.removeEventListener('deliveriesImported', handleDeliveriesImported);
      window.removeEventListener('offlineDeliveriesDeleted', handleOfflineDeliveriesDeleted);
      window.removeEventListener('deliveriesUpdated', handleDeliveriesUpdated);
      // window.removeEventListener('driverLocationsUpdated', handleDriverLocationUpdated);
      window.removeEventListener('dataConflictsDetected', handleConflict);
      window.removeEventListener('forceDataRefresh', handleForceDataRefresh);
      window.removeEventListener('pullToSyncDataReady', handlePullToSyncDataReady);
      window.removeEventListener('openMessaging', handleOpenMessaging);window.removeEventListener('openMessagingPanel', handleOpenMessagingPanel);
    };
  }, [currentUser, currentPageName]);

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
      setDeliveries((prev) => newDeliveries?.filter(Boolean).length || !prev.length ? [...(newDeliveries || []).filter(Boolean)] : prev);
    } else {
      setDeliveries((prevDeliveries) => {
        const merged = new Map((prevDeliveries || []).filter(Boolean).map((delivery) => [delivery.id, delivery]));
        (newDeliveries || []).filter(Boolean).forEach((delivery) => {
          if (!delivery?.id) return;
          const existing = merged.get(delivery.id);
          merged.set(delivery.id, existing ? { ...existing, ...delivery } : delivery);
        });
        return Array.from(merged.values());
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

    if (updates.deliveries) setDeliveries(updates.deliveries);
    if (updates.patients) setPatients(updates.patients);
    if (updates.appUsers) {

      if (currentUser && !isReloadingFromAppUserChange.current) {
        const updatedAppUserForCurrentUser = updates.appUsers.find((au) => au && au.user_id === currentUser.id);

        if (updatedAppUserForCurrentUser) {
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
  }, [currentUser, isFormOverlayOpen, deliveries, patients]);

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

  const triggerFullDataLoadRef = useRef();

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
        // Single delivery UI update — after all other state is set
        updateDeliveriesLocally(deliveries || [], true);
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
    } else if (userHasRole(currentUser, 'dispatcher')) {const sIds = currentUser.store_ids || [];if (selectedStoreId && selectedStoreId !== 'all' && !sIds.includes(selectedStoreId)) return [];const relIds = selectedStoreId && selectedStoreId !== 'all' ? [selectedStoreId] : sIds;data = data.filter((p) => p && relIds.includes(p.store_id));}return data;}, [patients, currentUser, selectedStoreId]); // Route count - for dispatchers: unique dates with at least 1 delivery for their stores (YTD)
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
  const currentPayrollNetPay = usePayrollBadge(currentUser, appUsers, dataLoaded);

  // Calculate online user counts
  const onlineCounts = useMemo(() => {
    const onlineDispatchers = appUsers.filter(
      (au) => au?.app_roles?.includes('dispatcher') && au.driver_status === 'online'
    );

    const onlineStores = new Set();
    onlineDispatchers.forEach((dispatcher) => {
      dispatcher.store_ids?.forEach((storeId) => onlineStores.add(storeId));
    });

    const onlineDrivers = appUsers.filter(
      (au) => au?.app_roles?.includes('driver') && (au.driver_status === 'online' || au.driver_status === 'on_duty')
    );

    const onlineNonDriverNonDispatcherUsers = appUsers.filter(
      (au) =>
      !au?.app_roles?.includes('driver') &&
      !au?.app_roles?.includes('dispatcher') &&
      au.driver_status === 'online'
    );

    return {
      onlineStoresCount: onlineStores.size,
      onlineDriversCount: onlineDrivers.length,
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
      <ConnectionRecoveryBanner />
      <MobileOverlayBackHandler isMobile={isMobile} isTabletPortrait={isTabletPortrait} isOverlayOpen={sidebarOpen || showMessaging || showInviteQRModal || showCitySelectionPopup || isFormOverlayOpen} onRequestCloseOverlay={() => {if (sidebarOpen) setSidebarOpen(false);if (showMessaging) {setShowMessaging(false);setInitialConversation(null);}if (showInviteQRModal) setShowInviteQRModal(false);if (isFormOverlayOpen) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));}} />

      {/* PWA Install Prompt */}
      <PWAInstallPrompt />

      {showCitySelectionPopup && currentUser && cities && cities.length > 0 &&
      <CitySelectionPopup
        cities={cities}
        currentUser={currentUser}
        onCitySelected={handleCitySelected} />
      }

      {/* Device Registration - Shows existing devices or option to create new - ALL USERS */}
      {!showCitySelectionPopup && !deviceRegistered && currentUser &&
      <DeviceRegistration
        currentUser={currentUser}
        onDeviceRegistered={(device) => {
          console.log('✅ Device registered:', device);
          setDeviceRegistered(true);
          // Cache the registration to prevent re-prompting on refresh
          localStorage.setItem(`rxdeliver_device_registered_${device.device_identifier}`, 'true');
        }} />
      }

      {showMessaging &&
      <MessagingPanel
        currentUser={currentUser}
        users={users}
        onClose={() => {
          setShowMessaging(false);
          setInitialConversation(null);
        }}
        initialConversation={initialConversation}
        onUnreadCountChange={setUnreadMessageCount} />
      }

      {showInviteQRModal &&
      <InviteQRCodeModal
        isOpen={showInviteQRModal}
        onClose={() => setShowInviteQRModal(false)}
        currentUser={currentUser}
        stores={stores} />
      }

                  {/* Global Conflict Manager */}
                  <ConflictManager />
                  
                  {/* Message Notification Balloon */}
                               {currentUser && !showMessaging &&
      <MessageNotificationBalloon
        currentUser={currentUser}
        onOpenConversation={(conversationId, otherUserId, otherUserName) => {
          setInitialConversation({ conversationId, otherUserId, otherUserName });
          setShowMessaging(true);
          setUnreadMessageCount(0);
        }} />
      }
                               {/* WebSocket Diagnostics Card - App Owners only, non-primary devices */}
                               {isAppOwner(currentUser) &&
      <WebSocketDiagnosticsCard />
      }

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
          isDataLoaded: dataLoaded, refreshData: triggerFullDataLoadRef.current, updateDeliveriesLocally, updateAppUsersLocally,
          applyDeliveryChangesLocally: ({ upserts = [], deleteIds = [] }) => setDeliveries((prev) => {const map = new Map((prev || []).filter(Boolean).map((item) => [item?.id, item]).filter(([id]) => !!id));(deleteIds || []).forEach((id) => map.delete(id));(upserts || []).forEach((item) => {if (item?.id) map.set(item.id, map.has(item.id) ? { ...map.get(item.id), ...item } : item);});return Array.from(map.values());}),
          applyAppUserChangesLocally: ({ upserts = [], deleteIds = [] }) => setAppUsers((prev) => {const map = new Map((prev || []).filter(Boolean).map((item) => [item?.id, item]).filter(([id]) => !!id));(deleteIds || []).forEach((id) => map.delete(id));(upserts || []).forEach((item) => {if (item?.id) map.set(item.id, map.has(item.id) ? { ...map.get(item.id), ...item } : item);});return Array.from(map.values());}),
          applyPatientChangesLocally: ({ upserts = [], deleteIds = [] }) => setPatients((prev) => {const map = new Map((prev || []).filter(Boolean).map((item) => [item?.id, item]).filter(([id]) => !!id));(deleteIds || []).forEach((id) => map.delete(id));(upserts || []).forEach((item) => {if (item?.id) map.set(item.id, map.has(item.id) ? { ...map.get(item.id), ...item } : item);});return Array.from(map.values());}),
          updatePatientsLocally: ({ upserts = [], deleteIds = [] }) => setPatients((prev) => {const map = new Map((prev || []).filter(Boolean).map((item) => [item?.id, item]).filter(([id]) => !!id));(deleteIds || []).forEach((id) => map.delete(id));(upserts || []).forEach((item) => {if (item?.id) map.set(item.id, map.has(item.id) ? { ...map.get(item.id), ...item } : item);});return Array.from(map.values());}),
          isFormOverlayOpen: isFormOverlayOpen, setIsFormOverlayOpen: setIsFormOverlayOpen, isEntityUpdating: isEntityUpdating, setIsEntityUpdating: setIsEntityUpdating,
          smartRefreshActivity: smartRefreshActivity, setSmartRefreshActivity: setSmartRefreshActivity, setOnSmartRefreshComplete: (callback) => {onSmartRefreshCompleteRef.current = callback;},
          dataReadyForSelectedDate: dataLoaded, dataSource: dataSource
        }}>
            <div className={`app-container ${isTabletPortrait ? 'tablet-portrait' : isMobile ? 'mobile-device' : 'desktop-device'}`}>
              {(isMobile || isTabletPortrait) && sidebarOpen &&
            <div
              className="sidebar-overlay"
              onClick={() => setSidebarOpen(false)} />
            }

              {/* Sidebar */}
            <div className={`app-sidebar ${sidebarOpen ? 'sidebar-open' : ''} border-r flex flex-col z-[200]`} style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}>
                <div className="border-b p-4 flex-shrink-0" style={{ borderColor: 'var(--border-slate-200)' }}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      {/* Close button - show when sidebar is open (always on mobile, on desktop when expanded) */}
                      {sidebarOpen &&
                    <button
                      onClick={() => setSidebarOpen(false)}
                      className="p-2 rounded-lg transition-colors"
                      style={{
                        '&:hover': { background: 'var(--bg-slate-100)' }
                      }}>
                          <X className="w-5 h-5" style={{ color: 'var(--text-slate-700)' }} />
                        </button>
                    }

                      <img
                      src={branding.favicon_url || "https://cdn-icons-png.flaticon.com/512/3843/3843479.png"}
                      alt="App Icon"
                      className="w-10 h-10 rounded object-contain"
                      style={{ filter: 'var(--image-filter, none)' }} />

                      <div>
                        <h2 className="font-bold text-lg" style={{ color: branding.primary_color || 'var(--text-slate-900)' }}>
                          {currentUser?.company_id ? 'Company App' : 'RxDeliver'}
                        </h2>
                        <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>Pharmacy Logistics</p>
                        <div className="flex items-center">
                          <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>{appVersion}</p>
                          {!isMobile && !isTabletPortrait && <BatteryIndicator />}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {/* Show controls in navigation panel when tablet landscape OR desktop admin */}
                      {deviceType === 'Tablet' && !isTabletPortrait || !isMobile && !isTabletPortrait && userHasRole(currentUser, 'admin') && cities && cities.length > 0 ?
                    <>
                          {/* Settings Menu */}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                                <MoreVertical className={`${isMobile ? 'w-5 h-5' : 'w-4 h-4'} text-slate-500`} />
                              </Button>
                            </DropdownMenuTrigger>
                            <SettingsMenu
                          currentUser={currentUser}
                          currentUser={currentUser}
                          isAppOwner={isAppOwner(currentUser)}
                          adminImportEnabled={adminImportEnabled}
                          onAdminImportToggle={async (checked) => {
                            // if (currentUser?._isImpersonating) return;
                            setAdminImportEnabled(checked);
                            try {
                              const settings = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
                              if (settings && settings.length > 0) {
                                await base44.entities.AppSettings.update(settings[0].id, {
                                  setting_value: {
                                    ...settings[0].setting_value,
                                    adminImportEnabled: checked
                                  }
                                });
                              }
                            } catch (error) {
                              console.error('Failed to save admin import setting:', error);
                            }
                          }}
                          themePreference={themePreference}
                          onThemeChange={handleThemeChange}
                          cities={cities}
                          onPatientImportClick={() => setShowPatientImport(true)}
                          onDeliveryImportClick={() => setShowDeliveryImport(true)}
                          isMobile={isMobile} />

                          </DropdownMenu>

                          {/* Driver Status Toggle - mobile devices (including tablets) in landscape, drivers only */}
                          {isMobileDeviceForTheme() && currentUser && userHasRole(currentUser, 'driver') &&
                      <DriverStatusToggle
                        currentUser={currentUser}
                        vertical={true}
                        onStatusChange={async (newStatus) => {
                          clearUserCache();
                          const refreshedUser = await getEffectiveUser();
                          if (refreshedUser) {
                            setCurrentUser(refreshedUser);
                          }
                        }} />

                      }
                        </> : null
                    }
                    </div>
                  </div>
                </div>

                <div className="pt-1 pr-3 pb-3 pl-3 flex-1 overflow-y-auto custom-scrollbar" style={{ background: 'var(--bg-white)' }} onClickCapture={(e) => {if ((isMobile || isTabletPortrait) && e.target?.closest?.('a')) {window.dispatchEvent(new CustomEvent('overlayNavigateClose'));}}}>
                  <div className="py-0.5">
                    <Link
                    to={constructUrlWithParams("Dashboard")}
                    onClick={() => setSidebarOpen(false)} className="px-4 rounded-xl flex items-center gap-3 transition-all duration-200 hover:opacity-80 py-1"

                    style={currentPageName === 'Dashboard' ? {
                      background: 'var(--bg-slate-100)',
                      color: 'var(--text-slate-900)'
                    } : {
                      color: 'var(--text-slate-600)'
                    }}>
                      <LayoutDashboard className="w-5 h-5" />
                      <span className="font-semibold">Dashboard</span>
                    </Link>

                    <SidebarDivider />

                    {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) &&
                  <Link
                    to={createPageUrl('Patients')}
                    onClick={() => setSidebarOpen(false)}
                    className={`px-4 rounded-xl flex items-center gap-2 transition-all duration-200 py-0.5 ${
                    currentPageName === 'Patients' ?
                    'shadow-sm' :
                    'hover:opacity-80'}`
                    }
                    style={currentPageName === 'Patients' ? {
                      background: 'var(--bg-slate-100)',
                      color: 'var(--text-slate-900)'
                    } : {
                      color: 'var(--text-slate-600)'
                    }}>
                          <Users className="w-5 h-5" />
                          <span className="font-semibold">Patients</span>
                          <Badge variant="secondary" className="ml-auto justify-center rounded-[10px] w-[50px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-600)' }}>{userHasRole(currentUser, 'admin') ? entityCounts.patients : patients.filter((p) => p && currentUser?.store_ids?.includes(p.store_id)).length}</Badge>
                          </Link>
                  }

                    {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) &&
                  <Link
                    to={getRouteNavigationUrl('Deliveries')}
                    onClick={() => setSidebarOpen(false)}
                    className={`px-4 rounded-xl flex items-center gap-2 transition-all duration-200 py-0.5 ${
                    currentPageName === 'Deliveries' ?
                    'shadow-sm' :
                    'hover:opacity-80'}`
                    }
                    style={currentPageName === 'Deliveries' ? {
                      background: 'var(--bg-slate-100)',
                      color: 'var(--text-slate-900)'
                    } : {
                      color: 'var(--text-slate-600)'
                    }}>
                          <Package className="w-5 h-5" />
                          <span className="font-semibold">Routes</span>
                          <Badge variant="secondary" className="ml-auto justify-center rounded-[10px] w-[50px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-600)' }}>{totalRoutesCount}</Badge>
                          </Link>
                  }

                          {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) &&
                  <Link
                    to={constructUrlWithParams(createPageUrl('Stores'))}
                    onClick={() => setSidebarOpen(false)}
                    className={`px-4 rounded-xl flex items-center gap-2 transition-all duration-200 py-0.5 ${
                    currentPageName === 'Stores' ?
                    'shadow-sm' :
                    'hover:opacity-80'}`
                    }
                    style={currentPageName === 'Stores' ? {
                      background: 'var(--bg-slate-100)',
                      color: 'var(--text-slate-900)'
                    } : {
                      color: 'var(--text-slate-600)'
                    }}>
                          <Building className="w-5 h-5" />
                          <span className="font-semibold">Stores</span>
                          <Badge variant="secondary" className="ml-auto justify-center w-[50px] rounded-[10px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-600)' }}>{`${onlineCounts.onlineStoresCount}/${stores.length}`}</Badge>
                          </Link>
                  }

                  <Link
                    to={constructUrlWithParams('/Drivers')}
                    onClick={() => setSidebarOpen(false)}
                    className={`px-4 rounded-xl flex items-center gap-2 transition-all duration-200 py-0.5 ${
                    currentPageName === 'Drivers' ?
                    'shadow-sm' :
                    'hover:opacity-80'}`
                    }
                    style={currentPageName === 'Drivers' ? {
                      background: 'var(--bg-slate-100)',
                      color: 'var(--text-slate-900)'
                    } : {
                      color: 'var(--text-slate-600)'
                    }}>
                          <Truck className="w-5 h-5" />
                          <span className="font-semibold">Drivers</span>
                          <Badge variant="secondary" className="ml-auto justify-center w-[50px] rounded-[10px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-600)' }}>{`${onlineCounts.onlineDriversCount}/${drivers.length}`}</Badge>
                          </Link>

                          <div className="border-t mb-2 py-0.5 mt-1" style={{ borderColor: 'var(--border-slate-200)' }}></div>

                    {/* Square COD - Admins and Drivers only */}
                    {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver')) &&
                  <Link
                    to={createPageUrl('SquareManagement')}
                    onClick={() => setSidebarOpen(false)}
                    className={`px-4 rounded-xl flex items-center gap-2 transition-all duration-200 py-0.5 ${
                    currentPageName === 'SquareManagement' ?
                    'shadow-sm' :
                    'hover:opacity-80'}`
                    }
                    style={currentPageName === 'SquareManagement' ? {
                      background: 'var(--bg-slate-100)',
                      color: 'var(--text-slate-900)'
                    } : {
                      color: 'var(--text-slate-600)'
                    }}>
                          <DollarSign className="w-5 h-5" />
                          <span className="font-semibold">Square COD</span>
                          {(() => {const bal = calculateRouteCodBalance(deliveries, globalFilters.getSelectedDriverId(), globalFilters.getSelectedDate());return <Badge variant="secondary" className="ml-auto justify-center w-auto px-2 rounded-[10px]" style={{ background: bal > 0 ? '#fef3c7' : 'var(--bg-slate-200)', color: bal > 0 ? '#92400e' : 'var(--text-slate-600)' }}>${bal.toFixed(2)}</Badge>;})()}
                          </Link>
                  }

                    {/* Driver Payroll - Admins and Drivers */}
                    {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver')) &&
                  <Link
                    to={createPageUrl('DriverPayroll')}
                    onClick={() => setSidebarOpen(false)}
                    className={`px-4 rounded-xl flex items-center gap-2 transition-all duration-200 py-0.5 ${
                    currentPageName === 'DriverPayroll' ?
                    'shadow-sm' :
                    'hover:opacity-80'}`
                    }
                    style={currentPageName === 'DriverPayroll' ? {
                      background: 'var(--bg-slate-100)',
                      color: 'var(--text-slate-900)'
                    } : {
                      color: 'var(--text-slate-600)'
                    }}>
                          <DollarSign className="w-5 h-5" />
                          <span className="font-semibold">Driver Payroll</span>
                          <Badge variant="secondary" className="ml-auto justify-center w-auto px-2 rounded-[10px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-600)' }}>
                            ${(currentPayrollNetPay ?? 0).toFixed(2)}
                          </Badge>
                          </Link>
                  }

                    {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) &&
                  <Link
                    to={constructUrlWithParams(createPageUrl("DeliveryMetrics"))}
                    onClick={() => setSidebarOpen(false)}
                    className={`px-4 rounded-xl flex items-center gap-2 transition-all duration-200 py-0 ${
                    currentPageName === 'DeliveryMetrics' ?
                    'shadow-sm' :
                    'hover:opacity-80'}`
                    }
                    style={currentPageName === 'DeliveryMetrics' ? {
                      background: 'var(--bg-slate-100)',
                      color: 'var(--text-slate-900)'
                    } : {
                      color: 'var(--text-slate-600)'
                    }}>
                        <BarChart3 className="w-5 h-5" />
                        <span className="font-semibold">Route Metrics</span>
                      </Link>
                  }

                    <div className="border-t mb-2 mt-1" style={{ borderColor: 'var(--border-slate-200)' }}></div>

                    {(userHasRole(currentUser, 'driver') || userHasRole(currentUser, 'admin')) &&
                  <Link
                    to={createPageUrl('DeviceSettings')}
                    onClick={() => setSidebarOpen(false)}
                    className={`px-4 rounded-xl flex items-center gap-2 transition-all duration-200 py-0.5 ${
                    currentPageName === 'DeviceSettings' ?
                    'shadow-sm' :
                    'hover:opacity-80'}`
                    }
                    style={currentPageName === 'DeviceSettings' ? {
                      background: 'var(--bg-slate-100)',
                      color: 'var(--text-slate-900)'
                    } : {
                      color: 'var(--text-slate-600)'
                    }}>
                        <Smartphone className="w-5 h-5" />
                        <span className="font-semibold">Device Settings</span>
                      </Link>
                  }

                    </div>

                  {userHasRole(currentUser, 'admin') &&
                <AdminNavigationSection
                  adminNavigationItems={adminNavigationItems}
                  currentPageName={currentPageName}
                  constructUrlWithParams={constructUrlWithParams}
                  setSidebarOpen={setSidebarOpen} />
                }

                  {currentPageName === 'Dashboard' &&
                <div className="mt-2">
                        <div className="border-t mb-2" style={{ borderColor: 'var(--border-slate-200)' }}></div>
                        <SidebarSectionLabel>Quick Stats</SidebarSectionLabel>
                        <QuickStats
                    currentUser={currentUser}
                    storeIds={stores.filter((s) => s && s.city_id === globalFilters.getSelectedCityId()).map((s) => s.id)}
                    isMobile={isMobile}
                    screenWidth={screenWidth} />

                        {/* Offline DB Monitor - embedded on narrow screens */}
                        {(isMobile || screenWidth < 768) &&
                  <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-slate-200)' }}>
                          <OfflineSyncIndicator embedded={true} />
                        </div>
                  }
                      </div>
                }
                </div>

                <SidebarUserFooter
                currentUser={currentUser}
                users={users}
                unreadMessageCount={unreadMessageCount}
                onOpenMessaging={() => {setShowMessaging(true);setUnreadMessageCount(0);setSidebarOpen(false);}}
                onOpenInviteQR={() => {setShowInviteQRModal(true);setSidebarOpen(false);}}
                stores={stores}
                filteredDeliveries={filteredDeliveries} />

                </div>

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
                    {!sidebarOpen && currentUser && (screenWidth < 768 || isTabletPortrait) &&
              <MobileBottomNav currentUser={currentUser} currentPageName={currentPageName} onSidebarToggle={() => setSidebarOpen(true)} />
              }
              </div>
            </div>
          </AppDataProvider>
          </UserProvider>
      }

      <OptimizationSpinner />
    </AppErrorBoundary>);
}