/**
 * Centralized Data Operation Manager
 * 
 * PURPOSE: Provides a unified interface for all create/update/delete operations
 * to ensure consistency across:
 * - Offline database (IndexedDB) - PRIMARY source of truth
 * - Online entities (Base44 backend) - EVENTUAL consistency
 * - UI updates - IMMEDIATE via mutation subscriptions
 * 
 * CRITICAL: This utility ensures:
 * 1. Smart refresh manager is PAUSED before operations
 * 2. Offline database is updated FIRST (instant UI)
 * 3. Online entities are updated in background (eventual consistency)
 * 4. Smart refresh manager is RESTARTED (not resumed) after completion
 * 
 * Used by: Dashboard, Importers (Patient, Route, Active), DeliveryForm, PatientForm, etc.
 */

import { smartRefreshManager } from './smartRefreshManager';
import { pauseOfflineSync, resumeOfflineSync } from './offlineSync';
import { pauseOfflineMutations, resumeOfflineMutations } from './offlineMutations';
import { driverLocationPoller } from './driverLocationPoller';
import { 
  createPatientLocal, 
  updatePatientLocal, 
  deletePatientLocal,
  createDeliveryLocal,
  updateDeliveryLocal,
  deleteDeliveryLocal,
  batchCreateDeliveriesLocal
} from './offlineMutations';

/**
 * Execute a data operation with proper pause/restart of refresh managers
 * 
 * @param {Function} operation - The async function to execute (creates/updates/deletes data)
 * @param {Object} options - Configuration options
 * @param {boolean} options.skipSmartRefreshRestart - If true, don't restart smart refresh (for bulk ops)
 * @param {number} options.restartDelay - Delay in ms before restarting smart refresh (default: 0 = immediate)
 * @returns {Promise<any>} - Result of the operation
 */
export const executeDataOperation = async (operation, options = {}) => {
  const { skipSmartRefreshRestart = false, restartDelay = 0 } = options;
  
  console.log('🔒 [DataOp] Starting data operation - pausing all refresh managers...');
  
  // STEP 1: Pause ALL refresh and sync managers
  smartRefreshManager.pause();
  pauseOfflineSync();
  pauseOfflineMutations();
  driverLocationPoller.pause();
  
  try {
    // STEP 2: Execute the actual data operation
    const result = await operation();
    
    console.log('✅ [DataOp] Operation completed successfully');
    
    // STEP 3: Resume offline sync/mutations FIRST (they handle backend sync)
    resumeOfflineMutations();
    resumeOfflineSync();
    driverLocationPoller.resume();
    
    // STEP 4: Restart smart refresh manager (force immediate refresh)
    if (!skipSmartRefreshRestart) {
      if (restartDelay > 0) {
        console.log(`⏰ [DataOp] Restarting smart refresh in ${restartDelay}ms...`);
        setTimeout(() => {
          smartRefreshManager.restart();
          console.log('✅ [DataOp] Smart refresh restarted');
        }, restartDelay);
      } else {
        // Immediate restart (default)
        smartRefreshManager.restart();
        console.log('✅ [DataOp] Smart refresh restarted immediately');
      }
    }
    
    return result;
  } catch (error) {
    console.error('❌ [DataOp] Operation failed:', error);
    
    // CRITICAL: Always resume managers even on error
    resumeOfflineMutations();
    resumeOfflineSync();
    driverLocationPoller.resume();
    
    if (!skipSmartRefreshRestart) {
      smartRefreshManager.restart();
    }
    
    throw error;
  }
};

/**
 * High-level API for common data operations
 * These wrap the local-first mutation functions with proper pause/restart
 */

export const createPatient = async (patientData) => {
  return executeDataOperation(() => createPatientLocal(patientData));
};

export const updatePatient = async (patientId, updates) => {
  return executeDataOperation(() => updatePatientLocal(patientId, updates));
};

export const deletePatient = async (patientId) => {
  return executeDataOperation(() => deletePatientLocal(patientId));
};

export const createDelivery = async (deliveryData) => {
  return executeDataOperation(() => createDeliveryLocal(deliveryData));
};

export const updateDelivery = async (deliveryId, updates, options = {}) => {
  return executeDataOperation(() => updateDeliveryLocal(deliveryId, updates, options), options);
};

export const deleteDelivery = async (deliveryId) => {
  return executeDataOperation(() => deleteDeliveryLocal(deliveryId));
};

export const batchCreateDeliveries = async (deliveriesData) => {
  return executeDataOperation(() => batchCreateDeliveriesLocal(deliveriesData));
};

/**
 * Batch import operations - for use by importers
 * These handle large-scale data operations with optional delays
 */
export const batchImportPatients = async (patientsData, options = {}) => {
  const { restartDelay = 2000 } = options; // 2 second delay for imports
  
  return executeDataOperation(async () => {
    console.log(`📥 [DataOp] Batch importing ${patientsData.length} patients...`);
    
    const results = [];
    for (const patientData of patientsData) {
      try {
        const result = await createPatientLocal(patientData);
        results.push(result);
      } catch (error) {
        console.warn('⚠️ [DataOp] Failed to import patient:', error.message);
      }
    }
    
    console.log(`✅ [DataOp] Imported ${results.length}/${patientsData.length} patients`);
    return results;
  }, { restartDelay });
};

export const batchImportDeliveries = async (deliveriesData, options = {}) => {
  const { restartDelay = 2000 } = options; // 2 second delay for imports
  
  return executeDataOperation(async () => {
    console.log(`📥 [DataOp] Batch importing ${deliveriesData.length} deliveries...`);
    return await batchCreateDeliveriesLocal(deliveriesData);
  }, { restartDelay });
};

/**
 * Special operation for bulk deletions
 * Used when deleting multiple deliveries at once (e.g., removing all stops for a driver)
 */
export const batchDeleteDeliveries = async (deliveryIds, options = {}) => {
  const { restartDelay = 1000 } = options;
  
  return executeDataOperation(async () => {
    console.log(`🗑️ [DataOp] Batch deleting ${deliveryIds.length} deliveries...`);
    
    const results = [];
    for (const deliveryId of deliveryIds) {
      try {
        await deleteDeliveryLocal(deliveryId);
        results.push(deliveryId);
      } catch (error) {
        console.warn(`⚠️ [DataOp] Failed to delete delivery ${deliveryId}:`, error.message);
      }
    }
    
    console.log(`✅ [DataOp] Deleted ${results.length}/${deliveryIds.length} deliveries`);
    return results;
  }, { restartDelay });
};

/**
 * Manual refresh trigger - for when user clicks refresh button
 * This forces an immediate full refresh of all data
 */
export const triggerManualRefresh = async () => {
  console.log('👆 [DataOp] Manual refresh triggered - restarting smart refresh...');
  
  // Restart smart refresh to force immediate cycle
  smartRefreshManager.restart();
  
  // Also trigger a full data refresh event
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('forceDataRefresh'));
  }
};