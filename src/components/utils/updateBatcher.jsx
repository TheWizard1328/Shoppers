// components/utils/updateBatcher.js
import { smartRefreshManager } from './smartRefreshManager';
import { updateDeliveryLocal } from './offlineMutations';

// Simple in-memory queue for delivery updates
const deliveryQueues = new Map(); // id -> merged patch
let flushTimer = null;
const FLUSH_MS = 150;

export function queueDeliveryUpdate(id, patch) {
  const existing = deliveryQueues.get(id) || {};
  deliveryQueues.set(id, { ...existing, ...patch });
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushQueuedDeliveryUpdates, FLUSH_MS);
}

export async function flushQueuedDeliveryUpdates() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (deliveryQueues.size === 0) return;

  // Pause smart refresh once for the whole batch
  try { smartRefreshManager.pause(); } catch {}

  const entries = Array.from(deliveryQueues.entries());
  deliveryQueues.clear();

  // Perform updates in parallel, skipping smart refresh per call
  await Promise.all(entries.map(([id, patch]) =>
    updateDeliveryLocal(id, patch, { skipSmartRefresh: true, isBatchOperation: true })
  ));

  // Restart smart refresh once after the batch
  try { smartRefreshManager.restart(); } catch {}
}