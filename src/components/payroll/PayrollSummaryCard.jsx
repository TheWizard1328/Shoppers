import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Download, Calculator, CheckCircle, AlertCircle, Clock, Users, Plus, X, Save, Share2, Loader2 } from 'lucide-react';
import html2canvas from 'html2canvas';
import ScreenshotShareModal from '../common/ScreenshotShareModal';
import { jsPDF } from 'jspdf';
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

/**
 * Payroll Summary Card
 * Calculates and displays payroll totals based on pay period and driver rates
 */
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
  const contentRef = useRef(null);

  const isAdmin = currentUser && userHasRole(currentUser, 'admin');
  const isDriver = currentUser && userHasRole(currentUser, 'driver') && !isAdmin;

  // Format period dates for querying
  const periodStartStr = currentPeriod?.start ? currentPeriod.start.toISOString().split('T')[0] : null;
  const periodEndStr = currentPeriod?.end ? currentPeriod.end.toISOString().split('T')[0] : null;

  // Calculate payroll for each driver for the current period - MOVED BEFORE OTHER EFFECTS
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
        } else if (d.status === 'cancelled') {// For cancelled: include after_hours_pickup OR store returns
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

      // Get app fee percentage from AppUser or Payroll record
      const payrollRecord = payrollRecords.find((r) => r.driver_id === driverId);
      const appFeePercentage = payrollRecord?.app_fee_percentage ?? appUser?.app_fee_percentage ?? 0;

      // Count failed and returns (cancelled with after_hours_pickup excluded from returns)
      const failedCount = periodDeliveries.filter((d) => d.status === 'failed').length;
      const returnsCount = periodDeliveries.filter((d) => d.status === 'cancelled' && !d.after_hours_pickup).length;

      // Count returns: any delivery with store name and 'return' in patient_name or delivery_notes
      const storeReturnCount = deliveries.filter((d) => {
        if (!d || d.driver_id !== driverId) return false;
        const date = new Date(d.delivery_date + 'T00:00:00');
        if (date < currentPeriod.start || date > currentPeriod.end) return false;

        const patientName = (d.patient_name || '').toLowerCase();
        const deliveryNotes = (d.delivery_notes || '').toLowerCase();
        const combined = patientName + ' ' + deliveryNotes;

        // Check if store name exists and 'return' exists
        const storeName = stores.find((s) => s && s.id === d.store_id)?.name || '';
        const hasStoreName = storeName && combined.includes(storeName.toLowerCase());
        const hasReturn = combined.includes('return');

        return hasStoreName && hasReturn;
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
        const driverCity = driverCityId ? cities.find((c) => c && c.id === driverCityId) : null;

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
        grossPay,
        appFeePercentage
      };
    });
  }, [deliveries, drivers, appUsers, patients, cities, selectedYear, selectedDriverId, currentPeriod]);

  // Last fetch timestamp to detect real changes
  const lastFetchRef = React.useRef({ timestamp: 0 });

  // Track last period we auto-created for to prevent duplicates on effect reruns
  const lastAutoCreatePeriodRef = React.useRef(null);

  // Use external payroll records if provided, otherwise fetch locally with 15-sec refresh
  useEffect(() => {
    if (externalPayrollRecords) {
      setPayrollRecords(externalPayrollRecords);
      setIsLoadingRecords(false);
      return;
    }

    if (!currentPeriod) return;

    const fetchPayrollRecords = async (force = false) => {
      const now = Date.now();
      // Check cache: only fetch if 15 seconds have passed or forced
      if (!force && now - lastFetchRef.current.timestamp < 15000) return;

      setIsLoadingRecords(true);
      try {
        // CRITICAL: Fetch ALL payroll records from Jan 1 to current period end (inclusive)
        // This ensures we get all prior periods + current period for YTD calculations
        const yearStart = new Date(currentPeriod.start.getFullYear(), 0, 1).toISOString().split('T')[0];
        const periodEnd = currentPeriod.end.toISOString().split('T')[0];
        
        console.log(`📥 [Payroll] Fetching records from ${yearStart} to ${periodEnd} (current period: ${periodStartStr} - ${periodEndStr})`);
        
        const records = await base44.entities.Payroll.filter({
          pay_period_end: { $gte: yearStart, $lte: periodEnd }
        });
        
        console.log(`📥 [Payroll] Fetched ${records?.length || 0} total payroll records from ${yearStart} to ${periodEnd}`);
        records?.forEach(r => {
          console.log(`   - Driver: ${r.driver_id}, Period: ${r.pay_period_start} to ${r.pay_period_end}, Net: $${r.net_pay}`);
        });
        
        setPayrollRecords(records || []);
        if (onPayrollRecordsChange) {
          onPayrollRecordsChange(records || []);
        }
        lastFetchRef.current.timestamp = now;
      } catch (error) {
        console.error('Failed to fetch payroll records:', error);
      } finally {
        setIsLoadingRecords(false);
      }
    };

    // Initial fetch - FORCE fetch when period changes
    console.log(`🔄 [Payroll] Period changed - forcing YTD records fetch`);
    fetchPayrollRecords(true);

    // 15-second refresh cycle (matching app refresh pattern)
    const interval = setInterval(() => fetchPayrollRecords(), 15000);

    return () => clearInterval(interval);
  }, [currentPeriod, externalPayrollRecords, periodStartStr, periodEndStr]);

  // Auto-create missing Payroll records - ONLY when period changes
  useEffect(() => {
    if (!periodStartStr || !periodEndStr || !payrollData || payrollData.length === 0) return;

    // CRITICAL: Skip if we've already processed this exact period
    const currentPeriodKey = `${periodStartStr}-${periodEndStr}`;
    if (lastAutoCreatePeriodRef.current === currentPeriodKey) {
      return;
    }

    // Mark IMMEDIATELY to prevent concurrent auto-creates
    lastAutoCreatePeriodRef.current = currentPeriodKey;

    const autoCreateMissingRecords = async () => {
      try {
        // Fetch latest records from API to ensure we have current state
        const latestRecords = await base44.entities.Payroll.filter({
          pay_period_start: periodStartStr,
          pay_period_end: periodEndStr
        });

        // Get drivers with deliveries in this pay period
        const driversWithDeliveries = payrollData.
        filter((data) => data.totalDeliveries > 0).
        map((data) => data.driver.id);

        if (driversWithDeliveries.length === 0) {
          console.log('ℹ️ [Payroll] No drivers with deliveries - skipping auto-create');
          return;
        }

        // Check which drivers already have records (from latest API data)
        const existingDriverIds = new Set(latestRecords.map((r) => r.driver_id));
        const driversNeedingRecords = driversWithDeliveries.filter((driverId) => !existingDriverIds.has(driverId));

        if (driversNeedingRecords.length === 0) {
          console.log('ℹ️ [Payroll] All drivers already have records for this period');
          return;
        }

        console.log(`🔄 [Payroll] Auto-creating records for ${driversNeedingRecords.length} drivers`);

        // Create records for missing drivers
        const newRecords = await Promise.all(
          driversNeedingRecords.map((driverId) => {
            const driverData = payrollData.find((d) => d.driver.id === driverId);
            
            // Calculate period app fee amount: billable deliveries * app fee % / 100
            let periodAppFeeDeliveries = 0;
            deliveries.forEach((d) => {
              if (!d || d.driver_id !== driverId) return;
              const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
              const periodStart = new Date(periodStartStr + 'T00:00:00');
              const periodEnd = new Date(periodEndStr + 'T00:00:00');
              if (deliveryDate < periodStart || deliveryDate > periodEnd) return;
              
              const validStatus = d.status === 'completed' || d.status === 'failed' || (d.status === 'cancelled' && d.after_hours_pickup);
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
                periodAppFeeDeliveries++;
              }
            });
            
            const periodAppFeeAmount = (periodAppFeeDeliveries * (driverData?.appFeePercentage || 0)) / 100;
            
            const recordData = {
              driver_id: driverId,
              city_id: selectedCityId && selectedCityId !== 'all' ? selectedCityId : null,
              pay_period_start: periodStartStr,
              pay_period_end: periodEndStr,
              pay_period_type: payPeriod,
              total_deliveries: driverData?.totalDeliveries || 0,
              total_extra_km: driverData?.totalExtraKm || 0,
              total_oversized_deliveries: driverData?.oversizedCount || 0,
              gross_pay: driverData?.grossPay || 0,
              net_pay: driverData?.grandTotal || 0,
              total_deductions: driverData?.deductions || 0,
              deductions: driverData?.deductionsArray || [],
              bonus_pay: 0,
              app_fee_percentage: 0,
              app_fee_amount: periodAppFeeAmount,
              tax_amount: driverData?.taxAmount || 0,
              pay_rate_per_delivery: driverData?.payRate || 0,
              extra_km_rate: driverData?.extraKmRate || 0,
              extra_km_limit: driverData?.extraKmLimit || 0,
              oversized_item_rate: driverData?.oversizedRate || 0,
              gst_hst_enabled: driverData?.gstHstEnabled || false,
              status: 'draft'
            };
            
            return base44.entities.Payroll.create(roundPayrollData(recordData));
          })
        );

        console.log(`✅ [Payroll] Created ${newRecords.length} payroll records`);

        // Update local state with fresh API data
        const allRecords = [...latestRecords, ...newRecords];
        setPayrollRecords(allRecords);
        if (onPayrollRecordsChange) {
          onPayrollRecordsChange(allRecords);
        }
      } catch (error) {
        console.error('❌ [Payroll] Failed to auto-create payroll records:', error);
      }
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



  // Handle immediate save to Payroll entity and offline DB
  const savePayrollChanges = async (driverId, updates) => {
    try {
      // Get or create payroll record
      let existingRecord = getDriverPayrollRecord(driverId);

      // If no record exists, create it first with current data
      if (!existingRecord) {
        console.log('ℹ️ [Payroll] No existing record - creating new record for driver:', driverId);
        const driverData = payrollData.find((d) => d.driver.id === driverId);
        if (!driverData) {
          console.warn('⚠️ [Payroll] No driver data found for:', driverId);
          return;
        }

        // Calculate app fee amount for this period
        let saveAppFeeDeliveries = 0;
        deliveries.forEach((d) => {
          if (!d || d.driver_id !== driverId) return;
          const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
          const periodStart = new Date(periodStartStr + 'T00:00:00');
          const periodEnd = new Date(periodEndStr + 'T00:00:00');
          if (deliveryDate < periodStart || deliveryDate > periodEnd) return;
          
          const validStatus = d.status === 'completed' || d.status === 'failed' || (d.status === 'cancelled' && d.after_hours_pickup);
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
            saveAppFeeDeliveries++;
          }
        });
        
        const saveAppFeeAmount = (saveAppFeeDeliveries * (driverData.appFeePercentage || 0)) / 100;
        
        const newRecordData = {
          driver_id: driverId,
          city_id: selectedCityId && selectedCityId !== 'all' ? selectedCityId : null,
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
          bonus_pay: 0,
          app_fee_percentage: 0,
          app_fee_amount: saveAppFeeAmount,
          tax_amount: driverData.taxAmount,
          pay_rate_per_delivery: driverData.payRate,
          extra_km_rate: driverData.extraKmRate,
          extra_km_limit: driverData.extraKmLimit,
          oversized_item_rate: driverData.oversizedRate,
          gst_hst_enabled: driverData.gstHstEnabled,
          status: 'draft'
        };
        
        const newRecord = await base44.entities.Payroll.create(roundPayrollData(newRecordData));

        setPayrollRecords((prev) => [...prev, newRecord]);
        if (onPayrollRecordsChange) {
          onPayrollRecordsChange([...payrollRecords, newRecord]);
        }
        existingRecord = newRecord;
      }

      // Recalculate totals if deductions or bonus changed
      const driverData = payrollData.find((d) => d.driver.id === driverId);
      let recalculatedUpdates = { ...updates };

      if (updates.deductions !== undefined || updates.bonus_pay !== undefined) {
        const newDeductions = updates.total_deductions !== undefined ? updates.total_deductions : existingRecord.total_deductions || 0;
        const newBonus = updates.bonus_pay !== undefined ? updates.bonus_pay : existingRecord.bonus_pay || 0;
        
        // Recalculate gross_pay = net_pay + tax - deductions + bonus
        const netPay = driverData?.grandTotal || existingRecord.net_pay || 0;
        const taxAmount = driverData?.taxAmount || 0;
        const newGrossPay = netPay + taxAmount - newDeductions + newBonus;
        
        recalculatedUpdates.gross_pay = newGrossPay;
      }

      // Update existing record (round currency values)
      const updatedRecord = await base44.entities.Payroll.update(existingRecord.id, roundPayrollData(recalculatedUpdates));
      console.log('✅ [Payroll] Updated record for driver:', driverId, recalculatedUpdates);

      // Update local state
      setPayrollRecords((prev) => prev.map((r) => r.id === existingRecord.id ? { ...r, ...updatedRecord } : r));
      if (onPayrollRecordsChange) {
        onPayrollRecordsChange(payrollRecords.map((r) => r.id === existingRecord.id ? { ...r, ...updatedRecord } : r));
      }

      // Sync to offline DB
      try {
        const { offlineDB } = await import('../utils/offlineDatabase');
        const syncData = { ...existingRecord, ...updatedRecord };
        await offlineDB.save(offlineDB.STORES.PAYROLL, syncData);
        console.log('💾 [Payroll] Synced to offline DB:', driverId);
      } catch (offlineError) {
        console.warn('⚠️ [Payroll] Failed to sync to offline DB:', offlineError);
      }

      // Force refresh after save to sync across devices
      lastFetchRef.current.timestamp = 0;
      if (refreshPayrollRecords) {
        await refreshPayrollRecords();
      }
    } catch (error) {
      console.error('❌ [Payroll] Failed to save changes:', error);
    }
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

      // Calculate app fee amount for finalization
      let finalizeAppFeeDeliveries = 0;
      deliveries.forEach((d) => {
        if (!d || d.driver_id !== driverData.driver.id) return;
        const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
        const periodStart = new Date(periodStartStr + 'T00:00:00');
        const periodEnd = new Date(periodEndStr + 'T00:00:00');
        if (deliveryDate < periodStart || deliveryDate > periodEnd) return;
        
        const validStatus = d.status === 'completed' || d.status === 'failed' || (d.status === 'cancelled' && d.after_hours_pickup);
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
          finalizeAppFeeDeliveries++;
        }
      });
      
      const finalizeAppFeeAmount = (finalizeAppFeeDeliveries * (edit.appFeePercent || 0)) / 100;

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
        bonus_pay: edit.bonusPay || 0,
        app_fee_percentage: edit.appFeePercent || 0,
        app_fee_amount: finalizeAppFeeAmount,
        tax_amount: driverData.taxAmount,
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
        savedRecord = await base44.entities.Payroll.update(existingRecord.id, roundPayrollData(payrollRecord));
        console.log('✅ [Payroll] Updated existing record:', existingRecord.id, savedRecord);
      } else {
        savedRecord = await base44.entities.Payroll.create(roundPayrollData(payrollRecord));
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
      const driversWithDeliveries = payrollData.filter((d) => d.totalDeliveries > 0);

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

  // Handle screenshot capture for sharing
  const handleCaptureScreenshot = async () => {
    if (!contentRef.current) return;

    setIsCapturingScreenshot(true);
    try {
      // Temporarily hide control elements
      const controlsElement = document.getElementById('payroll-controls');
      if (controlsElement) {
        controlsElement.style.display = 'none';
      }

      // Determine if user can see App Fee % (AppOwner or the driver themselves)
      const userCanSeeAppFee = isAppOwner(currentUser) || (isDriver && selectedDriverId === currentUser?.id);

      // Hide App Fee % rows if user doesn't have permission
      const appFeeRows = document.querySelectorAll('[data-app-fee-row="true"]');
      appFeeRows.forEach((row) => {
        if (!userCanSeeAppFee) {
          row.style.display = 'none';
        }
      });

      // Hide App Fee % YTD rows if user doesn't have permission
      const appFeeYtdRows = document.querySelectorAll('[data-app-fee-ytd-row="true"]');
      appFeeYtdRows.forEach((row) => {
        if (!userCanSeeAppFee) {
          row.style.display = 'none';
        }
      });

      // Capture the content
      const canvas = await html2canvas(contentRef.current, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true,
        logging: false
      });

      const imageUrl = canvas.toDataURL('image/png');
      setScreenshotDataUrl(imageUrl);
      setShowScreenshotModal(true);

      // Show controls again
      if (controlsElement) {
        controlsElement.style.display = 'flex';
      }

      // Show App Fee % rows again
      appFeeRows.forEach((row) => {
        row.style.display = '';
      });

      appFeeYtdRows.forEach((row) => {
        row.style.display = '';
      });
    } catch (error) {
      console.error('Failed to capture screenshot:', error);
    } finally {
      setIsCapturingScreenshot(false);
    }
  };

  // Export to PDF
  const handleExport = (stores = []) => {
    if (!currentPeriod) return;

    const formatDate = (date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    // Format filename dates: "MM_DD" format (2 digits each)
    const formatFilenameDate = (date) => {
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${month}_${day}`;
    };

    // Format dates for filename
    const dateFrom = formatFilenameDate(currentPeriod.start);
    const dateTo = formatFilenameDate(currentPeriod.end);
    const year = currentPeriod.end.getFullYear();

    // Determine if single driver or all drivers
    let filenameContext = '';
    if (selectedDriverId && selectedDriverId !== 'all') {
      // Single driver - use driver name
      const driver = payrollData.find((d) => d.driver.id === selectedDriverId)?.driver;
      filenameContext = driver?.user_name || driver?.full_name || 'Driver';
    } else {
      // All drivers - use city name
      const city = cities?.find((c) => c.id === selectedCityId);
      filenameContext = city?.name || 'All';
    }

    const filename = `${dateFrom}-${dateTo}_${year} - ${filenameContext}.pdf`;

    // Check if single driver view
    const isSingleDriver = selectedDriverId && selectedDriverId !== 'all';

    // For single driver: create compact single-page landscape layout with grid + payroll
    if (isSingleDriver) {
      const doc = new jsPDF({ orientation: 'landscape' });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const leftMargin = 14;
      let y = 15;

      // Get single driver data
      const driverData = payrollData.find((d) => d.driver.id === selectedDriverId);
      if (!driverData) return;

      // Title and Driver Name - compact header
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.text(`${driverData.driver.user_name || driverData.driver.full_name} - Payroll Report`, leftMargin, y);
      y += 7;
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.text(`${currentPeriod.label} | ${formatDate(currentPeriod.start)} - ${formatDate(currentPeriod.end)}`, leftMargin, y);
      y += 8;

      // Build store delivery grid (same as multi-driver view)
      const periodStart = currentPeriod.start;
      const periodEnd = currentPeriod.end;
      const dates = [];
      let currentDate = new Date(periodStart);
      while (currentDate <= periodEnd) {
        dates.push(new Date(currentDate));
        currentDate.setDate(currentDate.getDate() + 1);
      }

      const sortedStores = [...stores].sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
      const activeStores = sortedStores.filter((s) => s.status !== 'inactive');

      // Build store data map and oversized map for THIS driver only
      const storeDataMap = {};
      const oversizedMapSingle = {};
      dates.forEach((date) => {
        const dateKey = date.toISOString().split('T')[0];
        storeDataMap[dateKey] = {};
        oversizedMapSingle[dateKey] = {};
        activeStores.forEach((store) => {
          storeDataMap[dateKey][store.id] = 0;
          oversizedMapSingle[dateKey][store.id] = 0;
        });
      });

      deliveries.forEach((d) => {
        if (!d || !d.delivery_date || !d.store_id) return;
        if (d.driver_id !== selectedDriverId) return; // Filter by selected driver
        const validStatus = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' && d.after_hours_pickup;
        if (!validStatus) return;
        if (!d.patient_id && !d.after_hours_pickup) return;
        const date = new Date(d.delivery_date + 'T00:00:00');
        if (date < currentPeriod.start || date > currentPeriod.end) return;

        if (storeDataMap[d.delivery_date] && storeDataMap[d.delivery_date][d.store_id] !== undefined) {
          storeDataMap[d.delivery_date][d.store_id]++;
          if (d.oversized) {
            oversizedMapSingle[d.delivery_date][d.store_id]++;
          }
        }
      });

      // Filter to only stores with data
      const storesWithData = activeStores.filter((store) => {
        return dates.some((date) => {
          const dateKey = date.toISOString().split('T')[0];
          return storeDataMap[dateKey]?.[store.id] > 0;
        });
      });
      const displayStores = storesWithData.length > 0 ? storesWithData : activeStores;

      // Grid on left side (compact)
      const gridWidth = 140;
      const tableTop = y;
      const rowHeight = 5;
      const dayColWidth = 12;
      const storeColWidth = Math.min(12, (gridWidth - dayColWidth - 18) / Math.max(displayStores.length, 1));
      const totalColWidth = 12;

      doc.setFontSize(7);
      doc.setFont('helvetica', 'bold');
      doc.text('Day', leftMargin + dayColWidth / 2, tableTop + 4, { align: 'center' });

      displayStores.forEach((store, i) => {
        const x = leftMargin + dayColWidth + i * storeColWidth;
        const abbr = store.abbreviation || store.name?.substring(0, 2) || '??';
        doc.text(abbr, x + storeColWidth / 2, tableTop + 4, { align: 'center' });
      });
      doc.text('Tot', leftMargin + dayColWidth + displayStores.length * storeColWidth + totalColWidth / 2, tableTop + 4, { align: 'center' });

      doc.setDrawColor(100, 100, 100);
      const gridLineEnd = leftMargin + dayColWidth + displayStores.length * storeColWidth + totalColWidth;
      doc.line(leftMargin, tableTop + rowHeight + 1, gridLineEnd, tableTop + rowHeight + 1);

      // Vertical divider after Day column and before Tot column
      const dividerAfterDay = leftMargin + dayColWidth;
      const dividerBeforeTot = leftMargin + dayColWidth + displayStores.length * storeColWidth;

      doc.setFont('helvetica', 'normal');
      let gridY = tableTop + rowHeight + 5;

      const storeTotals = {};
      displayStores.forEach((store) => {storeTotals[store.id] = 0;});
      let grandTotal = 0;

      dates.forEach((date) => {
        const dateKey = date.toISOString().split('T')[0];
        const dayNum = date.getDate().toString();
        const isWeekend = date.getDay() === 0 || date.getDay() === 6;

        // Highlight weekend rows
        if (isWeekend) {
          doc.setFillColor(240, 240, 240);
          doc.rect(leftMargin, gridY - 4, gridLineEnd - leftMargin, rowHeight, 'F');
        }

        doc.setFont('helvetica', 'normal');
        doc.text(dayNum, leftMargin + dayColWidth / 2, gridY, { align: 'center' });

        let dayTotal = 0;
        displayStores.forEach((store, i) => {
          const count = storeDataMap[dateKey]?.[store.id] || 0;
          const oversizedCount = oversizedMapSingle[dateKey]?.[store.id] || 0;
          dayTotal += count;
          storeTotals[store.id] += count;

          const x = leftMargin + dayColWidth + i * storeColWidth;
          if (count > 0) {
            const plusSigns = oversizedCount > 0 ? '+'.repeat(oversizedCount) : '';
            doc.text(count.toString() + plusSigns, x + storeColWidth / 2, gridY, { align: 'center' });
          }
        });

        grandTotal += dayTotal;

        doc.setFont('helvetica', 'bold');
        if (dayTotal > 0) {
          doc.text(dayTotal.toString(), leftMargin + dayColWidth + displayStores.length * storeColWidth + totalColWidth / 2, gridY, { align: 'center' });
        }
        doc.setFont('helvetica', 'normal');

        gridY += rowHeight;
      });

      // Totals row
      doc.setDrawColor(100, 100, 100);
      doc.line(leftMargin, gridY - 2, gridLineEnd, gridY - 2);
      gridY += 3;

      doc.setFont('helvetica', 'bold');
      doc.text('Tot', leftMargin + dayColWidth / 2, gridY, { align: 'center' });

      displayStores.forEach((store, i) => {
        const total = storeTotals[store.id];
        const x = leftMargin + dayColWidth + i * storeColWidth;
        if (total > 0) {
          doc.text(total.toString(), x + storeColWidth / 2, gridY, { align: 'center' });
        }
      });

      doc.text(grandTotal.toString(), leftMargin + dayColWidth + displayStores.length * storeColWidth + totalColWidth / 2, gridY, { align: 'center' });

      // Draw vertical dividers
      doc.setDrawColor(150, 150, 150);
      doc.line(dividerAfterDay, tableTop + rowHeight + 1, dividerAfterDay, gridY + 2);
      doc.line(dividerBeforeTot, tableTop + rowHeight + 1, dividerBeforeTot, gridY + 2);

      // Draw box around grid
      doc.setDrawColor(100, 100, 100);
      doc.rect(leftMargin - 1, tableTop, gridLineEnd - leftMargin + 2, gridY - tableTop + 3);

      // Payroll details below the grid (2 columns: Period + YTD)
      y = gridY + 10;
      const rightColStart = leftMargin;

      // Define column positions for proper spacing (15% more condensed)
      const col1_rowTitles = rightColStart;
      const col2_payRates = rightColStart + 24;
      const col3_calcTotals = rightColStart + 64;
      const divider1 = col3_calcTotals + 17;
      const col4_ytdCounts = divider1 + 3;
      const col5_ytdTotals = col4_ytdCounts + 17;
      const rightMargin = col5_ytdTotals + 21;
      const breakdownWidth = rightMargin - rightColStart;

      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.text('Pay Breakdown', rightColStart, y);
      y += 5;

      // Draw box around entire section
      const boxTop = y - 2;

      // Column headers
      doc.setFontSize(7);
      const periodCenterX = (col1_rowTitles + col3_calcTotals + 28) / 2;
      const ytdCenterX = (divider1 + 5 + rightMargin) / 2;
      doc.text('Period', periodCenterX, y, { align: 'center' });
      doc.text('YTD', ytdCenterX, y, { align: 'center' });
      y += 1;

      // Top separator
      doc.setDrawColor(100, 100, 100);
      doc.line(rightColStart, y, rightMargin, y);
      y += 4;

      const breakdownStartY = y;

      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      const lineHeight = 4.5;

      // Calculate YTD data for this driver
      const ytdDeliveries = deliveries.filter((d) => {
        if (!d || d.driver_id !== selectedDriverId) return false;
        const validStatus = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' && d.after_hours_pickup;
        if (!validStatus) return false;
        if (!d.patient_id && !d.after_hours_pickup) return false;
        const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
        const yearStart = new Date(currentPeriod.start.getFullYear(), 0, 1);
        return deliveryDate >= yearStart && deliveryDate <= currentPeriod.end;
      });

      const ytdTotalDeliveries = ytdDeliveries.length;
      const ytdTotalBasePay = ytdTotalDeliveries * driverData.payRate;

      const ytdExtraKm = ytdDeliveries.reduce((sum, d) => {
        const patient = patients.find((p) => p?.id === d.patient_id);
        if (!patient?.distance_from_store) return sum;
        const distance = d.paid_km_override ?? patient.distance_from_store;
        const extraKm = Math.max(0, distance - driverData.extraKmLimit);
        return sum + extraKm;
      }, 0);
      const ytdExtraKmPay = ytdExtraKm * driverData.extraKmRate;

      const ytdOversizedCount = ytdDeliveries.filter((d) => d.oversized).length;
      const ytdOversizedPay = ytdOversizedCount * driverData.oversizedRate;

      const ytdGrossPay = ytdTotalBasePay + ytdExtraKmPay + ytdOversizedPay;
      const ytdFailedCount = ytdDeliveries.filter((d) => d.status === 'failed').length;
      const ytdReturnsCount = ytdDeliveries.filter((d) => d.status === 'cancelled' && d.after_hours_pickup).length;

      // Delivery Rate line
      doc.text(`Delivery Rate:`, col1_rowTitles, y);
      doc.text(`$${driverData.payRate.toFixed(2)} x ${driverData.totalDeliveries}`, col2_payRates, y);
      doc.text(`=$`, col3_calcTotals, y);
      doc.text(driverData.totalBasePay.toFixed(2), col3_calcTotals + 15, y, { align: 'right' });

      doc.text(`${ytdTotalDeliveries}`, col4_ytdCounts, y);
      doc.text(`=$`, col5_ytdTotals, y);
      doc.text(ytdTotalBasePay.toFixed(2), rightMargin - 2, y, { align: 'right' });
      y += lineHeight;

      // Extra KM line
      doc.text(`Extra KM:`, col1_rowTitles, y);
      doc.text(`$${driverData.extraKmRate.toFixed(3)}/km (>${driverData.extraKmLimit}km) x ${driverData.totalExtraKm.toFixed(2)} km`, col2_payRates, y);
      doc.text(`=$`, col3_calcTotals, y);
      doc.text(driverData.totalExtraKmPay.toFixed(2), col3_calcTotals + 15, y, { align: 'right' });

      doc.text(`${ytdExtraKm.toFixed(2)} km`, col4_ytdCounts, y);
      doc.text(`=$`, col5_ytdTotals, y);
      doc.text(ytdExtraKmPay.toFixed(2), rightMargin - 2, y, { align: 'right' });
      y += lineHeight;

      // Oversized line
      doc.text(`Oversized:`, col1_rowTitles, y);
      doc.text(`$${driverData.oversizedRate.toFixed(2)} x ${driverData.oversizedCount}`, col2_payRates, y);
      doc.text(`=$`, col3_calcTotals, y);
      doc.text(driverData.totalOversizedPay.toFixed(2), col3_calcTotals + 15, y, { align: 'right' });

      doc.text(`${ytdOversizedCount}`, col4_ytdCounts, y);
      doc.text(`=$`, col5_ytdTotals, y);
      doc.text(ytdOversizedPay.toFixed(2), rightMargin - 2, y, { align: 'right' });
      y += lineHeight + 1;

      // Draw vertical dividers
      doc.setDrawColor(150, 150, 150);
      doc.line(divider1, breakdownStartY, divider1, y);

      // Separator
      doc.setDrawColor(100, 100, 100);
      doc.line(rightColStart, y, rightMargin, y);
      y += 5;

      // Pay Summary section
      const summaryStartY = y;
      doc.setFont('helvetica', 'bold');
      doc.text('Pay Summary:', col1_rowTitles, y);
      doc.setFont('helvetica', 'normal');
      y += lineHeight;

      // Only show Net Pay if different from Gross Pay
      const hasDeductions = driverData.taxAmount > 0 || driverData.deductions > 0;
      if (hasDeductions) {
        doc.text(`Net Pay:`, col1_rowTitles, y);
        doc.text(`=$`, col3_calcTotals, y);
        doc.text(driverData.grandTotal.toFixed(2), col3_calcTotals + 15, y, { align: 'right' });

        // YTD Net Pay (same as gross for now, assuming no deductions tracking for YTD)
        doc.text(`=$`, col5_ytdTotals, y);
        doc.text(ytdGrossPay.toFixed(2), rightMargin - 2, y, { align: 'right' });
        y += lineHeight;

        if (driverData.taxAmount > 0) {
          doc.text(`Tax (${(driverData.taxRate * 100).toFixed(0)}% ${driverData.provinceCode || ''}):`, col1_rowTitles, y);
          doc.text(`$`, col3_calcTotals + 1, y);
          doc.text(driverData.taxAmount.toFixed(2), col3_calcTotals + 15, y, { align: 'right' });
          y += lineHeight;
        }

        if (driverData.deductions > 0) {
          doc.text(`Deductions:`, col1_rowTitles, y);
          doc.text(`-$`, col3_calcTotals, y);
          doc.text(driverData.deductions.toFixed(2), col3_calcTotals + 15, y, { align: 'right' });
          y += lineHeight;

          if (driverData.deductionsArray && driverData.deductionsArray.length > 0) {
            doc.setFontSize(7);
            driverData.deductionsArray.forEach((ded) => {
              doc.text(`  • ${ded.name}:`, col1_rowTitles + 2, y);
              doc.text(`-$`, col3_calcTotals, y);
              doc.text(ded.amount.toFixed(2), col3_calcTotals + 15, y, { align: 'right' });
              y += 3.5;
            });
            doc.setFontSize(8);
          }
        }
        y += 1;
      }

      // Gross Pay
      doc.setFont('helvetica', 'bold');
      doc.text(`Gross Pay:`, col1_rowTitles, y);
      doc.text(`=$`, col3_calcTotals, y);
      doc.text(driverData.grossPay.toFixed(2), col3_calcTotals + 15, y, { align: 'right' });

      doc.text(`=$`, col5_ytdTotals, y);
      doc.text(ytdGrossPay.toFixed(2), rightMargin - 2, y, { align: 'right' });
      y += lineHeight;

      // Draw vertical divider between Period and YTD for Pay Summary
      doc.setDrawColor(150, 150, 150);
      doc.line(divider1, summaryStartY - 5, divider1, y);

      // App Fee (admin/app owner only)
      if (currentUser && (userHasRole(currentUser, 'admin') || isAppOwner(currentUser))) {
        // Calculate app fee based on stores that pay app fees
        let appFeeTotal = 0;
        const periodDeliveries = deliveries.filter((d) => {
          if (!d || d.driver_id !== selectedDriverId) return false;
          const validStatus = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' && d.after_hours_pickup;
          if (!validStatus) return false;
          if (!d.patient_id && !d.after_hours_pickup) return false;
          const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
          return deliveryDate >= currentPeriod.start && deliveryDate <= currentPeriod.end;
        });

        periodDeliveries.forEach((d) => {
          const store = stores.find((s) => s?.id === d.store_id);
          if (!store) return;

          // Check if store pays app fees during this delivery date
          let paysAppFees = store.pays_app_fees || false;
          if (store.app_fee_history && store.app_fee_history.length > 0) {
            const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
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

          if (paysAppFees && driverData.appFeePercentage > 0) {
            appFeeTotal += driverData.payRate * driverData.appFeePercentage;
          }
        });

        if (appFeeTotal > 0 && driverData.appFeePercentage > 0) {
          doc.setFont('helvetica', 'normal');
          const appFeePercentage = driverData.appFeePercentage * 100;
          doc.text(`App Fee (${appFeePercentage.toFixed(0)}%):`, col1_rowTitles, y);
          doc.text(`$`, col3_calcTotals + 1, y);
          doc.text(appFeeTotal.toFixed(2), col3_calcTotals + 15, y, { align: 'right' });
          y += lineHeight;
        }
      }

      y += 1;

      // Draw box around Pay Breakdown section
      doc.setDrawColor(100, 100, 100);
      doc.rect(rightColStart - 1, boxTop, rightMargin - rightColStart + 2, y - boxTop);

      // Separator before Failed/Returns
      doc.line(rightColStart, y, rightMargin, y);
      y += 4;

      const failedReturnsStartY = y - 4;

      // Failed and Returns
      doc.setFont('helvetica', 'normal');
      doc.text(`Failed:`, col1_rowTitles, y);
      doc.text(`${driverData.failedCount}`, col3_calcTotals + 15, y, { align: 'right' });
      doc.text(`${ytdFailedCount}`, rightMargin - 2, y, { align: 'right' });
      y += lineHeight;

      doc.text(`Returns:`, col1_rowTitles, y);
      doc.text(`${driverData.storeReturnCount || 0}`, col3_calcTotals + 15, y, { align: 'right' });
      doc.text(`${ytdReturnsCount}`, rightMargin - 2, y, { align: 'right' });
      y += lineHeight;

      // Draw vertical divider for Failed/Returns section
      doc.setDrawColor(150, 150, 150);
      doc.line(divider1, failedReturnsStartY, divider1, y);

      // Draw box around Failed/Returns section
      doc.setDrawColor(100, 100, 100);
      doc.rect(rightColStart - 1, failedReturnsStartY, rightMargin - rightColStart + 2, y - failedReturnsStartY);

      doc.save(filename);
      return;
    }

    // Multi-driver view: First page: Landscape with grid matching DriverPayrollGrid (stores as columns, days as rows)
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
    const activeStores = sortedStores.filter((s) => s.status !== 'inactive');

    // Build store delivery map and oversized map (dateKey -> storeId -> count)
    const storeDataMap = {};
    const oversizedMapMulti = {};
    dates.forEach((date) => {
      const dateKey = date.toISOString().split('T')[0];
      storeDataMap[dateKey] = {};
      oversizedMapMulti[dateKey] = {};
      activeStores.forEach((store) => {
        storeDataMap[dateKey][store.id] = 0;
        oversizedMapMulti[dateKey][store.id] = 0;
      });
    });

    // Populate from deliveries
    deliveries.forEach((d) => {
      if (!d || !d.delivery_date || !d.store_id) return;
      const validStatus = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' && d.after_hours_pickup;
      if (!validStatus) return;
      if (!d.patient_id && !d.after_hours_pickup) return;
      const date = new Date(d.delivery_date + 'T00:00:00');
      if (date < currentPeriod.start || date > currentPeriod.end) return;
      // Filter by driver if selected
      if (selectedDriverId && selectedDriverId !== 'all' && d.driver_id !== selectedDriverId) return;

      if (storeDataMap[d.delivery_date] && storeDataMap[d.delivery_date][d.store_id] !== undefined) {
        storeDataMap[d.delivery_date][d.store_id]++;
        if (d.oversized) {
          oversizedMapMulti[d.delivery_date][d.store_id]++;
        }
      }
    });

    // Filter to only stores that have data
    const storesWithData = activeStores.filter((store) => {
      return dates.some((date) => {
        const dateKey = date.toISOString().split('T')[0];
        return storeDataMap[dateKey]?.[store.id] > 0;
      });
    });
    const displayStores = storesWithData.length > 0 ? storesWithData : activeStores;

    // Calculate table dimensions
    const tableTop = 30;
    const rowHeight = 6;
    const dayColWidth = 15;
    const storeColWidth = Math.min(14, (pageWidth - leftMargin * 2 - dayColWidth - 22) / Math.max(displayStores.length, 1));
    const totalColWidth = 14;

    // Header row - store abbreviations
    doc.setFontSize(7);
    doc.setFont('helvetica', 'bold');
    doc.text('Day', leftMargin + dayColWidth / 2, tableTop + 5, { align: 'center' });

    displayStores.forEach((store, i) => {
      const x = leftMargin + dayColWidth + i * storeColWidth;
      const abbr = store.abbreviation || store.name?.substring(0, 2) || '??';
      doc.text(abbr, x + storeColWidth / 2, tableTop + 5, { align: 'center' });
    });

    doc.text('Tot', leftMargin + dayColWidth + displayStores.length * storeColWidth + totalColWidth / 2, tableTop + 5, { align: 'center' });

    // Draw header line
    doc.setDrawColor(100, 100, 100);
    const multiGridLineEnd = leftMargin + dayColWidth + displayStores.length * storeColWidth + totalColWidth;
    doc.line(leftMargin, tableTop + rowHeight + 2, multiGridLineEnd, tableTop + rowHeight + 2);

    // Vertical dividers
    const multiDividerAfterDay = leftMargin + dayColWidth;
    const multiDividerBeforeTot = leftMargin + dayColWidth + displayStores.length * storeColWidth;

    // Data rows - one per day
    doc.setFont('helvetica', 'normal');
    let y = tableTop + rowHeight + 8;

    // Store column totals
    const storeTotals = {};
    displayStores.forEach((store) => {storeTotals[store.id] = 0;});
    let grandTotal = 0;

    dates.forEach((date) => {
      const dateKey = date.toISOString().split('T')[0];
      const dayNum = date.getDate().toString();
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;

      // Highlight weekend rows
      if (isWeekend) {
        doc.setFillColor(240, 240, 240);
        doc.rect(leftMargin, y - 4, multiGridLineEnd - leftMargin, rowHeight, 'F');
      }

      // Day number
      doc.setFont('helvetica', 'normal');
      doc.text(dayNum, leftMargin + dayColWidth / 2, y, { align: 'center' });

      let dayTotal = 0;
      displayStores.forEach((store, i) => {
        const count = storeDataMap[dateKey]?.[store.id] || 0;
        const oversizedCount = oversizedMapMulti[dateKey]?.[store.id] || 0;
        dayTotal += count;
        storeTotals[store.id] += count;

        const x = leftMargin + dayColWidth + i * storeColWidth;
        if (count > 0) {
          const plusSigns = oversizedCount > 0 ? '+'.repeat(oversizedCount) : '';
          doc.text(count.toString() + plusSigns, x + storeColWidth / 2, y, { align: 'center' });
        }
      });

      grandTotal += dayTotal;

      // Day total
      doc.setFont('helvetica', 'bold');
      if (dayTotal > 0) {
        doc.text(dayTotal.toString(), leftMargin + dayColWidth + displayStores.length * storeColWidth + totalColWidth / 2, y, { align: 'center' });
      }
      doc.setFont('helvetica', 'normal');

      y += rowHeight;
    });

    // Totals row
    doc.setDrawColor(100, 100, 100);
    doc.line(leftMargin, y - 2, multiGridLineEnd, y - 2);
    y += 4;

    doc.setFont('helvetica', 'bold');
    doc.text('Tot', leftMargin + dayColWidth / 2, y, { align: 'center' });

    displayStores.forEach((store, i) => {
      const total = storeTotals[store.id];
      const x = leftMargin + dayColWidth + i * storeColWidth;
      if (total > 0) {
        doc.text(total.toString(), x + storeColWidth / 2, y, { align: 'center' });
      }
    });

    doc.text(grandTotal.toString(), leftMargin + dayColWidth + displayStores.length * storeColWidth + totalColWidth / 2, y, { align: 'center' });

    // Draw vertical dividers
    doc.setDrawColor(150, 150, 150);
    doc.line(multiDividerAfterDay, tableTop + rowHeight + 2, multiDividerAfterDay, y + 2);
    doc.line(multiDividerBeforeTot, tableTop + rowHeight + 2, multiDividerBeforeTot, y + 2);

    // Draw box around grid
    doc.setDrawColor(100, 100, 100);
    doc.rect(leftMargin - 1, tableTop, multiGridLineEnd - leftMargin + 2, y - tableTop + 3);

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
    payrollData.filter((data) => data.totalDeliveries > 0).forEach((data, idx) => {
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
    doc.save(filename);
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
      'tax_amount', 'pay_rate_per_delivery', 'extra_km_rate', 'extra_km_limit', 'oversized_item_rate'
    ];
    const rounded = { ...data };
    currencyFields.forEach(field => {
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

  // Grand totals across all displayed drivers (only those with deliveries)
  const driversWithDeliveries = useMemo(() => payrollData.filter((d) => d.totalDeliveries > 0), [payrollData]);
  const grandTotalAllDrivers = driversWithDeliveries.reduce((sum, d) => sum + d.grandTotal, 0);
  const grandTotalTax = driversWithDeliveries.reduce((sum, d) => sum + d.taxAmount, 0);
  const grandTotalDeductions = driversWithDeliveries.reduce((sum, d) => sum + d.deductions, 0);
  const grandTotalGross = driversWithDeliveries.reduce((sum, d) => sum + d.grossPay, 0);

  // Count finalized drivers for admin view
  const driversWithDeliveriesIds = useMemo(() => {
    return driversWithDeliveries.map((d) => d.driver.id);
  }, [driversWithDeliveries]);

  const finalizedDriversCount = useMemo(() => {
    return driversWithDeliveriesIds.filter((driverId) => {
      const record = getDriverPayrollRecord(driverId);
      return record?.status === 'driver_finalized' ||
      record?.status === 'admin_finalized' ||
      record?.status === 'paid';
    }).length;
  }, [driversWithDeliveriesIds, payrollRecords]);

  const allDriversFinalized = finalizedDriversCount === driversWithDeliveriesIds.length && driversWithDeliveriesIds.length > 0;

  // Check if current pay period includes the last day of the month (for AppFee% editing)
  const isPeriodEndOfMonth = useMemo(() => {
    if (!currentPeriod?.end) return false;
    const periodEndDate = new Date(currentPeriod.end);
    const nextDay = new Date(periodEndDate);
    nextDay.setDate(nextDay.getDate() + 1);
    // If next day is in a different month, current period ends on last day of month
    return nextDay.getMonth() !== periodEndDate.getMonth();
  }, [currentPeriod?.end]);

  // Check if finalization is allowed (6pm local time on last day of pay period, or after)
  const canFinalize = useMemo(() => {
    if (!currentPeriod?.end || !cities || !currentUser) return false;

    // Get user's city to determine timezone
    const userCityId = currentUser.city_id || selectedCityId;
    const userCity = cities.find((c) => c && c.id === userCityId);

    // Map provinces to timezones (Canadian provinces)
    const PROVINCE_TIMEZONES = {
      'AB': 'America/Edmonton', // Alberta - MST
      'BC': 'America/Vancouver', // BC - PST
      'SK': 'America/Regina', // Saskatchewan - CST (no DST)
      'MB': 'America/Winnipeg', // Manitoba - CST
      'ON': 'America/Toronto', // Ontario - EST
      'QC': 'America/Montreal', // Quebec - EST
      'NB': 'America/Moncton', // New Brunswick - AST
      'NS': 'America/Halifax', // Nova Scotia - AST
      'PE': 'America/Halifax', // PEI - AST
      'NL': 'America/St_Johns', // Newfoundland - NST
      'YT': 'America/Whitehorse', // Yukon - PST
      'NT': 'America/Yellowknife', // Northwest Territories - MST
      'NU': 'America/Iqaluit' // Nunavut - EST
    };

    const provinceCode = userCity?.province_state?.toUpperCase()?.substring(0, 2);
    const timezone = provinceCode && PROVINCE_TIMEZONES[provinceCode] || 'America/Edmonton';

    // Get current time in city's timezone
    const nowInCityTime = new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
    const todayInCityTime = new Date(nowInCityTime);
    todayInCityTime.setHours(0, 0, 0, 0);

    const periodEnd = new Date(currentPeriod.end);
    periodEnd.setHours(0, 0, 0, 0);

    // If today is AFTER the pay period end, allow finalization
    if (todayInCityTime > periodEnd) return true;

    // If today IS the pay period end date, check if time is >= 6pm (18:00)
    if (todayInCityTime.getTime() === periodEnd.getTime()) {
      const currentHour = nowInCityTime.getHours();
      return currentHour >= 18;
    }

    // Before pay period end - not allowed
    return false;
  }, [currentPeriod?.end, cities, currentUser, selectedCityId]);

  // Check if admin has finalized
  const isAdminFinalized = useMemo(() => {
    if (driversWithDeliveriesIds.length === 0) return false;
    return driversWithDeliveriesIds.every((driverId) => {
      const record = getDriverPayrollRecord(driverId);
      return record?.status === 'admin_finalized' || record?.status === 'paid';
    });
  }, [driversWithDeliveriesIds, payrollRecords]);

  // Calculate YTD data from payroll records - sum stored values from all periods including current
  // CRITICAL: Uses shared utility to ensure consistent calculations between mobile and desktop
  const ytdDataByDriver = useMemo(() => {
    const ytdMap = {};
    
    payrollData.forEach((data) => {
      const year = currentPeriod.start.getFullYear();
      const yearStart = `${year}-01-01`;
      const currentPeriodEnd = currentPeriod.end.toISOString().split('T')[0];
      
      // CRITICAL: Include ONLY payroll records from Jan 1 to current period end (inclusive) for this driver
      const ytdRecords = payrollRecords.filter((r) => {
        if (!r || r.driver_id !== data.driver.id) return false;
        const recordEnd = r.pay_period_end;
        // Filter: recordEnd must be >= Jan 1 AND <= selected period end
        return recordEnd >= yearStart && recordEnd <= currentPeriodEnd;
      });
      
      console.log(`📋 [Payroll YTD Debug] Driver ${data.driver.user_name}: Period End=${currentPeriodEnd}`);
      console.log(`   Filtering records from ${yearStart} to ${currentPeriodEnd}`);
      console.log(`   ALL payroll records available (${payrollRecords.length} total):`);
      payrollRecords.filter(r => r.driver_id === data.driver.id).forEach(r => {
        const isIncluded = r.pay_period_end >= yearStart && r.pay_period_end <= currentPeriodEnd;
        console.log(`     ${isIncluded ? '✓' : '✗'} ${r.pay_period_start} to ${r.pay_period_end}: net=$${(r.net_pay || 0).toFixed(2)}, bonus=$${(r.bonus_pay || 0).toFixed(2)}, deductions=$${(r.total_deductions || 0).toFixed(2)}, app_fee=$${(r.app_fee_amount || 0).toFixed(2)}`);
      });
      console.log(`   YTD records included: ${ytdRecords.length}`);
      
      // Use shared utility to calculate YTD values
      const appUser = appUsers.find((au) => au && (au.user_id === data.driver.id || au.id === data.driver.id));
      const ytdValues = calculateYtdPayroll(ytdRecords, data, cities, appUser);
      
      const ytdNetTotal = ytdRecords.reduce((sum, r) => sum + (r.net_pay || 0), 0);
      const ytdGrossTotal = ytdRecords.reduce((sum, r) => sum + (r.gross_pay || 0), 0);
      const ytdAppFeeTotal = ytdRecords.reduce((sum, r) => sum + (r.app_fee_amount || 0), 0);
      console.log(`🧮 [Payroll] YTD Summary for ${data.driver.user_name}: Net=$${ytdNetTotal.toFixed(2)} (calc: $${ytdValues.ytdNetPay.toFixed(2)}), Tax=$${ytdValues.ytdTaxAmount.toFixed(2)}, Bonus=$${ytdValues.ytdBonusAmount.toFixed(2)}, Deductions=$${ytdValues.ytdDeductionsAmount.toFixed(2)}, AppFee=$${ytdAppFeeTotal.toFixed(2)} (calc: $${ytdValues.ytdAppFeeAmount.toFixed(2)}), Gross=$${ytdGrossTotal.toFixed(2)} (calc: $${ytdValues.ytdGrossPay.toFixed(2)})`);
      
      ytdMap[data.driver.id] = ytdValues;
    });
    
    return ytdMap;
  }, [payrollData, payrollRecords, currentPeriod, appUsers, cities]);

  // Load app fees per delivery setting and Extra_App_Fee_Percentage
  useEffect(() => {
    const loadAppFeesSetting = async () => {
      try {
        const settings = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
        if (settings?.[0]?.setting_value?.app_fees_per_delivery) {
          setAppFeesPerDelivery(parseFloat(settings[0].setting_value.app_fees_per_delivery));
        }
        if (settings?.[0]?.setting_value?.Extra_App_Fee_Percentage !== undefined) {
          setExtraAppFeePercent(parseFloat(settings[0].setting_value.Extra_App_Fee_Percentage));
        }
      } catch (error) {
        console.warn('Failed to load app fees setting:', error);
      }
    };
    loadAppFeesSetting();
  }, []);

  // Calculate sum of all drivers' app fee percentages
  const sumAllDriversAppFeePercent = useMemo(() => {
    return driversWithDeliveries.reduce((sum, d) => sum + (driverEdits[d.driver.id]?.appFeePercent || 0), 0);
  }, [driversWithDeliveries, driverEdits]);

  // Calculate App Owner's app fee % = 100% - Sum of all drivers - Extra App Fee % - Other App Fee %
  const appOwnerAppFeePercent = useMemo(() => {
    return Math.max(0, 100 - sumAllDriversAppFeePercent - extraAppFeePercent - otherAppFeePercent);
  }, [sumAllDriversAppFeePercent, extraAppFeePercent, otherAppFeePercent]);

  // YTD grand totals across all displayed drivers (calculated AFTER ytdDataByDriver)
  const ytdGrandTotalNet = useMemo(() => driversWithDeliveries.reduce((sum, d) => sum + (ytdDataByDriver[d.driver.id]?.ytdNetPay ?? 0), 0), [driversWithDeliveries, ytdDataByDriver]);
  const ytdGrandTotalTax = useMemo(() => driversWithDeliveries.reduce((sum, d) => sum + (ytdDataByDriver[d.driver.id]?.ytdTaxAmount ?? 0), 0), [driversWithDeliveries, ytdDataByDriver]);
  const ytdGrandTotalDeductions = useMemo(() => driversWithDeliveries.reduce((sum, d) => sum + (ytdDataByDriver[d.driver.id]?.ytdDeductionsAmount ?? 0), 0), [driversWithDeliveries, ytdDataByDriver]);
  const ytdGrandTotalGross = useMemo(() => driversWithDeliveries.reduce((sum, d) => sum + (ytdDataByDriver[d.driver.id]?.ytdGrossPay ?? 0), 0), [driversWithDeliveries, ytdDataByDriver]);

  // Calculate AppFeeAmount for a driver - distribute from total monthly app fee pool
  // CRITICAL: Use CALENDAR MONTH, not pay cycle, since app fees are collected monthly
  const calculateAppFeeAmount = useCallback((driverId, appFeePercent) => {
    if (appFeePercent <= 0 || appFeesPerDelivery === 0) return 0;
    
    // CRITICAL: Get calendar month (1st to last day), not pay period
    const calendarMonth = new Date(currentPeriod.start.getFullYear(), currentPeriod.start.getMonth(), 1);
    const calendarMonthEnd = new Date(currentPeriod.start.getFullYear(), currentPeriod.start.getMonth() + 1, 0);
    
    // CRITICAL: Check ALL stores first, then count deliveries for each
    const storeBreakdown = {};
    let totalBillableCount = 0;
    
    // Initialize all stores that pay app fees
    stores.forEach((store) => {
      if (!store) return;
      
      let paysAppFees = store.pays_app_fees || false;
      if (store.app_fee_history && store.app_fee_history.length > 0) {
        const sortedHistory = [...store.app_fee_history].sort((a, b) =>
          new Date(b.effective_date).getTime() - new Date(a.effective_date).getTime()
        );
        // Get most recent history entry (for current month)
        if (sortedHistory[0]) {
          paysAppFees = sortedHistory[0].pays_app_fees;
        }
      }
      
      storeBreakdown[store.id] = { 
        abbreviation: store.abbreviation || store.name?.substring(0, 2),
        name: store.name, 
        count: 0, 
        pays: paysAppFees 
      };
    });
    
    // Count deliveries for each store - using CALENDAR MONTH
    deliveries.forEach((d) => {
      if (!d || !d.store_id) return;
      const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
      if (deliveryDate < calendarMonth || deliveryDate > calendarMonthEnd) return;
      
      const validStatus = d.status === 'completed' || d.status === 'failed' || (d.status === 'cancelled' && d.after_hours_pickup);
      if (!validStatus) return;
      if (!d.patient_id && !d.after_hours_pickup) return;
      
      // Only count if store is in breakdown (handles edge case of deleted stores)
      if (storeBreakdown[d.store_id]) {
        storeBreakdown[d.store_id].count++;
        if (storeBreakdown[d.store_id].pays) {
          totalBillableCount++;
        }
      }
    });
    
    // Debug log - show ALL stores
    const monthStr = calendarMonth.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    console.log(`🧮 [AppFee Debug] CALENDAR MONTH: ${monthStr}, Fee/Del: $${appFeesPerDelivery}`);
    console.log(`📊 Store Summary (${Object.values(storeBreakdown).length} total stores):`);
    Object.values(storeBreakdown).forEach(s => {
      console.log(`   ${s.abbreviation}: ${s.count} deliveries ${s.pays ? '✅ PAYS' : '❌ NO PAY'}`);
    });
    const payingStores = Object.values(storeBreakdown).filter(s => s.pays).length;
    console.log(`✅ ${payingStores} stores pay app fees, ${Object.values(storeBreakdown).length - payingStores} don't`);
    console.log(`   Total Billable: ${totalBillableCount} deliveries`);
    
    const totalMonthlyAppFees = totalBillableCount * appFeesPerDelivery;
    console.log(`   Pool Calculation: ${totalBillableCount} × $${appFeesPerDelivery} = $${totalMonthlyAppFees.toFixed(2)}`);
    const driverAppFee = (totalMonthlyAppFees * appFeePercent) / 100;
    console.log(`   Driver ${driverId}: ${appFeePercent}% of $${totalMonthlyAppFees.toFixed(2)} = $${driverAppFee.toFixed(2)}`);
    
    return (totalMonthlyAppFees * appFeePercent) / 100;
  }, [deliveries, stores, currentPeriod, appFeesPerDelivery]);

  // Initialize and sync driver edits with payroll records
  useEffect(() => {
    const driversWithDeliveries = payrollData.filter((d) => d.totalDeliveries > 0);
    const newEdits = {};

    driversWithDeliveries.forEach((data) => {
      const driverKey = data.driver.id;
      const payrollRecord = getDriverPayrollRecord(driverKey);
      const appFeePercent = payrollRecord?.app_fee_percentage !== undefined ? payrollRecord.app_fee_percentage : 0;
      
      // CRITICAL: Recalculate app_fee_amount based on current deliveries and stored percentage
      const recalculatedAppFeeAmount = calculateAppFeeAmount(driverKey, appFeePercent);
      
      // CRITICAL: Always sync from payroll record if it exists, otherwise use defaults
      newEdits[driverKey] = {
        deductions: payrollRecord?.deductions || data.deductionsArray || [],
        bonusPay: payrollRecord?.bonus_pay !== undefined ? payrollRecord.bonus_pay : 0,
        appFeePercent: appFeePercent,
        recalculatedAppFeeAmount: recalculatedAppFeeAmount,
        showDeductionManager: false,
        newDeductionName: '',
        newDeductionAmount: ''
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
                     <th className="text-right px-2 py-1.5 font-semibold" style={{ width: '80px' }}>Fee %</th>
                     <th className="text-right px-2 py-1.5 font-semibold" style={{ width: '80px' }}>Fee $</th>
                   </tr>
                 </thead>
                 <tbody>
                   {driversWithDeliveries.map((driver, idx) => {
                     const driverAppFeePercent = driverEdits[driver.driver.id]?.appFeePercent || 0;
                     const driverAppFeeAmount = calculateAppFeeAmount(driver.driver.id, driverAppFeePercent);
                     const isCurrentUser = driver.driver.id === currentUser?.id;

                     return (
                       <tr key={driver.driver.id} style={{ borderBottom: '1px solid var(--border-slate-200)', background: isCurrentUser ? 'var(--bg-blue-50)' : idx % 2 === 0 ? 'var(--bg-slate-50)' : 'transparent' }}>
                         <td className="px-2 py-1.5 truncate text-left">
                           {driver.driver.user_name || driver.driver.full_name}
                           {isCurrentUser && isAppOwner(currentUser) && <span className="text-xs font-semibold text-blue-600 ml-1">(App Owner)</span>}
                         </td>
                         <td className="text-right px-1 py-1.5">
                           <input
                             type="number"
                             value={driverAppFeePercent.toFixed(2)}
                             onChange={(e) => {
                               const newPercent = parseFloat(e.target.value) || 0;
                               setDriverEdits((prev) => ({
                                 ...prev,
                                 [driver.driver.id]: { 
                                   ...prev[driver.driver.id], 
                                   appFeePercent: newPercent,
                                   appFeeAmount: calculateAppFeeAmount(driver.driver.id, newPercent)
                                 }
                               }));
                             }}
                             className="w-full px-1 py-0.5 border rounded text-right text-xs"
                             step="0.01"
                             min="0"
                             max="100" />
                         </td>
                         <td className="text-right px-1 py-1.5">
                           <input
                             type="number"
                             value={driverAppFeeAmount.toFixed(2)}
                             onChange={(e) => {
                               const newAmount = parseFloat(e.target.value) || 0;
                               let totalBillableCount = 0;
                               const calendarMonth = new Date(currentPeriod.start.getFullYear(), currentPeriod.start.getMonth(), 1);
                               const calendarMonthEnd = new Date(currentPeriod.start.getFullYear(), currentPeriod.start.getMonth() + 1, 0);
                               deliveries.forEach((d) => {
                                 if (!d || !d.store_id) return;
                                 const deliveryDate = new Date(d.delivery_date + 'T00:00:00');
                                 if (deliveryDate < calendarMonth || deliveryDate > calendarMonthEnd) return;
                                 const validStatus = d.status === 'completed' || d.status === 'failed' || (d.status === 'cancelled' && d.after_hours_pickup);
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
                               const newPercent = totalMonthlyAppFees > 0 ? (newAmount / totalMonthlyAppFees) * 100 : 0;
                               setDriverEdits((prev) => ({
                                 ...prev,
                                 [driver.driver.id]: { 
                                   ...prev[driver.driver.id], 
                                   appFeePercent: newPercent,
                                   appFeeAmount: newAmount
                                 }
                               }));
                             }}
                             className="w-full px-1 py-0.5 border rounded text-right text-xs"
                             step="0.01"
                             min="0" />
                         </td>
                       </tr>
                     );
                   })}
                   {/* Other App Fee Row */}
                   <tr style={{ background: 'var(--bg-slate-50)', borderBottom: '1px solid var(--border-slate-200)' }}>
                     <td className="px-2 py-1.5 text-left">Other App Fee</td>
                     <td className="text-right px-1 py-1.5">
                       <input
                         type="number"
                         value={otherAppFeePercent.toFixed(2)}
                         onChange={(e) => {
                           const newPercent = parseFloat(e.target.value) || 0;
                           setOtherAppFeePercent(Math.max(0, newPercent));
                         }}
                         className="w-full px-1 py-0.5 border rounded text-right text-xs no-spinner"
                         step="0.01"
                         min="0" />
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
                             const validStatus = d.status === 'completed' || d.status === 'failed' || (d.status === 'cancelled' && d.after_hours_pickup);
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
                           const newPercent = totalMonthlyAppFees > 0 ? (newAmount / totalMonthlyAppFees) * 100 : 0;
                           setOtherAppFeePercent(newPercent);
                         }}
                         className="w-full px-1 py-0.5 border rounded text-right text-xs no-spinner"
                         step="0.01"
                         min="0" />
                     </td>
                   </tr>
                   {/* App Owner Row */}
                   <tr style={{ background: 'var(--bg-slate-100)', borderTop: '2px solid var(--border-slate-300)' }}>
                     <td className="px-2 py-1.5 font-semibold">App Owner</td>
                     <td className="text-right px-1 py-1.5 font-semibold">{appOwnerAppFeePercent.toFixed(2)}%</td>
                     <td className="text-right px-1 py-1.5 font-semibold">${(calculateAppFeeAmount('app-owner', appOwnerAppFeePercent) || 0).toFixed(2)}</td>
                   </tr>
                 </tbody>
               </table>
             </div>
           </div>

           {/* Summary */}
           <div className="text-xs p-2 bg-slate-50 rounded mt-3">
             <div>Sum of Driver App Fees: <strong>{sumAllDriversAppFeePercent.toFixed(2)}%</strong></div>
             <div>Other App Fee: <strong>{otherAppFeePercent.toFixed(2)}%</strong></div>
             <div className="text-blue-600 font-semibold mt-1">App Owner App Fee: <strong>{appOwnerAppFeePercent.toFixed(2)}%</strong></div>
           </div>
           </div>

         <DialogFooter>
           <Button
             variant="outline"
             onClick={async () => {
               try {
                 // Save each driver's app fee percentage and amount to payroll records
                 for (const driver of driversWithDeliveries) {
                   const driverAppFeePercent = driverEdits[driver.driver.id]?.appFeePercent || 0;
                   const driverAppFeeAmount = calculateAppFeeAmount(driver.driver.id, driverAppFeePercent);
                   await savePayrollChanges(driver.driver.id, {
                     app_fee_percentage: driverAppFeePercent,
                     app_fee_amount: driverAppFeeAmount
                   });
                 }

                 // Save Extra_App_Fee_Percentage to AppSettings
                 const settings = await base44.entities.AppSettings.filter({ setting_key: 'refresh_intervals' });
                 if (settings?.[0]) {
                   await base44.entities.AppSettings.update(settings[0].id, {
                     setting_value: {
                       ...settings[0].setting_value,
                       Extra_App_Fee_Percentage: extraAppFeePercent
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

                       const validStatus = d.status === 'completed' || d.status === 'failed' || (d.status === 'cancelled' && d.after_hours_pickup);
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
                     const newPercent = totalMonthlyAppFees > 0 ? (newAmount / totalMonthlyAppFees) * 100 : 0;

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
                  {/* Left: 8 Stats in 4 columns x 2 rows with fixed column widths */}
                  <div className="grid text-xs" style={{ gridTemplateColumns: '150px 140px 140px 120px', gap: '1rem 1rem', rowGap: '0.125rem' }}>
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

                {/* Right: Pay Summary with YTD */}
                 <div className="text-xs ml-4 flex gap-4" style={{ fontVariantNumeric: 'tabular-nums' }}>
                   {/* Period Column */}
                   <div className="flex flex-col">
                     <div className="font-bold text-center mb-1 pb-1 border-b">Period</div>
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
                         <td className="text-right pr-1">
                           {isAdmin ?
                                <button onClick={() => setDeductionOverlayDriverId(data.driver.id)} className="text-blue-600 hover:text-blue-700 cursor-pointer font-medium">
                               Deductions:
                             </button> :

                                'Deductions:'
                                }
                         </td>
                         <td className="text-right">-$</td>
                         <td className="text-right font-semibold">{(edit.deductions?.reduce((sum, d) => sum + (d?.amount || 0), 0) || 0).toFixed(2)}</td>
                       </tr>
                       <tr style={{ color: 'var(--text-slate-600)' }}>
                         <td className="text-right pr-1">
                           {isAdmin ?
                                <button onClick={() => setBonusOverlayDriverId(data.driver.id)} className="text-blue-600 hover:text-blue-700 cursor-pointer font-medium">
                               Bonus:
                             </button> :

                                'Bonus:'
                                }
                         </td>
                         <td className="text-right">+$</td>
                         <td className="text-right font-semibold">{(edit.bonusPay || 0).toFixed(2)}</td>
                       </tr>
                       {isAdmin && isPeriodEndOfMonth && ((isAppOwner(currentUser) || (edit.appFeePercent || 0) > 0)) &&
                       <tr style={{ color: 'var(--text-slate-600)' }} data-app-fee-row="true">
                         <td className="text-right pr-1">
                           <button onClick={() => setAppFeeOverlayDriverId(driverKey)} className="text-blue-600 hover:text-blue-700 cursor-pointer font-medium">
                             App Fee %:
                           </button>
                         </td>
                         <td className="text-right">+$</td>
                         <td className="text-right font-semibold">{(edit.recalculatedAppFeeAmount || 0).toFixed(2)}</td>
                         </tr>
                       }
                       <tr className="text-lg font-bold text-emerald-600">
                         <td className="text-right pr-1 pt-1">Gross:</td>
                         <td className="text-right pt-1">$</td>
                         <td className="text-right pt-1">{(Math.round(data.grandTotal * 100) / 100 + Math.round(data.taxAmount * 100) / 100 + (edit.bonusPay || 0) - (edit.deductions?.reduce((sum, d) => sum + (d?.amount || 0), 0) || 0) + calculateAppFeeAmount(driverKey, edit.appFeePercent)).toFixed(2)}</td>
                       </tr>
                     </tbody>
                     </table>
                     </div>

                     {/* Vertical Divider */}
                     <div style={{ width: '1px', background: 'var(--border-slate-300)' }}></div>

                     {/* YTD Column */}
                     <div className="flex flex-col">
                       <div className="font-bold text-center mb-1 pb-1 border-b">YTD</div>
                       <table className="border-collapse">
                         <tbody>
                           <tr style={{ color: 'var(--text-slate-600)' }}>
                             <td className="text-right">$</td>
                             <td className="text-right font-semibold">{(ytdDataByDriver[data.driver.id]?.ytdNetPay ?? 0).toFixed(2)}</td>
                           </tr>
                           <tr style={{ color: 'var(--text-slate-600)' }}>
                             <td className="text-right">$</td>
                             <td className="text-right font-semibold">{(ytdDataByDriver[data.driver.id]?.ytdTaxAmount ?? 0).toFixed(2)}</td>
                           </tr>
                           <tr style={{ color: 'var(--text-slate-600)' }}>
                             <td className="text-right">-$</td>
                             <td className="text-right font-semibold">{(ytdDataByDriver[data.driver.id]?.ytdDeductionsAmount ?? 0).toFixed(2)}</td>
                           </tr>
                           <tr style={{ color: 'var(--text-slate-600)' }}>
                             <td className="text-right">+$</td>
                             <td className="text-right font-semibold">{(ytdDataByDriver[data.driver.id]?.ytdBonusAmount ?? 0).toFixed(2)}</td>
                           </tr>
                           {isAdmin && isPeriodEndOfMonth && ((isAppOwner(currentUser) || driverEdits[data.driver.id]?.appFeePercent > 0)) &&
                           <tr style={{ color: 'var(--text-slate-600)' }} data-app-fee-ytd-row="true">
                             <td className="text-right">+$</td>
                             <td className="text-right font-semibold">{(ytdDataByDriver[data.driver.id]?.ytdAppFeeAmount ?? 0).toFixed(2)}</td>
                           </tr>
                           }
                           <tr className="text-lg font-bold text-emerald-600">
                             <td className="text-right pt-1">$</td>
                             <td className="text-right pt-1">{(ytdDataByDriver[data.driver.id]?.ytdGrossPay ?? 0).toFixed(2)}</td>
                           </tr>

                         </tbody>
                         </table>
                         </div>
                             </div>
                             </div>
                             </div>
                             </div>);

          })}
          
          {/* App Owner App Fee % Row */}
          {payrollData.length > 1 && isAdmin && isPeriodEndOfMonth && isAppOwner(currentUser) &&
          <div className="pt-2 px-3 py-2 rounded-lg" style={{ background: 'var(--bg-slate-50)', borderLeft: '3px solid #8b5cf6' }}>
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold" style={{ color: 'var(--text-slate-700)' }}>
                App Owner App Fee % &amp; YTD
              </div>
              <div className="flex gap-6 items-start">
                {/* Period Column */}
                <div className="flex flex-col items-end gap-0.5">
                  <div className="text-xs text-center font-bold mb-1" style={{ color: 'var(--text-slate-500)' }}>Period</div>
                  <div className="text-sm" style={{ color: 'var(--text-slate-600)' }}>
                    <span className="text-xs mr-1">App Fee %:</span>
                    <button 
                      onClick={() => setAppFeeOverlayAllDriversId('all')}
                      className="font-semibold text-blue-600 hover:text-blue-700 cursor-pointer">
                      {appOwnerAppFeePercent.toFixed(2)}%
                    </button>
                  </div>
                  <div className="text-sm" style={{ color: 'var(--text-slate-600)' }}>
                    <span className="text-xs mr-1">App Fee $:</span>
                    <span className="font-semibold">${(calculateAppFeeAmount('app-owner', appOwnerAppFeePercent) || 0).toFixed(2)}</span>
                  </div>
                </div>

                {/* YTD Column */}
                <div className="flex flex-col items-end gap-0.5">
                  <div className="text-xs text-center font-bold mb-1" style={{ color: 'var(--text-slate-500)' }}>YTD</div>
                  <div className="text-sm" style={{ color: 'var(--text-slate-600)' }}>
                    <span className="text-xs mr-1">App Fee %:</span>
                    <span className="font-semibold">{appOwnerAppFeePercent.toFixed(2)}%</span>
                  </div>
                  <div className="text-sm" style={{ color: 'var(--text-slate-600)' }}>
                    <span className="text-xs mr-1">App Fee $:</span>
                    <span className="font-semibold">${(calculateAppFeeAmount('app-owner', appOwnerAppFeePercent) || 0).toFixed(2)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          }

          {/* Grand Total for All Drivers */}
          {payrollData.length > 1 &&
          <div className="pt-4" style={{ borderTop: '2px solid var(--border-slate-300)' }}>
              <div className="flex items-center justify-between">
                <div className="font-semibold" style={{ color: 'var(--text-slate-700)' }}>Total Payroll (All Drivers)</div>
                <div className="flex gap-8 items-start">
                  {/* Period Column */}
                  <div className="flex flex-col items-end gap-0.5">
                    {grandTotalTax > 0 || grandTotalDeductions > 0 ?
                  <>
                        <div className="text-xs text-center font-bold mb-1" style={{ color: 'var(--text-slate-500)' }}>Period</div>
                        <div className="text-sm" style={{ color: 'var(--text-slate-600)' }}>
                          <span className="text-xs mr-1">Net:</span>
                          <span className="font-semibold">{formatCurrency(grandTotalAllDrivers)}</span>
                        </div>
                        {grandTotalTax > 0 &&
                    <div className="text-sm" style={{ color: 'var(--text-slate-600)' }}>
                            <span className="text-xs mr-1">Tax:</span>
                            <span className="font-semibold">{formatCurrency(grandTotalTax)}</span>
                          </div>
                    }
                        {grandTotalDeductions > 0 &&
                    <div className="text-sm" style={{ color: '#ef4444' }}>
                            <span className="text-xs mr-1">Deductions:</span>
                            <span className="font-semibold">-{formatCurrency(grandTotalDeductions)}</span>
                          </div>
                    }
                        <div className="text-sm" style={{ color: 'var(--text-slate-600)' }}>
                          <button 
                            onClick={() => setAppFeeOverlayAllDriversId('all')}
                            className="text-xs mr-1 text-blue-600 hover:text-blue-700 cursor-pointer font-medium">
                            Extra App Fee Cut:
                          </button>
                          <span className="font-semibold">-{formatCurrency(calculateAppFeeAmount('extra-app-fee', extraAppFeePercent))}</span>
                        </div>
                        <div className="text-lg font-bold text-emerald-700 mt-1">
                          <span className="text-lg font-bold mr-1">Gross:</span>
                          {formatCurrency(grandTotalGross)}
                        </div>
                      </> :

                  <div className="text-lg font-bold text-emerald-700">
                        {formatCurrency(grandTotalGross)}
                      </div>
                  }
                  </div>

                  {/* YTD Column */}
                  <div className="flex flex-col items-end gap-0.5">
                    {ytdGrandTotalTax > 0 || ytdGrandTotalDeductions > 0 ?
                  <>
                        <div className="text-xs text-center font-bold mb-1" style={{ color: 'var(--text-slate-500)' }}>YTD</div>
                        <div className="text-sm font-semibold" style={{ color: 'var(--text-slate-600)' }}>
                          {formatCurrency(ytdGrandTotalNet)}
                        </div>
                        {ytdGrandTotalTax > 0 &&
                    <div className="text-sm font-semibold" style={{ color: 'var(--text-slate-600)' }}>
                            {formatCurrency(ytdGrandTotalTax)}
                          </div>
                    }
                        {ytdGrandTotalDeductions > 0 &&
                    <div className="text-sm font-semibold" style={{ color: '#ef4444' }}>
                            -{formatCurrency(ytdGrandTotalDeductions)}
                          </div>
                    }
                        <div className="text-sm font-semibold" style={{ color: 'var(--text-slate-600)' }}>
                         -{formatCurrency(calculateAppFeeAmount('extra-app-fee', extraAppFeePercent))}
                       </div>
                        <div className="text-lg font-bold text-emerald-700 mt-1">
                          {formatCurrency(ytdGrandTotalGross)}
                        </div>
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
          }
        </div>
      </CardContent>
    </Card>);

}