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
import { getStatusBadge, getTypeBadge, getPaymentMethodBadge } from "@/components/square/badgeHelpers";
import { format } from "date-fns";
import { smartRefreshManager } from "@/components/utils/smartRefreshManager";
import * as squareCODOfflineManager from "@/components/utils/squareCODOfflineManager";

export default function SquareManagement() {
  const {
    syncSquareCODSnapshotOffline,
    getCatalogItemsOffline,
    getPaymentTransactionsOffline,
    getSquareCODSyncStatus,
    handleSquareCatalogItemRealtimeEvent,
    handleSquareTransactionRealtimeEvent,
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
  const [drivers, setDrivers] = useState([]);
  const [patients, setPatients] = useState([]);
  const [selectedDriverFilter, setSelectedDriverFilter] = useState('all');
  const [recentTransactions, setRecentTransactions] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [selectedCODItem, setSelectedCODItem] = useState(null);
  const [allTransactions, setAllTransactions] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [itemToDelete, setItemToDelete] = useState(null);
  const [soldCatalogItems, setSoldCatalogItems] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);
  const [lastCleanup, setLastCleanup] = useState(null);
  const [navHeight, setNavHeight] = useState(0);
  const [bgSyncProgress, setBgSyncProgress] = useState({ stage: 'idle' });

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

  const refreshSquareView = async (fallbackLocationIds = []) => {
    const [catalogRecords, transactions] = await Promise.all([
      base44.entities.SquareCatalogItems.list('-updated_date', 500),
      base44.entities.SquareTransaction.list('-created_date', 500),
    ]);

    await syncSquareCODSnapshotOffline({
      catalogItems: catalogRecords || [],
      transactions: transactions || [],
    });

    const snapshot = await loadSquareViewFromOffline();
    setLocationIds(fallbackLocationIds);

    return { ...snapshot, data: { locationIds: fallbackLocationIds } };
  };

  const syncFromSquare = async () => {
    setIsSyncing(true);
    setError(null);
    setBgSyncProgress({ stage: 'catalog_sync' });

    try {
      const response = await base44.functions.invoke('squareSyncCatalogItems', { skipLock: true });
      const data = response?.data || response || {};

      if (data.rate_limited) {
        const { items } = await refreshSquareView(locationIds);
        toast.message(`Square sync is busy — using cached data (${items.length} active items)`);
        setBgSyncProgress({ stage: 'complete', detail: 'Using cached data (rate limited)' });
        setTimeout(() => setBgSyncProgress({ stage: 'idle' }), 5000);
        return;
      }

      if (!data.success) throw new Error(data.error || 'Sync failed');

      setBgSyncProgress({ stage: 'payments_sync' });
      const { items } = await refreshSquareView(locationIds);

      const createdCount = data.created_catalog_items ?? data.createdCount ?? 0;
      const deletedCount = data.deleted_catalog_items ?? data.deletedCount ?? 0;
      const parts = [];
      parts.push(`${items.length} active items`);
      if (createdCount > 0) parts.push(`+${createdCount} created`);
      if (deletedCount > 0) parts.push(`-${deletedCount} deleted`);
      toast.success(`Square COD sync: ${parts.join(', ')}`);

      setBgSyncProgress({ stage: 'complete', detail: parts.join(', ') });
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
      const updatedSyncStatus = await getSquareCODSyncStatus();
      setSyncStatus(updatedSyncStatus);
    }
  };

      const loadSyncStatus = async () => {
      try {
      const status = await getSquareCODSyncStatus();
      setSyncStatus(status);
      } catch (err) {
      console.error('Failed to load sync status:', err);
      }
      };

      useEffect(() => {
    const loadData = async () => {
      try {
        const user = await base44.auth.me();
        setCurrentUser(user);

        const today = new Date();
        const fourteenDaysAgo = new Date(today);
        fourteenDaysAgo.setDate(today.getDate() - 14);
        const dateFilter = {
          delivery_date: { 
            $gte: format(fourteenDaysAgo, 'yyyy-MM-dd'),
            $lte: format(today, 'yyyy-MM-dd')
          }
        };

        // OFFLINE-FIRST: Load from offline DB first to prevent rate limits
        const { offlineDB } = await import('@/components/utils/offlineDatabase');
        
        // Load Stores from offline DB first
        let storesData = await offlineDB.getAll(offlineDB.STORES.STORES) || [];
        if (storesData.length === 0) {
          console.log('📥 [SquareManagement] Stores not in offline DB - fetching from API');
          storesData = await base44.entities.Store.list();
          await offlineDB.bulkSave(offlineDB.STORES.STORES, storesData);
        } else {
          console.log(`📦 [SquareManagement] Using ${storesData.length} stores from offline DB`);
        }

        // Load AppUsers from offline DB first
        let appUsersData = await offlineDB.getAll(offlineDB.STORES.APP_USERS) || [];
        if (appUsersData.length === 0) {
          console.log('📥 [SquareManagement] AppUsers not in offline DB - fetching from API');
          appUsersData = await base44.entities.AppUser.list();
          await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, appUsersData);
        } else {
          console.log(`📦 [SquareManagement] Using ${appUsersData.length} AppUsers from offline DB`);
        }

        // Load Patients from offline DB first
        let patientsData = await offlineDB.getAll(offlineDB.STORES.PATIENTS) || [];
        if (patientsData.length === 0) {
          console.log('📥 [SquareManagement] Patients not in offline DB - fetching from API');
          patientsData = await base44.entities.Patient.list();
          await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, patientsData);
        } else {
          console.log(`📦 [SquareManagement] Using ${patientsData.length} patients from offline DB`);
        }

        // Load Deliveries from offline DB first
        let deliveriesData = [];
        try {
          const allDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES) || [];
          const fourteenDaysAgoStr = format(fourteenDaysAgo, 'yyyy-MM-dd');
          const todayStr = format(today, 'yyyy-MM-dd');
          
          deliveriesData = allDeliveries.filter(d => 
            d && d.delivery_date >= fourteenDaysAgoStr && d.delivery_date <= todayStr
          );
          
          if (deliveriesData.length === 0) {
            console.log('📥 [SquareManagement] Recent deliveries not in offline DB - fetching from API');
            deliveriesData = await base44.entities.Delivery.filter(dateFilter);
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveriesData);
          } else {
            console.log(`📦 [SquareManagement] Using ${deliveriesData.length} recent deliveries from offline DB`);
          }
        } catch (offlineError) {
          console.warn('⚠️ [SquareManagement] Offline deliveries failed, fetching from API');
          deliveriesData = await base44.entities.Delivery.filter(dateFilter);
        }

        const configs = await base44.entities.SquareLocationConfig.filter({ status: 'active' });

        setLocationConfigs(configs || []);
        setStores(storesData || []);
        setPatients(patientsData || []);
        setDeliveries(deliveriesData || []);

        const driversList = appUsersData.filter(u => 
          u && u.app_roles && u.app_roles.includes('driver') && u.status === 'active'
        );
        setDrivers(driversList || []);

        const syncedLocationIds = configs.map(c => c.square_location_id).filter(Boolean);
        setLocationIds(syncedLocationIds);

        const offlineSnapshot = await loadSquareViewFromOffline();
        if (offlineSnapshot.items.length > 0 || offlineSnapshot.transactions.length > 0) {
          setIsLoading(false);
        }

        // Always fetch fresh data from API (sync first, then refresh UI from Square)
        setBgSyncProgress({ stage: 'catalog_sync' });
        try {
          const response = await base44.functions.invoke('squareSyncCatalogItems', { skipLock: true });
          const data = response?.data || response || {};

          if (data.rate_limited) {
            await refreshSquareView(syncedLocationIds);
            await loadSyncStatus();
            setBgSyncProgress({ stage: 'complete', detail: 'Using cached data (rate limited)' });
            setTimeout(() => setBgSyncProgress({ stage: 'idle' }), 3000);
          } else if (data.success) {
            setBgSyncProgress({ stage: 'payments_sync' });
            const { items } = await refreshSquareView(syncedLocationIds);

            await loadSyncStatus();

            const createdCount = data.created_catalog_items ?? data.createdCount ?? 0;
            const deletedCount = data.deleted_catalog_items ?? data.deletedCount ?? 0;
            const detailParts = [
              `${items.length} items`,
              createdCount > 0 ? `+${createdCount} created` : null,
              deletedCount > 0 ? `-${deletedCount} deleted` : null,
            ].filter(Boolean).join(', ');

            setBgSyncProgress({ stage: 'complete', detail: detailParts });
            setTimeout(() => setBgSyncProgress({ stage: 'idle' }), 5000);
          } else if (data.lock_active) {
            // Lock active — keep offline data as-is
            setBgSyncProgress({ stage: 'complete', detail: 'Using cached data (sync locked)' });
            setTimeout(() => setBgSyncProgress({ stage: 'idle' }), 3000);
          }
        } catch (bgError) {
          console.warn('⚠️ [SquareManagement] API refresh failed:', bgError.message);
          setBgSyncProgress({ stage: 'error', error: bgError.message });
          setTimeout(() => setBgSyncProgress({ stage: 'idle' }), 8000);
        }

        setIsLoading(false);
      } catch (err) {
        console.error('Failed to load COD data:', err);
        setIsLoading(false);
      }
    };

    loadData();
  }, []);

  useEffect(() => {
    let isActive = true;

    const syncRealtimeEvent = async (handler, event) => {
      try {
        await handler(event);
        if (isActive) {
          await loadSquareViewFromOffline();
        }
      } catch (error) {
        console.error('❌ [SquareManagement] Realtime Square sync failed:', error);
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
  }, [loadSquareViewFromOffline]);



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
    
    console.log(`🔍 [SquareManagement] Filtering: catalogItems.length=${catalogItems.length}, soldCatalogItems.length=${soldCatalogItems.length}`);

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
    date.setDate(date.getDate() - 14);
    date.setHours(0, 0, 0, 0);
    return date;
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

  const isTransferTransaction = (transaction) => {
    const label = `${transaction?.item_name || ''} ${transaction?.delivery_id || ''}`.toLowerCase();
    return transaction?.type === 'transfer' || label.includes('transfer') || label.includes('interstore') || label.includes('inter-store');
  };

  const filteredCardSpendCount = React.useMemo(() => {
    return allTransactions.filter(transaction => {
      if (!transaction || isTransferTransaction(transaction)) return false;
      const transactionDate = new Date(transaction.created_date || transaction.updated_date || 0);
      if (!(transactionDate instanceof Date) || Number.isNaN(transactionDate.getTime()) || transactionDate < lookbackStart) return false;
      if (selectedDriverUserIds.size === 0 || !selectedDriverUserIds.has(transaction.driver_id)) return false;
      return transaction.type === 'collection' && ['completed', 'refunded'].includes(transaction.status);
    }).length;
  }, [allTransactions, lookbackStart, selectedDriverUserIds]);

  const filteredSalesCount = React.useMemo(() => {
    return soldCatalogItems.filter(transaction => {
      if (!transaction || isTransferTransaction(transaction)) return false;
      const transactionDate = new Date(transaction.created_date || transaction.updated_date || 0);
      if (!(transactionDate instanceof Date) || Number.isNaN(transactionDate.getTime()) || transactionDate < lookbackStart) return false;
      if (selectedDriverUserIds.size === 0) return false;
      return selectedDriverUserIds.has(transaction.driver_id);
    }).length;
  }, [soldCatalogItems, lookbackStart, selectedDriverUserIds]);

  // Summary stats
  const stats = {
    total: filteredCatalogItems.length,
    totalAmount: filteredCatalogItems.reduce((sum, i) => sum + (i.price_dollars || 0), 0),
    locations: locationIds.length
  };

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
      
      <div className="flex flex-row items-center gap-2 md:gap-3">
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
        <Button onClick={syncFromSquare} disabled={isLoading || isSyncing} className="gap-2 text-sm">
          <CloudDownload className={`w-4 h-4 flex-shrink-0 ${isSyncing ? 'animate-pulse' : ''}`} />
          <span className="hidden sm:inline">{isSyncing ? 'Syncing...' : 'Sync'}</span>
          <span className="sm:hidden">{isSyncing ? 'Syncing' : 'Sync'}</span>
        </Button>
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
            <div className="text-xs md:text-sm text-slate-600 dark:text-slate-400">Active COD Items</div>
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

      {/* Location Summary Cards */}
      {currentUser && isAppOwner(currentUser) && locationConfigs.length > 0 && (
        <div>
          <h2 className="text-base md:text-lg font-semibold mb-4 text-slate-900 dark:text-slate-50">By Location</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-none md:auto-cols-fr md:grid-flow-col gap-2 md:gap-4 mb-6 md:mb-8">
            {locationConfigs
              .sort((a, b) => {
                const storeA = stores.find(s => s.square_location_config_id === a.id);
                const storeB = stores.find(s => s.square_location_config_id === b.id);
                return (storeA?.sort_order ?? Infinity) - (storeB?.sort_order ?? Infinity);
              })
              .map(config => {
                const locationItems = filteredCatalogItems.filter(item => item.location_id === config.square_location_id);
                const codTotal = locationItems.reduce((sum, item) => sum + (item.price_dollars || 0), 0);
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

      {/* Active Square Items */}
      <Card className="bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 flex-1 flex flex-col min-h-0">
        <CardHeader className="sticky top-0 z-10 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
          <CardTitle className="text-base md:text-lg text-slate-900 dark:text-slate-50">Active COD Items</CardTitle>
        </CardHeader>
        <CardContent className="flex-1 overflow-y-auto" style={{ paddingBottom: navHeight ? navHeight + 8 : undefined }}>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin w-8 h-8 border-4 rounded-full" style={{ borderColor: 'var(--border-emerald-500)', borderTopColor: 'transparent' }} />
            </div>
          ) : filteredCatalogItems.length === 0 ? (
            <div className="text-center py-12 text-slate-500 dark:text-slate-400">
               <DollarSign className="w-10 md:w-12 h-10 md:h-12 mx-auto mb-4 opacity-50" />
               <p className="text-sm md:text-base">No active COD items in Square</p>
               <p className="text-xs md:text-sm mt-1">COD items will appear here when deliveries are created with COD amounts</p>
             </div>
          ) : (
            <div className="hidden md:block overflow-x-auto pb-2">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700">
                    <th className="p-3">Item Name</th>
                    <th className="p-3">Amount</th>
                    <th className="p-3">Store</th>
                    {currentUser && isAppOwner(currentUser) && <th className="p-3">Square Location ID</th>}
                    <th className="p-3">Catalog ID</th>
                    <th className="p-3">Delivery Date</th>
                    <th className="p-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCatalogItems.map((item, index) => {
                    const itemDrivers = getDriversForLocation(item.location_id)
                      .sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
                    const userIsAppOwner = currentUser && isAppOwner(currentUser);

                    // Get store for this item
                    const itemConfig = locationConfigs.find(c => c.square_location_id === item.location_id);
                    const itemStore = stores.find(s => s.square_location_config_id === itemConfig?.id);
                    const storeColor = itemStore ? getStoreColor(itemStore.id) : null;

                    // Check if there are other items with different stores
                    const hasMultipleStores = filteredCatalogItems.some(otherItem => {
                      if (otherItem.catalog_object_id === item.catalog_object_id) return false;
                      const otherConfig = locationConfigs.find(c => c.square_location_id === otherItem.location_id);
                      const otherStore = stores.find(s => s.square_location_config_id === otherConfig?.id);
                      return otherStore?.id !== itemStore?.id;
                    });

                    return (
                    <tr key={`${item.catalog_object_id}-${item.location_id}-${index}`} className="transition-colors border-b border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="p-3">
                        <div className="font-medium text-sm text-slate-900 dark:text-slate-50">
                          {(() => {
                            const delivery = deliveries.find(d => d?.id === item.delivery_id);
                            const patient = delivery?.patient_id ? patients.find(p => p?.id === delivery.patient_id || p?.patient_id === delivery.patient_id) : null;
                            const parsed = parseSquareItemName(item.name || item.item_name);
                            return patient?.full_name || parsed?.patientName || item.name || item.item_name || 'N/A';
                          })()}
                        </div>
                       {userIsAppOwner && itemDrivers.length > 0 && (
                          <div className="flex gap-1 mt-1.5 flex-wrap">
                            {itemDrivers.map(driver => (
                              <Badge key={driver.id} className={`${getDriverColor(driver.id)} text-xs border`}>
                                {driver.user_name}
                              </Badge>
                            ))}
                          </div>
                        )}
                        {item.description && (
                          <div className="text-xs truncate max-w-[200px] mt-1 text-muted-foreground">
                            {item.description}
                          </div>
                        )}
                      </td>
                      <td className="p-3">
                        <div>
                           <span className="font-semibold text-sm text-emerald-600 dark:text-emerald-400">
                             ${(item.price_dollars || 0).toFixed(2)}
                           </span>
                           {(() => {
                             // Check if this item has been sold in Square transactions
                             const soldInSquare = hasBeenSoldInSquare(item);

                             if (soldInSquare) {
                               return (
                                 <Badge className="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 text-xs mt-1 block w-fit">
                                   ✓ Collected
                                 </Badge>
                               );
                             }

                             const codDetails = getCODPaymentDetails(item.name, item.location_id);
                             const parsed = parseSquareItemName(item.name);
                             const isCurrentDate = parsed && parsed.deliveryDate === format(new Date(), 'yyyy-MM-dd');

                             if (codDetails.status === 'collected' && codDetails.payments.length > 0) {
                               return (
                                 <div className="flex flex-wrap gap-1 mt-1">
                                   {codDetails.payments.map((payment, idx) => {
                                     const colorClass = {
                                       'Cash': 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
                                       'Debit': 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
                                       'Credit': 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
                                       'Check': 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                                     }[payment.type] || 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300';

                                     return (
                                       <Badge key={idx} className={`${colorClass} text-xs`}>
                                         {payment.type}: ${payment.amount.toFixed(2)}
                                       </Badge>
                                     );
                                   })}
                                 </div>
                               );
                             } else if (codDetails.status === 'cash') {
                               return (
                                 <Badge className="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 text-xs mt-1 block w-fit">
                                   Cash
                                 </Badge>
                               );
                             } else {
                               return (
                                 <Badge className={`text-xs mt-1 block w-fit ${isCurrentDate ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' : 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300'}`}>
                                   {isCurrentDate ? 'Pending Collection' : 'No Collection'}
                                 </Badge>
                               );
                             }
                           })()}
                        </div>
                       </td>
                      <td className="p-3">
                        {(() => {
                          const locationId = item.location_id;
                          const config = locationConfigs.find(c => c.square_location_id === locationId);
                          const store = stores.find(s => s.square_location_config_id === config?.id);
                          
                          return (
                            <div className="text-sm font-medium text-slate-900 dark:text-slate-50">
                              {store ? store.name : (config?.name || 'Unknown')}
                            </div>
                          );
                          })()}
                          </td>
                          {currentUser && isAppOwner(currentUser) && (
                          <td className="p-3">
                          <div className="text-xs font-mono truncate max-w-[180px] text-slate-600 dark:text-slate-400">
                            {item.location_id}
                          </div>
                          </td>
                          )}
                          <td className="p-3">
                          <div className="text-xs font-mono truncate max-w-[150px] text-slate-600 dark:text-slate-400">
                          {item.catalog_object_id}
                          </div>
                          </td>
                          <td className="p-3 text-xs text-slate-600 dark:text-slate-400">
                            {(() => {
                              const delivery = deliveries.find(d => d?.id === item.delivery_id);
                              const resolvedDate = delivery?.delivery_date || item.delivery_date || parseSquareItemName(item.name || item.item_name)?.deliveryDate;
                              if (resolvedDate) {
                                const [year, month, day] = resolvedDate.split('-');
                                const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
                                return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
                              }
                              return 'N/A';
                            })()}
                          </td>
                      <td className="p-3">
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
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          
          {/* Mobile Card View */}
          {!isLoading && filteredCatalogItems.length > 0 && (
            <div className="md:hidden space-y-3">
              {filteredCatalogItems.map((item, index) => {
                const itemDrivers = getDriversForLocation(item.location_id)
                  .sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
                const userIsAppOwner = currentUser && isAppOwner(currentUser);
                
                return (
                  <div 
                    key={`${item.catalog_object_id}-${item.location_id}-${index}`}
                    onClick={() => setSelectedCODItem(item)}
                    role="button"
                    aria-label={`Open details for ${item.name}`}
                    className="p-3 rounded-lg transition-colors bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 active:ring-1 active:ring-slate-300"
                  >
                    {/* Header: name + amount + delete */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-sm text-slate-900 dark:text-slate-50 truncate">
                          {(() => {
                            const delivery = deliveries.find(d => d?.id === item.delivery_id);
                            const patient = delivery?.patient_id ? patients.find(p => p?.id === delivery.patient_id || p?.patient_id === delivery.patient_id) : null;
                            const parsed = parseSquareItemName(item.name || item.item_name);
                            return patient?.full_name || parsed?.patientName || item.name || item.item_name || 'N/A';
                          })()}
                        </p>
                        {item.description && (
                          <p className="text-xs truncate mt-0.5 text-slate-600 dark:text-slate-400">
                            {item.description}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <div className="text-base font-bold leading-none text-emerald-600 dark:text-emerald-400">${(item.price_dollars || 0).toFixed(2)}</div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setItemToDelete(item);
                          }}
                          disabled={deletingId === item.catalog_object_id}
                          className="flex-shrink-0 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                          aria-label="Delete COD item"
                        >
                          {deletingId === item.catalog_object_id ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </Button>
                      </div>
                    </div>

                    {/* Status badges row */}
                    <div className="mt-2 flex flex-wrap gap-1">
                      {(() => {
                        const soldInSquare = hasBeenSoldInSquare(item);
                        if (soldInSquare) {
                          return (
                            <Badge className="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 text-xs">✓ Collected</Badge>
                          );
                        }
                        const codDetails = getCODPaymentDetails(item.name, item.location_id);
                        const parsed = parseSquareItemName(item.name);
                        const isCurrentDate = parsed && parsed.deliveryDate === format(new Date(), 'yyyy-MM-dd');
                        if (codDetails.status === 'collected' && codDetails.payments.length > 0) {
                          return (
                            <>
                              {codDetails.payments.map((payment, idx) => {
                                const colorClass = {
                                  'Cash': 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
                                  'Debit': 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
                                  'Credit': 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
                                  'Check': 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                                }[payment.type] || 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300';
                                return (
                                  <Badge key={idx} className={`${colorClass} text-xs`}>{payment.type}: ${payment.amount.toFixed(2)}</Badge>
                                );
                              })}
                            </>
                          );
                        }
                        if (codDetails.status === 'cash') {
                          return (<Badge className="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 text-xs">Cash</Badge>);
                        }
                        return (
                          <Badge className={`text-xs ${isCurrentDate ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' : 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300'}`}>
                            {isCurrentDate ? 'Pending Collection' : 'No Collection'}
                          </Badge>
                        );
                      })()}
                    </div>

                    {/* Meta grid: store + date */}
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-600 dark:text-slate-400">
                      <div className="truncate">
                        <span className="font-semibold text-slate-900 dark:text-slate-50">Store:</span> {(() => {
                          const locationId = item.location_id;
                          const config = locationConfigs.find(c => c.square_location_id === locationId);
                          const store = stores.find(s => s.square_location_config_id === config?.id);
                          return store ? store.name : (config?.name || 'Unknown');
                        })()}
                      </div>
                      <div className="truncate text-right">
                        <span className="font-semibold text-slate-900 dark:text-slate-50">Date:</span> {(() => {
                          const delivery = deliveries.find(d => d?.id === item.delivery_id);
                          const resolvedDate = delivery?.delivery_date || item.delivery_date || parseSquareItemName(item.name || item.item_name)?.deliveryDate;
                          if (resolvedDate) {
                            const [year, month, day] = resolvedDate.split('-');
                            const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
                            return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                          }
                          return 'N/A';
                        })()}
                      </div>
                    </div>

                    {userIsAppOwner && itemDrivers.length > 0 && (
                      <div className="flex gap-1 mt-2 flex-wrap">
                        {itemDrivers.map(driver => (
                          <Badge key={driver.id} className={`${getDriverColor(driver.id)} text-[10px] border`}>
                            {driver.user_name}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

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