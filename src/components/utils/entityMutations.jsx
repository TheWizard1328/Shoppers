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
import { offlineDB } from './offlineDatabase';

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
      
      // Broadcast removed
      
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
 * Update a Patient (local-first)
 */
export const updatePatient = async (patientId, updates, options = {}) => {
  if (mutationsPaused) throw new Error('Mutations are paused');
  await pauseSmartRefresh();

  try {
    // Get existing from IndexedDB
    const patients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
    const existing = patients.find(p => p.id === patientId);
    
    if (!existing) {
      // Not in IndexedDB - update backend directly
      const backendPatient = await base44.entities.Patient.update(patientId, updates);
      await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [backendPatient]);
      notifyMutation({ type: 'update', entity: 'Patient', id: patientId, data: backendPatient });
      await broadcastChange('Patient', 'update', { id: patientId, ...options });
      await restartSmartRefresh();
      return backendPatient;
    }

    // Update locally first
    const updated = { ...existing, ...updates, updated_date: new Date().toISOString() };
    await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [updated]);
    notifyMutation({ type: 'update', entity: 'Patient', id: patientId, data: updated });

    // Sync to backend
    try {
      await base44.entities.Patient.update(patientId, updates);
      // Broadcast removed
    } catch (error) {
      console.warn('⚠️ [EntityMutations] Patient update sync failed, queuing:', error.message);
      await offlineDB.addPendingMutation({ operation: 'update', entity: 'Patient', recordId: patientId, payload: updates });
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
      // Broadcast removed
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
 * Create a Delivery (local-first)
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

    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [localDelivery]);
    notifyMutation({ type: 'create', entity: 'Delivery', id: tempId, data: localDelivery });

    try {
      const backendDelivery = await base44.entities.Delivery.create(deliveryData);
      
      const db = await offlineDB.openDatabase();
      const tx = db.transaction([offlineDB.STORES.DELIVERIES], 'readwrite');
      await new Promise((resolve, reject) => {
        const req = tx.objectStore(offlineDB.STORES.DELIVERIES).delete(tempId);
        req.onsuccess = resolve;
        req.onerror = () => reject(req.error);
      });
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [backendDelivery]);
      
      notifyMutation({ type: 'replace', entity: 'Delivery', oldId: tempId, newId: backendDelivery.id, data: backendDelivery });
      // Broadcast removed
      
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
 * Update a Delivery (local-first)
 */
export const updateDelivery = async (deliveryId, updates, options = {}) => {
  const { skipSmartRefresh = false } = options;
  if (mutationsPaused) throw new Error('Mutations are paused');
  if (!skipSmartRefresh) await pauseSmartRefresh();

  try {
    const deliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    const existing = deliveries.find(d => d.id === deliveryId);
    
    if (!existing) {
      // Not in IndexedDB - update backend directly
      try {
        const backendDelivery = await base44.entities.Delivery.update(deliveryId, updates);
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [backendDelivery]);
        notifyMutation({ type: 'update', entity: 'Delivery', id: deliveryId, data: backendDelivery });
        // Broadcast removed
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

    const updated = { ...existing, ...updates, updated_date: new Date().toISOString() };
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [updated]);

    try {
      await base44.entities.Delivery.update(deliveryId, updates);
      // Broadcast removed
    } catch (error) {
      console.warn('⚠️ [EntityMutations] Delivery update sync failed, queuing:', error.message);
      await offlineDB.addPendingMutation({ operation: 'update', entity: 'Delivery', recordId: deliveryId, payload: updates });
    }
    
    notifyMutation({ type: 'update', entity: 'Delivery', id: deliveryId, data: updated });
    if (!skipSmartRefresh) await restartSmartRefresh();
    return updated;
  } catch (error) {
    if (!skipSmartRefresh) await restartSmartRefresh();
    throw error;
  }
};

/**
 * Delete a Delivery (local-first)
 */
export const deleteDelivery = async (deliveryId, options = {}) => {
  if (mutationsPaused) throw new Error('Mutations are paused');
  await pauseSmartRefresh();

  try {
    const db = await offlineDB.openDatabase();
    const tx = db.transaction([offlineDB.STORES.DELIVERIES], 'readwrite');
    await new Promise((resolve, reject) => {
      const req = tx.objectStore(offlineDB.STORES.DELIVERIES).delete(deliveryId);
      req.onsuccess = resolve;
      req.onerror = () => reject(req.error);
    });

    try {
      await base44.entities.Delivery.delete(deliveryId);
      // Broadcast removed
    } catch (error) {
      console.warn('⚠️ [EntityMutations] Delivery delete sync failed, queuing:', error.message);
      await offlineDB.addPendingMutation({ operation: 'delete', entity: 'Delivery', recordId: deliveryId });
    }

    notifyMutation({ type: 'delete', entity: 'Delivery', id: deliveryId, data: null });
    await restartSmartRefresh();
    return true;
  } catch (error) {
    await restartSmartRefresh();
    throw error;
  }
};

/**
 * Batch create deliveries (local-first)
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

    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, localDeliveries);
    localDeliveries.forEach(d => notifyMutation({ type: 'create', entity: 'Delivery', id: d.id, data: d }));

    try {
      const backendDeliveries = await base44.entities.Delivery.bulkCreate(deliveriesData);
      
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
      
      backendDeliveries.forEach((backend, i) => {
        notifyMutation({ type: 'replace', entity: 'Delivery', oldId: localDeliveries[i].id, newId: backend.id, data: backend });
      });
      
      // Broadcast removed
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
 * Batch delete deliveries (local-first)
 */
export const batchDeleteDeliveries = async (deliveryIds, options = {}) => {
  if (mutationsPaused) throw new Error('Mutations are paused');
  await pauseSmartRefresh();

  try {
    console.log(`🗑️ [EntityMutations] Batch deleting ${deliveryIds.length} deliveries...`);
    
    // Remove all from IndexedDB
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

    // Sync to backend (batch delete via delete_entities tool)
    try {
      // Use Base44 SDK to batch delete (query-based delete)
      const deletePromises = deliveryIds.map(id => base44.entities.Delivery.delete(id));
      await Promise.all(deletePromises);
      console.log(`✅ [EntityMutations] Batch deleted ${deliveryIds.length} deliveries from backend`);
      
      // Broadcast removed
    } catch (error) {
      console.warn('⚠️ [EntityMutations] Batch delete sync failed, queuing:', error.message);
      for (const id of deliveryIds) {
        await offlineDB.addPendingMutation({ operation: 'delete', entity: 'Delivery', recordId: id });
      }
    }

    // CRITICAL: Single UI notification for all deletes (batched)
    notifyMutation({ 
      type: 'batch_delete', 
      entity: 'Delivery', 
      ids: deliveryIds,
      data: null 
    });

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