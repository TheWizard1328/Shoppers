import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RefreshCw, DollarSign, CheckCircle, XCircle, Clock, CreditCard, Trash2, Loader2, CloudDownload } from "lucide-react";
import { toast } from "sonner";
import { isAppOwner } from "@/components/utils/userRoles";
import LocationSummaryCard from "@/components/square/LocationSummaryCard";
import TransactionHistoryPanel from "@/components/square/TransactionHistoryPanel";
import CODItemDetailModal from "@/components/square/CODItemDetailModal";
import { getStatusBadge, getTypeBadge, getPaymentMethodBadge } from "@/components/square/badgeHelpers";
import { format } from "date-fns";

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

  const syncFromSquare = async () => {
    setIsSyncing(true);
    setError(null);
    try {
      // Step 1: Sync from Square
      const response = await base44.functions.invoke('squareSyncCatalogItems', {});
      const data = response?.data || response;
      
      if (!data.success) {
        throw new Error(data.error || 'Sync failed');
      }
      
      let syncedItems = data.items || [];
      let deletedCount = 0;
      let createdCount = 0;
      
      // Step 2: Delete catalog items that have matching collection transactions
      for (const item of syncedItems) {
        const codDetails = getCODPaymentDetails(item.name, item.location_id);
        
        // If payment has been collected, delete from Square
        if (codDetails.status === 'collected' && codDetails.payments.length > 0) {
          try {
            await base44.functions.invoke('squareDeleteCodItem', {
              catalogObjectId: item.catalog_object_id,
              transactionId: item.transaction_id,
              reason: 'payment_collected'
            });
            deletedCount++;
          } catch (deleteErr) {
            console.warn(`Failed to delete collected item ${item.name}:`, deleteErr);
          }
        }
      }
      
      // Remove deleted items from local state
      syncedItems = syncedItems.filter(item => {
        const codDetails = getCODPaymentDetails(item.name, item.location_id);
        return !(codDetails.status === 'collected' && codDetails.payments.length > 0);
      });
      
      // Step 3: Check deliveries for missing catalog items
      const completedDeliveries = deliveries.filter(d => 
        ['completed', 'returned'].includes(d.status) && 
        d.cod_total_amount_required > 0
      );
      
      for (const delivery of completedDeliveries) {
        // Check if payment already collected
        if (delivery.cod_payments && delivery.cod_payments.length > 0) {
          continue; // Already collected, skip
        }
        
        // Build expected item name
        const deliveryDate = new Date(delivery.delivery_date);
        const month = String(deliveryDate.getMonth() + 1).padStart(2, '0');
        const day = String(deliveryDate.getDate()).padStart(2, '0');
        const store = stores.find(s => s.id === delivery.store_id);
        const storeAbbr = store?.abbreviation || '??';
        const expectedName = `${month}/${day}(${storeAbbr})-${delivery.patient_name}`;
        
        // Check if catalog item exists
        const existsInCatalog = syncedItems.some(item => item.name === expectedName);
        
        if (!existsInCatalog && store?.square_location_config_id) {
          // Find location config
          const locationConfig = locationConfigs.find(c => c.id === store.square_location_config_id);
          
          if (locationConfig) {
            try {
              const createResponse = await base44.functions.invoke('squareCreateCodItem', {
                itemName: expectedName,
                amount: delivery.cod_total_amount_required,
                locationId: locationConfig.square_location_id,
                deliveryId: delivery.id,
                storeId: delivery.store_id
              });
              
              if (createResponse?.data?.success || createResponse?.success) {
                createdCount++;
              }
            } catch (createErr) {
              console.warn(`Failed to create catalog item for ${expectedName}:`, createErr);
            }
          }
        }
      }
      
      // Final sync to get updated catalog
      const finalResponse = await base44.functions.invoke('squareSyncCatalogItems', {});
      const finalData = finalResponse?.data || finalResponse;
      
      if (finalData.success) {
        setCatalogItems(finalData.items || []);
        setLocationIds(finalData.locationIds || []);
        
        const messages = [
          `Synced ${finalData.itemCount} items`,
          deletedCount > 0 ? `deleted ${deletedCount} collected` : null,
          createdCount > 0 ? `created ${createdCount} missing` : null
        ].filter(Boolean).join(', ');
        
        toast.success(messages);
      }
    } catch (err) {
      console.error('Sync error:', err);
      setError(err.message);
      toast.error('Failed to sync: ' + err.message);
    } finally {
      setIsSyncing(false);
      setIsLoading(false);
    }
  };

  useEffect(() => {
    const loadData = async () => {
      try {
        const user = await base44.auth.me();
        setCurrentUser(user);
        
        // Calculate date range for deliveries (last 60 days)
        const today = new Date();
        const sixtyDaysAgo = new Date(today);
        sixtyDaysAgo.setDate(today.getDate() - 60);
        const dateFilter = {
          delivery_date: { 
            $gte: format(sixtyDaysAgo, 'yyyy-MM-dd'),
            $lte: format(today, 'yyyy-MM-dd')
          }
        };
        
        const [configs, storesData, appUsersData, allTransactions, deliveriesData] = await Promise.all([
          base44.entities.SquareLocationConfig.filter({ status: 'active' }),
          base44.entities.Store.list(),
          base44.entities.AppUser.list(),
          base44.entities.SquareTransaction.list(),
          base44.entities.Delivery.filter(dateFilter)
        ]);
        
        // Filter to last 7 days in JavaScript
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const recentTxs = (allTransactions || []).filter(t => {
          const txDate = new Date(t.created_date);
          return txDate >= sevenDaysAgo;
        });
        
        console.log('Recent transactions (last 7 days):', recentTxs);
        
        setLocationConfigs(configs || []);
        setStores(storesData || []);
        setRecentTransactions(recentTxs);
        setAllTransactions(allTransactions || []);
        setDeliveries(deliveriesData || []);
        
        // Filter to only active drivers
        const driversList = appUsersData.filter(u => 
          u && u.app_roles && u.app_roles.includes('driver') && u.status === 'active'
        );
        setDrivers(driversList || []);
      } catch (err) {
        console.error('Failed to load configs/stores:', err);
      }
    };
    
    loadData();
    syncFromSquare();
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

  // Check if item has a completed collection (payment actually collected)
  const hasRecentPayment = (itemName, itemAmount, locationId) => {
    const match = recentTransactions.some(t => {
      const nameMatch = t.item_name === itemName;
      const amountMatch = Math.abs(t.amount - itemAmount) < 0.01;
      // CRITICAL: Only show as paid if it's a completed COLLECTION, not prepayment or pending
      const isCompletedCollection = t.type === 'collection' && t.status === 'completed';
      
      return nameMatch && amountMatch && isCompletedCollection;
    });
    
    return match;
  };

  const handleDelete = async (item) => {
    if (!window.confirm(`Delete COD item "${item.name}"?\n\nThis will permanently remove it from Square.`)) {
      return;
    }

    setDeletingId(item.catalog_object_id);
    try {
      // Call the delete function with catalog object ID
      await base44.functions.invoke('squareDeleteCodItem', {
        catalogObjectId: item.catalog_object_id,
        transactionId: item.transaction_id,
        reason: 'manual_delete'
      });

      // Remove from local state
      setCatalogItems(prev => prev.filter(i => i.catalog_object_id !== item.catalog_object_id));

      toast.success('COD item deleted from Square');
    } catch (err) {
      console.error('Delete failed:', err);
      toast.error('Failed to delete: ' + err.message);
    } finally {
      setDeletingId(null);
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
    
    // Sort: by driver, then store, then updated time
    return items.sort((a, b) => {
      const aDrivers = getDriversForLocation(a.location_id).sort((d1, d2) => (d1.sort_order ?? Infinity) - (d2.sort_order ?? Infinity));
      const bDrivers = getDriversForLocation(b.location_id).sort((d1, d2) => (d1.sort_order ?? Infinity) - (d2.sort_order ?? Infinity));
      
      // Compare first driver
      const aFirstDriver = aDrivers[0]?.user_name || '';
      const bFirstDriver = bDrivers[0]?.user_name || '';
      if (aFirstDriver !== bFirstDriver) {
        return aFirstDriver.localeCompare(bFirstDriver);
      }
      
      // Compare store
      const aConfig = locationConfigs.find(c => c.square_location_id === a.location_id);
      const bConfig = locationConfigs.find(c => c.square_location_id === b.location_id);
      const aStore = stores.find(s => s.square_location_config_id === aConfig?.id);
      const bStore = stores.find(s => s.square_location_config_id === bConfig?.id);
      const aStoreName = aStore?.name || aConfig?.name || '';
      const bStoreName = bStore?.name || bConfig?.name || '';
      if (aStoreName !== bStoreName) {
        return aStoreName.localeCompare(bStoreName);
      }
      
      // Compare updated time (newest first)
      const aTime = new Date(a.updated_at || 0).getTime();
      const bTime = new Date(b.updated_at || 0).getTime();
      return bTime - aTime;
    });
  }, [catalogItems, currentUser, selectedDriverFilter, locationConfigs, drivers]);

  // Summary stats
  const stats = {
    total: filteredCatalogItems.length,
    totalAmount: filteredCatalogItems.reduce((sum, i) => sum + (i.price_dollars || 0), 0),
    locations: locationIds.length
  };

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto" style={{ background: 'var(--bg-white)', color: 'var(--text-slate-900)' }}>
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 md:gap-6 mb-6">
        <div className="flex items-center gap-3">
          <CreditCard className="w-6 md:w-8 h-6 md:h-8 text-emerald-600 flex-shrink-0" />
          <div className="min-w-0">
            <h1 className="text-xl md:text-2xl font-bold" style={{ color: 'var(--text-slate-900)' }}>Square COD</h1>
            <p className="text-xs md:text-sm" style={{ color: 'var(--text-slate-500)' }}>Track and manage COD payments</p>
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

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 md:gap-4 mb-6 md:mb-8">
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xs md:text-sm text-slate-500">Active COD Items</div>
            <div className="text-xl md:text-2xl font-bold">{stats.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xs md:text-sm text-slate-500">Total Amount</div>
            <div className="text-xl md:text-2xl font-bold text-emerald-600">${stats.totalAmount.toFixed(2)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xs md:text-sm text-slate-500">Square Locations</div>
            <div className="text-xl md:text-2xl font-bold text-blue-600">{stats.locations}</div>
          </CardContent>
        </Card>
      </div>

      {/* Location Summary Cards */}
      {currentUser && isAppOwner(currentUser) && locationConfigs.length > 0 && (
        <div>
          <h2 className="text-base md:text-lg font-semibold mb-4" style={{ color: 'var(--text-slate-900)' }}>By Location</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 md:gap-4 mb-6 md:mb-8">
            {locationConfigs.map(config => {
              const locationItems = filteredCatalogItems.filter(item => item.location_id === config.square_location_id);
              const codTotal = locationItems.reduce((sum, item) => sum + (item.price_dollars || 0), 0);
              return (
                <LocationSummaryCard
                  key={config.id}
                  location={config}
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
        <div className="p-3 md:p-4 rounded-lg mb-6 text-sm md:text-base" style={{ background: 'var(--bg-red-50)', color: 'var(--text-red-700)', borderColor: 'var(--border-red-200)', border: '1px solid' }}>
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
              <div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full" />
            </div>
          ) : filteredCatalogItems.length === 0 ? (
            <div className="text-center py-12" style={{ color: 'var(--text-slate-500)' }}>
               <DollarSign className="w-10 md:w-12 h-10 md:h-12 mx-auto mb-4 opacity-50" />
               <p className="text-sm md:text-base">No active COD items in Square</p>
               <p className="text-xs md:text-sm mt-1">COD items will appear here when deliveries are created with COD amounts</p>
             </div>
          ) : (
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm" style={{ color: 'var(--text-slate-500)', borderColor: 'var(--border-slate-200)' }}>
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
                  {filteredCatalogItems.map((item) => {
                    const itemDrivers = getDriversForLocation(item.location_id)
                      .sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
                    const isMultiDriver = itemDrivers.length > 1;
                    const userIsAppOwner = currentUser && isAppOwner(currentUser);
                    
                    return (
                    <tr key={item.catalog_object_id} className={`border-b cursor-pointer transition-colors ${userIsAppOwner && isMultiDriver ? 'border-l-4 border-l-amber-500' : ''}`} style={{ borderColor: 'var(--border-slate-200)', background: userIsAppOwner && isMultiDriver ? 'rgba(251, 146, 60, 0.1)' : 'transparent' }} onMouseEnter={(e) => e.currentTarget.style.background = userIsAppOwner && isMultiDriver ? 'rgba(251, 146, 60, 0.15)' : 'var(--bg-slate-50)'} onMouseLeave={(e) => e.currentTarget.style.background = userIsAppOwner && isMultiDriver ? 'rgba(251, 146, 60, 0.1)' : 'transparent'} onClick={(e) => { e.stopPropagation(); setSelectedCODItem(item); }}>
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
                          <div className="text-xs truncate max-w-[200px] mt-1" style={{ color: 'var(--text-slate-500)' }}>
                            {item.description}
                          </div>
                        )}
                      </td>
                      <td className="p-3">
                        <div>
                          <span className="font-semibold text-emerald-600 text-sm">
                            ${(item.price_dollars || 0).toFixed(2)}
                          </span>
                          {(() => {
                            const codDetails = getCODPaymentDetails(item.name, item.location_id);
                            
                            if (codDetails.status === 'collected' && codDetails.payments.length > 0) {
                              return (
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {codDetails.payments.map((payment, idx) => (
                                    <Badge key={idx} className="bg-green-100 text-green-800 text-xs">
                                      {payment.type}: ${payment.amount.toFixed(2)}
                                    </Badge>
                                  ))}
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
                            <div className="text-sm font-medium" style={{ color: 'var(--text-slate-700)' }}>
                              {store ? store.name : (config?.name || 'Unknown')}
                            </div>
                          );
                        })()}
                      </td>
                      {currentUser && isAppOwner(currentUser) && (
                        <td className="p-3">
                          <div className="text-xs font-mono truncate max-w-[180px]" style={{ color: 'var(--text-slate-500)' }}>
                            {item.location_id}
                          </div>
                        </td>
                      )}
                      <td className="p-3">
                        <div className="text-xs font-mono truncate max-w-[150px]" style={{ color: 'var(--text-slate-500)' }}>
                          {item.catalog_object_id}
                        </div>
                      </td>
                      <td className="p-3 text-xs" style={{ color: 'var(--text-slate-500)' }}>
                        {item.updated_at ? new Date(item.updated_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : 'N/A'}
                      </td>
                      <td className="p-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(item)}
                          disabled={deletingId === item.catalog_object_id}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
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
              {filteredCatalogItems.map((item) => {
                const itemDrivers = getDriversForLocation(item.location_id)
                  .sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
                const userIsAppOwner = currentUser && isAppOwner(currentUser);
                
                return (
                  <div 
                    key={item.catalog_object_id}
                    onClick={() => setSelectedCODItem(item)}
                    className="p-4 rounded-lg border cursor-pointer transition-colors active:bg-slate-100"
                    style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-slate-50)' }}
                  >
                    <div className="flex justify-between items-start gap-3 mb-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-sm" style={{ color: 'var(--text-slate-900)' }}>
                          {item.name || 'N/A'}
                        </p>
                        {item.description && (
                          <p className="text-xs truncate mt-1" style={{ color: 'var(--text-slate-500)' }}>
                            {item.description}
                          </p>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(item);
                        }}
                        disabled={deletingId === item.catalog_object_id}
                        className="text-red-600 hover:text-red-700 flex-shrink-0"
                      >
                        {deletingId === item.catalog_object_id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                    
                    <div className="mb-3">
                      <div className="text-lg font-bold text-emerald-600 mb-2">
                        ${(item.price_dollars || 0).toFixed(2)}
                      </div>
                      {(() => {
                        const codDetails = getCODPaymentDetails(item.name, item.location_id);
                        
                        if (codDetails.status === 'collected' && codDetails.payments.length > 0) {
                          return (
                            <div className="flex flex-wrap gap-1">
                              {codDetails.payments.map((payment, idx) => (
                                <Badge key={idx} className="bg-green-100 text-green-800 text-xs">
                                  {payment.type}: ${payment.amount.toFixed(2)}
                                </Badge>
                              ))}
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
                    
                    <div className="space-y-2 text-xs" style={{ color: 'var(--text-slate-500)' }}>
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
    </div>
  );
}