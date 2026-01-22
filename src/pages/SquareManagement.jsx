import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { RefreshCw, DollarSign, CheckCircle, XCircle, Clock, CreditCard, Trash2, Loader2, CloudDownload } from "lucide-react";
import { toast } from "sonner";
import { isAppOwner } from "@/components/utils/userRoles";
import LocationSummaryCard from "@/components/square/LocationSummaryCard";
import TransactionHistoryPanel from "@/components/square/TransactionHistoryPanel";
import CODItemDetailModal from "@/components/square/CODItemDetailModal";
import SyncStatusIndicator from "@/components/square/SyncStatusIndicator";
import { getStatusBadge, getTypeBadge, getPaymentMethodBadge } from "@/components/square/badgeHelpers";
import { format } from "date-fns";
import { smartRefreshManager } from "@/components/utils/smartRefreshManager";
import { saveCatalogItemsOffline, savePaymentTransactionsOffline, getCatalogItemsOffline, getPaymentTransactionsOffline, clearSquareCODOfflineData, getSquareCODSyncStatus } from "@/components/utils/squareCODOfflineManager";

export default function SquareManagement() {
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
  const [selectedDriverFilter, setSelectedDriverFilter] = useState('all');
  const [recentTransactions, setRecentTransactions] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [selectedCODItem, setSelectedCODItem] = useState(null);
  const [allTransactions, setAllTransactions] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [itemToDelete, setItemToDelete] = useState(null);
  const [soldCatalogItems, setSoldCatalogItems] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);

  const syncFromSquare = async () => {
    setIsSyncing(true);
    setError(null);
    
    // CRITICAL: Pause smart refresh during Square sync
    smartRefreshManager.pause();
    console.log('⏸️ [SquareManagement] Paused smart refresh for Square sync');
    
    try {
      // Step 0: Clear offline Square COD data to start fresh
      console.log('🗑️ Step 0: Clearing offline Square COD data...');
      await clearSquareCODOfflineData();
      console.log('✓ Offline Square COD data cleared');

      // Step 1: Get fresh catalog from Square
      console.log('📥 Step 1: Fetching fresh catalog from Square...');
      const catalogResponse = await base44.functions.invoke('squareSyncCatalogItems', {});
      const catalogData = catalogResponse?.data || catalogResponse;

      if (!catalogData.success) {
        throw new Error(catalogData.error || 'Catalog sync failed');
      }

      let catalogItems = catalogData.items || [];
      const locationIds = catalogData.locationIds || [];
      console.log(`✓ Got ${catalogItems.length} items from Square`);

      // Step 2: Update recent payment transactions
      console.log('💳 Step 2: Fetching recent payment transactions...');
      const paymentsResponse = await base44.functions.invoke('squareFetchPayments', {
        locationIds,
        daysBack: 7
      });

      const paymentsData = paymentsResponse?.data || paymentsResponse;
      const recentPayments = paymentsData?.soldCatalogItems || [];
      setSoldCatalogItems(recentPayments);
      console.log(`✓ Got ${recentPayments.length} recent payment transactions`);

      // Step 3: Delete duplicate catalog items
      console.log('🗑️ Step 3: Identifying and deleting duplicates...');
      const uniqueItems = new Map();
      const duplicates = [];

      for (const item of catalogItems) {
        const dupKey = `${item.name}|${item.location_id}`;
        if (uniqueItems.has(dupKey)) {
          duplicates.push(item);
        } else {
          uniqueItems.set(dupKey, item);
        }
      }

      let deletedCount = 0;
      for (const item of duplicates) {
        try {
          await base44.functions.invoke('squareDeleteCodItem', {
            catalogObjectId: item.catalog_object_id,
            transactionId: null,
            reason: 'duplicate'
          });
          deletedCount++;
          console.log(`✓ Deleted duplicate: ${item.name}`);
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (err) {
          console.warn(`Failed to delete duplicate ${item.name}:`, err);
        }
      }
      console.log(`✓ Deleted ${deletedCount} duplicate items`);

      // Step 4 & 5: Compare and delete collected items
      console.log('🔍 Step 4-5: Comparing catalog to payments and deleting collected items...');
      const collectedCatalogIds = new Set();
      const collectedItemKeys = new Set();

      for (const payment of recentPayments) {
        const key = `${payment.item_name}|${payment.location_id}|${payment.amount.toFixed(2)}`;
        collectedItemKeys.add(key);
        if (payment.square_catalog_object_id) {
          collectedCatalogIds.add(payment.square_catalog_object_id);
        }
      }

      const collectedItemsToDelete = [];
      for (const item of catalogItems) {
        if (duplicates.find(d => d.catalog_object_id === item.catalog_object_id)) {
          continue; // Already deleted
        }

        const itemKey = `${item.name}|${item.location_id}|${(item.price_dollars || 0).toFixed(2)}`;
        if (collectedCatalogIds.has(item.catalog_object_id) || collectedItemKeys.has(itemKey)) {
          collectedItemsToDelete.push(item);
        }
      }

      let collectedDeletedCount = 0;
      for (const item of collectedItemsToDelete) {
        try {
          const relatedPayment = recentPayments.find(p => 
            p.square_catalog_object_id === item.catalog_object_id
          );
          
          await base44.functions.invoke('squareDeleteCodItem', {
            catalogObjectId: item.catalog_object_id,
            transactionId: relatedPayment?.square_transaction_id || null,
            reason: 'collected'
          });
          collectedDeletedCount++;
          console.log(`✓ Deleted collected: ${item.name}`);
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (err) {
          console.warn(`Failed to delete collected ${item.name}:`, err);
        }
      }
      console.log(`✓ Deleted ${collectedDeletedCount} collected items`);

      // Step 6: Refresh catalog data from Square
      console.log('🔄 Step 6: Refreshing catalog from Square...');
      const finalResponse = await base44.functions.invoke('squareSyncCatalogItems', {});
      const finalData = finalResponse?.data || finalResponse;

      if (!finalData.success) {
        throw new Error('Final catalog sync failed');
      }

      // Step 7: Update UI and save to offline database
      console.log('🎨 Step 7: Updating UI and saving to offline database...');
      const finalCatalogItems = finalData.items || [];
      setCatalogItems(finalCatalogItems);
      setLocationIds(finalData.locationIds || []);

      // Save to offline database after sync
      await Promise.all([
        saveCatalogItemsOffline(finalCatalogItems),
        savePaymentTransactionsOffline(recentPayments)
      ]);

      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const filteredPayments = recentPayments
        .filter(item => new Date(item.payment_date) >= sevenDaysAgo)
        .sort((a, b) => new Date(b.payment_date) - new Date(a.payment_date));

      setRecentTransactions(filteredPayments);
      setAllTransactions(recentPayments);

      const summary = [
        `Synced ${finalData.itemCount || 0} active items`,
        deletedCount > 0 ? `removed ${deletedCount} duplicates` : null,
        collectedDeletedCount > 0 ? `removed ${collectedDeletedCount} collected` : null
      ].filter(Boolean).join(' • ');

      toast.success(summary);
      console.log('✅ Sync complete');
    } catch (err) {
      console.error('Sync error:', err);
      setError(err.message);
      toast.error('Failed to sync: ' + err.message);
    } finally {
      setIsSyncing(false);
      setIsLoading(false);
      
      // Update sync status
      const updatedSyncStatus = await getSquareCODSyncStatus();
      setSyncStatus(updatedSyncStatus);

      // CRITICAL: Resume smart refresh and restart timers
      smartRefreshManager.resume();
      smartRefreshManager.restart();
      console.log('▶️ [SquareManagement] Resumed and restarted smart refresh after Square sync');
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
        const sevenDaysAgo = new Date(today);
        sevenDaysAgo.setDate(today.getDate() - 7);
        const dateFilter = {
          delivery_date: { 
            $gte: format(sevenDaysAgo, 'yyyy-MM-dd'),
            $lte: format(today, 'yyyy-MM-dd')
          }
        };

        const [configs, storesData, appUsersData, deliveriesData] = await Promise.all([
          base44.entities.SquareLocationConfig.filter({ status: 'active' }),
          base44.entities.Store.list(),
          base44.entities.AppUser.list(),
          base44.entities.Delivery.filter(dateFilter)
        ]);

        setLocationConfigs(configs || []);
        setStores(storesData || []);
        setDeliveries(deliveriesData || []);

        const driversList = appUsersData.filter(u => 
          u && u.app_roles && u.app_roles.includes('driver') && u.status === 'active'
        );
        setDrivers(driversList || []);

        // Get location IDs first
        const configs_list = await base44.entities.SquareLocationConfig.filter({ status: 'active' });
        const syncedLocationIds = configs_list.map(c => c.square_location_id).filter(Boolean);
        setLocationIds(syncedLocationIds);

        // Fetch fresh payments + catalog in one call
        const paymentsResponse = await base44.functions.invoke('squareFetchPayments', { 
          locationIds: syncedLocationIds, 
          daysBack: 7 
        });
        const paymentsData = paymentsResponse?.data || paymentsResponse || {};

        // Use combined catalog + payment data
        const catalogItemsData = paymentsData?.catalogItems || [];
        const soldCatalogItemsData = paymentsData?.soldCatalogItems || [];

        // Clear old offline data and save fresh data
        await clearSquareCODOfflineData();
        await Promise.all([
          saveCatalogItemsOffline(catalogItemsData),
          savePaymentTransactionsOffline(soldCatalogItemsData)
        ]);

        // Update UI with fresh data
        setCatalogItems(catalogItemsData);
        setSoldCatalogItems(soldCatalogItemsData);
        setAllTransactions(soldCatalogItemsData);

        const sevenDaysAgoTx = new Date();
        sevenDaysAgoTx.setDate(sevenDaysAgoTx.getDate() - 7);
        const recentPayments = soldCatalogItemsData
          .filter(item => new Date(item.payment_date) >= sevenDaysAgoTx)
          .sort((a, b) => new Date(b.payment_date) - new Date(a.payment_date));

        setRecentTransactions(recentPayments);

        setIsLoading(false);

        // Load sync status after data is loaded
        await loadSyncStatus();
        } catch (err) {
        console.error('Failed to load COD data:', err);
        setIsLoading(false);
        }
        };

        loadData();
        }, []);



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
      // Extract date (MM/DD)
      const dateMatch = itemName.match(/^(\d{2})\/(\d{2})/);
      if (!dateMatch) return null;
      
      const month = dateMatch[1];
      const day = dateMatch[2];
      const currentYear = new Date().getFullYear();
      const deliveryDate = `${currentYear}-${month}-${day}`;
      
      // Extract store abbreviation (inside parentheses)
      const storeMatch = itemName.match(/\(([^)]+)\)/);
      const storeAbbr = storeMatch ? storeMatch[1] : null;
      
      // Extract patient name (after dash)
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
      const nameMatch = d.patient_name?.toLowerCase().trim() === patientName.toLowerCase().trim();
      const isCompleted = ['completed', 'returned'].includes(d.status);
      
      return dateMatch && storeMatch && nameMatch && isCompleted;
    });
    
    return matchingDelivery;
  };

  // Get COD payment details for a Square item
  const getCODPaymentDetails = (itemName, itemLocationId) => {
    const delivery = findMatchingDelivery(itemName, itemLocationId);
    
    if (!delivery) {
      return { status: 'pending', payments: [] };
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
    
    return { status: 'pending', payments: [] };
  };

  // Check if catalog item has been sold in Square transactions
  const hasBeenSoldInSquare = (catalogItem) => {
    return soldCatalogItems.some(payment => {
      // Match on location_id, item_name, and amount
      return payment.location_id === catalogItem.location_id &&
             payment.item_name === catalogItem.name &&
             Math.abs(payment.amount - (catalogItem.price_dollars || 0)) < 0.01; // Float comparison tolerance
    });
  };

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

    // App owners can filter by driver
    if (userIsAppOwner) {
      if (selectedDriverFilter && selectedDriverFilter !== 'all') {
        // CRITICAL: Find AppUser by ID (not user_id)
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
        items = catalogItems;
      }
    } else {
      // CRITICAL: Find driver's AppUser by platform user ID, then use their square_location_ids
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

    // Filter out sold items (only keep non-collected items)
    items = items.filter(item => !hasBeenSoldInSquare(item));

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
  }, [catalogItems, currentUser, selectedDriverFilter, locationConfigs, drivers]);

  // Summary stats
  const stats = {
    total: filteredCatalogItems.length,
    totalAmount: filteredCatalogItems.reduce((sum, i) => sum + (i.price_dollars || 0), 0),
    locations: locationIds.length
  };

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto bg-background text-foreground">
    {/* Header */}
    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 md:gap-6 mb-6">
      <div className="flex items-center gap-3">
        <CreditCard className="w-6 md:w-8 h-6 md:h-8 flex-shrink-0" style={{ color: 'var(--text-emerald-600)' }} />
        <div className="min-w-0">
          <h1 className="text-xl md:text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Square COD</h1>
          <p className="text-xs md:text-sm text-muted-foreground">Track and manage COD payments</p>
        </div>
      </div>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
          {currentUser && isAppOwner(currentUser) && drivers.length > 0 && (
            <Select value={selectedDriverFilter} onValueChange={setSelectedDriverFilter}>
              <SelectTrigger className="w-full sm:w-[150px] md:w-[200px] text-sm">
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
            <div className="mb-6 md:mb-8">
              <SyncStatusIndicator 
                syncStatus={syncStatus}
                isSyncing={isSyncing}
                error={error}
              />
            </div>
          )}

          {/* Stats Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 md:gap-4 mb-6 md:mb-8">
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xs md:text-sm" style={{ color: 'var(--text-slate-500)' }}>Active COD Items</div>
            <div className="text-xl md:text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>{stats.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xs md:text-sm" style={{ color: 'var(--text-slate-500)' }}>Total Amount</div>
            <div className="text-xl md:text-2xl font-bold" style={{ color: 'var(--text-emerald-600)' }}>${stats.totalAmount.toFixed(2)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xs md:text-sm" style={{ color: 'var(--text-slate-500)' }}>Square Locations</div>
            <div className="text-xl md:text-2xl font-bold" style={{ color: 'var(--text-blue-600)' }}>{stats.locations}</div>
          </CardContent>
        </Card>
      </div>

      {/* Location Summary Cards */}
      {currentUser && isAppOwner(currentUser) && locationConfigs.length > 0 && (
        <div>
          <h2 className="text-base md:text-lg font-semibold mb-4" style={{ color: 'var(--text-slate-900)' }}>By Location</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 md:gap-4 mb-6 md:mb-8">
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
                  <div
                    key={config.id}
                    onClick={() => setSelectedLocation(config)}
                    className="cursor-pointer transition-all"
                    className="rounded-xl p-4 border-2"
                    style={{
                      borderColor: storeColor ? storeColor.border : undefined,
                      background: storeColor ? storeColor.bg : undefined
                    }}
                    onMouseEnter={(e) => {
                      if (storeColor) e.currentTarget.style.background = storeColor.hover;
                    }}
                    onMouseLeave={(e) => {
                      if (storeColor) e.currentTarget.style.background = storeColor.bg;
                    }}
                  >
                    <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-slate-900)' }}>
                      {store ? store.name : config.name}
                    </div>
                    <div className="text-xl font-bold mb-1" style={{ color: 'var(--text-emerald-600)' }}>
                      ${codTotal.toFixed(2)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {locationItems.length} {locationItems.length === 1 ? 'item' : 'items'}
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {error && (
        <div className="p-3 md:p-4 rounded-lg mb-6 text-sm md:text-base" style={{ background: 'var(--bg-red-50)', color: 'var(--text-red-700)', border: '1px solid var(--border-red-200)' }}>
          Error: {error}
        </div>
      )}

      {/* Active Square Items */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base md:text-lg">Active COD Items</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin w-8 h-8 border-4 rounded-full" style={{ borderColor: 'var(--border-emerald-500)', borderTopColor: 'transparent' }} />
            </div>
          ) : filteredCatalogItems.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
               <DollarSign className="w-10 md:w-12 h-10 md:h-12 mx-auto mb-4 opacity-50" />
               <p className="text-sm md:text-base">No active COD items in Square</p>
               <p className="text-xs md:text-sm mt-1">COD items will appear here when deliveries are created with COD amounts</p>
             </div>
          ) : (
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm" style={{ color: 'var(--text-muted-foreground)', borderColor: 'var(--border-slate-200)' }}>
                    <th className="p-3">Item Name</th>
                    <th className="p-3">Amount</th>
                    <th className="p-3">Store</th>
                    {currentUser && isAppOwner(currentUser) && <th className="p-3">Square Location ID</th>}
                    <th className="p-3">Catalog ID</th>
                    <th className="p-3">Last Updated</th>
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
                    <tr key={`${item.catalog_object_id}-${item.location_id}-${index}`} className="cursor-pointer transition-colors" style={{ background: userIsAppOwner && hasMultipleStores && storeColor ? storeColor.bg : 'transparent', borderBottom: '1px solid var(--border-slate-200)', borderLeft: userIsAppOwner && hasMultipleStores && storeColor ? `4px solid ${storeColor.border}` : 'none' }} onMouseEnter={(e) => { if (userIsAppOwner && hasMultipleStores && storeColor) e.currentTarget.style.background = storeColor.hover; else e.currentTarget.style.background = 'var(--bg-muted-hover)'; }} onMouseLeave={(e) => { if (userIsAppOwner && hasMultipleStores && storeColor) e.currentTarget.style.background = storeColor.bg; else e.currentTarget.style.background = 'transparent'; }} onClick={(e) => { e.stopPropagation(); setSelectedCODItem(item); }}>
                      <td className="p-3">
                         <div className="font-medium text-sm" style={{ color: 'var(--text-slate-900)' }}>{item.name || 'N/A'}</div>
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
                          <span className="font-semibold text-sm" style={{ color: 'var(--text-emerald-600)' }}>
                            ${(item.price_dollars || 0).toFixed(2)}
                          </span>
                          {(() => {
                            // Check if this item has been sold in Square transactions
                            const soldInSquare = hasBeenSoldInSquare(item);
                            
                            if (soldInSquare) {
                              return (
                                <Badge className="bg-green-100 text-green-800 text-xs mt-1 block w-fit">
                                  ✓ Collected
                                </Badge>
                              );
                            }
                            
                            const codDetails = getCODPaymentDetails(item.name, item.location_id);
                            
                            if (codDetails.status === 'collected' && codDetails.payments.length > 0) {
                              return (
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {codDetails.payments.map((payment, idx) => {
                                    const colorClass = {
                                      'Cash': 'bg-green-100 text-green-800',
                                      'Debit': 'bg-blue-100 text-blue-800',
                                      'Credit': 'bg-purple-100 text-purple-800',
                                      'Check': 'bg-amber-100 text-amber-800'
                                    }[payment.type] || 'bg-gray-100 text-gray-800';
                                    
                                    return (
                                      <Badge key={idx} className={`${colorClass} text-xs`}>
                                        {payment.type}: ${payment.amount.toFixed(2)}
                                      </Badge>
                                    );
                                  })}
                                </div>
                              );
                            } else {
                              return (
                                <Badge className="bg-amber-100 text-amber-800 text-xs mt-1 block w-fit">
                                  Pending Collection
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
                            <div className="text-sm font-medium" style={{ color: 'var(--text-slate-900)' }}>
                              {store ? store.name : (config?.name || 'Unknown')}
                            </div>
                          );
                          })()}
                          </td>
                          {currentUser && isAppOwner(currentUser) && (
                          <td className="p-3">
                          <div className="text-xs font-mono truncate max-w-[180px]" style={{ color: 'var(--text-muted-foreground)' }}>
                            {item.location_id}
                          </div>
                          </td>
                          )}
                          <td className="p-3">
                          <div className="text-xs font-mono truncate max-w-[150px]" style={{ color: 'var(--text-muted-foreground)' }}>
                          {item.catalog_object_id}
                          </div>
                          </td>
                          <td className="p-3 text-xs" style={{ color: 'var(--text-muted-foreground)' }}>
                        {item.updated_at ? new Date(item.updated_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : 'N/A'}
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
                          style={{ color: 'var(--text-red-600)' }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-red-700)'; e.currentTarget.style.background = 'var(--bg-red-50)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-red-600)'; e.currentTarget.style.background = 'transparent'; }}
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
                    className="p-4 rounded-lg cursor-pointer transition-colors"
                    style={{ background: 'var(--bg-muted-30)', border: '1px solid var(--border-slate-200)' }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-muted-50)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'var(--bg-muted-30)'}
                  >
                    <div className="flex justify-between items-start gap-3 mb-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-sm" style={{ color: 'var(--text-slate-900)' }}>
                          {item.name || 'N/A'}
                        </p>
                        {item.description && (
                          <p className="text-xs truncate mt-1 text-muted-foreground">
                            {item.description}
                          </p>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setItemToDelete(item);
                        }}
                        disabled={deletingId === item.catalog_object_id}
                        className="flex-shrink-0"
                        style={{ color: 'var(--text-red-600)' }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-red-700)'; e.currentTarget.style.background = 'var(--bg-red-50)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-red-600)'; e.currentTarget.style.background = 'transparent'; }}
                      >
                        {deletingId === item.catalog_object_id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </Button>
                    </div>

                    <div className="mb-3">
                      <div className="text-lg font-bold mb-2" style={{ color: 'var(--text-emerald-600)' }}>
                        ${(item.price_dollars || 0).toFixed(2)}
                      </div>
                      {(() => {
                        // Check if this item has been sold in Square transactions
                        const soldInSquare = hasBeenSoldInSquare(item);
                        
                        if (soldInSquare) {
                          return (
                            <Badge className="bg-green-100 text-green-800 text-xs">
                              ✓ Collected
                            </Badge>
                          );
                        }
                        
                        const codDetails = getCODPaymentDetails(item.name, item.location_id);
                        
                        if (codDetails.status === 'collected' && codDetails.payments.length > 0) {
                          return (
                            <div className="flex flex-wrap gap-1">
                              {codDetails.payments.map((payment, idx) => {
                                const colorClass = {
                                  'Cash': 'bg-green-100 text-green-800',
                                  'Debit': 'bg-blue-100 text-blue-800',
                                  'Credit': 'bg-purple-100 text-purple-800',
                                  'Check': 'bg-amber-100 text-amber-800'
                                }[payment.type] || 'bg-gray-100 text-gray-800';
                                
                                return (
                                  <Badge key={idx} className={`${colorClass} text-xs`}>
                                    {payment.type}: ${payment.amount.toFixed(2)}
                                  </Badge>
                                );
                              })}
                            </div>
                          );
                        } else {
                          return (
                            <Badge className="bg-amber-100 text-amber-800 text-xs">
                              Pending Collection
                            </Badge>
                          );
                        }
                      })()}
                    </div>

                    <div className="space-y-2 text-xs" style={{ color: 'var(--text-muted-foreground)' }}>
                      <div>
                        <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Store:</span> {(() => {
                          const locationId = item.location_id;
                          const config = locationConfigs.find(c => c.square_location_id === locationId);
                          const store = stores.find(s => s.square_location_config_id === config?.id);
                          return store ? store.name : (config?.name || 'Unknown');
                        })()}
                      </div>
                      <div>
                        <span className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Updated:</span> {item.updated_at ? new Date(item.updated_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : 'N/A'}
                      </div>
                      </div>
                    
                    {userIsAppOwner && itemDrivers.length > 0 && (
                      <div className="flex gap-1 mt-3 flex-wrap">
                        {itemDrivers.map(driver => (
                          <Badge key={driver.id} className={`${getDriverColor(driver.id)} text-xs border`}>
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