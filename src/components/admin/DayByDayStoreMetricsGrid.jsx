import React from 'react';
import { Card, CardContent } from '@/components/ui/card';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Day-by-Day Store Metrics Grid
 * Shows billable + non-billable deliveries per day for the entire selected month
 * Uses the daily delivery data aggregated across all stores and drivers
 */
export default function DayByDayStoreMetricsGrid({ metricsData, selectedMonth, selectedYear, selectedCityId }) {
  if (!metricsData || !selectedMonth) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-slate-500">Select a month to view day-by-day breakdown</p>
        </CardContent>
      </Card>
    );
  }

  const stores = metricsData.stores || [];
  const monthlyByStore = metricsData.monthlyByStore?.[selectedMonth] || {};
  const daysInMonth = new Date(parseInt(selectedYear), selectedMonth, 0).getDate();

  // Create a map of day -> store -> total
  const dataByDayAndStore = new Map();
  
  // Organize data by day and store
  stores.forEach(store => {
    const storeData = monthlyByStore[store.id];
    if (storeData && storeData.dailyBreakdown) {
      storeData.dailyBreakdown.forEach(dayData => {
        if (!dataByDayAndStore.has(dayData.day)) {
          dataByDayAndStore.set(dayData.day, new Map());
        }
        const total = (dayData.billable || 0) + (dayData.nonBillable || 0);
        dataByDayAndStore.get(dayData.day).set(store.id, total);
      });
    }
  });

  // Calculate totals per store
  const getStoreTotal = (storeId) => {
    const storeData = monthlyByStore[storeId];
    if (storeData) {
      return (storeData.billable || 0) + (storeData.nonBillable || 0);
    }
    return 0;
  };

  const grandTotal = stores.reduce((sum, store) => sum + getStoreTotal(store.id), 0);

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-slate-50">
                <th className="text-left p-2 font-medium text-slate-600 sticky left-0 bg-slate-50 z-10">Day</th>
                {stores.map(store => (
                  <th
                    key={store.id}
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
              {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((day) => {
                const dayStoreMap = dataByDayAndStore.get(day) || new Map();
                let dayTotal = 0;
                stores.forEach(store => {
                  const data = dayStoreMap.get(store.id);
                  if (data) {
                    dayTotal += (data.billable || 0) + (data.nonBillable || 0);
                  }
                });
                return (
                  <tr key={day} className="border-b hover:bg-slate-50">
                    <td className="p-2 font-medium sticky left-0 bg-white z-10 text-slate-700">
                      {day}
                    </td>
                    {stores.map(store => {
                      const data = dayStoreMap.get(store.id);
                      const value = data ? (data.billable || 0) + (data.nonBillable || 0) : 0;
                      return (
                        <td
                          key={store.id}
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
                <td className="p-2 text-slate-700 sticky left-0 bg-slate-100 z-10">Total</td>
                {stores.map(store => {
                  const total = getStoreTotal(store.id);
                  return (
                    <td
                      key={store.id}
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
                  const total = getStoreTotal(store.id);
                  const avg = total > 0 ? (total / daysInMonth).toFixed(1) : '';
                  return (
                    <td key={store.id} className="text-center p-2 tabular-nums text-slate-600">
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