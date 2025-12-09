/**
 * Offline-First Mutation Wrapper
 * Intercepts all Patient and Delivery mutations to write locally first,
 * then queues them for background sync to the server
 */

import { offlineDB } from './offlineDatabase';
import { base44 } from '@/api/base44Client';

// Listeners for local UI updates
let mutationListeners = [];

/**
 * Subscribe to local mutations for immediate UI updates
 */
export const subscribeMutations = (callback) => {
  mutationListeners.push(callback);
  return () => {
    mutationListeners = mutationListeners.filter(cb => cb !== callback);
  };
};

/**
 * Notify all listeners of a local mutation
 */
const notifyMutation = (entity, operation, record) => {
  mutationListeners.forEach(callback => {
    try {
      callback({ entity, operation, record });
    } catch (error) {
      console.error('Error in mutation listener:', error);
    }
  });
};

/**
 * Generate temporary client-side ID for new records
 */
const generateTempId = () => {
  return `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

/**
 * Create a Patient or Delivery (local-first)
 */
export const createRecord = async (entityName, data) => {
  console.log(`📝 [OfflineMutations] Creating ${entityName} locally...`);
  
  try {
    // Add temporary ID and timestamps
    const tempId = generateTempId();
    const now = new Date().toISOString();
    const record = {
      ...data,
      id: tempId,
      created_date: now,
      updated_date: now,
      _isPending: true // Mark as pending sync
    };

    // Save to local IndexedDB immediately
    const storeName = entityName === 'Patient' ? offlineDB.STORES.PATIENTS : offlineDB.STORES.DELIVERIES;
    await offlineDB.bulkSave(storeName, [record]);

    // Queue for background sync
    await offlineDB.addPendingMutation(entityName, 'create', tempId, data);

    // Notify UI to update immediately
    notifyMutation(entityName, 'create', record);

    console.log(`✅ [OfflineMutations] ${entityName} created locally with temp ID: ${tempId}`);
    return record;
  } catch (error) {
    console.error(`❌ [OfflineMutations] Failed to create ${entityName} locally:`, error);
    throw error;
  }
};

/**
 * Update a Patient or Delivery (local-first)
 */
export const updateRecord = async (entityName, recordId, updates) => {
  console.log(`📝 [OfflineMutations] Updating ${entityName} ${recordId} locally...`);
  
  try {
    const storeName = entityName === 'Patient' ? offlineDB.STORES.PATIENTS : offlineDB.STORES.DELIVERIES;
    
    // Get existing record from IndexedDB
    const allRecords = await offlineDB.getAll(storeName);
    const existingRecord = allRecords.find(r => r.id === recordId);
    
    if (!existingRecord) {
      throw new Error(`Record ${recordId} not found in local database`);
    }

    // Apply updates locally
    const updatedRecord = {
      ...existingRecord,
      ...updates,
      updated_date: new Date().toISOString(),
      _isPending: true // Mark as pending sync
    };

    // Save to local IndexedDB immediately
    await offlineDB.bulkSave(storeName, [updatedRecord]);

    // Queue for background sync
    await offlineDB.addPendingMutation(entityName, 'update', recordId, updates);

    // Notify UI to update immediately
    notifyMutation(entityName, 'update', updatedRecord);

    console.log(`✅ [OfflineMutations] ${entityName} ${recordId} updated locally`);
    return updatedRecord;
  } catch (error) {
    console.error(`❌ [OfflineMutations] Failed to update ${entityName} locally:`, error);
    throw error;
  }
};

/**
 * Delete a Patient or Delivery (local-first)
 */
export const deleteRecord = async (entityName, recordId) => {
  console.log(`📝 [OfflineMutations] Deleting ${entityName} ${recordId} locally...`);
  
  try {
    const storeName = entityName === 'Patient' ? offlineDB.STORES.PATIENTS : offlineDB.STORES.DELIVERIES;
    
    // Get record before deletion for notification
    const allRecords = await offlineDB.getAll(storeName);
    const record = allRecords.find(r => r.id === recordId);
    
    // Mark as deleted locally (soft delete - keep for sync)
    if (record) {
      const deletedRecord = {
        ...record,
        _isDeleted: true,
        _isPending: true,
        updated_date: new Date().toISOString()
      };
      await offlineDB.bulkSave(storeName, [deletedRecord]);
    }

    // Queue for background sync
    await offlineDB.addPendingMutation(entityName, 'delete', recordId, null);

    // Notify UI to update immediately
    notifyMutation(entityName, 'delete', record);

    console.log(`✅ [OfflineMutations] ${entityName} ${recordId} marked as deleted locally`);
    return { success: true };
  } catch (error) {
    console.error(`❌ [OfflineMutations] Failed to delete ${entityName} locally:`, error);
    throw error;
  }
};

/**
 * Direct backend sync (bypasses local-first for admin operations)
 */
export const syncCreateToBackend = async (entityName, data) => {
  const Entity = entityName === 'Patient' ? base44.entities.Patient : base44.entities.Delivery;
  return await Entity.create(data);
};

export const syncUpdateToBackend = async (entityName, recordId, updates) => {
  const Entity = entityName === 'Patient' ? base44.entities.Patient : base44.entities.Delivery;
  return await Entity.update(recordId, updates);
};

export const syncDeleteToBackend = async (entityName, recordId) => {
  const Entity = entityName === 'Patient' ? base44.entities.Patient : base44.entities.Delivery;
  return await Entity.delete(recordId);
};