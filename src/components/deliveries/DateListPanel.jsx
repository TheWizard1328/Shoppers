import React, { useMemo } from 'react';
import { format, isSameDay } from 'date-fns';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Package, CheckCircle, XCircle, RotateCcw, Trash2, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isAppOwner, userHasRole } from '../utils/userRoles';

export default function DateListPanel({
  deliveries = [],
  selectedDate,
  onDateSelect,
  selectedMonth,
  selectedYear,
  onMonthChange,
  onYearChange,
  patients = [],
  selectedDriverId,
  onDeleteRoute,
  onDeleteMonth,
  dateListWithStats = null,
  currentUser
}) {
  const isDispatcher = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');

  const datesWithDeliveries = useMemo(() => {
    if (!deliveries || deliveries.length === 0) return [];

    const patientMap = new Map();
    (patients || []).forEach((p) => {
      if (p?.id) patientMap.set(p.id, p);
      if (p?.patient_id) patientMap.set(p.patient_id, p);
    });

    const dateMap = new Map();
    deliveries.forEach((d) => {
      if (!d || !d.delivery_date) return;
      const dateStr = d.delivery_date;
      if (!dateMap.has(dateStr)) dateMap.set(dateStr, []);
      dateMap.get(dateStr).push(d);
    });

    const list = Array.from(dateMap.entries()).map(([dateStr, dateDeliveries]) => {
      const isReturnDelivery = (d) => {
        const patient = patientMap.get(d.patient_id);
        const notesReturn = (d.delivery_notes || '').toLowerCase().includes('return');
        const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
        return notesReturn || addressReturn;
      };

      const deliveriesOnly = isDispatcher
        ? dateDeliveries.filter((d) => d.patient_id && d.patient_id !== '')
        : dateDeliveries;
      const total = deliveriesOnly.length;

      const completed = deliveriesOnly.filter((d) => {
        if (d.status === 'completed' && !isReturnDelivery(d) && !d.after_hours_pickup) return true;
        if (!isDispatcher && d.after_hours_pickup === true && (d.status === 'completed' || d.status === 'cancelled')) return true;
        return false;
      }).length;

      const failed = deliveriesOnly.filter((d) => d.status === 'failed').length;
      const returned = deliveriesOnly.filter((d) => isReturnDelivery(d)).length;

      // Count unique drivers on this date
      const uniqueDrivers = new Set();
      dateDeliveries.forEach((d) => {
        if (d?.driver_id) uniqueDrivers.add(d.driver_id);
        else if (d?.driver_name) uniqueDrivers.add(d.driver_name);
      });
      const driversCount = uniqueDrivers.size;

      const [y, m, day] = dateStr.split('-').map(Number);
      const date = new Date(y, m - 1, day);

      return {
        date,
        dateStr,
        total,
        completed,
        failed,
        returned,
        driversCount,
        hasDeliveries: total > 0,
        canDelete: completed === 0 && total > 0
      };
    });

    return list.sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [deliveries, patients, isDispatcher]);

  const isSelected = (dateStr) => selectedDate === dateStr;
  const isToday = (date) => isSameDay(date, new Date());

  // Pre-compute driversCount from raw deliveries indexed by date (for when dateListWithStats is provided without driversCount)
  const driversCountByDate = useMemo(() => {
    const map = new Map();
    deliveries.forEach((d) => {
      if (!d?.delivery_date) return;
      const dateStr = d.delivery_date;
      if (!map.has(dateStr)) map.set(dateStr, new Set());
      if (d.driver_id) map.get(dateStr).add(d.driver_id);
      else if (d.driver_name) map.get(dateStr).add(d.driver_name);
    });
    const result = {};
    map.forEach((set, dateStr) => { result[dateStr] = set.size; });
    return result;
  }, [deliveries]);

  // Dispatchers always use datesWithDeliveries (computed from raw deliveries prop = all store deliveries,
  // all drivers) so the driver filter selection doesn't hide dates.
  const itemsToRender = (isDispatcher ? datesWithDeliveries : (dateListWithStats || datesWithDeliveries))
    .filter((d) => d.total > 0)
    .map((item) => ({
      ...item,
      driversCount: item.driversCount ?? driversCountByDate[item.dateStr || item.date] ?? 0
    }));

  return (
    <div className="flex flex-col h-full">
      <div className="px-2 py-2 flex-1 overflow-y-auto space-y-2">
        {itemsToRender.length === 0 ? (
          <div className="text-center py-8" style={{ color: 'var(--text-slate-500)' }}>
            <Package className="w-12 h-12 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No deliveries this month</p>
          </div>
        ) : (
          itemsToRender.map(({ date, dateStr, total, completed, failed, returned, driversCount, canDelete }, index) => (
            <Card
              key={dateStr || `date-${index}`}
              onClick={() => onDateSelect(dateStr, deliveries.filter((d) => d?.delivery_date === dateStr))}
              className="bg-card text-card-foreground pt-1 pr-3 pl-3 rounded-xl border cursor-pointer transition-all hover:shadow-md relative"
              style={{
                background: isSelected(dateStr) ? 'var(--bg-slate-100)' : 'var(--bg-white)',
                borderColor: isSelected(dateStr) ? '#10b981' : 'var(--border-slate-200)'
              }}
            >
              <div className="mt-1 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="text-sm font-bold" style={{ color: isSelected(dateStr) ? '#047857' : 'var(--text-slate-700)' }}>
                    {format(date, 'EEE, MMM d')}
                  </div>
                  {isToday(date) && (
                    <Badge className="bg-blue-100 text-blue-800 text-xs">Today</Badge>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge variant="secondary" className="text-xs" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>
                    {total}
                  </Badge>
                  {isDispatcher && driversCount > 0 && (
                    <Badge variant="secondary" className="text-xs flex items-center gap-1" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>
                      <Truck className="w-3 h-3" />
                      {driversCount}
                    </Badge>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex gap-3 text-xs">
                  <div className="flex items-center gap-1 text-green-600" title={`${completed} completed`}>
                    <CheckCircle className="w-3 h-3" />
                    <span>{completed}</span>
                  </div>
                  {failed > 0 && (
                    <div className="flex items-center gap-1 text-red-600" title={`${failed} failed`}>
                      <XCircle className="w-3 h-3" />
                      <span>{failed}</span>
                    </div>
                  )}
                  {returned > 0 && (
                    <div className="flex items-center gap-1 text-amber-600" title={`${returned} returned`}>
                      <RotateCcw className="w-3 h-3" />
                      <span>{returned}</span>
                    </div>
                  )}
                </div>

                {selectedDriverId && selectedDriverId !== 'all' && onDeleteRoute && isAppOwner(currentUser) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 hover:text-red-600 hover:bg-red-50"
                    style={{ color: 'var(--text-slate-400)' }}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (window.confirm(`Delete all ${total} stops for this date? This cannot be undone.`)) {
                        await onDeleteRoute(dateStr, selectedDriverId);
                      }
                    }}
                    title="Delete entire route for this date"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}