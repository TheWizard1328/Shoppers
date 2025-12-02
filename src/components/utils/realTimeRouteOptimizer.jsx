/**
 * Real-Time Route Optimizer
 * 
 * Handles automatic route optimization triggers:
 * - When driver goes on duty
 * - When a delivery is completed
 * - When new deliveries are assigned
 */

import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';

// Debounce optimization calls to prevent rapid-fire triggers
let optimizationTimeout = null;
let lastOptimizationTime = 0;
const OPTIMIZATION_COOLDOWN = 5000; // 5 seconds between optimizations

/**
 * Trigger AI-powered route optimization
 * @param {Object} params
 * @param {string} params.driverId - Driver's user ID
 * @param {string} params.deliveryDate - Date in yyyy-MM-dd format
 * @param {Object} params.currentLocation - {latitude, longitude}
 * @param {string} params.trigger - 'on_duty' | 'delivery_complete' | 'new_assignment' | 'manual'
 * @param {string} params.completedDeliveryId - ID of completed delivery (if applicable)
 * @param {Function} params.onSuccess - Callback with optimization result
 * @param {Function} params.onNotification - Callback to show notification
 */
export const triggerRouteOptimization = async ({
  driverId,
  deliveryDate,
  currentLocation,
  trigger = 'manual',
  completedDeliveryId = null,
  onSuccess = null,
  onNotification = null
}) => {
  // Check cooldown
  const now = Date.now();
  if (now - lastOptimizationTime < OPTIMIZATION_COOLDOWN) {
    console.log('⏳ [RouteOptimizer] Optimization cooldown - skipping');
    return null;
  }
  
  // Clear any pending optimization
  if (optimizationTimeout) {
    clearTimeout(optimizationTimeout);
  }
  
  console.log(`🚀 [RouteOptimizer] Triggering optimization (${trigger})`);
  
  try {
    lastOptimizationTime = now;
    
    const response = await base44.functions.invoke('aiRouteOptimizer', {
      driverId,
      deliveryDate: deliveryDate || format(new Date(), 'yyyy-MM-dd'),
      currentLocation,
      trigger,
      completedDeliveryId,
      enableAIAnalysis: true
    });
    
    if (response?.success) {
      console.log('✅ [RouteOptimizer] Optimization complete:', {
        stops: response.updates?.length || 0,
        traffic: response.trafficConditions,
        polyline: response.polylineGenerated
      });
      
      // Show notification if callback provided
      if (onNotification && response.notification) {
        onNotification(response.notification);
      }
      
      // Call success callback
      if (onSuccess) {
        onSuccess(response);
      }
      
      return response;
    } else {
      console.warn('⚠️ [RouteOptimizer] Optimization returned no success:', response);
      return null;
    }
  } catch (error) {
    console.error('❌ [RouteOptimizer] Optimization failed:', error);
    return null;
  }
};

/**
 * Debounced optimization - waits for activity to settle before optimizing
 * Good for batch updates (e.g., multiple status changes)
 */
export const debouncedOptimization = (params, delay = 1000) => {
  if (optimizationTimeout) {
    clearTimeout(optimizationTimeout);
  }
  
  optimizationTimeout = setTimeout(() => {
    triggerRouteOptimization(params);
  }, delay);
};

/**
 * Hook for components to access optimization
 */
export const useRouteOptimizer = () => {
  return {
    optimize: triggerRouteOptimization,
    optimizeDebounced: debouncedOptimization
  };
};