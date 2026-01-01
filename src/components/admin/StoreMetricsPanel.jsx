import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BarChart3, DollarSign, Store, Package, RefreshCw, Loader2, Download, Calendar } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export default function StoreMetricsPanel() {
  const [metrics, setMetrics] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear().toString());
  const [selectedMonth, setSelectedMonth] = useState((new Date().getMonth() + 1).toString());
  const [availableYears] = useState(() => {
    const currentYear = new Date().getFullYear();
    return [currentYear, currentYear - 1, currentYear - 2];
  });

  const loadMetrics = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await base44.functions.invoke('getStoreMetrics', {
        year: parseInt(selectedYear),
        month: parseInt(selectedMonth)
      });
      
      const data = response?.data || response;
      setMetrics(data);
    } catch (error) {
      console.error('Failed to load store metrics:', error);
      setMetrics(null);
    } finally {
      setIsLoading(false);
    }
  }, [selectedYear, selectedMonth]);

  useEffect(() => {
    loadMetrics();
  }, [loadMetrics]);

  const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount || 0);
  };

  const exportToCSV = () => {
    if (!metrics?.stores) return;

    const headers = [
      'Store Name',
      'Abbreviation',
      'Pays App Fees',
      'Fee Period Start',
      'Fee Period End',
      'Total Deliveries',
      'Billable Deliveries',
      'Billable While Paying',
      'Fee Rate',
      'Total Fees Owed'
    ];

    const rows = metrics.stores.map(store => [
      store.store_name,
      store.store_abbreviation || '',
      store.pays_app_fees ? 'Yes' : 'No',
      store.current_fee_period?.start || '',
      store.current_fee_period?.end || 'Present',
      store.total_deliveries,
      store.billable_deliveries,
      store.billable_while_paying,
      store.app_fee_rate.toFixed(2),
      store.total_fees_owed.toFixed(2)
    ]);

    // Add totals row
    rows.push([
      'TOTALS',
      '',
      `${metrics.totals.stores_paying_fees} stores`,
      '',
      '',
      '',
      metrics.totals.total_billable_deliveries,
      metrics.totals.total_billable_while_paying,
      metrics.totals.app_fee_rate.toFixed(2),
      metrics.totals.total_fees_owed.toFixed(2)
    ]);

    const csvContent = [
      `Store Metrics Report - ${MONTH_NAMES[parseInt(selectedMonth) - 1]} ${selectedYear}`,
      '',
      headers.join(','),
      ...rows.map(row => row.join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `store_metrics_${selectedYear}_${selectedMonth}.csv`;
    link.click();
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-emerald-500 mr-2" />
          <span className="text-slate-600">Loading store metrics...</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-blue-100 rounded-lg">
                <Store className="w-6 h-6 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-slate-500">Stores Paying Fees</p>
                <p className="text-2xl font-bold text-slate-900">
                  {metrics?.totals?.stores_paying_fees || 0} / {metrics?.totals?.total_stores || 0}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-emerald-100 rounded-lg">
                <Package className="w-6 h-6 text-emerald-600" />
              </div>
              <div>
                <p className="text-sm text-slate-500">Billable Deliveries</p>
                <p className="text-2xl font-bold text-slate-900">
                  {metrics?.totals?.total_billable_while_paying || 0}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-amber-100 rounded-lg">
                <DollarSign className="w-6 h-6 text-amber-600" />
              </div>
              <div>
                <p className="text-sm text-slate-500">Fee Rate</p>
                <p className="text-2xl font-bold text-slate-900">
                  {formatCurrency(metrics?.totals?.app_fee_rate || 0)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-emerald-50 border-emerald-200">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-emerald-500 rounded-lg">
                <DollarSign className="w-6 h-6 text-white" />
              </div>
              <div>
                <p className="text-sm text-emerald-700">Total Fees Owed</p>
                <p className="text-2xl font-bold text-emerald-900">
                  {formatCurrency(metrics?.totals?.total_fees_owed || 0)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Table Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="w-5 h-5" />
                Store App Fee Metrics
              </CardTitle>
              <CardDescription>
                Monthly breakdown of deliveries and fees owed by stores with "Pays App Fees" enabled
              </CardDescription>
            </div>
            <div className="flex items-center gap-3">
              <Select value={selectedYear} onValueChange={setSelectedYear}>
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableYears.map(year => (
                    <SelectItem key={year} value={year.toString()}>{year}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={selectedMonth} onValueChange={setSelectedMonth}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTH_NAMES.map((month, idx) => (
                    <SelectItem key={idx + 1} value={(idx + 1).toString()}>{month}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button variant="outline" onClick={loadMetrics} disabled={isLoading}>
                <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>

              <Button variant="outline" onClick={exportToCSV} disabled={!metrics?.stores?.length}>
                <Download className="w-4 h-4 mr-2" />
                Export CSV
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {metrics?.stores?.length > 0 ? (
            <div className="border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-slate-50">
                    <TableHead className="font-semibold">Store</TableHead>
                    <TableHead className="font-semibold text-center">Status</TableHead>
                    <TableHead className="font-semibold">Fee Period</TableHead>
                    <TableHead className="font-semibold text-right">Total Deliveries</TableHead>
                    <TableHead className="font-semibold text-right">Billable</TableHead>
                    <TableHead className="font-semibold text-right">Billable While Paying</TableHead>
                    <TableHead className="font-semibold text-right">Fees Owed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {metrics.stores.map(store => (
                    <TableRow key={store.store_id} className={store.pays_app_fees ? 'bg-amber-50/50' : ''}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium text-slate-900">{store.store_name}</span>
                          {store.store_abbreviation && (
                            <span className="text-xs text-slate-500">{store.store_abbreviation}</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        {store.pays_app_fees ? (
                          <Badge className="bg-amber-100 text-amber-800">
                            <DollarSign className="w-3 h-3 mr-1" />
                            Paying Fees
                          </Badge>
                        ) : (
                          <Badge variant="secondary">Not Paying</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {store.current_fee_period ? (
                          <div className="flex items-center gap-1 text-xs text-slate-600">
                            <Calendar className="w-3 h-3" />
                            {format(new Date(store.current_fee_period.start + 'T00:00:00'), 'MMM d, yyyy')}
                            <span className="mx-1">→</span>
                            {store.current_fee_period.end 
                              ? format(new Date(store.current_fee_period.end + 'T00:00:00'), 'MMM d, yyyy')
                              : 'Present'
                            }
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {store.total_deliveries}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {store.billable_deliveries}
                      </TableCell>
                      <TableCell className="text-right font-mono font-semibold">
                        {store.billable_while_paying}
                      </TableCell>
                      <TableCell className="text-right font-mono font-semibold text-emerald-700">
                        {formatCurrency(store.total_fees_owed)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {/* Totals Row */}
                  <TableRow className="bg-slate-100 font-semibold">
                    <TableCell>TOTAL</TableCell>
                    <TableCell className="text-center">
                      <Badge variant="outline">
                        {metrics.totals.stores_paying_fees} stores
                      </Badge>
                    </TableCell>
                    <TableCell></TableCell>
                    <TableCell className="text-right font-mono">—</TableCell>
                    <TableCell className="text-right font-mono">
                      {metrics.totals.total_billable_deliveries}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {metrics.totals.total_billable_while_paying}
                    </TableCell>
                    <TableCell className="text-right font-mono text-emerald-700 text-lg">
                      {formatCurrency(metrics.totals.total_fees_owed)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-12 text-slate-500">
              No store data available for {MONTH_NAMES[parseInt(selectedMonth) - 1]} {selectedYear}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}