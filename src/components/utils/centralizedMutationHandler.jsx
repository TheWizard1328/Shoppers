/**
 * Centralized Mutation Handler
 * ALL data mutations (create/update/delete) flow through this single pipeline
 * Ensures consistent pause → update → resume flow to prevent race conditions
 */

import { offlineDB } from './offlineDatabase';
import { invalidate, invalidateDeliveriesForDate } from './dataManager';

let isMutationInProgress = false;
let mutationQueue = [];

/**
 * SINGLE MUTATION PIPELINE
 * All updates go through this to ensure consistent state management
 */
export async function executeMutation({
  entityName,
  operation, // 'create', 'update', 'delete'
  data,
  deliveryId,
  patientId,
  onLocalUpdate, // Callback to update UI state INSTANTLY
}) {
  // Queue if another mutation is in progress
  if (isMutationInProgress) {
    console.log(`⏳ [Mutation] Queuing ${operation} for ${entityName}`);
    return new Promise((resolve, reject) => {
      mutationQueue.push({ entityName, operation, data, deliveryId, patientId, onLocalUpdate, resolve, reject });
    });
  }

  isMutationInProgress = true;
  console.log(`🔄 [Mutation] Starting ${operation} on ${entityName}`);

  try {
    // STEP 1: Pause EVERYTHING
    const { smartRefreshManager } = await import('./smartRefreshManager');
    const { pauseOfflineMutations, resumeOfflineMutations } = await import('./offlineMutations');
    const { pauseOfflineSync, resumeOfflineSync } = await import('./offlineSync');
    
    smartRefreshManager.pause();
    pauseOfflineMutations();
    pauseOfflineSync();
    
    // STEP 2: Update LOCAL UI state INSTANTLY via callback
    if (onLocalUpdate) {
      onLocalUpdate();
      console.log('✅ [Mutation] UI updated instantly');
    }
    
    // STEP 3: Update offline DB
    if (entityName === 'Delivery') {
      const storeName = offlineDB.STORES.DELIVERIES;
      
      if (operation === 'update') {
        const allDeliveries = await offlineDB.getAll(storeName);
        const existing = allDeliveries.find(d => d.id === deliveryId);
        if (existing) {
          const updated = { ...existing, ...data, updated_date: new Date().toISOString() };
          await offlineDB.bulkSave(storeName, [updated]);
          console.log('✅ [Mutation] Offline DB updated');
        }
      } else if (operation === 'delete') {
        const db = await offlineDB.openDatabase();
        const tx = db.transaction([storeName], 'readwrite');
        await new Promise((resolve, reject) => {
          const req = tx.objectStore(storeName).delete(deliveryId);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
        console.log('✅ [Mutation] Deleted from offline DB');
      }
      
      // Invalidate cache
      if (data?.delivery_date) {
        invalidateDeliveriesForDate(data.delivery_date);
      }
      invalidate('Delivery');
    }
    
    // STEP 4: Sync to backend in background
    const { base44 } = await import('@/api/base44Client');
    
    try {
      if (entityName === 'Delivery') {
        if (operation === 'update') {
          await base44.entities.Delivery.update(deliveryId, data);
          console.log('✅ [Mutation] Synced to backend');
        } else if (operation === 'delete') {
          await base44.entities.Delivery.delete(deliveryId);
          console.log('✅ [Mutation] Deleted from backend');
        }
      }
    } catch (backendError) {
      console.warn('⚠️ [Mutation] Backend sync failed (will retry):', backendError.message);
      // Queue for retry
      await offlineDB.addPendingMutation({
        operation,
        entity: entityName,
        recordId: deliveryId || patientId,
        payload: data
      });
    }
    
    // STEP 5: Resume EVERYTHING and force immediate refresh
    smartRefreshManager.restart(); // Reset timers to trigger immediate refresh
    resumeOfflineMutations();
    resumeOfflineSync();
    
    console.log('✅ [Mutation] Complete - smart refresh will pull remote changes');
    
  } catch (error) {
    console.error('❌ [Mutation] Failed:', error);
    throw error;
  } finally {
    isMutationInProgress = false;
    
    // Process next queued mutation
    if (mutationQueue.length > 0) {
      const next = mutationQueue.shift();
      executeMutation(next).then(next.resolve).catch(next.reject);
    }
  }
}