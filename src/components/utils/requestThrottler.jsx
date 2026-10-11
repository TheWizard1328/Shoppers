import { connectionMonitor } from './connectionMonitor';

/**
 * Request Throttler/Queue Manager
 *
 * Serializes boot and background requests, applies spacing/backoff, and ensures
 * one black-holed request can never leave the queue permanently stuck.
 */
const THROTTLE_DELAYS = {
  critical: 800,
  priority: 1500,
  standard: 2200,
  background: 3500
};

const BATCH_COOLDOWN = 800;
const REQUEST_TIMEOUT_MS = 15000;
let RATE_LIMIT_BACKOFF_MS = 30000;

let requestQueue = [];
let isProcessing = false;
let lastRequestTime = 0;
let isRateLimited = false;
let rateLimitUntil = 0;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const getDelay = (priority = 'standard') => THROTTLE_DELAYS[priority] || THROTTLE_DELAYS.standard;

const withRequestTimeout = (promise, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      error.code = 'ECONNABORTED';
      reject(error);
    }, REQUEST_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const is429Error = (error) =>
  error?.response?.status === 429 ||
  error?.status === 429 ||
  error?.code === 429 ||
  /429|rate limit/i.test(String(error?.message || ''));

export const requestThrottler = {
  queue: async (fn, priority = 'standard', label = 'request') =>
    new Promise((resolve, reject) => {
      requestQueue.push({
        id: Math.random().toString(36).slice(2, 11),
        fn,
        priority,
        label,
        resolve,
        reject,
        addedAt: Date.now()
      });
      requestThrottler._process();
    }),

  _process: async () => {
    if (isProcessing || requestQueue.length === 0) return;
    isProcessing = true;

    try {
      while (requestQueue.length > 0) {
        if (isRateLimited && Date.now() < rateLimitUntil) {
          await delay(rateLimitUntil - Date.now() + 250);
        }
        if (Date.now() >= rateLimitUntil) isRateLimited = false;

        const priorityOrder = { critical: 0, priority: 1, standard: 2, background: 3 };
        requestQueue.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
        const request = requestQueue.shift();

        const requiredDelay = getDelay(request.priority);
        const waitTime = Math.max(0, requiredDelay - (Date.now() - lastRequestTime));
        if (waitTime > 0) await delay(waitTime);
        lastRequestTime = Date.now();

        const startedAt = Date.now();
        try {
          const result = await withRequestTimeout(Promise.resolve().then(request.fn), request.label);
          connectionMonitor.recordResponseTime(Date.now() - startedAt);
          request.resolve(result);
          RATE_LIMIT_BACKOFF_MS = 30000;
          await delay(BATCH_COOLDOWN);
        } catch (error) {
          if (is429Error(error)) {
            isRateLimited = true;
            rateLimitUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
            RATE_LIMIT_BACKOFF_MS = Math.min(RATE_LIMIT_BACKOFF_MS * 2, 60000);
            connectionMonitor.recordError('rate_limit');
          } else {
            connectionMonitor.recordError(/timeout/i.test(String(error?.message || '')) ? 'timeout' : 'network');
          }
          request.reject(error);
        }
      }
    } finally {
      // Always release the queue, even if queue bookkeeping itself throws.
      isProcessing = false;
      if (requestQueue.length > 0) queueMicrotask(() => requestThrottler._process());
    }
  },

  getStatus: () => ({
    queueLength: requestQueue.length,
    isProcessing,
    isRateLimited,
    rateLimitUntil: isRateLimited ? new Date(rateLimitUntil).toISOString() : null,
    lastRequestTime: lastRequestTime ? new Date(lastRequestTime).toISOString() : null
  }),

  clear: () => {
    const pending = requestQueue;
    requestQueue = [];
    const error = new Error('Request queue cleared');
    error.code = 'QUEUE_CLEARED';
    pending.forEach((request) => request.reject(error));
    return pending.length;
  },

  waitUntilEmpty: async (timeoutMs = 20000) => {
    const startedAt = Date.now();
    while (requestQueue.length > 0 || isProcessing) {
      if (Date.now() - startedAt >= timeoutMs) return false;
      await delay(100);
    }
    return true;
  }
};
