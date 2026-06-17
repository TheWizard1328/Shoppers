/**
 * GPS Event Signaler - Triggers immediate GPS updates on delivery lifecycle events
 * Works in conjunction with locationTracker to ensure GPS is updated when:
 * - Stop is marked complete/failed/cancelled
 * - Driver status changes (on/off duty, break)
 * - Location sharing is toggled
 */

export const signalGPSUpdateForStopEvent = (eventType = 'completion') => {
  try {
    // Dynamically import to avoid circular dependencies
    import('./locationTracker').then(({ locationTracker }) => {
      if (locationTracker && typeof locationTracker.signalStopEvent === 'function') {
        locationTracker.signalStopEvent(eventType);
        console.log(`📍 [GPSEventSignaler] Signaled stop ${eventType} event to location tracker`);
      }
    }).catch(e => {
      console.warn('⚠️ [GPSEventSignaler] Failed to import locationTracker:', e.message);
    });
  } catch (error) {
    console.warn('⚠️ [GPSEventSignaler] Error signaling stop event:', error.message);
  }
};

export const signalGPSUpdateForStatusChange = (status) => {
  try {
    import('./locationTracker').then(({ locationTracker }) => {
      if (locationTracker && typeof locationTracker.setDriverStatus === 'function') {
        locationTracker.setDriverStatus(status);
        console.log(`📍 [GPSEventSignaler] Signaled status change to ${status}`);
      }
    }).catch(e => {
      console.warn('⚠️ [GPSEventSignaler] Failed to import locationTracker:', e.message);
    });
  } catch (error) {
    console.warn('⚠️ [GPSEventSignaler] Error signaling status change:', error.message);
  }
};

export const signalGPSUpdateForLocationSharingToggle = (enabled) => {
  try {
    import('./locationTracker').then(({ locationTracker }) => {
      if (locationTracker && typeof locationTracker.signalLocationSharingToggle === 'function') {
        locationTracker.signalLocationSharingToggle(enabled);
        console.log(`📍 [GPSEventSignaler] Signaled location sharing toggle: ${enabled}`);
      }
    }).catch(e => {
      console.warn('⚠️ [GPSEventSignaler] Failed to import locationTracker:', e.message);
    });
  } catch (error) {
    console.warn('⚠️ [GPSEventSignaler] Error signaling sharing toggle:', error.message);
  }
};