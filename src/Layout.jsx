import React, { useState, useEffect, Fragment, useMemo, useCallback, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import "./components/utils/globalErrorHandler";
import { createPageUrl } from "./utils";
import { User } from "@/entities/User";
import { AppUser } from "@/entities/AppUser";
import { Delivery } from "@/entities/Delivery";
import { Patient } from "@/entities/Patient";
import { City } from "@/entities/City";
import { Store } from "@/entities/Store";
import { format } from "date-fns";
import { getData, invalidate, loadDeliveries, loadDeliveriesForDate, loadFullMonthDeliveries } from './components/utils/dataManager';
import { smartRefreshManager } from './components/utils/smartRefreshManager';
import { offlineDB } from './components/utils/offlineDatabase';
import {
  LayoutDashboard,
  Users,
  Package,
  MapPin,
  Truck,
  Bell,
  HeartPulse,
  Building,
  Users2,
  Building2,
  BarChart3,
  LogOut,
  Eye,
  UserCheck,
  Clock,
  CheckCircle,
  AlertCircle,
  ChevronDown,
  Undo2,
  Menu,
  X,
  RefreshCw,
  Phone,
  BellRing,
  Settings,
  Home,
  FileText,
  Wrench,
  UserCog,
  Stethoscope,
  MoreVertical,
  MessageCircle,
  DollarSign,
  CreditCard } from
"lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger } from
"@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandList, CommandItem } from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger } from
"@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { getEffectiveUser, clearUserCache } from "./components/utils/auth";
import { base44 } from '@/api/base44Client';
import { motion, AnimatePresence } from "framer-motion";
import { userHasRole, getPrimaryRole, formatRoles, isAppOwner, canAccessImports } from './components/utils/userRoles';
import { getDriverDisplayName } from './components/utils/driverUtils';
import { formatPhoneNumber } from './components/utils/phoneFormatter';
import { sortUsers, sortStores } from './components/utils/sorting';
import { UserProvider } from './components/utils/UserContext';
import { AppDataProvider } from './components/utils/AppDataContext';
import { ResizableDivider } from './components/ui/resizable-divider';
import { globalFilters } from './components/utils/globalFilters';
import CitySelectionPopup from './components/cities/CitySelectionPopup';
import { getActiveDriversForCity, getAvailableDrivers } from './components/utils/driverSelectors';
// Removed: getCitiesWithinRadius - no longer using geographic filtering
import { getUserAgentInfo, isMobileDeviceForTheme } from './components/utils/deviceUtils';
import PatientImport from './components/patients/PatientImport';
  import RouteImport from './components/deliveries/RouteImport';
  import DriverStatusToggle from './components/layout/DriverStatusToggle';
  import LocationTrackingToggle from './components/layout/LocationTrackingToggle';
  import { loadUserSettings, saveSetting, clearSettingsCache } from './components/utils/userSettingsManager';
  import MessagingPanel from './components/messaging/MessagingPanel';
  import SmartRefreshIndicator from './components/layout/SmartRefreshIndicator';
  import { isMobileDevice } from './components/utils/deviceUtils';
  import MessageNotificationBalloon from './components/messaging/MessageNotificationBalloon';
  import InviteQRCodeModal from './components/common/InviteQRCodeModal';
  import { QrCode } from 'lucide-react';
import { initializeDailyCleanup } from './components/utils/messageCleaner';
import { toast } from 'sonner';
import { performInitialSync, processPendingMutations } from './components/utils/offlineSync';
import OfflineSyncIndicator from './components/layout/OfflineSyncIndicator';
import ConnectionRecoveryBanner from './components/layout/ConnectionRecoveryBanner';
import { subscribeMutations } from './components/utils/entityMutations';
import { realtimeSync, subscribeToRealtime } from './components/utils/realtimeSync';
import ConflictManager from './components/dashboard/ConflictManager';
import PWAInstallPrompt from './components/common/PWAInstallPrompt';
import { calculateUserCodTotal } from './components/utils/codTotalCalculator';
import BatteryIndicator from './components/layout/BatteryIndicator';
import SettingsMenu from './components/layout/SettingsMenu';

// App version will be loaded from AppSettings
const DEFAULT_APP_VERSION = 'v1.0.0';

const createMergedUser = (authUser, appUser) => {
  // CRITICAL: Allow creating users from AppUser data alone (for non-admin users who can't fetch User.list())
  if (!authUser && !appUser) {
    return null;
  }

  // If only appUser exists (no authUser), create a pseudo-user from AppUser data
  if (!authUser && appUser) {
    return {
      id: appUser.user_id,
      user_id: appUser.user_id,
      email: null, // Not available without authUser
      full_name: appUser.user_name || 'Unknown User',
      user_name: appUser.user_name || 'Unknown User',
      display_name: appUser.user_name || 'Unknown User',
      app_roles: Array.isArray(appUser.app_roles) ? appUser.app_roles : [],
      status: appUser.status || 'inactive',
      driver_status: appUser.driver_status,
      city_id: appUser.city_id,
      store_ids: appUser.store_ids,
      sort_order: appUser.sort_order,
      phone: appUser.phone,
      home_latitude: appUser.home_latitude,
      home_longitude: appUser.home_longitude,
      current_latitude: appUser.current_latitude,
      current_longitude: appUser.current_longitude,
      location_updated_at: appUser.location_updated_at,
      location_tracking_enabled: appUser.location_tracking_enabled
    };
  }

  // If authUser exists, merge with appUser (if available)
  let merged = {
    ...authUser,
    id: authUser.id,
    user_name: authUser.full_name,
    display_name: authUser.full_name,
    app_roles: [],
    status: 'inactive'
  };

  if (appUser) {
    merged = {
      ...merged,
      ...appUser,
      id: authUser.id,
      user_name: appUser.user_name !== undefined && appUser.user_name !== null ? appUser.user_name : merged.user_name,
      display_name: appUser.user_name !== undefined && appUser.user_name !== null ? appUser.user_name : merged.display_name,
      app_roles: Array.isArray(appUser.app_roles) ? appUser.app_roles : merged.app_roles,
      status: appUser.status !== undefined && appUser.status !== null ? appUser.status : merged.status
    };
  }
  return merged;
};

const QuickStats = ({ currentUser, storeIds = [], isMobile, screenWidth }) => {
  const [selectedDateStr, setSelectedDateStr] = useState(() => globalFilters.getSelectedDate());
  const [selectedDriverId, setSelectedDriverIdLocal] = useState(() => globalFilters.getSelectedDriverId());
  const [stats, setStats] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const lastFetchRef = useRef({ date: null, driver: null, timestamp: 0 });

  // Subscribe to global filter changes (not polling)
  useEffect(() => {
    const unsubscribe = globalFilters.subscribe(() => {
      const currentDateStr = globalFilters.getSelectedDate();
      const currentDriverId = globalFilters.getSelectedDriverId();

      if (currentDateStr !== selectedDateStr) {
        setSelectedDateStr(currentDateStr);
        // CRITICAL: Force immediate stats refresh on date change
        lastFetchRef.current = { date: null, driver: null, timestamp: 0 };
      }
      if (currentDriverId !== selectedDriverId) {
        setSelectedDriverIdLocal(currentDriverId);
        // CRITICAL: Force immediate stats refresh on driver change
        lastFetchRef.current = { date: null, driver: null, timestamp: 0 };
      }
    });

    return () => unsubscribe();
  }, [selectedDateStr, selectedDriverId]);

  // Fetch stats - only when filters change or on delivery events
  // CRITICAL: Use longer cache duration and avoid fetching on every driver change
  useEffect(() => {
    if (!currentUser) return;

    const fetchStats = async (force = false) => {
      // CRITICAL: Allow re-fetch on driver/date changes, but with minimal cache (5 seconds)
      const now = Date.now();
      if (!force &&
      lastFetchRef.current.date === selectedDateStr &&
      lastFetchRef.current.driver === selectedDriverId &&
      now - lastFetchRef.current.timestamp < 5000) {
        return;
      }

      try {
        setHasError(false);
        if (!stats) setIsLoading(true); // Only show loading on first load

        const driverId = selectedDriverId === 'all' ? null : selectedDriverId;

        let filteredStoreIds = [];
        if (userHasRole(currentUser, 'admin')) {
          filteredStoreIds = storeIds;
        } else if (userHasRole(currentUser, 'dispatcher')) {
          filteredStoreIds = (currentUser.store_ids || []).filter(Boolean);
        } else if (userHasRole(currentUser, 'driver')) {
          filteredStoreIds = storeIds;
        }

        const response = await base44.functions.invoke('getDeliveryStats', {
          selectedDate: selectedDateStr,
          driverId: driverId,
          storeIds: filteredStoreIds.length > 0 ? filteredStoreIds : null
        });

        const data = response?.data || response;
        if (data && data.today) {
          setStats(data);
          lastFetchRef.current = { date: selectedDateStr, driver: selectedDriverId, timestamp: now };

          // CRITICAL: Dispatch events to pass stats to Dashboard
          if (data.performanceStats) {
            window.dispatchEvent(new CustomEvent('performanceStatsUpdated', {
              detail: data.performanceStats
            }));
          }

          // Dispatch delivery stats (today's counts)
          window.dispatchEvent(new CustomEvent('deliveryStatsUpdated', {
            detail: data
          }));
        } else {
          setHasError(true);
        }
      } catch (error) {
        if (error.response?.status !== 500) {
          console.warn('Stats fetch error:', error.message);
        }
        setHasError(true);
      } finally {
        setIsLoading(false);
      }
    };

    // Initial fetch - delay slightly to let offline data load first
    const timer = setTimeout(() => fetchStats(), 2000);

    // Listen for delivery changes (imports, status changes, etc.)
    const handleDeliveryChange = () => fetchStats(true);
    window.addEventListener('refreshDeliveryStats', handleDeliveryChange);
    window.addEventListener('deliveriesImported', handleDeliveryChange);
    window.addEventListener('offlineSyncComplete', handleDeliveryChange);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('refreshDeliveryStats', handleDeliveryChange);
      window.removeEventListener('deliveriesImported', handleDeliveryChange);
      window.removeEventListener('offlineSyncComplete', handleDeliveryChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser, selectedDateStr, selectedDriverId]); // Removed storeIds to reduce re-fetches

  const StatItem = ({ icon: Icon, label, value, colorClass }) =>
  <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${colorClass || 'text-slate-500'}`} />
          <span className="font-medium" style={{ color: 'var(--text-slate-600)' }}>{label}</span>
        </div>
        <Badge variant="secondary" className="inline-flex border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent hover:bg-secondary/80 justify-center w-[60px] rounded-[10px]" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)' }}>{value}</Badge>
      </div>;

  if (!currentUser) return null;

  const selectedDate = selectedDateStr ? new Date(selectedDateStr + 'T00:00:00') : new Date();
  const now = new Date();
  const todayString = format(now, 'yyyy-MM-dd');
  const isToday = format(selectedDate, 'yyyy-MM-dd') === todayString;

  // CRITICAL: Only show loading skeleton on FIRST load (no stats yet)
  // When stats exist, keep displaying them while updating
  if (isLoading && !stats) {
    return (
      <div className="px-3 py-2">
        <div className="animate-pulse space-y-2">
          <div className="h-4 bg-slate-200 rounded w-1/2"></div>
          <div className="h-6 bg-slate-200 rounded"></div>
          <div className="h-6 bg-slate-200 rounded"></div>
        </div>
      </div>);

  }

  if (hasError && !stats) {
    return (
      <div className="px-3 py-2 text-sm text-slate-500">
        Unable to load stats
      </div>);

  }

  return (
    <div className="px-3 py-2 space-y-3">
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-slate-500)' }}>
          {isToday ? "Today's Stats:" : format(selectedDate, 'MMM dd, yyyy') + ':'}
        </h4>
        <div className="space-y-2">
          {!userHasRole(currentUser, 'driver') && <StatItem icon={Truck} label="Active Drivers" value={stats.today.activeDrivers} colorClass="text-blue-600" />}
          <StatItem icon={Package} label="Active Stops" value={stats.today.activeStops} colorClass="text-slate-600" />
          <StatItem icon={CheckCircle} label="Completed" value={stats.today.completed} colorClass="text-green-600" />
          {(stats.today.failed > 0 || stats.today.returns > 0) &&
          <StatItem
            icon={AlertCircle}
            label="Failed/Returned"
            value={`${stats.today.failed} / ${stats.today.returns}`}
            colorClass="text-red-600" />
          }
          {/* <StatItem icon={MapPin} label="Polylines" value={stats.today.polylineCount || 0} colorClass="text-blue-600" /> */}
        </div>
      </div>

      <div>
        <h4 className="xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--text-slate-500)' }}>{format(selectedDate, 'MMMM yyyy')}:</h4>
        <div className="space-y-2">
          <StatItem icon={CheckCircle} label="Completed" value={stats.month.completed} colorClass="text-green-600" />
          {(stats.month.failed > 0 || stats.month.returns > 0) &&
          <StatItem
            icon={AlertCircle}
            label="Failed/Returned"
            value={`${stats.month.failed} / ${stats.month.returns}`}
            colorClass="text-red-600" />
          }
        </div>
      </div>
    </div>);

};

const UserImpersonation = ({ users = [], onImpersonate, onStopImpersonating, impersonatingUser, currentUser }) => {
  const [open, setOpen] = useState(false);

  // CRITICAL: Deduplicate users by ID BEFORE sorting to prevent duplicates in View As User menu
  const dedupedUsers = currentUser ? users.filter((u) => u && u.id !== currentUser.id) : users;
  const uniqueUsersMap = new Map();
  dedupedUsers.forEach(u => {
    if (u?.id && !uniqueUsersMap.has(u.id)) {
      uniqueUsersMap.set(u.id, u);
    }
  });
  const availableUsers = sortUsers(Array.from(uniqueUsersMap.values()));

  return (
    <div className="mt-2 space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-full gap-2" style={{ borderColor: 'var(--border-slate-300)', background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}>
            <Eye className="w-4 h-4" style={{ color: 'var(--text-slate-700)' }} /> {impersonatingUser ? 'Switch User' : 'View as User'}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0 z-[100001]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>
          <Command style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>
            <CommandList style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>
              <CommandGroup style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>
                {availableUsers.map((user) =>
                <CommandItem
                  key={user.id}
                  value={`${user.user_name || user.full_name} ${formatRoles(user)}`}
                  onSelect={() => {
                    onImpersonate(user.id);
                    setOpen(false);
                  }}
                  className="flex justify-between"
                  style={{ color: 'var(--text-slate-900)' }}>

                    <span>{user.user_name || user.full_name}</span>
                    <span className="text-xs capitalize" style={{ color: 'var(--text-slate-500)' }}>{formatRoles(user)}</span>
                  </CommandItem>
                )}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>);

};

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

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    if (error.message && (
    error.message.includes('l is not a function') ||
    error.message.includes('_leaflet_pos') ||
    error.message.includes('Leaflet'))) {
      console.warn('Leaflet error caught by ErrorBoundary, continuing normally');
      return { hasError: false };
    }

    // Cache error to localStorage for debugging (survives refresh)
    try {
      localStorage.setItem('rxdeliver_last_error', JSON.stringify({
        message: error?.message || 'Unknown error',
        stack: error?.stack || '',
        timestamp: new Date().toISOString()
      }));
    } catch (e) {

      // Ignore localStorage errors
    }
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    if (error.message && (
    error.message.includes('l is not a function') ||
    error.message.includes('_leaflet_pos') ||
    error.message.includes('Leaflet'))) {
      console.warn('Leaflet error caught and neutralized by ErrorBoundary');
      return;
    }

    // Store errorInfo in state for display
    this.setState({ errorInfo });

    console.error('═══════════════════════════════════════════════════');
    console.error('❌ CRITICAL ERROR CAUGHT BY ERROR BOUNDARY');
    console.error('Error:', error);
    console.error('Error message:', error?.message);
    console.error('Error stack:', error?.stack);
    console.error('Component stack:', errorInfo?.componentStack);
    console.error('═══════════════════════════════════════════════════');
  }

  render() {
    if (this.state.hasError) {
      // Get cached error from previous session if available
      let cachedError = null;
      try {
        const cached = localStorage.getItem('rxdeliver_last_error');
        if (cached) {
          cachedError = JSON.parse(cached);
        }
      } catch (e) {

        // Ignore
      }
      const errorToShow = this.state.error || cachedError;

      // Check if mobile device
      const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

      // Check if app owner (from localStorage cache)
      let isOwner = false;
      try {
        const userCache = sessionStorage.getItem('effectiveUserCache');
        if (userCache) {
          const parsed = JSON.parse(userCache);
          isOwner = parsed?.user?.role === 'App Owner';
        }
      } catch (e) {

        // Ignore
      }
      const showErrorDetails = isMobileDevice && isOwner && errorToShow;

      const handleCopyError = () => {
        const errorText = `Error Message:\n${errorToShow?.message || 'Unknown error'}\n\nStack Trace:\n${errorToShow?.stack || 'No stack trace'}`;
        navigator.clipboard.writeText(errorText).then(() => {
          alert('Error copied to clipboard');
        }).catch(() => {
          alert('Failed to copy error');
        });
      };

      return (
        <div className="h-screen flex items-center justify-center bg-slate-50 p-4">
          <div className="text-center max-w-2xl mx-auto">
            <h1 className="text-xl font-semibold text-slate-900 mb-2">Something went wrong</h1>
            <p className="text-slate-600 mb-4">An error occurred while loading the app.</p>

            {/* Show error details only on mobile for app owners */}
            {showErrorDetails &&
            <div className="text-left mb-4 p-4 bg-red-50 rounded-lg border-2 border-red-300">
                <div className="flex justify-between items-center mb-3">
                  <div className="font-bold text-red-900 text-lg">Error Details:</div>
                  <Button
                  onClick={handleCopyError}
                  variant="outline"
                  size="sm"
                  className="text-red-700 border-red-300 hover:bg-red-100">

                    Copy Error
                  </Button>
                </div>
                <div className="mb-2 p-2 bg-white rounded border border-red-200">
                  <div className="font-semibold text-red-900 text-sm mb-1">Message:</div>
                  <div className="text-sm text-red-800 break-words">
                    {errorToShow.message || 'Unknown error'}
                  </div>
                </div>
                {errorToShow.stack &&
              <div className="p-2 bg-white rounded border border-red-200">
                    <div className="font-semibold text-red-900 text-sm mb-1">Stack Trace:</div>
                    <pre className="text-xs text-red-800 overflow-auto max-h-40 whitespace-pre-wrap break-words">
                      {errorToShow.stack}
                    </pre>
                  </div>
              }
                {cachedError &&
              <div className="mt-2 text-xs text-red-600">
                    Error occurred at: {new Date(cachedError.timestamp).toLocaleString()}
                  </div>
              }
              </div>
            }

            <div className="flex gap-3 justify-center">
              <Button
                onClick={() => {
                  localStorage.removeItem('rxdeliver_last_error');
                  sessionStorage.clear();
                  window.location.reload();
                }}
                className="bg-emerald-600 hover:bg-emerald-700">

                Clear Cache & Refresh
              </Button>
              <Button
                onClick={() => window.location.reload()}
                variant="outline">

                Refresh Page
              </Button>
            </div>
          </div>
        </div>);

    }

    return this.props.children;
  }
}

export default function Layout({ children, currentPageName }) {
  const location = useLocation();
  const [currentUser, setCurrentUser] = useState(null);
  const [collapsed, setCollapsed] = useState(false);
  const [isLoadingLayout, setIsLoadingLayout] = useState(true);
  const [hasAccess, setHasAccess] = useState(false);

  const [initialGlobalFiltersSet, setInitialGlobalFiltersSet] = useState(false);
  const [showCitySelectionPopup, setShowCitySelectionPopup] = useState(false);

  // Track if we've done initial driver selection (prevent re-running on filter changes)
  const hasSetInitialDriver = useRef(false);

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



  const refreshIntervalRef = useRef(null);
  const wakeLockRef = useRef(null);
  const onSmartRefreshCompleteRef = useRef(null);

  // Remove unused driverLocationIntervalRef - now handled by unified refresh

  const [sidebarWidth, setSidebarWidth] = useState(240); // Will be loaded from user settings
  const [themePreference, setThemePreference] = useState('auto');
  const [userSettingsLoaded, setUserSettingsLoaded] = useState(false);
  const [dataSource, setDataSource] = useState('offline'); // 'offline' or 'online'

  // Apply theme class - mobile devices (by user agent) can use dark mode even with desktop layout
  // CRITICAL: Apply theme IMMEDIATELY to prevent flash of light mode
  useEffect(() => {
    // CRITICAL: Use isMobileDeviceForTheme() for theme decisions - ONLY based on user agent, ignores screen width
    // This allows tablets/mobile devices to use dark mode regardless of screen size
    const isMobileOrTablet = isMobileDeviceForTheme();
    
    if (!isMobileOrTablet) {
      // Force light mode on actual desktop computers only
      document.documentElement.classList.remove('auto-theme', 'dark-theme');
      document.documentElement.classList.add('light-theme');
      return;
    }

    // Mobile/tablet theme switching (works regardless of screen width or layout)
    if (themePreference === 'dark') {
      document.documentElement.classList.remove('auto-theme', 'light-theme');
      document.documentElement.classList.add('dark-theme');
    } else if (themePreference === 'light') {
      document.documentElement.classList.remove('auto-theme', 'dark-theme');
      document.documentElement.classList.add('light-theme');
    } else {
      document.documentElement.classList.remove('light-theme', 'dark-theme');
      document.documentElement.classList.add('auto-theme');
    }
  }, [themePreference]);

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
          const [isSnapshotModeActive, setIsSnapshotModeActive] = useState(false);
          const [showInviteQRModal, setShowInviteQRModal] = useState(false);

  // Poll for adminImportEnabled changes (for Kyle J to see updates when toggle changes)
  useEffect(() => {
    // Only poll for Kyle J (non-app-owner who can benefit from the toggle)
    if (!currentUser) return;
    if (isAppOwner(currentUser)) return; // App owner controls the toggle, no need to poll
    if (currentUser.user_name !== 'Kyle J') return; // Only Kyle J needs to poll

    const pollAdminImportSetting = async () => {
      try {
        const settings = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
        if (settings && settings.length > 0 && settings[0].setting_value) {
          const newValue = settings[0].setting_value.adminImportEnabled === true;
          if (newValue !== adminImportEnabled) {
            setAdminImportEnabled(newValue);
          }
        }
      } catch (error) {

        // Silent fail
      }};

    // Initial check
    pollAdminImportSetting();

    // Poll every 10 seconds for faster response
    const interval = setInterval(pollAdminImportSetting, 10000);
    return () => clearInterval(interval);
  }, [currentUser, adminImportEnabled]);

  useEffect(() => {
    const init = async () => {
      setIsLoadingLayout(true);

      try {
        const fetchedUser = await getEffectiveUser();

        if (!fetchedUser) {
          setHasAccess(false);
          setCurrentUser(null);
          setIsLoadingLayout(false);
          setDataLoaded(true);
          return;
        }



        // OPTIMIZED INITIALIZATION: Load from cache first, then background sync
        // Step 1: Load user settings from local cache (no API call)
        try {
          const settings = await loadUserSettings(fetchedUser.id);

          // Apply sidebar width (device-specific, safe to use from settings)
          if (settings.sidebar_width) {
            setSidebarWidth(settings.sidebar_width);
          }

          // Apply theme preference (mobile devices only - desktop computers always light)
          // CRITICAL: Check user agent for theme, not deviceType (which includes screen width)
          const isMobileOrTablet = isMobileDeviceForTheme();
          if (settings.theme_preference && isMobileOrTablet) {
            setThemePreference(settings.theme_preference);
          } else {
            setThemePreference('light');
          }

          // Apply data source preference
          if (settings.data_source) {
            setDataSource(settings.data_source);
          }

          setUserSettingsLoaded(true);
        } catch (settingsError) {
          setUserSettingsLoaded(true);
        }

        // Initialize smart refresh with defaults (don't wait for API)
        smartRefreshManager._enabled = true;
        smartRefreshManager._initialized = true;

        // Load app-wide settings in background (non-blocking)
        setTimeout(async () => {
          try {
            const settings = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
            if (settings && settings.length > 0 && settings[0].setting_value) {
              smartRefreshManager._enabled = settings[0].setting_value.smartRefreshEnabled !== false;
              if (settings[0].setting_value.appVersion) {
                const version = settings[0].setting_value.appVersion;
                setAppVersion(`v${version.major}.${version.minor}.${version.build}`);
              }
              setAdminImportEnabled(settings[0].setting_value.adminImportEnabled === true);
            }
          } catch (e) {

            // Silent fail - use defaults
          }}, 10000); // Load app settings 10 seconds after init

        const isDispatcher = userHasRole(fetchedUser, 'dispatcher');
        const isInactive = fetchedUser.status === 'inactive';

        if (isDispatcher && isInactive) {

          sessionStorage.clear();
          clearUserCache();
          clearSettingsCache();

          alert('Access Denied: Your account is currently inactive. Please contact an administrator.');

          try {
            await User.logout();
          } catch (logoutError) {
            console.error('Logout error:', logoutError);
          }

          window.location.href = '/';
          return;
        }

        setCurrentUser(fetchedUser);
        setHasAccess(true);

        // Load cities from offline DB first to prevent rate limits
        let citiesData = [];
        try {
          const { offlineDB: offlineDBInstance } = await import('./components/utils/offlineDatabase');
          citiesData = await offlineDBInstance.getAll(offlineDBInstance.STORES.CITIES);

          if (!citiesData || citiesData.length === 0) {
            console.log('📥 [Layout] Cities not in offline DB - fetching from API');
            citiesData = await City.list();
            // Save to offline DB for future use
            await offlineDB.bulkSave(offlineDB.STORES.CITIES, citiesData);
          } else {
            console.log(`📦 [Layout] Using ${citiesData.length} cities from offline DB`);
          }
        } catch (offlineError) {
          console.warn('⚠️ [Layout] Offline DB failed, fetching from API');
          citiesData = await City.list();
        }

        citiesData.sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
        setCities(citiesData || []);

        // Longer delay before stores to prevent rate limits
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const storesData = await getData('Store');
        let initialCityId = null;

        if (fetchedUser.city_id) {
          const userCity = citiesData.find((c) => c && c.id === fetchedUser.city_id);

          if (userCity) {
            initialCityId = fetchedUser.city_id;
          } else {
            initialCityId = null;
          }
        }

        if (userHasRole(fetchedUser, 'admin')) {
          if (!initialCityId && citiesData.length > 0) {
            initialCityId = citiesData[0].id;
          }
        }


        if (!initialCityId) {
          setShowCitySelectionPopup(true);
          globalFilters.setSelectedCityId('waiting-for-selection');
          setIsLoadingLayout(false);
          return;
        }

        globalFilters.setSelectedCityId(initialCityId);

        const today = new Date();

        // CRITICAL: Load initial COD data from offline DB first to prevent rate limits
        const { offlineDB: offlineDBInstance } = await import('./components/utils/offlineDatabase');
        const offlineSquareConfigs = await offlineDBInstance.getAll(offlineDBInstance.STORES.SQUARE_LOCATION_CONFIGS);
        const offlineSquareTx = await offlineDBInstance.getAll(offlineDBInstance.STORES.SQUARE_TRANSACTIONS);
        const offlineCatalogItems = await offlineDBInstance.getAll(offlineDBInstance.STORES.SQUARE_CATALOG_ITEMS);

        // Use offline data if available, otherwise empty arrays (load in background later)
        setSquareLocationConfigs(offlineSquareConfigs || []);
        setCatalogItems(offlineCatalogItems || []); // Load from offline DB
        setSquareTransactions(offlineSquareTx || []);

        // Square catalog items will sync via real-time events and delivery updates only

        const savedDate = globalFilters.getSelectedDate();
        let effectiveDateForDriverAssignment;
        if (!savedDate) {
          globalFilters.setSelectedDate(today);
          effectiveDateForDriverAssignment = today;
        } else {
          effectiveDateForDriverAssignment = new Date(savedDate + 'T00:00:00');
        }

        const currentDriverFilter = globalFilters.getSelectedDriverId();
        if (!currentDriverFilter) {
          globalFilters.setSelectedDriverId('all');
        }

        setInitialGlobalFiltersSet(true);

        // CRITICAL: Mark offline DB load as complete to allow smart refresh to start
        const { markOfflineDBLoadComplete } = await import('./components/utils/dataManager');
        markOfflineDBLoadComplete();

        setDataLoaded(true); // CRITICAL: Set data loaded to prevent bg sync re-triggering
        setIsLoadingLayout(false);

      } catch (error) {
        // CRITICAL: Only treat auth errors (401/403) as access issues
        // Rate limit errors (429) should not block access
        const isAuthError = error.response?.status === 401 || error.response?.status === 403 ||
        error.message?.includes('Unauthorized') || error.message?.includes('Forbidden');

        if (isAuthError) {
          setHasAccess(false);
          setIsLoadingLayout(false);
          setDataLoaded(true);
        } else {
          // Rate limit or other error - keep access, set data loaded
          console.warn('⚠️ [Layout Init] Non-auth error during init:', error.message);
          setHasAccess(true);
          setIsLoadingLayout(false);
          setDataLoaded(true);
        }
      }
    };

    init();
  }, []);

  // Initialize daily message cleanup
  useEffect(() => {
    initializeDailyCleanup();
  }, []);

  // Real-time sync broadcasts removed - relying on smart refresh only

  // Initialize offline database sync
  useEffect(() => {
    if (!currentUser) return;

    // CRITICAL: Background sync - run ONCE after init, skip if already running
    let bgSyncHasRun = false;
    const bgSyncTimer = setTimeout(async () => {
      if (!initialGlobalFiltersSet || !currentUser || !dataLoaded || isFormOverlayOpen || bgSyncHasRun) return;
      bgSyncHasRun = true;

      const selectedDateStr = globalFilters.getSelectedDate() || format(new Date(), 'yyyy-MM-dd');
      const cityStoreIds = stores.map(s => s?.id).filter(Boolean);

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

      // CRITICAL: Handle 'delete' mutations - remove from UI state AND offline DB immediately
      if (mutation.type === 'delete') {
        if (mutation.entity === 'Patient') {
          setPatients((prev) => prev.filter((p) => p?.id !== mutation.id));
          offlineDB.deleteRecord(offlineDB.STORES.PATIENTS, mutation.id).catch(() => {});
        } else if (mutation.entity === 'Delivery') {
          setDeliveries((prev) => prev.filter((d) => d?.id !== mutation.id));
          offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, mutation.id).catch(() => {});
        } else if (mutation.entity === 'Store') {
          setStores((prev) => prev.filter((s) => s?.id !== mutation.id));
          offlineDB.deleteRecord(offlineDB.STORES.STORES, mutation.id).catch(() => {});
        } else if (mutation.entity === 'City') {
          setCities((prev) => prev.filter((c) => c?.id !== mutation.id));
          offlineDB.deleteRecord(offlineDB.STORES.CITIES, mutation.id).catch(() => {});
        } else if (mutation.entity === 'AppUser') {
          setAppUsers((prev) => prev.filter((a) => a?.id !== mutation.id));
          setUsers((prev) => prev.filter((u) => u?.id !== mutation.id));
          offlineDB.deleteRecord(offlineDB.STORES.APP_USERS, mutation.id).catch(() => {});
        }
        return;
      }

      // CRITICAL: Handle 'batch_delete' mutations - remove multiple items at once from UI AND offline DB
      if (mutation.type === 'batch_delete') {
        const idsToDelete = new Set(mutation.ids || []);
        if (mutation.entity === 'Delivery') {
          setDeliveries((prev) => prev.filter((d) => !idsToDelete.has(d?.id)));
          // Remove all from offline DB
          mutation.ids.forEach(id => {
            offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, id).catch(() => {});
          });
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
      const { deliveryId, driverId, deliveryDate, triggeredBy } = event.detail || {};
      console.log(`🔄 [Layout] Delivery updated event: ${deliveryId} (${triggeredBy})`);

      if (deliveryDate && driverId) {
        // Invalidate and refresh data for this date/driver
        invalidate('Delivery');
        if (triggerFullDataLoadRef.current) {
          triggerFullDataLoadRef.current(true);
        }
      } else if (deliveryId) {
        // Single delivery update - fetch fresh data
        invalidate('Delivery');
        if (triggerFullDataLoadRef.current) {
          triggerFullDataLoadRef.current(true);
        }
      }

      // CRITICAL: Immediately dispatch driverLocationsUpdated with current appUsers
      // This ensures map markers update without waiting for next smart refresh cycle
      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
        detail: { appUsers }
      }));

      // COD data will refresh via real-time sync events only
    };
    window.addEventListener('deliveriesUpdated', handleDeliveriesUpdated);

    // CRITICAL: Listen for driver location updates and refresh ALL UI data from offline DB
    const handleDriverLocationUpdated = async (event) => {
      console.log('📍 [Layout] Driver location updated - refreshing ALL UI data from offline DB');
      
      // Load fresh data from offline DB (instant, no API calls)
      try {
        const { offlineDB } = await import('./components/utils/offlineDatabase');
        const selectedDateStr = globalFilters.getSelectedDate() || format(new Date(), 'yyyy-MM-dd');
        
        // Load deliveries for selected date from offline DB
        const freshDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
        if (freshDeliveries && freshDeliveries.length > 0) {
          setDeliveries(freshDeliveries);
        }
        
        // Load patients from offline DB
        const freshPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
        if (freshPatients && freshPatients.length > 0) {
          setPatients(freshPatients);
        }
        
        // Load AppUsers from offline DB
        const freshAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
        if (freshAppUsers && freshAppUsers.length > 0) {
          setAppUsers(freshAppUsers);
          
          // Update merged users
          setUsers(prev => {
            const mergedMap = new Map();
            prev.forEach(u => mergedMap.set(u.id, u));
            freshAppUsers.forEach(au => {
              const existing = mergedMap.get(au.user_id);
              if (existing) {
                mergedMap.set(au.user_id, { ...existing, ...au });
              } else {
                const pseudoUser = createMergedUser(null, au);
                if (pseudoUser) mergedMap.set(pseudoUser.id, pseudoUser);
              }
            });
            return Array.from(mergedMap.values());
          });
        }
        
        // Refresh stats
        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
        
        console.log('✅ [Layout] UI data refreshed from offline DB');
      } catch (error) {
        console.error('❌ [Layout] Failed to refresh from offline DB:', error);
      }
    };
    window.addEventListener('driverLocationsUpdated', handleDriverLocationUpdated);

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

    // ========================================
    // REAL-TIME SYNC - WebSocket for instant updates (DISABLED in preview)
    // ========================================
    // CRITICAL: Skip WebSocket in preview/sandbox environments
    const isPreview = window.location.hostname.includes('preview') || window.location.hostname.includes('sandbox');
    if (!isPreview) {
      realtimeSync.connect();
    }

    const unsubscribeRealtime = subscribeToRealtime((update) => {
      if (update.type === 'connected') {
        console.log('✅ [Layout] Real-time sync connected');
        return;
      }

      if (update.type === 'disconnected') {
        console.log('🔌 [Layout] Real-time sync disconnected');
        return;
      }

      if (update.type !== 'entity_change') return;

      console.log(`📥 [Layout] Real-time update: ${update.entity} ${update.action}`, update.id || update.ids);

      // Handle Delivery updates
      if (update.entity === 'Delivery') {
        if (update.action === 'create') {
          setDeliveries((prev) => {
            if (prev.some((d) => d?.id === update.id)) return prev;
            return [...prev, update.data];
          });
          // Refresh catalog items if delivery has COD
          if (update.data?.cod_total_amount_required) {
            setTimeout(() => {
              base44.functions.invoke('squareSyncCatalogItems', {}).
              then((response) => {
                const items = response?.data?.items || response?.items || [];
                setCatalogItems(items);
              });
            }, 500);
          }
        } else if (update.action === 'update') {
          setDeliveries((prev) => prev.map((d) =>
          d?.id === update.id ? { ...d, ...update.data } : d
          ));
          console.log(`📥 [Layout] Real-time delivery update: ${update.id}, status: ${update.data?.status}`);
          // CRITICAL: Force polyline update when delivery status changes
          if (update.data?.driver_id && update.data?.delivery_date) {
            updatePolylineOnRefresh(update.data.driver_id, update.data.delivery_date);
          }
          console.log(`📥 [Layout] Real-time delivery update: ${update.id}, status: ${update.data?.status}`);
          // CRITICAL: Force polyline update when delivery status changes
          if (update.data?.driver_id && update.data?.delivery_date) {
            updatePolylineOnRefresh(update.data.driver_id, update.data.delivery_date);
          }
          // Refresh catalog items if COD amount changed
          if (update.data?.cod_total_amount_required) {
            setTimeout(() => {
              base44.functions.invoke('squareSyncCatalogItems', {}).
              then((response) => {
                const items = response?.data?.items || response?.items || [];
                setCatalogItems(items);
              });
            }, 500);
          }
        } else if (update.action === 'delete') {
          setDeliveries((prev) => prev.filter((d) => d?.id !== update.id));
          // CRITICAL: Remove from offline DB to prevent residual memory on other devices
          offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, update.id).catch(() => {});
          // Refresh catalog items after deletion
          setTimeout(() => {
            base44.functions.invoke('squareSyncCatalogItems', {}).
            then((response) => {
              const items = response?.data?.items || response?.items || [];
              setCatalogItems(items);
            });
          }, 500);
        } else if (update.action === 'batch_delete' && update.ids) {
          const idsToDelete = new Set(update.ids);
          setDeliveries((prev) => prev.filter((d) => !idsToDelete.has(d?.id)));
          // CRITICAL: Remove ALL deleted IDs from offline DB
          update.ids.forEach(id => {
            offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, id).catch(() => {});
          });
          // Refresh catalog items after batch deletion
          setTimeout(() => {
            base44.functions.invoke('squareSyncCatalogItems', {}).
            then((response) => {
              const items = response?.data?.items || response?.items || [];
              setCatalogItems(items);
            });
          }, 500);
        }
      }

      // Handle AppUser updates (driver location, status, tracking)
      if (update.entity === 'AppUser') {
        if (update.action === 'update') {
          setAppUsers((prev) => prev.map((au) =>
          au?.id === update.id ? { ...au, ...update.data } : au
          ));

          // Also update users array for merged user data
          setUsers((prev) => prev.map((u) =>
          u?.id === update.data?.user_id ? { ...u, ...update.data } : u
          ));

          // CRITICAL: Dispatch event to update map markers AND polylines immediately
          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
            detail: { appUsers: null, singleUpdate: update.data }
          }));

          // CRITICAL: If location changed, also refresh delivery markers (for polyline origins)
          if (update.data?.current_latitude || update.data?.current_longitude) {
            console.log(`📍 [Layout] Driver ${update.data.user_id} location updated - forcing map refresh`);
            window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
              detail: { 
                triggeredBy: 'driver_location_update',
                driverId: update.data.user_id 
              }
            }));
          }
        }
      }

      // Handle SquareTransaction updates - refresh COD data
      if (update.entity === 'SquareTransaction') {
        console.log('🔔 [Layout] SquareTransaction realtime update - syncing COD data');
        setTimeout(() => {
          base44.functions.invoke('squareSyncCatalogItems', {}).then((response) => {
            const items = response?.data?.items || response?.items || [];
            setCatalogItems(items);
          }).catch(() => {});
        }, 500);
      }

      // Handle Patient updates
      if (update.entity === 'Patient') {
        if (update.action === 'create') {
          setPatients((prev) => {
            if (prev.some((p) => p?.id === update.id)) return prev;
            return [...prev, update.data];
          });
          // Save to offline DB immediately
          offlineDB.save(offlineDB.STORES.PATIENTS, update.data).catch(() => {});
        } else if (update.action === 'update') {
          setPatients((prev) => prev.map((p) =>
            p?.id === update.id ? { ...p, ...update.data } : p
          ));
          // Update offline DB immediately
          offlineDB.save(offlineDB.STORES.PATIENTS, update.data).catch(() => {});
        } else if (update.action === 'delete') {
          setPatients((prev) => prev.filter((p) => p?.id !== update.id));
          // Remove from offline DB immediately
          offlineDB.deleteRecord(offlineDB.STORES.PATIENTS, update.id).catch(() => {});
        }
      }
    });

    return () => {
      clearTimeout(bgSyncTimer);
      clearInterval(mutationSyncInterval);
      unsubscribeMutations();
      unsubscribeRealtime();
      realtimeSync.disconnect();
      window.removeEventListener('offlineSyncComplete', handleSyncComplete);
      window.removeEventListener('userRolesChanged', handleUserRolesChanged);
      window.removeEventListener('deliveriesImported', handleDeliveriesImported);
      window.removeEventListener('offlineDeliveriesDeleted', handleOfflineDeliveriesDeleted);
      window.removeEventListener('deliveriesUpdated', handleDeliveriesUpdated);
      window.removeEventListener('driverLocationsUpdated', handleDriverLocationUpdated);
      window.removeEventListener('dataConflictsDetected', handleConflict);
      window.removeEventListener('forceDataRefresh', handleForceDataRefresh);
    };
  }, [currentUser]);

  // Recalculate COD total whenever catalog items or user changes
  useEffect(() => {
    if (!currentUser || catalogItems.length === 0) {
      setTotalCodsDue(0);
      return;
    }

    const codTotal = calculateUserCodTotal(currentUser, catalogItems, squareLocationConfigs, stores, squareTransactions);
    setTotalCodsDue(codTotal);
  }, [currentUser, catalogItems, squareLocationConfigs, stores, squareTransactions]);

  // Subscribe to real-time SquareTransaction updates to refresh catalog
  useEffect(() => {
    const unsubscribe = subscribeToRealtime((update) => {
      if (update.entity === 'SquareTransaction') {
        console.log('🔔 [Layout] SquareTransaction update detected, syncing catalog...');
        // Refresh catalog items and transactions when transactions change
        Promise.all([
        base44.functions.invoke('squareSyncCatalogItems', {}),
        base44.entities.SquareTransaction.filter({ type: 'collection' })]
        ).then(([catalogData, transactions]) => {
          const items = catalogData?.data?.items || catalogData?.items || [];
          setCatalogItems(items);
          setSquareTransactions(transactions || []);
          toast.success('COD data updated');
        });
      }
    });

    return unsubscribe;
  }, []);

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
      // CRITICAL: Force new array reference to trigger React re-render
      setDeliveries([...newDeliveries.filter(Boolean)]);
    } else {
      setDeliveries((prevDeliveries) => {
        const updatesMap = new Map(newDeliveries.map((u) => [u.id, u]));
        // CRITICAL: Create new array with spread to ensure React detects change
        return prevDeliveries.map((delivery) => {
          if (!delivery) return delivery;
          const update = updatesMap.get(delivery.id);
          if (update) return { ...delivery, ...update };
          return delivery;
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

      if (currentUser && !currentUser._isImpersonating && !isReloadingFromAppUserChange.current) {
        const updatedAppUserForCurrentUser = updates.appUsers.find((au) => au && au.user_id === currentUser.id);

        if (updatedAppUserForCurrentUser) {
          const oldStoreIds = JSON.stringify(currentUser.store_ids || []);
          const newStoreIds = JSON.stringify(updatedAppUserForCurrentUser.store_ids || []);

          const oldStatus = currentUser.status;
          const newStatus = updatedAppUserForCurrentUser.status;

          if (newStoreIds !== oldStoreIds || newStatus !== oldStatus) {
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

  // Wake Lock API and visibility change handler
  useEffect(() => {
    // Wake Lock API - keep screen on when app is focused
    const requestWakeLock = async () => {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        try {
          wakeLockRef.current = await navigator.wakeLock.request('screen');
          wakeLockRef.current.addEventListener('release', () => {});
        } catch (err) {}
      }
    };

    const releaseWakeLock = () => {
      if (wakeLockRef.current) {
        wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
    };

    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        await requestWakeLock();
        if (initialGlobalFiltersSet && currentUser && dataLoaded && !isFormOverlayOpen) {
          // Force immediate refresh when app becomes visible
          smartRefreshManager.lastRefreshTimes = {
            driverLocation: 0,
            activeDeliveries: 0,
            todayDeliveries: 0,
            appUsers: 0,
            patients: 0,
            stores: 0
          };
        }
      } else {
        releaseWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    if (document.visibilityState === 'visible') {
      requestWakeLock();
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      releaseWakeLock();
    };
  }, [initialGlobalFiltersSet, currentUser, dataLoaded, isFormOverlayOpen]);

  // Trigger smart refresh when navigating to Dashboard
  useEffect(() => {
    if (!initialGlobalFiltersSet || !currentUser || !dataLoaded) return;
    if (currentPageName !== 'Dashboard') return;

    // Force immediate refresh when navigating to Dashboard
    smartRefreshManager.lastRefreshTimes = {
      driverLocation: 0,
      activeDeliveries: 0,
      todayDeliveries: 0,
      appUsers: 0,
      patients: 0,
      stores: 0
    };
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



  const updatePolylineOnRefresh = async (driverId, dateStr) => {
    if (!driverId || driverId === 'all') return;

    try {
      const deliveryDate = dateStr || format(new Date(), 'yyyy-MM-dd');

      // Get driver's current location
      const appUsers = await base44.entities.AppUser.filter({ user_id: driverId });
      const driverAppUser = appUsers?.[0];

      if (!driverAppUser?.current_latitude || !driverAppUser?.current_longitude) return;

      await base44.functions.invoke('optimizeDriverRoute', {
        driverId: driverId,
        deliveryDate: deliveryDate,
        generatePolyline: true,
        currentLocation: {
          latitude: driverAppUser.current_latitude,
          longitude: driverAppUser.current_longitude
        }
      });
    } catch (error) {

      // Silent fail
    }};

  const handleImpersonate = useCallback(async (userId) => {
    sessionStorage.setItem('impersonationId', userId);
    window.location.reload();
  }, []);

  const handleStopImpersonating = useCallback(() => {
    sessionStorage.removeItem('impersonationId');
    window.location.reload();
  }, []);

  const realUser = currentUser && !currentUser._isImpersonating ? currentUser : null;
  const impersonatingUser = currentUser && currentUser._isImpersonating ? currentUser : null;

  const handleCitySelected = useCallback(async (cityId) => {
    try {
      globalFilters.setSelectedCityId(cityId);
      const today = new Date();
      globalFilters.setSelectedDate(today);

      const refreshedUser = await getEffectiveUser();
      if (refreshedUser) {
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

    triggerFullDataLoad.isRunning = true;

    try {
      const selectedCityId = globalFilters.getSelectedCityId();
      const selectedDateStr = globalFilters.getSelectedDate();
      const selectedDriverId = globalFilters.getSelectedDriverId();

      if (!currentUser || !selectedCityId || selectedCityId === 'waiting-for-selection') {
        setDataLoaded(false);
        return;
      }

      const selectedDate = selectedDateStr ? new Date(selectedDateStr + 'T00:00:00') : new Date();
      const selectedYear = selectedDate.getFullYear();

      let workingCities = cities;
      const isAdmin = userHasRole(currentUser, 'admin');

      // CRITICAL: Stagger initial data loads to prevent rate limiting
      // Load Cities first (usually cached), then others with delays
      const citiesData = workingCities?.length > 0 ? workingCities : await City.list();

      // Small delay before next batch
      await new Promise((resolve) => setTimeout(resolve, 500));

      const allStores = await getData('Store', null, null, forceRefresh);

      // Another delay before AppUsers
      await new Promise((resolve) => setTimeout(resolve, 500));

      const allAppUsers = await getData('AppUser', null, null, forceRefresh);

      if (citiesData && (!workingCities || workingCities.length === 0)) {
        citiesData.sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
        setCities(citiesData);
        workingCities = citiesData;
      }

      allStores.sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));

      // CRITICAL: ALWAYS load ALL drivers' deliveries for selected date (no driver filtering)
      // Dashboard will filter locally based on driver selection
      let cityStoreFilter = {};
      const cityStoreIds = allStores.map((s) => s?.id).filter(Boolean);
      if (cityStoreIds.length > 0) {
        cityStoreFilter.store_id = { $in: cityStoreIds };
      }

      // CRITICAL: Load ALL drivers' deliveries - no driver filter at all
      const priorityFilter = { delivery_date: selectedDateStr, ...cityStoreFilter };

      // CRITICAL: Load Square data from offline DB first to prevent rate limits
      // API sync will happen in background later
      const { offlineDB } = await import('./components/utils/offlineDatabase');
      const offlineSquareConfigs = await offlineDB.getAll(offlineDB.STORES.SQUARE_LOCATION_CONFIGS);
      const offlineSquareTx = await offlineDB.getAll(offlineDB.STORES.SQUARE_TRANSACTIONS);
      const offlineCatalogItems = await offlineDB.getAll(offlineDB.STORES.SQUARE_CATALOG_ITEMS);

      setSquareLocationConfigs(offlineSquareConfigs || []);
      setCatalogItems(offlineCatalogItems || []); // Load from offline DB first
      setSquareTransactions(offlineSquareTx || []);

      // Load deliveries with instant UI callback - NO driver filter to get ALL drivers
      await loadDeliveries(
        selectedDateStr,
        { delivery_date: selectedDateStr, ...cityStoreFilter }, // Priority: today's deliveries for ALL drivers
        { delivery_date: selectedDateStr, ...cityStoreFilter }, // Background: same (no separate background load)
        forceRefresh,
        // Instant UI callback
        (initialDeliveries) => {
          setDeliveries(initialDeliveries);
          setDataLoaded(true);

          setTimeout(async () => {
            const patientsData = await getData('Patient', null, null, forceRefresh);
            setPatients(patientsData);
          }, 100);
        },
        // Background callback
        (fullMonthDeliveries) => {
          setDeliveries((prevDeliveries) => {
            const map = new Map();
            fullMonthDeliveries.forEach((d) => map.set(d.id, d));
            prevDeliveries.forEach((d) => map.set(d.id, d));
            return Array.from(map.values());
          });
        }
      );

      // Load Users in background (admin only)
      let authUsersData = [];
      if (userHasRole(currentUser, 'admin')) {
        setTimeout(async () => {
          authUsersData = await getData('User', null, null, forceRefresh);

          const mergedUsersMap = new Map();
          if (currentUser) mergedUsersMap.set(currentUser.id, currentUser);

          authUsersData.forEach((authUser) => {
            if (!authUser) return;
            const appUser = allAppUsers.find((au) => au && au.user_id === authUser.id);
            const merged = createMergedUser(authUser, appUser);
            if (merged) mergedUsersMap.set(merged.id, merged);
          });

          const mergedUsers = Array.from(mergedUsersMap.values()).filter(Boolean);
          // CRITICAL: Deduplicate by id to prevent duplicates in View As User
          const dedupedUsers = Array.from(new Map(mergedUsers.map(u => [u.id, u])).values());
          setUsers(dedupedUsers);

          let activeDrivers = dedupedUsers.filter((user) => {
            if (!user || !user.app_roles || !Array.isArray(user.app_roles)) return false;
            if (!user.app_roles.includes('driver') && !user.app_roles.includes('admin')) return false;
            if (!user.user_name) return false;
            if (user.status !== 'active') return false;
            return true;
          });
          activeDrivers = sortUsers(activeDrivers);
          setDrivers(activeDrivers);

          // CRITICAL: Dispatch event to force QuickStats to refresh
          window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
        }, 500);
      }
      const mergedUsersMap = new Map();

      if (currentUser) {
        mergedUsersMap.set(currentUser.id, currentUser);
      }

      // For non-admins: create users from AppUser data only (faster)
      allAppUsers.forEach((appUser) => {
        if (!appUser || mergedUsersMap.has(appUser.user_id)) return;
        const pseudoUser = createMergedUser(null, appUser);
        if (pseudoUser) {
          mergedUsersMap.set(pseudoUser.id, pseudoUser);
        }
      });

      const initialUsers = Array.from(mergedUsersMap.values()).filter(Boolean);

      let activeDrivers = initialUsers.filter((user) => {
        if (!user || !user.app_roles || !Array.isArray(user.app_roles)) return false;
        if (!user.app_roles.includes('driver') && !user.app_roles.includes('admin')) return false;
        if (!user.user_name) return false;
        if (user.status !== 'active') return false;
        return true;
      });
      activeDrivers = sortUsers(activeDrivers);

      setUsers(initialUsers);
      setDrivers(activeDrivers);
      setStores(allStores);
      setAppUsers(allAppUsers);

      // CRITICAL: Force refresh driver locations on initial load IMMEDIATELY
      // This ensures driver location markers show immediately
      const locationUpdates = await smartRefreshManager.refreshDriverLocations(allAppUsers, true);
      if (locationUpdates?.hasChanges) {
        setAppUsers(locationUpdates.appUsers);
      }

      // Calculate initial COD total from offline catalog items
      const codTotal = calculateUserCodTotal(currentUser, catalogItems || [], squareLocationConfigs || [], allStores, squareTransactions || []);
      setTotalCodsDue(codTotal);

      // Refresh COD data from server to ensure it's up-to-date (background)
      setTimeout(() => {
        base44.functions.invoke('squareSyncCatalogItems', {}).then((response) => {
          const items = response?.data?.items || response?.items || [];
          setCatalogItems(items);
        }).catch(() => {});
      }, 1000);

    } catch (error) {
      setUsers([]);
      setDrivers([]);
      setStores([]);
      setPatients([]);
      setDeliveries([]);
      setAppUsers([]);
      setDataLoaded(true); // Ensure it's set even on error
    } finally {
      triggerFullDataLoad.isRunning = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser, isFormOverlayOpen]);

  triggerFullDataLoadRef.current = triggerFullDataLoad;

  useEffect(() => {
    if (!initialGlobalFiltersSet || !currentUser) return;
    const isReady = globalFilters.isReadyForDataFetch();
    if (!isReady) return;

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

    if (userHasRole(currentUser, 'dispatcher')) {
      const dispatcherStoreIds = currentUser.store_ids || [];
      if (selectedStoreId && selectedStoreId !== 'all' && !dispatcherStoreIds.includes(selectedStoreId)) {
        return [];
      }

      const relevantStoreIds = selectedStoreId && selectedStoreId !== 'all' ? [selectedStoreId] : dispatcherStoreIds;

      const dispatcherPatientIds = new Set(
        patients.filter((p) => p && relevantStoreIds.includes(p.store_id)).map((p) => p.id)
      );
      data = data.filter((delivery) => {
        if (!delivery) return false;
        if (delivery.patient_id) {
          return dispatcherPatientIds.has(delivery.patient_id);
        }
        return delivery.store_id && relevantStoreIds.includes(delivery.store_id);
      });
    } else if (userHasRole(currentUser, 'driver')) {
      data = data.filter((delivery) => delivery && delivery.driver_id === currentUser.id);
      if (selectedStoreId && selectedStoreId !== 'all' && currentUser.store_id !== selectedStoreId) {
        return [];
      }
    }

    return data;
  }, [deliveries, currentUser, patients, selectedStoreId]);

  const filteredPatients = useMemo(() => {
    if (!patients.length || !currentUser) return [];
    let data = patients.filter((patient) => patient);

    if (selectedStoreId && selectedStoreId !== 'all') {
      data = data.filter((p) => p && p.store_id === selectedStoreId);
    }

    if (userHasRole(currentUser, 'dispatcher')) {
      const dispatcherStoreIds = currentUser.store_ids || [];
      if (selectedStoreId && selectedStoreId !== 'all' && !dispatcherStoreIds.includes(selectedStoreId)) {
        return [];
      }
      const relevantStoreIds = selectedStoreId && selectedStoreId !== 'all' ? [selectedStoreId] : dispatcherStoreIds;
      data = data.filter((p) => p && relevantStoreIds.includes(p.store_id));
    }
    return data;
  }, [patients, currentUser, selectedStoreId]);

  // Route count - count driver-routes (each driver-date combination) in the selected month
  const totalRoutesCount = useMemo(() => {
    if (!deliveries || deliveries.length === 0 || !currentUser) return 0;

    const selectedDateStr = globalFilters.getSelectedDate();
    if (!selectedDateStr) return 0;

    const selectedDate = new Date(selectedDateStr + 'T00:00:00');
    const selectedYear = selectedDate.getFullYear();
    const selectedMonth = selectedDate.getMonth();

    // CRITICAL: Filter deliveries based on user role
    let relevantDeliveries = deliveries;

    if (userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
      // DISPATCHERS: Count driver-routes where driver has ANY stops in dispatcher's stores
      const dispatcherStoreIds = new Set(currentUser.store_ids || []);

      // Get all drivers who have ANY delivery in dispatcher's stores
      const driversInStores = new Set(
        deliveries.filter((d) => d && dispatcherStoreIds.has(d.store_id)).map((d) => d.driver_id).filter(Boolean)
      );

      // Filter to deliveries from those drivers only
      relevantDeliveries = relevantDeliveries.filter((d) => d && driversInStores.has(d.driver_id));
    } else if (userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin')) {
      // Drivers: only count their own routes
      relevantDeliveries = relevantDeliveries.filter((d) => d && d.driver_id === currentUser.id);
    }

    // For each date in the selected month, count unique drivers
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

    // CRITICAL: For dispatchers, only count patients from their assigned stores
    let relevantPatients = patients;
    const isDispatcher = currentUser ? userHasRole(currentUser, 'dispatcher') : false;
    if (isDispatcher && currentUser?.store_ids) {
      const dispatcherStoreIds = new Set(currentUser.store_ids);
      relevantPatients = patients.filter((p) => p && dispatcherStoreIds.has(p.store_id));
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

  // Route counts - fetched from server-side stats function
  const [routeCounts, setRouteCounts] = useState({ monthly: '...', yearly: '...' });
  const [entityCounts, setEntityCounts] = useState({ patients: '...', cities: '...', stores: '...', users: '...' });

  useEffect(() => {
    if (!currentUser || !dataLoaded) return;

    const fetchStats = async () => {
      try {
        let filteredStoreIds = [];

        if (userHasRole(currentUser, 'admin')) {
          filteredStoreIds = stores.map((s) => s?.id).filter(Boolean);
        } else if (userHasRole(currentUser, 'dispatcher')) {
          filteredStoreIds = (currentUser.store_ids || []).filter(Boolean);
        } else if (userHasRole(currentUser, 'driver')) {
          const driverStoreIds = new Set(
            deliveries.
            filter((d) => d && d.driver_id === currentUser.id).
            map((d) => d.store_id).
            filter(Boolean)
          );
          filteredStoreIds = Array.from(driverStoreIds);
        }

        const response = await base44.functions.invoke('getDeliveryStats', {
          selectedDate: globalFilters.getSelectedDate() || format(new Date(), 'yyyy-MM-dd'),
          driverId: userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin') ? currentUser.id : null,
          storeIds: filteredStoreIds.length > 0 ? filteredStoreIds : null
        });

        const data = response?.data || response;

        if (data?.deliveries && data?.drivers) {
          setRouteCounts({
            monthly: data.deliveries.monthly,
            yearly: data.deliveries.yearly
          });
        }
        if (data?.entityCounts) {
          setEntityCounts(data.entityCounts);
        }
      } catch (error) {}
    };

    // Delay stats fetch to 5 seconds after data loaded
    const timer = setTimeout(fetchStats, 5000);
    // Poll every 5 minutes
    const interval = setInterval(fetchStats, 300000);

    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [currentUser, dataLoaded]);

  const statsCardPositioning = useMemo(() => {
    const ratio = screenWidth / cardWidth;

    if (ratio < 2) {
      return 'absolute top-2 left-1/2 -translate-x-1/2 z-[20]';
    } else {
      return 'absolute top-2 right-2 z-[20]';
    }
  }, [screenWidth, cardWidth]);

  const todayInProgressTotal = filteredDeliveries.filter((delivery) => delivery && delivery.delivery_date === format(new Date(), 'yyyy-MM-dd') && delivery.status === 'in_transit').length;

  const adminNavigationItems = useMemo(() => {
    const items = [
    {
      title: 'Cities',
      pageName: 'Cities',
      count: entityCounts.cities,
      url: createPageUrl("Cities"),
      icon: Building2
    },
    {
      title: 'Stores',
      pageName: 'Stores',
      count: entityCounts.stores,
      url: createPageUrl("Stores"),
      icon: Building
    },
    {
      title: 'Drivers',
      pageName: 'DriverSettings',
      count: drivers.length,
      url: createPageUrl("DriverSettings"),
      icon: Truck
    },
    {
      title: 'Users',
      pageName: 'AppUsers',
      count: entityCounts.users,
      url: createPageUrl("AppUsers"),
      icon: Users2
    }];

    if (realUser && (isAppOwner(realUser) || userHasRole(realUser, 'admin'))) {
      items.push({
        title: "Admin Metrics",
        pageName: 'AdminMetrics',
        url: createPageUrl("AdminMetrics"),
        icon: BarChart3
      });
      items.push({
        title: "Store Invoices",
        pageName: 'StoreInvoices',
        url: createPageUrl("StoreInvoices"),
        icon: FileText
      });
    }

    if (realUser && canAccessImports(realUser, adminImportEnabled)) {
      items.push({
        title: "Admin Utilities",
        pageName: 'AdminUtilities',
        url: createPageUrl("AdminUtilities"),
        icon: BarChart3
      });
    }

    // Square Locations - App Owner only
    if (realUser && isAppOwner(realUser)) {
      items.push({
        title: "Square Locations",
        pageName: 'SquareLocationConfigs',
        url: createPageUrl("SquareLocationConfigs"),
        icon: CreditCard
      });
    }
    return items;
  }, [entityCounts.cities, entityCounts.stores, entityCounts.users, realUser, adminImportEnabled, drivers.length]);

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


  const showWatermark = realUser && isAppOwner(realUser);

  return (
    <ErrorBoundary>
      <style>{`
          /* CRITICAL: Set color-scheme in <html> element BEFORE page loads to prevent flash */
          html {
            color-scheme: ${themePreference === 'dark' ? 'dark' : themePreference === 'light' ? 'light' : 'light dark'};
          }

          :root {
            /* Light mode (default) - whites, blacks, and grays */
            --bg-white: #ffffff;
            --bg-slate-50: #f8fafc;
            --bg-slate-100: #f1f5f9;
            --bg-slate-200: #e2e8f0;
            --text-slate-900: #0f172a;
            --text-slate-800: #1e293b;
            --text-slate-700: #334155;
            --text-slate-600: #475569;
            --text-slate-500: #64748b;
            --text-slate-400: #94a3b8;
            --border-slate-200: #e2e8f0;
            --border-slate-300: #cbd5e1;
            --shadow-color: rgba(0, 0, 0, 0.1);
            --image-filter: none;
            --menu-border: #000000;
          }

          /* Dark mode via class (explicit user selection) */
          html.dark-theme,
          html.dark-theme body {
            /* Inverted whites, blacks, and grays */
            --bg-white: #0f172a;
            --bg-slate-50: #1e293b;
            --bg-slate-100: #334155;
            --bg-slate-200: #475569;
            --text-slate-900: #f8fafc;
            --text-slate-800: #f1f5f9;
            --text-slate-700: #e2e8f0;
            --text-slate-600: #cbd5e1;
            --text-slate-500: #94a3b8;
            --text-slate-400: #64748b;
            --border-slate-200: #cbd5e1;
            --border-slate-300: #94a3b8;
            --shadow-color: rgba(255, 255, 255, 0.1);
            --image-filter: invert(1) hue-rotate(180deg);
            --menu-border: #e2e8f0;
          }

          /* Auto mode - respect system preference */
          @media (prefers-color-scheme: dark) {
            html.auto-theme,
            html.auto-theme body {
              --bg-white: #0f172a;
              --bg-slate-50: #1e293b;
              --bg-slate-100: #334155;
              --bg-slate-200: #475569;
              --text-slate-900: #f8fafc;
              --text-slate-800: #f1f5f9;
              --text-slate-700: #e2e8f0;
              --text-slate-600: #cbd5e1;
              --text-slate-500: #94a3b8;
              --text-slate-400: #64748b;
              --border-slate-200: #cbd5e1;
              --border-slate-300: #94a3b8;
              --shadow-color: rgba(255, 255, 255, 0.1);
              --image-filter: invert(1) hue-rotate(180deg);
              --menu-border: #e2e8f0;
            }
          }

          html, body {
            font-size: 15px;
            margin: 0;
            padding: 0;
            height: 100vh;
            height: 100dvh;
            width: 100vw;
            overflow: hidden;
            overscroll-behavior: none;
            background: var(--bg-white);
            color: var(--text-slate-900);
          }

        #root {
          height: 100vh;
          height: 100dvh;
          width: 100vw;
          overflow: hidden;
        }

        :root {
          --sidebar-width: ${sidebarWidth}px;
          --safe-area-inset-top: env(safe-area-inset-top, 0px);
          --safe-area-inset-right: env(safe-area-inset-right, 0px);
          --safe-area-inset-bottom: env(safe-area-inset-bottom, 0px);
          --safe-area-inset-left: env(safe-area-inset-left, 0px);
          color-scheme: ${themePreference === 'auto' ? 'light dark' : themePreference};
        }

        ${themePreference === 'dark' ? `
          body {
            background-color: #0f172a;
            color: #f1f5f9;
          }
        ` : ''}

        .app-container {
          display: flex;
          flex-direction: row;
          height: 100vh;
          height: 100dvh;
          width: 100vw;
          overflow: hidden;
          background: var(--bg-slate-50);
        }

        main {
          overscroll-behavior-y: contain !important;
          -webkit-overflow-scrolling: touch !important;
          max-height: 100%;
        }

        .leaflet-container {
          z-index: 1 !important;
          height: 100% !important;
          width: 100% !important;
          background: var(--bg-slate-50) !important;
        }

        /* Prevent white flash during map tile loading */
        .leaflet-tile-pane {
          background: var(--bg-slate-50) !important;
        }

        .leaflet-map-pane {
          background: var(--bg-slate-50) !important;
        }

        .pb-safe {
          padding-bottom: max(1rem, env(safe-area-inset-bottom, 0px));
        }

        .mb-safe {
          margin-bottom: env(safe-area-inset-bottom, 0px);
        }

        @supports (-webkit-touch-callout: none) {
          body {
            height: -webkit-fill-available;
            overflow: hidden;
          }

          #root {
            height: -webkit-fill-available;
            overflow: hidden;
          }
        }

        /* Mobile layout - portrait mode (narrow screen) */
        @media (max-width: 767px) {
          .app-container.mobile-device .mobile-header {
            display: flex !important;
            position: sticky;
            top: 0;
            z-index: 10001 !important;
            background: var(--bg-white);
            border-bottom: 1px solid var(--border-slate-200);
          }

          .app-container.mobile-device main {
            overflow-y: auto !important;
            overflow-x: hidden !important;
            flex: 1;
          }

          .app-container.mobile-device .app-sidebar {
            position: fixed !important;
            left: 0 !important;
            top: 0 !important;
            bottom: 0 !important;
            width: 280px !important;
            max-width: 80vw !important;
            z-index: 50000 !important;
            transform: translateX(-100%) !important;
            transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
            background: var(--bg-white) !important;
            box-shadow: 4px 0 12px var(--shadow-color) !important;
            flex-shrink: 0 !important;
          }

          .app-container.mobile-device .app-sidebar.sidebar-open {
            transform: translateX(0) !important;
            box-shadow: 4px 0 12px var(--shadow-color) !important;
          }

          .app-container.mobile-device .main-content-area {
            width: 100vw !important;
            flex: 1 !important;
            display: flex !important;
            flex-direction: column !important;
            overflow: hidden !important;
            max-height: 100vh !important;
            max-height: 100dvh !important;
          }
        }

        /* Mobile layout - landscape mode (wide screen) - use desktop layout */
        @media (min-width: 768px) {
          .app-container.mobile-device .mobile-header {
            display: none !important;
          }

          .app-container.mobile-device .app-sidebar {
            position: relative !important;
            transform: none !important;
            box-shadow: none !important;
            width: var(--sidebar-width) !important;
            min-width: 200px !important;
            max-width: 400px !important;
            flex: 0 0 var(--sidebar-width) !important;
            transition: none !important;
          }

          .app-container.mobile-device .main-content-area {
            flex: 1 1 auto !important;
            width: calc(100vw - var(--sidebar-width) - 1px) !important;
            min-width: 400px !important;
            display: flex !important;
            flex-direction: column !important;
            overflow: hidden !important;
            max-height: 100vh !important;
            max-height: 100dvh !important;
          }
        }

        /* Desktop layout - controlled by device type */
        .app-container.desktop-device .mobile-header {
          display: none !important;
        }

        .app-container.desktop-device .app-sidebar {
          position: relative !important;
          transform: none !important;
          box-shadow: none !important;
          width: var(--sidebar-width) !important;
          min-width: 200px !important;
          max-width: 400px !important;
          flex: 0 0 var(--sidebar-width) !important;
          transition: none !important;
        }

        .app-container.desktop-device .main-content-area {
          flex: 1 1 auto !important;
          width: calc(100vw - var(--sidebar-width) - 1px) !important;
          min-width: 400px !important;
          display: flex !important;
          flex-direction: column !important;
          overflow: hidden !important;
          max-height: 100vh !important;
          max-height: 100dvh !important;
        }

        /* Narrow screens override - show mobile view even on desktop devices */
        @media (max-width: 767px) {
          .app-container.desktop-device .mobile-header {
            display: flex !important;
            position: sticky;
            top: 0;
            z-index: 10001 !important;
            background: var(--bg-white);
            border-bottom: 1px solid var(--border-slate-200);
          }

          .app-container.desktop-device main {
            overflow-y: auto !important;
            overflow-x: hidden !important;
            flex: 1;
          }

          .app-container.desktop-device .app-sidebar {
            position: fixed !important;
            left: 0 !important;
            top: 0 !important;
            bottom: 0 !important;
            width: 280px !important;
            max-width: 80vw !important;
            z-index: 50000 !important;
            transform: translateX(-100%) !important;
            transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
            background: var(--bg-white) !important;
            box-shadow: 4px 0 12px var(--shadow-color) !important;
            flex-shrink: 0 !important;
          }

          .app-container.desktop-device .app-sidebar.sidebar-open {
            transform: translateX(0) !important;
            box-shadow: 4px 0 12px var(--shadow-color) !important;
          }

          .app-container.desktop-device .main-content-area {
            width: 100vw !important;
            flex: 1 !important;
            display: flex !important;
            flex-direction: column !important;
            overflow: hidden !important;
            max-height: 100vh !important;
            max-height: 100dvh !important;
          }
        }

        .sidebar-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.5);
          z-index: 49999;
          animation: fadeIn 0.2s ease-out;
        }

        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .custom-scrollbar::-webkit-scrollbar {
          height: 8px;
          width: 8px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(0,0,0,0.2);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(0,0,0,0.3);
        }
        .custom-scrollbar {
          scrollbar-width: thin;
          scrollbar-color: rgba(0,0,0,0.2) transparent;
        }

        :root {
          --primary: 15 23 42;
          --primary-foreground: 248 250 252;
          --secondary: 5 150 105;
          --secondary-foreground: 255 255 255;
          --accent: 239 246 255;
          --accent-foreground: 15 23 42;
          --muted: 248 250 252;
          --muted-foreground: 100 116 139;
          --border: 0 0 0;
          --input: 0 0 0;
          --ring: 5 150 105;
        }

        .border-yellow-400,
        .border-yellow-500,
        .border-yellow-600,
        input:focus,
        select:focus,
        textarea:focus,
        [data-state="open"] {
          border-color: black !important;
        }

        input:focus-visible,
        select:focus-visible,
        textarea:focus-visible,
        button:focus-visible {
          outline: 2px solid black !important;
          outline-offset: 2px;
        }

        ::placeholder,
        input::placeholder,
        textarea::placeholder {
          color: #64748b !important;
          opacity: 1 !important;
        }

        .text-slate-400,
        .text-slate-300,
        .text-gray-400,
        .text-gray-300 {
          color: #64748b !important;
        }

        .text-slate-500 {
          color: #475569 !important;
        }

        .bg-yellow-100 {
          background-color: #fef3c7 !important;
        }

        .text-yellow-800 {
          color: #92400e !important;
        }

        .bg-yellow-400,
        .bg-yellow-500 {
          background-color: #f59e0b !important;
          color: #ffffff !important;
        }

        .text-yellow-600,
        .text-yellow-700 {
          color: #d97706 !important;
        }

        .border-yellow-300,
        .border-yellow-400 {
          border-color: #fbbf24 !important;
        }

        .stroke-yellow-500 {
          stroke: #f59e0b !important;
        }

        button:disabled,
        input:disabled,
        select:disabled,
        textarea:disabled {
          opacity: 0.6 !important;
          color: #64748b !important;
        }

        .bg-slate-50 {
          background-color: #f8fafc !important;
        }

        .text-xs,
        .text-sm {
          color: inherit;
        }

        .text-muted,
        .text-muted-foreground {
          color: #64748b !important;
        }

        .text-slate-400 svg,
        .text-gray-400 svg {
          color: #64748b !important;
        }

        /* Force black text on highlighted menu items (yellow background) */
        [role="option"][aria-selected="true"],
        [role="option"][data-selected="true"],
        [cmdk-item][data-selected="true"] {
          color: #000000 !important;
        }
        [role="option"][aria-selected="true"] span,
        [role="option"][data-selected="true"] span,
        [cmdk-item][data-selected="true"] span {
          color: #000000 !important;
        }

        ${Array.from({ length: 12 }, (_, i) => {
          const colors = [
          '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
          '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
          '#06b6d4', '#a855f7'];

          return `.store-color-${i} { color: ${colors[i]}; }`;
        }).join('\n')}
      `}</style>

      {/* Connection Recovery Banner - auto-shows on connection issues */}
      <ConnectionRecoveryBanner />

      {/* PWA Install Prompt */}
      <PWAInstallPrompt />

      {showCitySelectionPopup && currentUser && cities && cities.length > 0 &&
      <CitySelectionPopup
        cities={cities}
        currentUser={currentUser}
        onCitySelected={handleCitySelected} />

      }

      {showPatientImport &&
      <PatientImport
        onClose={() => {
          setShowPatientImport(false);
          setIsFormOverlayOpen(false);
        }}
        onImportStart={() => {
          setIsFormOverlayOpen(true);
        }}
        onImportComplete={async () => {
          setShowPatientImport(false);
          setIsFormOverlayOpen(false);
          invalidate('Patient');
          const freshPatients = await getData('Patient', null, null, true);
          setPatients(freshPatients);

          // CRITICAL: Dispatch events for active page to refresh
          window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
          window.dispatchEvent(new CustomEvent('patientsUpdated', {
            detail: { triggeredBy: 'patientImportComplete' }
          }));
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

                  {showDeliveryImport &&
      <RouteImport
        onCancel={() => {
          setShowDeliveryImport(false);
          setIsFormOverlayOpen(false);
          // Clean up global callback
          if (typeof window !== 'undefined') {
            delete window.__routeImportStartCallback;
          }
        }}
        onImportStart={() => {
          setIsFormOverlayOpen(true);
        }}
        onImportComplete={async () => {
          setShowDeliveryImport(false);
          setIsFormOverlayOpen(false);
          if (typeof window !== 'undefined') {
            delete window.__routeImportStartCallback;
          }
          invalidate('Delivery');
          invalidate('Patient');
          await triggerFullDataLoadRef.current(true);

          // CRITICAL: Dispatch events for active page to refresh
          window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
          window.dispatchEvent(new CustomEvent('deliveriesImported', {
            detail: { source: 'routeImport', deliveries: [] }
          }));
          window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
            detail: { triggeredBy: 'routeImportComplete' }
          }));
        }}
        stores={stores}
        allUsers={users}
        currentUser={currentUser}
        allDeliveries={deliveries} />

      }



      {isLoadingLayout ?
      <div className="h-screen flex items-center justify-center bg-slate-50">
          <div className="text-center">
            <div className="animate-spin w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full mx-auto mb-4"></div>
            <p className="text-slate-600 text-lg font-medium">Loading RxDeliver...</p>
          </div>
        </div> :
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
          deliveries: deliveries || [],
          patients: patients || [],
          stores: stores || [],
          drivers: drivers || [],
          users: users || [],
          appUsers: appUsers || [],
          cities: cities || [],
          isDataLoaded: dataLoaded,
          refreshData: triggerFullDataLoadRef.current,
          updateDeliveriesLocally: updateDeliveriesLocally,
          isFormOverlayOpen: isFormOverlayOpen,
          setIsFormOverlayOpen: setIsFormOverlayOpen,
          isEntityUpdating: isEntityUpdating,
          setIsEntityUpdating: setIsEntityUpdating,
          smartRefreshActivity: smartRefreshActivity,
          setSmartRefreshActivity: setSmartRefreshActivity,
          setOnSmartRefreshComplete: (callback) => {onSmartRefreshCompleteRef.current = callback;},
          // Data is already loaded from last 30 days - Dashboard filters locally
          dataReadyForSelectedDate: dataLoaded,
          isSnapshotModeActive: isSnapshotModeActive,
          setIsSnapshotModeActive: setIsSnapshotModeActive
        }}>
            <div className={`app-container ${isMobile ? 'mobile-device' : 'desktop-device'}`}>
              {isMobile && sidebarOpen &&
            <div
              className="sidebar-overlay"
              onClick={() => setSidebarOpen(false)} />
            }

              {/* Sidebar - Hidden in snapshot mode */}
              {!isSnapshotModeActive &&
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
                      src="https://cdn-icons-png.flaticon.com/512/3843/3843479.png"
                      alt="RxDeliver"
                      className="w-10 h-10 rounded object-contain"
                      style={{ filter: 'var(--image-filter, none)' }} />

                      <div>
                        <h2 className="font-bold text-lg" style={{ color: 'var(--text-slate-900)' }}>RxDeliver</h2>
                        <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>Pharmacy Logistics</p>
                        <div className="flex items-center">
                          <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>{appVersion}</p>
                          <BatteryIndicator />
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {/* Show controls in navigation panel when mobile wide screen OR desktop admin */}
                      {(isMobile && screenWidth >= 768) || (!isMobile && userHasRole(currentUser, 'admin') && cities && cities.length > 0) ?
                        <>
                          {/* Location Tracking Toggle - mobile wide screen only, drivers only */}
                          {isMobile && currentUser && userHasRole(currentUser, 'driver') &&
                            <LocationTrackingToggle
                              currentUser={currentUser}
                              onUpdate={async () => {
                                clearUserCache();
                                const refreshedUser = await getEffectiveUser();
                                if (refreshedUser) {
                                  setCurrentUser(refreshedUser);
                                }
                              }}
                            />
                          }

                          {/* Driver Status Toggle - mobile wide screen only, drivers only */}
                          {isMobile && currentUser && userHasRole(currentUser, 'driver') &&
                            <DriverStatusToggle
                              currentUser={currentUser}
                              vertical={true}
                              onStatusChange={async (newStatus) => {
                                clearUserCache();
                                const refreshedUser = await getEffectiveUser();
                                if (refreshedUser) {
                                  setCurrentUser(refreshedUser);
                                }
                              }}
                            />
                          }

                          {/* Settings Menu */}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                                <MoreVertical className={`${isMobile ? 'w-5 h-5' : 'w-4 h-4'} text-slate-500`} />
                              </Button>
                            </DropdownMenuTrigger>
                            <SettingsMenu
                              currentUser={currentUser}
                              realUser={realUser}
                              isAppOwner={isAppOwner(currentUser)}
                              adminImportEnabled={adminImportEnabled}
                              onAdminImportToggle={async (checked) => {
                                if (currentUser?._isImpersonating) return;
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
                              dataSource={dataSource}
                              onDataSourceChange={handleDataSourceChange}
                              cities={cities}
                              onPatientImportClick={() => setShowPatientImport(true)}
                              onDeliveryImportClick={() => setShowDeliveryImport(true)}
                              isMobile={isMobile}
                            />
                          </DropdownMenu>
                        </> : null
                      }
                    </div>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-3 custom-scrollbar" style={{ background: 'var(--bg-white)' }}>
                  <div className="">
                    <Link
                    to={constructUrlWithParams("Dashboard")}
                    onClick={() => setSidebarOpen(false)}
                    className={`px-4 rounded-xl flex items-center gap-3 transition-all duration-200 ${
                    currentPageName === 'Dashboard' ?
                    'shadow-sm' :
                    'hover:opacity-80'}`
                    }
                    style={currentPageName === 'Dashboard' ? {
                      background: 'var(--bg-slate-100)',
                      color: 'var(--text-slate-900)'
                    } : {
                      color: 'var(--text-slate-600)'
                    }}>
                      <LayoutDashboard className="w-5 h-5" />
                      <span className="font-semibold">Dashboard</span>
                    </Link>

                    <div className="border-t my-2" style={{ borderColor: 'var(--border-slate-200)' }}></div>

                    {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) &&
                    <Link
                    to={createPageUrl('Patients')}
                    onClick={(e) => {
                      if (isSnapshotModeActive) {
                        e.preventDefault();
                        return;
                      }
                      setSidebarOpen(false);
                    }}
                    className={`px-4 py-1 rounded-xl flex items-center gap-2 transition-all duration-200 ${
                    currentPageName === 'Patients' ?
                    'shadow-sm' :
                    'hover:opacity-80'} ${isSnapshotModeActive ? 'opacity-50 cursor-not-allowed' : ''}`
                    }
                    style={currentPageName === 'Patients' ? {
                      background: 'var(--bg-slate-100)',
                      color: 'var(--text-slate-900)'
                    } : {
                      color: 'var(--text-slate-600)'
                    }}>
                          <Users className="w-5 h-5" />
                          <span className="font-semibold">Patients</span>
                          <Badge variant="secondary" className="ml-auto justify-center w-[45px] rounded-[10px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-600)' }}>
                            {userHasRole(currentUser, 'admin') ?
                      entityCounts.patients :
                      patients.filter((p) => p && currentUser?.store_ids?.includes(p.store_id)).length}
                          </Badge>
                          </Link>
                    }

                    {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) &&
                    <Link
                    to={getRouteNavigationUrl('Deliveries')}
                    onClick={(e) => {
                      if (isSnapshotModeActive) {
                        e.preventDefault();
                        return;
                      }
                      setSidebarOpen(false);
                    }}
                    className={`px-4 py-1 rounded-xl flex items-center gap-2 transition-all duration-200 ${
                    currentPageName === 'Deliveries' ?
                    'shadow-sm' :
                    'hover:opacity-80'} ${isSnapshotModeActive ? 'opacity-50 cursor-not-allowed' : ''}`
                    }
                    style={currentPageName === 'Deliveries' ? {
                      background: 'var(--bg-slate-100)',
                      color: 'var(--text-slate-900)'
                    } : {
                      color: 'var(--text-slate-600)'
                    }}>
                          <Package className="w-5 h-5" />
                          <span className="font-semibold">Routes</span>
                          <Badge variant="secondary" className="ml-auto justify-center w-[45px] rounded-[10px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-600)' }}>{totalRoutesCount}</Badge>
                          </Link>
                    }

                    {/* Snapshot Mode - App Owner Only */}
                    {isAppOwner(currentUser) &&
                    <button
                    onClick={() => {
                      setIsSnapshotModeActive(!isSnapshotModeActive);
                      setSidebarOpen(false);
                    }}
                    className={`px-4 py-1 rounded-xl flex items-center gap-2 transition-all duration-200 ${
                    isSnapshotModeActive ?
                    'shadow-sm' :
                    'hover:opacity-80'}`
                    }
                    style={isSnapshotModeActive ? {
                      background: 'var(--bg-slate-100)',
                      color: 'var(--text-slate-900)'
                    } : {
                      color: 'var(--text-slate-600)'
                    }}>
                          <Clock className="w-5 h-5" />
                          <span className="font-semibold">Snapshot Mode</span>
                          </button>
                    }

                    {(isAppOwner(currentUser) || userHasRole(currentUser, 'driver')) &&
                    <Link
                    to={createPageUrl('SquareManagement')}
                    onClick={(e) => {
                      if (isSnapshotModeActive) {
                        e.preventDefault();
                        return;
                      }
                      setSidebarOpen(false);
                    }}
                    className={`px-4 py-1 rounded-xl flex items-center gap-2 transition-all duration-200 ${
                    currentPageName === 'SquareManagement' ?
                    'shadow-sm' :
                    'hover:opacity-80'} ${isSnapshotModeActive ? 'opacity-50 cursor-not-allowed' : ''}`
                    }
                    style={currentPageName === 'SquareManagement' ? {
                      background: 'var(--bg-slate-100)',
                      color: 'var(--text-slate-900)'
                    } : {
                      color: 'var(--text-slate-600)'
                    }}>
                          <CreditCard className="w-5 h-5" />
                          <span className="font-semibold">Square COD</span>
                          <Badge variant="secondary" className="ml-auto justify-center w-auto px-2 rounded-[10px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-600)' }}>
                            ${totalCodsDue.toFixed(2)}
                          </Badge>
                          </Link>
                    }

                    {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'driver')) &&
                    <Link
                    to={createPageUrl('DriverPayroll')}
                    onClick={(e) => {
                      if (isSnapshotModeActive) {
                        e.preventDefault();
                        return;
                      }
                      setSidebarOpen(false);
                    }}
                    className={`px-4 py-1 rounded-xl flex items-center gap-2 transition-all duration-200 ${
                    currentPageName === 'DriverPayroll' ?
                    'shadow-sm' :
                    'hover:opacity-80'} ${isSnapshotModeActive ? 'opacity-50 cursor-not-allowed' : ''}`
                    }
                    style={currentPageName === 'DriverPayroll' ? {
                      background: 'var(--bg-slate-100)',
                      color: 'var(--text-slate-900)'
                    } : {
                      color: 'var(--text-slate-600)'
                    }}>
                          <DollarSign className="w-5 h-5" />
                          <span className="font-semibold">Driver Payroll</span>
                          </Link>
                    }

                    {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) &&
                    <Link
                    to={constructUrlWithParams(createPageUrl("DeliveryMetrics"))}
                    onClick={(e) => {
                      if (isSnapshotModeActive) {
                        e.preventDefault();
                        return;
                      }
                      setSidebarOpen(false);
                    }}
                    className={`px-4 py-1 rounded-xl flex items-center gap-2 transition-all duration-200 ${
                    currentPageName === 'DeliveryMetrics' ?
                    'shadow-sm' :
                    'hover:opacity-80'} ${isSnapshotModeActive ? 'opacity-50 cursor-not-allowed' : ''}`
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

                    </div>

                  {userHasRole(currentUser, 'admin') &&
                <div className="mt-2">
                      <div className="border-t mb-2" style={{ borderColor: 'var(--border-slate-200)' }}></div>
                      <div className="text-xs font-semibold uppercase tracking-wider px-3 py-1" style={{ color: 'var(--text-slate-500)' }}>
                        Admin
                      </div>
                      <div className="space-y-1">
                        {adminNavigationItems.map((item) =>
                    <Link
                      key={item.title}
                      to={constructUrlWithParams(item.url)}
                      onClick={() => setSidebarOpen(false)}
                      className={`px-4 rounded-xl flex items-center gap-3 transition-all duration-200 ${
                      currentPageName === item.pageName ?
                      'shadow-sm' :
                      'hover:opacity-80'}`
                      }
                      style={currentPageName === item.pageName ? {
                        background: 'var(--bg-slate-100)',
                        color: 'var(--text-slate-900)'
                      } : {
                        color: 'var(--text-slate-600)'
                      }}>
                            {item.icon && <item.icon className="w-5 h-5" />}
                            <span className="font-semibold">{item.title}</span>
                            {item.count !== undefined && <Badge variant="secondary" className="ml-auto justify-center w-[50px] rounded-[10px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-600)' }}>{item.count}</Badge>}
                            </Link>
                    )}
                            </div>
                            </div>
                }

                  {currentPageName === 'Dashboard' &&
                  <div className="mt-2">
                        <div className="border-t mb-2" style={{ borderColor: 'var(--border-slate-200)' }}></div>
                        <div className="text-xs font-semibold uppercase tracking-wider px-3 py-1" style={{ color: 'var(--text-slate-500)' }}>
                          Quick Stats
                        </div>
                        <QuickStats
                        currentUser={currentUser}
                        storeIds={stores.map((s) => s?.id).filter(Boolean)}
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

                <div className="border-t p-4 flex-shrink-0" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}>
                    {currentUser ?
                <div>
                      <div className={`flex items-center gap-3 mb-3 p-3 rounded-lg ${
                      impersonatingUser ? 'bg-yellow-50 border-2 border-yellow-300' : ''}`
                      }>
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center relative flex-shrink-0 ${
                      impersonatingUser ?
                      'bg-gradient-to-br from-yellow-500 to-yellow-600' :
                      userHasRole(currentUser, 'admin') ?
                      'bg-gradient-to-br from-blue-500 to-blue-600' :
                      userHasRole(currentUser, 'dispatcher') ?
                      'bg-gradient-to-br from-red-500 to-red-600' :
                      userHasRole(currentUser, 'driver') ?
                      'bg-gradient-to-br from-emerald-500 to-emerald-600' :
                      'bg-gradient-to-br from-gray-400 to-gray-500' // Added fallback gradient for roles not specifically colored
                      }`
                      }>
                          <span className="text-white font-bold text-sm">
                            {(getDriverDisplayName(currentUser) || 'U')?.charAt(0)}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          {impersonatingUser &&
                      <p className="text-xs font-semibold text-yellow-800 mb-1">
                              Viewing As
                            </p>
                      }
                          <p className="font-semibold text-sm truncate" style={{ color: 'var(--text-slate-900)' }}>
                            {getDriverDisplayName(currentUser)} {showWatermark && <>[{deviceType} - {os}]</>}
                          </p>
                          <p className="text-xs truncate capitalize" style={{ color: 'var(--text-slate-500)' }}>
                            {formatRoles(currentUser)}
                          </p>
                          {currentUser.phone &&
                      <div className="flex items-center gap-2 text-xs text-slate-500">
                              <Phone className="w-3 h-3" />
                              <a
                          href={`tel:${currentUser.phone}`}
                          className="hover:text-slate-700 transition-colors">

                                {formatPhoneNumber(currentUser.phone)}
                              </a>
                            </div>
                      }
                        </div>
                        <div className="flex flex-col items-center gap-2">
                          <button
                        onClick={() => {
                          setShowMessaging(true);
                          setUnreadMessageCount(0);
                          setSidebarOpen(false); // Close sidebar when opening messages
                        }}
                        className="p-2 hover:bg-slate-100 rounded-lg transition-colors relative"
                        title="Messages">

                                <MessageCircle className="w-5 h-5 text-slate-500 hover:text-slate-700" fill={unreadMessageCount > 0 ? '#10b981' : 'none'} />
                                {unreadMessageCount > 0 &&
                        <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-blue-500 text-xs font-bold rounded-full flex items-center justify-center px-1 border-2 border-white" style={{ color: '#ffffff' }}>
                                        {unreadMessageCount > 9 ? '9+' : unreadMessageCount}
                                      </span>
                        }
                              </button>
                          <button
                        onClick={() => {
                          setShowInviteQRModal(true);
                          setSidebarOpen(false);
                        }}
                        className="p-2 hover:bg-slate-100 rounded-lg transition-colors relative"
                        title="Generate Invite QR Code">

                                <QrCode className="w-5 h-5 text-slate-500 hover:text-slate-700" />
                              </button>
                        </div>
                      </div>

                      {impersonatingUser &&
                  <Button
                    onClick={handleStopImpersonating}
                    variant="destructive"
                    className="w-full gap-2 mb-3">
                          <LogOut className="w-4 h-4" /> Stop Viewing As
                        </Button>
                  }

                      {(impersonatingUser || userHasRole(realUser, 'admin')) &&
                  <UserImpersonation
                    users={users} // Pass Layout's local users state
                    currentUser={currentUser}
                    onImpersonate={handleImpersonate}
                    onStopImpersonating={handleStopImpersonating}
                    impersonatingUser={impersonatingUser} />


                  }


                    </div> :

                <div className="space-y-2">
                      <div className="text-sm text-slate-500 mb-2">Not logged in</div>
                      <Button
                    onClick={async () => {
                      try {
                        sessionStorage.clear();
                        clearUserCache();
                        const currentUrl = window.location.origin + window.location.pathname;
                        await User.loginWithRedirect(currentUrl);
                      } catch (error) {
                        console.error('Login failed:', error);
                        window.location.href = '/';
                      }
                    }}
                    className="w-full gap-2 bg-emerald-500 hover:bg-emerald-600">

                        Log In
                      </Button>
                    </div>
                }
                </div>
                </div>
                }

                {/* Resizable Divider for Sidebar - Only on desktop */}
                {!isMobile && !isSnapshotModeActive &&
            <ResizableDivider
              storageKey="rxdeliver_sidebar_width"
              defaultWidth={240}
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
              <div className="main-content-area" style={isSnapshotModeActive ? { width: '100vw' } : {}}>

                {/* Mobile Header - Hidden in snapshot mode */}
                {!isSnapshotModeActive &&
                <header
                className="mobile-header border-b px-4 py-3 sticky top-0"
                style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}>

                  <div className="w-full flex items-center justify-between gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSidebarOpen(!sidebarOpen);
                      }}
                      className="p-2 hover:bg-slate-100 rounded-lg transition-colors flex-shrink-0">
                        {sidebarOpen ?
                          <X className="w-6 h-6 text-slate-700" /> :
                          <Menu className="w-6 h-6 text-slate-700" />
                        }
                    </button>

                    {/* Centered Controls - Only on narrow mobile */}
                    {isMobile && screenWidth < 768 && currentUser && (userHasRole(currentUser, 'driver') || userHasRole(currentUser, 'admin')) &&
                    <div className="flex-1 flex items-center justify-center gap-2">
                      {/* Menu - Left */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-9 w-9 p-0">
                            <MoreVertical className="w-5 h-5 text-slate-500" />
                          </Button>
                        </DropdownMenuTrigger>
                        <SettingsMenu
                          currentUser={currentUser}
                          realUser={realUser}
                          isAppOwner={isAppOwner(currentUser)}
                          adminImportEnabled={adminImportEnabled}
                          onAdminImportToggle={async (checked) => {
                            if (currentUser?._isImpersonating) return;
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
                          dataSource={dataSource}
                          onDataSourceChange={handleDataSourceChange}
                          cities={cities}
                          onPatientImportClick={() => setShowPatientImport(true)}
                          onDeliveryImportClick={() => setShowDeliveryImport(true)}
                          isMobile={true}
                        />
                      </DropdownMenu>

                      {/* Status Toggle - Center */}
                      <div style={{ width: userHasRole(currentUser, 'driver') ? 'auto' : '0px', overflow: 'hidden' }}>
                        <DriverStatusToggle
                          currentUser={currentUser}
                          onStatusChange={async (newStatus) => {
                            clearUserCache();
                            const refreshedUser = await getEffectiveUser();
                            if (refreshedUser) {
                              setCurrentUser(refreshedUser);
                            }
                          }}
                        />
                      </div>

                      {/* QR Code - Right */}
                      <button
                        onClick={() => setShowInviteQRModal(true)}
                        className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
                        title="Generate Invite QR Code">
                        <QrCode className="w-6 h-6 text-slate-500 hover:text-slate-700" />
                      </button>
                    </div>
                    }

                    {/* Center logo + message badge */}
                    <div
                      className="flex items-center gap-2 flex-shrink-0 relative cursor-pointer"
                      onClick={() => {
                        if (unreadMessageCount > 0) {
                          setShowMessaging(true);
                          setUnreadMessageCount(0);
                        }
                      }}>
                      <img
                        src="https://cdn-icons-png.flaticon.com/512/3843/3843479.png"
                        alt="RxDeliver"
                        className="w-8 h-8 rounded object-contain"
                        style={{ filter: 'var(--image-filter, none)' }} />
                      {unreadMessageCount > 0 &&
                        <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-blue-500 text-xs font-bold rounded-full flex items-center justify-center px-1 border-2 border-white" style={{ color: '#ffffff' }}>
                          {unreadMessageCount > 9 ? '9+' : unreadMessageCount}
                        </span>
                      }
                    </div>

                    {/* Battery + User Avatar on far right (all users, narrow mobile) */}
                    {isMobile && screenWidth < 768 && currentUser &&
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <BatteryIndicator vertical={true} />
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                          userHasRole(currentUser, 'admin') ?
                          'bg-gradient-to-br from-blue-500 to-blue-600' :
                          userHasRole(currentUser, 'dispatcher') ?
                          'bg-gradient-to-br from-red-500 to-red-600' :
                          userHasRole(currentUser, 'driver') ?
                          'bg-gradient-to-br from-emerald-500 to-emerald-600' :
                          'bg-gradient-to-br from-gray-400 to-gray-500'}`}>
                        <span className="text-white font-bold text-xs">
                          {(getDriverDisplayName(currentUser) || 'U')?.charAt(0)}
                        </span>
                      </div>
                    </div>
                    }
                    </div>
                    </header>
                    }

                    <main className="flex-1 overflow-y-auto relative" style={{ background: 'var(--bg-slate-50)' }}>
                  {children}
                </main>
              </div>
            </div>
          </AppDataProvider>
        </UserProvider>
      }
    </ErrorBoundary>);

}