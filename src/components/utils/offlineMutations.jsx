/**
 * Offline Mutations Manager
 * Handles local-first writes for Patient, Delivery, and AppUser entities
 */

import { offlineDB } from './offlineDatabase';
import { Patient } from '@/entities/Patient';
import { Delivery } from '@/entities/Delivery';
import { AppUser } from '@/entities/AppUser';
import { City } from '@/entities/City';
import { Store } from '@/entities/Store';
import { Company } from '@/entities/Company';
import { getOfflineStoreName, OFFLINE_SYNC_ENTITY_CLIENTS } from './offlineEntityRegistry';
import { sanitizeDeliveryPayload, sanitizeDeliveryPayloads } from './deliveryPayloadSanitizer';
import { getLocalTimestamp } from './localTimeHelper';

const normalizeComparableValue = (value) => {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value && typeof value === 'object') return JSON.stringify(value);
  return value;
};

const FORCE_DELIVERY_UPDATE_FIELDS = new Set(['arrival_time', 'actual_delivery_time']);

const getMeaningfulDeliveryUpdates = async (existingDelivery, updates = {}) => {
  const sanitizedUpdates = await sanitizeDeliveryPayload(updates);
  return Object.entries(sanitizedUpdates).reduce((acc, [key, value]) => {
    const currentValue = existingDelivery?.[key];
    const isBlankString = typeof value === 'string' && value.trim() === '' && (currentValue === undefined || currentValue === null || currentValue === '');
    if (isBlankString) return acc;
    if (!FORCE_DELIVERY_UPDATE_FIELDS.has(key) && normalizeComparableValue(currentValue) === normalizeComparableValue(value)) return acc;
    acc[key] = value;
    return acc;
  }, {});
};

// Listeners for UI updates
let mutationListeners = [];
let mutationsPaused = false; // CRITICAL: Pause mutations during route optimization

/**
 * Pause offline mutations (during route optimization)
 */
export const pauseOfflineMutations = () => {
  console.log('⏸️ [OfflineMutations] Paused');
  mutationsPaused = true;
};

/**
 * Resume offline mutations
 */
export const resumeOfflineMutations = () => {
  console.log('▶️ [OfflineMutations] Resumed');
  mutationsPaused = false;
};

/**
 * Check if offline mutations are paused
 */
export const areOfflineMutationsPaused = () => mutationsPaused;

/**
 * Subscribe to mutation events
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
  // CRITICAL: Don't notify if mutations are paused
  if (mutationsPaused) {
    console.log('⏸️ [OfflineMutations] Notification skipped - mutations paused');
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

/**
 * Pause smart refresh manager before mutation
 */
const pauseSmartRefresh = async () => {
  try {
    const { smartRefreshManager } = await import('./smartRefreshManager');
    smartRefreshManager.pause();
  } catch (error) {
    console.warn('⚠️ [OfflineMutations] Failed to pause smart refresh:', error);
  }
};

/**
 * Restart smart refresh after mutation completes
 * This resumes AND resets all timers to force immediate refresh
 */
const restartSmartRefresh = async () => {
  try {
    const { smartRefreshManager } = await import('./smartRefreshManager');
    smartRefreshManager.restart();
    console.log('🔄 [OfflineMutations] Smart refresh restarted after mutation');
  } catch (error) {
    console.warn('⚠️ [OfflineMutations] Failed to restart smart refresh:', error);
  }
};

/**
 * Create a new Patient (local-first)
 */
export const createPatientLocal = async (patientData) => {
  // CRITICAL: Check if mutations are paused
  if (mutationsPaused) {
    console.log('⏸️ [OfflineMutations] createPatientLocal skipped - mutations paused');
    throw new Error('Mutations are paused during route optimization');
  }

  // CRITICAL: Pause smart refresh during mutation
  const { smartRefreshManager } = await import('./smartRefreshManager');
  smartRefreshManager.pause();

  try {
    console.log('📝 [OfflineMutations] Creating patient locally...');
    
    // Generate temporary ID if not provided
    const tempId = patientData.id || `temp_patient_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const localPatient = {
      ...patientData,
      id: tempId,
      created_date: new Date().toISOString(),
      updated_date: new Date().toISOString(),
      _isLocal: true // Mark as locally created
    };

    // Save to local IndexedDB
    await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [localPatient]);

    console.log('✅ [OfflineMutations] Patient created locally:', tempId);
    
    // CRITICAL: Notify listeners IMMEDIATELY for instant UI update
    notifyMutation({ 
      type: 'create', 
      entity: 'Patient', 
      id: tempId,
      data: localPatient 
    });

    // Try immediate backend sync
    try {
      const { base44 } = await import('@/api/base44Client');
      const backendPatient = await base44.entities.Patient.create(patientData);
      console.log('✅ [Sync] Patient synced to backend immediately:', tempId, '→', backendPatient.id);
      
      // CRITICAL: Remove temp record from IndexedDB
      const db = await offlineDB.openDatabase();
      const transaction = db.transaction([offlineDB.STORES.PATIENTS], 'readwrite');
      const store = transaction.objectStore(offlineDB.STORES.PATIENTS);
      await new Promise((resolve, reject) => {
        const request = store.delete(tempId);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      
      // Add real backend record to IndexedDB
      await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [backendPatient]);
      
      // Notify listeners to replace temp with real record
      notifyMutation({ 
        type: 'replace', 
        entity: 'Patient', 
        oldId: tempId,
        newId: backendPatient.id,
        data: backendPatient 
      });
      
      console.log('✅ [Sync] Temp patient replaced with backend patient in IndexedDB');
      
      // CRITICAL: Restart smart refresh after sync (not resume)
      smartRefreshManager.restart();
    } catch (error) {
      console.warn('⚠️ [Sync] Immediate sync failed, queuing for later:', error.message);
      // Queue for backend sync if immediate sync fails
      await offlineDB.addPendingMutation({
        operation: 'create',
        entity: 'Patient',
        recordId: tempId,
        payload: patientData
      });
      // CRITICAL: Restart smart refresh even if queued
      smartRefreshManager.restart();
    }
    
    return localPatient;
  } catch (error) {
    console.error('❌ [OfflineMutations] Failed to create patient locally:', error);
    // CRITICAL: Restart smart refresh on error
    const { smartRefreshManager } = await import('./smartRefreshManager');
    smartRefreshManager.restart();
    throw error;
  }
};

/**
 * Update a Patient (local-first)
 */
export const updatePatientLocal = async (patientId, updates) => {
  // CRITICAL: Check if mutations are paused
  if (mutationsPaused) {
    console.log('⏸️ [OfflineMutations] updatePatientLocal skipped - mutations paused');
    throw new Error('Mutations are paused during route optimization');
  }

  // CRITICAL: Register pending update BEFORE anything else to protect from smart refresh
  try {
    const { smartRefreshManager } = await import('./smartRefreshManager');
    smartRefreshManager.registerPendingPatientUpdate(patientId);
  } catch (error) {
    console.warn('⚠️ [OfflineMutations] Failed to register pending patient update:', error);
  }

  // CRITICAL: Pause smart refresh during mutation
  const { smartRefreshManager } = await import('./smartRefreshManager');
  smartRefreshManager.pause();

  try {
    console.log('📝 [OfflineMutations] Updating patient locally:', patientId);
    
    // Get current patient from IndexedDB
    const patients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
    const existingPatient = patients.find(p => p.id === patientId);
    
    if (!existingPatient) {
      throw new Error(`Patient ${patientId} not found in local database`);
    }

    // Apply updates
    const updatedPatient = {
      ...existingPatient,
      ...updates,
      updated_date: new Date().toISOString()
    };

    // Save to local IndexedDB
    await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [updatedPatient]);

    console.log('✅ [OfflineMutations] Patient updated locally:', patientId);
    
    // CRITICAL: Notify listeners IMMEDIATELY for instant UI update
    notifyMutation({ 
      type: 'update', 
      entity: 'Patient', 
      id: patientId,
      data: updatedPatient 
    });

    // Try immediate backend sync
    try {
      const { base44 } = await import('@/api/base44Client');
      await base44.entities.Patient.update(patientId, updates);
      console.log('✅ [Sync] Patient synced to backend immediately:', patientId);
      
      // CRITICAL: Restart smart refresh after sync (not resume)
      smartRefreshManager.restart();
    } catch (error) {
      console.warn('⚠️ [Sync] Immediate sync failed, queuing for later:', error.message);
      // Queue for backend sync if immediate sync fails
      await offlineDB.addPendingMutation({
        operation: 'update',
        entity: 'Patient',
        recordId: patientId,
        payload: updates
      });
      // CRITICAL: Restart smart refresh even if queued
      smartRefreshManager.restart();
    }
    
    return updatedPatient;
  } catch (error) {
    console.error('❌ [OfflineMutations] Failed to update patient locally:', error);
    // CRITICAL: Restart smart refresh on error
    const { smartRefreshManager } = await import('./smartRefreshManager');
    smartRefreshManager.restart();
    throw error;
  }
};

/**
 * Delete a Patient (local-first)
 */
export const deletePatientLocal = async (patientId) => {
  // CRITICAL: Check if mutations are paused
  if (mutationsPaused) {
    console.log('⏸️ [OfflineMutations] deletePatientLocal skipped - mutations paused');
    throw new Error('Mutations are paused during route optimization');
  }

  // CRITICAL: Pause smart refresh during mutation
  const { smartRefreshManager } = await import('./smartRefreshManager');
  smartRefreshManager.pause();

  try {
    console.log('📝 [OfflineMutations] Deleting patient locally:', patientId);

    // Remove from local IndexedDB
    const db = await offlineDB.openDatabase();
    const transaction = db.transaction([offlineDB.STORES.PATIENTS], 'readwrite');
    const store = transaction.objectStore(offlineDB.STORES.PATIENTS);
    
    await new Promise((resolve, reject) => {
      const request = store.delete(patientId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });

    console.log('✅ [OfflineMutations] Patient deleted locally:', patientId);
    
    // CRITICAL: Notify listeners IMMEDIATELY for instant UI update
    notifyMutation({ 
      type: 'delete', 
      entity: 'Patient', 
      id: patientId,
      data: null 
    });

    // Try immediate backend sync
    try {
      const { base44 } = await import('@/api/base44Client');
      await base44.entities.Patient.delete(patientId);
      console.log('✅ [Sync] Patient deletion synced to backend immediately:', patientId);
      
      // CRITICAL: Restart smart refresh after sync (not resume)
      smartRefreshManager.restart();
    } catch (error) {
      // CRITICAL: Ignore 404 errors - record doesn't exist on backend (was local-only or already deleted)
      if (error.response?.status === 404 || error.message?.includes('404') || error.message?.includes('not found')) {
        console.log('ℹ️ [Sync] Patient not found on backend (was local-only or already deleted):', patientId);
        smartRefreshManager.restart();
      } else {
        console.warn('⚠️ [Sync] Immediate sync failed, queuing for later:', error.message);
        // Queue for backend sync if immediate sync fails
        await offlineDB.addPendingMutation({
          operation: 'delete',
          entity: 'Patient',
          recordId: patientId
        });
        // CRITICAL: Restart smart refresh even if queued
        smartRefreshManager.restart();
      }
    }
    
    return true;
  } catch (error) {
    console.error('❌ [OfflineMutations] Failed to delete patient locally:', error);
    // CRITICAL: Restart smart refresh on error
    const { smartRefreshManager } = await import('./smartRefreshManager');
    smartRefreshManager.restart();
    throw error;
  }
};

/**
 * Create a new Delivery (local-first)
 */
export const createDeliveryLocal = async (deliveryData) => {
  // CRITICAL: Check if mutations are paused
  if (mutationsPaused) {
    console.log('⏸️ [OfflineMutations] createDeliveryLocal skipped - mutations paused');
    throw new Error('Mutations are paused during route optimization');
  }

  // CRITICAL: Pause smart refresh during mutation
  const { smartRefreshManager } = await import('./smartRefreshManager');
  smartRefreshManager.pause();

  try {
    console.log('📝 [OfflineMutations] Creating delivery locally...');

    const sourceDelivery = deliveryData?._isBatchSave && Array.isArray(deliveryData?._stagedDeliveries)
      ? deliveryData._stagedDeliveries[0]
      : deliveryData;

    if (!sourceDelivery?.delivery_date) {
      throw new Error('Missing delivery_date');
    }

    const normalizedDeliveryData = await sanitizeDeliveryPayload(sourceDelivery);

    // Generate temporary ID if not provided
    const tempId = normalizedDeliveryData.id || `temp_delivery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const localDelivery = {
      ...normalizedDeliveryData,
      id: tempId,
      created_date: getLocalTimestamp(),
      updated_date: getLocalTimestamp(),
      _isLocal: true // Mark as locally created
    };

    // Save to local IndexedDB
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [localDelivery]);

    console.log('✅ [OfflineMutations] Delivery created locally:', tempId);
    
    // CRITICAL: Notify listeners IMMEDIATELY for instant UI update
    notifyMutation({ 
      type: 'create', 
      entity: 'Delivery', 
      id: tempId,
      data: localDelivery 
    });

    // Try immediate backend sync
    try {
      const { base44 } = await import('@/api/base44Client');
      const backendDelivery = await base44.entities.Delivery.create(normalizedDeliveryData);
      console.log('✅ [Sync] Delivery synced to backend immediately:', tempId, '→', backendDelivery.id);
      
      // CRITICAL: Remove temp record from IndexedDB
      const db = await offlineDB.openDatabase();
      const transaction = db.transaction([offlineDB.STORES.DELIVERIES], 'readwrite');
      const store = transaction.objectStore(offlineDB.STORES.DELIVERIES);
      await new Promise((resolve, reject) => {
        const request = store.delete(tempId);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      
      // Add real backend record to IndexedDB
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [backendDelivery]);
      
      // Notify listeners to replace temp with real record
      notifyMutation({ 
        type: 'replace', 
        entity: 'Delivery', 
        oldId: tempId,
        newId: backendDelivery.id,
        data: backendDelivery 
      });
      
      console.log('✅ [Sync] Temp delivery replaced with backend delivery in IndexedDB');
      
      // CRITICAL: Restart smart refresh after sync (not resume)
      smartRefreshManager.restart();
      return backendDelivery;
    } catch (error) {
      console.warn('⚠️ [Sync] Immediate sync failed, queuing for later:', error.message);
      // Queue for backend sync if immediate sync fails
      await offlineDB.addPendingMutation({
        operation: 'create',
        entity: 'Delivery',
        recordId: tempId,
        payload: normalizedDeliveryData
      });
      // CRITICAL: Restart smart refresh even if queued
      smartRefreshManager.restart();
    }
    
    return localDelivery;
  } catch (error) {
    console.error('❌ [OfflineMutations] Failed to create delivery locally:', error);
    // CRITICAL: Restart smart refresh on error
    const { smartRefreshManager } = await import('./smartRefreshManager');
    smartRefreshManager.restart();
    throw error;
  }
};

/**
 * Update a Delivery (local-first)
 * @param {string} deliveryId - The delivery ID to update
 * @param {object} updates - The fields to update
 * @param {object} options - Options: { skipSmartRefresh: boolean }
 */
export const updateDeliveryLocal = async (deliveryId, updates, options = {}) => {
  const { skipSmartRefresh = false, isBatchOperation = false } = options;
  console.warn('[OfflineMutations][updateDeliveryLocal] incoming', { deliveryId, updates, options });
  
  // CRITICAL: Check if mutations are paused
  if (mutationsPaused) {
    console.log('⏸️ [OfflineMutations] updateDeliveryLocal skipped - mutations paused');
    throw new Error('Mutations are paused during route optimization');
  }

  // CRITICAL: Pause smart refresh during mutation (unless skipped or in batch operation)
  let smartRefreshManager = null;
  if (!skipSmartRefresh && !isBatchOperation) {
    const module = await import('./smartRefreshManager');
    smartRefreshManager = module.smartRefreshManager;
    smartRefreshManager.pause();
  }

  try {
    console.log('📝 [OfflineMutations] Updating delivery:', deliveryId);
    
    // Get current delivery from IndexedDB
    const deliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    const existingDelivery = deliveries.find(d => d.id === deliveryId);
    
    // CRITICAL: If delivery not in IndexedDB, update backend FIRST, then add to IndexedDB
    if (!existingDelivery) {
      console.log('⚠️ [OfflineMutations] Delivery not in IndexedDB - syncing to backend first:', deliveryId);

      try {
        const meaningfulUpdates = await sanitizeDeliveryPayload(updates);
        if (Object.keys(meaningfulUpdates).length === 0) {
          return null;
        }
        // Update backend immediately
        const { base44 } = await import('@/api/base44Client');
        const backendDelivery = await base44.entities.Delivery.update(deliveryId, meaningfulUpdates);
        console.log('✅ [Sync] Delivery updated on backend:', deliveryId);
        
        // Broadcast removed

        // Add to IndexedDB
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [backendDelivery]);
        console.log('✅ [OfflineMutations] Added backend delivery to IndexedDB:', deliveryId);

        // Notify listeners for UI update
        notifyMutation({ 
          type: 'update', 
          entity: 'Delivery', 
          id: deliveryId,
          data: backendDelivery 
        });

        // CRITICAL: Restart smart refresh after sync (unless skipped)
        if (!skipSmartRefresh && smartRefreshManager) {
          smartRefreshManager.restart();
        }

        return backendDelivery;
      } catch (error) {
        // CRITICAL: Handle case where delivery was deleted from backend
        if (error.message?.includes('not found') || error.message?.includes('404')) {
          console.warn('⚠️ [OfflineMutations] Delivery no longer exists in backend:', deliveryId);
          // Notify listeners to remove from UI
          notifyMutation({ 
            type: 'delete', 
            entity: 'Delivery', 
            id: deliveryId,
            data: null 
          });
          // CRITICAL: Restart smart refresh on error
          if (!skipSmartRefresh && smartRefreshManager) {
            smartRefreshManager.restart();
          }
          return null;
        }
        // CRITICAL: Restart smart refresh on error
        if (!skipSmartRefresh && smartRefreshManager) {
          smartRefreshManager.restart();
        }
        throw error;
      }
    }

    const meaningfulUpdates = await getMeaningfulDeliveryUpdates(existingDelivery, updates);
    if (Object.keys(meaningfulUpdates).length === 0) {
      return existingDelivery;
    }

    if ('actual_delivery_time' in meaningfulUpdates || 'arrival_time' in meaningfulUpdates) {
      console.warn('[OfflineMutations][Retro] meaningful updates', {
        deliveryId,
        existing_actual_delivery_time: existingDelivery?.actual_delivery_time || null,
        existing_arrival_time: existingDelivery?.arrival_time || null,
        incoming_actual_delivery_time: updates?.actual_delivery_time || null,
        incoming_arrival_time: updates?.arrival_time || null,
        meaningful_actual_delivery_time: meaningfulUpdates?.actual_delivery_time || null,
        meaningful_arrival_time: meaningfulUpdates?.arrival_time || null
      });
    }

    // Apply updates
    const updatedDelivery = {
      ...existingDelivery,
      ...meaningfulUpdates,
      updated_date: getLocalTimestamp()
    };

    if ('actual_delivery_time' in updatedDelivery || 'arrival_time' in updatedDelivery) {
      console.warn('[OfflineMutations][Retro] saving locally', {
        deliveryId,
        saved_actual_delivery_time: updatedDelivery?.actual_delivery_time || null,
        saved_arrival_time: updatedDelivery?.arrival_time || null,
        updated_date: updatedDelivery?.updated_date || null
      });
    }

    // Save to local IndexedDB FIRST
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [updatedDelivery]);
    console.log('✅ [OfflineMutations] Delivery updated locally:', deliveryId);

    // CRITICAL: Notify listeners with only changed fields to avoid false downstream updates
    notifyMutation({ 
      type: 'update', 
      entity: 'Delivery', 
      id: deliveryId,
      data: { ...meaningfulUpdates, updated_date: updatedDelivery.updated_date }
    });
    console.log('🔔 [OfflineMutations] UI notified immediately after local save');

    // CRITICAL: Sync to backend in background (don't block UI update)
    // For batch operations, queue mutation to avoid rate limits
    if (isBatchOperation) {
      await offlineDB.addPendingMutation({
        operation: 'update',
        entity: 'Delivery',
        recordId: deliveryId,
        payload: meaningfulUpdates
      });
    } else {
      try {
        const { base44 } = await import('@/api/base44Client');
        await base44.entities.Delivery.update(deliveryId, meaningfulUpdates);
        console.log('✅ [Sync] Delivery synced to backend immediately:', deliveryId);
        
        // Broadcast removed
      } catch (error) {
        console.warn('⚠️ [Sync] Immediate sync failed, queuing for later:', error.message);
        // Queue for backend sync if immediate sync fails
        await offlineDB.addPendingMutation({
          operation: 'update',
          entity: 'Delivery',
          recordId: deliveryId,
          payload: meaningfulUpdates
        });
      }
    }

    // CRITICAL: NO restart during batch operations - caller handles it once at the end
    // Only restart if explicitly not batch and not skipped
    if (!isBatchOperation && !skipSmartRefresh && smartRefreshManager) {
      smartRefreshManager.restart();
    }
    
    return updatedDelivery;
  } catch (error) {
    console.error('❌ [OfflineMutations] Failed to update delivery:', error);
    // CRITICAL: Restart smart refresh on error (unless in batch operation)
    if (!skipSmartRefresh && !isBatchOperation && smartRefreshManager) {
      smartRefreshManager.restart();
    }
    throw error;
  }
};

/**
 * Delete a Delivery (local-first)
 * CRITICAL: Ensures both offline DB AND online entity are deleted together with mutations tracked
 */
export const deleteDeliveryLocal = async (deliveryId) => {
  // CRITICAL: Check if mutations are paused
  if (mutationsPaused) {
    console.log('⏸️ [OfflineMutations] deleteDeliveryLocal skipped - mutations paused');
    throw new Error('Mutations are paused during route optimization');
  }

  // CRITICAL: Pause smart refresh during mutation
  const { smartRefreshManager } = await import('./smartRefreshManager');
  smartRefreshManager.pause();

  try {
    console.log('📝 [OfflineMutations] Deleting delivery locally:', deliveryId);

    // Step 1: CRITICAL - Delete from BOTH offline DB AND backend simultaneously
    const offlineDeletePromise = (async () => {
      try {
        const existing = await offlineDB.getById(offlineDB.STORES.DELIVERIES, deliveryId);
        if (!existing) {
          console.log('ℹ️ [OfflineMutations] Delivery not found in offline DB (already deleted):', deliveryId);
          return { success: true, wasMissing: true };
        }

        const db = await offlineDB.openDatabase();
        const transaction = db.transaction([offlineDB.STORES.DELIVERIES], 'readwrite');
        const store = transaction.objectStore(offlineDB.STORES.DELIVERIES);

        await new Promise((resolve, reject) => {
          const request = store.delete(deliveryId);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });

        return { success: true };
      } catch (error) {
        const isMissingOffline = String(error?.message || '').toLowerCase().includes('not found') || String(error?.message || '').toLowerCase().includes('no record');
        if (isMissingOffline) {
          console.log('ℹ️ [OfflineMutations] Delivery not found in offline DB (already deleted):', deliveryId);
          return { success: true, wasMissing: true };
        }
        throw error;
      }
    })();

    const backendDeletePromise = (async () => {
      try {
        const { base44 } = await import('@/api/base44Client');
        await base44.entities.Delivery.delete(deliveryId);
        return { success: true };
      } catch (error) {
        // CRITICAL: Ignore 404 errors - record doesn't exist on backend (was local-only or already deleted)
        if (error.response?.status === 404 || error.message?.includes('404') || error.message?.includes('not found')) {
          console.log('ℹ️ [Sync] Delivery not found on backend (was local-only or already deleted):', deliveryId);
          return { success: true, was404: true };
        }
        // CRITICAL: Return error but don't throw - we need to queue mutation
        return { success: false, error };
      }
    })();

    // Execute both operations in parallel
    const [, backendResult] = await Promise.all([offlineDeletePromise, backendDeletePromise]);

    console.log('✅ [OfflineMutations] Delivery deleted from offline DB:', deliveryId);

    // Step 2: CRITICAL - Handle backend sync result and queue mutation if needed
    if (backendResult.success) {
      console.log('✅ [Sync] Delivery deletion synced to backend immediately:', deliveryId);
    } else {
      console.warn('⚠️ [Sync] Backend deletion failed, queuing mutation for retry:', backendResult.error?.message);
      // CRITICAL: Queue mutation so it retries later
      await offlineDB.addPendingMutation({
        operation: 'delete',
        entity: 'Delivery',
        recordId: deliveryId
      });
    }

    // Step 3: CRITICAL - Notify listeners AFTER both DB operations complete
    notifyMutation({ 
      type: 'delete', 
      entity: 'Delivery', 
      id: deliveryId,
      data: null 
    });
    window.dispatchEvent(new CustomEvent('deliveryUpdated', {
      detail: {
        deliveryId,
        updates: null,
        source: 'deleteDeliveryLocal',
        deleted: true
      }
    }));
    console.log('🔔 [OfflineMutations] Listeners notified of deletion');

    // CRITICAL: Restart smart refresh after all operations complete
    smartRefreshManager.restart();
    
    return true;
  } catch (error) {
    console.error('❌ [OfflineMutations] Failed to delete delivery locally:', error);
    // CRITICAL: Ensure mutation is queued even on error
    try {
      await offlineDB.addPendingMutation({
        operation: 'delete',
        entity: 'Delivery',
        recordId: deliveryId
      });
      console.log('⚠️ [OfflineMutations] Queued delete mutation on error');
    } catch (queueError) {
      console.error('❌ [OfflineMutations] Failed to queue mutation:', queueError);
    }
    
    // CRITICAL: Restart smart refresh on error
    smartRefreshManager.restart();
    throw error;
  }
};

/**
 * Batch create multiple deliveries (local-first)
 */
export const batchCreateDeliveriesLocal = async (deliveriesData) => {
  // CRITICAL: Check if mutations are paused
  if (mutationsPaused) {
    console.log('⏸️ [OfflineMutations] batchCreateDeliveriesLocal skipped - mutations paused');
    throw new Error('Mutations are paused during route optimization');
  }

  // CRITICAL: Pause smart refresh during mutation
  const { smartRefreshManager } = await import('./smartRefreshManager');
  smartRefreshManager.pause();

  try {
    console.log('📝 [OfflineMutations] Batch creating deliveries locally:', deliveriesData.length);
    
    const localDeliveries = deliveriesData.map(d => ({
      ...d,
      id: d.id || `temp_delivery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      created_date: new Date().toISOString(),
      updated_date: new Date().toISOString(),
      _isLocal: true
    }));

    // Save all to local IndexedDB
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, localDeliveries);

    console.log('✅ [OfflineMutations] Batch deliveries created locally');
    
    // CRITICAL: Notify listeners for each delivery for instant UI update
    localDeliveries.forEach(delivery => {
      notifyMutation({ 
        type: 'create', 
        entity: 'Delivery', 
        id: delivery.id,
        data: delivery 
      });
    });

    // Try immediate backend sync
    try {
      const { base44 } = await import('@/api/base44Client');
      const backendPayloads = await sanitizeDeliveryPayloads(deliveriesData);
      const backendDeliveries = await base44.entities.Delivery.bulkCreate(backendPayloads);
      console.log(`✅ [Sync] ${localDeliveries.length} deliveries synced to backend immediately`);
      
      // CRITICAL: Remove all temp records from IndexedDB
      const db = await offlineDB.openDatabase();
      const transaction = db.transaction([offlineDB.STORES.DELIVERIES], 'readwrite');
      const store = transaction.objectStore(offlineDB.STORES.DELIVERIES);
      
      for (const localDelivery of localDeliveries) {
        await new Promise((resolve, reject) => {
          const request = store.delete(localDelivery.id);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      }
      
      // Add all real backend records to IndexedDB
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, backendDeliveries);
      
      // Notify listeners to replace temp records with real records
      backendDeliveries.forEach((backendDelivery, index) => {
        notifyMutation({ 
          type: 'replace', 
          entity: 'Delivery', 
          oldId: localDeliveries[index].id,
          newId: backendDelivery.id,
          data: backendDelivery 
        });
      });
      
      console.log('✅ [Sync] All temp deliveries replaced with backend deliveries in IndexedDB');
      
      // CRITICAL: Restart smart refresh after sync (not resume)
      smartRefreshManager.restart();
      return backendDeliveries;
    } catch (error) {
      const isValidationError = error?.response?.status === 400 || error?.response?.status === 422 || /validation|invalid|schema|field|type/i.test(error?.message || '');

      if (isValidationError) {
        console.error('❌ [Sync] Bulk create rejected by backend validation:', error.message);
        for (const delivery of localDeliveries) {
          await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, delivery.id).catch(() => null);
          notifyMutation({
            type: 'delete',
            entity: 'Delivery',
            id: delivery.id,
            data: null
          });
        }
        smartRefreshManager.restart();
        throw error;
      }

      console.warn('⚠️ [Sync] Immediate bulk sync failed, queuing for later:', error.message);
      for (const delivery of localDeliveries) {
        await offlineDB.addPendingMutation({
          operation: 'create',
          entity: 'Delivery',
          recordId: delivery.id,
          payload: await sanitizeDeliveryPayload(delivery)
        });
      }
      smartRefreshManager.restart();
    }
    
    return localDeliveries;
  } catch (error) {
    console.error('❌ [OfflineMutations] Failed to batch create deliveries locally:', error);
    // CRITICAL: Restart smart refresh on error
    const { smartRefreshManager } = await import('./smartRefreshManager');
    smartRefreshManager.restart();
    throw error;
  }
};

const buildTempEntityId = (entityName) => `temp_${entityName.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

const createGenericEntityLocal = async (entityName, entityData) => {
  if (mutationsPaused) {
    throw new Error('Mutations are paused during route optimization');
  }

  const Entity = OFFLINE_SYNC_ENTITY_CLIENTS[entityName];
  const storeName = getOfflineStoreName(offlineDB, entityName);
  if (!Entity || !storeName) {
    throw new Error(`Unsupported offline entity: ${entityName}`);
  }

  const { smartRefreshManager } = await import('./smartRefreshManager');
  smartRefreshManager.pause();

  try {
    const tempId = entityData.id || buildTempEntityId(entityName);
    const localRecord = {
      ...entityData,
      id: tempId,
      created_date: new Date().toISOString(),
      updated_date: new Date().toISOString(),
      _isLocal: true
    };

    await offlineDB.bulkSave(storeName, [localRecord]);
    notifyMutation({ type: 'create', entity: entityName, id: tempId, data: localRecord });

    try {
      const backendRecord = await Entity.create(entityData);
      await offlineDB.deleteRecord(storeName, tempId);
      await offlineDB.bulkSave(storeName, [backendRecord]);
      notifyMutation({ type: 'replace', entity: entityName, oldId: tempId, newId: backendRecord.id, data: backendRecord });
      smartRefreshManager.restart();
      return backendRecord;
    } catch (error) {
      await offlineDB.addPendingMutation({
        operation: 'create',
        entity: entityName,
        recordId: tempId,
        payload: entityData
      });
      smartRefreshManager.restart();
      return localRecord;
    }
  } catch (error) {
    smartRefreshManager.restart();
    throw error;
  }
};

const updateGenericEntityLocal = async (entityName, recordId, updates) => {
  if (mutationsPaused) {
    throw new Error('Mutations are paused during route optimization');
  }

  const Entity = OFFLINE_SYNC_ENTITY_CLIENTS[entityName];
  const storeName = getOfflineStoreName(offlineDB, entityName);
  if (!Entity || !storeName) {
    throw new Error(`Unsupported offline entity: ${entityName}`);
  }

  const { smartRefreshManager } = await import('./smartRefreshManager');
  smartRefreshManager.pause();

  try {
    const existingRecord = await offlineDB.getById(storeName, recordId);
    if (!existingRecord) {
      throw new Error(`${entityName} ${recordId} not found in local database`);
    }

    const updatedRecord = {
      ...existingRecord,
      ...updates,
      updated_date: new Date().toISOString()
    };

    await offlineDB.bulkSave(storeName, [updatedRecord]);
    notifyMutation({ type: 'update', entity: entityName, id: recordId, data: updatedRecord });

    try {
      await Entity.update(recordId, updates);
    } catch (error) {
      await offlineDB.addPendingMutation({
        operation: 'update',
        entity: entityName,
        recordId,
        payload: updates
      });
    }

    smartRefreshManager.restart();
    return updatedRecord;
  } catch (error) {
    smartRefreshManager.restart();
    throw error;
  }
};

const deleteGenericEntityLocal = async (entityName, recordId) => {
  if (mutationsPaused) {
    throw new Error('Mutations are paused during route optimization');
  }

  const Entity = OFFLINE_SYNC_ENTITY_CLIENTS[entityName];
  const storeName = getOfflineStoreName(offlineDB, entityName);
  if (!Entity || !storeName) {
    throw new Error(`Unsupported offline entity: ${entityName}`);
  }

  const { smartRefreshManager } = await import('./smartRefreshManager');
  smartRefreshManager.pause();

  try {
    await offlineDB.deleteRecord(storeName, recordId);
    notifyMutation({ type: 'delete', entity: entityName, id: recordId, data: null });

    try {
      await Entity.delete(recordId);
    } catch (error) {
      if (!(error.response?.status === 404 || error.message?.includes('404') || error.message?.includes('not found'))) {
        await offlineDB.addPendingMutation({
          operation: 'delete',
          entity: entityName,
          recordId
        });
      }
    }

    smartRefreshManager.restart();
    return true;
  } catch (error) {
    smartRefreshManager.restart();
    throw error;
  }
};

export const createCityLocal = (cityData) => createGenericEntityLocal('City', cityData);
export const updateCityLocal = (cityId, updates) => updateGenericEntityLocal('City', cityId, updates);
export const deleteCityLocal = (cityId) => deleteGenericEntityLocal('City', cityId);

export const createStoreLocal = (storeData) => createGenericEntityLocal('Store', storeData);
export const updateStoreLocal = (storeId, updates) => updateGenericEntityLocal('Store', storeId, updates);
export const deleteStoreLocal = (storeId) => deleteGenericEntityLocal('Store', storeId);

export const createCompanyLocal = (companyData) => createGenericEntityLocal('Company', companyData);
export const updateCompanyLocal = (companyId, updates) => updateGenericEntityLocal('Company', companyId, updates);
export const deleteCompanyLocal = (companyId) => deleteGenericEntityLocal('Company', companyId);