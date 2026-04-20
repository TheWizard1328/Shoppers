let offlineDBLoadComplete = false;

export const markOfflineDBLoadComplete = () => {
  offlineDBLoadComplete = true;
};

export const isOfflineDBLoadComplete = () => {
  return offlineDBLoadComplete;
};