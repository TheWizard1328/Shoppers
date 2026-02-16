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
   * @param {boolean} skipCardScroll - If true, skip scrolling to next card (already handled)
   */
  reactivateFAB: (skipCardScroll = false) => {
    console.log('📢 [FAB Events] Broadcasting FAB reactivation, skipCardScroll:', skipCardScroll);
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'REACTIVATE_FAB', skipCardScroll });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },

  /**
   * Notify when route data has fully loaded/changed - FAB should reactivate current phase
   * Called after background data loads, date changes, or driver changes complete
   */
  notifyDataReady: () => {
    console.log('📢 [FAB Events] Broadcasting data ready - reactivating current FAB phase');
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'DATA_READY' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },

  /**
   * Notify when Done button is clicked - FAB should activate phase 1 temporarily (500ms)
   * Called after DeliveryForm Done button saves and closes
   */
  notifyDoneButtonClicked: () => {
    console.log('📢 [FAB Events] Broadcasting done button clicked - activating phase 1 for 500ms');
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'DONE_BUTTON_CLICKED' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },

  /**
   * Pause FAB updates during form operations
   */
  pauseFAB: () => {
    console.log('📢 [FAB Events] Broadcasting FAB pause');
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'PAUSE_FAB' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },

  /**
    * Resume FAB updates after form operations
    */
  resumeFAB: () => {
    console.log('📢 [FAB Events] Broadcasting FAB resume');
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'RESUME_FAB' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },

  /**
   * Notify when driver location changes - FAB phase 1 should flash for 500ms
   * Called when a driver location marker moves or location sharing state changes
   */
  notifyDriverLocationChange: () => {
    console.log('📢 [FAB Events] Broadcasting driver location change - reactivating phase 1 for 500ms');
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'DRIVER_LOCATION_CHANGE' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  }
  };