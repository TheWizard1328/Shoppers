/**
 * Request Coordinator - Deduplicates and batches API requests
 * Prevents duplicate requests and rate limiting from concurrent calls
 */

class RequestCoordinator {
  constructor() {
    this.pendingRequests = new Map(); // key -> Promise
    this.requestQueue = [];
    this.isProcessing = false;
    this.minDelayMs = 50; // Minimum delay between requests
    this.lastRequestTime = 0;
  }

  /**
   * Deduplicated entity fetch - returns same promise if already in flight
   */
  async fetchEntity(entityName, filter, sort, limit) {
    const key = this._createKey(entityName, filter, sort, limit);
    
    // Return existing pending request if available
    if (this.pendingRequests.has(key)) {
      return this.pendingRequests.get(key);
    }

    // Queue new request
    const promise = this._queueRequest(async () => {
      try {
        const { base44 } = await import('@/api/base44Client');
        const result = await base44.entities[entityName].filter(filter, sort, limit);
        return result;
      } finally {
        this.pendingRequests.delete(key);
      }
    });

    this.pendingRequests.set(key, promise);
    return promise;
  }

  /**
   * Queue a request with rate limit protection
   */
  async _queueRequest(fn) {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ fn, resolve, reject });
      this._processQueue();
    });
  }

  /**
   * Process queued requests sequentially with delays
   */
  async _processQueue() {
    if (this.isProcessing || this.requestQueue.length === 0) return;

    this.isProcessing = true;

    while (this.requestQueue.length > 0) {
      const { fn, resolve, reject } = this.requestQueue.shift();

      // Enforce minimum delay between requests
      const timeSinceLastRequest = Date.now() - this.lastRequestTime;
      if (timeSinceLastRequest < this.minDelayMs) {
        await new Promise(r => setTimeout(r, this.minDelayMs - timeSinceLastRequest));
      }

      try {
        this.lastRequestTime = Date.now();
        const result = await fn();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    }

    this.isProcessing = false;
  }

  /**
   * Create cache key for request
   */
  _createKey(entityName, filter, sort, limit) {
    return `${entityName}:${JSON.stringify(filter || {})}:${sort || ''}:${limit || ''}`;
  }

  /**
   * Clear pending requests (e.g., on error recovery)
   */
  clearPending() {
    this.pendingRequests.clear();
    this.requestQueue = [];
  }
}

export const requestCoordinator = new RequestCoordinator();