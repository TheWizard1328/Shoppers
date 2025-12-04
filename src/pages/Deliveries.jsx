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
import DeliveryForm from "../components/deliveries/DeliveryForm";
import DeliveryDetails from "../components/deliveries/DeliveryDetails";
import PatientForm from "../components/patients/PatientForm";
import DateListPanel from "../components/deliveries/DateListPanel";
import { getData, invalidate } from '../components/utils/dataManager';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
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
//import { parseAddress } from '../components/utils/addressParser';

// Utility function to add minutes to a time string
const addMinutesToTime = (timeString, minutesToAdd) => {
  if (!timeString) return null;
  const [hours, minutes] = timeString.split(':').map(Number);
  if (isNaN(hours) || isNaN(minutes)) return timeString;
  const total = hours * 60 + minutes + minutesToAdd;
  const newH = Math.floor(total / 60) % 24;
  const newM = total % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
};

// Utility function to calculate drive time between two coordinates (simplified)
const estimateDriveTimeMinutes = (lat1, lng1, lat2, lng2) => {
  if (!lat1 || !lng1 || !lat2 || !lng2) return 10; // Default 10 minutes

  // Simple distance calculation (Haversine formula)
  const toRad = (v) => v * Math.PI / 180;
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
  Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
  Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distanceKm = R * c;

  // Assume 30 km/h average speed in city, clamped between 5 and 60 minutes
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

  // Get data from AppDataContext for real-time updates
  const {
    deliveries: contextDeliveries = [],
    patients: contextPatients = [],
    stores: contextStores = [],
    drivers: contextDrivers = [],
    users: contextUsers = [],
    cities: contextCities = [],
    isDataLoaded: contextDataLoaded,
    updateDeliveriesLocally
  } = useAppData();

  // Replaced monolithic 'data' state with individual states
  const [allDeliveries, setAllDeliveries] = useState([]);
  const [allPatients, setAllPatients] = useState([]);
  const [stores, setStores] = useState([]);
  const [cities, setCities] = useState([]);

  const [currentUser, setCurrentUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true); // Initial page load state
  const [isLoadingData, setIsLoadingData] = useState(false); // Data fetching state
  const [isOffline, setIsOffline] = useState(false);
  const [hasAccess, setHasAccess] = useState(false);

  const [showImportModal, setShowImportModal] = useState(false);
  const [allUsers, setAllUsers] = useState([]); // All merged users for RouteImport, driverCards

  const [dataLoaded, setDataLoaded] = useState(false); // Indicates initial data load is complete

  const [showDeliveryForm, setShowDeliveryForm] = useState(false);
  const [editingDelivery, setEditingDelivery] = useState(null);
  const [editingPatient, setEditingPatient] = useState(null);

  const [selectedDate, setSelectedDate] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [driverFilter, setDriverFilter] = useState('all');
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(new Date().getMonth()); // 0-indexed month
  const [selectedOverviewYear, setSelectedOverviewYear] = useState('all'); // Initialize as 'all'
  const [selectedCityId, setSelectedCityId] = useState('all'); // New: City filter for driver overview

  const isMobile = useMemo(() => isMobileDevice(), []);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [selectedDeliveryId, setSelectedDeliveryId] = useState(null);

  const [showRouteMap, setShowRouteMap] = useState(false);

  const [activeDriver, setActiveDriver] = useState(null);
  const [isDriverOnline, setIsDriverOnline] = useState(false);
  const isMounted = useRef(false);

  const isDriverOverviewMode = driverFilter === 'all';
  // Force re-render of driver overview/cards when data changes without full page reload
  const [refreshKey, setRefreshKey] = React.useState(0);

  // Add refs to track loading state and prevent loops
  const lastLoadTime = useRef(0);
  const loadInProgress = useRef(0); // Use 0/1 instead of boolean for potential future counts
  const initialLoadDone = useRef(false);
  const yearAutoSelectDone = useRef(false); // NEW: Track if year has been auto-selected
  const yearManuallySelected = useRef(false); // NEW: Track if user manually changed year

  const checkAccess = useCallback(async () => {
    try {
      const user = await getEffectiveUser();
      if (!user) {
        console.log("❌ [Deliveries] No user found");
        setHasAccess(false);
        return false;
      }

      setCurrentUser(user);

      if (userHasRole(user, 'admin') || userHasRole(user, 'dispatcher')) {
        console.log("✅ [Deliveries] Admin/Dispatcher access granted");
        setHasAccess(true);
        return true;
      }

      const isDriverOnly = userHasRole(user, 'driver') &&
      !userHasRole(user, 'admin') &&
      !userHasRole(user, 'dispatcher');

      if (isDriverOnly) {
        console.log("❌ [Deliveries] Driver-only user, denying access");
        setHasAccess(false);
        return false;
      }

      console.log("✅ [Deliveries] Access granted");
      setHasAccess(true);
      return true;

    } catch (error) {
      console.error("❌ [Deliveries] Error checking access:", error);
      setHasAccess(false);
      return false;
    }
  }, [setHasAccess, setCurrentUser]);


  const loadData = useCallback(async (forceRefresh = false) => {
    // AGGRESSIVE GUARDS
    const now = Date.now();
    const timeSinceLastLoad = now - lastLoadTime.current;

    // Prevent calls within 2 seconds of each other (unless force refresh)
    if (!forceRefresh && timeSinceLastLoad < 2000 && loadInProgress.current > 0) {
      console.log(`🛑 [Deliveries] Blocked loadData - only ${timeSinceLastLoad}ms since last load, skipping...`);
      return;
    }

    // Prevent concurrent loads (ref-based)
    if (loadInProgress.current > 0) {
      console.log('🛑 [Deliveries] Load already in progress (ref), skipping...');
      return;
    }

    // Prevent concurrent loads (state-based, for redundancy/UI state)
    if (isLoadingData && !forceRefresh) {
      console.log('🛑 [Deliveries] isLoadingData is true (state), skipping...');
      return;
    }

    console.log('🔄 [Deliveries] Starting loadData...', forceRefresh ? '(FORCE REFRESH)' : '');

    loadInProgress.current = 1; // Set to 1 to indicate a load is in progress
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

      // Batch all non-conditional fetches together to happen in parallel
      const [storesData, appUsersData, citiesData] = await Promise.all([
      getData('Store', '-created_date', null, forceRefresh),
      getData('AppUser', '-created_date', null, forceRefresh),
      getData('City', '-created_date', null, forceRefresh)]
      );

      if (isMounted.current) {
        setStores(storesData || []);
        setCities(citiesData || []);
      }

      // Only fetch User list if current user is an admin (platform-level)
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

      // Build merged users
      let mergedUsers = [];

      if (allAuthUsers.length > 0) {
        // Admin path: merge User + AppUser
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
        // Non-admin path: build user objects from AppUser data only
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

      // Filter out store accounts
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

      // Filter drivers/admins/dispatchers
      mergedUsers = mergedUsers.filter((u) => {
        const roles = Array.isArray(u.app_roles) ? u.app_roles : u.app_role ? [u.app_role] : [];
        const hasRole = roles.some((r) => r === 'driver' || r === 'admin' || r === 'dispatcher');
        const statusOk = isDriverOverviewMode ? u.status === 'active' || u.status === 'inactive' : u.status === 'active';
        return hasRole && statusOk;
      });

      if (isMounted.current) {
        setAllUsers(sortUsers(mergedUsers));
      }

      // **ADAPTIVE FETCH**: Fetch deliveries based on mode
      let deliveriesData = [];

      if (isDriverOverviewMode) {
        console.log('Fetching deliveries for overview mode');
        let query = {};
        if (selectedOverviewYear && selectedOverviewYear !== 'all') {
          const year = parseInt(selectedOverviewYear, 10);
          const startDate = new Date(year, 0, 1);
          const endDate = new Date(year + 1, 0, 0); // Last day of the year
          query.delivery_date = { $gte: format(startDate, 'yyyy-MM-dd'), $lte: format(endDate, 'yyyy-MM-dd') };
          console.log(`Filtering deliveries for year ${selectedOverviewYear}: ${query.delivery_date.$gte} to ${query.delivery_date.$lte}`);
        } else {
          console.log('Fetching all deliveries for overview (no year filter)');
        }
        deliveriesData = await getData('Delivery', '-delivery_date', query, forceRefresh);
        console.log('Found total deliveries for overview:', deliveriesData?.length || 0);
      } else {
        // In daily view mode, fetch deliveries for the selected month
        const currentYear = selectedYear;
        const currentMonth = selectedMonth;
        const startOfMonth = new Date(currentYear, currentMonth, 1);
        const endDate = new Date(currentYear, currentMonth + 1, 0);
        const startDateStr = format(startOfMonth, 'yyyy-MM-dd');
        const endDateStr = format(endDate, 'yyyy-MM-dd');

        console.log('Fetching deliveries for', format(startOfMonth, 'MMMM yyyy'));

        deliveriesData = await getData(
          'Delivery',
          '-delivery_date',
          { delivery_date: { $gte: startDateStr, $lte: endDateStr } },
          forceRefresh
        );

        console.log('Found deliveries:', deliveriesData?.length || 0);
      }

      if (isMounted.current) {
        setAllDeliveries(deliveriesData || []);
      }

      // OPTIMIZED: Fetch patients based on role - avoid multiple filtered queries
      let patientsData = [];

      if (userHasRole(user, 'admin')) {
        // For admins: Instead of batched filtered queries, just list ALL patients once
        // This is more efficient and avoids rate limiting
        console.log('Admin - Fetching ALL patients (will filter in memory)');
        try {
          const allPatientsRaw = await getData('Patient', 'full_name', null, forceRefresh);
          console.log('Admin - Fetched all patients:', allPatientsRaw?.length || 0);

          // Filter in memory to only patients with deliveries
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
            // This query is already efficient with a single $in
            patientsData = await getData('Patient', 'full_name', { store_id: { $in: dispatcherStoreIds } }, forceRefresh);
            console.log('Dispatcher - Fetched patients:', patientsData?.length || 0);
          } catch (error) {
            console.error('Failed to fetch patients for dispatcher:', error.message);
            patientsData = [];
          }
        }
      } else if (userHasRole(user, 'driver')) {
        // For drivers: List all patients once and filter in memory
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
      initialLoadDone.current = true; // Mark initial load as done after successful data fetch

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
      loadInProgress.current = 0; // Reset load in progress flag
    }
  }, [currentUser, selectedYear, selectedMonth, isDriverOverviewMode, selectedOverviewYear]);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  // Sync context data to local state for real-time updates
  useEffect(() => {
    if (contextDataLoaded && contextDeliveries.length > 0) {
      console.log("🔄 [Deliveries] Syncing data from AppDataContext");
      setAllDeliveries(contextDeliveries);
      setAllPatients(contextPatients);
      setStores(contextStores);
      setCities(contextCities);
      // Sync users if available
      if (contextUsers.length > 0) {
        setAllUsers(contextUsers);
      }
    }
  }, [contextDataLoaded, contextDeliveries, contextPatients, contextStores, contextCities, contextUsers]);

  // Force smart refresh when Driver Overview page is active
  useEffect(() => {
    if (!isDriverOverviewMode || !dataLoaded || !hasAccess) return;
    
    console.log('🔄 [Deliveries] Driver Overview active - triggering smart refresh');
    
    // Reset refresh timers to force immediate refresh
    smartRefreshManager.lastRefreshTimes = {
      driverLocation: 0,
      activeDeliveries: 0,
      todayDeliveries: 0,
      appUsers: 0,
      todayPatients: 0,
      patients: 0,
      stores: 0
    };
    
    // Also trigger a data refresh
    setRefreshKey(k => k + 1);
  }, [isDriverOverviewMode, dataLoaded, hasAccess]);

  // Run checkAccess on mount to set hasAccess state
  useEffect(() => {
    console.log('🔐 [Deliveries] Running checkAccess on mount...');
    checkAccess();
  }, [checkAccess]);

  // Effect to perform initial data load only once after access is granted
  useEffect(() => {
    // Only run initial load once and if access is granted
    if (!hasAccess || initialLoadDone.current) {
      console.log(`⏩ [Deliveries] Skipping initial loadData (hasAccess: ${hasAccess}, initialLoadDone: ${initialLoadDone.current})`);
      return;
    }

    console.log('🚀 [Deliveries] Running initial loadData on page mount...');

    // Mark as done IMMEDIATELY to prevent re-runs
    initialLoadDone.current = true;

    setIsLoading(true);
    loadData(false).finally(() => {
      if (isMounted.current) {
        setIsLoading(false);
      }
    });
  }, [hasAccess]); // REMOVED loadData from dependencies to prevent loop


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
  }, [allDeliveries.length]); // CHANGED: Only depend on length, not entire array


  // Auto-select most recent year ONLY if currently 'all' and no URL param exists
  useEffect(() => {
    if (!isDriverOverviewMode || !dataLoaded || !hasAccess) return;
    if (!availableOverviewYears || availableOverviewYears.length === 0) return;

    const params = new URLSearchParams(location.search);
    const yearParam = params.get('overviewYear');

    // IMPORTANT: If 'all' is explicitly in the URL, respect it.
    if (yearParam === 'all') {
      console.log('📅 [Deliveries] URL explicitly requests "all" years, respecting selection.');
      if (selectedOverviewYear !== 'all') {
        setSelectedOverviewYear('all');
      }
      yearAutoSelectDone.current = true; // Mark as done to prevent re-runs
      yearManuallySelected.current = true; // Also mark as manually selected implicitly
      return;
    }

    // If a specific year is in the URL, use it
    if (yearParam && yearParam !== 'all') {
      console.log('📅 [Deliveries] Using specific year from URL:', yearParam);
      if (selectedOverviewYear !== yearParam) {
        setSelectedOverviewYear(yearParam);
      }
      yearAutoSelectDone.current = true; // Mark as done to prevent re-runs
      yearManuallySelected.current = true; // Also mark as manually selected implicitly
      return;
    }

    // If no yearParam in URL and no manual selection, then auto-select the most recent year.
    // This check for yearAutoSelectDone.current prevents it from running multiple times if state changes.
    if (!yearManuallySelected.current && selectedOverviewYear === 'all' && !yearAutoSelectDone.current) {
      const mostRecentYear = availableOverviewYears[0];
      if (mostRecentYear) {// Ensure there's a year to auto-select
        console.log('📅 [Deliveries] Auto-selecting most recent year:', mostRecentYear);
        setSelectedOverviewYear(mostRecentYear.toString());
        // Do NOT set yearManuallySelected.current to true here, as it's an auto-selection
      }
      yearAutoSelectDone.current = true; // Mark as done after the initial auto-selection or decision not to auto-select
    }
  }, [isDriverOverviewMode, dataLoaded, availableOverviewYears.length, hasAccess, location.search, selectedOverviewYear]);


  // Ensure mobile date menu is closed when switching to Driver Overview
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


  const updateUrl = useCallback((newFilters) => {
    const params = new URLSearchParams(location.search);
    const todayString = format(new Date(), 'yyyy-MM-dd');
    const currentYear = new Date().getFullYear().toString();
    const currentMonth = (new Date().getMonth() + 1).toString();

    Object.entries(newFilters).forEach(([key, value]) => {
      // Skip invalid values
      if (value === undefined || value === null || value === '' || value === 'all') {
        params.delete(key);
        return;
      }

      if (key === 'date') {
        try {
          let dateStr;

          // Convert Date object to string
          if (value instanceof Date) {
            if (isNaN(value.getTime())) {
              console.warn('[updateUrl] Invalid Date object');
              return;
            }
            dateStr = format(value, 'yyyy-MM-dd');
          } else if (typeof value === 'string') {
            // Validate string format
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

          // Only add date param if it's not today
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

  // Apply role-based filtering AFTER data is loaded
  const effectiveDeliveries = useMemo(() => {
    if (!currentUser || !allDeliveries || !Array.isArray(allDeliveries)) return [];
    if (userHasRole(currentUser, 'admin')) return allDeliveries;

    // UPDATED: Dispatcher filtering by store_id only (removed dispatcher_id check)
    if (userHasRole(currentUser, 'dispatcher')) {
      const dispatcherStoreIds = currentUser.store_ids || [];
      return allDeliveries.filter((d) => {
        if (!d) return false;
        // Check if delivery's store_id is in dispatcher's store_ids
        if (d.store_id && dispatcherStoreIds.includes(d.store_id)) {
          return true;
        }

        // Fallback: Check patient's store assignment if delivery itself has no store_id
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
      // CHANGED: compare by driver_id with name fallback
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

    // Filter to only users with driver, admin, or dispatcher roles
    let driversOnly = allUsers.filter((u) => {
      if (!u) {
        return false;
      }

      // ONLY check app_roles - if they have driver, admin, or dispatcher role, include them
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
      const filtered = driversOnly.filter((u) => u && (u.status === 'active' || isDriverOverviewMode));
      console.log('👑 [Deliveries] Admin view - filtered drivers:', filtered.length);
      return filtered;
    }

    if (userHasRole(currentUser, 'dispatcher')) {
      let filteredDrivers = driversOnly.filter((u) => u && (u.status === 'active' || isDriverOverviewMode));
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
    const dateParam = params.get("date");
    const driverParam = params.get("driver");
    const statusParam = params.get("status");
    const searchParam = params.get("search");
    const yearParam = params.get("year");
    const monthParam = params.get("month");
    const cityParam = params.get("city");

    let initialSelectedYear = new Date().getFullYear();
    let initialSelectedMonth = new Date().getMonth(); // 0-indexed

    if (yearParam) initialSelectedYear = parseInt(yearParam);
    if (monthParam) initialSelectedMonth = parseInt(monthParam) - 1; // Convert from 1-indexed URL to 0-indexed

    console.log('📅 [Deliveries] Setting year/month from URL:', {
      year: initialSelectedYear,
      month: initialSelectedMonth,
      monthParam
    });

    setSelectedYear(initialSelectedYear);
    setSelectedMonth(initialSelectedMonth);

    // Initialize city filter
    let initialSelectedCityId = 'all';
    if (userHasRole(currentUser, 'admin')) {
      initialSelectedCityId = cityParam || 'all';
    } else if (userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) {
      if (currentUser.city_id) {
        initialSelectedCityId = currentUser.city_id;
      }
    }
    setSelectedCityId(initialSelectedCityId);

    let initialSelectedDate = new Date();
    initialSelectedDate.setHours(0, 0, 0, 0);

    if (dateParam) {
      const [year, month, day] = dateParam.split('-').map(Number);
      if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
        const parsedDate = new Date(year, month - 1, day);
        parsedDate.setHours(0, 0, 0, 0);
        if (!isNaN(parsedDate.getTime())) {
          initialSelectedDate = parsedDate;
          console.log('📅 [Deliveries] Using date from URL:', format(initialSelectedDate, 'yyyy-MM-dd'));
        } else {
          console.warn('[Deliveries] Invalid date from URL dateParam:', dateParam);
        }
      } else {
        console.warn('[Deliveries] Could not parse date components from URL dateParam:', dateParam);
      }
    } else {
      const globalDate = globalFilters.getSelectedDate();
      if (globalDate) {
        try {
          const globalDateObj = new Date(globalDate);
          if (!isNaN(globalDateObj.getTime()) &&
          globalDateObj.getFullYear() === initialSelectedYear &&
          globalDateObj.getMonth() === initialSelectedMonth) {
            initialSelectedDate = globalDateObj;
          }
        } catch (e) {
          console.warn('[Deliveries] Error parsing global date:', e);
        }
      } else {
        initialSelectedDate = new Date(initialSelectedYear, initialSelectedMonth, 1);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (initialSelectedYear === today.getFullYear() &&
        initialSelectedMonth === today.getMonth() &&
        initialSelectedDate > today) {
          initialSelectedDate = today;
        }
      }
    }

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

    if (!dateParam && !globalFilters.getSelectedDate()) {
      const driverToFilterBy = (effectiveDrivers || []).find((d) => d.id === newDriverFilter);

      const deliveriesForDateCalculation = newDriverFilter === 'all' ?
      effectiveDeliveries || [] :
      (effectiveDeliveries || []).filter((d) =>
      d.driver_id && driverToFilterBy && d.driver_id === driverToFilterBy.id ||
      !d.driver_id && driverToFilterBy && d.driver_name && (
      d.driver_name === driverToFilterBy.full_name || d.driver_name === driverToFilterBy.user_name)
      );

      if (deliveriesForDateCalculation && deliveriesForDateCalculation.length > 0) {
        const sorted = [...deliveriesForDateCalculation].sort((a, b) =>
        new Date(b.delivery_date.replace(/-/g, '/')) - new Date(a.delivery_date.replace(/-/g, '/'))
        );
        if (sorted.length > 0 && sorted[0].delivery_date) {
          const [y, m, d] = sorted[0].delivery_date.split('-').map(Number);
          if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
            const latestDate = new Date(y, m - 1, d);
            latestDate.setHours(0, 0, 0, 0);
            if (!isNaN(latestDate.getTime())) {
              initialSelectedDate = latestDate;
            }
          }
        }
      }
    }

    console.log('📅 [Deliveries] Final initial state:', {
      date: format(initialSelectedDate, 'yyyy-MM-dd'),
      year: initialSelectedYear,
      month: initialSelectedMonth,
      driver: newDriverFilter
    });

    setSelectedDate(initialSelectedDate);
    setStatusFilter(statusParam || '');
    setSearchTerm(searchParam || '');

    const currentDriver = (effectiveDrivers || []).find((d) => d.id === newDriverFilter);
    setActiveDriver(currentDriver || null);
    if (currentDriver && currentDriver.location_tracking_enabled) {
      setIsDriverOnline(true);
    } else {
      setIsDriverOnline(false);
    }

  }, [location.search, currentUser, dataLoaded, hasAccess, isLoadingData, cities]);


  const driverFilteredDeliveries = useMemo(() => {
    if (!effectiveDeliveries || !Array.isArray(effectiveDeliveries)) return [];

    if (driverFilter === 'all') {
      return effectiveDeliveries;
    }

    const selectedDriver = (effectiveDrivers || []).find((d) => d.id === driverFilter);
    if (!selectedDriver) return [];

    // CHANGED: compare by driver_id with name fallback
    return effectiveDeliveries.filter((d) =>
    d.driver_id && (d.driver_id === selectedDriver.id || d.driver_id === selectedDriver.appUserId) ||
    !d.driver_id && d.driver_name && (d.driver_name === selectedDriver.full_name || d.driver_name === selectedDriver.user_name)
    );
  }, [effectiveDeliveries, effectiveDrivers, driverFilter]);

  const groupedDeliveries = useMemo(() => {
    return (driverFilteredDeliveries || []).reduce((acc, delivery) => {
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
  }, [driverFilteredDeliveries]);

  const sortedDates = useMemo(() => {
    return Object.keys(groupedDeliveries).sort((a, b) => new Date(b.replace(/-/g, '/')) - new Date(a.replace(/-/g, '/')));
  }, [groupedDeliveries]);

  const selectedDateDeliveries = useMemo(() => {
    if (!selectedDate) return [];
    const dateString = format(selectedDate, 'yyyy-MM-dd');
    return (groupedDeliveries[dateString] || []).filter((d) => !d.isProjected); // Ensure only actual deliveries
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
    return sortedDates.filter((date) => {
      const dateObj = new Date(date.replace(/-/g, '/'));
      return dateObj.getFullYear() === selectedYear && dateObj.getMonth() === selectedMonth;
    });
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

    // No longer adding projections here, as `projectedRoutes` handles it separately.
    // The date list only reflects dates with actual deliveries.

    const sortedAndFilteredDates = Array.from(datesSet).sort((a, b) => new Date(b.replace(/-/g, '/')) - new Date(a.replace(/-/g, '/')));

    return sortedAndFilteredDates.map((date) => {
      const deliveriesOnDate = groupedDeliveries[date] || [];
      const total = deliveriesOnDate.length;
      const done = deliveriesOnDate.filter((d) => ['completed', 'picked_up', 'in_transit'].includes(d.status)).length; // Updated done status
      const returnedByStatus = deliveriesOnDate.filter((d) => d.status === 'returned').length;
      const failedByStatus = deliveriesOnDate.filter((d) => d.status === 'failed').length; // Added failed status

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

      // Projections are handled separately now
      return { date, total, done, failed: failedByStatus, returned, displayLabel, actualDeliveries: deliveriesOnDate.length };
    });
  }, [filteredDatesByMonth, groupedDeliveries, effectivePatients, selectedYear, selectedMonth]);

  // Auto-select topmost date when month/year changes
  useEffect(() => {
    if (isDriverOverviewMode || isLoading || !dateListWithStats.length || isLoadingData) {
      return;
    }

    // IMPORTANT: Don't auto-select if there's a date parameter in the URL
    const params = new URLSearchParams(location.search);
    const dateParam = params.get("date");
    if (dateParam) {
      console.log('⏩ [Deliveries] Skipping auto-select - date param in URL:', dateParam);
      return;
    }

    // Only auto-select if we have dates in the list
    if (dateListWithStats.length > 0) {
      const currentSelectedDateString = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : null;

      // CRITICAL: Only auto-select if current date is NOT in the list
      // Don't force selection to top date if user manually selected a different date
      const isCurrentDateInList = dateListWithStats.some((d) => d.date === currentSelectedDateString);

      if (!isCurrentDateInList) {
        const topDate = dateListWithStats[0].date;
        const topDateObj = new Date(topDate.replace(/-/g, '/'));
        topDateObj.setHours(0, 0, 0, 0);

        console.log(`📅 [Deliveries] Current date not in list, auto-selecting topmost date: ${topDate}`);
        setSelectedDate(topDateObj);
        updateUrl({ date: topDate });
      }
    }
  }, [selectedMonth, selectedYear, dateListWithStats.length, isDriverOverviewMode, isLoading, isLoadingData, location.search]);


  useEffect(() => {
    if (isDriverOverviewMode || isLoading || !dateListWithStats.length || !effectiveDrivers.length || !hasAccess || isLoadingData) {
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
    todayDeliveriesForActiveDriver.every((d) => ['completed', 'returned', 'failed', 'cancelled'].includes(d.status)); // Added failed

    // The logic to advance to tomorrow based on projections is now handled by the separate projection component,
    // so `dateListWithStats` doesn't need to contain `projections`.
    // The auto-selection of tomorrow should still work based on actual deliveries.
    const selectedDriverFromFilter = (effectiveDrivers || []).find((d) => d.id === driverFilter);
    const tomorrowHasActualDeliveries = groupedDeliveries[tomorrowString]?.length > 0;


    let targetDateString = null;

    // This logic relies on actual deliveries and does not use `dateListWithStats.projections` anymore.
    // It will be triggered if all today's deliveries are complete for the active driver AND there are actual deliveries tomorrow.
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
      updateUrl({ date: targetDateString }); // Pass string directly
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

  // Sort deliveries by time for display - MATCHES DASHBOARD SORTING LOGIC
  // Extra rule: completed deliveries go to the bottom
  const sortDeliveriesByTime = useCallback((deliveries) => {
    if (!Array.isArray(deliveries)) return [];

    const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

    // Separate incomplete and completed
    const incomplete = deliveries.filter((d) => d && !finishedStatuses.includes(d.status));
    const completed = deliveries.filter((d) => d && finishedStatuses.includes(d.status));

    // Sort incomplete by stop_order, then delivery_time_start (Dashboard logic)
    incomplete.sort((a, b) => {
      if (!a || !b) return 0;
      const stopOrderA = a.stop_order ?? Infinity;
      const stopOrderB = b.stop_order ?? Infinity;
      if (stopOrderA !== stopOrderB) return stopOrderA - stopOrderB;
      const timeA = a.delivery_time_start || '';
      const timeB = b.delivery_time_start || '';
      return timeA.localeCompare(timeB);
    });

    // Sort completed by stop_order (maintain their original order)
    completed.sort((a, b) => {
      if (!a || !b) return 0;
      const stopOrderA = a.stop_order ?? Infinity;
      const stopOrderB = b.stop_order ?? Infinity;
      return stopOrderA - stopOrderB;
    });

    // Incomplete first, completed at bottom
    return [...incomplete, ...completed];
  }, []);

  const filteredAndSortedDeliveries = useMemo(() => {
    let filtered = selectedDateDeliveries;

    // Apply status filter
    if (statusFilter && statusFilter !== 'all') {
      filtered = filtered.filter((d) => d.status === statusFilter);
    }

    // Apply search filter
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

    // Sort the filtered deliveries
    const sorted = sortDeliveriesByTime(filtered);

    return sorted.map((delivery, index) => ({
      ...delivery,
      stopOrder: index + 1 // Assign stopOrder based on new order
    }));
  }, [selectedDateDeliveries, effectivePatients, stores, statusFilter, searchTerm, sortDeliveriesByTime]);

  const createDriverPickupStops = useCallback(async (driver, deliveryDate) => {
    try {
      const driverName = driver.full_name;
      const driverId = driver.id; // Platform User ID
      const appUserId = driver.appUserId; // AppUser entity ID

      const driverStores = (stores || []).filter((store) => {// Stores are not role-filtered
        const deliveryDateObj = new Date(deliveryDate);
        const dayOfWeek = deliveryDateObj.getDay(); // 0 = Sunday, 6 = Saturday

        if (dayOfWeek === 6) {// Saturday
          return store.saturday_am_enabled && store.saturday_am_start && (store.driver_saturday_am_id === driverId || store.driver_saturday_am_id === appUserId || store.driver_saturday_am === driverName) ||
          store.saturday_pm_enabled && store.saturday_pm_start && (store.driver_saturday_pm_id === driverId || store.driver_saturday_pm_id === appUserId || store.driver_saturday_pm === driverName);
        } else if (dayOfWeek === 0) {// Sunday
          return store.sunday_am_enabled && store.sunday_am_start && (store.sunday_am_driver_id === driverId || store.sunday_am_driver_id === appUserId || store.sunday_am_driver === driverName) ||
          store.sunday_pm_enabled && store.sunday_pm_start && (store.sunday_pm_driver_id === driverId || store.sunday_pm_driver_id === appUserId || store.sunday_pm_driver === driverName);
        } else {// Weekday
          return store.weekday_am_enabled && store.weekday_am_start && (store.weekday_am_driver_id === driverId || store.weekday_am_driver_id === appUserId || store.weekday_am_driver === driverName) ||
          store.weekday_pm_enabled && store.weekday_pm_start && (store.weekday_pm_driver_id === driverId || store.weekday_pm_driver_id === appUserId || store.weekday_pm_driver === driverName);
        }
      });

      const storesWithTimes = driverStores.map(async ({ ...store }) => {// Removed destructuring to use `store` object directly
        const deliveryDateObj = new Date(deliveryDate);
        const dayOfWeek = deliveryDateObj.getDay();
        let earliestStorePickupTime = null;
        let earliestStorePickupEndTime = null;

        if (dayOfWeek === 6) {// Saturday
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
        } else if (dayOfWeek === 0) {// Sunday
          if (store.sunday_am_enabled && store.sunday_am_start && (store.sunday_am_driver_id === driverId || store.sunday_am_driver_id === appUserId || store.sunday_am_driver === driverName)) {
            earliestStorePickupTime = store.sunday_am_start;
            earliestStorePickupEndTime = addMinutesToTime(earliestStorePickupTime, 60);
          }
          if (store.sunday_pm_enabled && store.sunday_pm_start && (store.sunday_pm_driver_id === driverId || store.sunday_pm_driver_id === appUserId || store.sunday_pm_driver === driverName)) {
            const pmStart = store.sunday_pm_start || '13:00';
            if (!earliestStorePickupTime || pmStart < earliestStorePickupTime) {// FIX: Changed currentStorePickupTime to earliestStorePickupTime
              earliestStorePickupTime = pmStart;
              earliestStorePickupEndTime = addMinutesToTime(pmStart, 60);
            }
          }
        } else {// Weekday
          if (store.weekday_am_enabled && store.weekday_am_start && (store.weekday_am_driver_id === driverId || store.weekday_am_driver_id === appUserId || store.weekday_am_driver === driverName)) {
            earliestStorePickupTime = store.weekday_am_start;
            earliestStorePickupEndTime = addMinutesToTime(earliestStorePickupTime, 60);
          }
          if (store.weekday_pm_enabled && store.weekday_pm_start && (store.weekday_pm_driver_id === driverId || store.weekday_pm_driver_id === appUserId || store.weekday_pm_driver === driverName)) {
            const pmStart = store.weekday_pm_start || '13:00';
            if (!earliestStorePickupTime || pmStart < earliestStorePickupTime) {// FIX: Changed currentStorePickupTime to earliestStorePickupTime
              earliestStorePickupTime = pmStart;
              earliestStorePickupEndTime = addMinutesToTime(pmStart, 60);
            }
          }
        }
        return { store, pickupTime: earliestStorePickupTime, pickupEndTime: earliestStorePickupEndTime };
      });

      const resolvedStoresWithTimes = (await Promise.all(storesWithTimes)).filter((s) => s.pickupTime); // Only keep stores that have a defined pickup time

      resolvedStoresWithTimes.sort((a, b) => (a.pickupTime || '').localeCompare(b.pickupTime || ''));

      const pickupPromises = resolvedStoresWithTimes.map(async ({ store, pickupTime, pickupEndTime }, storeIndex) => {
        const storeAbbr = store.abbreviation || 'XX';
        const baseTrackingNumber = storeIndex * 20;
        const pickupTrackingNumber = `${storeAbbr}${String(baseTrackingNumber).padStart(2, '0')}`;

        const allCurrentDeliveries = await getData('Delivery'); // Fetches all deliveries from DB (not filtered effectiveDeliveries)
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
            driver_id: driverId, // Store driver_id (platform User ID)
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
      if (dayOfWeek === 6) {// Saturday
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
      } else if (dayOfWeek === 0) {// Sunday
        if (store.sunday_am_enabled && store.sunday_am_start) {
          earliestStorePickupTime = store.sunday_am_start;
          earliestStorePickupEndTime = addMinutesToTime(earliestStorePickupTime, 60);
        }
        if (store.sunday_pm_enabled && store.sunday_pm_start) {
          const pmStart = store.sunday_pm_start || '13:00';
          if (!earliestStorePickupTime || pmStart < earliestStorePickupTime) {// FIX: Changed currentStorePickupTime to earliestStorePickupTime
            earliestStorePickupTime = pmStart;
            earliestStorePickupEndTime = addMinutesToTime(pmStart, 60);
          }
        }
      } else {// Weekday
        if (store.weekday_am_enabled && store.weekday_am_start) {
          earliestStorePickupTime = store.weekday_am_start;
          earliestStorePickupEndTime = addMinutesToTime(earliestStorePickupTime, 60);
        }
        if (store.weekday_pm_enabled && store.weekday_pm_start) {
          const pmStart = store.weekday_pm_start || '13:00';
          if (!earliestStorePickupTime || pmStart < earliestStorePickupTime) {// FIX: Changed currentStorePickupTime to earliestStorePickupTime
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
    const allDeliveriesRaw = await getData('Delivery'); // Fetch all deliveries from DB for full optimization scope
    const driverName = driver.full_name;
    const driverId = driver.id; // Platform User ID
    const appUserId = driver.appUserId; // AppUser ID

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

    const patientMap = new Map((allPatients || []).map((p) => [p.id, p])); // Use raw patients data for optimization logic

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
      // Handle batch save for staged deliveries
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

          // Find driver
          let actualDriver = null;
          if (staged.driver_id && staged.driver_id !== 'unassigned') {
            actualDriver = allUsers.find((u) => u.id === staged.driver_id);
          }

          // Assign dispatcher_id based on store
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

          // Create pickup stop if needed
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

          // Prepare final delivery data
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

          // Remove temporary fields
          delete finalDeliveryData._tempId;
          delete finalDeliveryData.store_name;
          delete finalDeliveryData.store_abbreviation;
          delete finalDeliveryData.distanceFromStore;
          delete finalDeliveryData.delivery_address;

          console.log(`✅ [Deliveries] Created delivery for ${staged.patient_name || 'pickup'}`);
          await Delivery.create(finalDeliveryData);

          // Optimize route order for this store
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

      // Normalize driver assignment
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

      // Assign dispatcher_id based on store assignment
      if (deliveryData.store_id && stores) {
        const selectedStore = stores.find((s) => s.id === deliveryData.store_id);
        if (selectedStore) {
          // PHASE 3 CHANGE: Use store.dispatcher_id directly instead of looking up by name
          if (selectedStore.dispatcher_id) {
            deliveryData.dispatcher_id = selectedStore.dispatcher_id;
            console.log('✅ [Deliveries] Assigned dispatcher_id from store:', {
              store: selectedStore.name,
              dispatcher_id: selectedStore.dispatcher_id
            });
          } else if (selectedStore.dispatcher_name) {
            // Fallback to name-based lookup for legacy data
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
      // Close modal first
      setShowImportModal(false);

      console.log('🗑️ [Deliveries] Invalidating all caches...');

      // Invalidate all relevant caches
      invalidate('Delivery');
      invalidate('Patient');
      invalidate('Store');
      invalidate('User');
      invalidate('AppUser');
      invalidate('City'); // Also invalidate City in case new cities were imported

      console.log('🔄 [Deliveries] Forcing data refresh...');

      // Wait a brief moment for cache invalidation to settle
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Fetch fresh data directly without going through loadData to avoid state conflicts
      const [freshDeliveries, freshPatients, freshStores, freshAppUsers, freshCities] = await Promise.all([
      getData('Delivery', '-delivery_date', null, true),
      getData('Patient', 'full_name', null, true),
      getData('Store', '-created_date', null, true),
      getData('AppUser', '-created_date', null, true),
      getData('City', '-created_date', null, true) // Fetch fresh cities
      ]);

      console.log('📊 [Deliveries] Fetched fresh data:', {
        deliveries: freshDeliveries?.length || 0,
        patients: freshPatients?.length || 0,
        stores: freshStores?.length || 0,
        appUsers: freshAppUsers?.length || 0,
        cities: freshCities?.length || 0
      });

      // Update state with fresh data
      if (isMounted.current) {
        setAllDeliveries(freshDeliveries || []);
        setAllPatients(freshPatients || []);
        setStores(freshStores || []);
        setCities(freshCities || []); // Update cities state

        // Rebuild merged users, similar to loadData logic
        let allAuthUsers = [];
        if (currentUser?.role === 'admin' || isAppOwner(currentUser)) {
          const usersData = await getData('User', '-created_date', null, true); // Fetch fresh User entities
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

        // Filter out store accounts using freshStores
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

        // Filter drivers/admins/dispatchers
        mergedUsers = mergedUsers.filter((u) => {
          const roles = Array.isArray(u.app_roles) ? u.app_roles : u.app_role ? [u.app_role] : [];
          const hasRole = roles.some((r) => r === 'driver' || r === 'admin' || r === 'dispatcher');
          const statusOk = isDriverOverviewMode ? u.status === 'active' || u.status === 'inactive' : u.status === 'active';
          return hasRole && statusOk;
        });

        setAllUsers(sortUsers(mergedUsers));

        // Force UI refresh
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
    const patientToEdit = (allPatients || []).find((p) => p && p.id === patientId); // Use raw patients
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

      // Define finished statuses - these all get timestamps
      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const isFinishing = finishedStatuses.includes(newStatus);
      const wasFinished = finishedStatuses.includes(delivery.status);

      const todayString = format(new Date(), 'yyyy-MM-dd');
      const isToday = delivery.delivery_date === todayString;

      // Set timestamp for finished deliveries (today only)
      if (isFinishing && isToday && !delivery.actual_delivery_time) {
        const now = new Date();
        if (now && typeof now.toISOString === 'function') {
          updateData.actual_delivery_time = now.toISOString();
          console.log('✅ [Deliveries] Set timestamp for finished status:', newStatus);
        }
      }

      // Clear timestamp if moving from finished to unfinished
      if (wasFinished && !isFinishing) {
        updateData.actual_delivery_time = null;
        console.log('🗑️ [Deliveries] Cleared timestamp - moving from finished to active');
      }

      await Delivery.update(deliveryId, updateData);

      if (newStatus === 'completed' && delivery.patient_id) {
        await Patient.update(delivery.patient_id, {
          last_delivery_date: delivery.delivery_date
        });
        await invalidate('Patient');
      }

      // CRITICAL: Invalidate all delivery caches to force Dashboard to refresh
      invalidate('Delivery');

      // Force a background refresh of context data
      await loadData(true);

      // Handle pickup completion logic
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
        Delivery.update(d.id, { status: 'in_transit' })
        );
        await Promise.all(updatePromises);
        console.log(`✅ [Deliveries] Updated ${relatedDeliveries.length} deliveries to in_transit after pickup`);
      }

      const freshDeliveries = await Delivery.list('-created_date');
      setAllDeliveries(freshDeliveries || []);

    } catch (error) {
      console.error('Error updating delivery status:', error);
    }
  }, [effectiveDeliveries, setAllDeliveries]);

  const handleNotesUpdate = useCallback(async (deliveryId, newNotes) => {
    try {
      await Delivery.update(deliveryId, { delivery_notes: newNotes });
      await invalidate('Delivery');
      // Directly update the state after invalidation
      const freshDeliveries = await Delivery.list('-created_date');
      setAllDeliveries(freshDeliveries || []);
    } catch (error) {
      console.error("Error updating delivery notes:", error);
      alert("Failed to update delivery notes.");
    }
  }, [setAllDeliveries]);

  const handleCODUpdate = useCallback(async (deliveryId, requiresCod) => {
    try {
      await Delivery.update(deliveryId, { requires_cod: requiresCod });
      await invalidate('Delivery');
      // Directly update the state after invalidation
      const freshDeliveries = await Delivery.list('-created_date');
      setAllDeliveries(freshDeliveries || []);
    } catch (error) {
      console.error("Error updating COD status:", error);
      alert("Failed to update COD status.");
    }
  }, [setAllDeliveries]);

  const handleRestartDelivery = useCallback(async (deliveryId) => {
    if (!confirm('Are you sure you want to retry this delivery? It will be marked as pending.')) return;
    try {
      await Delivery.update(deliveryId, { status: 'pending', actual_delivery_time: null });
      await invalidate('Delivery');
      // Directly update the state after invalidation
      const freshDeliveries = await Delivery.list('-created_date');
      setAllDeliveries(freshDeliveries || []);
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
        actual_delivery_time: now.toISOString() // Mark as finished with timestamp
      };
      await Delivery.update(deliveryId, updateData);
      await invalidate('Delivery');
      // Directly update the state after invalidation
      const freshDeliveries = await Delivery.list('-created_date');
      setAllDeliveries(freshDeliveries || []);
    } catch (error) {
      console.error("Error returning delivery:", error);
      alert("Failed to mark delivery for return.");
    }
  }, [setAllDeliveries]);

  const handleDeleteDelivery = useCallback(async (deliveryId) => {
    try {
      await Delivery.delete(deliveryId);
      await invalidate('Delivery');
      const freshDeliveries = await Delivery.list('-created_date');
      setAllDeliveries(freshDeliveries || []);
    } catch (error) {
      console.error("Error deleting delivery:", error);
      alert("Failed to delete delivery.");
    }
  }, [setAllDeliveries]);

  const handleMapView = useCallback(() => {
    setShowRouteMap(true);
  }, [setShowRouteMap]);

  const driverOverviewStats = useMemo(() => {
    if (isDriverOverviewMode || !activeDriver) return null;

    // CHANGED: compare by driver_id with name fallback
    const driverDeliveriesForSelectedDate = (selectedDateDeliveries || []).filter(
      (d) =>
      d.driver_id && (d.driver_id === activeDriver.id || d.driver_id === activeDriver.appUserId) ||
      !d.driver_id && d.driver_name && (d.driver_name === activeDriver.full_name || d.driver_name === activeDriver.user_name)
    );

    const totalStops = driverDeliveriesForSelectedDate.length;
    const completed = driverDeliveriesForSelectedDate.filter((d) => d.status === 'completed').length;

    // NEW: compute returns (based on notes/address flags)
    const returned = driverDeliveriesForSelectedDate.filter((d) => {
      const patient = (effectivePatients || []).find((p) => p.id === d.patient_id);
      const notesReturn = (d.delivery_notes || '').toLowerCase().includes('return');
      const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
      return notesReturn || addressReturn;
    }).length;

    // Calculate failed (don't subtract returns) - now counts deliveries with 'failed' status
    const failed = driverDeliveriesForSelectedDate.filter((d) => d.status === 'failed').length;

    return { totalStops, completed, failed, returned };
  }, [isDriverOverviewMode, selectedDateDeliveries, activeDriver, effectivePatients]);

  // Equal-width stat cards: measure max width across all and apply it
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
        className="px-3 py-2 bg-slate-50 rounded-lg text-center inline-flex flex-col items-center justify-center shadow-sm"
        style={fixedWidth ? { width: fixedWidth } : undefined}>

        <p className={`text-2xl font-bold ${valueClass}`}>{value}</p>
        <p className="text-xs text-slate-500">{label}</p>
      </div>);

  }

  // === Projections for routes page (per driver) ===
  const activeDriverDeliveries = React.useMemo(() => {
    if (!activeDriver || !selectedDateDeliveries || !Array.isArray(selectedDateDeliveries)) return [];
    return selectedDateDeliveries.filter((d) =>
    d?.driver_id && (d.driver_id === activeDriver.id || d.driver_id === activeDriver.appUserId) ||
    !d?.driver_id && d?.driver_name && (d.driver_name === activeDriver.user_name || d.driver_name === activeDriver.full_name)
    );
  }, [selectedDateDeliveries, activeDriver]);

  const projectedRoutes = React.useMemo(() => {
    // Only project if no actual deliveries for this driver on the selected date
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

    // Patients source
    const patientsSource = typeof effectivePatients !== 'undefined' && Array.isArray(effectivePatients) && effectivePatients?.length ?
    effectivePatients :
    typeof allPatients !== 'undefined' && Array.isArray(allPatients) ? allPatients || [] : [];

    // eligibility helpers
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

      // specific cadence rules
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
          return daysSince >= 13; // Allow a day before/after
        }
      }

      if (notes.includes('bi-weekly')) return daysSince >= 13 && daysSince <= 15;
      if (notes.includes('weekly x4')) return daysSince >= 26 && daysSince <= 31 && daysSince % 28 === 0;
      if (notes.includes('monthly')) return daysSince >= 28 && daysSince <= 31;
      if (notes.includes('weekly')) return daysSince >= 7;
      // default weekly cadence
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

    // Select stores for this driver on the day (AM/PM)
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

        // candidate patients for this store and period
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

        // Seed route time and position
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

    // Order and numbering
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

  // Small subcomponents for projected UI
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

      // IMPORTANT: Pass string to updateUrl, not Date object
      updateUrl({ date: dateString });
    } catch (error) {
      console.error('[handleDateSelect] Error:', error);
    }
  }, [updateUrl]);

  const handleSearchChange = useMemo(() => debounce((value) => {
    setSearchTerm(value);
  }, 300), []);

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
      const dateString = format(targetDate, 'yyyy-MM-dd');

      console.log('🎯 [handleDriverChange] Updating filters:', {
        driver: driverId,
        date: dateString,
        year: targetYear,
        month: targetMonth + 1
      });

      setDriverFilter(driverId);
      setSelectedDate(targetDate);
      setSelectedYear(targetYear);
      setSelectedMonth(targetMonth);

      // IMPORTANT: Pass string date, not Date object
      updateUrl({
        driver: driverId,
        date: dateString,
        year: targetYear.toString(),
        month: (targetMonth + 1).toString()
      });
    } catch (error) {
      console.error('[handleDriverChange] Error:', error);
    }
  }, [effectiveDrivers, effectiveDeliveries, updateUrl]);

  const handleDragEnd = useCallback(async (result) => {
    if (!result.destination) return;

    // Use a copy of the already filtered and sorted deliveries
    const reorderedDeliveries = Array.from(filteredAndSortedDeliveries);
    const [reorderedItem] = reorderedDeliveries.splice(result.source.index, 1);
    reorderedDeliveries.splice(result.destination.index, 0, reorderedItem);

    try {
      const updatePromises = reorderedDeliveries.map((delivery, index) => {
        const newStopOrder = index + 1;
        // Only update if the stop order has actually changed or if it was null/undefined
        if (delivery.stopOrder !== newStopOrder) {
          // Note: using delivery.id here, not delivery.stopOrder (which is a transient UI prop)
          return Delivery.update(delivery.id, { stop_order: newStopOrder });
        }
        return null;
      }).filter(Boolean); // Filter out nulls

      if (updatePromises.length > 0) {
        await Promise.all(updatePromises);
        await invalidate('Delivery');
        // Force a full reload to reflect the updated stop_orders and potentially re-sort
        await loadData(true);
      }
    } catch (error) {
      console.error("Error reordering deliveries:", error);
      alert("Failed to reorder deliveries. Please try again.");
    }
  }, [filteredAndSortedDeliveries, loadData]); // Depend on loadData to ensure full refresh

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
    console.log(`📊 effectiveDeliveries count: ${effectiveDeliveries?.length || 0}`);

    // Safety check: ensure we have the required data
    if (!effectiveDeliveries || !Array.isArray(effectiveDeliveries)) {
      console.warn('⚠️ effectiveDeliveries is not available');
      return [];
    }

    if (!allUsers || !Array.isArray(allUsers)) {
      console.warn('⚠️ allUsers is not available');
      return [];
    }

    if (!effectivePatients || !Array.isArray(effectivePatients)) {
      console.warn('⚠️ effectivePatients is not available');
      return [];
    }

    // REMOVED OPTIMIZATION: Don't skip computation for 'all' - let it work normally
    // The auto-select will handle switching to a specific year if needed

    // Filter deliveries by selectedOverviewYear
    const yearFilteredDeliveries = selectedOverviewYear === 'all' ?
    effectiveDeliveries :
    effectiveDeliveries.filter((d) => {
      if (!d || !d.delivery_date) return false;
      try {
        const deliveryYear = new Date(d.delivery_date.replace(/-/g, '/')).getFullYear();
        return deliveryYear === parseInt(selectedOverviewYear, 10);
      } catch (error) {
        console.warn('⚠️ Invalid delivery_date during year filtering:', d.delivery_date);
        return false;
      }
    });

    console.log(`📊 Year-filtered deliveries: ${yearFilteredDeliveries.length} of ${effectiveDeliveries.length} total`);

    if (yearFilteredDeliveries.length > 0) {
      const dates = yearFilteredDeliveries.map((d) => d.delivery_date).filter(Boolean).sort();
      console.log(`📊 Date range in yearFilteredDeliveries: ${dates[0]} to ${dates[dates.length - 1]}`);
      console.log(`📊 Sample delivery dates:`, dates.slice(0, 5), '...', dates.slice(-5));
    }

    const driverNamesInDeliveries = [...new Set(yearFilteredDeliveries.map((d) => d.driver_name).filter(Boolean))];
    const driverIdsInDeliveries = [...new Set(yearFilteredDeliveries.map((d) => d.driver_id).filter(Boolean))];
    console.log(`📊 Unique driver names in deliveries:`, driverNamesInDeliveries);
    console.log(`📊 Unique driver IDs in deliveries:`, driverIdsInDeliveries);

    // Get all drivers (active AND inactive) who have roles
    // Include drivers, admins, AND dispatchers for the overview
    const driversWithRoles = allUsers.filter((u) => {
      if (!u) return false;
      const roles = Array.isArray(u.app_roles) ? u.app_roles : [];
      const hasRelevantRole = roles.includes('driver') || roles.includes('admin') || roles.includes('dispatcher');
      if (hasRelevantRole) {
        console.log(`✅ Including user ${u.user_name || u.full_name} with roles: ${roles.join(', ')}`);
      }
      return hasRelevantRole;
    });
    console.log(`👥 Total drivers/admins/dispatchers with roles: ${driversWithRoles.length}`);

    // Filter by city based on user role and selected city
    let cityFilteredDrivers = driversWithRoles; // Start with drivers that have relevant roles

    if (userHasRole(currentUser, 'admin')) {
      // Admins see ALL drivers regardless of city filter
      console.log('👑 Admin - showing all drivers from all cities');
      // No city filtering for admins - they see everything
    } else if (userHasRole(currentUser, 'dispatcher') || userHasRole(currentUser, 'driver')) {
      // Dispatchers and drivers only see drivers from their own city
      if (currentUser.city_id) {
        cityFilteredDrivers = driversWithRoles.filter((d) => d.city_id === currentUser.city_id);
        console.log(`📍 Filtered to user's city ${currentUser.city_id}: ${cityFilteredDrivers.length} drivers`);
      }
    }

    // Find drivers who have deliveries in the filtered set
    const driversWithDeliveries = cityFilteredDrivers.filter((u) => {
      if (!u) return false;
      const hasDeliveries = driverIdsInDeliveries.includes(u.id) ||
      u.appUserId && driverIdsInDeliveries.includes(u.appUserId) ||
      driverNamesInDeliveries.includes(u.full_name) ||
      driverNamesInDeliveries.includes(u.user_name);
      if (hasDeliveries) {
        console.log(`   ✅ Found driver: ${u.user_name || u.full_name} (full_name: ${u.full_name}, ID: ${u.id}, AppUser ID: ${u.appUserId}), roles: [${(u.app_roles || []).join(', ')}]`);
      }
      return hasDeliveries;
    });

    console.log(`✅ Found ${driversWithDeliveries.length} drivers with deliveries (after city filter)`);

    let driversToShow = [];

    // The outline's `driversToShow` logic was simplified in the original version,
    // let's restore the more explicit filtering from the original but adapt it to the new `driversWithDeliveries`.
    if (userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) {
      // Admins and Dispatchers see the city-filtered list of drivers that have deliveries.
      // For dispatchers, this list is already filtered to their city by the `cityFilteredDrivers` step above.
      driversToShow = driversWithDeliveries;
      console.log(`👑 Admin/Dispatcher - showing ${driversToShow.length} drivers`);
    } else {
      console.log(`❌ User is not admin or dispatcher, no driver overview`);
      return [];
    }


    if (!driversToShow.length) {
      console.log('❌ No drivers to show');
      return [];
    }

    const cards = driversToShow.map((driver) => {
      const driverDeliveries = yearFilteredDeliveries.filter((d) => {
        if (d.driver_id && (d.driver_id === driver.id || d.driver_id === driver.appUserId)) {
          return true;
        }
        if (d.driver_name && (d.driver_name === driver.full_name || d.driver_name === driver.user_name)) {
          return true;
        }
        return false;
      });

      const totalStops = driverDeliveries.length;

      console.log(`🚗 Processing driver: ${driver.user_name || driver.full_name} - Found ${totalStops} deliveries in selected year`);

      // Pickups: Completed pickups only
      const pickups = driverDeliveries.filter((d) => {
        const isPickup = !d.patient_id || d.patient_id === '';
        return isPickup && (d.status === 'completed' || d.status === 'picked_up');
      }).length;

      // Completed: Completed deliveries only (not pickups)
      const completed = driverDeliveries.filter((d) => {
        const isDelivery = d.patient_id && d.patient_id !== '';
        return isDelivery && d.status === 'completed';
      }).length;

      // Calculate returns (by flag)
      const returned = driverDeliveries.filter((d) => {
        const patient = effectivePatients.find((p) => p.id === d.patient_id);
        const notesReturn = (d.delivery_notes || '').toLowerCase().includes('return');
        const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
        return notesReturn || addressReturn;
      }).length;

      // Calculate failed (deliveries with 'failed' status)
      const failed = driverDeliveries.filter((d) => d.status === 'failed').length;

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
        }
      };
    });

    const sortedCards = sortUsers(cards.map((c) => ({ ...c.driver, _cardData: c }))).map((driver) => driver._cardData);
    console.log(`📋 Final sorted cards: ${sortedCards.length} cards`);
    console.log(`📋 Display names:`, sortedCards.map((c) => c.firstName));
    console.log(`📋 Card stats:`, sortedCards.map((c) => `${c.firstName}: ${c.stats.totalStops} stops`));

    return sortedCards;
  }, [
  isDriverOverviewMode,
  effectiveDeliveries.length, // CHANGED: Only depend on length
  effectivePatients.length, // CHANGED: Only depend on length
  allUsers.length, // CHANGED: Only depend on ID
  currentUser?.id, // CHANGED: Only depend on ID
  selectedOverviewYear,
  availableOverviewYears.length, // CHANGED: Only depend on length
  selectedCityId, // NEW: Dependency for city filter
  yearManuallySelected.current // NEW: Added to trigger re-computation when manual selection state changes
  ]); // REMOVED refreshKey from dependencies

  const canCreateDeliveries = useMemo(() => {
    return userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher');
  }, [currentUser]);

  const handleDriverCardClick = useCallback((driver) => {
    console.log('🎯 [Deliveries] Driver card clicked:', driver.user_name || driver.full_name);

    // Find the most recent delivery date for this driver
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
          targetDate = new Date(y, m - 1, d); // m-1 because Date constructor takes 0-indexed month
          targetDate.setHours(0, 0, 0, 0);
        } else {
          console.warn('[Deliveries] Invalid date components from latest delivery for driver card click:', latest.delivery_date);
        }
      }
    }

    if (isNaN(targetDate.getTime())) {
      console.error('[Deliveries] Invalid target date after calculating for driver card click.');
      targetDate = new Date();
      targetDate.setHours(0, 0, 0, 0);
    }

    const targetYear = targetDate.getFullYear();
    const targetMonth = targetDate.getMonth(); // 0-indexed: 0=Jan, 9=Oct

    console.log('🎯 [Deliveries] Switching to driver view:', {
      driverId: driver.id,
      date: format(targetDate, 'yyyy-MM-dd'),
      year: targetYear,
      month: targetMonth + 1 // Store as 1-indexed in URL for clarity
    });

    // Build the new URL with all parameters
    const params = new URLSearchParams();
    params.set('driver', driver.id);
    params.set('date', format(targetDate, 'yyyy-MM-dd'));
    params.set('year', targetYear.toString());
    params.set('month', (targetMonth + 1).toString()); // Store 1-indexed in URL (1=Jan, 10=Oct)

    // Navigate once with all parameters
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

    return (
      <DragDropContext onDragEnd={handleDragEnd}>
        <Droppable droppableId="deliveries">
          {(provided) =>
          <div
            {...provided.droppableProps}
            ref={provided.innerRef}
            className="contents">

              {deliveriesToRender.map((delivery, index) =>
            <Draggable
              key={delivery.id}
              draggableId={delivery.id}
              index={index}
              isDragDisabled={!canCreateDeliveries}>

                  {(provided, snapshot) =>
              <div
                ref={provided.innerRef}
                {...provided.draggableProps}
                style={{
                  ...provided.draggableProps.style,
                  opacity: snapshot.isDragging ? 0.8 : 1
                }}>

                      <StopCard
                  delivery={delivery}
                  patient={(effectivePatients || []).find((p) => p && p.id === delivery.patient_id)} // Use effectivePatients
                  store={(stores || []).find((s) => s && s.id === delivery.store_id)} // Use raw stores
                  driver={
                  (effectiveDrivers || []).find((d) => d.id === delivery.driver_id || d.appUserId === delivery.driver_id) ||
                  (effectiveDrivers || []).find((d) => d.full_name === delivery.driver_name) ||
                  (effectiveDrivers || []).find((d) => d.user_name === delivery.driver_name)
                  } // CHANGED: prefer ID, fallback to names
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
                  allDeliveries={effectiveDeliveries || []} // Use effectiveDeliveries
                  selectedDate={selectedDate}
                  onEditPatient={handleEditPatient}
                  onCODUpdate={handleCODUpdate}
                  onStartDelivery={handleStatusUpdate}
                  onCreateReturn={async ({ originalDelivery, returnPatient, store }) => {
                    try {
                      const currentDate = format(new Date(), 'yyyy-MM-dd');
                      await base44.entities.Delivery.create({
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
                  dragHandleProps={canCreateDeliveries ? provided.dragHandleProps : null}
                  showDragHandle={false} />

                    </div>
              }
                </Draggable>
            )}
              {provided.placeholder}
            </div>
          }
        </Droppable>
      </DragDropContext>);

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
  handleDragEnd,
  currentUser,
  canCreateDeliveries,
  selectedDate,
  selectedDeliveryId,
  handleEditPatient,
  filteredAndSortedDeliveries // Add filteredAndSortedDeliveries to dependencies
  ]);

  // Small logo component with fallback sources so the real app logo shows instead of a placeholder
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
    <div className="h-screen flex flex-col bg-slate-50 relative">

      <div className={`${isMobile ? 'block' : 'hidden'} border-b border-slate-200 bg-white px-4 py-3 sticky top-0 z-20`}>
        {isDriverOverviewMode ?
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900">Driver Overview</h1>
          </div> :

        <div className="flex justify-between items-center">
            <h1 className="text-xl font-bold text-slate-900">Route Management</h1>
            <Button variant="ghost" size="icon" onClick={() => setIsMobileMenuOpen((v) => !v)}>
              <CalendarIcon className="w-5 h-5" />
            </Button>
          </div>
        }
      </div>

      <div className="hidden lg:block border-b border-slate-200 bg-white px-6 py-4 sticky top-0 z-20">
        {isDriverOverviewMode ?
        <h1 className="text-3xl font-bold text-slate-900">Driver Overview</h1> :

        <>
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
              <div>
                <h1 className="text-3xl font-bold text-slate-900 flex items-baseline gap-3">
                  Route Management
                  <Badge variant="outline" className="ml-2 text-sm font-normal">
                    {selectedDate ? format(selectedDate, 'MMM d, yyyy') : 'Select a Date'}
                  </Badge>
                </h1>
                <p className="text-slate-600 mt-1">
                  Manage deliveries and routes for {selectedDate ? format(selectedDate, 'EEEE, MMMM d, yyyy') : 'the selected date'}
                </p>
              </div>
              <div className="flex gap-3 flex-wrap items-center">
                {canAccessImports(currentUser) &&
              <Button
                onClick={() => setShowImportModal(true)}
                variant="outline"
                className="gap-2">
                    <FileUp className="w-4 h-4" />
                    Import Routes
                  </Button>
              }
                {canCreateDeliveries &&
              <Button
                onClick={() => {
                  setEditingDelivery(null);
                  setShowDeliveryForm(true);
                }}
                className="bg-emerald-600 hover:bg-emerald-700 gap-2">
                    <Plus className="w-4 h-4" />
                    Add Delivery
                  </Button>
              }
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
                <SelectTrigger className="w-48 bg-white border-slate-300">
                  <SelectValue placeholder="Select driver" />
                </SelectTrigger>
                <SelectContent>
                  {sortUsers(effectiveDrivers || []).map((driver) =>
                <SelectItem key={driver.id} value={driver.id}>
                      {getDriverDisplayName(driver)}
                    </SelectItem>
                )}
                </SelectContent>
              </Select>

              <Select value={statusFilter} onValueChange={handleStatusChange}>
                <SelectTrigger className="w-36 bg-white border-slate-300">
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

      <div className="flex-1 flex overflow-hidden">

        {!isDriverOverviewMode &&
        <div className="hidden lg:flex w-72 bg-white border-r border-slate-200 flex-col h-full">
            <div className="p-2 border-b border-slate-100 flex items-center gap-2">
              <CalendarIcon className="w-5 h-5" />
              <h2 className="text-lg font-semibold text-slate-800">Route Dates</h2>
            </div>
            <div className="flex-1 p-1 sm:p-2 overflow-y-auto">
              <DateListPanel
              deliveries={driverFilteredDeliveries}
              selectedDate={selectedDate ? format(selectedDate, 'yyyy-MM-dd') : null}
              onDateSelect={handleDateSelect}
              selectedMonth={selectedMonth}
              onMonthChange={handleMonthChange}
              selectedYear={selectedYear}
              onYearChange={handleYearChange}
              patients={effectivePatients}
              selectedDriverId={driverFilter}
              onDeleteRoute={async (dateStr, driverId) => {
                try {
                  const deliveriesToDelete = driverFilteredDeliveries.filter(
                    (d) => d.delivery_date === dateStr && d.driver_id === driverId
                  );
                  console.log(`🗑️ Deleting ${deliveriesToDelete.length} deliveries for ${dateStr}, driver ${driverId}`);

                  for (const delivery of deliveriesToDelete) {
                    await base44.entities.Delivery.delete(delivery.id);
                  }

                  // Clear all delivery caches
                  invalidate('Delivery');

                  // Update local state immediately
                  setAllDeliveries((prev) => prev.filter((d) =>
                  !(d.delivery_date === dateStr && d.driver_id === driverId)
                  ));

                  // CRITICAL: Update context to sync with Dashboard
                  if (updateDeliveriesLocally) {
                    const remainingDeliveries = allDeliveries.filter((d) =>
                    !(d.delivery_date === dateStr && d.driver_id === driverId)
                    );
                    updateDeliveriesLocally(remainingDeliveries);
                  }

                  console.log(`✅ Route deleted successfully`);
                } catch (error) {
                  console.error('Error deleting route:', error);
                  alert('Failed to delete route. Please try again.');
                }
              }} />
            </div>
          </div>
        }

        {/* Floating mobile sidebar toggle button */}
        {!isDriverOverviewMode && !activeDriver && isMobile &&
        <button
          onClick={() => setIsMobileMenuOpen((v) => !v)}
          className="absolute -left-3 top-24 z-30 bg-white hover:bg-slate-100 text-slate-700 font-semibold py-2 px-1 rounded-r-lg shadow-lg border-y border-r border-slate-200 transition-transform hover:scale-105 flex flex-col items-center gap-2">

            <LogoImage className="w-6 h-6 object-contain" />
            <ChevronRight className="w-5 h-5" />
          </button>
        }

        {/* Background overlay to close drawer when tapping outside */}
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
            className="fixed top-0 left-0 h-full w-64 bg-white shadow-xl z-50 flex flex-col"
            onClick={(e) => e.stopPropagation()}>

              <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CalendarIcon className="w-5 h-5" />
                  <h2 className="text-lg font-semibold text-slate-800">Route Dates</h2>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setIsMobileMenuOpen(false)}>
                  <XIcon className="w-5 h-5" />
                </Button>
              </div>
              <div className="flex-1 p-2 sm:p-4 overflow-y-auto">
                <DateListPanel
                deliveries={driverFilteredDeliveries}
                selectedDate={selectedDate ? format(selectedDate, 'yyyy-MM-dd') : null}
                onDateSelect={(dateStr) => {
                  handleDateSelect(dateStr);
                  setIsMobileMenuOpen(false);
                }}
                selectedMonth={selectedMonth}
                onMonthChange={handleMonthChange}
                selectedYear={selectedYear}
                onYearChange={handleYearChange}
                patients={effectivePatients}
                selectedDriverId={driverFilter}
                onDeleteRoute={async (dateStr, driverId) => {
                  try {
                    const deliveriesToDelete = driverFilteredDeliveries.filter(
                      (d) => d.delivery_date === dateStr && d.driver_id === driverId
                    );
                    console.log(`🗑️ Deleting ${deliveriesToDelete.length} deliveries for ${dateStr}, driver ${driverId}`);

                    for (const delivery of deliveriesToDelete) {
                      await base44.entities.Delivery.delete(delivery.id);
                    }

                    // Clear all delivery caches
                    invalidate('Delivery');

                    // Update local state immediately
                    setAllDeliveries((prev) => prev.filter((d) =>
                    !(d.delivery_date === dateStr && d.driver_id === driverId)
                    ));

                    // CRITICAL: Update context to sync with Dashboard
                    if (updateDeliveriesLocally) {
                      const remainingDeliveries = allDeliveries.filter((d) =>
                      !(d.delivery_date === dateStr && d.driver_id === driverId)
                      );
                      updateDeliveriesLocally(remainingDeliveries);
                    }

                    setIsMobileMenuOpen(false);
                    console.log(`✅ Route deleted successfully`);
                  } catch (error) {
                    console.error('Error deleting route:', error);
                    alert('Failed to delete route. Please try again.');
                  }
                }} />
              </div>
            </motion.div>
          }
        </AnimatePresence>

        <div className="flex-1 p-2 sm:p-4">

          {isDriverOverviewMode ?
          <div className="space-y-6">
              {/* Desktop Controls Banner - Large Screens (lg+) */}
              <Card className="bg-white/80 backdrop-blur-sm hidden lg:block">
                <CardContent className="p-6">
                  <div className="flex items-center gap-3">
                    {/* Search */}
                    <div className="relative flex-grow" style={{ minWidth: '200px', maxWidth: '400px' }}>
                      <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <Input
                      placeholder="Search drivers..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="pl-10 w-full bg-slate-100 border-slate-300" />
                    </div>

                    {/* City Selector - Only visible for Admins */}
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

                    {/* Year Selector */}
                    <Select value={selectedOverviewYear} onValueChange={(year) => {
                    yearManuallySelected.current = true; // Mark as manually selected
                    setSelectedOverviewYear(year);
                    const params = new URLSearchParams(location.search);
                    if (year === 'all') {
                      params.set('overviewYear', 'all'); // Explicitly set 'all' in URL
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

                    {/* Spacer */}
                    <div className="flex-grow"></div>

                    {/* Action Buttons */}
                    {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) &&
                  <Button onClick={() => {setEditingDelivery(null);setShowDeliveryForm(true);}} className="gap-2 w-[140px]">
                        <Plus className="w-4 h-4" /> Add Delivery
                      </Button>
                  }
                    {canAccessImports(currentUser) &&
                  <Button onClick={handleOpenRouteImport} variant="outline" className="gap-2 w-[140px]">
                        <FileUp className="w-4 h-4" /> Import Route
                      </Button>
                  }
                  </div>
                </CardContent>
              </Card>

              {/* Medium Screens Banner (md) */}
              <Card className="bg-white/80 backdrop-blur-sm hidden md:block lg:hidden">
                <CardContent className="p-6">
                  <div className="space-y-3">
                    {/* Row 1: Search */}
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <Input
                      placeholder="Search drivers..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="pl-10 w-full bg-slate-100 border-slate-300" />
                    </div>

                    {/* Row 2: Cities, Years, Spacer, Buttons */}
                    <div className="flex items-center gap-3">
                      {/* City Selector - Only visible for Admins */}
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

                      {/* Year Selector */}
                      <Select value={selectedOverviewYear} onValueChange={(year) => {
                      yearManuallySelected.current = true; // Mark as manually selected
                      setSelectedOverviewYear(year);
                      const params = new URLSearchParams(location.search);
                      if (year === 'all') {
                        params.set('overviewYear', 'all'); // Explicitly set 'all' in URL
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

                      {/* Spacer */}
                      <div className="flex-grow"></div>

                      {/* Action Buttons */}
                      {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) &&
                    <Button onClick={() => {setEditingDelivery(null);setShowDeliveryForm(true);}} className="gap-2 w-[140px]">
                          <Plus className="w-4 h-4" /> Add Delivery
                        </Button>
                    }
                      {canAccessImports(currentUser) &&
                    <Button onClick={handleOpenRouteImport} variant="outline" className="gap-2 w-[140px]">
                          <FileUp className="w-4 h-4" /> Import Route
                        </Button>
                    }
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Mobile Banner (sm and below) */}
              <Card className="bg-white/80 backdrop-blur-sm md:hidden">
                <CardContent className="p-4">
                  <div className="space-y-3">
                    {/* Row 1: Search */}
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <Input
                      placeholder="Search drivers..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="pl-10 w-full bg-slate-100 border-slate-300" />
                    </div>

                    {/* Row 2: Cities, Spacer, Add Delivery */}
                    <div className="flex items-center gap-3">
                      {/* City Selector - Only visible for Admins */}
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

                      {/* Spacer */}
                      <div className="flex-grow"></div>

                      {/* Add Delivery Button */}
                      {(userHasRole(currentUser, 'admin') || userHasRole(currentUser, 'dispatcher')) &&
                    <Button onClick={() => {setEditingDelivery(null);setShowDeliveryForm(true);}} className="gap-2 w-[140px]">
                          <Plus className="w-4 h-4" /> Add Delivery
                        </Button>
                    }
                    </div>

                    {/* Row 3: Years, Spacer, Import */}
                    <div className="flex items-center gap-3">
                      {/* Year Selector */}
                      <Select value={selectedOverviewYear} onValueChange={(year) => {
                      yearManuallySelected.current = true; // Mark as manually selected
                      setSelectedOverviewYear(year);
                      const params = new URLSearchParams(location.search);
                      if (year === 'all') {
                        params.set('overviewYear', 'all'); // Explicitly set 'all' in URL
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

                      {/* Spacer */}
                      <div className="flex-grow"></div>

                      {/* Import Button */}
                      {canAccessImports(currentUser) &&
                    <Button onClick={handleOpenRouteImport} variant="outline" className="gap-2 w-[140px]">
                          <FileUp className="w-4 h-4" /> Import Route
                        </Button>
                    }
                    </div>
                  </div>
                </CardContent>
              </Card>

              {driverCards.length === 0 ?
            <div className="text-center py-12 text-slate-500">
                  <Package className="w-16 h-16 mx-auto mb-4 opacity-30" />
                  <p className="text-lg font-medium">No drivers with deliveries for this period</p>
                  <p className="text-sm mt-2">Select a different year or add deliveries</p>
                </div> :

            <div key={refreshKey} className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, 256px)' }}>
                  {driverCards.map((card) => {
                const isInactive = card.driver.status === 'inactive';
                return (
                  <Card
                    key={card.driver.id}
                    className={`cursor-pointer transition-shadow bg-white/80 backdrop-blur-sm ${isInactive ? 'opacity-60 grayscale hover:shadow-md' : 'hover:shadow-lg'}`}
                    onClick={() => handleDriverCardClick(card.driver)}>

                        <CardHeader>
                          <CardTitle className="text-base flex items-center justify-between">
                            <span className="text-lg font-bold">
                              {card.firstName}
                            </span>
                            <Badge 
                              variant="outline" 
                              className={`text-xs font-semibold rounded-full w-[80px] inline-flex items-center justify-center border transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${
                                card.driver.driver_status === 'on_duty' 
                                  ? 'bg-emerald-500 text-white border-emerald-500' 
                                  : card.driver.driver_status === 'on_break'
                                    ? 'bg-orange-400 text-black border-orange-400'
                                    : 'text-foreground'
                              }`}
                            >
                              {card.stats.totalStops} stops
                            </Badge>
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="px-6 py-3">
                          <div className="space-y-1 text-sm">
                            <div className="flex justify-between items-center">
                              <span className="text-slate-600">Pickups:</span>
                              <span className="bg-blue-100 text-blue-800 px-3 py-1 text-xs rounded-full font-medium w-[60px] text-center">{card.stats.pickups}</span>
                            </div>
                            <div className="flex justify-between items-center">
                              <span className="text-slate-600">Completed:</span>
                              <span className="bg-emerald-100 text-emerald-800 px-3 py-1 text-xs rounded-full font-medium w-[60px] text-center">{card.stats.completed}</span>
                            </div>
                            {(card.stats.failed > 0 || card.stats.returned > 0) &&
                        <div className="flex justify-between items-center">
                                <span className="text-slate-600">Failed/Returned:</span>
                                <span className="bg-red-100 text-red-800 px-3 py-1 text-xs rounded-full font-medium w-[60px] text-center">
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
            </div> :

          <>
              {activeDriver &&
            <Card className="mb-6 border-slate-200 shadow-sm relative">
                  {/* Align the mobile toggle tab with the driver card (vertically centered) */}
                  <button
                onClick={() => setIsMobileMenuOpen((v) => !v)}
                className="absolute -left-3 top-1/2 -translate-y-1/2 z-30 bg-white hover:bg-slate-100 text-slate-700 font-semibold py-2 px-1 rounded-r-lg shadow-lg border-y border-r border-slate-200 transition-transform hover:scale-105 flex flex-col items-center gap-2 lg:hidden">

                    <LogoImage className="w-6 h-6 object-contain" />
                    <ChevronRight className="w-5 h-5" />
                  </button>

                  {isDriverOnline &&
              <div className="absolute top-3 left-3 w-3 h-3 bg-emerald-500 rounded-full ring-2 ring-white"></div>
              }
                  <CardContent className="p-3">
                    <div className="flex items-start gap-4 w-full">
                      <div className="flex-shrink-0 w-16 h-16 bg-gradient-to-br from-slate-100 to-slate-200 rounded-full flex items-center justify-center">
                        <span className="text-3xl font-bold text-slate-600">
                          {getDriverDisplayName(activeDriver).charAt(0)}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                          <div className="flex-none">
                            <h2 className="text-2xl font-bold text-slate-900">{getDriverDisplayName(activeDriver)}</h2>
                            <p className="text-slate-600 font-medium">{formatPhoneNumber(activeDriver.phone)}</p>
                            <div className="flex items-center gap-2">
                              <p className="text-sm text-slate-500 capitalize">{activeDriver.app_roles?.[0]}</p>
                              <span className="text-slate-400">•</span>
                              <p className="text-sm font-medium text-slate-700">{selectedDate ? format(selectedDate, 'MMM d, yyyy') : ''}</p>
                            </div>
                          </div>
                          {driverOverviewStats &&
                      <div className="flex gap-3 flex-shrink-0">
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
                      </div>
                    </div>
                  </CardContent>
                </Card>
            }

              <AnimatePresence mode="wait">
                {/* Actual deliveries list */}
                <div className="pyoverflow-y-auto py-2 gap-x-6 gap-y-2 grid overflow-y-auto auto-rows-max" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(325px, 325px))', maxHeight: 'calc(100vh - 280px)' }}>
                  {renderDeliveries(filteredAndSortedDeliveries)}
                </div>
              </AnimatePresence>

              {/* Render projections when there are no actual deliveries for this driver */}
              {activeDriver && activeDriverDeliveries.length === 0 && projectedRoutes.pickups.length > 0 &&
            <div className="mt-4">
                  <h3 className="text-sm font-semibold text-slate-700 mb-2">Projected Route</h3>
                  <div className="flex gap-4 overflow-x-auto custom-scrollbar">
                    {projectedRoutes.pickups.map((p) =>
                <ProjectedPickupCard
                  key={p.id}
                  pickup={p}
                  stopOrder={projectedRoutes.stopOrderMap[p.id]}
                  stopOrderMap={projectedRoutes.stopOrderMap} />

                )}
                  </div>
                </div>
            }
            </>
          }
        </div>

      </div>

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
            patients={effectivePatients || []} // Use effectivePatients
            stores={stores || []} // Use raw stores
            drivers={effectiveDrivers || []} // Use effectiveDrivers
            onSave={handleSaveDelivery}
            onCancel={() => {setShowDeliveryForm(false);setEditingDelivery(null);}}
            suggestedDate={selectedDate ? format(selectedDate, 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd')}
            currentUser={currentUser}
            allDeliveries={effectiveDeliveries || []}
            initialDriverId={
            editingDelivery ?
            (effectiveDrivers || []).find((d) => d.id === editingDelivery.driver_id || d.appUserId === editingDelivery.driver_id || d.full_name === editingDelivery.driver_name || d.user_name === editingDelivery.driver_name)?.id // Use effectiveDrivers
            : driverFilter === 'all' ? null : driverFilter
            }
            closeOnSave={true} />

          </motion.div>
        }
        {showImportModal &&
        <RouteImport
          onImportComplete={handleImportComplete}
          onCancel={() => setShowImportModal(false)}
          patients={allPatients || []} // Use raw allPatients for import context
          stores={stores || []} // Use raw stores for import context
          drivers={(allUsers || []).filter((u) => userHasRole(u, 'driver')) || []} // All active drivers from allUsers
          allUsers={allUsers} // All merged users
          currentUser={currentUser} />

        }
        <RouteMapView
          isOpen={showRouteMap}
          onClose={() => setShowRouteMap(false)}
          deliveries={filteredAndSortedDeliveries}
          patients={effectivePatients || []} // Use effectivePatients
          stores={stores || []} // Use raw stores
          drivers={effectiveDrivers || []} // Use effectiveDrivers
          selectedDate={selectedDate}
          currentUser={currentUser} />

      </AnimatePresence>
    </div>);

}