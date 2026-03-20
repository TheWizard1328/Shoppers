import React, { useCallback, useEffect, useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { CreditCard, CloudDownload } from "lucide-react";
import { toast } from "sonner";
import { isAppOwner } from "@/components/utils/userRoles";
import LocationSummaryCard from "@/components/square/LocationSummaryCard";
import TransactionHistoryPanel from "@/components/square/TransactionHistoryPanel";
import CODItemDetailModal from "@/components/square/CODItemDetailModal";
import SyncStatusIndicator from "@/components/square/SyncStatusIndicator";
import BackgroundSyncProgressBar from "@/components/square/BackgroundSyncProgressBar";
import { format, subDays } from "date-fns";
import * as squareCODOfflineManager from "@/components/utils/squareCODOfflineManager";
import { offlineDB } from "@/components/utils/offlineDatabase";
import SquareCODViewTabs from "@/components/square/SquareCODViewTabs";
import SquareCODDatasetTable from "@/components/square/SquareCODDatasetTable";

const LOOKBACK_DAYS = 30;

const VIEW_META = {
  reconciliation: {
    title: "Reconciliation",
    emptyTitle: "Reconciliation is not set up yet",
    emptyDescription: "We can fine tune this after you confirm the other 3 sections.",
  },
  deliveries: {
    title: "COD Deliveries",
    emptyTitle: "No COD deliveries found",
    emptyDescription: "COD deliveries for the selected city will show here.",
  },
  transactions: {
    title: "Square Transactions",
    emptyTitle: "No collected Square transactions found",
    emptyDescription: "Collected Square transactions for the selected city will show here.",
  },
  catalog: {
    title: "Square Catalog Items",
    emptyTitle: "No Square catalog items found",
    emptyDescription: "Catalog items for the selected city will show here.",
  },
};

const getActiveCityId = (user) => user?.city_id || user?.city_ids?.[0] || null;

const isAssignedToCity = (record, cityId) => {
  if (!cityId) return true;
  if (record?.city_id === cityId) return true;
  return Array.isArray(record?.city_ids) && record.city_ids.includes(cityId);
};

const makeBadge = (label, className) => ({ label, className });

export default function SquareManagement() {
  const {
    syncSquareCODSnapshotOffline,
    getCatalogItemsOffline,
    getPaymentTransactionsOffline,
    getSquareCODSyncStatus,
    handleSquareCatalogItemRealtimeEvent,
    handleSquareTransactionRealtimeEvent,
  } = squareCODOfflineManager;

  const [activeView, setActiveView] = useState("deliveries");
  const [catalogItems, setCatalogItems] = useState([]);
  const [allTransactions, setAllTransactions] = useState([]);
  const [soldCatalogItems, setSoldCatalogItems] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [stores, setStores] = useState([]);
  const [patients, setPatients] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [locationConfigs, setLocationConfigs] = useState([]);
  const [locationIds, setLocationIds] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [selectedDriverFilter, setSelectedDriverFilter] = useState("all");
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [selectedCODItem, setSelectedCODItem] = useState(null);
  const [itemToDelete, setItemToDelete] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [syncStatus, setSyncStatus] = useState(null);
  const [bgSyncProgress, setBgSyncProgress] = useState({ stage: "idle" });
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [navHeight, setNavHeight] = useState(0);

  useEffect(() => {
    const measure = () => {
      const nav = document.querySelector("nav[data-mobile-bottom-nav]");
      setNavHeight(nav ? Math.ceil(nav.getBoundingClientRect().height) : 0);
    };

    measure();
    window.addEventListener("resize", measure);

    const navEl = document.querySelector("nav[data-mobile-bottom-nav]");
    let observer;
    if ("ResizeObserver" in window && navEl) {
      observer = new ResizeObserver(measure);
      observer.observe(navEl);
    }

    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, []);

  const lookbackStart = useMemo(() => {
    const date = subDays(new Date(), LOOKBACK_DAYS);
    date.setHours(0, 0, 0, 0);
    return date;
  }, []);

  const lookbackStartStr = useMemo(() => format(lookbackStart, "yyyy-MM-dd"), [lookbackStart]);
  const todayStr = useMemo(() => format(new Date(), "yyyy-MM-dd"), []);

  const loadSquareViewFromOffline = useCallback(async () => {
    const [offlineCatalog, offlineTransactions, updatedSyncStatus] = await Promise.all([
      getCatalogItemsOffline(),
      getPaymentTransactionsOffline(),
      getSquareCODSyncStatus(),
    ]);

    const transactions = offlineTransactions || [];
    const sold = transactions.filter((tx) => ["completed", "refunded"].includes(tx.status));

    setCatalogItems(offlineCatalog || []);
    setAllTransactions(transactions);
    setSoldCatalogItems(sold);
    setSyncStatus(updatedSyncStatus);

    return {
      items: offlineCatalog || [],
      transactions,
      sold,
    };
  }, [getCatalogItemsOffline, getPaymentTransactionsOffline, getSquareCODSyncStatus]);

  const refreshSquareView = useCallback(async (fallbackLocationIds = [], options = {}) => {
    const { onStageChange } = options;

    const [catalogRecords, transactions] = await Promise.all([
      base44.entities.SquareCatalogItems.list("-updated_date", 500),
      base44.entities.SquareTransaction.list("-created_date", 500),
    ]);

    onStageChange?.({ stage: "saving_offline", detail: "Updating local COD cache…" });

    await syncSquareCODSnapshotOffline({
      catalogItems: catalogRecords || [],
      transactions: transactions || [],
    });

    const snapshot = await loadSquareViewFromOffline();
    setLocationIds(fallbackLocationIds);
    return snapshot;
  }, [loadSquareViewFromOffline, syncSquareCODSnapshotOffline]);

  const getOfflineOrRemote = useCallback(async (storeName, fetcher) => {
    const offlineRecords = await offlineDB.getAll(storeName);
    if (offlineRecords?.length) return offlineRecords;

    const remoteRecords = await fetcher();
    if (remoteRecords?.length) {
      await offlineDB.bulkSave(storeName, remoteRecords);
    }
    return remoteRecords || [];
  }, []);

  const hydrateFromOffline = useCallback(async (userOverride = null) => {
    const user = userOverride || currentUser || await base44.auth.me();
    if (!user) {
      setIsLoading(false);
      return { cityStoreIds: [], syncedLocationIds: [] };
    }

    const activeCityId = getActiveCityId(user);

    const [storesData, appUsersData, patientsData, configsData, allOfflineDeliveries] = await Promise.all([
      getOfflineOrRemote(offlineDB.STORES.STORES, () => base44.entities.Store.list()),
      getOfflineOrRemote(offlineDB.STORES.APP_USERS, () => base44.entities.AppUser.list()),
      getOfflineOrRemote(offlineDB.STORES.PATIENTS, () => base44.entities.Patient.list()),
      getOfflineOrRemote(offlineDB.STORES.SQUARE_LOCATION_CONFIGS, () => base44.entities.SquareLocationConfig.filter({ status: "active" })),
      offlineDB.getAll(offlineDB.STORES.DELIVERIES),
    ]);

    const cityStores = (storesData || []).filter((store) => !activeCityId || store?.city_id === activeCityId);
    const cityStoreIds = cityStores.map((store) => store.id).filter(Boolean);
    const cityStoreIdsSet = new Set(cityStoreIds);
    const cityConfigs = (configsData || []).filter((config) => cityStores.some((store) => store.square_location_config_id === config.id));
    const cityConfigIds = new Set(cityConfigs.map((config) => config.id));
    const syncedLocationIds = cityConfigs.map((config) => config.square_location_id).filter(Boolean);

    let cityDeliveries = (allOfflineDeliveries || []).filter(
      (delivery) => delivery && cityStoreIdsSet.has(delivery.store_id) && delivery.delivery_date >= lookbackStartStr && delivery.delivery_date <= todayStr
    );

    if (cityDeliveries.length === 0 && cityStoreIds.length > 0) {
      const remoteDeliveries = await base44.entities.Delivery.filter(
        {
          delivery_date: { $gte: lookbackStartStr, $lte: todayStr },
          store_id: { $in: cityStoreIds },
        },
        "-delivery_date",
        2000,
      );

      if (remoteDeliveries?.length) {
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, remoteDeliveries);
        cityDeliveries = remoteDeliveries;
      }
    }

    cityDeliveries = [...cityDeliveries].sort((a, b) => {
      const dateCompare = String(b?.delivery_date || "").localeCompare(String(a?.delivery_date || ""));
      if (dateCompare !== 0) return dateCompare;
      return String(a?.delivery_id || a?.stop_id || "").localeCompare(String(b?.delivery_id || b?.stop_id || ""));
    });

    const cityDrivers = (appUsersData || [])
      .filter((userRecord) => userRecord?.app_roles?.includes("driver") && userRecord?.status === "active" && isAssignedToCity(userRecord, activeCityId))
      .sort((a, b) => (a?.sort_order ?? Infinity) - (b?.sort_order ?? Infinity));

    const cityPatients = (patientsData || []).filter((patient) => !cityStoreIds.length || cityStoreIdsSet.has(patient.store_id));

    setCurrentUser(user);
    setStores(cityStores);
    setDrivers(cityDrivers);
    setPatients(cityPatients);
    setLocationConfigs(cityConfigs.filter((config) => config?.status !== "inactive"));
    setLocationIds(syncedLocationIds);
    setDeliveries(cityDeliveries);

    await loadSquareViewFromOffline();
    setIsLoading(false);

    return { cityStoreIds, syncedLocationIds, cityConfigIds };
  }, [base44, currentUser, getOfflineOrRemote, loadSquareViewFromOffline, lookbackStartStr, todayStr]);

  const runInitialBackgroundRefresh = useCallback(async ({ cityStoreIds, syncedLocationIds, syncKey, user }) => {
    sessionStorage.setItem(syncKey, "done");
    setBgSyncProgress({ stage: "catalog_sync", detail: "Refreshing deliveries and Square data…" });

    try {
      if (cityStoreIds.length > 0) {
        const freshDeliveries = await base44.entities.Delivery.filter(
          {
            delivery_date: { $gte: lookbackStartStr, $lte: todayStr },
            store_id: { $in: cityStoreIds },
          },
          "-delivery_date",
          2000,
        );

        if (freshDeliveries?.length) {
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
        }
      }

      const response = await base44.functions.invoke("squareSyncCatalogItems", { skipLock: true });
      const data = response?.data || response || {};

      if (data.rate_limited) {
        setBgSyncProgress({ stage: "payments_sync", detail: "Loading cached Square data…" });
        await refreshSquareView(syncedLocationIds, { onStageChange: setBgSyncProgress });
        setBgSyncProgress({ stage: "complete", detail: "Using cached data (rate limited)" });
      } else if (data.success) {
        setBgSyncProgress({ stage: "payments_sync", detail: "Refreshing Square transactions and catalog…" });
        await refreshSquareView(syncedLocationIds, { onStageChange: setBgSyncProgress });
        setBgSyncProgress({ stage: "complete", detail: "Offline COD data updated" });
      } else if (data.lock_active) {
        setBgSyncProgress({ stage: "complete", detail: "Using cached data (sync locked)" });
      }

      await hydrateFromOffline(user);
      setTimeout(() => setBgSyncProgress({ stage: "idle" }), 4000);
    } catch (refreshError) {
      console.warn("⚠️ [SquareManagement] Initial background refresh failed:", refreshError?.message || refreshError);
      setBgSyncProgress({ stage: "error", error: refreshError?.message || "Failed to refresh COD data" });
      setTimeout(() => setBgSyncProgress({ stage: "idle" }), 8000);
    }
  }, [hydrateFromOffline, lookbackStartStr, refreshSquareView, todayStr]);

  useEffect(() => {
    let isMounted = true;

    const init = async () => {
      try {
        const user = await base44.auth.me();
        if (!isMounted) return;

        const { cityStoreIds, syncedLocationIds } = await hydrateFromOffline(user);
        if (!isMounted) return;

        const syncKey = `square-cod-initial-bg-sync:${getActiveCityId(user) || "default"}`;
        if (!sessionStorage.getItem(syncKey)) {
          runInitialBackgroundRefresh({ cityStoreIds, syncedLocationIds, syncKey, user });
        }
      } catch (loadError) {
        console.error("Failed to load COD data:", loadError);
        if (isMounted) {
          setError(loadError?.message || "Failed to load COD data");
          setIsLoading(false);
        }
      }
    };

    init();

    return () => {
      isMounted = false;
    };
  }, [hydrateFromOffline, runInitialBackgroundRefresh]);

  useEffect(() => {
    let isActive = true;

    const syncRealtimeEvent = async (handler, event) => {
      try {
        await handler(event);
        if (isActive) {
          await hydrateFromOffline(currentUser);
        }
      } catch (realtimeError) {
        console.error("❌ [SquareManagement] Realtime Square sync failed:", realtimeError);
      }
    };

    const unsubscribeCatalogItems = base44.entities.SquareCatalogItems.subscribe((event) => {
      syncRealtimeEvent(handleSquareCatalogItemRealtimeEvent, event);
    });

    const unsubscribeTransactions = base44.entities.SquareTransaction.subscribe((event) => {
      syncRealtimeEvent(handleSquareTransactionRealtimeEvent, event);
    });

    return () => {
      isActive = false;
      unsubscribeCatalogItems?.();
      unsubscribeTransactions?.();
    };
  }, [currentUser, handleSquareCatalogItemRealtimeEvent, handleSquareTransactionRealtimeEvent, hydrateFromOffline]);

  const syncFromSquare = async () => {
    setIsSyncing(true);
    setError(null);
    setBgSyncProgress({ stage: "catalog_sync" });

    try {
      const response = await base44.functions.invoke("squareSyncCatalogItems", { skipLock: true });
      const data = response?.data || response || {};

      if (data.rate_limited) {
        setBgSyncProgress({ stage: "payments_sync", detail: "Loading cached COD data…" });
        const { items } = await refreshSquareView(locationIds, { onStageChange: setBgSyncProgress });
        await hydrateFromOffline(currentUser);
        toast.message(`Square sync is busy — using cached data (${items.length} items)`);
        setBgSyncProgress({ stage: "complete", detail: "Using cached data (rate limited)" });
        setTimeout(() => setBgSyncProgress({ stage: "idle" }), 5000);
        return;
      }

      if (!data.success) {
        throw new Error(data.error || "Sync failed");
      }

      setBgSyncProgress({ stage: "payments_sync", detail: "Loading latest synced COD data…" });
      const { items } = await refreshSquareView(locationIds, { onStageChange: setBgSyncProgress });
      await hydrateFromOffline(currentUser);

      const createdCount = data.created_catalog_items ?? data.createdCount ?? 0;
      const deletedCount = data.deleted_catalog_items ?? data.deletedCount ?? 0;
      const parts = [`${items.length} items`];
      if (createdCount > 0) parts.push(`+${createdCount} created`);
      if (deletedCount > 0) parts.push(`-${deletedCount} deleted`);
      toast.success(`Square COD sync: ${parts.join(", ")}`);

      setBgSyncProgress({ stage: "complete", detail: parts.join(", ") });
      setTimeout(() => setBgSyncProgress({ stage: "idle" }), 5000);
    } catch (syncError) {
      console.error("Sync error:", syncError);
      setError(syncError?.message || "Failed to sync COD data");
      toast.error(`Failed to sync: ${syncError?.message || "Unknown error"}`);
      setBgSyncProgress({ stage: "error", error: syncError?.message || "Failed to sync COD data" });
      setTimeout(() => setBgSyncProgress({ stage: "idle" }), 8000);
    } finally {
      setIsSyncing(false);
      setIsLoading(false);
      const updatedSyncStatus = await getSquareCODSyncStatus();
      setSyncStatus(updatedSyncStatus);
    }
  };

  const confirmDelete = async () => {
    if (!itemToDelete) return;

    setDeletingId(itemToDelete.catalog_object_id);
    try {
      await base44.functions.invoke("squareDeleteCodItem", {
        catalogObjectId: itemToDelete.catalog_object_id,
        transactionId: itemToDelete.transaction_id,
        reason: "manual_delete",
      });

      setCatalogItems((prev) => prev.filter((item) => item.catalog_object_id !== itemToDelete.catalog_object_id));
      toast.success("COD item deleted from Square");
    } catch (deleteError) {
      console.error("Delete failed:", deleteError);
      toast.error(`Failed to delete: ${deleteError?.message || "Unknown error"}`);
    } finally {
      setDeletingId(null);
      setItemToDelete(null);
      await hydrateFromOffline(currentUser);
    }
  };

  const getDriverColor = useCallback((driverId) => {
    const colors = [
      "bg-blue-100 text-blue-800 border-blue-300",
      "bg-purple-100 text-purple-800 border-purple-300",
      "bg-pink-100 text-pink-800 border-pink-300",
      "bg-orange-100 text-orange-800 border-orange-300",
      "bg-teal-100 text-teal-800 border-teal-300",
      "bg-indigo-100 text-indigo-800 border-indigo-300",
    ];

    const index = drivers.findIndex((driver) => driver.id === driverId);
    return colors[index >= 0 ? index % colors.length : 0];
  }, [drivers]);

  const getDriversForLocation = useCallback((locationId) => {
    const config = locationConfigs.find((item) => item.square_location_id === locationId);
    if (!config) return [];

    return drivers.filter((driver) => Array.isArray(driver.square_location_ids) && driver.square_location_ids.includes(config.id));
  }, [drivers, locationConfigs]);

  const parseSquareItemName = useCallback((itemName) => {
    if (!itemName) return null;

    try {
      const dateMatch = String(itemName).match(/^(\d{2})[\/-](\d{2})/);
      if (!dateMatch) return null;

      const month = Number(dateMatch[1]);
      const day = Number(dateMatch[2]);
      const today = new Date();
      const inferredDate = new Date(today.getFullYear(), month - 1, day);
      const msInDay = 24 * 60 * 60 * 1000;

      if (inferredDate.getTime() - today.getTime() > 45 * msInDay) {
        inferredDate.setFullYear(inferredDate.getFullYear() - 1);
      }

      const deliveryDate = format(inferredDate, "yyyy-MM-dd");
      const storeMatch = String(itemName).match(/\(([^)]+)\)/);
      const nameMatch = String(itemName).match(/\)-(.+)$/);

      return {
        deliveryDate,
        storeAbbr: storeMatch ? storeMatch[1] : null,
        patientName: nameMatch ? nameMatch[1].trim() : null,
      };
    } catch {
      return null;
    }
  }, []);

  const storeById = useMemo(() => new Map(stores.map((store) => [store.id, store])), [stores]);
  const configById = useMemo(() => new Map(locationConfigs.map((config) => [config.id, config])), [locationConfigs]);
  const configBySquareLocationId = useMemo(() => new Map(locationConfigs.map((config) => [config.square_location_id, config])), [locationConfigs]);
  const citySquareLocationIds = useMemo(() => new Set(locationConfigs.map((config) => config.square_location_id).filter(Boolean)), [locationConfigs]);

  const patientLookup = useMemo(() => {
    const map = new Map();
    patients.forEach((patient) => {
      if (patient?.id) map.set(patient.id, patient);
      if (patient?.patient_id) map.set(patient.patient_id, patient);
    });
    return map;
  }, [patients]);

  const catalogByDeliveryId = useMemo(() => {
    const map = new Map();
    catalogItems
      .filter((item) => citySquareLocationIds.has(item.location_id))
      .forEach((item) => {
        if (item?.delivery_id && !map.has(item.delivery_id)) {
          map.set(item.delivery_id, item);
        }
      });
    return map;
  }, [catalogItems, citySquareLocationIds]);

  const findMatchingDelivery = useCallback((itemName) => {
    const parsed = parseSquareItemName(itemName);
    if (!parsed?.deliveryDate || !parsed?.patientName) return null;

    const store = stores.find((storeRecord) => storeRecord.abbreviation === parsed.storeAbbr);
    if (!store) return null;

    return deliveries.find((delivery) => {
      if (delivery.delivery_date !== parsed.deliveryDate) return false;
      if (delivery.store_id !== store.id) return false;
      if (!["completed", "returned"].includes(delivery.status)) return false;
      const matchedPatient = patientLookup.get(delivery.patient_id);
      return matchedPatient?.full_name?.toLowerCase().trim() === parsed.patientName.toLowerCase().trim();
    }) || null;
  }, [deliveries, parseSquareItemName, patientLookup, stores]);

  const getCODPaymentDetails = useCallback((itemName) => {
    const delivery = findMatchingDelivery(itemName);
    if (!delivery) return { status: "no_collection", payments: [] };

    const codPayments = Array.isArray(delivery.cod_payments) ? delivery.cod_payments : [];
    if (codPayments.length > 0) {
      return { status: "collected", payments: codPayments };
    }

    if (delivery.cod_payment_type && delivery.cod_payment_type !== "No Payment") {
      return {
        status: "collected",
        payments: [{
          type: delivery.cod_payment_type,
          amount: Number(delivery.cod_amount || 0),
        }],
      };
    }

    return { status: "cash", payments: [] };
  }, [findMatchingDelivery]);

  const getMonthDayKey = useCallback((value) => {
    if (!value) return "";

    const isoMatch = String(value).match(/^\d{4}-(\d{2})-(\d{2})$/);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}`;

    const parsed = parseSquareItemName(value);
    if (parsed?.deliveryDate) {
      const [, month, day] = parsed.deliveryDate.split("-");
      return `${month}-${day}`;
    }

    return "";
  }, [parseSquareItemName]);

  const buildLocationDateAmountSignature = useCallback((locationId, dateValue, amountValue) => {
    const amountCents = Math.round(Number(amountValue || 0) * 100);
    return `${locationId || ""}::${getMonthDayKey(dateValue) || "unknown-date"}::${amountCents}`;
  }, [getMonthDayKey]);

  const hasBeenSoldInSquare = useCallback((catalogItem) => {
    const catalogPrice = catalogItem.price_dollars || ((catalogItem.price_cents || 0) / 100);
    const catalogSignature = buildLocationDateAmountSignature(
      catalogItem.location_id,
      catalogItem.delivery_date || catalogItem.name,
      catalogPrice,
    );

    return soldCatalogItems.some((payment) => {
      const paymentSignature = buildLocationDateAmountSignature(
        payment.location_id,
        payment.item_name,
        payment.amount,
      );
      return paymentSignature === catalogSignature;
    });
  }, [buildLocationDateAmountSignature, soldCatalogItems]);

  const isTransferTransaction = useCallback((transaction) => {
    const label = `${transaction?.item_name || ""} ${transaction?.delivery_id || ""}`.toLowerCase();
    return transaction?.type === "transfer" || label.includes("transfer") || label.includes("interstore") || label.includes("inter-store");
  }, []);

  const selectedDriverUserIds = useMemo(() => {
    if (selectedDriverFilter !== "all") {
      const selectedDriver = drivers.find((driver) => driver?.id === selectedDriverFilter);
      return new Set(selectedDriver?.user_id ? [selectedDriver.user_id] : []);
    }

    const driverIds = drivers.map((driver) => driver?.user_id).filter(Boolean);
    if (driverIds.length > 0) return new Set(driverIds);
    return new Set(currentUser?.id ? [currentUser.id] : []);
  }, [currentUser, drivers, selectedDriverFilter]);

  const visibleCatalogItems = useMemo(() => {
    if (!currentUser) return [];

    const userIsOwner = isAppOwner(currentUser);
    let items = catalogItems.filter((item) => citySquareLocationIds.has(item.location_id));

    if (userIsOwner && selectedDriverFilter !== "all") {
      const driver = drivers.find((driverRecord) => driverRecord.id === selectedDriverFilter);
      const driverLocationConfigIds = new Set(driver?.square_location_ids || []);
      const driverLocationIds = new Set(
        locationConfigs
          .filter((config) => driverLocationConfigIds.has(config.id))
          .map((config) => config.square_location_id),
      );
      items = items.filter((item) => driverLocationIds.has(item.location_id));
    }

    if (!userIsOwner) {
      const currentDriver = drivers.find((driver) => driver.user_id === currentUser.id);
      const driverLocationConfigIds = new Set(currentDriver?.square_location_ids || []);
      const driverLocationIds = new Set(
        locationConfigs
          .filter((config) => driverLocationConfigIds.has(config.id))
          .map((config) => config.square_location_id),
      );
      items = items.filter((item) => driverLocationIds.has(item.location_id));
    }

    return items
      .filter((item) => {
        const linkedDelivery = deliveries.find((delivery) => delivery?.id === item.delivery_id);
        if (linkedDelivery?.status === "pending") return false;
        return !item.is_sold && !hasBeenSoldInSquare(item);
      })
      .sort((a, b) => {
        const aName = String(a?.name || a?.item_name || "").toLowerCase();
        const bName = String(b?.name || b?.item_name || "").toLowerCase();
        return aName.localeCompare(bName);
      });
  }, [catalogItems, citySquareLocationIds, currentUser, deliveries, drivers, hasBeenSoldInSquare, locationConfigs, selectedDriverFilter]);

  const visibleTransactions = useMemo(() => {
    return allTransactions
      .filter((transaction) => {
        if (!transaction || isTransferTransaction(transaction)) return false;
        if (!citySquareLocationIds.has(transaction.location_id)) return false;
        if (!["completed", "refunded"].includes(transaction.status)) return false;
        if (transaction.type !== "collection") return false;
        if (selectedDriverUserIds.size > 0 && transaction.driver_id && !selectedDriverUserIds.has(transaction.driver_id)) return false;
        return true;
      })
      .sort((a, b) => new Date(b?.created_date || b?.updated_date || 0).getTime() - new Date(a?.created_date || a?.updated_date || 0).getTime());
  }, [allTransactions, citySquareLocationIds, isTransferTransaction, selectedDriverUserIds]);

  const visibleDeliveries = useMemo(() => {
    return deliveries
      .filter((delivery) => {
        if (!delivery) return false;
        if (Number(delivery.cod_total_amount_required || 0) <= 0) return false;
        if (selectedDriverUserIds.size === 0) return false;
        return selectedDriverUserIds.has(delivery.driver_id);
      })
      .sort((a, b) => {
        const dateCompare = String(b?.delivery_date || "").localeCompare(String(a?.delivery_date || ""));
        if (dateCompare !== 0) return dateCompare;
        return String(a?.delivery_id || a?.stop_id || "").localeCompare(String(b?.delivery_id || b?.stop_id || ""));
      });
  }, [deliveries, selectedDriverUserIds]);

  const deliveryRows = useMemo(() => {
    return visibleDeliveries.map((delivery) => {
      const patient = patientLookup.get(delivery.patient_id);
      const store = storeById.get(delivery.store_id);
      const config = locationConfigs.find((item) => item.id === store?.square_location_config_id);
      const linkedCatalogItem = catalogByDeliveryId.get(delivery.id);
      const paymentBadges = [];
      const codPayments = Array.isArray(delivery.cod_payments) ? delivery.cod_payments : [];

      if (codPayments.length > 0) {
        codPayments.forEach((payment) => {
          paymentBadges.push(
            makeBadge(
              `${payment.type}: $${Number(payment.amount || 0).toFixed(2)}`,
              payment.type === "Cash"
                ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                : payment.type === "Debit"
                ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
                : payment.type === "Credit"
                ? "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300"
                : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
            ),
          );
        });
      } else if (delivery.cod_payment_type && delivery.cod_payment_type !== "No Payment") {
        paymentBadges.push(makeBadge(delivery.cod_payment_type, "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300"));
      } else {
        paymentBadges.push(makeBadge("No Collection", "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300"));
      }

      paymentBadges.unshift(
        makeBadge(
          String(delivery.status || "pending").replace(/_/g, " "),
          delivery.status === "completed"
            ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
            : delivery.status === "failed"
            ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
            : "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
        ),
      );

      return {
        id: `delivery-${delivery.id}`,
        raw: delivery,
        rawType: "delivery",
        itemName: patient?.full_name || delivery.delivery_id || delivery.stop_id || "Unknown Delivery",
        amount: Number(delivery.cod_total_amount_required || 0),
        storeName: store?.name || "Unknown",
        squareLocationId: config?.square_location_id || "—",
        catalogId: linkedCatalogItem?.catalog_object_id || "—",
        deliveryDate: delivery.delivery_date,
        badges: paymentBadges,
        driverBadges: [],
        description: delivery.tracking_number || "",
        actionType: "none",
        isSelectable: false,
      };
    });
  }, [catalogByDeliveryId, locationConfigs, patientLookup, storeById, visibleDeliveries]);

  const transactionRows = useMemo(() => {
    return visibleTransactions.map((transaction) => {
      const store = transaction.store_id ? storeById.get(transaction.store_id) : null;
      const config = transaction.location_id ? configBySquareLocationId.get(transaction.location_id) : null;
      const parsed = parseSquareItemName(transaction.item_name);
      const linkedDelivery = transaction.delivery_id ? deliveries.find((delivery) => delivery.id === transaction.delivery_id) : null;

      return {
        id: `transaction-${transaction.id}`,
        raw: transaction,
        rawType: "transaction",
        itemName: transaction.item_name || "Square Transaction",
        amount: Number(transaction.amount || 0),
        storeName: store?.name || stores.find((storeRecord) => storeRecord.square_location_config_id === config?.id)?.name || config?.name || "Unknown",
        squareLocationId: transaction.location_id || "—",
        catalogId: transaction.square_catalog_object_id || "—",
        deliveryDate: linkedDelivery?.delivery_date || parsed?.deliveryDate || transaction.created_date,
        badges: [
          makeBadge(transaction.status || "unknown", "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"),
          makeBadge(transaction.payment_method || "Unknown", "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300"),
        ],
        driverBadges: [],
        description: transaction.square_payment_id || "",
        actionType: "none",
        isSelectable: false,
      };
    });
  }, [configBySquareLocationId, deliveries, parseSquareItemName, stores, storeById, visibleTransactions]);

  const catalogRows = useMemo(() => {
    return visibleCatalogItems.map((item, index) => {
      const delivery = deliveries.find((record) => record?.id === item.delivery_id);
      const patient = delivery?.patient_id ? patientLookup.get(delivery.patient_id) : null;
      const parsed = parseSquareItemName(item.name || item.item_name);
      const itemDrivers = getDriversForLocation(item.location_id).sort((a, b) => (a?.sort_order ?? Infinity) - (b?.sort_order ?? Infinity));
      const store = stores.find((storeRecord) => storeRecord.square_location_config_id === configBySquareLocationId.get(item.location_id)?.id);
      const codDetails = getCODPaymentDetails(item.name || item.item_name);
      const badges = [];

      if (hasBeenSoldInSquare(item)) {
        badges.push(makeBadge("✓ Collected", "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"));
      } else if (codDetails.status === "collected" && codDetails.payments.length > 0) {
        codDetails.payments.forEach((payment) => {
          badges.push(
            makeBadge(
              `${payment.type}: $${Number(payment.amount || 0).toFixed(2)}`,
              payment.type === "Cash"
                ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
                : payment.type === "Debit"
                ? "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
                : payment.type === "Credit"
                ? "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300"
                : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
            ),
          );
        });
      } else if (codDetails.status === "cash") {
        badges.push(makeBadge("Cash", "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"));
      } else {
        badges.push(makeBadge("No Collection", "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300"));
      }

      return {
        id: `catalog-${item.catalog_object_id}-${index}`,
        raw: item,
        rawType: "catalog",
        itemName: patient?.full_name || parsed?.patientName || item.name || item.item_name || "N/A",
        amount: Number(item.price_dollars || 0),
        storeName: store?.name || configBySquareLocationId.get(item.location_id)?.name || "Unknown",
        squareLocationId: item.location_id || "—",
        catalogId: item.catalog_object_id || "—",
        deliveryDate: delivery?.delivery_date || item.delivery_date || parsed?.deliveryDate,
        badges,
        driverBadges: isAppOwner(currentUser)
          ? itemDrivers.map((driver) => ({ label: driver.user_name, className: getDriverColor(driver.id) }))
          : [],
        description: item.description || "",
        actionType: "delete",
        isSelectable: true,
      };
    });
  }, [configBySquareLocationId, currentUser, deliveries, getCODPaymentDetails, getDriverColor, getDriversForLocation, hasBeenSoldInSquare, patientLookup, parseSquareItemName, stores, visibleCatalogItems]);

  const activeRows = useMemo(() => {
    if (activeView === "catalog") return catalogRows;
    if (activeView === "transactions") return transactionRows;
    if (activeView === "deliveries") return deliveryRows;
    return [];
  }, [activeView, catalogRows, deliveryRows, transactionRows]);

  const stats = useMemo(() => ({
    total: activeRows.length,
    totalAmount: activeRows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    locations: new Set(activeRows.map((row) => row.squareLocationId).filter(Boolean).filter((value) => value !== "—")).size,
  }), [activeRows]);

  const codDeliveriesCount = deliveryRows.length;

  const collectedCodTypeBreakdown = useMemo(() => {
    const counts = { Cash: 0, Debit: 0, Credit: 0, Check: 0 };

    visibleDeliveries.forEach((delivery) => {
      const codPayments = Array.isArray(delivery.cod_payments) ? delivery.cod_payments : [];
      if (codPayments.length > 0) {
        const types = new Set(
          codPayments
            .filter((payment) => Number(payment?.amount || 0) > 0)
            .map((payment) => payment?.type)
            .filter((type) => ["Cash", "Debit", "Credit", "Check"].includes(type)),
        );
        types.forEach((type) => {
          counts[type] += 1;
        });
        return;
      }

      if (["Cash", "Debit", "Credit", "Check"].includes(delivery.cod_payment_type)) {
        counts[delivery.cod_payment_type] += 1;
      }
    });

    return counts;
  }, [visibleDeliveries]);

  const filteredCardSpendCount = visibleTransactions.length;
  const filteredSalesCount = soldCatalogItems.filter((transaction) => citySquareLocationIds.has(transaction.location_id)).length;

  return (
    <div className="p-4 md:p-6 bg-background text-foreground w-full min-h-screen md:h-screen flex flex-col overflow-hidden" style={{ paddingBottom: navHeight ? navHeight + 8 : undefined }}>
      <div className="flex flex-col gap-4 mb-6">
        <div className="flex items-center gap-3">
          <CreditCard className="w-6 md:w-8 h-6 md:h-8 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="min-w-0">
            <h1 className="text-xl md:text-2xl font-bold text-slate-900 dark:text-slate-50">Square COD</h1>
            <p className="text-xs md:text-sm text-slate-600 dark:text-slate-400">Track and manage COD payments</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 md:gap-3">
          {currentUser && isAppOwner(currentUser) && drivers.length > 0 ? (
            <Select value={selectedDriverFilter} onValueChange={setSelectedDriverFilter}>
              <SelectTrigger className="w-[150px] md:w-[200px] text-sm">
                <SelectValue placeholder="All Drivers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Drivers</SelectItem>
                {drivers.map((driver) => (
                  <SelectItem key={driver.id} value={driver.id}>
                    {driver.user_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <SquareCODViewTabs activeView={activeView} onChange={setActiveView} />
            <Button onClick={syncFromSquare} disabled={isLoading || isSyncing} className="gap-2 text-sm">
              <CloudDownload className={`w-4 h-4 flex-shrink-0 ${isSyncing ? "animate-pulse" : ""}`} />
              <span className="hidden sm:inline">{isSyncing ? "Syncing..." : "Sync"}</span>
              <span className="sm:hidden">{isSyncing ? "Syncing" : "Sync"}</span>
            </Button>
          </div>
        </div>
      </div>

      {syncStatus ? (
        <div className="mb-2">
          <SyncStatusIndicator
            syncStatus={syncStatus}
            isSyncing={isSyncing}
            error={error}
            codDeliveryCount={codDeliveriesCount}
            catalogItemCount={visibleCatalogItems.length}
            cardSpendCount={filteredCardSpendCount}
            salesCount={filteredSalesCount}
            collectedCodTypeBreakdown={collectedCodTypeBreakdown}
          />
        </div>
      ) : null}

      {bgSyncProgress.stage !== "idle" ? (
        <div className="mb-6 md:mb-8">
          <BackgroundSyncProgressBar progress={bgSyncProgress} />
        </div>
      ) : !syncStatus ? <div className="mb-4" /> : null}

      <div className="grid grid-cols-3 gap-2 md:gap-4 mb-6 md:mb-8">
        <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700">
          <CardContent className="p-3 md:p-4">
            <div className="text-xs md:text-sm text-slate-600 dark:text-slate-400">Visible Records</div>
            <div className="text-xl md:text-2xl font-bold text-slate-900 dark:text-slate-50">{stats.total}</div>
          </CardContent>
        </Card>
        <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700">
          <CardContent className="p-3 md:p-4">
            <div className="text-xs md:text-sm text-slate-600 dark:text-slate-400">Total Amount</div>
            <div className="text-xl md:text-2xl font-bold text-emerald-600 dark:text-emerald-400">${stats.totalAmount.toFixed(2)}</div>
          </CardContent>
        </Card>
        <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700">
          <CardContent className="p-3 md:p-4">
            <div className="text-xs md:text-sm text-slate-600 dark:text-slate-400">Square Locations</div>
            <div className="text-xl md:text-2xl font-bold text-blue-600 dark:text-blue-400">{stats.locations}</div>
          </CardContent>
        </Card>
      </div>

      {currentUser && isAppOwner(currentUser) && activeView === "catalog" && locationConfigs.length > 0 ? (
        <div>
          <h2 className="text-base md:text-lg font-semibold mb-4 text-slate-900 dark:text-slate-50">By Location</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-none md:auto-cols-fr md:grid-flow-col gap-2 md:gap-4 mb-6 md:mb-8">
            {locationConfigs
              .slice()
              .sort((a, b) => {
                const storeA = stores.find((store) => store.square_location_config_id === a.id);
                const storeB = stores.find((store) => store.square_location_config_id === b.id);
                return (storeA?.sort_order ?? Infinity) - (storeB?.sort_order ?? Infinity);
              })
              .map((config) => {
                const locationItems = visibleCatalogItems.filter((item) => item.location_id === config.square_location_id);
                const store = stores.find((storeRecord) => storeRecord.square_location_config_id === config.id);

                return (
                  <LocationSummaryCard
                    key={config.id}
                    location={{ name: config?.name || store?.name || "Unknown", square_location_id: config.square_location_id }}
                    codTotal={locationItems.reduce((sum, item) => sum + Number(item.price_dollars || 0), 0)}
                    itemCount={locationItems.length}
                    onClick={() => setSelectedLocation(config)}
                  />
                );
              })}
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="p-3 md:p-4 rounded-lg mb-6 text-sm md:text-base bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800">
          Error: {error}
        </div>
      ) : null}

      {activeView === "reconciliation" ? (
        <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 flex-1 flex items-center justify-center">
          <CardContent className="py-16 text-center">
            <div className="text-lg font-semibold text-slate-900 dark:text-slate-50">Reconciliation is ready for the next step</div>
            <div className="mt-2 text-sm text-slate-600 dark:text-slate-400">The Deliveries, Transactions, and Catalog views are now set up first.</div>
          </CardContent>
        </Card>
      ) : (
        <SquareCODDatasetTable
          title={VIEW_META[activeView].title}
          rows={activeRows}
          isLoading={isLoading}
          emptyTitle={VIEW_META[activeView].emptyTitle}
          emptyDescription={VIEW_META[activeView].emptyDescription}
          deletingId={deletingId}
          onDeleteCatalogItem={setItemToDelete}
          onSelectRow={setSelectedCODItem}
        />
      )}

      {selectedLocation ? (
        <TransactionHistoryPanel
          location={selectedLocation}
          transactions={allTransactions}
          drivers={drivers}
          catalogItems={catalogItems}
          onClose={() => setSelectedLocation(null)}
        />
      ) : null}

      {selectedCODItem ? (
        <CODItemDetailModal
          item={selectedCODItem}
          locationConfigs={locationConfigs}
          stores={stores}
          transactions={allTransactions}
          drivers={drivers}
          deliveries={deliveries}
          onClose={() => setSelectedCODItem(null)}
        />
      ) : null}

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