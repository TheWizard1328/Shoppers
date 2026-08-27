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

// Safety timeout: if a task hangs (e.g. RAF never fires while backgrounded, an
// awaited import stalls, or a backend call never returns), force-release the lock
// after 120s so the UI recovers instead of spinning forever. The hung task
// continues in the background — we just stop blocking new actions.
const ACTION_LOCK_TIMEOUT_MS = 120000;

export const runWithDeliveryActionLock = async (actionName, task) => {
  const lock = acquireDeliveryActionLock(actionName);
  if (!lock) {
    return {
      skipped: true,
      activeAction: activeDeliveryAction?.actionName || null
    };
  }

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    if (activeDeliveryAction?.token === lock.token) {
      timedOut = true;
      console.error(`⏱️ [deliveryActionLock] "${actionName}" timed out after ${ACTION_LOCK_TIMEOUT_MS / 1000}s — force-releasing lock`);
      releaseDeliveryActionLock(lock);
    }
  }, ACTION_LOCK_TIMEOUT_MS);

  try {
    return await task(lock);
  } finally {
    clearTimeout(timeoutId);
    if (!timedOut) releaseDeliveryActionLock(lock);
  }
};