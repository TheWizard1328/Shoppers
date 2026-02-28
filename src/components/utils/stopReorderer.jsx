/**
 * Stop Reordering Utility
 * 
 * Handles automatic reordering of stops when a status changes:
 * 1. Completed/Failed/Returned stops are sorted by actual_delivery_time
 * 2. Incomplete stops are sorted by delivery_time_eta
 * 3. Stop orders are updated sequentially
 */

import { base44 } from '@/api/base44Client';

/**
 * Reorder stops for a driver's route on a specific date
 * Sends current local time to backend for accurate ETA calculations
 * @param {string} driverId - The driver's ID
 * @param {string} deliveryDate - The date in yyyy-MM-dd format
 * @param {Array} allDeliveries - All deliveries (to filter by driver/date)
 * @param {string} currentLocalTime - Optional current local time (HH:mm) from client device
 * @returns {Promise<Array>} - The reordered deliveries
 */
export const reorderStops = async (driverId, deliveryDate, allDeliveries, currentLocalTime = null) => {
  console.log('🔄 [Reorder] Starting stop reordering for driver:', driverId, 'date:', deliveryDate);
  
  // Get current local time if not provided
  const localTime = currentLocalTime || (() => {
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
  })();
  
  console.log(`🕐 [Reorder] Using local time: ${localTime}`);
  
  // Filter deliveries for this driver and date
  const driverDeliveries = allDeliveries.filter(d => 
    d && d.driver_id === driverId && d.delivery_date === deliveryDate
  );
  
  if (driverDeliveries.length === 0) {
    console.log('⏭️ [Reorder] No deliveries found for this driver/date');
    return [];
  }
  
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
  
  // Separate finished and incomplete deliveries
  const finishedDeliveries = driverDeliveries.filter(d => finishedStatuses.includes(d.status));
  const incompleteDeliveries = driverDeliveries.filter(d => !finishedStatuses.includes(d.status));
  
  console.log(`📊 [Reorder] Found ${finishedDeliveries.length} finished, ${incompleteDeliveries.length} incomplete`);
  
  // Sort finished by actual_delivery_time (earliest first)
  const sortedFinished = [...finishedDeliveries].sort((a, b) => {
    if (!a.actual_delivery_time || !b.actual_delivery_time) return 0;
    return new Date(a.actual_delivery_time) - new Date(b.actual_delivery_time);
  });
  
  // Sort incomplete by delivery_time_eta
  const sortedIncomplete = [...incompleteDeliveries].sort((a, b) => {
    const etaA = a.delivery_time_eta || a.delivery_time_start || '99:99';
    const etaB = b.delivery_time_eta || b.delivery_time_start || '99:99';
    return etaA.localeCompare(etaB);
  });
  
  // Combine: finished first, then incomplete
  const reorderedDeliveries = [...sortedFinished, ...sortedIncomplete];
  
  console.log('📋 [Reorder] New stop order:');
  reorderedDeliveries.forEach((d, idx) => {
    console.log(`  ${idx + 1}. ${d.patient_name || 'Pickup'} - ${d.status} - ${d.actual_delivery_time ? new Date(d.actual_delivery_time).toLocaleTimeString() : d.delivery_time_eta}`);
  });
  
  // Update stop_order in database (batched to avoid long serial waits)
  const updatesToApply = reorderedDeliveries
    .map((d, idx) => ({ id: d.id, next: idx + 1, current: d.stop_order }))
    .filter(u => u.current !== u.next);

  console.log(`📝 [Reorder] Applying ${updatesToApply.length} stop_order updates`);

  const CONCURRENCY = 10;
  const results = [];
  for (let i = 0; i < updatesToApply.length; i += CONCURRENCY) {
    const chunk = updatesToApply.slice(i, i + CONCURRENCY);
    const promises = chunk.map(u =>
      base44.entities.Delivery.update(u.id, { stop_order: u.next })
        .then(() => ({ id: u.id, ok: true }))
        .catch((e) => ({ id: u.id, ok: false, error: e?.message || String(e) }))
    );
    const settled = await Promise.all(promises);
    results.push(...settled);
  }

  const okCount = results.filter(r => r.ok).length;
  console.log(`✅ [Reorder] Updated ${okCount}/${updatesToApply.length} stop orders`);

  return reorderedDeliveries;
};