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
import PayrollMobileCard from './PayrollMobileCard';
import LeftStatsAndNotes from './LeftStatsAndNotes';
import { AppFeeAllDriversDialog } from './AppFeeDialogs';
import { syncPayrollRecordsWithLiveData } from '../utils/payrollEntitySync';
import { getReturnCountFromPatientId } from '../utils/returnDeliveryUtils';
import { exportPayrollPdf } from './payrollPdfExport';
import { getDefaultPaidAmount, getPeriodNetAmount, sumDeductionAmounts } from './payrollSummaryCalculations';

const PROVINCE_TAX_RATES = { 'AB': 0.05, 'BC': 0.05, 'SK': 0.05, 'MB': 0.05, 'ON': 0.13, 'QC': 0.05, 'NB': 0.15, 'NS': 0.15, 'PE': 0.15, 'NL': 0.15, 'YT': 0.05, 'NT': 0.05, 'NU': 0.05 };

const parsePaidAmount = (value, fallback = 0) => {
  if (value === '' || value == null) return fallback;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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
  refreshPayrollRecords,
  driverStats = {}
}) {
  const { currentUser } = useUser();
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [payrollRecords, setPayrollRecords] = useState([]);
  const [driverEdits, setDriverEdits] = useState({});
  const [deductionOverlayDriverId, setDeductionOverlayDriverId] = useState(null);
  const [bonusOverlayDriverId, setBonusOverlayDriverId] = useState(null);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState(null);
  const [showScreenshotModal, setShowScreenshotModal] = useState(false);
  const [appFeesPerDelivery, setAppFeesPerDelivery] = useState(0);
  const [extraAppFeePercent, setExtraAppFeePercent] = useState(0);
  const [otherAppFeePercent, setOtherAppFeePercent] = useState(0);
  const [appFeeOverlayAllDriversId, setAppFeeOverlayAllDriversId] = useState(null);
  const [adminMetricsFeeTotals, setAdminMetricsFeeTotals] = useState(null);
  const [activeInputField, setActiveInputField] = useState(null);
  const [paidDrafts, setPaidDrafts] = useState({});
  const [bonusDraftValue, setBonusDraftValue] = useState('');
  const paidRefreshPauseRef = useRef({});
  const [deductionDraftName, setDeductionDraftName] = useState('');
  const [deductionDraftAmount, setDeductionDraftAmount] = useState('');
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

        const matchedPatient = d.patient_id ?
        patients?.find((p) => p && (p.id === d.patient_id || p.patient_id === d.patient_id)) :
        null;
        const isPatientReturn = String(matchedPatient?.address || '').toUpperCase().includes('(RTN)');

        const patientName = String(d.patient_name || '').toUpperCase();
        const isInterStore = patientName.includes('INTERSTORE') || patientName.includes('(ISD)') || patientName.includes('(ISP)');
        const isPatientOrTransfer = !!d.patient_id;
        const isAfterHours = d.after_hours_pickup === true;

        if (d.status === 'completed' || d.status === 'failed') {/* valid */} else
        if (d.status === 'cancelled') {
          if (!isAfterHours && !isPatientReturn) {
            return false;
          }
        } else {
          return false;
        }

        if (!isPatientOrTransfer && !isAfterHours) return false;
        if (isInterStore && !isAfterHours) return false;

        const date = new Date(d.delivery_date + 'T00:00:00');
        const inPeriod = date >= currentPeriod.start && date <= currentPeriod.end;

        return inPeriod;
      });

      const deliveryCount = periodDeliveries.length;
      const basePay = deliveryCount * payRate;

      let extraKmPay = 0,totalExtraKm = 0;
      periodDeliveries.forEach((d) => {
        let dist = d.paid_km_override || 0;
        if (!dist && d.patient_id && patients) {dist = patients.find((p) => p && p.id === d.patient_id)?.distance_from_store || 0;}
        if (dist > extraKmLimit && extraKmRate > 0) {const ek = dist - extraKmLimit;totalExtraKm += ek;extraKmPay += ek * extraKmRate;}
      });

      const oversizedCount = periodDeliveries.filter((d) => d.oversized).length;
      const oversizedPay = oversizedCount * oversizedRate;
      const payrollRecord = payrollRecords.find((r) => r.driver_id === driverId);
      const appFeePercentage = payrollRecord?.app_fee_percentage ?? appUser?.app_fee_percentage ?? 0;
      const afterHoursCount = periodDeliveries.filter((d) => d.after_hours_pickup).length;
      const failedCount = periodDeliveries.filter((d) => d.status === 'failed').length;
      const returnsCount = periodDeliveries.reduce(
        (sum, d) => sum + getReturnCountFromPatientId(d, patients),
        0
      );
      const storeReturnCount = returnsCount;
      const totalPay = basePay + extraKmPay + oversizedPay;
      const gstHstEnabled = appUser?.gst_hst_enabled || false;
      let taxAmount = 0,taxRate = 0,provinceCode = null;
      if (gstHstEnabled && cities) {
        const driverCity = appUser?.city_id ? cities.find((c) => c && c.id === appUser.city_id) : null;
        if (driverCity?.province_state) {
          const prov = driverCity.province_state.toUpperCase();
          const PM = { 'ALBERTA': 'AB', 'BRITISH COLUMBIA': 'BC', 'SASKATCHEWAN': 'SK', 'MANITOBA': 'MB', 'ONTARIO': 'ON', 'QUEBEC': 'QC', 'NEW BRUNSWICK': 'NB', 'NOVA SCOTIA': 'NS', 'PRINCE EDWARD ISLAND': 'PE', 'NEWFOUNDLAND': 'NL', 'NEWFOUNDLAND AND LABRADOR': 'NL', 'YUKON': 'YT', 'NORTHWEST TERRITORIES': 'NT', 'NUNAVUT': 'NU' };
          provinceCode = prov.length === 2 && PROVINCE_TAX_RATES[prov] ? prov : PM[prov] || null;
          if (provinceCode && PROVINCE_TAX_RATES[provinceCode]) {taxRate = PROVINCE_TAX_RATES[provinceCode];taxAmount = totalPay * taxRate;}
        }
      }
      const deductionsArray = Array.isArray(appUser?.deductions) ? appUser.deductions : [];
      const totalDeductions = totalPay > 0 ? deductionsArray.reduce((sum, d) => sum + (d?.amount || 0), 0) : 0;
      const grossPay = totalPay > 0 ? totalPay + taxAmount - totalDeductions : 0;
      const storedPaidAmount = payrollRecord?.paid_amount;

      const graphPayableDeliveries = periodDeliveries.filter((delivery) => {
        if (!delivery) return false;
        const validStatus = delivery.status === 'completed' || delivery.status === 'failed' || delivery.status === 'cancelled' && delivery.after_hours_pickup;
        if (!validStatus) return false;
        if (!delivery.patient_id && !delivery.after_hours_pickup) return false;
        return true;
      });
      const graphDeliveryCount = graphPayableDeliveries.length;
      const graphBasePay = graphDeliveryCount * payRate;
      const graphGrandTotal = graphBasePay + extraKmPay + oversizedPay;
      const graphTaxAmount = gstHstEnabled && taxRate > 0 ? graphGrandTotal * taxRate : 0;
      const graphGrossPay = graphGrandTotal > 0 ? graphGrandTotal + graphTaxAmount - totalDeductions : 0;
      const graphNetPay = graphGrandTotal + graphTaxAmount - totalDeductions;

      return {
        driver: { ...driver, id: driverId }, payRate, extraKmRate, extraKmLimit, oversizedRate,
        totalDeliveries: deliveryCount, totalBasePay: basePay, graphDeliveryCount, graphBasePay, totalExtraKm, totalExtraKmPay: extraKmPay,
        oversizedCount, totalOversizedPay: oversizedPay, afterHoursCount, failedCount, returnsCount,
        storeReturnCount, grandTotal: graphGrandTotal, gstHstEnabled, taxRate, taxAmount: graphTaxAmount, provinceCode,
        deductions: totalDeductions, deductionsArray, grossPay: graphGrossPay, netPay: graphNetPay, appFeePercentage, storedPaidAmount
      };
    });
  }, [deliveries, drivers, appUsers, patients, cities, selectedYear, selectedDriverId, currentPeriod]);

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
    base44.entities.Payroll.filter({ pay_period_end: { $gte: yearStart, $lte: periodEnd } }).then((records) => {setPayrollRecords(records || []);if (onPayrollRecordsChange) onPayrollRecordsChange(records || []);}).catch(() => {});
  }, [currentPeriod, periodStartStr, periodEndStr]);

  // Use payroll records provided by the parent page, which already loads the full year once.
  useEffect(() => {
    if (externalPayrollRecords) {
      setPayrollRecords(externalPayrollRecords);
      return;
    }
    setPayrollRecords([]);
  }, [externalPayrollRecords]);

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
        const driversWithDeliveries = payrollData.filter((data) => data.graphDeliveryCount > 0).map((data) => data.driver.id);
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

            const recordData = { driver_id: driverId, city_id: selectedCityId && selectedCityId !== 'all' ? selectedCityId : currentUser?.city_id || null,
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
      } catch (error) {console.error('❌ [Payroll] Auto-create failed:', error);} finally
      {autoCreateInProgressRef.current = false;}
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
      if (!d || driverId && d.driver_id !== driverId) return;
      const matchedPatient = d.patient_id ?
      patients?.find((p) => p && (p.id === d.patient_id || p.patient_id === d.patient_id)) :
      null;
      const isPatientReturn = String(matchedPatient?.address || '').toUpperCase().includes('(RTN)');
      const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
      if (deliveryDate < new Date(periodStartStr + 'T00:00:00') || deliveryDate > new Date(periodEndStr + 'T00:00:00')) return;
      const patientName = String(d.patient_name || '').toUpperCase();
      const isInterStore = patientName.includes('INTERSTORE') || patientName.includes('(ISD)') || patientName.includes('(ISP)');
      const isPatientOrTransfer = !!d.patient_id;
      const isAfterHours = d.after_hours_pickup === true;
      const validStatus = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' && (isAfterHours || isPatientReturn);
      if (!validStatus) return;
      if (!isPatientOrTransfer && !isAfterHours) return;
      if (isInterStore && !isAfterHours) return;
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
  }, [deliveries, stores, patients, periodStartStr, periodEndStr]);

  // Handle immediate save to Payroll entity and offline DB
  const savePayrollChanges = async (driverId, updates) => {
    try {
      let existingRecord = getDriverPayrollRecord(driverId);
      if (!existingRecord) {
        const driverData = payrollData.find((d) => d.driver.id === driverId);
        if (!driverData) return;
        const saveAppFeeAmount = countBillableDeliveries(driverId) * (driverData.appFeePercentage || 0) / 100;

        const newRecordData = {
          driver_id: driverId,
          city_id: selectedCityId && selectedCityId !== 'all' ? selectedCityId : currentUser?.city_id || null,
          pay_period_start: periodStartStr,
          pay_period_end: periodEndStr,
          pay_period_type: payPeriod,
          total_deliveries: driverData.totalDeliveries,
          total_extra_km: driverData.totalExtraKm,
          total_oversized_deliveries: driverData.oversizedCount,
          total_after_hours_deliveries: driverData.afterHoursCount || 0,
          gross_pay: driverData.grossPay,
          net_pay: driverData.grandTotal,
          total_deductions: driverData.deductions,
          deductions: driverData.deductionsArray,
          bonus_pay: 0,
          app_fee_percentage: 0,
          app_fee_amount: saveAppFeeAmount,
          paid_amount: driverData.grandTotal,
          tax_amount: driverData.taxAmount,
          pay_rate_per_delivery: driverData.payRate,
          extra_km_rate: driverData.extraKmRate,
          extra_km_limit: driverData.extraKmLimit,
          oversized_item_rate: driverData.oversizedRate,
          gst_hst_enabled: driverData.gstHstEnabled,
          status: 'draft'
        };

        const newRecord = await base44.entities.Payroll.create(roundPayrollData(newRecordData));

        const nextPayrollRecords = [...payrollRecords, newRecord];
        setPayrollRecords(nextPayrollRecords);
        if (onPayrollRecordsChange) {
          onPayrollRecordsChange(nextPayrollRecords);
        }
        try {
          const { broadcastMutation } = await import('../utils/realtimeSync');
          await broadcastMutation('Payroll', 'create', newRecord.id, newRecord);
        } catch (e) {/* ignore */}
        existingRecord = newRecord;
      }

      const driverData = payrollData.find((d) => d.driver.id === driverId);
      let recalculatedUpdates = { ...updates };
      if (updates.deductions !== undefined || updates.bonus_pay !== undefined) {
        const newDed = updates.total_deductions !== undefined ? updates.total_deductions : existingRecord.total_deductions || 0;
        const newBonus = updates.bonus_pay !== undefined ? updates.bonus_pay : existingRecord.bonus_pay || 0;
        recalculatedUpdates.gross_pay = (driverData?.grandTotal || existingRecord.net_pay || 0) + (driverData?.taxAmount || 0) - newDed + newBonus;
      }

      const finalUpdates = roundPayrollData(recalculatedUpdates);
      const updatedRecord = await base44.entities.Payroll.update(existingRecord.id, finalUpdates);
      const mergedRecord = { ...existingRecord, ...finalUpdates, ...updatedRecord };
      const nextPayrollRecords = payrollRecords.map((r) => r.id === existingRecord.id ? mergedRecord : r);
      setPayrollRecords(nextPayrollRecords);
      if (onPayrollRecordsChange) onPayrollRecordsChange(nextPayrollRecords);
      try {
        const { broadcastMutation } = await import('../utils/realtimeSync');
        await broadcastMutation('Payroll', 'update', mergedRecord.id, mergedRecord);
      } catch (e) {/* ignore */}

      const mergedPaidAmount = mergedRecord?.paid_amount;
      if (mergedPaidAmount != null) {
        const paidAsString = Number(mergedPaidAmount).toFixed(2);
        setDriverEdits((prev) => ({
          ...prev,
          [driverId]: {
            ...prev[driverId],
            paidAmount: paidAsString
          }
        }));
        setPaidDrafts((prev) => ({
          ...prev,
          [driverId]: paidAsString
        }));
      }

      try {
        const { offlineDB } = await import('../utils/offlineDatabase');
        await offlineDB.save(offlineDB.STORES.PAYROLL, mergedRecord);
      } catch (e) {/* ignore */}
    } catch (error) {console.error('❌ [Payroll] Failed to save changes:', error);}
  };

  // Initialize deduction input drafts when dialog opens
  useEffect(() => {
    if (!deductionOverlayDriverId) {
      setDeductionDraftName('');
      setDeductionDraftAmount('');
      return;
    }
    setDeductionDraftName('');
    setDeductionDraftAmount('');
  }, [deductionOverlayDriverId]);

  // Initialize bonus input draft when dialog opens
  useEffect(() => {
    if (!bonusOverlayDriverId) {
      setBonusDraftValue('');
      return;
    }
    const currentBonus = driverEdits[bonusOverlayDriverId]?.bonusPay;
    setBonusDraftValue(currentBonus != null ? String(currentBonus) : '0');
  }, [bonusOverlayDriverId]);

  const commitBonusDraft = async (driverId, rawValue = bonusDraftValue) => {
    if (!driverId) return;

    const parsedValue = rawValue === '' ? 0 : parseFloat(rawValue);
    const nextBonusValue = Number.isFinite(parsedValue) ? parsedValue : 0;
    const currentBonusValue = driverEdits[driverId]?.bonusPay ?? 0;

    setDriverEdits((prev) => ({
      ...prev,
      [driverId]: { ...prev[driverId], bonusPay: nextBonusValue }
    }));

    setBonusDraftValue(String(nextBonusValue));

    if (nextBonusValue !== currentBonusValue) {
      await savePayrollChanges(driverId, { bonus_pay: nextBonusValue });
    }
  };

  // Handle bonus pay save and close
  const handleBonusClose = async () => {
    const driverId = bonusOverlayDriverId;
    if (!driverId) return;
    await commitBonusDraft(driverId);
    setBonusOverlayDriverId(null);
  };

  // Handle driver finalization
  const handleDriverFinalize = async (driverData) => {
    setIsFinalizing(true);
    try {
      const existingRecord = getDriverPayrollRecord(driverData.driver.id);
      const edit = driverEdits[driverData.driver.id] || {};
      const finalizeAppFeeAmount = countBillableDeliveries(driverData.driver.id) * (edit.appFeePercent || 0) / 100;
      const finalizedNetPay = getPeriodNetAmount({
        grandTotal: driverData.grandTotal,
        taxAmount: driverData.taxAmount,
        bonusPay: edit.bonusPay || 0,
        deductions: driverData.deductionsArray || [],
        appFeeAmount: finalizeAppFeeAmount
      });
      const finalizedPaidAmount = parsePaidAmount(edit.paidAmount, finalizedNetPay);
      const payrollRecord = { driver_id: driverData.driver.id, city_id: selectedCityId && selectedCityId !== 'all' ? selectedCityId : currentUser?.city_id || null,
        pay_period_start: periodStartStr, pay_period_end: periodEndStr, pay_period_type: payPeriod,
        total_deliveries: driverData.totalDeliveries, total_extra_km: driverData.totalExtraKm,
        total_oversized_deliveries: driverData.oversizedCount, total_after_hours_deliveries: driverData.afterHoursCount || 0,
        gross_pay: driverData.grossPay, net_pay: driverData.grandTotal,
        total_deductions: driverData.deductions, deductions: driverData.deductionsArray,
        bonus_pay: edit.bonusPay || 0, app_fee_percentage: edit.appFeePercent || 0, app_fee_amount: finalizeAppFeeAmount, paid_amount: finalizedPaidAmount,
        tax_amount: driverData.taxAmount, pay_rate_per_delivery: driverData.payRate,
        extra_km_rate: driverData.extraKmRate, extra_km_limit: driverData.extraKmLimit,
        oversized_item_rate: driverData.oversizedRate, gst_hst_enabled: driverData.gstHstEnabled,
        status: 'driver_finalized', driver_finalized_at: new Date().toISOString() };

      const savedRecord = existingRecord
        ? await base44.entities.Payroll.update(existingRecord.id, roundPayrollData(payrollRecord))
        : await base44.entities.Payroll.create(roundPayrollData(payrollRecord));

      const mergedRecord = { ...existingRecord, ...roundPayrollData(payrollRecord), ...savedRecord };
      const nextPayrollRecords = existingRecord
        ? payrollRecords.map((record) => record.id === existingRecord.id ? mergedRecord : record)
        : [...payrollRecords, mergedRecord];

      setPayrollRecords(nextPayrollRecords);
      if (onPayrollRecordsChange) onPayrollRecordsChange(nextPayrollRecords);
      try {
        const { broadcastMutation } = await import('../utils/realtimeSync');
        await broadcastMutation('Payroll', existingRecord ? 'update' : 'create', mergedRecord.id, mergedRecord);
      } catch (e) {/* ignore */}

      try {
        const { offlineDB } = await import('../utils/offlineDatabase');
        await offlineDB.save(offlineDB.STORES.PAYROLL, mergedRecord);
      } catch (e) {/* ignore */}

      try {await notifyDriverConfirmedPayroll({ driver: currentUser, periodLabel: currentPeriod?.label || 'this period', appUsers, excludeUserId: isAdmin ? currentUser?.id : null });} catch (e) {/* ignore */}
      if (refreshPayrollRecords) await refreshPayrollRecords();
    } catch (error) {console.error('❌ [Payroll] Failed to finalize:', error);alert('Failed to save payroll confirmation.');} finally
    {setIsFinalizing(false);setShowConfirmDialog(false);}
  };

  // Handle admin finalization (all drivers)
  const handleAdminFinalize = async () => {
    setIsFinalizing(true);
    try {
      const dwdList = payrollData.filter((d) => d.totalDeliveries > 0);
      for (const dd of dwdList) {
        const rec = getDriverPayrollRecord(dd.driver.id);
        const edit = driverEdits[dd.driver.id] || {};
        const appFeeAmount = edit.appFeeAmount || calculateAppFeeAmount(dd.driver.id, edit.appFeePercent || 0);
        const netAmount = getPeriodNetAmount({
          grandTotal: dd.grandTotal,
          taxAmount: dd.taxAmount,
          bonusPay: edit.bonusPay || 0,
          deductions: edit.deductions || [],
          appFeeAmount
        });
        const paidAmount = parsePaidAmount(edit.paidAmount, netAmount);
        if (rec) {
          const finalizedRecord = await base44.entities.Payroll.update(rec.id, { paid_amount: paidAmount, status: 'admin_finalized', admin_finalized_at: new Date().toISOString(), admin_finalized_by: currentUser?.id });
          try {
            const { broadcastMutation } = await import('../utils/realtimeSync');
            await broadcastMutation('Payroll', 'update', finalizedRecord.id || rec.id, { ...rec, ...finalizedRecord, paid_amount: paidAmount, status: 'admin_finalized', admin_finalized_at: finalizedRecord.admin_finalized_at || new Date().toISOString(), admin_finalized_by: currentUser?.id });
          } catch (e) {/* ignore */}
        }
      }
      await notifyAdminApprovedPayroll({ admin: currentUser, periodLabel: currentPeriod?.label || 'this period', driversWithDeliveries: dwdList, appUsers });
      if (refreshPayrollRecords) {await refreshPayrollRecords();} else
      {const records = await base44.entities.Payroll.filter({ pay_period_start: periodStartStr, pay_period_end: periodEndStr });setPayrollRecords(records || []);if (onPayrollRecordsChange) onPayrollRecordsChange(records || []);}
      if (onFinalizePayroll) onFinalizePayroll({ period: currentPeriod, payrollData: dwdList, grandTotals: { Gross: grandTotalAllDrivers, tax: grandTotalTax, deductions: grandTotalDeductions, Net: grandTotalGross } });
    } catch (error) {console.error('Failed to admin finalize payroll:', error);} finally
    {setIsFinalizing(false);setShowConfirmDialog(false);}
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
      if (!userCanSeeAppFee) {appFeeRows.forEach((r) => r.style.display = 'none');appFeeYtdRows.forEach((r) => r.style.display = 'none');}
      const canvas = await html2canvas(contentRef.current, { backgroundColor: '#ffffff', scale: 2, useCORS: true, logging: false });
      setScreenshotDataUrl(canvas.toDataURL('image/png'));
      setShowScreenshotModal(true);
      if (controlsElement) controlsElement.style.display = 'flex';
      appFeeRows.forEach((r) => r.style.display = '');
      appFeeYtdRows.forEach((r) => r.style.display = '');
    } catch (error) {console.error('Failed to capture screenshot:', error);} finally
    {setIsCapturingScreenshot(false);}
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

  const formatCurrency = (amount, decimals = 2) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(amount);
  const getPaidDraftValue = (driverId, fallback) => {
    if (Object.prototype.hasOwnProperty.call(paidDrafts, driverId)) return paidDrafts[driverId];
    return fallback.toFixed(2);
  };
  const formatCentsInput = (value) => {
    const cleaned = String(value || '').replace(/[^\d]/g, '');
    const cents = parseInt(cleaned, 10) || 0;
    return (cents / 100).toFixed(2);
  };
  const roundPayrollData = (data) => {
    const rounded = { ...data };
    ['gross_pay', 'net_pay', 'total_deductions', 'bonus_pay', 'app_fee_amount', 'paid_amount', 'tax_amount', 'pay_rate_per_delivery', 'extra_km_rate', 'extra_km_limit', 'oversized_item_rate', 'total_extra_km'].forEach((f) => {if (rounded[f] != null) rounded[f] = Math.round(rounded[f] * 100) / 100;});
    return rounded;
  };

  const driversWithDeliveries = useMemo(() => payrollData.filter((d) => d.graphDeliveryCount > 0), [payrollData]);
  const isPeriodEndOfMonth = useMemo(() => {if (!currentPeriod?.end) return false;const d = new Date(currentPeriod.end);const n = new Date(d);n.setDate(n.getDate() + 1);return n.getMonth() !== d.getMonth();}, [currentPeriod?.end]);
  const driversWithDeliveriesIds = useMemo(() => driversWithDeliveries.map((d) => d.driver.id), [driversWithDeliveries]);
  const finalizedDriversCount = useMemo(() => driversWithDeliveriesIds.filter((id) => {const r = getDriverPayrollRecord(id);return r?.status === 'driver_finalized' || r?.status === 'admin_finalized' || r?.status === 'paid';}).length, [driversWithDeliveriesIds, payrollRecords]);
  const allDriversFinalized = finalizedDriversCount === driversWithDeliveriesIds.length && driversWithDeliveriesIds.length > 0;

  // Check if finalization is allowed (6pm local time on last day of pay period, or after)
  const canFinalize = useMemo(() => {
    if (!currentPeriod?.end || !cities || !currentUser) return false;
    const userCity = cities.find((c) => c && c.id === (currentUser.city_id || selectedCityId));
    const TZ = { 'AB': 'America/Edmonton', 'BC': 'America/Vancouver', 'SK': 'America/Regina', 'MB': 'America/Winnipeg', 'ON': 'America/Toronto', 'QC': 'America/Montreal', 'NB': 'America/Moncton', 'NS': 'America/Halifax', 'PE': 'America/Halifax', 'NL': 'America/St_Johns', 'YT': 'America/Whitehorse', 'NT': 'America/Yellowknife', 'NU': 'America/Iqaluit' };
    const pc = userCity?.province_state?.toUpperCase()?.substring(0, 2);
    const tz = pc && TZ[pc] || 'America/Edmonton';
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const today = new Date(now);today.setHours(0, 0, 0, 0);
    const pe = new Date(currentPeriod.end);pe.setHours(0, 0, 0, 0);
    if (today > pe) return true;
    if (today.getTime() === pe.getTime()) return now.getHours() >= 18;
    return false;
  }, [currentPeriod?.end, cities, currentUser, selectedCityId]);

  const isAdminFinalized = useMemo(() => driversWithDeliveriesIds.length > 0 && driversWithDeliveriesIds.every((id) => {const r = getDriverPayrollRecord(id);return r?.status === 'admin_finalized' || r?.status === 'paid';}), [driversWithDeliveriesIds, payrollRecords]);

  const selectedMonthIndex = currentPeriod?.start?.getMonth?.() ?? null;
  const monthlyAppFeeBaseTotal = useMemo(() => {
    if (selectedMonthIndex == null) return 0;
    return adminMetricsFeeTotals?.monthlyFees?.[selectedMonthIndex] || 0;
  }, [adminMetricsFeeTotals, selectedMonthIndex]);

  const ytdAppFeeBaseTotal = useMemo(() => {
    if (!adminMetricsFeeTotals?.monthlyFees || selectedMonthIndex == null) return 0;
    return adminMetricsFeeTotals.monthlyFees.slice(0, selectedMonthIndex + 1).reduce((sum, value) => sum + (Number(value) || 0), 0);
  }, [adminMetricsFeeTotals, selectedMonthIndex]);

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

  useEffect(() => {
    if (!currentPeriod?.start || !selectedCityId || selectedCityId === 'all') {
      setAdminMetricsFeeTotals(null);
      return;
    }

    base44.functions.invoke('getAdminMetricsAndPayrollData', {
      adminMetricsYear: currentPeriod.start.getFullYear(),
      adminMetricsCityId: selectedCityId,
      payrollYear: null,
      payrollCityId: null
    }).then((response) => {
      const adminMetrics = response?.data?.adminMetrics || response?.adminMetrics;
      setAdminMetricsFeeTotals(adminMetrics?.storeFeeTotals || null);
    }).catch(() => {
      setAdminMetricsFeeTotals(null);
    });
  }, [currentPeriod?.start, selectedCityId]);

  // Calculate AppFeeAmount for a driver - distribute from total monthly app fee pool (calendar month)
  const calculateAppFeeAmount = useCallback((driverId, appFeePercent) => {
    if (!currentPeriod || appFeePercent <= 0) return 0;
    return monthlyAppFeeBaseTotal * appFeePercent / 100;
  }, [currentPeriod, monthlyAppFeeBaseTotal]);

  const grandTotalAllDrivers = driversWithDeliveries.reduce((sum, d) => sum + d.grandTotal, 0);
  const grandTotalTax = driversWithDeliveries.reduce((sum, d) => sum + d.taxAmount, 0);
  const grandTotalDeductions = driversWithDeliveries.reduce((sum, d) => sum + sumDeductionAmounts(driverEdits[d.driver.id]?.deductions || d.deductionsArray || []), 0);
  const grandTotalBonus = driversWithDeliveries.reduce((sum, d) => sum + (Number(driverEdits[d.driver.id]?.bonusPay) || 0), 0);
  const totalDriverAppFeesPaid = driversWithDeliveries.reduce((sum, d) => sum + (isPeriodEndOfMonth ? (Number(driverEdits[d.driver.id]?.appFeeAmount) || Number(getDriverPayrollRecord(d.driver.id)?.app_fee_amount) || calculateAppFeeAmount(d.driver.id, driverEdits[d.driver.id]?.appFeePercent || 0)) : 0), 0);
  const grandTotalAppFee = isPeriodEndOfMonth ? Math.max(0, monthlyAppFeeBaseTotal - totalDriverAppFeesPaid) : 0;
  const grandTotalGross = driversWithDeliveries.reduce((sum, d) => sum + d.grossPay, 0);
  const grandTotalNet = driversWithDeliveries.reduce((sum, d) => sum + ((d.grandTotal || 0) + (d.taxAmount || 0) - sumDeductionAmounts(driverEdits[d.driver.id]?.deductions || d.deductionsArray || []) + (Number(driverEdits[d.driver.id]?.bonusPay) || 0) + (isPeriodEndOfMonth ? driverEdits[d.driver.id]?.appFeeAmount || calculateAppFeeAmount(d.driver.id, driverEdits[d.driver.id]?.appFeePercent || 0) : 0)), 0);

  const sumAllDriversAppFeePercent = useMemo(() => driversWithDeliveries.reduce((sum, d) => d.driver.id === currentUser?.id && isAppOwner(currentUser) ? sum : sum + (driverEdits[d.driver.id]?.appFeePercent || 0), 0), [driversWithDeliveries, driverEdits, currentUser]);
  const appOwnerAppFeePercent = useMemo(() => Math.max(0, 100 - sumAllDriversAppFeePercent - otherAppFeePercent), [sumAllDriversAppFeePercent, otherAppFeePercent]);
  const ytdGrandTotalGross = useMemo(() => driversWithDeliveries.reduce((sum, d) => sum + (ytdDataByDriver[d.driver.id]?.ytdGrossPay ?? 0), 0), [driversWithDeliveries, ytdDataByDriver]);
  const totalPeriodPaidAmount = useMemo(() => {
    const visibleDriverIds = new Set(driversWithDeliveries.map((d) => d.driver.id));
    return payrollRecords.reduce((sum, record) => {
      if (
      !record ||
      record.pay_period_start !== periodStartStr ||
      record.pay_period_end !== periodEndStr ||
      record.pay_period_type !== payPeriod ||
      !visibleDriverIds.has(record.driver_id))
      {
        return sum;
      }
      return sum + (Number(record.paid_amount) || 0);
    }, 0);
  }, [driversWithDeliveries, payrollRecords, periodStartStr, periodEndStr, payPeriod]);
  const ytdGrandTotalTax = useMemo(() => driversWithDeliveries.reduce((sum, d) => sum + (ytdDataByDriver[d.driver.id]?.ytdTaxAmount ?? 0), 0), [driversWithDeliveries, ytdDataByDriver]);
  const ytdGrandTotalDeductions = useMemo(() => driversWithDeliveries.reduce((sum, d) => sum + (ytdDataByDriver[d.driver.id]?.ytdDeductionsAmount ?? 0), 0), [driversWithDeliveries, ytdDataByDriver]);
  const ytdGrandTotalBonus = useMemo(() => driversWithDeliveries.reduce((sum, d) => sum + (ytdDataByDriver[d.driver.id]?.ytdBonusAmount ?? 0), 0), [driversWithDeliveries, ytdDataByDriver]);
  const ytdGrandTotalNet = useMemo(() => driversWithDeliveries.reduce((sum, d) => sum + (ytdDataByDriver[d.driver.id]?.ytdNetPay ?? 0), 0), [driversWithDeliveries, ytdDataByDriver]);

  // Initialize and sync driver edits with payroll records
  useEffect(() => {
    setDriverEdits((prev) => {
      const next = {};
      payrollData.filter((d) => d.totalDeliveries > 0).forEach((data) => {
        const k = data.driver.id;
        const pr = getDriverPayrollRecord(k);
        const netAmount = (data.grandTotal || 0) + (data.taxAmount || 0) - sumDeductionAmounts(pr?.deductions || data.deductionsArray || []) + (pr?.bonus_pay || 0) + (isPeriodEndOfMonth ? pr?.app_fee_amount ?? 0 : 0);
        const paidAmount = pr?.paid_amount != null ? pr.paid_amount : netAmount;
        next[k] = {
          ...prev[k],
          deductions: pr?.deductions || data.deductionsArray || [],
          bonusPay: pr?.bonus_pay !== undefined ? pr.bonus_pay : 0,
          appFeePercent: pr?.app_fee_percentage ?? 0,
          appFeeAmount: pr?.app_fee_amount ?? 0,
          paidAmount,
          showDeductionManager: false,
          newDeductionName: '',
          newDeductionAmount: ''
        };
      });
      return next;
    });

    setPaidDrafts((prev) => {
      const next = {};
      payrollData.filter((d) => d.totalDeliveries > 0).forEach((data) => {
        const k = data.driver.id;
        const pr = getDriverPayrollRecord(k);
        const netAmount = (data.grandTotal || 0) + (data.taxAmount || 0) - sumDeductionAmounts(pr?.deductions || data.deductionsArray || []) + (pr?.bonus_pay || 0) + (isPeriodEndOfMonth ? pr?.app_fee_amount ?? 0 : 0);
        const paidAmount = pr?.paid_amount != null ? pr.paid_amount : netAmount;
        next[k] = paidRefreshPauseRef.current[k] ? prev[k] ?? String(paidAmount.toFixed(2)) : String(paidAmount.toFixed(2));
      });
      return next;
    });
  }, [payrollData, payrollRecords, calculateAppFeeAmount]);

  // Auto-sync payroll entity records with live-calculated data whenever payrollData or records change
  const syncInProgressRef = useRef(false);
  const skipNextAutoSyncRef = useRef(false);
  useEffect(() => {
    if (!payrollData || payrollData.length === 0 || !periodStartStr || !periodEndStr) return;
    if (syncInProgressRef.current || skipNextAutoSyncRef.current) {
      skipNextAutoSyncRef.current = false;
      return;
    }
    const driversWithData = payrollData.filter((d) => d.graphDeliveryCount > 0);
    if (driversWithData.length === 0) return;
    const hasRecords = driversWithData.some((d) => getDriverPayrollRecord(d.driver.id));
    if (!hasRecords) return;
    syncInProgressRef.current = true;
    syncPayrollRecordsWithLiveData(payrollData, getDriverPayrollRecord, (updated) => {
      if (updated.length > 0) {
        console.log(`✅ [PayrollSync] Auto-synced ${updated.length} records`);
        setPayrollRecords((prev) => {
          const updatedMap = {};
          updated.forEach((u) => {updatedMap[u.recordId] = u.updates;});
          return prev.map((r) => updatedMap[r.id] ? { ...r, ...updatedMap[r.id] } : r);
        });
        if (onPayrollRecordsChange) {
          onPayrollRecordsChange(payrollRecords.map((r) => {
            const u = updated.find((u) => u.recordId === r.id);
            return u ? { ...r, ...u.updates } : r;
          }));
        }
      }
    }).finally(() => {syncInProgressRef.current = false;});
  }, [payrollData, payrollRecords, periodStartStr, periodEndStr]);

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
     <Card className="bg-card text-card-foreground mt-1 py-2 rounded-xl border shadow" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
       <CardHeader className="px-4 py-1 space-y-1.5 flex flex-col">
        {/* Mobile View: 2 rows */}
        <div className="md:hidden flex flex-col gap-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <CardTitle className="flex items-center gap-2 text-base" style={{ color: 'var(--text-slate-900)' }}>
                <Calculator className="w-5 h-5" />
                Payroll
              </CardTitle>

              {isAdmin && driversWithDeliveriesIds.length > 0 && selectedDriverId === 'all' && !isAdminFinalized &&
                <span className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                  <Users className="w-3 h-3 inline mr-1" />
                  {finalizedDriversCount}/{driversWithDeliveriesIds.length} confirmed
                </span>
                }
            </div>

            <div className="flex items-center gap-2 justify-end">
              {isAdmin && driversWithDeliveriesIds.length > 0 && selectedDriverId === 'all' && !isAdminFinalized &&
                <Button
                  size="sm"
                  onClick={() => setShowConfirmDialog(true)}
                  disabled={isFinalizing || !canFinalize || isAdminFinalized}
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
                }

              {(isDriver && selectedDriverId === currentUser?.id ||
                isAdmin && userHasRole(currentUser, 'driver') && selectedDriverId === currentUser?.id) &&
                !isCurrentDriverFinalized &&
                <Button
                  size="sm"
                  onClick={() => setShowConfirmDialog(true)}
                  disabled={isFinalizing || !canFinalize || isCurrentDriverFinalized}
                  className="gap-2 bg-emerald-600 hover:bg-emerald-700 h-8"
                  title={isCurrentDriverFinalized ? 'Already confirmed' : !canFinalize ? 'Cannot finalize until pay period ends' : ''}>
                    <CheckCircle className="w-4 h-4" />
                    {isFinalizing ? 'Finalizing...' : 'Confirm My Payroll'}
                  </Button>
                }

              <Button size="sm" variant="outline" onClick={() => handleExport(stores || [])} className="gap-2 h-8" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-300)', color: 'var(--text-slate-900)' }}>
                <Download className="w-4 h-4" />
                PDF
              </Button>
            </div>
          </div>

          {isAdmin && driversWithDeliveriesIds.length > 0 && selectedDriverId === 'all' && isAdminFinalized &&
            <div className="flex items-center justify-end gap-1 text-sm text-emerald-600 font-medium px-2">
              <CheckCircle className="w-4 h-4" />
              Finalized
            </div>
            }

          {(isDriver && selectedDriverId === currentUser?.id ||
            isAdmin && userHasRole(currentUser, 'driver') && selectedDriverId === currentUser?.id) &&
            isCurrentDriverFinalized &&
            <div className="flex items-center justify-end gap-1 text-sm text-emerald-600 font-medium px-2">
                <CheckCircle className="w-4 h-4" />
                Confirmed
              </div>
            }
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
                disabled={isFinalizing || !canFinalize || isCurrentDriverFinalized}
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
                    disabled={isFinalizing || !canFinalize || isAdminFinalized}
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
                    value={deductionDraftName}
                    onChange={(e) => setDeductionDraftName(e.target.value)}
                    className="w-full px-2 py-1 text-sm border rounded" />

                  <div className="flex gap-2">
                    <span className="flex items-center">$</span>
                    <input
                      type="number"
                      placeholder="Amount"
                      value={deductionDraftAmount}
                      onChange={(e) => setDeductionDraftAmount(e.target.value)}
                      className="flex-1 px-2 py-1 text-sm border rounded"
                      step="0.01" />

                    <button
                      onClick={async () => {
                        const name = deductionDraftName.trim();
                        const amount = deductionDraftAmount;
                        if (name && amount) {
                          const newDeductions = [...(driverEdits[deductionOverlayDriverId].deductions || []), { name, amount: parseFloat(amount) }];
                          setDriverEdits((prev) => ({
                            ...prev,
                            [deductionOverlayDriverId]: {
                              ...prev[deductionOverlayDriverId],
                              deductions: newDeductions
                            }
                          }));
                          setDeductionDraftName('');
                          setDeductionDraftAmount('');
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
                    value={bonusDraftValue}
                    onChange={(e) => setBonusDraftValue(e.target.value)}
                    onBlur={() => commitBonusDraft(bonusOverlayDriverId, bonusDraftValue)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitBonusDraft(bonusOverlayDriverId, bonusDraftValue);
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

      <AppFeeAllDriversDialog
          open={appFeeOverlayAllDriversId === 'all' && isAppOwner(currentUser)} onClose={() => setAppFeeOverlayAllDriversId(null)}
          driversWithDeliveries={driversWithDeliveries} driverEdits={driverEdits} setDriverEdits={setDriverEdits}
          currentUser={currentUser} otherAppFeePercent={otherAppFeePercent} setOtherAppFeePercent={setOtherAppFeePercent}
          sumAllDriversAppFeePercent={sumAllDriversAppFeePercent} calculateAppFeeAmount={calculateAppFeeAmount}
          totalMonthlyAppFees={monthlyAppFeeBaseTotal}
          appFeesPerDelivery={appFeesPerDelivery} extraAppFeePercent={extraAppFeePercent} getDriverPayrollRecord={getDriverPayrollRecord} />

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
              <strong>Total Net Pay:</strong> {formatCurrency(grandTotalNet)}
              {Math.abs((totalPeriodPaidAmount || 0) - (grandTotalNet || 0)) > 0.009 && (
                <>
                  <br />
                  <strong>Actual Paid:</strong> {formatCurrency(totalPeriodPaidAmount)}
                </>
              )}
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


      <CardContent ref={contentRef} className="px-1 py-1">
        <div className="space-y-2">
          {payrollData.filter((data) => data.graphDeliveryCount > 0).map((data, idx) => {
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
                    appFeeAmount={isPeriodEndOfMonth ? calculateAppFeeAmount(data.driver.id, driverEdits[data.driver.id]?.appFeePercent || 0) : 0}
                    appFeePercent={driverEdits[data.driver.id]?.appFeePercent || 0}
                    ytdDataByDriver={ytdDataByDriver}
                    isPeriodEndOfMonth={isPeriodEndOfMonth}
                    onDeductionsClick={setDeductionOverlayDriverId}
                    onBonusClick={setBonusOverlayDriverId}
                    payrollRecord={driverPayrollRecord}
                    onPaidAmountSave={async (driverId, paidAmount) => {
                      skipNextAutoSyncRef.current = true;
                      await savePayrollChanges(driverId, { paid_amount: paidAmount });
                    }} />);


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
                      disabled={isFinalizing || driverHasConfirmed}
                      className="gap-1 bg-emerald-600 hover:bg-emerald-700 text-xs h-7 px-2"
                      title={driverHasConfirmed ? 'Already confirmed' : ''}>

                     <CheckCircle className="w-3 h-3" />
                     {isFinalizing ? '...' : 'Confirm My Payroll'}
                   </Button>
                    }
              </div>

              {/* Stats and Pay Summary - Side by Side */}
              <div className="grid grid-cols-[minmax(0,1.45fr)_minmax(320px,0.9fr)] gap-4 items-stretch">
                <div className="rounded-lg border px-4 py-3" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
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
                        savePayrollChanges={savePayrollChanges} />
                      
                </div>

                <div className="rounded-lg border px-4 py-3" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                  <div className="text-xs h-full flex items-start justify-end" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    <div className="ml-auto flex gap-4">
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
                            <tr style={{ color: '#ef4444' }}>
                              <td className="text-left pr-2">
                                {isAdmin ?
                                    <button onClick={() => setDeductionOverlayDriverId(data.driver.id)} className="text-red-600 hover:text-red-700 cursor-pointer font-medium !min-h-0 h-auto py-0 leading-none align-middle">
                                    Deductions:
                                  </button> :
                                    'Deductions:'
                                    }
                              </td>
                              <td className="text-right pr-0.5">-$</td>
                              <td className="text-right font-semibold" style={{ width: '60px' }}>{sumDeductionAmounts(edit.deductions || []).toFixed(2)}</td>
                            </tr>
                            <tr style={{ color: '#16a34a' }}>
                              <td className="text-left pr-2">
                                {isAdmin ?
                                    <button onClick={() => setBonusOverlayDriverId(data.driver.id)} className="text-green-600 hover:text-green-700 cursor-pointer font-medium !min-h-0 h-auto py-0 leading-none align-middle">
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
                                <td className="text-left pr-2">App Fee %:</td>
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
                              <td className="text-right" style={{ width: '60px' }}>{getPeriodNetAmount({ grandTotal: data.grandTotal || 0, taxAmount: data.taxAmount || 0, deductions: edit.deductions || [], bonusPay: edit.bonusPay || 0, appFeeAmount: isPeriodEndOfMonth ? edit.appFeeAmount || calculateAppFeeAmount(driverKey, edit.appFeePercent || 0) : 0 }).toFixed(2)}</td>
                            </tr>
                            {canFinalize && (isAdmin || selectedDriverId === currentUser?.id) &&
                                <tr style={{ color: 'var(--text-slate-600)' }}>
                              <td className="text-left pr-2">Paid:</td>
                              <td className="text-right">$</td>
                              <td className="pr-1">
                                {isAdmin ?
                                    <Input
                                      type="text"
                                      inputMode="numeric"
                                      value={getPaidDraftValue(driverKey, parsePaidAmount(edit.paidAmount, (data.grandTotal || 0) + (data.taxAmount || 0) - sumDeductionAmounts(edit.deductions || []) + (edit.bonusPay || 0) + (isPeriodEndOfMonth ? edit.appFeeAmount || calculateAppFeeAmount(driverKey, edit.appFeePercent || 0) : 0)))}
                                      onFocus={(e) => {
                                        paidRefreshPauseRef.current[driverKey] = true;
                                        e.target.select();
                                      }}
                                      onChange={(e) => {
                                        const formattedValue = formatCentsInput(e.target.value);
                                        setPaidDrafts((prev) => ({ ...prev, [driverKey]: formattedValue }));
                                        updateEdit({ paidAmount: formattedValue });
                                      }}
                                      onBlur={async (e) => {
                                        const fallbackAmount = (data.grandTotal || 0) + (data.taxAmount || 0) - sumDeductionAmounts(edit.deductions || []) + (edit.bonusPay || 0) + (isPeriodEndOfMonth ? edit.appFeeAmount || calculateAppFeeAmount(driverKey, edit.appFeePercent || 0) : 0);
                                        const nextPaidAmount = parsePaidAmount(e.target.value, fallbackAmount);
                                        const formattedPaidAmount = nextPaidAmount.toFixed(2);
                                        setPaidDrafts((prev) => ({ ...prev, [driverKey]: formattedPaidAmount }));
                                        setDriverEdits((prev) => ({
                                          ...prev,
                                          [driverKey]: { ...prev[driverKey], paidAmount: formattedPaidAmount }
                                        }));
                                        paidRefreshPauseRef.current[driverKey] = false;
                                        skipNextAutoSyncRef.current = true;
                                        await savePayrollChanges(driverKey, {
                                          paid_amount: nextPaidAmount
                                        });
                                      }} className="flex rounded-md border px-1 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-md h-7 min-h-0 w-[70px] text-right font-semibold" /> :



                                    <div className="h-7 min-h-0 w-[60px] flex items-center justify-end text-right font-semibold">
                                    {parsePaidAmount(
                                        edit.paidAmount,
                                        (data.grandTotal || 0) + (data.taxAmount || 0) - sumDeductionAmounts(edit.deductions || []) + (edit.bonusPay || 0) + (isPeriodEndOfMonth ? edit.appFeeAmount || calculateAppFeeAmount(driverKey, edit.appFeePercent || 0) : 0)
                                      ).toFixed(2)}
                                  </div>
                                    }
                              </td>
                            </tr>
                                }
                          </tbody>
                        </table>
                      </div>

                      <div style={{ width: '1px', background: 'var(--border-slate-300)' }}></div>

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
              </div>
            </div>);

            })}
          
          {/* Total App Fees Collected - App Owner Only */}
          {payrollData.length > 1 && isAdmin && isPeriodEndOfMonth && isAppOwner(currentUser) && isAppOwner(currentUser) &&
            <div className="pt-2">
            {/* Desktop View */}
            <div className="hidden md:block">
              <div className="pr-3 pl-3 grid grid-cols-[minmax(0,1.45fr)_minmax(320px,0.9fr)] gap-4 items-stretch">
                <div className="rounded-lg border px-4 py-3" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                  <div className="flex h-full flex-col justify-center gap-2">
                    <div className="text-sm font-semibold" style={{ color: 'var(--text-slate-700)' }}>
                      Total App Fees Collected
                    </div>
                    <div className="text-xs" style={{ color: 'var(--text-slate-500)' }}>
                      Monthly and year-to-date app fee totals.
                    </div>
                  </div>
                </div>

                <div className="pt-3 pr-4 pb-3 pl-4 rounded-lg border" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                  <div className="text-xs h-full flex items-start justify-end" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    <div className="ml-auto flex gap-6 items-start">
                      {/* Period Column */}
                      <div className="flex flex-col">
                        <div className="text-xs text-center font-bold mb-1 pb-1 border-b" style={{ color: 'var(--text-slate-500)', borderColor: 'var(--border-slate-300)' }}>Month</div>
                        <table className="border-collapse">
                          <tbody>
                            <tr style={{ color: 'var(--text-slate-600)' }}>
                              <td className="text-left pr-2">
                                <button
                                    onClick={() => setAppFeeOverlayAllDriversId('all')}
                                    className="text-blue-600 hover:text-blue-700 cursor-pointer font-medium !min-h-0 h-auto py-0 leading-none align-middle">
                                  Total Fees:
                                </button>
                              </td>
                              <td className="text-right pr-0.5">$</td>
                              <td className="text-right font-semibold" style={{ width: '60px' }}>
                                {monthlyAppFeeBaseTotal.toFixed(2)}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>

                      <div style={{ width: '1px', background: 'var(--border-slate-300)' }}></div>

                      {/* YTD Column */}
                      <div className="flex flex-col">
                        <div className="text-xs text-center font-bold mb-1 pb-1 border-b" style={{ color: 'var(--text-slate-500)', borderColor: 'var(--border-slate-300)' }}>YTD</div>
                        <table className="border-collapse">
                          <tbody>
                            <tr style={{ color: 'var(--text-slate-600)' }}>
                              <td className="text-right pr-0.5">$</td>
                              <td className="text-right font-semibold" style={{ width: '60px' }}>
                                {ytdAppFeeBaseTotal.toFixed(2)}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
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
                      {monthlyAppFeeBaseTotal.toFixed(2)}
                    </div>
                    <div className="text-right pr-0.5">$</div>
                    <div className="text-right font-semibold">
                      {ytdAppFeeBaseTotal.toFixed(2)}
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
                <div className="pr-3 pl-3 grid grid-cols-[minmax(0,1.45fr)_minmax(320px,0.9fr)] gap-4 items-stretch">
                  <div className="rounded-lg border px-4 py-3" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                    <div className="grid grid-cols-3 gap-3 text-sm">
                      <div className="flex flex-col gap-1">
                        <span style={{ color: 'var(--text-slate-600)' }}>Deliveries</span>
                        <span className="rounded-md px-2 py-1 text-xs font-semibold" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)' }}>
                          {driversWithDeliveries.reduce((sum, d) => sum + d.totalDeliveries, 0)} = ${driversWithDeliveries.reduce((sum, d) => sum + d.totalBasePay, 0).toFixed(2)}
                        </span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span style={{ color: 'var(--text-slate-600)' }}>Extra KM</span>
                        <span className="rounded-md px-2 py-1 text-xs font-semibold" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)' }}>
                          {driversWithDeliveries.reduce((sum, d) => sum + d.totalExtraKm, 0).toFixed(2)} = ${driversWithDeliveries.reduce((sum, d) => sum + d.totalExtraKmPay, 0).toFixed(2)}
                        </span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span style={{ color: 'var(--text-slate-600)' }}>Oversized</span>
                        <span className="rounded-md px-2 py-1 text-xs font-semibold" style={{ background: 'var(--bg-slate-100)', color: 'var(--text-slate-700)' }}>
                          {driversWithDeliveries.reduce((sum, d) => sum + d.oversizedCount, 0)} = ${driversWithDeliveries.reduce((sum, d) => sum + d.totalOversizedPay, 0).toFixed(2)}
                        </span>
                      </div>
                      <div className="col-span-2 col-start-1 flex items-center gap-4 text-sm">
                        <div className="flex items-center gap-2">
                          <span style={{ color: 'var(--text-slate-600)' }}>Failed:</span>
                          <span className="rounded-md bg-red-100 px-2 py-1 text-xs font-semibold text-red-700">
                            {driversWithDeliveries.reduce((sum, d) => sum + d.failedCount, 0)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span style={{ color: 'var(--text-slate-600)' }}>Returns:</span>
                          <span className="rounded-md bg-orange-100 px-2 py-1 text-xs font-semibold text-orange-700">
                            {driversWithDeliveries.reduce((sum, d) => sum + (d.returnsCount || 0), 0)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border px-4 py-3" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                    <div className="text-xs h-full flex items-start justify-end" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      <div className="ml-auto flex gap-4">
                        <div className="flex flex-col">
                          <div className="font-bold text-center mb-1 pb-1 border-b" style={{ borderColor: 'var(--border-slate-300)' }}>Period</div>
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
                              <tr style={{ color: '#16a34a' }}>
                                <td className="text-left pr-2">Bonus:</td>
                                <td className="text-right pr-0.5">+$</td>
                                <td className="text-right font-semibold" style={{ width: '60px' }}>{grandTotalBonus.toFixed(2)}</td>
                              </tr>
                              {isPeriodEndOfMonth &&
                              <tr style={{ color: 'var(--text-slate-600)' }}>
                                  <td className="text-left pr-2">Extra App Fee Cut:</td>
                                  <td className="text-right pr-0.5">-$</td>
                                  <td className="text-right font-semibold" style={{ width: '60px' }}>{grandTotalAppFee.toFixed(2)}</td>
                                </tr>
                              }
                              <tr style={{ borderTop: '1px solid var(--border-slate-300)' }}>
                                <td colSpan="3" className="pt-1"></td>
                              </tr>
                              <tr className="text-lg font-bold text-emerald-600">
                                <td className="text-left pr-2">Net:</td>
                                <td className="text-right pr-0.5">$</td>
                                <td className="text-right" style={{ width: '60px' }}>{grandTotalNet.toFixed(2)}</td>
                              </tr>
                              {isAdmin &&
                              <tr style={{ color: 'var(--text-slate-600)' }}>
                                <td className="text-left pr-2">Paid:</td>
                                <td className="text-right pr-0.5">$</td>
                                <td className="text-right text-md font-semibold" style={{ width: '60px' }}>{totalPeriodPaidAmount.toFixed(2)}</td>
                              </tr>
                              }
                            </tbody>
                          </table>
                        </div>

                        <div style={{ width: '1px', background: 'var(--border-slate-300)' }}></div>

                        <div className="flex flex-col">
                          <div className="font-bold text-center mb-1 pb-1 border-b" style={{ borderColor: 'var(--border-slate-300)' }}>YTD</div>
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
                              <tr style={{ color: '#16a34a' }}>
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
                        </div>
                      </div>
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
              }} className="px-2">
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

                    {/* Gross */}
                    <div className="grid gap-1" style={{ gridTemplateColumns: '1fr 22px 60px 22px 60px', color: 'var(--text-slate-600)' }}>
                      <div className="text-left">Gross:</div>
                      <div className="text-right pr-0.5">$</div>
                      <div className="text-right font-semibold">{grandTotalAllDrivers.toFixed(2)}</div>
                      <div className="text-right pr-0.5">$</div>
                      <div className="text-right font-semibold">{ytdGrandTotalGross.toFixed(2)}</div>
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
                    <div className="grid gap-1" style={{ gridTemplateColumns: '1fr 22px 60px 22px 60px', color: '#16a34a' }}>
                      <div className="text-left">Bonus:</div>
                      <div className="text-right pr-0.5">+$</div>
                      <div className="text-right font-semibold">{grandTotalBonus.toFixed(2)}</div>
                      <div className="text-right pr-0.5">+$</div>
                      <div className="text-right font-semibold">{ytdGrandTotalBonus.toFixed(2)}</div>
                    </div>

                    {/* App Fee Cut (if end of month) */}
                    {isPeriodEndOfMonth &&
                    <div className="grid gap-1" style={{ gridTemplateColumns: '1fr 22px 60px 22px 60px', color: 'var(--text-purple-700)' }}>
                      <div className="text-left">App Fee Cut:</div>
                      <div className="text-right pr-0.5">-$</div>
                      <div className="text-right font-semibold">{grandTotalAppFee.toFixed(2)}</div>
                      <div className="text-right pr-0.5">-$</div>
                      <div className="text-right font-semibold">{grandTotalAppFee.toFixed(2)}</div>
                    </div>
                    }

                    {/* Net (bold, divider) */}
                    <div className="grid gap-1 pt-1 border-t font-bold" style={{
                      gridTemplateColumns: '1fr 22px 60px 22px 60px',
                      borderColor: 'var(--border-slate-200)',
                      color: '#10b981'
                    }}>
                      <div className="text-left">Net:</div>
                      <div className="text-right pr-0.5">$</div>
                      <div className="text-right">{grandTotalNet.toFixed(2)}</div>
                      <div className="text-right pr-0.5">$</div>
                      <div className="text-right">{ytdGrandTotalNet.toFixed(2)}</div>
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