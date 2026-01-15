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
  patients,
  selectedYear,
  selectedDriverId,
  payPeriod,
  currentPeriod
}) {

  // Calculate payroll for each driver for the current period
  const payrollData = useMemo(() => {
    if (!deliveries || !drivers || !appUsers || !currentPeriod) return [];

    // Get drivers to calculate for
    const driversToCalc = selectedDriverId === 'all' ?
    drivers.filter((d) => d && d.status === 'active') :
    drivers.filter((d) => d && d.id === selectedDriverId);

    return driversToCalc.map((driver) => {
      // Get AppUser data for pay rates
      const appUser = appUsers.find((au) => au && au.user_id === driver.id);
      const payRate = appUser?.pay_rate_per_delivery || 0;
      const extraKmRate = appUser?.extra_km_rate || 0;
      const extraKmLimit = appUser?.extra_km_limit || 0;
      const oversizedRate = appUser?.oversized_item_rate || 0;

      // Filter deliveries for this driver in the current period
      // Exclude pickups (no patient_id) UNLESS it's an after_hours_pickup
      const periodDeliveries = deliveries.filter((d) => {
        if (!d || !d.delivery_date) return false;
        // Count completed, failed, and cancelled (for after_hours_pickup)
        const validStatus = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' && d.after_hours_pickup;
        if (!validStatus) return false;
        if (d.driver_id !== driver.id) return false;
        // Exclude pickups (no patient_id) unless it's an after_hours_pickup
        if (!d.patient_id && !d.after_hours_pickup) return false;

        const date = new Date(d.delivery_date + 'T00:00:00');
        return date >= currentPeriod.start && date <= currentPeriod.end;
      });

      const deliveryCount = periodDeliveries.length;
      const basePay = deliveryCount * payRate;

      // Calculate extra km pay
      // Use patient's distance_from_store (or paid_km_override if set on delivery)
      // Extra km = distance_from_store - extraKmLimit (only if positive)
      let extraKmPay = 0;
      let totalExtraKm = 0;
      periodDeliveries.forEach((d) => {
        // First check for paid_km_override on delivery, then get patient's distance_from_store
        let distanceFromStore = d.paid_km_override || 0;
        if (!distanceFromStore && d.patient_id && patients) {
          const patient = patients.find((p) => p && p.id === d.patient_id);
          distanceFromStore = patient?.distance_from_store || 0;
        }

        if (distanceFromStore > extraKmLimit && extraKmRate > 0) {
          const extraKm = distanceFromStore - extraKmLimit;
          totalExtraKm += extraKm;
          extraKmPay += extraKm * extraKmRate;
        }
      });

      // Calculate oversized pay
      const oversizedCount = periodDeliveries.filter((d) => d.oversized).length;
      const oversizedPay = oversizedCount * oversizedRate;

      // Count failed and returns (cancelled with after_hours_pickup excluded from returns)
      const failedCount = periodDeliveries.filter((d) => d.status === 'failed').length;
      const returnsCount = periodDeliveries.filter((d) => d.status === 'cancelled' && !d.after_hours_pickup).length;

      const totalPay = basePay + extraKmPay + oversizedPay;

      return {
        driver,
        payRate,
        extraKmRate,
        extraKmLimit,
        oversizedRate,
        totalDeliveries: deliveryCount,
        totalBasePay: basePay,
        totalExtraKm: totalExtraKm,
        totalExtraKmPay: extraKmPay,
        oversizedCount: oversizedCount,
        totalOversizedPay: oversizedPay,
        failedCount: failedCount,
        returnsCount: returnsCount,
        grandTotal: totalPay
      };
    });
  }, [deliveries, drivers, appUsers, patients, selectedYear, selectedDriverId, currentPeriod]);

  // Export to CSV
  const handleExport = () => {
    if (!currentPeriod) return;

    const formatDate = (date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    let csv = `Driver Payroll - ${currentPeriod.label}\n`;
    csv += `Period: ${formatDate(currentPeriod.start)} - ${formatDate(currentPeriod.end)}\n`;
    csv += `Pay Period Type: ${payPeriod.charAt(0).toUpperCase() + payPeriod.slice(1)}\n\n`;

    csv += 'Driver,Pay Rate,Deliveries,Base Pay,Extra KM Pay,Oversized Pay,Total\n';

    payrollData.forEach((data) => {
      csv += `${data.driver.user_name || data.driver.full_name},$${data.payRate.toFixed(2)},${data.totalDeliveries},$${data.totalBasePay.toFixed(2)},$${data.totalExtraKmPay.toFixed(2)},$${data.totalOversizedPay.toFixed(2)},$${data.grandTotal.toFixed(2)}\n`;
    });

    // Grand total across all drivers
    if (payrollData.length > 1) {
      const allDriversTotal = payrollData.reduce((sum, d) => sum + d.grandTotal, 0);
      const allDeliveries = payrollData.reduce((sum, d) => sum + d.totalDeliveries, 0);
      csv += `\nTOTAL,,${allDeliveries},,,,${allDriversTotal.toFixed(2)}\n`;
    }

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payroll_${currentPeriod.label.replace(/\s+/g, '_')}_${selectedYear}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Format currency
  const formatCurrency = (amount, decimals = 2) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(amount);
  };

  // Grand total across all displayed drivers
  const grandTotalAllDrivers = payrollData.reduce((sum, d) => sum + d.grandTotal, 0);

  if (payrollData.length === 0) {
    return (
      <Card className="mt-4">
        <CardContent className="p-6 text-center text-slate-500">
          No payroll data available. Select a driver or ensure drivers have pay rates configured.
        </CardContent>
      </Card>);

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
        <div className="space-y-4">
          {payrollData.filter((data) => data.grandTotal > 0).map((data, idx) =>
          <div key={data.driver.id} className={`p-3 rounded-lg ${idx % 2 === 0 ? 'bg-slate-50' : ''}`}>
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-slate-900">
                  {data.driver.user_name || data.driver.full_name}
                </h3>
                <div className="text-2xl font-bold text-emerald-600">
                  {formatCurrency(data.grandTotal)}
                </div>
              </div>
              {/* Pay Rates Row */}
              <div className="flex gap-14 text-xs mb-1.5">
                <div className="flex items-center gap-1 w-24">
                  <span className="text-slate-500 w-8">Rate:</span>
                  <span className="bg-slate-200 text-slate-700 px-1 py-0.5 rounded text-[11px]">{formatCurrency(data.payRate)}</span>
                </div>
                <div className="flex items-center gap-1 w-28">
                  <span className="text-slate-500 w-6">KM:</span>
                  <span className="bg-slate-200 text-slate-700 px-1 py-0.5 rounded text-[11px]">{formatCurrency(data.extraKmRate, 3)}/km</span>
                </div>
                <div className="flex items-center gap-1 w-20">
                  <span className="text-slate-500 w-6">OS:</span>
                  <span className="bg-slate-200 text-slate-700 px-1 py-0.5 rounded text-[11px]">{formatCurrency(data.oversizedRate)}</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-slate-500">Failed:</span>
                  <span className="bg-red-100 text-red-700 px-1 py-0.5 rounded text-[11px]">{data.failedCount}</span>
                </div>
              </div>
              {/* Totals Row */}
              <div className="flex gap-14 text-xs">
                <div className="flex items-center gap-1 w-24">
                  <span className="text-slate-500 w-8">Del:</span>
                  <span className="bg-slate-200 text-slate-700 px-1 py-0.5 rounded text-[11px]">{data.totalDeliveries} = {formatCurrency(data.totalBasePay)}</span>
                </div>
                <div className="flex items-center gap-1 w-28">
                  <span className="text-slate-500 w-6">KM:</span>
                  <span className="bg-slate-200 text-slate-700 px-2 py-0.5 rounded text-[11px]">{data.totalExtraKm.toFixed(2)} = {formatCurrency(data.totalExtraKmPay)}</span>
                </div>
                <div className="flex items-center gap-1 w-20">
                  <span className="text-slate-500 w-6">OS:</span>
                  <span className="bg-slate-200 text-slate-700 px-1 py-0.5 rounded text-[11px]">{data.oversizedCount} = {formatCurrency(data.totalOversizedPay)}</span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-slate-500">Returns:</span>
                  <span className="bg-orange-100 text-orange-700 px-1 py-0.5 rounded text-[11px]">{data.returnsCount}</span>
                </div>
              </div>
            </div>
          )}
          
          {/* Grand Total for All Drivers */}
          {payrollData.length > 1 &&
          <div className="border-t-2 border-slate-300 pt-4 flex items-center justify-between">
              <div className="font-semibold text-slate-700">Total Payroll (All Drivers)</div>
              <div className="text-2xl font-bold text-emerald-700">
                {formatCurrency(grandTotalAllDrivers)}
              </div>
            </div>
          }
        </div>
      </CardContent>
    </Card>);

}