/**
 * User Activity Monitor - Tracks user activity to drive adaptive refresh intervals
 * 
 * Reduces unnecessary polling when user is idle
 * Increases refresh frequency when user is actively using the app
 */

let lastActivityTime = Date.now();
let activityLevel = 'normal'; // 'idle', 'normal', 'active'
let activityListeners = [];

const IDLE_THRESHOLD = 5 * 60 * 1000; // 5 minutes
const ACTIVE_THRESHOLD = 30 * 1000; // 30 seconds

export const userActivityMonitor = {
  /**
   * Record user activity (called on clicks, inputs, etc)
   */
  recordActivity: () => {
    const now = Date.now();
    const timeSinceLastActivity = now - lastActivityTime;
    lastActivityTime = now;

    // Determine activity level
    const wasIdle = activityLevel === 'idle';
    activityLevel = timeSinceLastActivity < ACTIVE_THRESHOLD ? 'active' : 'normal';

    // If transitioning from idle to active, notify listeners
    if (wasIdle && activityLevel !== 'idle') {
      notifyListeners({ level: activityLevel, type: 'resumed' });
    }
  },

  /**
   * Get current activity level
   */
  getActivityLevel: () => activityLevel,

  /**
   * Get time since last activity
   */
  getIdleDuration: () => Date.now() - lastActivityTime,

  /**
   * Check if user is idle
   */
  isIdle: () => (Date.now() - lastActivityTime) > IDLE_THRESHOLD,

  /**
   * Subscribe to activity changes
   */
  subscribe: (callback) => {
    activityListeners.push(callback);
    return () => {
      activityListeners = activityListeners.filter(cb => cb !== callback);
    };
  },

  /**
   * Get adaptive refresh interval based on activity
   * Returns milliseconds between refreshes
   * idle: 5 minutes, normal: 30 seconds, active: 10 seconds
   */
  getAdaptiveInterval: () => {
    if (activityLevel === 'idle') return 5 * 60 * 1000; // 5 minutes
    if (activityLevel === 'active') return 10 * 1000; // 10 seconds
    return 30 * 1000; // 30 seconds (normal)
  },

  /**
   * Reset activity (after refresh or reconnection)
   */
  reset: () => {
    lastActivityTime = Date.now();
    activityLevel = 'normal';
  }
};

// Monitor user activity
const notifyListeners = (state) => {
  activityListeners.forEach(cb => {
    try { cb(state); } catch (e) {}
  });
};

if (typeof window !== 'undefined') {
  // Track clicks, inputs, touches
  document.addEventListener('click', () => userActivityMonitor.recordActivity(), { passive: true });
  document.addEventListener('input', () => userActivityMonitor.recordActivity(), { passive: true });
  document.addEventListener('touchstart', () => userActivityMonitor.recordActivity(), { passive: true });
  document.addEventListener('keydown', () => userActivityMonitor.recordActivity(), { passive: true });
  
  // Monitor page visibility
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      activityLevel = 'idle';
      notifyListeners({ level: 'idle', type: 'hidden' });
    } else {
      userActivityMonitor.recordActivity();
      notifyListeners({ level: activityLevel, type: 'visible' });
    }
  });
}