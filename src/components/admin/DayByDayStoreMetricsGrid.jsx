import React, { useMemo } from 'react';
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

  // Use the pre-calculated daily delivery data (billable + non-billable)
  const dailyDeliveryData = metricsData.dailyDeliveryData?.[selectedMonth] || [];
  const daysInMonth = new Date(parseInt(selectedYear), selectedMonth, 0).getDate();

  // Create a map of day -> { billable, nonBillable }
  const dataByDay = new Map(dailyDeliveryData.map(d => [d.day, d]));

  // Calculate totals
  const totalBillable = dailyDeliveryData.reduce((sum, d) => sum + (d.billable || 0), 0);
  const totalNonBillable = dailyDeliveryData.reduce((sum, d) => sum + (d.nonBillable || 0), 0);
  const grandTotal = totalBillable + totalNonBillable;

  // Calculate daily totals
  const getDayTotal = (day) => {
    let total = 0;
    stores.forEach(store => {
      const value = getBillableValue(store.storeId, day);
      if (value !== null) {
        total += value;
      }
    });
    return total;
  };

  // Get grand total
  const grandTotal = stores.reduce((sum, store) => sum + getStoreTotal(store.storeId), 0);

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-slate-50">
                <th className="text-left p-2 font-medium text-slate-600 sticky left-0 bg-slate-50 z-10">Day</th>
                {stores.map((store) => (
                  <th
                    key={store.storeId}
                    className="text-center p-2 font-bold min-w-[50px]"
                    style={{ color: store.color || '#64748b' }}
                    title={store.name}
                  >
                    {store.abbreviation}
                  </th>
                ))}
                <th className="text-center p-2 font-bold text-slate-900 border-l-2 border-purple-300 min-w-[60px]">Tot</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((day) => {
                const dayTotal = getDayTotal(day);
                return (
                  <tr key={day} className="border-b hover:bg-slate-50">
                    <td className="p-2 font-medium sticky left-0 bg-white z-10 text-slate-700">
                      {day}
                    </td>
                    {stores.map((store) => {
                      const value = getBillableValue(store.storeId, day);
                      return (
                        <td
                          key={store.storeId}
                          className="text-center p-2 tabular-nums"
                          style={{ color: value !== null && value > 0 ? (store.color || '#64748b') : '#94a3b8' }}
                        >
                          {value !== null ? value : ''}
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
                {stores.map((store) => {
                  const total = getStoreTotal(store.storeId);
                  return (
                    <td
                      key={store.storeId}
                      className="text-center p-2 tabular-nums"
                      style={{ color: store.color || '#64748b' }}
                    >
                      {total > 0 ? total : ''}
                    </td>
                  );
                })}
                <td className="text-center p-2 font-bold text-slate-900 border-l-2 border-purple-300 tabular-nums">
                  {grandTotal > 0 ? grandTotal : ''}
                </td>
              </tr>

              {/* Average Row */}
              <tr className="bg-slate-50">
                <td className="p-2 text-slate-600 sticky left-0 bg-slate-50 z-10">AVG</td>
                {stores.map((store) => {
                  const total = getStoreTotal(store.storeId);
                  const avg = total > 0 ? (total / daysInMonth).toFixed(2) : '';
                  return (
                    <td
                      key={store.storeId}
                      className="text-center p-2 tabular-nums text-slate-600"
                    >
                      {avg}
                    </td>
                  );
                })}
                <td className="text-center p-2 font-semibold text-slate-700 border-l-2 border-purple-300 tabular-nums">
                  {grandTotal > 0 ? (grandTotal / daysInMonth).toFixed(2) : ''}
                </td>
              </tr>

              {/* Projection Row - same as totals */}
              <tr className="bg-slate-50">
                <td className="p-2 text-slate-600 sticky left-0 bg-slate-50 z-10">Proj</td>
                {stores.map((store) => {
                  const total = getStoreTotal(store.storeId);
                  return (
                    <td
                      key={store.storeId}
                      className="text-center p-2 tabular-nums font-medium"
                      style={{ color: store.color || '#64748b' }}
                    >
                      {total > 0 ? total : ''}
                    </td>
                  );
                })}
                <td className="text-center p-2 font-bold text-slate-900 border-l-2 border-purple-300 tabular-nums">
                  {grandTotal > 0 ? grandTotal : ''}
                </td>
              </tr>
              </tbody>
              </table>
              </div>
              </CardContent>
              </Card>
              );
              }