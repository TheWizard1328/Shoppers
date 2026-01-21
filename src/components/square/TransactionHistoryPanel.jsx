import React, { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { X, Calendar } from 'lucide-react';
import { getStatusBadge, getTypeBadge, getPaymentMethodBadge } from './badgeHelpers';

export default function TransactionHistoryPanel({ location, transactions = [], drivers = [], onClose }) {
  const [dateRangeStart, setDateRangeStart] = useState('');
  const [dateRangeEnd, setDateRangeEnd] = useState('');
  const [selectedDriver, setSelectedDriver] = useState('all');
  const [transactionType, setTransactionType] = useState('all');

  const filteredTransactions = useMemo(() => {
    // Note: Transactions don't have a location field directly - they relate through catalog items
    // For now, show all transactions (filtering by location would require catalog item mapping)
    let filtered = transactions;

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

    // Type filter
    if (transactionType !== 'all') {
      filtered = filtered.filter(t => t.type === transactionType);
    }

    return filtered.sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
  }, [transactions, location.square_location_id, dateRangeStart, dateRangeEnd, selectedDriver, transactionType]);

  const totalAmount = useMemo(() => {
    return filteredTransactions.reduce((sum, t) => {
      if (t.type === 'refund') return sum - (t.amount || 0);
      return sum + (t.amount || 0);
    }, 0);
  }, [filteredTransactions]);

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
        <div className="border-b p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
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
          </div>

          <div className="grid grid-cols-2 gap-4">
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
            <div>
              <label className="text-sm font-medium text-slate-700 mb-1 block">Type</label>
              <Select value={transactionType} onValueChange={setTransactionType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="prepayment">Prepayment</SelectItem>
                  <SelectItem value="collection">Collection</SelectItem>
                  <SelectItem value="refund">Refund</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Summary */}
        <div className="bg-emerald-50 border-b p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-600">Total Amount</p>
              <p className="text-2xl font-bold text-emerald-600">${totalAmount.toFixed(2)}</p>
            </div>
            <div className="text-right">
              <p className="text-sm text-slate-600">Transactions</p>
              <p className="text-2xl font-bold text-slate-900">{filteredTransactions.length}</p>
            </div>
          </div>
        </div>

        {/* Transaction List */}
        <div className="p-6 space-y-4">
          {filteredTransactions.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              <Calendar className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No transactions found</p>
            </div>
          ) : (
            filteredTransactions.map(t => (
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

                  <div className="grid grid-cols-3 gap-2 mb-3">
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
  );
}