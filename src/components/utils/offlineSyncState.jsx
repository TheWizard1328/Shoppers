let syncInProgress = false;
let syncPaused = false;
let syncPauseReasons = new Set();
let syncListeners = [];
let lastBackgroundSyncAt = 0;

export const getSyncInProgress = () => syncInProgress;
export const setSyncInProgress = (value) => {
  syncInProgress = value;
};

export const getSyncPaused = () => syncPaused;
export const setSyncPaused = (value) => {
  syncPaused = value;
};

export const getSyncPauseReasons = () => syncPauseReasons;
export const getLastBackgroundSyncAt = () => lastBackgroundSyncAt;
export const setLastBackgroundSyncAt = (value) => {
  lastBackgroundSyncAt = value;
};

export const addSyncPauseReason = (reason) => {
  syncPauseReasons.add(reason);
};

export const removeSyncPauseReason = (reason) => {
  syncPauseReasons.delete(reason);
};

export const getSyncListeners = () => syncListeners;
export const setSyncListeners = (value) => {
  syncListeners = value;
};