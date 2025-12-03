import React, { useMemo } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, parseISO } from 'date-fns';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Calendar, Package, CheckCircle, XCircle, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

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
  onDeleteRoute
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


  const years = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 3 }, (_, i) => currentYear - 1 + i).reverse();
  }, []);

  // Get all dates in selected month that have deliveries
  const datesWithDeliveries = useMemo(() => {
    const start = startOfMonth(new Date(selectedYear, selectedMonth));
    const end = endOfMonth(new Date(selectedYear, selectedMonth));
    const allDates = eachDayOfInterval({ start, end });

    // Create patient map for quick lookup
    const patientMap = new Map((patients || []).map((p) => [p.id, p]));

    const list = allDates.map((date) => {
      const dateStr = format(date, 'yyyy-MM-dd');
      const dateDeliveries = deliveries.filter((d) => d.delivery_date === dateStr);

      const completed = dateDeliveries.filter((d) => d.status === 'completed').length;
      const failed = dateDeliveries.filter((d) => d.status === 'failed').length;

      // Calculate returned deliveries
      const returned = dateDeliveries.filter((d) => {
        const patient = patientMap.get(d.patient_id);
        const notesReturn = (d.delivery_notes || '').toLowerCase().includes('return');
        const addressReturn = patient && (patient.address || '').toLowerCase().includes('rtn');
        return notesReturn || addressReturn;
      }).length;

      const total = dateDeliveries.length;

      return {
        date,
        dateStr,
        total,
        completed,
        failed,
        returned,
        hasDeliveries: total > 0,
        canDelete: completed === 0 && total > 0 // Can delete if no completed deliveries
      };
    }).filter((d) => d.hasDeliveries);

    return list.sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [deliveries, selectedMonth, selectedYear, patients]);

  const isSelected = (dateStr) => selectedDate === dateStr;
  const isToday = (date) => isSameDay(date, new Date());

  return (
    <div className="flex flex-col h-full">
      {/* Month/Year Selectors */}
      <div className="p-2 border-b border-slate-200">
        <div className="grid grid-cols-2 gap-2">
          <Select value={selectedMonth.toString()} onValueChange={(val) => onMonthChange(parseInt(val))}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-[300px]">
              {months.map((m) =>
              <SelectItem key={m.value} value={m.value.toString()}>
                  {m.label}
                </SelectItem>
              )}
            </SelectContent>
          </Select>

          <Select value={selectedYear.toString()} onValueChange={(val) => onYearChange(parseInt(val))}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map((y) =>
              <SelectItem key={y} value={y.toString()}>
                  {y}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Date Cards List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {datesWithDeliveries.length === 0 ?
        <div className="text-center py-8 text-slate-500">
            <Package className="w-12 h-12 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No deliveries this month</p>
          </div> :

        datesWithDeliveries.map(({ date, dateStr, total, completed, failed, returned, canDelete }) =>
        <Card
          key={dateStr}
          onClick={() => onDateSelect(dateStr)}
          className={`p-3 cursor-pointer transition-all hover:shadow-md relative ${
          isSelected(dateStr) ?
          'bg-emerald-50 border-emerald-500 shadow-md' :
          'bg-white hover:bg-slate-50'}`
          }>

              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className={`text-sm font-bold ${isSelected(dateStr) ? 'text-emerald-700' : 'text-slate-700'}`}>
                    {format(date, 'EEE, MMM d')}
                  </div>
                  {isToday(date) &&
              <Badge className="bg-blue-100 text-blue-800 text-xs">Today</Badge>
              }
                </div>
                <Badge variant="secondary" className="text-xs">
                  {total}
                </Badge>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex gap-3 text-xs">
                  <div className="flex items-center gap-1 text-green-600">
                    <CheckCircle className="w-3 h-3" />
                    <span>{completed}</span>
                  </div>
                  {failed > 0 &&
              <div className="flex items-center gap-1 text-red-600">
                      <XCircle className="w-3 h-3" />
                      <span>{failed}</span>
                    </div>
              }
                  {returned > 0 &&
              <div className="flex items-center gap-1 text-amber-600">
                      <RotateCcw className="w-3 h-3" />
                      <span>{returned}</span>
                    </div>
              }
                </div>
                
                {/* Delete route button - only show if no completed deliveries and a driver is selected */}
                {canDelete && selectedDriverId && selectedDriverId !== 'all' && onDeleteRoute &&
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 text-slate-400 hover:text-red-600 hover:bg-red-50"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm(`Delete all ${total} stops for this date? This cannot be undone.`)) {
                        onDeleteRoute(dateStr, selectedDriverId);
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