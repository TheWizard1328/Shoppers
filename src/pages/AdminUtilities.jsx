import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';
// import { ActiveDeliveries } from '@/entities/ActiveDeliveries'; // This entity doesn't exist
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { RefreshCw, Users, Loader2, AlertCircle, ArrowUpDown, Edit, Trash2, Database, Settings } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { getEffectiveUser } from '@/components/utils/auth';
import { isAppOwner, userHasRole } from '../components/utils/userRoles';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getDriverDisplayName } from '../components/utils/driverUtils';
import AdminPatientsTab from '../components/admin/AdminPatientsTab';
import { sortUsers } from '../components/utils/sorting';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format, parse, parseISO } from 'date-fns';
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { useAppData } from '../components/utils/AppDataContext';
import { findFuzzyMatch, normalizeText } from '../components/utils/fuzzyMatching';
import { smartRefreshManager } from '../components/utils/smartRefreshManager';
import AppSettingsPanel from '../components/admin/AppSettingsPanel';
import AdminUtilitiesExtraTabs from '../components/admin/AdminUtilitiesExtraTabs';
import { loadUserSettings, saveSetting } from '../components/utils/userSettingsManager';
import DeliveryForm from '../components/deliveries/DeliveryForm';import PatientForm from '../components/patients/PatientForm';
import MessageRulesManager from '../components/admin/MessageRulesManager';
import PolylineViewer from '../components/admin/PolylineViewer';
import GoogleAPILogViewer from '../components/admin/GoogleAPILogViewer';
import SmartRefreshIndicator from '../components/layout/SmartRefreshIndicator';
import StoreMetricsPanel from '../components/admin/StoreMetricsPanel';
import PatientAnalysisReview from '../components/admin/PatientAnalysisReview';import IntegrationCreditsTab from '../components/admin/IntegrationCreditsTab';import SimpleDataViewTab from '../components/admin/SimpleDataViewTab';
import DeliveryRouteDataCell from '../components/admin/DeliveryRouteDataCell';
import { ResizableColumnHeader, ColumnVisibilityControl } from '../components/admin/AdminTableControls';
import AdminDeliveriesTable from '../components/admin/AdminDeliveriesTable';
import { matchesDeliveryCodFilter } from '../components/admin/deliveryCodFilter';
import UserSettingsTable from '../components/admin/UserSettingsTable';
import InkbirdRawDiagnostic from '../components/admin/InkbirdRawDiagnostic';
import InkbirdBleLog from '../components/devices/InkbirdBleLog';

// Wrapper to reload data when Routes tab is opened or a breadcrumb save completes
const PolylineViewerWrapper = ({ users, activeUtilityTab }) => {
  // PolylineViewer manages its own real-time state updates via WS listeners.
  // Do NOT use a reloadKey here — resetting the key causes a full remount on every save.
  return <PolylineViewer users={users} />;
};

const ConfirmationDialog = ({ open, onOpenChange, title, description, onConfirm, confirmText = "Delete", variant = "destructive" }) => (
  <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle className="flex items-center gap-2"><AlertCircle className="w-5 h-5 text-red-600" />{title}</DialogTitle><DialogDescription className="text-base pt-2">{description}</DialogDescription></DialogHeader><DialogFooter className="gap-2 sm:gap-0"><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant={variant} onClick={() => { onConfirm(); onOpenChange(false); }}>{confirmText}</Button></DialogFooter></DialogContent></Dialog>
);

// RouteImport (250 lines) kept inline below for AM/PM import
const RouteImport = ({ onImportComplete, onCancel, stores, drivers, allUsers, currentUser, allDeliveries }) => {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [csvFile, setCSVFile] = useState(null);

  const handleFileUpload = (event) => {
    const file = event.target.files?.[0];
    if (file) {
      setCSVFile(file);
      setStatus(`File selected: ${file.name}`);
    }
  };

  const handleImport = async () => {
    if (!csvFile) {
      alert('Please select a CSV file first');
      return;
    }

    setLoading(true);
    setStatus('Reading CSV file...');

    try {
      const text = await csvFile.text();
      const lines = text.split('\n').filter((line) => line.trim());

      if (lines.length < 2) {
        throw new Error("CSV file is empty or only contains a header.");
      }

      setStatus(`Processing ${lines.length - 1} rows...`);

      const { offlineDB } = await import('../components/utils/offlineDatabase');
      const allPatients = await base44.entities.Patient.list();

      // CRITICAL: Extract unique delivery dates from CSV for purge/resync
      const uniqueDeliveryDates = new Set();
      for (let i = 1; i < lines.length; i++) {
        const row = lines[i].split(',').map((cell) => cell.trim());
        const deliveryDateStr = row[6]; // Assuming delivery_date is in column 7 (index 6)
        if (deliveryDateStr) {
          const parsedDate = parseFlexibleDate(deliveryDateStr);
          if (parsedDate) {
            uniqueDeliveryDates.add(format(parsedDate, 'yyyy-MM-dd'));
          }
        }
      }

      console.log(`🔍 [RouteImport] Unique delivery dates in CSV:`, Array.from(uniqueDeliveryDates));

      // CRITICAL: Daily Purge and Resync for ALL imported dates (not just mismatches)
      for (const dateStr of Array.from(uniqueDeliveryDates)) {
        setStatus(`Purging and resyncing ${dateStr}...`);

        // CRITICAL: Always purge and resync to ensure consistency, regardless of count match
        // This prevents stale/duplicate data from the importer from accumulating
        const deleteResult = await offlineDB.deleteDeliveriesByDate(dateStr);
        console.log(`[RouteImport] Delete result for ${dateStr}:`, deleteResult);

        // Fetch fresh data from online DB
        const onlineDeliveriesForDate = await base44.entities.Delivery.filter({ delivery_date: dateStr });
        console.log(`[RouteImport] Fetched ${onlineDeliveriesForDate.length} deliveries from online for ${dateStr}`);

        // Resync to offline DB
        const saveResult = await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, onlineDeliveriesForDate);
        console.log(`[RouteImport] Save result for ${dateStr}:`, saveResult);

        // Verify the resync worked
        const verifyOfflineCount = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, dateStr);
        console.log(`✅ [RouteImport] Verified ${verifyOfflineCount.length} deliveries in offline DB for ${dateStr}`);
      }

      let exactMatched = 0;
      let fuzzyMatched = 0;
      let skipped = 0;
      let errors = 0;

      for (let i = 1; i < lines.length; i++) {// i=1 skips header automatically, don't count it
        const row = lines[i].split(',').map((cell) => cell.trim());

        if (row.length < 2) {
          console.warn(`Skipping row ${i} due to insufficient columns:`, lines[i]);
          errors++;
          continue;
        }

        const ampmIndicator = row[1];
        const ampm = ampmIndicator === '1' ? 'AM' : ampmIndicator === '2' ? 'PM' : null;

        if (!ampm) {
          console.warn(`Skipping row ${i} due to invalid AM/PM indicator:`, ampmIndicator);
          skipped++;
          continue;
        }

        try {
          const identifier = row[0];

          if (!identifier) {
            console.warn(`Skipping row ${i} due to missing identifier`);
            skipped++;
            continue;
          }

          // STEP 1: Try EXACT MATCH (use refreshed data from offline DB after purge/resync)
          const currentOfflineDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
          const exactMatch = (currentOfflineDeliveries || []).find((d) =>
          d.stop_id && normalizeText(d.stop_id) === normalizeText(identifier) ||
          d.tracking_number && normalizeText(d.tracking_number) === normalizeText(identifier)
          );

          if (exactMatch) {
            const { updateDeliveryLocal } = await import('../components/utils/offlineMutations');
            await updateDeliveryLocal(exactMatch.id, { ampm_deliveries: ampm });
            exactMatched++;
            console.log(`✅ EXACT MATCH: Updated delivery ${identifier} with AM/PM: ${ampm}`);
            continue;
          }

          // STEP 2: Try FUZZY MATCHING
          const importedData = {
            stop_id: identifier,
            tracking_number: row[2] || null,
            patient_name: row[3] || null,
            address: row[4] || null,
            phone: row[5] || null,
            delivery_date: row[6] || null,
            actual_delivery_time: row[7] || null,
            store_id: row[8] || null,
            prescription_number: row[9] || null,
            driver_name: row[10] || null
          };

          let candidateDeliveries = currentOfflineDeliveries || [];
          if (importedData.delivery_date) {
            const parsedImportDate = parseFlexibleDate(importedData.delivery_date);
            if (parsedImportDate) {
              const formattedImportDate = format(parsedImportDate, 'yyyy-MM-dd');
              candidateDeliveries = candidateDeliveries.filter((d) =>
              d.delivery_date && d.delivery_date === formattedImportDate
              );
            }
          }

          if (candidateDeliveries.length > 0 && (importedData.patient_name || importedData.address || importedData.phone)) {
            const fuzzyResult = findFuzzyMatch(importedData, candidateDeliveries, allPatients);

            if (fuzzyResult) {
              console.log(`🔍 FUZZY MATCH: Row ${i} - Score: ${fuzzyResult.score}, Tier: ${fuzzyResult.tier}`);
              console.log(`   Details: ${fuzzyResult.details.join(', ')}`);
            }

            if (fuzzyResult && (fuzzyResult.tier === 'strong' || fuzzyResult.tier === 'moderate')) {
              const { updateDeliveryLocal } = await import('../components/utils/offlineMutations');
              await updateDeliveryLocal(fuzzyResult.match.id, { ampm_deliveries: ampm });
              fuzzyMatched++;
              console.log(`✅ FUZZY MATCH (${fuzzyResult.tier.toUpperCase()}, score: ${fuzzyResult.score}): Updated delivery ${fuzzyResult.match.id} with AM/PM: ${ampm}`);
              continue;
            }
          }

          // STEP 3: No match found - Skip
          console.warn(`⚠️ NO MATCH: No suitable match for identifier ${identifier}`);
          skipped++;

        } catch (error) {
          console.error(`Error processing row ${i}:`, error);
          errors++;
        }
      }

      // Final deduplication after all imports are processed
      setStatus(`Running final deduplication...`);
      const deduplicateResult = await offlineDB.deduplicateDeliveries();
      if (deduplicateResult.success) {
        console.log(`✅ [RouteImport] Deduplication complete. Removed ${deduplicateResult.removed} duplicates.`);
        setStatus(`✅ Import complete! Exact: ${exactMatched}, Fuzzy: ${fuzzyMatched}, Skipped: ${skipped}, Errors: ${errors}. Deduplicated: ${deduplicateResult.removed}.`);
      } else {
        console.error('❌ [RouteImport] Deduplication failed:', deduplicateResult.error);
        setStatus(`✅ Import complete! Exact: ${exactMatched}, Fuzzy: ${fuzzyMatched}, Skipped: ${skipped}, Errors: ${errors}. Deduplication failed.`);
      }

      setLoading(false);

      setTimeout(() => {
        onImportComplete();
      }, 1500);

    } catch (error) {
      console.error('Import error:', error);
      setStatus(`❌ Import failed: ${error.message}`);
      setLoading(false);
    }
  };

  const parseFlexibleDate = (dateString) => {
    if (!dateString || typeof dateString !== 'string') return null;

    let date = parseISO(dateString);
    if (!isNaN(date.getTime())) return date;

    date = parse(dateString, 'M/d/yyyy', new Date());
    if (!isNaN(date.getTime())) return date;

    date = parse(dateString, 'MM/dd/yyyy', new Date());
    if (!isNaN(date.getTime())) return date;

    return null;
  };

  return (<Dialog open={true} onOpenChange={onCancel}><DialogContent><DialogHeader><DialogTitle>Import AM/PM Designations</DialogTitle><DialogDescription>Upload a CSV file to update delivery AM/PM designations.</DialogDescription></DialogHeader><div className="space-y-4"><Input type="file" accept=".csv" onChange={handleFileUpload} disabled={loading} /><div className="text-xs text-slate-600 bg-blue-50 border border-blue-200 rounded-lg p-3"><p className="font-semibold mb-1">CSV Format:</p><ul className="list-disc list-inside space-y-1"><li>Column 1: Stop ID (SID) or Tracking Number (TR#)</li><li>Column 2: AM/PM indicator (1 = AM, 2 = PM)</li><li>First row is treated as header and will be skipped</li></ul></div><p className="text-sm text-slate-600">{status || "Select a CSV file to begin import."}</p>{loading && <Loader2 className="h-6 w-6 animate-spin mx-auto text-emerald-500" />}</div><DialogFooter><Button variant="outline" onClick={onCancel} disabled={loading}>Cancel</Button><Button onClick={handleImport} disabled={loading || !csvFile}>{loading ? 'Importing...' : 'Import AM/PM Data'}</Button></DialogFooter></DialogContent></Dialog>);
};

// COLUMN_CONFIGS and useColumnVisibility moved to AdminDataTables.jsx


const getData = async (entityName, sortKey) => {
  let data = [];
  try {
    if (entityName === 'Patient') data = await base44.entities.Patient.list();
    else if (entityName === 'Store') data = await base44.entities.Store.list();
    else if (entityName === 'User') data = await base44.entities.User.list();
    else if (entityName === 'AppUser') data = await base44.entities.AppUser.list();
    else if (entityName === 'Delivery') data = await base44.entities.Delivery.list();
    else if (entityName === 'City') data = await base44.entities.City.list();
  } catch (error) { data = []; }
  if (!Array.isArray(data)) return [];
  if (sortKey && data.length > 0) {
    const isDesc = sortKey.startsWith('-'); const actualKey = isDesc ? sortKey.substring(1) : sortKey;
    data.sort((a, b) => { const av = a[actualKey]; const bv = b[actualKey]; if (typeof av === 'string') return isDesc ? bv.localeCompare(av) : av.localeCompare(bv); if (typeof av === 'number') return isDesc ? bv - av : av - bv; return 0; });
  }
  return data;
};
const parseFlexibleDate = (ds) => { if (!ds) return null; let d = parseISO(ds); if (!isNaN(d.getTime())) return d; d = parse(ds, 'M/d/yyyy', new Date()); if (!isNaN(d.getTime())) return d; d = parse(ds, 'MM/dd/yyyy', new Date()); if (!isNaN(d.getTime())) return d; return null; };

import { PatientDataTable, StoreDataTable, UserDataTable, CityDataTable } from '../components/admin/AdminDataTables';
import CompanyDataTab from '../components/admin/CompanyDataTab';import TempLogTab from '../components/admin/TempLogTab';
const DeliveryDataTable = (props) => <AdminDeliveriesTable {...props} />;

// CityDataTable moved to AdminDataTables.jsx


export default function AdminUtilities() {
  const queryClient = useQueryClient();
  const {
    deliveries: contextDeliveries,
    patients: contextPatients,
    stores: contextStores,
    users: contextUsers,
    appUsers: contextAppUsers,
    cities: contextCities,
    isDataLoaded: contextDataLoaded,
    refreshData
  } = useAppData();

  const [currentUser, setCurrentUser] = useState(null);
  const [hasAccess, setHasAccess] = useState(true);
  const [initialLoading, setInitialLoading] = useState(true);

  const [activeDataTab, setActiveDataTab] = useState('deliveries');
  const [activeUtilityTab, setActiveUtilityTab] = useState('data');
  const [dataViewMode, setDataViewMode] = useState({ deliveries: 'offline' }); // default deliveries to offline DB

  const [isBackfilling, setIsBackfilling] = useState(false);

  const [isRefreshing, setIsRefreshing] = useState(false);

  const [confirmDialog, setConfirmDialog] = useState({
    open: false,
    title: '',
    description: '',
    onConfirm: () => {},
    confirmText: 'Delete',
    variant: 'destructive'
  });

  const [autoSelectDuplicateIds, setAutoSelectDuplicateIds] = useState([]);
  const [duplicateFilterMode, setDuplicateFilterMode] = useState(false);

  const [bulkDelete, setBulkDelete] = useState({
    open: false,
    running: false,
    total: 0,
    processed: 0,
    success: 0,
    failed: 0,
    currentLabel: "",
    currentDelay: 0,
    retryQueue: 0,
    entityLabel: ""
  });

  const [deliveryFilterText, setDeliveryFilterText] = useState('');
  const [deliverySortColumn, setDeliverySortColumn] = useState('delivery_date');
  const [deliverySortDirection, setDeliverySortDirection] = useState('desc');
  const [selectedDeliveryYear, setSelectedDeliveryYear] = useState(() => new Date().getFullYear().toString());
  const [selectedDeliveryMonth, setSelectedDeliveryMonth] = useState(() => (new Date().getMonth() + 1).toString());
  const [selectedDriver, setSelectedDriver] = useState('all');
  const [selectedCodFilter, setSelectedCodFilter] = useState('all');
  const [availableDeliveryYears, setAvailableDeliveryYears] = useState([]);
  const [filtersReady, setFiltersReady] = useState(false);
  const [userSettingsLoaded, setUserSettingsLoaded] = useState(false);

  const [patientFilterText, setPatientFilterText] = useState('');
  const [patientSortColumn, setPatientSortColumn] = useState('full_name');
  const [patientSortDirection, setPatientSortDirection] = useState('asc');

  const [offlineDeliveries, setOfflineDeliveries] = useState([]);
  const [offlinePatients, setOfflinePatients] = useState([]);
  const [offlineStores, setOfflineStores] = useState([]);
  const [offlineAppUsers, setOfflineAppUsers] = useState([]);
  const [offlineCities, setOfflineCities] = useState([]);

  const [showRouteImport, setShowRouteImport] = useState(false);
  const [editingDelivery, setEditingDelivery] = useState(null);
  const [editingPatient, setEditingPatient] = useState(null);
  const [editingStatusId, setEditingStatusId] = useState(null);
  const [editingDriverId, setEditingDriverId] = useState(null);

  const refreshIntervalRef = useRef(null);

  const invalidate = async (entityName) => {
    let queryKey;
    switch (entityName) {
      case 'Patient':queryKey = ['patients'];break;
      case 'Store':queryKey = ['stores'];break;
      case 'User':queryKey = ['authUsers'];break;
      case 'AppUser':queryKey = ['appUsers'];break;
      case 'Delivery':queryKey = ['deliveries'];break;
      case 'ActiveDeliveries':queryKey = ['activeDeliveries'];break;
      case 'City':queryKey = ['cities'];break;
      default:return;
    }
    await queryClient.invalidateQueries({ queryKey });
  };

  const queryOptions = {
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    staleTime: Infinity
  };

  const { data: fetchedPatients, isLoading: patientsLoading, refetch: refetchPatients } = useQuery({
    queryKey: ['patients'],
    queryFn: () => getData('Patient', 'full_name'),
    initialData: contextPatients?.length > 0 ? contextPatients : undefined,
    ...queryOptions
  });
  // Use context patients for real-time updates, or offline data if selected
  const patients = dataViewMode.patients === 'offline' ? offlinePatients : contextPatients?.length > 0 ? contextPatients : fetchedPatients || [];

  const { data: fetchedStores, isLoading: storesLoading, refetch: refetchStores } = useQuery({
    queryKey: ['stores'],
    queryFn: () => getData('Store', 'name'),
    initialData: contextStores?.length > 0 ? contextStores : undefined,
    ...queryOptions
  });
  const stores = dataViewMode.stores === 'offline' ? offlineStores : contextStores?.length > 0 ? contextStores : fetchedStores || [];

  const { data: authUsers, isLoading: authUsersLoading, refetch: refetchAuthUsers } = useQuery({
    queryKey: ['authUsers'],
    queryFn: () => getData('User', 'full_name'),
    initialData: contextUsers?.length > 0 ? contextUsers : undefined,
    ...queryOptions
  });

  const { data: fetchedAppUsers, isLoading: appUsersLoading, refetch: refetchAppUsers } = useQuery({
    queryKey: ['appUsers'],
    queryFn: () => getData('AppUser', 'user_name'),
    initialData: contextAppUsers?.length > 0 ? contextAppUsers : undefined,
    ...queryOptions
  });
  const appUsers = dataViewMode.users === 'offline' ? offlineAppUsers : contextAppUsers?.length > 0 ? contextAppUsers : fetchedAppUsers || [];

  useEffect(() => { /* appUsers loaded */ }, [appUsers?.length]);

  const { data: fetchedCities, isLoading: citiesLoading, refetch: refetchCities } = useQuery({
    queryKey: ['cities'],
    queryFn: () => getData('City', 'name'),
    initialData: contextCities?.length > 0 ? contextCities : undefined,
    ...queryOptions
  });
  const cities = dataViewMode.cities === 'offline' ? offlineCities : contextCities?.length > 0 ? contextCities : fetchedCities || [];

  // CRITICAL: Define mergedUsers and driversForDropdown BEFORE deliveries query to prevent initialization error
  const mergedUsers = useMemo(() => {
    // CRITICAL: Support non-admins who can't fetch User entity
    // If no authUsers (non-admin), create pseudo-users from AppUsers
    if (!appUsers || appUsers.length === 0) return [];

    if (!authUsers || authUsers.length === 0) {
      // Non-admin: Create pseudo-users from AppUsers
      return appUsers.
      map((appUser) => ({
        id: appUser.user_id,
        user_id: appUser.user_id,
        user_name: appUser.user_name,
        full_name: appUser.user_name,
        app_roles: appUser.app_roles || [],
        status: appUser.status || 'active',
        display_name: appUser.user_name,
        first_name: (appUser.user_name || '').split(' ')[0]
      })).
      filter((u) => u.user_name && u.status === 'active');
    }

    // Admin: Merge authUsers with appUsers
    return authUsers.
    map((authUser) => {
      const appUser = appUsers.find((au) => au.user_id === authUser.id);
      if (!appUser) return null;

      return {
        ...authUser,
        ...appUser,
        id: authUser.id,
        user_name: appUser.user_name || authUser.full_name,
        app_roles: appUser.app_roles || ['driver'],
        status: appUser.status || 'active',
        display_name: appUser.user_name || authUser.full_name,
        first_name: (appUser.user_name || authUser.full_name).split(' ')[0]
      };
    }).
    filter(Boolean).
    filter((u) => u.status === 'active');
  }, [authUsers, appUsers]);

  const driversForDropdown = useMemo(() => {
    if (!mergedUsers?.length) return [];
    return sortUsers(mergedUsers.filter((u) => u?.user_name && (u.app_roles || []).some((r) => r === 'driver' || r === 'admin')));
  }, [mergedUsers]);

  // Auto-show deliveries from offline DB on first render
  const [manualLoadTriggered, setManualLoadTriggered] = useState(true);

  const { data: fetchedDeliveries, isLoading: deliveriesLoading, refetch: refetchDeliveries } = useQuery({
    queryKey: ['deliveries', selectedDeliveryYear, selectedDeliveryMonth, selectedDriver],
    queryFn: async () => {
      const filter = {};

      if (selectedDeliveryYear && selectedDeliveryYear !== 'all') {
        const year = parseInt(selectedDeliveryYear);
        const startDate = `${year}-01-01`;
        const endDate = `${year}-12-31`;
        filter.delivery_date = { $gte: startDate, $lte: endDate };

        if (selectedDeliveryMonth !== 'all') {
          const month = parseInt(selectedDeliveryMonth);
          const monthStartDate = `${year}-${month.toString().padStart(2, '0')}-01`;
          const daysInMonth = new Date(year, month, 0).getDate();
          const monthEndDate = `${year}-${month.toString().padStart(2, '0')}-${daysInMonth}`;
          filter.delivery_date = { $gte: monthStartDate, $lte: monthEndDate };
        }
      }

      // Driver filter will be applied client-side after mergedUsers is ready

      const deliveries = Object.keys(filter).length > 0 ?
      await base44.entities.Delivery.filter(filter, '-created_date', 1000) :
      await base44.entities.Delivery.list('-created_date', 1000);

      return deliveries;
    },
    enabled: filtersReady && manualLoadTriggered,
    initialData: undefined,
    ...queryOptions
  });

  // Use ONLY fetched deliveries (not context) for admin view
  const allDeliveries = useMemo(() => {
    return dataViewMode.deliveries === 'offline' ? offlineDeliveries : fetchedDeliveries || [];
  }, [fetchedDeliveries, dataViewMode.deliveries, offlineDeliveries]);

  const dataLoading = patientsLoading || storesLoading || authUsersLoading || appUsersLoading || citiesLoading || deliveriesLoading;

  const handleRefreshAllData = async () => {
    setIsRefreshing(true);
    try {
      const { offlineDB } = await import('../components/utils/offlineDatabase');
      if (dataViewMode.deliveries === 'offline') setOfflineDeliveries(await offlineDB.getAll(offlineDB.STORES.DELIVERIES) || []);
      if (dataViewMode.patients === 'offline') setOfflinePatients(await offlineDB.getAll(offlineDB.STORES.PATIENTS) || []);
      if (dataViewMode.stores === 'offline') setOfflineStores(await offlineDB.getAll(offlineDB.STORES.STORES) || []);
      if (dataViewMode.users === 'offline') setOfflineAppUsers(await offlineDB.getAll(offlineDB.STORES.APP_USERS) || []);
      if (dataViewMode.cities === 'offline') setOfflineCities(await offlineDB.getAll(offlineDB.STORES.CITIES) || []);
      await Promise.all(['patients','stores','authUsers','appUsers','cities','deliveries'].map((k) => queryClient.invalidateQueries([k])));
      await Promise.all([refetchPatients(), refetchStores(), refetchAuthUsers(), refetchAppUsers(), refetchCities(), refetchDeliveries()]);
      await refreshData();
    } catch (error) { alert('Error refreshing data. Please try again.'); }
    finally { setIsRefreshing(false); }
  };


  const handleRouteImportComplete = async () => {
    setShowRouteImport(false);
    try {
      for (const e of ['Delivery','Patient','Store','AppUser','User','City']) await invalidate(e);
      await Promise.all([refetchDeliveries(), refetchPatients(), refetchStores(), refetchAppUsers(), refetchAuthUsers(), refetchCities()]);
      await refreshData();
    } catch (error) { alert('Import completed but there was an error refreshing the display.'); }
    finally { setFiltersReady(true); }
  };

  useEffect(() => {
    const load = async () => {
      try {
        const { offlineDB } = await import('../components/utils/offlineDatabase');
        // Always load deliveries from offline DB on mount/mode change
        setOfflineDeliveries(await offlineDB.getAll(offlineDB.STORES.DELIVERIES) || []);
        if (dataViewMode.patients === 'offline') setOfflinePatients(await offlineDB.getAll(offlineDB.STORES.PATIENTS) || []);
        if (dataViewMode.stores === 'offline') setOfflineStores(await offlineDB.getAll(offlineDB.STORES.STORES) || []);
        if (dataViewMode.users === 'offline') setOfflineAppUsers(await offlineDB.getAll(offlineDB.STORES.APP_USERS) || []);
        if (dataViewMode.cities === 'offline') setOfflineCities(await offlineDB.getAll(offlineDB.STORES.CITIES) || []);
      } catch (_) {}
    };
    load();
  }, [dataViewMode]);

  useEffect(() => {
    const checkAccess = async () => {
      try {
        const user = await getEffectiveUser(); let realUserData = null;
        try { realUserData = await base44.auth.me(); } catch (error) { if (error?.response?.status !== 429 && !String(error?.message || '').includes('429') && !String(error?.message || '').toLowerCase().includes('rate limit')) throw error; }
        setCurrentUser(user);
        setHasAccess(realUserData ? isAppOwner(realUserData) : true);

        if (user?.id) {
          try {
            const settings = await loadUserSettings(user.id);
            if (settings.admin_utilities_year) setSelectedDeliveryYear(settings.admin_utilities_year);
            if (settings.admin_utilities_month) setSelectedDeliveryMonth(settings.admin_utilities_month);
            if (settings.admin_utilities_driver) setSelectedDriver(settings.admin_utilities_driver);
          } catch (_) {}
          setUserSettingsLoaded(true);
        }
      } catch (error) {
        console.error('Access check failed:', error);
        setHasAccess(false);
      } finally {
        setInitialLoading(false);
      }
    };
    checkAccess();

    return () => {
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
      }
    };
  }, []);



  useEffect(() => {
    if (filtersReady) {
      return;
    }

    console.log('📊 [AdminUtilities] Calculating available years from metadata...');

    const currentYear = new Date().getFullYear();
    const estimatedYears = [currentYear, currentYear - 1, currentYear - 2].sort((a, b) => b - a);

    setAvailableDeliveryYears(estimatedYears);
    setFiltersReady(true);

    console.log('✅ [AdminUtilities] Filters ready, deliveries will now load');
  }, [filtersReady]);

  useEffect(() => {
    if (!filtersReady || !allDeliveries || deliveriesLoading) {
      return;
    }

    if (allDeliveries.length > 0) {
      const years = [...new Set(
        allDeliveries.map((d) => d.delivery_date ? new Date(d.delivery_date).getFullYear() : null).
        filter(Boolean)
      )].sort((a, b) => b - a);

      setAvailableDeliveryYears(years);
      console.log('📅 [AdminUtilities] Updated available years from actual data:', years);
    }
  }, [allDeliveries, deliveriesLoading, filtersReady]);

  useEffect(() => {
    if (!filtersReady || dataLoading) { if (refreshIntervalRef.current) { clearInterval(refreshIntervalRef.current); refreshIntervalRef.current = null; } return; }
    const performRefresh = async () => {
      if (editingDelivery || showRouteImport || activeUtilityTab !== 'data') return;
      try {
        if (activeDataTab === 'deliveries' && manualLoadTriggered) await refetchDeliveries();
        else if (activeDataTab === 'patients') await refetchPatients();
        else if (activeDataTab === 'stores') await refetchStores();
        else if (activeDataTab === 'users') await refetchAppUsers();
        else if (activeDataTab === 'cities') await refetchCities();
      } catch (_) {}
    };
    refreshIntervalRef.current = setInterval(performRefresh, 120000);
    return () => { if (refreshIntervalRef.current) { clearInterval(refreshIntervalRef.current); refreshIntervalRef.current = null; } };
  }, [activeDataTab, filtersReady, dataLoading, editingDelivery, showRouteImport, refetchDeliveries, refetchPatients, refetchStores, refetchAppUsers, refetchCities]);



  const handleSortChange = useCallback((column, currentSortColumn, currentSortDirection, setSortColumn, setSortDirection) => {
    if (currentSortColumn === column) {
      setSortDirection(currentSortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  }, []);

  const handleDeliverySort = useCallback((column) =>
  handleSortChange(column, deliverySortColumn, deliverySortDirection, setDeliverySortColumn, setDeliverySortDirection),
  [handleSortChange, deliverySortColumn, deliverySortDirection]
  );

  const handlePatientSort = useCallback((column) => {
    handleSortChange(column, patientSortColumn, patientSortDirection, setPatientSortColumn, setPatientSortDirection);
  }, [handleSortChange, patientSortColumn, patientSortDirection]);

  const filteredAndSortedDeliveries = useMemo(() => {
    let filtered = allDeliveries || [];

    console.log(`📊 [AdminUtilities] filteredAndSortedDeliveries starting with ${filtered.length} deliveries`);
    console.log(`📊 [AdminUtilities] Filters: year=${selectedDeliveryYear}, month=${selectedDeliveryMonth}, driver=${selectedDriver}`);

    if (selectedDeliveryYear && selectedDeliveryYear !== 'all') {
      const year = parseInt(selectedDeliveryYear);
      const beforeFilter = filtered.length;
      filtered = filtered.filter((d) => {
        if (!d.delivery_date || typeof d.delivery_date !== 'string') return false;
        const dateParts = d.delivery_date.split('-');
        if (dateParts.length === 3) {
          const deliveryYear = parseInt(dateParts[0]);
          return deliveryYear === year;
        }
        return false;
      });
      console.log(`📊 [AdminUtilities] Year filter (${year}): ${beforeFilter} → ${filtered.length}`);

      if (selectedDeliveryMonth !== 'all') {
        const month = parseInt(selectedDeliveryMonth);
        const beforeMonthFilter = filtered.length;
        filtered = filtered.filter((d) => {
          if (!d.delivery_date || typeof d.delivery_date !== 'string') return false;
          const dateParts = d.delivery_date.split('-');
          if (dateParts.length === 3) {
            const deliveryMonth = parseInt(dateParts[1]);
            return deliveryMonth === month;
          }
          return false;
        });
        console.log(`📊 [AdminUtilities] Month filter (${month}): ${beforeMonthFilter} → ${filtered.length}`);
      }
    } else if (selectedDeliveryYear === 'all' && selectedDeliveryMonth !== 'all') {
      const month = parseInt(selectedDeliveryMonth);
      const beforeFilter = filtered.length;
      filtered = filtered.filter((d) => {
        if (!d.delivery_date || typeof d.delivery_date !== 'string') return false;
        const dateParts = d.delivery_date.split('-');
        if (dateParts.length === 3) {
          const deliveryMonth = parseInt(dateParts[1]);
          return deliveryMonth === month;
        }
        return false;
      });
      console.log(`📊 [AdminUtilities] Month-only filter (${month}): ${beforeFilter} → ${filtered.length}`);
    }

    if (selectedDriver && selectedDriver !== 'all') {
      const targetDriver = driversForDropdown.find((d) => d.user_name === selectedDriver);
      if (targetDriver) {
        filtered = filtered.filter((delivery) =>
        delivery.driver_id === targetDriver.id ||
        delivery.driver_name === targetDriver.full_name ||
        delivery.driver_name === targetDriver.user_name
        );
      }
    }

    filtered = filtered.filter((delivery) => matchesDeliveryCodFilter(delivery, selectedCodFilter));

    filtered = filtered.filter((delivery) => {
      const patient = (patients || []).find((p) => p.id === delivery.patient_id);
      const store = (stores || []).find((s) => s.id === delivery.store_id);
      const patientName = patient?.full_name || 'Store Pickup';
      const address = patient?.address || store?.address || 'Unknown Address';
      const unitNumber = patient?.unit_number ? `, Unit: ${patient.unit_number}` : '';
      const stopId = delivery.stop_id ? String(delivery.stop_id) : '';
      const patientId = patient?.patient_id ? String(patient.patient_id) : '';
      const trackingNumber = delivery.tracking_number ? String(delivery.tracking_number) : '';
      const stopOrder = delivery.stop_order ? String(delivery.stop_order) : '';

      const searchText = deliveryFilterText.toLowerCase();

      return (
        searchText === '' ||
        patientName.toLowerCase().includes(searchText) ||
        (address + unitNumber).toLowerCase().includes(searchText) ||
        delivery.status && delivery.status.toLowerCase().includes(searchText) ||
        stopId.includes(searchText) ||
        patientId.includes(searchText) ||
        trackingNumber.includes(searchText) ||
        stopOrder.includes(searchText));

    });

    if (deliverySortColumn) {
      filtered.sort((a, b) => {
        const getTimeValue = (delivery) => {
          if (delivery.actual_delivery_time) {
            try {
              const date = new Date(delivery.actual_delivery_time);
              if (!isNaN(date.getTime())) {
                return date.getHours() * 60 + date.getMinutes();
              }
            } catch (e) {


















              // Fallback
            }}if (delivery.delivery_time_eta) {const timeParts = delivery.delivery_time_eta.match(/(\d{2}):(\d{2})/);if (timeParts) {const hours = parseInt(timeParts[1]);const minutes = parseInt(timeParts[2]);return hours * 60 + minutes;}}return 9999;};if (deliverySortColumn === 'stop_order') {const aOrder = a.stop_order ?? 99999;const bOrder = b.stop_order ?? 99999;if (aOrder !== bOrder) {return deliverySortDirection === 'asc' ? aOrder - bOrder : bOrder - aOrder;
          }

          const aDate = a.delivery_date || '';
          const bDate = b.delivery_date || '';

          const dateComparison = deliverySortDirection === 'asc' ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate);
          if (dateComparison !== 0) {
            return dateComparison;
          }

          const aTime = getTimeValue(a);
          const bTime = getTimeValue(b);

          return deliverySortDirection === 'asc' ? aTime - bTime : bTime - aTime;
        } else if (deliverySortColumn === 'delivery_date') {
          const aDate = a.delivery_date || '';
          const bDate = b.delivery_date || '';

          const dateComparison = deliverySortDirection === 'asc' ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate);
          if (dateComparison !== 0) {
            return dateComparison;
          }

          const aTime = getTimeValue(a);
          const bTime = getTimeValue(b);

          return deliverySortDirection === 'asc' ? aTime - bTime : bTime - aTime;
        } else {
          const aValue = a[deliverySortColumn];
          const bValue = b[deliverySortColumn];

          if (aValue === null || aValue === undefined) return deliverySortDirection === 'asc' ? 1 : -1;
          if (bValue === null || bValue === undefined) return deliverySortDirection === 'asc' ? -1 : 1;

          if (typeof aValue === 'string' && typeof bValue === 'string') {
            return deliverySortDirection === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
          }
          if (typeof aValue === 'number' && typeof bValue === 'number') {
            return deliverySortDirection === 'asc' ? aValue - bValue : bValue - aValue;
          }
          return 0;
        }
      });
    }
    return filtered;
  }, [allDeliveries, selectedDeliveryYear, selectedDeliveryMonth, selectedDriver, selectedCodFilter, driversForDropdown, patients, stores, deliveryFilterText, deliverySortColumn, deliverySortDirection]);


  const filteredPatientsForDetectDuplicates = useMemo(() => {
    if (!patients || !Array.isArray(patients)) {
      console.warn('[AdminUtilities] filteredPatientsForDetectDuplicates: patients is not an array');
      return [];
    }

    return patients;
  }, [patients]);

  const performBulkDeletePatients = useCallback(async (patientsToDelete) => {
    if (!patientsToDelete || !Array.isArray(patientsToDelete)) {
      console.error('[AdminUtilities] performBulkDeletePatients: Invalid input - not an array:', typeof patientsToDelete);
      alert('Error: Invalid data provided for deletion. Please refresh and try again.');
      return;
    }

    if (patientsToDelete.length === 0) {
      console.warn('[AdminUtilities] performBulkDeletePatients: Empty array provided');
      alert('No patients to delete.');
      return;
    }

    const isOfflineMode = dataViewMode.patients === 'offline';
    const count = patientsToDelete.length;

    let delayMs = 100;
    let trend = 'up';
    let opsSinceDelayChange = 0;
    let segmentFailures = 0;

    setBulkDelete({
      open: true,
      running: true,
      total: count,
      processed: 0,
      success: 0,
      failed: 0,
      currentLabel: "",
      currentDelay: delayMs,
      retryQueue: 0,
      entityLabel: `Patients (${isOfflineMode ? 'Offline' : 'Online'})`
    });

    const failedDeletions = [];
    try {
      let successCount = 0;
      let failCount = 0;
      let processed = 0;

      for (const patient of patientsToDelete) {
        if (!patient || !patient.id) {
          console.warn('[AdminUtilities] Skipping invalid patient:', patient);
          processed++;
          continue;
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs));

        const label = patient.full_name || patient.id;

        try {
          const { offlineDB } = await import('../components/utils/offlineDatabase');

          if (isOfflineMode) {
            // OFFLINE MODE: Delete ONLY from offline DB
            await offlineDB.deleteRecord(offlineDB.STORES.PATIENTS, patient.id);
            setOfflinePatients((prev) => prev.filter((p) => p.id !== patient.id));
          } else {
            // ONLINE MODE: Delete ONLY from backend
            await base44.entities.Patient.delete(patient.id);
          }

          successCount++;
        } catch (error) {
          // CRITICAL: Ignore 404 errors in online mode (already deleted)
          if (!isOfflineMode && (error?.response?.status === 404 || String(error?.message || '').includes('404') || String(error?.message || '').toLowerCase().includes('not found'))) {
            console.log(`Patient ${patient.id} already deleted (404) - counting as success`);
            successCount++;
          } else {
            console.error(`Failed to delete patient ${patient.id}:`, error);
            failCount++;
            segmentFailures++;
            failedDeletions.push(patient);
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } finally {
          processed++;
          setBulkDelete((prev) => ({
            ...prev,
            processed,
            success: successCount,
            failed: failCount,
            currentLabel: label,
            currentDelay: delayMs,
            retryQueue: failedDeletions.length
          }));

          opsSinceDelayChange++;
          if (opsSinceDelayChange >= 75) {
            if (segmentFailures === 0) {
              if (trend === 'up') {
                delayMs = Math.min(300, delayMs + 25);
                if (delayMs === 300) trend = 'down';
              } else if (trend === 'down') {
                delayMs = Math.max(100, delayMs - 25);
                if (delayMs === 100) trend = 'up';
              }
            }
            opsSinceDelayChange = 0;
            segmentFailures = 0;
            setBulkDelete((prev) => ({ ...prev, currentDelay: delayMs }));
          }
        }
      }

      if (failedDeletions.length > 0) {
        console.log(`Retrying ${failedDeletions.length} failed patient deletions...`);
        const retryDelay = 500;
        setBulkDelete((prev) => ({ ...prev, retryQueue: failedDeletions.length }));

        for (let i = 0; i < failedDeletions.length; i++) {
          const p = failedDeletions[i];
          if (!p || !p.id) continue;

          const label = p.full_name || p.id;

          await new Promise((resolve) => setTimeout(resolve, retryDelay));

          try {
            const { offlineDB } = await import('../components/utils/offlineDatabase');

            if (isOfflineMode) {
              await offlineDB.deleteRecord(offlineDB.STORES.PATIENTS, p.id);
              setOfflinePatients((prev) => prev.filter((pat) => pat.id !== p.id));
            } else {
              await base44.entities.Patient.delete(p.id);
            }

            setBulkDelete((prev) => ({
              ...prev,
              processed: prev.processed + 1,
              success: prev.success + 1,
              failed: prev.failed - 1,
              currentLabel: label,
              currentDelay: retryDelay,
              retryQueue: Math.max(0, prev.retryQueue - 1)
            }));
          } catch (error) {
            // CRITICAL: Ignore 404 errors in online mode (already deleted)
            if (!isOfflineMode && (error?.response?.status === 404 || String(error?.message || '').includes('404') || String(error?.message || '').toLowerCase().includes('not found'))) {
              console.log(`Patient ${p.id} already deleted (404) - counting as success`);
              setBulkDelete((prev) => ({
                ...prev,
                processed: prev.processed + 1,
                success: prev.success + 1,
                failed: prev.failed - 1,
                currentLabel: label,
                currentDelay: retryDelay,
                retryQueue: Math.max(0, prev.retryQueue - 1)
              }));
            } else {
              console.error(`Retry failed for patient ${p.id}:`, error);
              await new Promise((resolve) => setTimeout(resolve, 1000));
              setBulkDelete((prev) => ({
                ...prev,
                processed: prev.processed + 1,
                failed: prev.failed + 1,
                currentLabel: label,
                currentDelay: retryDelay,
                retryQueue: Math.max(0, prev.retryQueue - 1)
              }));
            }
          }
        }
      }

      setBulkDelete((prev) => ({ ...prev, running: false, currentLabel: "", open: false }));

      if (!isOfflineMode) {
        queryClient.invalidateQueries(['patients']);
        await refetchPatients();
        await refreshData();
      }
    } catch (error) {
      console.error('Error during bulk patient delete:', error);
      setBulkDelete((prev) => ({ ...prev, running: false, open: false }));
    }
  }, [dataViewMode.patients, queryClient, refetchPatients, refreshData]);


  // Optimized batch delete for duplicates - deletes in chunks with minimal delays
  const performBulkDeleteDeliveriesBatch = useCallback(async (deliveriesToDelete) => {
    if (!deliveriesToDelete || !Array.isArray(deliveriesToDelete) || deliveriesToDelete.length === 0) {
      alert('No deliveries to delete.');
      return;
    }

    const isOfflineMode = dataViewMode.deliveries === 'offline',count = deliveriesToDelete.length;

    setBulkDelete({
      open: true,
      running: true,
      total: count,
      processed: 0,
      success: 0,
      failed: 0,
      currentLabel: "Processing batch deletes...",
      currentDelay: 0,
      retryQueue: 0,
      entityLabel: "Duplicate Deliveries"
    });

    try {
      console.log(`🗑️ [AdminUtilities] Starting batch delete of ${count} duplicates...`);

      // Delete in batches of 50 (much faster than one-at-a-time)
      const BATCH_SIZE = 25;
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < deliveriesToDelete.length; i += BATCH_SIZE) {
        const batch = deliveriesToDelete.slice(i, i + BATCH_SIZE);

        setBulkDelete((prev) => ({
          ...prev,
          currentLabel: `Batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(count / BATCH_SIZE)}`
        }));

        // Delete all in this batch with minimal delay
        for (const delivery of batch) {
          try {
            if (dataViewMode.deliveries === 'offline' || String(delivery.id || '').startsWith('temp_')) {const { offlineDB } = await import('../components/utils/offlineDatabase');await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, delivery.id);setOfflineDeliveries((prev) => prev.filter((d) => d.id !== delivery.id));} else {await base44.entities.Delivery.delete(delivery.id);}
            successCount++;
          } catch (error) {
            if (error?.response?.status === 404 || String(error?.message || '').includes('404') || String(error?.message || '').toLowerCase().includes('not found')) {try {const { offlineDB } = await import('../components/utils/offlineDatabase');await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, delivery.id);} catch (_) {}successCount++;} else {console.error(`Failed to delete ${delivery.id}:`, error);failCount++;}
          }
          await new Promise((resolve) => setTimeout(resolve, 100)); // Paced to reduce rate limits
        }

        setBulkDelete((prev) => ({
          ...prev,
          processed: Math.min(i + BATCH_SIZE, count),
          success: successCount,
          failed: failCount
        }));

        console.log(`✅ [AdminUtilities] Batch ${Math.floor(i / BATCH_SIZE) + 1} complete: ${successCount} deleted, ${failCount} failed`);
      }

      setBulkDelete((prev) => ({ ...prev, running: false, currentLabel: "", open: false }));

      // Reload offline data if in offline mode
      if (dataViewMode.deliveries === 'offline') {
        const { offlineDB } = await import('../components/utils/offlineDatabase');
        const data = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
        setOfflineDeliveries(data || []);
        console.log(`📦 Reloaded ${data?.length || 0} offline deliveries after delete`);
      }

      queryClient.invalidateQueries(['deliveries']);
      await refetchDeliveries();

      console.log('🔄 [AdminUtilities] Triggering global data refresh after batch delete');
      await refreshData();

      console.log(`✅ [AdminUtilities] Batch delete complete: ${successCount} deleted, ${failCount} failed`);
    } catch (error) {
      console.error('Error during batch delivery delete:', error);
      setBulkDelete((prev) => ({ ...prev, running: false, open: false }));
    }
  }, [queryClient, refetchDeliveries, refreshData]);

  const performBulkDeleteDeliveries = useCallback(async (deliveriesToDelete) => {
    if (!deliveriesToDelete || !Array.isArray(deliveriesToDelete)) {
      console.error('[AdminUtilities] performBulkDeleteDeliveries: Invalid input - not an array:', typeof deliveriesToDelete);
      alert('Error: Invalid data provided for deletion. Please refresh and try again.');
      return;
    }

    if (deliveriesToDelete.length === 0) {
      console.warn('[AdminUtilities] performBulkDeleteDeliveries: Empty array provided');
      alert('No deliveries to delete.');
      return;
    }

    const isOfflineMode = dataViewMode.deliveries === 'offline';
    const count = deliveriesToDelete.length;

    let delayMs = 100;
    let trend = 'up';
    let opsSinceDelayChange = 0;
    let segmentFailures = 0;

    setBulkDelete({
      open: true,
      running: true,
      total: count,
      processed: 0,
      success: 0,
      failed: 0,
      currentLabel: "",
      currentDelay: delayMs,
      retryQueue: 0,
      entityLabel: `Deliveries (${isOfflineMode ? 'Offline' : 'Online'})`
    });

    const failedDeletions = [];
    try {
      let successCount = 0;
      let failCount = 0;
      let processed = 0;

      for (const delivery of deliveriesToDelete) {
        if (!delivery || !delivery.id) {
          console.warn('[AdminUtilities] Skipping invalid delivery:', delivery);
          processed++;
          continue;
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs));

        const label = delivery.tracking_number || delivery.id;

        try {
          const { offlineDB } = await import('../components/utils/offlineDatabase');

          let ok = true;
          if (!isOfflineMode) try { await base44.entities.Delivery.delete(delivery.id); } catch (error) { if (!(error?.response?.status === 404 || String(error?.message || '').includes('404') || String(error?.message || '').toLowerCase().includes('not found'))) { ok = false; console.error(`Failed to delete delivery ${delivery.id} from online DB:`, error); } }
          try { await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, delivery.id); } catch (error) { if (!(String(error?.message || '').toLowerCase().includes('not found') || String(error?.message || '').toLowerCase().includes('no record'))) { ok = false; console.error(`Failed to delete delivery ${delivery.id} from offline DB:`, error); } }
          if (isOfflineMode) setOfflineDeliveries((prev) => prev.filter((d) => d.id !== delivery.id));
          if (ok) successCount++; else { failCount++; segmentFailures++; failedDeletions.push(delivery); await new Promise((resolve) => setTimeout(resolve, 1000)); }
        } catch (error) {
          // CRITICAL: Ignore 404 errors in online mode (already deleted)
          if (!isOfflineMode && (error?.response?.status === 404 || String(error?.message || '').includes('404') || String(error?.message || '').toLowerCase().includes('not found'))) {
            console.log(`Delivery ${delivery.id} already deleted (404) - counting as success`);try {const { offlineDB } = await import('../components/utils/offlineDatabase');await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, delivery.id);} catch (_) {}
            successCount++;
          } else {
            console.error(`Failed to delete delivery ${delivery.id}:`, error);
            failCount++;
            segmentFailures++;
            failedDeletions.push(delivery);
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } finally {
          processed++;
          setBulkDelete((prev) => ({
            ...prev,
            processed,
            success: successCount,
            failed: failCount,
            currentLabel: label,
            currentDelay: delayMs,
            retryQueue: failedDeletions.length
          }));

          opsSinceDelayChange++;
          if (opsSinceDelayChange >= 75) {
            if (segmentFailures === 0) {
              if (trend === 'up') {
                delayMs = Math.min(300, delayMs + 25);
                if (delayMs === 300) trend = 'down';
              } else if (trend === 'down') {
                delayMs = Math.max(100, delayMs - 25);
                if (delayMs === 100) trend = 'up';
              }
            }
            opsSinceDelayChange = 0;
            segmentFailures = 0;
            setBulkDelete((prev) => ({ ...prev, currentDelay: delayMs }));
          }
        }
      }

      if (failedDeletions.length > 0) {
        console.log(`Retrying ${failedDeletions.length} failed delivery deletions...`);
        const retryDelay = 500;
        setBulkDelete((prev) => ({ ...prev, retryQueue: failedDeletions.length }));

        for (let i = 0; i < failedDeletions.length; i++) {
          const d = failedDeletions[i];
          if (!d || !d.id) continue;

          const label = d.tracking_number || d.id;

          await new Promise((resolve) => setTimeout(resolve, retryDelay));

          try {
            const { offlineDB } = await import('../components/utils/offlineDatabase');

            if (isOfflineMode) {
              await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, d.id);
              setOfflineDeliveries((prev) => prev.filter((del) => del.id !== d.id));
            } else {
              await base44.entities.Delivery.delete(d.id);
            }

            setBulkDelete((prev) => ({
              ...prev,
              processed: prev.processed + 1,
              success: prev.success + 1,
              failed: prev.failed - 1,
              currentLabel: label,
              currentDelay: retryDelay,
              retryQueue: Math.max(0, prev.retryQueue - 1)
            }));
          } catch (error) {
            // CRITICAL: Ignore 404 errors in online mode (already deleted)
            if (!isOfflineMode && (error?.response?.status === 404 || String(error?.message || '').includes('404') || String(error?.message || '').toLowerCase().includes('not found'))) {
              console.log(`Delivery ${d.id} already deleted (404) - counting as success`);try {const { offlineDB } = await import('../components/utils/offlineDatabase');await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, d.id);} catch (_) {}
              setBulkDelete((prev) => ({
                ...prev,
                processed: prev.processed + 1,
                success: prev.success + 1,
                failed: prev.failed - 1,
                currentLabel: label,
                currentDelay: retryDelay,
                retryQueue: Math.max(0, prev.retryQueue - 1)
              }));
            } else {
              console.error(`Retry failed for delivery ${d.id}:`, error);
              await new Promise((resolve) => setTimeout(resolve, 1000));
              setBulkDelete((prev) => ({
                ...prev,
                processed: prev.processed + 1,
                failed: prev.failed + 1,
                currentLabel: label,
                currentDelay: retryDelay,
                retryQueue: Math.max(0, prev.retryQueue - 1)
              }));
            }
          }
        }
      }

      setBulkDelete((prev) => ({ ...prev, running: false, currentLabel: "", open: false }));

      // Reload offline data if in offline mode
      if (isOfflineMode) {
        const { offlineDB } = await import('../components/utils/offlineDatabase');
        const data = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
        setOfflineDeliveries(data || []);
        console.log(`📦 Reloaded ${data?.length || 0} offline deliveries after delete`);
      } else {
        queryClient.invalidateQueries(['deliveries']);
        await refetchDeliveries();
        await refreshData();
      }
    } catch (error) {
      console.error('Error during bulk delivery delete:', error);
      setBulkDelete((prev) => ({ ...prev, running: false, open: false }));
    }
  }, [dataViewMode.deliveries, queryClient, refetchDeliveries, refreshData]);

  const _confirmDeleteAllDeliveries = useCallback(() => {
    const count = filteredAndSortedDeliveries.length;
    setConfirmDialog({
      open: true,
      title: `Delete ${count} Deliveries?`,
      description: `⚠️ WARNING: This will permanently delete ${count} deliveries that are currently filtered. This action CANNOT be undone. Are you absolutely sure?`,
      confirmText: 'Yes, Delete All',
      variant: 'destructive',
      onConfirm: () => performBulkDeleteDeliveries(filteredAndSortedDeliveries)
    });
  }, [filteredAndSortedDeliveries, performBulkDeleteDeliveries]);

  const _confirmDeleteSelectedDeliveries = useCallback((deliveriesToDelete) => {
    const count = deliveriesToDelete.length;
    setConfirmDialog({
      open: true,
      title: `Delete ${count} Selected Deliveries?`,
      description: `This will permanently delete ${count} selected deliveries. This action cannot be undone.`,
      confirmText: 'Delete Selected',
      variant: 'destructive',
      onConfirm: () => performBulkDeleteDeliveries(deliveriesToDelete)
    });
  }, [performBulkDeleteDeliveriesBatch]);

  const _confirmDeleteAllPatients = useCallback((patientsToDelete) => {
    const count = patientsToDelete.length;
    setConfirmDialog({
      open: true,
      title: `Delete ${count} Patients?`,
      description: `⚠️ WARNING: This will permanently delete ${count} patients that are currently filtered. This action CANNOT be undone. Are you absolutely sure?`,
      confirmText: 'Yes, Delete All',
      variant: 'destructive',
      onConfirm: () => performBulkDeletePatients(patientsToDelete)
    });
  }, [performBulkDeletePatients]);

  const _confirmDeleteSelectedPatients = useCallback((patientsToDelete) => {
    const count = patientsToDelete.length;
    setConfirmDialog({
      open: true,
      title: `Delete ${count} Selected Patients?`,
      description: `This will permanently delete ${count} selected patients. This action cannot be undone.`,
      confirmText: 'Delete Selected',
      variant: 'destructive',
      onConfirm: () => performBulkDeletePatients(patientsToDelete)
    });
  }, [performBulkDeletePatients]);

  const performBulkDeleteStores = useCallback(async (storesToDelete) => {
    if (!storesToDelete || !Array.isArray(storesToDelete) || storesToDelete.length === 0) {
      alert('No stores to delete.');
      return;
    }

    setBulkDelete({
      open: true, running: true, total: storesToDelete.length, processed: 0, success: 0, failed: 0,
      currentLabel: "", currentDelay: 100, retryQueue: 0, entityLabel: "Stores"
    });

    let successCount = 0,failCount = 0;
    for (const store of storesToDelete) {
      if (!store || !store.id) continue;
      try {
        await base44.entities.Store.delete(store.id);
        successCount++;
      } catch (error) {
        console.error(`Failed to delete store ${store.id}:`, error);
        failCount++;
      }
      setBulkDelete((prev) => ({
        ...prev, processed: prev.processed + 1, success: successCount, failed: failCount, currentLabel: store.name || store.id
      }));
      await new Promise((r) => setTimeout(r, 100));
    }

    setBulkDelete((prev) => ({ ...prev, running: false, open: false }));
    await refetchStores();
    await refreshData();
  }, [refetchStores, refreshData]);

  const _confirmDeleteSelectedStores = useCallback((storesToDelete) => {
    setConfirmDialog({
      open: true,
      title: `Delete ${storesToDelete.length} Selected Stores?`,
      description: `This will permanently delete ${storesToDelete.length} selected stores. This action cannot be undone.`,
      confirmText: 'Delete Selected',
      variant: 'destructive',
      onConfirm: () => performBulkDeleteStores(storesToDelete)
    });
  }, [performBulkDeleteStores]);

  const performBulkDeleteUsers = useCallback(async (usersToDelete) => {
    if (!usersToDelete || !Array.isArray(usersToDelete) || usersToDelete.length === 0) {
      alert('No users to delete.');
      return;
    }

    setBulkDelete({
      open: true, running: true, total: usersToDelete.length, processed: 0, success: 0, failed: 0,
      currentLabel: "", currentDelay: 100, retryQueue: 0, entityLabel: "App Users"
    });

    let successCount = 0,failCount = 0;
    for (const user of usersToDelete) {
      if (!user || !user.id) continue;
      try {
        await base44.entities.AppUser.delete(user.id);
        successCount++;
      } catch (error) {
        console.error(`Failed to delete user ${user.id}:`, error);
        failCount++;
      }
      setBulkDelete((prev) => ({
        ...prev, processed: prev.processed + 1, success: successCount, failed: failCount, currentLabel: user.user_name || user.id
      }));
      await new Promise((r) => setTimeout(r, 100));
    }

    setBulkDelete((prev) => ({ ...prev, running: false, open: false }));
    await refetchAppUsers();
    await refreshData();
  }, [refetchAppUsers, refreshData]);

  const _confirmDeleteSelectedUsers = useCallback((usersToDelete) => {
    setConfirmDialog({
      open: true,
      title: `Delete ${usersToDelete.length} Selected Users?`,
      description: `This will permanently delete ${usersToDelete.length} selected app users. This action cannot be undone.`,
      confirmText: 'Delete Selected',
      variant: 'destructive',
      onConfirm: () => performBulkDeleteUsers(usersToDelete)
    });
  }, [performBulkDeleteUsers]);

  const performBulkDeleteCities = useCallback(async (citiesToDelete) => {
    if (!citiesToDelete || !Array.isArray(citiesToDelete) || citiesToDelete.length === 0) {
      alert('No cities to delete.');
      return;
    }

    setBulkDelete({
      open: true, running: true, total: citiesToDelete.length, processed: 0, success: 0, failed: 0,
      currentLabel: "", currentDelay: 100, retryQueue: 0, entityLabel: "Cities"
    });

    let successCount = 0,failCount = 0;
    for (const city of citiesToDelete) {
      if (!city || !city.id) continue;
      try {
        await base44.entities.City.delete(city.id);
        successCount++;
      } catch (error) {
        console.error(`Failed to delete city ${city.id}:`, error);
        failCount++;
      }
      setBulkDelete((prev) => ({
        ...prev, processed: prev.processed + 1, success: successCount, failed: failCount, currentLabel: city.name || city.id
      }));
      await new Promise((r) => setTimeout(r, 100));
    }

    setBulkDelete((prev) => ({ ...prev, running: false, open: false }));
    await refetchCities();
    await refreshData();
  }, [refetchCities, refreshData]);

  const _confirmDeleteSelectedCities = useCallback((citiesToDelete) => {
    setConfirmDialog({
      open: true,
      title: `Delete ${citiesToDelete.length} Selected Cities?`,
      description: `This will permanently delete ${citiesToDelete.length} selected cities. This action cannot be undone.`,
      confirmText: 'Delete Selected',
      variant: 'destructive',
      onConfirm: () => performBulkDeleteCities(citiesToDelete)
    });
  }, [performBulkDeleteCities]);

  const handleFindDuplicates = useCallback(async (deliveriesToProcess, onAutoSelect) => {
    if (!deliveriesToProcess?.length) { setConfirmDialog({ open: true, title: '⚠️ No Data', description: 'No deliveries to search. Please load data first.', confirmText: 'OK', variant: 'destructive', onConfirm: () => {} }); return; }
    const duplicateGroups = new Map(); let skippedCount = 0; let processedCount = 0;
    deliveriesToProcess.forEach((d) => {
      if (!d) return;
      const sid = d.stop_id?.toString().trim() || ''; const date = d.delivery_date?.trim() || '';
      if (!sid || !date) { skippedCount++; return; }
      processedCount++;
      const key = `${sid}|${date}`; if (!duplicateGroups.has(key)) duplicateGroups.set(key, []); duplicateGroups.get(key).push(d);
    });
    const duplicateIds = []; let duplicateGroupCount = 0;
    duplicateGroups.forEach((group) => { if (group.length > 1) { duplicateGroupCount++; const sorted = [...group].sort((a, b) => new Date(a.created_date || 0) - new Date(b.created_date || 0)); sorted.slice(1).forEach((d) => duplicateIds.push(d.id)); } });
    if (duplicateIds.length === 0) { setConfirmDialog({ open: true, title: '✅ No Duplicates Found', description: `No duplicates found in ${deliveriesToProcess.length} deliveries. Processed: ${processedCount}, Skipped: ${skippedCount}.`, confirmText: 'OK', variant: 'default', onConfirm: () => {} }); return; }
    setDuplicateFilterMode(true); if (onAutoSelect) onAutoSelect(duplicateIds);
    setConfirmDialog({ open: true, title: `✅ Found ${duplicateIds.length} Duplicates`, description: `Found ${duplicateGroupCount} duplicate groups with ${duplicateIds.length} duplicates. Review and click "Delete Selected" to remove them.`, confirmText: 'OK', variant: 'default', onConfirm: () => {} });
  }, [dataViewMode.deliveries]);



  const handleStatusChange = useCallback(async (delivery, newStatus) => {
    try {
      const { updateDeliveryLocal } = await import('../components/utils/offlineMutations');
      await updateDeliveryLocal(delivery.id, { status: newStatus });
      setEditingStatusId(null);
      await refetchDeliveries();
    } catch (error) {
      console.error('Failed to update status:', error);
      alert('Failed to update status: ' + error.message);
    }
  }, [refetchDeliveries]);

  const handleDriverChange = useCallback(async (delivery, newDriverId) => {
    try {
      const { updateDeliveryLocal } = await import('../components/utils/offlineMutations');
      const driver = driversForDropdown.find((d) => d && d.id === newDriverId);
      const driverName = driver ? getDriverDisplayName(driver) : '';

      await updateDeliveryLocal(delivery.id, {
        driver_id: newDriverId,
        driver_name: driverName
      });
      setEditingDriverId(null);
      await refetchDeliveries();
    } catch (error) {
      console.error('Failed to update driver:', error);
      alert('Failed to update driver: ' + error.message);
    }
  }, [driversForDropdown, refetchDeliveries]);

  const handleEditEntity = (entity) => {
    console.log('Edit entity:', entity);

    if (activeDataTab === 'deliveries') { setEditingDelivery(entity); return; }
    if (activeDataTab === 'patients') { setEditingPatient(entity); return; }
    alert('Edit functionality not implemented yet. Please use the dedicated management pages (Patients, Stores, etc.) to edit records.');
  };

  const handleDeleteEntity = useCallback(async (entity) => {
    const entityType = activeDataTab;
    let entityName = '';
    let EntityClass = null;

    switch (entityType) {
      case 'patients':
        entityName = entity.full_name || entity.id;
        EntityClass = { name: 'Patient' };
        break;
      case 'deliveries':
        entityName = `Delivery ${entity.tracking_number || entity.id}`;
        EntityClass = { name: 'Delivery' };
        break;
      case 'stores':
        entityName = entity.name || entity.id;
        EntityClass = { name: 'Store' };
        break;
      case 'users':
        entityName = entity.user_name || entity.id;
        EntityClass = { name: 'AppUser' };
        break;
      case 'cities':
        entityName = entity.name || entity.id;
        EntityClass = { name: 'City' };
        break;
      default:
        alert('Unknown entity type');
        return;
    }

    const isOfflineMode = dataViewMode[entityType] === 'offline';

    setConfirmDialog({
      open: true,
      title: `Delete ${entityName}?`,
      description: `⚠️ Are you sure you want to delete "${entityName}" from ${isOfflineMode ? 'OFFLINE DATABASE ONLY' : 'BACKEND (online)'}? This action cannot be undone.`,
      confirmText: 'Delete',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          console.log(`Deleting ${entityType} (${isOfflineMode ? 'offline' : 'online'}):`, entity.id);
          const { offlineDB } = await import('../components/utils/offlineDatabase');

          if (isOfflineMode) {
            // OFFLINE MODE: Delete ONLY from offline DB
            if (entityType === 'patients') {
              await offlineDB.deleteRecord(offlineDB.STORES.PATIENTS, entity.id);
              setOfflinePatients((prev) => prev.filter((p) => p.id !== entity.id));
            } else if (entityType === 'deliveries') {
              await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, entity.id);
              setOfflineDeliveries((prev) => prev.filter((d) => d.id !== entity.id));
            } else if (entityType === 'stores') {
              await offlineDB.deleteRecord(offlineDB.STORES.STORES, entity.id);
              setOfflineStores((prev) => prev.filter((s) => s.id !== entity.id));
            } else if (entityType === 'users') {
              await offlineDB.deleteRecord(offlineDB.STORES.APP_USERS, entity.id);
              setOfflineAppUsers((prev) => prev.filter((u) => u.id !== entity.id));
            } else if (entityType === 'cities') {
              await offlineDB.deleteRecord(offlineDB.STORES.CITIES, entity.id);
              setOfflineCities((prev) => prev.filter((c) => c.id !== entity.id));
            }
            console.log(`✅ Deleted ${entityName} from offline DB`);
          } else {
            // ONLINE MODE: Delete ONLY from backend
            if (entityType === 'patients') {
              await base44.entities.Patient.delete(entity.id);
            } else if (entityType === 'deliveries') {
              await base44.entities.Delivery.delete(entity.id);try {const { offlineDB } = await import('../components/utils/offlineDatabase');await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, entity.id);} catch (_) {}
            } else if (entityType === 'stores') {
              await base44.entities.Store.delete(entity.id);
            } else if (entityType === 'users') {
              await base44.entities.AppUser.delete(entity.id);
            } else if (entityType === 'cities') {
              await base44.entities.City.delete(entity.id);
            }
            console.log(`✅ Deleted ${entityName} from backend`);

            // Refetch online data
            await invalidate(EntityClass.name);
            switch (entityType) {
              case 'patients':
                await refetchPatients();
                break;
              case 'deliveries':
                await refetchDeliveries();
                break;
              case 'stores':
                await refetchStores();
                break;
              case 'users':
                await refetchAppUsers();
                break;
              case 'cities':
                await refetchCities();
                break;
            }
            await refreshData();
          }

        } catch (error) {
          console.error(`❌ Failed to delete ${entityName}:`, error);

          // CRITICAL: Ignore 404 errors for offline mode (record already gone)
          // if (isOfflineMode || error?.response?.status === 404 || String(error?.message || '').includes('404') || String(error?.message || '').toLowerCase().includes('not found')) {
          //   try {
          //     const { offlineDB } = await import('../components/utils/offlineDatabase');
          //     if (entityType === 'deliveries') {await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, entity.id);}
          //     if (entityType === 'patients') {await offlineDB.deleteRecord(offlineDB.STORES.PATIENTS, entity.id);}} 
          //   catch (_) 
          //     {}alert(`❌ Failed to delete ${entityName}:`, error);
          //   return;
          // }

          alert(`❌ Failed to delete "${entityName}": ${error.message}`);
        }
      }
    });
  }, [activeDataTab, dataViewMode, invalidate, refetchPatients, refetchDeliveries, refetchStores, refetchAppUsers, refetchCities, refreshData]);


  if (initialLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
        <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
        <span className="ml-3 text-lg" style={{ color: 'var(--text-slate-600)' }}>Loading initial data...</span>
      </div>);

  }

  if (!hasAccess) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-slate-50)' }}>
        <Card className="p-8 text-center" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <AlertCircle className="w-12 h-12 mx-auto mb-4 text-red-500" />
          <h2 className="text-xl font-bold mb-2" style={{ color: 'var(--text-slate-900)' }}>Access Denied</h2>
          <p style={{ color: 'var(--text-slate-600)' }}>Only app owners can access this page.</p>
        </Card>
      </div>);

  }

  return (
    <div className="w-full flex flex-col" style={{ background: 'var(--bg-slate-50)', height: '100%', overflow: 'hidden' }}>
      {/* Sticky header — never scrolls */}
      <div className="flex-shrink-0 px-2 md:px-3 pt-2 md:pt-3 pb-2" style={{ background: 'var(--bg-slate-50)' }}>
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2 md:gap-3 flex-1 min-w-0">
            <h1 className="text-xl md:text-3xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Admin Utilities</h1>
            <SmartRefreshIndicator inline={true} onManualRefresh={handleRefreshAllData} />
          </div>
        </div>

        <Tabs value={activeUtilityTab} onValueChange={setActiveUtilityTab} className="w-full">
          <div className="overflow-x-auto overflow-y-hidden scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent">
            <TabsList className="items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground grid min-w-full w-max gap-1 md:gap-0 h-auto md:h-14" style={{ gridTemplateColumns: 'repeat(9,minmax(max-content,1fr))' }}>
              <TabsTrigger value="data" className="px-3 text-xs font-medium text-center rounded-md inline-flex items-center whitespace-nowrap ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow md:text-sm justify-center">Data</TabsTrigger>
              <TabsTrigger value="store-metrics" className="px-3 text-xs font-medium text-center rounded-md inline-flex items-center whitespace-nowrap ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow md:text-sm justify-center">Metrics</TabsTrigger>
              <TabsTrigger value="user-settings" className="px-3 text-xs font-medium text-center rounded-md inline-flex items-center whitespace-nowrap ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow md:text-sm justify-center">Settings</TabsTrigger>
              <TabsTrigger value="app-settings" className="px-3 text-xs font-medium text-center rounded-md inline-flex items-center whitespace-nowrap ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow md:text-sm justify-center">App</TabsTrigger>
              <TabsTrigger value="message-rules" className="px-3 text-xs font-medium text-center rounded-md inline-flex items-center whitespace-nowrap ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow md:text-sm justify-center">Messages</TabsTrigger>
              <TabsTrigger value="polylines" className="px-3 text-xs font-medium text-center rounded-md inline-flex items-center whitespace-nowrap ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow md:text-sm justify-center">Routes</TabsTrigger>
              <TabsTrigger value="api-logs" className="px-3 text-xs font-medium text-center rounded-md inline-flex items-center whitespace-nowrap ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow md:text-sm justify-center">Logs</TabsTrigger>
              <TabsTrigger value="remote-logs" className="px-3 text-xs font-medium text-center rounded-md inline-flex items-center whitespace-nowrap ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow md:text-sm justify-center">Remote Logs</TabsTrigger>
              <TabsTrigger value="sync-management" className="px-3 text-xs font-medium text-center rounded-md inline-flex items-center whitespace-nowrap ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow md:text-sm justify-center">Sync</TabsTrigger>
            </TabsList>
          </div>
        </Tabs>
      </div>

      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto px-2 md:px-3 pb-4">
        <Tabs value={activeUtilityTab} onValueChange={setActiveUtilityTab} className="w-full">

          <TabsContent value="data" className="mt-0">
            {dataLoading && activeDataTab !== 'deliveries' || dataLoading && activeDataTab === 'deliveries' && !allDeliveries?.length ?
            <div className="flex justify-center items-center h-60">
                <Loader2 className="h-10 w-10 animate-spin text-emerald-500" />
                <span className="ml-3 text-lg text-slate-600">Loading data...</span>
              </div> :

            <div className="space-y-6">
                <Tabs value={activeDataTab} onValueChange={setActiveDataTab} className="w-full flex flex-col">
                   <div className="overflow-x-auto overflow-y-hidden scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent"><TabsList className="items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground grid min-w-full w-max gap-1 md:gap-0 h-auto md:h-14" style={{ gridTemplateColumns: 'repeat(9,minmax(max-content,1fr))' }}>
                       <TabsTrigger value="companies" className="text-xs md:text-sm px-3 py-2 justify-center text-center">Companies</TabsTrigger>
                       <TabsTrigger value="cities" className="text-xs md:text-sm px-3 py-2 justify-center text-center">Cities</TabsTrigger>
                       <TabsTrigger value="deliveries" className="text-xs md:text-sm px-3 py-2 justify-center text-center">Deliveries</TabsTrigger>
                       <TabsTrigger value="patients" className="text-xs md:text-sm px-3 py-2 justify-center text-center">Patients</TabsTrigger>
                       <TabsTrigger value="stores" className="text-xs md:text-sm px-3 py-2 justify-center text-center">Stores</TabsTrigger><TabsTrigger value="temp-logs" className="text-xs md:text-sm px-3 py-2 justify-center text-center">🌡️ Temp Logs</TabsTrigger>
                       <TabsTrigger value="credits" className="text-xs md:text-sm px-3 py-2 justify-center text-center">Credits</TabsTrigger>
                       <TabsTrigger value="ble-diagnostic" className="text-xs md:text-sm px-3 py-2 justify-center text-center">🌡️ BLE Diag</TabsTrigger>
                       </TabsList></div>

                  <TabsContent value="deliveries" className="mt-4">
                    <div className="space-y-2">
                      <div className="flex flex-col md:flex-row gap-1 flex-wrap items-stretch md:items-center justify-between">
                        {!manualLoadTriggered ?
                      <Alert className="bg-background text-foreground pt-2 pr-3 pb-1 pl-3 text-sm rounded-lg relative w-full border [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground [&>svg~*]:pl-7 flex-1">
                            <AlertCircle className="h-4 w-4" />
                            <AlertDescription className="flex items-center justify-between">
                              <span>Select filters above, then click "Load Data" to fetch deliveries.</span>
                              <Button
                            onClick={() => setManualLoadTriggered(true)}
                            disabled={deliveriesLoading}
                            size="sm">
                            
                                <Database className="w-4 h-4 mr-2" />
                                Load Data
                              </Button>
                            </AlertDescription>
                          </Alert> :

                      <Button
                        onClick={() => {
                          setManualLoadTriggered(false);
                          setTimeout(() => setManualLoadTriggered(true), 100);
                        }}
                        disabled={deliveriesLoading}
                        variant="outline">
                        
                            <RefreshCw className={`w-4 h-4 mr-2 ${deliveriesLoading ? 'animate-spin' : ''}`} />
                            Reload Data
                          </Button>
                      }
                        {manualLoadTriggered &&
                      <div className="flex gap-2 w-full md:w-auto">
                             <Button
                          variant={dataViewMode.deliveries === 'offline' ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => setDataViewMode((prev) => ({ ...prev, deliveries: 'offline' }))}
                          className="flex-1 md:flex-none min-h-10">
                          
                               Offline
                             </Button>
                             <Button
                          variant={dataViewMode.deliveries !== 'offline' ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => setDataViewMode((prev) => ({ ...prev, deliveries: 'online' }))}
                          className="flex-1 md:flex-none min-h-10">
                          
                               Online
                             </Button>
                           </div>
                      }
                      </div>

                      {manualLoadTriggered && <DeliveryDataTable
                      deliveries={filteredAndSortedDeliveries}
                      patients={patients || []}
                      stores={stores || []}
                      drivers={driversForDropdown}
                      onEdit={handleEditEntity}
                      onDelete={handleDeleteEntity}
                      onDeleteAll={_confirmDeleteAllDeliveries}
                      onDeleteSelected={_confirmDeleteSelectedDeliveries}
                      onFindDuplicates={(deliveries) => handleFindDuplicates(deliveries, setAutoSelectDuplicateIds)}
                      autoSelectIds={autoSelectDuplicateIds}
                      duplicateFilterMode={duplicateFilterMode}
                      onAutoSelectProcessed={() => setAutoSelectDuplicateIds([])}
                      onClearDuplicateFilter={() => setDuplicateFilterMode(false)}
                      filterText={deliveryFilterText}
                      onFilterChange={setDeliveryFilterText}
                      sortColumn={deliverySortColumn}
                      sortDirection={deliverySortDirection}
                      onSortChange={handleDeliverySort}
                      isLoadingData={deliveriesLoading}
                      selectedYear={selectedDeliveryYear}
                      onYearChange={(year) => {
                        if (currentUser?.id) {
                          saveSetting(currentUser.id, 'admin_utilities_year', year);
                        }
                        setSelectedDeliveryYear(year);
                      }}
                      availableYears={availableDeliveryYears}
                      selectedMonth={selectedDeliveryMonth}
                      onMonthChange={(month) => {
                        if (currentUser?.id) {
                          saveSetting(currentUser.id, 'admin_utilities_month', month);
                        }
                        setSelectedDeliveryMonth(month);
                      }}
                      selectedDriver={selectedDriver}
                      onDriverChange={(driver) => {
                        if (currentUser?.id) {
                          saveSetting(currentUser.id, 'admin_utilities_driver', driver);
                        }
                        setSelectedDriver(driver);
                      }}
                      selectedCodFilter={selectedCodFilter}
                      onCodFilterChange={setSelectedCodFilter}
                      handleDriverChange={handleDriverChange} />
                    }
                    </div>
                  </TabsContent>

                  <TabsContent value="patients" className="mt-6">
                    <AdminPatientsTab
                    dataViewMode={dataViewMode}
                    setDataViewMode={setDataViewMode}>
                    
                      <PatientDataTable
                      patients={filteredPatientsForDetectDuplicates || []}
                      stores={stores || []}
                      onEdit={handleEditEntity}
                      onDelete={handleDeleteEntity}
                      filterText={patientFilterText}
                      onFilterChange={setPatientFilterText}
                      sortColumn={patientSortColumn}
                      sortDirection={patientSortDirection}
                      onSortChange={handlePatientSort}
                      isLoadingData={patientsLoading}
                      onDeleteAll={_confirmDeleteAllPatients}
                      onDeleteSelected={_confirmDeleteSelectedPatients} />
                    
                    </AdminPatientsTab>
                  </TabsContent>

                  <TabsContent value="stores" className="mt-6">
                    <SimpleDataViewTab viewKey="stores" dataViewMode={dataViewMode} setDataViewMode={setDataViewMode}>
                      <StoreDataTable
                      stores={stores || []}
                      onEdit={handleEditEntity}
                      onDelete={handleDeleteEntity}
                      onDeleteSelected={_confirmDeleteSelectedStores}
                      isLoadingData={storesLoading} />
                    
                    </SimpleDataViewTab>
                  </TabsContent>

                  <TabsContent value="cities" className="mt-6">
                    <SimpleDataViewTab viewKey="cities" dataViewMode={dataViewMode} setDataViewMode={setDataViewMode}>
                      <CityDataTable
                      cities={cities || []}
                      onEdit={handleEditEntity}
                      onDelete={handleDeleteEntity}
                      onDeleteSelected={_confirmDeleteSelectedCities}
                      isLoadingData={citiesLoading} />
                    
                    </SimpleDataViewTab>
                  </TabsContent>
                  <TabsContent value="credits" className="mt-6"><IntegrationCreditsTab /></TabsContent><TabsContent value="temp-logs" className="mt-4 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 220px)' }}><TempLogTab drivers={driversForDropdown} currentUser={currentUser} /></TabsContent>
                  <TabsContent value="companies" className="mt-6"><CompanyDataTab /></TabsContent>
                  <TabsContent value="ble-diagnostic" className="mt-4 overflow-y-auto space-y-4" style={{ maxHeight: 'calc(100vh - 220px)' }}><InkbirdBleLog /><InkbirdRawDiagnostic /></TabsContent></Tabs>
              </div>
            }
          </TabsContent>

          <TabsContent value="store-metrics">
            <StoreMetricsPanel />
          </TabsContent>

          <TabsContent value="user-settings">
            <UserSettingsTable
              appUsers={appUsers || []}
              mergedUsers={mergedUsers} />
            
          </TabsContent>

          <TabsContent value="polylines" className="mt-4" style={{ height: 'calc(100vh - 180px)' }}>
            <PolylineViewerWrapper users={mergedUsers} activeUtilityTab={activeUtilityTab} />
          </TabsContent>

          <AdminUtilitiesExtraTabs appUsers={appUsers || []} stores={stores || []} />
        </Tabs>
      </div>

      {showRouteImport &&
      <RouteImport
        onImportComplete={handleRouteImportComplete}
        onCancel={() => setShowRouteImport(false)}
        stores={stores || []}
        drivers={driversForDropdown}
        allUsers={mergedUsers}
        currentUser={currentUser}
        allDeliveries={allDeliveries || []} />

      }

      {editingPatient && <PatientForm patient={editingPatient} stores={stores || []} currentUser={currentUser} forceAppOwnerView={true} onSave={async (updatedData) => { await base44.entities.Patient.update(editingPatient.id, updatedData); setEditingPatient(null); await refetchPatients(); await refreshData(); }} onCancel={() => setEditingPatient(null)} />}

      {editingDelivery &&
      <DeliveryForm
        delivery={editingDelivery}
        patients={patients || []}
        stores={stores || []}
        drivers={mergedUsers || []}
        currentUser={currentUser}
        allDeliveries={allDeliveries || []}
        onSave={async (updatedData) => {
          try {
            const { updateDeliveryLocal } = await import('../components/utils/offlineMutations');
            await updateDeliveryLocal(editingDelivery.id, updatedData);
            setEditingDelivery(null);
            await refetchDeliveries();
            await refreshData();
          } catch (error) {
            console.error('Failed to update delivery:', error);
            throw error;
          }
        }}
        onCancel={() => setEditingDelivery(null)}
        closeOnSave={true} />

      }

      <Dialog open={bulkDelete.open} onOpenChange={(open) => {
        if (!bulkDelete.running) {
          setBulkDelete((prev) => ({ ...prev, open }));
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deleting {bulkDelete.entityLabel}</DialogTitle>
            <DialogDescription>
              {bulkDelete.running ?
              `Please keep this window open while we delete the filtered ${bulkDelete.entityLabel.toLowerCase()}.` :
              "Bulk delete completed."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="text-sm text-slate-600">
              {bulkDelete.processed} / {bulkDelete.total} processed
              {bulkDelete.currentLabel ? ` • Last: ${bulkDelete.currentLabel}` : ""}
            </div>
            <div className="text-xs text-slate-500">
              Current delay: {Math.round(bulkDelete.currentDelay)} ms • Retrying: {bulkDelete.retryQueue}
            </div>
            <Progress value={bulkDelete.total ? bulkDelete.processed / bulkDelete.total * 100 : 0} />
            <div className="flex items-center justify-between text-sm">
              <div className="text-emerald-600 font-medium">Success: {bulkDelete.success}</div>
              <div className="text-red-600 font-medium">Failed: {bulkDelete.failed}</div>
            </div>
          </div>

          <DialogFooter className="mt-4">
            <Button
              onClick={() => setBulkDelete((prev) => ({ ...prev, open: false }))}
              disabled={bulkDelete.running}>
              
              {bulkDelete.running ? 'Deleting…' : 'Close'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmationDialog
        open={confirmDialog.open}
        onOpenChange={(open) => setConfirmDialog((prev) => ({ ...prev, open }))}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        confirmText={confirmDialog.confirmText}
        variant={confirmDialog.variant} />
    </div>);

}