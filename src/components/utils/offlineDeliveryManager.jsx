/**
 * Offline Delivery Manager - Handles offline delivery status updates
 */

import { offlineManager } from './offlineManager';

class OfflineDeliveryManager {
  constructor() {
    this.localUpdates = new Map(); // deliveryId -> update data
    this.loadLocalUpdates();
  }

  // Update delivery status offline
  async updateDeliveryOffline(deliveryId, status, extraData = {}) {
    const currentTime = new Date().toISOString();
    
    const updateData = {
      status,
      ...extraData,
      _offlineUpdate: true,
      _offlineTimestamp: currentTime
    };
    
    // Add actual_delivery_time for finished statuses
    const finishedStatuses = ['completed', 'failed', 'delivered', 'cancelled'];
    if (finishedStatuses.includes(status)) {
      updateData.actual_delivery_time = currentTime;
    }
    
    // Store locally
    this.localUpdates.set(deliveryId, updateData);
    await this.saveLocalUpdates();
    
    // Queue for sync when online
    await offlineManager.queueAction({
      type: 'updateDelivery',
      deliveryId,
      data: updateData
    });
    
    console.log('💾 [OfflineDelivery] Saved offline update:', deliveryId, status);
    
    return updateData;
  }

  // Get local update for a delivery
  getLocalUpdate(deliveryId) {
    return this.localUpdates.get(deliveryId);
  }

  // Check if delivery has local updates
  hasLocalUpdate(deliveryId) {
    return this.localUpdates.has(deliveryId);
  }

  // Clear local update after successful sync
  async clearLocalUpdate(deliveryId) {
    this.localUpdates.delete(deliveryId);
    await this.saveLocalUpdates();
  }

  // Save local updates to localStorage
  async saveLocalUpdates() {
    try {
      const updates = Array.from(this.localUpdates.entries());
      localStorage.setItem('rxdeliver_offline_updates', JSON.stringify(updates));
    } catch (error) {
      console.error('❌ [OfflineDelivery] Error saving local updates:', error);
    }
  }

  // Load local updates from localStorage
  async loadLocalUpdates() {
    try {
      const saved = localStorage.getItem('rxdeliver_offline_updates');
      if (saved) {
        const updates = JSON.parse(saved);
        this.localUpdates = new Map(updates);
        console.log('📦 [OfflineDelivery] Loaded', this.localUpdates.size, 'local updates');
      }
    } catch (error) {
      console.error('❌ [OfflineDelivery] Error loading local updates:', error);
    }
  }

  // Apply local updates to delivery data
  applyLocalUpdates(deliveries) {
    if (!Array.isArray(deliveries)) return deliveries;
    
    return deliveries.map(delivery => {
      if (!delivery) return delivery;
      
      const localUpdate = this.getLocalUpdate(delivery.id);
      if (localUpdate) {
        return {
          ...delivery,
          ...localUpdate,
          _hasLocalUpdate: true
        };
      }
      return delivery;
    });
  }
}

export const offlineDeliveryManager = new OfflineDeliveryManager();