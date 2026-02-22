import React, { useMemo } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, parseISO } from 'date-fns';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Calendar, Package, CheckCircle, XCircle, RotateCcw, Trash2 } from 'lucide-react';
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
  const months = [
  { value: 0, label: 'January' },
  { value: 1, label: 'February' },
  { value: 2, label: 'March' },
  { value: 3, label: 'April' },
  { value: 4, label: 'May' },
  { value: 5, label: 'June' },
  { value: 6, label: 'July' },
  { value: 7, label: 'August' },
  { value: 8, label: 'September' },
  { value: 9, label: 'October' },
  { value: 10, label: 'November' },
  { value: 11, label: 'December' }];


  // Extract years where the selected driver has deliveries
  const availableYears = useMemo(() => {
    if (!deliveries || deliveries.length === 0) return [];
    
    const yearsSet = new Set();
    deliveries.forEach((d) => {
      if (!d || !d.delivery_date) return;
      try {
        const year = new Date(d.delivery_date.replace(/-/g, '/')).getFullYear();
        yearsSet.add(year);
      } catch (error) {
        console.warn('Invalid delivery_date:', d.delivery_date);
      }
    });
    
    return Array.from(yearsSet).sort((a, b) => b - a);
  }, [deliveries]);

  // Extract months with deliveries for the selected year
  const availableMonths = useMemo(() => {
    if (!deliveries || deliveries.length === 0) return [];
    
    const monthsSet = new Set();
    deliveries.forEach((d) => {
      if (!d || !d.delivery_date) return;
      try {
        const date = new Date(d.delivery_date.replace(/-/g, '/'));
        if (date.getFullYear() === selectedYear) {
          monthsSet.add(date.getMonth());
        }
      } catch (error) {
        console.warn('Invalid delivery_date:', d.delivery_date);
      }
    });
    
    return Array.from(monthsSet).sort((a, b) => b - a);
  }, [deliveries, selectedYear]);

  // Get all dates in selected month that have deliveries
  // CRITICAL: Extract dates directly from deliveries to avoid UTC conversion issues
  const datesWithDeliveries = useMemo(() => {
    if (!deliveries || deliveries.length === 0) {
      return [];
    }

    // Create patient map for quick lookup
    const patientMap = new Map((patients || []).map((p) => [p.id, p]));

    // Extract unique dates directly from delivery data (no UTC conversion)
    const dateMap = new Map();

    deliveries.forEach((d) => {
      if (!d || !d.delivery_date) return;

      const dateStr = d.delivery_date;
      if (!dateMap.has(dateStr)) {
        dateMap.set(dateStr, []);
      }
      dateMap.get(dateStr).push(d);
    });

    // Build stats for each unique date
    const list = Array.from(dateMap.entries()).map(([dateStr, dateDeliveries]) => {
      // Helper function to detect returns (by notes or address)
      const isReturnDelivery = (d) => {
        const patient = patientMap.get(d.patient_id);
        const notesReturn = (d.delivery_notes || '').toLowerCase().includes('return');
        const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
        return notesReturn || addressReturn;
      };

      // CRITICAL: For dispatchers, exclude pickups (patient_id is null/empty) from total
      const isDispatcher = userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin');
      const deliveriesOnly = isDispatcher 
        ? dateDeliveries.filter(d => d.patient_id && d.patient_id !== '')
        : dateDeliveries;
      const total = deliveriesOnly.length;

      // Completed: all completed deliveries (no returns, no pickups) + after hours pickups (completed or cancelled)
      const completed = dateDeliveries.filter((d) => {
        // Completed deliveries (exclude returns and pickups)
        if (d.status === 'completed' && !isReturnDelivery(d) && !d.after_hours_pickup) {
          return true;
        }
        // After hours pickups (completed or cancelled only)
        if (d.after_hours_pickup === true && (d.status === 'completed' || d.status === 'cancelled')) {
          return true;
        }
        return false;
      }).length;

      // Failed: all failed deliveries only
      const failed = dateDeliveries.filter((d) => d.status === 'failed').length;

      // Returned: all deliveries marked as returned
      const returned = dateDeliveries.filter((d) => isReturnDelivery(d)).length;

      // Parse date as local time (YYYY-MM-DD format is always local)
      const [y, m, day] = dateStr.split('-').map(Number);
      const date = new Date(y, m - 1, day);

      return {
        date,
        dateStr,
        total,
        completed,
        failed,
        returned,
        hasDeliveries: total > 0,
        canDelete: completed === 0 && total > 0
      };
    });

    return list.sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [deliveries, patients, currentUser]);

  const isSelected = (dateStr) => selectedDate === dateStr;
  const isToday = (date) => isSameDay(date, new Date());

  return (
    <div className="flex flex-col h-full">
      {/* Month/Year Selectors */}
      <div className="p-2" style={{ borderBottom: '1px solid var(--border-slate-200)' }}>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <Select value={selectedMonth.toString()} onValueChange={(val) => onMonthChange(parseInt(val))}>
            <SelectTrigger style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-[300px]" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
              {months.filter((m) => availableMonths.includes(m.value)).map((m) =>
              <SelectItem key={m.value} value={m.value.toString()} style={{ color: 'var(--text-slate-900)' }}>
                  {m.label}
                </SelectItem>
              )}
            </SelectContent>
          </Select>

          <Select value={selectedYear.toString()} onValueChange={(val) => onYearChange(parseInt(val))}>
            <SelectTrigger style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)', color: 'var(--text-slate-900)' }}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
              {availableYears.map((y) =>
              <SelectItem key={y} value={y.toString()} style={{ color: 'var(--text-slate-900)' }}>
                  {y}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
        
        {onDeleteMonth && datesWithDeliveries.length > 0 && selectedDriverId && selectedDriverId !== 'all' && isAppOwner(currentUser) &&
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-2 text-red-600 hover:bg-red-50"
          onClick={() => {
            const monthName = months[selectedMonth].label;
            const driverDeliveries = deliveries.filter((d) => d && d.driver_id === selectedDriverId);
            const monthStart = new Date(selectedYear, selectedMonth, 1);
            const monthEnd = new Date(selectedYear, selectedMonth + 1, 0);
            const startDateStr = format(monthStart, 'yyyy-MM-dd');
            const endDateStr = format(monthEnd, 'yyyy-MM-dd');
            const totalForMonth = driverDeliveries.filter((d) => d.delivery_date >= startDateStr && d.delivery_date <= endDateStr).length;
            if (window.confirm(`Delete all ${totalForMonth} stops for ${monthName} ${selectedYear} for this driver? This cannot be undone.`)) {
              onDeleteMonth(selectedYear, selectedMonth, selectedDriverId);
            }
          }}
        >
          <Trash2 className="w-4 h-4" />
          Delete All
        </Button>
        }
      </div>

      {/* Date Cards List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {datesWithDeliveries.filter(d => d.total > 0).length === 0 ?
        <div className="text-center py-8" style={{ color: 'var(--text-slate-500)' }}>
            <Package className="w-12 h-12 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No deliveries this month</p>
          </div> :

        (dateListWithStats || datesWithDeliveries).filter(d => d.total > 0).map(({ date, dateStr, total, completed, failed, returned, canDelete }, index) =>
        <Card
          key={dateStr || `date-${index}`}
          onClick={() => onDateSelect(dateStr)}
          className={`p-3 cursor-pointer transition-all hover:shadow-md relative ${
          isSelected(dateStr) ?
          'border-emerald-500 shadow-md' :
          ''}`
          }
          style={{
            background: isSelected(dateStr) ? 'var(--bg-slate-100)' : 'var(--bg-white)',
            borderColor: isSelected(dateStr) ? '#10b981' : 'var(--border-slate-200)'
          }}>

              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="text-sm font-bold" style={{ color: isSelected(dateStr) ? '#047857' : 'var(--text-slate-700)' }}>
                    {format(date, 'EEE, MMM d')}
                  </div>
                  {isToday(date) &&
              <Badge className="bg-blue-100 text-blue-800 text-xs">Today</Badge>
              }
                </div>
                <Badge variant="secondary" className="text-xs" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>
                  {total}
                </Badge>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex gap-3 text-xs">
                  <div className="flex items-center gap-1 text-green-600" title={`${completed} paid`}>
                    <CheckCircle className="w-3 h-3" />
                    <span>{completed}</span>
                  </div>
                  {failed > 0 &&
              <div className="flex items-center gap-1 text-red-600" title={`${failed} failed`}>
                      <XCircle className="w-3 h-3" />
                      <span>{failed}</span>
                    </div>
              }
                  {returned > 0 &&
              <div className="flex items-center gap-1 text-amber-600" title={`${returned} returned`}>
                      <RotateCcw className="w-3 h-3" />
                      <span>{returned}</span>
                    </div>
              }
                </div>
                
                {/* Delete route button - show if a specific driver is selected AND user is app owner */}
                {selectedDriverId && selectedDriverId !== 'all' && onDeleteRoute && isAppOwner(currentUser) &&
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
                }
              </div>
            </Card>
        )
        }
      </div>
    </div>);

}