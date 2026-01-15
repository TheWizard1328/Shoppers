import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DollarSign, Download, Calculator } from 'lucide-react';

/**
 * Payroll Summary Card
 * Calculates and displays payroll totals based on pay period and driver rates
 */
export default function PayrollSummaryCard({
  deliveries,
  drivers,
  appUsers,
  selectedYear,
  selectedMonth,
  selectedDriverId,
  payPeriod
}) {
  // Find first Monday of the year
  const getFirstMondayOfYear = (year) => {
    const jan1 = new Date(year, 0, 1);
    const dayOfWeek = jan1.getDay();
    // 0 = Sunday, 1 = Monday, etc.
    const daysUntilMonday = dayOfWeek === 0 ? 1 : (dayOfWeek === 1 ? 0 : 8 - dayOfWeek);
    return new Date(year, 0, 1 + daysUntilMonday);
  };

  // Get pay period date ranges
  const getPayPeriodRanges = useMemo(() => {
    const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
    const monthStart = new Date(selectedYear, selectedMonth - 1, 1);
    const monthEnd = new Date(selectedYear, selectedMonth - 1, daysInMonth);
    const ranges = [];
    
    switch (payPeriod) {
      case 'weekly': {
        // 7-day cycles starting from first Monday of the year
        const firstMonday = getFirstMondayOfYear(selectedYear);
        
        // Find the week that contains the first day of this month
        const daysSinceFirstMonday = Math.floor((monthStart - firstMonday) / (1000 * 60 * 60 * 24));
        const weeksOffset = Math.floor(daysSinceFirstMonday / 7);
        let weekStart = new Date(firstMonday);
        weekStart.setDate(firstMonday.getDate() + (weeksOffset * 7));
        
        // If weekStart is after month start, go back one week
        if (weekStart > monthStart) {
          weekStart.setDate(weekStart.getDate() - 7);
        }
        
        let weekNum = 1;
        while (weekStart <= monthEnd) {
          const weekEnd = new Date(weekStart);
          weekEnd.setDate(weekStart.getDate() + 6);
          
          // Clip to month boundaries
          const rangeStart = weekStart < monthStart ? 1 : weekStart.getDate();
          const rangeEnd = weekEnd > monthEnd ? daysInMonth : weekEnd.getDate();
          
          // Only add if range is within this month
          if (rangeStart <= daysInMonth && rangeEnd >= 1) {
            const startMonth = weekStart.getMonth() + 1;
            const endMonth = weekEnd.getMonth() + 1;
            const label = startMonth === selectedMonth && endMonth === selectedMonth
              ? `Week ${weekNum} (${rangeStart}-${rangeEnd})`
              : `Week ${weekNum} (${rangeStart}-${rangeEnd})`;
            ranges.push({ start: rangeStart, end: rangeEnd, label });
            weekNum++;
          }
          
          weekStart.setDate(weekStart.getDate() + 7);
        }
        break;
      }
        
      case 'biweekly': {
        // 2-week cycles starting from first Monday of the year
        const firstMonday = getFirstMondayOfYear(selectedYear);
        
        // Find the bi-week that contains the first day of this month
        const daysSinceFirstMonday = Math.floor((monthStart - firstMonday) / (1000 * 60 * 60 * 24));
        const biweeksOffset = Math.floor(daysSinceFirstMonday / 14);
        let biweekStart = new Date(firstMonday);
        biweekStart.setDate(firstMonday.getDate() + (biweeksOffset * 14));
        
        // If biweekStart is after month start, go back one bi-week
        if (biweekStart > monthStart) {
          biweekStart.setDate(biweekStart.getDate() - 14);
        }
        
        let periodNum = 1;
        while (biweekStart <= monthEnd) {
          const biweekEnd = new Date(biweekStart);
          biweekEnd.setDate(biweekStart.getDate() + 13);
          
          // Clip to month boundaries
          const rangeStart = biweekStart < monthStart ? 1 : biweekStart.getDate();
          const rangeEnd = biweekEnd > monthEnd ? daysInMonth : biweekEnd.getDate();
          
          // Only add if range is within this month
          if (rangeStart <= daysInMonth && rangeEnd >= 1) {
            ranges.push({ 
              start: rangeStart, 
              end: rangeEnd, 
              label: `Period ${periodNum} (${rangeStart}-${rangeEnd})` 
            });
            periodNum++;
          }
          
          biweekStart.setDate(biweekStart.getDate() + 14);
        }
        break;
      }
        
      case 'semimonthly':
        // 1-15 and 16-end of month
        ranges.push({ start: 1, end: 15, label: '1st - 15th' });
        ranges.push({ start: 16, end: daysInMonth, label: `16th - ${daysInMonth}th` });
        break;
        
      case 'monthly':
      default:
        ranges.push({ start: 1, end: daysInMonth, label: 'Full Month' });
        break;
    }
    
    return ranges;
  }, [selectedYear, selectedMonth, payPeriod]);

  // Calculate payroll for each driver and period
  const payrollData = useMemo(() => {
    if (!deliveries || !drivers || !appUsers) return [];
    
    // Get drivers to calculate for
    const driversToCalc = selectedDriverId === 'all' 
      ? drivers.filter(d => d && d.status === 'active')
      : drivers.filter(d => d && d.id === selectedDriverId);
    
    return driversToCalc.map(driver => {
      // Get AppUser data for pay rates
      const appUser = appUsers.find(au => au && au.user_id === driver.id);
      const payRate = appUser?.pay_rate_per_delivery || 0;
      const extraKmRate = appUser?.extra_km_rate || 0;
      const extraKmLimit = appUser?.extra_km_limit || 0;
      const oversizedRate = appUser?.oversized_item_rate || 0;
      
      // Calculate for each period
      const periods = getPayPeriodRanges.map(range => {
        // Filter deliveries for this driver in this period
        const periodDeliveries = deliveries.filter(d => {
          if (!d || !d.delivery_date || d.status !== 'completed') return false;
          if (d.driver_id !== driver.id) return false;
          
          const date = new Date(d.delivery_date + 'T00:00:00');
          if (date.getFullYear() !== selectedYear) return false;
          if (date.getMonth() + 1 !== selectedMonth) return false;
          
          const day = date.getDate();
          return day >= range.start && day <= range.end;
        });
        
        const deliveryCount = periodDeliveries.length;
        const basePay = deliveryCount * payRate;
        
        // Calculate extra km pay
        let extraKmPay = 0;
        periodDeliveries.forEach(d => {
          const paidKm = d.paid_km_override || d.travel_dist || 0;
          if (paidKm > extraKmLimit && extraKmRate > 0) {
            extraKmPay += (paidKm - extraKmLimit) * extraKmRate;
          }
        });
        
        // Calculate oversized pay
        const oversizedCount = periodDeliveries.filter(d => d.oversized).length;
        const oversizedPay = oversizedCount * oversizedRate;
        
        const totalPay = basePay + extraKmPay + oversizedPay;
        
        return {
          label: range.label,
          deliveries: deliveryCount,
          basePay,
          extraKmPay,
          oversizedPay,
          totalPay
        };
      });
      
      // Grand totals
      const totalDeliveries = periods.reduce((sum, p) => sum + p.deliveries, 0);
      const totalBasePay = periods.reduce((sum, p) => sum + p.basePay, 0);
      const totalExtraKmPay = periods.reduce((sum, p) => sum + p.extraKmPay, 0);
      const totalOversizedPay = periods.reduce((sum, p) => sum + p.oversizedPay, 0);
      const grandTotal = periods.reduce((sum, p) => sum + p.totalPay, 0);
      
      return {
        driver,
        payRate,
        extraKmRate,
        extraKmLimit,
        oversizedRate,
        periods,
        totalDeliveries,
        totalBasePay,
        totalExtraKmPay,
        totalOversizedPay,
        grandTotal
      };
    });
  }, [deliveries, drivers, appUsers, selectedYear, selectedMonth, selectedDriverId, getPayPeriodRanges]);

  // Export to CSV
  const handleExport = () => {
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                        'July', 'August', 'September', 'October', 'November', 'December'];
    
    let csv = `Driver Payroll - ${monthNames[selectedMonth - 1]} ${selectedYear}\n`;
    csv += `Pay Period Type: ${payPeriod.charAt(0).toUpperCase() + payPeriod.slice(1)}\n\n`;
    
    payrollData.forEach(data => {
      csv += `Driver: ${data.driver.user_name || data.driver.full_name}\n`;
      csv += `Pay Rate: $${data.payRate.toFixed(2)}/delivery\n`;
      if (data.extraKmRate > 0) csv += `Extra KM Rate: $${data.extraKmRate.toFixed(2)}/km (after ${data.extraKmLimit} km)\n`;
      if (data.oversizedRate > 0) csv += `Oversized Rate: $${data.oversizedRate.toFixed(2)}/item\n`;
      csv += '\n';
      csv += 'Period,Deliveries,Base Pay,Extra KM Pay,Oversized Pay,Total\n';
      
      data.periods.forEach(period => {
        csv += `${period.label},${period.deliveries},$${period.basePay.toFixed(2)},$${period.extraKmPay.toFixed(2)},$${period.oversizedPay.toFixed(2)},$${period.totalPay.toFixed(2)}\n`;
      });
      
      csv += `TOTAL,${data.totalDeliveries},$${data.totalBasePay.toFixed(2)},$${data.totalExtraKmPay.toFixed(2)},$${data.totalOversizedPay.toFixed(2)},$${data.grandTotal.toFixed(2)}\n`;
      csv += '\n\n';
    });
    
    // Grand total across all drivers
    if (payrollData.length > 1) {
      const allDriversTotal = payrollData.reduce((sum, d) => sum + d.grandTotal, 0);
      csv += `GRAND TOTAL (All Drivers): $${allDriversTotal.toFixed(2)}\n`;
    }
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payroll_${selectedYear}_${String(selectedMonth).padStart(2, '0')}_${payPeriod}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Format currency
  const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
  };

  // Grand total across all displayed drivers
  const grandTotalAllDrivers = payrollData.reduce((sum, d) => sum + d.grandTotal, 0);

  if (payrollData.length === 0) {
    return (
      <Card className="mt-4">
        <CardContent className="p-6 text-center text-slate-500">
          No payroll data available. Select a driver or ensure drivers have pay rates configured.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mt-4">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Calculator className="w-5 h-5" />
            Payroll Summary
          </CardTitle>
          <Button size="sm" variant="outline" onClick={handleExport} className="gap-2">
            <Download className="w-4 h-4" />
            Export CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {payrollData.map((data, idx) => (
            <div key={data.driver.id} className={idx > 0 ? 'border-t pt-4' : ''}>
              {/* Driver Header */}
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-slate-900">
                    {data.driver.user_name || data.driver.full_name}
                  </h3>
                  <div className="text-xs text-slate-500 space-x-3">
                    <span>Rate: {formatCurrency(data.payRate)}/delivery</span>
                    {data.extraKmRate > 0 && <span>• Extra KM: {formatCurrency(data.extraKmRate)}/km</span>}
                    {data.oversizedRate > 0 && <span>• Oversized: {formatCurrency(data.oversizedRate)}</span>}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold text-emerald-600">
                    {formatCurrency(data.grandTotal)}
                  </div>
                  <div className="text-xs text-slate-500">{data.totalDeliveries} deliveries</div>
                </div>
              </div>
              
              {/* Period Breakdown */}
              {data.periods.length > 1 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-slate-50">
                        <th className="text-left p-2 font-medium text-slate-600">Period</th>
                        <th className="text-center p-2 font-medium text-slate-600">Deliveries</th>
                        <th className="text-right p-2 font-medium text-slate-600">Base</th>
                        {data.extraKmRate > 0 && <th className="text-right p-2 font-medium text-slate-600">Extra KM</th>}
                        {data.oversizedRate > 0 && <th className="text-right p-2 font-medium text-slate-600">Oversized</th>}
                        <th className="text-right p-2 font-medium text-slate-600">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.periods.map((period, pIdx) => (
                        <tr key={pIdx} className="border-b">
                          <td className="p-2 text-slate-700">{period.label}</td>
                          <td className="p-2 text-center tabular-nums">{period.deliveries}</td>
                          <td className="p-2 text-right tabular-nums">{formatCurrency(period.basePay)}</td>
                          {data.extraKmRate > 0 && (
                            <td className="p-2 text-right tabular-nums">{formatCurrency(period.extraKmPay)}</td>
                          )}
                          {data.oversizedRate > 0 && (
                            <td className="p-2 text-right tabular-nums">{formatCurrency(period.oversizedPay)}</td>
                          )}
                          <td className="p-2 text-right font-semibold tabular-nums">{formatCurrency(period.totalPay)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
          
          {/* Grand Total for All Drivers */}
          {payrollData.length > 1 && (
            <div className="border-t-2 border-slate-300 pt-4 flex items-center justify-between">
              <div className="font-semibold text-slate-700">Total Payroll (All Drivers)</div>
              <div className="text-2xl font-bold text-emerald-700">
                {formatCurrency(grandTotalAllDrivers)}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}