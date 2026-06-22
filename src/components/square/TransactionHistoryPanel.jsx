import React, { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { X, Calendar, AlertCircle, DollarSign } from 'lucide-react';
import { getStatusBadge, getTypeBadge, getPaymentMethodBadge } from './badgeHelpers';

export default function TransactionHistoryPanel({ location, transactions = [], drivers = [], catalogItems = [], onClose }) {
  // Default to current month
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const defaultStart = monthStart.toISOString().split('T')[0];
  const defaultEnd = monthEnd.toISOString().split('T')[0];

  const [dateRangeStart, setDateRangeStart] = useState(defaultStart);
  const [dateRangeEnd, setDateRangeEnd] = useState(defaultEnd);
  const [selectedDriver, setSelectedDriver] = useState('all');

  // Get uncollected catalog items for this location
  const uncollectedCatalogItems = useMemo(() => {
    const locationItems = catalogItems.filter(item => item.location_id === location.square_location_id);
    
    // Filter out items that have a completed collection transaction
    return locationItems.filter(item => {
      const hasCollection = transactions.some(t => 
        t.square_catalog_object_id === item.catalog_object_id &&
        t.type === 'collection' &&
        t.status === 'completed'
      );
      return !hasCollection;
    });
  }, [catalogItems, location.square_location_id, transactions]);

  // Find stores that use this location config
  const locationStoreIds = useMemo(() => {
    // Need to get stores from parent component - for now, filter by catalog items
    return catalogItems
      .filter(item => item.location_id === location.square_location_id)
      .map(item => item.store_id)
      .filter((id, index, self) => id && self.indexOf(id) === index); // unique store IDs
  }, [catalogItems, location.square_location_id]);

  // Get catalog object IDs for this location
  const locationCatalogIds = useMemo(() => {
    return catalogItems
      .filter(item => item.location_id === location.square_location_id)
      .map(item => item.catalog_object_id);
  }, [catalogItems, location.square_location_id]);

  // Filter transactions by location (by catalog object ID OR store ID)
  const baseFilteredTransactions = useMemo(() => {
    let filtered = transactions.filter(t => 
      locationCatalogIds.includes(t.square_catalog_object_id) ||
      (t.store_id && locationStoreIds.includes(t.store_id))
    );

    // Date range filter
    if (dateRangeStart) {
      const startDate = new Date(dateRangeStart);
      filtered = filtered.filter(t => new Date(t.created_date) >= startDate);
    }
    if (dateRangeEnd) {
      const endDate = new Date(dateRangeEnd);
      endDate.setHours(23, 59, 59, 999);
      filtered = filtered.filter(t => new Date(t.created_date) <= endDate);
    }

    // Driver filter
    if (selectedDriver !== 'all') {
      filtered = filtered.filter(t => t.driver_id === selectedDriver);
    }

    return filtered.sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
  }, [transactions, locationCatalogIds, dateRangeStart, dateRangeEnd, selectedDriver]);

  // Activity transactions - card spends, refunds, and driver collections/refunds
  const activityTransactions = useMemo(() => {
    return baseFilteredTransactions;
  }, [baseFilteredTransactions]);

  const uncollectedTotal = useMemo(() => {
    return uncollectedCatalogItems.reduce((sum, item) => sum + (item.price_dollars || 0), 0);
  }, [uncollectedCatalogItems]);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-start justify-end">
      <div className="bg-white w-full max-w-3xl h-full overflow-y-auto shadow-lg">
        <div className="sticky top-0 bg-white border-b p-6 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">{location.name}</h2>
            <p className="text-sm text-slate-500">Transaction History</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Filters */}
        <div className="border-b p-6">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="text-sm font-medium text-slate-700 mb-1 block">Start Date</label>
              <Input
                type="date"
                value={dateRangeStart}
                onChange={(e) => setDateRangeStart(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700 mb-1 block">End Date</label>
              <Input
                type="date"
                value={dateRangeEnd}
                onChange={(e) => setDateRangeEnd(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700 mb-1 block">Driver</label>
              <Select value={selectedDriver} onValueChange={setSelectedDriver}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Drivers</SelectItem>
                  {drivers.map(d => (
                    <SelectItem key={d.id} value={d.id}>{d.user_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Uncollected Items Section */}
        <div className="border-b">
          <div className="bg-amber-50 border-b p-6">
            <h3 className="text-lg font-semibold text-slate-900 mb-4">Uncollected Items</h3>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600">Pending Collection</p>
                <p className="text-2xl font-bold text-amber-600">${uncollectedTotal.toFixed(2)}</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-slate-600">Items</p>
                <p className="text-2xl font-bold text-slate-900">{uncollectedCatalogItems.length}</p>
              </div>
            </div>
          </div>

          <div className="p-6 space-y-4">
            {uncollectedCatalogItems.length === 0 ? (
              <div className="text-center py-12 text-slate-500">
                <DollarSign className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>All items collected</p>
              </div>
            ) : (
              uncollectedCatalogItems.map(item => (
                <Card key={item.catalog_object_id} className="hover:shadow-md transition-shadow">
                  <CardContent className="p-4">
                    <div className="grid grid-cols-2 gap-4 mb-3">
                      <div>
                        <p className="text-sm text-slate-500">Item</p>
                        <p className="font-semibold text-slate-900">{item.name || 'N/A'}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-slate-500">Amount</p>
                        <p className="font-bold text-amber-600">${(item.price_dollars || 0).toFixed(2)}</p>
                      </div>
                    </div>

                    <div className="flex gap-2 mb-3">
                      <Badge className="bg-amber-100 text-amber-800">Pending Collection</Badge>
                    </div>

                    <div className="text-xs text-slate-500">
                      <p className="font-medium text-slate-600 mb-1">Last Updated</p>
                      {item.updated_at ? new Date(item.updated_at).toLocaleString() : 'N/A'}
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </div>

        {/* Activity Section (Card Spends/Refunds, Driver Collections/Refunds) */}
        <div>
          <div className="bg-slate-50 border-b p-6">
            <h3 className="text-lg font-semibold text-slate-900 mb-4">Card Activity</h3>
            <p className="text-sm text-slate-600 mb-4">Card spends, refunds, and driver collections</p>
          </div>

          <div className="p-6 space-y-4">
            {activityTransactions.length === 0 ? (
              <div className="text-center py-12 text-slate-500">
                <Calendar className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No activity found</p>
              </div>
            ) : (
              activityTransactions.map(t => (
                <Card key={t.id} className="hover:shadow-md transition-shadow">
                  <CardContent className="p-4">
                    <div className="grid grid-cols-2 gap-4 mb-3">
                      <div>
                        <p className="text-sm text-slate-500">Item</p>
                        <p className="font-semibold text-slate-900">{t.item_name || 'N/A'}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-slate-500">Amount</p>
                        <p className="font-bold">${(t.amount || 0).toFixed(2)}</p>
                      </div>
                    </div>

                    <div className="flex gap-2 flex-wrap mb-3">
                      {getStatusBadge(t.status)}
                      {getTypeBadge(t.type)}
                      {t.payment_method && getPaymentMethodBadge(t.payment_method)}
                    </div>

                    <div className="grid grid-cols-2 gap-4 text-xs text-slate-500">
                      <div>
                        <p className="font-medium text-slate-600 mb-1">Date</p>
                        {new Date(t.created_date).toLocaleString()}
                      </div>
                      <div>
                        <p className="font-medium text-slate-600 mb-1">Driver</p>
                        {t.driver_id ? drivers.find(d => d.id === t.driver_id)?.user_name || 'Unknown' : 'N/A'}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}