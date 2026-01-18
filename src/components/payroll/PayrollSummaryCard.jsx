import React, { useMemo, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Download, Calculator } from 'lucide-react';
import { jsPDF } from 'jspdf';

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

      // Deductions - only apply if there are deliveries (totalPay > 0)
      const deductionsArray = Array.isArray(appUser?.deductions) ? appUser.deductions : [];
      const totalDeductions = totalPay > 0 ? deductionsArray.reduce((sum, d) => sum + (d?.amount || 0), 0) : 0;

      // Gross = Net + Tax - Deductions (only calculate if there's actual pay)
      const grossPay = totalPay > 0 ? totalPay + taxAmount - totalDeductions : 0;

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
        deductions: totalDeductions,
        deductionsArray,
        grossPay
      };
    });
  }, [deliveries, drivers, appUsers, patients, cities, selectedYear, selectedDriverId, currentPeriod]);

  // Export to PDF
  const handleExport = () => {
    if (!currentPeriod) return;

    const formatDate = (date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    
    // First page: Landscape with grid/chart
    const doc = new jsPDF({ orientation: 'landscape' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const leftMargin = 14;
    
    // Title on landscape page
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text('Driver Payroll Summary', leftMargin, 15);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`${currentPeriod.label} | ${formatDate(currentPeriod.start)} - ${formatDate(currentPeriod.end)}`, leftMargin, 22);
    
    // Build grid data
    const periodStart = currentPeriod.start;
    const periodEnd = currentPeriod.end;
    const dates = [];
    let currentDate = new Date(periodStart);
    while (currentDate <= periodEnd) {
      dates.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    // Calculate table dimensions
    const tableTop = 30;
    const rowHeight = 8;
    const driverColWidth = 45;
    const dateColWidth = Math.min(18, (pageWidth - leftMargin * 2 - driverColWidth - 25) / dates.length);
    const totalColWidth = 22;
    
    // Header row - dates
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.text('Driver', leftMargin + 2, tableTop + 5);
    
    dates.forEach((date, i) => {
      const x = leftMargin + driverColWidth + (i * dateColWidth);
      const dayLabel = date.toLocaleDateString('en-US', { weekday: 'short' }).charAt(0);
      const dateLabel = date.getDate().toString();
      doc.text(dayLabel, x + dateColWidth/2, tableTop + 3, { align: 'center' });
      doc.text(dateLabel, x + dateColWidth/2, tableTop + 7, { align: 'center' });
    });
    
    doc.text('Total', leftMargin + driverColWidth + (dates.length * dateColWidth) + totalColWidth/2, tableTop + 5, { align: 'center' });
    
    // Draw header line
    doc.setDrawColor(100, 100, 100);
    doc.line(leftMargin, tableTop + rowHeight, pageWidth - leftMargin, tableTop + rowHeight);
    
    // Data rows
    doc.setFont('helvetica', 'normal');
    let y = tableTop + rowHeight + 6;
    
    payrollData.filter(data => data.totalDeliveries > 0).forEach((data, idx) => {
      const driverName = (data.driver.user_name || data.driver.full_name || '').substring(0, 12);
      doc.text(driverName, leftMargin + 2, y);
      
      // Get deliveries per day for this driver
      const driverId = data.driver.user_id || data.driver.id;
      let rowTotal = 0;
      
      dates.forEach((date, i) => {
        const dateStr = date.toISOString().split('T')[0];
        const dayDeliveries = deliveries.filter(d => {
          if (!d || d.driver_id !== driverId) return false;
          if (d.delivery_date !== dateStr) return false;
          if (!d.patient_id && !d.after_hours_pickup) return false;
          return d.status === 'completed' || d.status === 'failed' || (d.status === 'cancelled' && d.after_hours_pickup);
        }).length;
        
        rowTotal += dayDeliveries;
        const x = leftMargin + driverColWidth + (i * dateColWidth);
        
        if (dayDeliveries > 0) {
          doc.text(dayDeliveries.toString(), x + dateColWidth/2, y, { align: 'center' });
        }
      });
      
      // Row total
      doc.setFont('helvetica', 'bold');
      doc.text(rowTotal.toString(), leftMargin + driverColWidth + (dates.length * dateColWidth) + totalColWidth/2, y, { align: 'center' });
      doc.setFont('helvetica', 'normal');
      
      y += rowHeight;
    });
    
    // Grand total row
    doc.setDrawColor(100, 100, 100);
    doc.line(leftMargin, y - 3, pageWidth - leftMargin, y - 3);
    y += 3;
    
    doc.setFont('helvetica', 'bold');
    doc.text('TOTAL', leftMargin + 2, y);
    
    let grandTotal = 0;
    dates.forEach((date, i) => {
      const dateStr = date.toISOString().split('T')[0];
      const dayTotal = payrollData.reduce((sum, data) => {
        const driverId = data.driver.user_id || data.driver.id;
        return sum + deliveries.filter(d => {
          if (!d || d.driver_id !== driverId) return false;
          if (d.delivery_date !== dateStr) return false;
          if (!d.patient_id && !d.after_hours_pickup) return false;
          return d.status === 'completed' || d.status === 'failed' || (d.status === 'cancelled' && d.after_hours_pickup);
        }).length;
      }, 0);
      
      grandTotal += dayTotal;
      const x = leftMargin + driverColWidth + (i * dateColWidth);
      if (dayTotal > 0) {
        doc.text(dayTotal.toString(), x + dateColWidth/2, y, { align: 'center' });
      }
    });
    
    doc.text(grandTotal.toString(), leftMargin + driverColWidth + (dates.length * dateColWidth) + totalColWidth/2, y, { align: 'center' });
    
    // Second page: Portrait with detailed summaries
    doc.addPage('portrait');
    const portraitWidth = doc.internal.pageSize.getWidth();
    
    y = 20;
    
    // Title
    doc.setFontSize(18);
    doc.setFont('helvetica', 'bold');
    doc.text('Driver Payroll Report', 14, y);
    y += 10;
    
    // Period info
    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    doc.text(`Period: ${currentPeriod.label}`, 14, y);
    y += 6;
    doc.text(`${formatDate(currentPeriod.start)} - ${formatDate(currentPeriod.end)}`, 14, y);
    y += 6;
    doc.text(`Pay Period Type: ${payPeriod.charAt(0).toUpperCase() + payPeriod.slice(1)}`, 14, y);
    y += 12;
    
    // Driver sections
    payrollData.filter(data => data.totalDeliveries > 0).forEach((data, idx) => {
      // Check if we need a new page
      if (y > 250) {
        doc.addPage();
        y = 20;
      }
      
      const driverName = data.driver.user_name || data.driver.full_name;
      
      // Driver name header
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.text(driverName, 14, y);
      y += 7;
      
      // Stats - left side
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      
      const col1 = 14;
      const col2 = 64;
      const col3 = 114;
      
      // Row 1: Rates
      doc.text(`Rate: $${data.payRate.toFixed(2)}`, col1, y);
      doc.text(`KM Rate: $${data.extraKmRate.toFixed(3)}/km`, col2, y);
      doc.text(`OS Rate: $${data.oversizedRate.toFixed(2)}`, col3, y);
      y += 5;
      
      // Row 2: Totals
      doc.text(`Del: ${data.totalDeliveries} = $${data.totalBasePay.toFixed(2)}`, col1, y);
      doc.text(`KM: ${data.totalExtraKm.toFixed(2)} = $${data.totalExtraKmPay.toFixed(2)}`, col2, y);
      doc.text(`OS: ${data.oversizedCount} = $${data.totalOversizedPay.toFixed(2)}`, col3, y);
      y += 5;
      
      // Row 3: Failed/Returns
      doc.text(`Failed: ${data.failedCount}`, col1, y);
      doc.text(`Returns: ${data.returnsCount}`, col2, y);
      y += 7;
      
      // Pay summary - right aligned
      const rightCol = portraitWidth - 14;
      doc.setFont('helvetica', 'normal');
      doc.text(`Net:`, rightCol - 40, y - 14);
      doc.text(`$${(data.grandTotal || 0).toFixed(2)}`, rightCol, y - 14, { align: 'right' });
      
      doc.text(`Tax:`, rightCol - 40, y - 9);
      doc.text(`$${(data.taxAmount || 0).toFixed(2)}`, rightCol, y - 9, { align: 'right' });
      
      doc.text(`Deductions:`, rightCol - 40, y - 4);
      doc.text(`-$${(data.deductions || 0).toFixed(2)}`, rightCol, y - 4, { align: 'right' });
      
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text(`Gross:`, rightCol - 40, y + 2);
      doc.text(`$${(data.grossPay || 0).toFixed(2)}`, rightCol, y + 2, { align: 'right' });
      
      y += 8;
      
      // Separator line
      doc.setDrawColor(200, 200, 200);
      doc.line(14, y, portraitWidth - 14, y);
      y += 8;
    });
    
    // Grand total for all drivers
    if (payrollData.length > 1) {
      if (y > 260) {
        doc.addPage();
        y = 20;
      }
      
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.text('Total Payroll (All Drivers)', 14, y);
      
      const rightCol = portraitWidth - 14;
      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.text(`Net: $${grandTotalAllDrivers.toFixed(2)}`, rightCol, y, { align: 'right' });
      y += 5;
      doc.text(`Tax: $${grandTotalTax.toFixed(2)}`, rightCol, y, { align: 'right' });
      y += 5;
      doc.text(`Deductions: $${grandTotalDeductions.toFixed(2)}`, rightCol, y, { align: 'right' });
      y += 6;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(14);
      doc.text(`Gross: $${grandTotalGross.toFixed(2)}`, rightCol, y, { align: 'right' });
    }
    
    // Save the PDF
    doc.save(`payroll_${currentPeriod.label.replace(/\s+/g, '_')}_${selectedYear}.pdf`);
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
            Export PDF
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {payrollData.filter(data => data.totalDeliveries > 0).map((data, idx) => {
          const hasTaxOrDeductions = data.taxAmount > 0 || data.deductions > 0;
          
          return (
          <div key={data.driver.id} className="p-3 rounded-lg" style={{ background: idx % 2 === 0 ? 'var(--bg-slate-50)' : 'transparent' }}>
              {/* Driver Name - Top Left */}
              <h3 className="font-semibold mb-1" style={{ color: 'var(--text-slate-900)' }}>
                {data.driver.user_name || data.driver.full_name}
              </h3>

              {/* Stats and Pay Summary - Side by Side */}
              <div className="flex justify-between items-start">
                {/* Left: 8 Stats in 4 columns x 2 rows */}
                <div className="grid grid-cols-4 gap-x-4 gap-y-0.5 text-xs">
                  {/* Row 1: Rates */}
                  <div className="flex items-center">
                    <span className="w-10 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>Rate:</span>
                    <span className="px-2 py-0.5 rounded text-[11px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>{formatCurrency(data.payRate)}</span>
                  </div>
                  <div className="flex items-center">
                    <span className="w-8 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>KM:</span>
                    <span className="px-2 py-0.5 rounded text-[11px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>{formatCurrency(data.extraKmRate, 3)}/km</span>
                  </div>
                  <div className="flex items-center">
                    <span className="w-8 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>OS:</span>
                    <span className="px-2 py-0.5 rounded text-[11px]" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>{formatCurrency(data.oversizedRate)}</span>
                  </div>
                  <div className="flex items-center">
                    <span className="w-12 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>Failed:</span>
                    <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded text-[11px]">{data.failedCount}</span>
                  </div>
                  {/* Row 2: Totals */}
                  <div className="flex items-center">
                    <span className="w-10 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>Del:</span>
                    <span className="px-2 py-0.5 rounded text-[11px] whitespace-nowrap" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>{data.totalDeliveries} = {formatCurrency(data.totalBasePay)}</span>
                  </div>
                  <div className="flex items-center">
                    <span className="w-8 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>KM:</span>
                    <span className="px-2 py-0.5 rounded text-[11px] whitespace-nowrap" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>{data.totalExtraKm.toFixed(2)} = {formatCurrency(data.totalExtraKmPay)}</span>
                  </div>
                  <div className="flex items-center">
                    <span className="w-8 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>OS:</span>
                    <span className="px-2 py-0.5 rounded text-[11px] whitespace-nowrap" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>{data.oversizedCount} = {formatCurrency(data.totalOversizedPay)}</span>
                  </div>
                  <div className="flex items-center">
                    <span className="w-12 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>Returns:</span>
                    <span className="bg-orange-100 text-orange-700 px-2 py-0.5 rounded text-[11px]">{data.returnsCount}</span>
                  </div>
                </div>

                {/* Right: Pay Summary */}
                <div className="text-xs ml-4" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  <table className="border-collapse">
                    <tbody>
                      <tr style={{ color: 'var(--text-slate-600)' }}>
                        <td className="text-right pr-1">Net:</td>
                        <td className="text-right">$</td>
                        <td className="text-right font-semibold">{(data.grandTotal || 0).toFixed(2)}</td>
                      </tr>
                      <tr style={{ color: 'var(--text-slate-600)' }}>
                        <td className="text-right pr-1">Tax:</td>
                        <td className="text-right">$</td>
                        <td className="text-right font-semibold">{(data.taxAmount || 0).toFixed(2)}</td>
                      </tr>
                      <tr style={{ color: 'var(--text-slate-600)' }}>
                        <td className="text-right pr-1">Deductions:</td>
                        <td className="text-right">-$</td>
                        <td className="text-right font-semibold">{(data.deductions || 0).toFixed(2)}</td>
                      </tr>
                      <tr className="text-lg font-bold text-emerald-600">
                        <td className="text-right pr-1 pt-1">Gross:</td>
                        <td className="text-right pt-1">$</td>
                        <td className="text-right pt-1">{(data.grossPay || 0).toFixed(2)}</td>
                      </tr>
                    </tbody>
                  </table>
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