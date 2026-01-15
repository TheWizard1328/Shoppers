import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table } from 'lucide-react';

/**
 * Driver Payroll Grid
 * Shows deliveries per store per day of month for selected driver(s)
 */
export default function DriverPayrollGrid({ 
  deliveries, 
  stores, 
  selectedYear, 
  selectedMonth,
  selectedDriverId,
  payPeriod,
  onPayPeriodChange
}) {

  if (!deliveries || !stores) return null;

  // Get days in the selected month
  const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  // Sort stores by sort_order
  const sortedStores = [...stores].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));

  // Filter deliveries by year, month, and driver
  const filteredDeliveries = deliveries.filter(d => {
    if (!d || !d.delivery_date) return false;
    const date = new Date(d.delivery_date + 'T00:00:00');
    if (date.getFullYear() !== selectedYear) return false;
    if (date.getMonth() + 1 !== selectedMonth) return false;
    if (d.status !== 'completed') return false;
    if (selectedDriverId && selectedDriverId !== 'all' && d.driver_id !== selectedDriverId) return false;
    return true;
  });

  // Build a map of day -> store -> count
  const dataMap = {};
  days.forEach(day => {
    dataMap[day] = {};
    sortedStores.forEach(store => {
      dataMap[day][store.id] = 0;
    });
  });

  filteredDeliveries.forEach(d => {
    const date = new Date(d.delivery_date + 'T00:00:00');
    const day = date.getDate();
    const storeId = d.store_id;
    if (dataMap[day] && dataMap[day][storeId] !== undefined) {
      dataMap[day][storeId]++;
    }
  });

  // Calculate store totals (column totals)
  const storeTotals = {};
  sortedStores.forEach(store => {
    storeTotals[store.id] = 0;
  });
  days.forEach(day => {
    sortedStores.forEach(store => {
      storeTotals[store.id] += dataMap[day][store.id] || 0;
    });
  });

  // Calculate day totals (row totals)
  const getDayTotal = (day) => {
    return sortedStores.reduce((sum, store) => sum + (dataMap[day][store.id] || 0), 0);
  };

  // Grand total
  const grandTotal = Object.values(storeTotals).reduce((sum, val) => sum + val, 0);

  // Get store color
  const getStoreColor = (store) => store.color || '#64748b';

  // Month name for header
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                      'July', 'August', 'September', 'October', 'November', 'December'];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Table className="w-5 h-5" />
            Daily Deliveries by Store - {monthNames[selectedMonth - 1]} {selectedYear}
          </CardTitle>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={payPeriod === 'weekly' ? 'default' : 'outline'}
              onClick={() => onPayPeriodChange('weekly')}
              className="text-xs h-7 px-2"
            >
              Weekly
            </Button>
            <Button
              size="sm"
              variant={payPeriod === 'biweekly' ? 'default' : 'outline'}
              onClick={() => onPayPeriodChange('biweekly')}
              className="text-xs h-7 px-2"
            >
              Bi-Weekly
            </Button>
            <Button
              size="sm"
              variant={payPeriod === 'semimonthly' ? 'default' : 'outline'}
              onClick={() => onPayPeriodChange('semimonthly')}
              className="text-xs h-7 px-2"
            >
              Semi-Monthly
            </Button>
            <Button
              size="sm"
              variant={payPeriod === 'monthly' ? 'default' : 'outline'}
              onClick={() => onPayPeriodChange('monthly')}
              className="text-xs h-7 px-2"
            >
              Monthly
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-slate-50">
                <th className="text-left p-2 font-medium text-slate-600 sticky left-0 bg-slate-50 z-10">Day</th>
                {sortedStores.map((store) => (
                  <th
                    key={store.id}
                    className="text-center p-2 font-bold min-w-[50px]"
                    style={{ color: getStoreColor(store) }}
                    title={store.name}
                  >
                    {store.abbreviation || store.name?.substring(0, 2)}
                  </th>
                ))}
                <th className="text-center p-2 font-bold text-slate-900 border-l-2 border-purple-300 min-w-[60px]">Tot</th>
              </tr>
            </thead>
            <tbody>
              {days.map((day) => {
                const dayTotal = getDayTotal(day);
                const dateObj = new Date(selectedYear, selectedMonth - 1, day);
                const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
                const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;
                
                return (
                  <tr 
                    key={day} 
                    className={`border-b hover:bg-slate-50 ${isWeekend ? 'bg-slate-50' : ''}`}
                  >
                    <td
                      className={`p-2 font-medium sticky left-0 z-10 ${isWeekend ? 'bg-slate-50' : 'bg-white'}`}
                      style={{ color: '#475569' }}
                    >
                      {day} <span className="text-slate-400 text-[10px]">{dayOfWeek}</span>
                    </td>
                    {sortedStores.map((store) => {
                      const value = dataMap[day][store.id] || 0;
                      return (
                        <td
                          key={store.id}
                          className="text-center p-2 tabular-nums"
                          style={{ color: value > 0 ? getStoreColor(store) : '#94a3b8' }}
                        >
                          {value > 0 ? value : ''}
                        </td>
                      );
                    })}
                    <td className="text-center p-2 font-semibold text-slate-900 border-l-2 border-purple-300 tabular-nums">
                      {dayTotal > 0 ? dayTotal : ''}
                    </td>
                  </tr>
                );
              })}
              {/* Totals Row */}
              <tr className="border-t-2 border-slate-300 bg-slate-100 font-semibold">
                <td className="p-2 text-slate-700 sticky left-0 bg-slate-100 z-10">Tot</td>
                {sortedStores.map((store) => (
                  <td
                    key={store.id}
                    className="text-center p-2 tabular-nums"
                    style={{ color: getStoreColor(store) }}
                  >
                    {storeTotals[store.id] > 0 ? storeTotals[store.id] : ''}
                  </td>
                ))}
                <td className="text-center p-2 font-bold text-slate-900 border-l-2 border-purple-300 tabular-nums">
                  {grandTotal}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}