import React, { useMemo, useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Download, Calculator, CheckCircle, AlertCircle, Clock, Users } from 'lucide-react';
import { jsPDF } from 'jspdf';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { base44 } from '@/api/base44Client';
import { useUser } from '../utils/UserContext';
import { userHasRole } from '../utils/userRoles';
import { notifyDriverConfirmedPayroll, notifyAdminApprovedPayroll } from '../utils/deliveryMessaging';
import PayrollMobileCard from './PayrollMobileCard';

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
  stores,
  selectedYear,
  selectedDriverId,
  selectedCityId,
  payPeriod,
  currentPeriod,
  onFinalizePayroll,
  onPayrollRecordsChange,
  payrollRecords: externalPayrollRecords,
  refreshPayrollRecords
}) {
  const { currentUser } = useUser();
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [payrollRecords, setPayrollRecords] = useState([]);
  const [isLoadingRecords, setIsLoadingRecords] = useState(false);

  const isAdmin = currentUser && userHasRole(currentUser, 'admin');
  const isDriver = currentUser && userHasRole(currentUser, 'driver') && !isAdmin;

  // Format period dates for querying
  const periodStartStr = currentPeriod?.start ? currentPeriod.start.toISOString().split('T')[0] : null;
  const periodEndStr = currentPeriod?.end ? currentPeriod.end.toISOString().split('T')[0] : null;

  // Use external payroll records if provided, otherwise fetch locally
  useEffect(() => {
    if (externalPayrollRecords) {
      setPayrollRecords(externalPayrollRecords);
      setIsLoadingRecords(false);
      return;
    }

    if (!periodStartStr || !periodEndStr) return;

    const fetchPayrollRecords = async () => {
      setIsLoadingRecords(true);
      try {
        const records = await base44.entities.Payroll.filter({
          pay_period_start: periodStartStr,
          pay_period_end: periodEndStr
        });
        setPayrollRecords(records || []);
        if (onPayrollRecordsChange) {
          onPayrollRecordsChange(records || []);
        }
      } catch (error) {
        console.error('Failed to fetch payroll records:', error);
      } finally {
        setIsLoadingRecords(false);
      }
    };

    fetchPayrollRecords();
  }, [periodStartStr, periodEndStr, externalPayrollRecords]);

  // Get finalization status for each driver
  // CRITICAL: Only return records that match the current period's dates
  const getDriverPayrollRecord = (driverId) => {
    return payrollRecords.find(r => 
      r.driver_id === driverId &&
      r.pay_period_start === periodStartStr &&
      r.pay_period_end === periodEndStr
    );
  };

  // Check if current driver has finalized (for driver view)
  const currentDriverRecord = isDriver && currentUser ? getDriverPayrollRecord(currentUser.id) : null;
  const isCurrentDriverFinalized = currentDriverRecord?.status === 'driver_finalized' || 
                                    currentDriverRecord?.status === 'admin_finalized' ||
                                    currentDriverRecord?.status === 'paid';



  // Handle driver finalization
  const handleDriverFinalize = async (driverData) => {
    setIsFinalizing(true);
    try {
      const existingRecord = getDriverPayrollRecord(driverData.driver.id);
      
      const payrollRecord = {
        driver_id: driverData.driver.id,
        city_id: selectedCityId || null,
        pay_period_start: periodStartStr,
        pay_period_end: periodEndStr,
        pay_period_type: payPeriod,
        total_deliveries: driverData.totalDeliveries,
        total_extra_km: driverData.totalExtraKm,
        total_oversized_deliveries: driverData.oversizedCount,
        gross_pay: driverData.grossPay,
        net_pay: driverData.grandTotal,
        total_deductions: driverData.deductions,
        deductions: driverData.deductionsArray,
        pay_rate_per_delivery: driverData.payRate,
        extra_km_rate: driverData.extraKmRate,
        extra_km_limit: driverData.extraKmLimit,
        oversized_item_rate: driverData.oversizedRate,
        gst_hst_enabled: driverData.gstHstEnabled,
        status: 'driver_finalized',
        driver_finalized_at: new Date().toISOString()
      };

      let savedRecord;
      if (existingRecord) {
        savedRecord = await base44.entities.Payroll.update(existingRecord.id, payrollRecord);
        console.log('✅ [Payroll] Updated existing record:', existingRecord.id, savedRecord);
      } else {
        savedRecord = await base44.entities.Payroll.create(payrollRecord);
        console.log('✅ [Payroll] Created new record:', savedRecord);
      }

      // Send notification to admins (excluding self if admin-driver)
      try {
        await notifyDriverConfirmedPayroll({
          driver: currentUser,
          periodLabel: currentPeriod?.label || 'this period',
          appUsers,
          excludeUserId: isAdmin ? currentUser?.id : null // Don't notify self if admin-driver
        });
      } catch (notifyError) {
        console.warn('Failed to send notification:', notifyError);
      }

      // Refresh records - use external refresh if available for real-time sync
      if (refreshPayrollRecords) {
        await refreshPayrollRecords();
      } else {
        const records = await base44.entities.Payroll.filter({
          pay_period_start: periodStartStr,
          pay_period_end: periodEndStr
        });
        console.log('📥 [Payroll] Refreshed records after driver finalize:', records?.length);
        setPayrollRecords(records || []);
        if (onPayrollRecordsChange) {
          onPayrollRecordsChange(records || []);
        }
      }
    } catch (error) {
      console.error('❌ [Payroll] Failed to finalize payroll:', error);
      alert('Failed to save payroll confirmation. Please try again.');
    } finally {
      setIsFinalizing(false);
      setShowConfirmDialog(false);
    }
  };

  // Handle admin finalization (all drivers)
  const handleAdminFinalize = async () => {
    setIsFinalizing(true);
    try {
      const driversWithDeliveries = payrollData.filter(d => d.totalDeliveries > 0);
      
      for (const driverData of driversWithDeliveries) {
        const existingRecord = getDriverPayrollRecord(driverData.driver.id);
        
        if (existingRecord) {
          await base44.entities.Payroll.update(existingRecord.id, {
            status: 'admin_finalized',
            admin_finalized_at: new Date().toISOString(),
            admin_finalized_by: currentUser?.id
          });
        }
      }

      // Send notification to all drivers
      await notifyAdminApprovedPayroll({
        admin: currentUser,
        periodLabel: currentPeriod?.label || 'this period',
        driversWithDeliveries,
        appUsers
      });

      // Refresh records - use external refresh if available for real-time sync
      if (refreshPayrollRecords) {
        await refreshPayrollRecords();
      } else {
        const records = await base44.entities.Payroll.filter({
          pay_period_start: periodStartStr,
          pay_period_end: periodEndStr
        });
        setPayrollRecords(records || []);
        if (onPayrollRecordsChange) {
          onPayrollRecordsChange(records || []);
        }
      }

      if (onFinalizePayroll) {
        onFinalizePayroll({
          period: currentPeriod,
          payrollData: driversWithDeliveries,
          grandTotals: {
            net: grandTotalAllDrivers,
            tax: grandTotalTax,
            deductions: grandTotalDeductions,
            gross: grandTotalGross
          }
        });
      }
    } catch (error) {
      console.error('Failed to admin finalize payroll:', error);
    } finally {
      setIsFinalizing(false);
      setShowConfirmDialog(false);
    }
  };

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
      // Include completed, failed, cancelled (after_hours OR store returns)
      const periodDeliveries = deliveries.filter((d) => {
        if (!d || !d.delivery_date) return false;
        if (d.driver_id !== driverId) return false;
        // Exclude pickups (no patient_id) unless it's an after_hours_pickup or store return
        if (!d.patient_id && !d.after_hours_pickup) return false;

        // Valid statuses: completed, failed, or cancelled (for after_hours or store returns)
        if (d.status === 'completed' || d.status === 'failed') {
          // Valid - count these
        } else if (d.status === 'cancelled') {
          // For cancelled: include after_hours_pickup OR store returns
          const isStoreReturn = /\[[\w\s]+\]/.test(d.patient_name || '') && 
                                (d.patient_name || '').toLowerCase().includes('return');
          if (!d.after_hours_pickup && !isStoreReturn) return false;
        } else {
          return false;
        }

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
      
      // Count returns with store name in brackets (e.g., "[XX] Return") - must be cancelled and not after_hours
      const storeReturnCount = periodDeliveries.filter((d) => {
        if (d.status !== 'cancelled' || d.after_hours_pickup) return false;
        const patientName = (d.patient_name || '').toLowerCase();
        const hasStorePattern = /\[[\w\s]+\]/.test(d.patient_name || '');
        const hasReturn = patientName.includes('return');
        return hasStorePattern && hasReturn;
      }).length;

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
        storeReturnCount: storeReturnCount,
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
  const handleExport = (stores = []) => {
    if (!currentPeriod) return;

    const formatDate = (date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    
    // First page: Landscape with grid matching DriverPayrollGrid (stores as columns, days as rows)
    const doc = new jsPDF({ orientation: 'landscape' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const leftMargin = 14;
    
    // Title on landscape page
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text('Deliveries by Store', leftMargin, 15);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`${currentPeriod.label} | ${formatDate(currentPeriod.start)} - ${formatDate(currentPeriod.end)}`, leftMargin, 22);
    
    // Build grid data - days as rows, stores as columns
    const periodStart = currentPeriod.start;
    const periodEnd = currentPeriod.end;
    const dates = [];
    let currentDate = new Date(periodStart);
    while (currentDate <= periodEnd) {
      dates.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    // Sort stores and filter to those with data
    const sortedStores = [...stores].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
    const activeStores = sortedStores.filter(s => s.status !== 'inactive');
    
    // Build store delivery map (dateKey -> storeId -> count)
    const storeDataMap = {};
    dates.forEach(date => {
      const dateKey = date.toISOString().split('T')[0];
      storeDataMap[dateKey] = {};
      activeStores.forEach(store => {
        storeDataMap[dateKey][store.id] = 0;
      });
    });
    
    // Populate from deliveries
    deliveries.forEach(d => {
      if (!d || !d.delivery_date || !d.store_id) return;
      const validStatus = d.status === 'completed' || d.status === 'failed' || (d.status === 'cancelled' && d.after_hours_pickup);
      if (!validStatus) return;
      if (!d.patient_id && !d.after_hours_pickup) return;
      const date = new Date(d.delivery_date + 'T00:00:00');
      if (date < currentPeriod.start || date > currentPeriod.end) return;
      // Filter by driver if selected
      if (selectedDriverId && selectedDriverId !== 'all' && d.driver_id !== selectedDriverId) return;
      
      if (storeDataMap[d.delivery_date] && storeDataMap[d.delivery_date][d.store_id] !== undefined) {
        storeDataMap[d.delivery_date][d.store_id]++;
      }
    });
    
    // Filter to only stores that have data
    const storesWithData = activeStores.filter(store => {
      return dates.some(date => {
        const dateKey = date.toISOString().split('T')[0];
        return storeDataMap[dateKey]?.[store.id] > 0;
      });
    });
    const displayStores = storesWithData.length > 0 ? storesWithData : activeStores;
    
    // Calculate table dimensions
    const tableTop = 30;
    const rowHeight = 6;
    const dayColWidth = 20;
    const storeColWidth = Math.min(22, (pageWidth - leftMargin * 2 - dayColWidth - 25) / Math.max(displayStores.length, 1));
    const totalColWidth = 22;
    
    // Header row - store abbreviations
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.text('Day', leftMargin + 2, tableTop + 5);
    
    displayStores.forEach((store, i) => {
      const x = leftMargin + dayColWidth + (i * storeColWidth);
      const abbr = store.abbreviation || store.name?.substring(0, 2) || '??';
      doc.text(abbr, x + storeColWidth/2, tableTop + 5, { align: 'center' });
    });
    
    doc.text('Tot', leftMargin + dayColWidth + (displayStores.length * storeColWidth) + totalColWidth/2, tableTop + 5, { align: 'center' });
    
    // Draw header line
    doc.setDrawColor(100, 100, 100);
    doc.line(leftMargin, tableTop + rowHeight + 2, pageWidth - leftMargin, tableTop + rowHeight + 2);
    
    // Data rows - one per day
    doc.setFont('helvetica', 'normal');
    let y = tableTop + rowHeight + 8;
    
    // Store column totals
    const storeTotals = {};
    displayStores.forEach(store => { storeTotals[store.id] = 0; });
    let grandTotal = 0;
    
    dates.forEach((date) => {
      const dateKey = date.toISOString().split('T')[0];
      const dayNum = date.getDate().toString();
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      
      // Day number
      doc.setFont('helvetica', isWeekend ? 'bold' : 'normal');
      doc.text(dayNum, leftMargin + dayColWidth/2, y, { align: 'center' });
      doc.setFont('helvetica', 'normal');
      
      let dayTotal = 0;
      displayStores.forEach((store, i) => {
        const count = storeDataMap[dateKey]?.[store.id] || 0;
        dayTotal += count;
        storeTotals[store.id] += count;
        
        const x = leftMargin + dayColWidth + (i * storeColWidth);
        if (count > 0) {
          doc.text(count.toString(), x + storeColWidth/2, y, { align: 'center' });
        }
      });
      
      grandTotal += dayTotal;
      
      // Day total
      doc.setFont('helvetica', 'bold');
      if (dayTotal > 0) {
        doc.text(dayTotal.toString(), leftMargin + dayColWidth + (displayStores.length * storeColWidth) + totalColWidth/2, y, { align: 'center' });
      }
      doc.setFont('helvetica', 'normal');
      
      y += rowHeight;
    });
    
    // Totals row
    doc.setDrawColor(100, 100, 100);
    doc.line(leftMargin, y - 2, pageWidth - leftMargin, y - 2);
    y += 4;
    
    doc.setFont('helvetica', 'bold');
    doc.text('Tot', leftMargin + dayColWidth/2, y, { align: 'center' });
    
    displayStores.forEach((store, i) => {
      const total = storeTotals[store.id];
      const x = leftMargin + dayColWidth + (i * storeColWidth);
      if (total > 0) {
        doc.text(total.toString(), x + storeColWidth/2, y, { align: 'center' });
      }
    });
    
    doc.text(grandTotal.toString(), leftMargin + dayColWidth + (displayStores.length * storeColWidth) + totalColWidth/2, y, { align: 'center' });
    
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
      doc.text(`Store Returns: ${data.storeReturnCount || 0}`, col2, y);
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

  // Grand totals across all displayed drivers (only those with deliveries)
  const driversWithDeliveries = useMemo(() => payrollData.filter(d => d.totalDeliveries > 0), [payrollData]);
  const grandTotalAllDrivers = driversWithDeliveries.reduce((sum, d) => sum + d.grandTotal, 0);
  const grandTotalTax = driversWithDeliveries.reduce((sum, d) => sum + d.taxAmount, 0);
  const grandTotalDeductions = driversWithDeliveries.reduce((sum, d) => sum + d.deductions, 0);
  const grandTotalGross = driversWithDeliveries.reduce((sum, d) => sum + d.grossPay, 0);

  // Count finalized drivers for admin view
  const driversWithDeliveriesIds = useMemo(() => {
    return driversWithDeliveries.map(d => d.driver.id);
  }, [driversWithDeliveries]);

  const finalizedDriversCount = useMemo(() => {
    return driversWithDeliveriesIds.filter(driverId => {
      const record = getDriverPayrollRecord(driverId);
      return record?.status === 'driver_finalized' || 
             record?.status === 'admin_finalized' ||
             record?.status === 'paid';
    }).length;
  }, [driversWithDeliveriesIds, payrollRecords]);

  const allDriversFinalized = finalizedDriversCount === driversWithDeliveriesIds.length && driversWithDeliveriesIds.length > 0;

  // Check if finalization is allowed (today must be on or after pay period end date)
  const canFinalize = useMemo(() => {
    if (!currentPeriod?.end) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const periodEnd = new Date(currentPeriod.end);
    periodEnd.setHours(0, 0, 0, 0);
    return today >= periodEnd;
  }, [currentPeriod?.end]);
  
  // Check if admin has finalized
  const isAdminFinalized = useMemo(() => {
    if (driversWithDeliveriesIds.length === 0) return false;
    return driversWithDeliveriesIds.every(driverId => {
      const record = getDriverPayrollRecord(driverId);
      return record?.status === 'admin_finalized' || record?.status === 'paid';
    });
  }, [driversWithDeliveriesIds, payrollRecords]);

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
        {/* Mobile View: 2 rows */}
        <div className="md:hidden flex flex-col gap-2">
          {/* Row 1: Title and PDF Button */}
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base" style={{ color: 'var(--text-slate-900)' }}>
              <Calculator className="w-5 h-5" />
              Payroll
            </CardTitle>
            <Button size="sm" variant="outline" onClick={() => handleExport(stores || [])} className="gap-2 h-8" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
              <Download className="w-4 h-4" />
              PDF
            </Button>
          </div>
          
          {/* Row 2: Confirmed Drivers and Finalize Button */}
          <div className="flex items-center justify-between">
            {/* Admin View: Show finalization progress - multi-driver view only */}
              {isAdmin && driversWithDeliveriesIds.length > 0 && 
                selectedDriverId === 'all' && (
              <>
                {!isAdminFinalized && (
                  <>
                    <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                      <Users className="w-3 h-3 inline mr-1" />
                      {finalizedDriversCount}/{driversWithDeliveriesIds.length} confirmed
                    </span>
                    <Button 
                      size="sm" 
                      onClick={() => setShowConfirmDialog(true)} 
                      disabled={isFinalizing || isLoadingRecords || !canFinalize || isAdminFinalized}
                      className={`gap-2 h-8 ${allDriversFinalized && canFinalize ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-blue-600 hover:bg-blue-700'}`}
                      title={isAdminFinalized ? 'Already finalized' : !canFinalize ? 'Cannot finalize until pay period ends' : ''}
                    >
                      {allDriversFinalized ? (
                        <>
                          <CheckCircle className="w-4 h-4" />
                          {isFinalizing ? 'Finalizing...' : 'Finalize All'}
                        </>
                      ) : (
                        <>
                          <Clock className="w-4 h-4" />
                          {isFinalizing ? 'Finalizing...' : 'Finalize All'}
                        </>
                      )}
                    </Button>
                  </>
                )}
                {isAdminFinalized && (
                  <div className="flex items-center gap-1 text-sm text-emerald-600 font-medium px-2">
                    <CheckCircle className="w-4 h-4" />
                    Finalized
                  </div>
                )}
              </>
            )}
            
            {/* Driver View: Show Confirm/Confirmed status */}
            {((isDriver && selectedDriverId === currentUser?.id) || 
              (isAdmin && userHasRole(currentUser, 'driver') && selectedDriverId === currentUser?.id)) && (
              <>
                {!isCurrentDriverFinalized && (
                   <Button 
                     size="sm" 
                     onClick={() => setShowConfirmDialog(true)} 
                     disabled={isFinalizing || isLoadingRecords || !canFinalize || isCurrentDriverFinalized}
                     className="gap-2 bg-emerald-600 hover:bg-emerald-700 h-8 ml-auto"
                     title={isCurrentDriverFinalized ? 'Already confirmed' : !canFinalize ? 'Cannot finalize until pay period ends' : ''}
                   >
                     <CheckCircle className="w-4 h-4" />
                     {isFinalizing ? 'Finalizing...' : 'Confirm My Payroll'}
                   </Button>
                )}
                {isCurrentDriverFinalized && (
                  <div className="flex items-center gap-1 text-sm text-emerald-600 font-medium px-2 ml-auto">
                    <CheckCircle className="w-4 h-4" />
                    Confirmed
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        
        {/* Desktop View: Original single row layout */}
        <div className="hidden md:flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base" style={{ color: 'var(--text-slate-900)' }}>
            <Calculator className="w-5 h-5" />
            Payroll Summary
          </CardTitle>
          <div className="flex gap-2 items-center">
            <Button size="sm" variant="outline" onClick={() => handleExport(stores || [])} className="gap-2" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
              <Download className="w-4 h-4" />
              Export PDF
            </Button>
            
            {/* Driver Finalize Button - for drivers OR admin-drivers viewing their own payroll (single driver mode) */}
            {((isDriver && selectedDriverId === currentUser?.id) || 
              (isAdmin && userHasRole(currentUser, 'driver') && selectedDriverId === currentUser?.id)) && 
              !isCurrentDriverFinalized && (
              <Button 
                size="sm" 
                onClick={() => setShowConfirmDialog(true)} 
                disabled={isFinalizing || isLoadingRecords || !canFinalize || isCurrentDriverFinalized}
                className="gap-2 bg-emerald-600 hover:bg-emerald-700"
                title={isCurrentDriverFinalized ? 'Already confirmed' : !canFinalize ? 'Cannot finalize until pay period ends' : ''}
              >
                <CheckCircle className="w-4 h-4" />
                {isFinalizing ? 'Finalizing...' : 'Confirm My Payroll'}
              </Button>
            )}
            
            {/* Driver Finalized Status - for drivers OR admin-drivers viewing their own payroll */}
            {((isDriver && isCurrentDriverFinalized) || 
              (isAdmin && userHasRole(currentUser, 'driver') && selectedDriverId === currentUser?.id && isCurrentDriverFinalized)) && (
              <div className="flex items-center gap-1 text-sm text-emerald-600 font-medium px-2">
                <CheckCircle className="w-4 h-4" />
                Confirmed
              </div>
            )}

            {/* Admin View: Show finalization progress - but only in multi-driver view, NOT if viewing single driver */}
            {isAdmin && driversWithDeliveriesIds.length > 0 && 
              selectedDriverId === 'all' && (
              <>
                {!isAdminFinalized && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                      <Users className="w-3 h-3 inline mr-1" />
                      {finalizedDriversCount}/{driversWithDeliveriesIds.length} confirmed
                    </span>
                    <Button 
                      size="sm" 
                      onClick={() => setShowConfirmDialog(true)} 
                      disabled={isFinalizing || isLoadingRecords || !canFinalize || isAdminFinalized}
                      className={`gap-2 ${allDriversFinalized && canFinalize ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-blue-600 hover:bg-blue-700'}`}
                      title={isAdminFinalized ? 'Already finalized' : !canFinalize ? 'Cannot finalize until pay period ends' : ''}
                    >
                      {allDriversFinalized ? (
                        <>
                          <CheckCircle className="w-4 h-4" />
                          {isFinalizing ? 'Finalizing...' : 'Finalize All'}
                        </>
                      ) : (
                        <>
                          <Clock className="w-4 h-4" />
                          {isFinalizing ? 'Finalizing...' : 'Finalize All'}
                        </>
                      )}
                    </Button>
                  </div>
                )}
                {isAdminFinalized && (
                  <div className="flex items-center gap-1 text-sm text-emerald-600 font-medium px-2">
                    <CheckCircle className="w-4 h-4" />
                    Finalized
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </CardHeader>

      {/* Driver Confirmation Dialog - also for admin-drivers viewing their own payroll */}
      <Dialog open={showConfirmDialog && (isDriver || (isAdmin && userHasRole(currentUser, 'driver') && selectedDriverId === currentUser?.id))} onOpenChange={setShowConfirmDialog}>
        <DialogContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
              <CheckCircle className="w-5 h-5 text-emerald-500" />
              Confirm Your Payroll
            </DialogTitle>
            <DialogDescription style={{ color: 'var(--text-slate-600)' }}>
              You are confirming your payroll for <strong>{currentPeriod?.label}</strong>.
              <br /><br />
              <strong>Total Gross Pay:</strong> {formatCurrency(payrollData.find(d => d.driver.id === currentUser?.id)?.grossPay || 0)}
              <br /><br />
              Please review your deliveries and pay above before confirming. Once confirmed, you will not be able to edit any stops for this pay period.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowConfirmDialog(false)} disabled={isFinalizing} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
              Cancel
            </Button>
            <Button 
              onClick={() => {
                const myData = payrollData.find(d => d.driver.id === currentUser?.id);
                if (myData) handleDriverFinalize(myData);
              }}
              disabled={isFinalizing}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {isFinalizing ? 'Confirming...' : 'Confirm My Payroll'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Admin Confirmation Dialog - but NOT for admin-drivers viewing their own payroll */}
      <Dialog open={showConfirmDialog && isAdmin && !(userHasRole(currentUser, 'driver') && selectedDriverId === currentUser?.id)} onOpenChange={setShowConfirmDialog}>
        <DialogContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
              <AlertCircle className="w-5 h-5 text-amber-500" />
              Finalize All Driver Payrolls
            </DialogTitle>
            <DialogDescription style={{ color: 'var(--text-slate-600)' }}>
              You are about to finalize payroll for <strong>{currentPeriod?.label}</strong>.
              <br /><br />
              <strong>Total Gross Pay:</strong> {formatCurrency(grandTotalGross)}
              <br />
              <strong>Drivers Confirmed:</strong> {finalizedDriversCount}/{driversWithDeliveriesIds.length}
              <br /><br />
              This will lock all deliveries for this pay period. Drivers will no longer be able to edit stops.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowConfirmDialog(false)} disabled={isFinalizing} style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
              Cancel
            </Button>
            <Button 
              onClick={handleAdminFinalize}
              disabled={isFinalizing}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {isFinalizing ? 'Finalizing...' : 'Finalize All Payrolls'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <CardContent>
        <div className="space-y-4">
          {payrollData.filter(data => data.totalDeliveries > 0).map((data, idx) => {
          const hasTaxOrDeductions = data.taxAmount > 0 || data.deductions > 0;
          const driverPayrollRecord = getDriverPayrollRecord(data.driver.id);
          const driverHasConfirmed = driverPayrollRecord?.status === 'driver_finalized' || 
                                      driverPayrollRecord?.status === 'admin_finalized' ||
                                      driverPayrollRecord?.status === 'paid';
          const adminHasFinalized = driverPayrollRecord?.status === 'admin_finalized' ||
                                     driverPayrollRecord?.status === 'paid';
          
          // For admins: show badge when driver confirmed
          // For drivers: show badge when admin finalized
          const showBadge = isAdmin ? driverHasConfirmed : adminHasFinalized;
          
          // Check if this is the current admin-driver's own card in "All Drivers" mode
          const isOwnCardInAllDriversMode = isAdmin && 
                                             userHasRole(currentUser, 'driver') && 
                                             selectedDriverId === 'all' && 
                                             data.driver.id === currentUser?.id;
          const canShowConfirmButton = isOwnCardInAllDriversMode && !driverHasConfirmed && canFinalize;
          
          // Mobile view
          const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
          
          if (isMobile) {
            return (
              <PayrollMobileCard
                key={data.driver.id}
                data={data}
                isAdmin={isAdmin}
                driverHasConfirmed={driverHasConfirmed}
                adminHasFinalized={adminHasFinalized}
                showBadge={showBadge}
                canShowConfirmButton={canShowConfirmButton}
                onConfirmClick={() => handleDriverFinalize(data)}
                isFinalizing={isFinalizing}
                formatCurrency={formatCurrency}
              />
            );
          }
          
          return (
          <div key={data.driver.id} className="hidden md:block p-3 rounded-lg" style={{ background: idx % 2 === 0 ? 'var(--bg-slate-50)' : 'transparent' }}>
              {/* Driver Name - Top Left with optional Confirm button for admin-drivers */}
              <div className="flex items-center justify-between mb-1">
                <h3 className="font-semibold flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
                  {data.driver.user_name || data.driver.full_name}
                  {showBadge && (
                    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500" title={isAdmin ? 'Driver confirmed' : 'Admin finalized'}>
                      <CheckCircle className="w-3.5 h-3.5 text-white" />
                    </span>
                  )}
                </h3>
                {canShowConfirmButton && (
                   <Button 
                     size="sm" 
                     onClick={() => handleDriverFinalize(data)} 
                     disabled={isFinalizing || isLoadingRecords || driverHasConfirmed}
                     className="gap-1 bg-emerald-600 hover:bg-emerald-700 text-xs h-7 px-2"
                     title={driverHasConfirmed ? 'Already confirmed' : ''}
                   >
                     <CheckCircle className="w-3 h-3" />
                     {isFinalizing ? '...' : 'Confirm My Payroll'}
                   </Button>
                )}
              </div>

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
                    <span className="bg-orange-100 text-orange-700 px-2 py-0.5 rounded text-[11px]">{data.storeReturnCount || 0}</span>
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
                        <span className="text-2xl font-bold mr-1">Gross:</span>
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