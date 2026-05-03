import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Package, Ruler } from 'lucide-react';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Day-by-Day Store Metrics Grid
 * Shows daily totals (billable + non-billable) for each store across all days in selected month
 * Top row: Store abbreviations | Left column: Days 1-31
 */
export default function DayByDayStoreMetricsGrid({ metricsData, selectedMonth, selectedYear, metricsViewMode = 'deliveries', onResetView }) {
  const viewMode = metricsViewMode;
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
  const monthlyStoreFees = metricsData.monthlyStoreFees || {};
  const monthlyStoreExtraKm = metricsData.monthlyStoreExtraKm || {};

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

    if (mode === 'fees') {
      const monthStore = monthData.find((store) => (store.storeId || store.id) === storeId);
      const fallbackFee = (monthlyStoreFees[selectedMonth] || []).find((store) => (store.storeId || store.id) === storeId);
      const monthTotalFees = monthStore?.fees ?? fallbackFee?.fees ?? fallbackFee?.total_fees ?? 0;
      const monthTotalDeliveries = (monthStore?.completed || 0) + (monthStore?.failed || 0) + (monthStore?.afterHours || 0);
      const dayTotalDeliveries = (dayData.completed || 0) + (dayData.failed || 0) + (dayData.afterHours || 0);
      if (monthTotalFees <= 0 || monthTotalDeliveries <= 0 || dayTotalDeliveries <= 0) return 0;
      return monthTotalFees * (dayTotalDeliveries / monthTotalDeliveries);
    }

    return (dayData.completed || 0) + (dayData.failed || 0) + (dayData.afterHours || 0);
  };

  // Calculate day totals (sum across all stores for each day)
  const getDayTotal = (day, mode = 'deliveries') => {
    return stores.reduce((sum, store) => sum + getDayValue(store.storeId || store.id, day, mode), 0);
  };

  // Calculate store totals (sum across all days for each store)
  const getStoreTotal = (store, mode = 'deliveries') => {
    const storeId = store.storeId || store.id;
    const storeDaily = dailyStoreData[storeId] || [];
    if (mode === 'extra_km') {
      const fallbackKm = (monthlyStoreExtraKm[selectedMonth] || []).find((item) => (item.storeId || item.id) === storeId);
      return fallbackKm?.extra_km ?? storeDaily.reduce((sum, day) => sum + (day.extra_km || 0), 0);
    }
    if (mode === 'fees') {
      const fallbackFee = (monthlyStoreFees[selectedMonth] || []).find((item) => (item.storeId || item.id) === storeId);
      return store.fees ?? fallbackFee?.fees ?? fallbackFee?.total_fees ?? 0;
    }
    return storeDaily.reduce((sum, day) => sum + (day.completed || 0) + (day.failed || 0) + (day.afterHours || 0), 0);
  };

  const grandTotal = stores.reduce((sum, store) => sum + getStoreTotal(store, viewMode), 0);

  // Helper: Check if a day is a weekend (Saturday=6 or Sunday=0)
  const isWeekend = (day) => {
    const date = new Date(parseInt(selectedYear), selectedMonth - 1, day);
    const dayOfWeek = date.getDay();
    return dayOfWeek === 0 || dayOfWeek === 6;
  };

  return (
    <Card className="overflow-visible">
      <CardContent className="p-0 overflow-visible">
        <div className="w-full overflow-x-auto overflow-y-visible">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-slate-50">
                <th className="text-left px-1.5 py-0.5 font-medium text-slate-600 sticky left-0 bg-slate-50 z-10 min-w-[35px] border-r border-slate-300">Day</th>
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
                const weekend = isWeekend(day);
                return (
                  <tr key={day} className={`border-b hover:bg-slate-50 ${weekend ? 'bg-slate-100' : ''}`}>
                    <td className={`px-1.5 py-0.5 font-medium sticky left-0 border-r border-slate-300 z-10 text-slate-700 ${weekend ? 'bg-slate-100' : 'bg-white'}`}>
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
                          {value > 0 ? Number(value).toFixed(2) : ''}
                        </td>
                      );
                    })}
                    <td className="text-center px-1 py-0.5 font-semibold text-slate-900 border-l-2 border-slate-300 tabular-nums">
                      {dayTotal > 0 ? Number(dayTotal).toFixed(2) : ''}
                    </td>
                  </tr>
                );
              })}

              {/* Totals Row */}
              <tr className="border-t-2 border-slate-300 bg-slate-100 font-semibold">
                <td className="px-1.5 py-0.5 text-slate-700 sticky left-0 bg-slate-100 z-10 border-r border-slate-300">Tot</td>
                {stores.map(store => {
                  const total = getStoreTotal(store, viewMode);
                  return (
                    <td
                      key={store.storeId || store.id}
                      className="text-center px-1 py-0.5 tabular-nums"
                      style={{ color: store.color || '#64748b' }}
                    >
                      {total > 0 ? Number(total).toFixed(2) : ''}
                    </td>
                  );
                })}
                <td className="text-center px-1 py-0.5 font-bold text-slate-900 border-l-2 border-slate-300 tabular-nums">
                  {grandTotal > 0 ? Number(grandTotal).toFixed(2) : ''}
                </td>
              </tr>

              {/* Average Row */}
              <tr className="bg-slate-50">
                <td className="px-1.5 py-0.5 text-slate-600 sticky left-0 bg-slate-50 z-10 border-r border-slate-300">Avg</td>
                {stores.map(store => {
                   const total = getStoreTotal(store, viewMode);
                   const avg = total > 0 ? Number(total / daysInMonth).toFixed(2) : '';
                   return (
                     <td key={store.storeId || store.id} className="text-center px-1 py-0.5 tabular-nums text-slate-600">
                       {avg}
                     </td>
                   );
                 })}
                 <td className="text-center px-1 py-0.5 font-semibold text-slate-700 border-l-2 border-slate-300 tabular-nums">
                   {grandTotal > 0 ? Number(grandTotal / daysInMonth).toFixed(2) : ''}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}