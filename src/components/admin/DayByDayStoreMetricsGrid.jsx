import React from 'react';
import { Card, CardContent } from '@/components/ui/card';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Day-by-Day Store Metrics Grid
 * Shows daily totals (billable + non-billable) for each store across all days in selected month
 * Top row: Store abbreviations | Left column: Days 1-31
 */
export default function DayByDayStoreMetricsGrid({ metricsData, selectedMonth, selectedYear, onResetView }) {
  if (!metricsData || !selectedMonth) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-slate-500">Click a month name in the monthly grid to view day-by-day breakdown</p>
        </CardContent>
      </Card>
    );
  }

  const monthlyStoreData = metricsData.monthlyStoreData || {};
  const monthData = monthlyStoreData[selectedMonth] || [];
  const daysInMonth = new Date(parseInt(selectedYear), selectedMonth, 0).getDate();

  // Build stores list from this month's data
  const stores = monthData.sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
  
  if (!stores.length) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-slate-500">No data available for {MONTH_NAMES[selectedMonth - 1]} {selectedYear}</p>
        </CardContent>
      </Card>
    );
  }

  // Helper: Get daily data for a store and day
  const getDayValue = (store, day) => {
    if (!store.dailyBreakdown) return 0;
    const dayData = store.dailyBreakdown.find(d => d.day === day);
    if (!dayData) return 0;
    return (dayData.billable || 0) + (dayData.nonBillable || 0);
  };

  // Calculate day totals (sum across all stores for each day)
  const getDayTotal = (day) => {
    return stores.reduce((sum, store) => sum + getDayValue(store, day), 0);
  };

  // Calculate store totals (sum across all days for each store)
  const getStoreTotal = (store) => {
    return (store.billable || 0) + (store.nonBillable || 0);
  };

  const grandTotal = stores.reduce((sum, store) => sum + getStoreTotal(store), 0);

  return (
    <Card>
      <CardContent className="p-0">
        <div className="mb-2 px-4 pt-4 flex items-center justify-between">
          <h3 className="font-semibold text-slate-900">
            Daily Deliveries - {MONTH_NAMES[selectedMonth - 1]} {selectedYear}
          </h3>
          {selectedMonth &&
            <button
              onClick={() => onResetView?.()}
              className="text-xs px-3 py-1 border border-slate-300 rounded hover:bg-slate-100 transition-colors"
            >
              Reset View
            </button>
          }
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-slate-50">
                <th className="text-left p-2 font-medium text-slate-600 sticky left-0 bg-slate-50 z-10 min-w-[40px]">Day</th>
                {stores.map(store => (
                  <th
                    key={store.storeId || store.id}
                    className="text-center p-2 font-bold min-w-[50px]"
                    style={{ color: store.color || '#64748b' }}
                    title={store.name}
                  >
                    {store.abbreviation}
                  </th>
                ))}
                <th className="text-center p-2 font-bold text-slate-900 border-l-2 border-slate-300 min-w-[60px]">Total</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(day => {
                const dayTotal = getDayTotal(day);
                return (
                  <tr key={day} className="border-b hover:bg-slate-50">
                    <td className="p-2 font-medium sticky left-0 bg-white z-10 text-slate-700">
                      {day}
                    </td>
                    {stores.map(store => {
                      const value = getDayValue(store, day);
                      return (
                        <td
                          key={store.storeId || store.id}
                          className="text-center p-2 tabular-nums"
                          style={{ color: value > 0 ? (store.color || '#64748b') : '#94a3b8' }}
                        >
                          {value > 0 ? value : ''}
                        </td>
                      );
                    })}
                    <td className="text-center p-2 font-semibold text-slate-900 border-l-2 border-slate-300 tabular-nums">
                      {dayTotal > 0 ? dayTotal : ''}
                    </td>
                  </tr>
                );
              })}

              {/* Totals Row */}
              <tr className="border-t-2 border-slate-300 bg-slate-100 font-semibold">
                <td className="p-2 text-slate-700 sticky left-0 bg-slate-100 z-10">Tot</td>
                {stores.map(store => {
                  const total = getStoreTotal(store);
                  return (
                    <td
                      key={store.storeId || store.id}
                      className="text-center p-2 tabular-nums"
                      style={{ color: store.color || '#64748b' }}
                    >
                      {total > 0 ? total : ''}
                    </td>
                  );
                })}
                <td className="text-center p-2 font-bold text-slate-900 border-l-2 border-slate-300 tabular-nums">
                  {grandTotal > 0 ? grandTotal : ''}
                </td>
              </tr>

              {/* Average Row */}
              <tr className="bg-slate-50">
                <td className="p-2 text-slate-600 sticky left-0 bg-slate-50 z-10">Avg</td>
                {stores.map(store => {
                  const total = getStoreTotal(store);
                  const avg = total > 0 ? (total / daysInMonth).toFixed(1) : '';
                  return (
                    <td key={store.storeId || store.id} className="text-center p-2 tabular-nums text-slate-600">
                      {avg}
                    </td>
                  );
                })}
                <td className="text-center p-2 font-semibold text-slate-700 border-l-2 border-slate-300 tabular-nums">
                  {grandTotal > 0 ? (grandTotal / daysInMonth).toFixed(1) : ''}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}