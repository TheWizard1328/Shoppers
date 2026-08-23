/**
 * Client-side mutex for syncPendingBreadcrumbs calls.
 *
 * Two callers fire syncPendingBreadcrumbs concurrently:
 *  1. locationBreadcrumbService.jsx — routine 15s GPS sync loop
 *  2. stopCardActionStatusHelpers.js — pre-slice flush on every stop completion
 *
 * Both can read "no existing record" simultaneously and both create(), producing
 * duplicate master breadcrumb records (stop_order = -1). The server-side self-heal
 * only fires on the NEXT sync, so duplicates accumulate faster than they're cleaned.
 *
 * This mutex ensures only ONE syncPendingBreadcrumbs call is in-flight per device
 * at a time. The second caller waits for the first to complete, by which time the
 * server has the updated record — so the second caller reads it and updates
 * instead of creating a duplicate.
 */

let _syncPromise = null;
let _syncCount = 0;

/**
 * Acquire the breadcrumb sync lock. Returns a release function.
 * If a sync is already in progress, waits for it to finish first.
 *
 * @returns {Promise<() => void>} release function to call in finally block
 */
export const acquireBreadcrumbSyncLock = async () => {
  // Wait for any existing sync to complete
  while (_syncPromise) {
    await _syncPromise;
  }

  let resolveRelease;
  _syncPromise = new Promise((resolve) => { resolveRelease = resolve; });
  _syncCount++;

  return () => {
    _syncPromise = null;
    resolveRelease();
  };
};

/**
 * Check if a sync is currently in progress (non-blocking).
 * Useful for logging/diagnostics.
 */
export const isBreadcrumbSyncInProgress = () => _syncPromise !== null;

/**
 * Get total number of syncs that have acquired the lock.
 */
export const getBreadcrumbSyncCount = () => _syncCount;
