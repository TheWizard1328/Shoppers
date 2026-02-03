/**
 * Global Request Queue - Stagger all entity fetches to prevent rate limiting
 * All entity.filter() and entity.list() calls should go through this queue
 */

const MIN_REQUEST_INTERVAL = 50; // Minimum 50ms between requests - balanced for offline-first strategy
const DEDUP_WINDOW = 500; // Deduplicate identical requests within 500ms window

class RequestQueue {
  constructor() {
    this.lastRequestTime = 0;
    this.queue = [];
    this.processing = false;
    this.pendingRequests = new Map(); // Key: request hash, Value: { promise, timestamp }
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
      
      // Calculate wait time to maintain spacing
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      const waitTime = Math.max(0, MIN_REQUEST_INTERVAL - timeSinceLastRequest);

      if (waitTime > 0) {
        console.log(`⏳ [RequestQueue] Spacing request "${requestName}" - waiting ${waitTime}ms`);
        await new Promise(r => setTimeout(r, waitTime));
      }

      this.lastRequestTime = Date.now();

      try {
        console.log(`📤 [RequestQueue] Executing request: "${requestName}"`);
        const result = await requestFn();
        resolve(result);
      } catch (error) {
        console.warn(`❌ [RequestQueue] Request failed: "${requestName}" -`, error.message);
        reject(error);
      }
    }

    this.processing = false;
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