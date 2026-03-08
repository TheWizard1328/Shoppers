import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Download, Calculator, CheckCircle, AlertCircle, Clock, Users, Plus, X, Save, Share2, Loader2 } from 'lucide-react';
import html2canvas from 'html2canvas';
import ScreenshotShareModal from '../common/ScreenshotShareModal';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle } from
"@/components/ui/dialog";
import { base44 } from '@/api/base44Client';
import { useUser } from '../utils/UserContext';
import { userHasRole, isAppOwner } from '../utils/userRoles';
import { notifyDriverConfirmedPayroll, notifyAdminApprovedPayroll } from '../utils/deliveryMessaging';
import { calculateYtdPayroll } from '../utils/payrollYtdCalculator';
import PayrollMobileCard from './PayrollMobileCard'; import LeftStatsAndNotes from './LeftStatsAndNotes';
import { syncPayrollRecordsWithLiveData } from '../utils/payrollEntitySync';
import { exportPayrollPdf } from './payrollPdfExport';

// GST/HST rates by province (Canada)
const PROVINCE_TAX_RATES = {
  'AB': 0.05, // Alberta - GST only
  'BC': 0.05, // BC - GST only (PST separate)
  'SK': 0.05, // Saskatchewan - GST only
  'MB': 0.05, // Manitoba - GST only
  'ON': 0.13, // Ontario - HST
  'QC': 0.05, // Quebec - GST only (QST separate)
  'NB': 0.15, // New Brunswick - HST
  'NS': 0.15, // Nova Scotia - HST
  'PE': 0.15, // PEI - HST
  'NL': 0.15, // Newfoundland - HST
  'YT': 0.05, // Yukon - GST only
  'NT': 0.05, // Northwest Territories - GST only
  'NU': 0.05 // Nunavut - GST only
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
  const [driverEdits, setDriverEdits] = useState({});
  const [deductionOverlayDriverId, setDeductionOverlayDriverId] = useState(null);
  const [bonusOverlayDriverId, setBonusOverlayDriverId] = useState(null);
  const [appFeeOverlayDriverId, setAppFeeOverlayDriverId] = useState(null);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState(null);
  const [showScreenshotModal, setShowScreenshotModal] = useState(false);
  const [appFeesPerDelivery, setAppFeesPerDelivery] = useState(0);
  const [extraAppFeePercent, setExtraAppFeePercent] = useState(0);
  const [otherAppFeePercent, setOtherAppFeePercent] = useState(0);
  const [appFeeOverlayAllDriversId, setAppFeeOverlayAllDriversId] = useState(null);
  const [activeInputField, setActiveInputField] = useState(null);
  const contentRef = useRef(null);

  const isAdmin = currentUser && userHasRole(currentUser, 'admin');
  const isDriver = currentUser && userHasRole(currentUser, 'driver') && !isAdmin;

  // Format period dates for querying
  const periodStartStr = currentPeriod?.start ? currentPeriod.start.toISOString().split('T')[0] : null;
  const periodEndStr = currentPeriod?.end ? currentPeriod.end.toISOString().split('T')[0] : null;

  const payrollData = useMemo(() => {
    if (!deliveries || !drivers || !appUsers || !currentPeriod) return [];
    const driversToCalc = selectedDriverId === 'all' ? drivers.filter((d) => d && d.status === 'active') : drivers.filter((d) => d && (d.id === selectedDriverId || d.user_id === selectedDriverId));
    return driversToCalc.map((driver) => {
      const driverId = driver.user_id || driver.id;
      const appUser = appUsers.find((au) => au && (au.user_id === driverId || au.id === driver.id)) || driver;
      const payRate = appUser?.pay_rate_per_delivery || 0;
      const extraKmRate = appUser?.extra_km_rate || 0;
      const extraKmLimit = appUser?.extra_km_limit || 0;
      const oversizedRate = appUser?.oversized_item_rate || 0;

      const periodDeliveries = deliveries.filter((d) => {
        if (!d || !d.delivery_date || d.driver_id !== driverId) return false;
        if (!d.patient_id && !d.after_hours_pickup) return false;
        if (d.status === 'completed' || d.status === 'failed') { /* valid */ }
        else if (d.status === 'cancelled') {
          const isStoreReturn = /\[[\w\s]+\]/.test(d.patient_name || '') && (d.patient_name || '').toLowerCase().includes('return');
          if (!d.after_hours_pickup && !isStoreReturn) return false;
        } else return false;
        const date = new Date(d.delivery_date + 'T00:00:00');
        return date >= currentPeriod.start && date <= currentPeriod.end;
      });

      const deliveryCount = periodDeliveries.length;
      const basePay = deliveryCount * payRate;

      let extraKmPay = 0, totalExtraKm = 0;
      periodDeliveries.forEach((d) => {
        let dist = d.paid_km_override || 0;
        if (!dist && d.patient_id && patients) { dist = patients.find((p) => p && p.id === d.patient_id)?.distance_from_store || 0; }
        if (dist > extraKmLimit && extraKmRate > 0) { const ek = dist - extraKmLimit; totalExtraKm += ek; extraKmPay += ek * extraKmRate; }
      });

      const oversizedCount = periodDeliveries.filter((d) => d.oversized).length;
      const oversizedPay = oversizedCount * oversizedRate;
      const payrollRecord = payrollRecords.find((r) => r.driver_id === driverId);
      const appFeePercentage = payrollRecord?.app_fee_percentage ?? appUser?.app_fee_percentage ?? 0;
      const afterHoursCount = periodDeliveries.filter((d) => d.after_hours_pickup).length;
      const failedCount = periodDeliveries.filter((d) => d.status === 'failed').length;
      const returnsCount = periodDeliveries.filter((d) => d.status === 'cancelled' && !d.after_hours_pickup).length;
      const storeReturnCount = deliveries.filter((d) => {
        if (!d || d.driver_id !== driverId) return false;
        const date = new Date(d.delivery_date + 'T00:00:00');
        if (date < currentPeriod.start || date > currentPeriod.end) return false;
        const combined = ((d.patient_name || '') + ' ' + (d.delivery_notes || '')).toLowerCase();
        const sn = stores.find((s) => s?.id === d.store_id)?.name || '';
        return sn && combined.includes(sn.toLowerCase()) && combined.includes('return');
      }).length;
      const totalPay = basePay + extraKmPay + oversizedPay;
      const gstHstEnabled = appUser?.gst_hst_enabled || false;
      let taxAmount = 0, taxRate = 0, provinceCode = null;
      if (gstHstEnabled && cities) {
        const driverCity = appUser?.city_id ? cities.find((c) => c && c.id === appUser.city_id) : null;
        if (driverCity?.province_state) {
          const prov = driverCity.province_state.toUpperCase();
          const PM = { 'ALBERTA': 'AB', 'BRITISH COLUMBIA': 'BC', 'SASKATCHEWAN': 'SK', 'MANITOBA': 'MB', 'ONTARIO': 'ON', 'QUEBEC': 'QC', 'NEW BRUNSWICK': 'NB', 'NOVA SCOTIA': 'NS', 'PRINCE EDWARD ISLAND': 'PE', 'NEWFOUNDLAND': 'NL', 'NEWFOUNDLAND AND LABRADOR': 'NL', 'YUKON': 'YT', 'NORTHWEST TERRITORIES': 'NT', 'NUNAVUT': 'NU' };
          provinceCode = prov.length === 2 && PROVINCE_TAX_RATES[prov] ? prov : PM[prov] || null;
          if (provinceCode && PROVINCE_TAX_RATES[provinceCode]) { taxRate = PROVINCE_TAX_RATES[provinceCode]; taxAmount = totalPay * taxRate; }
        }
      }
      const deductionsArray = Array.isArray(appUser?.deductions) ? appUser.deductions : [];
      const totalDeductions = totalPay > 0 ? deductionsArray.reduce((sum, d) => sum + (d?.amount || 0), 0) : 0;
      const grossPay = totalPay > 0 ? totalPay + taxAmount - totalDeductions : 0;

      return {
        driver: { ...driver, id: driverId }, payRate, extraKmRate, extraKmLimit, oversizedRate,
        totalDeliveries: deliveryCount, totalBasePay: basePay, totalExtraKm, totalExtraKmPay: extraKmPay,
        oversizedCount, totalOversizedPay: oversizedPay, afterHoursCount, failedCount, returnsCount,
        storeReturnCount, grandTotal: totalPay, gstHstEnabled, taxRate, taxAmount, provinceCode,
        deductions: totalDeductions, deductionsArray, grossPay, appFeePercentage
      };
    });
  }, [deliveries, drivers, appUsers, patients, cities, selectedYear, selectedDriverId, currentPeriod]);

  const lastFetchRef = React.useRef({ timestamp: 0 });
  const lastAutoCreatePeriodRef = React.useRef(null);
  const autoCreateInProgressRef = React.useRef(false);
  const initialYtdCalculationDone = React.useRef(false);

  // Calculate YTD values whenever period changes
  useEffect(() => {
    if (!currentPeriod) return;
    if (periodStartStr && periodEndStr) initialYtdCalculationDone.current = false;
    if (initialYtdCalculationDone.current) return;
    initialYtdCalculationDone.current = true;
    const yearStart = new Date(currentPeriod.start.getFullYear(), 0, 1).toISOString().split('T')[0];
    const periodEnd = currentPeriod.end.toISOString().split('T')[0];
    base44.entities.Payroll.filter({ pay_period_end: { $gte: yearStart, $lte: periodEnd } }).then((records) => { setPayrollRecords(records || []); if (onPayrollRecordsChange) onPayrollRecordsChange(records || []); }).catch(() => {});
  }, [currentPeriod, periodStartStr, periodEndStr]);

  // Fetch payroll records (external or local with 15-sec refresh)
  useEffect(() => {
    if (externalPayrollRecords) { setPayrollRecords(externalPayrollRecords); setIsLoadingRecords(false); return; }
    if (!currentPeriod) return;
    const fetch = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastFetchRef.current.timestamp < 15000) return;
      setIsLoadingRecords(true);
      try {
        const ys = new Date(currentPeriod.start.getFullYear(), 0, 1).toISOString().split('T')[0];
        const pe = currentPeriod.end.toISOString().split('T')[0];
        const records = await base44.entities.Payroll.filter({ pay_period_end: { $gte: ys, $lte: pe } });
        setPayrollRecords(records || []); if (onPayrollRecordsChange) onPayrollRecordsChange(records || []);
        lastFetchRef.current.timestamp = now;
      } catch (e) { /* ignore */ } finally { setIsLoadingRecords(false); }
    };
    fetch(true);
    const interval = setInterval(() => fetch(), 15000);
    return () => clearInterval(interval);
  }, [currentPeriod, externalPayrollRecords, periodStartStr, periodEndStr]);

  // Auto-create missing Payroll records - ONLY when period changes
  useEffect(() => {
    if (!periodStartStr || !periodEndStr || !payrollData || payrollData.length === 0) return;
    const currentPeriodKey = `${periodStartStr}-${periodEndStr}`;
    if (lastAutoCreatePeriodRef.current === currentPeriodKey || autoCreateInProgressRef.current) return;
    lastAutoCreatePeriodRef.current = currentPeriodKey;
    autoCreateInProgressRef.current = true;
    const autoCreateMissingRecords = async () => {
      try {
        const latestRecords = await base44.entities.Payroll.filter({ pay_period_start: periodStartStr, pay_period_end: periodEndStr });
        const driversWithDeliveries = payrollData.filter((data) => data.totalDeliveries > 0).map((data) => data.driver.id);
        if (driversWithDeliveries.length === 0) return;
        const existingDriverIds = new Set(latestRecords.map((r) => r.driver_id));
        const driversNeedingRecords = driversWithDeliveries.filter((driverId) => !existingDriverIds.has(driverId));
        if (driversNeedingRecords.length === 0) return;
        console.log(`🔄 [Payroll] Auto-creating ${driversNeedingRecords.length} records`);

        // Create records for missing drivers
        const newRecords = await Promise.all(
          driversNeedingRecords.map((driverId) => {
            const driverData = payrollData.find((d) => d.driver.id === driverId);
            const periodAppFeeAmount = countBillableDeliveries(driverId) * (driverData?.appFeePercentage || 0) / 100;

            const recordData = { driver_id: driverId, city_id: selectedCityId && selectedCityId !== 'all' ? selectedCityId : null,
              pay_period_start: periodStartStr, pay_period_end: periodEndStr, pay_period_type: payPeriod,
              total_deliveries: driverData?.totalDeliveries || 0, total_extra_km: driverData?.totalExtraKm || 0,
              total_oversized_deliveries: driverData?.oversizedCount || 0, total_after_hours_deliveries: driverData?.afterHoursCount || 0,
              gross_pay: driverData?.grossPay || 0, net_pay: driverData?.grandTotal || 0,
              total_deductions: driverData?.deductions || 0, deductions: driverData?.deductionsArray || [],
              bonus_pay: 0, app_fee_percentage: 0, app_fee_amount: periodAppFeeAmount,
              tax_amount: driverData?.taxAmount || 0, pay_rate_per_delivery: driverData?.payRate || 0,
              extra_km_rate: driverData?.extraKmRate || 0, extra_km_limit: driverData?.extraKmLimit || 0,
              oversized_item_rate: driverData?.oversizedRate || 0, gst_hst_enabled: driverData?.gstHstEnabled || false, status: 'draft' };

            return base44.entities.Payroll.create(roundPayrollData(recordData));
          })
        );

        const allRecords = [...latestRecords, ...newRecords];
        setPayrollRecords(allRecords);
        if (onPayrollRecordsChange) onPayrollRecordsChange(allRecords);
      } catch (error) { console.error('❌ [Payroll] Auto-create failed:', error); }
      finally { autoCreateInProgressRef.current = false; }
    };
    autoCreateMissingRecords();
  }, [periodStartStr, periodEndStr]);

  // Get finalization status for each driver
  // CRITICAL: Only return records that match the current period's dates
  const getDriverPayrollRecord = (driverId) => {
    return payrollRecords.find((r) =>
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



  // Count billable deliveries for app fee calculation
  const countBillableDeliveries = useCallback((driverId) => {
    let count = 0;
    deliveries.forEach((d) => {
      if (!d || (driverId && d.driver_id !== driverId)) return;
      const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
      if (deliveryDate < new Date(periodStartStr + 'T00:00:00') || deliveryDate > new Date(periodEndStr + 'T00:00:00')) return;
      const validStatus = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' && d.after_hours_pickup;
      if (!validStatus) return;
      if (!d.patient_id && !d.after_hours_pickup) return;
      const store = stores.find((s) => s?.id === d.store_id);
      if (!store) return;
      let paysAppFees = store.pays_app_fees || false;
      if (store.app_fee_history?.length > 0) {
        const sorted = [...store.app_fee_history].sort((a, b) => new Date(b.effective_date) - new Date(a.effective_date));
        const entry = sorted.find((e) => new Date(e.effective_date) <= deliveryDate);
        if (entry) paysAppFees = entry.pays_app_fees;
      }
      if (paysAppFees) count++;
    });
    return count;
  }, [deliveries, stores, periodStartStr, periodEndStr]);

  // Handle immediate save to Payroll entity and offline DB
  const savePayrollChanges = async (driverId, updates) => {
    try {
      let existingRecord = getDriverPayrollRecord(driverId);
      if (!existingRecord) {
        const driverData = payrollData.find((d) => d.driver.id === driverId);
        if (!driverData) return;
        const saveAppFeeAmount = countBillableDeliveries(driverId) * (driverData.appFeePercentage || 0) / 100;

        const newRecordData = { driver_id: driverId, city_id: selectedCityId && selectedCityId !== 'all' ? selectedCityId : null,
          pay_period_start: periodStartStr, pay_period_end: periodEndStr, pay_period_type: payPeriod,
          total_deliveries: driverData.totalDeliveries, total_extra_km: driverData.totalExtraKm,
          total_oversized_deliveries: driverData.oversizedCount, total_after_hours_deliveries: driverData.afterHoursCount || 0,
          gross_pay: driverData.grossPay, net_pay: driverData.grandTotal,
          total_deductions: driverData.deductions, deductions: driverData.deductionsArray,
          bonus_pay: 0, app_fee_percentage: 0, app_fee_amount: saveAppFeeAmount,
          tax_amount: driverData.taxAmount, pay_rate_per_delivery: driverData.payRate,
          extra_km_rate: driverData.extraKmRate, extra_km_limit: driverData.extraKmLimit,
          oversized_item_rate: driverData.oversizedRate, gst_hst_enabled: driverData.gstHstEnabled, status: 'draft' };

        const newRecord = await base44.entities.Payroll.create(roundPayrollData(newRecordData));

        setPayrollRecords((prev) => [...prev, newRecord]);
        if (onPayrollRecordsChange) {
          onPayrollRecordsChange([...payrollRecords, newRecord]);
        }
        existingRecord = newRecord;
      }

      const driverData = payrollData.find((d) => d.driver.id === driverId);
      let recalculatedUpdates = { ...updates };
      if (updates.deductions !== undefined || updates.bonus_pay !== undefined) {
        const newDed = updates.total_deductions !== undefined ? updates.total_deductions : existingRecord.total_deductions || 0;
        const newBonus = updates.bonus_pay !== undefined ? updates.bonus_pay : existingRecord.bonus_pay || 0;
        recalculatedUpdates.gross_pay = (driverData?.grandTotal || existingRecord.net_pay || 0) + (driverData?.taxAmount || 0) - newDed + newBonus;
      }
      const updatedRecord = await base44.entities.Payroll.update(existingRecord.id, roundPayrollData(recalculatedUpdates));
      setPayrollRecords((prev) => prev.map((r) => r.id === existingRecord.id ? { ...r, ...updatedRecord } : r));
      if (onPayrollRecordsChange) onPayrollRecordsChange(payrollRecords.map((r) => r.id === existingRecord.id ? { ...r, ...updatedRecord } : r));
      try { const { offlineDB } = await import('../utils/offlineDatabase'); await offlineDB.save(offlineDB.STORES.PAYROLL, { ...existingRecord, ...updatedRecord }); } catch (e) { /* ignore */ }
      lastFetchRef.current.timestamp = 0;
      if (refreshPayrollRecords) await refreshPayrollRecords();
    } catch (error) { console.error('❌ [Payroll] Failed to save changes:', error); }
  };

  // Handle bonus pay save and close
  const handleBonusClose = async () => {
    const driverId = bonusOverlayDriverId;
    if (!driverId) return;
    setBonusOverlayDriverId(null);
  };

  // Handle driver finalization
  const handleDriverFinalize = async (driverData) => {
    setIsFinalizing(true);
    try {
      const existingRecord = getDriverPayrollRecord(driverData.driver.id);
      const edit = driverEdits[driverData.driver.id] || {};
      const finalizeAppFeeAmount = countBillableDeliveries(driverData.driver.id) * (edit.appFeePercent || 0) / 100;
      const payrollRecord = { driver_id: driverData.driver.id, city_id: selectedCityId || null,
        pay_period_start: periodStartStr, pay_period_end: periodEndStr, pay_period_type: payPeriod,
        total_deliveries: driverData.totalDeliveries, total_extra_km: driverData.totalExtraKm,
        total_oversized_deliveries: driverData.oversizedCount, total_after_hours_deliveries: driverData.afterHoursCount || 0,
        gross_pay: driverData.grossPay, net_pay: driverData.grandTotal,
        total_deductions: driverData.deductions, deductions: driverData.deductionsArray,
        bonus_pay: edit.bonusPay || 0, app_fee_percentage: edit.appFeePercent || 0, app_fee_amount: finalizeAppFeeAmount,
        tax_amount: driverData.taxAmount, pay_rate_per_delivery: driverData.payRate,
        extra_km_rate: driverData.extraKmRate, extra_km_limit: driverData.extraKmLimit,
        oversized_item_rate: driverData.oversizedRate, gst_hst_enabled: driverData.gstHstEnabled,
        status: 'driver_finalized', driver_finalized_at: new Date().toISOString() };
      if (existingRecord) await base44.entities.Payroll.update(existingRecord.id, roundPayrollData(payrollRecord));
      else await base44.entities.Payroll.create(roundPayrollData(payrollRecord));
      try { await notifyDriverConfirmedPayroll({ driver: currentUser, periodLabel: currentPeriod?.label || 'this period', appUsers, excludeUserId: isAdmin ? currentUser?.id : null }); } catch (e) { /* ignore */ }
      if (refreshPayrollRecords) await refreshPayrollRecords();
      else { const records = await base44.entities.Payroll.filter({ pay_period_start: periodStartStr, pay_period_end: periodEndStr }); setPayrollRecords(records || []); if (onPayrollRecordsChange) onPayrollRecordsChange(records || []); }
    } catch (error) { console.error('❌ [Payroll] Failed to finalize:', error); alert('Failed to save payroll confirmation.'); }
    finally { setIsFinalizing(false); setShowConfirmDialog(false); }
  };

  // Handle admin finalization (all drivers)
  const handleAdminFinalize = async () => {
    setIsFinalizing(true);
    try {
      const dwdList = payrollData.filter((d) => d.totalDeliveries > 0);
      for (const dd of dwdList) {
        const rec = getDriverPayrollRecord(dd.driver.id);
        if (rec) await base44.entities.Payroll.update(rec.id, { status: 'admin_finalized', admin_finalized_at: new Date().toISOString(), admin_finalized_by: currentUser?.id });
      }
      await notifyAdminApprovedPayroll({ admin: currentUser, periodLabel: currentPeriod?.label || 'this period', driversWithDeliveries: dwdList, appUsers });
      if (refreshPayrollRecords) { await refreshPayrollRecords(); }
      else { const records = await base44.entities.Payroll.filter({ pay_period_start: periodStartStr, pay_period_end: periodEndStr }); setPayrollRecords(records || []); if (onPayrollRecordsChange) onPayrollRecordsChange(records || []); }
      if (onFinalizePayroll) onFinalizePayroll({ period: currentPeriod, payrollData: dwdList, grandTotals: { Gross: grandTotalAllDrivers, tax: grandTotalTax, deductions: grandTotalDeductions, Net: grandTotalGross } });
    } catch (error) { console.error('Failed to admin finalize payroll:', error); }
    finally { setIsFinalizing(false); setShowConfirmDialog(false); }
  };

  // Handle screenshot capture for sharing
  const handleCaptureScreenshot = async () => {
    if (!contentRef.current) return;
    setIsCapturingScreenshot(true);
    try {
      const controlsElement = document.getElementById('payroll-controls');
      if (controlsElement) controlsElement.style.display = 'none';
      const userCanSeeAppFee = isAppOwner(currentUser) || isDriver && selectedDriverId === currentUser?.id;
      const appFeeRows = document.querySelectorAll('[data-app-fee-row="true"]');
      const appFeeYtdRows = document.querySelectorAll('[data-app-fee-ytd-row="true"]');
      if (!userCanSeeAppFee) { appFeeRows.forEach((r) => r.style.display = 'none'); appFeeYtdRows.forEach((r) => r.style.display = 'none'); }
      const canvas = await html2canvas(contentRef.current, { backgroundColor: '#ffffff', scale: 2, useCORS: true, logging: false });
      setScreenshotDataUrl(canvas.toDataURL('image/png'));
      setShowScreenshotModal(true);
      if (controlsElement) controlsElement.style.display = 'flex';
      appFeeRows.forEach((r) => r.style.display = '');
      appFeeYtdRows.forEach((r) => r.style.display = '');
    } catch (error) { console.error('Failed to capture screenshot:', error); }
    finally { setIsCapturingScreenshot(false); }
  };

  // Export to PDF (extracted to payrollPdfExport.js)
  const handleExport = (storesList = []) => {
    exportPayrollPdf({
      currentPeriod, selectedDriverId, selectedCityId, payPeriod, payrollData,
      deliveries, patients, stores: storesList, cities, currentUser,
      grandTotalAllDrivers, grandTotalTax, grandTotalDeductions, grandTotalGross,
      driverEdits, calculateAppFeeAmount, extraAppFeePercent, otherAppFeePercent, isPeriodEndOfMonth,
      driversWithDeliveries, appFeesPerDelivery
    });
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

  // Round currency values to 2 decimals before saving to Payroll entity
  const roundPayrollData = (data) => {
    const currencyFields = [
    'gross_pay', 'net_pay', 'total_deductions', 'bonus_pay', 'app_fee_amount',
    'tax_amount', 'pay_rate_per_delivery', 'extra_km_rate', 'extra_km_limit', 'oversized_item_rate'];

    const rounded = { ...data };
    currencyFields.forEach((field) => {
      if (rounded[field] !== undefined && rounded[field] !== null) {
        rounded[field] = Math.round(rounded[field] * 100) / 100;
      }
    });
    // Also round total_extra_km to 2 decimals for precision
    if (rounded.total_extra_km !== undefined && rounded.total_extra_km !== null) {
      rounded.total_extra_km = Math.round(rounded.total_extra_km * 100) / 100;
    }
    return rounded;
  };

  const driversWithDeliveries = useMemo(() => payrollData.filter((d) => d.totalDeliveries > 0), [payrollData]);
  const grandTotalAllDrivers = driversWithDeliveries.reduce((sum, d) => sum + d.grandTotal, 0);
  const grandTotalTax = driversWithDeliveries.reduce((sum, d) => sum + d.taxAmount, 0);
  const grandTotalDeductions = driversWithDeliveries.reduce((sum, d) => sum + d.deductions, 0);
  const grandTotalGross = driversWithDeliveries.reduce((sum, d) => sum + d.grossPay, 0);
  const driversWithDeliveriesIds = useMemo(() => driversWithDeliveries.map((d) => d.driver.id), [driversWithDeliveries]);
  const finalizedDriversCount = useMemo(() => driversWithDeliveriesIds.filter((id) => { const r = getDriverPayrollRecord(id); return r?.status === 'driver_finalized' || r?.status === 'admin_finalized' || r?.status === 'paid'; }).length, [driversWithDeliveriesIds, payrollRecords]);
  const allDriversFinalized = finalizedDriversCount === driversWithDeliveriesIds.length && driversWithDeliveriesIds.length > 0;
  const isPeriodEndOfMonth = useMemo(() => { if (!currentPeriod?.end) return false; const d = new Date(currentPeriod.end); const n = new Date(d); n.setDate(n.getDate() + 1); return n.getMonth() !== d.getMonth(); }, [currentPeriod?.end]);

  // Check if finalization is allowed (6pm local time on last day of pay period, or after)
  const canFinalize = useMemo(() => {
    if (!currentPeriod?.end || !cities || !currentUser) return false;
    const userCity = cities.find((c) => c && c.id === (currentUser.city_id || selectedCityId));
    const TZ = { 'AB': 'America/Edmonton', 'BC': 'America/Vancouver', 'SK': 'America/Regina', 'MB': 'America/Winnipeg', 'ON': 'America/Toronto', 'QC': 'America/Montreal', 'NB': 'America/Moncton', 'NS': 'America/Halifax', 'PE': 'America/Halifax', 'NL': 'America/St_Johns', 'YT': 'America/Whitehorse', 'NT': 'America/Yellowknife', 'NU': 'America/Iqaluit' };
    const pc = userCity?.province_state?.toUpperCase()?.substring(0, 2);
    const tz = pc && TZ[pc] || 'America/Edmonton';
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const pe = new Date(currentPeriod.end); pe.setHours(0, 0, 0, 0);
    if (today > pe) return true;
    if (today.getTime() === pe.getTime()) return now.getHours() >= 18;
    return false;
  }, [currentPeriod?.end, cities, currentUser, selectedCityId]);

  const isAdminFinalized = useMemo(() => driversWithDeliveriesIds.length > 0 && driversWithDeliveriesIds.every((id) => { const r = getDriverPayrollRecord(id); return r?.status === 'admin_finalized' || r?.status === 'paid'; }), [driversWithDeliveriesIds, payrollRecords]);

  // Calculate YTD data from payroll records
  const ytdDataByDriver = useMemo(() => {
    const ytdMap = {};
    payrollData.forEach((data) => {
      const yearStart = `${currentPeriod.start.getFullYear()}-01-01`;
      const periodEnd = currentPeriod.end.toISOString().split('T')[0];
      const ytdRecords = payrollRecords.filter((r) => r && r.driver_id === data.driver.id && r.pay_period_end >= yearStart && r.pay_period_end <= periodEnd);
      const appUser = appUsers.find((au) => au && (au.user_id === data.driver.id || au.id === data.driver.id));
      ytdMap[data.driver.id] = calculateYtdPayroll(ytdRecords, data, cities, appUser);
    });
    return ytdMap;
  }, [payrollData, payrollRecords, currentPeriod, appUsers, cities]);

  // Load app fees per delivery setting
  useEffect(() => {
    base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' }).then((settings) => {
      const sv = settings?.[0]?.setting_value;
      if (sv?.app_fees_per_delivery) setAppFeesPerDelivery(parseFloat(sv.app_fees_per_delivery));
      if (sv?.Extra_App_Fee_Percentage !== undefined) setExtraAppFeePercent(parseFloat(sv.Extra_App_Fee_Percentage));
      if (sv?.Other_App_Fee_Percentage !== undefined) setOtherAppFeePercent(parseFloat(sv.Other_App_Fee_Percentage));
    }).catch(() => {});
  }, []);

  const sumAllDriversAppFeePercent = useMemo(() => driversWithDeliveries.reduce((sum, d) => d.driver.id === currentUser?.id && isAppOwner(currentUser) ? sum : sum + (driverEdits[d.driver.id]?.appFeePercent || 0), 0), [driversWithDeliveries, driverEdits, currentUser]);
  const appOwnerAppFeePercent = useMemo(() => Math.max(0, 100 - sumAllDriversAppFeePercent - otherAppFeePercent), [sumAllDriversAppFeePercent, otherAppFeePercent]);
  const ytdGrandTotalGross = useMemo(() => driversWithDeliveries.reduce((sum, d) => sum + (ytdDataByDriver[d.driver.id]?.ytdGrossPay ?? 0), 0), [driversWithDeliveries, ytdDataByDriver]);
  const ytdGrandTotalTax = useMemo(() => driversWithDeliveries.reduce((sum, d) => sum + (ytdDataByDriver[d.driver.id]?.ytdTaxAmount ?? 0), 0), [driversWithDeliveries, ytdDataByDriver]);
  const ytdGrandTotalDeductions = useMemo(() => driversWithDeliveries.reduce((sum, d) => sum + (ytdDataByDriver[d.driver.id]?.ytdDeductionsAmount ?? 0), 0), [driversWithDeliveries, ytdDataByDriver]);
  const ytdGrandTotalBonus = useMemo(() => driversWithDeliveries.reduce((sum, d) => sum + (ytdDataByDriver[d.driver.id]?.ytdBonusAmount ?? 0), 0), [driversWithDeliveries, ytdDataByDriver]);
  const ytdGrandTotalNet = useMemo(() => driversWithDeliveries.reduce((sum, d) => sum + (ytdDataByDriver[d.driver.id]?.ytdNetPay ?? 0), 0), [driversWithDeliveries, ytdDataByDriver]);

  // Calculate AppFeeAmount for a driver - distribute from total monthly app fee pool (calendar month)
  const calculateAppFeeAmount = useCallback((driverId, appFeePercent) => {
    if (appFeePercent <= 0 || appFeesPerDelivery === 0) return 0;
    const calMonth = new Date(currentPeriod.start.getFullYear(), currentPeriod.start.getMonth(), 1);
    const calMonthEnd = new Date(currentPeriod.start.getFullYear(), currentPeriod.start.getMonth() + 1, 0);
    let total = 0;
    deliveries.forEach((d) => {
      if (!d || !d.store_id) return;
      const dd = new Date(d.delivery_date + 'T00:00:00');
      if (dd < calMonth || dd > calMonthEnd) return;
      const valid = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' && d.after_hours_pickup;
      if (!valid || !d.patient_id && !d.after_hours_pickup) return;
      const store = stores.find((s) => s?.id === d.store_id);
      if (!store) return;
      let pays = store.pays_app_fees || false;
      if (store.app_fee_history?.length > 0) {
        const sorted = [...store.app_fee_history].sort((a, b) => new Date(b.effective_date) - new Date(a.effective_date));
        const entry = sorted.find((e) => new Date(e.effective_date) <= dd);
        if (entry) pays = entry.pays_app_fees;
      }
      if (pays) total++;
    });
    return total * appFeesPerDelivery * appFeePercent / 100;
  }, [deliveries, stores, currentPeriod, appFeesPerDelivery]);

  // Initialize and sync driver edits with payroll records
  useEffect(() => {
    const newEdits = {};
    payrollData.filter((d) => d.totalDeliveries > 0).forEach((data) => {
      const k = data.driver.id;
      const pr = getDriverPayrollRecord(k);
      newEdits[k] = {
        deductions: pr?.deductions || data.deductionsArray || [],
        bonusPay: pr?.bonus_pay !== undefined ? pr.bonus_pay : 0,
        appFeePercent: pr?.app_fee_percentage ?? 0,
        appFeeAmount: pr?.app_fee_amount ?? 0,
        showDeductionManager: false, newDeductionName: '', newDeductionAmount: ''
      };
    });
    setDriverEdits(newEdits);
  }, [payrollData, payrollRecords, calculateAppFeeAmount]);

  // Guard clause AFTER all hooks
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
    <>
      <style>{`
        input[type='number'].no-spinner::-webkit-outer-spin-button,
        input[type='number'].no-spinner::-webkit-inner-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        input[type='number'].no-spinner[type=number] {
          -moz-appearance: textfield;
        }
      `}</style>
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
              selectedDriverId === 'all' &&
              <>
                {!isAdminFinalized &&
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
                    title={isAdminFinalized ? 'Already finalized' : !canFinalize ? 'Cannot finalize until pay period ends' : ''}>

                      {allDriversFinalized ?
                    <>
                          <CheckCircle className="w-4 h-4" />
                          {isFinalizing ? 'Finalizing...' : 'Finalize All'}
                        </> :

                    <>
                          <Clock className="w-4 h-4" />
                          {isFinalizing ? 'Finalizing...' : 'Finalize All'}
                        </>
                    }
                    </Button>
                  </>
                }
                {isAdminFinalized &&
                <div className="flex items-center gap-1 text-sm text-emerald-600 font-medium px-2">
                    <CheckCircle className="w-4 h-4" />
                    Finalized
                  </div>
                }
              </>
              }
            
            {/* Driver View: Show Confirm/Confirmed status */}
            {(isDriver && selectedDriverId === currentUser?.id ||
              isAdmin && userHasRole(currentUser, 'driver') && selectedDriverId === currentUser?.id) &&
              <>
                {!isCurrentDriverFinalized &&
                <Button
                  size="sm"
                  onClick={() => setShowConfirmDialog(true)}
                  disabled={isFinalizing || isLoadingRecords || !canFinalize || isCurrentDriverFinalized}
                  className="gap-2 bg-emerald-600 hover:bg-emerald-700 h-8 ml-auto"
                  title={isCurrentDriverFinalized ? 'Already confirmed' : !canFinalize ? 'Cannot finalize until pay period ends' : ''}>

                     <CheckCircle className="w-4 h-4" />
                     {isFinalizing ? 'Finalizing...' : 'Confirm My Payroll'}
                   </Button>
                }
                {isCurrentDriverFinalized &&
                <div className="flex items-center gap-1 text-sm text-emerald-600 font-medium px-2 ml-auto">
                    <CheckCircle className="w-4 h-4" />
                    Confirmed
                  </div>
                }
              </>
              }
          </div>
        </div>
        
        {/* Desktop View: Original single row layout */}
        <div className="hidden md:flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base" style={{ color: 'var(--text-slate-900)' }}>
            <Calculator className="w-5 h-5" />
            Payroll Summary
          </CardTitle>
          <div className="flex gap-2 items-center" id="payroll-controls">
            <Button size="sm" variant="outline" onClick={() => handleExport(stores || [])} className="gap-2" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
              <Download className="w-4 h-4" />
              PDF
            </Button>
            
            {/* Driver Finalize Button - for drivers OR admin-drivers viewing their own payroll (single driver mode) */}
            {(isDriver && selectedDriverId === currentUser?.id ||
              isAdmin && userHasRole(currentUser, 'driver') && selectedDriverId === currentUser?.id) &&
              !isCurrentDriverFinalized &&
              <Button
                size="sm"
                onClick={() => setShowConfirmDialog(true)}
                disabled={isFinalizing || isLoadingRecords || !canFinalize || isCurrentDriverFinalized}
                className="gap-2 bg-emerald-600 hover:bg-emerald-700"
                title={isCurrentDriverFinalized ? 'Already confirmed' : !canFinalize ? 'Cannot finalize until pay period ends' : ''}>

                <CheckCircle className="w-4 h-4" />
                {isFinalizing ? 'Finalizing...' : 'Confirm My Payroll'}
              </Button>
              }
            
            {/* Driver Finalized Status - for drivers OR admin-drivers viewing their own payroll */}
            {(isDriver && isCurrentDriverFinalized ||
              isAdmin && userHasRole(currentUser, 'driver') && selectedDriverId === currentUser?.id && isCurrentDriverFinalized) &&
              <div className="flex items-center gap-1 text-sm text-emerald-600 font-medium px-2">
                <CheckCircle className="w-4 h-4" />
                Confirmed
              </div>
              }

            {/* Admin View: Show finalization progress - but only in multi-driver view, NOT if viewing single driver */}
            {isAdmin && driversWithDeliveriesIds.length > 0 &&
              selectedDriverId === 'all' &&
              <>
                {!isAdminFinalized &&
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
                    title={isAdminFinalized ? 'Already finalized' : !canFinalize ? 'Cannot finalize until pay period ends' : ''}>

                      {allDriversFinalized ?
                    <>
                          <CheckCircle className="w-4 h-4" />
                          {isFinalizing ? 'Finalizing...' : 'Finalize All'}
                        </> :

                    <>
                          <Clock className="w-4 h-4" />
                          {isFinalizing ? 'Finalizing...' : 'Finalize All'}
                        </>
                    }
                    </Button>
                  </div>
                }
                {isAdminFinalized &&
                <div className="flex items-center gap-1 text-sm text-emerald-600 font-medium px-2">
                    <CheckCircle className="w-4 h-4" />
                    Finalized
                  </div>
                }
              </>
              }
          </div>
        </div>
      </CardHeader>

      {/* Driver Confirmation Dialog - also for admin-drivers viewing their own payroll */}
      <Dialog open={showConfirmDialog && (isDriver || isAdmin && userHasRole(currentUser, 'driver') && selectedDriverId === currentUser?.id)} onOpenChange={setShowConfirmDialog}>
        <DialogContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
              <CheckCircle className="w-5 h-5 text-emerald-500" />
              Confirm Your Payroll
            </DialogTitle>
            <DialogDescription style={{ color: 'var(--text-slate-600)' }}>
              You are confirming your payroll for <strong>{currentPeriod?.label}</strong>.
              <br /><br />
              <strong>Total Gross Pay:</strong> {formatCurrency(payrollData.find((d) => d.driver.id === currentUser?.id)?.grossPay || 0)}
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
                  const myData = payrollData.find((d) => d.driver.id === currentUser?.id);
                  if (myData) handleDriverFinalize(myData);
                }}
                disabled={isFinalizing}
                className="bg-emerald-600 hover:bg-emerald-700">

              {isFinalizing ? 'Confirming...' : 'Confirm My Payroll'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deduction Manager Overlay Dialog */}
      {deductionOverlayDriverId && driverEdits[deductionOverlayDriverId] &&
        <Dialog open={true} onOpenChange={(open) => !open && setDeductionOverlayDriverId(null)}>
          <DialogContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
            <DialogHeader>
              <DialogTitle style={{ color: 'var(--text-slate-900)' }}>Manage Deductions</DialogTitle>
            </DialogHeader>
            
            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold" style={{ color: 'var(--text-slate-600)' }}>Current Deductions:</label>
                <div className="mt-2 space-y-1">
                  {driverEdits[deductionOverlayDriverId]?.deductions?.map((ded, idx) =>
                  <div key={idx} className="flex items-center justify-between text-sm p-2 bg-slate-50 rounded">
                      <span>{ded.name}</span>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">-${ded.amount.toFixed(2)}</span>
                        <button
                        onClick={async () => {
                          const updatedDeductions = driverEdits[deductionOverlayDriverId].deductions.filter((_, i) => i !== idx);
                          setDriverEdits((prev) => ({
                            ...prev,
                            [deductionOverlayDriverId]: {
                              ...prev[deductionOverlayDriverId],
                              deductions: updatedDeductions
                            }
                          }));
                          // Save immediately
                          await savePayrollChanges(deductionOverlayDriverId, {
                            deductions: updatedDeductions,
                            total_deductions: updatedDeductions.reduce((sum, d) => sum + (d?.amount || 0), 0)
                          });
                        }}
                        className="p-1 hover:bg-red-100 rounded">

                           <X className="w-4 h-4 text-red-600" />
                         </button>
                      </div>
                    </div>
                  )}
                  {!driverEdits[deductionOverlayDriverId]?.deductions?.length &&
                  <p className="text-xs text-slate-500">No deductions</p>
                  }
                </div>
              </div>
              
              <div className="border-t pt-3">
                <label className="text-xs font-semibold block mb-2" style={{ color: 'var(--text-slate-600)' }}>Add New Deduction:</label>
                <div className="space-y-2">
                  <input
                    type="text"
                    placeholder="Deduction name"
                    value={driverEdits[deductionOverlayDriverId]?.newDeductionName || ''}
                    onChange={(e) => setDriverEdits((prev) => ({
                      ...prev,
                      [deductionOverlayDriverId]: { ...prev[deductionOverlayDriverId], newDeductionName: e.target.value }
                    }))}
                    className="w-full px-2 py-1 text-sm border rounded" />

                  <div className="flex gap-2">
                    <span className="flex items-center">$</span>
                    <input
                      type="number"
                      placeholder="Amount"
                      value={driverEdits[deductionOverlayDriverId]?.newDeductionAmount || ''}
                      onChange={(e) => setDriverEdits((prev) => ({
                        ...prev,
                        [deductionOverlayDriverId]: { ...prev[deductionOverlayDriverId], newDeductionAmount: e.target.value }
                      }))}
                      className="flex-1 px-2 py-1 text-sm border rounded"
                      step="0.01" />

                    <button
                      onClick={async () => {
                        const name = driverEdits[deductionOverlayDriverId]?.newDeductionName;
                        const amount = driverEdits[deductionOverlayDriverId]?.newDeductionAmount;
                        if (name && amount) {
                          const newDeductions = [...(driverEdits[deductionOverlayDriverId].deductions || []), { name, amount: parseFloat(amount) }];
                          setDriverEdits((prev) => ({
                            ...prev,
                            [deductionOverlayDriverId]: {
                              ...prev[deductionOverlayDriverId],
                              deductions: newDeductions,
                              newDeductionName: '',
                              newDeductionAmount: ''
                            }
                          }));
                          // Save immediately
                          await savePayrollChanges(deductionOverlayDriverId, {
                            deductions: newDeductions,
                            total_deductions: newDeductions.reduce((sum, d) => sum + (d?.amount || 0), 0)
                          });
                        }
                      }}
                      className="px-3 py-1 bg-emerald-600 text-white rounded text-sm font-medium hover:bg-emerald-700">

                     Add
                    </button>
                  </div>
                </div>
              </div>
            </div>
            
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setDeductionOverlayDriverId(null)}
                style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>

                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        }

      {/* Bonus Manager Overlay Dialog */}
       {bonusOverlayDriverId && driverEdits[bonusOverlayDriverId] &&
        <Dialog open={true} onOpenChange={(open) => !open && handleBonusClose()}>
           <DialogContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
             <DialogHeader>
               <DialogTitle style={{ color: 'var(--text-slate-900)' }}>Manage Bonus Pay</DialogTitle>
             </DialogHeader>

             <div className="space-y-3">
               <div>
                 <label className="text-xs font-semibold block mb-2" style={{ color: 'var(--text-slate-600)' }}>Bonus Pay for {payrollData.find((d) => d.driver.id === bonusOverlayDriverId)?.driver.user_name}:</label>
                 <div className="flex gap-2">
                   <span className="flex items-center">$</span>
                   <input
                    type="number"
                    value={driverEdits[bonusOverlayDriverId]?.bonusPay || 0}
                    onChange={(e) => {
                      const newValue = parseFloat(e.target.value) || 0;
                      setDriverEdits((prev) => ({
                        ...prev,
                        [bonusOverlayDriverId]: { ...prev[bonusOverlayDriverId], bonusPay: newValue }
                      }));
                      // Save immediately
                      savePayrollChanges(bonusOverlayDriverId, { bonus_pay: newValue });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const closeButton = document.querySelector('[data-dialog-close="bonus"]');
                        if (closeButton) closeButton.click();
                      }
                    }}
                    placeholder="0.00"
                    className="flex-1 px-2 py-1 text-sm border rounded"
                    step="0.01" />

                 </div>
                 <p className="text-xs text-slate-500 mt-2">Enter the bonus amount to add to this driver's payroll for {currentPeriod?.label}.</p>
               </div>
             </div>

             <DialogFooter>
                <Button
                variant="outline"
                data-dialog-close="bonus"
                onClick={handleBonusClose}
                style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>

                  Close
                </Button>
              </DialogFooter>
           </DialogContent>
        </Dialog>
        }

      {/* App Owner Fee Manager Overlay Dialog */}
      {appFeeOverlayAllDriversId === 'all' && isAppOwner(currentUser) &&
        <Dialog open={true} onOpenChange={(open) => !open && setAppFeeOverlayAllDriversId(null)}>
       <DialogContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
         <DialogHeader>
           <DialogTitle style={{ color: 'var(--text-slate-900)' }}>Manage App Owner App Fee</DialogTitle>
         </DialogHeader>

         <div className="space-y-3">
           <p className="text-xs text-slate-600">Configure app fees for operational costs.</p>

           {/* Drivers Breakdown Table */}
           <div className="mt-4">
             <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-slate-900)' }}>Driver App Fee Breakdown</h3>
             <div className="border rounded" style={{ borderColor: 'var(--border-slate-200)', maxHeight: '350px', overflowY: 'auto' }}>
               <table className="w-full text-xs border-collapse">
                 <thead style={{ background: 'var(--bg-slate-100)', position: 'sticky', top: 0 }}>
                   <tr style={{ borderBottom: '1px solid var(--border-slate-200)' }}>
                     <th className="text-left px-2 py-1.5 font-semibold">Driver</th>
                     <th className="text-right px-2 py-1.5 font-semibold" style={{ width: '90px' }}>Fee %</th>
                     <th className="text-right px-2 py-1.5 font-semibold" style={{ width: '80px' }}>Fee $</th>
                   </tr>
                 </thead>
                 <tbody>
                   {driversWithDeliveries.map((driver, idx) => {
                        const driverAppFeePercent = driverEdits[driver.driver.id]?.appFeePercent || 0;
                        const driverAppFeeAmount = driverEdits[driver.driver.id]?.appFeeAmount !== undefined ? driverEdits[driver.driver.id].appFeeAmount : calculateAppFeeAmount(driver.driver.id, driverAppFeePercent);
                        const isCurrentUser = driver.driver.id === currentUser?.id;
                        const isAppOwnerRow = isCurrentUser && isAppOwner(currentUser);

                        return (
                          <tr key={driver.driver.id} style={{ borderBottom: '1px solid var(--border-slate-200)', background: isCurrentUser ? 'var(--bg-blue-50)' : idx % 2 === 0 ? 'var(--bg-slate-50)' : 'transparent' }}>
                         <td className="px-2 py-1.5 truncate text-left">
                           {driver.driver.user_name || driver.driver.full_name}
                           {isAppOwnerRow && <span className="text-xs font-semibold text-blue-600 ml-1">(App Owner)</span>}
                         </td>
                         <td className="text-right px-1 py-1.5">
                           <span className="text-[11px] font-medium">{driverAppFeePercent.toFixed(2)}%</span>
                         </td>
                         <td className="text-right px-1 py-1.5">
                           <input
                                type="number"
                                value={driverAppFeeAmount}
                                onChange={(e) => {
                                  const newAmount = parseFloat(e.target.value) || 0;
                                  let totalBillableCount = 0;
                                  const calendarMonth = new Date(currentPeriod.start.getFullYear(), currentPeriod.start.getMonth(), 1);
                                  const calendarMonthEnd = new Date(currentPeriod.start.getFullYear(), currentPeriod.start.getMonth() + 1, 0);
                                  deliveries.forEach((d) => {
                                    if (!d || !d.store_id) return;
                                    const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
                                    if (deliveryDate < calendarMonth || deliveryDate > calendarMonthEnd) return;
                                    const validStatus = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' && d.after_hours_pickup;
                                    if (!validStatus) return;
                                    if (!d.patient_id && !d.after_hours_pickup) return;
                                    const store = stores.find((s) => s?.id === d.store_id);
                                    if (!store) return;
                                    let paysAppFees = store.pays_app_fees || false;
                                    if (store.app_fee_history && store.app_fee_history.length > 0) {
                                      const sortedHistory = [...store.app_fee_history].sort((a, b) =>
                                      new Date(b.effective_date).getTime() - new Date(a.effective_date).getTime()
                                      );
                                      if (sortedHistory[0]) {
                                        paysAppFees = sortedHistory[0].pays_app_fees;
                                      }
                                    }
                                    if (paysAppFees) {
                                      totalBillableCount++;
                                    }
                                  });
                                  const totalMonthlyAppFees = totalBillableCount * appFeesPerDelivery;
                                  const newPercent = totalMonthlyAppFees > 0 ? newAmount / totalMonthlyAppFees * 100 : 0;

                                  setDriverEdits((prev) => ({
                                    ...prev,
                                    [driver.driver.id]: {
                                      ...prev[driver.driver.id],
                                      appFeePercent: newPercent,
                                      appFeeAmount: newAmount
                                    }
                                  }));

                                  // RULE 1 & 2: Recalculate based on who is being edited
                                  if (isAppOwnerRow) {
                                    // Editing App Owner → recalc Other App Fee
                                    const sumAllDrivers = driversWithDeliveries.reduce((sum, d) => {
                                      if (d.driver.id === driver.driver.id) return sum + newPercent;
                                      return sum + (driverEdits[d.driver.id]?.appFeePercent || 0);
                                    }, 0);
                                    const newOtherPercent = Math.max(0, 100 - sumAllDrivers);
                                    setOtherAppFeePercent(Math.round(newOtherPercent * 100) / 100);
                                  } else {
                                    // Editing regular driver → recalc App Owner fee
                                    const sumNonAppOwnerDrivers = driversWithDeliveries.reduce((sum, d) => {
                                      if (d.driver.id === currentUser?.id) return sum; // Skip App Owner
                                      if (d.driver.id === driver.driver.id) return sum + newPercent; // Use new value
                                      return sum + (driverEdits[d.driver.id]?.appFeePercent || 0);
                                    }, 0);
                                    const newAppOwnerPercent = Math.max(0, 100 - sumNonAppOwnerDrivers - otherAppFeePercent);
                                    setDriverEdits((prev) => ({
                                      ...prev,
                                      [currentUser.id]: {
                                        ...prev[currentUser.id],
                                        appFeePercent: newAppOwnerPercent,
                                        appFeeAmount: calculateAppFeeAmount(currentUser.id, newAppOwnerPercent)
                                      }
                                    }));
                                  }
                                }}
                                onBlur={(e) => {
                                  const value = parseFloat(e.target.value) || 0;
                                  setDriverEdits((prev) => ({
                                    ...prev,
                                    [driver.driver.id]: {
                                      ...prev[driver.driver.id],
                                      appFeeAmount: Math.round(value * 100) / 100
                                    }
                                  }));
                                }}
                                className="w-full px-1 py-0.5 border rounded text-right text-xs no-spinner"
                                step="any"
                                min="0" />
                         </td>
                       </tr>);

                      })}
                   {/* Other App Fee Row */}
                   <tr style={{ background: 'var(--bg-slate-50)', borderBottom: '1px solid var(--border-slate-200)' }}>
                     <td className="px-2 py-1.5 text-left">Other App Fee</td>
                     <td className="text-right px-1 py-1.5">
                       <span className="text-[11px] font-medium">{otherAppFeePercent.toFixed(2)}%</span>
                     </td>
                     <td className="text-right px-1 py-1.5">
                       <input
                            type="number"
                            value={calculateAppFeeAmount('other-app-fee', otherAppFeePercent).toFixed(2)}
                            onChange={(e) => {
                              const newAmount = parseFloat(e.target.value) || 0;
                              let totalBillableCount = 0;
                              const calendarMonth = new Date(currentPeriod.start.getFullYear(), currentPeriod.start.getMonth(), 1);
                              const calendarMonthEnd = new Date(currentPeriod.start.getFullYear(), currentPeriod.start.getMonth() + 1, 0);
                              deliveries.forEach((d) => {
                                if (!d || !d.store_id) return;
                                const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
                                if (deliveryDate < calendarMonth || deliveryDate > calendarMonthEnd) return;
                                const validStatus = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' && d.after_hours_pickup;
                                if (!validStatus) return;
                                if (!d.patient_id && !d.after_hours_pickup) return;
                                const store = stores.find((s) => s?.id === d.store_id);
                                if (!store) return;
                                let paysAppFees = store.pays_app_fees || false;
                                if (store.app_fee_history && store.app_fee_history.length > 0) {
                                  const sortedHistory = [...store.app_fee_history].sort((a, b) =>
                                  new Date(b.effective_date).getTime() - new Date(a.effective_date).getTime()
                                  );
                                  if (sortedHistory[0]) {
                                    paysAppFees = sortedHistory[0].pays_app_fees;
                                  }
                                }
                                if (paysAppFees) {
                                  totalBillableCount++;
                                }
                              });
                              const totalMonthlyAppFees = totalBillableCount * appFeesPerDelivery;
                              const newPercent = totalMonthlyAppFees > 0 ? newAmount / totalMonthlyAppFees * 100 : 0;
                              setOtherAppFeePercent(newPercent);

                              // RULE 3: Editing Other App Fee → recalc App Owner fee
                              const sumNonAppOwnerDrivers = driversWithDeliveries.reduce((sum, d) => {
                                if (d.driver.id === currentUser?.id) return sum; // Skip App Owner
                                return sum + (driverEdits[d.driver.id]?.appFeePercent || 0);
                              }, 0);
                              const newAppOwnerPercent = Math.max(0, 100 - sumNonAppOwnerDrivers - newPercent);
                              setDriverEdits((prev) => ({
                                ...prev,
                                [currentUser.id]: {
                                  ...prev[currentUser.id],
                                  appFeePercent: newAppOwnerPercent,
                                  appFeeAmount: calculateAppFeeAmount(currentUser.id, newAppOwnerPercent)
                                }
                              }));
                            }}
                            className="w-full px-1 py-0.5 border rounded text-right text-xs no-spinner"
                            step="0.01"
                            min="0" />
                     </td>
                   </tr>

                   {/* App Owner Row - Shows current user's app fee since they ARE the app owner */}
                   <tr style={{ background: 'var(--bg-slate-100)', borderTop: '2px solid var(--border-slate-300)' }}>
                     <td className="px-2 py-1.5 font-semibold">App Owner (You)</td>
                     <td className="text-right px-1 py-1.5">
                       <span className="text-[11px] font-semibold">{(driverEdits[currentUser?.id]?.appFeePercent || 0).toFixed(2)}%</span>
                     </td>
                     <td className="text-right px-1 py-1.5 font-semibold">${(driverEdits[currentUser?.id]?.appFeeAmount || calculateAppFeeAmount(currentUser?.id, driverEdits[currentUser?.id]?.appFeePercent || 0) || 0).toFixed(2)}</td>
                   </tr>
                 </tbody>
               </table>
             </div>
           </div>

           {/* Summary */}
           <div className="text-xs p-2 bg-slate-50 rounded mt-3">
             <div>Sum of Other Drivers: <strong>{sumAllDriversAppFeePercent.toFixed(2)}%</strong></div>
             <div>App Owner (You): <strong>{(driverEdits[currentUser?.id]?.appFeePercent || 0).toFixed(2)}%</strong></div>
             <div>Other App Fee: <strong>{otherAppFeePercent.toFixed(2)}%</strong></div>
             <div className="text-xs text-slate-500 mt-1 font-semibold">Total: {(sumAllDriversAppFeePercent + (driverEdits[currentUser?.id]?.appFeePercent || 0) + otherAppFeePercent).toFixed(2)}% / 100%</div>
           </div>
           </div>

           <DialogFooter>
           <Button
                variant="outline"
                onClick={async () => {
                  try {
                    // Save each driver's app fee percentage and amount - direct update without recalculation
                    for (const driver of driversWithDeliveries) {
                      const driverAppFeePercent = driverEdits[driver.driver.id]?.appFeePercent || 0;
                      const driverAppFeeAmount = driverEdits[driver.driver.id]?.appFeeAmount || 0;
                      const existingRecord = getDriverPayrollRecord(driver.driver.id);

                      if (existingRecord) {
                        await base44.entities.Payroll.update(existingRecord.id, {
                          app_fee_percentage: driverAppFeePercent,
                          app_fee_amount: driverAppFeeAmount
                        });
                      }
                    }

                    // Save Extra_App_Fee_Percentage and Other_App_Fee_Percentage to AppSettings
                    const settings = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
                    if (settings?.[0]) {
                      await base44.entities.AppSettings.update(settings[0].id, {
                        setting_value: {
                          ...settings[0].setting_value,
                          Extra_App_Fee_Percentage: extraAppFeePercent,
                          Other_App_Fee_Percentage: otherAppFeePercent
                        }
                      });
                    }
                    setAppFeeOverlayAllDriversId(null);
                  } catch (error) {
                    console.error('Failed to save App Fee changes:', error);
                  }
                }}
                style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>
             Save & Close
           </Button>
         </DialogFooter>
       </DialogContent>
      </Dialog>
        }

      {/* App Fee Manager Overlay Dialog */}
      {appFeeOverlayDriverId && driverEdits[appFeeOverlayDriverId] &&
        <Dialog open={true} onOpenChange={(open) => !open && setAppFeeOverlayDriverId(null)}>
       <DialogContent style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
         <DialogHeader>
           <DialogTitle style={{ color: 'var(--text-slate-900)' }}>Manage App Fee</DialogTitle>
         </DialogHeader>

         <div className="space-y-3">
           <p className="text-xs text-slate-600">For {payrollData.find((d) => d.driver.id === appFeeOverlayDriverId)?.driver.user_name}:</p>

           {/* Two fields side by side */}
           <div className="grid grid-cols-2 gap-3">
             {/* App Fee % */}
             <div>
               <label className="text-xs font-semibold block mb-2" style={{ color: 'var(--text-slate-600)' }}>App Fee %</label>
               <div className="flex gap-1">
                 <input
                      type="number"
                      value={driverEdits[appFeeOverlayDriverId]?.appFeePercent || 0}
                      onChange={(e) => {
                        const newPercent = parseFloat(e.target.value) || 0;
                        const calculatedAmount = calculateAppFeeAmount(appFeeOverlayDriverId, newPercent);
                        setDriverEdits((prev) => ({
                          ...prev,
                          [appFeeOverlayDriverId]: {
                            ...prev[appFeeOverlayDriverId],
                            appFeePercent: newPercent,
                            appFeeAmount: calculatedAmount
                          }
                        }));
                      }}
                      placeholder="0"
                      className="flex-1 px-2 py-1 text-sm border rounded"
                      step="0.01"
                      min="0"
                      max="100" />
                 <span className="flex items-center text-slate-500">%</span>
               </div>
             </div>

             {/* App Fee Amount */}
             <div>
               <label className="text-xs font-semibold block mb-2" style={{ color: 'var(--text-slate-600)' }}>App Fee Amount</label>
               <div className="flex gap-1">
                 <span className="flex items-center text-slate-500">$</span>
                 <input
                      type="number"
                      value={driverEdits[appFeeOverlayDriverId]?.appFeeAmount || 0}
                      onChange={(e) => {
                        const newAmount = parseFloat(e.target.value) || 0;
                        // Recalculate percentage: (amount / total_monthly_app_fees) * 100
                        // Need to get total monthly app fees for this calculation
                        let totalBillableCount = 0;
                        const calendarMonth = new Date(currentPeriod.start.getFullYear(), currentPeriod.start.getMonth(), 1);
                        const calendarMonthEnd = new Date(currentPeriod.start.getFullYear(), currentPeriod.start.getMonth() + 1, 0);

                        deliveries.forEach((d) => {
                          if (!d || !d.store_id) return;
                          const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
                          if (deliveryDate < calendarMonth || deliveryDate > calendarMonthEnd) return;

                          const validStatus = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' && d.after_hours_pickup;
                          if (!validStatus) return;
                          if (!d.patient_id && !d.after_hours_pickup) return;

                          const store = stores.find((s) => s?.id === d.store_id);
                          if (!store) return;

                          let paysAppFees = store.pays_app_fees || false;
                          if (store.app_fee_history && store.app_fee_history.length > 0) {
                            const sortedHistory = [...store.app_fee_history].sort((a, b) =>
                            new Date(b.effective_date).getTime() - new Date(a.effective_date).getTime()
                            );
                            if (sortedHistory[0]) {
                              paysAppFees = sortedHistory[0].pays_app_fees;
                            }
                          }

                          if (paysAppFees) {
                            totalBillableCount++;
                          }
                        });

                        const totalMonthlyAppFees = totalBillableCount * appFeesPerDelivery;
                        const newPercent = totalMonthlyAppFees > 0 ? newAmount / totalMonthlyAppFees * 100 : 0;

                        setDriverEdits((prev) => ({
                          ...prev,
                          [appFeeOverlayDriverId]: {
                            ...prev[appFeeOverlayDriverId],
                            appFeeAmount: newAmount,
                            appFeePercent: newPercent
                          }
                        }));
                      }}
                      placeholder="0.00"
                      className="flex-1 px-2 py-1 text-sm border rounded"
                      step="0.01"
                      min="0" />
               </div>
             </div>
           </div>
         </div>

         <DialogFooter>
           <Button
                variant="outline"
                data-dialog-close="appfee"
                onClick={() => {
                  // Save only the app fee percentage
                  savePayrollChanges(appFeeOverlayDriverId, {
                    app_fee_percentage: driverEdits[appFeeOverlayDriverId]?.appFeePercent || 0,
                    app_fee_amount: driverEdits[appFeeOverlayDriverId]?.appFeeAmount || 0
                  });
                  setAppFeeOverlayDriverId(null);
                }}
                style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)' }}>
             Close
           </Button>
         </DialogFooter>
       </DialogContent>
      </Dialog>
        }

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
                className="bg-emerald-600 hover:bg-emerald-700">

              {isFinalizing ? 'Finalizing...' : 'Finalize All Payrolls'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Screenshot Share Modal */}
      <ScreenshotShareModal
          isOpen={showScreenshotModal}
          onClose={() => setShowScreenshotModal(false)}
          imageDataUrl={screenshotDataUrl}
          filename={`payroll-summary-${currentPeriod?.label || 'report'}.png`} />


      <CardContent ref={contentRef} className="px-3 py-6">
        <div className="space-y-4">
          {payrollData.filter((data) => data.totalDeliveries > 0).map((data, idx) => {
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

              const shouldShowMobile = (() => {
                if (typeof window === 'undefined') return false;
                const ua = navigator.userAgent;
                if (/Android.*Mobile|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true;
                if (/iPad|Android(?!.*Mobile)/i.test(ua)) return window.innerWidth < window.innerHeight;
                return window.innerWidth < 768;
              })();

              if (shouldShowMobile) {
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
                    deliveries={deliveries}
                    patients={patients}
                    currentPeriod={currentPeriod}
                    bonusAmount={driverEdits[data.driver.id]?.bonusPay || 0}
                    appFeeAmount={calculateAppFeeAmount(data.driver.id, driverEdits[data.driver.id]?.appFeePercent || 0)}
                    appFeePercent={driverEdits[data.driver.id]?.appFeePercent || 0}
                    ytdDataByDriver={ytdDataByDriver}
                    isPeriodEndOfMonth={isPeriodEndOfMonth} />);


              }

              const driverKey = data.driver.id;
              const edit = driverEdits[driverKey] || {};

              const updateEdit = (updates) => {
                setDriverEdits((prev) => ({
                  ...prev,
                  [driverKey]: { ...edit, ...updates }
                }));
              };

              return (
                <div key={data.driver.id} className="hidden md:block p-3 rounded-lg" style={{ background: idx % 2 === 0 ? 'var(--bg-slate-50)' : 'transparent' }}>
              {/* Driver Name - Top Left with optional Confirm button for admin-drivers */}
              <div className="flex items-center justify-between mb-1">
                <h3 className="font-semibold flex items-center gap-2" style={{ color: 'var(--text-slate-900)' }}>
                  {data.driver.user_name || data.driver.full_name}
                  {showBadge &&
                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500" title={isAdmin ? 'Driver confirmed' : 'Admin finalized'}>
                      <CheckCircle className="w-3.5 h-3.5 text-white" />
                    </span>
                      }
                </h3>
                {canShowConfirmButton &&
                    <Button
                      size="sm"
                      onClick={() => handleDriverFinalize(data)}
                      disabled={isFinalizing || isLoadingRecords || driverHasConfirmed}
                      className="gap-1 bg-emerald-600 hover:bg-emerald-700 text-xs h-7 px-2"
                      title={driverHasConfirmed ? 'Already confirmed' : ''}>

                     <CheckCircle className="w-3 h-3" />
                     {isFinalizing ? '...' : 'Confirm My Payroll'}
                   </Button>
                    }
              </div>

              {/* Stats and Pay Summary - Side by Side */}
              <div>
                <div className="flex justify-between items-start">
                  <LeftStatsAndNotes
                    data={data}
                    formatCurrency={formatCurrency}
                    isAdmin={isAdmin}
                    isDriver={isDriver}
                    currentUser={currentUser}
                    driverKey={driverKey}
                    setDeductionOverlayDriverId={setDeductionOverlayDriverId}
                    setBonusOverlayDriverId={setBonusOverlayDriverId}
                    getDriverPayrollRecord={getDriverPayrollRecord}
                    savePayrollChanges={savePayrollChanges}
                  />

                {/* Right: Pay Summary with YTD */}
                <div className="text-xs ml-4 flex gap-4" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {/* Period Column */}
                  <div className="flex flex-col">
                    <div className="font-bold text-center mb-1 pb-1 border-b" style={{ borderColor: 'var(--border-slate-300)' }}>Period</div>
                  <table className="border-collapse">
                    <tbody>
                      <tr style={{ color: 'var(--text-slate-600)' }}>
                        <td className="text-left pr-2">Gross:</td>
                        <td className="text-right pr-0.5">$</td>
                        <td className="text-right font-semibold" style={{ width: '60px' }}>{(data.grandTotal || 0).toFixed(2)}</td>
                      </tr>
                      <tr style={{ color: 'var(--text-slate-600)' }}>
                        <td className="text-left pr-2">Tax:</td>
                        <td className="text-right pr-0.5">$</td>
                        <td className="text-right font-semibold" style={{ width: '60px' }}>{(data.taxAmount || 0).toFixed(2)}</td>
                      </tr>
                      <tr style={{ color: 'var(--text-slate-600)' }}>
                        <td className="text-left pr-2">
                          {isAdmin ?
                                  <button onClick={() => setDeductionOverlayDriverId(data.driver.id)} className="text-blue-600 hover:text-blue-700 cursor-pointer font-medium">
                              Deductions:
                            </button> :

                                  'Deductions:'
                                  }
                        </td>
                        <td className="text-right pr-0.5">-$</td>
                        <td className="text-right font-semibold" style={{ width: '60px' }}>{(edit.deductions?.reduce((sum, d) => sum + (d?.amount || 0), 0) || 0).toFixed(2)}</td>
                      </tr>
                      <tr style={{ color: 'var(--text-slate-600)' }}>
                        <td className="text-left pr-2">
                          {isAdmin ?
                                  <button onClick={() => setBonusOverlayDriverId(data.driver.id)} className="text-blue-600 hover:text-blue-700 cursor-pointer font-medium">
                              Bonus:
                            </button> :

                                  'Bonus:'
                                  }
                        </td>
                        <td className="text-right pr-0.5">+$</td>
                        <td className="text-right font-semibold" style={{ width: '60px' }}>{(edit.bonusPay || 0).toFixed(2)}</td>
                      </tr>
                      {isAdmin && isPeriodEndOfMonth && (isAppOwner(currentUser) || (edit.appFeePercent || 0) > 0) &&
                              <tr style={{ color: 'var(--text-slate-600)' }} data-app-fee-row="true">
                        <td className="text-left pr-2">
                          <button onClick={() => setAppFeeOverlayDriverId(driverKey)} className="text-blue-600 hover:text-blue-700 cursor-pointer font-medium">
                            App Fee %:
                          </button>
                        </td>
                        <td className="text-right pr-0.5">+$</td>
                        <td className="text-right font-semibold" style={{ width: '60px' }}>{(edit.appFeeAmount || calculateAppFeeAmount(driverKey, edit.appFeePercent || 0)).toFixed(2)}</td>
                        </tr>
                              }
                      <tr style={{ borderTop: '1px solid var(--border-slate-300)' }}>
                        <td colSpan="3" className="pt-1"></td>
                      </tr>
                      <tr className="text-lg font-bold text-emerald-600">
                        <td className="text-left pr-2">Net:</td>
                        <td className="text-right pr-0.5">$</td>
                        <td className="text-right" style={{ width: '60px' }}>{(Math.round(data.grandTotal * 100) / 100 + Math.round(data.taxAmount * 100) / 100 + (edit.bonusPay || 0) - (edit.deductions?.reduce((sum, d) => sum + (d?.amount || 0), 0) || 0) + (edit.appFeeAmount || calculateAppFeeAmount(driverKey, edit.appFeePercent || 0))).toFixed(2)}</td>
                      </tr>
                    </tbody>
                    </table>
                    </div>

                    {/* Vertical Divider */}
                    <div style={{ width: '1px', background: 'var(--border-slate-300)' }}></div>

                    {/* YTD Column */}
                    <div className="flex flex-col">
                      <div className="font-bold text-center mb-1 pb-1 border-b" style={{ borderColor: 'var(--border-slate-300)' }}>YTD</div>
                      <table className="border-collapse">
                        <tbody>
                          <tr style={{ color: 'var(--text-slate-600)' }}>
                            <td className="text-right pr-0.5">$</td>
                            <td className="text-right font-semibold" style={{ width: '60px' }}>{(ytdDataByDriver[data.driver.id]?.ytdNetPay ?? 0).toFixed(2)}</td>
                          </tr>
                          <tr style={{ color: 'var(--text-slate-600)' }}>
                            <td className="text-right pr-0.5">$</td>
                            <td className="text-right font-semibold" style={{ width: '60px' }}>{(ytdDataByDriver[data.driver.id]?.ytdTaxAmount ?? 0).toFixed(2)}</td>
                          </tr>
                          <tr style={{ color: 'var(--text-slate-600)' }}>
                            <td className="text-right pr-0.5">-$</td>
                            <td className="text-right font-semibold" style={{ width: '60px' }}>{(ytdDataByDriver[data.driver.id]?.ytdDeductionsAmount ?? 0).toFixed(2)}</td>
                          </tr>
                          <tr style={{ color: 'var(--text-slate-600)' }}>
                            <td className="text-right pr-0.5">+$</td>
                            <td className="text-right font-semibold" style={{ width: '60px' }}>{(ytdDataByDriver[data.driver.id]?.ytdBonusAmount ?? 0).toFixed(2)}</td>
                          </tr>
                          {isAdmin && isPeriodEndOfMonth && (isAppOwner(currentUser) || driverEdits[data.driver.id]?.appFeePercent > 0) &&
                              <tr style={{ color: 'var(--text-slate-600)' }} data-app-fee-ytd-row="true">
                            <td className="text-right pr-0.5">+$</td>
                            <td className="text-right font-semibold" style={{ width: '60px' }}>{(ytdDataByDriver[data.driver.id]?.ytdAppFeeAmount ?? 0).toFixed(2)}</td>
                          </tr>
                              }
                          <tr style={{ borderTop: '1px solid var(--border-slate-300)' }}>
                            <td colSpan="2" className="pt-1"></td>
                          </tr>
                          <tr className="text-lg font-bold text-emerald-600">
                            <td className="text-right pr-0.5">$</td>
                            <td className="text-right" style={{ width: '60px' }}>{(ytdDataByDriver[data.driver.id]?.ytdGrossPay ?? 0).toFixed(2)}</td>
                          </tr>

                        </tbody>
                        </table>
                        </div>
                            </div>
                             </div>
                             </div>
                             </div>);

            })}
          
          {/* Total App Fees Collected - App Owner Only */}
          {payrollData.length > 1 && isAdmin && isPeriodEndOfMonth && isAppOwner(currentUser) && isAppOwner(currentUser) &&
            <div className="pt-2 px-3 py-2 rounded-lg" style={{ background: 'var(--bg-slate-50)', borderLeft: '3px solid #8b5cf6' }}>
            {/* Desktop View */}
            <div className="hidden md:block">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold" style={{ color: 'var(--text-slate-700)' }}>
                  Total App Fees Collected
                </div>
                <div className="flex gap-6 items-start">
                  {/* Period Column */}
                  <div className="flex flex-col">
                    <div className="text-xs text-center font-bold mb-1 pb-1 border-b" style={{ color: 'var(--text-slate-500)', borderColor: 'var(--border-slate-300)' }}>Month</div>
                    <table className="border-collapse">
                      <tbody>
                        <tr style={{ color: 'var(--text-slate-600)' }}>
                          <td className="text-left pr-2">
                            <button
                                onClick={() => setAppFeeOverlayAllDriversId('all')}
                                className="text-blue-600 hover:text-blue-700 cursor-pointer font-medium">
                              Total Fees:
                            </button>
                          </td>
                          <td className="text-right pr-0.5">$</td>
                          <td className="text-right font-semibold" style={{ width: '60px' }}>
                            {(() => {
                                // Calculate total billable deliveries in calendar month
                                const calendarMonth = new Date(currentPeriod.start.getFullYear(), currentPeriod.start.getMonth(), 1);
                                const calendarMonthEnd = new Date(currentPeriod.start.getFullYear(), currentPeriod.start.getMonth() + 1, 0);
                                let totalBillableCount = 0;
                                deliveries.forEach((d) => {
                                  if (!d || !d.store_id) return;
                                  const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
                                  if (deliveryDate < calendarMonth || deliveryDate > calendarMonthEnd) return;
                                  const validStatus = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' && d.after_hours_pickup;
                                  if (!validStatus) return;
                                  if (!d.patient_id && !d.after_hours_pickup) return;
                                  const store = stores.find((s) => s?.id === d.store_id);
                                  if (!store) return;
                                  let paysAppFees = store.pays_app_fees || false;
                                  if (store.app_fee_history && store.app_fee_history.length > 0) {
                                    const sortedHistory = [...store.app_fee_history].sort((a, b) =>
                                    new Date(b.effective_date).getTime() - new Date(a.effective_date).getTime()
                                    );
                                    if (sortedHistory[0]) {
                                      paysAppFees = sortedHistory[0].pays_app_fees;
                                    }
                                  }
                                  if (paysAppFees) {
                                    totalBillableCount++;
                                  }
                                });
                                return (totalBillableCount * appFeesPerDelivery).toFixed(2);
                              })()}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  {/* Vertical Divider */}
                  <div style={{ width: '1px', background: 'var(--border-slate-300)' }}></div>

                  {/* YTD Column */}
                  <div className="flex flex-col">
                    <div className="text-xs text-center font-bold mb-1 pb-1 border-b" style={{ color: 'var(--text-slate-500)', borderColor: 'var(--border-slate-300)' }}>YTD</div>
                    <table className="border-collapse">
                      <tbody>
                        <tr style={{ color: 'var(--text-slate-600)' }}>
                          <td className="text-right pr-0.5">$</td>
                          <td className="text-right font-semibold" style={{ width: '60px' }}>
                            {(() => {
                                // Calculate YTD total app fees (Jan 1 to current month end)
                                const yearStart = new Date(currentPeriod.start.getFullYear(), 0, 1);
                                const currentMonthEnd = new Date(currentPeriod.start.getFullYear(), currentPeriod.start.getMonth() + 1, 0);
                                let ytdTotalBillable = 0;
                                deliveries.forEach((d) => {
                                  if (!d || !d.store_id) return;
                                  const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
                                  if (deliveryDate < yearStart || deliveryDate > currentMonthEnd) return;
                                  const validStatus = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' && d.after_hours_pickup;
                                  if (!validStatus) return;
                                  if (!d.patient_id && !d.after_hours_pickup) return;
                                  const store = stores.find((s) => s?.id === d.store_id);
                                  if (!store) return;
                                  let paysAppFees = store.pays_app_fees || false;
                                  if (store.app_fee_history && store.app_fee_history.length > 0) {
                                    const sortedHistory = [...store.app_fee_history].sort((a, b) =>
                                    new Date(b.effective_date).getTime() - new Date(a.effective_date).getTime()
                                    );
                                    const applicableEntry = sortedHistory.find((entry) =>
                                    new Date(entry.effective_date) <= deliveryDate
                                    );
                                    if (applicableEntry) {
                                      paysAppFees = applicableEntry.pays_app_fees;
                                    }
                                  }
                                  if (paysAppFees) {
                                    ytdTotalBillable++;
                                  }
                                });
                                return (ytdTotalBillable * appFeesPerDelivery).toFixed(2);
                              })()}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>

            {/* Mobile View */}
            <div className="md:hidden">
              <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-slate-700)' }}>
                Total App Fees Collected
              </div>
              
              <div className="p-3 rounded-lg border" style={{
                  background: 'var(--bg-white)',
                  borderColor: 'var(--border-slate-200)',
                  fontVariantNumeric: 'tabular-nums'
                }}>
                <div className="text-xs font-mono">
                  {/* Header Row */}
                  <div className="grid gap-1 mb-2 font-semibold pb-1 border-b" style={{
                      gridTemplateColumns: '1fr 22px 60px 22px 60px',
                      borderColor: 'var(--border-slate-200)',
                      color: 'var(--text-slate-700)'
                    }}>
                    <div></div>
                    <div></div>
                    <div className="text-right">Month</div>
                    <div></div>
                    <div className="text-right">YTD</div>
                  </div>

                  {/* Total Fees */}
                  <div className="grid gap-1" style={{ gridTemplateColumns: '1fr 22px 60px 22px 60px', color: 'var(--text-purple-700)' }}>
                    <div className="text-left">Total Fees:</div>
                    <div className="text-right pr-0.5">$</div>
                    <div className="text-right font-semibold">
                      {(() => {
                          // Calculate total billable deliveries in calendar month
                          const calendarMonth = new Date(currentPeriod.start.getFullYear(), currentPeriod.start.getMonth(), 1);
                          const calendarMonthEnd = new Date(currentPeriod.start.getFullYear(), currentPeriod.start.getMonth() + 1, 0);
                          let totalBillableCount = 0;
                          deliveries.forEach((d) => {
                            if (!d || !d.store_id) return;
                            const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
                            if (deliveryDate < calendarMonth || deliveryDate > calendarMonthEnd) return;
                            const validStatus = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' && d.after_hours_pickup;
                            if (!validStatus) return;
                            if (!d.patient_id && !d.after_hours_pickup) return;
                            const store = stores.find((s) => s?.id === d.store_id);
                            if (!store) return;
                            let paysAppFees = store.pays_app_fees || false;
                            if (store.app_fee_history && store.app_fee_history.length > 0) {
                              const sortedHistory = [...store.app_fee_history].sort((a, b) =>
                              new Date(b.effective_date).getTime() - new Date(a.effective_date).getTime()
                              );
                              if (sortedHistory[0]) {
                                paysAppFees = sortedHistory[0].pays_app_fees;
                              }
                            }
                            if (paysAppFees) {
                              totalBillableCount++;
                            }
                          });
                          return (totalBillableCount * appFeesPerDelivery).toFixed(2);
                        })()}
                    </div>
                    <div className="text-right pr-0.5">$</div>
                    <div className="text-right font-semibold">
                      {(() => {
                          // Calculate YTD total app fees (Jan 1 to current month end)
                          const yearStart = new Date(currentPeriod.start.getFullYear(), 0, 1);
                          const currentMonthEnd = new Date(currentPeriod.start.getFullYear(), currentPeriod.start.getMonth() + 1, 0);
                          let ytdTotalBillable = 0;
                          deliveries.forEach((d) => {
                            if (!d || !d.store_id) return;
                            const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
                            if (deliveryDate < yearStart || deliveryDate > currentMonthEnd) return;
                            const validStatus = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' && d.after_hours_pickup;
                            if (!validStatus) return;
                            if (!d.patient_id && !d.after_hours_pickup) return;
                            const store = stores.find((s) => s?.id === d.store_id);
                            if (!store) return;
                            let paysAppFees = store.pays_app_fees || false;
                            if (store.app_fee_history && store.app_fee_history.length > 0) {
                              const sortedHistory = [...store.app_fee_history].sort((a, b) =>
                              new Date(b.effective_date).getTime() - new Date(a.effective_date).getTime()
                              );
                              const applicableEntry = sortedHistory.find((entry) =>
                              new Date(entry.effective_date) <= deliveryDate
                              );
                              if (applicableEntry) {
                                paysAppFees = applicableEntry.pays_app_fees;
                              }
                            }
                            if (paysAppFees) {
                              ytdTotalBillable++;
                            }
                          });
                          return (ytdTotalBillable * appFeesPerDelivery).toFixed(2);
                        })()}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
            }

          {/* Grand Total for All Drivers */}
          {payrollData.length > 1 &&
            <div className="pt-4" style={{ borderTop: '2px solid var(--border-slate-300)' }}>
              <div style={{
                display: (() => {
                  if (typeof window === 'undefined') return 'block';
                  const ua = navigator.userAgent;
                  if (/Android.*Mobile|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return 'none';
                  if (/iPad|Android(?!.*Mobile)/i.test(ua)) return window.innerWidth < window.innerHeight ? 'none' : 'block';
                  return window.innerWidth >= 768 ? 'block' : 'none';
                })()
              }}>
                <div className="flex items-center justify-between mb-2">
                  <div className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Total Payroll (All Drivers)</div>
                </div>

                {/* Two Column Layout */}
                <div className="flex gap-3 items-start justify-between">
                  {/* Left Column: Period Stats Summary */}
                  <div className="text-xs grid gap-1" style={{ gridTemplateColumns: '150px 140px 140px', rowGap: '0.125rem' }}>
                    {/* Row 1 */}
                    <div className="flex items-center">
                      <span className="w-16 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>Del:</span>
                      <span className="px-2 py-0.5 rounded text-[11px] whitespace-nowrap" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>
                        {driversWithDeliveries.reduce((sum, d) => sum + d.totalDeliveries, 0)} = ${driversWithDeliveries.reduce((sum, d) => sum + d.totalBasePay, 0).toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center">
                      <span className="w-16 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>KM:</span>
                      <span className="px-2 py-0.5 rounded text-[11px] whitespace-nowrap" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>
                        {driversWithDeliveries.reduce((sum, d) => sum + d.totalExtraKm, 0).toFixed(2)} = ${driversWithDeliveries.reduce((sum, d) => sum + d.totalExtraKmPay, 0).toFixed(2)}
                      </span>
                    </div>
                    <div className="flex items-center">
                      <span className="w-16 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>OS:</span>
                      <span className="px-2 py-0.5 rounded text-[11px] whitespace-nowrap" style={{ background: 'var(--bg-slate-200)', color: 'var(--text-slate-700)' }}>
                        {driversWithDeliveries.reduce((sum, d) => sum + d.oversizedCount, 0)} = ${driversWithDeliveries.reduce((sum, d) => sum + d.totalOversizedPay, 0).toFixed(2)}
                      </span>
                    </div>
                    
                    {/* Row 2 */}
                    <div className="flex items-center">
                      <span className="w-16 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>Failed:</span>
                      <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded text-[11px]">
                        {driversWithDeliveries.reduce((sum, d) => sum + d.failedCount, 0)}
                      </span>
                    </div>
                    <div className="flex items-center">
                      <span className="w-16 text-right pr-1" style={{ color: 'var(--text-slate-500)' }}>Returns:</span>
                      <span className="bg-orange-100 text-orange-700 px-2 py-0.5 rounded text-[11px]">
                        {driversWithDeliveries.reduce((sum, d) => sum + d.storeReturnCount, 0)}
                      </span>
                    </div>
                  </div>

                  {/* Right Column: Pay Totals with YTD */}
                  <div className="flex items-start ml-auto gap-3">
                  {/* Period Column */}
                  <div className="flex flex-col">
                    {grandTotalTax > 0 || grandTotalDeductions > 0 ?
                      <>
                        <div className="text-xs text-center font-bold mb-1 pb-1 border-b" style={{ color: 'var(--text-slate-500)', borderColor: 'var(--border-slate-300)' }}>Period</div>
                        <table className="border-collapse">
                          <tbody>
                            <tr style={{ color: 'var(--text-slate-600)' }}>
                              <td className="text-left pr-2">Gross:</td>
                              <td className="text-right pr-0.5">$</td>
                              <td className="text-right font-semibold" style={{ width: '60px' }}>{grandTotalAllDrivers.toFixed(2)}</td>
                            </tr>
                            {grandTotalTax > 0 &&
                            <tr style={{ color: 'var(--text-slate-600)' }}>
                              <td className="text-left pr-2">Tax:</td>
                              <td className="text-right pr-0.5">$</td>
                              <td className="text-right font-semibold" style={{ width: '60px' }}>{grandTotalTax.toFixed(2)}</td>
                            </tr>
                            }
                            {grandTotalDeductions > 0 &&
                            <tr style={{ color: '#ef4444' }}>
                              <td className="text-left pr-2">Deductions:</td>
                              <td className="text-right pr-0.5">-$</td>
                              <td className="text-right font-semibold" style={{ width: '60px' }}>{grandTotalDeductions.toFixed(2)}</td>
                            </tr>
                            }
                            <tr style={{ color: 'var(--text-slate-600)' }}>
                              <td className="text-left pr-2">Bonus:</td>
                              <td className="text-right pr-0.5">+$</td>
                              <td className="text-right font-semibold" style={{ width: '60px' }}>{driversWithDeliveries.reduce((sum, d) => sum + (driverEdits[d.driver.id]?.bonusPay || 0), 0).toFixed(2)}</td>
                            </tr>
                            {isPeriodEndOfMonth &&
                            <tr style={{ color: 'var(--text-slate-600)' }}>
                              <td className="text-left pr-2">
                                <button
                                  onClick={() => setAppFeeOverlayAllDriversId('all')}
                                  className="text-blue-600 hover:text-blue-700 cursor-pointer font-medium">
                                  Extra App Fee Cut:
                                </button>
                              </td>
                              <td className="text-right pr-0.5">-$</td>
                              <td className="text-right font-semibold" style={{ width: '60px' }}>{(calculateAppFeeAmount('extra-app-fee', extraAppFeePercent) + calculateAppFeeAmount('other-app-fee', otherAppFeePercent)).toFixed(2)}</td>
                            </tr>
                            }
                            <tr style={{ borderTop: '1px solid var(--border-slate-300)' }}>
                              <td colSpan="3" className="pt-1"></td>
                            </tr>
                            <tr className="text-lg font-bold text-emerald-600">
                              <td className="text-left pr-2">Net:</td>
                              <td className="text-right pr-0.5">$</td>
                              <td className="text-right" style={{ width: '60px' }}>{(grandTotalGross + driversWithDeliveries.reduce((sum, d) => sum + (driverEdits[d.driver.id]?.bonusPay || 0), 0)).toFixed(2)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </> :

                      <div className="text-lg font-bold text-emerald-700">
                        {formatCurrency(grandTotalGross)}
                      </div>
                      }
                  </div>

                  {/* Vertical Divider */}
                  <div style={{ width: '1px', background: 'var(--border-slate-300)' }}></div>

                  {/* YTD Column */}
                  <div className="flex flex-col">
                    {ytdGrandTotalTax > 0 || ytdGrandTotalDeductions > 0 ?
                      <>
                        <div className="text-xs text-center font-bold mb-1 pb-1 border-b" style={{ color: 'var(--text-slate-500)', borderColor: 'var(--border-slate-300)' }}>YTD</div>
                        <table className="border-collapse">
                          <tbody>
                            <tr style={{ color: 'var(--text-slate-600)' }}>
                              <td className="text-right pr-0.5">$</td>
                              <td className="text-right font-semibold" style={{ width: '60px' }}>{ytdGrandTotalNet.toFixed(2)}</td>
                            </tr>
                            {ytdGrandTotalTax > 0 &&
                            <tr style={{ color: 'var(--text-slate-600)' }}>
                              <td className="text-right pr-0.5">$</td>
                              <td className="text-right font-semibold" style={{ width: '60px' }}>{ytdGrandTotalTax.toFixed(2)}</td>
                            </tr>
                            }
                            {ytdGrandTotalDeductions > 0 &&
                            <tr style={{ color: '#ef4444' }}>
                              <td className="text-right pr-0.5">-$</td>
                              <td className="text-right font-semibold" style={{ width: '60px' }}>{ytdGrandTotalDeductions.toFixed(2)}</td>
                            </tr>
                            }
                            <tr style={{ color: 'var(--text-slate-600)' }}>
                              <td className="text-right pr-0.5">+$</td>
                              <td className="text-right font-semibold" style={{ width: '60px' }}>{ytdGrandTotalBonus.toFixed(2)}</td>
                            </tr>
                            {isPeriodEndOfMonth &&
                            <tr style={{ color: 'var(--text-slate-600)' }}>
                              <td className="text-right pr-0.5">-$</td>
                              <td className="text-right font-semibold" style={{ width: '60px' }}>{(calculateAppFeeAmount('extra-app-fee', extraAppFeePercent) + calculateAppFeeAmount('other-app-fee', otherAppFeePercent)).toFixed(2)}</td>
                            </tr>
                            }
                            <tr style={{ borderTop: '1px solid var(--border-slate-300)' }}>
                              <td colSpan="2" className="pt-1"></td>
                            </tr>
                            <tr className="text-lg font-bold text-emerald-600">
                              <td className="text-right pr-0.5">$</td>
                              <td className="text-right" style={{ width: '60px' }}>{ytdGrandTotalGross.toFixed(2)}</td>
                            </tr>
                          </tbody>
                        </table>
                      </> :

                      <div className="text-lg font-bold text-emerald-700">
                        <div className="text-xs text-center font-bold mb-1" style={{ color: 'var(--text-slate-500)' }}>YTD</div>
                        {formatCurrency(ytdGrandTotalGross)}
                      </div>
                      }
                  </div>
                  </div>
                  </div>
              </div>

              <div style={{
                display: (() => {
                  if (typeof window === 'undefined') return 'none';
                  const ua = navigator.userAgent;
                  if (/Android.*Mobile|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return 'block';
                  if (/iPad|Android(?!.*Mobile)/i.test(ua)) return window.innerWidth < window.innerHeight ? 'block' : 'none';
                  return window.innerWidth < 768 ? 'block' : 'none';
                })()
              }} className="px-4">
                <div className="font-semibold mb-3 text-sm" style={{ color: 'var(--text-slate-700)' }}>Total Payroll (All Drivers)</div>
                
                {/* Pay Summary Table */}
                <div className="p-3 rounded-lg border" style={{
                  background: 'var(--bg-white)',
                  borderColor: 'var(--border-slate-200)',
                  fontVariantNumeric: 'tabular-nums'
                }}>
                  <div className="text-xs font-mono">
                    {/* Header Row */}
                    <div className="grid gap-1 mb-2 font-semibold pb-1 border-b" style={{
                      gridTemplateColumns: '1fr 22px 60px 22px 60px',
                      borderColor: 'var(--border-slate-200)',
                      color: 'var(--text-slate-700)'
                    }}>
                      <div></div>
                      <div></div>
                      <div className="text-right">Period</div>
                      <div></div>
                      <div className="text-right">YTD</div>
                    </div>

                    {/* Net */}
                    <div className="grid gap-1" style={{ gridTemplateColumns: '1fr 22px 60px 22px 60px', color: 'var(--text-slate-600)' }}>
                      <div className="text-left">Gross:</div>
                      <div className="text-right pr-0.5">$</div>
                      <div className="text-right font-semibold">{grandTotalAllDrivers.toFixed(2)}</div>
                      <div className="text-right pr-0.5">$</div>
                      <div className="text-right font-semibold">{ytdGrandTotalNet.toFixed(2)}</div>
                    </div>

                    {/* Tax */}
                    {grandTotalTax > 0 &&
                    <div className="grid gap-1" style={{ gridTemplateColumns: '1fr 22px 60px 22px 60px', color: 'var(--text-slate-600)' }}>
                      <div className="text-left">Tax:</div>
                      <div className="text-right pr-0.5">$</div>
                      <div className="text-right font-semibold">{grandTotalTax.toFixed(2)}</div>
                      <div className="text-right pr-0.5">$</div>
                      <div className="text-right font-semibold">{ytdGrandTotalTax.toFixed(2)}</div>
                    </div>
                    }

                    {/* Deductions */}
                    {grandTotalDeductions > 0 &&
                    <div className="grid gap-1 text-red-700" style={{ gridTemplateColumns: '1fr 22px 60px 22px 60px' }}>
                      <div className="text-left">Deductions:</div>
                      <div className="text-right pr-0.5">-$</div>
                      <div className="text-right font-semibold">{grandTotalDeductions.toFixed(2)}</div>
                      <div className="text-right pr-0.5">-$</div>
                      <div className="text-right font-semibold">{ytdGrandTotalDeductions.toFixed(2)}</div>
                    </div>
                    }

                    {/* Bonus */}
                    <div className="grid gap-1" style={{ gridTemplateColumns: '1fr 22px 60px 22px 60px', color: 'var(--text-blue-700)' }}>
                      <div className="text-left">Bonus:</div>
                      <div className="text-right pr-0.5">+$</div>
                      <div className="text-right font-semibold">{driversWithDeliveries.reduce((sum, d) => sum + (driverEdits[d.driver.id]?.bonusPay || 0), 0).toFixed(2)}</div>
                      <div className="text-right pr-0.5">+$</div>
                      <div className="text-right font-semibold">{ytdGrandTotalBonus.toFixed(2)}</div>
                    </div>

                    {/* App Fee Cut (if end of month) */}
                    {isPeriodEndOfMonth &&
                    <div className="grid gap-1" style={{ gridTemplateColumns: '1fr 22px 60px 22px 60px', color: 'var(--text-purple-700)' }}>
                      <div className="text-left">App Fee Cut:</div>
                      <div className="text-right pr-0.5">-$</div>
                      <div className="text-right font-semibold">{(calculateAppFeeAmount('extra-app-fee', extraAppFeePercent) + calculateAppFeeAmount('other-app-fee', otherAppFeePercent)).toFixed(2)}</div>
                      <div className="text-right pr-0.5">-$</div>
                      <div className="text-right font-semibold">{(calculateAppFeeAmount('extra-app-fee', extraAppFeePercent) + calculateAppFeeAmount('other-app-fee', otherAppFeePercent)).toFixed(2)}</div>
                    </div>
                    }

                    {/* Gross (bold, divider) */}
                    <div className="grid gap-1 pt-1 border-t font-bold" style={{
                      gridTemplateColumns: '1fr 22px 60px 22px 60px',
                      borderColor: 'var(--border-slate-200)',
                      color: '#10b981'
                    }}>
                      <div className="text-left">Net:</div>
                      <div className="text-right pr-0.5">$</div>
                      <div className="text-right">{(grandTotalGross + driversWithDeliveries.reduce((sum, d) => sum + (driverEdits[d.driver.id]?.bonusPay || 0), 0)).toFixed(2)}</div>
                      <div className="text-right pr-0.5">$</div>
                      <div className="text-right">{ytdGrandTotalGross.toFixed(2)}</div>
                    </div>
                  </div>
                </div>
              </div>
              </div>
            }
                  </div>
                  </CardContent>
                  </Card>
        </>);

}