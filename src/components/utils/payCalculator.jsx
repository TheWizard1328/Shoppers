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
// ISD/ISP inter-store deliveries are always payable as deliveries
const isInterStoreDelivery = (delivery_id) => {
  const id = String(delivery_id || '').toUpperCase();
  return id.startsWith('ISD-') || id.startsWith('ISP-');
};

export const calculateDeliveryPay = (delivery, driver, patient = null) => {
  if (!delivery || !driver) return 0;
  if (delivery.no_charge) return 0; // No-charge deliveries are not driver payable
  if (!delivery.patient_id && !delivery.after_hours_pickup && !isInterStoreDelivery(delivery.delivery_id)) return 0;

  let totalPay = driver.pay_rate_per_delivery || 0;

  if (delivery.patient_id || isInterStoreDelivery(delivery.delivery_id)) {
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