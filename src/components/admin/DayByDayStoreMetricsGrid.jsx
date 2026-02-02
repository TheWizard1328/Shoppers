import React, { useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Day-by-Day Store Metrics Grid
 * Shows billable deliveries per store per day for an entire selected month
 * Similar to payroll grid but for all drivers and filtered by city
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

  // Build stores list and day-by-day data from metricsData
  const dailyStoreData = metricsData.dailyStoreData?.[selectedMonth] || {};
  const storeMap = new Map();
  const storeDataByDay = new Map(); // { storeId: { day: value, ... }, ... }
  
  // Get all stores and their data from the nested structure
  Object.entries(dailyStoreData).forEach(([storeId, dayArray]) => {
    if (!Array.isArray(dayArray)) return;
    
    // Get store info from first record
    const firstRecord = dayArray[0];
    if (firstRecord?.abbreviation && !storeMap.has(storeId)) {
      storeMap.set(storeId, {
        storeId,
        abbreviation: firstRecord.abbreviation,
        name: firstRecord.name,
        color: firstRecord.color,
        sortOrder: firstRecord.sortOrder || 999
      });
    }
    
    // Build day-by-day map for this store
    const dayMap = {};
    dayArray.forEach(dayRecord => {
      if (dayRecord?.day) {
        // Billable = Completed + After Hours
        dayMap[dayRecord.day] = (dayRecord.completed || 0) + (dayRecord.afterHours || 0);
      }
    });
    storeDataByDay.set(storeId, dayMap);
  });

  const stores = Array.from(storeMap.values()).sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity));
  const daysInMonth = new Date(parseInt(selectedYear), selectedMonth, 0).getDate();

  // Get billable value for a store on a specific day
  // Billable = Completed + Failed + After Hours Pickups (Completed & Cancelled)
  const getBillableValue = (storeId, day) => {
    const dayData = dailyStoreData[storeId];
    if (!dayData || !Array.isArray(dayData)) return null;
    
    const dayRecord = dayData.find(d => d.day === day);
    if (!dayRecord) return null;
    
    // All billable: Completed + Failed + After Hours
    const billable = (dayRecord.completed || 0) + (dayRecord.failed || 0) + (dayRecord.afterHours || 0);
    return billable > 0 ? billable : null;
  };

  // Calculate totals per store
  const getStoreTotal = (storeId) => {
    const dayMap = storeDataByDay.get(storeId);
    return dayMap ? Object.values(dayMap).reduce((sum, v) => sum + (v || 0), 0) : 0;
  };

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