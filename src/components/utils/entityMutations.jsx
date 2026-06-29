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
// UTILITY: Sanitize actual_delivery_time
// ========================================

/**
 * Removes timezone offsets from actual_delivery_time string
 * Converts "2025-01-15T14:30:00-07:00" to "2025-01-15T14:30:00"
 */
const sanitizeActualDeliveryTime = (timeString) => {
  if (!timeString || typeof timeString !== 'string') return timeString;
  
  // Remove timezone offsets: -07:00, +05:00, Z, etc.
  return timeString.replace(/([+-]\d{2}:?\d{2}|Z)$/, '');
};

/**
 * Sanitizes delivery data before saving
 * Ensures actual_delivery_time has no timezone offset
 */
const sanitizeDeliveryData = (deliveryData) => {
  if (!deliveryData) return deliveryData;

  const source = deliveryData._isBatchSave && Array.isArray(deliveryData._stagedDeliveries) && deliveryData._stagedDeliveries.length === 1
    ? deliveryData._stagedDeliveries[0]
    : deliveryData;

  const sanitized = { ...source };
  delete sanitized._isBatchSave;
  delete sanitized._stagedDeliveries;
  delete sanitized._originalDriverId;
  delete sanitized._driverWasChanged;
  delete sanitized._tempId;
  delete sanitized.isNew;
  delete sanitized.latitude;
  delete sanitized.longitude;
  delete sanitized.store_name;
  delete sanitized.store_abbreviation;
  delete sanitized.distanceFromStore;
  delete sanitized.delivery_address;
  delete sanitized.patient_name;
  delete sanitized.patient_phone;
  delete sanitized.store_phone;
  delete sanitized.cod_amount;
  delete sanitized.cod_payment_type;

  if (sanitized.actual_delivery_time) {
    sanitized.actual_delivery_time = sanitizeActualDeliveryTime(sanitized.actual_delivery_time);
  }

  return sanitized;
};

// Lazy load broadcastMutation / pause helpers to avoid circular dependency issues
const broadcastMutation = async (entity, action, id, data, ids = null) => {
  try {
    const { broadcastMutation: broadcast } = await import('./realtimeSync');
    return broadcast(entity, action, id, data, ids);
  } catch (error) {
    console.warn('[EntityMutations] Could not broadcast mutation:', error.message);
  }
};

const pauseRealtime = async () => {
  try {
    const { pauseRealtimeSync } = await import('./realtimeSync');
    pauseRealtimeSync();
  } catch {}
};

const resumeRealtime = async () => {
  try {
    const { resumeRealtimeSync } = await import('./realtimeSync');
    resumeRealtimeSync();
  } catch {}
};

const emitImmediateRealtimeCreate = async (entity, record) => {
  if (!record?.id) return;
  try {
    const { cityFilteredRealtimeSync } = await import('./cityFilteredRealtimeSync');
    cityFilteredRealtimeSync.notifySubscribers(entity, 'create', record);
  } catch (error) {
    console.warn('[EntityMutations] Could not emit immediate realtime create:', error.message);
  }
};

const refreshOfflineEntitySnapshots = async (entityName, record = null) => {
  try {
    if (entityName === 'Patient') {
      const allPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
      await offlineDB.updateCacheSnapshot('Patient', allPatients || [], { scopeKey: 'global', syncType: 'mutation' });
      return;
    }

    if (entityName === 'Delivery') {
      const allDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
      await offlineDB.updateCacheSnapshot('Delivery', allDeliveries || [], { scopeKey: 'global', syncType: 'mutation' });
      const deliveryDate = record?.delivery_date;
      if (deliveryDate) {
        await offlineDB.updateCacheSnapshot('Delivery', (allDeliveries || []).filter(d => d?.delivery_date === deliveryDate), { scopeKey: `date:${deliveryDate}`, syncType: 'mutation' });
      }
    }
  } catch (error) {
    console.warn('[EntityMutations] Failed to refresh offline cache snapshot:', error.message);
  }
};

let creatorAppUserPromise = null;
const getCurrentCreatorAppUserId = async () => {
  if (!creatorAppUserPromise) {
    creatorAppUserPromise = (async () => {
      const me = await base44.auth.me();
      if (!me?.id) return null;
      const appUsers = await base44.entities.AppUser.filter({ user_id: me.id }, '-updated_date', 1);
      return appUsers?.[0]?.id || null;
    })().catch(() => null);
  }
  return creatorAppUserPromise;
};

// ========================================
// LISTENERS & STATE
// ========================================

let mutationListeners = [];
let mutationsPaused = false;
let isBatchFormSaving = false; // CRITICAL: Track if Add To Route form is batch saving

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
 * Set batch form saving state (prevents SmartRefresh spam during batch operations)
 */
export const setBatchFormSaving = (isSaving) => {
  console.log(`${isSaving ? '🔒' : '🔓'} [EntityMutations] Batch form saving: ${isSaving}`);
  isBatchFormSaving = isSaving;
};

/**
 * Check if batch form is saving
 */
export const isBatchFormSavingActive = () => isBatchFormSaving;

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
  // CRITICAL: Skip restart if batch form is saving (prevents spam during Add To Route)
  if (isBatchFormSaving) {
    console.log('⏭️ [EntityMutations] Skipping SmartRefresh restart - batch form saving active');
    return;
  }
  
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
      await refreshOfflineEntitySnapshots('Patient', backendPatient);
      
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
  await pauseRealtime();

  try {
    const patients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
    const existing = patients.find(p => p.id === patientId);
    
    if (!existing) {
      // Not in IndexedDB - update backend directly, then sync to local
      try {
        const backendPatient = await base44.entities.Patient.update(patientId, updates);
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, [backendPatient]);
        
        // CRITICAL: Update cache directly to prevent UI flickering
        const { updateCache } = await import('./dataManager');
        updateCache('Patient', patientId, backendPatient);
        
        notifyMutation({ type: 'update', entity: 'Patient', id: patientId, data: backendPatient });
        await resumeRealtime();
        await restartSmartRefresh();
        return backendPatient;
      } catch (error) {
        if (error.message?.includes('not found') || error.message?.includes('404') || error.response?.status === 404) {
          notifyMutation({ type: 'delete', entity: 'Patient', id: patientId, data: null });
          await resumeRealtime();
          await restartSmartRefresh();
          return null;
        }
        throw error;
      }
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
      await refreshOfflineEntitySnapshots('Patient', backendPatient);
      
      // STEP 4: CRITICAL - Update cache directly to prevent UI flickering
      const { updateCache } = await import('./dataManager');
      updateCache('Patient', patientId, backendPatient);
      console.log('⚡ [EntityMutations] Updated Patient cache');
      
      // STEP 5: Notify UI with backend version
      notifyMutation({ type: 'update', entity: 'Patient', id: patientId, data: backendPatient });
      
      // CRITICAL: Broadcast patient update event to delivery forms
      window.dispatchEvent(new CustomEvent('patientUpdated', {
        detail: { patientId, updates: backendPatient }
      }));
      
      // Broadcast to other devices
      broadcastMutation('Patient', 'update', patientId, backendPatient);
      
    } catch (error) {
      if (error.message?.includes('not found') || error.message?.includes('404') || error.response?.status === 404) {
        console.warn('⚠️ [EntityMutations] Patient no longer exists, removing stale local record:', patientId);
        const db = await offlineDB.openDatabase();
        const tx = db.transaction([offlineDB.STORES.PATIENTS], 'readwrite');
        await new Promise((resolve, reject) => {
          const req = tx.objectStore(offlineDB.STORES.PATIENTS).delete(patientId);
          req.onsuccess = resolve;
          req.onerror = () => reject(req.error);
        });
        notifyMutation({ type: 'delete', entity: 'Patient', id: patientId, data: null });
        await restartSmartRefresh();
        return null;
      }

      console.warn('⚠️ [EntityMutations] Patient update sync failed, queuing:', error.message);
      await offlineDB.addPendingMutation({ operation: 'update', entity: 'Patient', recordId: patientId, payload: updates });
      
      // Notify UI with local version if backend fails
      notifyMutation({ type: 'update', entity: 'Patient', id: patientId, data: updated });
    }

    await resumeRealtime();
    await restartSmartRefresh();
    return updated;
  } catch (error) {
    await resumeRealtime();
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

    // CRITICAL: Remove deleted patient from all caches and forms immediately
    const { removeDeletedFromCache, invalidate } = await import('./dataManager');
    removeDeletedFromCache('Patient', [patientId]);
    invalidate('Patient');
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('patientDeleted', {
        detail: { patientId }
      }));
    }

    // Sync to backend
    try {
      await base44.entities.Patient.delete(patientId);
      
      // CRITICAL: Mark as deleted in smart refresh to prevent resurrection
      const { smartRefreshManager } = await import('./smartRefreshManager');
      smartRefreshManager.deletedPatientIds.add(patientId);
      
      // Broadcast to other devices
      broadcastMutation('Patient', 'delete', patientId, null);
    } catch (error) {
      if (error.message?.includes('not found') || error.message?.includes('404') || error.response?.status === 404) {
        const { smartRefreshManager } = await import('./smartRefreshManager');
        smartRefreshManager.deletedPatientIds.add(patientId);
      } else {
        console.warn('⚠️ [EntityMutations] Patient delete sync failed, queuing:', error.message);
        await offlineDB.addPendingMutation({ operation: 'delete', entity: 'Patient', recordId: patientId });
      }
    }

    await refreshOfflineEntitySnapshots('Patient');
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
    // CRITICAL: Sanitize actual_delivery_time before saving
    const sanitizedData = sanitizeDeliveryData(deliveryData);
    const creatorAppUserId = await getCurrentCreatorAppUserId();
    const payloadWithCreator = {
      ...sanitizedData,
      created_by_app_user_id: sanitizedData.created_by_app_user_id || creatorAppUserId || ''
    };
    
    const tempId = `temp_delivery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const localDelivery = {
      ...payloadWithCreator,
      id: tempId,
      created_date: new Date().toISOString(),
      updated_date: new Date().toISOString(),
      _isLocal: true
    };

    // STEP 1: Save to IndexedDB with temp ID
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [localDelivery]);
    notifyMutation({ type: 'create', entity: 'Delivery', id: tempId, data: localDelivery });

    try {
      // STEP 2: Create on backend (with creator attached)
      const backendDelivery = await base44.entities.Delivery.create(payloadWithCreator);
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
      await refreshOfflineEntitySnapshots('Delivery', backendDelivery);
      if (!options?.deferPolylineRefresh && backendDelivery?.driver_id && backendDelivery?.delivery_date) {
        await base44.functions.invoke('purgeAndRegeneratePolylines', {
          driverId: backendDelivery.driver_id,
          deliveryDate: backendDelivery.delivery_date,
          scope: 'active_only',
          reason: 'stops_added'
        }).catch(() => null);
      }
      
      // STEP 4: CRITICAL - Update cache directly (will be added via notifyMutation)
      // For creates, the cache will be updated through the mutation listener
      console.log('⚡ [EntityMutations] Created Delivery, cache will update via listener');
      
      // STEP 5: Notify UI to replace temp with real
      notifyMutation({ type: 'replace', entity: 'Delivery', oldId: tempId, newId: backendDelivery.id, data: backendDelivery });
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('offlineMutationRecordReplaced', {
          detail: {
            entity: 'Delivery',
            oldId: tempId,
            record: backendDelivery
          }
        }));
      }
      
      // Broadcast to other devices
      await broadcastMutation('Delivery', 'create', backendDelivery.id, backendDelivery);
      await emitImmediateRealtimeCreate('Delivery', backendDelivery);
      
      await restartSmartRefresh();
      return backendDelivery;
    } catch (error) {
      console.warn('⚠️ [EntityMutations] Delivery sync failed, queuing:', error.message);
      await offlineDB.addPendingMutation({ operation: 'create', entity: 'Delivery', recordId: tempId, payload: payloadWithCreator });
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
  const { skipSmartRefresh = false, isBatchOperation = false } = options;
  
  if (mutationsPaused) throw new Error('Mutations are paused');
  
  // CRITICAL: Sanitize actual_delivery_time before updating
  const sanitizedUpdates = sanitizeDeliveryData(updates);
  
  // CRITICAL: Skip ALL SmartRefresh operations during batch
  const shouldManageSmartRefresh = !skipSmartRefresh && !isBatchOperation;
  if (shouldManageSmartRefresh) await pauseSmartRefresh();

  try {
    const deliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    const existing = deliveries.find(d => d.id === deliveryId);
    
    if (!existing) {
      // Not in IndexedDB - update backend directly, then sync to local
      try {
        const backendDelivery = await base44.entities.Delivery.update(deliveryId, sanitizedUpdates);
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [backendDelivery]);
        
        // CRITICAL: Update cache directly to prevent UI flickering
        const { updateCache } = await import('./dataManager');
        updateCache('Delivery', deliveryId, backendDelivery);
        
        notifyMutation({ type: 'update', entity: 'Delivery', id: deliveryId, data: backendDelivery });
        if (shouldManageSmartRefresh) await restartSmartRefresh();
        return backendDelivery;
      } catch (error) {
        if (error.message?.includes('not found') || error.message?.includes('404')) {
          notifyMutation({ type: 'delete', entity: 'Delivery', id: deliveryId, data: null });
          if (shouldManageSmartRefresh) await restartSmartRefresh();
          return null;
        }
        if (shouldManageSmartRefresh) await restartSmartRefresh();
        throw error;
      }
    }

    // STEP 1: Update IndexedDB locally FIRST
    const updated = { ...existing, ...sanitizedUpdates, updated_date: new Date().toISOString() };
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [updated]);
    console.log('💾 [EntityMutations] Updated IndexedDB for:', deliveryId);

    // STEP 2: Update backend (sync to server)
    try {
      const backendDelivery = await base44.entities.Delivery.update(deliveryId, sanitizedUpdates);
      console.log('☁️ [EntityMutations] Backend updated for:', deliveryId);
      
      // STEP 3: Update IndexedDB with backend response (authoritative version)
      // CRITICAL: Preserve polyline fields that may not be returned in partial update responses
      const existingForMerge = deliveries.find(d => d.id === deliveryId);
      const deliveryToStore = existingForMerge ? {
        ...backendDelivery,
        encoded_polyline: backendDelivery.encoded_polyline ?? existingForMerge.encoded_polyline,
        estimated_distance_km: backendDelivery.estimated_distance_km ?? existingForMerge.estimated_distance_km,
        estimated_duration_minutes: backendDelivery.estimated_duration_minutes ?? existingForMerge.estimated_duration_minutes
      } : backendDelivery;
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [deliveryToStore]);
      await refreshOfflineEntitySnapshots('Delivery', deliveryToStore);
      
      // STEP 4: CRITICAL - Update cache directly to prevent UI flickering
      const { updateCache } = await import('./dataManager');
      updateCache('Delivery', deliveryId, backendDelivery);
      console.log('⚡ [EntityMutations] Updated Delivery cache');
      
      // STEP 5: Notify UI with backend version (most up-to-date)
      notifyMutation({ type: 'update', entity: 'Delivery', id: deliveryId, data: backendDelivery });
      
      // Broadcast to other devices immediately
      await broadcastMutation('Delivery', 'update', deliveryId, backendDelivery);
      
    } catch (error) {
      console.warn('⚠️ [EntityMutations] Delivery update sync failed, queuing:', error.message);
      await offlineDB.addPendingMutation({ operation: 'update', entity: 'Delivery', recordId: deliveryId, payload: sanitizedUpdates });
      
      // STEP 5 (fallback): Notify UI with local version if backend fails
      notifyMutation({ type: 'update', entity: 'Delivery', id: deliveryId, data: updated });
    }
    
    // CRITICAL: keep Smart Refresh calm after direct delivery edits
    if (shouldManageSmartRefresh) {
      const { smartRefreshManager } = await import('./smartRefreshManager');
      smartRefreshManager.resetTimers();
      await restartSmartRefresh();
    }
    return updated;
  } catch (error) {
    if (shouldManageSmartRefresh) await restartSmartRefresh();
    throw error;
  }
};

/**
 * Delete a Delivery (local-first with guaranteed cache refresh)
 * CRITICAL: Skips if delivery doesn't exist in offline or online DB
 */
export const deleteDelivery = async (deliveryId, options = {}) => {
  if (mutationsPaused) throw new Error('Mutations are paused');
  await pauseSmartRefresh();

  try {
    // STEP 1: Check if exists in IndexedDB and delete
    let existedOffline = false;
    let deletedDeliverySnapshot = null;
    try {
      const deliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
      const exists = deliveries.find(d => d.id === deliveryId);
      
      if (exists) {
        deletedDeliverySnapshot = exists;
        const db = await offlineDB.openDatabase();
        const tx = db.transaction([offlineDB.STORES.DELIVERIES], 'readwrite');
        await new Promise((resolve, reject) => {
          const req = tx.objectStore(offlineDB.STORES.DELIVERIES).delete(deliveryId);
          req.onsuccess = resolve;
          req.onerror = () => reject(req.error);
        });
        existedOffline = true;
        console.log('💾 [EntityMutations] Deleted from IndexedDB:', deliveryId);
      } else {
        console.log('⏭️ [EntityMutations] Not in IndexedDB, skipping offline delete:', deliveryId);
      }
    } catch (offlineError) {
      console.warn('⚠️ [EntityMutations] IndexedDB delete check failed:', offlineError.message);
    }

    // STEP 2: Delete from backend (skip if not found)
    let existedOnline = false;
    try {
      await base44.entities.Delivery.delete(deliveryId);
      existedOnline = true;
      console.log('☁️ [EntityMutations] Backend deleted:', deliveryId);
    } catch (error) {
      if (error.message?.includes('not found') || error.message?.includes('404') || error.response?.status === 404) {
        console.log('⏭️ [EntityMutations] Not found in backend, skipping online delete:', deliveryId);
      } else {
        console.warn('⚠️ [EntityMutations] Delivery delete sync failed, queuing:', error.message);
        await offlineDB.addPendingMutation({ operation: 'delete', entity: 'Delivery', recordId: deliveryId });
      }
    }

    // If delivery didn't exist in either DB, skip the rest
    if (!existedOffline && !existedOnline) {
      console.log('⏭️ [EntityMutations] Delivery not found in offline or online DB, skipping:', deliveryId);
      await restartSmartRefresh();
      return false; // Indicate it was already deleted
    }

    if (deletedDeliverySnapshot?.driver_id && deletedDeliverySnapshot?.delivery_date) {
      await base44.functions.invoke('purgeAndRegeneratePolylines', {
        driverId: deletedDeliverySnapshot.driver_id,
        deliveryDate: deletedDeliverySnapshot.delivery_date,
        scope: 'active_only',
        reason: 'stops_deleted'
      }).catch(() => null);
    }

    // STEP 3: CRITICAL - Remove from cache (prevents deleted item from showing)
    const { removeDeletedFromCache } = await import('./dataManager');
    removeDeletedFromCache('Delivery', [deliveryId]);
    console.log('🗑️ [EntityMutations] Removed deleted delivery from all caches');
    
    // STEP 4: Mark as deleted in smart refresh to prevent resurrection
    const { smartRefreshManager } = await import('./smartRefreshManager');
    smartRefreshManager.deletedDeliveryIds.add(deliveryId);

    // STEP 5: Notify UI immediately on this device
    notifyMutation({ type: 'delete', entity: 'Delivery', id: deliveryId, data: null });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('offlineDeliveriesDeleted', {
        detail: { deletedIds: [deliveryId] }
      }));
    }

    // STEP 6: Broadcast immediate delete so other devices update UI right away too
    await broadcastMutation('Delivery', 'delete', deliveryId, deletedDeliverySnapshot);

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
    // CRITICAL: Sanitize all deliveries before saving
    const sanitizedDeliveriesData = deliveriesData.map(d => sanitizeDeliveryData(d));
    const creatorAppUserId = await getCurrentCreatorAppUserId();
    const deliveriesWithCreator = sanitizedDeliveriesData.map(d => ({
      ...d,
      created_by_app_user_id: d.created_by_app_user_id || creatorAppUserId || ''
    }));
    
    const localDeliveries = deliveriesWithCreator.map(d => ({
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
      // STEP 2: Create on backend (with creator attached)
      const backendDeliveriesRaw = await base44.entities.Delivery.bulkCreate(deliveriesWithCreator);
      const backendDeliveries = (backendDeliveriesRaw || []).map((delivery) => (
        !delivery?.patient_id && delivery?.stop_id
          ? { ...delivery, puid: delivery.puid || delivery.stop_id }
          : delivery
      ));
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
      
      await refreshOfflineEntitySnapshots('Delivery', backendDeliveries[0]);
      const firstRouteDelivery = backendDeliveries.find((delivery) => delivery?.driver_id && delivery?.delivery_date);
      if (firstRouteDelivery) {
        await base44.functions.invoke('purgeAndRegeneratePolylines', {
          driverId: firstRouteDelivery.driver_id,
          deliveryDate: firstRouteDelivery.delivery_date,
          scope: 'active_only',
          reason: 'stops_added'
        }).catch(() => null);
      }

      // STEP 4: CRITICAL - Invalidate dataManager cache
      const { invalidate } = await import('./dataManager');
      invalidate('Delivery');
      console.log('🗑️ [EntityMutations] Invalidated Delivery cache after batch create');
      
      // STEP 5: Notify UI to replace temps with real
      for (const [i, backend] of backendDeliveries.entries()) {
        notifyMutation({ type: 'replace', entity: 'Delivery', oldId: localDeliveries[i].id, newId: backend.id, data: backend });
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('offlineMutationRecordReplaced', {
            detail: {
              entity: 'Delivery',
              oldId: localDeliveries[i].id,
              record: backend
            }
          }));
        }
      }
      
      // Broadcast to other devices
      for (const d of backendDeliveries) {
        await broadcastMutation('Delivery', 'create', d.id, d);
        await emitImmediateRealtimeCreate('Delivery', d);
      }
      
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
 * CRITICAL: Skips deliveries that don't exist in offline or online DB
 */
export const batchDeleteDeliveries = async (deliveryIds, options = {}) => {
  if (mutationsPaused) throw new Error('Mutations are paused');
  await pauseSmartRefresh();

  try {
    console.log(`🗑️ [EntityMutations] Batch deleting ${deliveryIds.length} deliveries...`);
    
    // STEP 1: Check which deliveries exist in IndexedDB and delete them
    const offlineDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    const existingOfflineIds = new Set(offlineDeliveries.map(d => d.id));
    const idsToDeleteOffline = deliveryIds.filter(id => existingOfflineIds.has(id));
    
    console.log(`💾 [EntityMutations] Found ${idsToDeleteOffline.length} of ${deliveryIds.length} in IndexedDB`);
    
    if (idsToDeleteOffline.length > 0) {
      const db = await offlineDB.openDatabase();
      const tx = db.transaction([offlineDB.STORES.DELIVERIES], 'readwrite');
      const store = tx.objectStore(offlineDB.STORES.DELIVERIES);
      
      for (const id of idsToDeleteOffline) {
        await new Promise((resolve, reject) => {
          const req = store.delete(id);
          req.onsuccess = resolve;
          req.onerror = () => reject(req.error);
        });
      }
      console.log(`💾 [EntityMutations] Deleted ${idsToDeleteOffline.length} from IndexedDB`);
    }

    // STEP 2: Delete from backend (skip if not found)
    const deletedOnlineIds = [];
    const notFoundIds = [];
    
    for (const id of deliveryIds) {
      try {
        await base44.entities.Delivery.delete(id);
        deletedOnlineIds.push(id);
      } catch (error) {
        if (error.message?.includes('not found') || error.message?.includes('404') || error.response?.status === 404) {
          console.log('⏭️ [EntityMutations] Not found in backend, skipping:', id);
          notFoundIds.push(id);
        } else {
          console.warn('⚠️ [EntityMutations] Backend delete failed for', id, ':', error.message);
          await offlineDB.addPendingMutation({ operation: 'delete', entity: 'Delivery', recordId: id });
        }
      }
    }
    
    console.log(`☁️ [EntityMutations] Backend deleted ${deletedOnlineIds.length} deliveries (${notFoundIds.length} not found)`);

    // If nothing was deleted from either DB, skip the rest
    if (idsToDeleteOffline.length === 0 && deletedOnlineIds.length === 0) {
      console.log('⏭️ [EntityMutations] No deliveries found in offline or online DB, all already deleted');
      await restartSmartRefresh();
      return false;
    }
    
    const firstDeletedDelivery = offlineDeliveries.find(d => idsToDeleteOffline.includes(d.id));
    if (firstDeletedDelivery?.driver_id && firstDeletedDelivery?.delivery_date) {
      await base44.functions.invoke('purgeAndRegeneratePolylines', {
        driverId: firstDeletedDelivery.driver_id,
        deliveryDate: firstDeletedDelivery.delivery_date,
        scope: 'active_only',
        reason: 'stops_deleted'
      }).catch(() => null);
    }

    // STEP 3: CRITICAL - Remove deleted items from cache (prevents deleted items from showing)
    const { removeDeletedFromCache } = await import('./dataManager');
    removeDeletedFromCache('Delivery', deliveryIds);
    console.log('🗑️ [EntityMutations] Removed deleted deliveries from all caches');
    
    // STEP 4: Mark as deleted in smart refresh
    const { smartRefreshManager } = await import('./smartRefreshManager');
    deliveryIds.forEach(id => smartRefreshManager.deletedDeliveryIds.add(id));
    console.log(`🗑️ [EntityMutations] Marked ${deliveryIds.length} deliveries as deleted`);

    // STEP 5: Notify UI immediately on this device
    notifyMutation({ 
      type: 'batch_delete', 
      entity: 'Delivery', 
      ids: deliveryIds,
      data: null 
    });

    // STEP 6: Broadcast a single batch delete so other devices don't miss events under load
    await broadcastMutation('Delivery', 'batch_delete', null, null, deliveryIds);

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

    if (entityName === 'AppUser') {
      // Merge with existing offline record to preserve all fields (IndexedDB put replaces the entire record)
      const existingRecord = await offlineDB.getById(offlineDB.STORES.APP_USERS, result.id).catch(() => ({})) || {};
      await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, [{ ...existingRecord, ...result }]);
    }

    notifyMutation({ type: 'create', entity: entityName, id: result.id, data: result });
    await broadcastMutation(entityName, 'create', result.id, result);
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

    if (entityName === 'AppUser') {
      // CRITICAL: Merge with existing offline record to preserve all fields.
      // The SDK update response may omit fields like app_roles, user_name, etc.
      // Saving a partial record would overwrite the full record in IndexedDB.
      const existingRecord = await offlineDB.getById(offlineDB.STORES.APP_USERS, entityId).catch(() => ({})) || {};
      await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, [{ ...existingRecord, ...result }]);
    }

    notifyMutation({ type: 'update', entity: entityName, id: entityId, data: result });
    await broadcastMutation(entityName, 'update', entityId, result);
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
    if (entityName === 'AppUser') {
      await offlineDB.deleteRecord(offlineDB.STORES.APP_USERS, entityId).catch(() => null);
    }

    await base44.entities[entityName].delete(entityId);
    notifyMutation({ type: 'delete', entity: entityName, id: entityId, data: null });
    await broadcastMutation(entityName, 'delete', entityId, null);
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
 * Update AppUser with immediate UI refresh, offline sync, and real-time broadcast
 * CRITICAL: Dual-writes to both online AppUser entity AND offline DB
 * Used for driver status, location, and tracking changes
 */
export const localUpdateAppUser = async (appUserId, updates, options = {}) => {
  if (mutationsPaused) throw new Error('Mutations are paused');
  
  try {
    console.log(`🔄 [EntityMutations] Updating AppUser ${appUserId}...`);
    
    // STEP 1: Update backend (online database)
    const result = await base44.entities.AppUser.update(appUserId, updates);
    console.log(`☁️ [EntityMutations] Backend AppUser updated: ${appUserId}`);
    
    // STEP 2: CRITICAL - DUAL-WRITE to offline DB immediately
    try {
      // CRITICAL: Merge with existing offline record to preserve app_roles and all other fields.
      // The SDK update response may only return changed fields, not the full record.
      const existingRecord = await offlineDB.getById(offlineDB.STORES.APP_USERS, appUserId).catch(() => ({})) || {};
      await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, [{ ...existingRecord, ...result }]);
      console.log(`💾 [EntityMutations] Synced AppUser to offline DB: ${appUserId}`);
    } catch (offlineError) {
      console.warn('⚠️ [EntityMutations] Failed to sync AppUser to offline DB:', offlineError.message);
      // Don't throw - continue with UI update even if offline sync fails
    }
    
    // STEP 3: Notify UI immediately so components refresh
    notifyMutation({ type: 'update', entity: 'AppUser', id: appUserId, data: result });
    console.log(`🔔 [EntityMutations] UI notified of AppUser update`);
    
    // STEP 4: CRITICAL: Broadcast to other devices for real-time sync
    // This ensures driver location/status changes are instantly visible on all devices
    broadcastMutation('AppUser', 'update', appUserId, result);
    
    console.log(`✅ [EntityMutations] AppUser ${appUserId} updated, synced to offline DB, and broadcast to other devices`);
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