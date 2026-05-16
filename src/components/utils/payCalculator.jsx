/**
 * Pay Calculator Utility
 * Calculates driver earnings for individual deliveries
 */

/**
 * Calculate pay for a single delivery
 * @param {Object} delivery - The delivery object
 * @param {Object} driver - The driver/AppUser object with pay rates
 * @param {Object} patient - Optional patient object (for distance_from_store)
 * @returns {number} - Total pay for this delivery in dollars
 */
export const calculateDeliveryPay = (delivery, driver, patient = null) => {
  if (!delivery || !driver) return 0;
  if (!delivery.patient_id && !delivery.after_hours_pickup) return 0;

  let totalPay = driver.pay_rate_per_delivery || 0;

  if (delivery.patient_id) {
    const extraKmRate = driver.extra_km_rate || 0;
    const extraKmLimit = driver.extra_km_limit || 0;
    const paidKm = delivery.paid_km_override ?? patient?.distance_from_store ?? 0;

    if (paidKm > extraKmLimit && extraKmRate > 0) {
      totalPay += (paidKm - extraKmLimit) * extraKmRate;
    }
  }

  if (delivery.oversized && driver.oversized_item_rate) {
    totalPay += driver.oversized_item_rate;
  }

  return totalPay;
};

/**
 * Format pay amount for display
 * @param {number} amount - Amount in dollars
 * @returns {string} - Formatted currency string
 */
export const formatPay = (amount) => {
  if (amount === 0) return '$0.00';
  return `$${amount.toFixed(2)}`;
};

/**
 * Calculate outstanding COD amount still to be collected for a set of deliveries.
 * Outstanding = sum of cod_total_amount_required minus any Debit or Credit payments already collected.
 * @param {Array} deliveries - Array of delivery objects
 * @returns {number} - Outstanding COD amount in dollars
 */
export const calculateCodOutstanding = (deliveries = []) => {
  let outstanding = 0;
  for (const delivery of deliveries) {
    if (!delivery) continue;
    const required = Number(delivery.cod_total_amount_required) || 0;
    if (required <= 0) continue;
    const collected = (delivery.cod_payments || []).reduce((sum, p) => {
      if (p?.type === 'Debit' || p?.type === 'Credit') {
        return sum + (Number(p.amount) || 0);
      }
      return sum;
    }, 0);
    outstanding += Math.max(0, required - collected);
  }
  return outstanding;
};