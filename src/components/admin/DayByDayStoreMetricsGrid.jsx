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

  // Use the pre-calculated daily delivery data (billable + non-billable)
  const dailyDeliveryData = metricsData.dailyDeliveryData?.[selectedMonth] || [];
  const daysInMonth = new Date(parseInt(selectedYear), selectedMonth, 0).getDate();

  // Create a map of day -> { billable, nonBillable }
  const dataByDay = new Map(dailyDeliveryData.map(d => [d.day, d]));

  // Calculate totals
  const totalBillable = dailyDeliveryData.reduce((sum, d) => sum + (d.billable || 0), 0);
  const totalNonBillable = dailyDeliveryData.reduce((sum, d) => sum + (d.nonBillable || 0), 0);
  const grandTotal = totalBillable + totalNonBillable;

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-slate-50">
                <th className="text-left p-2 font-medium text-slate-600 sticky left-0 bg-slate-50 z-10">Day</th>
                <th className="text-center p-2 font-bold min-w-[60px] text-emerald-600">Billable</th>
                <th className="text-center p-2 font-bold min-w-[60px] text-orange-600">Non-Billable</th>
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
                  {totalBillable > 0 ? totalBillable : ''}
                </td>
                <td className="text-center p-2 tabular-nums text-orange-600">
                  {totalNonBillable > 0 ? totalNonBillable : ''}
                </td>
                <td className="text-center p-2 font-bold text-slate-900 border-l-2 border-slate-300 tabular-nums">
                  {grandTotal > 0 ? grandTotal : ''}
                </td>
              </tr>

              {/* Average Row */}
              <tr className="bg-slate-50">
                <td className="p-2 text-slate-600 sticky left-0 bg-slate-50 z-10">Avg/Day</td>
                <td className="text-center p-2 tabular-nums text-slate-600">
                  {totalBillable > 0 ? (totalBillable / daysInMonth).toFixed(1) : ''}
                </td>
                <td className="text-center p-2 tabular-nums text-slate-600">
                  {totalNonBillable > 0 ? (totalNonBillable / daysInMonth).toFixed(1) : ''}
                </td>
                <td className="text-center p-2 font-semibold text-slate-700 border-l-2 border-slate-300 tabular-nums">
                  {grandTotal > 0 ? (grandTotal / daysInMonth).toFixed(1) : ''}
                </td>
              </tr>

              {/* Projection Row */}
              <tr className="bg-slate-50">
                <td className="p-2 text-slate-600 sticky left-0 bg-slate-50 z-10">Proj/Mo</td>
                <td className="text-center p-2 tabular-nums font-medium text-emerald-600">
                  {totalBillable > 0 ? totalBillable : ''}
                </td>
                <td className="text-center p-2 tabular-nums font-medium text-orange-600">
                  {totalNonBillable > 0 ? totalNonBillable : ''}
                </td>
                <td className="text-center p-2 font-bold text-slate-900 border-l-2 border-slate-300 tabular-nums">
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