import {
  addSyncPauseReason,
  removeSyncPauseReason,
  getSyncPaused,
  setSyncPaused,
  getSyncPauseReasons,
  getSyncListeners,
  setSyncListeners
} from './offlineSyncState';

export const pauseOfflineSync = (reason = 'general') => {
  addSyncPauseReason(reason);
  setSyncPaused(true);
};

export const resumeOfflineSync = (reason = 'general') => {
  removeSyncPauseReason(reason);
  setSyncPaused(getSyncPauseReasons().size > 0);

  if (!getSyncPaused() && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('offlineSyncResumed'));
  }
};

export const isOfflineSyncPaused = () => getSyncPaused();

export const subscribeSyncStatus = (callback) => {
  setSyncListeners([...getSyncListeners(), callback]);
  return () => {
    setSyncListeners(getSyncListeners().filter(cb => cb !== callback));
  };
};

export const notifySyncStatus = (status) => {
  getSyncListeners().forEach(callback => {
    try { callback(status); } catch (e) {}
  });
};