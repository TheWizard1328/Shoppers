import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DollarSign, Download, Calculator } from 'lucide-react';

/**
 * Payroll Summary Card
 * Calculates and displays payroll totals based on pay period and driver rates
 */
// GST/HST rates by province (Canada)
const PROVINCE_TAX_RATES = {
  'AB': 0.05,  // Alberta - GST only
  'BC': 0.05,  // BC - GST only (PST separate)
  'SK': 0.05,  // Saskatchewan - GST only
  'MB': 0.05,  // Manitoba - GST only
  'ON': 0.13,  // Ontario - HST
  'QC': 0.05,  // Quebec - GST only (QST separate)
  'NB': 0.15,  // New Brunswick - HST
  'NS': 0.15,  // Nova Scotia - HST
  'PE': 0.15,  // PEI - HST
  'NL': 0.15,  // Newfoundland - HST
  'YT': 0.05,  // Yukon - GST only
  'NT': 0.05,  // Northwest Territories - GST only
  'NU': 0.05,  // Nunavut - GST only
};

export default function PayrollSummaryCard({
  deliveries,
  drivers,
  appUsers,
  patients,
  cities,
  selectedYear,
  selectedDriverId,
  payPeriod,
  currentPeriod
}) {

  // Calculate payroll for each driver for the current period
  const payrollData = useMemo(() => {
    if (!deliveries || !drivers || !appUsers || !currentPeriod) return [];

    // Get drivers to calculate for
    // Note: drivers come from payrollData.drivers which are AppUser records (user_id field)
    const driversToCalc = selectedDriverId === 'all' ?
    drivers.filter((d) => d && d.status === 'active') :
    drivers.filter((d) => d && (d.id === selectedDriverId || d.user_id === selectedDriverId));

    return driversToCalc.map((driver) => {
      // Get AppUser data for pay rates
      // driver IS the AppUser record, but also check by user_id for consistency
      const driverId = driver.user_id || driver.id;
      const appUser = appUsers.find((au) => au && (au.user_id === driverId || au.id === driver.id)) || driver;
      const payRate = appUser?.pay_rate_per_delivery || 0;
      const extraKmRate = appUser?.extra_km_rate || 0;
      const extraKmLimit = appUser?.extra_km_limit || 0;
      const oversizedRate = appUser?.oversized_item_rate || 0;

      // Filter deliveries for this driver in the current period
      // Exclude pickups (no patient_id) UNLESS it's an after_hours_pickup
      const periodDeliveries = deliveries.filter((d) => {
        if (!d || !d.delivery_date) return false;
        // Count completed, failed, and cancelled (for after_hours_pickup)
        const validStatus = d.status === 'completed' || d.status === 'failed' || (d.status === 'cancelled' && d.after_hours_pickup);
        if (!validStatus) return false;
        if (d.driver_id !== driverId) return false;
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

      // Calculate GST/HST if enabled for driver
      const gstHstEnabled = appUser?.gst_hst_enabled || false;
      let taxAmount = 0;
      let taxRate = 0;
      let provinceCode = null;

      if (gstHstEnabled && cities) {
        // Get driver's city to determine province
        const driverCityId = appUser?.city_id;
        const driverCity = driverCityId ? cities.find(c => c && c.id === driverCityId) : null;
        
        if (driverCity?.province_state) {
          // Extract province code (handle full names and abbreviations)
          const province = driverCity.province_state.toUpperCase();
          // Check if it's already a 2-letter code
          if (province.length === 2 && PROVINCE_TAX_RATES[province]) {
            provinceCode = province;
          } else {
            // Map full names to codes
            const provinceMap = {
              'ALBERTA': 'AB', 'BRITISH COLUMBIA': 'BC', 'SASKATCHEWAN': 'SK',
              'MANITOBA': 'MB', 'ONTARIO': 'ON', 'QUEBEC': 'QC',
              'NEW BRUNSWICK': 'NB', 'NOVA SCOTIA': 'NS', 'PRINCE EDWARD ISLAND': 'PE',
              'NEWFOUNDLAND': 'NL', 'NEWFOUNDLAND AND LABRADOR': 'NL',
              'YUKON': 'YT', 'NORTHWEST TERRITORIES': 'NT', 'NUNAVUT': 'NU'
            };
            provinceCode = provinceMap[province] || null;
          }
          
          if (provinceCode && PROVINCE_TAX_RATES[provinceCode]) {
            taxRate = PROVINCE_TAX_RATES[provinceCode];
            taxAmount = totalPay * taxRate;
          }
        }
      }

      // Deductions (placeholder - can be expanded based on appUser.deductions field if added)
      const deductions = appUser?.deductions || 0;

      // Gross = Net + Tax - Deductions
      const grossPay = totalPay + taxAmount - deductions;

      return {
        driver: { ...driver, id: driverId }, // Ensure consistent id
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
        grandTotal: totalPay,
        // New fields
        gstHstEnabled,
        taxRate,
        taxAmount,
        provinceCode,
        deductions,
        grossPay
      };
    });
  }, [deliveries, drivers, appUsers, patients, cities, selectedYear, selectedDriverId, currentPeriod]);

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

  // Grand totals across all displayed drivers
  const grandTotalAllDrivers = payrollData.reduce((sum, d) => sum + d.grandTotal, 0);
  const grandTotalTax = payrollData.reduce((sum, d) => sum + d.taxAmount, 0);
  const grandTotalDeductions = payrollData.reduce((sum, d) => sum + d.deductions, 0);
  const grandTotalGross = payrollData.reduce((sum, d) => sum + d.grossPay, 0);

  if (payrollData.length === 0) {
    return (
      <Card className="mt-4" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
        <CardContent className="p-6 text-center" style={{ color: 'var(--text-slate-500)' }}>
          No payroll data available for this period. 
          {drivers?.length === 0 && ' No drivers found.'}
          {drivers?.length > 0 && appUsers?.length === 0 && ' No driver pay rates configured.'}
          {drivers?.length > 0 && appUsers?.length > 0 && deliveries?.length === 0 && ' No deliveries in selected period.'}
        </CardContent>
      </Card>);

  }

  return (
    <Card className="mt-4" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base" style={{ color: 'var(--text-slate-900)' }}>
            <Calculator className="w-5 h-5" />
            Payroll Summary
          </CardTitle>
          <Button size="sm" variant="outline" onClick={handleExport} className="gap-2" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
            <Download className="w-4 h-4" />
            Export CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {payrollData.filter(data => data.grossPay > 0).map((data, idx) => {
          const hasTaxOrDeductions = data.taxAmount > 0 || data.deductions > 0;
          
          return (
          <div key={data.driver.id} className="p-3 rounded-lg" style={{ background: idx % 2 === 0 ? 'var(--bg-slate-50)' : 'transparent' }}>
              {/* Driver Name - Top Left */}
              <h3 className="font-semibold mb-1" style={{ color: 'var(--text-slate-900)' }}>
                {data.driver.user_name || data.driver.full_name}
              </h3>

              {/* Stats and Pay Summary - Side by Side */}
              <div className="flex justify-between items-start">
                {/* Left: 8 Stats in 2 columns */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
                  <div className="flex items-center">
                    <span className="w-12 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>Rate:</span>
                    <span className="px-2 py-0.5 rounded text-[11px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>{formatCurrency(data.payRate)}</span>
                  </div>
                  <div className="flex items-center">
                    <span className="w-10 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>Del:</span>
                    <span className="px-2 py-0.5 rounded text-[11px] whitespace-nowrap" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>{data.totalDeliveries} = {formatCurrency(data.totalBasePay)}</span>
                  </div>
                  <div className="flex items-center">
                    <span className="w-12 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>KM:</span>
                    <span className="px-2 py-0.5 rounded text-[11px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>{formatCurrency(data.extraKmRate, 3)}/km</span>
                  </div>
                  <div className="flex items-center">
                    <span className="w-10 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>KM:</span>
                    <span className="px-2 py-0.5 rounded text-[11px] whitespace-nowrap" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>{data.totalExtraKm.toFixed(2)} = {formatCurrency(data.totalExtraKmPay)}</span>
                  </div>
                  <div className="flex items-center">
                    <span className="w-12 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>OS:</span>
                    <span className="px-2 py-0.5 rounded text-[11px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>{formatCurrency(data.oversizedRate)}</span>
                  </div>
                  <div className="flex items-center">
                    <span className="w-10 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>OS:</span>
                    <span className="px-2 py-0.5 rounded text-[11px] whitespace-nowrap" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>{data.oversizedCount} = {formatCurrency(data.totalOversizedPay)}</span>
                  </div>
                  <div className="flex items-center">
                    <span className="w-12 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>Failed:</span>
                    <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded text-[11px]">{data.failedCount}</span>
                  </div>
                  <div className="flex items-center">
                    <span className="w-10 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>Ret:</span>
                    <span className="bg-orange-100 text-orange-700 px-2 py-0.5 rounded text-[11px]">{data.returnsCount}</span>
                  </div>
                </div>

                {/* Right: Pay Summary */}
                <div className="flex flex-col items-end text-xs ml-4">
                  <div style={{ color: 'var(--text-slate-600)' }}>
                    <span className="mr-1">Net:</span>
                    <span className="font-semibold">{formatCurrency(data.grandTotal)}</span>
                  </div>
                  {data.taxAmount > 0 ? (
                    <div style={{ color: 'var(--text-slate-600)' }}>
                      <span className="mr-1">Tax ({data.provinceCode} {(data.taxRate * 100).toFixed(0)}%):</span>
                      <span className="font-semibold">{formatCurrency(data.taxAmount)}</span>
                    </div>
                  ) : (
                    <div style={{ color: 'var(--text-slate-400)' }}>
                      <span className="mr-1">Tax:</span>
                      <span>-</span>
                    </div>
                  )}
                  <div style={{ color: 'var(--text-slate-400)' }}>
                    <span className="mr-1">Deductions:</span>
                    <span className="italic text-[10px]">Coming soon</span>
                  </div>
                  <div className="text-lg font-bold text-emerald-600 mt-1">
                    {formatCurrency(data.grossPay)}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
          
          {/* Grand Total for All Drivers */}
          {payrollData.length > 1 && (
          <div className="pt-4" style={{ borderTop: '2px solid var(--border-slate-300)' }}>
              <div className="flex items-center justify-between">
                <div className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Total Payroll (All Drivers)</div>
                <div className="flex flex-col items-end gap-0.5">
                  {(grandTotalTax > 0 || grandTotalDeductions > 0) ? (
                    <>
                      <div className="text-sm" style={{ color: 'var(--text-slate-600)' }}>
                        <span className="text-xs mr-1">Net:</span>
                        <span className="font-semibold">{formatCurrency(grandTotalAllDrivers)}</span>
                      </div>
                      {grandTotalTax > 0 && (
                        <div className="text-sm" style={{ color: 'var(--text-slate-600)' }}>
                          <span className="text-xs mr-1">Tax:</span>
                          <span className="font-semibold">{formatCurrency(grandTotalTax)}</span>
                        </div>
                      )}
                      {grandTotalDeductions > 0 && (
                        <div className="text-sm text-red-600">
                          <span className="text-xs mr-1">Deductions:</span>
                          <span className="font-semibold">-{formatCurrency(grandTotalDeductions)}</span>
                        </div>
                      )}
                      <div className="text-2xl font-bold text-emerald-700 mt-1">
                        <span className="text-xs font-normal mr-1" style={{ color: 'var(--text-slate-500)' }}>Gross:</span>
                        {formatCurrency(grandTotalGross)}
                      </div>
                    </>
                  ) : (
                    <div className="text-2xl font-bold text-emerald-700">
                      {formatCurrency(grandTotalGross)}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}