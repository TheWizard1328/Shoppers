import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw, DollarSign, CheckCircle, XCircle, Clock, CreditCard, Trash2, Loader2, CloudDownload } from "lucide-react";
import { toast } from "sonner";

export default function SquareManagement() {
  const [catalogItems, setCatalogItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [locationIds, setLocationIds] = useState([]);
  const [locationConfigs, setLocationConfigs] = useState([]);
  const [stores, setStores] = useState([]);

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
        const [configs, storesData] = await Promise.all([
          base44.entities.SquareLocationConfig.filter({ status: 'active' }),
          base44.entities.Store.list()
        ]);
        setLocationConfigs(configs || []);
        setStores(storesData || []);
      } catch (err) {
        console.error('Failed to load configs/stores:', err);
      }
    };
    
    loadData();
    syncFromSquare();
  }, []);

  const getStatusBadge = (status) => {
    const config = {
      pending: { color: 'bg-amber-100 text-amber-800', icon: Clock },
      completed: { color: 'bg-green-100 text-green-800', icon: CheckCircle },
      failed: { color: 'bg-red-100 text-red-800', icon: XCircle },
      cancelled: { color: 'bg-slate-100 text-slate-800', icon: XCircle },
      refunded: { color: 'bg-purple-100 text-purple-800', icon: RefreshCw }
    };
    const cfg = config[status] || config.pending;
    const Icon = cfg.icon;
    return (
      <Badge className={`${cfg.color} gap-1`}>
        <Icon className="w-3 h-3" />
        {status}
      </Badge>
    );
  };

  const getTypeBadge = (type) => {
    const config = {
      prepayment: 'bg-blue-100 text-blue-800',
      collection: 'bg-emerald-100 text-emerald-800',
      refund: 'bg-purple-100 text-purple-800'
    };
    return <Badge className={config[type] || 'bg-slate-100'}>{type}</Badge>;
  };

  const getPaymentMethodBadge = (method) => {
    if (!method) return null;
    const config = {
      cash: 'bg-green-100 text-green-800',
      debit: 'bg-blue-100 text-blue-800',
      credit: 'bg-purple-100 text-purple-800',
      check: 'bg-amber-100 text-amber-800'
    };
    return <Badge className={config[method] || 'bg-slate-100'}>{method}</Badge>;
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

  // Summary stats
  const stats = {
    total: catalogItems.length,
    totalAmount: catalogItems.reduce((sum, i) => sum + (i.price_dollars || 0), 0),
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
        <Button onClick={syncFromSquare} disabled={isLoading || isSyncing} className="gap-2">
          <CloudDownload className={`w-4 h-4 ${isSyncing ? 'animate-pulse' : ''}`} />
          {isSyncing ? 'Syncing...' : 'Sync from Square'}
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
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
          ) : catalogItems.length === 0 ? (
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
                    <th className="p-3">Location / Store</th>
                    <th className="p-3">Catalog ID</th>
                    <th className="p-3">Last Updated</th>
                    <th className="p-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {catalogItems.map((item) => (
                    <tr key={item.catalog_object_id} className="border-b hover:bg-slate-50">
                      <td className="p-3">
                        <div className="font-medium">{item.name || 'N/A'}</div>
                        {item.description && (
                          <div className="text-xs text-slate-400 truncate max-w-[200px]">
                            {item.description}
                          </div>
                        )}
                      </td>
                      <td className="p-3">
                        <span className="font-semibold text-emerald-600">
                          ${(item.price_dollars || 0).toFixed(2)}
                        </span>
                      </td>
                      <td className="p-3">
                        {(() => {
                          const locationId = item.location_id;
                          const config = locationConfigs.find(c => c.square_location_id === locationId);
                          const store = stores.find(s => s.square_location_config_id === config?.id);
                          
                          return (
                            <div className="space-y-1">
                              <div className="text-sm font-medium text-slate-700">
                                {config?.name || 'Unknown Location'}
                              </div>
                              {store && (
                                <div className="text-xs text-slate-500">
                                  {store.name}
                                </div>
                              )}
                              <div className="text-xs text-slate-400 font-mono truncate max-w-[180px]">
                                {locationId}
                              </div>
                            </div>
                          );
                        })()}
                      </td>
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
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}