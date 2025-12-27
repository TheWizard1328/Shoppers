/**
 * Projection Testing Helper
 * 
 * This utility provides debugging and verification functions for the projection system.
 * Use these functions in the browser console to verify projection behavior.
 */

import { base44 } from '@/api/base44Client';

/**
 * Check if projections exist for a specific date and driver
 */
export const checkProjections = async (deliveryDate, driverId = null) => {
  console.log('🔍 Checking projections for:', { deliveryDate, driverId });
  
  const deliveries = await base44.entities.ActiveDeliveries.list();
  
  const projected = deliveries.filter(d => 
    d.delivery_date === deliveryDate &&
    d.is_projected === true &&
    (!driverId || d.driver_id === driverId)
  );
  
  const real = deliveries.filter(d => 
    d.delivery_date === deliveryDate &&
    (!d.is_projected || d.is_projected === false) &&
    (!driverId || d.driver_id === driverId)
  );
  
  console.log('📊 Results:', {
    projectedCount: projected.length,
    realCount: real.length,
    projectedDeliveries: projected.map(d => ({
      id: d.id,
      patient_id: d.patient_id,
      store_id: d.store_id,
      stop_order: d.stop_order,
      tracking_number: d.tracking_number,
      stop_optimized: d.stop_optimized,
      projection_generated_at: d.projection_generated_at
    })),
    realDeliveries: real.map(d => ({
      id: d.id,
      patient_id: d.patient_id,
      stop_order: d.stop_order
    }))
  });
  
  return { projected, real };
};

/**
 * Clear all projections for a specific date
 */
export const clearProjections = async (deliveryDate, driverId = null) => {
  console.log('🗑️ Clearing projections for:', { deliveryDate, driverId });
  
  const deliveries = await base44.entities.ActiveDeliveries.list();
  
  const toDelete = deliveries.filter(d => 
    d.delivery_date === deliveryDate &&
    d.is_projected === true &&
    (!driverId || d.driver_id === driverId)
  );
  
  console.log(`🗑️ Found ${toDelete.length} projected deliveries to delete`);
  
  if (toDelete.length > 0) {
    await Promise.all(toDelete.map(d => base44.entities.ActiveDeliveries.delete(d.id)));
    console.log('✅ Projections cleared');
  } else {
    console.log('ℹ️ No projections to clear');
  }
  
  return toDelete.length;
};

/**
 * Verify projection data integrity
 */
export const verifyProjectionIntegrity = async (deliveryDate, driverId = null) => {
  console.log('🔬 Verifying projection integrity for:', { deliveryDate, driverId });
  
  const { projected } = await checkProjections(deliveryDate, driverId);
  
  const issues = [];
  
  projected.forEach((d, index) => {
    // Check required fields
    if (!d.delivery_date) issues.push(`Delivery ${index + 1} missing delivery_date`);
    if (!d.driver_id) issues.push(`Delivery ${index + 1} missing driver_id`);
    if (!d.driver_name) issues.push(`Delivery ${index + 1} missing driver_name`);
    if (d.is_projected !== true) issues.push(`Delivery ${index + 1} is_projected is not true`);
    if (!d.projection_generated_at) issues.push(`Delivery ${index + 1} missing projection_generated_at`);
    
    // Check optimization fields
    if (!d.stop_optimized) issues.push(`Delivery ${index + 1} not marked as optimized`);
    if (d.stop_order === undefined || d.stop_order === null) issues.push(`Delivery ${index + 1} missing stop_order`);
    if (!d.tracking_number) issues.push(`Delivery ${index + 1} missing tracking_number`);
    
    // Check delivery type consistency
    if (!d.patient_id && !d.store_id) issues.push(`Delivery ${index + 1} missing both patient_id and store_id`);
    if (d.patient_id && !d.store_id) issues.push(`Delivery ${index + 1} has patient_id but missing store_id`);
  });
  
  if (issues.length === 0) {
    console.log('✅ All projections passed integrity checks');
  } else {
    console.warn('⚠️ Found integrity issues:', issues);
  }
  
  return { passed: issues.length === 0, issues };
};

/**
 * Compare projection counts vs expected patterns
 */
export const analyzeProjectionPatterns = async (deliveryDate, driverId) => {
  console.log('📈 Analyzing projection patterns for:', { deliveryDate, driverId });
  
  const { projected } = await checkProjections(deliveryDate, driverId);
  
  const pickups = projected.filter(d => !d.patient_id && d.store_id);
  const deliveries = projected.filter(d => d.patient_id);
  
  const byStore = {};
  pickups.forEach(p => {
    if (!byStore[p.store_id]) {
      byStore[p.store_id] = { pickups: 0, deliveries: 0 };
    }
    byStore[p.store_id].pickups++;
  });
  
  deliveries.forEach(d => {
    if (d.store_id) {
      if (!byStore[d.store_id]) {
        byStore[d.store_id] = { pickups: 0, deliveries: 0 };
      }
      byStore[d.store_id].deliveries++;
    }
  });
  
  console.log('📊 Pattern Analysis:', {
    totalProjected: projected.length,
    pickups: pickups.length,
    deliveries: deliveries.length,
    byStore
  });
  
  return { pickups, deliveries, byStore };
};

// Export for console access
if (typeof window !== 'undefined') {
  window.projectionDebug = {
    checkProjections,
    clearProjections,
    verifyProjectionIntegrity,
    analyzeProjectionPatterns
  };
  console.log('🔧 Projection debug tools loaded. Access via window.projectionDebug');
}