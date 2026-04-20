/**
 * Real-Time Route Optimizer
 * 
 * Handles automatic route optimization triggers:
 * - When driver goes on duty
 * - When a delivery is completed
 * - When new deliveries are assigned
 */

import { format } from 'date-fns';
import { isMobileDevice } from './deviceUtils';
import { shouldRunRouteDeviationCheck } from './etaRefreshRules';
import { fullRouteOptimizer } from '@/functions/fullRouteOptimizer';

// Debounce optimization calls to prevent rapid-fire triggers
let optimizationTimeout = null;
let lastOptimizationTime = 0;
const OPTIMIZATION_COOLDOWN = 60000; // 1 minute between route deviation checks
const optimizationInFlight = new Map();

/**
 * Trigger AI-powered route optimization
 * CRITICAL: Only runs on mobile devices OR when forceFromDesktop=true (admin action)
 * This prevents multiple devices from constantly re-optimizing the same route
 * 
 * @param {Object} params
 * @param {string} params.driverId - Driver's user ID
 * @param {string} params.deliveryDate - Date in yyyy-MM-dd format
 * @param {Object} params.currentLocation - {latitude, longitude}
 * @param {string} params.trigger - 'on_duty' | 'delivery_complete' | 'new_assignment' | 'manual'
 * @param {string} params.completedDeliveryId - ID of completed delivery (if applicable)
 * @param {Function} params.onSuccess - Callback with optimization result
 * @param {Function} params.onNotification - Callback to show notification
 * @param {boolean} params.forceFromDesktop - Allow optimization from desktop (admin override)
 */
export const triggerRouteOptimization = async ({
  driverId,
  deliveryDate,
  currentLocation,
  trigger = 'manual',
  completedDeliveryId = null,
  onSuccess = null,
  onNotification = null,
  forceFromDesktop = false
}) => {
  // CRITICAL: Only allow optimization from mobile devices unless explicitly forced
  // This prevents desktop viewers from triggering optimizations that affect the driver's route
  if (!isMobileDevice() && !forceFromDesktop) {
    console.log('🚫 [RouteOptimizer] Skipping - only mobile devices can trigger route optimization');
    console.log('   (Desktop users can view routes but not auto-optimize them)');
    return null;
  }
  
  // Check cooldown
  const now = Date.now();
  if (!shouldRunRouteDeviationCheck({ driverId, deliveryDate: deliveryDate || format(new Date(), 'yyyy-MM-dd'), now })) {
    console.log('⏳ [RouteOptimizer] Route deviation check throttled');
    return null;
  }
  if (now - lastOptimizationTime < OPTIMIZATION_COOLDOWN) {
    console.log('⏳ [RouteOptimizer] Optimization cooldown - skipping');
    return null;
  }
  
  // Clear any pending optimization
  if (optimizationTimeout) {
    clearTimeout(optimizationTimeout);
  }
  
  console.log(`🚀 [RouteOptimizer] Triggering optimization (${trigger}) from ${isMobileDevice() ? 'MOBILE' : 'DESKTOP (forced)'}`);
  
  const requestKey = `${driverId}:${deliveryDate || format(new Date(), 'yyyy-MM-dd')}`;
  if (optimizationInFlight.has(requestKey)) {
    console.log('⏳ [RouteOptimizer] Reusing in-flight optimization request');
    return optimizationInFlight.get(requestKey);
  }
  
  try {
    lastOptimizationTime = now;
    
    const requestPromise = fullRouteOptimizer({
      driverId,
      deliveryDate: deliveryDate || format(new Date(), 'yyyy-MM-dd'),
      currentLocation
    });
    optimizationInFlight.set(requestKey, requestPromise);
    const response = await requestPromise;
    
    if (response?.success || response?.data?.success) {
      const data = response?.data || response;
      console.log('✅ [RouteOptimizer] Optimization complete:', {
        stops: data.optimizedRoute?.length || 0
      });
      
      // Call success callback
      if (onSuccess) {
        onSuccess(data);
      }
      
      return data;
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
 * CRITICAL: Also respects mobile-only restriction
 */
export const debouncedOptimization = (params, delay = 1000) => {
  // Check mobile restriction early to avoid scheduling unnecessary timeouts
  if (!isMobileDevice() && !params.forceFromDesktop) {
    console.log('🚫 [RouteOptimizer] Debounced optimization skipped - desktop device');
    return;
  }
  
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