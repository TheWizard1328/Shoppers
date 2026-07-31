/**
 * Delivery WebSocket Reconciler - Backup safety mechanism
 * When WebSocket receives a delivery update, sets a 5-second timer.
 * After 5 seconds: compares online DB vs offline DB for selected date.
 * If different: updates offline DB.
 * Always updates UI with offline DB data.
 */

import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';

class DeliveryWebSocketReconciler {
  constructor() {
    this.reconcileTimer = null;
    this.pendingDate = null;
    this.isReconciling = false;
    this.RECONCILE_DELAY = 5000; // 5 seconds
  }

  /**
   * Call when WebSocket delivery event arrives
   * Schedules reconciliation for this date
   */
  onDeliveryWebSocketEvent(deliveryData) {
    const eventDate = deliveryData?.delivery_date;
    
    if (!eventDate) return;

    // Cancel existing timer if date changed
    if (this.pendingDate && this.pendingDate !== eventDate) {
      this.cancelReconcile();
    }

    this.pendingDate = eventDate;

    // Reset timer
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
    }

    // Schedule reconciliation
    console.log(`⏱️ [DeliveryReconciler] Scheduled reconcile for ${eventDate} in ${this.RECONCILE_DELAY}ms`);
    this.reconcileTimer = setTimeout(() => {
      this.performReconciliation(eventDate);
    }, this.RECONCILE_DELAY);
  }

  /**
   * Refresh UI from the offline DB for this date.
   * No longer fetches from the online API — realtimeSync already keeps IDB accurate
   * via per-record WS merge, so a bulk Delivery.filter() round-trip here is redundant
   * and was the primary source of lag on receiving devices.
   */
  async performReconciliation(dateStr) {
    if (this.isReconciling) return;
    this.isReconciling = true;

    try {
      const freshOfflineDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, dateStr);
      if (typeof window !== 'undefined' && freshOfflineDeliveries?.length > 0) {
        window.dispatchEvent(new CustomEvent('deliveryReconcilerUIRefresh', {
          detail: { date: dateStr, deliveries: freshOfflineDeliveries, hadDifferences: false }
        }));
      }
      console.log(`✅ [DeliveryReconciler] IDB→UI refresh: ${freshOfflineDeliveries?.length || 0} deliveries for ${dateStr}`);
    } catch (error) {
      console.warn(`⚠️ [DeliveryReconciler] Error:`, error.message);
    } finally {
      this.isReconciling = false;
      this.reconcileTimer = null;
      this.pendingDate = null;
    }
  }

  /**
   * Cancel pending reconciliation
   */
  cancelReconcile() {
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
      this.pendingDate = null;
      console.log('⏹️ [DeliveryReconciler] Cancelled pending reconciliation');
    }
  }

  /**
   * Get reconciler status
   */
  getStatus() {
    return {
      isReconciling: this.isReconciling,
      hasPendingReconcile: !!this.reconcileTimer,
      pendingDate: this.pendingDate,
      delayMs: this.RECONCILE_DELAY
    };
  }
}

export const deliveryWebSocketReconciler = new DeliveryWebSocketReconciler();