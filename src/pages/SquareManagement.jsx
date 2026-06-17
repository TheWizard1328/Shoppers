import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useAppData } from "@/components/utils/AppDataContext";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { CheckCircle, Clock, CreditCard, Loader2, CloudDownload, RefreshCw } from "lucide-react";
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
    currentUser: appCurrentUser,
    appUsers: appDataAppUsers,
    stores: appDataStores,
    patients: appDataPatients
  } = useAppData();
  const {
    syncSquareCODSnapshotOffline,
    getCatalogItemsOffline,
    getPaymentTransactionsOffline,
    getSquareCODSyncStatus,
    purgeSquareCODOfflineDataBeforeSync
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
  const [selectedDaysRange, setSelectedDaysRange] = useState(() => localStorage.getItem('square_cod_days_range') || '90');

  const [hasInitialLoadCompleted, setHasInitialLoadCompleted] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [selectedCODItem, setSelectedCODItem] = useState(null);
  const [allTransactions, setAllTransactions] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [activeView, setActiveView] = useState('deliveries');
  const [itemToDelete, setItemToDelete] = useState(null);
  const [soldCatalogItems, setSoldCatalogItems] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);
  const [lastCleanup] = useState(null);
  const [navHeight, setNavHeight] = useState(0);
  const [bgSyncProgress, setBgSyncProgress] = useState({ stage: 'idle' });
  const [isReconciling, setIsReconciling] = useState(false);
  const realtimeRefreshTimeoutRef = useRef(null);
  const lastRealtimeRefreshAtRef = useRef(0);
  const locationConfigsRef = useRef([]);
  const initialLoadKeyRef = useRef(null);
  const syncInFlightRef = useRef(false);
  const lastSyncAtRef = useRef(0);

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

  const loadSquareViewFromOffline = useCallback(async () => {
    const [offlineCatalog, offlineTransactions, updatedSyncStatus] = await Promise.all([
    getCatalogItemsOffline(),
    getPaymentTransactionsOffline(),
    getSquareCODSyncStatus()]
    );

    const sold = (offlineTransactions || []).filter((tx) => ['completed', 'refunded'].includes(tx.status));

    setCatalogItems([...(offlineCatalog || [])]);
    setSoldCatalogItems([...(sold || [])]);
    setAllTransactions([...(offlineTransactions || [])]);
    setSyncStatus(updatedSyncStatus ? { ...updatedSyncStatus } : updatedSyncStatus);

    return {
      items: offlineCatalog || [],
      transactions: offlineTransactions || [],
      sold
    };
  }, [getCatalogItemsOffline, getPaymentTransactionsOffline, getSquareCODSyncStatus]);

  const refreshOfflineSquareFromOnlineEntities = useCallback(async () => {
    const loadAllRecords = async (entityApi) => {
      const pageSize = 1000;
      let skip = 0;
      let allRecords = [];
      while (true) {
        const page = await entityApi.list('-updated_date', pageSize, skip);
        if (!page?.length) break;
        allRecords = allRecords.concat(page);
        if (page.length < pageSize) break;
        skip += pageSize;
      }
      return allRecords;
    };

    const [catalogRecords, transactionRecords] = await Promise.all([
      loadAllRecords(base44.entities.SquareCatalogItems),
      loadAllRecords(base44.entities.SquareTransaction)
    ]);

    await syncSquareCODSnapshotOffline({
      catalogItems: catalogRecords || [],
      transactions: transactionRecords || []
    });

    return {
      catalogRecords: catalogRecords || [],
      transactionRecords: transactionRecords || []
    };
  }, [syncSquareCODSnapshotOffline]);

  const loadDeliveriesFromOffline = useCallback(async (offlineDB, startDateStr, endDateStr) => {
    const allDeliveries = (await offlineDB.getAll(offlineDB.STORES.DELIVERIES)) || [];
    return allDeliveries.filter((delivery) => delivery && delivery.delivery_date >= startDateStr && delivery.delivery_date <= endDateStr);
  }, []);

  const getLocalDateString = useCallback((date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }, []);

  const getSourceWindow = useCallback(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - 90);
    return {
      startDateStr: getLocalDateString(startDate),
      endDateStr: getLocalDateString(today)
    };
  }, [getLocalDateString]);

  const loadSyncStatus = useCallback(async () => {
    try {
      const status = await getSquareCODSyncStatus();
      setSyncStatus(status);
      return status;
    } catch {
      return null;
    }
  }, [getSquareCODSyncStatus]);

  const mapCatalogRecordToUIItem = useCallback((record) => ({
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
    is_sold: false
  }), []);

  const loadReconciliationFromOffline = useCallback(async (offlineDB, startDateStr, endDateStr) => {
    const [windowDeliveries, allOfflineDeliveries, offlineCatalogSnapshot] = await Promise.all([
    loadDeliveriesFromOffline(offlineDB, startDateStr, endDateStr),
    offlineDB.getAll(offlineDB.STORES.DELIVERIES),
    loadSquareViewFromOffline()]
    );

    const deliveriesToUse = (windowDeliveries || []).length > 0 ? windowDeliveries || [] : allOfflineDeliveries || [];
    setDeliveries([...(deliveriesToUse || [])]);
    setCatalogItems([...(offlineCatalogSnapshot?.items || [])]);
    setAllTransactions([...(offlineCatalogSnapshot?.transactions || [])]);
    setSoldCatalogItems([...(offlineCatalogSnapshot?.sold || [])]);
  }, [loadDeliveriesFromOffline, loadSquareViewFromOffline]);

  const refreshUiFromOfflineOnly = useCallback(async () => {
    // loadReconciliationFromOffline already calls loadSquareViewFromOffline internally —
    // calling it again here was causing a double-write to catalogItems/transactions state.
    const { startDateStr, endDateStr } = getSourceWindow();
    const { offlineDB } = await import('@/components/utils/offlineDatabase');
    await loadReconciliationFromOffline(offlineDB, startDateStr, endDateStr);
    await loadSyncStatus();
  }, [getSourceWindow, loadReconciliationFromOffline, loadSyncStatus]);

  useEffect(() => {
    locationConfigsRef.current = locationConfigs || [];
  }, [locationConfigs]);

  const reconciliationRowsRef = useRef([]);
  const visibleStoreIdsRef = useRef(new Set());
  const selectedDriverUserIdsRef = useRef(new Set());

  const runReconcile = useCallback(async () => {
    setIsReconciling(true);
    try {
      const { offlineDB } = await import('@/components/utils/offlineDatabase');

      // Load all deliveries + transactions from offline DB — reconciliationRows useMemo does the matching
      const [allOfflineDeliveries, offlineCatalog, offlineTransactions] = await Promise.all([
        offlineDB.getAll(offlineDB.STORES.DELIVERIES),
        offlineDB.getAll(offlineDB.STORES.SQUARE_CATALOG_ITEMS),
        offlineDB.getAll(offlineDB.STORES.SQUARE_TRANSACTIONS),
      ]);

      setDeliveries([...(allOfflineDeliveries || [])]);
      setCatalogItems([...(offlineCatalog || [])]);
      setAllTransactions([...(offlineTransactions || [])]);
      setSoldCatalogItems([...(offlineTransactions || []).filter((tx) => ['completed', 'refunded'].includes(tx.status))]);

      toast.success('Reconciliation list updated');
    } catch (err) {
      toast.error('Reconcile failed: ' + err.message);
    } finally {
      setIsReconciling(false);
    }
  }, []);

  const syncFromSquare = async () => {
    const now = Date.now();
    if (syncInFlightRef.current || now - lastSyncAtRef.current < 30000) {
      return;
    }

    syncInFlightRef.current = true;
    lastSyncAtRef.current = now;
    setIsSyncing(true);
    setError(null);

    try {
      const { offlineDB } = await import('@/components/utils/offlineDatabase');

      // 1) Load from offline DB first
      await refreshUiFromOfflineOnly();

      const { startDateStr, endDateStr } = getSourceWindow();
      const offlineDeliveries = await loadDeliveriesFromOffline(offlineDB, startDateStr, endDateStr);
      if (offlineDeliveries.length > 0) {
        setDeliveries([...(offlineDeliveries || [])]);
      }

      // 2) Refresh UI immediately without clearing totals
      setIsLoading(false);

      // 5) Pull latest Square catalog + transactions from Square API
      let catalogError = null;
      let transactionError = null;
      let catalogRecords = [];
      let transactionRecords = [];
      try {
        const codResponse = await base44.functions.invoke('squareGetCODData', {
          forceDeliveryRefresh: true,
          daysBack: 90,
          mergeWithExisting: true
        });
        const codData = codResponse?.data || codResponse || {};
        catalogRecords = codData.catalogRecords || [];
        transactionRecords = codData.transactionRecords || [];
        const strippedDeliveries = Array.isArray(codData.deliveries)
          ? codData.deliveries.map(({ delivery_route_breadcrumbs, encoded_polyline, proof_photo_urls, signature_image_url, ...rest }) => rest)
          : [];

        const mergeRecords = async (store, freshRecords) => {
          const existing = (await offlineDB.getAll(store)) || [];
          const existingMap = new Map(existing.map((r) => [r.id, r]));
          (freshRecords || []).forEach((r) => { if (r?.id) existingMap.set(r.id, r); });
          await offlineDB.replaceAllRecords(store, Array.from(existingMap.values()));
          return Array.from(existingMap.values());
        };

        const mergedDeliveries = await mergeRecords(offlineDB.STORES.DELIVERIES, strippedDeliveries);

        await squareCODOfflineManager.saveCatalogItemsOffline(catalogRecords);
        await squareCODOfflineManager.savePaymentTransactionsOffline(transactionRecords);

        const [uiCatalog, uiTransactions] = await Promise.all([
          squareCODOfflineManager.getCatalogItemsOffline(),
          squareCODOfflineManager.getPaymentTransactionsOffline(),
        ]);

        setDeliveries([...(mergedDeliveries || [])]);
        setCatalogItems([...(uiCatalog || [])]);
        setAllTransactions([...(uiTransactions || [])]);
        setSoldCatalogItems([...(uiTransactions || []).filter((tx) => ['completed', 'refunded'].includes(tx.status))]);

      } catch (err) {
        transactionError = err;
      }

      if (transactionError || catalogError) {
        await loadSquareViewFromOffline();
        await loadSyncStatus();
      }
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
      window.dispatchEvent(new CustomEvent('offlineSyncComplete'));

      setIsSyncing(false);
      setIsLoading(false);
      toast.success('Square data synced locally');

      ;(async () => {
        try {
          const settledCatalogObjectIds = new Set(
            (transactionRecords || [])
              .filter((t) => ['completed', 'refunded'].includes(t?.status) && t?.square_catalog_object_id)
              .map((t) => t.square_catalog_object_id)
          );
          const itemsToClean = (catalogRecords || []).filter(
            (item) => item?.id && settledCatalogObjectIds.has(item.id)
          );
          if (!itemsToClean.length) return;

          const deletions = itemsToClean.map((item) => ({
            catalogObjectId: item.id,
            deliveryId: item.delivery_id || undefined,
            reason: 'collected_cleanup',
          }));

          await base44.functions.invoke('squareCodCore', {
            action: 'syncSquareCods',
            deletions,
          });

          const cleanResponse = await base44.functions.invoke('squareGetCODData', { daysBack: 90 });
          const cleanData = cleanResponse?.data || cleanResponse || {};
          await squareCODOfflineManager.saveCatalogItemsOffline(cleanData.catalogRecords || []);
          await squareCODOfflineManager.savePaymentTransactionsOffline(cleanData.transactionRecords || []);
          const [freshCatalog, freshTransactions] = await Promise.all([
            squareCODOfflineManager.getCatalogItemsOffline(),
            squareCODOfflineManager.getPaymentTransactionsOffline(),
          ]);
          setCatalogItems([...(freshCatalog || [])]);
          setAllTransactions([...(freshTransactions || [])]);
          setSoldCatalogItems([...(freshTransactions || []).filter((tx) => ['completed', 'refunded'].includes(tx.status))]);
        } catch (_) { /* background — never surface to user */ }
      })();

      let onlineSyncError = null;

      if (catalogError || transactionError) {
        const message = catalogError?.message || transactionError?.message || 'Square sync partially failed';
        console.error('[SquareManagement] Sync finished with issues', {
          catalogError: catalogError?.message || null,
          transactionError: transactionError?.message || null,
          onlineSyncError: onlineSyncError?.message || null,
        });
        setError(message);
        toast.error('Sync finished with issues: ' + message);
      } else if (onlineSyncError) {
        console.error('[SquareManagement] Background online sync issue', {
          onlineSyncError: onlineSyncError?.message || null,
        });
      }
    } catch (err) {
      setError(err.message);
      await refreshUiFromOfflineOnly();
      toast.error('Failed to sync: ' + err.message);
    } finally {
      syncInFlightRef.current = false;
      setIsSyncing(false);
      setIsLoading(false);
      await loadSyncStatus();
    }
  };

  useEffect(() => {
    localStorage.setItem('square_cod_days_range', selectedDaysRange);
  }, [selectedDaysRange]);

  // Immediately load deliveries, stores, and locationConfigs from offline DB on first mount
  // Mount-time hydration: load all Square COD data from offline DB immediately.
  // This runs BEFORE appCurrentUser arrives so the filter chain (locationConfigs,
  // stores, deliveries, catalogItems) is populated on first paint.
  useEffect(() => {
    (async () => {
      try {
        const { offlineDB } = await import('@/components/utils/offlineDatabase');
        const [allDeliveries, allLocationConfigs, allStores] = await Promise.all([
          offlineDB.getAll(offlineDB.STORES.DELIVERIES),
          offlineDB.getAll(offlineDB.STORES.SQUARE_LOCATION_CONFIGS),
          offlineDB.getAll(offlineDB.STORES.STORES),
        ]);
        // Hydrate all three — filter chain needs all three to show any rows.
        if ((allStores || []).length > 0) setStores(allStores);
        if ((allLocationConfigs || []).length > 0) {
          setLocationConfigs([...allLocationConfigs]);
          locationConfigsRef.current = allLocationConfigs;
          setLocationIds(allLocationConfigs.map((c) => c?.square_location_id).filter(Boolean));
        }
        if ((allDeliveries || []).length > 0) setDeliveries([...allDeliveries]);

        // Load via the offline manager so records are normalized the same way
        // as after a full syncFromSquare (mapCatalogEntityToUIItem applied).
        const [normalizedCatalog, normalizedTransactions] = await Promise.all([
          getCatalogItemsOffline(),
          getPaymentTransactionsOffline(),
        ]);
        if ((normalizedCatalog || []).length > 0) setCatalogItems([...normalizedCatalog]);
        if ((normalizedTransactions || []).length > 0) {
          setAllTransactions([...normalizedTransactions]);
          setSoldCatalogItems([...normalizedTransactions.filter((tx) => ['completed', 'refunded'].includes(tx?.status))]);
        }
      } catch (_) { /* non-critical — full sync fires shortly after */ }
    })();
  }, []); // runs once on mount

  // Seed stores as soon as appDataStores is available (even before appCurrentUser) — sink only, never clear
  useEffect(() => {
    const nextStores = (appDataStores || []).filter(Boolean);
    if (nextStores.length > 0) setStores(nextStores);
  }, [appDataStores]);

  // Always sync lookup data whenever appData changes (no early-return guard on stores length)
  useEffect(() => {
    if (!appCurrentUser) return;

    const syncLookupData = async () => {
      try {
        const { offlineDB } = await import('@/components/utils/offlineDatabase');
        const nextLocationConfigs = (await offlineDB.getAll(offlineDB.STORES.SQUARE_LOCATION_CONFIGS)) || [];
        const nextStores = (appDataStores || []).filter(Boolean);
        const nextPatients = (appDataPatients || []).filter(Boolean);
        const nextDrivers = (appDataAppUsers || [])
          .filter((user) => Array.isArray(user?.app_roles) && user.app_roles.includes('driver'))
          .sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
        const currentAppUserRecord = (appDataAppUsers || []).find((user) => user?.user_id === appCurrentUser?.id) || null;

        setCurrentUser(appCurrentUser || null);
        setCurrentAppUser(currentAppUserRecord);
        // SINK: never clear existing data with an empty array — only update if new data is non-empty
        if (nextStores.length > 0) setStores(nextStores);
        if (nextPatients.length > 0) setPatients(nextPatients);
        if (nextDrivers.length > 0) setDrivers(nextDrivers);
        if (nextLocationConfigs.length > 0) {
          setLocationConfigs(nextLocationConfigs);
          locationConfigsRef.current = nextLocationConfigs;
          setLocationIds(nextLocationConfigs.map((config) => config?.square_location_id).filter(Boolean));
        } else {
          // Keep whatever was already loaded from offline DB on mount
        }

        return { offlineDB, nextLocationConfigs };
      } catch (err) {
        console.error('Failed to sync lookup data:', err);
        return null;
      }
    };

    // First load: also load deliveries and trigger Square sync
    if (!initialLoadKeyRef.current) {
      // CRITICAL: Don't lock the initialLoadKey until we have locationConfigs.
      // appCurrentUser often arrives before appDataStores, which means locationConfigs
      // would be empty when the filter chain evaluates — filtering out every delivery row.
      // Wait until either the offline DB or appDataStores has produced configs.
      const configsReady = (locationConfigsRef.current || []).length > 0 || (appDataStores || []).length > 0;
      if (!configsReady) return; // re-runs when appDataStores arrives

      initialLoadKeyRef.current = true;
      (async () => {
        const result = await syncLookupData();
        if (!result) return;
        try {
          const { offlineDB } = result;
          const { startDateStr, endDateStr } = getSourceWindow();
          await loadReconciliationFromOffline(offlineDB, startDateStr, endDateStr);
          await loadSquareViewFromOffline();
          setIsLoading(false);
          setHasInitialLoadCompleted(true);
          await syncFromSquare();
          setBgSyncProgress({ stage: 'idle' });
        } catch (err) {
          console.error('Failed to load COD data:', err);
          setIsLoading(false);
        }
      })();
    } else {
      // Subsequent updates: just refresh lookup data so filters re-evaluate
      syncLookupData();
    }
  }, [appCurrentUser, appDataAppUsers, appDataStores, appDataPatients]);

  useEffect(() => {
    if (!hasInitialLoadCompleted) return;
    refreshUiFromOfflineOnly();
  }, [hasInitialLoadCompleted, refreshUiFromOfflineOnly]);

  useEffect(() => {
    if (!hasInitialLoadCompleted) return;

    let isActive = true;
    const scheduleLocalRealtimeRefresh = () => {
      const now = Date.now();
      if (now - lastRealtimeRefreshAtRef.current < 15000) return;
      if (realtimeRefreshTimeoutRef.current) clearTimeout(realtimeRefreshTimeoutRef.current);

      realtimeRefreshTimeoutRef.current = setTimeout(async () => {
        if (!isActive || isSyncing || isReconciling || syncInFlightRef.current) return;
        lastRealtimeRefreshAtRef.current = Date.now();
        await refreshOfflineSquareFromOnlineEntities();
        await refreshUiFromOfflineOnly();
      }, 800);
    };

    const unsubscribeCatalogItems = base44.entities.SquareCatalogItems.subscribe(scheduleLocalRealtimeRefresh);
    const unsubscribeTransactions = base44.entities.SquareTransaction.subscribe(scheduleLocalRealtimeRefresh);

    return () => {
      isActive = false;
      if (realtimeRefreshTimeoutRef.current) clearTimeout(realtimeRefreshTimeoutRef.current);
      unsubscribeCatalogItems?.();
      unsubscribeTransactions?.();
    };
  }, [hasInitialLoadCompleted, isSyncing, isReconciling, refreshOfflineSquareFromOnlineEntities, refreshUiFromOfflineOnly]);

  // Resolve a SquareLocationConfig for a store by name match OR legacy ID
  const getConfigForStore = useCallback((store) => {
    if (!store) return null;
    return locationConfigs.find((c) => c?.store_name === store.name)
      || locationConfigs.find((c) => store.square_location_config_id && c?.id === store.square_location_config_id)
      || null;
  }, [locationConfigs]);

  // Resolve a store for a config by matching store.name === config.store_name
  const getStoreForConfig = useCallback((config) => {
    if (!config?.store_name) return null;
    return stores.find((s) => s?.name === config.store_name) || null;
  }, [stores]);

  const getStoreColor = (storeId) => {
    const colors = [
    { bg: 'rgba(148, 163, 184, 0.08)', border: 'rgb(148, 163, 184)', hover: 'rgba(148, 163, 184, 0.12)' },
    { bg: 'rgba(55, 65, 81, 0.08)', border: 'rgb(55, 65, 81)', hover: 'rgba(55, 65, 81, 0.12)' },
    { bg: 'rgba(156, 163, 175, 0.08)', border: 'rgb(156, 163, 175)', hover: 'rgba(156, 163, 175, 0.12)' },
    { bg: 'rgba(71, 85, 105, 0.08)', border: 'rgb(71, 85, 105)', hover: 'rgba(71, 85, 105, 0.12)' }];

    const sortedStores = [...stores].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
    const index = sortedStores.findIndex((s) => s.id === storeId);
    return colors[index % colors.length];
  };

  const getDriversForLocation = (locationId) => {
    const config = locationConfigs.find((c) => c.square_location_id === locationId);
    if (!config) return [];
    return drivers.filter((d) => d.square_location_ids && d.square_location_ids.includes(config.id));
  };

  const parseSquareItemName = (itemName) => {
    if (!itemName) return { deliveryDate: null, storeAbbr: null, patientName: null };
    try {
      const today = new Date();
      const msInDay = 24 * 60 * 60 * 1000;
      let tempName = itemName;
      let deliveryDate = null;
      let storeAbbr = null;

      const dateMatch = tempName.match(/^(\d{1,2})[\/-](\d{1,2})/);
      if (dateMatch) {
        const month = Number(dateMatch[1]);
        const day = Number(dateMatch[2]);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          const inferredDate = new Date(today.getFullYear(), month - 1, day);
          if (inferredDate.getTime() - today.getTime() > 45 * msInDay) inferredDate.setFullYear(inferredDate.getFullYear() - 1);
          deliveryDate = format(inferredDate, 'yyyy-MM-dd');
          tempName = tempName.substring(dateMatch[0].length);
        }
      }

      const storeMatch = tempName.match(/\(([^)]+)\)/);
      if (storeMatch) {
        storeAbbr = storeMatch[1].trim();
        tempName = tempName.replace(storeMatch[0], '');
      }

      const patientNameRaw = tempName.replace(/^[\s\-\u2014\(\)]+/, '').trim();
      const patientName = patientNameRaw.length > 1 ? patientNameRaw : null;

      return { deliveryDate, storeAbbr, patientName };
    } catch {
      return { deliveryDate: null, storeAbbr: null, patientName: null };
    }
  };

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

  const hasBeenSoldInSquare = (catalogItem) => {
    const catalogPrice = catalogItem.price_dollars || (catalogItem.price_cents || 0) / 100;
    const catalogSignature = buildLocationDateAmountSignature(catalogItem.location_id, catalogItem.delivery_date || catalogItem.name, catalogPrice);
    return soldCatalogItems.some((payment) => {
      const paymentSignature = buildLocationDateAmountSignature(payment.location_id, payment.item_name, payment.amount);
      return paymentSignature === catalogSignature;
    });
  };

  function getDeliveryPaymentAmountSet(delivery) {
    const amounts = new Set();
    const totalRequired = Math.round(Number(delivery?.cod_total_amount_required || 0) * 100);
    if (totalRequired > 0) amounts.add(totalRequired);
    const codPayments = Array.isArray(delivery?.cod_payments) ? delivery.cod_payments : [];
    let splitTotal = 0;
    codPayments.forEach((payment) => {
      const amount = Math.round(Number(payment?.amount || 0) * 100);
      if (amount > 0) {
        amounts.add(amount);
        splitTotal += amount;
      }
    });
    if (splitTotal > 0) amounts.add(splitTotal);
    return amounts;
  }

  function getTransactionAmountSet(transaction) {
    const amounts = new Set();
    const totalAmount = Math.round(Number(transaction?.amount || 0) * 100);
    if (totalAmount > 0) amounts.add(totalAmount);
    return amounts;
  }

  function amountSetsIntersect(left, right) {
    for (const value of left) if (right.has(value)) return true;
    return false;
  }

  const normalizePatientName = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const getPatientNameTokens = (value) => normalizePatientName(value).split(' ').map((part) => part.trim()).filter((part) => part.length >= 2);
  const getLevenshteinDistance = (a, b) => {
    const left = String(a || '');
    const right = String(b || '');
    if (!left) return right.length;
    if (!right) return left.length;
    const matrix = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
    for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i;
    for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j;
    for (let i = 1; i <= left.length; i += 1) {
      for (let j = 1; j <= right.length; j += 1) {
        const cost = left[i - 1] === right[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
      }
    }
    return matrix[left.length][right.length];
  };
  const patientNamesMatch = (patientName, transactionItemName) => {
    const normalizedPatient = normalizePatientName(patientName);
    const normalizedTransaction = normalizePatientName(transactionItemName);
    if (!normalizedPatient || !normalizedTransaction) return false;
    if (normalizedTransaction.includes(normalizedPatient) || normalizedPatient.includes(normalizedTransaction)) return true;
    const patientTokens = getPatientNameTokens(normalizedPatient);
    const transactionTokens = getPatientNameTokens(normalizedTransaction);
    if (!patientTokens.length || !transactionTokens.length) return false;
    const partialMatch = patientTokens.every((patientToken) => transactionTokens.some((transactionToken) => transactionToken.includes(patientToken) || patientToken.includes(transactionToken)));
    if (partialMatch) return true;
    return patientTokens.every((patientToken) => transactionTokens.some((transactionToken) => {
      const distance = getLevenshteinDistance(patientToken, transactionToken);
      const maxLength = Math.max(patientToken.length, transactionToken.length);
      return maxLength >= 4 && distance <= 1;
    }));
  };

  const getTransactionSearchNames = useCallback((transaction) => {
    const names = new Set();
    if (transaction?.item_name) names.add(String(transaction.item_name));
    return Array.from(names);
  }, []);

  const getTransactionCreatedDate = useCallback((transaction) => {
    const rawDate = transaction?.raw_square_data?.payment_date || transaction?.raw_square_data?.created_at || transaction?.created_date || transaction?.updated_date;
    if (!rawDate) return null;
    const parsed = new Date(rawDate);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }, []);

  const getTransactionFilterDate = useCallback((transaction) => {
    const parsedItem = parseSquareItemName(transaction?.item_name);
    if (parsedItem?.deliveryDate) {
      const parsedFromName = new Date(`${parsedItem.deliveryDate}T00:00:00`);
      if (!Number.isNaN(parsedFromName.getTime())) return parsedFromName;
    }
    return null;
  }, []);

  const getTransactionEffectiveDateString = useCallback((transaction) => {
    const parsed = getTransactionFilterDate(transaction);
    return parsed ? format(parsed, 'yyyy-MM-dd') : null;
  }, [getTransactionFilterDate]);

  const findMatchingDeliveryForTransaction = useCallback((transaction, resolvedStoreId = null) => {
    const transactionAmountSet = getTransactionAmountSet(transaction);
    const transactionDate = getTransactionEffectiveDateString(transaction);
    const parsedItem = parseSquareItemName(transaction?.item_name);
    const patientName = parsedItem?.patientName || '';
    const targetStoreId = resolvedStoreId || transaction?.store_id || null;

    return (deliveries || []).find((delivery) => {
      if (!delivery) return false;
      if (transaction.delivery_id && delivery.id === transaction.delivery_id) return true;
      if (targetStoreId && delivery.store_id !== targetStoreId) return false;
      if (!amountSetsIntersect(getDeliveryPaymentAmountSet(delivery), transactionAmountSet)) return false;
      if (transactionDate && delivery.delivery_date === transactionDate) {
        if (!patientName) return true;
        const patient = patients.find((p) => p?.id === delivery.patient_id || p?.patient_id === delivery.patient_id);
        if (patient?.full_name && patientNamesMatch(patient.full_name, patientName)) return true;
        return true;
      }
      if (patientName) {
        const patient = patients.find((p) => p?.id === delivery.patient_id || p?.patient_id === delivery.patient_id);
        return !!(patient?.full_name && patientNamesMatch(patient.full_name, patientName));
      }
      return false;
    }) || null;
  }, [deliveries, getTransactionEffectiveDateString, patients]);

  const formatItemNameForDisplay = useCallback((deliveryDate, storeAbbreviation, patientName) => {
    const [, month, day] = String(deliveryDate || '').split('-');
    const mm = month?.padStart(2, '0') || '00';
    const dd = day?.padStart(2, '0') || '00';
    return `${mm}/${dd}(${storeAbbreviation || 'NA'})-${patientName || 'Unknown Patient'}`;
  }, []);

  const isTransferTransaction = (transaction) => {
    const label = `${transaction?.item_name || ''} ${transaction?.delivery_id || ''}`.toLowerCase();
    return transaction?.type === 'transfer' || label.includes('transfer') || label.includes('interstore') || label.includes('inter-store');
  };

  const hasMatchingSquareTransaction = useCallback((delivery, locationId, transactionsPool = allTransactions) => {
    const patient = patients.find((p) => p?.id === delivery?.patient_id || p?.patient_id === delivery?.patient_id);
    const patientName = patient?.full_name || '';
    const store = stores.find((s) => s?.id === delivery?.store_id);
    const deliveryAmountSet = getDeliveryPaymentAmountSet(delivery);
    const deliveryDateString = delivery?.delivery_date ? String(delivery.delivery_date).slice(0, 10) : null;
    const storeAbbreviation = String(store?.abbreviation || '').trim().toLowerCase();
    const normalizedLocationId = String(locationId || '').trim();

    const hasInternalPayments = Array.isArray(delivery?.cod_payments) && delivery.cod_payments.length > 0;

    return (transactionsPool || []).some((transactionLike) => {
      const transaction = transactionLike?.rawTransaction || transactionLike;
      if (!transaction || isTransferTransaction(transaction)) return false;
      if (transaction.type !== 'collection') return false;
      if (!['completed', 'refunded', 'pending'].includes(transaction.status)) return false;

      if (transaction.delivery_id && transaction.delivery_id === delivery?.id) return true;

      const transactionAmountSet = getTransactionAmountSet(transaction);
      if (!amountSetsIntersect(deliveryAmountSet, transactionAmountSet)) return false;

      const parsed = parseSquareItemName(String(transaction.item_name || '').trim());
      const parsedTransactionDateString = parsed?.deliveryDate || null;
      const transactionCreatedDate = getTransactionCreatedDate(transaction);
      const transactionCreatedDateString = transactionCreatedDate ? format(transactionCreatedDate, 'yyyy-MM-dd') : null;
      const transactionDateString = parsedTransactionDateString || transactionCreatedDateString;
      const transactionStoreAbbreviation = String(parsed?.storeAbbr || '').trim().toLowerCase();
      const transactionLocationId = String(transaction.location_id || '').trim();

      const dateMatches = !!deliveryDateString && !!transactionDateString && deliveryDateString === transactionDateString;
      const locationMatches = !!normalizedLocationId && !!transactionLocationId && normalizedLocationId === transactionLocationId;
      const abbreviationMatches = !!storeAbbreviation && (
        (!!transactionStoreAbbreviation && storeAbbreviation === transactionStoreAbbreviation) ||
        String(transaction.item_name || '').toLowerCase().includes(storeAbbreviation)
      );

      const searchableText = String(transaction.item_name || transaction.raw_square_data?.note || transaction.raw_square_data?.notes || '').trim();
      const nameMatches = !!patientName && !!searchableText && patientNamesMatch(patientName, searchableText);

      if (dateMatches && (locationMatches || abbreviationMatches || nameMatches)) return true;
      if (locationMatches && (abbreviationMatches || nameMatches)) return true;
      if (abbreviationMatches && nameMatches) return true;

      return false;
    });
  }, [allTransactions, patients, stores, getTransactionCreatedDate]);

  const confirmDelete = async () => {
    if (!itemToDelete) return;
    setDeletingId(itemToDelete.catalog_object_id);
    try {
      await base44.functions.invoke('squareCodCore', {
        action: 'markCollectedDebit',
        deliveryId: itemToDelete.delivery_id,
        catalogObjectId: itemToDelete.catalog_object_id,
        transactionId: itemToDelete.transaction_id
      });

      setCatalogItems((prev) => prev.filter((i) => i.catalog_object_id !== itemToDelete.catalog_object_id));
      setDeliveries((prev) => prev.map((delivery) =>
      delivery?.id === itemToDelete.delivery_id ?
      {
        ...delivery,
        cod_payments: [{ type: 'Debit', amount: Number(delivery.cod_total_amount_required || 0) }]
      } :
      delivery
      ));

      toast.success('Marked as collected and removed from Square');
    } catch (err) {
      console.error('Collect failed:', err);
      toast.error('Failed to mark collected: ' + err.message);
    } finally {
      setDeletingId(null);
      setItemToDelete(null);
    }
  };

  const filteredCatalogItems = useMemo(() => {
    if (!currentUser) return [];
    const userIsAppOwner = isAppOwner(currentUser);
    let items = [];
    if (userIsAppOwner) {
      if (selectedDriverFilter && selectedDriverFilter !== 'all') {
        const driver = drivers.find((d) => d.id === selectedDriverFilter);
        const driverLocationIds = driver?.square_location_ids || [];
        const squareLocationIds = locationConfigs.filter((c) => driverLocationIds.includes(c.id)).map((c) => c.square_location_id);
        items = catalogItems.filter((item) => squareLocationIds.includes(item.location_id));
      } else {
        items = catalogItems;
      }
    } else {
      const driverRecord = drivers.find((d) => d.user_id === currentUser.id);
      const driverLocationIds = driverRecord?.square_location_ids || [];
      const squareLocationIds = locationConfigs.filter((c) => driverLocationIds.includes(c.id)).map((c) => c.square_location_id);
      items = catalogItems.filter((item) => squareLocationIds.includes(item.location_id));
    }

    items = items.filter((item) => {
      const linkedDelivery = deliveries.find((d) => d?.id === item.delivery_id);
      if (linkedDelivery?.status === 'pending') return false; // catalog items for pending deliveries are not yet settled
      const soldInSquare = hasBeenSoldInSquare(item);
      return !item.is_sold && !soldInSquare;
    });

    return items.sort((a, b) => {
      const aDrivers = getDriversForLocation(a.location_id).sort((d1, d2) => (d1.sort_order ?? Infinity) - (d2.sort_order ?? Infinity));
      const bDrivers = getDriversForLocation(b.location_id).sort((d1, d2) => (d1.sort_order ?? Infinity) - (d2.sort_order ?? Infinity));
      const aFirstDriverOrder = aDrivers[0]?.sort_order ?? Infinity;
      const bFirstDriverOrder = bDrivers[0]?.sort_order ?? Infinity;
      if (aFirstDriverOrder !== bFirstDriverOrder) return aFirstDriverOrder - bFirstDriverOrder;
      if (a.name !== b.name) return a.name.localeCompare(b.name);
      const aConfig = locationConfigs.find((c) => c.square_location_id === a.location_id);
      const bConfig = locationConfigs.find((c) => c.square_location_id === b.location_id);
      const aStore = getStoreForConfig(aConfig);
      const bStore = getStoreForConfig(bConfig);
      const aStoreName = aStore?.name || aConfig?.name || '';
      const bStoreName = bStore?.name || bConfig?.name || '';
      return aStoreName.localeCompare(bStoreName);
    });
  }, [catalogItems, currentUser, selectedDriverFilter, locationConfigs, drivers, soldCatalogItems, deliveries, stores]);

  const selectedDriverUserIds = useMemo(() => {
    if (selectedDriverFilter && selectedDriverFilter !== 'all') {
      const selectedDriver = drivers.find((driver) => driver?.id === selectedDriverFilter);
      const result = new Set(selectedDriver?.user_id ? [selectedDriver.user_id] : []);
      selectedDriverUserIdsRef.current = result;
      return result;
    }
    const result = new Set((drivers || []).map((driver) => driver?.user_id).filter(Boolean));
    selectedDriverUserIdsRef.current = result;
    return result;
  }, [drivers, selectedDriverFilter]);

  const lookbackStart = useMemo(() => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - Number(selectedDaysRange || 90));
    return date;
  }, [selectedDaysRange]);

  const activeCityIds = useMemo(() => {
    const source = currentAppUser || currentUser;
    if (Array.isArray(source?.city_ids) && source.city_ids.length > 0) return source.city_ids.filter(Boolean);
    return source?.city_id ? [source.city_id] : [];
  }, [currentAppUser, currentUser]);

  // Stores that have a matching SquareLocationConfig (by name OR legacy square_location_config_id)
  const storesWithSquareLocationIds = useMemo(() => stores.filter((store) => {
    if (!store?.id || !store?.name) return false;
    return locationConfigs.some((c) =>
      c?.store_name === store.name ||
      (store.square_location_config_id && c?.id === store.square_location_config_id)
    );
  }), [stores, locationConfigs]);

  const availableStoresForFilter = useMemo(() => {
    const cityFilteredStores = activeCityIds.length > 0
      ? storesWithSquareLocationIds.filter((store) => activeCityIds.includes(store?.city_id))
      : storesWithSquareLocationIds;
    const effectiveStores = cityFilteredStores.length > 0 ? cityFilteredStores : storesWithSquareLocationIds;
    return [...effectiveStores].sort((a, b) => (a?.sort_order ?? Infinity) - (b?.sort_order ?? Infinity));
  }, [storesWithSquareLocationIds, activeCityIds]);

  const visibleStoreIds = useMemo(() => {
    const scopedStores = selectedStoreFilter && selectedStoreFilter !== 'all'
      ? availableStoresForFilter.filter((store) => store?.id === selectedStoreFilter)
      : availableStoresForFilter;
    const result = new Set(scopedStores.map((store) => store?.id).filter(Boolean));
    visibleStoreIdsRef.current = result;
    return result;
  }, [availableStoresForFilter, selectedStoreFilter]);

  // Config IDs for visible stores (resolved by name match OR legacy ID)
  const visibleSquareLocationConfigIds = useMemo(() => new Set(
    storesWithSquareLocationIds
      .filter((store) => visibleStoreIds.has(store?.id))
      .map((store) => (
        locationConfigs.find((c) => c?.store_name === store.name)?.id ||
        locationConfigs.find((c) => c?.id === store.square_location_config_id)?.id
      ))
      .filter(Boolean)
  ), [storesWithSquareLocationIds, visibleStoreIds, locationConfigs]);

  const visibleLocationIds = useMemo(() => new Set(
    locationConfigs
      .filter((lc) => visibleSquareLocationConfigIds.has(lc?.id))
      .map((lc) => lc?.square_location_id)
      .filter(Boolean)
  ), [locationConfigs, visibleSquareLocationConfigIds]);

  const driverScopedLocationIds = useMemo(() => {
    if (currentUser && isAppOwner(currentUser)) {
      if (!selectedDriverFilter || selectedDriverFilter === 'all') return null;
      const selectedDriver = drivers.find((driver) => driver?.id === selectedDriverFilter);
      const configIds = new Set((selectedDriver?.square_location_ids || []).filter(Boolean));
      return new Set(locationConfigs.filter((config) => configIds.has(config?.id)).map((config) => config?.square_location_id).filter(Boolean));
    }
    const configIds = new Set((currentAppUser?.square_location_ids || []).filter(Boolean));
    if (configIds.size === 0) return null;
    return new Set(locationConfigs.filter((config) => configIds.has(config?.id)).map((config) => config?.square_location_id).filter(Boolean));
  }, [currentUser, currentAppUser, drivers, selectedDriverFilter, locationConfigs]);

  const filteredDeliveryRows = useMemo(() => {
    const rows = (deliveries || []).filter((d) => d && Number(d.cod_total_amount_required || 0) > 0).
    filter((delivery) => {
      if (!delivery) return false;
      if (['failed', 'cancelled'].includes(delivery.status)) return false;
      // Only show deliveries for stores that have a Square location config
      const deliveryStore = stores.find((s) => s?.id === delivery.store_id);
      const deliveryConfig = getConfigForStore(deliveryStore);
      if (!deliveryConfig?.id || !visibleSquareLocationConfigIds.has(deliveryConfig.id)) return false;
      // Store filter: if a specific store is selected, filter by it
      if (selectedStoreFilter && selectedStoreFilter !== 'all') {
        if (delivery.store_id !== selectedStoreFilter) return false;
      }
      const deliveryDate = delivery.delivery_date ? new Date(`${String(delivery.delivery_date).slice(0, 10)}T00:00:00`) : null;
      if (!(deliveryDate instanceof Date) || Number.isNaN(deliveryDate.getTime()) || deliveryDate < lookbackStart) return false;
      if (selectedDriverFilter === 'all') return true;
      if (selectedDriverUserIds.size === 0) return false;
      return selectedDriverUserIds.has(delivery.driver_id);
    }).
    sort((a, b) => String(b.delivery_date || '').localeCompare(String(a.delivery_date || ''))).
    map((delivery) => {
      const patient = patients.find((p) => p?.id === delivery.patient_id || p?.patient_id === delivery.patient_id);
      const store = stores.find((s) => s?.id === delivery.store_id);
      const config = getConfigForStore(store);
      const linkedCatalog = catalogItems.find((item) => item?.delivery_id === delivery.id);
      const resolvedLocationId = config?.square_location_id || null;
      const hasMatch = hasMatchingSquareTransaction(delivery, resolvedLocationId, allTransactions);
      const matchingTx = hasMatch
        ? (allTransactions || []).find((tx) => {
            if (!tx || tx.type !== 'collection') return false;
            if (!['completed', 'refunded', 'pending'].includes(tx.status)) return false;
            if (tx.delivery_id && tx.delivery_id === delivery.id) return true;
            const txAmountSet = getTransactionAmountSet(tx);
            if (!amountSetsIntersect(getDeliveryPaymentAmountSet(delivery), txAmountSet)) return false;
            const parsed = parseSquareItemName(String(tx.item_name || ''));
            const txDate = parsed?.deliveryDate || null;
            const txStoreAbbr = String(parsed?.storeAbbr || '').trim().toLowerCase();
            const deliveryStoreAbbr = String(store?.abbreviation || '').trim().toLowerCase();
            const abbrMatches = !!deliveryStoreAbbr && (txStoreAbbr === deliveryStoreAbbr || String(tx.item_name || '').toLowerCase().includes(deliveryStoreAbbr));
            const patient = patients.find((p) => p?.id === delivery.patient_id || p?.patient_id === delivery.patient_id);
            const nameMatches = !!(patient?.full_name && patientNamesMatch(patient.full_name, String(tx.item_name || '')));
            if (txDate === delivery.delivery_date && (abbrMatches || nameMatches || tx.location_id === resolvedLocationId)) return true;
            if (abbrMatches && nameMatches) return true;
            return false;
          })
        : null;
      const collectionType = Array.isArray(delivery?.cod_payments) && delivery.cod_payments.length > 0 ?
      Array.from(new Set(delivery.cod_payments.map((payment) => payment?.type).filter(Boolean))).join(', ') :
      null;

      return {
        id: delivery.id,
        key: `${delivery.id || 'delivery'}|${resolvedLocationId || '--'}|${delivery.delivery_date || 'no-date'}`,
        rawDelivery: delivery,
        amountSet: getDeliveryPaymentAmountSet(delivery),
        rawStoreId: delivery.store_id || null,
        itemName: patient?.full_name || delivery.delivery_id || delivery.stop_id || 'Unknown Delivery',
        amount: Number(delivery.cod_total_amount_required || 0),
        storeName: store?.name || 'Unknown',
        locationId: resolvedLocationId || '--',
        catalogId: linkedCatalog?.catalog_object_id || '--',
        transactionId: matchingTx?.square_payment_id || matchingTx?.square_transaction_id || matchingTx?.id || '--',
        deliveryDate: delivery.delivery_date,
        collectionType,
        subtext: delivery.driver_name || null,
        actions: hasMatch ?
        <Button variant="secondary" size="sm" className="border border-emerald-300 bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">Collected</Button> :
        delivery.status === 'pending' ?
        <Button variant="secondary" size="sm" className="border border-slate-300 bg-slate-100 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400">Pending Pickup</Button> :
        <Button variant="secondary" size="sm" className="border border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-300 leading-tight h-auto py-1 text-center whitespace-normal"><span>Not<br/>Collected</span></Button>
      };
    });

    const seenRowKeys = new Set();
    return rows.filter((row) => {
      const rowKey = row.key || row.id;
      if (seenRowKeys.has(rowKey)) return false;
      seenRowKeys.add(rowKey);
      return true;
    });
  }, [deliveries, lookbackStart, selectedDriverFilter, selectedDriverUserIds, patients, stores, locationConfigs, catalogItems, allTransactions, visibleSquareLocationConfigIds]);

  const isCardSaleTransaction = useCallback((transaction) => {
    if (!transaction || isTransferTransaction(transaction)) return false;
    if (transaction?.type && transaction.type !== 'collection') return false;
    const status = String(transaction?.status || '').toLowerCase();
    if (!['completed', 'pending'].includes(status)) return false;
    const orderState = String(transaction?.raw_square_data?.order_state || '').toUpperCase();
    if (orderState && !['COMPLETED', 'OPEN'].includes(orderState)) return false;
    return true;
  }, []);

  const filteredTransactionRows = useMemo(() => {
    const dedupedTransactions = [];
    const seenTransactionKeys = new Set();

    (allTransactions || []).
    filter((transaction) => {
      if (!isCardSaleTransaction(transaction)) return false;
      const hasFormattedItemDate = !!parseSquareItemName(transaction?.item_name)?.deliveryDate;
      const transactionDate = getTransactionFilterDate(transaction);
      if (hasFormattedItemDate && (!transactionDate || transactionDate < lookbackStart)) return false;

      const config = locationConfigs.find((c) => c?.square_location_id === transaction.location_id);
      // Check visibility: config found by location_id OR store resolved from config.store_name
      const configStoreVisible = config ? visibleSquareLocationConfigIds.has(config.id) : false;
      const locationIsVisible = configStoreVisible;
      const matchedDeliveryForFilter = !locationIsVisible || (selectedDriverFilter && selectedDriverFilter !== 'all')
        ? findMatchingDeliveryForTransaction(transaction, transaction.store_id || null)
        : null;
      if (!locationIsVisible) {
        // Fallback: try resolving store from transaction.store_id, matched delivery, or config.store_name
        const matchedStore = stores.find((s) => s?.id === transaction.store_id)
          || (matchedDeliveryForFilter ? stores.find((s) => s?.id === matchedDeliveryForFilter.store_id) : null)
          || getStoreForConfig(config)
          || null;
        const matchedConfig = config || getConfigForStore(matchedStore);
        if (!matchedConfig?.id || !visibleSquareLocationConfigIds.has(matchedConfig.id)) return false;
      }

      if (selectedDriverFilter && selectedDriverFilter !== 'all') {
        if (selectedDriverUserIds.size === 0) return false;
        const matchedDriverId = transaction.driver_id || matchedDeliveryForFilter?.driver_id || null;
        return matchedDriverId ? selectedDriverUserIds.has(matchedDriverId) : false;
      }

      return true;
    }).
    forEach((transaction) => {
      const effectiveDate = getTransactionEffectiveDateString(transaction) || 'unknown-date';
      const amountCents = Math.round(Number(transaction.amount || 0) * 100);
      const dedupeKey = transaction.square_payment_id || transaction.square_transaction_id || `${transaction.location_id || 'unknown-location'}::${transaction.item_name || 'unknown-item'}::${amountCents}::${effectiveDate}`;
      if (seenTransactionKeys.has(dedupeKey)) return;
      seenTransactionKeys.add(dedupeKey);
      dedupedTransactions.push(transaction);
    });

    const rows = dedupedTransactions.map((transaction) => {
      const config = locationConfigs.find((c) => c?.square_location_id === transaction.location_id);
      const matchedDelivery = findMatchingDeliveryForTransaction(transaction, transaction.store_id || null);
      const store = stores.find((s) => s?.id === transaction.store_id)
        || (matchedDelivery ? stores.find((s) => s?.id === matchedDelivery.store_id) : null)
        || getStoreForConfig(config)
        || null;
      const resolvedConfig = config || getConfigForStore(store) || null;
      const resolvedStore = store || getStoreForConfig(config) || null;
      const squareCreatedAt = transaction?.raw_square_data?.created_at || null;
      const collectionDate = squareCreatedAt ? squareCreatedAt.slice(0, 10) : getTransactionEffectiveDateString(transaction);
      const displayDate = collectionDate;
      const collectedByName = matchedDelivery?.driver_name || drivers.find((driver) => driver?.user_id === matchedDelivery?.driver_id)?.user_name || null;
      const collectionType = Array.isArray(matchedDelivery?.cod_payments) && matchedDelivery.cod_payments.length > 0 ?
      Array.from(new Set(matchedDelivery.cod_payments.map((payment) => payment?.type).filter(Boolean))).join(', ') :
      null;

      return {
        id: transaction.id,
        key: `${transaction.id || transaction.square_payment_id || 'transaction'}|${transaction.location_id || '--'}|${collectionDate || displayDate || 'no-date'}|${Number(transaction.amount || 0)}`,
        rawTransaction: transaction,
        amountSet: getTransactionAmountSet(transaction),
        searchNames: getTransactionSearchNames(transaction),
        rawStatus: transaction.status,
        rawStoreId: transaction.store_id || store?.id || null,
        itemName: transaction.item_name || transaction.square_payment_id || 'Square Transaction',
        amount: Number(transaction.amount || 0),
        storeName: resolvedStore?.name || store?.name || resolvedConfig?.name || config?.name || 'Unknown',
        locationId: transaction.location_id || resolvedConfig?.square_location_id || '--',
        catalogId: transaction.square_catalog_object_id || '--',
        deliveryDate: displayDate,
        collectionDate,
        collectionType,
        subtext: collectedByName ? `Collected by ${collectedByName}` : transaction.payment_method || null,
        notes: transaction.raw_square_data?.note || transaction.raw_square_data?.notes || null,
        actions: matchedDelivery ?
        <Button variant="secondary" size="sm" className="border border-emerald-300 bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">Collected</Button> :
        <Button variant="secondary" size="sm" className="border border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-300">No Match</Button>
      };
    }).sort((a, b) => {
      // Properly formatted names start with MM/DD(STORE)-Name pattern
      const isFormatted = (name) => /^\d{1,2}\/\d{1,2}\([^)]+\)/.test(String(name || ''));
      const aFormatted = isFormatted(a.itemName);
      const bFormatted = isFormatted(b.itemName);
      if (aFormatted && !bFormatted) return -1;
      if (!aFormatted && bFormatted) return 1;
      return String(b.itemName || '').localeCompare(String(a.itemName || ''), undefined, { sensitivity: 'base' });
    });

    const seenRowKeys = new Set();
    return rows.filter((row) => {
      const rowKey = row.key || row.id;
      if (seenRowKeys.has(rowKey)) return false;
      seenRowKeys.add(rowKey);
      return true;
    });
  }, [allTransactions, lookbackStart, visibleLocationIds, selectedDriverFilter, selectedDriverUserIds, locationConfigs, stores, drivers, getTransactionSearchNames, getTransactionFilterDate, getTransactionEffectiveDateString, findMatchingDeliveryForTransaction, visibleSquareLocationConfigIds]);

  const filteredCatalogRows = useMemo(() => {
    const rows = (catalogItems || []).
    filter((item) => {
      if (driverScopedLocationIds && item.location_id && !driverScopedLocationIds.has(item.location_id)) return false;
      if (visibleLocationIds.size > 0 && item.location_id && !visibleLocationIds.has(item.location_id)) return false;
      const store = stores.find((candidateStore) => candidateStore?.id === item.store_id)
        || getStoreForConfig(locationConfigs.find((c) => c?.square_location_id === item.location_id))
        || null;
      const storeConfig = getConfigForStore(store);
      if (!storeConfig?.id || !visibleSquareLocationConfigIds.has(storeConfig.id)) return false;
      return true;
    }).
    map((item) => {
      const config = locationConfigs.find((c) => c?.square_location_id === item.location_id);
      const store = stores.find((s) => s?.id === item.store_id) || getStoreForConfig(config);
      return {
        id: item.catalog_object_id || item.id,
        key: `${item.catalog_object_id || item.id || 'catalog'}|${item.location_id || '--'}|${item.delivery_date || parseSquareItemName(item.name || item.item_name)?.deliveryDate || 'no-date'}`,
        itemName: item.name || item.item_name || 'Catalog Item',
        amount: Number(item.price_dollars || item.amount || 0),
        storeName: store?.name || config?.name || 'Unknown',
        locationId: item.location_id || '--',
        catalogId: item.catalog_object_id || item.id || '--',
        deliveryDate: item.delivery_date || parseSquareItemName(item.name || item.item_name)?.deliveryDate,
        subtext: item.description || item.status || null,
        actions:
        <Button
          variant="secondary"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            setItemToDelete(item);
          }}
          disabled={deletingId === item.catalog_object_id || !item.delivery_id}
          className="rounded-lg border border-emerald-300 bg-white text-emerald-700 shadow-sm hover:bg-emerald-50 hover:border-emerald-400 dark:border-emerald-700 dark:bg-slate-900 dark:text-emerald-300 dark:hover:bg-emerald-900/20">
          
              {deletingId === item.catalog_object_id ?
          <Loader2 className="w-4 h-4 animate-spin" /> :

          'Collected'
          }
            </Button>

      };
    }).
    sort((a, b) => String(b.deliveryDate || '').localeCompare(String(a.deliveryDate || '')));

    const seenRowKeys = new Set();
    return rows.filter((row) => {
      const rowKey = row.key || row.id;
      if (seenRowKeys.has(rowKey)) return false;
      seenRowKeys.add(rowKey);
      return true;
    });
  }, [catalogItems, locationConfigs, stores, visibleLocationIds, driverScopedLocationIds, deletingId, lookbackStart, visibleSquareLocationConfigIds]);

  const reconciliationRows = useMemo(() => {
    const rows = (deliveries || [])
      .filter((delivery) => {
        if (!delivery) return false;
        if (delivery.status === 'failed') return false;
        if (Number(delivery.cod_total_amount_required || 0) <= 0) return false;

        const store = stores.find((candidateStore) => candidateStore?.id === delivery.store_id);
        const storeConfig = getConfigForStore(store);
        if (!storeConfig?.id || !visibleSquareLocationConfigIds.has(storeConfig.id)) return false;

        const deliveryDate = delivery.delivery_date ? new Date(`${String(delivery.delivery_date).slice(0, 10)}T00:00:00`) : null;
        if (!(deliveryDate instanceof Date) || Number.isNaN(deliveryDate.getTime()) || deliveryDate < lookbackStart) return false;

        if (selectedDriverFilter !== 'all') {
          if (selectedDriverUserIds.size === 0) return false;
          if (!selectedDriverUserIds.has(delivery.driver_id)) return false;
        }

        const resolvedLocationId = storeConfig?.square_location_id || null;
        if (!resolvedLocationId) return false;

        return !hasMatchingSquareTransaction(delivery, resolvedLocationId, allTransactions);
      })
      .sort((a, b) => String(b.delivery_date || '').localeCompare(String(a.delivery_date || '')))
      .map((delivery) => {
        const patient = patients.find((p) => p?.id === delivery?.patient_id || p?.patient_id === delivery?.patient_id);
        const store = stores.find((s) => s?.id === delivery?.store_id);
        const config = getConfigForStore(store);
        const resolvedLocationId = config?.square_location_id || '--';

        return {
          id: delivery.id,
          key: `${delivery.id || 'delivery'}|${resolvedLocationId}|${delivery.delivery_date || 'no-date'}`,
          rawDelivery: delivery,
          amountSet: getDeliveryPaymentAmountSet(delivery),
          rawStoreId: delivery.store_id || null,
          itemName: formatItemNameForDisplay(delivery?.delivery_date, store?.abbreviation, patient?.full_name),
          amount: Number(delivery.cod_total_amount_required || 0),
          storeName: store?.name || 'Unknown',
          locationId: resolvedLocationId,
          catalogId: '--',
          deliveryDate: delivery.delivery_date,
          collectionType: Array.isArray(delivery?.cod_payments) && delivery.cod_payments.length > 0
            ? Array.from(new Set(delivery.cod_payments.map((payment) => payment?.type).filter(Boolean))).join(', ')
            : null,
          subtext: delivery.driver_name || null,
          actions: <Button variant="secondary" size="sm" className="border border-red-300 bg-red-100 text-red-800 hover:bg-red-100 dark:border-red-700 dark:bg-red-900/40 dark:text-red-300">Unmatched</Button>
        };
      });

    const seenRowKeys = new Set();
    return rows.filter((row) => {
      const rowKey = row.key || row.id;
      if (seenRowKeys.has(rowKey)) return false;
      seenRowKeys.add(rowKey);
      return true;
    });
  }, [deliveries, stores, visibleSquareLocationConfigIds, lookbackStart, selectedDriverFilter, selectedDriverUserIds, locationConfigs, allTransactions, hasMatchingSquareTransaction, patients, formatItemNameForDisplay]);

  reconciliationRowsRef.current = reconciliationRows;

  const codDeliveriesCount = useMemo(() => deliveries.filter((delivery) => {
    if (!delivery || Number(delivery.cod_total_amount_required || 0) <= 0) return false;
    if (selectedDriverFilter === 'all') return true;
    if (selectedDriverUserIds.size === 0) return false;
    return selectedDriverUserIds.has(delivery.driver_id);
  }).length, [deliveries, selectedDriverFilter, selectedDriverUserIds]);

  const collectedCodTypeBreakdown = useMemo(() => {
    const counts = { Cash: 0, Debit: 0, Credit: 0, Check: 0, Other: 0 };
    deliveries.forEach((delivery) => {
      if (!delivery || Number(delivery.cod_total_amount_required || 0) <= 0) return;
      if (delivery.delivery_date && new Date(`${delivery.delivery_date}T00:00:00`) < lookbackStart) return;
      if (selectedDriverFilter !== 'all' && (selectedDriverUserIds.size === 0 || !selectedDriverUserIds.has(delivery.driver_id))) return;
      const codPayments = Array.isArray(delivery.cod_payments) ? delivery.cod_payments : [];
      if (codPayments.length > 0) {
        const deliveryTypes = new Set(codPayments.filter((payment) => Number(payment?.amount || 0) > 0).map((payment) => payment?.type).filter((type) => ['Cash', 'Debit', 'Credit', 'Check', 'Other'].includes(type)));
        deliveryTypes.forEach((type) => {counts[type] += 1;});
      }
    });
    return counts;
  }, [deliveries, lookbackStart, selectedDriverFilter, selectedDriverUserIds]);

  const filteredCardSalesCount = useMemo(() => filteredTransactionRows.length, [filteredTransactionRows]);
  const filteredSalesCount = useMemo(() => soldCatalogItems.filter((transaction) => isCardSaleTransaction(transaction)).length, [soldCatalogItems, isCardSaleTransaction]);

  const viewCounts = {
    deliveries: filteredDeliveryRows.length,
    transactions: filteredTransactionRows.length,
    catalog: filteredCatalogRows.length,
    reconciliation: reconciliationRows.length
  };

  const activeViewStats = useMemo(() => {
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
    <div className="px-4 md:px-6 pt-4 md:pt-6 bg-background text-foreground w-full h-full overflow-y-auto md:overflow-hidden flex flex-col">
      <div className="flex flex-col gap-4 mb-6 flex-shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <CreditCard className="w-6 md:w-8 h-6 md:h-8 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
            <div className="min-w-0">
              <h1 className="text-xl md:text-2xl font-bold text-slate-900 dark:text-slate-50">Square COD</h1>
              <p className="text-xs md:text-sm text-slate-600 dark:text-slate-400">Track and manage COD payments</p>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2 md:flex md:flex-row md:flex-wrap md:items-center md:gap-3 w-full">
            {currentUser && isAppOwner(currentUser) && drivers.length > 0 &&
            <Select value={selectedDriverFilter} onValueChange={setSelectedDriverFilter}>
                <SelectTrigger className="w-full md:w-[130px] text-sm">
                  <SelectValue placeholder="All Drivers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Drivers</SelectItem>
                  {drivers.map((driver) =>
                <SelectItem key={driver.id} value={driver.id}>{driver.user_name}</SelectItem>
                )}
                </SelectContent>
              </Select>
            }

            <Select value={selectedStoreFilter} onValueChange={setSelectedStoreFilter}>
              <SelectTrigger className="w-full md:w-[130px] text-sm">
                <SelectValue placeholder="All Stores" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Stores</SelectItem>
                {availableStoresForFilter.map((store) =>
                <SelectItem key={store.id} value={store.id}>{store.name}</SelectItem>
                )}
              </SelectContent>
            </Select>

            <Select value={selectedDaysRange} onValueChange={setSelectedDaysRange}>
              <SelectTrigger className="w-full md:w-[130px] text-sm">
                <SelectValue placeholder="Days" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">7 Days</SelectItem>
                <SelectItem value="14">14 Days</SelectItem>
                <SelectItem value="21">21 Days</SelectItem>
                <SelectItem value="28">28 Days</SelectItem>
                <SelectItem value="45">45 Days</SelectItem>
                <SelectItem value="60">60 Days</SelectItem>
                <SelectItem value="90">90 Days</SelectItem>
              </SelectContent>
            </Select>

            {currentUser && isAppOwner(currentUser) &&
            <>
              <Button onClick={syncFromSquare} disabled={isLoading || isSyncing} className="w-full md:w-[130px] gap-1 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800 justify-center">
                <CloudDownload className={`w-4 h-4 flex-shrink-0 ${isSyncing ? 'animate-pulse' : ''}`} />
                {isSyncing ? 'Syncing...' : 'Sync'}
              </Button>
              {activeView === 'reconciliation' &&
              <Button onClick={runReconcile} disabled={isReconciling || isSyncing} className="w-full md:w-[160px] gap-1 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800 justify-center">
                {isReconciling ? <Loader2 className="w-4 h-4 flex-shrink-0 animate-spin" /> : <RefreshCw className="w-4 h-4 flex-shrink-0" />}
                {isReconciling ? 'Reconciling...' : 'Reconcile'}
              </Button>
              }
            </>
            }
          </div>

          <div className="grid grid-cols-2 gap-2 md:flex md:flex-row md:flex-wrap md:items-center md:gap-3 w-full">
            <SquareCodViewSwitcher activeView={activeView} onChange={setActiveView} counts={viewCounts} />
            {activeView === 'reconciliation' && currentUser && isAppOwner(currentUser) &&
            <Button onClick={syncFromSquare} disabled={isLoading || isSyncing} className="w-full md:w-[160px] gap-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800">
                <CloudDownload className={`w-4 h-4 flex-shrink-0 ${isSyncing ? 'animate-pulse' : ''}`} />
                <span>{isSyncing ? 'Updating...' : 'Update Catalog'}</span>
              </Button>
            }
          </div>
        </div>
      </div>

      <div className="md:flex-1 md:min-h-0 flex flex-col">
        {syncStatus &&
        <div className="mb-2">
            <SyncStatusIndicator
            syncStatus={syncStatus}
            isSyncing={isSyncing}
            error={error}
            codDeliveryCount={codDeliveriesCount}
            catalogItemCount={filteredCatalogItems.length}
            cardSpendCount={filteredCardSalesCount}
            salesCount={filteredSalesCount}
            collectedCodTypeBreakdown={collectedCodTypeBreakdown} />
          
          </div>
        }

        {bgSyncProgress.stage !== 'idle' &&
        <div className="mb-6 md:mb-8">
            <BackgroundSyncProgressBar progress={bgSyncProgress} />
          </div>
        }

        {!syncStatus && bgSyncProgress.stage === 'idle' && <div className="mb-4" />}

        {lastCleanup &&
        <div className="mb-6 md:mb-8">
            <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700">
              <CardContent className="p-3 md:p-4">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <CheckCircle className="w-4 h-4 text-emerald-600" />
                  <span className="font-semibold">Last Cleanup</span>
                  <span className="text-slate-600 dark:text-slate-400">Processed: {lastCleanup.processed}</span>
                  <span className="text-slate-600 dark:text-slate-400">Deleted OK: {lastCleanup.counts['delete']?.ok || 0}</span>
                  <span className="text-slate-600 dark:text-slate-400">Upserted OK: {lastCleanup.counts['upsert']?.ok || 0}</span>
                  <span className="ml-auto text-xs flex items-center gap-1 text-slate-500 dark:text-slate-400">
                    <Clock className="w-3 h-3" />
                    {new Date(lastCleanup.finishedAt || lastCleanup.startedAt).toLocaleString()}
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>
        }

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4 mb-4 md:mb-8">
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
          <Card className="bg-white dark:bg-slate-900 border-amber-200 dark:border-amber-800">
            <CardContent className="p-3 md:p-4">
              <div className="text-xs md:text-sm text-slate-600 dark:text-slate-400">Uncollected COD's</div>
              <div className="text-xl md:text-2xl font-bold text-amber-600 dark:text-amber-400">
                ${(activeView === 'deliveries' ? filteredDeliveryRows : activeView === 'transactions' ? filteredTransactionRows : activeView === 'reconciliation' ? reconciliationRows : filteredCatalogRows)
                  .filter((row) => {
                    const cls = row.actions?.props?.className || '';
                    return cls.includes('amber');
                  })
                  .reduce((sum, row) => sum + Number(row.amount || 0), 0)
                  .toFixed(2)}
              </div>
            </CardContent>
          </Card>
          <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700">
            <CardContent className="p-3 md:p-4">
              <div className="text-xs md:text-sm text-slate-600 dark:text-slate-400">{activeViewStats.locationLabel}</div>
              <div className="text-xl md:text-2xl font-bold text-blue-600 dark:text-blue-400">{activeViewStats.locationValue}</div>
            </CardContent>
          </Card>
        </div>

        {activeView === 'catalog' && currentUser && isAppOwner(currentUser) && locationConfigs.length > 0 &&
        <div>
            <h2 className="text-base md:text-lg font-semibold mb-4 text-slate-900 dark:text-slate-50">By Location</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-none md:auto-cols-fr md:grid-flow-col gap-2 md:gap-4 mb-6 md:mb-8">
              {locationConfigs.
            filter((config) => visibleLocationIds.has(config.square_location_id)).
            sort((a, b) => {
              const storeA = getStoreForConfig(a);
              const storeB = getStoreForConfig(b);
              return (storeA?.sort_order ?? Infinity) - (storeB?.sort_order ?? Infinity);
            }).
            map((config) => {
              const locationItems = filteredCatalogRows.filter((item) => item.locationId === config.square_location_id);
              const codTotal = locationItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);
              const store = getStoreForConfig(config);
              getStoreColor(store?.id);
              return (
                <LocationSummaryCard
                  key={config.id}
                  location={{ name: config?.name || store?.name || 'Unknown', square_location_id: config.square_location_id }}
                  codTotal={codTotal}
                  itemCount={locationItems.length}
                  onClick={() => setSelectedLocation(config)} />);


            })}
            </div>
          </div>
        }

        {error &&
        <div className="p-3 md:p-4 rounded-lg mb-6 text-sm md:text-base bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800">
            Error: {error}
          </div>
        }

        {activeView === 'reconciliation' ?
        <SquareCodDatasetTable key="reconciliation" title="Reconciliation" rows={reconciliationRows} isLoading={isLoading} emptyTitle="No unmatched deliveries" emptyDescription="Deliveries that do not have a matching transaction by amount and Square location will appear here." showLocationColumn={currentUser && isAppOwner(currentUser)} navHeight={navHeight} /> :
        activeView === 'deliveries' ?
        <SquareCodDatasetTable key="deliveries" title="In App COD Deliveries" rows={filteredDeliveryRows} isLoading={isLoading} emptyTitle="No COD deliveries found" emptyDescription="COD deliveries from your local cache will appear here even if Square data was cleared." showLocationColumn={currentUser && isAppOwner(currentUser)} navHeight={navHeight} groupByCollected showCatalogColumn /> :
        activeView === 'transactions' ?
        <SquareCodDatasetTable key="transactions" title="Square Transactions" rows={filteredTransactionRows} isLoading={isLoading} emptyTitle="No Square transactions found" emptyDescription="Recent Square transactions for the active city will appear here." showLocationColumn={currentUser && isAppOwner(currentUser)} navHeight={navHeight} /> :

        <SquareCodDatasetTable
          key="catalog"
          title="Square Catalog Items"
          rows={filteredCatalogRows}
          isLoading={isLoading}
          emptyTitle="No Square catalog items found"
          emptyDescription={`Offline catalog loaded: ${catalogItems.length} items, visible after filters: ${filteredCatalogItems.length}. If this stays at 0, the current store/driver filters do not match the filtered catalog records.`}
          showLocationColumn={currentUser && isAppOwner(currentUser)}
          navHeight={navHeight} />

        }

        {selectedLocation &&
        <TransactionHistoryPanel location={selectedLocation} transactions={allTransactions} drivers={drivers} catalogItems={catalogItems} onClose={() => setSelectedLocation(null)} />
        }

        {selectedCODItem &&
        <CODItemDetailModal item={selectedCODItem} locationConfigs={locationConfigs} stores={stores} transactions={allTransactions} drivers={drivers} deliveries={deliveries} onClose={() => setSelectedCODItem(null)} />
        }

        <AlertDialog open={!!itemToDelete} onOpenChange={(open) => !open && setItemToDelete(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Mark as Collected</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove "{itemToDelete?.name}" from Square and mark the linked delivery as Debit collected.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={confirmDelete} className="rounded-lg border border-emerald-700 bg-emerald-600 hover:bg-emerald-700">
                Collected
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>);

}