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
   * Compare online DB vs offline DB and sync if needed
   */
  async performReconciliation(dateStr) {
    if (this.isReconciling) {
      console.log(`⏸️ [DeliveryReconciler] Reconcile already in progress for ${dateStr}`);
      return;
    }

    this.isReconciling = true;
    console.log(`🔄 [DeliveryReconciler] Starting reconciliation for ${dateStr}...`);

    try {
      // Step 1: Get offline data for this date
      const offlineDeliveries = await offlineDB.getByDate(
        offlineDB.STORES.DELIVERIES,
        dateStr
      );
      const offlineMap = new Map(offlineDeliveries?.map(d => [d.id, d]) || []);
      console.log(`💾 [DeliveryReconciler] Offline DB: ${offlineMap.size} deliveries for ${dateStr}`);

      // Step 2: Fetch fresh data from online API
      const onlineDeliveries = await base44.entities.Delivery.filter({
        delivery_date: dateStr
      });
      const onlineMap = new Map(onlineDeliveries?.map(d => [d.id, d]) || []);
      console.log(`☁️ [DeliveryReconciler] Online DB: ${onlineMap.size} deliveries for ${dateStr}`);

      // Step 3: Detect differences
      const toAdd = [];
      const toUpdate = [];
      const toDelete = [];

      // Check online for adds/updates
      for (const [id, onlineRecord] of onlineMap) {
        const offlineRecord = offlineMap.get(id);
        
        if (!offlineRecord) {
          toAdd.push(onlineRecord);
        } else {
          // Compare timestamps to detect changes
          const onlineTime = new Date(onlineRecord.updated_date || 0).getTime();
          const offlineTime = new Date(offlineRecord.updated_date || 0).getTime();
          
          if (onlineTime > offlineTime) {
            toUpdate.push(onlineRecord);
          }
        }
      }

      // Check offline for deletes
      for (const [id, offlineRecord] of offlineMap) {
        if (!onlineMap.has(id)) {
          toDelete.push(id);
        }
      }

      const hasDifferences = toAdd.length > 0 || toUpdate.length > 0 || toDelete.length > 0;

      if (hasDifferences) {
        console.log(`⚠️ [DeliveryReconciler] Found differences:`);
        console.log(`   + ${toAdd.length} to add, ~ ${toUpdate.length} to update, - ${toDelete.length} to delete`);

        // Step 4: Update offline DB
        if (toAdd.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, toAdd);
          console.log(`✅ [DeliveryReconciler] Added ${toAdd.length} deliveries`);
        }

        if (toUpdate.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, toUpdate);
          console.log(`✅ [DeliveryReconciler] Updated ${toUpdate.length} deliveries`);
        }

        if (toDelete.length > 0) {
          for (const id of toDelete) {
            await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, id);
          }
          console.log(`✅ [DeliveryReconciler] Deleted ${toDelete.length} deliveries`);
        }

        // Dispatch reconcile event
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('deliveryWebSocketReconciled', {
            detail: {
              date: dateStr,
              added: toAdd.length,
              updated: toUpdate.length,
              deleted: toDelete.length
            }
          }));
        }
      } else {
        console.log(`✅ [DeliveryReconciler] Online and offline DBs match for ${dateStr}`);
      }

      // Step 5: ALWAYS update UI with fresh offline DB data
      const freshOfflineDeliveries = await offlineDB.getByDate(
        offlineDB.STORES.DELIVERIES,
        dateStr
      );

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('deliveryReconcilerUIRefresh', {
          detail: {
            date: dateStr,
            deliveries: freshOfflineDeliveries,
            hadDifferences: hasDifferences
          }
        }));
      }

      console.log(`✅ [DeliveryReconciler] UI refreshed with ${freshOfflineDeliveries?.length || 0} deliveries for ${dateStr}`);

    } catch (error) {
      console.error(`❌ [DeliveryReconciler] Error:`, error.message);
      
      // Even on error, try to update UI with whatever offline data we have
      try {
        const offlineDeliveries = await offlineDB.getByDate(
          offlineDB.STORES.DELIVERIES,
          dateStr
        );
        
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('deliveryReconcilerUIRefresh', {
            detail: {
              date: dateStr,
              deliveries: offlineDeliveries,
              hadDifferences: false,
              error: error.message
            }
          }));
        }
      } catch (fallbackError) {
        console.warn(`⚠️ [DeliveryReconciler] Fallback UI update failed:`, fallbackError.message);
      }
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