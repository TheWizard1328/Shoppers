import React, { useState, useEffect, Fragment, useMemo, useCallback, useRef } from "react";
import "./components/utils/globalErrorHandler";
import { Link, useLocation } from "react-router-dom";
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
  MessageCircle
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandList, CommandItem } from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
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
      import { getUserAgentInfo } from './components/utils/deviceUtils';
      import PatientImport from './components/patients/PatientImport';
      import RouteImport from './components/deliveries/RouteImport';
      import DriverStatusToggle from './components/layout/DriverStatusToggle';
      import { loadUserSettings, saveSetting, clearSettingsCache } from './components/utils/userSettingsManager';
      import MessagingPanel from './components/messaging/MessagingPanel';
      import SmartRefreshIndicator from './components/layout/SmartRefreshIndicator';
      import { isMobileDevice } from './components/utils/deviceUtils';
      import MessageNotificationBalloon from './components/messaging/MessageNotificationBalloon';
      import { initializeDailyCleanup } from './components/utils/messageCleaner';

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

const QuickStats = ({ currentUser, storeIds = [] }) => {
  const [selectedDateStr, setSelectedDateStr] = useState(() => globalFilters.getSelectedDate());
  const [stats, setStats] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    const checkDateChange = () => {
      const currentDateStr = globalFilters.getSelectedDate();
      if (currentDateStr !== selectedDateStr) {
        setSelectedDateStr(currentDateStr);
      }
    };

    const interval = setInterval(checkDateChange, 100);
    return () => clearInterval(interval);
  }, [selectedDateStr]);

  // Fetch stats from backend function (lightweight - no full data load)
          useEffect(() => {
            if (!currentUser) return;

            const fetchStats = async () => {
              try {
                setHasError(false);
                const selectedDriverId = globalFilters.getSelectedDriverId();

                // CRITICAL: Pass selected driver ID directly - backend handles filtering
                // When 'all' is selected → driverId=null (show all drivers)
                // When specific driver selected → driverId=that driver (show only that driver)
                const driverId = selectedDriverId === 'all' ? null : selectedDriverId;

                // Store filtering based on user role
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
                } else {
                  setHasError(true);
                }
              } catch (error) {
                setHasError(true);
              } finally {
                setIsLoading(false);
              }
            };

            // Listen for manual refresh requests (e.g., after imports)
            window.addEventListener('refreshDeliveryStats', fetchStats);

            // Delay initial fetch slightly to avoid competing with layout init
            console.log('🔄 [QuickStats] Scheduling stats fetch for date:', selectedDateStr);
            const initialTimer = setTimeout(fetchStats, 1000);
            // Refresh stats every 60 seconds
            const interval = setInterval(fetchStats, 60000);
            return () => {
              clearTimeout(initialTimer);
              clearInterval(interval);
              window.removeEventListener('refreshDeliveryStats', fetchStats);
            };
          }, [currentUser, selectedDateStr, storeIds]);

  const StatItem = ({ icon: Icon, label, value, colorClass }) =>
    <div className="flex items-center justify-between text-sm">
      <div className="flex items-center gap-2">
        <Icon className={`w-4 h-4 ${colorClass || 'text-slate-500'}`} />
        <span className="text-slate-600 font-medium">{label}</span>
      </div>
      <Badge variant="secondary" className="inline-flex border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent hover:bg-secondary/80 bg-slate-100 text-slate-700 justify-center w-[55px] rounded-[10px]">{value}</Badge>
    </div>;

  if (!currentUser) return null;

  const selectedDate = selectedDateStr ? new Date(selectedDateStr + 'T00:00:00') : new Date();
  const now = new Date();
  const todayString = format(now, 'yyyy-MM-dd');
  const isToday = format(selectedDate, 'yyyy-MM-dd') === todayString;

  if (isLoading) {
    return (
      <div className="px-3 py-2">
        <div className="animate-pulse space-y-2">
          <div className="h-4 bg-slate-200 rounded w-1/2"></div>
          <div className="h-6 bg-slate-200 rounded"></div>
          <div className="h-6 bg-slate-200 rounded"></div>
        </div>
      </div>
    );
  }

  if (hasError || !stats) {
    return (
      <div className="px-3 py-2 text-sm text-slate-500">
        Unable to load stats
      </div>
    );
  }

  return (
    <div className="px-3 py-2 space-y-3">
      <div>
        <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
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
          <StatItem icon={MapPin} label="Polylines" value={stats.today.polylineCount || 0} colorClass="text-blue-600" />
        </div>
      </div>

      <div>
        <h4 className="xs font-semibold text-slate-500 uppercase tracking-wider mb-2">{format(selectedDate, 'MMMM yyyy')}:</h4>
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
    </div>
  );
};

const UserImpersonation = ({ users = [], onImpersonate, onStopImpersonating, impersonatingUser, currentUser }) => {
  const [open, setOpen] = useState(false);

  const availableUsers = sortUsers(currentUser ? users.filter((u) => u && u.id !== currentUser.id) : users);

  return (
    <div className="mt-2 space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-full gap-2 border-black">
            <Eye className="w-4 h-4" /> {impersonatingUser ? 'Switch User' : 'View as User'}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0 z-[10001]">
          <Command>
            <CommandList>
              <CommandGroup>
                {availableUsers.map((user) =>
                  <CommandItem
                    key={user.id}
                    value={`${user.user_name || user.full_name} ${formatRoles(user)}`}
                    onSelect={() => {
                      onImpersonate(user.id);
                      setOpen(false);
                    }}
                    className="flex justify-between">

                    <span>{user.user_name || user.full_name}</span>
                    <span className="text-xs capitalize text-slate-500">{formatRoles(user)}</span>
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
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    if (error.message && (
      error.message.includes('l is not a function') ||
      error.message.includes('_leaflet_pos') ||
      error.message.includes('Leaflet'))) {
      console.warn('Leaflet error caught by ErrorBoundary, continuing normally');
      return { hasError: false };
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
    console.error('Unhandled error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen flex items-center justify-center bg-slate-50">
          <div className="text-center">
            <h1 className="text-xl font-semibold text-slate-900 mb-2">Something went wrong</h1>
            <p className="text-slate-600 mb-4">Please refresh the page to continue.</p>
            <Button onClick={() => window.location.reload()}>Refresh Page</Button>
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
  const { deviceType, os } = getUserAgentInfo();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(deviceType === 'Mobile');
  const [screenWidth, setScreenWidth] = useState(window.innerWidth);
  const [cardWidth, setCardWidth] = useState(300);

  const [pullDistance, setPullDistance] = useState(0);
  const [isPulling, setIsPulling] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [touchStartY, setTouchStartY] = useState(0);
  const pullThreshold = 80;

  const refreshIntervalRef = useRef(null);
  const wakeLockRef = useRef(null);
  const onSmartRefreshCompleteRef = useRef(null);

  // Remove unused driverLocationIntervalRef - now handled by unified refresh

  const [sidebarWidth, setSidebarWidth] = useState(240); // Will be loaded from user settings
      const [themePreference, setThemePreference] = useState('auto');
      const [userSettingsLoaded, setUserSettingsLoaded] = useState(false);
      const [showMessaging, setShowMessaging] = useState(false);
      const [unreadMessageCount, setUnreadMessageCount] = useState(0);
      const [initialConversation, setInitialConversation] = useState(null);

  useEffect(() => {
    const init = async () => {
      console.log("📦 [Layout] === PHASE 2: STARTING INITIAL DATA LOAD ===");
      setIsLoadingLayout(true);

      try {
        console.log('🔐 [Layout] Step 2.1: Fetching currentUser...');
        const fetchedUser = await getEffectiveUser();

        if (!fetchedUser) {
          console.warn('⚠️ [Layout] Step 2.2: No user found during initialization');
          setHasAccess(false);
          setCurrentUser(null);
          setIsLoadingLayout(false);
          setDataLoaded(true);
          return;
        }

        console.log(`✅ [Layout] Step 2.1 Complete: User loaded - ${fetchedUser.user_name || fetchedUser.full_name}`);

      // Load user settings for this user and device
      console.log('📋 [Layout] Step 2.1b: Loading user settings...');
      try {
        const settings = await loadUserSettings(fetchedUser.id);
        console.log('✅ [Layout] User settings loaded:', settings);

        // Apply sidebar width
        if (settings.sidebar_width) {
          setSidebarWidth(settings.sidebar_width);
        }

        // Apply theme preference
        if (settings.theme_preference) {
          setThemePreference(settings.theme_preference);
        }

        setUserSettingsLoaded(true);
      } catch (settingsError) {
        console.warn('⚠️ [Layout] Error loading user settings:', settingsError);
        setUserSettingsLoaded(true);
      }

      // Load app-wide settings (smart refresh toggle)
      console.log('⚙️ [Layout] Step 2.1c: Loading app settings...');
      try {
        const smartRefreshEnabled = await smartRefreshManager.initializeFromSettings();
        console.log(`⚙️ [Layout] Smart refresh initialized: ${smartRefreshEnabled ? 'ENABLED' : 'DISABLED'} (_enabled=${smartRefreshManager._enabled}, _initialized=${smartRefreshManager._initialized})`);
      } catch (appSettingsError) {
        console.warn('⚠️ [Layout] Error loading app settings:', appSettingsError);
        // Default to enabled on error
        smartRefreshManager._enabled = true;
        smartRefreshManager._initialized = true;
      }

        console.log('🔐 [Layout] Step 2.2: Checking access permissions...');

        const isDispatcher = userHasRole(fetchedUser, 'dispatcher');
        const isInactive = fetchedUser.status === 'inactive';

        if (isDispatcher && isInactive) {
          console.error('🚫 [Layout] INACTIVE DISPATCHER detected - ACCESS DENIED');

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

        console.log('✅ [Layout] Step 2.2 Complete: Access granted');


        setCurrentUser(fetchedUser);
        setHasAccess(true);

        console.log('🏙️ [Layout] Step 2.3: Loading all City entities...');
        const citiesData = await City.list();
        console.log(`✅ [Layout] Step 2.3 Complete: Loaded ${citiesData?.length || 0} cities`);

        citiesData.sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
        setCities(citiesData || []);

        console.log('🏪 [Layout] Step 2.3b: Pre-loading Stores for dispatcher logic...');
        const storesData = await getData('Store');
        console.log(`✅ [Layout] Step 2.3b Complete: Loaded ${storesData?.length || 0} stores`);

        console.log('🎯 [Layout] Step 2.4: Determining initial selectedCityId...');
        let initialCityId = null;

        if (fetchedUser.city_id) {
          const userCity = citiesData.find(c => c && c.id === fetchedUser.city_id);

          if (userCity) {
            initialCityId = fetchedUser.city_id;
            console.log(`✅ [Layout] Step 2.4: Using currentUser.city_id: ${initialCityId} (${userCity.name})`);
          } else {
            console.warn(`⚠️ [Layout] Step 2.4: currentUser.city_id (${fetchedUser.city_id}) does not match any loaded City entity`);
            initialCityId = null;
          }
        } else {
          console.warn('⚠️ [Layout] Step 2.4: currentUser.city_id is missing');
        }

        if (userHasRole(fetchedUser, 'admin')) {
          if (!initialCityId && citiesData.length > 0) {
            initialCityId = citiesData[0].id;
            console.log(`✅ [Layout] Step 2.4: Admin with no city_id, defaulting to first city: ${initialCityId} (${citiesData[0].name})`);
          }
        }


        if (!initialCityId) {
          console.log('🚨 [Layout] Step 2.4: EDGE CASE - No valid city for user, showing city selection popup');
          setShowCitySelectionPopup(true);
          globalFilters.setSelectedCityId('waiting-for-selection');
          setIsLoadingLayout(false);
          return;
        }

        globalFilters.setSelectedCityId(initialCityId);

        console.log('⚙️ [Layout] Step 2.5: Setting other global filters...');

        const today = new Date();

        // CRITICAL: Only set date to today if no saved date exists
        const savedDate = globalFilters.getSelectedDate();
        let effectiveDateForDriverAssignment;
        if (!savedDate) {
          globalFilters.setSelectedDate(today);
          effectiveDateForDriverAssignment = today;
          console.log(`📅 [Layout] Set selectedDate to today: ${format(today, 'yyyy-MM-dd')} (no saved date)`);
        } else {
          effectiveDateForDriverAssignment = new Date(savedDate + 'T00:00:00');
          console.log(`📅 [Layout] Keeping saved selectedDate: ${savedDate}`);
        }

        // CRITICAL: Do NOT auto-select driver here - let Dashboard handle it from user settings
        // Layout only ensures globalFilters has a value (defaults to 'all' if not set)
        const currentDriverFilter = globalFilters.getSelectedDriverId();
        if (!currentDriverFilter) {
          console.log('🎯 [Layout] No driver filter set, defaulting to "all" (Dashboard will override from settings)');
          globalFilters.setSelectedDriverId('all');
        } else {
          console.log(`🎯 [Layout] Driver filter already set: ${currentDriverFilter}`);
        }

        console.log('✅ [Layout] Step 2.5 Complete: All global filters initialized');

        console.log('🚪 [Layout] Step 2.6: Setting initialGlobalFiltersSet gate to TRUE');
        setInitialGlobalFiltersSet(true);

        const isReady = globalFilters.isReadyForDataFetch();
        console.log(`🔍 [Layout] globalFilters.isReadyForDataFetch(): ${isReady}`);

        if (!isReady) {
          console.error('❌ [Layout] CRITICAL: Gate should be ready but isReadyForDataFetch() returned false!');
          globalFilters.debug();
        }

        setIsLoadingLayout(false);
        console.log("✅ [Layout] === PHASE 2: INITIAL DATA LOAD COMPLETE ===");

      } catch (error) {
        console.error("❌ [Layout] Error during initial data load:", error);
        setHasAccess(false);
        setIsLoadingLayout(false);
        setDataLoaded(true);
      }
    };

    init();
    }, []);

    // Initialize daily message cleanup
    useEffect(() => {
    initializeDailyCleanup();
    }, []);

    // Fetch unread message count - only when messaging panel is closed
  // When panel is open, ConversationsList handles the count
  // OPTIMIZED: Reduced frequency significantly to prevent rate limits
  useEffect(() => {
    if (!currentUser?.id || showMessaging) return;

    const fetchUnreadCount = async () => {
      try {
        // Only fetch count, limit to 50 to reduce load
        const unreadMessages = await base44.entities.Message.filter({
          receiver_id: currentUser.id,
          read: false
        }, '-created_date', 50);
        setUnreadMessageCount(unreadMessages.length);
      } catch (error) {
        // Silently handle rate limits - don't spam console
        if (!error.message?.includes('429') && !error.message?.includes('Rate limit')) {
          console.error('Error fetching unread messages:', error);
        }
      }
    };

    // Delay initial fetch to avoid competing with init load
    const initialTimer = setTimeout(fetchUnreadCount, 5000);
    // Poll every 30 minutes when panel is closed
    const interval = setInterval(fetchUnreadCount, 1800000);
    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [currentUser?.id, showMessaging]);

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
  const updateDeliveriesLocally = useCallback((updates) => {
    console.log('🔄 [Layout] updateDeliveriesLocally called with', updates.length, 'updates');
    
    setDeliveries(prevDeliveries => {
      const updatesMap = new Map(updates.map(u => [u.id, u]));
      
      return prevDeliveries.map(delivery => {
        if (!delivery) return delivery;
        const update = updatesMap.get(delivery.id);
        if (update) {
          console.log(`  ✅ Applying update to delivery ${delivery.id}`);
          return { ...delivery, ...update };
        }
        return delivery;
      });
    });
  }, []);

  // Callback to update state from smartRefreshManager
  const updateAppDataState = useCallback(async (updates) => {
    // CRITICAL: Don't update state if a form is open to prevent unwanted re-renders
    if (isFormOverlayOpen) {
      console.log('⏸️ [Layout] Skipping state update - form overlay is open');
      return;
    }

    // CRITICAL: Don't apply empty updates - this causes data to disappear
    if (updates.deliveries && updates.deliveries.length === 0 && deliveries.length > 0) {
      console.warn('⚠️ [Layout] Ignoring empty deliveries update - would clear existing data');
      return;
    }
    if (updates.patients && updates.patients.length === 0 && patients.length > 0) {
      console.warn('⚠️ [Layout] Ignoring empty patients update - would clear existing data');
      return;
    }

    if (updates.deliveries) {
      console.log('🔄 [Layout] Updating deliveries from smart refresh');
      setDeliveries(updates.deliveries);
    }
    if (updates.patients) {
      console.log('🔄 [Layout] Updating patients from smart refresh');
      setPatients(updates.patients);
    }
    if (updates.appUsers) {
      console.log('🔄 [Layout] Updating appUsers from smart refresh');
      console.log('   📊 AppUsers updated - checking for driver_status changes...');
      const onDutyDrivers = updates.appUsers.filter(u => u && u.driver_status === 'on_duty');
      console.log(`   🚗 On-duty drivers: ${onDutyDrivers.length}`, onDutyDrivers.map(d => d.user_name || d.user_id));

      // CRITICAL: Check if current user's AppUser changed BEFORE updating state
      if (currentUser && !currentUser._isImpersonating && !isReloadingFromAppUserChange.current) {
        const updatedAppUserForCurrentUser = updates.appUsers.find(au => au && au.user_id === currentUser.id);

        if (updatedAppUserForCurrentUser) {
          // Compare against currentUser's store_ids, not stale appUsers state
          const oldStoreIds = JSON.stringify(currentUser.store_ids || []);
          const newStoreIds = JSON.stringify(updatedAppUserForCurrentUser.store_ids || []);

          const oldStatus = currentUser.status;
          const newStatus = updatedAppUserForCurrentUser.status;

          if (newStoreIds !== oldStoreIds || newStatus !== oldStatus) {
            console.log('🔄 [Layout] Current user AppUser changed - old stores:', currentUser.store_ids, 'new stores:', updatedAppUserForCurrentUser.store_ids);
            console.log('🛑 [Layout] Pausing smart refresh for full data reload...');

            isReloadingFromAppUserChange.current = true;

            // Update appUsers state first
            setAppUsers(updates.appUsers);

            // Refresh currentUser and wait for it
            clearUserCache();
            invalidate('AppUser');
            const refreshedUser = await getEffectiveUser();

            if (refreshedUser) {
              console.log('✅ [Layout] currentUser refreshed with new store assignments:', refreshedUser.store_ids);

              // Invalidate all caches
              invalidate('Store');
              invalidate('Patient');
              invalidate('Delivery');
              invalidate('User');

              // Update currentUser - this will trigger the useEffect to reload data
              setCurrentUser(refreshedUser);
              needsDataReload.current = true;
            }

            isReloadingFromAppUserChange.current = false;
            return; // Exit early since we already updated appUsers
          }
        }
      }

      // If no currentUser change detected, just update appUsers
      setAppUsers(updates.appUsers);
    }
    if (updates.users) {
      console.log('🔄 [Layout] Updating users from smart refresh');
      setUsers(updates.users);
    }
  }, [currentUser, isFormOverlayOpen]);

  // Unified real-time refresh system - single 5s interval handles all entity types
  // Each entity has its own refresh interval managed by smartRefreshManager
  useEffect(() => {
    if (!initialGlobalFiltersSet || !currentUser || isFormOverlayOpen || isEntityUpdating || !dataLoaded) {
      if (refreshIntervalRef.current) {
        console.log('🛑 [Layout] Stopping smart refresh (conditions not met)', { isFormOverlayOpen, isEntityUpdating });
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
      return;
    }

    // Set up rate limit callback
    smartRefreshManager.setRateLimitCallback((hasError) => {
      // This will be handled by Dashboard component
      if (window._setRateLimitError) {
        window._setRateLimitError(hasError);
      }
    });

    // Add delay to ensure all connections are established
    const startupTimer = setTimeout(() => {
      console.log('🚀 [Layout] Starting unified real-time refresh (20s tick, staggered intervals per entity)');

    // Unified refresh function - runs every 30s, each entity checks its own interval
    const performUnifiedRefresh = async () => {
      // CRITICAL: Check if smart refresh is disabled
      // When disabled, skip automatic background polling entirely
      if (!smartRefreshManager._enabled) {
        return;
      }

      const updatedEntities = [];
      try {
        setSmartRefreshActivity(prev => ({ ...prev, active: true }));
        console.log('');
        console.log('═══════════════════════════════════════════════════');
        console.log('🔄 [UNIFIED REFRESH] Starting refresh cycle');
        console.log('═══════════════════════════════════════════════════');

        const selectedDateStr = globalFilters.getSelectedDate();
        const selectedDate = selectedDateStr ? new Date(selectedDateStr + 'T00:00:00') : new Date();

        // Build current data and filters
        const currentData = {
          deliveries,
          patients,
          appUsers,
          stores
        };

        const filters = {
          selectedDate,
          deliveryFilter: {},
          patientFilter: {},
          activeDriverIds: drivers.map(d => d?.id).filter(Boolean)
        };

        const selectedDriverId = globalFilters.getSelectedDriverId();
        const cityStoreIds = stores.map(s => s?.id).filter(Boolean);

        if (cityStoreIds.length > 0) {
          filters.deliveryFilter.store_id = { $in: cityStoreIds };
          filters.patientFilter.store_id = { $in: cityStoreIds };
        }

        const isAdmin = userHasRole(currentUser, 'admin');
        const isDriver = userHasRole(currentUser, 'driver');
        const isDispatcher = userHasRole(currentUser, 'dispatcher');

        if (isDriver && !isDispatcher && !isAdmin) {
          filters.deliveryFilter.driver_id = currentUser.id;
        }

        if (selectedDriverId && selectedDriverId !== 'all') {
          filters.deliveryFilter.driver_id = selectedDriverId;
        }

        console.log(`📊 Current State: ${deliveries.length} deliveries, ${appUsers.length} appUsers, ${patients.length} patients, ${stores.length} stores`);
        console.log(`🎯 Entity Update Flag: ${isEntityUpdating ? 'PAUSED' : 'ACTIVE'}`);

        // CRITICAL: Skip all refreshes if entity update in progress
        if (isEntityUpdating) {
          console.log('⏸️ [Layout] Smart refresh SKIPPED - entity update in progress');
          console.log('═══════════════════════════════════════════════════');
          return;
        }

        // FAST: Driver locations (20s) - highest priority for real-time map
        console.log('');
        console.log('📍 [1/3] Driver Locations Refresh...');
        const locationUpdates = await smartRefreshManager.refreshDriverLocations(appUsers);
        if (locationUpdates?.hasChanges) {
          console.log('   ✅ Updating appUsers state with new locations');
          setAppUsers(locationUpdates.appUsers);
          updatedEntities.push('locations');
        } else {
          console.log('   ⏭️ No location changes');
        }

        // FAST: Active delivery statuses (30s) - for real-time map markers
        console.log('');
        console.log('📦 [2/3] Active Delivery Statuses Refresh...');
        const activeDeliveryUpdates = await smartRefreshManager.refreshActiveDeliveryStatuses(deliveries, selectedDate, filters);
        if (activeDeliveryUpdates?.hasChanges) {
          console.log('   ✅ Updating deliveries state with active status changes');
          setDeliveries(activeDeliveryUpdates.deliveries);
          if (!updatedEntities.includes('deliveries')) updatedEntities.push('deliveries');
        } else {
          console.log('   ⏭️ No active delivery changes');
        }

        // STAGGERED: Full entity refresh - each entity checks its own interval
        console.log('');
        console.log('🔄 [3/3] Full Entity Refresh (staggered intervals)...');
        const updates = await smartRefreshManager.performSmartRefresh(currentData, filters, isEntityUpdating);
        if (updates) {
          console.log('   ✅ Applying updates to state:', Object.keys(updates).join(', '));
          updateAppDataState(updates);
          // Track which entities were updated
          if (updates.deliveries) updatedEntities.push('deliveries');
          if (updates.patients) updatedEntities.push('patients');
          if (updates.appUsers) updatedEntities.push('appUsers');
          if (updates.stores) updatedEntities.push('stores');
        } else {
          console.log('   ⏭️ No entity updates needed');
        }

        // Notify map of any updates and reactivate FAB phase
        const hasAnyUpdates = locationUpdates?.hasChanges || activeDeliveryUpdates?.hasChanges || updates;
        if (hasAnyUpdates) {
          console.log('');
          console.log('🔔 Notifying map of updates and reactivating FAB phase');
          if (onSmartRefreshCompleteRef.current) {
            onSmartRefreshCompleteRef.current();
          }
        }

        console.log('');
        console.log('✅ [UNIFIED REFRESH] Cycle complete');
        console.log('═══════════════════════════════════════════════════');
        
        // Update activity state with which entities changed
        const uniqueUpdates = [...new Set(updatedEntities)];
        setSmartRefreshActivity({ active: false, updatedEntities: uniqueUpdates });
      } catch (error) {
        if (error.response?.status === 429 || error.message?.includes('429')) {
          console.error('🚨 [Layout] RATE LIMIT ERROR:', error.message);
          smartRefreshManager.notifyRateLimit(true);
        } else {
          console.warn('⚠️ [Layout] Refresh error:', error.message);
        }
        console.log('═══════════════════════════════════════════════════');
        setSmartRefreshActivity({ active: false, updatedEntities: [] });
      }
    };

      // CRITICAL: Don't run initial refresh immediately - wait for data to be fully loaded
      // The normal interval will handle the first refresh after data is stable
      console.log('🚀 [Layout] Smart refresh started - first refresh in 2 minutes (not immediate)');

      // Single unified interval - 2 minutes to avoid rate limits
      // Individual entity intervals are managed by smartRefreshManager
      refreshIntervalRef.current = setInterval(performUnifiedRefresh, 120000);
    }, 500);

    return () => {
      clearTimeout(startupTimer);
      console.log('🛑 [Layout] Stopping real-time refresh');
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
    };
    }, [initialGlobalFiltersSet, currentUser, isFormOverlayOpen, dataLoaded, updateAppDataState, appUsers, deliveries, stores, drivers]);

    // Wake Lock API and visibility change handler
    useEffect(() => {
      // Wake Lock API - keep screen on when app is focused
      const requestWakeLock = async () => {
        if ('wakeLock' in navigator && document.visibilityState === 'visible') {
          try {
            wakeLockRef.current = await navigator.wakeLock.request('screen');
            console.log('🔆 [Layout] Wake Lock acquired');
            wakeLockRef.current.addEventListener('release', () => {
              console.log('🔅 [Layout] Wake Lock released');
            });
          } catch (err) {
            // Silently fail - wake lock not critical
          }
        }
      };

      const releaseWakeLock = () => {
        if (wakeLockRef.current) {
          wakeLockRef.current.release();
          wakeLockRef.current = null;
        }
      };

      // Handle visibility change - force immediate refresh on focus
      const handleVisibilityChange = async () => {
        if (document.visibilityState === 'visible') {
          console.log('👁️ [Layout] App regained focus - forcing immediate refresh');
          await requestWakeLock();

          // Force immediate refresh by resetting all interval timers
          if (initialGlobalFiltersSet && currentUser && dataLoaded && !isFormOverlayOpen) {
            // Reset smartRefreshManager timers to force immediate refresh
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

    // Trigger smart refresh when navigating between pages
    useEffect(() => {
      if (!initialGlobalFiltersSet || !currentUser || !dataLoaded) {
        console.log('⏸️ [Layout] Skipping page navigation refresh - not ready');
        return;
      }

      console.log(`📄 [Layout] ===== PAGE NAVIGATION DETECTED =====`);
      console.log(`📄 [Layout] Switched to: ${currentPageName}`);
      
      // CRITICAL: Only trigger immediate refresh when returning to Dashboard
      if (currentPageName !== 'Dashboard') {
        console.log(`📄 [Layout] Non-dashboard page - skipping immediate refresh`);
        return;
      }
      
      console.log(`📄 [Layout] Dashboard detected - forcing IMMEDIATE smart refresh...`);

      // CRITICAL: Reset all smart refresh timers to force immediate data sync
      smartRefreshManager.lastRefreshTimes = {
        driverLocation: 0,
        activeDeliveries: 0,
        todayDeliveries: 0,
        appUsers: 0,
        patients: 0,
        stores: 0
      };

      const performPageChangeRefresh = async () => {
        try {
          setSmartRefreshActivity(prev => ({ ...prev, active: true }));

          const selectedDateStr = globalFilters.getSelectedDate();
          const selectedDate = selectedDateStr ? new Date(selectedDateStr + 'T00:00:00') : new Date();

          const currentData = {
            deliveries,
            patients,
            appUsers,
            stores
          };

          const filters = {
            selectedDate,
            deliveryFilter: {},
            patientFilter: {},
            activeDriverIds: drivers.map(d => d?.id).filter(Boolean)
          };

          const selectedDriverId = globalFilters.getSelectedDriverId();
          const cityStoreIds = stores.map(s => s?.id).filter(Boolean);

          if (cityStoreIds.length > 0) {
            filters.deliveryFilter.store_id = { $in: cityStoreIds };
            filters.patientFilter.store_id = { $in: cityStoreIds };
          }

          const isAdmin = userHasRole(currentUser, 'admin');
          const isDriver = userHasRole(currentUser, 'driver');
          const isDispatcher = userHasRole(currentUser, 'dispatcher');

          if (!isAdmin) {
            if (isDriver && !isDispatcher) {
              filters.deliveryFilter.driver_id = currentUser.id;
            }
          }

          if (selectedDriverId && selectedDriverId !== 'all') {
            filters.deliveryFilter.driver_id = selectedDriverId;
          }

          // Force refresh all entities by passing isEntityUpdating=false
          const updates = await smartRefreshManager.performSmartRefresh(currentData, filters, false);
          if (updates) {
            console.log(`✅ [Layout] Page navigation refresh complete - updated ${Object.keys(updates).length} data types`);
            updateAppDataState(updates);

            // Notify map of updates
            if (onSmartRefreshCompleteRef.current) {
              onSmartRefreshCompleteRef.current();
            }
          } else {
            console.log(`✅ [Layout] Page navigation refresh complete - no updates needed`);
          }

          setSmartRefreshActivity({ active: false, updatedEntities: updates ? Object.keys(updates) : [] });
        } catch (error) {
          console.error('🛑 [Layout] Page change refresh error:', error);
          setSmartRefreshActivity({ active: false, updatedEntities: [] });
        }
      };

      performPageChangeRefresh();
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

  const handleTouchStart = (e) => {
    if (!isMobile || isRefreshing) return;

    const mainContent = document.querySelector('main');
    if (mainContent && mainContent.scrollTop === 0) {
      setTouchStartY(e.touches[0].clientY);
      setIsPulling(true);
    }
  };

  const handleTouchMove = (e) => {
    if (!isPulling || !isMobile || isRefreshing) return;

    const touchY = e.touches[0].clientY;
    const distance = touchY - touchStartY;

    if (distance > 0) {
      e.preventDefault();

      const resistance = 0.5;
      const resistedDistance = Math.min(distance * resistance, pullThreshold * 1.5);
      setPullDistance(resistedDistance);
    }
  };

  const handleTouchEnd = async () => {
    if (!isPulling || !isMobile) return;

    setIsPulling(false);

    if (pullDistance >= pullThreshold) {
      setIsRefreshing(true);

      // CRITICAL: Trigger polyline update BEFORE reload
      console.log('🔄 [Pull-to-Refresh] Triggering polyline update...');
      try {
        const selectedDateStr = globalFilters.getSelectedDate();
        const selectedDriverId = globalFilters.getSelectedDriverId();

        // Only update polyline if we have a valid driver selected
        if (selectedDriverId && selectedDriverId !== 'all') {
          await updatePolylineOnRefresh(selectedDriverId, selectedDateStr);
        }
      } catch (error) {
        console.error('❌ [Pull-to-Refresh] Polyline update failed:', error);
      }

      setTimeout(() => {
        window.location.reload();
      }, 300);
    } else {
      setPullDistance(0);
    }
  };

  const updatePolylineOnRefresh = async (driverId, dateStr) => {
    if (!driverId || driverId === 'all') return;

    try {
      const deliveryDate = dateStr || format(new Date(), 'yyyy-MM-dd');

      // Get driver's current location
      const appUsers = await base44.entities.AppUser.filter({ user_id: driverId });
      const driverAppUser = appUsers?.[0];

      if (!driverAppUser?.current_latitude || !driverAppUser?.current_longitude) {
        console.log('⚠️ [Pull-to-Refresh] No driver GPS location available');
        return;
      }

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
    }
  };

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
    console.log('🎉 [Layout] === PHASE 6: CITY SELECTED FROM POPUP ===');
    console.log('🏙️ [Layout] Selected city:', cityId);

    try {
      globalFilters.setSelectedCityId(cityId);

      const today = new Date();
      globalFilters.setSelectedDate(today);
      console.log(`📅 [Layout] Set selectedDate to today: ${format(today, 'yyyy-MM-dd')}`);

      const refreshedUser = await getEffectiveUser();
      if (refreshedUser) {
        setCurrentUser(refreshedUser);

        // After city change, reset driver to 'all' - Dashboard will load from settings
        console.log('🎯 [Layout] City changed - resetting driver to "all" (Dashboard will override from settings)');
        globalFilters.setSelectedDriverId('all');
      }

      console.log('✅ [Layout] All global filters initialized after city selection');

      setShowCitySelectionPopup(false);

      console.log('🚪 [Layout] Setting initialGlobalFiltersSet gate to TRUE');
      setInitialGlobalFiltersSet(true);

      const isReady = globalFilters.isReadyForDataFetch();
      console.log(`🔍 [Layout] globalFilters.isReadyForDataFetch(): ${isReady}`);

      if (!isReady) {
        console.error('❌ [Layout] CRITICAL: Gate should be ready but isReadyForDataFetch() returned false!');
        globalFilters.debug();
      }

      console.log("✅ [Layout] === PHASE 6: CITY SELECTION COMPLETE ===");
    } catch (error) {
      console.error('❌ [Layout] Error handling city selection:', error);
      alert('Failed to save city selection. Please try again.');
      setShowCitySelectionPopup(true);
    }
  }, []);

  const triggerFullDataLoad = useCallback(async (forceRefresh = false) => {
    if (isFormOverlayOpen) {
      console.log('⏸️ [Layout] Form overlay is open, skipping data refresh');
      return;
    }

    if (triggerFullDataLoad.isRunning) {
      console.log('⏸️ [Layout] Data load already in progress, skipping...');
      return;
    }

    console.log("🚀 [Layout] === PHASE 3: STARTING FULL DATA LOAD ===");
    console.log("🔍 [Layout] Global filters state:", globalFilters.getAllFilters());

    triggerFullDataLoad.isRunning = true;

    try {
      const selectedCityId = globalFilters.getSelectedCityId();
      const selectedDateStr = globalFilters.getSelectedDate();
      const selectedDriverId = globalFilters.getSelectedDriverId();

      if (!currentUser || !selectedCityId || selectedCityId === 'waiting-for-selection') {
        console.warn('⚠️ [Layout] Cannot load full data: currentUser or selectedCityId is missing/pending.');
        setDataLoaded(false);
        return;
      }

      console.log(`📍 [Layout] Loading data for City: ${selectedCityId}, Driver: ${selectedDriverId}, Date: ${selectedDateStr}`);

      const selectedDate = selectedDateStr ? new Date(selectedDateStr + 'T00:00:00') : new Date();
      const selectedYear = selectedDate.getFullYear();

      console.log(`📅 [Layout] Starting sequential data loading with rate limit protection...`);
      console.log(`📋 [Layout] NEW Load order: AppUsers → Cities → Stores → Patients → Deliveries (selected date) → UI Render → Full Month Background`);
      console.log(`⏱️ [Layout] Adding 200ms delays between entity loads to prevent rate limits`);

      let workingCities = cities;
      const isAdmin = userHasRole(currentUser, 'admin');

      // Step 1: AppUsers
      const allAppUsers = await getData('AppUser', null, null, forceRefresh);
      console.log(`✅ [Layout] Step 1: Loaded ${allAppUsers.length} AppUsers`);
      await new Promise(resolve => setTimeout(resolve, 200));

      // Step 2: Cities
      if (!workingCities || workingCities.length === 0) {
        workingCities = await City.list();
        workingCities.sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
        setCities(workingCities);
        console.log(`✅ [Layout] Step 2: Loaded ${workingCities.length} Cities`);
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // Step 3: Stores
      const allStores = await getData('Store', null, null, forceRefresh);
      allStores.sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
      console.log(`✅ [Layout] Step 3: Loaded ${allStores.length} Stores`);
      await new Promise(resolve => setTimeout(resolve, 200));

      // Step 4: Patients (NO FILTER - dispatchers need all patient coords for map markers)
      const patientsData = await getData('Patient', null, null, forceRefresh);
      setPatients(patientsData);
      console.log(`✅ [Layout] Step 4: Loaded ${patientsData.length} Patients (all - needed for map coordinates)`);
      await new Promise(resolve => setTimeout(resolve, 200));

      // Step 5: Deliveries - CRITICAL: Load ALL drivers for selected city
      // Build city store filter (ALWAYS used to restrict to selected city)
      let cityStoreFilter = {};
      const cityStoreIds = allStores.map(s => s?.id).filter(Boolean);
      if (cityStoreIds.length > 0) {
        cityStoreFilter.store_id = { $in: cityStoreIds };
      }

      // CRITICAL: For past 30 days data, load ALL drivers in city (no role filtering)
      // This allows dispatchers to see historical data for all drivers
      let backgroundFilter = { ...cityStoreFilter };

      await loadDeliveries(
        selectedDateStr,
        cityStoreFilter, // PRIORITY: ALL drivers for selected city (today + next 7 days)
        backgroundFilter, // BACKGROUND: Role-filtered past data
        forceRefresh,
        // Initial load callback (selected date + next 7 days for ALL drivers)
        (initialDeliveries) => {
          console.log(`⚡ [Layout] Step 5a: Initial UI update with ${initialDeliveries.length} deliveries for ${selectedDateStr}`);
          setDeliveries(initialDeliveries);

          // Update patient cache with missing patients from deliveries
          const patientIdsInDeliveries = [...new Set(initialDeliveries.filter(d => d?.patient_id).map(d => d.patient_id))];
          const existingPatientIds = new Set(patientsData.map(p => p.id));
          const missingPatientIds = patientIdsInDeliveries.filter(pId => !existingPatientIds.has(pId));

          if (missingPatientIds.length > 0) {
            console.log(`⚡ [Layout] Fetching ${missingPatientIds.length} missing patients...`);
            Patient.filter({ id: { $in: missingPatientIds } }).then(newPatients => {
              setPatients(prev => [...prev, ...newPatients]);
              console.log(`✅ [Layout] Added ${newPatients.length} missing patients`);
            }).catch(err => {
              console.warn('⚠️ [Layout] Error fetching missing patients:', err);
            });
          }

          // UI is ready to render
          setDataLoaded(true);
          console.log(`✅ [Layout] === UI READY - Dashboard can render ===`);
        },
        // Background full month callback
        (fullMonthDeliveries) => {
          console.log(`🔄 [Layout] Step 5b: Background merge of ${fullMonthDeliveries.length} full month deliveries`);
          setDeliveries(prevDeliveries => {
            const map = new Map();
            fullMonthDeliveries.forEach(d => map.set(d.id, d));
            prevDeliveries.forEach(d => map.set(d.id, d)); // Selected date takes priority
            return Array.from(map.values());
          });
          console.log(`✅ [Layout] Background: Full month merged`);
        }
      );

      await new Promise(resolve => setTimeout(resolve, 200));

      // Step 6: Users (admin only)
      let authUsersData = [];
      if (userHasRole(currentUser, 'admin')) {
        authUsersData = await getData('User', null, null, forceRefresh);
        console.log(`✅ [Layout] Step 6: Loaded ${authUsersData.length} Users`);
      } else {
        console.log(`ℹ️ [Layout] Step 6: Skipping User.list() - non-admin`);
      }
      await new Promise(resolve => setTimeout(resolve, 200));

      console.log('🔀 [Layout] Building merged user list from AppUsers and currentUser...');
      const mergedUsersMap = new Map();

      // Add current user first
      if (currentUser) {
        mergedUsersMap.set(currentUser.id, currentUser);
      }

      // For admins: merge authUsers with appUsers
      if (authUsersData.length > 0) {
        authUsersData.forEach(authUser => {
          if (!authUser) return;
          const appUser = allAppUsers.find(au => au && au.user_id === authUser.id);
          const merged = createMergedUser(authUser, appUser);
          if (merged) {
            mergedUsersMap.set(merged.id, merged);
          }
        });
      } else {
        // For non-admins: create users from AppUser data only
        allAppUsers.forEach(appUser => {
          if (!appUser || mergedUsersMap.has(appUser.user_id)) return;
          const pseudoUser = createMergedUser(null, appUser);
          if (pseudoUser) {
            mergedUsersMap.set(pseudoUser.id, pseudoUser);
          }
        });
      }

      const mergedUsers = Array.from(mergedUsersMap.values()).filter(Boolean);
      console.log(`✅ [Layout] Merged ${mergedUsers.length} users`);

      // Get ALL active drivers - no geographic filtering
      let activeDrivers = mergedUsers.filter(user => {
        if (!user || !user.app_roles || !Array.isArray(user.app_roles)) return false;
        if (!user.app_roles.includes('driver') && !user.app_roles.includes('admin')) return false;
        if (!user.user_name) return false;
        if (user.status !== 'active') return false;
        return true;
      });
      activeDrivers = sortUsers(activeDrivers);
      console.log(`✅ [Layout] Populated ${activeDrivers.length} active drivers`);


      console.log('💾 [Layout] Updating Layout state (users, drivers, stores, appUsers)...');
      setUsers(mergedUsers);
      setDrivers(activeDrivers);
      setStores(allStores);
      setAppUsers(allAppUsers);

      console.log("✅ [Layout] === PHASE 3: ALL DATA LOAD COMPLETE ===")

      } catch (error) {
      console.error("❌ [Layout] Error during full data load:", error);
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
      }, [currentUser, isFormOverlayOpen]);

  useEffect(() => {
    if (!initialGlobalFiltersSet || !currentUser) {
      console.log('⏸️ [Layout] Waiting for initial filters or currentUser to be ready...');
      return;
    }

    const isReady = globalFilters.isReadyForDataFetch();

    if (!isReady) {
      console.log('⏸️ [Layout] Global filters not ready for data fetch yet');
      return;
    }

    console.log('✅ [Layout] Gate is open - triggering full data load');
    const forceRefresh = needsDataReload.current;
    if (forceRefresh) {
      console.log('🔄 [Layout] Force refresh requested due to currentUser change');
      needsDataReload.current = false;
    }
    triggerFullDataLoad(forceRefresh);

  }, [initialGlobalFiltersSet, currentUser, triggerFullDataLoad]);

  useEffect(() => {
    if (!dataLoaded) {
      console.log('⏸️ [Layout] Data not yet loaded, skipping filter change reload');
      return;
    }

    const unsubscribe = globalFilters.subscribe((newFilters) => {
      console.log('🔄 [Layout] Global filters changed:', newFilters);

      // CRITICAL: Don't reload data on date/driver changes - Dashboard filters deliveries locally
      // Only reload on CITY changes which require fresh store/patient data
      if (globalFilters.isReadyForDataFetch()) {
        console.log('⏭️ [Layout] Filter change detected - letting Dashboard handle local filtering (no full reload)');
      }
    });

    return unsubscribe;
  }, [dataLoaded, triggerFullDataLoad]);

  const filteredDeliveries = useMemo(() => {
    if (!deliveries.length || !currentUser) return [];
    let data = deliveries.filter(delivery => delivery);

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
    let data = patients.filter(patient => patient);

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
      // Dispatchers: only count routes for their assigned stores
      const dispatcherStoreIds = new Set(currentUser.store_ids || []);
      relevantDeliveries = deliveries.filter(d => d && dispatcherStoreIds.has(d.store_id));
    } else if (userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin')) {
      // Drivers: only count their own routes
      relevantDeliveries = deliveries.filter(d => d && d.driver_id === currentUser.id);
    }
    
    // For each date in the selected month, count unique drivers
    const dateDriverMap = new Map();
    
    relevantDeliveries.forEach(delivery => {
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
    dateDriverMap.forEach(driverSet => {
      totalRoutes += driverSet.size;
    });
    
    return totalRoutes;
  }, [deliveries, currentUser]);

  const getPatientStoreData = useCallback(() => {
    if (!stores.length || !filteredPatients.length) return [];
    const sortedStores = [...stores].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
    return sortedStores.map((store) => ({
      ...store,
      patientCount: filteredPatients.filter((p) => p && p.store_id === store.id).length
    }));
  }, [stores, filteredPatients]);

  const getLatestDateWithDeliveries = useCallback((driverId = null) => {
    let relevantDeliveries = filteredDeliveries.filter(delivery => delivery);
    if (driverId) {
      const driver = users.find((u) => u && u.id === driverId);
      if (driver) {
        relevantDeliveries = relevantDeliveries.filter((delivery) => delivery && delivery.driver_id === driver.id);
      }
    }

    if (!relevantDeliveries || relevantDeliveries.length === 0) {
      return format(new Date(), 'yyyy-MM-dd');
    }

    const dates = [...new Set(relevantDeliveries.filter(delivery => delivery && delivery.delivery_date).map((delivery) => delivery.delivery_date))];
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
        // CRITICAL: Filter storeIds based on user role
        let filteredStoreIds = [];

        if (userHasRole(currentUser, 'admin')) {
          // Admins see all stores in selected city
          filteredStoreIds = stores.map(s => s?.id).filter(Boolean);
        } else if (userHasRole(currentUser, 'dispatcher')) {
          // Dispatchers see only their assigned stores
          filteredStoreIds = (currentUser.store_ids || []).filter(Boolean);
        } else if (userHasRole(currentUser, 'driver')) {
          // Drivers see stores where they have deliveries
          const driverStoreIds = new Set(
            deliveries
              .filter(d => d && d.driver_id === currentUser.id)
              .map(d => d.store_id)
              .filter(Boolean)
          );
          filteredStoreIds = Array.from(driverStoreIds);
        }

        const response = await base44.functions.invoke('getDeliveryStats', {
          selectedDate: globalFilters.getSelectedDate() || format(new Date(), 'yyyy-MM-dd'),
          driverId: userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin') ? currentUser.id : null,
          storeIds: filteredStoreIds.length > 0 ? filteredStoreIds : null
        });

        // Handle both response.data (axios-style) and direct response
        const data = response?.data || response;

        console.log('📊 [NavStats] Parsed data:', data);

        // FIXED: Map the backend response structure correctly
        if (data?.deliveries && data?.drivers) {
          setRouteCounts({
            monthly: data.deliveries.monthly,
            yearly: data.deliveries.yearly
          });
          console.log('✅ [NavStats] Route counts updated:', { monthly: data.deliveries.monthly, yearly: data.deliveries.yearly });
        }
        if (data?.entityCounts) {
          setEntityCounts(data.entityCounts);
          console.log('✅ [NavStats] Entity counts updated:', data.entityCounts);
        }
      } catch (error) {
        console.error('❌ [NavStats] Error:', error.message);
      }
    };

    const timer = setTimeout(fetchStats, 2000);
    const interval = setInterval(fetchStats, 300000);

    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [currentUser, dataLoaded, stores, deliveries]);

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
        title: 'Users',
        pageName: 'AppUsers',
        count: entityCounts.users,
        url: createPageUrl("AppUsers"),
        icon: Users2
      }];



    if (realUser && canAccessImports(realUser)) {
      items.push({
        title: "Admin Utilities",
        pageName: 'AdminUtilities',
        url: createPageUrl("AdminUtilities"),
        icon: BarChart3
      });
    }
    return items;
  }, [entityCounts.cities, entityCounts.stores, entityCounts.users, realUser]);

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
      const latestDate = getLatestDateWithDeliveries();
      url.searchParams.set("date", latestDate);
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
        html, body {
          font-size: 15px;
          margin: 0;
          padding: 0;
          height: 100vh;
          height: 100dvh;
          width: 100vw;
          overflow: hidden;
          overscroll-behavior: none;
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
          background: #f8fafc;
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

        @media (max-width: 1023px) {
          .mobile-header {
            display: flex !important;
            position: sticky;
            top: 0;
            z-index: 10001 !important;
            background: white;
            border-bottom: 1px solid #e2e8f0;
          }

          main {
            overflow-y: auto !important;
            overflow-x: hidden !important;
            flex: 1;
          }

          .app-sidebar {
            position: fixed !important;
            left: 0 !important;
            top: 0 !important;
            bottom: 0 !important;
            width: 280px !important;
            max-width: 80vw !important;
            z-index: 10000 !important;
            transform: translateX(-100%) !important;
            transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
            background: white !important;
            box-shadow: 4px 0 12px rgba(0, 0, 0, 0.15) !important;
            flex-shrink: 0 !important;
          }

          .app-sidebar.sidebar-open {
            transform: translateX(0) !important;
            box-shadow: 4px 0 12px rgba(0, 0, 0, 0.15) !important;
          }

          .main-content-area {
            width: 100vw !important;
            flex: 1 !important;
            display: flex !important;
            flex-direction: column !important;
            overflow: hidden !important;
          }
        }

        @media (min-width: 1024px) {
          .mobile-header {
            display: none !important;
          }

          .app-sidebar {
            position: relative !important;
            transform: none !important;
            box-shadow: none !important;
            width: var(--sidebar-width) !important;
            min-width: 200px !important;
            max-width: 400px !important;
            flex: 0 0 var(--sidebar-width) !important;
            transition: none !important;
          }

          .main-content-area {
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

        .sidebar-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.5);
          z-index: 9999;
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

        ${Array.from({ length: 12 }, (_, i) => {
          const colors = [
            '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
            '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
            '#06b6d4', '#a855f7'];

          return `.store-color-${i} { color: ${colors[i]}; }`;
        }).join('\n')}
      `}</style>

      {showCitySelectionPopup && currentUser && cities && cities.length > 0 && (
        <CitySelectionPopup
          cities={cities}
          currentUser={currentUser}
          onCitySelected={handleCitySelected}
        />
      )}

      {showPatientImport && (
                      <PatientImport
                        onClose={() => {
                          setShowPatientImport(false);
                          setIsFormOverlayOpen(false);
                        }}
                        onImportStart={() => {
                          console.log('⏸️ [Layout] Pausing smart refresh for patient import...');
                          setIsFormOverlayOpen(true);
                        }}
                        onImportComplete={async () => {
                                                        setShowPatientImport(false);
                                                        setIsFormOverlayOpen(false);
                                                        console.log('▶️ [Layout] Resuming smart refresh after patient import');
                                                        // Background refresh - invalidate cache and fetch fresh data without full reload
                                                        invalidate('Patient');
                                                        const freshPatients = await getData('Patient', null, null, true);
                                                        setPatients(freshPatients);
                                                        console.log('✅ [Layout] Patient import complete - background refreshed', freshPatients.length, 'patients');
                                                        // Trigger stats refresh
                                                        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
                                                      }}
                      />
                    )}

      {showMessaging && (
                    <MessagingPanel
                      currentUser={currentUser}
                      users={users}
                      onClose={() => {
                        setShowMessaging(false);
                        setInitialConversation(null);
                      }}
                      initialConversation={initialConversation}
                      onUnreadCountChange={setUnreadMessageCount}
                    />
                  )}
                  
                  {/* Message Notification Balloon */}
                  {currentUser && !showMessaging && (
                    <MessageNotificationBalloon
                      currentUser={currentUser}
                      onOpenConversation={(conversationId, otherUserId, otherUserName) => {
                        setInitialConversation({ conversationId, otherUserId, otherUserName });
                        setShowMessaging(true);
                        setUnreadMessageCount(0);
                      }}
                    />
                  )}

                  {showDeliveryImport && (
                                            <RouteImport
                                  onCancel={() => {
                                    setShowDeliveryImport(false);
                                    setIsFormOverlayOpen(false);
                                    // Clean up global callback
                                    if (typeof window !== 'undefined') {
                                      delete window.__routeImportStartCallback;
                                    }
                                  }}
                                  ref={() => {
                                    // Set up global callback for RouteImport to call
                                    if (typeof window !== 'undefined') {
                                      window.__routeImportStartCallback = () => {
                                        console.log('⏸️ [Layout] Pausing smart refresh for route import...');
                                        setIsFormOverlayOpen(true);
                                      };
                                    }
                                  }}
                                  onImportComplete={async () => {
                                                                                                        setShowDeliveryImport(false);
                                                                                                        setIsFormOverlayOpen(false);
                                                                                                        // Clean up global callback
                                                                                                        if (typeof window !== 'undefined') {
                                                                                                          delete window.__routeImportStartCallback;
                                                                                                        }
                                                                                                        console.log('▶️ [Layout] Resuming smart refresh after route import');
                                                                                                        // Background refresh - invalidate cache and fetch fresh data without full reload
                                                                                                        console.log('🔄 [Layout] Route import complete - triggering full data refresh...');
                                                                                                        invalidate('Delivery');
                                                                                                        invalidate('Patient');
                                                                                                        await triggerFullDataLoad(true);
                                                                                                        console.log('✅ [Layout] Route import complete - full data refreshed');
                                                                                                        // Trigger stats refresh
                                                                                                        window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
                                                                                                      }}
                        stores={stores}
                        allUsers={users}
                        currentUser={currentUser}
                        allDeliveries={deliveries}
                      />
                    )}

      {isLoadingLayout ? (
        <div className="h-screen flex items-center justify-center bg-slate-50">
          <div className="text-center">
            <div className="animate-spin w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full mx-auto mb-4"></div>
            <p className="text-slate-600 text-lg font-medium">Loading RxDeliver...</p>
          </div>
        </div>
      ) : !hasAccess || !currentUser ? (
        <div className="h-screen flex items-center justify-center bg-slate-50">
          <div className="text-center p-8">
            <h2 className="2xl font-bold text-slate-900 mb-4">RxDeliver</h2>
            <p className="text-slate-600 mb-6">Redirecting to login...</p>
            <p className="text-sm text-slate-500">If you're not redirected automatically, please refresh the page.</p>
          </div>
        </div>
      ) : (
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
              refreshData: triggerFullDataLoad,
              updateDeliveriesLocally: updateDeliveriesLocally,
              isFormOverlayOpen: isFormOverlayOpen,
              setIsFormOverlayOpen: setIsFormOverlayOpen,
              isEntityUpdating: isEntityUpdating,
              setIsEntityUpdating: setIsEntityUpdating,
              smartRefreshActivity: smartRefreshActivity,
              setSmartRefreshActivity: setSmartRefreshActivity,
              setOnSmartRefreshComplete: (callback) => { onSmartRefreshCompleteRef.current = callback; },
              // Data is already loaded from last 30 days - Dashboard filters locally
              dataReadyForSelectedDate: dataLoaded
              }}>
            <div className="app-container">
              {isMobile && sidebarOpen &&
                <div
                  className="sidebar-overlay"
                  onClick={() => setSidebarOpen(false)} />
              }

              {/* Sidebar */}
              <div className={`app-sidebar ${sidebarOpen ? 'sidebar-open' : ''} border-r border-slate-200 bg-white flex flex-col z-[200]`}>
                <div className="border-b border-slate-100 p-4 flex-shrink-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      {/* Mobile close button - only show when sidebar is open */}
                      {isMobile && sidebarOpen && (
                        <button
                          onClick={() => setSidebarOpen(false)}
                          className="lg:hidden p-2 hover:bg-slate-100 rounded-lg transition-colors">
                          <X className="w-5 h-5 text-slate-700" />
                        </button>
                      )}

                      <img
                        src="/app-logo.png"
                        alt="RxDeliver"
                        className="w-10 h-10 rounded object-contain"
                        onError={(e) => {
                          e.currentTarget.src = 'https://cdn-icons-png.flaticon.com/512/3843/3843479.png';
                          e.currentTarget.onerror = null;
                        }} />

                      <div>
                        <h2 className="font-bold text-lg text-slate-900">RxDeliver</h2>
                        <p className="text-xs text-slate-500">Pharmacy Logistics</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">

                      {/* --- PHASE 4: SUBTLE SETTINGS MENU (DESKTOP) --- */}
                      {/* Only show if at least one menu item is visible */}
                      {!sidebarOpen && userHasRole(currentUser, 'admin') && cities && cities.length > 0 && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                              <MoreVertical className="w-4 h-4 text-slate-500" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-56 z-[10000]">
                            <DropdownMenuLabel>Settings</DropdownMenuLabel>
                            <DropdownMenuSeparator />

                            {/* Import Buttons - App Owner Only */}
                            {realUser && isAppOwner(realUser) && (
                              <>
                                <DropdownMenuItem onClick={() => setShowPatientImport(true)} className="cursor-pointer">
                                  <FileText className="w-4 h-4 mr-2" />
                                  Patient Import
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => setShowDeliveryImport(true)} className="cursor-pointer">
                                  <FileText className="w-4 h-4 mr-2" />
                                  Delivery Import
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                              </>
                            )}

                            {/* City Filter - Admin Only */}
                            {userHasRole(currentUser, 'admin') && cities && cities.length > 0 && (
                              <div className="px-2 py-2">
                                <label className="text-xs font-medium text-slate-700 mb-1.5 block">
                                  City Filter
                                </label>
                                <Select
                                  value={globalFilters.getSelectedCityId()}
                                  onValueChange={(cityId) => {
                                    console.log('🏙️ [Layout] Admin changed city filter to:', cityId);
                                    globalFilters.setSelectedCityId(cityId);
                                  }}
                                >
                                  <SelectTrigger className="w-full bg-white border-slate-300 h-9">
                                    <SelectValue placeholder="Select city..." />
                                  </SelectTrigger>
                                  <SelectContent className="max-h-[300px] overflow-y-auto z-[10002]">
                                    {cities.map((city) => (
                                      <SelectItem key={city.id} value={city.id}>
                                        {city.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-3 custom-scrollbar">
                  <div className="">
                    <Link
                      to={constructUrlWithParams("Dashboard")}
                      onClick={() => setSidebarOpen(false)}
                      className={`${
                        currentPageName === 'Dashboard' ?
                          'bg-slate-100 text-slate-900 shadow-sm' :
                          'text-slate-600 hover:bg-slate-50 hover:text-slate-900'} mb-1 px-4 py-1 rounded-xl flex items-center gap-3 transition-all duration-200`
                      }>
                      <LayoutDashboard className="w-5 h-5" />
                      <span className="font-semibold">Dashboard</span>
                    </Link>

                    <div className="border-t border-slate-200 my-2"></div>

                    {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) &&
                      <Link
                        to={createPageUrl('Patients')}
                        onClick={() => setSidebarOpen(false)}
                        className={`${
                          currentPageName === 'Patients' ?
                            'bg-slate-100 text-slate-900 shadow-sm' :
                            'text-slate-600 hover:bg-slate-50 hover:text-slate-900'} mb-1 px-4 py-1 rounded-xl flex items-center gap-3 transition-all duration-200`
                        }>
                        <Users className="w-5 h-5" />
                        <span className="font-semibold">Patients</span>
                        <Badge variant="secondary" className="ml-auto bg-slate-200 text-slate-600 justify-center w-[45px] rounded-[10px]">{entityCounts.patients}</Badge>
                      </Link>
                    }

                    {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) &&
                      <Link
                        to={getRouteNavigationUrl('Deliveries')}
                        onClick={() => setSidebarOpen(false)}
                        className={`${
                          currentPageName === 'Deliveries' ?
                            'bg-slate-100 text-slate-900 shadow-sm' :
                            'text-slate-600 hover:bg-slate-50 hover:text-slate-900'} mb-1 px-4 py-1 rounded-xl flex items-center gap-3 transition-all duration-200`
                        }>
                        <Package className="w-5 h-5" />
                        <span className="font-semibold">Routes</span>
                        <Badge variant="secondary" className="ml-auto bg-slate-200 text-slate-600 justify-center w-[45px] rounded-[10px]">{totalRoutesCount}</Badge>
                      </Link>
                    }

                    {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) &&
                      <Link
                        to={constructUrlWithParams(createPageUrl("DeliveryMetrics"))}
                        onClick={() => setSidebarOpen(false)}
                        className={`${
                          currentPageName === 'DeliveryMetrics' ?
                            'bg-slate-100 text-slate-900 shadow-sm' :
                            'text-slate-600 hover:bg-slate-50 hover:text-slate-900'} mb-2 px-4 py-1 rounded-xl flex items-center gap-3 transition-all duration-200`
                        }>
                        <BarChart3 className="w-5 h-5" />
                        <span className="font-semibold">Route Metrics</span>
                      </Link>
                    }
                  </div>

                  {userHasRole(currentUser, 'admin') &&
                    <div className="mt-2">
                      <div className="border-t border-slate-200 mb-2"></div>
                      <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-3 py-1">
                        Admin
                      </div>
                      <div className="space-y-1">
                        {adminNavigationItems.map((item) =>
                          <Link
                            key={item.title}
                            to={constructUrlWithParams(item.url)}
                            onClick={() => setSidebarOpen(false)}
                            className={`${
                              currentPageName === item.pageName ?
                                'bg-slate-100 text-slate-900 shadow-sm' :
                                'text-slate-600 hover:bg-slate-50 hover:text-slate-900'} my-1 px-4 py-1 rounded-xl flex items-center gap-3 transition-all duration-200`
                            }>
                            {item.icon && <item.icon className="w-5 h-5" />}
                            <span className="font-semibold">{item.title}</span>
                            {item.count !== undefined && <Badge variant="secondary" className="ml-auto bg-slate-200 text-slate-600 justify-center w-[30px] rounded-[10px]">{item.count}</Badge>}
                          </Link>
                        )}
                      </div>
                    </div>
                  }

                  {currentPageName === 'Dashboard' &&
                    <div className="mt-2">
                      <div className="border-t border-slate-200 mb-2"></div>
                      <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-3 py-1">
                        Quick Stats
                      </div>
                      <QuickStats
                        currentUser={currentUser}
                        storeIds={stores.map(s => s?.id).filter(Boolean)} />

                    </div>
                  }
                </div>

                <div className="border-t border-slate-100 p-4 flex-shrink-0 bg-white">
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
                          <p className="font-semibold text-slate-900 text-sm truncate">
                            {getDriverDisplayName(currentUser)} {showWatermark && (<>[{deviceType} - {os}]</>)}
                          </p>
                          <p className="text-xs text-slate-500 truncate capitalize">
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
                        <button 
                              onClick={() => {
                                setShowMessaging(true);
                                setUnreadMessageCount(0);
                                setSidebarOpen(false); // Close sidebar when opening messages
                              }}
                              className="p-2 hover:bg-slate-100 rounded-lg transition-colors relative"
                              title="Messages"
                            >
                              <MessageCircle className="w-5 h-5 text-slate-500 hover:text-slate-700" fill={unreadMessageCount > 0 ? '#10b981' : 'none'} />
                              {unreadMessageCount > 0 && (
                                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-blue-500 text-xs font-bold rounded-full flex items-center justify-center px-1 border-2 border-white" style={{ color: '#ffffff' }}>
                                      {unreadMessageCount > 9 ? '9+' : unreadMessageCount}
                                    </span>
                              )}
                            </button>
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

                      <div className="flex gap-2 mt-3">
                          <Button
                          onClick={async () => {
                            if (window.confirm('Are you sure you want to log out?')) {
                              try {
                                sessionStorage.clear();
                                clearUserCache();
                                clearSettingsCache();
                                await User.logout();
                                window.location.href = '/';
                              } catch (error) {
                                console.error('Logout failed:', error);
                                sessionStorage.clear();
                                localStorage.clear();
                                window.location.href = '/';
                              }
                            }
                          }}
                          variant="outline"
                          className="flex-1 gap-2 text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
                        >
                          <LogOut className="w-4 h-4" />
                          Log Out
                        </Button>
                      </div>
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

              {/* Resizable Divider for Sidebar - Only on desktop */}
              {!isMobile &&
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
              <div className="main-content-area">
                {/* Smart Refresh Indicator - Fixed position on all pages except Dashboard */}
                {currentPageName !== 'Dashboard' && (
                  <div className="fixed bottom-4 right-4 z-[100]">
                    <SmartRefreshIndicator />
                  </div>
                )}

                <header
                  className="mobile-header border-b border-slate-200 bg-white px-4 py-3 sticky top-0"
                  onTouchStart={handleTouchStart}
                  onTouchMove={handleTouchMove}
                  onTouchEnd={handleTouchEnd}>

                  {(isPulling || isRefreshing) && pullDistance > 0 &&
                    <div
                      className="fixed left-0 right-0 flex justify-center items-center pointer-events-none"
                      style={{
                        top: `${Math.min(pullDistance + 10, pullThreshold + 30)}px`,
                        opacity: Math.min(pullDistance / pullThreshold, 1),
                        zIndex: 10000
                      }}>

                      <div className="bg-white rounded-full p-3 shadow-2xl border-2 border-emerald-500">
                        <RefreshCw
                          className={`w-6 h-6 text-emerald-600 ${
                            isRefreshing ? 'animate-spin' : ''}`
                          }
                          style={{
                            transform: !isRefreshing ? `rotate(${pullDistance * 3}deg)` : 'none'
                          }} />

                      </div>
                    </div>
                  }

                  <div className="flex items-center justify-between gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSidebarOpen(!sidebarOpen);
                      }}
                      className="p-2 hover:bg-slate-100 rounded-lg transition-colors">

                      {sidebarOpen ?
                        <X className="w-6 h-6 text-slate-700" /> :

                        <Menu className="w-6 h-6 text-slate-700" />
                      }
                    </button>

                    <div 
                      className="flex items-center gap-2 flex-shrink-0 relative cursor-pointer"
                      onClick={() => {
                        if (unreadMessageCount > 0) {
                          setShowMessaging(true);
                          setUnreadMessageCount(0);
                        }
                      }}
                    >
                      <img
                        src="/app-logo.png"
                        alt="RxDeliver"
                        className="w-8 h-8 rounded object-contain"
                        onError={(e) => {
                          e.currentTarget.src = 'https://cdn-icons-png.flaticon.com/512/3843/3843479.png';
                          e.currentTarget.onerror = null;
                        }} />
                      {unreadMessageCount > 0 && (
                        <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] bg-blue-500 text-xs font-bold rounded-full flex items-center justify-center px-1 border-2 border-white" style={{ color: '#ffffff' }}>
                          {unreadMessageCount > 9 ? '9+' : unreadMessageCount}
                        </span>
                      )}
                    </div>

                    <div className="flex-1"></div>

                        {/* --- PHASE 4: SUBTLE SETTINGS MENU (MOBILE) --- */}
                        {/* Only show if at least one menu item is visible */}
                        {userHasRole(currentUser, 'admin') && cities && cities.length > 0 && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm" className="h-9 w-9 p-0">
                            <MoreVertical className="w-5 h-5 text-slate-500" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56 z-[10000]">
                          <DropdownMenuLabel>Settings</DropdownMenuLabel>
                          <DropdownMenuSeparator />

                          {/* Import Buttons - App Owner Only */}
                          {realUser && isAppOwner(realUser) && (
                            <>
                              <DropdownMenuItem onClick={() => setShowPatientImport(true)} className="cursor-pointer">
                                <FileText className="w-4 h-4 mr-2" />
                                Patient Import
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setShowDeliveryImport(true)} className="cursor-pointer">
                                <FileText className="w-4 h-4 mr-2" />
                                Delivery Import
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                            </>
                          )}

                          {/* City Filter - Admin Only */}
                          {userHasRole(currentUser, 'admin') && cities && cities.length > 0 && (
                            <div className="px-2 py-2">
                              <label className="text-xs font-medium text-slate-700 mb-1.5 block">
                                City Filter
                              </label>
                              <Select
                                value={globalFilters.getSelectedCityId()}
                                onValueChange={(cityId) => {
                                  console.log('🏙️ [Layout] Admin changed city filter (mobile) to:', cityId);
                                  globalFilters.setSelectedCityId(cityId);
                                }}
                              >
                                <SelectTrigger className="w-full bg-white border-slate-300 h-9">
                                  <SelectValue placeholder="City" />
                                </SelectTrigger>
                                <SelectContent className="max-h-[300px] overflow-y-auto z-[10002]">
                                  {cities.map((city) => (
                                    <SelectItem key={city.id} value={city.id}>
                                      {city.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>

                  {/* Driver Status Toggle - Centered in Mobile Header - Only on mobile */}
                  {isMobile && currentUser && userHasRole(currentUser, 'driver') && (
                    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
                      <DriverStatusToggle 
                        currentUser={currentUser}
                        onStatusChange={async (newStatus) => {
                          console.log('Driver status changed to:', newStatus);
                          // Refresh user data to sync location tracking toggle
                          clearUserCache();
                          const refreshedUser = await getEffectiveUser();
                          if (refreshedUser) {
                            setCurrentUser(refreshedUser);
                          }
                        }}
                      />
                    </div>
                  )}

                  {currentUser &&
                    <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-3">
                      <div className="flex flex-col items-center gap-1">
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center relative flex-shrink-0 ${
                          userHasRole(currentUser, 'admin') ?
                            'bg-gradient-to-br from-blue-500 to-blue-600' :
                            userHasRole(currentUser, 'dispatcher') ?
                              'bg-gradient-to-br from-red-500 to-red-600' :
                              userHasRole(currentUser, 'driver') ?
                                'bg-gradient-to-br from-emerald-500 to-emerald-600' :
                                'bg-gradient-to-br from-gray-400 to-gray-500'
                          }`
                        }>
                          <span className="text-white font-bold text-sm">
                            {(getDriverDisplayName(currentUser) || 'U')?.charAt(0)}
                          </span>
                        </div>
                        <span className="text-xs font-medium text-slate-700 whitespace-nowrap">
                          {getDriverDisplayName(currentUser)}
                        </span>
                      </div>
                    </div>
                  }
                </header>

                <main className="flex-1 overflow-y-auto bg-slate-50 relative">
                  {children}
                </main>
              </div>
            </div>
          </AppDataProvider>
        </UserProvider>
      )}
    </ErrorBoundary>
  );
}