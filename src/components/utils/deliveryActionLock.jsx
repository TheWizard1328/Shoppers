let activeDeliveryAction = null;
const listeners = new Set();

const notifyListeners = () => {
  listeners.forEach((listener) => listener(activeDeliveryAction));
};

export const getActiveDeliveryAction = () => activeDeliveryAction;

export const isDeliveryActionLocked = () => activeDeliveryAction !== null;

export const subscribeDeliveryActionLock = (listener) => {
  listeners.add(listener);
  listener(activeDeliveryAction);
  return () => listeners.delete(listener);
};

export const acquireDeliveryActionLock = (actionName) => {
  if (activeDeliveryAction) return null;

  activeDeliveryAction = {
    token: `${actionName}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    actionName,
    startedAt: Date.now()
  };

  notifyListeners();
  return activeDeliveryAction;
};

export const releaseDeliveryActionLock = (lockOrToken) => {
  if (!activeDeliveryAction) return;

  const token = typeof lockOrToken === 'string' ? lockOrToken : lockOrToken?.token;
  if (!token || activeDeliveryAction.token !== token) return;

  activeDeliveryAction = null;
  notifyListeners();
};

export const clearDeliveryActionLock = () => {
  if (!activeDeliveryAction) return;
  activeDeliveryAction = null;
  notifyListeners();
};

export const runWithDeliveryActionLock = async (actionName, task) => {
  const lock = acquireDeliveryActionLock(actionName);
  if (!lock) {
    return {
      skipped: true,
      activeAction: activeDeliveryAction?.actionName || null
    };
  }

  try {
    return await task(lock);
  } finally {
    releaseDeliveryActionLock(lock);
  }
};