import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Loader2, ArrowUpDown, Edit, Trash2 } from 'lucide-react';
import DeliveryRouteDataCell from '@/components/admin/DeliveryRouteDataCell';
import { getDriverDisplayName } from '@/components/utils/driverUtils';

const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function ResizableColumnHeader({ width, children }) {
  return <th className="p-2 text-left font-semibold" style={{ width: `${width}px`, minWidth: `${width}px`, maxWidth: `${width}px` }}>{children}</th>;
}

export default function AdminDeliveriesTable(props) {
  const {
    deliveries, patients, stores, drivers,
    onEdit, onDelete, onDeleteAll, onDeleteSelected, onFindDuplicates,
    autoSelectIds = [], duplicateFilterMode, onAutoSelectProcessed, onClearDuplicateFilter,
    filterText, onFilterChange, sortColumn, sortDirection, onSortChange,
    selectedYear, onYearChange, availableYears, selectedMonth, onMonthChange,
    selectedDriver, onDriverChange, selectedCodFilter, onCodFilterChange,
    isLoadingData, handleDriverChange
  } = props;

  const [selectedDeliveries, setSelectedDeliveries] = useState(new Set());
  const [editingDriverId, setEditingDriverId] = useState(null);
  const [showMostRecentOnly, setShowMostRecentOnly] = useState(false);
  const [columnWidths] = useState({ checkbox: 50, date: 120, order: 80, sid_pid: 110, tracking: 90, delivery_to: 220, driver: 140, cod: 120, distance: 90, status: 110, actions: 110 });
  const isCodFilterActive = selectedCodFilter && selectedCodFilter !== 'all_deliveries';

  React.useEffect(() => {
    if (autoSelectIds.length > 0) {
      setSelectedDeliveries(new Set(autoSelectIds));
      onAutoSelectProcessed?.();
    }
  }, [autoSelectIds, onAutoSelectProcessed]);

  React.useEffect(() => {
    if (isCodFilterActive && showMostRecentOnly) {
      setShowMostRecentOnly(false);
    }
  }, [isCodFilterActive, showMostRecentOnly]);

  const getSortIcon = (columnName) => {
    if (sortColumn === columnName) {
      return sortDirection === 'asc' ? <ArrowUpDown className="w-4 h-4 inline ml-1 rotate-180" /> : <ArrowUpDown className="w-4 h-4 inline ml-1" />;
    }
    return <ArrowUpDown className="w-4 h-4 inline ml-1 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />;
  };

  const getDeliveryInfo = (delivery) => {
    const patient = (patients || []).find((p) => p.id === delivery.patient_id);
    const store = (stores || []).find((s) => s.id === delivery.store_id);
    return {
      name: patient?.full_name || store?.name || 'Store Pickup',
      address: patient?.address || store?.address || 'Unknown Address',
      patientPID: patient?.patient_id || ''
    };
  };

  const getDeliveryDateTime = (delivery) => ({
    date: delivery.delivery_date || '-',
    time: delivery.actual_delivery_time?.split('T')[1]?.slice(0, 5) || delivery.delivery_time_eta || '-'
  });

  const getDriverName = (delivery) => {
    const driver = (drivers || []).find((d) => d.id === delivery.driver_id);
    return driver ? getDriverDisplayName(driver) : delivery.driver_name || '-';
  };

  const getStatusBadge = (delivery) => <Badge variant="secondary">{delivery.status || '-'}</Badge>;

  const displayDeliveries = useMemo(() => {
    let rows = deliveries || [];
    if (showMostRecentOnly && rows.length > 0) {
      const latest = [...new Set(rows.map((d) => d.delivery_date).filter(Boolean))].sort().pop();
      rows = rows.filter((d) => d.delivery_date === latest);
    }
    return rows;
  }, [deliveries, showMostRecentOnly]);

  const handleSelectAll = (checked) => {
    setSelectedDeliveries(checked ? new Set(displayDeliveries.map((d) => d.id)) : new Set());
  };

  const handleSelectDelivery = (id, checked) => {
    setSelectedDeliveries((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);else next.delete(id);
      return next;
    });
  };

  const isAllSelected = displayDeliveries.length > 0 && selectedDeliveries.size === displayDeliveries.length;
  const isSomeSelected = selectedDeliveries.size > 0 && selectedDeliveries.size < displayDeliveries.length;

  return (
    <Card className="flex-1 min-h-0 rounded-xl border bg-card text-card-foreground shadow">
      <CardHeader className="px-6 py-1 flex flex-col space-y-1.5">
        <CardTitle className="flex items-center justify-between">
          <span>Deliveries</span>
          <div className="flex gap-2">
            {selectedDeliveries.size > 0 && <Button variant="destructive" size="sm" onClick={() => { onDeleteSelected(displayDeliveries.filter((d) => selectedDeliveries.has(d.id))); setSelectedDeliveries(new Set()); }}>Delete Selected ({selectedDeliveries.size})</Button>}
            <Button variant="outline" size="sm" onClick={() => onFindDuplicates(displayDeliveries)} disabled={isLoadingData} className="text-orange-600 border-orange-300 hover:bg-orange-50">Find Duplicates</Button>
            {duplicateFilterMode && <Button variant="outline" size="sm" onClick={onClearDuplicateFilter} disabled={isLoadingData} className="bg-blue-50 border-blue-300">Clear Filter</Button>}
            {selectedDeliveries.size === 0 && <Button variant="destructive" size="sm" onClick={onDeleteAll} disabled={isLoadingData}>Delete All Filtered ({displayDeliveries.length})</Button>}
          </div>
        </CardTitle>
        <CardDescription>Filtered and sorted list of deliveries by year, month, and driver.</CardDescription>
      </CardHeader>
      <CardContent className="px-6 py-1">
        <div className="flex flex-wrap gap-3 mb-4">
          <Select value={selectedYear} onValueChange={onYearChange} disabled={isLoadingData}><SelectTrigger className="w-32"><SelectValue placeholder="Select year" /></SelectTrigger><SelectContent><SelectItem value="all">All Years</SelectItem>{(availableYears || []).map((year) => <SelectItem key={year} value={year.toString()}>{year}</SelectItem>)}</SelectContent></Select>
          <Select value={selectedMonth} onValueChange={onMonthChange} disabled={isLoadingData || selectedYear === 'all'}><SelectTrigger className="w-36"><SelectValue placeholder="Select month" /></SelectTrigger><SelectContent><SelectItem value="all">All Months</SelectItem>{monthNames.map((month, index) => <SelectItem key={index + 1} value={(index + 1).toString()}>{month}</SelectItem>)}</SelectContent></Select>
          <Select value={selectedDriver} onValueChange={onDriverChange} disabled={isLoadingData}><SelectTrigger className="w-40"><SelectValue placeholder="Select driver" /></SelectTrigger><SelectContent><SelectItem value="all">All Drivers</SelectItem>{drivers && drivers.length > 0 ? drivers.map((driver) => <SelectItem key={driver.id} value={driver.user_name || driver.full_name || ''}>{getDriverDisplayName(driver)}</SelectItem>) : <div className="p-2 text-xs text-slate-500">No drivers available</div>}</SelectContent></Select>
          <Select value={selectedCodFilter || 'all_deliveries'} onValueChange={onCodFilterChange} disabled={isLoadingData}><SelectTrigger className="w-40"><SelectValue placeholder="Select COD" /></SelectTrigger><SelectContent><SelectItem value="all_deliveries">All Deliveries</SelectItem><SelectItem value="all">All COD's</SelectItem><SelectItem value="cash">Cash</SelectItem><SelectItem value="debit">Debit</SelectItem><SelectItem value="credit">Credit</SelectItem><SelectItem value="check">Check</SelectItem></SelectContent></Select>
          <Input placeholder="Filter by name, address, SID, TR#, or status..." value={filterText} onChange={(e) => onFilterChange(e.target.value)} className="flex-1 min-w-[200px]" disabled={isLoadingData} />
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--border-slate-200)', background: 'var(--bg-white)' }}><Checkbox id="show-most-recent" checked={showMostRecentOnly} onCheckedChange={setShowMostRecentOnly} disabled={isCodFilterActive} /><label htmlFor="show-most-recent" className="text-sm font-medium cursor-pointer" style={{ color: 'var(--text-slate-900)' }}>{isCodFilterActive ? 'Most Recent Date Only (off for COD filters)' : 'Most Recent Date Only'}</label></div>
        </div>
        <div className="border rounded-md overflow-hidden" style={{ borderColor: 'var(--border-slate-200)' }}>
          <div className="overflow-x-auto" style={{ maxHeight: '600px' }}>
            <table className="w-full text-sm table-fixed">
              <thead className="border-b sticky top-0 z-10" style={{ background: 'var(--bg-slate-100)', borderColor: 'var(--border-slate-200)' }}>
                <tr>
                  <ResizableColumnHeader width={columnWidths.checkbox}><Checkbox checked={isAllSelected} onCheckedChange={handleSelectAll} className={isSomeSelected ? 'data-[state=checked]:bg-slate-500' : ''} /></ResizableColumnHeader>
                  <ResizableColumnHeader width={columnWidths.date}><Button variant="ghost" onClick={() => onSortChange('delivery_date')} className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold">Date / Time {getSortIcon('delivery_date')}</Button></ResizableColumnHeader>
                  <ResizableColumnHeader width={columnWidths.order}><Button variant="ghost" onClick={() => onSortChange('stop_order')} className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold">Order {getSortIcon('stop_order')}</Button></ResizableColumnHeader>
                  <ResizableColumnHeader width={columnWidths.sid_pid}><Button variant="ghost" onClick={() => onSortChange('stop_id')} className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold">SID / PID {getSortIcon('stop_id')}</Button></ResizableColumnHeader>
                  <ResizableColumnHeader width={columnWidths.tracking}><Button variant="ghost" onClick={() => onSortChange('tracking_number')} className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold">TR# {getSortIcon('tracking_number')}</Button></ResizableColumnHeader>
                  <ResizableColumnHeader width={columnWidths.delivery_to}><span className="font-semibold">Delivery To</span></ResizableColumnHeader>
                  <ResizableColumnHeader width={columnWidths.driver}><Button variant="ghost" onClick={() => onSortChange('driver_name')} className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold">Driver {getSortIcon('driver_name')}</Button></ResizableColumnHeader>
                  <ResizableColumnHeader width={columnWidths.cod}><span className="font-semibold">COD</span></ResizableColumnHeader>
                  <ResizableColumnHeader width={columnWidths.distance}><Button variant="ghost" onClick={() => onSortChange('travel_dist')} className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold">Dist {getSortIcon('travel_dist')}</Button></ResizableColumnHeader>
                  <ResizableColumnHeader width={columnWidths.status}><Button variant="ghost" onClick={() => onSortChange('status')} className="p-0 h-auto group flex items-center hover:text-emerald-600 transition-colors font-semibold">Status {getSortIcon('status')}</Button></ResizableColumnHeader>
                  <th className="p-2 text-left font-semibold" style={{ width: '170px', minWidth: '170px', maxWidth: '170px' }}>Breadcrumbs / Polylines</th>
                  <ResizableColumnHeader width={columnWidths.actions}><span className="font-semibold">Actions</span></ResizableColumnHeader>
                </tr>
              </thead>
              <tbody>
                {isLoadingData ? <tr><td colSpan={12} className="p-3 text-center text-slate-500"><Loader2 className="w-5 h-5 inline mr-2 animate-spin" />Loading deliveries...</td></tr> : displayDeliveries.length > 0 ? displayDeliveries.map((delivery) => {
                  const info = getDeliveryInfo(delivery);
                  const dateTime = getDeliveryDateTime(delivery);
                  const driverName = getDriverName(delivery);
                  const codPayments = Array.isArray(delivery.cod_payments) ? delivery.cod_payments : [];
                  const collectionType = codPayments.find((p) => Number(p?.amount || 0) > 0)?.type || (delivery.cod_payment_type && delivery.cod_payment_type !== 'No Payment' ? delivery.cod_payment_type : '-');
                  return <tr key={delivery.id} className="border-b" style={{ borderColor: 'var(--border-slate-200)' }}><td className="p-2"><Checkbox checked={selectedDeliveries.has(delivery.id)} onCheckedChange={(checked) => handleSelectDelivery(delivery.id, checked)} /></td><td className="p-2"><div className="flex flex-col"><span className="font-medium" style={{ color: 'var(--text-slate-900)' }}>{dateTime.date}</span><span className="text-xs" style={{ color: 'var(--text-slate-600)' }}>{dateTime.time}</span></div></td><td className="p-2 font-mono text-sm"><div className="flex flex-col"><span className="font-semibold">{delivery.stop_order ?? '-'}</span>{delivery.ampm_deliveries && <span className="text-xs text-slate-600">{delivery.ampm_deliveries}</span>}</div></td><td className="p-2 font-mono text-xs"><div className="flex flex-col">{delivery.stop_id && <span className="font-semibold">{delivery.stop_id}</span>}{info.patientPID && <span className="text-slate-600">{info.patientPID}</span>}{!delivery.stop_id && !info.patientPID && <span>-</span>}</div></td><td className="p-2 font-mono text-xs"><div className="flex flex-col"><span>{delivery.tracking_number || '-'}</span>{delivery.puid && <span className="text-slate-600 text-[10px]">{delivery.puid}</span>}</div></td><td className="p-2"><div className="flex flex-col"><span className="font-medium" style={{ color: 'var(--text-slate-900)' }}>{info.name}</span><span className="text-xs" style={{ color: 'var(--text-slate-600)' }}>{info.address}</span></div></td><td className="p-2">{editingDriverId === delivery.id ? <Select value={delivery.driver_id || ''} onValueChange={(newDriverId) => handleDriverChange(delivery, newDriverId)} onOpenChange={(open) => {if (!open) setEditingDriverId(null);}}><SelectTrigger className="h-7 w-full text-xs"><SelectValue /></SelectTrigger><SelectContent className="z-[9999]">{drivers.map((driver) => <SelectItem key={driver.id} value={driver.id}>{getDriverDisplayName(driver)}</SelectItem>)}</SelectContent></Select> : <div className="flex flex-col gap-1"><span className="cursor-pointer hover:bg-slate-100 px-2 py-1 rounded transition-colors inline-block" onClick={() => setEditingDriverId(delivery.id)}>{driverName}</span>{delivery.isNextDelivery && <Badge className="bg-green-100 !text-green-800 border-green-300 w-fit">Next</Badge>}</div>}</td><td className="p-2"><div className="flex flex-col text-sm"><span className="font-mono" style={{ color: 'var(--text-slate-900)' }}>{Number(delivery.cod_total_amount_required || 0) > 0 ? `$${Number(delivery.cod_total_amount_required || 0).toFixed(2)}` : '-'}</span><span className="text-xs" style={{ color: 'var(--text-slate-600)' }}>{collectionType}</span></div></td><td className="p-2"><div className="flex flex-col text-sm font-mono" style={{ color: 'var(--text-slate-900)' }}><span>{delivery.travel_dist ? `${delivery.travel_dist.toFixed(2)}k` : '-'}</span>{(() => {const patient = (patients || []).find((p) => p.id === delivery.patient_id);const patientDist = patient?.distance_from_store;return patientDist ? <span className="text-xs text-slate-600">{patientDist.toFixed(2)}k</span> : null;})()}</div></td><td className="p-2">{getStatusBadge(delivery)}</td><td className="p-2"><DeliveryRouteDataCell delivery={delivery} /></td><td className="p-2 text-right"><div className="flex justify-end gap-2"><Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onEdit(delivery)}><Edit className="w-4 h-4" /></Button><Button variant="ghost" size="icon" className="h-8 w-8 text-red-600 hover:text-red-700 hover:bg-red-50" onClick={() => onDelete(delivery)}><Trash2 className="w-4 h-4" /></Button></div></td></tr>;
                }) : <tr><td colSpan={12} className="p-3 text-center text-slate-500">No deliveries found.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </CardContent>
    </Card>);

}