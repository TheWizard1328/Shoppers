/**
 * Adaptive Smart Refresh Manager - Uses user activity to adjust refresh intervals
 * 
 * Replaces fixed intervals with adaptive ones based on user activity
 * Reduces polling when idle, increases when active
 */

import { userActivityMonitor } from './userActivityMonitor';
import { smartRefreshManager } from './smartRefreshManager';

let adaptiveIntervalMultiplier = 1;
let lastActivityCheckTime = Date.now();
let baseIntervals = {
  driverLocation: 15000,
  activeDeliveries: 15000,
  appUsers: 15000,
  patients: 60000,
  stores: 120000
};

export const adaptiveSmartRefreshManager = {
  /**
   * Initialize adaptive refresh with activity monitoring
   */
  initialize: () => {
    // Subscribe to activity changes
    userActivityMonitor.subscribe((state) => {
      console.log(`📊 [AdaptiveSmartRefresh] Activity changed: ${state.level} (${state.type})`);
      adaptiveSmartRefreshManager._updateIntervals();
    });
    
    // Update intervals every 30 seconds based on activity
    setInterval(() => {
      adaptiveSmartRefreshManager._updateIntervals();
    }, 30000);
    
    console.log('✅ [AdaptiveSmartRefresh] Initialized with activity monitoring');
  },

  /**
   * Update refresh intervals based on current activity level
   */
  _updateIntervals: () => {
    const activityLevel = userActivityMonitor.getActivityLevel();
    const isIdle = userActivityMonitor.isIdle();
    
    // Calculate multiplier based on activity
    let newMultiplier = 1;
    if (isIdle) {
      newMultiplier = 5; // 5x slower when idle
    } else if (activityLevel === 'active') {
      newMultiplier = 0.5; // 2x faster when active
    } else {
      newMultiplier = 1; // Normal speed
    }
    
    // Only update if multiplier changed
    if (newMultiplier !== adaptiveIntervalMultiplier) {
      adaptiveIntervalMultiplier = newMultiplier;
      console.log(`⏱️ [AdaptiveSmartRefresh] Updated multiplier: ${newMultiplier}x (activity: ${activityLevel}, idle: ${isIdle})`);
    }
  },

  /**
   * Get effective interval for an entity considering activity
   */
  getEffectiveInterval: (entityName) => {
    const baseInterval = baseIntervals[entityName] || 30000;
    return Math.ceil(baseInterval * adaptiveIntervalMultiplier);
  },

  /**
   * Get current multiplier
   */
  getMultiplier: () => adaptiveIntervalMultiplier,

  /**
   * Get activity-aware refresh status
   */
  getStatus: () => ({
    multiplier: adaptiveIntervalMultiplier,
    activityLevel: userActivityMonitor.getActivityLevel(),
    isIdle: userActivityMonitor.isIdle(),
    idleDuration: userActivityMonitor.getIdleDuration(),
    intervals: Object.entries(baseIntervals).reduce((acc, [key, value]) => {
      acc[key] = adaptiveSmartRefreshManager.getEffectiveInterval(key);
      return acc;
    }, {})
  })
};

// Auto-initialize when imported
if (typeof window !== 'undefined') {
  adaptiveSmartRefreshManager.initialize();
}