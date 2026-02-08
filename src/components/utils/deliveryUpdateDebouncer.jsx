/**
 * Delivery Update Debouncer
 * 
 * Batches rapid delivery update events and deduplicates API calls
 * to prevent rate limit hammering when multiple deliveries update simultaneously.
 * 
 * Also respects smart refresh rate limiting to avoid conflicts.
 */

import { base44 } from '@/api/base44Client';

class DeliveryUpdateDebouncer {
  constructor() {
    this.pendingUpdates = new Map(); // dateStr -> Set of delivery IDs
    this.debounceTimer = null;
    this.debounceDelay = 1500; // Wait 1.5s for more updates to batch
    this.lastUpdateTime = 0;
    this.minTimeBetweenUpdates = 5000; // Don't fetch same date more than once per 5s
    this.isProcessing = false;
    this.smartRefreshMgr = null;
  }

  /**
   * Set reference to smart refresh manager for rate limit checking
   */
  setSmartRefreshManager(manager) {
    this.smartRefreshMgr = manager;
  }

  /**
   * Queue a delivery update event for batched processing
   */
  queueUpdate(dateStr, deliveryId) {
    if (!dateStr || !deliveryId) return;

    // Add to pending batch
    if (!this.pendingUpdates.has(dateStr)) {
      this.pendingUpdates.set(dateStr, new Set());
    }
    this.pendingUpdates.get(dateStr).add(deliveryId);

    // Reset debounce timer
    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    // Debounce the fetch
    this.debounceTimer = setTimeout(() => {
      this.processPendingUpdates();
    }, this.debounceDelay);
  }

  /**
   * Process all batched updates at once
   */
  async processPendingUpdates() {
    if (this.isProcessing || this.pendingUpdates.size === 0) return;

    this.isProcessing = true;

    try {
      // CRITICAL: Check if smart refresh is rate limited
      if (this.smartRefreshMgr && this.smartRefreshMgr.errorCooldownUntil > Date.now()) {
        console.log('⏸️ [DeliveryDebouncer] Smart refresh in cooldown - delaying updates');
        this.debounceTimer = setTimeout(() => this.processPendingUpdates(), 5000);
        return;
      }

      // CRITICAL: Wait for smart refresh rate limit
      if (this.smartRefreshMgr) {
        await this.smartRefreshMgr.waitForRateLimit();
      }

      // Process each date's updates
      for (const [dateStr, deliveryIds] of this.pendingUpdates.entries()) {
        try {
          // Check if we updated this date recently
          const lastUpdate = this.lastUpdateTime;
          if (Date.now() - lastUpdate < this.minTimeBetweenUpdates) {
            console.log(`⏭️ [DeliveryDebouncer] Skipping ${dateStr} - fetched too recently`);
            continue;
          }

          console.log(
            `🔄 [DeliveryDebouncer] Fetching ${dateStr} (${deliveryIds.size} delivery IDs batched)`
          );

          // Fetch fresh deliveries for this date
          const freshDeliveries = await base44.entities.Delivery.filter({
            delivery_date: dateStr,
          });

          if (freshDeliveries && freshDeliveries.length > 0) {
            console.log(
              `✅ [DeliveryDebouncer] Fetched ${freshDeliveries.length} deliveries for ${dateStr}`
            );

            // Dispatch event for consumers to handle the update
            window.dispatchEvent(
              new CustomEvent('deliveriesRefreshedFromRealtime', {
                detail: { date: dateStr, deliveries: freshDeliveries },
              })
            );
          }

          this.lastUpdateTime = Date.now();

          // Rate limit between date fetches
          await new Promise((r) => setTimeout(r, 1000));
        } catch (error) {
          console.warn(`⚠️ [DeliveryDebouncer] Failed to fetch ${dateStr}:`, error.message);

          // Track error for smart refresh
          if (this.smartRefreshMgr) {
            this.smartRefreshMgr.recordError();
            this.smartRefreshMgr.recordConnectionError(error);
          }
        }
      }

      // Clear pending updates after processing
      this.pendingUpdates.clear();
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Clear all pending updates (e.g., after manual refresh)
   */
  clear() {
    this.pendingUpdates.clear();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
  }

  /**
   * Get current pending update count
   */
  getPendingCount() {
    let total = 0;
    for (const dateSet of this.pendingUpdates.values()) {
      total += dateSet.size;
    }
    return total;
  }
}

export const deliveryUpdateDebouncer = new DeliveryUpdateDebouncer();