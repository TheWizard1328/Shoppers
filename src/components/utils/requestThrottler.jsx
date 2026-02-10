/**
 * Request Throttler/Queue Manager
 * 
 * Prevents API rate limits by:
 * 1. Queuing requests instead of firing them all at once
 * 2. Spacing out requests by type (critical vs non-critical)
 * 3. Adding intelligent delays between batches
 * 4. Respecting rate limit backoff windows
 */

const THROTTLE_DELAYS = {
  critical: 500,      // Critical requests (user, auth) - short delay
  priority: 2000,     // Priority data (AppUsers, deliveries) - medium delay
  standard: 3000,     // Standard requests (patients, stats) - longer delay
  background: 5000    // Background syncs - longest delay
};

const BATCH_COOLDOWN = 1000; // Delay between different batch types
const RATE_LIMIT_BACKOFF = 60000; // 60 seconds when rate limited

let requestQueue = [];
let isProcessing = false;
let lastRequestTime = 0;
let isRateLimited = false;
let rateLimitUntil = 0;

const getDelay = (priority = 'standard') => {
  return THROTTLE_DELAYS[priority] || THROTTLE_DELAYS.standard;
};

export const requestThrottler = {
  /**
   * Queue a request with specified priority
   * @param {Function} fn - Async function to execute
   * @param {string} priority - One of: 'critical', 'priority', 'standard', 'background'
   * @param {string} label - Label for logging
   * @returns {Promise}
   */
  queue: async (fn, priority = 'standard', label = 'request') => {
    return new Promise((resolve, reject) => {
      const requestId = Math.random().toString(36).substr(2, 9);
      
      requestQueue.push({
        id: requestId,
        fn,
        priority,
        label,
        resolve,
        reject,
        addedAt: Date.now()
      });
      
      console.log(`📋 [RequestThrottler] Queued ${priority} request (${label}) - Queue: ${requestQueue.length}`);
      
      // Start processing if not already
      requestThrottler._process();
    });
  },

  /**
   * Process the request queue
   */
  _process: async () => {
    if (isProcessing || requestQueue.length === 0) return;
    
    isProcessing = true;
    
    while (requestQueue.length > 0) {
      // Wait if rate limited
      if (isRateLimited && Date.now() < rateLimitUntil) {
        const waitTime = rateLimitUntil - Date.now();
        console.warn(`⏰ [RequestThrottler] Rate limited - waiting ${(waitTime / 1000).toFixed(1)}s`);
        await new Promise(r => setTimeout(r, Math.min(waitTime + 1000, RATE_LIMIT_BACKOFF)));
        isRateLimited = false;
      }
      
      // Sort by priority (critical first, background last)
      const priorityOrder = { critical: 0, priority: 1, standard: 2, background: 3 };
      requestQueue.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
      
      const request = requestQueue.shift();
      const now = Date.now();
      const timeSinceLastRequest = now - lastRequestTime;
      const requiredDelay = getDelay(request.priority);
      
      // Wait if needed
      if (timeSinceLastRequest < requiredDelay) {
        const waitTime = requiredDelay - timeSinceLastRequest;
        console.log(`⏳ [RequestThrottler] Waiting ${(waitTime / 1000).toFixed(1)}s before ${request.label}`);
        await new Promise(r => setTimeout(r, waitTime));
      }
      
      lastRequestTime = Date.now();
      
      try {
        console.log(`🚀 [RequestThrottler] Executing ${request.priority} request (${request.label})`);
        const result = await request.fn();
        request.resolve(result);
        
        // Small delay between requests in same priority
        await new Promise(r => setTimeout(r, BATCH_COOLDOWN));
      } catch (error) {
        // Check if rate limited
        if (error.response?.status === 429 || error.message?.includes('Rate limit')) {
          isRateLimited = true;
          rateLimitUntil = Date.now() + RATE_LIMIT_BACKOFF;
          console.warn(`⚠️ [RequestThrottler] Rate limit detected - backing off for ${RATE_LIMIT_BACKOFF / 1000}s`);
          
          // Re-queue the request
          requestQueue.unshift(request);
        } else {
          request.reject(error);
        }
      }
    }
    
    isProcessing = false;
  },

  /**
   * Get queue status
   */
  getStatus: () => ({
    queueLength: requestQueue.length,
    isProcessing,
    isRateLimited,
    rateLimitUntil: isRateLimited ? new Date(rateLimitUntil).toISOString() : null,
    lastRequestTime: new Date(lastRequestTime).toISOString()
  }),

  /**
   * Clear the queue (use with caution)
   */
  clear: () => {
    const cleared = requestQueue.length;
    requestQueue = [];
    console.warn(`⚠️ [RequestThrottler] Cleared ${cleared} queued requests`);
    return cleared;
  },

  /**
   * Wait for queue to empty
   */
  waitUntilEmpty: async () => {
    while (requestQueue.length > 0 || isProcessing) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
};