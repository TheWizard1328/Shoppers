/**
 * Payroll Lock Manager
 * Checks if a delivery belongs to a finalized pay period
 * and prevents editing if locked
 */

import { base44 } from '@/api/base44Client';

/**
 * Check if a delivery date belongs to a finalized pay period
 * @param {string} deliveryDate - Date string in 'yyyy-MM-dd' format
 * @param {string} driverId - Driver's user_id
 * @returns {Promise<{isLocked: boolean, payrollRecord: object|null}>}
 */
export const checkPayrollLock = async (deliveryDate, driverId) => {
  if (!deliveryDate || !driverId) {
    return { isLocked: false, payrollRecord: null };
  }

  try {
    // Query all payroll records for this driver
    const payrollRecords = await base44.entities.Payroll.filter({
      driver_id: driverId
    });

    if (!payrollRecords || payrollRecords.length === 0) {
      return { isLocked: false, payrollRecord: null };
    }

    // Check if deliveryDate falls within any finalized pay period
    const deliveryDateObj = new Date(deliveryDate + 'T00:00:00');

    for (const record of payrollRecords) {
      const periodStart = new Date(record.pay_period_start + 'T00:00:00');
      const periodEnd = new Date(record.pay_period_end + 'T00:00:00');

      // Check if delivery date is in this pay period
      if (deliveryDateObj >= periodStart && deliveryDateObj <= periodEnd) {
        // Check if period is finalized (driver_finalized or admin_finalized)
        const isFinalized = record.status === 'driver_finalized' || 
                            record.status === 'admin_finalized' || 
                            record.status === 'paid';

        if (isFinalized) {
          return { isLocked: true, payrollRecord: record };
        }
      }
    }

    return { isLocked: false, payrollRecord: null };
  } catch (error) {
    console.error('Failed to check payroll lock:', error);
    // On error, allow editing (fail open)
    return { isLocked: false, payrollRecord: null };
  }
};

/**
 * Check if multiple deliveries are locked (batch check)
 * @param {Array} deliveries - Array of delivery objects with delivery_date and driver_id
 * @returns {Promise<{lockedDeliveryIds: Set, payrollRecords: Array}>}
 */
export const checkBatchPayrollLock = async (deliveries) => {
  if (!deliveries || deliveries.length === 0) {
    return { lockedDeliveryIds: new Set(), payrollRecords: [] };
  }

  const lockedDeliveryIds = new Set();
  const payrollRecordsMap = new Map();

  try {
    // Get unique driver IDs
    const driverIds = [...new Set(deliveries.map(d => d.driver_id).filter(Boolean))];

    // Fetch all payroll records for these drivers
    for (const driverId of driverIds) {
      const records = await base44.entities.Payroll.filter({ driver_id: driverId });
      if (records && records.length > 0) {
        payrollRecordsMap.set(driverId, records);
      }
    }

    // Check each delivery
    for (const delivery of deliveries) {
      if (!delivery.delivery_date || !delivery.driver_id || !delivery.id) continue;

      const driverRecords = payrollRecordsMap.get(delivery.driver_id);
      if (!driverRecords) continue;

      const deliveryDateObj = new Date(delivery.delivery_date + 'T00:00:00');

      for (const record of driverRecords) {
        const periodStart = new Date(record.pay_period_start + 'T00:00:00');
        const periodEnd = new Date(record.pay_period_end + 'T00:00:00');

        if (deliveryDateObj >= periodStart && deliveryDateObj <= periodEnd) {
          const isFinalized = record.status === 'driver_finalized' || 
                              record.status === 'admin_finalized' || 
                              record.status === 'paid';

          if (isFinalized) {
            lockedDeliveryIds.add(delivery.id);
            break;
          }
        }
      }
    }

    return { 
      lockedDeliveryIds, 
      payrollRecords: Array.from(payrollRecordsMap.values()).flat()
    };
  } catch (error) {
    console.error('Failed to batch check payroll locks:', error);
    return { lockedDeliveryIds: new Set(), payrollRecords: [] };
  }
};