/**
 * Offline Mutations Manager
 * Handles local-first writes for Patient and Delivery entities
 */

import { offlineDB } from './offlineDatabase';
import { Patient } from '@/entities/Patient';
import { Delivery } from '@/entities/Delivery';

// Listeners for UI updates
let mutationListeners = [];

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
  mutationListeners.forEach(callback => {
    try {
      callback(mutation);
    } catch (error) {
      console.error('Error in mutation listener:', error);
    }
  });
};

/**
 * Create a new Patient (local-first)
 */
export const createPatientLocal = async (patientData) => {
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

    // Queue for backend sync
    await offlineDB.addPendingMutation({
      operation: 'create',
      entity: 'Patient',
      recordId: tempId,
      payload: patientData
    });

    console.log('✅ [OfflineMutations] Patient created locally:', tempId);
    
    // CRITICAL: Notify listeners IMMEDIATELY for instant UI update
    notifyMutation({ 
      type: 'create', 
      entity: 'Patient', 
      id: tempId,
      data: localPatient 
    });
    
    return localPatient;
  } catch (error) {
    console.error('❌ [OfflineMutations] Failed to create patient locally:', error);
    throw error;
  }
};

/**
 * Update a Patient (local-first)
 */
export const updatePatientLocal = async (patientId, updates) => {
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

    // Queue for backend sync
    await offlineDB.addPendingMutation({
      operation: 'update',
      entity: 'Patient',
      recordId: patientId,
      payload: updates
    });

    console.log('✅ [OfflineMutations] Patient updated locally:', patientId);
    
    // CRITICAL: Notify listeners IMMEDIATELY for instant UI update
    notifyMutation({ 
      type: 'update', 
      entity: 'Patient', 
      id: patientId,
      data: updatedPatient 
    });
    
    return updatedPatient;
  } catch (error) {
    console.error('❌ [OfflineMutations] Failed to update patient locally:', error);
    throw error;
  }
};

/**
 * Delete a Patient (local-first)
 */
export const deletePatientLocal = async (patientId) => {
  try {
    console.log('📝 [OfflineMutations] Deleting patient locally:', patientId);
    
    // Queue for backend sync BEFORE removing from local DB
    await offlineDB.addPendingMutation({
      operation: 'delete',
      entity: 'Patient',
      recordId: patientId
    });

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
    
    return true;
  } catch (error) {
    console.error('❌ [OfflineMutations] Failed to delete patient locally:', error);
    throw error;
  }
};

/**
 * Create a new Delivery (local-first)
 */
export const createDeliveryLocal = async (deliveryData) => {
  try {
    console.log('📝 [OfflineMutations] Creating delivery locally...');
    
    // Generate temporary ID if not provided
    const tempId = deliveryData.id || `temp_delivery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const localDelivery = {
      ...deliveryData,
      id: tempId,
      created_date: new Date().toISOString(),
      updated_date: new Date().toISOString(),
      _isLocal: true // Mark as locally created
    };

    // Save to local IndexedDB
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [localDelivery]);

    // Queue for backend sync
    await offlineDB.addPendingMutation({
      operation: 'create',
      entity: 'Delivery',
      recordId: tempId,
      payload: deliveryData
    });

    console.log('✅ [OfflineMutations] Delivery created locally:', tempId);
    
    // CRITICAL: Notify listeners IMMEDIATELY for instant UI update
    notifyMutation({ 
      type: 'create', 
      entity: 'Delivery', 
      id: tempId,
      data: localDelivery 
    });
    
    return localDelivery;
  } catch (error) {
    console.error('❌ [OfflineMutations] Failed to create delivery locally:', error);
    throw error;
  }
};

/**
 * Update a Delivery (local-first)
 */
export const updateDeliveryLocal = async (deliveryId, updates) => {
  try {
    console.log('📝 [OfflineMutations] Updating delivery locally:', deliveryId);
    
    // Get current delivery from IndexedDB
    const deliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
    const existingDelivery = deliveries.find(d => d.id === deliveryId);
    
    if (!existingDelivery) {
      throw new Error(`Delivery ${deliveryId} not found in local database`);
    }

    // Apply updates
    const updatedDelivery = {
      ...existingDelivery,
      ...updates,
      updated_date: new Date().toISOString()
    };

    // Save to local IndexedDB
    await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [updatedDelivery]);

    // Queue for backend sync
    await offlineDB.addPendingMutation({
      operation: 'update',
      entity: 'Delivery',
      recordId: deliveryId,
      payload: updates
    });

    console.log('✅ [OfflineMutations] Delivery updated locally:', deliveryId);
    
    // CRITICAL: Notify listeners IMMEDIATELY for instant UI update
    notifyMutation({ 
      type: 'update', 
      entity: 'Delivery', 
      id: deliveryId,
      data: updatedDelivery 
    });
    
    return updatedDelivery;
  } catch (error) {
    console.error('❌ [OfflineMutations] Failed to update delivery locally:', error);
    throw error;
  }
};

/**
 * Delete a Delivery (local-first)
 */
export const deleteDeliveryLocal = async (deliveryId) => {
  try {
    console.log('📝 [OfflineMutations] Deleting delivery locally:', deliveryId);
    
    // Queue for backend sync BEFORE removing from local DB
    await offlineDB.addPendingMutation({
      operation: 'delete',
      entity: 'Delivery',
      recordId: deliveryId
    });

    // Remove from local IndexedDB
    const db = await offlineDB.openDatabase();
    const transaction = db.transaction([offlineDB.STORES.DELIVERIES], 'readwrite');
    const store = transaction.objectStore(offlineDB.STORES.DELIVERIES);
    
    await new Promise((resolve, reject) => {
      const request = store.delete(deliveryId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });

    console.log('✅ [OfflineMutations] Delivery deleted locally:', deliveryId);
    
    // CRITICAL: Notify listeners IMMEDIATELY for instant UI update
    notifyMutation({ 
      type: 'delete', 
      entity: 'Delivery', 
      id: deliveryId,
      data: null 
    });
    
    return true;
  } catch (error) {
    console.error('❌ [OfflineMutations] Failed to delete delivery locally:', error);
    throw error;
  }
};

/**
 * Batch create multiple deliveries (local-first)
 */
export const batchCreateDeliveriesLocal = async (deliveriesData) => {
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

    // Queue all for backend sync
    for (const delivery of localDeliveries) {
      await offlineDB.addPendingMutation({
        operation: 'create',
        entity: 'Delivery',
        recordId: delivery.id,
        payload: delivery
      });
    }

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
    
    return localDeliveries;
  } catch (error) {
    console.error('❌ [OfflineMutations] Failed to batch create deliveries locally:', error);
    throw error;
  }
};