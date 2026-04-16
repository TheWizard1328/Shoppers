/**
 * payrollEntitySync.js
 * 
 * Keeps the Payroll entity records in sync with the live-calculated payrollData values.
 * When deliveries change, the UI recalculates payrollData in real-time via useMemo,
 * but the persisted Payroll entity records can become stale. This module detects
 * drift and updates the entity so that the database always reflects what the UI shows.
 */
import { base44 } from '@/api/base44Client';

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

    // Only sync records that are still in draft status (don't overwrite finalized records)
    if (record.status !== 'draft') continue;

    // Build the set of fields we want to keep in sync
    // IMPORTANT: do not auto-sync custom editable values like paid_amount, bonus_pay,
    // app_fee_amount, app_fee_percentage, deductions, or total_deductions here.
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

    // Detect drift: compare each live value with the persisted value
    const updates = {};
    let hasDrift = false;
    for (const [key, liveVal] of Object.entries(liveValues)) {
      const storedVal = typeof liveVal === 'boolean' ? (record[key] || false) : round2(record[key]);
      if (liveVal !== storedVal) {
        updates[key] = liveVal;
        hasDrift = true;
      }
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