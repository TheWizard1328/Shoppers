/**
 * Pay Calculator Utility
 * Calculates driver earnings for individual deliveries
 */

/**
 * Calculate pay for a single delivery
 * @param {Object} delivery - The delivery object
 * @param {Object} driver - The driver/AppUser object with pay rates
 * @returns {number} - Total pay for this delivery in dollars
 */
export const calculateDeliveryPay = (delivery, driver) => {
  if (!delivery || !driver) return 0;

  let totalPay = 0;

  // Base pay per delivery
  const baseRate = driver.pay_rate_per_delivery || 0;
  totalPay += baseRate;

  // Extra KM pay (if distance exceeds limit)
  const extraKmRate = driver.extra_km_rate || 0;
  const extraKmLimit = driver.extra_km_limit || 0;
  const paidKm = delivery.paid_km_override ?? delivery.travel_dist ?? 0;

  if (paidKm > extraKmLimit && extraKmRate > 0) {
    const extraKm = paidKm - extraKmLimit;
    totalPay += extraKm * extraKmRate;
  }

  // Oversized item bonus
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