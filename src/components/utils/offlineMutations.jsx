/**
 * Offline Mutations Manager
 * Handles local-first writes for Patient, Delivery, and AppUser entities
 */

import { offlineDB } from './offlineDatabase';
import { Patient } from '@/entities/Patient';
import { Delivery } from '@/entities/Delivery';
import { AppUser } from '@/entities/AppUser';

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
    } catch (error) {
      console.warn('⚠️ [Sync] Immediate sync failed, queuing for later:', error.message);
      // Queue for backend sync if immediate sync fails
      await offlineDB.addPendingMutation({
        operation: 'create',
        entity: 'Patient',
        recordId: tempId,
        payload: patientData
      });
    }
    
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
    } catch (error) {
      console.warn('⚠️ [Sync] Immediate sync failed, queuing for later:', error.message);
      // Queue for backend sync if immediate sync fails
      await offlineDB.addPendingMutation({
        operation: 'update',
        entity: 'Patient',
        recordId: patientId,
        payload: updates
      });
    }
    
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
    } catch (error) {
      console.warn('⚠️ [Sync] Immediate sync failed, queuing for later:', error.message);
      // Queue for backend sync if immediate sync fails
      await offlineDB.addPendingMutation({
        operation: 'delete',
        entity: 'Patient',
        recordId: patientId
      });
    }
    
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
      const backendDelivery = await base44.entities.Delivery.create(deliveryData);
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
    } catch (error) {
      console.warn('⚠️ [Sync] Immediate sync failed, queuing for later:', error.message);
      // Queue for backend sync if immediate sync fails
      await offlineDB.addPendingMutation({
        operation: 'create',
        entity: 'Delivery',
        recordId: tempId,
        payload: deliveryData
      });
    }
    
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

    console.log('✅ [OfflineMutations] Delivery updated locally:', deliveryId);
    
    // CRITICAL: Notify listeners IMMEDIATELY for instant UI update
    notifyMutation({ 
      type: 'update', 
      entity: 'Delivery', 
      id: deliveryId,
      data: updatedDelivery 
    });

    // Try immediate backend sync
    try {
      const { base44 } = await import('@/api/base44Client');
      await base44.entities.Delivery.update(deliveryId, updates);
      console.log('✅ [Sync] Delivery synced to backend immediately:', deliveryId);
    } catch (error) {
      console.warn('⚠️ [Sync] Immediate sync failed, queuing for later:', error.message);
      // Queue for backend sync if immediate sync fails
      await offlineDB.addPendingMutation({
        operation: 'update',
        entity: 'Delivery',
        recordId: deliveryId,
        payload: updates
      });
    }
    
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

    // Try immediate backend sync
    try {
      const { base44 } = await import('@/api/base44Client');
      await base44.entities.Delivery.delete(deliveryId);
      console.log('✅ [Sync] Delivery deletion synced to backend immediately:', deliveryId);
    } catch (error) {
      console.warn('⚠️ [Sync] Immediate sync failed, queuing for later:', error.message);
      // Queue for backend sync if immediate sync fails
      await offlineDB.addPendingMutation({
        operation: 'delete',
        entity: 'Delivery',
        recordId: deliveryId
      });
    }
    
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
      const backendDeliveries = await base44.entities.Delivery.bulkCreate(deliveriesData);
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
    } catch (error) {
      console.warn('⚠️ [Sync] Immediate bulk sync failed, queuing for later:', error.message);
      // Queue all for backend sync if immediate sync fails
      for (const delivery of localDeliveries) {
        await offlineDB.addPendingMutation({
          operation: 'create',
          entity: 'Delivery',
          recordId: delivery.id,
          payload: delivery
        });
      }
    }
    
    return localDeliveries;
  } catch (error) {
    console.error('❌ [OfflineMutations] Failed to batch create deliveries locally:', error);
    throw error;
  }
};