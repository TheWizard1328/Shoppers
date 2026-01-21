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

  // Get catalog items for this location by matching Square catalog object IDs
  const locationCatalogIds = useMemo(() => {
    // catalogItems have location_id matching the Square location ID
    return catalogItems
      .filter(item => item.location_id === location.square_location_id)
      .map(item => item.catalog_object_id);
  }, [catalogItems, location.square_location_id]);

  // Filter transactions by location (via catalog items)
  const baseFilteredTransactions = useMemo(() => {
    console.log('[TransactionHistoryPanel] locationCatalogIds:', locationCatalogIds);
    console.log('[TransactionHistoryPanel] transactions:', transactions);
    let filtered = transactions.filter(t => {
      const matches = locationCatalogIds.includes(t.square_catalog_object_id);
      if (!matches) {
        console.log('[TransactionHistoryPanel] Transaction filtered out:', t.item_name, t.square_catalog_object_id);
      }
      return matches;
    });

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

  // Transactions section - only collections
  const collectionTransactions = useMemo(() => {
    return baseFilteredTransactions.filter(t => t.type === 'collection');
  }, [baseFilteredTransactions]);

  // Activity section - all types
  const allActivityTransactions = useMemo(() => {
    return baseFilteredTransactions;
  }, [baseFilteredTransactions]);

  // Audit reconciliation
  const auditStats = useMemo(() => {
    const allTx = allActivityTransactions;
    const payments = allTx.filter(t => t.type === 'prepayment').reduce((sum, t) => sum + (t.amount || 0), 0);
    const collections = allTx.filter(t => t.type === 'collection').reduce((sum, t) => sum + (t.amount || 0), 0);
    const refunds = allTx.filter(t => t.type === 'refund').reduce((sum, t) => sum + (t.amount || 0), 0);
    
    return {
      payments,
      collections,
      refunds,
      isBalanced: Math.abs(payments - collections - refunds) < 0.01
    };
  }, [allActivityTransactions]);

  // Reconciliation issues
  const reconciliationIssues = useMemo(() => {
    const issues = [];
    if (auditStats.payments > 0 && auditStats.collections === 0 && auditStats.refunds === 0) {
      issues.push('Payments collected but no sales recorded');
    }
    if (auditStats.collections > 0 && auditStats.refunds > 0 && auditStats.payments === 0) {
      issues.push('Sales and refunds but no payment spends recorded');
    }
    return issues;
  }, [auditStats]);

  const collectionAmount = useMemo(() => {
    return collectionTransactions.reduce((sum, t) => sum + (t.amount || 0), 0);
  }, [collectionTransactions]);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-start justify-end">
      <div className="bg-white w-full max-w-2xl h-full overflow-y-auto shadow-lg">
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

        {/* Transactions Section (Collections) */}
        <div className="border-b">
          <div className="bg-emerald-50 border-b p-6">
            <h3 className="text-lg font-semibold text-slate-900 mb-4">Transactions (Collections)</h3>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600">Total Collected</p>
                <p className="text-2xl font-bold text-emerald-600">${collectionAmount.toFixed(2)}</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-slate-600">Collections</p>
                <p className="text-2xl font-bold text-slate-900">{collectionTransactions.length}</p>
              </div>
            </div>
          </div>

          <div className="p-6 space-y-4">
            {collectionTransactions.length === 0 ? (
              <div className="text-center py-12 text-slate-500">
                <DollarSign className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No collections recorded</p>
              </div>
            ) : (
              collectionTransactions.map(t => (
                <Card key={t.id} className="hover:shadow-md transition-shadow">
                  <CardContent className="p-4">
                    <div className="grid grid-cols-2 gap-4 mb-3">
                      <div>
                        <p className="text-sm text-slate-500">Item</p>
                        <p className="font-semibold text-slate-900">{t.item_name || 'N/A'}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-slate-500">Amount</p>
                        <p className="font-bold text-emerald-600">${(t.amount || 0).toFixed(2)}</p>
                      </div>
                    </div>

                    <div className="flex gap-2 mb-3">
                      {getStatusBadge(t.status)}
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

        {/* Activity Section (All Transactions) */}
        <div>
          <div className="bg-slate-50 border-b p-6">
            <h3 className="text-lg font-semibold text-slate-900 mb-4">Activity & Reconciliation</h3>
            
            {/* Reconciliation Summary */}
            <div className="grid grid-cols-3 gap-3 mb-4">
              <Card className="bg-white">
                <CardContent className="p-3">
                  <p className="text-xs text-slate-500">Payments</p>
                  <p className="text-xl font-bold text-blue-600">${auditStats.payments.toFixed(2)}</p>
                </CardContent>
              </Card>
              <Card className="bg-white">
                <CardContent className="p-3">
                  <p className="text-xs text-slate-500">Collections</p>
                  <p className="text-xl font-bold text-emerald-600">${auditStats.collections.toFixed(2)}</p>
                </CardContent>
              </Card>
              <Card className="bg-white">
                <CardContent className="p-3">
                  <p className="text-xs text-slate-500">Refunds</p>
                  <p className="text-xl font-bold text-red-600">${auditStats.refunds.toFixed(2)}</p>
                </CardContent>
              </Card>
            </div>

            {/* Issues Indicator */}
            {reconciliationIssues.length > 0 && (
              <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 mb-4">
                <div className="flex gap-2 items-start">
                  <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-amber-900 text-sm">Reconciliation Alert</p>
                    {reconciliationIssues.map((issue, i) => (
                      <p key={i} className="text-xs text-amber-800">{issue}</p>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="p-6 space-y-4">
            {allActivityTransactions.length === 0 ? (
              <div className="text-center py-12 text-slate-500">
                <Calendar className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No activity found</p>
              </div>
            ) : (
              allActivityTransactions.map(t => (
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