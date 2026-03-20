import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DollarSign, CheckCircle, Clock, CreditCard, Trash2, Loader2, CloudDownload } from "lucide-react";
import { toast } from "sonner";
import { isAppOwner } from "@/components/utils/userRoles";
import LocationSummaryCard from "@/components/square/LocationSummaryCard";
import TransactionHistoryPanel from "@/components/square/TransactionHistoryPanel";
import CODItemDetailModal from "@/components/square/CODItemDetailModal";
import SyncStatusIndicator from "@/components/square/SyncStatusIndicator";
import BackgroundSyncProgressBar from "@/components/square/BackgroundSyncProgressBar";
import SquareCodViewSwitcher from "@/components/square/SquareCodViewSwitcher";
import SquareCodDatasetTable from "@/components/square/SquareCodDatasetTable";
import { getStatusBadge, getTypeBadge, getPaymentMethodBadge } from "@/components/square/badgeHelpers";
import { format } from "date-fns";
import * as squareCODOfflineManager from "@/components/utils/squareCODOfflineManager";

export default function SquareManagement() {
  const {
    syncSquareCODSnapshotOffline,
    getCatalogItemsOffline,
    getPaymentTransactionsOffline,
    getSquareCODSyncStatus,
  } = squareCODOfflineManager;

  const [catalogItems, setCatalogItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [locationIds, setLocationIds] = useState([]);
  const [locationConfigs, setLocationConfigs] = useState([]);
  const [stores, setStores] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [currentAppUser, setCurrentAppUser] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [patients, setPatients] = useState([]);
  const [selectedDriverFilter, setSelectedDriverFilter] = useState('all');
  const [selectedStoreFilter, setSelectedStoreFilter] = useState('all');
  const [selectedDaysRange, setSelectedDaysRange] = useState('7');
  const [isUpdatingReconciliationCatalog, setIsUpdatingReconciliationCatalog] = useState(false);
  const [hasInitialLoadCompleted, setHasInitialLoadCompleted] = useState(false);
  const [recentTransactions, setRecentTransactions] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [selectedCODItem, setSelectedCODItem] = useState(null);
  const [allTransactions, setAllTransactions] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [activeView, setActiveView] = useState('deliveries');
  const [itemToDelete, setItemToDelete] = useState(null);
  const [soldCatalogItems, setSoldCatalogItems] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);
  const [lastCleanup, setLastCleanup] = useState(null);
  const [navHeight, setNavHeight] = useState(0);
  const [bgSyncProgress, setBgSyncProgress] = useState({ stage: 'idle' });
  const realtimeRefreshTimeoutRef = React.useRef(null);
  const locationConfigsRef = React.useRef([]);
  const initialLoadKeyRef = React.useRef(null);

  useEffect(() => {
    const measure = () => {
      const nav = document.querySelector('nav[data-mobile-bottom-nav]');
      const h = nav ? Math.ceil(nav.getBoundingClientRect().height) : 0;
      setNavHeight(h);
    };
    measure();
    window.addEventListener('resize', measure);
    const navEl = document.querySelector('nav[data-mobile-bottom-nav]');
    let ro;
    if ('ResizeObserver' in window && navEl) {
      ro = new ResizeObserver(measure);
      ro.observe(navEl);
    }
    return () => {
      window.removeEventListener('resize', measure);
      if (ro) ro.disconnect();
    };
  }, []);

  const loadSquareViewFromOffline = React.useCallback(async () => {
    const [offlineCatalog, offlineTransactions, updatedSyncStatus] = await Promise.all([
      getCatalogItemsOffline(),
      getPaymentTransactionsOffline(),
      getSquareCODSyncStatus(),
    ]);

    const sold = (offlineTransactions || []).filter(tx => ['completed', 'refunded'].includes(tx.status));

    setCatalogItems(offlineCatalog || []);
    setSoldCatalogItems(sold);
    setAllTransactions(offlineTransactions || []);
    setSyncStatus(updatedSyncStatus);

    return {
      items: offlineCatalog || [],
      transactions: offlineTransactions || [],
      sold,
    };
  }, []);

  const loadDeliveriesFromOffline = React.useCallback(async (offlineDB, startDateStr, endDateStr) => {
    const allDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES) || [];
    return allDeliveries.filter((delivery) => (
      delivery &&
      delivery.delivery_date >= startDateStr &&
      delivery.delivery_date <= endDateStr
    ));
  }, []);

  const loadSyncStatus = React.useCallback(async () => {
    try {
      const status = await getSquareCODSyncStatus();
      setSyncStatus(status);
    } catch (err) {
      console.error('Failed to load sync status:', err);
    }
  }, [getSquareCODSyncStatus]);


  const extractSquarePayments = React.useCallback((response) => {
    const data = response?.data || response || {};
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.transactions)) return data.transactions;
    if (Array.isArray(data.payments)) return data.payments;
    if (Array.isArray(data.soldCatalogItems)) return data.soldCatalogItems;
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.results)) return data.results;
    return [];
  }, []);

  const refreshSquareView = async (fallbackLocationIds = [], options = {}) => {
    const { onStageChange, paymentsResponse, daysBack } = options;

    const [catalogRecords, fetchedPaymentsResponse] = await Promise.all([
      base44.entities.SquareCatalogItems.list('-updated_date', 2000),
      paymentsResponse ? Promise.resolve(paymentsResponse) : base44.functions.invoke('squareCodCore', { action: 'fetchPayments', daysBack: Number(daysBack || selectedDaysRange || 30) }),
    ]);

    const transactions = extractSquarePayments(fetchedPaymentsResponse);

    onStageChange?.({ stage: 'saving_offline', detail: 'Updating local COD cache…' });

    await syncSquareCODSnapshotOffline({
      catalogItems: catalogRecords || [],
      transactions: transactions || [],
    });

    const snapshot = await loadSquareViewFromOffline();
    setLocationIds(fallbackLocationIds);

    return { ...snapshot, data: { locationIds: fallbackLocationIds } };
  };

  const hydrateSquareViewFromEntities = React.useCallback(async () => {
    const [catalogRecords, transactionRecords] = await Promise.all([
      base44.entities.SquareCatalogItems.list('-updated_date', 2000),
      base44.entities.SquareTransaction.list('-updated_date', 2000),
    ]);

    await syncSquareCODSnapshotOffline({
      catalogItems: catalogRecords || [],
      transactions: transactionRecords || [],
    });

    return loadSquareViewFromOffline();
  }, [loadSquareViewFromOffline]);

  const mapCatalogRecordToUIItem = React.useCallback((record) => ({
    id: record.id,
    catalog_object_id: record.square_catalog_object_id || record.id,
    variation_id: null,
    name: record.item_name,
    description: record.description || '',
    price_cents: record.amount_cents ?? Math.round(Number(record.amount || 0) * 100),
    price_dollars: Number(record.amount || 0),
    location_id: record.location_id || '',
    present_at_locations: record.location_id ? [record.location_id] : [],
    present_at_all: false,
    updated_at: record.updated_date,
    version: record.square_catalog_version || 0,
    transaction_id: null,
    delivery_id: record.delivery_id,
    patient_id: record.patient_id,
    store_id: record.store_id,
    status: record.status || 'active',
    created_date: record.created_date,
    is_sold: false,
  }), []);

  const loadReconciliationFromEntities = React.useCallback(async (dateFilter) => {
    const [entityDeliveries, catalogRecords, transactionRecords] = await Promise.all([
      base44.entities.Delivery.filter(dateFilter, '-updated_date', 2000),
      base44.entities.SquareCatalogItems.list('-updated_date', 2000),
      base44.entities.SquareTransaction.list('-updated_date', 2000),
    ]);

    setDeliveries(entityDeliveries || []);
    setCatalogItems((catalogRecords || []).map(mapCatalogRecordToUIItem));
    setAllTransactions(transactionRecords || []);
    setSoldCatalogItems((transactionRecords || []).filter((tx) => ['completed', 'refunded'].includes(tx.status)));

    return {
      deliveries: entityDeliveries || [],
      catalogRecords: catalogRecords || [],
      transactionRecords: transactionRecords || [],
    };
  }, [mapCatalogRecordToUIItem]);

  const loadReconciliationFromOffline = React.useCallback(async (offlineDB, startDateStr, endDateStr, entitySnapshot = null) => {
    if (entitySnapshot) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, entitySnapshot.deliveries || []);
      await syncSquareCODSnapshotOffline({
        catalogItems: entitySnapshot.catalogRecords || [],
        transactions: entitySnapshot.transactionRecords || [],
      });
    }

    const [updatedDeliveries] = await Promise.all([
      loadDeliveriesFromOffline(offlineDB, startDateStr, endDateStr),
      loadSquareViewFromOffline(),
    ]);

    setDeliveries(updatedDeliveries || []);
    return updatedDeliveries || [];
  }, [loadDeliveriesFromOffline, loadSquareViewFromOffline]);

  const refreshUiFromOfflineOnly = React.useCallback(async () => {
    const today = new Date();
    const daysBack = Number(selectedDaysRange || 30);
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - daysBack);
    const startDateStr = format(startDate, 'yyyy-MM-dd');
    const endDateStr = format(today, 'yyyy-MM-dd');
    const { offlineDB } = await import('@/components/utils/offlineDatabase');

    await loadReconciliationFromOffline(offlineDB, startDateStr, endDateStr);
    await loadSyncStatus();
  }, [selectedDaysRange, loadReconciliationFromOffline, loadSyncStatus]);

  const syncDeliveriesWindowOffline = React.useCallback(async (offlineDB, startDateStr, endDateStr, deliveryRecords = []) => {
    const existingDeliveries = await loadDeliveriesFromOffline(offlineDB, startDateStr, endDateStr);
    const nextIds = new Set((deliveryRecords || []).map((delivery) => delivery?.id).filter(Boolean));

    await Promise.all(
      (existingDeliveries || [])
        .filter((delivery) => delivery?.id && !nextIds.has(delivery.id))
        .map((delivery) => offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, delivery.id))
    );

    if ((deliveryRecords || []).length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveryRecords);
    }
  }, [loadDeliveriesFromOffline]);

  React.useEffect(() => {
    locationConfigsRef.current = locationConfigs || [];
  }, [locationConfigs]);

  const runFullOfflineSnapshotSync = React.useCallback(async ({ onStageChange, daysBack, refreshLocations = false } = {}) => {
    const rangeDays = Number(daysBack || selectedDaysRange || 30);
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - rangeDays);
    const startDateStr = format(startDate, 'yyyy-MM-dd');
    const endDateStr = format(today, 'yyyy-MM-dd');
    const { offlineDB } = await import('@/components/utils/offlineDatabase');

    onStageChange?.({ stage: 'catalog_sync', detail: 'Refreshing COD snapshot…' });

    const snapshotResponse = await base44.functions.invoke('squareCodCore', { action: 'getCodData', daysBack: rangeDays });
    const snapshotData = snapshotResponse?.data || snapshotResponse || {};
    const catalogRecords = snapshotData.catalogRecords || [];
    const transactions = snapshotData.transactionRecords || [];
    const deliveryRecords = snapshotData.deliveries || [];
    const nextConfigs = refreshLocations ? (snapshotData.locationConfigs || []) : (locationConfigsRef.current || []);

    if (refreshLocations) {
      await offlineDB.clearStore(offlineDB.STORES.SQUARE_LOCATION_CONFIGS);
      if ((nextConfigs || []).length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.SQUARE_LOCATION_CONFIGS, nextConfigs);
      }
      setLocationConfigs(nextConfigs || []);
      setLocationIds((snapshotData.locationIds || []).filter(Boolean));
    }

    onStageChange?.({ stage: 'payments_sync', detail: 'Updating offline COD data…' });

    await Promise.all([
      syncDeliveriesWindowOffline(offlineDB, startDateStr, endDateStr, deliveryRecords || []),
      syncSquareCODSnapshotOffline({
        catalogItems: catalogRecords || [],
        transactions: transactions || [],
      }),
    ]);

    onStageChange?.({ stage: 'saving_offline', detail: 'Reloading from offline cache…' });

    await Promise.all([
      loadReconciliationFromOffline(offlineDB, startDateStr, endDateStr),
      loadSyncStatus(),
    ]);

    return {
      deliveryCount: (deliveryRecords || []).length,
      transactionCount: (transactions || []).length,
    };
  }, [selectedDaysRange, syncDeliveriesWindowOffline, syncSquareCODSnapshotOffline, loadReconciliationFromOffline, loadSyncStatus]);

  const syncReconciliationToCatalog = async () => {
    setIsUpdatingReconciliationCatalog(true);
    try {
      const items = reconciliationRows
        .map((row) => {
          const delivery = deliveries.find((entry) => entry?.id === row.id);
          if (!delivery) return null;
          const patient = patients.find((p) => p?.id === delivery.patient_id || p?.patient_id === delivery.patient_id);
          const store = stores.find((s) => s?.id === delivery.store_id);
          return {
            deliveryId: delivery.id,
            patientName: patient?.full_name || row.itemName,
            storeAbbreviation: store?.abbreviation,
            codAmount: Number(delivery.cod_total_amount_required || 0),
            deliveryDate: delivery.delivery_date,
            storeId: delivery.store_id,
          };
        })
        .filter((item) => item && item.deliveryId && item.codAmount > 0);

      if (items.length === 0) {
        toast.error('No reconciliation items available to update');
        return;
      }

      const keepDeliveryIds = new Set(items.map((item) => item.deliveryId));
      const deletions = (catalogItems || [])
        .filter((item) => !keepDeliveryIds.has(item.delivery_id))
        .map((item) => ({
          deliveryId: item.delivery_id,
          catalogObjectId: item.catalog_object_id || item.id,
          transactionId: item.transaction_id,
          status: 'cancelled',
          reason: 'replace_catalog_with_reconciliation_items',
        }))
        .filter((item) => item?.catalogObjectId);

      await base44.functions.invoke('squareCodCore', {
        action: 'syncSquareCods',
        items,
        deletions,
      });
      await syncFromSquare();
      setActiveView('catalog');
      toast.success(`Square catalog replaced with ${items.length} reconciliation items and deleted ${deletions.length} others`);
    } finally {
      setIsUpdatingReconciliationCatalog(false);
    }
  };

  const syncFromSquare = async () => {
    setIsSyncing(true);
    setError(null);
    setBgSyncProgress({ stage: 'catalog_sync' });

    try {
      const syncResult = await runFullOfflineSnapshotSync({
        onStageChange: setBgSyncProgress,
        daysBack: Number(selectedDaysRange || 30),
        refreshLocations: true,
      });

      toast.success(`Square payments refreshed: ${syncResult.transactionCount} transactions`);
      setBgSyncProgress({ stage: 'complete', detail: `${syncResult.transactionCount} transactions refreshed` });
      setTimeout(() => setBgSyncProgress({ stage: 'idle' }), 5000);
    } catch (err) {
      console.error('Sync error:', err);
      setError(err.message);
      toast.error('Failed to sync: ' + err.message);
      setBgSyncProgress({ stage: 'error', error: err.message });
      setTimeout(() => setBgSyncProgress({ stage: 'idle' }), 8000);
    } finally {
      setIsSyncing(false);
      setIsLoading(false);
      await loadSyncStatus();
    }
  };

  useEffect(() => {
    const loadKey = `square-cod-${selectedDaysRange}`;
    if (initialLoadKeyRef.current === loadKey) return;
    initialLoadKeyRef.current = loadKey;

    const loadData = async () => {
      try {
        const authUser = await base44.auth.me();
        const today = new Date();
        const daysBack = Number(selectedDaysRange || 30);
        const startDate = new Date(today);
        startDate.setDate(today.getDate() - daysBack);
        const startDateStr = format(startDate, 'yyyy-MM-dd');
        const endDateStr = format(today, 'yyyy-MM-dd');
        const { offlineDB } = await import('@/components/utils/offlineDatabase');

        let storesData = await offlineDB.getAll(offlineDB.STORES.STORES) || [];
        if (storesData.length === 0) {
          storesData = await base44.entities.Store.list();
          await offlineDB.bulkSave(offlineDB.STORES.STORES, storesData);
        }

        let appUsersData = await offlineDB.getAll(offlineDB.STORES.APP_USERS) || [];
        if (appUsersData.length === 0) {
          appUsersData = await base44.entities.AppUser.list();
          await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, appUsersData);
        }

        let patientsData = await offlineDB.getAll(offlineDB.STORES.PATIENTS) || [];
        if (patientsData.length === 0) {
          patientsData = await base44.entities.Patient.list();
          await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, patientsData);
        }

        const configs = await offlineDB.getAll(offlineDB.STORES.SQUARE_LOCATION_CONFIGS) || [];

        const matchedAppUser = appUsersData.find((appUser) => appUser?.user_id === authUser?.id) || null;
        setCurrentUser(authUser);
        setCurrentAppUser(matchedAppUser);
        setLocationConfigs(configs || []);
        setStores(storesData || []);
        setPatients(patientsData || []);

        const driversList = appUsersData.filter((u) => u && u.app_roles && u.app_roles.includes('driver') && u.status === 'active');
        setDrivers(driversList || []);
        setLocationIds((configs || []).map((config) => config?.square_location_id).filter(Boolean));

        await loadReconciliationFromOffline(offlineDB, startDateStr, endDateStr);
        await loadSyncStatus();
        setIsLoading(false);
        setHasInitialLoadCompleted(true);

        setBgSyncProgress({ stage: 'catalog_sync', detail: 'Refreshing COD views…' });

        try {
          const { transactionCount } = await runFullOfflineSnapshotSync({
            onStageChange: setBgSyncProgress,
            daysBack,
            refreshLocations: true,
          });
          setBgSyncProgress({ stage: 'complete', detail: `${transactionCount} transactions refreshed` });
          setTimeout(() => setBgSyncProgress({ stage: 'idle' }), 4000);
        } catch (bgError) {
          console.warn('⚠️ [SquareManagement] Background COD refresh failed:', bgError.message);
          setBgSyncProgress({ stage: 'error', error: bgError.message });
          setTimeout(() => setBgSyncProgress({ stage: 'idle' }), 8000);
        }
      } catch (err) {
        console.error('Failed to load COD data:', err);
        setIsLoading(false);
      }
    };

    loadData();
  }, [selectedDaysRange, loadReconciliationFromOffline, loadSyncStatus, runFullOfflineSnapshotSync]);

  useEffect(() => {
    if (!hasInitialLoadCompleted) return;
    refreshUiFromOfflineOnly();
  }, [activeView, selectedDriverFilter, selectedStoreFilter, selectedDaysRange, hasInitialLoadCompleted, refreshUiFromOfflineOnly]);

  useEffect(() => {
    if (!hasInitialLoadCompleted) return;

    let isActive = true;

    const scheduleFullRealtimeRefresh = () => {
      if (realtimeRefreshTimeoutRef.current) {
        clearTimeout(realtimeRefreshTimeoutRef.current);
      }

      realtimeRefreshTimeoutRef.current = setTimeout(async () => {
        if (!isActive || isSyncing) return;

        try {
          setBgSyncProgress({ stage: 'catalog_sync', detail: 'Refreshing COD snapshot…' });
          const { transactionCount } = await runFullOfflineSnapshotSync({
            onStageChange: setBgSyncProgress,
            daysBack: Number(selectedDaysRange || 30),
            refreshLocations: false,
          });
          setBgSyncProgress({ stage: 'complete', detail: `${transactionCount} transactions refreshed` });
          setTimeout(() => setBgSyncProgress({ stage: 'idle' }), 4000);
        } catch (error) {
          console.error('❌ [SquareManagement] Realtime Square sync failed:', error);
          setBgSyncProgress({ stage: 'error', error: error.message });
          setTimeout(() => setBgSyncProgress({ stage: 'idle' }), 8000);
        }
      }, 1200);
    };

    const unsubscribeCatalogItems = base44.entities.SquareCatalogItems.subscribe(() => {
      scheduleFullRealtimeRefresh();
    });

    const unsubscribeTransactions = base44.entities.SquareTransaction.subscribe(() => {
      scheduleFullRealtimeRefresh();
    });

    return () => {
      isActive = false;
      if (realtimeRefreshTimeoutRef.current) {
        clearTimeout(realtimeRefreshTimeoutRef.current);
      }
      unsubscribeCatalogItems?.();
      unsubscribeTransactions?.();
    };
  }, [hasInitialLoadCompleted, isSyncing, selectedDaysRange, runFullOfflineSnapshotSync]);



  // Get consistent color for each driver
  const getDriverColor = (driverId) => {
    const colors = [
      'bg-blue-100 text-blue-800 border-blue-300',
      'bg-purple-100 text-purple-800 border-purple-300',
      'bg-pink-100 text-pink-800 border-pink-300',
      'bg-orange-100 text-orange-800 border-orange-300',
      'bg-teal-100 text-teal-800 border-teal-300',
      'bg-indigo-100 text-indigo-800 border-indigo-300'
    ];
    const index = drivers.findIndex(d => d.id === driverId);
    return colors[index % colors.length];
  };

  // Get consistent color for each store
  const getStoreColor = (storeId) => {
    const colors = [
      { bg: 'rgba(148, 163, 184, 0.08)', border: 'rgb(148, 163, 184)', hover: 'rgba(148, 163, 184, 0.12)' }, // slate-light
      { bg: 'rgba(55, 65, 81, 0.08)', border: 'rgb(55, 65, 81)', hover: 'rgba(55, 65, 81, 0.12)' }, // gray-dark
      { bg: 'rgba(156, 163, 175, 0.08)', border: 'rgb(156, 163, 175)', hover: 'rgba(156, 163, 175, 0.12)' }, // gray-light
      { bg: 'rgba(71, 85, 105, 0.08)', border: 'rgb(71, 85, 105)', hover: 'rgba(71, 85, 105, 0.12)' }, // slate-dark
      { bg: 'rgba(107, 114, 128, 0.08)', border: 'rgb(107, 114, 128)', hover: 'rgba(107, 114, 128, 0.12)' }, // gray-mid (light)
      { bg: 'rgba(82, 82, 91, 0.08)', border: 'rgb(82, 82, 91)', hover: 'rgba(82, 82, 91, 0.12)' }, // zinc (dark)
      { bg: 'rgba(100, 116, 139, 0.08)', border: 'rgb(100, 116, 139)', hover: 'rgba(100, 116, 139, 0.12)' }, // slate (light)
      { bg: 'rgba(75, 85, 99, 0.08)', border: 'rgb(75, 85, 99)', hover: 'rgba(75, 85, 99, 0.12)' } // gray (dark)
    ];
    const sortedStores = [...stores].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
    const index = sortedStores.findIndex(s => s.id === storeId);
    return colors[index % colors.length];
  };

  // Get drivers assigned to a location
  const getDriversForLocation = (locationId) => {
    const config = locationConfigs.find(c => c.square_location_id === locationId);
    if (!config) return [];
    
    return drivers.filter(d => 
      d.square_location_ids && d.square_location_ids.includes(config.id)
    );
  };

  // Parse Square catalog item name (format: "MM/DD(STORE)-PatientName")
  const parseSquareItemName = (itemName) => {
    if (!itemName) return null;
    
    try {
      const dateMatch = itemName.match(/^(\d{2})[\/-](\d{2})/);
      if (!dateMatch) return null;
      
      const month = Number(dateMatch[1]);
      const day = Number(dateMatch[2]);
      const today = new Date();
      const inferredDate = new Date(today.getFullYear(), month - 1, day);
      const msInDay = 24 * 60 * 60 * 1000;

      if (inferredDate.getTime() - today.getTime() > 45 * msInDay) {
        inferredDate.setFullYear(inferredDate.getFullYear() - 1);
      }

      const deliveryDate = format(inferredDate, 'yyyy-MM-dd');
      
      const storeMatch = itemName.match(/\(([^)]+)\)/);
      const storeAbbr = storeMatch ? storeMatch[1] : null;
      
      const nameMatch = itemName.match(/\)-(.+)$/);
      const patientName = nameMatch ? nameMatch[1].trim() : null;
      
      return { deliveryDate, storeAbbr, patientName };
    } catch (error) {
      console.warn('Failed to parse Square item name:', itemName, error);
      return null;
    }
  };

  // Find matching delivery for a Square catalog item
  const findMatchingDelivery = (itemName, itemLocationId) => {
    const parsed = parseSquareItemName(itemName);
    if (!parsed) return null;
    
    const { deliveryDate, storeAbbr, patientName } = parsed;
    if (!deliveryDate || !patientName) return null;
    
    // Find store by abbreviation
    const store = stores.find(s => s.abbreviation === storeAbbr);
    if (!store) return null;
    
    // Find matching delivery
    const matchingDelivery = deliveries.find(d => {
      const dateMatch = d.delivery_date === deliveryDate;
      const storeMatch = d.store_id === store.id;
      const matchedPatient = patients.find((p) => p && (p.id === d.patient_id || p.patient_id === d.patient_id));
      const nameMatch = matchedPatient?.full_name?.toLowerCase().trim() === patientName.toLowerCase().trim();
      const isCompleted = ['completed', 'returned'].includes(d.status);
      
      return dateMatch && storeMatch && nameMatch && isCompleted;
    });
    
    return matchingDelivery;
  };

  // Get COD payment details for a Square item
  const getCODPaymentDetails = (itemName, itemLocationId) => {
    const delivery = findMatchingDelivery(itemName, itemLocationId);
    
    // If no matching delivery found, return 'no_collection' status
    if (!delivery) {
      return { status: 'no_collection', payments: [] };
    }
    
    // Check if delivery has cod_payments array (new format)
    if (delivery.cod_payments && delivery.cod_payments.length > 0) {
      return { status: 'collected', payments: delivery.cod_payments };
    }
    
    // Fallback to legacy format (cod_payment_type and cod_amount)
    if (delivery.cod_payment_type && delivery.cod_payment_type !== 'No Payment') {
      return { 
        status: 'collected', 
        payments: [{ 
          type: delivery.cod_payment_type, 
          amount: parseFloat(delivery.cod_amount || 0) 
        }]
      };
    }
    
    // Delivery exists but no payment recorded yet - mark as "Cash"
    return { status: 'cash', payments: [] };
  };

  // Normalize item name for comparison (must match backend normalization)
  const getMonthDayKey = (value) => {
    if (!value) return '';
    const isoMatch = String(value).match(/^\d{4}-(\d{2})-(\d{2})$/);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}`;
    const parsed = parseSquareItemName(value);
    if (parsed?.deliveryDate) {
      const [, month, day] = parsed.deliveryDate.split('-');
      return `${month}-${day}`;
    }
    return '';
  };

  const buildLocationDateAmountSignature = (locationId, dateValue, amountValue) => {
    const amountCents = Math.round(Number(amountValue || 0) * 100);
    return `${locationId || ''}::${getMonthDayKey(dateValue) || 'unknown-date'}::${amountCents}`;
  };

  // Check if catalog item has been sold in Square transactions
  const hasBeenSoldInSquare = (catalogItem) => {
    const catalogPrice = catalogItem.price_dollars || ((catalogItem.price_cents || 0) / 100);
    const catalogSignature = buildLocationDateAmountSignature(
      catalogItem.location_id,
      catalogItem.delivery_date || catalogItem.name,
      catalogPrice
    );

    return soldCatalogItems.some(payment => {
      const paymentSignature = buildLocationDateAmountSignature(
        payment.location_id,
        payment.item_name,
        payment.amount
      );
      return paymentSignature === catalogSignature;
    });
  };

  const hasMatchingSquareTransaction = (delivery, locationId) => {
    const deliveryAmount = Number(delivery?.cod_total_amount_required || 0);
    const deliveryAmountCents = Math.round(deliveryAmount * 100);

    return (allTransactions || []).some((transaction) => {
      if (!transaction || isTransferTransaction(transaction)) return false;
      if (!transaction.square_payment_id) return false;
      if (transaction.type !== 'collection') return false;
      if (!['completed', 'refunded'].includes(transaction.status)) return false;

      if (transaction.delivery_id && transaction.delivery_id === delivery.id) return true;

      const transactionAmountCents = Math.round(Number(transaction.amount || 0) * 100);
      return transaction.location_id === locationId &&
        transaction.store_id === delivery.store_id &&
        transactionAmountCents === deliveryAmountCents &&
        transaction.created_date?.slice(0, 10) === delivery.delivery_date;
    });
  };

  // NOTE: Auto-deletion of paid catalog items is handled by the backend (squareSyncCatalogItems)
  // No frontend auto-delete needed — the backend already removes sold items from the catalog

  const confirmDelete = async () => {
    if (!itemToDelete) return;

    setDeletingId(itemToDelete.catalog_object_id);
    try {
      // Call the delete function with catalog object ID
      await base44.functions.invoke('squareDeleteCodItem', {
        catalogObjectId: itemToDelete.catalog_object_id,
        transactionId: itemToDelete.transaction_id,
        reason: 'manual_delete'
      });

      // Remove from local state
      setCatalogItems(prev => prev.filter(i => i.catalog_object_id !== itemToDelete.catalog_object_id));

      toast.success('COD item deleted from Square');
    } catch (err) {
      console.error('Delete failed:', err);
      toast.error('Failed to delete: ' + err.message);
    } finally {
      setDeletingId(null);
      setItemToDelete(null);
    }
  };

  // Filter items based on user role and selected driver filter
  const filteredCatalogItems = React.useMemo(() => {
    if (!currentUser) return [];
    
    const userIsAppOwner = isAppOwner(currentUser);

    let items = [];

    // Admins see ALL items, regardless of location assignment
    if (userIsAppOwner) {
      if (selectedDriverFilter && selectedDriverFilter !== 'all') {
        // Filter by selected driver's locations
        const driver = drivers.find(d => d.id === selectedDriverFilter);
        const driverLocationIds = driver?.square_location_ids || [];

        // Map SquareLocationConfig IDs to square_location_id values
        const squareLocationIds = locationConfigs
          .filter(c => driverLocationIds.includes(c.id))
          .map(c => c.square_location_id);

        items = catalogItems.filter(item => 
          squareLocationIds.includes(item.location_id)
        );
      } else {
        // "All Drivers" - show everything
        items = catalogItems;
      }
    } else {
      // Non-admins see only their assigned locations
      const currentAppUser = drivers.find(d => d.user_id === currentUser.id);
      const driverLocationIds = currentAppUser?.square_location_ids || [];

      // Map SquareLocationConfig IDs to square_location_id values
      const squareLocationIds = locationConfigs
        .filter(c => driverLocationIds.includes(c.id))
        .map(c => c.square_location_id);

      items = catalogItems.filter(item => 
        squareLocationIds.includes(item.location_id)
      );
    }

    items = items.filter(item => {
      const linkedDelivery = deliveries.find(d => d?.id === item.delivery_id);
      if (linkedDelivery?.status === 'pending') return false;
      const soldInSquare = hasBeenSoldInSquare(item);
      return !item.is_sold && !soldInSquare;
    });

    // Sort: by driver (sort_order), then item name, then store
    return items.sort((a, b) => {
      const aDrivers = getDriversForLocation(a.location_id).sort((d1, d2) => (d1.sort_order ?? Infinity) - (d2.sort_order ?? Infinity));
      const bDrivers = getDriversForLocation(b.location_id).sort((d1, d2) => (d1.sort_order ?? Infinity) - (d2.sort_order ?? Infinity));
      
      // Compare first driver by sort_order
      const aFirstDriverOrder = aDrivers[0]?.sort_order ?? Infinity;
      const bFirstDriverOrder = bDrivers[0]?.sort_order ?? Infinity;
      if (aFirstDriverOrder !== bFirstDriverOrder) {
        return aFirstDriverOrder - bFirstDriverOrder;
      }
      
      // Compare item name
      if (a.name !== b.name) {
        return a.name.localeCompare(b.name);
      }
      
      // Compare store
      const aConfig = locationConfigs.find(c => c.square_location_id === a.location_id);
      const bConfig = locationConfigs.find(c => c.square_location_id === b.location_id);
      const aStore = stores.find(s => s.square_location_config_id === aConfig?.id);
      const bStore = stores.find(s => s.square_location_config_id === bConfig?.id);
      const aStoreName = aStore?.name || aConfig?.name || '';
      const bStoreName = bStore?.name || bConfig?.name || '';
      return aStoreName.localeCompare(bStoreName);
    });
  }, [catalogItems, currentUser, selectedDriverFilter, locationConfigs, drivers, soldCatalogItems, deliveries, stores, patients]);

  const selectedDriverUserIds = React.useMemo(() => {
    if (selectedDriverFilter && selectedDriverFilter !== 'all') {
      const selectedDriver = drivers.find(driver => driver?.id === selectedDriverFilter);
      return new Set(selectedDriver?.user_id ? [selectedDriver.user_id] : []);
    }
    return new Set((drivers || []).map(driver => driver?.user_id).filter(Boolean));
  }, [drivers, selectedDriverFilter]);

  const lookbackStart = React.useMemo(() => {
    const date = new Date();
    date.setDate(date.getDate() - Number(selectedDaysRange || 30));
    date.setHours(0, 0, 0, 0);
    return date;
  }, [selectedDaysRange]);

  const isTransferTransaction = (transaction) => {
    const label = `${transaction?.item_name || ''} ${transaction?.delivery_id || ''}`.toLowerCase();
    return transaction?.type === 'transfer' || label.includes('transfer') || label.includes('interstore') || label.includes('inter-store');
  };

  const activeCityIds = React.useMemo(() => {
    const source = currentAppUser || currentUser;
    if (Array.isArray(source?.city_ids) && source.city_ids.length > 0) {
      return source.city_ids.filter(Boolean);
    }
    return source?.city_id ? [source.city_id] : [];
  }, [currentAppUser, currentUser]);

  const availableStoresForFilter = React.useMemo(() => {
    const cityFilteredStores = activeCityIds.length > 0
      ? stores.filter((store) => activeCityIds.includes(store?.city_id))
      : stores;
    return [...cityFilteredStores].sort((a, b) => (a?.sort_order ?? Infinity) - (b?.sort_order ?? Infinity));
  }, [stores, activeCityIds]);

  const visibleStoreIds = React.useMemo(() => {
    const scopedStores = selectedStoreFilter && selectedStoreFilter !== 'all'
      ? availableStoresForFilter.filter((store) => store?.id === selectedStoreFilter)
      : availableStoresForFilter;
    return new Set(scopedStores.map((store) => store?.id).filter(Boolean));
  }, [availableStoresForFilter, selectedStoreFilter]);

  const visibleLocationIds = React.useMemo(() => {
    const configIds = new Set(
      stores
        .filter((store) => visibleStoreIds.has(store?.id))
        .map((store) => store?.square_location_config_id)
        .filter(Boolean)
    );

    return new Set(
      locationConfigs
        .filter((config) => configIds.has(config?.id))
        .map((config) => config?.square_location_id)
        .filter(Boolean)
    );
  }, [locationConfigs, stores, visibleStoreIds]);

  const driverScopedLocationIds = React.useMemo(() => {
    if (currentUser && isAppOwner(currentUser)) {
      if (!selectedDriverFilter || selectedDriverFilter === 'all') return null;
      const selectedDriver = drivers.find((driver) => driver?.id === selectedDriverFilter);
      const configIds = new Set((selectedDriver?.square_location_ids || []).filter(Boolean));
      return new Set(
        locationConfigs
          .filter((config) => configIds.has(config?.id))
          .map((config) => config?.square_location_id)
          .filter(Boolean)
      );
    }

    const configIds = new Set((currentAppUser?.square_location_ids || []).filter(Boolean));
    if (configIds.size === 0) return null;
    return new Set(
      locationConfigs
        .filter((config) => configIds.has(config?.id))
        .map((config) => config?.square_location_id)
        .filter(Boolean)
    );
  }, [currentUser, currentAppUser, drivers, selectedDriverFilter, locationConfigs]);

  const filteredDeliveryRows = React.useMemo(() => {
    return (deliveries || [])
      .filter((delivery) => {
        if (!delivery || !delivery.patient_id) return false;
        if (Number(delivery.cod_total_amount_required || 0) <= 0) return false;
        if (!visibleStoreIds.has(delivery.store_id)) return false;
        if (delivery.delivery_date && new Date(`${delivery.delivery_date}T00:00:00`) < lookbackStart) return false;
        if (selectedDriverUserIds.size === 0) return false;
        return selectedDriverUserIds.has(delivery.driver_id);
      })
      .sort((a, b) => {
        const dateCompare = String(b.delivery_date || '').localeCompare(String(a.delivery_date || ''));
        if (dateCompare !== 0) return dateCompare;
        return String(a.delivery_time_start || '').localeCompare(String(b.delivery_time_start || ''));
      })
      .map((delivery) => {
        const patient = patients.find((p) => p?.id === delivery.patient_id || p?.patient_id === delivery.patient_id);
        const store = stores.find((s) => s?.id === delivery.store_id);
        const config = locationConfigs.find((c) => c?.id === store?.square_location_config_id);
        if (!config?.square_location_id) return null;
        const linkedCatalog = catalogItems.find((item) => item?.delivery_id === delivery.id);
        const hasMatch = hasMatchingSquareTransaction(delivery, config.square_location_id);
        return {
          id: delivery.id,
          itemName: patient?.full_name || delivery.delivery_id || 'Unknown Delivery',
          amount: Number(delivery.cod_total_amount_required || 0),
          storeName: store?.name || 'Unknown',
          locationId: config.square_location_id,
          catalogId: linkedCatalog?.catalog_object_id || '—',
          deliveryDate: delivery.delivery_date,
          subtext: delivery.driver_name || null,
          actions: hasMatch ? (
            <Badge className="border border-emerald-300 bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
              Matched
            </Badge>
          ) : (
            <Badge className="border border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-100">
              No Match
            </Badge>
          )
        };
      })
      .filter(Boolean);
  }, [deliveries, visibleStoreIds, lookbackStart, selectedDriverUserIds, patients, stores, locationConfigs, catalogItems, allTransactions]);

  const filteredTransactionRows = React.useMemo(() => {
    return (allTransactions || [])
      .filter((transaction) => {
        if (!transaction || isTransferTransaction(transaction)) return false;
        if (transaction.type !== 'collection') return false;
        if (!['completed', 'refunded'].includes(transaction.status)) return false;
        const transactionDate = new Date(transaction.created_date || transaction.updated_date || 0);
        if (!(transactionDate instanceof Date) || Number.isNaN(transactionDate.getTime()) || transactionDate < lookbackStart) return false;
        const storeMatch = transaction.store_id ? visibleStoreIds.has(transaction.store_id) : visibleLocationIds.has(transaction.location_id);
        if (!storeMatch) return false;
        if (selectedDriverFilter && selectedDriverFilter !== 'all') {
          if (selectedDriverUserIds.size === 0) return false;
          return selectedDriverUserIds.has(transaction.driver_id);
        }
        if (driverScopedLocationIds && driverScopedLocationIds.size > 0) {
          return driverScopedLocationIds.has(transaction.location_id) || selectedDriverUserIds.has(transaction.driver_id);
        }
        return true;
      })
      .map((transaction) => {
        const config = locationConfigs.find((c) => c?.square_location_id === transaction.location_id);
        const store = stores.find((s) => s?.id === transaction.store_id) || stores.find((s) => s?.square_location_config_id === config?.id);
        const matchedTransactionDate = (() => {
          const rawDate = transaction.created_date || transaction.updated_date;
          if (!rawDate) return null;
          return format(new Date(rawDate), 'yyyy-MM-dd');
        })();
        const matchedAmountCents = Math.round(Number(transaction.amount || 0) * 100);
        const matchedDelivery = (deliveries || []).find((delivery) => {
          if (!delivery || !store?.id) return false;
          if (delivery.store_id !== store.id) return false;
          if (delivery.delivery_date !== matchedTransactionDate) return false;
          return Math.round(Number(delivery.cod_total_amount_required || 0) * 100) === matchedAmountCents;
        });
        const collectedByName = matchedDelivery?.driver_name || drivers.find((driver) => driver?.user_id === matchedDelivery?.driver_id)?.user_name || null;

        return {
          id: transaction.id,
          itemName: transaction.item_name || transaction.square_payment_id || 'Square Transaction',
          amount: Number(transaction.amount || 0),
          storeName: store?.name || config?.name || 'Unknown',
          locationId: transaction.location_id || '—',
          catalogId: transaction.square_catalog_object_id || '—',
          deliveryDate: matchedTransactionDate || parseSquareItemName(transaction.item_name)?.deliveryDate || transaction.created_date,
          subtext: collectedByName ? `Collected by ${collectedByName}` : (transaction.payment_method || transaction.status || null),
          notes: transaction.raw_square_data?.note || transaction.raw_square_data?.notes || null,
          actions: (
            <div className="flex flex-wrap gap-1 justify-end">
              {getTypeBadge(transaction.type)}
              {getStatusBadge(transaction.status)}
              {transaction.payment_method ? getPaymentMethodBadge(transaction.payment_method) : null}
            </div>
          )
        };
      })
      .sort((a, b) => String(b.deliveryDate || '').localeCompare(String(a.deliveryDate || '')));
  }, [allTransactions, lookbackStart, visibleStoreIds, visibleLocationIds, selectedDriverFilter, selectedDriverUserIds, driverScopedLocationIds, locationConfigs, stores, deliveries, drivers]);

  const filteredCatalogRows = React.useMemo(() => {
    return (catalogItems || [])
      .filter((item) => {
        if (driverScopedLocationIds && !driverScopedLocationIds.has(item.location_id)) return false;
        const config = locationConfigs.find((c) => c?.square_location_id === item.location_id);
        const store = stores.find((s) => s?.id === item.store_id) || stores.find((s) => s?.square_location_config_id === config?.id);
        return store ? visibleStoreIds.has(store.id) : visibleLocationIds.has(item.location_id);
      })
      .map((item) => {
        const config = locationConfigs.find((c) => c?.square_location_id === item.location_id);
        const store = stores.find((s) => s?.id === item.store_id) || stores.find((s) => s?.square_location_config_id === config?.id);
        return {
          id: item.catalog_object_id || item.id,
          itemName: item.name || item.item_name || 'Catalog Item',
          amount: Number(item.price_dollars || 0),
          storeName: store?.name || config?.name || 'Unknown',
          locationId: item.location_id || '—',
          catalogId: item.catalog_object_id || item.id || '—',
          deliveryDate: item.delivery_date || parseSquareItemName(item.name || item.item_name)?.deliveryDate,
          subtext: item.description || null,
          actions: (
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setItemToDelete(item);
              }}
              disabled={deletingId === item.catalog_object_id}
              className="text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              {deletingId === item.catalog_object_id ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
            </Button>
          )
        };
      })
      .sort((a, b) => String(b.deliveryDate || '').localeCompare(String(a.deliveryDate || '')));
  }, [catalogItems, locationConfigs, stores, visibleStoreIds, visibleLocationIds, driverScopedLocationIds, deletingId]);

  const reconciliationRows = React.useMemo(() => {
    const normalizeDate = (value) => {
      if (!value) return '';
      if (typeof value === 'string' && value.includes('T')) return value.slice(0, 10);
      return String(value).slice(0, 10);
    };

    const deliverySignature = (row) => `${row.locationId || '—'}::${Math.round(Number(row.amount || 0) * 100)}::${normalizeDate(row.deliveryDate)}`;
    const transactionSignature = (row) => `${row.locationId || '—'}::${Math.round(Number(row.amount || 0) * 100)}::${normalizeDate(row.deliveryDate)}`;

    const transactionsBySignature = filteredTransactionRows.reduce((acc, row) => {
      const key = transactionSignature(row);
      if (!acc.has(key)) acc.set(key, []);
      acc.get(key).push(row);
      return acc;
    }, new Map());

    const usedTransactionIds = new Set();
    const comparedRows = [];

    filteredDeliveryRows.forEach((deliveryRow) => {
      const key = deliverySignature(deliveryRow);
      const candidates = transactionsBySignature.get(key) || [];
      const matchedTransaction = candidates.find((transactionRow) => !usedTransactionIds.has(transactionRow.id));

      if (matchedTransaction) {
        usedTransactionIds.add(matchedTransaction.id);
        return;
      }

      comparedRows.push({
        ...deliveryRow,
        subtext: 'Delivery has no matching Square transaction',
        actions: (
          <Badge className="border border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-100">
            Missing Square Tx
          </Badge>
        )
      });
    });

    return comparedRows.sort((a, b) => String(b.deliveryDate || '').localeCompare(String(a.deliveryDate || '')));
  }, [filteredDeliveryRows, filteredTransactionRows]);

  const applyCatalogRealtimeToUI = React.useCallback((event) => {
    if (!event) return;

    setCatalogItems((prev) => {
      if (event.type === 'delete') {
        return prev.filter((item) => item?.id !== event.id && item?.catalog_object_id !== event.id);
      }

      const nextItem = mapCatalogRecordToUIItem(event.data || {});
      const existingIndex = prev.findIndex((item) => item?.id === nextItem.id || item?.catalog_object_id === nextItem.catalog_object_id);
      if (existingIndex === -1) {
        return [nextItem, ...prev];
      }

      const next = [...prev];
      next[existingIndex] = { ...next[existingIndex], ...nextItem };
      return next;
    });
  }, [mapCatalogRecordToUIItem]);

  const applyTransactionRealtimeToUI = React.useCallback((event) => {
    if (!event) return;

    setAllTransactions((prev) => {
      let nextTransactions = prev;

      if (event.type === 'delete') {
        nextTransactions = prev.filter((item) => item?.id !== event.id);
      } else {
        const nextTransaction = event.data || {};
        const existingIndex = prev.findIndex((item) => item?.id === nextTransaction.id);
        if (existingIndex === -1) {
          nextTransactions = [nextTransaction, ...prev];
        } else {
          nextTransactions = [...prev];
          nextTransactions[existingIndex] = { ...nextTransactions[existingIndex], ...nextTransaction };
        }
      }

      setSoldCatalogItems(nextTransactions.filter((tx) => ['completed', 'refunded'].includes(tx.status)));
      return nextTransactions;
    });
  }, []);

  const codDeliveriesCount = React.useMemo(() => {
    return deliveries.filter(delivery => {
      if (!delivery || Number(delivery.cod_total_amount_required || 0) <= 0) return false;
      if (delivery.delivery_date && new Date(`${delivery.delivery_date}T00:00:00`) < lookbackStart) return false;
      if (selectedDriverUserIds.size === 0) return false;
      return selectedDriverUserIds.has(delivery.driver_id);
    }).length;
  }, [deliveries, lookbackStart, selectedDriverUserIds]);

  const collectedCodTypeBreakdown = React.useMemo(() => {
    const counts = { Cash: 0, Debit: 0, Credit: 0, Check: 0 };

    deliveries.forEach((delivery) => {
      if (!delivery || Number(delivery.cod_total_amount_required || 0) <= 0) return;
      if (delivery.delivery_date && new Date(`${delivery.delivery_date}T00:00:00`) < lookbackStart) return;
      if (selectedDriverUserIds.size === 0 || !selectedDriverUserIds.has(delivery.driver_id)) return;

      const codPayments = Array.isArray(delivery.cod_payments) ? delivery.cod_payments : [];
      if (codPayments.length > 0) {
        const deliveryTypes = new Set(
          codPayments
            .filter((payment) => Number(payment?.amount || 0) > 0)
            .map((payment) => payment?.type)
            .filter((type) => ['Cash', 'Debit', 'Credit', 'Check'].includes(type))
        );
        deliveryTypes.forEach((type) => {
          counts[type] += 1;
        });
        return;
      }

      if (['Cash', 'Debit', 'Credit', 'Check'].includes(delivery.cod_payment_type)) {
        counts[delivery.cod_payment_type] += 1;
      }
    });

    return counts;
  }, [deliveries, lookbackStart, selectedDriverUserIds]);

  const filteredCardSpendCount = React.useMemo(() => {
    return allTransactions.filter(transaction => {
      if (!transaction || isTransferTransaction(transaction)) return false;
      const transactionDate = new Date(transaction.created_date || transaction.updated_date || 0);
      if (!(transactionDate instanceof Date) || Number.isNaN(transactionDate.getTime()) || transactionDate < lookbackStart) return false;
      if (transaction.type !== 'collection' || !['completed', 'refunded'].includes(transaction.status)) return false;
      if (selectedDriverFilter && selectedDriverFilter !== 'all') {
        if (selectedDriverUserIds.size === 0 || !selectedDriverUserIds.has(transaction.driver_id)) return false;
      } else if (driverScopedLocationIds && driverScopedLocationIds.size > 0) {
        if (!driverScopedLocationIds.has(transaction.location_id) && !selectedDriverUserIds.has(transaction.driver_id)) return false;
      }
      return true;
    }).length;
  }, [allTransactions, lookbackStart, selectedDriverFilter, selectedDriverUserIds, driverScopedLocationIds]);

  const filteredSalesCount = React.useMemo(() => {
    return soldCatalogItems.filter(transaction => {
      if (!transaction || isTransferTransaction(transaction)) return false;
      const transactionDate = new Date(transaction.created_date || transaction.updated_date || 0);
      if (!(transactionDate instanceof Date) || Number.isNaN(transactionDate.getTime()) || transactionDate < lookbackStart) return false;
      if (selectedDriverUserIds.size === 0) return false;
      return selectedDriverUserIds.has(transaction.driver_id);
    }).length;
  }, [soldCatalogItems, lookbackStart, selectedDriverUserIds]);

  const viewCounts = {
    deliveries: filteredDeliveryRows.length,
    transactions: filteredTransactionRows.length,
    catalog: filteredCatalogRows.length,
    reconciliation: reconciliationRows.length
  };

  const activeViewStats = React.useMemo(() => {
    if (activeView === 'deliveries') {
      return {
        primaryLabel: 'COD Deliveries',
        primaryValue: filteredDeliveryRows.length,
        amountLabel: 'Total COD',
        amountValue: filteredDeliveryRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
        locationLabel: 'City Stores',
        locationValue: visibleStoreIds.size
      };
    }

    if (activeView === 'transactions') {
      return {
        primaryLabel: 'Transactions',
        primaryValue: filteredTransactionRows.length,
        amountLabel: 'Collected Amount',
        amountValue: filteredTransactionRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
        locationLabel: 'Square Locations',
        locationValue: new Set(filteredTransactionRows.map((row) => row.locationId).filter(Boolean)).size
      };
    }

    if (activeView === 'reconciliation') {
      return {
        primaryLabel: 'Unmatched Deliveries',
        primaryValue: reconciliationRows.length,
        amountLabel: 'Unmatched Amount',
        amountValue: reconciliationRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
        locationLabel: 'Square Locations',
        locationValue: new Set(reconciliationRows.map((row) => row.locationId).filter(Boolean)).size
      };
    }

    return {
      primaryLabel: 'Catalog Items',
      primaryValue: filteredCatalogRows.length,
      amountLabel: 'Total Amount',
      amountValue: filteredCatalogRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
      locationLabel: 'Square Locations',
      locationValue: new Set(filteredCatalogRows.map((row) => row.locationId).filter(Boolean)).size
    };
  }, [activeView, filteredCatalogRows, filteredDeliveryRows, filteredTransactionRows, reconciliationRows, visibleStoreIds]);

  return (
    <div className="p-4 md:p-6 bg-background text-foreground w-full min-h-screen md:h-screen flex flex-col overflow-hidden" style={{ paddingBottom: navHeight ? navHeight + 8 : undefined }}>
    {/* Header */}
    <div className="flex flex-col gap-4 mb-6">
      <div className="flex items-center gap-3">
        <CreditCard className="w-6 md:w-8 h-6 md:h-8 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div className="min-w-0">
          <h1 className="text-xl md:text-2xl font-bold text-slate-900 dark:text-slate-50">Square COD</h1>
          <p className="text-xs md:text-sm text-slate-600 dark:text-slate-400">Track and manage COD payments</p>
        </div>
      </div>
      
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-row flex-wrap items-center gap-2 md:gap-3">
          {currentUser && isAppOwner(currentUser) && drivers.length > 0 && (
            <Select value={selectedDriverFilter} onValueChange={setSelectedDriverFilter}>
              <SelectTrigger className="w-[150px] md:w-[200px] text-sm">
                <SelectValue placeholder="All Drivers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Drivers</SelectItem>
                {drivers.map(driver => (
                  <SelectItem key={driver.id} value={driver.id}>
                    {driver.user_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select value={selectedStoreFilter} onValueChange={setSelectedStoreFilter}>
            <SelectTrigger className="w-[150px] md:w-[200px] text-sm">
              <SelectValue placeholder="All Stores" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Stores</SelectItem>
              {availableStoresForFilter.map(store => (
                <SelectItem key={store.id} value={store.id}>
                  {store.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button onClick={syncFromSquare} disabled={isLoading || isSyncing} className="gap-2 text-sm">
            <CloudDownload className={`w-4 h-4 flex-shrink-0 ${isSyncing ? 'animate-pulse' : ''}`} />
            <span className="hidden sm:inline">{isSyncing ? 'Syncing...' : 'Sync'}</span>
            <span className="sm:hidden">{isSyncing ? 'Syncing' : 'Sync'}</span>
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 md:gap-3">
          {activeView === 'reconciliation' && (
            <Button
              onClick={syncReconciliationToCatalog}
              disabled={isLoading || isSyncing || isUpdatingReconciliationCatalog || reconciliationRows.length === 0}
              className="gap-2 text-sm"
            >
              <CloudDownload className={`w-4 h-4 flex-shrink-0 ${(isSyncing || isUpdatingReconciliationCatalog) ? 'animate-pulse' : ''}`} />
              <span className="hidden sm:inline">{isUpdatingReconciliationCatalog ? 'Updating Catalog...' : 'Update Catalog'}</span>
              <span className="sm:hidden">{isUpdatingReconciliationCatalog ? 'Updating...' : 'Update'}</span>
            </Button>
          )}
          <Select value={selectedDaysRange} onValueChange={setSelectedDaysRange}>
            <SelectTrigger className="w-[120px] text-sm">
              <SelectValue placeholder="Days" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">7 Days</SelectItem>
              <SelectItem value="14">14 Days</SelectItem>
              <SelectItem value="21">21 Days</SelectItem>
              <SelectItem value="28">28 Days</SelectItem>
              <SelectItem value="45">45 Days</SelectItem>
              <SelectItem value="60">60 Days</SelectItem>
            </SelectContent>
          </Select>
          <SquareCodViewSwitcher activeView={activeView} onChange={setActiveView} counts={viewCounts} />
        </div>
      </div>
    </div>

          {/* Sync Status Indicator */}
          {syncStatus && (
            <div className="mb-2">
              <SyncStatusIndicator 
                syncStatus={syncStatus}
                isSyncing={isSyncing}
                error={error}
                codDeliveryCount={codDeliveriesCount}
                catalogItemCount={filteredCatalogItems.length}
                cardSpendCount={filteredCardSpendCount}
                salesCount={filteredSalesCount}
                collectedCodTypeBreakdown={collectedCodTypeBreakdown}
              />
            </div>
          )}

          {/* Background Sync Progress Bar */}
          {bgSyncProgress.stage !== 'idle' && (
            <div className="mb-6 md:mb-8">
              <BackgroundSyncProgressBar progress={bgSyncProgress} />
            </div>
          )}

          {!syncStatus && bgSyncProgress.stage === 'idle' && <div className="mb-4" />}

          {lastCleanup && (
            <div className="mb-6 md:mb-8">
              <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700">
                <CardContent className="p-3 md:p-4">
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <CheckCircle className="w-4 h-4 text-emerald-600" />
                    <span className="font-semibold">Last Cleanup</span>
                    <span className="text-slate-600 dark:text-slate-400">Processed: {lastCleanup.processed}</span>
                    <span className="text-slate-600 dark:text-slate-400">Deleted OK: {(lastCleanup.counts['delete']?.ok) || 0}</span>
                    <span className="text-slate-600 dark:text-slate-400">Upserted OK: {(lastCleanup.counts['upsert']?.ok) || 0}</span>
                    {(((lastCleanup.counts['delete']?.failed) || 0) + ((lastCleanup.counts['upsert']?.failed) || 0)) > 0 && (
                      <span className="text-red-600 dark:text-red-400">Failed: {((lastCleanup.counts['delete']?.failed) || 0) + ((lastCleanup.counts['upsert']?.failed) || 0)}</span>
                    )}
                    <span className="ml-auto text-xs flex items-center gap-1 text-slate-500 dark:text-slate-400">
                      <Clock className="w-3 h-3" />
                      {new Date(lastCleanup.finishedAt || lastCleanup.startedAt).toLocaleString()}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Stats Cards */}
          <div className="grid grid-cols-3 gap-2 md:gap-4 mb-6 md:mb-8">
          <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700">
          <CardContent className="p-3 md:p-4">
            <div className="text-xs md:text-sm text-slate-600 dark:text-slate-400">{activeViewStats.primaryLabel}</div>
            <div className="text-xl md:text-2xl font-bold text-slate-900 dark:text-slate-50">{activeViewStats.primaryValue}</div>
          </CardContent>
          </Card>
          <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700">
          <CardContent className="p-3 md:p-4">
            <div className="text-xs md:text-sm text-slate-600 dark:text-slate-400">{activeViewStats.amountLabel}</div>
            <div className="text-xl md:text-2xl font-bold text-emerald-600 dark:text-emerald-400">${activeViewStats.amountValue.toFixed(2)}</div>
          </CardContent>
          </Card>
          <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700">
          <CardContent className="p-3 md:p-4">
            <div className="text-xs md:text-sm text-slate-600 dark:text-slate-400">{activeViewStats.locationLabel}</div>
            <div className="text-xl md:text-2xl font-bold text-blue-600 dark:text-blue-400">{activeViewStats.locationValue}</div>
          </CardContent>
          </Card>
          </div>

      {/* Location Summary Cards */}
      {activeView === 'catalog' && currentUser && isAppOwner(currentUser) && locationConfigs.length > 0 && (
        <div>
          <h2 className="text-base md:text-lg font-semibold mb-4 text-slate-900 dark:text-slate-50">By Location</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-none md:auto-cols-fr md:grid-flow-col gap-2 md:gap-4 mb-6 md:mb-8">
            {locationConfigs
              .filter((config) => visibleLocationIds.has(config.square_location_id))
              .sort((a, b) => {
                const storeA = stores.find(s => s.square_location_config_id === a.id);
                const storeB = stores.find(s => s.square_location_config_id === b.id);
                return (storeA?.sort_order ?? Infinity) - (storeB?.sort_order ?? Infinity);
              })
              .map(config => {
                const locationItems = filteredCatalogRows.filter(item => item.locationId === config.square_location_id);
                const codTotal = locationItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);
                const store = stores.find(s => s.square_location_config_id === config.id);
                const storeColor = store ? getStoreColor(store.id) : null;
                return (
                  <LocationSummaryCard
                    key={config.id}
                    location={{ name: config?.name || store?.name || 'Unknown', square_location_id: config.square_location_id }}
                    codTotal={codTotal}
                    itemCount={locationItems.length}
                    onClick={() => setSelectedLocation(config)}
                  />
                );
              })}
          </div>
        </div>
      )}

      {error && (
        <div className="p-3 md:p-4 rounded-lg mb-6 text-sm md:text-base bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800">
          Error: {error}
        </div>
      )}

      {activeView === 'reconciliation' ? (
        <SquareCodDatasetTable
          title="Reconciliation"
          rows={reconciliationRows}
          isLoading={isLoading}
          emptyTitle="No unmatched deliveries"
          emptyDescription="Deliveries that do not have a matching transaction by amount and Square location will appear here."
          showLocationColumn={currentUser && isAppOwner(currentUser)}
          navHeight={navHeight}
        />
      ) : activeView === 'deliveries' ? (
        <SquareCodDatasetTable
          title="In App COD Deliveries"
          rows={filteredDeliveryRows}
          isLoading={isLoading}
          emptyTitle="No COD deliveries found"
          emptyDescription="Recent COD deliveries for the active city will appear here."
          showLocationColumn={currentUser && isAppOwner(currentUser)}
          navHeight={navHeight}
        />
      ) : activeView === 'transactions' ? (
        <SquareCodDatasetTable
          title="Square Transactions"
          rows={filteredTransactionRows}
          isLoading={isLoading}
          emptyTitle="No Square transactions found"
          emptyDescription="Recent Square transactions for the active city will appear here."
          showLocationColumn={currentUser && isAppOwner(currentUser)}
          navHeight={navHeight}
        />
      ) : (
        <SquareCodDatasetTable
          title="Square Catalog Items"
          rows={filteredCatalogRows}
          isLoading={isLoading}
          emptyTitle="No Square catalog items found"
          emptyDescription="Recent Square catalog items for the active city will appear here."
          showLocationColumn={currentUser && isAppOwner(currentUser)}
          navHeight={navHeight}
        />
      )}

      {/* Transaction History Panel */}
      {selectedLocation && (
        <TransactionHistoryPanel
          location={selectedLocation}
          transactions={allTransactions}
          drivers={drivers}
          catalogItems={catalogItems}
          onClose={() => setSelectedLocation(null)}
        />
      )}

      {/* COD Item Detail Modal */}
      {selectedCODItem && (
        <CODItemDetailModal
          item={selectedCODItem}
          locationConfigs={locationConfigs}
          stores={stores}
          transactions={allTransactions}
          drivers={drivers}
          deliveries={deliveries}
          onClose={() => setSelectedCODItem(null)}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!itemToDelete} onOpenChange={(open) => !open && setItemToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete COD Item</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{itemToDelete?.name}"? This will permanently remove it from Square.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-red-600 hover:bg-red-700">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}