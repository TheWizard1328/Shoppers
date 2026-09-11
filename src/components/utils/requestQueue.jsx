/**
 * Global Request Queue - Stagger all entity fetches to prevent rate limiting
 * All entity.filter() and entity.list() calls should go through this queue
 */

const MIN_REQUEST_INTERVAL = 600; // Minimum 600ms between requests to avoid bursts and 429s
const DEDUP_WINDOW = 500; // Deduplicate identical requests within 500ms window
// Per-request timeout: a black-holed fetch (mobile sleep/wake, Wi-Fi handoff) never
// settles on its own — without this, one hung request at the queue head freezes
// `processing` forever and starves every queued entity fetch (the frozen
// smart-refresh spinner / dead manager bug).
const REQUEST_TIMEOUT_MS = 30000;

class RequestQueue {
  constructor() {
    this.lastRequestTime = 0;
    this.queue = [];
    this.processing = false;
    this.pendingRequests = new Map(); // Key: request hash, Value: { promise, timestamp }
    // Global 429 backoff — when ANY queued request returns 429, pause the entire
    // queue so every caller backs off together instead of each device continuing
    // to hammer the server at 600ms intervals (the root cause of the 429 storm).
    this.rateLimitUntil = 0;
    this.rateLimitBackoffMs = 30000; // 30s initial, escalates to 60s on repeat 429s
  }

  /**
   * Emergency unstick: if `processing` was left true by a path that bypassed the
   * per-request timeout race (should no longer happen, but belt-and-suspenders),
   * reset it and drop stale waits. Called by smartRefreshManager.checkHeartbeatAndSync().
   */
  forceUnstick() {
    if (!this.processing && this.queue.length === 0) return false;
    console.warn(`🔧 [RequestQueue] Force-unsticking queue (${this.queue.length} waiting) — processing was ${this.processing}`);
    this.processing = false;
    this.queue.length = 0; // stale waits are retried by the next refresh cycle
    return true;
  }

  /**
   * Generate a hash key for deduplication
   */
  generateRequestKey(requestName) {
    return `${requestName}`;
  }

  /**
   * Queue a request and wait for appropriate spacing
   */
  async enqueue(requestFn, requestName = 'unknown') {
    const requestKey = this.generateRequestKey(requestName);
    const now = Date.now();

    // Check if we have a pending identical request within dedup window
    if (this.pendingRequests.has(requestKey)) {
      const { promise, timestamp } = this.pendingRequests.get(requestKey);
      if (now - timestamp < DEDUP_WINDOW) {
        console.log(`🔄 [RequestQueue] Deduplicating request: "${requestName}" (merged with pending)`);
        return promise;
      } else {
        // Old pending request timed out, remove it
        this.pendingRequests.delete(requestKey);
      }
    }

    // Create a new promise for this request
    const promise = new Promise((resolve, reject) => {
      this.queue.push({ requestFn, requestName, resolve, reject });
      this.processQueue();
    });

    // Store as pending
    this.pendingRequests.set(requestKey, { promise, timestamp: now });

    // Clean up after dedup window expires
    setTimeout(() => {
      if (this.pendingRequests.get(requestKey)?.timestamp === now) {
        this.pendingRequests.delete(requestKey);
      }
    }, DEDUP_WINDOW);

    return promise;
  }

  /**
   * Process queued requests with spacing
   */
  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const { requestFn, requestName, resolve, reject } = this.queue.shift();

      // GLOBAL 429 BACKOFF: if a recent request was rate-limited, wait until the
      // backoff window expires before firing the next one. This pauses ALL queued
      // callers together so the whole device backs off, not just the one request
      // that got 429'd — preventing the storm where every device keeps hammering
      // at 600ms intervals after the server says "stop".
      const rateWait = this.rateLimitUntil - Date.now();
      if (rateWait > 0) {
        console.warn(`⏰ [RequestQueue] Rate-limited — pausing ${Math.round(rateWait / 1000)}s before "${requestName}"`);
        await new Promise(r => setTimeout(r, rateWait));
      }
      
      // Calculate wait time to maintain spacing
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      const waitTime = Math.max(0, MIN_REQUEST_INTERVAL - timeSinceLastRequest);

      if (waitTime > 0) {
        console.log(`⏳ [RequestQueue] Spacing request "${requestName}" - waiting ${waitTime}ms`);
        await new Promise(r => setTimeout(r, waitTime));
      }

      this.lastRequestTime = Date.now();

      // Declare outside try so the catch block can clear the timeout if the
      // request rejects (otherwise the pending timeout fires as a no-op later).
      let timeoutId;
      try {
        console.log(`📤 [RequestQueue] Executing request: "${requestName}"`);
        // TIMEOUT RACE: never let a hung fetch stall the queue. If the underlying
        // request exceeds REQUEST_TIMEOUT_MS, reject it and move on — the next
        // refresh cycle retries. The abandoned request's late resolve() is a no-op
        // on an already-settled promise.
        const timeoutPromise = new Promise((_, timeoutReject) => {
          timeoutId = setTimeout(
            () => timeoutReject(new Error(`Request "${requestName}" timed out after ${REQUEST_TIMEOUT_MS / 1000}s`)),
            REQUEST_TIMEOUT_MS
          );
        });
        const result = await Promise.race([requestFn(), timeoutPromise]);
        clearTimeout(timeoutId);
        // Success — reset backoff escalation to the floor
        this.rateLimitBackoffMs = 30000;
        resolve(result);
      } catch (error) {
        clearTimeout(timeoutId);
        // 429 detection: detect rate-limit responses from any error shape the SDK
        // throws (response.status, message containing "429"/"Rate limit", or a
        // numeric code). On 429, arm the global backoff window and reject this
        // request — the next iteration of this loop waits for the window to clear.
        const is429 = error?.response?.status === 429 ||
          error?.status === 429 ||
          error?.code === 429 ||
          (error?.message && (/429/.test(error.message) || /rate limit/i.test(error.message)));
        if (is429) {
          this.rateLimitUntil = Date.now() + this.rateLimitBackoffMs;
          // Escalate: 30s → 60s on consecutive 429s
          this.rateLimitBackoffMs = this.rateLimitBackoffMs === 30000 ? 60000 : this.rateLimitBackoffMs;
          console.warn(`⏰ [RequestQueue] 429 on "${requestName}" — backing off ${Math.round(this.rateLimitBackoffMs / 1000)}s (all queued callers paused)`);
        } else {
          console.warn(`❌ [RequestQueue] Request failed: "${requestName}" -`, error?.message || error);
        }
        reject(error);
      }
    }

    this.processing = false;
  }

  /**
   * Check if the queue is currently in a rate-limit backoff window
   */
  isRateLimited() {
    return Date.now() < this.rateLimitUntil;
  }

  /**
   * Get queue length (for debugging)
   */
  getQueueLength() {
    return this.queue.length;
  }

  /**
   * Clear queue (e.g., on rate limit error)
   */
  clear() {
    const cleared = this.queue.length;
    this.queue = [];
    console.log(`🗑️ [RequestQueue] Cleared ${cleared} queued requests`);
    return cleared;
  }
}

export const requestQueue = new RequestQueue();

/**
 * Wrap an entity filter or list call with request queuing
 * Usage: await queueEntityRequest(() => base44.entities.Delivery.filter(...), 'Delivery filter')
 */
export async function queueEntityRequest(requestFn, requestName = 'entity request') {
  return requestQueue.enqueue(requestFn, requestName);
}