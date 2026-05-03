import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useAppData } from "@/components/utils/AppDataContext";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { CheckCircle, Clock, CreditCard, Loader2, CloudDownload } from "lucide-react";
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
  const [selectedDaysRange, setSelectedDaysRange] = useState(() => localStorage.getItem('square_cod_days_range') || '7');
  const [isUpdatingReconciliationCatalog, setIsUpdatingReconciliationCatalog] = useState(false);
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
    startDate.setDate(today.getDate() - 60);
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
    const { startDateStr, endDateStr } = getSourceWindow();
    const { offlineDB } = await import('@/components/utils/offlineDatabase');
    await loadReconciliationFromOffline(offlineDB, startDateStr, endDateStr);
    await loadSquareViewFromOffline();
    await loadSyncStatus();
  }, [getSourceWindow, loadReconciliationFromOffline, loadSquareViewFromOffline, loadSyncStatus]);

  useEffect(() => {
    locationConfigsRef.current = locationConfigs || [];
  }, [locationConfigs]);

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

      // Step 1: Fetch fresh data from backend snapshot
      const codResponse = await base44.functions.invoke('squareCodCore', {
        action: 'getCodData',
        forceDeliveryRefresh: true
      });
      const codData = codResponse?.data || codResponse || {};
      const strippedDeliveries = Array.isArray(codData.deliveries)
        ? codData.deliveries.map(({ delivery_route_breadcrumbs, encoded_polyline, proof_photo_urls, signature_image_url, ...rest }) => rest)
        : [];
      const catalogRecords = codData.catalogRecords || [];
      const transactionRecords = codData.transactionRecords || [];

      // Step 2: Sync deliveries tab source first
      if (strippedDeliveries.length > 0) {
        await offlineDB.replaceAllRecords(offlineDB.STORES.DELIVERIES, strippedDeliveries);
      }

      // Step 3: Sync catalog + transactions after deliveries
      await Promise.all([
        offlineDB.replaceAllRecords(offlineDB.STORES.SQUARE_CATALOG_ITEMS, catalogRecords),
        offlineDB.replaceAllRecords(offlineDB.STORES.SQUARE_TRANSACTIONS, transactionRecords)
      ]);

      // Step 4: Read back from offline DBs - these are now the source of truth
      const [offlineCatalog, offlineTransactions] = await Promise.all([
        offlineDB.getAll(offlineDB.STORES.SQUARE_CATALOG_ITEMS),
        offlineDB.getAll(offlineDB.STORES.SQUARE_TRANSACTIONS)
      ]);

      // Step 5: Fully replace online Square entities from the completed offline snapshot
      await base44.functions.invoke('squareCodCore', {
        action: 'syncOnlineSquareEntities',
        catalogRecords: offlineCatalog || [],
        transactionRecords: offlineTransactions || []
      });

      // Step 6: Refresh UI from offline
      await refreshUiFromOfflineOnly();
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
      window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
      toast.success('Square data synced');

    } catch (err) {
      setError(err.message);
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

  useEffect(() => {
    const loadKey = 'square-cod-initial-load';
    if (initialLoadKeyRef.current === loadKey) return;
    initialLoadKeyRef.current = loadKey;

    const loadData = async () => {
      try {
        const authUser = appCurrentUser;
        const { startDateStr, endDateStr } = getSourceWindow();
        const { offlineDB } = await import('@/components/utils/offlineDatabase');

        const nextLocationConfigs = (await offlineDB.getAll(offlineDB.STORES.SQUARE_LOCATION_CONFIGS)) || [];
        const nextStores = (appDataStores || []).filter(Boolean);
        const nextPatients = (appDataPatients || []).filter(Boolean);
        const nextDrivers = (appDataAppUsers || []).filter((user) => Array.isArray(user?.app_roles) && user.app_roles.includes('driver'));
        const currentAppUserRecord = (appDataAppUsers || []).find((user) => user?.user_id === authUser?.id) || null;

        setCurrentUser(authUser || null);
        setCurrentAppUser(currentAppUserRecord);
        setStores(nextStores);
        setPatients(nextPatients);
        setDrivers(nextDrivers);
        setLocationConfigs(nextLocationConfigs);
        locationConfigsRef.current = nextLocationConfigs;
        setLocationIds(nextLocationConfigs.map((config) => config?.square_location_id).filter(Boolean));

        await loadReconciliationFromOffline(offlineDB, startDateStr, endDateStr);
        await loadSquareViewFromOffline();
        setIsLoading(false);
        setHasInitialLoadCompleted(true);

        await purgeSquareCODOfflineDataBeforeSync();
        await syncFromSquare();
        setBgSyncProgress({ stage: 'idle' });
      } catch (err) {
        console.error('Failed to load COD data:', err);
        setIsLoading(false);
      }
    };

    loadData();
  }, [appCurrentUser, appDataAppUsers, appDataStores, appDataPatients, getSourceWindow, loadReconciliationFromOffline, loadSquareViewFromOffline, loadSyncStatus, refreshOfflineSquareFromOnlineEntities, purgeSquareCODOfflineDataBeforeSync]);

  useEffect(() => {
    if (!hasInitialLoadCompleted) return;
    refreshUiFromOfflineOnly();
  }, [activeView, selectedDriverFilter, selectedStoreFilter, selectedDaysRange, hasInitialLoadCompleted, refreshUiFromOfflineOnly]);

  useEffect(() => {
    if (!hasInitialLoadCompleted) return;

    let isActive = true;
    const scheduleLocalRealtimeRefresh = () => {
      const now = Date.now();
      if (now - lastRealtimeRefreshAtRef.current < 15000) return;
      if (realtimeRefreshTimeoutRef.current) clearTimeout(realtimeRefreshTimeoutRef.current);

      realtimeRefreshTimeoutRef.current = setTimeout(async () => {
        if (!isActive || isSyncing || isUpdatingReconciliationCatalog || syncInFlightRef.current) return;
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
  }, [hasInitialLoadCompleted, isSyncing, isUpdatingReconciliationCatalog, refreshOfflineSquareFromOnlineEntities, refreshUiFromOfflineOnly]);

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
    if (!itemName) return null;
    try {
      const dateMatch = itemName.match(/^(\d{2})[\/-](\d{2})/);
      if (!dateMatch) return null;
      const month = Number(dateMatch[1]);
      const day = Number(dateMatch[2]);
      const today = new Date();
      const inferredDate = new Date(today.getFullYear(), month - 1, day);
      const msInDay = 24 * 60 * 60 * 1000;
      if (inferredDate.getTime() - today.getTime() > 45 * msInDay) inferredDate.setFullYear(inferredDate.getFullYear() - 1);
      const deliveryDate = format(inferredDate, 'yyyy-MM-dd');
      const storeMatch = itemName.match(/\(([^)]+)\)/);
      const storeAbbr = storeMatch ? storeMatch[1] : null;
      const nameMatch = itemName.match(/\)-(.+)$/);
      const patientName = nameMatch ? nameMatch[1].trim() : null;
      return { deliveryDate, storeAbbr, patientName };
    } catch {
      return null;
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
      if (targetStoreId && delivery.store_id !== targetStoreId) return false;
      if (transaction.delivery_id && delivery.id === transaction.delivery_id) return true;
      if (!amountSetsIntersect(getDeliveryPaymentAmountSet(delivery), transactionAmountSet)) return false;
      if (transactionDate && delivery.delivery_date === transactionDate) return true;
      if (patientName && delivery.delivery_date === parsedItem?.deliveryDate) {
        const patient = patients.find((p) => p?.id === delivery.patient_id || p?.patient_id === delivery.patient_id);
        return patientNamesMatch(patient?.full_name || '', patientName);
      }
      return false;
    }) || null;
  }, [deliveries, getTransactionEffectiveDateString, patients]);

  const isTransferTransaction = (transaction) => {
    const label = `${transaction?.item_name || ''} ${transaction?.delivery_id || ''}`.toLowerCase();
    return transaction?.type === 'transfer' || label.includes('transfer') || label.includes('interstore') || label.includes('inter-store');
  };

  const hasMatchingSquareTransaction = (delivery, locationId) => {
    const deliveryAmountSet = getDeliveryPaymentAmountSet(delivery);
    const patient = patients.find((p) => p?.id === delivery?.patient_id || p?.patient_id === delivery?.patient_id);
    const patientName = patient?.full_name || '';
    return (allTransactions || []).some((transaction) => {
      if (!transaction || isTransferTransaction(transaction)) return false;
      if (!transaction.square_payment_id) return false;
      if (transaction.type !== 'collection') return false;
      if (!['completed', 'refunded'].includes(transaction.status)) return false;
      if (transaction.delivery_id && transaction.delivery_id === delivery.id) return true;
      const transactionAmountSet = getTransactionAmountSet(transaction);
      if (!amountSetsIntersect(deliveryAmountSet, transactionAmountSet)) return false;
      const sameStoreSameDay = transaction.location_id === locationId && transaction.store_id === delivery.store_id && transaction.created_date?.slice(0, 10) === delivery.delivery_date;
      if (sameStoreSameDay) return true;
      return getTransactionSearchNames(transaction).some((name) => patientNamesMatch(patientName, name));
    });
  };

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
      if (linkedDelivery?.status === 'pending') return false;
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
      const aStore = stores.find((s) => s.square_location_config_id === aConfig?.id);
      const bStore = stores.find((s) => s.square_location_config_id === bConfig?.id);
      const aStoreName = aStore?.name || aConfig?.name || '';
      const bStoreName = bStore?.name || bConfig?.name || '';
      return aStoreName.localeCompare(bStoreName);
    });
  }, [catalogItems, currentUser, selectedDriverFilter, locationConfigs, drivers, soldCatalogItems, deliveries, stores]);

  const selectedDriverUserIds = useMemo(() => {
    if (selectedDriverFilter && selectedDriverFilter !== 'all') {
      const selectedDriver = drivers.find((driver) => driver?.id === selectedDriverFilter);
      return new Set(selectedDriver?.user_id ? [selectedDriver.user_id] : []);
    }
    return new Set((drivers || []).map((driver) => driver?.user_id).filter(Boolean));
  }, [drivers, selectedDriverFilter]);

  const lookbackStart = useMemo(() => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - Number(selectedDaysRange || 60));
    return date;
  }, [selectedDaysRange]);

  const activeCityIds = useMemo(() => {
    const source = currentAppUser || currentUser;
    if (Array.isArray(source?.city_ids) && source.city_ids.length > 0) return source.city_ids.filter(Boolean);
    return source?.city_id ? [source.city_id] : [];
  }, [currentAppUser, currentUser]);

  const availableStoresForFilter = useMemo(() => {
    const cityFilteredStores = activeCityIds.length > 0 ? stores.filter((store) => activeCityIds.includes(store?.city_id)) : stores;
    return [...cityFilteredStores].sort((a, b) => (a?.sort_order ?? Infinity) - (b?.sort_order ?? Infinity));
  }, [stores, activeCityIds]);

  const visibleStoreIds = useMemo(() => {
    const scopedStores = selectedStoreFilter && selectedStoreFilter !== 'all' ? availableStoresForFilter.filter((store) => store?.id === selectedStoreFilter) : availableStoresForFilter;
    return new Set(scopedStores.map((store) => store?.id).filter(Boolean));
  }, [availableStoresForFilter, selectedStoreFilter]);

  const storesWithSquareLocationIds = useMemo(() => stores.filter((store) => {
    if (!store?.id || !store?.square_location_config_id) return false;
    const config = locationConfigs.find((locationConfig) => locationConfig?.id === store.square_location_config_id);
    return Boolean(config?.square_location_id);
  }), [stores, locationConfigs]);


  const visibleLocationIds = useMemo(() => new Set(
    storesWithSquareLocationIds.
    filter((store) => visibleStoreIds.has(store?.id)).
    map((store) => {
      const config = locationConfigs.find((locationConfig) => locationConfig?.id === store.square_location_config_id);
      return config?.square_location_id;
    }).
    filter(Boolean)
  ), [storesWithSquareLocationIds, locationConfigs, visibleStoreIds]);

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
    const rows = (deliveries || []).
    filter((delivery) => {
      if (!delivery) return false;
      if (delivery.status === 'failed') return false;
      if (Number(delivery.cod_total_amount_required || 0) <= 0) return false;
      if (!visibleStoreIds.has(delivery.store_id)) return false;
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
      const config = locationConfigs.find((c) => c?.id === store?.square_location_config_id);
      const linkedCatalog = catalogItems.find((item) => item?.delivery_id === delivery.id);
      // Fallback: if config join fails, infer location_id from a matching transaction for this store
      const fallbackLocationId = !config?.square_location_id
        ? (allTransactions.find((t) => t?.store_id === delivery.store_id && t?.location_id)?.location_id || null)
        : null;
      const resolvedLocationId = config?.square_location_id || fallbackLocationId;
      const hasMatch = resolvedLocationId ? hasMatchingSquareTransaction(delivery, resolvedLocationId) : false;
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
        deliveryDate: delivery.delivery_date,
        collectionType,
        subtext: delivery.driver_name || null,
        actions: hasMatch ?
        <Button variant="secondary" size="sm" className="border border-emerald-300 bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Matched</Button> :
        <Button variant="secondary" size="sm" className="border border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-100">No Match</Button>
      };
    });

    const seenRowKeys = new Set();
    return rows.filter((row) => {
      const rowKey = row.key || row.id;
      if (seenRowKeys.has(rowKey)) return false;
      seenRowKeys.add(rowKey);
      return true;
    });
  }, [deliveries, visibleStoreIds, lookbackStart, selectedDriverFilter, selectedDriverUserIds, patients, stores, locationConfigs, catalogItems, allTransactions]);

  const filteredTransactionRows = useMemo(() => {
    const dedupedTransactions = [];
    const seenTransactionKeys = new Set();

    (allTransactions || []).
    filter((transaction) => {
      if (!transaction || isTransferTransaction(transaction)) return false;
      const hasFormattedItemDate = !!parseSquareItemName(transaction?.item_name)?.deliveryDate;
      const transactionDate = getTransactionFilterDate(transaction);
      if (hasFormattedItemDate && (!transactionDate || transactionDate < lookbackStart)) return false;

      const config = locationConfigs.find((c) => c?.square_location_id === transaction.location_id);
      const matchedDelivery = findMatchingDeliveryForTransaction(transaction, transaction.store_id || null);
      const matchedStoreId = transaction.store_id || matchedDelivery?.store_id || stores.find((s) => s?.square_location_config_id === config?.id)?.id || null;
      const storeMatch = matchedStoreId ? visibleStoreIds.has(matchedStoreId) : visibleLocationIds.has(transaction.location_id);
      if (!storeMatch) return false;

      if (selectedDriverFilter && selectedDriverFilter !== 'all') {
        if (selectedDriverUserIds.size === 0) return false;
        const matchedDriverId = transaction.driver_id || matchedDelivery?.driver_id || null;
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
      const store = stores.find((s) => s?.id === transaction.store_id) || (matchedDelivery ? stores.find((s) => s?.id === matchedDelivery.store_id) : null) || stores.find((s) => s?.square_location_config_id === config?.id) || null;
      const resolvedConfig = config || locationConfigs.find((c) => c?.id === store?.square_location_config_id) || null;
      const collectionDate = getTransactionEffectiveDateString(transaction);
      const parsedDeliveryDate = parseSquareItemName(transaction.item_name)?.deliveryDate;
      const displayDate = matchedDelivery?.delivery_date || collectionDate || parsedDeliveryDate || transaction.created_date;
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
        storeName: store?.name || resolvedConfig?.name || config?.name || 'Unknown',
        locationId: transaction.location_id || resolvedConfig?.square_location_id || '--',
        catalogId: transaction.square_catalog_object_id || '--',
        deliveryDate: displayDate,
        collectionDate,
        collectionType,
        subtext: collectedByName ? `Collected by ${collectedByName}` : transaction.payment_method || null,
        notes: transaction.raw_square_data?.note || transaction.raw_square_data?.notes || null,
        actions: matchedDelivery ?
        <Button variant="secondary" size="sm" className="border border-emerald-300 bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Collected</Button> :
        null
      };
    }).sort((a, b) => String(b.itemName || '').localeCompare(String(a.itemName || ''), undefined, { sensitivity: 'base' }));

    const seenRowKeys = new Set();
    return rows.filter((row) => {
      const rowKey = row.key || row.id;
      if (seenRowKeys.has(rowKey)) return false;
      seenRowKeys.add(rowKey);
      return true;
    });
  }, [allTransactions, lookbackStart, visibleStoreIds, visibleLocationIds, selectedDriverFilter, selectedDriverUserIds, locationConfigs, stores, drivers, getTransactionSearchNames, getTransactionFilterDate, getTransactionEffectiveDateString, findMatchingDeliveryForTransaction]);

  const filteredCatalogRows = useMemo(() => {
    const rows = (catalogItems || []).
    filter((item) => {
      if (driverScopedLocationIds && item.location_id && !driverScopedLocationIds.has(item.location_id)) return false;
      if (visibleLocationIds.size > 0 && item.location_id && !visibleLocationIds.has(item.location_id)) return false;
      if (visibleStoreIds.size > 0 && item.store_id && !visibleStoreIds.has(item.store_id)) return false;
      const parsedItemDate = parseSquareItemName(item.name || item.item_name)?.deliveryDate;
      if (!parsedItemDate) return false;
      const itemDate = new Date(`${parsedItemDate}T00:00:00`);
      if (Number.isNaN(itemDate.getTime()) || itemDate < lookbackStart) return false;
      return true;
    }).
    map((item) => {
      const config = locationConfigs.find((c) => c?.square_location_id === item.location_id);
      const store = stores.find((s) => s?.id === item.store_id) || stores.find((s) => s?.square_location_config_id === config?.id);
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
  }, [catalogItems, locationConfigs, stores, visibleStoreIds, visibleLocationIds, driverScopedLocationIds, deletingId, lookbackStart]);

  const reconciliationRows = useMemo(() => [], []);

  const codDeliveriesCount = useMemo(() => deliveries.filter((delivery) => {
    if (!delivery || Number(delivery.cod_total_amount_required || 0) <= 0) return false;
    if (!visibleStoreIds.has(delivery.store_id)) return false;
    if (selectedDriverFilter === 'all') return true;
    if (selectedDriverUserIds.size === 0) return false;
    return selectedDriverUserIds.has(delivery.driver_id);
  }).length, [deliveries, selectedDriverFilter, selectedDriverUserIds, visibleStoreIds]);

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

  const filteredCardSpendCount = useMemo(() => filteredTransactionRows.length, [filteredTransactionRows]);
  const filteredSalesCount = useMemo(() => soldCatalogItems.length, [soldCatalogItems]);

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
    <div className="px-4 md:px-6 pt-4 md:pt-6 bg-background text-foreground w-full h-full overflow-hidden flex flex-col">
      <div className="flex flex-col gap-4 mb-6 flex-shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <CreditCard className="w-6 md:w-8 h-6 md:h-8 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
            <div className="min-w-0">
              <h1 className="text-xl md:text-2xl font-bold text-slate-900 dark:text-slate-50">Square COD</h1>
              <p className="text-xs md:text-sm text-slate-600 dark:text-slate-400">Track and manage COD payments</p>
            </div>
          </div>

          {currentUser && isAppOwner(currentUser) &&
          <Button onClick={syncFromSquare} disabled={isLoading || isSyncing} className="gap-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 shadow-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800 shrink-0 self-start">
              <CloudDownload className={`w-4 h-4 flex-shrink-0 ${isSyncing ? 'animate-pulse' : ''}`} />
              <span className="hidden sm:inline">{isSyncing ? 'Syncing...' : 'Sync'}</span>
              <span className="sm:hidden">{isSyncing ? 'Syncing' : 'Sync'}</span>
            </Button>
          }
        </div>

        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-3 gap-1 md:flex md:flex-row md:flex-wrap md:items-center md:gap-3 w-full">
            {currentUser && isAppOwner(currentUser) && drivers.length > 0 &&
            <Select value={selectedDriverFilter} onValueChange={setSelectedDriverFilter}>
                <SelectTrigger className="w-full min-w-0 px-2 text-xs md:w-[120px] md:px-3 md:text-sm">
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
              <SelectTrigger className="w-full min-w-0 px-2 text-xs md:w-[120px] md:px-3 md:text-sm">
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
              <SelectTrigger className="w-full min-w-0 px-2 text-xs md:w-[120px] md:px-3 md:text-sm">
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
          </div>

          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between w-full">
            <SquareCodViewSwitcher activeView={activeView} onChange={setActiveView} counts={viewCounts} />
            {activeView === 'reconciliation' &&
            <Button onClick={() => {}} disabled className="gap-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 md:ml-3">
                <CloudDownload className="w-4 h-4 flex-shrink-0" />
                <span className="hidden sm:inline">Update Catalog</span>
                <span className="sm:hidden">Update</span>
              </Button>
            }
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {syncStatus &&
        <div className="mb-2">
            <SyncStatusIndicator
            syncStatus={syncStatus}
            isSyncing={isSyncing}
            error={error}
            codDeliveryCount={codDeliveriesCount}
            catalogItemCount={filteredCatalogItems.length}
            cardSpendCount={filteredCardSpendCount}
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

        {activeView === 'catalog' && currentUser && isAppOwner(currentUser) && locationConfigs.length > 0 &&
        <div>
            <h2 className="text-base md:text-lg font-semibold mb-4 text-slate-900 dark:text-slate-50">By Location</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-none md:auto-cols-fr md:grid-flow-col gap-2 md:gap-4 mb-6 md:mb-8">
              {locationConfigs.
            filter((config) => visibleLocationIds.has(config.square_location_id)).
            sort((a, b) => {
              const storeA = stores.find((s) => s.square_location_config_id === a.id);
              const storeB = stores.find((s) => s.square_location_config_id === b.id);
              return (storeA?.sort_order ?? Infinity) - (storeB?.sort_order ?? Infinity);
            }).
            map((config) => {
              const locationItems = filteredCatalogRows.filter((item) => item.locationId === config.square_location_id);
              const codTotal = locationItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);
              const store = stores.find((s) => s.square_location_config_id === config.id);
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
        <SquareCodDatasetTable key="deliveries" title="In App COD Deliveries" rows={filteredDeliveryRows} isLoading={isLoading} emptyTitle="No COD deliveries found" emptyDescription="COD deliveries from your local cache will appear here even if Square data was cleared." showLocationColumn={currentUser && isAppOwner(currentUser)} navHeight={navHeight} /> :
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