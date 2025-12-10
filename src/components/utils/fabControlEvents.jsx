/**
 * Global FAB control events for driver status changes
 * Allows DriverStatusToggle to communicate with Dashboard's FAB
 */

const fabControlListeners = new Set();

export const fabControlEvents = {
  /**
   * Subscribe to FAB control events
   * @param {Function} callback - Called with event data
   * @returns {Function} Unsubscribe function
   */
  subscribe: (callback) => {
    fabControlListeners.add(callback);
    return () => fabControlListeners.delete(callback);
  },
  
  /**
   * Notify when driver goes on break - FAB should unlock and zoom to phase 1
   * @param {number} currentPhase - The phase that was active before break
   */
  notifyBreakStart: (currentPhase) => {
    console.log('📢 [FAB Events] Broadcasting break start, previous phase:', currentPhase);
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'BREAK_START', previousPhase: currentPhase });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },
  
  /**
   * Notify when driver returns from break - FAB should restore previous phase
   * @param {number} phaseToRestore - The phase to restore
   */
  notifyBreakEnd: (phaseToRestore) => {
    console.log('📢 [FAB Events] Broadcasting break end, restoring phase:', phaseToRestore);
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'BREAK_END', phaseToRestore });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },

  /**
   * Deactivate FAB and store current phase (for button actions)
   */
  deactivateFAB: () => {
    console.log('📢 [FAB Events] Broadcasting FAB deactivation');
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'DEACTIVATE_FAB' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },

  /**
   * Reactivate FAB and restore previous phase (after button action completes)
   */
  reactivateFAB: () => {
    console.log('📢 [FAB Events] Broadcasting FAB reactivation');
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'REACTIVATE_FAB' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  }
};