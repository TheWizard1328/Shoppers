/**
 * payrollEntitySync.js
 * 
 * Keeps the Payroll entity records in sync with the live-calculated payrollData values.
 * When deliveries change, the UI recalculates payrollData in real-time via useMemo,
 * but the persisted Payroll entity records can become stale. This module detects
 * drift and updates the entity so that the database always reflects what the UI shows.
 */
import { base44 } from '@/api/base44Client';
import { sumDeductionAmounts } from '@/components/payroll/payrollSummaryCalculations';

// Round currency values to 2 decimals
const round2 = (v) => Math.round((v || 0) * 100) / 100;

/**
 * Compare live-calculated payroll stats against the persisted Payroll record
 * and update the entity if any tracked field has drifted.
 *
 * @param {Array} payrollData - live-calculated driver payroll array from useMemo
 * @param {Function} getDriverPayrollRecord - fn(driverId) => record | undefined
 * @param {Function} onRecordsUpdated - callback after records are updated
 */
export async function syncPayrollRecordsWithLiveData(payrollData, getDriverPayrollRecord, onRecordsUpdated) {
  if (!payrollData || payrollData.length === 0) return;

  const updatedRecords = [];

  const updatesToApply = [];

  for (const data of payrollData) {
    if (data.totalDeliveries === 0) continue;

    const record = getDriverPayrollRecord(data.driver.id);
    if (!record) continue; // No persisted record yet — auto-create handles this

    // 'paid' records are fully locked — skip everything.
    // 'draft' records sync ALL pay totals + the deductions snapshot.
    // 'driver_finalized' / 'admin_finalized' records keep their pay totals frozen
    // but STILL receive the deductions snapshot from AppUser.deductions — that's
    // the source of truth for recurring deductions, and admins add/adjust them
    // between driver-confirmation and admin-payment.
    const recordStatus = record.status || 'draft';
    if (recordStatus === 'paid') continue;
    const canSyncTotals = (recordStatus === 'draft');
    const canSyncDeductions = true; // any non-paid status

    const updates = {};
    let hasDrift = false;

    if (canSyncTotals) {
      // IMPORTANT: paid_amount, bonus_pay, app_fee_amount, app_fee_percentage remain
      // user-editable and are NOT auto-synced.
      // deductions + total_deductions ARE synced to AppUser.deductions as the source
      // of truth — otherwise a newly-added recurring deduction on the driver's
      // AppUser would never propagate into existing draft Payroll records.
      const liveValues = {
        total_deliveries: data.totalDeliveries,
        total_extra_km: round2(data.totalExtraKm),
        total_oversized_deliveries: data.oversizedCount,
        total_after_hours_deliveries: data.afterHoursCount || 0,
        gross_pay: round2(data.grossPay),
        net_pay: round2(data.grandTotal),
        tax_amount: round2(data.taxAmount),
        pay_rate_per_delivery: round2(data.payRate),
        extra_km_rate: round2(data.extraKmRate),
        extra_km_limit: round2(data.extraKmLimit),
        oversized_item_rate: round2(data.oversizedRate),
        gst_hst_enabled: data.gstHstEnabled || false,
      };

      for (const [key, liveVal] of Object.entries(liveValues)) {
        const storedVal = typeof liveVal === 'boolean' ? (record[key] || false) : round2(record[key]);
        if (liveVal !== storedVal) {
          updates[key] = liveVal;
          hasDrift = true;
        }
      }
    }

    // Sync the deductions snapshot to AppUser.deductions (period-overlap filtered)
    // for any record that isn't 'paid'. Frozen totals on finalized records aren't
    // touched — only the deduction list mirrors AppUser.
    if (canSyncDeductions) {
      const liveDeductions = Array.isArray(data.deductionsArray) ? data.deductionsArray : [];
      const storedDeductions = Array.isArray(record.deductions) ? record.deductions : [];
      const sameDeduction = (a, b) =>
        (a?.name || '') === (b?.name || '') && (round2(a?.amount) === round2(b?.amount)) &&
        (a?.start_date || '') === (b?.start_date || '') && (a?.end_date || '') === (b?.end_date || '');
      const liveHasNew =
        liveDeductions.some((d) => !storedDeductions.some((s) => sameDeduction(d, s)));
      const storedMissingLive =
        storedDeductions.some((s) => !liveDeductions.some((d) => sameDeduction(s, d)));
      const liveTotal = round2(sumDeductionAmounts(liveDeductions));
      const storedTotal = round2(record.total_deductions || 0);
      if (liveDeductions.length > 0 && (liveHasNew || storedMissingLive)) {
        updates.deductions = liveDeductions;
        if (storedTotal !== liveTotal) {
          updates.total_deductions = liveTotal;
        }
        hasDrift = true;
      } else if (liveDeductions.length === 0 && storedDeductions.length > 0) {
        updates.deductions = [];
        if (storedTotal !== 0) updates.total_deductions = 0;
        hasDrift = true;
      } else if (liveDeductions.length > 0 && storedTotal !== liveTotal) {
        updates.total_deductions = liveTotal;
        hasDrift = true;
      }
    }

    // Patch missing company_id and wrong pay_period_type on existing draft records
    if (!record.company_id && data.driver?.company_id) {
      updates.company_id = data.driver.company_id;
      hasDrift = true;
    }
    const driverPayCycle = data.driver?.pay_cycle_type;
    if (driverPayCycle && record.pay_period_type !== driverPayCycle && record.status === 'draft') {
      updates.pay_period_type = driverPayCycle;
      hasDrift = true;
    }

    if (hasDrift) {
      updatesToApply.push({ data, record, updates });
    }
  }

  for (const item of updatesToApply) {
    try {
      await base44.entities.Payroll.update(item.record.id, item.updates);
      updatedRecords.push({ driverId: item.data.driver.id, recordId: item.record.id, updates: item.updates });
      console.log(`🔄 [PayrollSync] Updated record for ${item.data.driver.user_name || item.data.driver.id}:`, Object.keys(item.updates).join(', '));
    } catch (err) {
      console.warn(`⚠️ [PayrollSync] Failed to update record ${item.record.id}:`, err);
    }
  }

  if (updatedRecords.length > 0 && onRecordsUpdated) {
    onRecordsUpdated(updatedRecords);
  }

  return updatedRecords;
}