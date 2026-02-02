import React, { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Package, Ruler } from 'lucide-react';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Day-by-Day Store Metrics Grid
 * Shows daily totals (billable + non-billable) for each store across all days in selected month
 * Top row: Store abbreviations | Left column: Days 1-31
 */
export default function DayByDayStoreMetricsGrid({ metricsData, selectedMonth, selectedYear, onResetView }) {
  const [viewMode, setViewMode] = useState('deliveries'); // 'deliveries' or 'extra_km'
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
  const dailyStoreData = metricsData.dailyStoreData?.[selectedMonth] || {};

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

  // Helper: Get daily value (total) for a store and day
  const getDayValue = (storeId, day, mode = 'deliveries') => {
    const storeDaily = dailyStoreData[storeId] || [];
    const dayData = storeDaily.find(d => d.day === day);
    if (!dayData) return 0;
    
    if (mode === 'extra_km') {
      return dayData.extra_km || 0;
    }
    // deliveries mode
    return (dayData.completed || 0) + (dayData.failed || 0) + (dayData.afterHours || 0);
  };

  // Calculate day totals (sum across all stores for each day)
  const getDayTotal = (day, mode = 'deliveries') => {
    return stores.reduce((sum, store) => sum + getDayValue(store.storeId || store.id, day, mode), 0);
  };

  // Calculate store totals (sum across all days for each store)
  const getStoreTotal = (store, mode = 'deliveries') => {
    const storeDaily = dailyStoreData[store.storeId || store.id] || [];
    if (mode === 'extra_km') {
      return storeDaily.reduce((sum, day) => sum + (day.extra_km || 0), 0);
    }
    // deliveries mode
    return storeDaily.reduce((sum, day) => sum + (day.completed || 0) + (day.failed || 0) + (day.afterHours || 0), 0);
  };

  const grandTotal = stores.reduce((sum, store) => sum + getStoreTotal(store, viewMode), 0);

  return (
    <Card>
      <CardContent className="p-0">
        <div className="mb-2 px-4 pt-4 flex items-center justify-between">
          <h3 className="font-semibold text-slate-900">
            {viewMode === 'deliveries' ? 'Daily Deliveries' : 'Daily Extra Km'} - {MONTH_NAMES[selectedMonth - 1]} {selectedYear}
          </h3>
          <div className="flex gap-1 rounded-lg p-0.5 flex-shrink-0" style={{ background: 'var(--bg-slate-100)' }}>
            <Button 
              size="sm" 
              variant={viewMode === 'deliveries' ? 'default' : 'ghost'} 
              onClick={() => setViewMode('deliveries')} 
              className="text-xs h-6 px-2 gap-1"
            >
              <Package className="w-3 h-3" />Deliveries
            </Button>
            <Button 
              size="sm" 
              variant={viewMode === 'extra_km' ? 'default' : 'ghost'} 
              onClick={() => setViewMode('extra_km')} 
              className="text-xs h-6 px-2 gap-1"
            >
              <Ruler className="w-3 h-3" />Extra KM
            </Button>
          </div>
        </div>
        <div className="overflow-x-auto w-full">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-slate-50">
                <th className="text-left px-1.5 py-0.5 font-medium text-slate-600 sticky left-0 bg-slate-50 z-10 min-w-[35px]">Day</th>
                {stores.map(store => (
                  <th
                    key={store.storeId || store.id}
                    className="text-center px-1 py-0.5 font-bold min-w-[40px]"
                    style={{ color: store.color || '#64748b' }}
                    title={store.name}
                  >
                    {store.abbreviation}
                  </th>
                ))}
                <th className="text-center px-1 py-0.5 font-bold text-slate-900 border-l-2 border-slate-300 min-w-[45px]">Tot</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(day => {
                const dayTotal = getDayTotal(day, viewMode);
                return (
                  <tr key={day} className="border-b hover:bg-slate-50">
                    <td className="px-1.5 py-0.5 font-medium sticky left-0 bg-white z-10 text-slate-700">
                      {day}
                    </td>
                    {stores.map(store => {
                      const value = getDayValue(store.storeId || store.id, day, viewMode);
                      return (
                        <td
                          key={store.storeId || store.id}
                          className="text-center px-1 py-0.5 tabular-nums"
                          style={{ color: value > 0 ? (store.color || '#64748b') : '#94a3b8' }}
                        >
                          {value > 0 ? (viewMode === 'extra_km' ? value.toFixed(1) : value) : ''}
                        </td>
                      );
                    })}
                    <td className="text-center px-1 py-0.5 font-semibold text-slate-900 border-l-2 border-slate-300 tabular-nums">
                      {dayTotal > 0 ? (viewMode === 'extra_km' ? dayTotal.toFixed(1) : dayTotal) : ''}
                    </td>
                  </tr>
                );
              })}

              {/* Totals Row */}
              <tr className="border-t-2 border-slate-300 bg-slate-100 font-semibold">
                <td className="px-1.5 py-0.5 text-slate-700 sticky left-0 bg-slate-100 z-10">Tot</td>
                {stores.map(store => {
                  const total = getStoreTotal(store, viewMode);
                  return (
                    <td
                      key={store.storeId || store.id}
                      className="text-center px-1 py-0.5 tabular-nums"
                      style={{ color: store.color || '#64748b' }}
                    >
                      {total > 0 ? (viewMode === 'extra_km' ? total.toFixed(1) : total) : ''}
                    </td>
                  );
                })}
                <td className="text-center px-1 py-0.5 font-bold text-slate-900 border-l-2 border-slate-300 tabular-nums">
                  {grandTotal > 0 ? (viewMode === 'extra_km' ? grandTotal.toFixed(1) : grandTotal) : ''}
                </td>
              </tr>

              {/* Average Row */}
              <tr className="bg-slate-50">
                <td className="px-1.5 py-0.5 text-slate-600 sticky left-0 bg-slate-50 z-10">Avg</td>
                {stores.map(store => {
                  const total = getStoreTotal(store, viewMode);
                  const avg = total > 0 ? (total / daysInMonth).toFixed(1) : '';
                  return (
                    <td key={store.storeId || store.id} className="text-center px-1 py-0.5 tabular-nums text-slate-600">
                      {avg}
                    </td>
                  );
                })}
                <td className="text-center px-1 py-0.5 font-semibold text-slate-700 border-l-2 border-slate-300 tabular-nums">
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