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

  const syncFromSquare = async () => {
    setIsSyncing(true);
    setError(null);
    try {
      const response = await base44.functions.invoke('squareSyncCatalogItems', {});
      const data = response?.data || response;
      
      if (data.success) {
        setCatalogItems(data.items || []);
        setLocationIds(data.locationIds || []);
        toast.success(`Synced ${data.itemCount} items from Square`);
      } else {
        throw new Error(data.error || 'Sync failed');
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
        
        const [configs, storesData, appUsersData, allTransactions] = await Promise.all([
          base44.entities.SquareLocationConfig.filter({ status: 'active' }),
          base44.entities.Store.list(),
          base44.entities.AppUser.list(),
          base44.entities.SquareTransaction.list()
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

  // Check if item has a recent payment (last 7 days)
  const hasRecentPayment = (itemName, itemAmount, locationId) => {
    console.log('Checking payment for:', { itemName, itemAmount, locationId });
    console.log('Recent transactions:', recentTransactions);
    
    const match = recentTransactions.some(t => {
      const nameMatch = t.item_name === itemName;
      const amountMatch = Math.abs(t.amount - itemAmount) < 0.01;
      
      console.log('Transaction:', t.item_name, t.amount, 'Match:', nameMatch && amountMatch);
      
      return nameMatch && amountMatch;
    });
    
    console.log('Final match result:', match);
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
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <CreditCard className="w-8 h-8 text-emerald-600" />
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Square COD Management</h1>
            <p className="text-sm text-slate-500">Track and manage COD payments via Square</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {currentUser && isAppOwner(currentUser) && drivers.length > 0 && (
            <Select value={selectedDriverFilter} onValueChange={setSelectedDriverFilter}>
              <SelectTrigger className="w-[200px]">
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
          <Button onClick={syncFromSquare} disabled={isLoading || isSyncing} className="gap-2">
            <CloudDownload className={`w-4 h-4 ${isSyncing ? 'animate-pulse' : ''}`} />
            {isSyncing ? 'Syncing...' : 'Sync from Square'}
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
        <Card>
          <CardContent className="p-4">
            <div className="text-sm text-slate-500">Active COD Items</div>
            <div className="text-2xl font-bold">{stats.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-sm text-slate-500">Total Amount</div>
            <div className="text-2xl font-bold text-emerald-600">${stats.totalAmount.toFixed(2)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-sm text-slate-500">Square Locations</div>
            <div className="text-2xl font-bold text-blue-600">{stats.locations}</div>
          </CardContent>
        </Card>
      </div>

      {/* Location Summary Cards */}
      {currentUser && isAppOwner(currentUser) && locationConfigs.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-slate-900 mb-4">By Location</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
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
        <div className="p-4 bg-red-100 text-red-700 rounded-lg mb-6">
          Error: {error}
        </div>
      )}

      {/* Active Square Items */}
      <Card>
        <CardHeader>
          <CardTitle>Active Square COD Items</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full" />
            </div>
          ) : filteredCatalogItems.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <DollarSign className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No active COD items in Square</p>
              <p className="text-sm">COD items will appear here when deliveries are created with COD amounts</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-slate-500">
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
                    <tr key={item.catalog_object_id} className={`border-b hover:bg-slate-50 cursor-pointer ${userIsAppOwner && isMultiDriver ? 'bg-amber-100 border-l-4 border-l-amber-500' : ''}`} onClick={() => setSelectedCODItem(item)}>
                      <td className="p-3">
                        <div className="font-medium">{item.name || 'N/A'}</div>
                        {userIsAppOwner && itemDrivers.length > 0 && (
                          <div className="flex gap-1 mt-1.5">
                            {itemDrivers.map(driver => (
                              <Badge key={driver.id} className={`${getDriverColor(driver.id)} text-xs border`}>
                                {driver.user_name}
                              </Badge>
                            ))}
                          </div>
                        )}
                        {item.description && (
                          <div className="text-xs text-slate-400 truncate max-w-[200px] mt-1">
                            {item.description}
                          </div>
                        )}
                      </td>
                      <td className="p-3">
                        <div>
                          <span className="font-semibold text-emerald-600">
                            ${(item.price_dollars || 0).toFixed(2)}
                          </span>
                          {hasRecentPayment(item.name, item.price_dollars, item.location_id) && (
                            <Badge className="bg-green-100 text-green-800 text-xs mt-1 block w-fit">
                              *Paid*
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="p-3">
                        {(() => {
                          const locationId = item.location_id;
                          const config = locationConfigs.find(c => c.square_location_id === locationId);
                          const store = stores.find(s => s.square_location_config_id === config?.id);
                          
                          return (
                            <div className="text-sm font-medium text-slate-700">
                              {store ? store.name : (config?.name || 'Unknown')}
                            </div>
                          );
                        })()}
                      </td>
                      {currentUser && isAppOwner(currentUser) && (
                        <td className="p-3">
                          <div className="text-xs text-slate-400 font-mono truncate max-w-[180px]">
                            {item.location_id}
                          </div>
                        </td>
                      )}
                      <td className="p-3">
                        <div className="text-xs text-slate-500 font-mono truncate max-w-[150px]">
                          {item.catalog_object_id}
                        </div>
                      </td>
                      <td className="p-3 text-sm text-slate-500">
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
        </CardContent>
      </Card>

      {/* Transaction History Panel */}
      {selectedLocation && (
        <TransactionHistoryPanel
          location={selectedLocation}
          transactions={allTransactions}
          drivers={drivers}
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