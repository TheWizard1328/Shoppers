const listeners = new Set();

const DEFAULT_STATE = {
  jobId: null,
  status: 'idle',
  total: 0,
  completed: 0,
  failed: 0,
  pending: 0,
  retriesScheduled: 0,
  currentAttempt: 0,
  startedAt: null,
  finishedAt: null,
  failedIds: [],
  pendingIds: [],
  lastError: null
};

let state = { ...DEFAULT_STATE };

const emit = () => {
  const snapshot = { ...state };
  listeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch {}
  });

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('bulkDeleteJobStateChanged', { detail: snapshot }));
  }
};

export const getBulkDeleteJobState = () => ({ ...state });

export const subscribeBulkDeleteJob = (listener) => {
  listeners.add(listener);
  listener({ ...state });
  return () => listeners.delete(listener);
};

export const startBulkDeleteJob = (deliveryIds = []) => {
  const uniqueIds = Array.from(new Set((deliveryIds || []).filter(Boolean)));
  state = {
    ...DEFAULT_STATE,
    jobId: `bulk-delete-${Date.now()}`,
    status: 'running',
    total: uniqueIds.length,
    pending: uniqueIds.length,
    pendingIds: uniqueIds,
    startedAt: new Date().toISOString(),
    currentAttempt: 1
  };
  emit();
  return state.jobId;
};

export const updateBulkDeleteJobProgress = ({ completedIds = [], failedIds = [], pendingIds = [], attempt = state.currentAttempt, status = state.status, lastError = null, retriesScheduled = state.retriesScheduled } = {}) => {
  const completedSet = new Set(completedIds);
  const failedSet = new Set(failedIds);
  const nextPending = Array.from(new Set((pendingIds || []).filter((id) => !completedSet.has(id))));

  state = {
    ...state,
    status,
    currentAttempt: attempt,
    completed: completedSet.size,
    failed: failedSet.size,
    pending: nextPending.length,
    failedIds: Array.from(failedSet),
    pendingIds: nextPending,
    retriesScheduled,
    lastError
  };
  emit();
};

export const scheduleBulkDeleteRetry = ({ pendingIds = [], attempt = 1, delayMs = 0, lastError = null } = {}) => {
  state = {
    ...state,
    status: 'retrying',
    currentAttempt: attempt,
    pending: pendingIds.length,
    pendingIds: [...pendingIds],
    retriesScheduled: state.retriesScheduled + 1,
    lastError: lastError || (delayMs ? `Retrying in ${Math.round(delayMs / 1000)}s` : state.lastError)
  };
  emit();
};

export const finishBulkDeleteJob = ({ failedIds = [], pendingIds = [] } = {}) => {
  const finalFailed = Array.from(new Set(failedIds));
  const finalPending = Array.from(new Set(pendingIds));
  const completed = Math.max(0, state.total - finalFailed.length - finalPending.length);

  state = {
    ...state,
    status: finalFailed.length === 0 && finalPending.length === 0 ? 'finished' : 'finished_with_errors',
    completed,
    failed: finalFailed.length,
    pending: finalPending.length,
    failedIds: finalFailed,
    pendingIds: finalPending,
    finishedAt: new Date().toISOString()
  };
  emit();
};

export const resetBulkDeleteJob = () => {
  state = { ...DEFAULT_STATE };
  emit();
};

export const isBulkDeleteJobActive = () => state.status === 'running' || state.status === 'retrying';

export const isBulkDeleteJobBlockingRehydration = () => isBulkDeleteJobActive() || state.status === 'finished_with_errors';