/**
 * Global FAB control events for driver status changes
 * Allows DriverStatusToggle to communicate with Dashboard's FAB
 */

const fabControlListeners = new Set();

const isUserControllingMap = () => typeof window !== 'undefined' && (window._userMapControlUntil || 0) > Date.now();
const isUserSwipingStopCards = () => typeof window !== 'undefined' && (window.__suppressCardAutoCenterUntil || 0) > Date.now();

const hasDispatcherActiveStopsForStore = () => {
  if (typeof window === 'undefined') return false;
  const currentUser = window.__currentUserForFAB;
  const deliveries = window.__fabContextDeliveries || [];
  if (!currentUser || !Array.isArray(currentUser.app_roles) || !currentUser.app_roles.includes('dispatcher')) return false;
  const storeIds = Array.isArray(currentUser.store_ids) ? currentUser.store_ids : [];
  if (storeIds.length === 0) return false;
  return deliveries.some((delivery) => delivery && storeIds.includes(delivery.store_id) && delivery.status === 'in_transit');
};

const shouldAllowRefreshDrivenFABReactivation = () => {
  if (typeof window === 'undefined') return false;
  const currentUser = window.__currentUserForFAB;
  const currentPhase = window.__currentMapViewPhase || 1;
  const isLocked = window.__currentMapViewFABLocked === true;

  if (!currentUser || !Array.isArray(currentUser.app_roles)) return false;

  if (currentUser.app_roles.includes('dispatcher')) {
    return hasDispatcherActiveStopsForStore();
  }

  if (currentUser.app_roles.includes('driver')) {
    return (currentPhase === 2 || currentPhase === 3) && !isLocked;
  }

  return false;
};

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
  reactivateFAB: (skipCardScroll = false, options = {}) => {
    if ((isUserControllingMap() || isUserSwipingStopCards()) && !options?.forceWhileUserInteracting) {
      console.log('📢 [FAB Events] Skipping FAB reactivation during active user interaction');
      return;
    }
    console.log('📢 [FAB Events] Broadcasting FAB reactivation, skipCardScroll:', skipCardScroll, 'options:', options);
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'REACTIVATE_FAB', skipCardScroll, ...options });
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
    if (!shouldAllowRefreshDrivenFABReactivation()) {
      console.log('📢 [FAB Events] Skipping data-ready FAB reactivation due to role/phase rules');
      return;
    }
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
   * Notify when Done button is clicked - FAB should activate phase 1 temporarily (3000ms)
   * Called after DeliveryForm Done button saves and closes
   */
  notifyDoneButtonClicked: (duration = 500) => {
    console.log('📢 [FAB Events] Broadcasting done button clicked - activating phase 1 for', duration, 'ms');
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'DONE_BUTTON_CLICKED', duration });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },

  resetToPhaseOneAfterDone: (duration = 500) => {
    console.log('📢 [FAB Events] Broadcasting done reset - unlock + phase 1 for', duration, 'ms');
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'DONE_RESET_TO_PHASE_ONE', duration });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },

  notifyAcceptAllClicked: () => {
    console.log('📢 [FAB Events] Broadcasting accept all clicked - activating phase 1 for 500ms');
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'ACCEPT_ALL_CLICKED' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },

  notifyDeliveryRealtimeCreateOrDelete: (payload = {}) => {
    console.log('📢 [FAB Events] Broadcasting delivery realtime create/delete - pulse only');
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'DELIVERY_REALTIME_CREATE_DELETE_PULSE', ...payload });
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
   * Check if FAB is currently paused
   */
  isPaused: () => {
    return window.__fabIsPaused === true;
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
  },

  reactivatePhaseTwoIfAvailable: () => {
    console.log('📢 [FAB Events] Broadcasting phase 2 reactivation request');
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'REACTIVATE_PHASE_TWO_IF_AVAILABLE' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },

  notifyPhaseTwoCompleteRecenter: () => {
    console.log('📢 [FAB Events] Broadcasting phase 2 complete recenter pulse');
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'PHASE2_COMPLETE_RECENTER' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },
  notifyPhaseTwoTempUnlock: () => {
    console.log('📢 [FAB Events] Broadcasting phase 2 temporary unlock');
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'PHASE2_TEMP_UNLOCK' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },

  notifyDriverSelectionChanged: () => {
    console.log('📢 [FAB Events] Broadcasting driver selection change - activating phase 1');
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'DRIVER_SELECTION_CHANGED' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },

  notifyImmersiveModeToggled: () => {
    console.log('📢 [FAB Events] Broadcasting immersive mode toggle - reactivating FAB');
    fabControlListeners.forEach(callback => {
      try {
        callback({ type: 'IMMERSIVE_MODE_TOGGLED' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  }
  };