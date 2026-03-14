/**
 * Global FAB control events for driver status changes
 * Allows DriverStatusToggle to communicate with Dashboard's FAB
 */

const fabControlListeners = new Set();

export const fabControlEvents = {
  subscribe: (callback) => {
    fabControlListeners.add(callback);
    return () => fabControlListeners.delete(callback);
  },
  notifyBreakStart: (currentPhase) => {
    console.log('📢 [FAB Events] Broadcasting break start, previous phase:', currentPhase);
    fabControlListeners.forEach((callback) => {
      try {
        callback({ type: 'BREAK_START', previousPhase: currentPhase });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },
  notifyBreakEnd: (phaseToRestore) => {
    console.log('📢 [FAB Events] Broadcasting break end, restoring phase:', phaseToRestore);
    fabControlListeners.forEach((callback) => {
      try {
        callback({ type: 'BREAK_END', phaseToRestore });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },
  deactivateFAB: () => {
    console.log('📢 [FAB Events] Broadcasting FAB deactivation');
    fabControlListeners.forEach((callback) => {
      try {
        callback({ type: 'DEACTIVATE_FAB' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },
  reactivateFAB: (skipCardScroll = false) => {
    console.log('📢 [FAB Events] Broadcasting FAB reactivation, skipCardScroll:', skipCardScroll);
    fabControlListeners.forEach((callback) => {
      try {
        callback({ type: 'REACTIVATE_FAB', skipCardScroll });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },
  notifyDataReady: () => {
    console.log('📢 [FAB Events] Broadcasting data ready - reactivating current FAB phase');
    fabControlListeners.forEach((callback) => {
      try {
        callback({ type: 'DATA_READY' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },
  notifyDoneButtonClicked: () => {
    console.log('📢 [FAB Events] Broadcasting done button clicked - activating phase 1 for 500ms');
    fabControlListeners.forEach((callback) => {
      try {
        callback({ type: 'DONE_BUTTON_CLICKED' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },
  pauseFAB: () => {
    console.log('📢 [FAB Events] Broadcasting FAB pause');
    fabControlListeners.forEach((callback) => {
      try {
        callback({ type: 'PAUSE_FAB' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },
  resumeFAB: () => {
    console.log('📢 [FAB Events] Broadcasting FAB resume');
    fabControlListeners.forEach((callback) => {
      try {
        callback({ type: 'RESUME_FAB' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },
  isPaused: () => window.__fabIsPaused === true,
  notifyDriverLocationChange: () => {
    console.log('📢 [FAB Events] Broadcasting driver location change - reactivating phase 1 for 500ms');
    fabControlListeners.forEach((callback) => {
      try {
        callback({ type: 'DRIVER_LOCATION_CHANGE' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  },
  reactivatePhaseTwoIfAvailable: () => {
    console.log('📢 [FAB Events] Broadcasting phase 2 reactivation request');
    fabControlListeners.forEach((callback) => {
      try {
        callback({ type: 'REACTIVATE_PHASE_TWO_IF_AVAILABLE' });
      } catch (error) {
        console.error('Error in FAB event listener:', error);
      }
    });
  }
};

export default fabControlEvents;