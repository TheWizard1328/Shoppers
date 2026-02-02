import React from 'react';
import { Card, CardContent } from '@/components/ui/card';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Day-by-Day Store Metrics Grid
 * Shows billable + non-billable deliveries per day for each store in the selected month
 */
export default function DayByDayStoreMetricsGrid({ metricsData, selectedMonth, selectedYear, selectedStoreMonth, onResetView }) {
  if (!metricsData || !selectedMonth || !selectedStoreMonth) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-slate-500">Click a store in the monthly grid to view day-by-day breakdown</p>
        </CardContent>
      </Card>
    );
  }

  const { month, storeId, abbreviation, name } = selectedStoreMonth;
  
  // Get the daily breakdown for this store
  const monthlyStoreData = metricsData.monthlyStoreData || {};
  const monthData = monthlyStoreData[month] || [];
  const storeData = monthData.find(s => s.storeId === storeId || s.id === storeId);

  if (!storeData || !storeData.dailyBreakdown) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-slate-500">No daily breakdown available for {name}</p>
        </CardContent>
      </Card>
    );
  }

  const daysInMonth = new Date(parseInt(selectedYear), month, 0).getDate();
  const dailyData = storeData.dailyBreakdown;

  // Create a map of day -> data
  const dataByDay = new Map(dailyData.map(d => [d.day, d]));

  // Calculate totals
  let monthTotal = 0;
  dailyData.forEach(d => {
    monthTotal += (d.billable || 0) + (d.nonBillable || 0);
  });

  return (
    <Card>
      <CardContent className="p-0">
        <div className="mb-2 px-4 pt-4 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-slate-900">{name} - {MONTH_NAMES[month - 1]} Daily Breakdown</h3>
            <p className="text-xs text-slate-500">Total: {monthTotal} deliveries</p>
          </div>
          {(month || storeId) &&
            <button
              onClick={() => onResetView?.()}
              className="text-xs px-3 py-1 border border-slate-300 rounded hover:bg-slate-100 transition-colors"
            >
              Back
            </button>
          }
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-slate-50">
                <th className="text-left p-2 font-medium text-slate-600 sticky left-0 bg-slate-50 z-10">Day</th>
                <th className="text-center p-2 font-bold min-w-[60px] text-emerald-600">Billable</th>
                <th className="text-center p-2 font-bold min-w-[60px] text-orange-600">Non-Bill</th>
                <th className="text-center p-2 font-bold text-slate-900 border-l-2 border-slate-300 min-w-[60px]">Total</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((day) => {
                const dayData = dataByDay.get(day) || { billable: 0, nonBillable: 0 };
                const total = (dayData.billable || 0) + (dayData.nonBillable || 0);
                return (
                  <tr key={day} className="border-b hover:bg-slate-50">
                    <td className="p-2 font-medium sticky left-0 bg-white z-10 text-slate-700">
                      {day}
                    </td>
                    <td className="text-center p-2 tabular-nums text-emerald-600 font-medium">
                      {dayData.billable || ''}
                    </td>
                    <td className="text-center p-2 tabular-nums text-orange-600 font-medium">
                      {dayData.nonBillable || ''}
                    </td>
                    <td className="text-center p-2 font-semibold text-slate-900 border-l-2 border-slate-300 tabular-nums">
                      {total > 0 ? total : ''}
                    </td>
                  </tr>
                );
              })}
              
              {/* Totals Row */}
              <tr className="border-t-2 border-slate-300 bg-slate-100 font-semibold">
                <td className="p-2 text-slate-700 sticky left-0 bg-slate-100 z-10">Total</td>
                <td className="text-center p-2 tabular-nums text-emerald-600">
                  {storeData.billable || ''}
                </td>
                <td className="text-center p-2 tabular-nums text-orange-600">
                  {storeData.nonBillable || ''}
                </td>
                <td className="text-center p-2 font-bold text-slate-900 border-l-2 border-slate-300 tabular-nums">
                  {monthTotal}
                </td>
              </tr>

              {/* Average Row */}
              <tr className="bg-slate-50">
                <td className="p-2 text-slate-600 sticky left-0 bg-slate-50 z-10">Avg</td>
                <td className="text-center p-2 tabular-nums text-slate-600">
                  {storeData.billable > 0 ? (storeData.billable / daysInMonth).toFixed(1) : ''}
                </td>
                <td className="text-center p-2 tabular-nums text-slate-600">
                  {storeData.nonBillable > 0 ? (storeData.nonBillable / daysInMonth).toFixed(1) : ''}
                </td>
                <td className="text-center p-2 font-semibold text-slate-700 border-l-2 border-slate-300 tabular-nums">
                  {(monthTotal / daysInMonth).toFixed(1)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}