import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BarChart3, DollarSign, Store, Package, RefreshCw, Loader2, FileText, Calendar } from 'lucide-react';
import { jsPDF } from 'jspdf';
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

  const exportToPDF = () => {
    if (!metrics?.stores) return;

    // Sort stores: paying fees first, then alphabetically
    const sortedStores = [...metrics.stores].sort((a, b) => {
      if (a.pays_app_fees && !b.pays_app_fees) return -1;
      if (!a.pays_app_fees && b.pays_app_fees) return 1;
      return a.store_name.localeCompare(b.store_name);
    });

    const doc = new jsPDF('landscape');
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 15;

    // Title
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.text(`Store App Fee Metrics - ${MONTH_NAMES[parseInt(selectedMonth) - 1]} ${selectedYear}`, margin, 20);

    // Summary section
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`Generated: ${format(new Date(), 'MMM dd, yyyy h:mm a')}`, margin, 28);
    
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    const summaryY = 38;
    doc.text(`Stores Paying Fees: ${metrics.totals.stores_paying_fees} / ${metrics.totals.total_stores}`, margin, summaryY);
    doc.text(`Billable Deliveries: ${metrics.totals.total_billable_while_paying}`, margin + 80, summaryY);
    doc.text(`Fee Rate: ${formatCurrency(metrics.totals.app_fee_rate)}`, margin + 160, summaryY);
    doc.text(`Total Fees Owed: ${formatCurrency(metrics.totals.total_fees_owed)}`, margin + 220, summaryY);

    // Table headers
    const headers = ['Store', 'Status', 'Fee Period', 'Total', 'Billable', 'Billable (Paying)', 'Fees Owed'];
    const colWidths = [55, 30, 60, 25, 25, 40, 35];
    let startX = margin;
    let y = 50;

    // Header row
    doc.setFillColor(241, 245, 249);
    doc.rect(margin, y - 5, pageWidth - margin * 2, 10, 'F');
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(51, 65, 85);
    
    headers.forEach((header, i) => {
      doc.text(header, startX, y);
      startX += colWidths[i];
    });

    // Table rows
    y += 12;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(8);

    sortedStores.forEach((store, idx) => {
      if (y > pageHeight - 25) {
        doc.addPage();
        y = 20;
      }

      // Alternate row background
      if (store.pays_app_fees) {
        doc.setFillColor(254, 252, 232);
        doc.rect(margin, y - 4, pageWidth - margin * 2, 8, 'F');
      } else if (idx % 2 === 0) {
        doc.setFillColor(248, 250, 252);
        doc.rect(margin, y - 4, pageWidth - margin * 2, 8, 'F');
      }

      startX = margin;
      doc.text(store.store_name.substring(0, 25), startX, y);
      startX += colWidths[0];
      doc.text(store.pays_app_fees ? 'Paying' : 'Not Paying', startX, y);
      startX += colWidths[1];
      
      const feePeriod = store.current_fee_period 
        ? `${format(new Date(store.current_fee_period.start + 'T00:00:00'), 'MMM dd, yyyy')} → ${store.current_fee_period.end ? format(new Date(store.current_fee_period.end + 'T00:00:00'), 'MMM dd, yyyy') : 'Present'}`
        : '—';
      doc.text(feePeriod.substring(0, 28), startX, y);
      startX += colWidths[2];
      
      doc.text(store.total_deliveries.toString(), startX, y);
      startX += colWidths[3];
      doc.text(store.billable_deliveries.toString(), startX, y);
      startX += colWidths[4];
      doc.text(store.billable_while_paying.toString(), startX, y);
      startX += colWidths[5];
      
      doc.setFont('helvetica', 'bold');
      doc.text(formatCurrency(store.total_fees_owed), startX, y);
      doc.setFont('helvetica', 'normal');

      y += 8;
    });

    // Totals row
    y += 4;
    doc.setFillColor(226, 232, 240);
    doc.rect(margin, y - 4, pageWidth - margin * 2, 10, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    
    startX = margin;
    doc.text('TOTAL', startX, y);
    startX += colWidths[0];
    doc.text(`${metrics.totals.stores_paying_fees} stores`, startX, y);
    startX += colWidths[1] + colWidths[2] + colWidths[3];
    doc.text(metrics.totals.total_billable_deliveries.toString(), startX, y);
    startX += colWidths[4];
    doc.text(metrics.totals.total_billable_while_paying.toString(), startX, y);
    startX += colWidths[5];
    doc.setTextColor(5, 150, 105);
    doc.text(formatCurrency(metrics.totals.total_fees_owed), startX, y);

    doc.save(`store_metrics_${selectedYear}_${selectedMonth}.pdf`);
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
      <Card className="flex flex-col max-h-[calc(100vh-220px)] min-h-[420px]">
        <CardHeader className="shrink-0">
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

              <Button variant="outline" onClick={exportToPDF} disabled={!metrics?.stores?.length}>
                <FileText className="w-4 h-4 mr-2" />
                Export PDF
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex-1 overflow-hidden p-0">
          <div className="h-full overflow-y-auto p-6">
          {metrics?.stores?.length > 0 ? (
            <div className="border rounded-lg overflow-hidden">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-slate-50">
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
        </div>
        </CardContent>
        <CardFooter className="shrink-0 justify-between">
          <span className="text-xs text-slate-500">Showing {metrics?.stores?.length || 0} stores</span>
          <span className="text-xs text-slate-400">Scroll to view more</span>
        </CardFooter>
      </Card>
    </div>
  );
}