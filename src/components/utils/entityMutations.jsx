/**
 * Unified Entity Mutations Manager
 * 
 * Handles ALL entity writes in the app:
 * - Patient & Delivery: Local-first (IndexedDB + Backend + UI update + Broadcast)
 * - All other entities: Backend + UI update + Broadcast
 * 
 * This centralizes the mutation logic so that every entity change:
 * 1. Updates the backend
 * 2. Updates local state/UI immediately
 * 3. Broadcasts to other devices
 */

import { base44 } from '@/api/base44Client';
import * as offlineDB from './offlineDatabase';

// Lazy load broadcastMutation to avoid circular dependency issues
const broadcastMutation = async (entity, action, id, data, ids = null) => {
  try {
    const { broadcastMutation: broadcast } = await import('./realtimeSync');
    return broadcast(entity, action, id, data, ids);
  } catch (error) {
    console.warn('[EntityMutations] Could not broadcast mutation:', error.message);
  }
};

// ========================================
// LISTENERS & STATE
// ========================================

let mutationListeners = [];
let mutationsPaused = false;

/**
 * Pause all mutations (during route optimization)
 */
export const pauseMutations = () => {
  console.log('⏸️ [EntityMutations] Paused');
  mutationsPaused = true;
};

/**
 * Resume mutations
 */
export const resumeMutations = () => {
  console.log('▶️ [EntityMutations] Resumed');
  mutationsPaused = false;
};

/**
 * Check if mutations are paused
 */
export const areMutationsPaused = () => mutationsPaused;

/**
 * Subscribe to mutation events for UI updates
 * Callback receives: { type, entity, id, data, oldId?, newId? }
 */
export const subscribeMutations = (callback) => {
  mutationListeners.push(callback);
  return () => {
    mutationListeners = mutationListeners.filter(cb => cb !== callback);
  };
};

/**
 * Notify all listeners of a mutation
 */
const notifyMutation = (mutation) => {
  if (mutationsPaused) {
    console.log('⏸️ [EntityMutations] Notification skipped - mutations paused');
    return;
  }

  mutationListeners.forEach(callback => {
    try {
      callback(mutation);
    } catch (error) {
      console.error('Error in mutation listener:', error);
    }
  });
};

// Broadcast functionality removed

/**
 * Pause smart refresh manager before mutation
 */
const pauseSmartRefresh = async () => {
  try {
    const { smartRefreshManager } = await import('./smartRefreshManager');
    smartRefreshManager.pause();
  } catch (error) {
    console.warn('⚠️ [EntityMutations] Failed to pause smart refresh:', error);
  }
};

/**
 * Restart smart refresh after mutation
 */
const restartSmartRefresh = async () => {
  try {
    const { smartRefreshManager } = await import('./smartRefreshManager');
    smartRefreshManager.restart();
  } catch (error) {
    console.warn('⚠️ [EntityMutations] Failed to restart smart refresh:', error);
  }
};

// ========================================
// OFFLINE-ENABLED ENTITIES (Patient, Delivery)
// ========================================

/**
 * Create a Patient (local-first)
 */
export const createPatient = async (patientData, options = {}) => {
  if (mutationsPaused) throw new Error('Mutations are paused');
  await pauseSmartRefresh();

  try {
    // Generate temp ID
    const tempId = `temp_patient_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const localPatient = {
      ...patientData,
      id: tempId,
      created_date: new Date().toISOString(),
      updated_date: new Date().toISOString(),
      _isLocal: true
    };

    // Save to IndexedDB
    await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [localPatient]);
    
    // Notify UI immediately
    notifyMutation({ type: 'create', entity: 'Patient', id: tempId, data: localPatient });

    // Sync to backend
    try {
      const backendPatient = await base44.entities.Patient.create(patientData);
      
      // Replace temp with real in IndexedDB
      const db = await offlineDB.openDatabase();
      const tx = db.transaction([offlineDB.STORES.PATIENTS], 'readwrite');
      await new Promise((resolve, reject) => {
        const req = tx.objectStore(offlineDB.STORES.PATIENTS).delete(tempId);
        req.onsuccess = resolve;
        req.onerror = () => reject(req.error);
      });
      await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [backendPatient]);
      
      // Notify UI to replace temp with real
      notifyMutation({ type: 'replace', entity: 'Patient', oldId: tempId, newId: backendPatient.id, data: backendPatient });
      
      // Broadcast to other devices
      broadcastMutation('Patient', 'create', backendPatient.id, backendPatient);
      
      await restartSmartRefresh();
      return backendPatient;
    } catch (error) {
      console.warn('⚠️ [EntityMutations] Patient sync failed, queuing:', error.message);
      await offlineDB.addPendingMutation({ operation: 'create', entity: 'Patient', recordId: tempId, payload: patientData });
      await restartSmartRefresh();
      return localPatient;
    }
  } catch (error) {
    await restartSmartRefresh();
    throw error;
  }
};

/**
 * Update a Patient (local-first with guaranteed cache refresh)
 */
export const updatePatient = async (patientId, updates, options = {}) => {
  if (mutationsPaused) throw new Error('Mutations are paused');
  await pauseSmartRefresh();

  try {
    const patients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
    const existing = patients.find(p => p.id === patientId);
    
    if (!existing) {
      // Not in IndexedDB - update backend directly, then sync to local
      const backendPatient = await base44.entities.Patient.update(patientId, updates);
      await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [backendPatient]);
      
      // CRITICAL: Update cache directly to prevent UI flickering
      const { updateCache } = await import('./dataManager');
      updateCache('Patient', patientId, backendPatient);
      
      notifyMutation({ type: 'update', entity: 'Patient', id: patientId, data: backendPatient });
      await restartSmartRefresh();
      return backendPatient;
    }

    // STEP 1: Update IndexedDB locally first
    const updated = { ...existing, ...updates, updated_date: new Date().toISOString() };
    await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [updated]);
    console.log('💾 [EntityMutations] Updated IndexedDB for patient:', patientId);

    // STEP 2: Sync to backend
    try {
      const backendPatient = await base44.entities.Patient.update(patientId, updates);
      console.log('☁️ [EntityMutations] Backend updated patient:', patientId);
      
      // STEP 3: Update IndexedDB with backend version
      await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [backendPatient]);
      
      // STEP 4: CRITICAL - Update cache directly to prevent UI flickering
      const { updateCache } = await import('./dataManager');
      updateCache('Patient', patientId, backendPatient);
      console.log('⚡ [EntityMutations] Updated Patient cache');
      
      // STEP 5: Notify UI with backend version
      notifyMutation({ type: 'update', entity: 'Patient', id: patientId, data: backendPatient });
      
      // Broadcast to other devices
      broadcastMutation('Patient', 'update', patientId, backendPatient);
      
    } catch (error) {
      console.warn('⚠️ [EntityMutations] Patient update sync failed, queuing:', error.message);
      await offlineDB.addPendingMutation({ operation: 'update', entity: 'Patient', recordId: patientId, payload: updates });
      
      // Notify UI with local version if backend fails
      notifyMutation({ type: 'update', entity: 'Patient', id: patientId, data: updated });
    }

    await restartSmartRefresh();
    return updated;
  } catch (error) {
    await restartSmartRefresh();
    throw error;
  }
};

/**
 * Delete a Patient (local-first)
 */
export const deletePatient = async (patientId, options = {}) => {
  if (mutationsPaused) throw new Error('Mutations are paused');
  await pauseSmartRefresh();

  try {
    // Remove from IndexedDB
    const db = await offlineDB.openDatabase();
    const tx = db.transaction([offlineDB.STORES.PATIENTS], 'readwrite');
    await new Promise((resolve, reject) => {
      const req = tx.objectStore(offlineDB.STORES.PATIENTS).delete(patientId);
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });

    // Notify UI immediately
    notifyMutation({ type: 'delete', entity: 'Patient', id: patientId, data: null });

    // Sync to backend
    try {
      await base44.entities.Patient.delete(patientId);
      
      // CRITICAL: Mark as deleted in smart refresh to prevent resurrection
      const { smartRefreshManager } = await import('./smartRefreshManager');
      smartRefreshManager.deletedPatientIds.add(patientId);
      
      // Broadcast to other devices
      broadcastMutation('Patient', 'delete', patientId, null);
    } catch (error) {
      console.warn('⚠️ [EntityMutations] Patient delete sync failed, queuing:', error.message);
      await offlineDB.addPendingMutation({ operation: 'delete', entity: 'Patient', recordId: patientId });
    }

    await restartSmartRefresh();
    return true;
  } catch (error) {
    await restartSmartRefresh();
    throw error;
  }
};

/**
 * Create a Delivery (local-first with guaranteed cache refresh)
 */
export const createDelivery = async (deliveryData, options = {}) => {
  if (mutationsPaused) throw new Error('Mutations are paused');
  await pauseSmartRefresh();

  try {
    const tempId = `temp_delivery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const localDelivery = {
      ...deliveryData,
      id: tempId,
      created_date: new Date().toISOString(),
      updated_date: new Date().toISOString(),
      _isLocal: true
    };

    // STEP 1: Save to IndexedDB with temp ID
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [localDelivery]);
    notifyMutation({ type: 'create', entity: 'Delivery', id: tempId, data: localDelivery });

    try {
      // STEP 2: Create on backend
      const backendDelivery = await base44.entities.Delivery.create(deliveryData);
      console.log('☁️ [EntityMutations] Backend created:', backendDelivery.id);
      
      // STEP 3: Replace temp with real in IndexedDB
      const db = await offlineDB.openDatabase();
      const tx = db.transaction([offlineDB.STORES.DELIVERIES], 'readwrite');
      await new Promise((resolve, reject) => {
        const req = tx.objectStore(offlineDB.STORES.DELIVERIES).delete(tempId);
        req.onsuccess = resolve;
        req.onerror = () => reject(req.error);
      });
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [backendDelivery]);
      
      // STEP 4: CRITICAL - Update cache directly (will be added via notifyMutation)
      // For creates, the cache will be updated through the mutation listener
      console.log('⚡ [EntityMutations] Created Delivery, cache will update via listener');
      
      // STEP 5: Notify UI to replace temp with real
      notifyMutation({ type: 'replace', entity: 'Delivery', oldId: tempId, newId: backendDelivery.id, data: backendDelivery });
      
      // Broadcast to other devices
      broadcastMutation('Delivery', 'create', backendDelivery.id, backendDelivery);
      
      await restartSmartRefresh();
      return backendDelivery;
    } catch (error) {
      console.warn('⚠️ [EntityMutations] Delivery sync failed, queuing:', error.message);
      await offlineDB.addPendingMutation({ operation: 'create', entity: 'Delivery', recordId: tempId, payload: deliveryData });
      await restartSmartRefresh();
      return localDelivery;
    }
  } catch (error) {
    await restartSmartRefresh();
    throw error;
  }
};

/**
 * Update a Delivery (local-first with guaranteed cache refresh)
 */
export const updateDelivery = async (deliveryId, updates, options = {}) => {
  const { skipSmartRefresh = false } = options;
  if (mutationsPaused) throw new Error('Mutations are paused');
  if (!skipSmartRefresh) await pauseSmartRefresh();

  try {
    const deliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    const existing = deliveries.find(d => d.id === deliveryId);
    
    if (!existing) {
      // Not in IndexedDB - update backend directly, then sync to local
      try {
        const backendDelivery = await base44.entities.Delivery.update(deliveryId, updates);
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [backendDelivery]);
        
        // CRITICAL: Update cache directly to prevent UI flickering
        const { updateCache } = await import('./dataManager');
        updateCache('Delivery', deliveryId, backendDelivery);
        
        notifyMutation({ type: 'update', entity: 'Delivery', id: deliveryId, data: backendDelivery });
        if (!skipSmartRefresh) await restartSmartRefresh();
        return backendDelivery;
      } catch (error) {
        if (error.message?.includes('not found') || error.message?.includes('404')) {
          notifyMutation({ type: 'delete', entity: 'Delivery', id: deliveryId, data: null });
          if (!skipSmartRefresh) await restartSmartRefresh();
          return null;
        }
        throw error;
      }
    }

    // STEP 1: Update IndexedDB locally FIRST
    const updated = { ...existing, ...updates, updated_date: new Date().toISOString() };
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [updated]);
    console.log('💾 [EntityMutations] Updated IndexedDB for:', deliveryId);
    
    // STEP 2: Update backend (sync to server)
    try {
      const backendDelivery = await base44.entities.Delivery.update(deliveryId, updates);
      console.log('☁️ [EntityMutations] Backend updated for:', deliveryId);
      
      // STEP 3: Update IndexedDB with backend response (authoritative version)
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [backendDelivery]);
      
      // STEP 4: CRITICAL - Update cache directly to prevent UI flickering
      const { updateCache } = await import('./dataManager');
      updateCache('Delivery', deliveryId, backendDelivery);
      console.log('⚡ [EntityMutations] Updated Delivery cache');
      
      // STEP 5: Notify UI with backend version (most up-to-date)
      notifyMutation({ type: 'update', entity: 'Delivery', id: deliveryId, data: backendDelivery });
      
      // Broadcast to other devices
      broadcastMutation('Delivery', 'update', deliveryId, backendDelivery);
      
    } catch (error) {
      console.warn('⚠️ [EntityMutations] Delivery update sync failed, queuing:', error.message);
      await offlineDB.addPendingMutation({ operation: 'update', entity: 'Delivery', recordId: deliveryId, payload: updates });
      
      // STEP 5 (fallback): Notify UI with local version if backend fails
      notifyMutation({ type: 'update', entity: 'Delivery', id: deliveryId, data: updated });
    }
    
    if (!skipSmartRefresh) await restartSmartRefresh();
    return updated;
  } catch (error) {
    if (!skipSmartRefresh) await restartSmartRefresh();
    throw error;
  }
};

/**
 * Delete a Delivery (local-first with guaranteed cache refresh)
 */
export const deleteDelivery = async (deliveryId, options = {}) => {
  if (mutationsPaused) throw new Error('Mutations are paused');
  await pauseSmartRefresh();

  try {
    // STEP 1: Delete from IndexedDB
    const db = await offlineDB.openDatabase();
    const tx = db.transaction([offlineDB.STORES.DELIVERIES], 'readwrite');
    await new Promise((resolve, reject) => {
      const req = tx.objectStore(offlineDB.STORES.DELIVERIES).delete(deliveryId);
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });
    console.log('💾 [EntityMutations] Deleted from IndexedDB:', deliveryId);

    // STEP 2: Delete from backend
    try {
      await base44.entities.Delivery.delete(deliveryId);
      console.log('☁️ [EntityMutations] Backend deleted:', deliveryId);
    } catch (error) {
      console.warn('⚠️ [EntityMutations] Delivery delete sync failed, queuing:', error.message);
      await offlineDB.addPendingMutation({ operation: 'delete', entity: 'Delivery', recordId: deliveryId });
    }

    // STEP 3: CRITICAL - Invalidate dataManager cache
    const { invalidate } = await import('./dataManager');
    invalidate('Delivery');
    console.log('🗑️ [EntityMutations] Invalidated Delivery cache after delete');
    
    // STEP 4: Mark as deleted in smart refresh to prevent resurrection
    const { smartRefreshManager } = await import('./smartRefreshManager');
    smartRefreshManager.deletedDeliveryIds.add(deliveryId);

    // STEP 5: Notify UI immediately
    notifyMutation({ type: 'delete', entity: 'Delivery', id: deliveryId, data: null });
    
    // Broadcast to other devices
    broadcastMutation('Delivery', 'delete', deliveryId, null);
    
    await restartSmartRefresh();
    return true;
  } catch (error) {
    await restartSmartRefresh();
    throw error;
  }
};

/**
 * Batch create deliveries (local-first with guaranteed cache refresh)
 */
export const batchCreateDeliveries = async (deliveriesData, options = {}) => {
  if (mutationsPaused) throw new Error('Mutations are paused');
  await pauseSmartRefresh();

  try {
    const localDeliveries = deliveriesData.map(d => ({
      ...d,
      id: `temp_delivery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      created_date: new Date().toISOString(),
      updated_date: new Date().toISOString(),
      _isLocal: true
    }));

    // STEP 1: Save to IndexedDB with temp IDs
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, localDeliveries);
    localDeliveries.forEach(d => notifyMutation({ type: 'create', entity: 'Delivery', id: d.id, data: d }));

    try {
      // STEP 2: Create on backend
      const backendDeliveries = await base44.entities.Delivery.bulkCreate(deliveriesData);
      console.log(`☁️ [EntityMutations] Backend created ${backendDeliveries.length} deliveries`);
      
      // STEP 3: Replace temps with real in IndexedDB
      const db = await offlineDB.openDatabase();
      const tx = db.transaction([offlineDB.STORES.DELIVERIES], 'readwrite');
      const store = tx.objectStore(offlineDB.STORES.DELIVERIES);
      
      for (const local of localDeliveries) {
        await new Promise((resolve, reject) => {
          const req = store.delete(local.id);
          req.onsuccess = resolve;
          req.onerror = () => reject(req.error);
        });
      }
      
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, backendDeliveries);
      console.log(`💾 [EntityMutations] Updated IndexedDB with ${backendDeliveries.length} real deliveries`);
      
      // STEP 4: CRITICAL - Invalidate dataManager cache
      const { invalidate } = await import('./dataManager');
      invalidate('Delivery');
      console.log('🗑️ [EntityMutations] Invalidated Delivery cache after batch create');
      
      // STEP 5: Notify UI to replace temps with real
      backendDeliveries.forEach((backend, i) => {
        notifyMutation({ type: 'replace', entity: 'Delivery', oldId: localDeliveries[i].id, newId: backend.id, data: backend });
      });
      
      // Broadcast to other devices
      backendDeliveries.forEach(d => broadcastMutation('Delivery', 'create', d.id, d));
      
      await restartSmartRefresh();
      return backendDeliveries;
    } catch (error) {
      console.warn('⚠️ [EntityMutations] Batch delivery sync failed, queuing:', error.message);
      for (const d of localDeliveries) {
        await offlineDB.addPendingMutation({ operation: 'create', entity: 'Delivery', recordId: d.id, payload: d });
      }
      await restartSmartRefresh();
      return localDeliveries;
    }
  } catch (error) {
    await restartSmartRefresh();
    throw error;
  }
};

/**
 * Batch delete deliveries (local-first with guaranteed cache refresh)
 */
export const batchDeleteDeliveries = async (deliveryIds, options = {}) => {
  if (mutationsPaused) throw new Error('Mutations are paused');
  await pauseSmartRefresh();

  try {
    console.log(`🗑️ [EntityMutations] Batch deleting ${deliveryIds.length} deliveries...`);
    
    // STEP 1: Remove all from IndexedDB
    const db = await offlineDB.openDatabase();
    const tx = db.transaction([offlineDB.STORES.DELIVERIES], 'readwrite');
    const store = tx.objectStore(offlineDB.STORES.DELIVERIES);
    
    for (const id of deliveryIds) {
      await new Promise((resolve, reject) => {
        const req = store.delete(id);
        req.onsuccess = resolve;
        req.onerror = () => reject(req.error);
      });
    }
    console.log(`💾 [EntityMutations] Deleted ${deliveryIds.length} from IndexedDB`);

    // STEP 2: Delete from backend
    try {
      const deletePromises = deliveryIds.map(id => base44.entities.Delivery.delete(id));
      await Promise.all(deletePromises);
      console.log(`☁️ [EntityMutations] Backend deleted ${deliveryIds.length} deliveries`);
      
      // STEP 3: CRITICAL - Invalidate dataManager cache
      const { invalidate } = await import('./dataManager');
      invalidate('Delivery');
      console.log('🗑️ [EntityMutations] Invalidated Delivery cache after batch delete');
      
      // STEP 4: Mark as deleted in smart refresh
      const { smartRefreshManager } = await import('./smartRefreshManager');
      deliveryIds.forEach(id => smartRefreshManager.deletedDeliveryIds.add(id));
      console.log(`🗑️ [EntityMutations] Marked ${deliveryIds.length} deliveries as deleted`);
    } catch (error) {
      console.warn('⚠️ [EntityMutations] Batch delete sync failed, queuing:', error.message);
      for (const id of deliveryIds) {
        await offlineDB.addPendingMutation({ operation: 'delete', entity: 'Delivery', recordId: id });
      }
    }

    // STEP 5: Notify UI immediately
    notifyMutation({ 
      type: 'batch_delete', 
      entity: 'Delivery', 
      ids: deliveryIds,
      data: null 
    });

    // Broadcast to other devices
    broadcastMutation('Delivery', 'batch_delete', null, null, deliveryIds);

    await restartSmartRefresh();
    return true;
  } catch (error) {
    await restartSmartRefresh();
    throw error;
  }
};

// ========================================
// ONLINE-ONLY ENTITIES (Store, City, AppUser, etc.)
// ========================================

/**
 * Generic create for online-only entities
 */
export const createEntity = async (entityName, data, options = {}) => {
  if (mutationsPaused) throw new Error('Mutations are paused');
  
  try {
    const result = await base44.entities[entityName].create(data);
    notifyMutation({ type: 'create', entity: entityName, id: result.id, data: result });
    // Broadcast removed
    return result;
  } catch (error) {
    console.error(`❌ [EntityMutations] Failed to create ${entityName}:`, error);
    throw error;
  }
};

/**
 * Generic update for online-only entities
 */
export const updateEntity = async (entityName, entityId, updates, options = {}) => {
  if (mutationsPaused) throw new Error('Mutations are paused');
  
  try {
    const result = await base44.entities[entityName].update(entityId, updates);
    notifyMutation({ type: 'update', entity: entityName, id: entityId, data: result });
    // Broadcast removed
    return result;
  } catch (error) {
    console.error(`❌ [EntityMutations] Failed to update ${entityName}:`, error);
    throw error;
  }
};

/**
 * Generic delete for online-only entities
 */
export const deleteEntity = async (entityName, entityId, options = {}) => {
  if (mutationsPaused) throw new Error('Mutations are paused');
  
  try {
    await base44.entities[entityName].delete(entityId);
    notifyMutation({ type: 'delete', entity: entityName, id: entityId, data: null });
    // Broadcast removed
    return true;
  } catch (error) {
    console.error(`❌ [EntityMutations] Failed to delete ${entityName}:`, error);
    throw error;
  }
};

// ========================================
// CONVENIENCE EXPORTS FOR SPECIFIC ENTITIES
// ========================================

// Store mutations
export const createStore = (data, options) => createEntity('Store', data, options);
export const updateStore = (id, updates, options) => updateEntity('Store', id, updates, options);
export const deleteStore = (id, options) => deleteEntity('Store', id, options);

// City mutations
export const createCity = (data, options) => createEntity('City', data, options);
export const updateCity = (id, updates, options) => updateEntity('City', id, updates, options);
export const deleteCity = (id, options) => deleteEntity('City', id, options);

// AppUser mutations
export const createAppUser = (data, options) => createEntity('AppUser', data, options);
export const updateAppUser = (id, updates, options) => updateEntity('AppUser', id, updates, options);
export const deleteAppUser = (id, options) => deleteEntity('AppUser', id, options);

/**
 * Update AppUser with immediate UI refresh and real-time broadcast
 * Updates backend, notifies UI immediately, and broadcasts to other devices
 * CRITICAL: Used for driver status, location, and tracking changes
 */
export const localUpdateAppUser = async (appUserId, updates, options = {}) => {
  if (mutationsPaused) throw new Error('Mutations are paused');
  
  try {
    console.log(`🔄 [EntityMutations] Updating AppUser ${appUserId}...`);
    
    // Update backend
    const result = await base44.entities.AppUser.update(appUserId, updates);
    
    // Notify UI immediately so DriverSettings refreshes
    notifyMutation({ type: 'update', entity: 'AppUser', id: appUserId, data: result });
    
    // CRITICAL: Broadcast to other devices for real-time sync
    // This ensures driver location/status changes are instantly visible
    broadcastMutation('AppUser', 'update', appUserId, result);
    
    console.log(`✅ [EntityMutations] AppUser ${appUserId} updated and broadcast`);
    return result;
  } catch (error) {
    console.error(`❌ [EntityMutations] Failed to update AppUser ${appUserId}:`, error);
    throw error;
  }
};

// UserSettings mutations
export const createUserSettings = (data, options) => createEntity('UserSettings', data, options);
export const updateUserSettings = (id, updates, options) => updateEntity('UserSettings', id, updates, options);

// Message mutations
export const createMessage = (data, options) => createEntity('Message', data, options);
export const updateMessage = (id, updates, options) => updateEntity('Message', id, updates, options);
export const deleteMessage = (id, options) => deleteEntity('Message', id, options);

// ========================================
// LEGACY EXPORTS (for backward compatibility)
// ========================================

// Re-export with old names for backward compatibility
export {
  createPatient as createPatientLocal,
  updatePatient as updatePatientLocal,
  deletePatient as deletePatientLocal,
  createDelivery as createDeliveryLocal,
  updateDelivery as updateDeliveryLocal,
  deleteDelivery as deleteDeliveryLocal,
  batchCreateDeliveries as batchCreateDeliveriesLocal,
  batchDeleteDeliveries as batchDeleteDeliveriesLocal,
  pauseMutations as pauseOfflineMutations,
  resumeMutations as resumeOfflineMutations,
  areMutationsPaused as areOfflineMutationsPaused
};