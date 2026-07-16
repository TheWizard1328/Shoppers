import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useAppData } from "@/components/utils/AppDataContext";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { CheckCircle, Clock, CreditCard, Loader2, CloudDownload, RefreshCw, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { isAppOwner, userHasRole } from "@/components/utils/userRoles";
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
import { generateDriverColor, hexToRgba } from "@/components/utils/colorGenerator";

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
  const [activeView, setActiveView] = useState('catalog');
  const [itemToDelete, setItemToDelete] = useState(null);
  const [soldCatalogItems, setSoldCatalogItems] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);
  const [lastCleanup] = useState(null);
  const [navHeight, setNavHeight] = useState(0);
  const [bgSyncProgress, setBgSyncProgress] = useState({ stage: 'idle' });
  const [isReconciling, setIsReconciling] = useState(false);
  const [isUpdatingCatalog, setIsUpdatingCatalog] = useState(false);
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
    loadAllRecords(base44.entities.SquareTransaction)]
    );

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
  const filteredCatalogRowsRef = useRef([]);
  const visibleStoreIdsRef = useRef(new Set());
  const selectedDriverUserIdsRef = useRef(new Set());

  const updateCatalog = useCallback(async () => {
    if (isUpdatingCatalog || isSyncing) return;
    setIsUpdatingCatalog(true);
    setError(null);
    try {
      const { offlineDB } = await import('@/components/utils/offlineDatabase');

      // Combine rows from both tabs to find items with a Transaction ID
      const allRows = [...(filteredCatalogRowsRef.current || []), ...(reconciliationRowsRef.current || [])];

      // ── Step 1: Delete catalog items that have a Transaction ID ──────────
      const toDeleteMap = new Map();
      for (const row of allRows) {
        const catalogId = row.catalogId;
        const transactionId = row.transactionId;
        if (!catalogId || catalogId === '--') continue;
        if (!transactionId || transactionId === '--') continue;
        if (!toDeleteMap.has(catalogId)) toDeleteMap.set(catalogId, row);
      }
      const toDelete = Array.from(toDeleteMap.values());

      for (const row of toDelete) {
        try {
          await base44.functions.invoke('squareDeleteCodItem', { catalogObjectId: row.catalogId });
          const existing = await base44.entities.SquareCatalogItems.filter({ square_catalog_object_id: row.catalogId });
          for (const record of existing || []) {
            await base44.entities.SquareCatalogItems.delete(record.id);
          }
        } catch (_) { /* skip individual failures */ }
      }

      // Purge deleted items from offline DB
      if (toDelete.length > 0) {
        const deletedIds = new Set(toDelete.map((r) => r.catalogId));
        const allOffline = (await offlineDB.getAll(offlineDB.STORES.SQUARE_CATALOG_ITEMS)) || [];
        const remaining = allOffline.filter((item) => !deletedIds.has(item.square_catalog_object_id) && !deletedIds.has(item.id));
        await offlineDB.replaceAllRecords(offlineDB.STORES.SQUARE_CATALOG_ITEMS, remaining);
      }

      // ── Step 2: Add items without a Catalog ID to Square ────────────────
      const rowsToAdd = (reconciliationRowsRef.current || []).filter(
        (row) => !row.catalogId || row.catalogId === '--'
      );

      const itemsToAdd = rowsToAdd.map((row) => {
        const delivery = row.rawDelivery;
        if (!delivery) return null;
        const patient = patients.find((p) => p?.id === delivery.patient_id || p?.patient_id === delivery.patient_id);
        return {
          deliveryId: delivery.id,
          patientName: patient?.full_name || null,
          storeId: delivery.store_id,
          codAmount: delivery.cod_total_amount_required,
          deliveryDate: delivery.delivery_date,
        };
      }).filter((item) => item && item.deliveryId && Number(item.codAmount) > 0);

      if (itemsToAdd.length > 0) {
        await base44.functions.invoke('squareCodCore', {
          action: 'syncSquareCods',
          items: itemsToAdd,
          deletions: [],
        });
      }

      // ── Step 3: Refresh UI from offline DB (windowed deliveries only) ───
      const { offlineDB: offlineDB2 } = await import('@/components/utils/offlineDatabase');
      const { startDateStr, endDateStr } = getSourceWindow();
      const windowedDeliveries = await loadDeliveriesFromOffline(offlineDB2, startDateStr, endDateStr);
      if (windowedDeliveries.length > 0) setDeliveries([...windowedDeliveries]);
      const [freshCatalog, freshTransactions] = await Promise.all([
        getCatalogItemsOffline(),
        getPaymentTransactionsOffline(),
      ]);
      if (freshCatalog) setCatalogItems([...freshCatalog]);
      if (freshTransactions) {
        setAllTransactions([...freshTransactions]);
        setSoldCatalogItems([...freshTransactions.filter((tx) => ['completed', 'refunded'].includes(tx?.status))]);
      }
      await loadSyncStatus();

      toast.success(`Catalog updated: ${itemsToAdd.length} added, ${toDelete.length} deleted`);
    } catch (err) {
      toast.error('Catalog update failed: ' + err.message);
      setError(err.message);
    } finally {
      setIsUpdatingCatalog(false);
    }
  }, [isUpdatingCatalog, isSyncing, patients, refreshUiFromOfflineOnly]);

  const runReconcile = useCallback(async () => {
    setIsReconciling(true);
    try {
      const { offlineDB } = await import('@/components/utils/offlineDatabase');

      // Load all deliveries + transactions from offline DB — reconciliationRows useMemo does the matching
      const [allOfflineDeliveries, offlineCatalog, offlineTransactions] = await Promise.all([
      offlineDB.getAll(offlineDB.STORES.DELIVERIES),
      offlineDB.getAll(offlineDB.STORES.SQUARE_CATALOG_ITEMS),
      offlineDB.getAll(offlineDB.STORES.SQUARE_TRANSACTIONS)]
      );

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

      // 5) PURGE online DBs then rebuild from Square API, then sync offline to match exactly
      let catalogError = null;
      let transactionError = null;
      try {
        // Step A: Purge + rebuild online SquareCatalogItems from live Square catalog API
        const purgeResult = await base44.functions.invoke('squareCodCore', { action: 'purgeAndRebuildCatalog' });
        const purgeData = purgeResult?.data || purgeResult || {};

        // Step B: Pull fresh transactions + deliveries from Square API (rebuilds online SquareTransaction records)
        const codResponse = await base44.functions.invoke('squareGetCODData', {
          forceDeliveryRefresh: true,
          daysBack: 90,
        });
        const codData = codResponse?.data || codResponse || {};
        const transactionRecords = codData.transactionRecords || [];
        const strippedDeliveries = Array.isArray(codData.deliveries) ?
        codData.deliveries.map(({ delivery_route_breadcrumbs, encoded_polyline, proof_photo_urls, signature_image_url, ...rest }) => rest) :
        [];

        // Step C: Use catalog records returned by purgeAndRebuildCatalog (already matches live Square)
        const catalogRecords = purgeData.catalogRecords || [];

        // Step D: Sync online→offline: replace offline stores with exactly what Square returned
        await squareCODOfflineManager.saveCatalogItemsOffline(catalogRecords);
        await squareCODOfflineManager.savePaymentTransactionsOffline(transactionRecords);

        // Step E: Merge deliveries (non-destructive — delivery data is not purged)
        const mergeDeliveries = async (freshRecords) => {
          const existing = (await offlineDB.getAll(offlineDB.STORES.DELIVERIES)) || [];
          const existingMap = new Map(existing.map((r) => [r.id, r]));
          (freshRecords || []).forEach((r) => { if (r?.id) existingMap.set(r.id, r); });
          await offlineDB.replaceAllRecords(offlineDB.STORES.DELIVERIES, Array.from(existingMap.values()));
          return Array.from(existingMap.values());
        };
        const mergedDeliveries = await mergeDeliveries(strippedDeliveries);

        const [uiCatalog, uiTransactions] = await Promise.all([
        squareCODOfflineManager.getCatalogItemsOffline(),
        squareCODOfflineManager.getPaymentTransactionsOffline()]
        );

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

      // Cleanup: delete catalog items that have already been collected via Square POS.
      // This runs inline (not as a background fire-and-forget) so the UI reflects the true state.
      try {
        const cleanupResult = await base44.functions.invoke('squareCodCore', { action: 'cleanupCollectedCatalogItems' });
        const cleanupData = cleanupResult?.data || cleanupResult || {};
        if (cleanupData?.deletedCount > 0) {
          // Re-fetch after cleanup so the UI reflects removed items
          const freshResponse = await base44.functions.invoke('squareGetCODData', { daysBack: 90 });
          const freshData = freshResponse?.data || freshResponse || {};
          await squareCODOfflineManager.saveCatalogItemsOffline(freshData.catalogRecords || []);
          await squareCODOfflineManager.savePaymentTransactionsOffline(freshData.transactionRecords || []);
          const [freshCatalog, freshTransactions] = await Promise.all([
          squareCODOfflineManager.getCatalogItemsOffline(),
          squareCODOfflineManager.getPaymentTransactionsOffline()]
          );
          setCatalogItems([...(freshCatalog || [])]);
          setAllTransactions([...(freshTransactions || [])]);
          setSoldCatalogItems([...(freshTransactions || []).filter((tx) => ['completed', 'refunded'].includes(tx.status))]);
          toast.success(`Sync complete — removed ${cleanupData.deletedCount} collected catalog item(s)`);
        } else {
          toast.success('Square data synced locally');
        }
      } catch (_) {
        toast.success('Square data synced locally');
      }

      let onlineSyncError = null;

      if (catalogError || transactionError) {
        const message = catalogError?.message || transactionError?.message || 'Square sync partially failed';
        console.error('[SquareManagement] Sync finished with issues', {
          catalogError: catalogError?.message || null,
          transactionError: transactionError?.message || null,
          onlineSyncError: onlineSyncError?.message || null
        });
        setError(message);
        toast.error('Sync finished with issues: ' + message);
      } else if (onlineSyncError) {
        console.error('[SquareManagement] Background online sync issue', {
          onlineSyncError: onlineSyncError?.message || null
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
        offlineDB.getAll(offlineDB.STORES.STORES)]
        );
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
        getPaymentTransactionsOffline()]
        );
        if ((normalizedCatalog || []).length > 0) setCatalogItems([...normalizedCatalog]);
        if ((normalizedTransactions || []).length > 0) {
          setAllTransactions([...normalizedTransactions]);
          setSoldCatalogItems([...normalizedTransactions.filter((tx) => ['completed', 'refunded'].includes(tx?.status))]);
        }
      } catch (_) {/* non-critical — full sync fires shortly after */}
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
        const nextDrivers = (appDataAppUsers || []).
        filter((user) => Array.isArray(user?.app_roles) && user.app_roles.includes('driver')).
        sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
        const currentAppUserRecord = (appDataAppUsers || []).find((user) => user?.user_id === appCurrentUser?.id) || null;

        setCurrentUser(appCurrentUser || null);
        setCurrentAppUser(currentAppUserRecord);

        // For drivers: lock view to catalog, pre-select their own driver filter
        const isDriver = !!(appCurrentUser && !isAppOwner(appCurrentUser) && userHasRole(appCurrentUser, 'driver'));
        if (isDriver) {
          setActiveView('catalog');
          if (currentAppUserRecord?.id) setSelectedDriverFilter(currentAppUserRecord.id);
          setSelectedStoreFilter('all');
        }
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
        }return { offlineDB, nextLocationConfigs };} catch (err) {console.error('Failed to sync lookup data:', err);return null;}}; // First load: also load deliveries and trigger Square sync
    if (!initialLoadKeyRef.current) {// CRITICAL: Don't lock the initialLoadKey until we have locationConfigs.
      // appCurrentUser often arrives before appDataStores, which means locationConfigs
      // would be empty when the filter chain evaluates — filtering out every delivery row.
      // Wait until either the offline DB or appDataStores has produced configs.
      const configsReady = (locationConfigsRef.current || []).length > 0 || (appDataStores || []).length > 0;if (!configsReady) return; // re-runs when appDataStores arrives
      initialLoadKeyRef.current = true;(async () => {const result = await syncLookupData();if (!result) return;try {const { offlineDB } = result;const { startDateStr, endDateStr } = getSourceWindow();await loadReconciliationFromOffline(offlineDB, startDateStr, endDateStr);await loadSquareViewFromOffline();setIsLoading(false);setHasInitialLoadCompleted(true);await syncFromSquare();setBgSyncProgress({ stage: 'idle' });
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
    return locationConfigs.find((c) => c?.store_name === store.name) ||
    locationConfigs.find((c) => store.square_location_config_id && c?.id === store.square_location_config_id) ||
    null;
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

  // A delivery is considered a "manual override" (collected without Square) if it has
  // Debit or Credit cod_payments recorded and no matching Square transaction.
  // These should be excluded from Reconcile and Catalog tabs.
  function isManualCardOverride(delivery) {
    const payments = Array.isArray(delivery?.cod_payments) ? delivery.cod_payments : [];
    if (payments.length === 0) return false;
    return payments.some((p) => p?.type === 'Debit' || p?.type === 'Credit') &&
      payments.every((p) => p?.type === 'Debit' || p?.type === 'Credit');
  }

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

  // Build a map of locationId → [storeId, storeId, ...] for shared-location disambiguation
  const storeIdsByLocationId = useMemo(() => {
    const map = new Map();
    for (const store of stores) {
      if (!store?.id) continue;
      const config = getConfigForStore(store);
      if (!config?.square_location_id) continue;
      if (!map.has(config.square_location_id)) map.set(config.square_location_id, []);
      map.get(config.square_location_id).push(store.id);
    }
    return map;
  }, [stores, locationConfigs]);

  const findMatchingDeliveryForTransaction = useCallback((transaction, resolvedStoreId = null) => {
    const transactionAmountSet = getTransactionAmountSet(transaction);
    const transactionDate = getTransactionEffectiveDateString(transaction);
    const parsedItem = parseSquareItemName(transaction?.item_name);
    const patientName = parsedItem?.patientName || '';
    const txLocationId = transaction?.location_id || null;

    // All store IDs valid for this transaction's location (handles shared location IDs)
    const validStoreIds = txLocationId ?
    new Set(storeIdsByLocationId.get(txLocationId) || []) :
    null;
    // If we have a resolved store, prefer it but don't block matches from sibling stores at the same location
    const preferredStoreId = resolvedStoreId || transaction?.store_id || null;

    return (deliveries || []).find((delivery) => {
      if (!delivery) return false;
      if (transaction.delivery_id && delivery.id === transaction.delivery_id) return true;
      // Only filter by store if the delivery's store is NOT in the valid location pool
      if (validStoreIds && validStoreIds.size > 0 && !validStoreIds.has(delivery.store_id)) return false;
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
  }, [deliveries, getTransactionEffectiveDateString, patients, storeIdsByLocationId]);

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
      const amountsMatch = amountSetsIntersect(deliveryAmountSet, transactionAmountSet);

      const parsed = parseSquareItemName(String(transaction.item_name || '').trim());
      const parsedTransactionDateString = parsed?.deliveryDate || null;
      const transactionCreatedDate = getTransactionCreatedDate(transaction);
      const transactionCreatedDateString = transactionCreatedDate ? format(transactionCreatedDate, 'yyyy-MM-dd') : null;
      const transactionDateString = parsedTransactionDateString || transactionCreatedDateString;
      const transactionStoreAbbreviation = String(parsed?.storeAbbr || '').trim().toLowerCase();
      const transactionLocationId = String(transaction.location_id || '').trim();
      const txLocationId = transaction.location_id || null;

      const dateMatches = !!deliveryDateString && !!transactionDateString && deliveryDateString === transactionDateString;
      // Location matches if same ID, OR if both are valid store IDs at the same shared Square location
      const sharedLocationIds = txLocationId ? storeIdsByLocationId.get(normalizedLocationId) || [] : [];
      const locationMatches = !!normalizedLocationId && !!transactionLocationId && (
      normalizedLocationId === transactionLocationId ||
      sharedLocationIds.length > 1 && sharedLocationIds.includes(transactionLocationId));

      const abbreviationMatches = !!storeAbbreviation && (
      !!transactionStoreAbbreviation && storeAbbreviation === transactionStoreAbbreviation ||
      String(transaction.item_name || '').toLowerCase().includes(storeAbbreviation));

      const searchableText = String(transaction.item_name || transaction.raw_square_data?.note || transaction.raw_square_data?.notes || '').trim();
      const nameMatches = !!patientName && !!searchableText && patientNamesMatch(patientName, searchableText);

      // Amount + name alone is sufficient (handles plain-text transaction item names like "Wendy Paustian")
      if (amountsMatch && nameMatches) return true;

      if (!amountsMatch) return false;

      if (dateMatches && (locationMatches || abbreviationMatches || nameMatches)) return true;
      if (locationMatches && (abbreviationMatches || nameMatches)) return true;
      if (abbreviationMatches && nameMatches) return true;

      return false;
    });
  }, [allTransactions, patients, stores, getTransactionCreatedDate, storeIdsByLocationId]);

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

      toast.success('Marked as collected — running sync...');
      setItemToDelete(null);
      setDeletingId(null);
      await syncFromSquare();
    } catch (err) {
      console.error('Collect failed:', err);
      toast.error('Failed to mark collected: ' + err.message);
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

    // Build a fast lookup of settled transaction delivery IDs and catalog object IDs
    const settledTxCatalogIds = new Set(
      (allTransactions || []).
      filter((t) => ['completed', 'refunded'].includes(t?.status) && t?.square_catalog_object_id).
      map((t) => t.square_catalog_object_id)
    );
    const settledTxDeliveryIds = new Set(
      (allTransactions || []).
      filter((t) => ['completed', 'refunded'].includes(t?.status) && t?.delivery_id).
      map((t) => t.delivery_id)
    );

    items = items.filter((item) => {
      const linkedDelivery = deliveries.find((d) => d?.id === item.delivery_id);
      if (linkedDelivery?.status === 'pending') return false;
      // Direct match by catalog object ID or delivery_id against settled transactions
      const catalogObjId = item.catalog_object_id || item.id;
      if (catalogObjId && settledTxCatalogIds.has(catalogObjId)) return false;
      if (item.delivery_id && settledTxDeliveryIds.has(item.delivery_id)) return false;
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
    date.setDate(date.getDate() - Number(selectedDaysRange || 90) + 1);
    return date;
  }, [selectedDaysRange]);

  // Ceiling: deliveries dated after today should never appear in COD views
  const todayDateString = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, []);

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
    store.square_location_config_id && c?.id === store.square_location_config_id
    );
  }), [stores, locationConfigs]);

  const availableStoresForFilter = useMemo(() => {
    const cityFilteredStores = activeCityIds.length > 0 ?
    storesWithSquareLocationIds.filter((store) => activeCityIds.includes(store?.city_id)) :
    storesWithSquareLocationIds;
    const effectiveStores = cityFilteredStores.length > 0 ? cityFilteredStores : storesWithSquareLocationIds;
    return [...effectiveStores].sort((a, b) => (a?.sort_order ?? Infinity) - (b?.sort_order ?? Infinity));
  }, [storesWithSquareLocationIds, activeCityIds]);

  const visibleStoreIds = useMemo(() => {
    const scopedStores = selectedStoreFilter && selectedStoreFilter !== 'all' ?
    availableStoresForFilter.filter((store) => store?.id === selectedStoreFilter) :
    availableStoresForFilter;
    const result = new Set(scopedStores.map((store) => store?.id).filter(Boolean));
    visibleStoreIdsRef.current = result;
    return result;
  }, [availableStoresForFilter, selectedStoreFilter]);

  // Config IDs for visible stores (resolved by name match OR legacy ID)
  const visibleSquareLocationConfigIds = useMemo(() => new Set(
    storesWithSquareLocationIds.
    filter((store) => visibleStoreIds.has(store?.id)).
    map((store) =>
    locationConfigs.find((c) => c?.store_name === store.name)?.id ||
    locationConfigs.find((c) => c?.id === store.square_location_config_id)?.id
    ).
    filter(Boolean)
  ), [storesWithSquareLocationIds, visibleStoreIds, locationConfigs]);

  const visibleLocationIds = useMemo(() => new Set(
    locationConfigs.
    filter((lc) => visibleSquareLocationConfigIds.has(lc?.id)).
    map((lc) => lc?.square_location_id).
    filter(Boolean)
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

  // Resolve the driver color (same palette as dashboard) for a given driver_id or driver user_id
  const getDriverColorForId = useCallback((driverId) => {
    if (!driverId) return null;
    const driver = drivers.find((d) => d?.user_id === driverId || d?.id === driverId);
    return driver?.user_name ? generateDriverColor(driver.user_name) : null;
  }, [drivers]);

  const filteredDeliveryRows = useMemo(() => {
    const rows = (deliveries || []).filter((d) => d && Number(d.cod_total_amount_required || 0) > 0).
    filter((delivery) => {
      if (!delivery) return false;
      if (['failed', 'cancelled', 'pending'].includes(delivery.status)) return false;
      // Exclude future-dated deliveries — not yet assigned/accepted
      if (delivery.delivery_date && delivery.delivery_date > todayDateString) return false;
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
      const matchingTx = hasMatch ?
      (allTransactions || []).find((tx) => {
        if (!tx || tx.type !== 'collection') return false;
        if (!['completed', 'refunded', 'pending'].includes(tx.status)) return false;
        if (tx.delivery_id && tx.delivery_id === delivery.id) return true;
        const deliveryPatient = patients.find((p) => p?.id === delivery.patient_id || p?.patient_id === delivery.patient_id);
        const txSearchText = String(tx.item_name || tx.raw_square_data?.note || tx.raw_square_data?.notes || '').trim();
        const nameMatches = !!(deliveryPatient?.full_name && txSearchText && patientNamesMatch(deliveryPatient.full_name, txSearchText));
        const txAmountSet = getTransactionAmountSet(tx);
        const amountsMatch = amountSetsIntersect(getDeliveryPaymentAmountSet(delivery), txAmountSet);
        // Amount + name is sufficient
        if (amountsMatch && nameMatches) return true;
        if (!amountsMatch) return false;
        const parsed = parseSquareItemName(String(tx.item_name || ''));
        const txDate = parsed?.deliveryDate || null;
        const txStoreAbbr = String(parsed?.storeAbbr || '').trim().toLowerCase();
        const deliveryStoreAbbr = String(store?.abbreviation || '').trim().toLowerCase();
        const abbrMatches = !!deliveryStoreAbbr && (txStoreAbbr === deliveryStoreAbbr || String(tx.item_name || '').toLowerCase().includes(deliveryStoreAbbr));
        if (txDate === delivery.delivery_date && (abbrMatches || nameMatches || tx.location_id === resolvedLocationId)) return true;
        if (abbrMatches && nameMatches) return true;
        return false;
      }) :
      null;
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
        driverColor: getDriverColorForId(delivery.driver_id),
        actions: hasMatch ?
        <Button variant="secondary" size="sm" className="border border-emerald-300 bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">Collected</Button> :
        delivery.status === 'pending' ?
        <Button variant="secondary" size="sm" className="border border-slate-300 bg-slate-100 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400">Pending Pickup</Button> :
        <Button variant="secondary" size="sm" className="border border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-300 leading-tight h-auto py-1 text-center whitespace-normal"><span>Not<br />Collected</span></Button>
      };
    });

    const seenRowKeys = new Set();
    return rows.filter((row) => {
      const rowKey = row.key || row.id;
      if (seenRowKeys.has(rowKey)) return false;
      seenRowKeys.add(rowKey);
      return true;
    });
  }, [deliveries, lookbackStart, todayDateString, selectedDriverFilter, selectedDriverUserIds, patients, stores, locationConfigs, catalogItems, allTransactions, visibleSquareLocationConfigIds, getDriverColorForId]);

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
      // Always apply date filter — use item-name date first, fall back to created_date
      const transactionDate = getTransactionFilterDate(transaction) || (
      transaction?.created_date ? new Date(transaction.created_date) : null) || (
      transaction?.raw_square_data?.payment_date ? new Date(transaction.raw_square_data.payment_date) : null);
      if (!transactionDate || transactionDate < lookbackStart) return false;

      const config = locationConfigs.find((c) => c?.square_location_id === transaction.location_id);
      // Check visibility: config found by location_id OR store resolved from config.store_name
      const configStoreVisible = config ? visibleSquareLocationConfigIds.has(config.id) : false;
      const locationIsVisible = configStoreVisible;
      const matchedDeliveryForFilter = !locationIsVisible || selectedDriverFilter && selectedDriverFilter !== 'all' ?
      findMatchingDeliveryForTransaction(transaction, transaction.store_id || null) :
      null;
      if (!locationIsVisible) {
        // Fallback: try resolving store from transaction.store_id, matched delivery, or config.store_name
        const matchedStore = stores.find((s) => s?.id === transaction.store_id) || (
        matchedDeliveryForFilter ? stores.find((s) => s?.id === matchedDeliveryForFilter.store_id) : null) ||
        getStoreForConfig(config) ||
        null;
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
      const store = stores.find((s) => s?.id === transaction.store_id) || (
      matchedDelivery ? stores.find((s) => s?.id === matchedDelivery.store_id) : null) ||
      getStoreForConfig(config) ||
      null;
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
        catalogId: (() => {
          // Prefer the catalog item's own ID (matches Catalog tab); fall back to transaction's reference
          const linkedCatalogItem = (catalogItems || []).find((ci) =>
          ci.delivery_id && matchedDelivery?.id && ci.delivery_id === matchedDelivery.id ||
          ci.catalog_object_id && transaction.square_catalog_object_id && ci.catalog_object_id === transaction.square_catalog_object_id ||
          ci.id && transaction.square_catalog_object_id && ci.id === transaction.square_catalog_object_id
          );
          return linkedCatalogItem?.catalog_object_id || linkedCatalogItem?.id || transaction.square_catalog_object_id || '--';
        })(),
        transactionId: transaction.square_payment_id || transaction.square_transaction_id || transaction.id || '--',
        deliveryDate: displayDate,
        collectionDate,
        collectionType,
        subtext: collectedByName ? `Collected by ${collectedByName}` : transaction.payment_method || null,
        driverColor: getDriverColorForId(matchedDelivery?.driver_id || transaction.driver_id),
        notes: transaction.raw_square_data?.note || transaction.raw_square_data?.notes || null,
        actions: matchedDelivery || transaction.square_payment_id || transaction.square_transaction_id ?
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
  }, [allTransactions, lookbackStart, visibleLocationIds, selectedDriverFilter, selectedDriverUserIds, locationConfigs, stores, drivers, getTransactionSearchNames, getTransactionFilterDate, getTransactionEffectiveDateString, findMatchingDeliveryForTransaction, visibleSquareLocationConfigIds, getDriverColorForId]);

  const filteredCatalogRows = useMemo(() => {
    const rows = (catalogItems || []).
    filter((item) => {
      if (driverScopedLocationIds && item.location_id && !driverScopedLocationIds.has(item.location_id)) return false;
      if (visibleLocationIds.size > 0 && item.location_id && !visibleLocationIds.has(item.location_id)) return false;
      const store = stores.find((candidateStore) => candidateStore?.id === item.store_id) ||
      getStoreForConfig(locationConfigs.find((c) => c?.square_location_id === item.location_id)) ||
      null;
      const storeConfig = getConfigForStore(store);
      if (!storeConfig?.id || !visibleSquareLocationConfigIds.has(storeConfig.id)) return false;
      // Exclude catalog items linked to pending or future-dated deliveries
      const linkedDelivery = item.delivery_id ? deliveries.find((d) => d?.id === item.delivery_id) : null;
      if (linkedDelivery?.status === 'pending') return false;
      // Exclude if the linked delivery was paid by Debit/Credit (manual override — no Square transaction needed)
      if (linkedDelivery && isManualCardOverride(linkedDelivery)) return false;
      const itemDate = item.delivery_date || parseSquareItemName(item.name || item.item_name)?.deliveryDate;
      if (itemDate && itemDate > todayDateString) return false;
      return true;
    }).
    map((item) => {
      const config = locationConfigs.find((c) => c?.square_location_id === item.location_id);
      const store = stores.find((s) => s?.id === item.store_id) || getStoreForConfig(config);
      const linkedDelivery = item.delivery_id ? deliveries.find((d) => d?.id === item.delivery_id) : null;
      // A catalog item is "Collected" ONLY if there is a matching transaction in the transactions list.
      // Match by: square_catalog_object_id on the transaction, OR delivery_id on the transaction.
      const catalogObjectId = item.catalog_object_id || item.id;
      const linkedPatient = linkedDelivery?.patient_id ?
      patients.find((p) => p?.id === linkedDelivery.patient_id || p?.patient_id === linkedDelivery.patient_id) : null;
      const linkedPatientName = linkedPatient?.full_name || parseSquareItemName(item.name || item.item_name)?.patientName || '';
      const matchingTx = (allTransactions || []).find((tx) => {
        if (!tx) return false;
        // Match by delivery_id (most reliable)
        if (linkedDelivery?.id && tx.delivery_id === linkedDelivery.id) return true;
        // Match by catalog object ID on the transaction
        if (tx.square_catalog_object_id && (tx.square_catalog_object_id === catalogObjectId || tx.square_catalog_object_id === item.id)) return true;
        const txAmountCents = Math.round(Number(tx.amount || 0) * 100);
        const itemAmountCents = Math.round(Number(item.price_dollars || item.amount || 0) * 100);
        const amountsMatch = txAmountCents === itemAmountCents;
        const txSearchableText = String(tx.item_name || tx.raw_square_data?.note || tx.raw_square_data?.notes || '').trim();
        const txNameMatches = !!linkedPatientName && !!txSearchableText && patientNamesMatch(linkedPatientName, txSearchableText);
        // Amount + patient name match (handles plain-text transaction names)
        if (amountsMatch && txNameMatches) return true;
        // Amount + location + delivery date from item name
        if (!amountsMatch || !item.location_id || tx.location_id !== item.location_id) return false;
        const itemDateStr = item.delivery_date || parseSquareItemName(item.name || item.item_name)?.deliveryDate;
        const txDateStr = getTransactionEffectiveDateString(tx);
        return !!(itemDateStr && txDateStr && itemDateStr === txDateStr);
      });
      const isCollected = !!matchingTx;
      return {
        id: catalogObjectId,
        key: `${catalogObjectId || 'catalog'}|${item.location_id || '--'}|${item.delivery_date || parseSquareItemName(item.name || item.item_name)?.deliveryDate || 'no-date'}`,
        itemName: item.name || item.item_name || 'Catalog Item',
        amount: Number(item.price_dollars || item.amount || 0),
        storeName: store?.name || config?.name || 'Unknown',
        locationId: item.location_id || '--',
        catalogId: catalogObjectId || '--',
        transactionId: matchingTx ? matchingTx.square_payment_id || matchingTx.square_transaction_id || matchingTx.id || '--' : '--',
        deliveryDate: item.delivery_date || parseSquareItemName(item.name || item.item_name)?.deliveryDate,
        subtext: item.description || item.status || null,
        driverColor: getDriverColorForId(linkedDelivery?.driver_id),
        isCollected,
        actions: isCollected ?
        <Button variant="secondary" size="sm" className="border border-emerald-300 bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">Collected</Button> :
        <Button
          variant="secondary"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            setItemToDelete(item);
          }}
          disabled={deletingId === catalogObjectId || !item.delivery_id}
          className="rounded-lg border border-emerald-300 bg-white text-emerald-700 shadow-sm hover:bg-emerald-50 hover:border-emerald-400 dark:border-emerald-700 dark:bg-slate-900 dark:text-emerald-300 dark:hover:bg-emerald-900/20">
          {deletingId === catalogObjectId ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Collect'}
        </Button>
      };
    }).
    sort((a, b) => {
      const aCollected = a.actions?.props?.className?.includes('bg-emerald-100') || a.actions?.props?.className?.includes('bg-emerald-900') ? 1 : 0;
      const bCollected = b.actions?.props?.className?.includes('bg-emerald-100') || b.actions?.props?.className?.includes('bg-emerald-900') ? 1 : 0;
      if (aCollected !== bCollected) return aCollected - bCollected;
      return String(b.deliveryDate || '').localeCompare(String(a.deliveryDate || ''));
    });

    const seenRowKeys = new Set();
    return rows.filter((row) => {
      const rowKey = row.key || row.id;
      if (seenRowKeys.has(rowKey)) return false;
      seenRowKeys.add(rowKey);
      return true;
    });
  }, [catalogItems, locationConfigs, stores, visibleLocationIds, driverScopedLocationIds, deletingId, lookbackStart, todayDateString, deliveries, visibleSquareLocationConfigIds, allTransactions, hasMatchingSquareTransaction, getDriverColorForId]);

  // Build a fast set of delivery IDs that are already matched in the Transactions tab
  const transactionMatchedDeliveryIds = useMemo(() => {
    const ids = new Set();
    for (const tx of allTransactions || []) {
      if (!tx || tx.type !== 'collection') continue;
      if (!['completed', 'pending'].includes(tx.status)) continue;
      if (tx.delivery_id) ids.add(tx.delivery_id);
    }
    return ids;
  }, [allTransactions]);

  // Build a fast set of (amount+patientName) signatures from transactions so we can match by name
  const transactionSignatures = useMemo(() => {
    const sigs = new Set();
    for (const tx of allTransactions || []) {
      if (!tx || tx.type !== 'collection') continue;
      if (!['completed', 'pending'].includes(tx.status)) continue;
      const amtCents = Math.round(Number(tx.amount || 0) * 100);
      const parsed = parseSquareItemName(String(tx.item_name || ''));
      const name = normalizePatientName(parsed?.patientName || tx.item_name || '');
      if (name) sigs.add(`${amtCents}::${name}`);
    }
    return sigs;
  }, [allTransactions]);

  const reconciliationRows = useMemo(() => {
    const rows = (deliveries || []).
    filter((delivery) => {
      if (!delivery) return false;
      if (['failed', 'pending'].includes(delivery.status)) return false;
      // Exclude future-dated deliveries — not yet assigned/accepted by a driver
      if (delivery.delivery_date && delivery.delivery_date > todayDateString) return false;
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

      // Exclude deliveries with Debit/Credit payments — treated as manually collected (no Square needed)
      if (isManualCardOverride(delivery)) return false;

      // Exclude if directly matched by delivery_id in any transaction
      if (transactionMatchedDeliveryIds.has(delivery.id)) return false;

      // Exclude if matched by amount + patient name in any transaction
      const patient = patients.find((p) => p?.id === delivery.patient_id || p?.patient_id === delivery.patient_id);
      if (patient?.full_name) {
        const amtCents = Math.round(Number(delivery.cod_total_amount_required || 0) * 100);
        const deliveryName = normalizePatientName(patient.full_name);
        // Check if any transaction signature matches this delivery's amount + name
        const hasNameMatch = Array.from(transactionSignatures).some((sig) => {
          const [sigAmt, sigName] = sig.split('::');
          if (Number(sigAmt) !== amtCents) return false;
          return patientNamesMatch(deliveryName, sigName);
        });
        if (hasNameMatch) return false;
      }

      return !hasMatchingSquareTransaction(delivery, resolvedLocationId, allTransactions);
    }).
    sort((a, b) => String(b.delivery_date || '').localeCompare(String(a.delivery_date || ''))).
    map((delivery) => {
      const patient = patients.find((p) => p?.id === delivery?.patient_id || p?.patient_id === delivery?.patient_id);
      const store = stores.find((s) => s?.id === delivery?.store_id);
      const config = getConfigForStore(store);
      const resolvedLocationId = config?.square_location_id || '--';
      const deliveryAmountCents = Math.round(Number(delivery.cod_total_amount_required || 0) * 100);
      const patientName = patient?.full_name || '';

      // Detect cross-store collection: a transaction that matches by amount + patient name
      // but was collected at a DIFFERENT Square location than the delivery's expected store.
      const crossStoreTx = (allTransactions || []).find((tx) => {
        if (!tx || tx.type !== 'collection') return false;
        if (!['completed', 'pending'].includes(tx.status)) return false;
        if (tx.location_id === resolvedLocationId) return false; // same location = not cross-store
        const txAmountCents = Math.round(Number(tx.amount || 0) * 100);
        if (txAmountCents !== deliveryAmountCents) return false;
        if (!patientName) return false;
        return patientNamesMatch(patientName, String(tx.item_name || ''));
      }) || null;

      // Resolve which store the cross-store tx was collected at
      const crossStoreConfig = crossStoreTx ?
      locationConfigs.find((c) => c?.square_location_id === crossStoreTx.location_id) :
      null;
      const crossStoreStore = crossStoreConfig ? getStoreForConfig(crossStoreConfig) : null;
      const crossStoreName = crossStoreStore?.name || crossStoreConfig?.name || crossStoreTx?.location_id || null;

      const linkedCatalogItem = (catalogItems || []).find((ci) => ci?.delivery_id === delivery.id);
      const catalogObjectId = linkedCatalogItem?.catalog_object_id || linkedCatalogItem?.id || null;

      // Find any matching transaction (same-location or cross-store) for the Transaction ID column
      const anyMatchingTx = crossStoreTx || (allTransactions || []).find((tx) => {
        if (!tx || tx.type !== 'collection') return false;
        if (!['completed', 'pending'].includes(tx.status)) return false;
        if (tx.delivery_id === delivery.id) return true;
        const txAmountCents = Math.round(Number(tx.amount || 0) * 100);
        if (txAmountCents !== deliveryAmountCents) return false;
        if (!patientName) return false;
        return patientNamesMatch(patientName, String(tx.item_name || ''));
      }) || null;

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
        catalogId: catalogObjectId || '--',
        transactionId: anyMatchingTx ? anyMatchingTx.square_payment_id || anyMatchingTx.square_transaction_id || anyMatchingTx.id || '--' : '--',
        deliveryDate: delivery.delivery_date,
        collectionType: Array.isArray(delivery?.cod_payments) && delivery.cod_payments.length > 0 ?
        Array.from(new Set(delivery.cod_payments.map((payment) => payment?.type).filter(Boolean))).join(', ') :
        null,
        subtext: delivery.driver_name || null,
        driverColor: getDriverColorForId(delivery.driver_id),
        crossStoreAlert: crossStoreTx ? { collectedAt: crossStoreName } : null,
        actions: crossStoreTx ?
        <div className="flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-orange-500 flex-shrink-0" />
              <Button variant="secondary" size="sm" className="border border-orange-300 bg-orange-100 text-orange-800 hover:bg-orange-100 dark:border-orange-700 dark:bg-orange-900/40 dark:text-orange-300 leading-tight h-auto py-1 text-center whitespace-normal">
                <span>Cross-Store{crossStoreName ? `: ${crossStoreName}` : ''}</span>
              </Button>
            </div> :

        <Button variant="secondary" size="sm" className="border border-red-300 bg-red-100 text-red-800 hover:bg-red-100 dark:border-red-700 dark:bg-red-900/40 dark:text-red-300">Unmatched</Button>

      };
    });

    const seenRowKeys = new Set();
    return rows.filter((row) => {
      const rowKey = row.key || row.id;
      if (seenRowKeys.has(rowKey)) return false;
      seenRowKeys.add(rowKey);
      return true;
    });
  }, [deliveries, stores, visibleSquareLocationConfigIds, lookbackStart, todayDateString, selectedDriverFilter, selectedDriverUserIds, locationConfigs, allTransactions, hasMatchingSquareTransaction, patients, formatItemNameForDisplay, catalogItems, transactionMatchedDeliveryIds, transactionSignatures, getDriverColorForId]);

  reconciliationRowsRef.current = reconciliationRows;
  filteredCatalogRowsRef.current = filteredCatalogRows;

  const codDeliveriesCount = useMemo(() => filteredDeliveryRows.length, [filteredDeliveryRows]);

  const collectedCodTypeBreakdown = useMemo(() => {
    const counts = { Cash: 0, Debit: 0, Credit: 0, Check: 0, Other: 0 };
    filteredDeliveryRows.forEach((row) => {
      const delivery = row.rawDelivery;
      if (!delivery) return;
      const codPayments = Array.isArray(delivery.cod_payments) ? delivery.cod_payments : [];
      if (codPayments.length > 0) {
        const deliveryTypes = new Set(codPayments.filter((payment) => Number(payment?.amount || 0) > 0).map((payment) => payment?.type).filter((type) => ['Cash', 'Debit', 'Credit', 'Check', 'Other'].includes(type)));
        deliveryTypes.forEach((type) => {counts[type] += 1;});
      }
    });
    return counts;
  }, [filteredDeliveryRows]);

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

  const isDriverView = !!(currentUser && !isAppOwner(currentUser) && userHasRole(currentUser, 'driver'));

  return (
    <div className="px-4 md:px-6 pt-4 md:pt-6 bg-background text-foreground w-full h-full overflow-y-auto md:overflow-hidden flex flex-col">
      {/* ═══════════════════════════════════════════════════════════════════
                                   MASTER LAYOUT  –  2 main rows × 2 columns
                                   Left column  : auto/shrink  (content-width)
                                   Right column : flex-1       (fills remaining width)
                               ═══════════════════════════════════════════════════════════════════ */}
      <div className="flex-shrink-0 mb-4">

        {/* ── 2×2 GRID LAYOUT ── */}
        <div className="grid grid-cols-1 gap-2 md:grid-cols-[40%_60%]">

          {/* R1-C1: Filters + Tab buttons */}
          <div className="flex flex-col gap-2">

            {/* Sub-row 1: Drivers | Stores | Date range | Sync */}
            <div className="flex flex-row items-center gap-2">
              {currentUser && isAppOwner(currentUser) && drivers.length > 0 &&
              <div className="flex-1 min-w-0">
                <Select value={selectedDriverFilter} onValueChange={setSelectedDriverFilter}>
                  <SelectTrigger className="w-full text-sm">
                    <SelectValue placeholder="All Drivers" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Drivers</SelectItem>
                    {drivers.map((driver) =>
                    <SelectItem key={driver.id} value={driver.id}>{driver.user_name}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
              }
              {isDriverView && currentAppUser &&
              <div className="flex-1 min-w-0">
                <Select value={selectedDriverFilter} disabled>
                  <SelectTrigger className="w-full text-sm opacity-70 cursor-not-allowed">
                    <SelectValue>{currentAppUser.user_name || 'My Items'}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={currentAppUser.id}>{currentAppUser.user_name}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              }
              <div className="flex-1 min-w-0">
                <Select value={selectedStoreFilter} onValueChange={setSelectedStoreFilter}>
                  <SelectTrigger className="w-full text-sm">
                    <SelectValue placeholder="All Stores" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Stores</SelectItem>
                    {availableStoresForFilter.map((store) =>
                    <SelectItem key={store.id} value={store.id}>{store.name}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1 min-w-0">
                <Select value={selectedDaysRange} onValueChange={setSelectedDaysRange}>
                  <SelectTrigger className="w-full text-sm">
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
              </div>
              {currentUser && isAppOwner(currentUser) &&
              <div className="flex-1 min-w-0">
                <Button onClick={syncFromSquare} disabled={isLoading || isSyncing} className="w-full gap-1 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800 px-3">
                  <CloudDownload className={`w-4 h-4 flex-shrink-0 ${isSyncing ? 'animate-pulse' : ''}`} />
                  {isSyncing ? 'Syncing...' : 'Sync'}
                </Button>
              </div>
              }
            </div>

            {/* Sub-row 2: Tab buttons */}
            {!isDriverView && currentUser && isAppOwner(currentUser) ?
            <div className="grid grid-cols-4 gap-2">
                {[{ key: 'deliveries', label: 'Deliveries' }, { key: 'transactions', label: 'Transactions' }, { key: 'catalog', label: 'Catalog' }, { key: 'reconciliation', label: 'Reconcile' }].map((view) =>
              <Button
                key={view.key}
                type="button"
                variant={activeView === view.key ? 'default' : 'outline'}
                size="sm"
                onClick={() => setActiveView(view.key)}
                className="w-full h-auto py-1.5 justify-center rounded-md px-2 flex-col gap-0">
                    <span className="text-xs font-medium leading-tight">{view.label}</span>
                    {typeof viewCounts[view.key] === 'number' && <span className="text-[11px] opacity-60 leading-tight">{viewCounts[view.key]}</span>}
                  </Button>
              )}
              </div> :

            <div className="flex flex-row flex-wrap items-center gap-2">
                <SquareCodViewSwitcher activeView={activeView} onChange={setActiveView} counts={viewCounts} hidden={isDriverView} />
              </div>
            }





          </div>

          {/* R1-C2: Sync status card */}
          <div className="flex-1 min-w-0 self-start">
            {syncStatus &&
            <SyncStatusIndicator
              syncStatus={syncStatus}
              isSyncing={isSyncing}
              error={error}
              codDeliveryCount={codDeliveriesCount}
              catalogItemCount={filteredCatalogItems.length}
              cardSpendCount={filteredCardSalesCount}
              salesCount={filteredSalesCount}
              collectedCodTypeBreakdown={collectedCodTypeBreakdown} />
            }
          </div>

          {/* R2-C1: 4 stat cards (catalog view only) */}
          {activeView === 'catalog' && currentUser && isAppOwner(currentUser) && (() => {
            const catalogDeliveryIdsForStats = new Set(filteredCatalogRows.map((r) => r.rawDelivery?.id || r.id).filter(Boolean));
            const newCatalogItems = reconciliationRows.filter((r) => {
              if (r.catalogId && r.catalogId !== '--') return false;
              const deliveryId = r.rawDelivery?.id || r.id;
              return !catalogDeliveryIdsForStats.has(deliveryId);
            });
            const newCatalogTotal = newCatalogItems.reduce((s, r) => s + Number(r.amount || 0), 0);
            const uncollectedRows = filteredCatalogRows.filter((row) => !row.isCollected);
            const collectedRows = filteredCatalogRows.filter((row) => row.isCollected);
            const uncollectedTotal = uncollectedRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
            const collectedAmount = collectedRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
            const catalogTotal = filteredCatalogRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
            // Total = Catalog Items + New Items - Collected
            const grandTotal = catalogTotal + newCatalogTotal - collectedAmount;
            const totalItemCount = filteredCatalogRows.length + newCatalogItems.length;
            const uncollectedItemCount = uncollectedRows.length;
            const catalogOnlyItemCount = filteredCatalogRows.length;
            // Bar percentages relative to the overall pool (catalog + new) for all 4 cards
            const overallPool = catalogTotal + newCatalogTotal > 0 ? catalogTotal + newCatalogTotal : 1;
            const collectedPct = (collectedAmount / overallPool) * 100;
            const uncollectedPct = (uncollectedTotal / overallPool) * 100;
            const catalogPct = (catalogTotal / overallPool) * 100;
            const newItemsPct = (newCatalogTotal / overallPool) * 100;
            return (
              <div className="grid grid-cols-4 gap-3 mt-6 mb-1">
                {/* Total Amount = Catalog + New - Collected */}
                <div className="bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-slate-100 dark:border-slate-800 overflow-hidden">
                  <div className="px-5 pt-5 pb-3">
                    <div className="text-[11px] font-semibold tracking-widest uppercase text-slate-400 dark:text-slate-500 mb-2">Total Amount</div>
                    <div className="text-2xl font-bold text-slate-900 dark:text-slate-50 tabular-nums">${grandTotal.toFixed(2)}</div>
                    <div className="text-xs text-slate-400 dark:text-slate-500 mt-1">{totalItemCount} item{totalItemCount !== 1 ? 's' : ''}</div>
                    <div className="mt-3 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden flex">
                      {collectedPct > 0 && <div className="h-full bg-emerald-500" style={{ width: `${collectedPct}%` }} />}
                      {catalogPct > 0 && <div className="h-full bg-blue-500" style={{ width: `${catalogPct}%` }} />}
                      {newItemsPct > 0 && <div className="h-full bg-amber-400" style={{ width: `${newItemsPct}%` }} />}
                    </div>
                  </div>
                </div>
                {/* Collected */}
                <div className="bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-slate-100 dark:border-slate-800 overflow-hidden">
                  <div className="px-5 pt-5 pb-3">
                    <div className="text-[11px] font-semibold tracking-widest uppercase text-slate-400 dark:text-slate-500 mb-2">Collected</div>
                    <div className="text-2xl font-bold text-slate-900 dark:text-slate-50 tabular-nums">${collectedAmount.toFixed(2)}</div>
                    <div className="text-xs text-slate-400 dark:text-slate-500 mt-1">{collectedRows.length} item{collectedRows.length !== 1 ? 's' : ''}</div>
                    <div className="mt-3 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-500" style={{ width: `${collectedPct}%` }} />
                    </div>
                  </div>
                </div>
                {/* Catalog Items */}
                <div className="bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-slate-100 dark:border-slate-800 overflow-hidden">
                  <div className="px-5 pt-5 pb-3">
                    <div className="text-[11px] font-semibold tracking-widest uppercase text-slate-400 dark:text-slate-500 mb-2">Catalog Items</div>
                    <div className="text-2xl font-bold text-slate-900 dark:text-slate-50 tabular-nums">${catalogTotal.toFixed(2)}</div>
                    <div className="text-xs text-slate-400 dark:text-slate-500 mt-1">{catalogOnlyItemCount} item{catalogOnlyItemCount !== 1 ? 's' : ''}</div>
                    <div className="mt-3 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full bg-blue-500" style={{ width: `${catalogPct}%` }} />
                    </div>
                  </div>
                </div>
                {/* New Items */}
                <div className="bg-white dark:bg-slate-900 rounded-xl shadow-sm border border-slate-100 dark:border-slate-800 overflow-hidden">
                  <div className="px-5 pt-5 pb-3">
                    <div className="text-[11px] font-semibold tracking-widest uppercase text-slate-400 dark:text-slate-500 mb-2">New Items</div>
                    <div className="text-2xl font-bold text-slate-900 dark:text-slate-50 tabular-nums">${newCatalogTotal.toFixed(2)}</div>
                    <div className="text-xs text-slate-400 dark:text-slate-500 mt-1">{newCatalogItems.length} item{newCatalogItems.length !== 1 ? 's' : ''}</div>
                    <div className="mt-3 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full bg-amber-400" style={{ width: `${newItemsPct}%` }} />
                    </div>
                  </div>
                </div>
              </div>);

          })()}

          {/* R2-C2: Store location cards (catalog view only) */}
          {activeView === 'catalog' && currentUser && isAppOwner(currentUser) && locationConfigs.length > 0 &&
          <div className="flex-1 min-w-0 self-start">
            <h2 className="text-sm font-semibold mb-1.5 text-slate-900 dark:text-slate-50">By Store</h2>
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
              {(() => {
                const storeCardMap = new Map();
                const catalogDeliveryIdsForStoreCards = new Set(filteredCatalogRows.map((r) => r.rawDelivery?.id || r.id).filter(Boolean));
                const newCatalogItemsForStore = reconciliationRows.filter((r) => {
                  if (r.catalogId && r.catalogId !== '--') return false;
                  const deliveryId = r.rawDelivery?.id || r.id;
                  return !catalogDeliveryIdsForStoreCards.has(deliveryId);
                });
                for (const item of filteredCatalogRows) {
                  const parsed = parseSquareItemName(item.itemName || item.name || '');
                  const abbr = parsed?.storeAbbr ? parsed.storeAbbr.toUpperCase() : null;
                  const locationId = item.locationId;
                  const config = locationConfigs.find((c) => c?.square_location_id === locationId);
                  const storeByAbbr = abbr ? stores.find((s) => s?.abbreviation?.toUpperCase() === abbr) : null;
                  const storeByConfig = getStoreForConfig(config);
                  const resolvedStore = storeByAbbr || storeByConfig;
                  const label = resolvedStore?.name || abbr || config?.name || 'Unknown';
                  const sortOrder = resolvedStore?.sort_order ?? Infinity;
                  const cardKey = `${locationId}::${abbr || 'unknown'}`;
                  if (!storeCardMap.has(cardKey)) storeCardMap.set(cardKey, { label, locationId, config, storeAbbr: abbr, sortOrder, items: [], newItems: [] });
                  storeCardMap.get(cardKey).items.push(item);
                }
                for (const row of newCatalogItemsForStore) {
                  const store = stores.find((s) => s?.id === row.rawStoreId);
                  const config = store ? getConfigForStore(store) : null;
                  const locationId = row.locationId !== '--' ? row.locationId : config?.square_location_id || null;
                  if (!locationId) continue;
                  const abbr = store?.abbreviation?.toUpperCase() || null;
                  const label = store?.name || row.storeName || 'Unknown';
                  const sortOrder = store?.sort_order ?? Infinity;
                  const cardKey = `${locationId}::${abbr || 'unknown'}`;
                  if (!storeCardMap.has(cardKey)) storeCardMap.set(cardKey, { label, locationId, config, storeAbbr: abbr, sortOrder, items: [], newItems: [] });
                  storeCardMap.get(cardKey).newItems.push(row);
                }
                return Array.from(storeCardMap.values()).sort((a, b) => a.sortOrder - b.sortOrder).map(({ label, locationId, config, storeAbbr, items, newItems, sortOrder }) => {
                  const codTotal = items.reduce((sum, item) => sum + Number(item.amount || 0), 0) + (newItems || []).reduce((sum, r) => sum + Number(r.amount || 0), 0);
                  const itemCount = items.length + (newItems || []).length;
                  // Resolve the store's default driver color (same logic as dashboard)
                  const resolvedStore = storeAbbr ? stores.find((s) => s?.abbreviation?.toUpperCase() === storeAbbr) : getStoreForConfig(config);
                  const defaultDriverId = resolvedStore?.weekday_am_driver_id || resolvedStore?.weekday_pm_driver_id || resolvedStore?.saturday_am_driver_id || null;
                  const defaultDriver = defaultDriverId ? drivers.find((d) => d?.id === defaultDriverId || d?.user_id === defaultDriverId) : null;
                  const driverHex = defaultDriver?.user_name ? generateDriverColor(defaultDriver.user_name) : null;
                  const cardStoreColor = driverHex ? { border: driverHex, bg: hexToRgba(driverHex, 0.06) } : undefined;
                  return (
                    <LocationSummaryCard
                      key={`${locationId}::${storeAbbr || 'unknown'}`}
                      location={{ name: label, square_location_id: locationId }}
                      codTotal={codTotal}
                      itemCount={itemCount}
                      storeColor={cardStoreColor}
                      onClick={() => config && setSelectedLocation(config)} />);

                });
              })()}
            </div>
          </div>
          }
        </div>

        {/* Reconciliation stat cards — full-width single row */}
        {activeView === 'reconciliation' && currentUser && isAppOwner(currentUser) &&
        <div className="grid grid-cols-10 gap-2">
          <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700">
            <CardContent className="p-3 flex items-center justify-between gap-1">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Locations</div>
              <div className="text-base font-bold text-blue-600 dark:text-blue-400 tabular-nums">{new Set(reconciliationRows.map((r) => r.locationId).filter(Boolean)).size}</div>
            </CardContent>
          </Card>
          <Card className="bg-white dark:bg-slate-900 border-emerald-200 dark:border-emerald-800">
            <CardContent className="p-3 flex items-center justify-between gap-1">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Transactions</div>
              <div className="text-base font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">{filteredTransactionRows.length}</div>
            </CardContent>
          </Card>
          <Card className="bg-white dark:bg-slate-900 border-emerald-200 dark:border-emerald-800">
            <CardContent className="p-3 flex items-center justify-between gap-1">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Collected $</div>
              <div className="text-base font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">${filteredTransactionRows.reduce((s, r) => s + Number(r.amount || 0), 0).toFixed(2)}</div>
            </CardContent>
          </Card>
          <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700">
            <CardContent className="p-3 flex items-center justify-between gap-1">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Cash</div>
              <div className="text-base font-bold text-slate-900 dark:text-slate-50 tabular-nums">{collectedCodTypeBreakdown.Cash}</div>
            </CardContent>
          </Card>
          <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700">
            <CardContent className="p-3 flex items-center justify-between gap-1">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Debit</div>
              <div className="text-base font-bold text-slate-900 dark:text-slate-50 tabular-nums">{collectedCodTypeBreakdown.Debit}</div>
            </CardContent>
          </Card>
          <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700">
            <CardContent className="p-3 flex items-center justify-between gap-1">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Credit</div>
              <div className="text-base font-bold text-slate-900 dark:text-slate-50 tabular-nums">{collectedCodTypeBreakdown.Credit}</div>
            </CardContent>
          </Card>
          <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700">
            <CardContent className="p-3 flex items-center justify-between gap-1">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">COD Deliveries</div>
              <div className="text-base font-bold text-slate-900 dark:text-slate-50 tabular-nums">{codDeliveriesCount}</div>
            </CardContent>
          </Card>
          <Card className="bg-white dark:bg-slate-900 border-red-200 dark:border-red-800">
            <CardContent className="p-3 flex items-center justify-between gap-1">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Unmatched</div>
              <div className="text-base font-bold text-red-600 dark:text-red-400 tabular-nums">{reconciliationRows.length}</div>
            </CardContent>
          </Card>
          <Card className="bg-white dark:bg-slate-900 border-red-200 dark:border-red-800">
            <CardContent className="p-3 flex items-center justify-between gap-1">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Unmatched $</div>
              <div className="text-base font-bold text-red-600 dark:text-red-400 tabular-nums">${reconciliationRows.reduce((s, r) => s + Number(r.amount || 0), 0).toFixed(2)}</div>
            </CardContent>
          </Card>
          <Card className="bg-white dark:bg-slate-900 border-orange-200 dark:border-orange-800">
            <CardContent className="p-3 flex items-center justify-between gap-1">
              <div className="text-xs font-medium text-slate-500 dark:text-slate-400">Cross-Store</div>
              <div className="text-base font-bold text-orange-600 dark:text-orange-400 tabular-nums">{reconciliationRows.filter((r) => r.crossStoreAlert).length}</div>
            </CardContent>
          </Card>
        </div>
        }

        {bgSyncProgress.stage !== 'idle' &&
        <div className="mt-3">
          <BackgroundSyncProgressBar progress={bgSyncProgress} />
        </div>
        }
        {lastCleanup &&
        <div className="mt-3">
          <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700">
            <CardContent className="p-3">
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
      </div>

      <div className="md:flex-1 md:min-h-0 flex flex-col">
        {error &&
        <div className="p-3 md:p-4 rounded-lg mb-6 text-sm md:text-base bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800">
            Error: {error}
          </div>
        }

        {activeView === 'reconciliation' ?
        <SquareCodDatasetTable
          key="reconciliation"
          title="Reconciliation"
          rows={reconciliationRows}
          isLoading={isLoading}
          emptyTitle="No unmatched deliveries"
          emptyDescription="Deliveries that do not have a matching transaction by amount and Square location will appear here."
          showLocationColumn={currentUser && isAppOwner(currentUser)}
          navHeight={navHeight}
          headerActions={!isDriverView && currentUser && isAppOwner(currentUser) ?
          <>
              <Button
              onClick={updateCatalog}
              disabled={isLoading || isUpdatingCatalog || isSyncing || reconciliationRows.length === 0}
              className="h-9 gap-1.5 rounded-md border border-slate-300 bg-white text-sm text-slate-900 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800 px-2 disabled:opacity-50 disabled:cursor-not-allowed">
                <CloudDownload className={`w-4 h-4 flex-shrink-0 ${isUpdatingCatalog ? 'animate-pulse' : ''}`} />
                <span>{isUpdatingCatalog ? 'Updating...' : 'Update Catalog'}</span>
              </Button>
            </> :
          undefined} /> :

        activeView === 'deliveries' ?
        <SquareCodDatasetTable key="deliveries" title="In App COD Deliveries" rows={filteredDeliveryRows} isLoading={isLoading} emptyTitle="No COD deliveries found" emptyDescription="COD deliveries from your local cache will appear here even if Square data was cleared." showLocationColumn={currentUser && isAppOwner(currentUser)} navHeight={navHeight} groupByCollected showCatalogColumn /> :
        activeView === 'transactions' ?
        <SquareCodDatasetTable key="transactions" title="Square Transactions" rows={filteredTransactionRows} isLoading={isLoading} emptyTitle="No Square transactions found" emptyDescription="Recent Square transactions for the active city will appear here." showLocationColumn={currentUser && isAppOwner(currentUser)} navHeight={navHeight} groupByCollected /> :

        <SquareCodDatasetTable
          key="catalog"
          title="Square Catalog Items"
          rows={filteredCatalogRows}
          isLoading={isLoading}
          emptyTitle="No Square catalog items found"
          emptyDescription={`Offline catalog loaded: ${catalogItems.length} items, visible after filters: ${filteredCatalogItems.length}. If this stays at 0, the current store/driver filters do not match the filtered catalog records.`}
          showLocationColumn={currentUser && isAppOwner(currentUser)}
          navHeight={navHeight}
          showCatalogColumn
          groupByCollected
          newCatalogRows={(() => {
            // Exclude reconciliation rows whose delivery already has a catalog item in filteredCatalogRows
            const catalogDeliveryIds = new Set(filteredCatalogRows.map((r) => r.rawDelivery?.id || r.id).filter(Boolean));
            return reconciliationRows.filter((r) => {
              if (r.catalogId && r.catalogId !== '--') return false; // already has a catalog ID
              const deliveryId = r.rawDelivery?.id || r.id;
              return !catalogDeliveryIds.has(deliveryId); // exclude if already in catalog tab
            });
          })()}
          headerActions={!isDriverView && currentUser && isAppOwner(currentUser) ?
          <Button
            onClick={updateCatalog}
            disabled={isLoading || isUpdatingCatalog || isSyncing}
            className="h-9 gap-1.5 rounded-md border border-slate-300 bg-white text-sm text-slate-900 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800 px-2 disabled:opacity-50 disabled:cursor-not-allowed">
              <CloudDownload className={`w-4 h-4 flex-shrink-0 ${isUpdatingCatalog ? 'animate-pulse' : ''}`} />
              <span>{isUpdatingCatalog ? 'Updating...' : 'Update Catalog'}</span>
            </Button> :
          undefined} />

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