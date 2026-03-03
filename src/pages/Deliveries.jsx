import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { Delivery } from "@/entities/Delivery";
import { Patient } from "@/entities/Patient";
import { Store } from "@/entities/Store";
import { City } from "@/entities/City";
import { User } from "@/entities/User";
import { AppUser } from "@/entities/AppUser";
import { format, startOfDay, addDays, subDays, isSameDay, isToday, parseISO } from 'date-fns';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Calendar as CalendarIcon,
  Clock,
  Truck,
  Map as MapIcon,
  MapPin,
  Package,
  Plus,
  ChevronLeft,
  ChevronRight,
  Filter,
  X as XIcon,
  Navigation,
  Home,
  Building2,
  User as UserIcon,
  Phone,
  Search,
  StickyNote,
  CheckCircle,
  XCircle,
  AlertCircle,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  MoreVertical,
  Eye,
  Pencil,
  Trash2,
  Copy,
  FileDown,
  FileUp,
  Settings,
  List,
  LayoutGrid,
  Download,
  Upload,
  RotateCcw,
  GripVertical } from
"lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { getEffectiveUser, isUserDataAvailable } from "../components/utils/auth";
import StopCard from "../components/common/StopCard";
import RouteImport from "../components/deliveries/RouteImport";
import ExportRouteButton from "../components/deliveries/ExportRouteButton";
import DeliveryForm from "../components/deliveries/DeliveryForm";
import DeliveryDetails from "../components/deliveries/DeliveryDetails";
import PatientForm from "../components/patients/PatientForm";
import DateListPanel from "../components/deliveries/DateListPanel";
import { getData, invalidate } from '../components/utils/dataManager';

import { getDriverDisplayName, getDriverNameForStorage, findDriverByName } from '../components/utils/driverUtils';
import { useAutoRefresh } from '../components/utils/useAutoRefresh';
import { sortUsers } from '../components/utils/sorting';
import DeleteConfirmDialog from "../components/deliveries/DeleteConfirmDialog";
import RouteMapView from "../components/deliveries/RouteMapView";
import { debounce } from 'lodash';
import { globalFilters } from "../components/utils/globalFilters";
import { userHasRole, isAppOwner, canAccessImports } from '../components/utils/userRoles';
import { formatPhoneNumber } from "../components/utils/phoneFormatter";
import { useUser } from '../components/utils/UserContext';
import { isMobileDevice } from "../components/utils/deviceUtils";
import { useAppData } from '../components/utils/AppDataContext';
import { smartRefreshManager } from '../components/utils/smartRefreshManager';
import { updateDeliveryLocal, deleteDeliveryLocal, createDeliveryLocal, batchDeleteDeliveriesLocal } from '../components/utils/entityMutations';
import SmartRefreshIndicator from '../components/layout/SmartRefreshIndicator';
import StopDetailsPanel from '../components/deliveries/StopDetailsPanel';
import DeliveryListView from '../components/dashboard/DeliveryListView';

const addMinutesToTime = (timeString, minutesToAdd) => {
  if (!timeString) return null;
  const [hours, minutes] = timeString.split(':').map(Number);
  if (isNaN(hours) || isNaN(minutes)) return timeString;
  const total = hours * 60 + minutes + minutesToAdd;
  const newH = Math.floor(total / 60) % 24;
  const newM = total % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
};

const estimateDriveTimeMinutes = (lat1, lng1, lat2, lng2) => {
  if (!lat1 || !lng1 || !lat2 || !lng2) return 10;
  const toRad = (v) => v * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
  Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
  Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanceKm = R * c;
  return Math.max(5, Math.min(Math.round(distanceKm / 30 * 60), 60));
};

const statusConfig = {
  pending: { color: 'bg-yellow-100 text-yellow-800', label: 'Pending' },
  'Ready For Pickup': { color: 'bg-blue-100 text-blue-800', label: 'Ready For Pickup' },
  picked_up: { color: 'bg-purple-100 text-purple-800', label: 'Picked Up' },
  in_transit: { color: 'bg-purple-100 text-purple-800', label: 'In Transit' },
  completed: { color: 'bg-emerald-100 text-emerald-800', label: 'Completed' },
  failed: { color: 'bg-red-100 text-red-800', label: 'Failed' },
  cancelled: { color: 'bg-slate-100 text-slate-800', label: 'Cancelled' },
  returned: { color: 'bg-orange-100 text-orange-800', label: 'Returned' },
  projected: { color: 'bg-gray-100 text-gray-700', label: 'Projected' }
};

export default function DeliveriesPage() {
  const location = useLocation();
  const navigate = useNavigate();

  const {
    deliveries: contextDeliveries = [],
    patients: contextPatients = [],
    stores: contextStores = [],
    drivers: contextDrivers = [],
    users: contextUsers = [],
    cities: contextCities = [],
    isDataLoaded: contextDataLoaded,
    updateDeliveriesLocally,
    setIsEntityUpdating
  } = useAppData();

  const [allDeliveries, setAllDeliveries] = useState([]);
  const [allPatients, setAllPatients] = useState([]);
  const [stores, setStores] = useState([]);
  const [cities, setCities] = useState([]);
  const [freshAppUsers, setFreshAppUsers] = useState([]);

  const [currentUser, setCurrentUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [hasAccess, setHasAccess] = useState(false);

  const [showImportModal, setShowImportModal] = useState(false);
  const [allUsers, setAllUsers] = useState([]);

  const [dataLoaded, setDataLoaded] = useState(false);

  const [showDeliveryForm, setShowDeliveryForm] = useState(false);
  const [editingDelivery, setEditingDelivery] = useState(null);
  const [editingPatient, setEditingPatient] = useState(null);

  const [selectedDate, setSelectedDate] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [driverFilter, setDriverFilter] = useState('all');
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth());
  const [selectedOverviewYear, setSelectedOverviewYear] = useState('all');
  const [selectedCityId, setSelectedCityId] = useState('all');

  const isMobile = useMemo(() => isMobileDevice(), []);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [selectedDeliveryId, setSelectedDeliveryId] = useState(null);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);

  // Check if bottom nav is visible (matches Layout.js logic)
  const isBottomNavVisible = isMobile && !isMobileMenuOpen;

  const [showRouteMap, setShowRouteMap] = useState(false);

  const [activeDriver, setActiveDriver] = useState(null);
  const [isDriverOnline, setIsDriverOnline] = useState(false);
  const isMounted = useRef(false);
  const [viewMode, setViewModeState] = useState('list');

  // Track if this is initial page load (not refresh)
  const isInitialPageLoadRef = useRef(true);
  // Track previous mode to detect transition INTO Route Management
  const prevModeRef = useRef(null);

  // Wrap setViewMode to immediately persist and prevent re-renders
  const setViewMode = useCallback((mode) => {
    localStorage.setItem('rxdeliver_routes_view_mode', mode);
    setViewModeState(mode);
  }, []);

  // Count unique drivers with deliveries for dispatchers
  const uniqueDriversForDispatcher = useMemo(() => {
    if (!currentUser || !userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'admin')) {
      return null; // Not applicable
    }

    const dispatcherStoreIds = new Set(currentUser.store_ids || []);
    if (dispatcherStoreIds.size === 0) return null;

    const deliveriesToCheck = allDeliveries?.length > 0 ? allDeliveries : contextDeliveries;
    if (!deliveriesToCheck || deliveriesToCheck.length === 0) return null;

    // Find unique driver IDs with deliveries for dispatcher's stores
    const driverIds = new Set();
    deliveriesToCheck.forEach((d) => {
      if (d && d.store_id && dispatcherStoreIds.has(d.store_id) && d.driver_id) {
        driverIds.add(d.driver_id);
      }
    });

    return { count: driverIds.size, driverIds: Array.from(driverIds) };
  }, [currentUser, allDeliveries, contextDeliveries]);

  // Determine if we should show Driver Overview mode
  // - Drivers always bypass (go directly to their route)
  // - Dispatchers bypass if only 1 driver has deliveries for their stores
  // - Admins see Driver Overview when filter is 'all'
  const isDriverOverviewMode = useMemo(() => {
    if (driverFilter !== 'all') return false;

    // Drivers always bypass Driver Overview
    if (userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin') && !userHasRole(currentUser, 'dispatcher')) {
      return false;
    }

    // Dispatchers bypass if only 1 driver has deliveries for their stores
    if (userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
      if (uniqueDriversForDispatcher && uniqueDriversForDispatcher.count === 1) {
        return false;
      }
    }

    return true;
  }, [driverFilter, currentUser, uniqueDriversForDispatcher]);
  const [refreshKey, setRefreshKey] = React.useState(0);

  const lastLoadTime = useRef(0);
  const loadInProgress = useRef(0);
  const initialLoadDone = useRef(false);
  const yearAutoSelectDone = useRef(false);
  const yearManuallySelected = useRef(false);
  const skipContextSyncUntil = useRef(0);

  const checkAccess = useCallback(async () => {
    try {
      const user = await getEffectiveUser();
      if (!user) {
        console.log("❌ [Deliveries] No user found");
        setHasAccess(false);
        return false;
      }

      setCurrentUser(user);

      // Allow access for admin, dispatcher, and driver roles
      if (userHasRole(user, 'admin') || userHasRole(user, 'dispatcher') || userHasRole(user, 'driver')) {
        console.log("✅ [Deliveries] Access granted for role:", user.app_roles);
        setHasAccess(true);
        return true;
      }

      console.log("❌ [Deliveries] No valid role found");
      setHasAccess(false);
      return false;

    } catch (error) {
      console.error("❌ [Deliveries] Error checking access:", error);
      setHasAccess(false);
      return false;
    }
  }, [setHasAccess, setCurrentUser]);


  const loadData = useCallback(async (forceRefresh = false) => {
    const now = Date.now();
    const timeSinceLastLoad = now - lastLoadTime.current;

    if (!forceRefresh && timeSinceLastLoad < 2000 && loadInProgress.current > 0) {
      console.log(`🛑 [Deliveries] Blocked loadData - only ${timeSinceLastLoad}ms since last load, skipping...`);
      return;
    }

    if (loadInProgress.current > 0) {
      console.log('🛑 [Deliveries] Load already in progress (ref), skipping...');
      return;
    }

    if (isLoadingData && !forceRefresh) {
      console.log('🛑 [Deliveries] isLoadingData is true (state), skipping...');
      return;
    }

    console.log('🔄 [Deliveries] Starting loadData...', forceRefresh ? '(FORCE REFRESH)' : '');
    console.log(`🔍 [Deliveries] Mode: ${isDriverOverviewMode ? 'Driver Overview' : 'Route View'}, Year filter: ${selectedOverviewYear}`);

    loadInProgress.current = 1;
    lastLoadTime.current = now;
    setIsLoadingData(true);

    try {
      let user = currentUser;
      if (!user) {
        user = await getEffectiveUser();
        if (isMounted.current) {
          setCurrentUser(user);
        }
      }

      console.log('USER ROLE CHECK');
      console.log('User:', user?.user_name || user?.full_name);
      console.log('Platform role:', user?.role);
      console.log('App role:', user?.app_roles?.[0]);
      console.log('IS APP OWNER (dual admin):', isAppOwner(user));

      const [storesData, appUsersData, citiesData] = await Promise.all([
      getData('Store', '-created_date', null, forceRefresh),
      getData('AppUser', '-created_date', null, forceRefresh),
      getData('City', '-created_date', null, forceRefresh)]);

      if (isMounted.current) {
        setStores(storesData || []);
        setCities(citiesData || []);
      }

      let allAuthUsers = [];
      if (user?.role === 'admin' || isAppOwner(user)) {
        console.log('User is admin, fetching all User entities...');
        const usersData = await getData('User', '-created_date', null, forceRefresh);
        allAuthUsers = (usersData || []).filter((u) => u.role === 'admin' || u.role === 'user');
        console.log('Fetched User entities:', allAuthUsers.length);
      } else {
        console.log('User is not admin, skipping User.list()');
      }

      console.log('Filtering users from raw data:', {
        totalAuthUsers: allAuthUsers.length,
        totalAppUsers: (appUsersData || []).length
      });

      let mergedUsers = [];

      if (allAuthUsers.length > 0) {
        mergedUsers = allAuthUsers.map((authUser) => {
          const appUser = (appUsersData || []).find((au) => au.user_id === authUser.id);
          if (appUser) {
            return {
              ...authUser,
              ...appUser,
              id: authUser.id,
              appUserId: appUser.id,
              user_name: appUser.user_name || authUser.full_name,
              app_roles: appUser.app_roles || ['driver'],
              display_name: appUser.user_name || authUser.full_name,
              first_name: authUser.full_name.split(' ')[0]
            };
          }
          return {
            ...authUser,
            user_name: authUser.full_name,
            app_roles: ['driver'],
            display_name: authUser.full_name,
            first_name: authUser.full_name.split(' ')[0]
          };
        });
      } else {
        mergedUsers = (appUsersData || []).map((appUser) => {
          return {
            id: appUser.user_id,
            appUserId: appUser.id,
            email: `${appUser.user_name}@unknown.com`,
            full_name: appUser.user_name,
            role: 'user',
            ...appUser,
            user_name: appUser.user_name,
            app_roles: appUser.app_roles || ['driver'],
            display_name: appUser.user_name,
            first_name: appUser.user_name ? appUser.user_name.split(' ')[0] : ''
          };
        });
      }

      const preFilterCount = mergedUsers.length;
      mergedUsers = mergedUsers.filter((u) => {
        const userNameLower = (u.user_name || '').toLowerCase();
        const storePatterns = [
        '.shoppers',
        'shoppers.',
        '.pharmacy',
        'pharmacy.',
        'rite.choice',
        'rite-choice',
        'ritechoice'];

        const isStoreAccount = storePatterns.some((pattern) => userNameLower.includes(pattern));
        if (isStoreAccount) return false;

        const matchesStoreName = (storesData || []).some((store) => {
          const storeName = (store.name || '').toLowerCase();
          const storeAbbr = (store.abbreviation || '').toLowerCase();
          return userNameLower === storeName || userNameLower === storeAbbr;
        });
        return !matchesStoreName;
      });

      console.log('Filtered merged users:', {
        beforeFilter: preFilterCount,
        afterFilter: mergedUsers.length
      });

      mergedUsers = mergedUsers.filter((u) => {
        const roles = Array.isArray(u.app_roles) ? u.app_roles : u.app_role ? [u.app_role] : [];
        const hasRole = roles.some((r) => r === 'driver' || r === 'admin' || r === 'dispatcher');
        return hasRole;
      });

      if (isMounted.current) {
        setAllUsers(sortUsers(mergedUsers));
      }

      let deliveriesData = [];

      if (isDriverOverviewMode) {
        console.log('📋 [Deliveries] Loading Driver Overview - OFFLINE FIRST approach');

        // STEP 1: Load immediately from offline DB
        try {
          const { offlineDB: offlineDBInstance } = await import('../components/utils/offlineDatabase');
          const offlineDeliveries = await offlineDBInstance.getAll(offlineDBInstance.STORES.DELIVERIES);

          if (offlineDeliveries && offlineDeliveries.length > 0) {
            deliveriesData = offlineDeliveries;
            console.log(`✅ [Deliveries] Loaded ${deliveriesData.length} deliveries from offline DB (INSTANT)`);

            // Update UI immediately with cached data
            if (isMounted.current) {
              setAllDeliveries(deliveriesData);
            }
          }
        } catch (offlineError) {
          console.warn('⚠️ [Deliveries] Failed to load from offline DB:', offlineError);
        }

        // STEP 2: Start background sync from online DB (non-blocking)
        // CRITICAL: Age-based sync intervals - older data syncs less frequently
        const lastHistoricalSyncKey = 'lastHistoricalDeliveriesSyncTime';
        const lastSyncTime = localStorage.getItem(lastHistoricalSyncKey);
        const hoursSinceLastSync = lastSyncTime ? (Date.now() - parseInt(lastSyncTime)) / (1000 * 60 * 60) : Infinity;

        // Determine sync interval based on data age
        const getSyncInterval = () => {
          const currentDate = new Date();
          const currentMonth = currentDate.getMonth();
          const currentYear = currentDate.getFullYear();

          // Recent data (current & last month): 12h interval
          // 2-3 months ago: 48h interval
          // 4-6 months ago: 1 week interval
          // 6+ months ago: 2 weeks interval
          // 1+ year ago: 30 days interval
          return {
            recent: 12, // current + last month
            months2_3: 48, // 2-3 months ago
            months4_6: 168, // 4-6 months ago (1 week)
            months6plus: 336, // 6+ months ago (2 weeks)
            year1plus: 720 // 1+ year ago (30 days)
          };
        };

        const intervals = getSyncInterval();
        const shouldSync = hoursSinceLastSync > intervals.recent;

        if (shouldSync) {
          console.log(`🔄 [Deliveries] Starting background historical sync (last sync: ${hoursSinceLastSync.toFixed(1)}h ago)`);
          setTimeout(async () => {
            try {
              const currentYear = new Date().getFullYear();
              const startYear = currentYear - 1; // CRITICAL: Only fetch last 2 years to prevent rate limits
              const allYearData = [];

              // Fetch each year with LONG delays to avoid rate limits
              for (let year = currentYear; year >= startYear; year--) {
                console.log(`📅 [Deliveries Background] Fetching year ${year}...`);
                const quarters = [
                { start: `${year}-01-01`, end: `${year}-03-31`, label: 'Q1' },
                { start: `${year}-04-01`, end: `${year}-06-30`, label: 'Q2' },
                { start: `${year}-07-01`, end: `${year}-09-30`, label: 'Q3' },
                { start: `${year}-10-01`, end: `${year}-12-31`, label: 'Q4' }];


                for (const quarter of quarters) {
                  try {
                    const quarterData = await base44.entities.Delivery.filter({
                      delivery_date: { $gte: quarter.start, $lte: quarter.end }
                    }, '-delivery_date');

                    if (quarterData && quarterData.length > 0) {
                      allYearData.push(...quarterData);
                    }

                    // CRITICAL: 5 second delay between quarter requests to prevent rate limits
                    await new Promise((resolve) => setTimeout(resolve, 5000));
                  } catch (quarterError) {
                    console.warn(`⚠️ [Deliveries Background] Failed to fetch ${year} ${quarter.label}:`, quarterError.message);
                    // Continue with other quarters even if one fails
                  }
                }
              }

              console.log(`✅ [Deliveries Background] Synced ${allYearData.length} deliveries from online DB`);

              // CRITICAL: Filter out deleted deliveries before saving to offline DB
              const { smartRefreshManager } = await import('../components/utils/smartRefreshManager');
              const filteredData = allYearData.filter((delivery) => !smartRefreshManager.isDeliveryDeleted(delivery.id));

              console.log(`🗑️ [Deliveries Background] Filtered out ${allYearData.length - filteredData.length} deleted deliveries`);

              // Save to offline DB
              if (filteredData.length > 0) {
                const { offlineDB: offlineDBInstance } = await import('../components/utils/offlineDatabase');
                await offlineDBInstance.bulkSave(offlineDBInstance.STORES.DELIVERIES, filteredData);
                console.log(`💾 [Deliveries Background] Saved ${filteredData.length} to offline DB`);

                // Update UI with fresh data (excluding deleted)
                if (isMounted.current) {
                  setAllDeliveries(filteredData);
                  console.log('✅ [Deliveries Background] UI updated with fresh online data (deleted filtered)');
                }
              }

              // CRITICAL: Mark sync complete to prevent repeated syncing
              localStorage.setItem(lastHistoricalSyncKey, Date.now().toString());
              console.log('🕐 [Deliveries Background] Historical sync timestamp updated');
            } catch (error) {
              console.error('❌ [Deliveries Background] Sync failed:', error);
              // Silently fail - offline data is already displayed
            }
          }, 100); // Start background sync after 100ms
        } else {
          console.log(`⏭️ [Deliveries] Skipping historical sync (last sync: ${hoursSinceLastSync.toFixed(1)}h ago, need >24h)`);
        }

        if (deliveriesData && deliveriesData.length > 0) {
          const dates = deliveriesData.map((d) => d.delivery_date).filter(Boolean).sort();
          console.log(`📅 [Deliveries] Delivery date range: ${dates[0]} to ${dates[dates.length - 1]}`);
        }
      } else {
        // CRITICAL: Load ENTIRE MONTH's data for Route Management - bypass offline DB to get fresh data
        const currentYear = selectedYear;
        const currentMonth = selectedMonth;
        const startOfMonth = new Date(currentYear, currentMonth, 1);
        const endDate = new Date(currentYear, currentMonth + 1, 0);
        const startDateStr = format(startOfMonth, 'yyyy-MM-dd');
        const endDateStr = format(endDate, 'yyyy-MM-dd');

        console.log('📅 [Deliveries] Fetching entire month:', format(startOfMonth, 'MMMM yyyy'), `(${startDateStr} to ${endDateStr})`);

        // CRITICAL: Always fetch fresh from server for Route Management (don't rely on offline DB which may be stale)
        try {
          deliveriesData = await getData(
            'Delivery',
            '-delivery_date',
            { delivery_date: { $gte: startDateStr, $lte: endDateStr } },
            true // Force refresh to ensure we get complete month data
          );
          console.log(`✅ [Deliveries] Fetched ${deliveriesData?.length || 0} deliveries from server for month`);
        } catch (error) {
          console.error('❌ [Deliveries] Error fetching month deliveries:', error.message);
          deliveriesData = [];
        }
      }

      if (isMounted.current) {
        setAllDeliveries(deliveriesData || []);
      }

      let patientsData = [];

      if (userHasRole(user, 'admin')) {
        console.log('Admin - Fetching ALL patients (will filter in memory)');
        try {
          const allPatientsRaw = await getData('Patient', 'full_name', null, forceRefresh);
          console.log('Admin - Fetched all patients:', allPatientsRaw?.length || 0);

          const uniquePatientIds = new Set(
            (deliveriesData || []).filter((d) => d.patient_id).map((d) => d.patient_id)
          );
          patientsData = (allPatientsRaw || []).filter((p) => uniquePatientIds.has(p.id));
          console.log('Admin - Filtered to patients with deliveries:', patientsData.length);
        } catch (error) {
          console.error('Failed to fetch patients for admin:', error.message);
          patientsData = [];
        }
      } else if (userHasRole(user, 'dispatcher')) {
        const dispatcherStoreIds = user.store_ids || [];
        if (dispatcherStoreIds.length > 0) {
          try {
            patientsData = await getData('Patient', 'full_name', { store_id: { $in: dispatcherStoreIds } }, forceRefresh);
            console.log('Dispatcher - Fetched patients:', patientsData?.length || 0);
          } catch (error) {
            console.error('Failed to fetch patients for dispatcher:', error.message);
            patientsData = [];
          }
        }
      } else if (userHasRole(user, 'driver')) {
        console.log('Driver - Fetching ALL patients (will filter in memory)');
        try {
          const allPatientsRaw = await getData('Patient', 'full_name', null, forceRefresh);

          const uniquePatientIds = new Set(
            (deliveriesData || []).filter((d) => d.patient_id).map((d) => d.patient_id)
          );
          patientsData = (allPatientsRaw || []).filter((p) => uniquePatientIds.has(p.id));
          console.log('Driver - Filtered to patients with deliveries:', patientsData.length);
        } catch (error) {
          console.error('Failed to fetch patients for driver:', error.message);
          patientsData = [];
        }
      }

      if (isMounted.current) {
        setAllPatients(patientsData || []);
      }

      console.log('✅ [Deliveries] Data refresh complete');
      initialLoadDone.current = true;

    } catch (error) {
      console.error('[Deliveries] Error loading data:', error);
      if (isMounted.current) {
        setAllDeliveries([]);
        setAllPatients([]);
        setStores([]);
        setAllUsers([]);
        setCities([]);
      }
    } finally {
      if (isMounted.current) {
        setIsLoadingData(false);
        setDataLoaded(true);
      }
      loadInProgress.current = 0;
    }
  }, [currentUser, selectedYear, selectedMonth, isDriverOverviewMode, selectedOverviewYear]);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  // CRITICAL: Listen for smart refresh and import completion to update date cards
  useEffect(() => {
    const handleSmartRefreshComplete = () => {
      if (!isDriverOverviewMode) {
        console.log('🔄 [Deliveries] Smart refresh complete - forcing UI update');
        setRefreshKey((prev) => prev + 1);
      }
    };

    const handleImportComplete = () => {
      if (!isDriverOverviewMode) {
        console.log('📥 [Deliveries] Import complete - forcing UI update');
        setRefreshKey((prev) => prev + 1);
      }
    };

    const handleDataRefresh = () => {
      console.log('🔄 [Deliveries] Data refresh event - forcing UI update');
      setRefreshKey((prev) => prev + 1);
    };

    window.addEventListener('smartRefreshComplete', handleSmartRefreshComplete);
    window.addEventListener('offlineSyncComplete', handleImportComplete);
    window.addEventListener('deliveriesImported', handleImportComplete);
    window.addEventListener('refreshDeliveryStats', handleDataRefresh);

    return () => {
      window.removeEventListener('smartRefreshComplete', handleSmartRefreshComplete);
      window.removeEventListener('offlineSyncComplete', handleImportComplete);
      window.removeEventListener('deliveriesImported', handleImportComplete);
      window.removeEventListener('refreshDeliveryStats', handleDataRefresh);
    };
  }, [isDriverOverviewMode]);

  // CRITICAL: Subscribe to delivery mutations to update data in real-time
  useEffect(() => {
    const unsubscribe = base44.entities.Delivery.subscribe((event) => {
      if (!isMounted.current) return;

      console.log(`📡 [Deliveries] Delivery ${event.type}:`, event.id);

      if (event.type === 'create') {
        setAllDeliveries((prev) => {
          const exists = prev.some((d) => d?.id === event.id);
          return exists ? prev : [...prev, event.data];
        });
      } else if (event.type === 'update') {
        setAllDeliveries((prev) => prev.map((d) => d?.id === event.id ? { ...d, ...event.data } : d));
      } else if (event.type === 'delete') {
        setAllDeliveries((prev) => prev.filter((d) => d?.id !== event.id));
      }
    });

    return () => unsubscribe();
  }, []);

  // Fetch fresh AppUser data periodically for accurate driver_status
  useEffect(() => {
    if (!isDriverOverviewMode) return;

    const fetchFreshAppUsers = async () => {
      try {
        const freshData = await base44.entities.AppUser.list();
        setFreshAppUsers(freshData || []);
      } catch (error) {
        console.warn('Failed to fetch fresh AppUser data:', error);
      }
    };

    fetchFreshAppUsers();
    const interval = setInterval(fetchFreshAppUsers, 10000);
    return () => clearInterval(interval);
  }, [isDriverOverviewMode]);

  useEffect(() => {
    if (!contextDataLoaded || !initialLoadDone.current || !dataLoaded) {
      return;
    }

    if (Date.now() < skipContextSyncUntil.current) {
      console.log('⏸️ [Deliveries] Skipping context sync - drag operation in progress');
      return;
    }

    // CRITICAL: Route Management loads its own month data independently
    // NEVER sync context deliveries into Route Management (both overview and with driver selected)
    // Route Management is completely decoupled from Dashboard
    if (!isDriverOverviewMode) {
      console.log('⏸️ [Deliveries] Skipping context sync for deliveries - Route Management loads independently from offline DB');
      // Still sync other data
      if (contextPatients.length > 0) {
        setAllPatients(contextPatients);
      }
      if (contextStores.length > 0) {
        setStores(contextStores);
      }
      if (contextCities.length > 0) {
        setCities(contextCities);
      }
      if (contextUsers.length > 0) {
        setAllUsers(contextUsers);
      }
      return;
    }

    // Driver Overview: DO NOT sync deliveries from context (contextDeliveries is date-filtered)
    // Driver Overview loads its own data independently from offline DB
    console.log('⏸️ [Deliveries] Skipping context delivery sync for Driver Overview - loads independently from offline DB');

    if (contextPatients.length > 0) {
      setAllPatients(contextPatients);
    }

    if (contextStores.length > 0) {
      setStores(contextStores);
    }

    if (contextCities.length > 0) {
      setCities(contextCities);
    }

    if (contextUsers.length > 0) {
      setAllUsers(contextUsers);
    }
  }, [contextDataLoaded, contextDeliveries, contextPatients, contextStores, contextCities, contextUsers, dataLoaded, isDriverOverviewMode]);

  useEffect(() => {
    console.log('🔐 [Deliveries] Running checkAccess on mount...');
    checkAccess();
  }, [checkAccess]);

  // Auto-select driver for driver-only users OR dispatchers with single driver
  useEffect(() => {
    if (!currentUser || !hasAccess) return;

    // Driver-only users: auto-select themselves
    if (userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin') && !userHasRole(currentUser, 'dispatcher')) {
      if (driverFilter === 'all') {
        console.log('🚗 [Deliveries] Driver user detected, auto-selecting self:', currentUser.id);
        setDriverFilter(currentUser.id);
      }
    }

    // Dispatchers with only 1 driver: auto-select that driver
    if (userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
      if (uniqueDriversForDispatcher && uniqueDriversForDispatcher.count === 1 && driverFilter === 'all') {
        const singleDriverId = uniqueDriversForDispatcher.driverIds[0];
        console.log('👔 [Deliveries] Dispatcher has only 1 driver, auto-selecting:', singleDriverId);
        setDriverFilter(singleDriverId);
      }
    }
  }, [currentUser, hasAccess, driverFilter, uniqueDriversForDispatcher]);

  useEffect(() => {
    if (!hasAccess || initialLoadDone.current) {
      console.log(`⏩ [Deliveries] Skipping initial loadData (hasAccess: ${hasAccess}, initialLoadDone: ${initialLoadDone.current})`);
      return;
    }

    console.log('🚀 [Deliveries] Running initial loadData on page mount...');

    initialLoadDone.current = true;

    setIsLoading(true);
    loadData(false).finally(() => {
      if (isMounted.current) {
        setIsLoading(false);
      }
    });
  }, [hasAccess]);

  // CRITICAL: Reload data when transitioning from Driver Overview to Route Management
  useEffect(() => {
    if (prevModeRef.current === null) return;

    // Detect transition from Driver Overview to Route Management
    const transitionedToRouteManagement = prevModeRef.current === true && isDriverOverviewMode === false;

    if (transitionedToRouteManagement && driverFilter !== 'all') {
      console.log('🔄 [Deliveries] Transitioned to Route Management - reloading month data for selected driver');
      loadData(true).catch(() => {});
    }
  }, [isDriverOverviewMode, driverFilter, loadData]);


  const availableOverviewYears = useMemo(() => {
    console.log('🗓️ Calculating availableOverviewYears...');

    if (!allDeliveries || !Array.isArray(allDeliveries) || allDeliveries.length === 0) {
      console.log('⚠️ No allDeliveries, returning empty years');
      return [];
    }

    console.log('📊 allDeliveries count for year calculation:', allDeliveries.length);

    const years = [...new Set(allDeliveries.map((d) => {
      if (!d || !d.delivery_date) return null;
      try {
        return new Date(d.delivery_date.replace(/-/g, '/')).getFullYear();
      } catch (error) {
        console.warn('⚠️ Invalid delivery_date:', d.delivery_date);
        return null;
      }
    }).filter(Boolean))];

    const sortedYears = years.sort((a, b) => b - a);
    console.log(`✅ Available overview years (from all deliveries):`, sortedYears);

    return sortedYears;
  }, [allDeliveries.length]);


  useEffect(() => {
    if (!isDriverOverviewMode || !dataLoaded || !hasAccess) return;
    if (!availableOverviewYears || availableOverviewYears.length === 0) return;

    if (yearAutoSelectDone.current) {
      return;
    }

    const params = new URLSearchParams(location.search);
    const yearParam = params.get('overviewYear');

    if (yearParam) {
      console.log('📅 [Deliveries] URL has year param:', yearParam);
      if (yearParam === 'all') {
        setSelectedOverviewYear('all');
      } else {
        setSelectedOverviewYear(yearParam);
      }
      yearAutoSelectDone.current = true;
      yearManuallySelected.current = true;
      return;
    }

    const currentYear = new Date().getFullYear();
    const targetYear = availableOverviewYears.includes(currentYear) ?
    currentYear.toString() :
    availableOverviewYears[0]?.toString();

    if (targetYear) {
      console.log('📅 [Deliveries] Auto-selecting year:', targetYear);
      setSelectedOverviewYear(targetYear);
    }

    yearAutoSelectDone.current = true;
  }, [isDriverOverviewMode, dataLoaded, hasAccess, availableOverviewYears.length, location.search]);


  useEffect(() => {
    if (isDriverOverviewMode && isMobileMenuOpen) {
      setIsMobileMenuOpen(false);
    }
  }, [isDriverOverviewMode, isMobileMenuOpen]);

  useEffect(() => {
    globalFilters.setSelectedDate(selectedDate);
  }, [selectedDate]);

  useEffect(() => {
    globalFilters.setSelectedDriverId(driverFilter);
  }, [driverFilter]);

  // Removed - now handled directly in setViewMode callback


  const updateUrl = useCallback((newFilters) => {
    const params = new URLSearchParams(location.search);
    const todayString = format(new Date(), 'yyyy-MM-dd');
    const currentYear = new Date().getFullYear().toString();
    const currentMonth = (new Date().getMonth() + 1).toString();

    Object.entries(newFilters).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '' || value === 'all') {
        params.delete(key);
        return;
      }

      if (key === 'date') {
        try {
          let dateStr;

          if (value instanceof Date) {
            if (isNaN(value.getTime())) {
              console.warn('[updateUrl] Invalid Date object');
              return;
            }
            dateStr = format(value, 'yyyy-MM-dd');
          } else if (typeof value === 'string') {
            const [y, m, d] = value.split('-').map(Number);
            if (isNaN(y) || isNaN(m) || isNaN(d)) {
              console.warn('[updateUrl] Invalid date string format:', value);
              return;
            }
            dateStr = value;
          } else {
            console.warn('[updateUrl] Unexpected date value type:', typeof value);
            return;
          }

          if (dateStr !== todayString) {
            params.set(key, dateStr);
          } else {
            params.delete(key);
          }
        } catch (error) {
          console.error('[updateUrl] Error formatting date:', error, value);
        }
      } else if (key === 'year') {
        const paramValue = value.toString();
        if (paramValue !== currentYear) {
          params.set(key, paramValue);
        } else {
          params.delete(key);
        }
      } else if (key === 'month') {
        const paramValue = value.toString();
        if (paramValue !== currentMonth) {
          params.set(key, paramValue);
        } else {
          params.delete(key);
        }
      } else if (key === 'city') {
        if (value !== 'all') {
          params.set(key, value);
        } else {
          params.delete(key);
        }
      } else {
        params.set(key, value.toString());
      }
    });

    navigate(`${location.pathname}?${params.toString()}`, { replace: true });
  }, [location.search, location.pathname, navigate]);


  const handleStatusChange = useCallback((value) => {
    setStatusFilter(value);
    updateUrl({ status: value });
  }, [updateUrl]);

  const effectiveDeliveries = useMemo(() => {
    if (!currentUser || !allDeliveries || !Array.isArray(allDeliveries)) return [];
    if (userHasRole(currentUser, 'admin')) return allDeliveries;

    if (userHasRole(currentUser, 'dispatcher')) {
      const dispatcherStoreIds = currentUser.store_ids || [];
      return allDeliveries.filter((d) => {
        if (!d) return false;
        if (d.store_id && dispatcherStoreIds.includes(d.store_id)) {
          return true;
        }

        if (d.patient_id) {
          const patient = allPatients.find((p) => p && p.id === d.patient_id);
          if (patient && patient.store_id && dispatcherStoreIds.includes(patient.store_id)) {
            return true;
          }
        }
        return false;
      });
    }

    if (userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin')) {
      return allDeliveries.filter((d) =>
      d && (
      d.driver_id && d.driver_id === currentUser.id ||
      !d.driver_id && d.driver_name && (d.driver_name === currentUser.full_name || d.driver_name === currentUser.user_name))
      );
    }
    return [];
  }, [currentUser, allDeliveries, allPatients]);

  const effectivePatients = useMemo(() => {
    if (!currentUser || !allPatients || !Array.isArray(allPatients)) return [];
    if (userHasRole(currentUser, 'admin')) return allPatients;

    if (userHasRole(currentUser, 'dispatcher')) {
      const dispatcherStoreIds = currentUser.store_ids || [];
      return allPatients.filter((p) => p && dispatcherStoreIds.includes(p.store_id));
    }

    if (userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin')) {
      const uniquePatientIds = new Set(effectiveDeliveries.map((d) => d.patient_id).filter(Boolean));
      return allPatients.filter((p) => uniquePatientIds.has(p.id));
    }
    return [];
  }, [currentUser, allPatients, effectiveDeliveries]);

  const effectiveDrivers = useMemo(() => {
    if (!currentUser || !allUsers || !Array.isArray(allUsers)) {
      console.log('❌ [Deliveries] effectiveDrivers: No data available', {
        hasCurrentUser: !!currentUser,
        hasAllUsers: !!allUsers,
        isArray: Array.isArray(allUsers),
        allUsersLength: allUsers?.length
      });
      return [];
    }

    console.log('🔍 [Deliveries] Building effectiveDrivers list...');
    console.log('📊 [Deliveries] Total allUsers:', allUsers.length);

    let driversOnly = allUsers.filter((u) => {
      if (!u) {
        return false;
      }

      const hasDriverRole = userHasRole(u, 'driver') || userHasRole(u, 'admin') || userHasRole(u, 'dispatcher');

      if (!hasDriverRole) {
        console.log('❌ [Deliveries] Excluding (no driver/admin/dispatcher role):', u.user_name || u.full_name, 'roles:', u.app_roles);
        return false;
      }

      console.log('✅ [Deliveries] Including user with driver role:', u.user_name || u.full_name, 'roles:', u.app_roles);
      return true;
    });

    console.log('📊 [Deliveries] After role filtering:', driversOnly.length, 'drivers remaining');

    if (userHasRole(currentUser, 'admin')) {
      // CRITICAL: Include specific driver from URL even if inactive (for duplicate driver cleanup)
      const filtered = driversOnly.filter((u) => u && (u.status === 'active' || isDriverOverviewMode || u.id === driverFilter));
      console.log('👑 [Deliveries] Admin view - filtered drivers:', filtered.length);
      return filtered;
    }

    if (userHasRole(currentUser, 'dispatcher')) {
      // CRITICAL: Include specific driver from URL even if inactive (for duplicate driver cleanup)
      let filteredDrivers = driversOnly.filter((u) => u && (u.status === 'active' || isDriverOverviewMode || u.id === driverFilter));
      if (currentUser.city_id) {
        const beforeCityFilter = filteredDrivers.length;
        filteredDrivers = filteredDrivers.filter((d) => d && d.city_id === currentUser.city_id);
        console.log('📍 [Deliveries] Dispatcher city filter:', {
          before: beforeCityFilter,
          after: filteredDrivers.length,
          cityId: currentUser.city_id
        });
      }
      console.log('👔 [Deliveries] Dispatcher view - filtered:', filteredDrivers.length);
      return filteredDrivers;
    }

    if (userHasRole(currentUser, 'driver') && !userHasRole(currentUser, 'admin')) {
      const filtered = driversOnly.filter((d) => d.id === currentUser.id);
      console.log('🚗 [Deliveries] Driver view - own account only:', filtered.length);
      return filtered;
    }

    console.log('⚠️ [Deliveries] No matching role, returning empty array');
    return [];
  }, [currentUser, allUsers, isDriverOverviewMode]);


  useEffect(() => {
    if (!dataLoaded || !hasAccess || isLoadingData) return;

    console.log('🔍 [Deliveries] Processing URL parameters and setting initial state');

    const params = new URLSearchParams(location.search);
    const driverParam = params.get("driver");
    const statusParam = params.get("status");
    const searchParam = params.get("search");
    const yearParam = params.get("year");
    const monthParam = params.get("month");
    const cityParam = params.get("city");

    // NOTE: dateParam is no longer used in Route Management (only year/month are used in URL)

    // CRITICAL: Route Management only uses year/month in URL (no date param)
    let initialSelectedYear = new Date().getFullYear();
    let initialSelectedMonth = new Date().getMonth();

    if (yearParam) initialSelectedYear = parseInt(yearParam);
    if (monthParam) {
      initialSelectedMonth = parseInt(monthParam) - 1;
    } else {
      // No month param: use current month
      initialSelectedMonth = new Date().getMonth();
    }

    console.log('📅 [Deliveries] Setting year/month from URL:', {
      year: initialSelectedYear,
      month: initialSelectedMonth,
      monthParam,
      hasMonthParam: !!monthParam,
      isInitialLoad: isInitialPageLoadRef.current
    });

    setSelectedYear(initialSelectedYear);
    setSelectedMonth(initialSelectedMonth);

    let initialSelectedCityId = 'all';
    if (userHasRole(currentUser, 'admin')) {
      initialSelectedCityId = cityParam || 'all';
    } else if (userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) {
      if (currentUser.city_id) {
        initialSelectedCityId = currentUser.city_id;
      }
    }
    setSelectedCityId(initialSelectedCityId);

    // CRITICAL: Driver Overview doesn't use selectedDate - it shows stats for the entire year/period
    // Route Management: selectedDate is managed by date cards selection effect (auto-selected after data loads)

    let newDriverFilter = globalFilters.getSelectedDriverId() || 'all';

    if (driverParam) {
      newDriverFilter = driverParam;
      console.log('🚗 [Deliveries] Using driver from URL:', driverParam);
    } else if (userHasRole(currentUser, 'driver')) {
      const driverUser = (effectiveDrivers || []).find((d) => d.id === newDriverFilter);
      if (driverUser) {
        newDriverFilter = driverUser.id;
      }
    }
    setDriverFilter(newDriverFilter);

    setStatusFilter(statusParam || 'all');
    setSearchTerm(searchParam || '');

    const currentDriver = (effectiveDrivers || []).find((d) => d.id === newDriverFilter);
    setActiveDriver(currentDriver || null);
    if (currentDriver && currentDriver.location_tracking_enabled) {
      setIsDriverOnline(true);
    } else {
      setIsDriverOnline(false);
    }

    // CRITICAL: Ensure year/month are always in URL for both modes
    if (!yearParam || !monthParam) {
      const urlParams = new URLSearchParams(location.search);
      if (!yearParam) urlParams.set('year', initialSelectedYear.toString());
      if (!monthParam) urlParams.set('month', (initialSelectedMonth + 1).toString());
      // Remove date param if it exists (should never be in URL)
      urlParams.delete('date');
      navigate(`${location.pathname}?${urlParams.toString()}`, { replace: true });
    }

  }, [location.search, currentUser, dataLoaded, hasAccess, isLoadingData, cities, navigate, location.pathname]);


  const driverFilteredDeliveries = useMemo(() => {
    // CRITICAL: Use allDeliveries in Route Management mode (not effectiveDeliveries)
    // because we've already loaded the full month's data
    const source = !isDriverOverviewMode ? allDeliveries : effectiveDeliveries;

    if (!source || !Array.isArray(source)) return [];

    let filtered = source;

    // CRITICAL: For dispatchers, filter to only their assigned stores
    if (userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
      const dispatcherStoreIds = new Set(currentUser.store_ids || []);
      filtered = source.filter((d) => d && d.store_id && dispatcherStoreIds.has(d.store_id));
    }

    if (driverFilter === 'all') {
      return filtered;
    }

    const selectedDriver = (effectiveDrivers || []).find((d) => d.id === driverFilter);
    if (!selectedDriver) return [];

    return filtered.filter((d) =>
    d.driver_id && (d.driver_id === selectedDriver.id || d.driver_id === selectedDriver.appUserId) ||
    !d.driver_id && d.driver_name && (d.driver_name === selectedDriver.full_name || d.driver_name === selectedDriver.user_name)
    );
  }, [allDeliveries, effectiveDeliveries, effectiveDrivers, driverFilter, isDriverOverviewMode, currentUser]);

  const groupedDeliveries = useMemo(() => {
    // CRITICAL: Group deliveries by date within selected month/year
    if (!driverFilteredDeliveries || driverFilteredDeliveries.length === 0) {
      return {};
    }

    // CRITICAL: For dispatchers, filter to only their assigned stores BEFORE grouping
    let deliveriesToGroup = driverFilteredDeliveries;
    if (userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
      const dispatcherStoreIds = new Set(currentUser.store_ids || []);
      deliveriesToGroup = driverFilteredDeliveries.filter((d) =>
      d && d.store_id && dispatcherStoreIds.has(d.store_id)
      );
      console.log(`👔 [Deliveries] Dispatcher filter: ${deliveriesToGroup.length} of ${driverFilteredDeliveries.length} deliveries in assigned stores`);
    }

    // When in Route Management mode (not Driver Overview), only show dates in selected month
    if (!isDriverOverviewMode && selectedYear !== undefined && selectedMonth !== undefined) {
      const monthStart = new Date(selectedYear, selectedMonth, 1);
      const monthEnd = new Date(selectedYear, selectedMonth + 1, 0);

      const filtered = deliveriesToGroup.filter((d) => {
        if (!d || !d.delivery_date) return false;
        const [y, m, day] = d.delivery_date.split('-').map(Number);
        const deliveryDate = new Date(y, m - 1, day);
        return deliveryDate >= monthStart && deliveryDate <= monthEnd;
      });

      return filtered.reduce((acc, delivery) => {
        const dateKey = delivery.delivery_date.substring(0, 10);
        if (!acc[dateKey]) {
          acc[dateKey] = [];
        }
        acc[dateKey].push(delivery);
        return acc;
      }, {});
    }

    // Driver Overview: show all dates
    return deliveriesToGroup.reduce((acc, delivery) => {
      if (!delivery || !delivery.delivery_date) {
        return acc;
      }
      const dateKey = delivery.delivery_date.substring(0, 10);
      if (!acc[dateKey]) {
        acc[dateKey] = [];
      }
      acc[dateKey].push(delivery);
      return acc;
    }, {});
  }, [driverFilteredDeliveries, isDriverOverviewMode, selectedYear, selectedMonth, currentUser]);

  const sortedDates = useMemo(() => {
    return Object.keys(groupedDeliveries).sort((a, b) => new Date(b.replace(/-/g, '/')) - new Date(a.replace(/-/g, '/')));
  }, [groupedDeliveries]);

  const selectedDateDeliveries = useMemo(() => {
    if (!selectedDate) return [];
    const dateString = format(selectedDate, 'yyyy-MM-dd');
    return (groupedDeliveries[dateString] || []).filter((d) => !d.isProjected);
  }, [selectedDate, groupedDeliveries]);

  const availableYears = useMemo(() => {
    const years = [...new Set(sortedDates.map((date) => new Date(date.replace(/-/g, '/')).getFullYear()))];
    return years.sort((a, b) => b - a);
  }, [sortedDates]);

  const availableMonths = useMemo(() => {
    const monthsInYear = sortedDates.
    filter((date) => new Date(date.replace(/-/g, '/')).getFullYear() === selectedYear).
    map((date) => new Date(date.replace(/-/g, '/')).getMonth());
    return [...new Set(monthsInYear)].sort((a, b) => b - a);
  }, [sortedDates, selectedYear]);

  const filteredDatesByMonth = useMemo(() => {
    if (!sortedDates) return [];

    // Filter dates by selected year and month
    const filtered = sortedDates.filter((date) => {
      const [y, m, d] = date.split('-').map(Number);
      return !isNaN(y) && !isNaN(m) && !isNaN(d) && y === selectedYear && m - 1 === selectedMonth;
    });

    console.log(`📅 [Deliveries] Filtered dates for ${selectedMonth + 1}/${selectedYear}: ${filtered.length} dates`);

    return filtered;
  }, [sortedDates, selectedYear, selectedMonth]);

  const dateListWithStats = useMemo(() => {
    const patientMap = new Map((effectivePatients || []).map((p) => [p.id, p]));
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const todayString = format(today, 'yyyy-MM-dd');
    const tomorrowString = format(tomorrow, 'yyyy-MM-dd');

    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const isViewingCurrentPeriod = selectedYear === currentYear && selectedMonth === currentMonth;

    const datesSet = new Set(Array.isArray(filteredDatesByMonth) ? filteredDatesByMonth : []);

    filteredDatesByMonth.forEach((date) => datesSet.add(date));

    const sortedAndFilteredDates = Array.from(datesSet).sort((a, b) => new Date(b.replace(/-/g, '/')) - new Date(a.replace(/-/g, '/')));

    return sortedAndFilteredDates.map((date) => {
      const deliveriesOnDate = groupedDeliveries[date] || [];
      const total = deliveriesOnDate.length;
      const done = deliveriesOnDate.filter((d) => ['completed', 'picked_up', 'in_transit'].includes(d.status)).length;
      const returnedByStatus = deliveriesOnDate.filter((d) => d.status === 'returned').length;
      const failedByStatus = deliveriesOnDate.filter((d) => d.status === 'failed').length;

      const returned = deliveriesOnDate.filter((d) => {
        const patient = patientMap.get(d.patient_id);
        const notesReturn = (d.delivery_notes || '').toLowerCase().includes('return');
        const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
        return notesReturn || addressReturn;
      }).length;

      const dateObj = new Date(date.replace(/-/g, '/'));
      let displayLabel;
      if (isViewingCurrentPeriod && isSameDay(dateObj, today)) {
        displayLabel = 'Today';
      } else if (isViewingCurrentPeriod && isSameDay(dateObj, tomorrow)) {
        displayLabel = 'Tomorrow';
      } else {
        displayLabel = format(dateObj, 'EEE MMM d');
      }

      return { date, total, done, failed: failedByStatus, returned, displayLabel, actualDeliveries: deliveriesOnDate.length };
    });
  }, [filteredDatesByMonth, groupedDeliveries, effectivePatients, selectedYear, selectedMonth, refreshKey]);

  useEffect(() => {
    if (prevModeRef.current === null) {
      prevModeRef.current = isDriverOverviewMode;
    }

    if (isDriverOverviewMode || isLoading || isLoadingData) {
      prevModeRef.current = isDriverOverviewMode;
      return;
    }

    // CRITICAL: When transitioning FROM Driver Overview TO Route Management, auto-select most recent date
    const transitionedToRouteManagement = prevModeRef.current === true && isDriverOverviewMode === false;
    prevModeRef.current = isDriverOverviewMode;

    // On initial page load: select most recent date
    if (isInitialPageLoadRef.current) {
      console.log('📅 [Deliveries] Initial page load - selecting most recent date');
      if (dateListWithStats.length > 0) {
        const mostRecentDate = dateListWithStats[0].date;
        const topDateObj = new Date(mostRecentDate.replace(/-/g, '/'));
        topDateObj.setHours(0, 0, 0, 0);
        console.log(`📅 [Deliveries] Most recent date selected: ${format(topDateObj, 'yyyy-MM-dd')}`);
        setSelectedDate(topDateObj);
      }
      isInitialPageLoadRef.current = false;
      return;
    }

    // When transitioning to Route Management from Driver Overview, always select most recent date
    if (transitionedToRouteManagement) {
      console.log('📅 [Deliveries] Transitioned to Route Management - selecting most recent date');
      if (dateListWithStats.length > 0) {
        const mostRecentDate = dateListWithStats[0].date;
        const topDateObj = new Date(mostRecentDate.replace(/-/g, '/'));
        topDateObj.setHours(0, 0, 0, 0);
        console.log(`📅 [Deliveries] Most recent date selected: ${format(topDateObj, 'yyyy-MM-dd')}`);
        setSelectedDate(topDateObj);
        return;
      }
    }

    // On refresh/month-year change: keep selected date or auto-select if invalid
    if (selectedDate) {
      const selectedDateYear = selectedDate.getFullYear();
      const selectedDateMonth = selectedDate.getMonth();

      // If selected date is NOT in the currently selected month/year, auto-select first valid date
      if (selectedDateYear !== selectedYear || selectedDateMonth !== selectedMonth) {
        if (dateListWithStats.length > 0) {
          const topDate = dateListWithStats[0].date;
          const topDateObj = new Date(topDate.replace(/-/g, '/'));
          topDateObj.setHours(0, 0, 0, 0);

          console.log(`📅 [Deliveries] Selected date not in month/year range, auto-selecting: ${format(topDateObj, 'yyyy-MM-dd')}`);
          setSelectedDate(topDateObj);
        }
      }
    } else if (!selectedDate && dateListWithStats.length > 0) {
      // No date selected - select most recent
      const topDate = dateListWithStats[0].date;
      const topDateObj = new Date(topDate.replace(/-/g, '/'));
      topDateObj.setHours(0, 0, 0, 0);
      console.log(`📅 [Deliveries] No date selected, selecting most recent: ${format(topDateObj, 'yyyy-MM-dd')}`);
      setSelectedDate(topDateObj);
    }
  }, [selectedMonth, selectedYear, isDriverOverviewMode, isLoading, isLoadingData, dateListWithStats.length]);


  useEffect(() => {
    if (isDriverOverviewMode || isLoading || !dateListWithStats.length || !effectiveDrivers.length || !hasAccess || isLoadingData) {
      return;
    }

    // Skip on initial page load - let the initial date selection effect handle it
    if (isInitialPageLoadRef.current) {
      return;
    }

    const now = new Date();
    const todayString = format(now, 'yyyy-MM-dd');
    const tomorrowString = format(addDays(now, 1), 'yyyy-MM-dd');
    const currentSelectedDateString = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : null;

    const isCurrentlyToday = currentSelectedDateString && isSameDay(new Date(currentSelectedDateString.replace(/-/g, '/')), now);

    if (isCurrentlyToday === false) {
      return;
    }

    const currentHour = now.getHours();

    const todayDeliveriesForActiveDriver = (effectiveDeliveries || []).filter((d) =>
    d.delivery_date === todayString && (d.driver_id && (d.driver_id === activeDriver?.id || d.driver_id === activeDriver?.appUserId) || d.driver_name === activeDriver?.full_name || d.driver_name === activeDriver?.user_name)
    );
    const allTodayCompleteForActiveDriver = todayDeliveriesForActiveDriver.length > 0 &&
    todayDeliveriesForActiveDriver.every((d) => ['completed', 'returned', 'failed', 'cancelled'].includes(d.status));

    const selectedDriverFromFilter = (effectiveDrivers || []).find((d) => d.id === driverFilter);
    const tomorrowHasActualDeliveries = groupedDeliveries[tomorrowString]?.length > 0;


    let targetDateString = null;

    if (currentHour >= 18 && allTodayCompleteForActiveDriver && tomorrowHasActualDeliveries) {
      targetDateString = tomorrowString;
    } else {
      if (isCurrentlyToday || !currentSelectedDateString) {
        const todayStats = dateListWithStats.find((d) => d.date === todayString);
        if (todayStats) {
          targetDateString = todayString;
        } else {
          targetDateString = dateListWithStats[0]?.date;
        }
      }
    }

    if (targetDateString && currentSelectedDateString !== targetDateString) {
      const [year, month, day] = targetDateString.split('-').map(Number);
      const newDate = new Date(year, month - 1, day);
      setSelectedDate(newDate);
      updateUrl({ date: targetDateString });
    }

  }, [
  dateListWithStats,
  driverFilter,
  effectiveDeliveries,
  effectiveDrivers,
  isDriverOverviewMode,
  isLoading,
  selectedDate,
  updateUrl,
  setSelectedDate,
  activeDriver,
  hasAccess,
  groupedDeliveries,
  isLoadingData]
  );

  const sortDeliveriesByTime = useCallback((deliveries) => {
    if (!Array.isArray(deliveries)) return [];

    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

    const incomplete = deliveries.filter((d) => d && !finishedStatuses.includes(d.status));
    const completed = deliveries.filter((d) => d && finishedStatuses.includes(d.status));

    incomplete.sort((a, b) => {
      if (!a || !b) return 0;
      const stopOrderA = a.stop_order ?? Infinity;
      const stopOrderB = b.stop_order ?? Infinity;
      if (stopOrderA !== stopOrderB) return stopOrderA - stopOrderB;
      const timeA = a.delivery_time_start || '';
      const timeB = b.delivery_time_start || '';
      return timeA.localeCompare(timeB);
    });

    completed.sort((a, b) => {
      if (!a || !b) return 0;
      const stopOrderA = a.stop_order ?? Infinity;
      const stopOrderB = b.stop_order ?? Infinity;
      return stopOrderA - stopOrderB;
    });

    return [...incomplete, ...completed];
  }, []);

  const filteredAndSortedDeliveries = useMemo(() => {
    let filtered = selectedDateDeliveries;

    if (statusFilter && statusFilter !== 'all') {
      filtered = filtered.filter((d) => d.status === statusFilter);
    }

    if (searchTerm) {
      const lowerSearch = searchTerm.toLowerCase();
      filtered = filtered.filter((d) => {
        const patient = effectivePatients.find((p) => p.id === d.patient_id);
        const store = stores.find((s) => s.id === d.store_id);

        return (
          (patient?.full_name || '').toLowerCase().includes(lowerSearch) ||
          (patient?.address || '').toLowerCase().includes(lowerSearch) ||
          (d.driver_name || '').toLowerCase().includes(lowerSearch) ||
          (store?.name || '').toLowerCase().includes(lowerSearch) ||
          (d.prescription_number || '').toLowerCase().includes(lowerSearch));

      });
    }

    const sorted = sortDeliveriesByTime(filtered);

    return sorted.map((delivery, index) => ({
      ...delivery,
      stopOrder: index + 1
    }));
  }, [selectedDateDeliveries, effectivePatients, stores, statusFilter, searchTerm, sortDeliveriesByTime]);

  // Filter date cards based on search term (search across all available dates)
  const filteredDatesBySearch = useMemo(() => {
    if (!searchTerm) {
      return dateListWithStats;
    }

    const lowerSearch = searchTerm.toLowerCase();
    return dateListWithStats.filter((dateItem) => {
      // Get deliveries for this date and check if any match the search
      const deliveriesOnDate = driverFilteredDeliveries.filter((d) => d.delivery_date === dateItem.date);

      return deliveriesOnDate.some((d) => {
        const patient = effectivePatients.find((p) => p.id === d.patient_id);
        const store = stores.find((s) => s.id === d.store_id);

        return (
          (patient?.full_name || '').toLowerCase().includes(lowerSearch) ||
          (patient?.address || '').toLowerCase().includes(lowerSearch) ||
          (d.driver_name || '').toLowerCase().includes(lowerSearch) ||
          (store?.name || '').toLowerCase().includes(lowerSearch) ||
          (d.prescription_number || '').toLowerCase().includes(lowerSearch));

      });
    });
  }, [searchTerm, dateListWithStats, driverFilteredDeliveries, effectivePatients, stores]);

  const createDriverPickupStops = useCallback(async (driver, deliveryDate) => {
    try {
      const driverName = driver.full_name;
      const driverId = driver.id;
      const appUserId = driver.appUserId;

      const driverStores = (stores || []).filter((store) => {
        const deliveryDateObj = new Date(deliveryDate);
        const dayOfWeek = deliveryDateObj.getDay();

        if (dayOfWeek === 6) {
          return store.saturday_am_enabled && store.saturday_am_start && (store.driver_saturday_am_id === driverId || store.driver_saturday_am_id === appUserId || store.driver_saturday_am === driverName) ||
          store.saturday_pm_enabled && store.saturday_pm_start && (store.driver_saturday_pm_id === driverId || store.driver_saturday_pm_id === appUserId || store.driver_saturday_pm === driverName);
        } else if (dayOfWeek === 0) {
          return store.sunday_am_enabled && store.sunday_am_start && (store.sunday_am_driver_id === driverId || store.sunday_am_driver_id === appUserId || store.sunday_am_driver === driverName) ||
          store.sunday_pm_enabled && store.sunday_pm_start && (store.sunday_pm_driver_id === driverId || store.sunday_pm_driver_id === appUserId || store.sunday_pm_driver === driverName);
        } else {
          return store.weekday_am_enabled && store.weekday_am_start && (store.weekday_am_driver_id === driverId || store.weekday_am_driver_id === appUserId || store.weekday_am_driver === driverName) ||
          store.weekday_pm_enabled && store.weekday_pm_start && (store.weekday_pm_driver_id === driverId || store.weekday_pm_driver_id === appUserId || store.weekday_pm_driver === driverName);
        }
      });

      const storesWithTimes = driverStores.map(async ({ ...store }) => {
        const deliveryDateObj = new Date(deliveryDate);
        const dayOfWeek = deliveryDateObj.getDay();
        let earliestStorePickupTime = null;
        let earliestStorePickupEndTime = null;

        if (dayOfWeek === 6) {
          if (store.saturday_am_enabled && store.saturday_am_start && (store.driver_saturday_am_id === driverId || store.driver_saturday_am_id === appUserId || store.driver_saturday_am === driverName)) {
            earliestStorePickupTime = store.saturday_am_start;
            earliestStorePickupEndTime = addMinutesToTime(earliestStorePickupTime, 60);
          }
          if (store.saturday_pm_enabled && store.saturday_pm_start && (store.driver_saturday_pm_id === driverId || store.driver_saturday_pm_id === appUserId || store.driver_saturday_pm === driverName)) {
            const pmStart = store.saturday_pm_start || '13:00';
            if (!earliestStorePickupTime || pmStart < earliestStorePickupTime) {
              earliestStorePickupTime = pmStart;
              earliestStorePickupEndTime = addMinutesToTime(pmStart, 60);
            }
          }
        } else if (dayOfWeek === 0) {
          if (store.sunday_am_enabled && store.sunday_am_start && (store.sunday_am_driver_id === driverId || store.sunday_am_driver_id === appUserId || store.sunday_am_driver === driverName)) {
            earliestStorePickupTime = store.sunday_am_start;
            earliestStorePickupEndTime = addMinutesToTime(earliestStorePickupTime, 60);
          }
          if (store.sunday_pm_enabled && store.sunday_pm_start && (store.sunday_pm_driver_id === driverId || store.sunday_pm_driver_id === appUserId || store.sunday_pm_driver === driverName)) {
            const pmStart = store.sunday_pm_start || '13:00';
            if (!earliestStorePickupTime || pmStart < earliestStorePickupTime) {
              earliestStorePickupTime = pmStart;
              earliestStorePickupEndTime = addMinutesToTime(pmStart, 60);
            }
          }
        } else {
          if (store.weekday_am_enabled && store.weekday_am_start && (store.weekday_am_driver_id === driverId || store.weekday_am_driver_id === appUserId || store.weekday_am_driver === driverName)) {
            earliestStorePickupTime = store.weekday_am_start;
            earliestStorePickupEndTime = addMinutesToTime(earliestStorePickupTime, 60);
          }
          if (store.weekday_pm_enabled && store.weekday_pm_start && (store.weekday_pm_driver_id === driverId || store.weekday_pm_driver_id === appUserId || store.weekday_pm_driver === driverName)) {
            const pmStart = store.weekday_pm_start || '13:00';
            if (!earliestStorePickupTime || pmStart < earliestStorePickupTime) {
              earliestStorePickupTime = pmStart;
              earliestStorePickupEndTime = addMinutesToTime(pmStart, 60);
            }
          }
        }
        return { store, pickupTime: earliestStorePickupTime, pickupEndTime: earliestStorePickupEndTime };
      });

      const resolvedStoresWithTimes = (await Promise.all(storesWithTimes)).filter((s) => s.pickupTime);

      resolvedStoresWithTimes.sort((a, b) => (a.pickupTime || '').localeCompare(b.pickupTime || ''));

      const pickupPromises = resolvedStoresWithTimes.map(async ({ store, pickupTime, pickupEndTime }, storeIndex) => {
        const storeAbbr = store.abbreviation || 'XX';
        const baseTrackingNumber = storeIndex * 20;
        const pickupTrackingNumber = `${storeAbbr}${String(baseTrackingNumber).padStart(2, '0')}`;

        const allCurrentDeliveries = await getData('Delivery');
        const pickupExists = (allCurrentDeliveries || []).some((d) =>
        d.delivery_date === deliveryDate && (
        d.driver_id && (d.driver_id === driverId || d.driver_id === appUserId) || !d.driver_id && d.driver_name === driverName) &&
        d.store_id === store.id &&
        d.patient_id === null
        );

        if (!pickupExists) {
          const pickupPayload = {
            store_id: store.id,
            delivery_date: deliveryDate,
            status: 'pending',
            driver_name: driverName,
            driver_id: driverId,
            tracking_number: pickupTrackingNumber,
            delivery_notes: `Store Pickup for ${store.name}`,
            delivery_address: store.address,
            delivery_time_start: pickupTime,
            delivery_time_end: pickupEndTime,
            stop_order: 1
          };

          await Delivery.create(pickupPayload);
          await invalidate('Delivery');
        }
      });

      await Promise.all(pickupPromises);
    } catch (error) {
      console.error("Error creating driver pickup stops:", error);
    }
  }, [stores]);

  const calculateOptimalTimeWindow = useCallback((patient, store, existingDeliveriesForDriver, deliveryDate) => {
    if (patient?.time_window_start && patient?.time_window_end) {
      return {
        delivery_time_start: patient.time_window_start,
        delivery_time_end: patient.time_window_end
      };
    }

    const deliveryDateObj = new Date(deliveryDate);
    const dayOfWeek = deliveryDateObj.getDay();

    let earliestStorePickupTime = null;
    let earliestStorePickupEndTime = null;

    if (store) {
      if (dayOfWeek === 6) {
        if (store.saturday_am_enabled && store.saturday_am_start) {
          earliestStorePickupTime = store.saturday_am_start;
          earliestStorePickupEndTime = addMinutesToTime(earliestStorePickupTime, 60);
        }
        if (store.saturday_pm_enabled && store.saturday_pm_start) {
          const pmStart = store.saturday_pm_start || '13:00';
          if (!earliestStorePickupTime || pmStart < earliestStorePickupTime) {
            earliestStorePickupTime = pmStart;
            earliestStorePickupEndTime = addMinutesToTime(pmStart, 60);
          }
        }
      } else if (dayOfWeek === 0) {
        if (store.sunday_am_enabled && store.sunday_am_start) {
          earliestStorePickupTime = store.sunday_am_start;
          earliestStorePickupEndTime = addMinutesToTime(earliestStorePickupTime, 60);
        }
        if (store.sunday_pm_enabled && store.sunday_pm_start) {
          const pmStart = store.sunday_pm_start || '13:00';
          if (!earliestStorePickupTime || pmStart < earliestStorePickupTime) {
            earliestStorePickupTime = pmStart;
            earliestStorePickupEndTime = addMinutesToTime(pmStart, 60);
          }
        }
      } else {
        if (store.weekday_am_enabled && store.weekday_am_start) {
          earliestStorePickupTime = store.weekday_am_start;
          earliestStorePickupEndTime = addMinutesToTime(earliestStorePickupTime, 60);
        }
        if (store.weekday_pm_enabled && store.weekday_pm_start) {
          const pmStart = store.weekday_pm_start || '13:00';
          if (!earliestStorePickupTime || pmStart < earliestStorePickupTime) {
            earliestStorePickupTime = pmStart;
            earliestStorePickupEndTime = addMinutesToTime(pmStart, 60);
          }
        }
      }
    }

    if (!earliestStorePickupTime) {
      earliestStorePickupTime = '09:00';
      earliestStorePickupEndTime = '10:00';
    }

    const defaultDeliveryStartTime = addMinutesToTime(earliestStorePickupEndTime, 5);
    const defaultDeliveryEndTime = addMinutesToTime(defaultDeliveryStartTime, 15);

    return {
      delivery_time_start: defaultDeliveryStartTime,
      delivery_time_end: defaultDeliveryEndTime
    };
  }, []);

  const optimizeRouteOrder = useCallback(async (storeId, deliveryDate, driver) => {
    const allDeliveriesRaw = await getData('Delivery');
    const driverName = driver.full_name;
    const driverId = driver.id;
    const appUserId = driver.appUserId;

    const store = (stores || []).find((s) => s.id === storeId);
    if (!store) return;

    const storeAbbr = store.abbreviation || 'XX';


    const routeDeliveries = (allDeliveriesRaw || []).filter((d) =>
    d.store_id === storeId &&
    d.delivery_date === deliveryDate && (
    d.driver_id && (d.driver_id === driverId || d.driver_id === appUserId) || !d.driver_id && d.driver_name === driverName) &&
    d.status === 'pending'
    );

    let pickupDelivery = routeDeliveries.find((d) => d.patient_id === null);
    let patientDeliveries = routeDeliveries.filter((d) => d.patient_id !== null);

    const pickupTrackingBase = pickupDelivery ? pickupDelivery.tracking_number : `${storeAbbr}00`;

    const patientMap = new Map((allPatients || []).map((p) => [p.id, p]));

    patientDeliveries.sort((a, b) => {
      const patientA = patientMap.get(a.patient_id);
      const patientB = patientMap.get(b.patient_id);

      if (!patientA || !patientB) return 0;

      const addressA = (patientA.address || '').toLowerCase();
      const addressB = (patientB.address || '').toLowerCase();
      const addressCompare = addressA.localeCompare(addressB);
      if (addressCompare !== 0) return addressCompare;

      const distanceA = patientA.distance_from_store || Infinity;
      const distanceB = patientB.distance_from_store || Infinity;
      return distanceA - distanceB;
    });

    const updates = [];

    if (pickupDelivery) {
      if (pickupDelivery.stop_order !== 1 || pickupDelivery.tracking_number !== pickupTrackingBase) {
        updates.push(Delivery.update(pickupDelivery.id, { stop_order: 1, tracking_number: pickupTrackingBase }));
      }
    }

    let baseNum = 0;
    const baseNumMatch = pickupTrackingBase.match(/\D*(\d+)$/);
    if (baseNumMatch && baseNumMatch[1]) {
      baseNum = parseInt(baseNumMatch[1]);
    }

    patientDeliveries.forEach((delivery, index) => {
      const newStopOrder = (pickupDelivery ? 1 : 0) + index + 1;
      const newTrackingNumber = `${storeAbbr}${String(baseNum + index + 1).padStart(3, '0')}`;

      if (delivery.stop_order !== newStopOrder || delivery.tracking_number !== newTrackingNumber) {
        updates.push(Delivery.update(delivery.id, { stop_order: newStopOrder, tracking_number: newTrackingNumber }));
      }
    });

    if (updates.length > 0) {
      await Promise.all(updates);
      await invalidate('Delivery');
    }
  }, [allPatients, stores]);

  const handleSaveDelivery = useCallback(async (deliveryData) => {
    console.log('🚀 [Deliveries] handleSaveDelivery called with data:', deliveryData);
    console.log('🏷️  [Deliveries] Received tracking_number:', deliveryData.tracking_number);
    console.log('⏰ [Deliveries] Received delivery_time_start:', deliveryData.delivery_time_start);
    console.log('📊 [Deliveries] Received status:', deliveryData.status);

    try {
      if (deliveryData._isBatchSave && deliveryData._stagedDeliveries) {
        console.log(`📦 [Deliveries] Processing batch save for ${deliveryData._stagedDeliveries.length} deliveries`);
        console.log('📦 [Deliveries] Staged deliveries:', deliveryData._stagedDeliveries);

        const stagedDeliveries = deliveryData._stagedDeliveries;

        for (const staged of stagedDeliveries) {
          const patient = staged.patient_id ? (allPatients || []).find((p) => p && p.id === staged.patient_id) : null;
          const store = (stores || []).find((s) => s && s.id === staged.store_id);

          if (!store) {
            console.warn('⚠️ Skipping staged delivery - store not found:', staged.store_id);
            continue;
          }

          let actualDriver = null;
          if (staged.driver_id && staged.driver_id !== 'unassigned') {
            actualDriver = allUsers.find((u) => u.id === staged.driver_id);
          }

          let dispatcher_id = null;
          if (store.dispatcher_id) {
            dispatcher_id = store.dispatcher_id;
          } else if (store.dispatcher_name) {
            const dispatcher = allUsers.find((u) => {
              const userName = (u.user_name || u.full_name || '').toLowerCase().trim();
              const dispatcherName = store.dispatcher_name.toLowerCase().trim();
              return userName === dispatcherName;
            });
            if (dispatcher) {
              dispatcher_id = dispatcher.id;
            }
          }

          if (actualDriver) {
            const allCurrentDeliveries = await getData('Delivery');
            const hasPickupForStore = (allCurrentDeliveries || []).some((d) =>
            d.store_id === store.id &&
            d.patient_id === null &&
            d.delivery_date === staged.delivery_date && (
            d.driver_id === actualDriver.id || d.driver_name === actualDriver.full_name)
            );

            if (!hasPickupForStore) {
              await createDriverPickupStops(actualDriver, staged.delivery_date);
            }
          }

          const timeWindows = patient ?
          calculateOptimalTimeWindow(patient, store, [], staged.delivery_date) :
          { delivery_time_start: staged.time_window_start || '09:00', delivery_time_end: staged.time_window_end || '17:00' };

          const finalDeliveryData = {
            ...staged,
            delivery_time_start: staged.delivery_time_start || timeWindows.delivery_time_start,
            delivery_time_end: staged.delivery_time_end || timeWindows.delivery_time_end,
            store_id: store.id,
            dispatcher_id: dispatcher_id,
            driver_id: actualDriver?.id || null,
            driver_name: actualDriver ? getDriverNameForStorage(actualDriver) : '',
            tracking_number: 'temp',
            stop_order: 9999
          };

          delete finalDeliveryData._tempId;
          delete finalDeliveryData.store_name;
          delete finalDeliveryData.store_abbreviation;
          delete finalDeliveryData.distanceFromStore;
          delete finalDeliveryData.delivery_address;

          console.log(`✅ [Deliveries] Created delivery for ${staged.patient_name || 'pickup'}`);
          await Delivery.create(finalDeliveryData);

          if (actualDriver) {
            console.log(`🔄 [Deliveries] Optimizing route for store ${store.name}`);
            await optimizeRouteOrder(store.id, staged.delivery_date, actualDriver);
          }
        }

        console.log(`✅ [Deliveries] All ${stagedDeliveries.length} deliveries created, refreshing data...`);
        await invalidate('Delivery');
        const freshDeliveries = await Delivery.list('-created_date');
        setAllDeliveries(freshDeliveries || []);
        setShowDeliveryForm(false);
        setEditingDelivery(null);

        console.log(`✅ [Deliveries] Batch save complete - UI refreshed`);
        return;
      }

      const isEditing = !!editingDelivery;

      if (deliveryData._storeUpdates) {
        await Store.update(deliveryData._storeUpdates.id, { phone: deliveryData._storeUpdates.phone });
        await invalidate('Store');
        delete deliveryData._storeUpdates;
      }

      if (deliveryData._patientUpdates) {
        await Patient.update(deliveryData._patientUpdates.id, deliveryData._patientUpdates);
        await invalidate('Patient');
        delete deliveryData._patientUpdates;
      }

      let actualDriver = null;
      if (deliveryData.driver_id && deliveryData.driver_id !== 'unassigned') {
        actualDriver = allUsers.find((u) => u.id === deliveryData.driver_id);
        if (actualDriver) {
          deliveryData.driver_id = actualDriver.id;
          deliveryData.driver_name = getDriverNameForStorage(actualDriver);
        } else {
          deliveryData.driver_id = null;
          deliveryData.driver_name = '';
        }
      } else {
        deliveryData.driver_id = null;
        deliveryData.driver_name = '';
      }

      if (deliveryData.store_id && stores) {
        const selectedStore = stores.find((s) => s.id === deliveryData.store_id);
        if (selectedStore) {
          if (selectedStore.dispatcher_id) {
            deliveryData.dispatcher_id = selectedStore.dispatcher_id;
            console.log('✅ [Deliveries] Assigned dispatcher_id from store:', {
              store: selectedStore.name,
              dispatcher_id: selectedStore.dispatcher_id
            });
          } else if (selectedStore.dispatcher_name) {
            console.warn('⚠️ [Deliveries] Store has dispatcher_name but no dispatcher_id, falling back to name lookup');
            const dispatcher = allUsers.find((u) => {
              const userName = (u.user_name || u.full_name || '').toLowerCase().trim();
              const dispatcherName = selectedStore.dispatcher_name.toLowerCase().trim();
              return userName === dispatcherName;
            });
            if (dispatcher) {
              deliveryData.dispatcher_id = dispatcher.id;
              console.log('✅ [Deliveries] Found dispatcher via name fallback:', dispatcher.user_name || dispatcher.full_name);
            } else {
              deliveryData.dispatcher_id = null;
              console.warn('⚠️ [Deliveries] No dispatcher found for name:', selectedStore.dispatcher_name);
            }
          } else {
            deliveryData.dispatcher_id = null;
          }
        } else {
          deliveryData.dispatcher_id = null;
        }
      } else {
        deliveryData.dispatcher_id = null;
      }

      if (isEditing) {
        await Delivery.update(editingDelivery.id, deliveryData);
        await invalidate('Delivery');
      } else {
        const patient = (allPatients || []).find((p) => p && p.id === deliveryData.patient_id);
        if (!patient) throw new Error("Selected patient could not be found.");
        const store = (stores || []).find((s) => s && s.id === patient.store_id);
        if (!store) throw new Error("Patient's assigned store could not be found. Please check patient data.");

        const allCurrentDeliveries = await getData('Delivery');
        const existingDeliveriesForDriver = (allCurrentDeliveries || []).filter((d) =>
        (actualDriver && (d.driver_id === actualDriver.id || d.driver_id === actualDriver.appUserId) || !d.driver_id && actualDriver && d.driver_name === actualDriver.full_name) &&
        d.delivery_date === deliveryData.delivery_date
        );

        if (actualDriver) {
          const hasPickupForStore = existingDeliveriesForDriver.some((d) =>
          d.store_id === store.id && d.patient_id === null
          );

          if (!hasPickupForStore) {
            await createDriverPickupStops(actualDriver, deliveryData.delivery_date);
          }
        }

        const timeWindows = calculateOptimalTimeWindow(patient, store, existingDeliveriesForDriver, deliveryData.delivery_date);
        const finalDeliveryData = {
          ...deliveryData,
          delivery_time_start: deliveryData.delivery_time_start || timeWindows.delivery_time_start,
          delivery_time_end: deliveryData.delivery_time_end || timeWindows.delivery_time_end,
          store_id: store.id,
          tracking_number: 'temp',
          stop_order: 9999
        };

        await Delivery.create(finalDeliveryData);
        await invalidate('Delivery');

        if (actualDriver) {
          await optimizeRouteOrder(store.id, deliveryData.delivery_date, actualDriver);
        }
      }

      const freshDeliveries = await Delivery.list('-created_date');
      setAllDeliveries(freshDeliveries || []);

      setShowDeliveryForm(false);
      setEditingDelivery(null);

    } catch (error) {
      console.error("Error saving delivery:", error);
      alert(`Failed to save delivery: ${error.message}`);
    }
  }, [editingDelivery, allPatients, stores, setShowDeliveryForm, setEditingDelivery, createDriverPickupStops, calculateOptimalTimeWindow, optimizeRouteOrder, effectiveDrivers, setAllDeliveries, allUsers]);

  const handleImportComplete = useCallback(async () => {
    console.log('✅ [Deliveries] Route import completed, refreshing data...');

    try {
      setShowImportModal(false);

      console.log('🗑️ [Deliveries] Invalidating all caches...');

      invalidate('Delivery');
      invalidate('Patient');
      invalidate('Store');
      invalidate('User');
      invalidate('AppUser');
      invalidate('City');

      console.log('🔄 [Deliveries] Forcing data refresh...');

      await new Promise((resolve) => setTimeout(resolve, 100));

      const [freshDeliveries, freshPatients, freshStores, freshAppUsers, freshCities] = await Promise.all([
      getData('Delivery', '-delivery_date', null, true),
      getData('Patient', 'full_name', null, true),
      getData('Store', '-created_date', null, true),
      getData('AppUser', '-created_date', null, true),
      getData('City', '-created_date', null, true)]
      );

      console.log('📊 [Deliveries] Fetched fresh data:', {
        deliveries: freshDeliveries?.length || 0,
        patients: freshPatients?.length || 0,
        stores: freshStores?.length || 0,
        appUsers: freshAppUsers?.length || 0,
        cities: freshCities?.length || 0
      });

      if (isMounted.current) {
        setAllDeliveries(freshDeliveries || []);
        setAllPatients(freshPatients || []);
        setStores(freshStores || []);
        setCities(freshCities || []);

        let allAuthUsers = [];
        if (currentUser?.role === 'admin' || isAppOwner(currentUser)) {
          const usersData = await getData('User', '-created_date', null, true);
          allAuthUsers = (usersData || []).filter((u) => u.role === 'admin' || u.role === 'user');
        }

        let mergedUsers = [];
        if (allAuthUsers.length > 0) {
          mergedUsers = allAuthUsers.map((authUser) => {
            const appUser = (freshAppUsers || []).find((au) => au.user_id === authUser.id);
            if (appUser) {
              return {
                ...authUser,
                ...appUser,
                id: authUser.id,
                appUserId: appUser.id,
                user_name: appUser.user_name || authUser.full_name,
                app_roles: appUser.app_roles || ['driver'],
                display_name: appUser.user_name || authUser.full_name,
                first_name: authUser.full_name.split(' ')[0]
              };
            }
            return {
              ...authUser,
              user_name: authUser.full_name,
              app_roles: ['driver'],
              display_name: authUser.full_name,
              first_name: authUser.full_name.split(' ')[0]
            };
          });
        } else {
          mergedUsers = (freshAppUsers || []).map((appUser) => {
            return {
              id: appUser.user_id,
              appUserId: appUser.id,
              email: `${appUser.user_name}@unknown.com`,
              full_name: appUser.user_name,
              role: 'user',
              ...appUser,
              user_name: appUser.user_name,
              app_roles: appUser.app_roles || ['driver'],
              display_name: appUser.user_name,
              first_name: appUser.user_name ? appUser.user_name.split(' ')[0] : ''
            };
          });
        }

        mergedUsers = mergedUsers.filter((u) => {
          const userNameLower = (u.user_name || '').toLowerCase();
          const storePatterns = [
          '.shoppers',
          'shoppers.',
          '.pharmacy',
          'pharmacy.',
          'rite.choice',
          'rite-choice',
          'ritechoice'];

          const isStoreAccount = storePatterns.some((pattern) => userNameLower.includes(pattern));
          if (isStoreAccount) return false;

          const matchesStoreName = (freshStores || []).some((store) => {
            const storeName = (store.name || '').toLowerCase();
            const storeAbbr = (store.abbreviation || '').toLowerCase();
            return userNameLower === storeName || userNameLower === storeAbbr;
          });
          return !matchesStoreName;
        });

        mergedUsers = mergedUsers.filter((u) => {
          const roles = Array.isArray(u.app_roles) ? u.app_roles : u.app_role ? [u.app_role] : [];
          const hasRole = roles.some((r) => r === 'driver' || r === 'admin' || r === 'dispatcher');
          const statusOk = isDriverOverviewMode ? u.status === 'active' || u.status === 'inactive' : u.status === 'active';
          return hasRole && statusOk;
        });

        setAllUsers(sortUsers(mergedUsers));

        setRefreshKey((k) => k + 1);

        console.log('✅ [Deliveries] Data refresh complete after import');
      }

    } catch (error) {
      console.error('❌ [Deliveries] Error during post-import refresh:', error);
      alert('Import completed but there was an error refreshing the display. Please refresh the page.');
    }
  }, [currentUser, isDriverOverviewMode, isMounted]);

  const handleOpenRouteImport = useCallback(() => {
    setShowImportModal(true);
  }, [setShowImportModal]);

  const handleEditDelivery = useCallback((delivery) => {
    setEditingDelivery(delivery);
    setShowDeliveryForm(true);
  }, [setEditingDelivery, setShowDeliveryForm]);

  const handleEditPatient = useCallback((patientId) => {
    const patientToEdit = (allPatients || []).find((p) => p && p.id === patientId);
    if (patientToEdit) {
      setEditingPatient(patientToEdit);
      alert(`Edit Patient: ${patientToEdit.full_name} (ID: ${patientToEdit.id}) - Form not yet implemented.`);
      console.log('Editing patient:', patientToEdit);
    }
  }, [allPatients]);

  const handleStatusUpdate = useCallback(async (deliveryId, newStatus) => {
    try {
      const delivery = (effectiveDeliveries || []).find((d) => d.id === deliveryId);
      if (!delivery) return;

      const updateData = { status: newStatus };

      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const isFinishing = finishedStatuses.includes(newStatus);
      const wasFinished = finishedStatuses.includes(delivery.status);

      const todayString = format(new Date(), 'yyyy-MM-dd');
      const isToday = delivery.delivery_date === todayString;

      if (isFinishing && isToday && !delivery.actual_delivery_time) {
        const now = new Date();
        if (now && typeof now.toISOString === 'function') {
          updateData.actual_delivery_time = now.toISOString();
          console.log('✅ [Deliveries] Set timestamp for finished status:', newStatus);
        }
      }

      if (wasFinished && !isFinishing) {
        updateData.actual_delivery_time = null;
        console.log('🗑️ [Deliveries] Cleared timestamp - moving from finished to active');
      }

      await updateDeliveryLocal(deliveryId, updateData);

      if (newStatus === 'completed' && delivery.patient_id) {
        const { updatePatientLocal } = await import('../components/utils/offlineMutations');
        await updatePatientLocal(delivery.patient_id, {
          last_delivery_date: delivery.delivery_date
        });
        await invalidate('Patient');
      }

      setAllDeliveries((prev) =>
      prev.map((d) => d.id === deliveryId ? { ...d, ...updateData, updated_date: new Date().toISOString() } : d)
      );

      invalidate('Delivery');

      const isPickup = delivery.patient_id === null;
      if (isPickup && newStatus === 'picked_up') {
        const relatedDeliveries = (effectiveDeliveries || []).filter((d) =>
        d && d.store_id === delivery.store_id &&
        d.delivery_date === delivery.delivery_date &&
        d.driver_name === delivery.driver_name &&
        d.patient_id &&
        ['pending', 'Ready For Pickup'].includes(d.status)
        );

        const updatePromises = relatedDeliveries.map((d) =>
        updateDeliveryLocal(d.id, { status: 'in_transit' })
        );
        await Promise.all(updatePromises);
        console.log(`✅ [Deliveries] Updated ${relatedDeliveries.length} deliveries to in_transit after pickup`);

        setAllDeliveries((prev) =>
        prev.map((d) => {
          const updated = relatedDeliveries.find((rd) => rd.id === d.id);
          return updated ? { ...d, status: 'in_transit', updated_date: new Date().toISOString() } : d;
        })
        );
      }

    } catch (error) {
      console.error('Error updating delivery status:', error);
    }
  }, [effectiveDeliveries, setAllDeliveries]);

  const handleNotesUpdate = useCallback(async (deliveryId, newNotes) => {
    try {
      await updateDeliveryLocal(deliveryId, { delivery_notes: newNotes });
      setAllDeliveries((prev) =>
      prev.map((d) => d.id === deliveryId ? { ...d, delivery_notes: newNotes, updated_date: new Date().toISOString() } : d)
      );
      invalidate('Delivery');
    } catch (error) {
      console.error("Error updating delivery notes:", error);
      alert("Failed to update delivery notes.");
    }
  }, [setAllDeliveries]);

  const handleCODUpdate = useCallback(async (deliveryId, requiresCod) => {
    try {
      await updateDeliveryLocal(deliveryId, { requires_cod: requiresCod });
      setAllDeliveries((prev) =>
      prev.map((d) => d.id === deliveryId ? { ...d, requires_cod: requiresCod, updated_date: new Date().toISOString() } : d)
      );
      invalidate('Delivery');
    } catch (error) {
      console.error("Error updating COD status:", error);
      alert("Failed to update COD status.");
    }
  }, [setAllDeliveries]);

  const handleRestartDelivery = useCallback(async (deliveryId) => {
    if (!confirm('Are you sure you want to retry this delivery? It will be marked as pending.')) return;
    try {
      await updateDeliveryLocal(deliveryId, { status: 'pending', actual_delivery_time: null });
      setAllDeliveries((prev) =>
      prev.map((d) => d.id === deliveryId ? { ...d, status: 'pending', actual_delivery_time: null, updated_date: new Date().toISOString() } : d)
      );
      invalidate('Delivery');
    } catch (error) {
      console.error("Error retrying delivery:", error);
      alert("Failed to retry delivery.");
    }
  }, [setAllDeliveries]);

  const handleReturn = useCallback(async (deliveryId) => {
    if (!confirm('Are you sure you want to mark this delivery for return? It will be marked as returned and completed.')) return;
    try {
      const now = new Date();
      const updateData = {
        status: 'returned',
        actual_delivery_time: now.toISOString()
      };
      await updateDeliveryLocal(deliveryId, updateData);
      setAllDeliveries((prev) =>
      prev.map((d) => d.id === deliveryId ? { ...d, ...updateData, updated_date: new Date().toISOString() } : d)
      );
      invalidate('Delivery');
    } catch (error) {
      console.error("Error returning delivery:", error);
      alert("Failed to mark delivery for return.");
    }
  }, [setAllDeliveries]);

  const handleDeleteDelivery = useCallback(async (deliveryId) => {
    try {
      console.log('🗑️ [Deliveries] Deleting delivery:', deliveryId);

      // CRITICAL: Update UI immediately first (optimistic update)
      setAllDeliveries((prev) => {
        const filtered = prev.filter((d) => d.id !== deliveryId);
        console.log(`✅ [Deliveries] Local state updated: ${prev.length} → ${filtered.length}`);
        return filtered;
      });

      // Delete from offline DB and sync to backend
      // This will trigger mutation listeners to update Layout context
      await deleteDeliveryLocal(deliveryId);

      invalidate('Delivery');
      console.log('✅ [Deliveries] Delivery deleted successfully');
    } catch (error) {
      console.error("Error deleting delivery:", error);
      alert("Failed to delete delivery.");
      // Revert optimistic update on error
      await loadData(true);
    }
  }, [loadData]);

  const handleMapView = useCallback(() => {
    setShowRouteMap(true);
  }, [setShowRouteMap]);

  const driverOverviewStats = useMemo(() => {
    if (isDriverOverviewMode || !activeDriver) return null;

    const driverDeliveriesForSelectedDate = (selectedDateDeliveries || []).filter(
      (d) =>
      d.driver_id && (d.driver_id === activeDriver.id || d.driver_id === activeDriver.appUserId) ||
      !d.driver_id && d.driver_name && (d.driver_name === activeDriver.full_name || d.driver_name === activeDriver.user_name)
    );

    const totalStops = driverDeliveriesForSelectedDate.length;

    // Helper to check if delivery is a return (by notes or address)
    const isReturnDelivery = (d) => {
      const patient = (effectivePatients || []).find((p) => p.id === d.patient_id);
      const notesReturn = (d.delivery_notes || '').toLowerCase().includes('return');
      const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
      return notesReturn || addressReturn;
    };

    // Completed should NOT include failed, returned, or cancelled statuses
    const completed = driverDeliveriesForSelectedDate.filter((d) =>
    d.status === 'completed' &&
    !['failed', 'returned', 'cancelled'].includes(d.status) &&
    !isReturnDelivery(d)
    ).length;

    const returned = driverDeliveriesForSelectedDate.filter((d) => isReturnDelivery(d)).length;

    const failed = driverDeliveriesForSelectedDate.filter((d) => d.status === 'failed').length;

    return { totalStops, completed, failed, returned };
  }, [isDriverOverviewMode, selectedDateDeliveries, activeDriver, effectivePatients]);

  const [statCardBaseWidth, setStatCardBaseWidth] = React.useState(0);
  const handleStatMeasure = React.useCallback((w) => {
    setStatCardBaseWidth((prev) => w > prev ? w : prev);
  }, []);

  function StatBox({ value, label, valueClass, onMeasure, fixedWidth }) {
    const ref = React.useRef(null);
    React.useEffect(() => {
      if (ref.current && onMeasure) {
        const w = ref.current.getBoundingClientRect().width;
        onMeasure(Math.ceil(w));
      }
    }, [value, label, onMeasure]);
    return (
      <div
        ref={ref}
        className="px-3 py-2 rounded-lg text-center inline-flex flex-col items-center justify-center shadow-sm"
        style={{ background: 'var(--bg-slate-100)', ...(fixedWidth ? { width: fixedWidth } : {}) }}>

        <p className={`text-2xl font-bold ${valueClass}`}>{value}</p>
        <p className="text-xs" style={{ color: 'var(--text-slate-500)' }}>{label}</p>
      </div>);

  }

  const activeDriverDeliveries = React.useMemo(() => {
    if (!activeDriver || !selectedDateDeliveries || !Array.isArray(selectedDateDeliveries)) return [];
    return selectedDateDeliveries.filter((d) =>
    d?.driver_id && (d.driver_id === activeDriver.id || d.driver_id === activeDriver.appUserId) ||
    !d?.driver_id && d?.driver_name && (d.driver_name === activeDriver.user_name || d.driver_name === activeDriver.full_name)
    );
  }, [selectedDateDeliveries, activeDriver]);

  const projectedRoutes = React.useMemo(() => {
    if (!activeDriver || activeDriverDeliveries.length > 0) {
      return { pickups: [], deliveries: [], stopOrderMap: {} };
    }

    const dateObj = selectedDate instanceof Date ? selectedDate : new Date(selectedDate);
    const dateString = !isNaN(dateObj.getTime()) ? format(dateObj, 'yyyy-MM-dd') : String(selectedDate || '');
    if (!dateString) return { pickups: [], deliveries: [], stopOrderMap: {} };

    const day = dateObj.getDay();
    const isSaturday = day === 6;
    const isSunday = day === 0;

    const driverName = activeDriver.user_name || activeDriver.full_name || '';
    if (!driverName) return { pickups: [], deliveries: [], stopOrderMap: {} };

    const patientsSource = typeof effectivePatients !== 'undefined' && Array.isArray(effectivePatients) && effectivePatients?.length ?
    effectivePatients :
    typeof allPatients !== 'undefined' && Array.isArray(allPatients) ? allPatients || [] : [];

    const isPatientDue = (patient) => {
      if (!patient || !patient.last_delivery_date) return false;
      const notes = (patient.notes || '').toLowerCase();
      const [ly, lm, ld] = patient.last_delivery_date.split('-').map(Number);
      const lastDelivery = new Date(ly, lm - 1, ld);
      lastDelivery.setHours(0, 0, 0, 0);
      const current = new Date(dateObj);
      current.setHours(0, 0, 0, 0);
      if (current <= lastDelivery) return false;
      const daysSince = Math.round((current - lastDelivery) / (1000 * 60 * 60 * 24));
      if (daysSince > 90) return false;

      const dayOfWeekShort = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][current.getDay()];

      if (notes.includes('daily')) return daysSince >= 1;

      const weeklyMatch = notes.match(/weekly\s*\((mon|tue|wed|thu|fri|sat|sun)\)/i);
      if (weeklyMatch) {
        const scheduledDay = weeklyMatch[1].toLowerCase();
        if (dayOfWeekShort === scheduledDay) {
          return daysSince >= 7;
        }
      }

      const biWeeklyMatch = notes.match(/bi-weekly\s*\((mon|tue|wed|thu|fri|sat|sun)\)/i);
      if (biWeeklyMatch) {
        const scheduledDay = biWeeklyMatch[1].toLowerCase();
        if (dayOfWeekShort === scheduledDay) {
          return daysSince >= 13;
        }
      }

      if (notes.includes('bi-weekly')) return daysSince >= 13 && daysSince <= 15;
      if (notes.includes('weekly x4')) return daysSince >= 26 && daysSince <= 31 && daysSince % 28 === 0;
      if (notes.includes('monthly')) return daysSince >= 28 && daysSince <= 31;
      if (notes.includes('weekly')) return daysSince >= 7;
      return daysSince > 0 && daysSince % 7 === 0;
    };

    const getFrequencyPriority = (patient) => {
      const n = (patient.notes || '').toLowerCase();
      if (n.includes('daily')) return 1;
      if (n.includes('weekly') && !n.includes('bi-weekly') && !n.includes('weekly x4')) return 2;
      if (n.includes('bi-weekly')) return 3;
      if (n.includes('weekly x4')) return 4;
      if (n.includes('monthly')) return 5;
      return 6;
    };

    const relevantStores = (stores || []).filter((store) => {
      if (isSaturday) {
        return store.saturday_am_enabled && (store.driver_saturday_am_id === activeDriver.id || store.driver_saturday_am_id === activeDriver.appUserId || store.driver_saturday_am === driverName) ||
        store.saturday_pm_enabled && (store.driver_saturday_pm_id === activeDriver.id || store.driver_saturday_pm_id === activeDriver.appUserId || store.driver_saturday_pm === driverName);
      }
      if (isSunday) {
        return store.sunday_am_enabled && (store.sunday_am_driver_id === activeDriver.id || store.sunday_am_driver_id === activeDriver.appUserId || store.sunday_am_driver === driverName) ||
        store.sunday_pm_enabled && (store.sunday_pm_driver_id === activeDriver.id || store.sunday_pm_driver_id === activeDriver.appUserId || store.sunday_pm_driver === driverName);
      }
      return store.weekday_am_enabled && (store.weekday_am_driver_id === activeDriver.id || store.weekday_am_driver_id === activeDriver.appUserId || store.weekday_am_driver === driverName) ||
      store.weekday_pm_enabled && (store.weekday_pm_driver_id === activeDriver.id || store.weekday_pm_driver_id === activeDriver.appUserId || store.weekday_pm_driver === driverName);
    }).sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999));

    const pickups = [];
    const flatDeliveries = [];
    const stopOrderMap = {};
    let segmentIndex = 0;

    const exclusionKeywords = ['\\(Old', '\\(Wrong', '\\(Deceased', 'DMR', 'RFD', 'RTN', 'Return', '\\(ISP\\)', '\\(ISD\\)', 'InterStore'];
    const exclusionRegex = new RegExp(exclusionKeywords.join('|'), 'i');

    relevantStores.forEach((store) => {
      const timeSlots = [];
      if (isSaturday) {
        if (store.saturday_am_enabled && (store.driver_saturday_am_id === activeDriver.id || store.driver_saturday_am_id === activeDriver.appUserId || store.driver_saturday_am === driverName)) {
          timeSlots.push({ period: 'am', start: store.saturday_am_start, end: store.saturday_am_end });
        }
        if (store.saturday_pm_enabled && (store.driver_saturday_pm_id === activeDriver.id || store.driver_saturday_pm_id === activeDriver.appUserId || store.driver_saturday_pm === driverName)) {
          timeSlots.push({ period: 'pm', start: store.saturday_pm_start, end: store.saturday_pm_end });
        }
      } else if (isSunday) {
        if (store.sunday_am_enabled && (store.sunday_am_driver_id === activeDriver.id || store.sunday_am_driver_id === activeDriver.appUserId || store.sunday_am_driver === driverName)) {
          timeSlots.push({ period: 'am', start: store.sunday_am_start, end: store.sunday_am_end });
        }
        if (store.sunday_pm_enabled && (store.sunday_pm_driver_id === activeDriver.id || store.sunday_pm_driver_id === activeDriver.appUserId || store.sunday_pm_driver === driverName)) {
          timeSlots.push({ period: 'pm', start: store.sunday_pm_start, end: store.sunday_pm_end });
        }
      } else {
        if (store.weekday_am_enabled && (store.weekday_am_driver_id === activeDriver.id || store.weekday_am_driver_id === activeDriver.appUserId || store.weekday_am_driver === driverName)) {
          timeSlots.push({ period: 'am', start: store.weekday_am_start, end: store.weekday_am_end });
        }
        if (store.weekday_pm_enabled && (store.weekday_pm_driver_id === activeDriver.id || store.weekday_pm_driver_id === activeDriver.appUserId || store.weekday_pm_driver === driverName)) {
          timeSlots.push({ period: 'pm', start: store.weekday_pm_start, end: store.weekday_pm_end });
        }
      }

      timeSlots.forEach(({ period, start, end }) => {
        if (!start) return;
        segmentIndex += 1;
        const isAM = period === 'am';

        const storePatients = (patientsSource || []).
        filter((p) => p?.status === 'active' && p.store_id === store.id).
        filter((p) => {
          const combinedText = `${p.full_name || ''} ${p.address || ''} ${p.notes || ''}`;
          if (exclusionRegex.test(combinedText)) return false;

          if (isAM) {
            return !(p.notes || '').toLowerCase().includes('pm delivery');
          } else {
            return !(p.notes || '').toLowerCase().includes('am delivery');
          }
        }).
        map((p) => ({
          id: `projected-delivery-${p.id}-${dateString}-${period}-${store.id}`,
          patient_id: p.id,
          patient_name: p.full_name,
          store_id: p.store_id,
          driver_name: driverName,
          delivery_date: dateString,
          delivery_address: p.address,
          delivery_instructions: p.notes,
          latitude: p.latitude,
          longitude: p.longitude,
          delivery_time_start: p.time_window_start || null,
          delivery_time_end: p.time_window_end || null,
          status: 'projected',
          isProjected: true,
          isPickup: false,
          phone: p.phone,
          tracking_number: 'temp',
          frequencyPriority: getFrequencyPriority(p),
          distance_from_store: p.distance_from_store || 0
        }));

        storePatients.sort((a, b) => {
          if (a.frequencyPriority !== b.frequencyPriority) return a.frequencyPriority - b.frequencyPriority;
          const tA = a.delivery_time_start || '00:00';
          const tB = b.delivery_time_start || '00:00';
          if (tA !== tB) return tA.localeCompare(tB);
          if (a.distance_from_store !== b.distance_from_store) return a.distance_from_store - b.distance_from_store;
          return a.patient_name.localeCompare(b.patient_name);
        });

        const storeAbbr = store.abbreviation || 'ST';
        const pickupId = `projected-pickup-${store.id}-${dateString}-${period}-${segmentIndex}`;
        const pickupCard = {
          id: pickupId,
          patient_id: null,
          store_id: store.id,
          delivery_date: dateString,
          delivery_time_start: start,
          delivery_time_end: end || addMinutesToTime(start, 60),
          status: 'projected',
          driver_name: driverName,
          tracking_number: `${storeAbbr}PU${String(segmentIndex).padStart(2, '0')}`,
          delivery_notes: `Projected Pickup`,
          delivery_address: store.address,
          isProjected: true,
          isPickup: true,
          sortTime: start,
          latitude: store.latitude,
          longitude: store.longitude,
          full_name: `${store.name} ${period.toUpperCase()} Pickup`,
          alias_name: store.abbreviation,
          color: store.color,
          projected_deliveries: [],
          phone: store.phone
        };

        let currentTime = pickupCard.delivery_time_end;
        let lastLat = store.latitude;
        let lastLng = store.longitude;
        const baseSegment = segmentIndex * 100;

        storePatients.forEach((d, idx) => {
          const drive = estimateDriveTimeMinutes(lastLat, lastLng, d.latitude, d.longitude);
          currentTime = addMinutesToTime(currentTime, drive);
          if (d.delivery_time_start && currentTime && d.delivery_time_start > currentTime) {
            currentTime = d.delivery_time_start;
          }
          d.delivery_time_start = currentTime;
          d.delivery_time_end = addMinutesToTime(currentTime, 15);
          d.sortTime = currentTime;
          d.tracking_number = `${storeAbbr}${String(baseSegment + idx + 1).padStart(3, '0')}`;
          lastLat = d.latitude;
          lastLng = d.longitude;
          pickupCard.projected_deliveries.push(d);
          flatDeliveries.push(d);
        });

        pickups.push(pickupCard);
        flatDeliveries.push(pickupCard);
      });
    });

    flatDeliveries.sort((a, b) => {
      const tA = a.sortTime || a.delivery_time_start || '00:00';
      const tB = b.sortTime || b.delivery_time_start || '00:00';
      if (tA !== tB) return tA.localeCompare(tB);
      return (a.tracking_number || '').localeCompare(b.tracking_number || '');
    });
    flatDeliveries.forEach((s, i) => {stopOrderMap[s.id] = i + 1;});
    pickups.sort((a, b) => (a.sortTime || '00:00').localeCompare(b.sortTime || '00:00'));

    return { pickups, deliveries: flatDeliveries, stopOrderMap };
  }, [activeDriver, activeDriverDeliveries.length, stores, effectivePatients, allPatients, selectedDate]);

  const ProjectedDeliveryList = ({ deliveries, stopOrderMap }) =>
  <div className="mt-3">
      <div className="max-h-48 overflow-y-auto border rounded-lg">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-100/80 backdrop-blur-sm z-10">
            <tr>
              <th className="text-left font-medium p-2 w-10">#</th>
              <th className="text-left font-medium p-2">TR#</th>
              <th className="text-left font-medium p-2">Patient</th>
              <th className="text-right font-medium p-2">Dist</th>
            </tr>
          </thead>
          <tbody className="bg-white">
            {deliveries.map((d) => {
            const stopNumber = stopOrderMap[d.id];
            const trackingNumber = d.tracking_number || '';
            const storeAbbr = trackingNumber.substring(0, 2);
            return (
              <tr key={d.id} className="border-b border-slate-100 last:border-b-0">
                  <td className="p-2 font-medium">{stopNumber}</td>
                  <td className="p-2 font-mono">{trackingNumber.replace(storeAbbr, '')}</td>
                  <td className="p-2 truncate">{d.patient_name}</td>
                  <td className="p-2 truncate text-right">{(d.distance_from_store ?? 0).toFixed(1)}km</td>
                </tr>);

          })}
          </tbody>
        </table>
      </div>
    </div>;


  const ProjectedPickupCard = ({ pickup, stopOrder, stopOrderMap }) => {
    if (!pickup || !pickup.isProjected) return null;
    return (
      <div className="w-80 flex-shrink-0">
        <div className="w-full overflow-hidden shadow-lg border border-slate-200 rounded-lg bg-white">
          <div className="p-4 flex flex-col gap-2">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 text-lg font-bold text-white w-8 h-8 flex items-center justify-center rounded-md"
              style={{ backgroundColor: pickup.color || '#71717A' }}>
                {stopOrder}
              </div>
              <div className="flex-grow min-w-0">
                <div className="flex justify-between items-start">
                  <h3 className="font-bold text-slate-800 text-sm truncate">{pickup.full_name}</h3>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-yellow-100 text-yellow-800 border border-yellow-200">PROJECTED</span>
                </div>
                <div className="text-xs text-slate-600 mt-1 space-y-0.5">
                  <p>ETA: {pickup.delivery_time_start}</p>
                  <p className="truncate">{pickup.delivery_address}</p>
                  {pickup.phone && <p>{formatPhoneNumber(pickup.phone)}</p>}
                </div>
              </div>
              <div className="flex-shrink-0">
                <span className="font-mono text-xs px-2 py-0.5 rounded" style={{ backgroundColor: `${pickup.color || '#71717A'}20`, color: pickup.color || '#71717A' }}>
                  {pickup.tracking_number}
                </span>
              </div>
            </div>
            <ProjectedDeliveryList deliveries={pickup.projected_deliveries || []} stopOrderMap={stopOrderMap} />
          </div>
        </div>
      </div>);

  };


  const handleYearChange = useCallback((year) => {
    const newYear = parseInt(year);
    setSelectedYear(newYear);
    updateUrl({ year: newYear, month: selectedMonth + 1 });
  }, [selectedMonth, updateUrl]);

  const handleMonthChange = useCallback((month) => {
    const newMonth = parseInt(month);
    setSelectedMonth(newMonth);
    updateUrl({ year: selectedYear, month: newMonth + 1 });
  }, [selectedYear, updateUrl]);

  const handleDateSelect = useCallback((dateString) => {
    if (!dateString) {
      console.warn('[handleDateSelect] No date string provided');
      return;
    }

    try {
      const [year, month, day] = dateString.split('-').map(Number);

      if (isNaN(year) || isNaN(month) || isNaN(day)) {
        console.error('[handleDateSelect] Invalid date components:', { year, month, day });
        return;
      }

      const dateObj = new Date(year, month - 1, day);
      dateObj.setHours(0, 0, 0, 0);

      if (isNaN(dateObj.getTime())) {
        console.error('[handleDateSelect] Invalid date object created');
        return;
      }

      console.log('📅 [handleDateSelect] Setting date:', dateString);

      setSelectedDate(dateObj);
      // CRITICAL: Do NOT add date to URL - keep date selection local to page
    } catch (error) {
      console.error('[handleDateSelect] Error:', error);
    }
  }, []);

  const handleSearchChange = useMemo(() => debounce((value) => {
    setSearchTerm(value);
  }, 100), []);

  const handleDriverChange = useCallback((driverId) => {
    try {
      const driverDeliveries = (effectiveDeliveries || []).filter((d) =>
      d.driver_id && (d.driver_id === driverId || d.driver_id === (effectiveDrivers || []).find((dr) => dr.id === driverId)?.appUserId) ||
      !d.driver_id && d.driver_name && (d.driver_name === (effectiveDrivers || []).find((dr) => dr.id === driverId)?.full_name || d.driver_name === (effectiveDrivers || []).find((dr) => dr.id === driverId)?.user_name)
      );

      let targetDate = new Date();
      targetDate.setHours(0, 0, 0, 0);

      if (driverDeliveries.length > 0) {
        const latest = [...driverDeliveries].sort(
          (a, b) => new Date(b.delivery_date.replace(/-/g, '/')) - new Date(a.delivery_date.replace(/-/g, '/'))
        )[0];
        if (latest?.delivery_date) {
          const [y, m, d] = latest.delivery_date.split('-').map(Number);
          if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
            targetDate = new Date(y, m - 1, d);
            targetDate.setHours(0, 0, 0, 0);
          }
        }
      }

      if (isNaN(targetDate.getTime())) {
        console.error('[handleDriverChange] Invalid target date');
        return;
      }

      const targetYear = targetDate.getFullYear();
      const targetMonth = targetDate.getMonth();

      console.log('🎯 [handleDriverChange] Updating filters:', {
        driver: driverId,
        year: targetYear,
        month: targetMonth + 1
      });

      setDriverFilter(driverId);
      setSelectedDate(targetDate);
      setSelectedYear(targetYear);
      setSelectedMonth(targetMonth);

      // CRITICAL: Only use year/month/driver in URL, no date param
      updateUrl({
        driver: driverId,
        year: targetYear.toString(),
        month: (targetMonth + 1).toString()
      });
    } catch (error) {
      console.error('[handleDriverChange] Error:', error);
    }
  }, [effectiveDrivers, effectiveDeliveries, updateUrl]);



  // CRITICAL: Offline-first driver stats with smart refresh
  const [backendDriverStats, setBackendDriverStats] = useState(null);
  const [isLoadingStats, setIsLoadingStats] = useState(false);
  const lastStatsParamsRef = useRef({ year: null, timestamp: 0 });

  // CRITICAL: Fetch full-year driver stats from backend function and cache in offline DB
  useEffect(() => {
    if (!isDriverOverviewMode || !currentUser) return;

    // CRITICAL: Prevent re-fetching with same parameters within 5 seconds
    const cacheKey = `${selectedOverviewYear}-${currentUser.id}`;
    const now = Date.now();
    if (lastStatsParamsRef.current.year === cacheKey && now - lastStatsParamsRef.current.timestamp < 5000) {
      console.log('⏸️ [Deliveries] Skipping stats fetch - cached params:', cacheKey);
      return;
    }

    const loadDriverStats = async () => {
      setIsLoadingStats(true);
      try {
        const { offlineDB: offlineDBInstance } = await import('../components/utils/offlineDatabase');

        // Build storeIds filter for dispatchers
        let storeIdsFilter = null;
        if (userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
          storeIdsFilter = currentUser.store_ids || [];
        }

        const storeIdsHash = storeIdsFilter && storeIdsFilter.length > 0 ? storeIdsFilter.sort().join(',') : 'all';

        // CRITICAL: Check offline DB FIRST for cached stats
        const cachedStatsRecords = await offlineDBInstance.getAll(offlineDBInstance.STORES.DRIVER_OVERVIEW_STATS);
        const cachedStats = cachedStatsRecords?.find((s) => s.year === (selectedOverviewYear || 'all') && s.store_ids_hash === storeIdsHash);

        if (cachedStats) {
          const cacheAge = Date.now() - new Date(cachedStats.calculated_at).getTime();
          const cacheAgeMinutes = Math.round(cacheAge / 60000);
          console.log(`✅ [Deliveries] Loaded driver stats from offline DB (age: ${cacheAgeMinutes}min)`);
          setBackendDriverStats(cachedStats.driver_stats || []);
          lastStatsParamsRef.current = { year: cacheKey, timestamp: now };
          setIsLoadingStats(false);
          return;
        }

        // CRITICAL: Fetch from backend if not cached
        console.log(`📥 [Deliveries] Fetching full-year driver stats from backend for year: ${selectedOverviewYear}`);
        const yearStart = `${selectedOverviewYear || new Date().getFullYear()}-01-01`;
        const yearEnd = `${selectedOverviewYear || new Date().getFullYear()}-12-31`;

        const response = await base44.functions.invoke('getAdminMetricsAndPayrollData', {
          payrollYear: selectedOverviewYear || new Date().getFullYear(),
          payrollCityId: selectedCityId === 'all' ? null : selectedCityId,
          payrollDriverId: null,
          payrollStartDate: yearStart,
          payrollEndDate: yearEnd
        });

        const statsData = response?.data?.driverOverviewStats || response?.driverOverviewStats || [];
        console.log(`✅ [Deliveries] Fetched ${statsData.length} driver stats from backend`);

        // CRITICAL: Cache in offline DB for future use
        if (statsData.length > 0) {
          const cacheRecord = {
            year: selectedOverviewYear || 'all',
            store_ids_hash: storeIdsHash,
            driver_stats: statsData,
            calculated_at: new Date().toISOString()
          };
          await offlineDBInstance.save(offlineDBInstance.STORES.DRIVER_OVERVIEW_STATS, cacheRecord);
          console.log(`💾 [Deliveries] Cached ${statsData.length} driver stats in offline DB`);
        }

        setBackendDriverStats(statsData);
        lastStatsParamsRef.current = { year: cacheKey, timestamp: now };
      } catch (error) {
        console.error('❌ [Deliveries] Failed to load driver stats:', error);
        setBackendDriverStats([]);
      } finally {
        setIsLoadingStats(false);
      }
    };

    loadDriverStats();
  }, [isDriverOverviewMode, selectedOverviewYear, selectedCityId, currentUser?.id]);

  const driverCards = useMemo(() => {
    if (!isDriverOverviewMode) {
      return [];
    }

    console.log('🎯 Building driver cards for overview mode');
    console.log(`👤 Current user:`, currentUser?.user_name || currentUser?.full_name);
    console.log(`👤 User roles:`, currentUser?.app_roles);
    console.log(`📊 Total users in allUsers:`, allUsers?.length || 0);
    console.log(`📊 Total users in effectiveDrivers:`, effectiveDrivers?.length || 0);
    console.log(`📅 Selected overview year: ${selectedOverviewYear}`);
    console.log(`📍 Selected City ID: ${selectedCityId}`);
    console.log(`📊 Backend stats available: ${backendDriverStats ? 'YES' : 'NO'}`);

    // CRITICAL: Always use allDeliveries for Driver Overview (never fall back to contextDeliveries which is date-filtered)
    const deliveriesToUse = allDeliveries?.length > 0 ? allDeliveries : [];
    const patientsToUse = allPatients?.length > 0 ? allPatients : contextPatients;
    const usersToUse = allUsers?.length > 0 ? allUsers : contextUsers;

    console.log(`🔍 [DriverCards] Data sources selected:`, {
      deliveries: deliveriesToUse.length,
      deliveriesSource: allDeliveries?.length > 0 ? 'allDeliveries' : 'contextDeliveries',
      patients: patientsToUse.length,
      patientsSource: allPatients?.length > 0 ? 'allPatients' : 'contextPatients',
      users: usersToUse.length,
      usersSource: allUsers?.length > 0 ? 'allUsers' : 'contextUsers'
    });

    if (!deliveriesToUse || !Array.isArray(deliveriesToUse)) {
      console.warn('⚠️ No deliveries available');
      return [];
    }

    if (!usersToUse || usersToUse.length === 0) {
      console.warn('⚠️ No users available');
      return [];
    }

    if (!patientsToUse || !Array.isArray(patientsToUse)) {
      console.warn('⚠️ No patients available');
    }

    const yearFilteredDeliveries = selectedOverviewYear === 'all' ?
    deliveriesToUse :
    deliveriesToUse.filter((d) => {
      if (!d || !d.delivery_date) return false;
      try {
        const deliveryYear = new Date(d.delivery_date.replace(/-/g, '/')).getFullYear();
        return deliveryYear === parseInt(selectedOverviewYear, 10);
      } catch (error) {
        console.warn('⚠️ Invalid delivery_date during year filtering:', d.delivery_date);
        return false;
      }
    });

    console.log(`📊 Year-filtered deliveries: ${yearFilteredDeliveries.length} of ${deliveriesToUse.length} total`);

    if (yearFilteredDeliveries.length > 0) {
      const dates = yearFilteredDeliveries.map((d) => d.delivery_date).filter(Boolean).sort();
      console.log(`📊 Date range in yearFilteredDeliveries: ${dates[0]} to ${dates[dates.length - 1]}`);
      console.log(`📊 Sample delivery dates:`, dates.slice(0, 5), '...', dates.slice(-5));
    }

    const driverNamesInDeliveries = [...new Set(yearFilteredDeliveries.map((d) => (d.driver_name || '').toLowerCase().trim()).filter(Boolean))];
    const driverIdsInDeliveries = [...new Set(yearFilteredDeliveries.map((d) => d.driver_id).filter(Boolean))];
    console.log(`📊 Unique driver names in deliveries:`, driverNamesInDeliveries);
    console.log(`📊 Unique driver IDs in deliveries:`, driverIdsInDeliveries);

    const driversWithRoles = usersToUse.filter((u) => {
      if (!u) return false;
      const roles = Array.isArray(u.app_roles) ? u.app_roles : [];
      const hasDriverRole = roles.includes('driver');
      const isAdminDriver = roles.includes('admin') && roles.includes('driver');

      if (hasDriverRole || isAdminDriver) {
        console.log(`✅ Including driver ${u.user_name || u.full_name} (id: ${u.id}, appUserId: ${u.appUserId}) with roles: ${roles.join(', ')}, status: ${u.status}`);
        return true;
      }
      return false;
    });
    console.log(`👥 Total drivers with driver role: ${driversWithRoles.length}`);

    const deliveryDriverIds = [...new Set(deliveriesToUse.map((d) => d.driver_id).filter(Boolean))];
    console.log(`📊 [Debug] Unique driver_ids in deliveries:`, deliveryDriverIds);
    console.log(`📊 [Debug] Driver IDs from driversWithRoles:`, driversWithRoles.map((d) => ({ name: d.user_name, id: d.id, appUserId: d.appUserId })));

    let cityFilteredDrivers = driversWithRoles;

    if (userHasRole(currentUser, 'admin')) {
      if (selectedCityId && selectedCityId !== 'all') {
        cityFilteredDrivers = driversWithRoles.filter((d) => d.city_id === selectedCityId);
        console.log(`👑 Admin - filtered to city ${selectedCityId}: ${cityFilteredDrivers.length} drivers`);
      } else {
        console.log('👑 Admin - showing all drivers from all cities');
      }
    } else if (userHasRole(currentUser, 'dispatcher')) {
      // CRITICAL: Dispatchers should only see drivers who have deliveries for their assigned stores
      const dispatcherStoreIds = new Set(currentUser.store_ids || []);
      console.log(`👔 Dispatcher store IDs:`, Array.from(dispatcherStoreIds));

      // Find all driver IDs that have deliveries for the dispatcher's stores
      const driversWithStoreDeliveries = new Set();
      yearFilteredDeliveries.forEach((d) => {
        if (d && d.store_id && dispatcherStoreIds.has(d.store_id)) {
          if (d.driver_id) {
            driversWithStoreDeliveries.add(d.driver_id);
          }
          if (d.driver_name) {
            driversWithStoreDeliveries.add((d.driver_name || '').toLowerCase().trim());
          }
        }
      });
      console.log(`👔 Drivers with deliveries for dispatcher's stores:`, Array.from(driversWithStoreDeliveries));

      // Filter to only show drivers who have deliveries for dispatcher's stores
      cityFilteredDrivers = driversWithRoles.filter((d) => {
        if (!d) return false;
        const driverIdMatch = driversWithStoreDeliveries.has(d.id) ||
        d.appUserId && driversWithStoreDeliveries.has(d.appUserId);
        const driverNameMatch = driversWithStoreDeliveries.has((d.full_name || '').toLowerCase().trim()) ||
        driversWithStoreDeliveries.has((d.user_name || '').toLowerCase().trim());
        return driverIdMatch || driverNameMatch;
      });
      console.log(`👔 Dispatcher - filtered to drivers with store deliveries: ${cityFilteredDrivers.length} drivers`);
    } else if (userHasRole(currentUser, 'driver')) {
      if (currentUser.city_id) {
        cityFilteredDrivers = driversWithRoles.filter((d) => d.city_id === currentUser.city_id);
        console.log(`📍 Filtered to user's city ${currentUser.city_id}: ${cityFilteredDrivers.length} drivers`);
      }
    }

    const driversWithDeliveries = cityFilteredDrivers.filter((u) => {
      if (!u) return false;

      const userFullNameLower = (u.full_name || '').toLowerCase().trim();
      const userUserNameLower = (u.user_name || '').toLowerCase().trim();

      const hasDeliveries = driverIdsInDeliveries.includes(u.id) ||
      u.appUserId && driverIdsInDeliveries.includes(u.appUserId) ||
      driverNamesInDeliveries.includes(userFullNameLower) ||
      driverNamesInDeliveries.includes(userUserNameLower);

      if (!hasDeliveries) {
        console.log(`   ⏭️ Skipping driver (no deliveries): ${u.user_name || u.full_name}`);
        return false;
      }

      console.log(`   ✅ Including driver: ${u.user_name || u.full_name} (has deliveries: ${hasDeliveries}, status: ${u.status})`);
      return true;
    });

    console.log(`✅ Found ${driversWithDeliveries.length} drivers to show (after city filter)`);

    let driversToShow = [];

    if (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) {
      driversToShow = driversWithDeliveries;
      console.log(`👑 Admin/Dispatcher - showing ${driversToShow.length} drivers`);
    } else if (userHasRole(currentUser, 'driver')) {
      // Drivers can only see their own card
      driversToShow = driversWithDeliveries.filter((d) =>
      d.id === currentUser.id || d.appUserId === currentUser.id
      );
      console.log(`🚗 Driver - showing own card only: ${driversToShow.length} drivers`);
    } else {
      console.log(`❌ User has no valid role for driver overview`);
      return [];
    }


    if (!driversToShow.length) {
      console.log('❌ No drivers to show');
      return [];
    }

    const todayStr = format(new Date(), 'yyyy-MM-dd');

    // CRITICAL: For dispatchers, only count deliveries for their assigned stores
    const dispatcherStoreIds = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin') ?
    new Set(currentUser.store_ids || []) :
    null;

    // CRITICAL: Use backend stats if available, otherwise fall back to local calculation
    const cards = driversToShow.map((driver) => {
      // Try to get stats from backend first
      const backendStats = backendDriverStats?.find((s) => s.driverId === driver.id || s.driverId === driver.appUserId);

      if (backendStats) {
        console.log(`✅ Using backend stats for driver: ${driver.user_name || driver.full_name}`);
        return {
          driver: driver,
          firstName: getDriverDisplayName(driver),
          stats: {
            totalStops: backendStats.totalStops,
            pickups: backendStats.pickups,
            completed: backendStats.completed,
            failed: backendStats.failed,
            returned: backendStats.returned,
            completionRate: backendStats.completionRate
          },
          todayStats: backendStats.todayStats
        };
      }

      // Fallback to local calculation if backend stats not available
      console.log(`⚠️ Falling back to local calculation for driver: ${driver.user_name || driver.full_name}`);

      const driverDeliveries = yearFilteredDeliveries.filter((d) => {
        if (!d) return false;

        // CRITICAL: For dispatchers, only include deliveries for their stores
        if (dispatcherStoreIds && d.store_id && !dispatcherStoreIds.has(d.store_id)) {
          return false;
        }

        if (d.driver_id) {
          if (d.driver_id === driver.id || d.driver_id === driver.appUserId) {
            return true;
          }
        }

        if (d.driver_name) {
          const deliveryDriverName = (d.driver_name || '').toLowerCase().trim();
          const driverFullName = (driver.full_name || '').toLowerCase().trim();
          const driverUserName = (driver.user_name || '').toLowerCase().trim();

          if (deliveryDriverName === driverFullName || deliveryDriverName === driverUserName) {
            return true;
          }

          const driverFirstName = driverUserName.split(' ')[0];
          if (driverFirstName && deliveryDriverName === driverFirstName) {
            return true;
          }
        }

        return false;
      });

      const totalStops = driverDeliveries.length;

      const pickups = driverDeliveries.filter((d) => {
        const isPickup = !d.patient_id || d.patient_id === '';
        return isPickup && (d.status === 'completed' || d.status === 'picked_up');
      }).length;

      const completed = driverDeliveries.filter((d) => {
        const isDelivery = d.patient_id && d.patient_id !== '';
        return isDelivery && d.status === 'completed';
      }).length;

      const returned = driverDeliveries.filter((d) => {
        const patient = patientsToUse.find((p) => p && p.id === d.patient_id);
        const notesReturn = (d.delivery_notes || '').toLowerCase().includes('return');
        const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
        return notesReturn || addressReturn;
      }).length;

      const failed = driverDeliveries.filter((d) => d.status === 'failed').length;

      const todayDeliveries = driverDeliveries.filter((d) => d.delivery_date === todayStr);

      const isReturn = (delivery) => {
        if (!delivery) return false;
        const patient = patientsToUse.find((p) => p && p.id === delivery.patient_id);
        const notesReturn = (delivery.delivery_notes || '').toLowerCase().includes('return');
        const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
        return notesReturn || addressReturn;
      };

      const todayStats = {
        active: todayDeliveries.filter((d) => ['picked_up', 'in_transit', 'pending'].includes(d.status)).length,
        completed: todayDeliveries.filter((d) => d.status === 'completed' || d.status === 'delivered').length,
        failed: todayDeliveries.filter((d) => d.status === 'failed' && !isReturn(d)).length,
        returned: todayDeliveries.filter((d) => d.status === 'returned' || isReturn(d)).length,
        total: todayDeliveries.length
      };

      const firstName = getDriverDisplayName(driver);

      return {
        driver: driver,
        firstName: firstName,
        stats: {
          totalStops,
          pickups,
          completed,
          failed,
          returned,
          completionRate: totalStops > 0 ? Math.round(completed / totalStops * 100) : 0
        },
        todayStats
      };
    });

    // CRITICAL: Filter out drivers with 0 stops before sorting
    const cardsWithStops = cards.filter((c) => c.stats.totalStops > 0);

    const sortedCards = sortUsers(cardsWithStops.map((c) => ({ ...c.driver, _cardData: c }))).map((driver) => driver._cardData);
    console.log(`📋 Final sorted cards: ${sortedCards.length} cards (${cards.length - cardsWithStops.length} drivers hidden with 0 stops)`);
    console.log(`📋 Display names:`, sortedCards.map((c) => c.firstName));
    console.log(`📋 Card stats:`, sortedCards.map((c) => `${c.firstName}: ${c.stats.totalStops} stops`));

    return sortedCards;
  }, [
  isDriverOverviewMode,
  effectiveDeliveries,
  effectivePatients,
  allUsers,
  allDeliveries,
  allPatients,
  currentUser?.id,
  selectedOverviewYear,
  selectedCityId,
  contextDeliveries,
  contextPatients,
  contextUsers,
  refreshKey,
  backendDriverStats]
  );

  const canCreateDeliveries = useMemo(() => {
    return userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher');
  }, [currentUser]);

  // Helper function to get driver status badge class
  const getDriverStatusBadgeClass = useCallback((driverId, fallbackStatus) => {
    const freshAppUser = freshAppUsers.find((au) => au?.user_id === driverId);
    const driverStatus = freshAppUser?.driver_status ?? fallbackStatus ?? 'off_duty';

    if (driverStatus === 'on_duty') return 'bg-emerald-500 text-white border-emerald-500';
    if (driverStatus === 'on_break') return 'bg-orange-400 text-white border-orange-400';
    if (driverStatus === 'online') return 'bg-emerald-500 text-white border-emerald-500';
    if (driverStatus === 'off_duty') return 'bg-red-500 text-white border-red-500';
    return 'bg-white text-slate-600 border-slate-300';
  }, [freshAppUsers]);

  const handleDriverCardClick = useCallback((driver) => {
    console.log('🎯 [Deliveries] Driver card clicked:', driver.user_name || driver.full_name);

    const driverDeliveries = (effectiveDeliveries || []).filter((d) =>
    d.driver_id && (d.driver_id === driver.id || d.driver_id === driver.appUserId) ||
    !d.driver_id && d.driver_name && (d.driver_name === driver.full_name || d.driver_name === driver.user_name)
    );

    let targetDate = new Date();
    if (driverDeliveries.length > 0) {
      const latest = [...driverDeliveries].sort(
        (a, b) => new Date(b.delivery_date.replace(/-/g, '/')) - new Date(a.delivery_date.replace(/-/g, '/'))
      )[0];
      if (latest?.delivery_date) {
        const [y, m, d] = latest.delivery_date.split('-').map(Number);
        if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
          targetDate = new Date(y, m - 1, d);
          targetDate.setHours(0, 0, 0, 0);
        }
      }
    }

    if (isNaN(targetDate.getTime())) {
      targetDate = new Date();
      targetDate.setHours(0, 0, 0, 0);
    }

    const targetYear = targetDate.getFullYear();
    const targetMonth = targetDate.getMonth();

    console.log('🎯 [Deliveries] Switching to Route Management:', {
      driverId: driver.id,
      year: targetYear,
      month: targetMonth + 1
    });

    // CRITICAL: Set driver filter immediately to prevent it from being cleared
    setDriverFilter(driver.id);
    setSelectedYear(targetYear);
    setSelectedMonth(targetMonth);

    // CRITICAL: Only use year/month/driver in URL, NO date param
    const params = new URLSearchParams();
    params.set('driver', driver.id);
    params.set('year', targetYear.toString());
    params.set('month', (targetMonth + 1).toString());

    navigate(`${location.pathname}?${params.toString()}`, { replace: false });
  }, [effectiveDeliveries, navigate, location.pathname]);

  const renderDeliveries = useCallback((deliveriesToRender) => {
    if (!deliveriesToRender || !Array.isArray(deliveriesToRender) || deliveriesToRender.length === 0) {
      return (
        <div className="text-center py-12 text-slate-500 col-span-full">
          <Package className="w-16 h-16 mx-auto mb-4 opacity-30" />
          <p className="text-lg font-medium">No deliveries for this date</p>
        </div>);

    }

    // Find the selected delivery for the details panel
    const selectedDelivery = selectedDeliveryId ? deliveriesToRender.find((d) => d.id === selectedDeliveryId) : null;
    const selectedPatient = selectedDelivery ? (effectivePatients || []).find((p) => p && p.id === selectedDelivery.patient_id) : null;
    const selectedStore = selectedDelivery ? (stores || []).find((s) => s && s.id === selectedDelivery.store_id) : null;
    const selectedDriver = selectedDelivery ?
    (effectiveDrivers || []).find((d) => d.id === selectedDelivery.driver_id || d.appUserId === selectedDelivery.driver_id) ||
    (effectiveDrivers || []).find((d) => d.full_name === selectedDelivery.driver_name) ||
    (effectiveDrivers || []).find((d) => d.user_name === selectedDelivery.driver_name) :
    null;

    return (
      <>
        {viewMode === 'cards' ?
        <div className="flex h-full gap-4">
            {/* Stop Cards Column - Single column on desktop, full width on narrow mobile */}
            <div className={`${showSplitView ? 'w-[400px] flex-shrink-0' : 'w-full'} h-full overflow-hidden`}>
              <div className="px-3 py-2 space-y-2 overflow-y-auto h-full flex flex-col items-center" style={{ maxHeight: 'calc(100vh - 280px)' }}>
                {deliveriesToRender.map((delivery, index) =>
              <StopCard
                key={delivery.id || `${delivery.delivery_date||'unknown'}-${delivery.patient_id ?? 'pickup'}-${delivery.store_id ?? 'store'}-${delivery.tracking_number || index}` }
                delivery={delivery}
                patient={(effectivePatients || []).find((p) => p && p.id === delivery.patient_id)}
                store={(stores || []).find((s) => s && s.id === delivery.store_id)}
                driver={
                (effectiveDrivers || []).find((d) => d.id === delivery.driver_id || d.appUserId === delivery.driver_id) ||
                (effectiveDrivers || []).find((d) => d.full_name === delivery.driver_name) ||
                (effectiveDrivers || []).find((d) => d.user_name === delivery.driver_name)
                }
                currentUser={currentUser}
                stopOrder={delivery.stopOrder || delivery.stop_order || index + 1}
                isSelected={selectedDeliveryId === delivery.id}
                onClick={() => setSelectedDeliveryId(selectedDeliveryId === delivery.id ? null : delivery.id)}
                onStatusUpdate={handleStatusUpdate}
                onNotesUpdate={handleNotesUpdate}
                onEditDelivery={handleEditDelivery}
                onDeleteDelivery={handleDeleteDelivery}
                showDriverName={false}
                onRestart={handleRestartDelivery}
                allDeliveries={effectiveDeliveries || []}
                selectedDate={selectedDate}
                onEditPatient={handleEditPatient}
                onCODUpdate={handleCODUpdate}
                onStartDelivery={handleStatusUpdate}
                onCreateReturn={async ({ originalDelivery, returnPatient, store }) => {
                  try {
                    const currentDate = format(new Date(), 'yyyy-MM-dd');
                    await createDeliveryLocal({
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
                    });
                    await invalidate('Delivery');
                    await loadData(true);
                  } catch (error) {
                    console.error('Error creating return:', error);
                    throw error;
                  }
                }}
                patients={effectivePatients || []}
                drivers={effectiveDrivers || []}
                stores={stores || []}
                appUsers={contextUsers || []}
                showDragHandle={false}
                compact={true} />

              )}
              </div>
            </div>

            {/* Details Panel - Show on desktop and wider mobile screens */}
            {showSplitView &&
          <div className="flex-1 h-full overflow-hidden rounded-lg border" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                <StopDetailsPanel
              delivery={selectedDelivery}
              patient={selectedPatient}
              store={selectedStore}
              driver={selectedDriver}
              currentUser={currentUser}
              onClose={() => setSelectedDeliveryId(null)}
              onStatusUpdate={handleStatusUpdate}
              onEditDelivery={handleEditDelivery}
              onDeleteDelivery={handleDeleteDelivery}
              onRestart={handleRestartDelivery} />

              </div>
          }
          </div> :

        <div className="h-full overflow-hidden px-4 relative">
            <DeliveryListView
            deliveries={deliveriesToRender}
            patients={effectivePatients || []}
            stores={stores || []}
            drivers={effectiveDrivers || []}
            currentUser={currentUser}
            onEditDelivery={handleEditDelivery}
            onEditPatient={handleEditPatient}
            onDeleteDelivery={handleDeleteDelivery}
            onRestart={handleRestartDelivery}
            onStatusUpdate={handleStatusUpdate}
            onNotesUpdate={handleNotesUpdate}
            onCODUpdate={handleCODUpdate}
            onCreateReturn={async ({ originalDelivery, returnPatient, store }) => {
              try {
                const currentDate = format(new Date(), 'yyyy-MM-dd');
                await createDeliveryLocal({
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
                });
                await invalidate('Delivery');
                await loadData(true);
              } catch (error) {
                console.error('Error creating return:', error);
                throw error;
              }
            }}
            onStartDelivery={handleStatusUpdate}
            allDeliveries={effectiveDeliveries || []}
            selectedDate={selectedDate}
            isMobile={isMobile} />

          </div>
        }
      </>);


  }, [
  effectivePatients,
  stores,
  effectiveDrivers,
  effectiveDeliveries,
  handleEditDelivery,
  handleDeleteDelivery,
  handleStatusUpdate,
  handleNotesUpdate,
  handleRestartDelivery,
  handleReturn,
  currentUser,
  canCreateDeliveries,
  selectedDate,
  selectedDeliveryId,
  handleEditPatient,
  filteredAndSortedDeliveries,
  isMobile,
  loadData,
  viewMode,
  handleCODUpdate,
  windowWidth]
  );

  // Track window width for responsive layout
  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Determine if we should show the split view (cards + details panel)
  // Show split view on desktop OR on wider mobile screens (>= 640px width)
  const showSplitView = !isMobile || windowWidth >= 640;

  function LogoImage({ className }) {
    const [idx, setIdx] = React.useState(0);
    const candidates = ['/app-logo.png', '/logo.png', '/logo.svg', '/logo192.png', '/favicon.png'];
    const src = candidates[idx];
    return (
      <img
        src={src}
        alt="Routes"
        className={className}
        onError={() => setIdx((i) => i + 1 < candidates.length ? i + 1 : i)} />);

  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-xl text-slate-700">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full mx-auto mb-4"></div>
          <p>Loading deliveries...</p>
          {(isOffline || !navigator.onLine) &&
          <p className="text-sm text-orange-600 mt-2">Network issues detected. Showing cached data if available.</p>
          }
        </div>
      </div>);

  }

  if (!hasAccess && !isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-xl text-slate-700 bg-slate-50">
        <div className="text-center p-6 bg-white rounded-lg shadow-md">
          <h2 className="text-2xl font-bold text-red-600 mb-4">Access Denied</h2>
          <p className="text-base text-slate-600 mb-6">
            You do not have permission to view this page. Please contact your administrator.
          </p>
          <Button onClick={() => navigate('/')} className="bg-emerald-600 hover:bg-emerald-700">
            Go to Dashboard
          </Button>
        </div>
      </div>);

  }

  const shouldShowNoDataMessage = !isLoading && (isOffline || effectiveDeliveries.length === 0);

  return (
    <div className="h-screen h-[100dvh] flex flex-col relative overflow-hidden" style={{ background: 'var(--bg-slate-50)' }}>

      <div className={`${isMobile ? 'block' : 'hidden'} px-4 py-3 flex-shrink-0 z-20`} style={{ borderBottom: '1px solid var(--border-slate-200)', background: 'var(--bg-white)' }}>
        {isDriverOverviewMode ?
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-2">
            <div className="flex items-center gap-3">
              <SmartRefreshIndicator inline={true} />
              <h1 className="text-xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Driver Overview</h1>
            </div>
          </div> :

        <div className="flex justify-between items-center">
            <h1 className="text-xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Route Management</h1>
            <Button variant="ghost" size="icon" onClick={() => setIsMobileMenuOpen((v) => !v)}>
              <CalendarIcon className="w-5 h-5" />
            </Button>
          </div>
        }
      </div>

      <div className="hidden lg:block px-6 py-4 flex-shrink-0 z-20" style={{ borderBottom: '1px solid var(--border-slate-200)', background: 'var(--bg-white)' }}>
        {isDriverOverviewMode ?
        <div className="flex items-center gap-3">
          <SmartRefreshIndicator inline={true} />
          {isLoadingStats &&
          <div className="animate-spin w-6 h-6 border-3 border-emerald-500 border-t-transparent rounded-full flex-shrink-0" />
          }
          <h1 className="text-3xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Driver Overview</h1>
        </div> :

        <>
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
              <div>
                <h1 className="text-3xl font-bold flex items-baseline gap-3" style={{ color: 'var(--text-slate-900)' }}>
                  <SmartRefreshIndicator inline={true} />
                  Route Management
                  <Badge variant="outline" className="ml-2 text-sm font-normal" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)', borderColor: 'var(--border-slate-300)' }}>
                    {format(new Date(), 'MMM d, yyyy')}
                  </Badge>
                </h1>
              </div>
              <div className="flex gap-3 flex-wrap items-center">
                <ExportRouteButton
                  currentUser={currentUser}
                  driverFilter={driverFilter}
                  selectedDate={selectedDate}
                  driverFilteredDeliveries={driverFilteredDeliveries}
                />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative flex-grow">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                placeholder="Search patient, address, Rx details, tracking..."
                value={searchTerm}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-10 w-full bg-slate-100 border-slate-300" />
              </div>



              <Select value={driverFilter} onValueChange={handleDriverChange}>
                <SelectTrigger className="w-[140px] bg-white border-slate-300">
                  <SelectValue placeholder="Select driver" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Drivers</SelectItem>
                  {sortUsers((effectiveDrivers || []).filter((d) => userHasRole(d, 'driver'))).map((driver) => {
                  // Check if there are duplicate names
                  const duplicateNames = (effectiveDrivers || []).filter((d) =>
                  getDriverDisplayName(d) === getDriverDisplayName(driver)
                  );
                  const displayName = duplicateNames.length > 1 ?
                  `${getDriverDisplayName(driver)} (${driver.id.slice(-4)})` :
                  getDriverDisplayName(driver);

                  return (
                    <SelectItem key={driver.id} value={driver.id}>
                        {displayName}
                      </SelectItem>);

                })}
                </SelectContent>
              </Select>

              <Select value={statusFilter} onValueChange={handleStatusChange}>
                <SelectTrigger className="w-36 bg-white border-slate-300 text-slate-900 font-medium">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="Ready For Pickup">Ready For Pickup</SelectItem>
                  <SelectItem value="picked_up">Picked Up</SelectItem>
                  <SelectItem value="in_transit">In Transit</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="returned">Returned</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>
        }
      </div>

      <div className="flex-1 flex overflow-hidden min-h-0">

        {!isDriverOverviewMode &&
        <div className="hidden lg:flex w-72 flex-col h-full" style={{ background: 'var(--bg-white)', borderRight: '1px solid var(--border-slate-200)' }}>
            <div className="p-2 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border-slate-100)' }}>
              <CalendarIcon className="w-5 h-5" style={{ color: 'var(--text-slate-700)' }} />
              <h2 className="text-lg font-semibold" style={{ color: 'var(--text-slate-800)' }}>Route Dates</h2>
            </div>
            <div className="flex-1 p-1 sm:p-2 overflow-y-auto">
              <DateListPanel
              deliveries={driverFilteredDeliveries}
              selectedDate={selectedDate ? format(selectedDate, 'yyyy-MM-dd') : null}
              dateListWithStats={null}
              onDateSelect={handleDateSelect}
              patients={effectivePatients}
              selectedDriverId={driverFilter}
              currentUser={currentUser}
              onDeleteRoute={async (dateStr, driverId) => {
                try {
                  const deliveriesToDelete = driverFilteredDeliveries.filter(
                    (d) => d.delivery_date === dateStr && d.driver_id === driverId
                  );
                  const deliveryIds = deliveriesToDelete.map((d) => d.id);

                  console.log(`🗑️ [DeleteRoute] Batch deleting ${deliveryIds.length} deliveries for ${dateStr}, driver ${driverId}`);

                  // CRITICAL: Delete from BOTH databases simultaneously
                  // 1. Delete from online database
                  for (const id of deliveryIds) {
                    await base44.entities.Delivery.delete(id);
                  }
                  console.log(`✅ [DeleteRoute] Deleted ${deliveryIds.length} from online DB`);

                  // 2. Delete from offline database
                  const { offlineDB } = await import('../components/utils/offlineDatabase');
                  for (const id of deliveryIds) {
                    await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, id);
                  }
                  console.log(`✅ [DeleteRoute] Deleted ${deliveryIds.length} from offline DB`);

                  // 3. Update UI immediately
                  setAllDeliveries((prev) => prev.filter((d) => !deliveryIds.includes(d.id)));

                  // 4. Broadcast to other devices
                  deliveryIds.forEach((id) => smartRefreshManager.deletedDeliveryIds.add(id));

                  invalidate('Delivery');
                  setRefreshKey((prev) => prev + 1);
                  console.log(`✅ [DeleteRoute] Route deleted successfully from both databases`);
                } catch (error) {
                  console.error('❌ [DeleteRoute] Error:', error);
                  alert('Failed to delete route. Please try again.');
                  await loadData(true);
                }
              }}
              onDeleteMonth={async (year, month, driverId) => {
                try {
                  if (!confirm(`Delete all deliveries for ${driverId ? 'this driver for ' : ''}this month?`)) return;

                  const monthStart = new Date(year, month, 1);
                  const monthEnd = new Date(year, month + 1, 0);
                  const startDateStr = format(monthStart, 'yyyy-MM-dd');
                  const endDateStr = format(monthEnd, 'yyyy-MM-dd');

                  const deliveriesToDelete = driverFilteredDeliveries.filter(
                    (d) => d.delivery_date >= startDateStr && d.delivery_date <= endDateStr && (
                    driverId ? d.driver_id === driverId : true)
                  );
                  const deliveryIds = deliveriesToDelete.map((d) => d.id);

                  console.log(`🗑️ [DeleteMonth] Batch deleting ${deliveryIds.length} deliveries for ${format(monthStart, 'MMMM yyyy')}${driverId ? ` (driver: ${driverId})` : ''}`);

                  await batchDeleteDeliveriesLocal(deliveryIds, {
                    userId: currentUser?.id,
                    userName: currentUser?.user_name || currentUser?.full_name
                  });

                  console.log(`✅ [DeleteMonth] Month deleted successfully`);
                  invalidate('Delivery');
                  setRefreshKey((prev) => prev + 1);
                } catch (error) {
                  console.error('❌ [DeleteMonth] Error:', error);
                  alert('Failed to delete month. Please try again.');
                  await loadData(true);
                }
              }} />
            </div>
          </div>
        }

        {!isDriverOverviewMode && !activeDriver && isMobile &&
        <button
          onClick={() => setIsMobileMenuOpen((v) => !v)}
          className="absolute left-0 top-24 z-30 font-semibold py-3 px-1.5 rounded-r-lg shadow-lg transition-transform hover:scale-105 flex items-center justify-center"
          style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderTop: '1px solid var(--border-slate-200)', borderRight: '1px solid var(--border-slate-200)', borderBottom: '1px solid var(--border-slate-200)' }}>

            <CalendarIcon className="w-5 h-5" />
          </button>
        }

        {!isDriverOverviewMode && isMobile && isMobileMenuOpen &&
        <div
          className="fixed top-12 left-0 right-0 bottom-0 bg-black/30 z-40"
          onClick={() => setIsMobileMenuOpen(false)} />

        }

        <AnimatePresence>
          {!isDriverOverviewMode && isMobile && isMobileMenuOpen &&
          <motion.div
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed top-0 left-0 h-full w-64 shadow-xl z-[9999] flex flex-col"
            style={{ background: 'var(--bg-white)' }}
            onClick={(e) => e.stopPropagation()}>

              <div className="p-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border-slate-100)' }}>
                <div className="flex items-center gap-2">
                  <CalendarIcon className="w-5 h-5" style={{ color: 'var(--text-slate-700)' }} />
                  <h2 className="text-lg font-semibold" style={{ color: 'var(--text-slate-800)' }}>Route Dates</h2>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setIsMobileMenuOpen(false)}>
                  <XIcon className="w-5 h-5" />
                </Button>
              </div>
              <div className="flex-1 p-2 sm:p-4 overflow-y-auto">
                <DateListPanel
                deliveries={driverFilteredDeliveries}
                selectedDate={selectedDate ? format(selectedDate, 'yyyy-MM-dd') : null}
                dateListWithStats={null}
                onDateSelect={(dateStr) => {
                  handleDateSelect(dateStr);
                  setIsMobileMenuOpen(false);
                }}
                patients={effectivePatients}
                selectedDriverId={driverFilter}
                currentUser={currentUser}
                onDeleteRoute={async (dateStr, driverId) => {
                  try {
                    const deliveriesToDelete = driverFilteredDeliveries.filter(
                      (d) => d.delivery_date === dateStr && d.driver_id === driverId
                    );
                    const deliveryIds = deliveriesToDelete.map((d) => d.id);

                    console.log(`🗑️ [DeleteRoute-Mobile] Batch deleting ${deliveryIds.length} deliveries for ${dateStr}, driver ${driverId}`);

                    // CRITICAL: Delete from BOTH databases simultaneously
                    // 1. Delete from online database
                    for (const id of deliveryIds) {
                      await base44.entities.Delivery.delete(id);
                    }
                    console.log(`✅ [DeleteRoute-Mobile] Deleted ${deliveryIds.length} from online DB`);

                    // 2. Delete from offline database
                    const { offlineDB } = await import('../components/utils/offlineDatabase');
                    for (const id of deliveryIds) {
                      await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, id);
                    }
                    console.log(`✅ [DeleteRoute-Mobile] Deleted ${deliveryIds.length} from offline DB`);

                    // 3. Update UI immediately
                    setAllDeliveries((prev) => prev.filter((d) => !deliveryIds.includes(d.id)));

                    // 4. Broadcast to other devices
                    deliveryIds.forEach((id) => smartRefreshManager.deletedDeliveryIds.add(id));

                    invalidate('Delivery');
                    setRefreshKey((prev) => prev + 1);
                    setIsMobileMenuOpen(false);
                    console.log(`✅ [DeleteRoute-Mobile] Route deleted successfully from both databases`);
                  } catch (error) {
                    console.error('❌ [DeleteRoute-Mobile] Error:', error);
                    alert('Failed to delete route. Please try again.');
                    await loadData(true);
                  }
                }}
                onDeleteMonth={async (year, month, driverId) => {
                  try {
                    if (!confirm(`Delete all deliveries for ${driverId ? 'this driver for ' : ''}this month?`)) return;

                    const monthStart = new Date(year, month, 1);
                    const monthEnd = new Date(year, month + 1, 0);
                    const startDateStr = format(monthStart, 'yyyy-MM-dd');
                    const endDateStr = format(monthEnd, 'yyyy-MM-dd');

                    const deliveriesToDelete = driverFilteredDeliveries.filter(
                      (d) => d.delivery_date >= startDateStr && d.delivery_date <= endDateStr && (
                      driverId ? d.driver_id === driverId : true)
                    );
                    const deliveryIds = deliveriesToDelete.map((d) => d.id);

                    console.log(`🗑️ [DeleteMonth-Mobile] Batch deleting ${deliveryIds.length} deliveries for ${format(monthStart, 'MMMM yyyy')}${driverId ? ` (driver: ${driverId})` : ''}`);

                    await batchDeleteDeliveriesLocal(deliveryIds, {
                      userId: currentUser?.id,
                      userName: currentUser?.user_name || currentUser?.full_name
                    });

                    console.log(`✅ [DeleteMonth-Mobile] Month deleted successfully`);
                    invalidate('Delivery');
                    setRefreshKey((prev) => prev + 1);
                    setIsMobileMenuOpen(false);
                  } catch (error) {
                    console.error('❌ [DeleteMonth-Mobile] Error:', error);
                    alert('Failed to delete month. Please try again.');
                    await loadData(true);
                  }
                }} />
              </div>
            </motion.div>
          }
        </AnimatePresence>

        <div className="flex-1 flex flex-col overflow-hidden min-h-0" style={isBottomNavVisible ? { maxHeight: 'calc(100vh - 180px)' } : undefined}>

           {isDriverOverviewMode ?
          <div className="flex flex-col h-full overflow-hidden">
              <Card className="backdrop-blur-sm hidden lg:block flex-shrink-0 m-4 mb-2" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                <CardContent className="p-6">
                  <div className="flex items-center gap-3">
                    {userHasRole(currentUser, 'admin') && cities && cities.length > 0 &&
                  <Select value={selectedCityId} onValueChange={(value) => {
                    setSelectedCityId(value);
                    updateUrl({ city: value });
                  }}>
                        <SelectTrigger className="w-[140px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                          <SelectValue placeholder="Select City" />
                        </SelectTrigger>
                        <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                          <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Cities</SelectItem>
                          {cities.map((city) =>
                      <SelectItem key={city.id} value={city.id} style={{ color: 'var(--text-slate-900)' }}>{city.name}</SelectItem>
                      )}
                        </SelectContent>
                      </Select>
                  }

                    <Select value={selectedOverviewYear} onValueChange={(year) => {
                    yearManuallySelected.current = true;
                    setSelectedOverviewYear(year);
                    const params = new URLSearchParams(location.search);
                    if (year === 'all') {
                      params.set('overviewYear', 'all');
                    } else {
                      params.set('overviewYear', year);
                    }
                    navigate(`${location.pathname}?${params.toString()}`, { replace: true });
                  }}>
                      <SelectTrigger className="w-[140px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                        <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Years</SelectItem>
                        {availableOverviewYears.map((year) =>
                      <SelectItem key={year} value={year.toString()} style={{ color: 'var(--text-slate-900)' }}>{year}</SelectItem>
                      )}
                      </SelectContent>
                    </Select>

                    <div className="flex-grow"></div>

                    {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) &&
                  <Button onClick={() => {setEditingDelivery(null);setShowDeliveryForm(true);}} className="gap-2 w-[140px]">
                        <Plus className="w-4 h-4" /> Add Delivery
                      </Button>
                  }
                    {canAccessImports(currentUser) && !isMobile &&
                  <Button onClick={handleOpenRouteImport} variant="outline" className="gap-2 w-[140px]">
                        <FileUp className="w-4 h-4" /> Import Route
                      </Button>
                  }
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-white/80 backdrop-blur-sm hidden md:block lg:hidden flex-shrink-0 m-4 mb-2">
                <CardContent className="p-6">
                  <div className="space-y-3">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <Input
                      placeholder="Search drivers..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="pl-10 w-full bg-slate-100 border-slate-300" />
                    </div>

                    <div className="flex items-center gap-3">
                      {userHasRole(currentUser, 'admin') && cities && cities.length > 0 &&
                    <Select value={selectedCityId} onValueChange={(value) => {
                      setSelectedCityId(value);
                      updateUrl({ city: value });
                    }}>
                          <SelectTrigger className="w-[140px] bg-white border-slate-300">
                            <SelectValue placeholder="Select City" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All Cities</SelectItem>
                            {cities.map((city) =>
                        <SelectItem key={city.id} value={city.id}>{city.name}</SelectItem>
                        )}
                          </SelectContent>
                        </Select>
                    }

                      <Select value={selectedOverviewYear} onValueChange={(year) => {
                      yearManuallySelected.current = true;
                      setSelectedOverviewYear(year);
                      const params = new URLSearchParams(location.search);
                      if (year === 'all') {
                        params.set('overviewYear', 'all');
                      } else {
                        params.set('overviewYear', year);
                      }
                      navigate(`${location.pathname}?${params.toString()}`, { replace: true });
                    }}>
                        <SelectTrigger className="w-[140px] bg-white border-slate-300">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All Years</SelectItem>
                          {availableOverviewYears.map((year) =>
                        <SelectItem key={year} value={year.toString()}>{year}</SelectItem>
                        )}
                        </SelectContent>
                      </Select>

                      <div className="flex-grow"></div>

                      {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) &&
                    <Button onClick={() => {setEditingDelivery(null);setShowDeliveryForm(true);}} className="gap-2 w-[140px]">
                          <Plus className="w-4 h-4" /> Add Delivery
                        </Button>
                    }
                      {canAccessImports(currentUser) && !isMobile &&
                    <Button onClick={handleOpenRouteImport} variant="outline" className="gap-2 w-[140px]">
                          <FileUp className="w-4 h-4" /> Import Route
                        </Button>
                    }
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="backdrop-blur-sm md:hidden flex-shrink-0 m-4 mb-2" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                <CardContent className="p-4">
                  <div className="space-y-3">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4" style={{ color: 'var(--text-slate-400)' }} />
                      <Input
                      placeholder="Search drivers..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="pl-10 w-full"
                      style={{ background: 'var(--bg-slate-100)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }} />
                    </div>

                    <div className="flex items-center gap-3">
                      {userHasRole(currentUser, 'admin') && cities && cities.length > 0 &&
                    <Select value={selectedCityId} onValueChange={(value) => {
                      setSelectedCityId(value);
                      updateUrl({ city: value });
                    }}>
                          <SelectTrigger className="w-[140px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                            <SelectValue placeholder="Select City" />
                          </SelectTrigger>
                          <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                            <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Cities</SelectItem>
                            {cities.map((city) =>
                        <SelectItem key={city.id} value={city.id} style={{ color: 'var(--text-slate-900)' }}>{city.name}</SelectItem>
                        )}
                          </SelectContent>
                        </Select>
                    }

                      <div className="flex-grow"></div>

                      {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) &&
                    <Button onClick={() => {setEditingDelivery(null);setShowDeliveryForm(true);}} className="gap-2 w-[140px]">
                          <Plus className="w-4 h-4" /> Add Delivery
                        </Button>
                    }
                    </div>

                    <div className="flex items-center gap-3">
                      <Select value={selectedOverviewYear} onValueChange={(year) => {
                      yearManuallySelected.current = true;
                      setSelectedOverviewYear(year);
                      const params = new URLSearchParams(location.search);
                      if (year === 'all') {
                        params.set('overviewYear', 'all');
                      } else {
                        params.set('overviewYear', year);
                      }
                      navigate(`${location.pathname}?${params.toString()}`, { replace: true });
                    }}>
                        <SelectTrigger className="w-[140px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                          <SelectItem value="all" style={{ color: 'var(--text-slate-900)' }}>All Years</SelectItem>
                          {availableOverviewYears.map((year) =>
                        <SelectItem key={year} value={year.toString()} style={{ color: 'var(--text-slate-900)' }}>{year}</SelectItem>
                        )}
                        </SelectContent>
                      </Select>

                      <div className="flex-grow"></div>

                      {canAccessImports(currentUser) && !isMobile &&
                    <Button onClick={handleOpenRouteImport} variant="outline" className="gap-2 w-[140px]">
                          <FileUp className="w-4 h-4" /> Import Route
                        </Button>
                    }
                    </div>
                  </div>
                </CardContent>
              </Card>

              <div className="flex-1 flex flex-col min-h-0 px-4">
                {(isLoadingData || isLoadingStats) && driverCards.length === 0 ?
              <div className="text-center py-12" style={{ color: 'var(--text-slate-500)' }}>
                    <div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full mx-auto mb-4"></div>
                    <p className="text-lg font-medium">Loading driver stats...</p>
                  </div> :
              driverCards.length === 0 ?
              <div className="text-center py-12" style={{ color: 'var(--text-slate-500)' }}>
                    <Package className="w-16 h-16 mx-auto mb-4 opacity-30" />
                    <p className="text-lg font-medium">No drivers with deliveries for this period</p>
                    <p className="text-sm mt-2">Select a different year or add deliveries</p>
                  </div> :

              <div key={refreshKey} className="flex-1 w-full overflow-y-auto" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px', alignContent: 'start' }}>
                  {driverCards.map((card) => {
                  const isInactive = card.driver.status === 'inactive';
                  return (
                    <Card
                      key={card.driver.id} className="rounded-xl border shadow cursor-pointer transition-shadow backdrop-blur-sm hover:shadow-lg"
                      style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)', minHeight: '200px', minWidth: '280px', display: 'flex', flexDirection: 'column' }}
                      onClick={() => handleDriverCardClick(card.driver)}>

                        <CardHeader className="pb-2">
                          <CardTitle className="text-base flex items-center justify-between">
                            <span className="text-lg font-bold" style={{ color: 'var(--text-slate-900)' }}>
                              {card.firstName}
                            </span>
                            <Badge
                            variant="outline"
                            className={`text-xs font-semibold rounded-full w-[80px] inline-flex items-center justify-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${
                            getDriverStatusBadgeClass(card.driver.id, card.driver.driver_status)}`
                            }>

                              {card.stats.totalStops} stops
                            </Badge>
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="px-3 py-3">
                          <div className="mb-3 pb-3 h-[40px] flex items-center justify-center" style={{ borderBottom: '1px solid var(--border-slate-100)' }}>
                            {card.todayStats && card.todayStats.total > 0 ?
                          <div className="flex items-center justify-center gap-2 text-xs font-medium flex-wrap">
                                <span className="text-blue-600">Active: {card.todayStats.active}</span>
                                <span className="text-green-600">Comp: {card.todayStats.completed}</span>
                                <span className="text-red-600">Failed: {card.todayStats.failed}</span>
                                <span className="text-orange-600">Returns: {card.todayStats.returned}</span>
                              </div> :
                          <div className="text-xs" style={{ color: 'var(--text-slate-400)' }}>No deliveries today</div>
                          }
                          </div>
                          <div className="space-y-1 text-sm">
                            <div className="flex justify-between items-center">
                              <span style={{ color: 'var(--text-slate-600)' }}>Pickups:</span>
                              <span className="bg-blue-500 text-white px-3 py-1 text-xs rounded-full font-medium w-[60px] text-center">{card.stats.pickups}</span>
                            </div>
                            <div className="flex justify-between items-center">
                              <span style={{ color: 'var(--text-slate-600)' }}>Completed:</span>
                              <span className="bg-emerald-500 text-white px-3 py-1 text-xs rounded-full font-medium w-[60px] text-center">{card.stats.completed}</span>
                            </div>
                            {(card.stats.failed > 0 || card.stats.returned > 0) &&
                          <div className="flex justify-between items-center">
                                <span style={{ color: 'var(--text-slate-600)' }}>Failed/Returned:</span>
                                <span className="bg-red-500 text-white px-3 py-1 text-xs rounded-full font-medium w-[60px] text-center">
                                  {card.stats.failed}/{card.stats.returned}
                                </span>
                              </div>
                          }
                          </div>
                        </CardContent>
                      </Card>);

                })}
                  </div>
              }
              </div>
            </div> :

          <>
              {activeDriver &&
            <Card className="flex-shrink-0 shadow-sm relative mb-2" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                  <button
                onClick={() => setIsMobileMenuOpen((v) => !v)}
                className="absolute left-0 top-1/2 -translate-y-1/2 z-30 font-semibold py-3 px-1.5 rounded-r-lg shadow-lg transition-transform hover:scale-105 flex items-center justify-center lg:hidden"
                style={{ background: 'var(--bg-white)', color: 'var(--text-slate-700)', borderTop: '1px solid var(--border-slate-200)', borderRight: '1px solid var(--border-slate-200)', borderBottom: '1px solid var(--border-slate-200)' }}>

                    <CalendarIcon className="w-5 h-5" />
                  </button>

                  {isDriverOnline &&
              <div className="absolute top-3 left-3 w-3 h-3 bg-emerald-500 rounded-full ring-2 ring-white"></div>
              }
                  <CardContent className="px-3 py-1">
                    <div className="flex flex-col lg:flex-row items-start lg:items-center gap-3 lg:gap-4 w-full">
                      <div className="flex items-center gap-4 w-full lg:flex-1">
                        <div className="flex-shrink-0 w-16 h-16 rounded-full flex items-center justify-center" style={{ background: 'var(--bg-slate-100)' }}>
                          <span className="text-3xl font-bold" style={{ color: 'var(--text-slate-600)' }}>
                            {getDriverDisplayName(activeDriver).charAt(0)}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <h2 className="text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>{getDriverDisplayName(activeDriver)}</h2>
                          <p className="font-medium" style={{ color: 'var(--text-slate-600)' }}>{formatPhoneNumber(activeDriver.phone)}</p>
                          <div className="flex items-center gap-2">
                            <p className="text-sm capitalize" style={{ color: 'var(--text-slate-500)' }}>{activeDriver.app_roles?.[0]}</p>
                            <span style={{ color: 'var(--text-slate-400)' }}>•</span>
                            <p className="text-sm font-medium" style={{ color: 'var(--text-slate-700)' }}>{selectedDate ? format(selectedDate, 'MMM d, yyyy') : ''}</p>
                          </div>
                        </div>
                        {/* Driver dropdown on mobile */}
                        {isMobile && effectiveDrivers?.length > 1 &&
                    <div className="flex-shrink-0">
                            <Select value={driverFilter} onValueChange={handleDriverChange}>
                              <SelectTrigger className="w-[100px] h-9 text-xs" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                                <SelectValue placeholder="Driver" />
                              </SelectTrigger>
                              <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                                {sortUsers((effectiveDrivers || []).filter((d) => userHasRole(d, 'driver'))).map((driver) => {
                            const duplicateNames = (effectiveDrivers || []).filter((d) =>
                            getDriverDisplayName(d) === getDriverDisplayName(driver)
                            );
                            const displayName = duplicateNames.length > 1 ?
                            `${getDriverDisplayName(driver)} (${driver.id.slice(-4)})` :
                            getDriverDisplayName(driver);

                            return (
                              <SelectItem key={driver.id} value={driver.id} style={{ color: 'var(--text-slate-900)' }}>
                                      {displayName}
                                    </SelectItem>);

                          })}
                              </SelectContent>
                            </Select>
                          </div>
                    }
                      </div>
                      {driverOverviewStats &&
                  <div className="flex gap-3 flex-shrink-0 items-center w-full lg:w-auto">
                          <StatBox
                      value={driverOverviewStats.totalStops}
                      label="Total Stops"
                      valueClass="text-slate-800"
                      onMeasure={handleStatMeasure}
                      fixedWidth={statCardBaseWidth || undefined} />
                          <StatBox
                      value={driverOverviewStats.completed}
                      label="Completed"
                      valueClass="text-emerald-600"
                      onMeasure={handleStatMeasure}
                      fixedWidth={statCardBaseWidth || undefined} />
                          <StatBox
                      value={`${driverOverviewStats.failed}/${driverOverviewStats.returned}`}
                      label="Failed/Returned"
                      valueClass="text-red-600"
                      onMeasure={handleStatMeasure}
                      fixedWidth={statCardBaseWidth || undefined} />
                        </div>
                  }
                    </div>
                  </CardContent>
                </Card>
            }

              <div className="flex-1 overflow-y-auto min-h-0">
                {renderDeliveries(filteredAndSortedDeliveries)}
              </div>
            </>
          }
        </div>

      </div>

      {/* Mobile popup panel for stop details when screen is too narrow */}
      <AnimatePresence>
        {isMobile && !showSplitView && selectedDeliveryId &&
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[10000] flex items-end justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setSelectedDeliveryId(null)}>

            <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="w-full max-h-[85vh] overflow-hidden rounded-t-2xl"
            style={{ background: 'var(--bg-white)' }}
            onClick={(e) => e.stopPropagation()}>

            {(() => {
              const delivery = filteredAndSortedDeliveries.find((d) => d?.id === selectedDeliveryId);
              if (!delivery) return null;
              return (
                <StopDetailsPanel
                  delivery={delivery}
                  patient={(effectivePatients || []).find((p) => p && p.id === delivery?.patient_id)}
                  store={(stores || []).find((s) => s && s.id === delivery?.store_id)}
                  driver={(effectiveDrivers || []).find((d) => d.id === delivery?.driver_id || d.appUserId === delivery?.driver_id)}
                  currentUser={currentUser}
                  onClose={() => setSelectedDeliveryId(null)}
                  onStatusUpdate={handleStatusUpdate}
                  onEditDelivery={handleEditDelivery}
                  onDeleteDelivery={handleDeleteDelivery}
                  onRestart={handleRestartDelivery} />);


            })()}
          </motion.div>
        </motion.div>
        }
      </AnimatePresence>

      <AnimatePresence>
        {showDeliveryForm &&
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm overflow-auto">

            <DeliveryForm
            delivery={editingDelivery}
            patients={effectivePatients || []}
            stores={stores || []}
            drivers={effectiveDrivers || []}
            onSave={handleSaveDelivery}
            onCancel={() => {setShowDeliveryForm(false);setEditingDelivery(null);}}
            suggestedDate={selectedDate ? format(selectedDate, 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd')}
            currentUser={currentUser}
            allDeliveries={effectiveDeliveries || []}
            initialDriverId={
            editingDelivery ?
            (effectiveDrivers || []).find((d) => d.id === editingDelivery.driver_id || d.appUserId === editingDelivery.driver_id || d.full_name === editingDelivery.driver_name || d.user_name === editingDelivery.driver_name)?.id :
            driverFilter === 'all' ? null : driverFilter
            }
            closeOnSave={true} />

          </motion.div>
        }
        {showImportModal &&
        <RouteImport
          onImportComplete={handleImportComplete}
          onCancel={() => setShowImportModal(false)}
          patients={allPatients || []}
          stores={stores || []}
          drivers={(allUsers || []).filter((u) => userHasRole(u, 'driver')) || []}
          allUsers={allUsers}
          currentUser={currentUser} />

        }
        <RouteMapView
          isOpen={showRouteMap}
          onClose={() => setShowRouteMap(false)}
          deliveries={filteredAndSortedDeliveries}
          patients={effectivePatients || []}
          stores={stores || []}
          drivers={effectiveDrivers || []}
          selectedDate={selectedDate}
          currentUser={currentUser} />

      </AnimatePresence>
    </div>);

}