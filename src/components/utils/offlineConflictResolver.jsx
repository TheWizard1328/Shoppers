/**
 * Offline Conflict Resolver
 * Handles conflicts when syncing offline edits back to online database
 * 
 * STRATEGIES:
 * 1. Last Write Wins - Compare timestamps, newest data wins
 * 2. Field-Level Merge - Merge changed fields intelligently
 * 3. User Prompt - Show UI dialog for manual resolution
 */

import { offlineDB } from './offlineDatabase';
import { base44 } from '@/api/base44Client';

// Track conflicts for UI display
let pendingConflicts = [];
let conflictListeners = [];

/**
 * Subscribe to conflict events
 */
export const subscribeToConflicts = (callback) => {
  conflictListeners.push(callback);
  return () => {
    conflictListeners = conflictListeners.filter(cb => cb !== callback);
  };
};

const notifyConflictListeners = (conflict) => {
  conflictListeners.forEach(cb => {
    try { cb(conflict); } catch (e) {}
  });
};

/**
 * Detect if a record has conflicts
 * Compares local vs server updated_date
 */
export const detectConflict = async (entityName, recordId, localRecord) => {
  try {
    const Entity = entityName === 'Patient' ? base44.entities.Patient : base44.entities.Delivery;
    
    // Fetch server version
    const serverRecords = await Entity.filter({ id: recordId });
    if (!serverRecords || serverRecords.length === 0) {
      // Record doesn't exist on server - no conflict (local creation)
      return { hasConflict: false, serverRecord: null };
    }
    
    const serverRecord = serverRecords[0];
    
    // Compare timestamps
    const localTime = new Date(localRecord.updated_date || localRecord.created_date).getTime();
    const serverTime = new Date(serverRecord.updated_date || serverRecord.created_date).getTime();
    
    // Conflict if server was updated after local edit
    if (serverTime > localTime) {
      return {
        hasConflict: true,
        serverRecord,
        localRecord,
        timeDiff: serverTime - localTime
      };
    }
    
    return { hasConflict: false, serverRecord };
  } catch (error) {
    console.error('❌ [ConflictResolver] Error detecting conflict:', error);
    return { hasConflict: false, error: error.message };
  }
};

/**
 * Resolve conflict using Last Write Wins strategy
 */
const resolveLastWriteWins = (localRecord, serverRecord) => {
  const localTime = new Date(localRecord.updated_date || localRecord.created_date).getTime();
  const serverTime = new Date(serverRecord.updated_date || serverRecord.created_date).getTime();
  
  if (localTime >= serverTime) {
    return { winner: 'local', data: localRecord };
  } else {
    return { winner: 'server', data: serverRecord };
  }
};

/**
 * Resolve conflict using Field-Level Merge
 * Intelligently merges changed fields
 */
const resolveFieldLevelMerge = (localRecord, serverRecord) => {
  const merged = { ...serverRecord }; // Start with server as base
  
  // Critical fields that should always use local version if modified
  const criticalFields = ['status', 'actual_delivery_time', 'delivery_notes', 'cod_payments', 'stop_order'];
  
  criticalFields.forEach(field => {
    if (localRecord[field] !== undefined && localRecord[field] !== serverRecord[field]) {
      merged[field] = localRecord[field];
    }
  });
  
  return { winner: 'merged', data: merged };
};

/**
 * Sync a single record with conflict detection and resolution
 */
export const syncRecordWithConflictResolution = async (
  entityName, 
  recordId, 
  localRecord, 
  strategy = 'last_write_wins'
) => {
  try {
    console.log(`🔄 [ConflictResolver] Syncing ${entityName} ${recordId}...`);
    
    // Check for conflicts
    const conflictCheck = await detectConflict(entityName, recordId, localRecord);
    
    if (!conflictCheck.hasConflict) {
      // No conflict - safe to sync
      const Entity = entityName === 'Patient' ? base44.entities.Patient : base44.entities.Delivery;
      
      // Filter out temp IDs and internal fields
      const cleanRecord = { ...localRecord };
      delete cleanRecord.id;
      delete cleanRecord.created_date;
      delete cleanRecord.updated_date;
      delete cleanRecord.created_by;
      
      await Entity.update(recordId, cleanRecord);
      console.log(`   ✅ Synced without conflict`);
      
      return { success: true, conflict: false };
    }
    
    // CONFLICT DETECTED
    console.warn(`⚠️ [ConflictResolver] Conflict detected for ${entityName} ${recordId}`);
    
    let resolution;
    
    if (strategy === 'last_write_wins') {
      resolution = resolveLastWriteWins(localRecord, conflictCheck.serverRecord);
    } else if (strategy === 'field_merge') {
      resolution = resolveFieldLevelMerge(localRecord, conflictCheck.serverRecord);
    } else {
      // Prompt user - queue conflict
      const conflict = {
        id: `conflict_${Date.now()}`,
        entityName,
        recordId,
        localRecord,
        serverRecord: conflictCheck.serverRecord,
        timestamp: new Date().toISOString()
      };
      
      pendingConflicts.push(conflict);
      notifyConflictListeners(conflict);
      
      return { success: false, conflict: true, requiresUserInput: true, conflictId: conflict.id };
    }
    
    // Apply resolution
    if (resolution.winner === 'local' || resolution.winner === 'merged') {
      const Entity = entityName === 'Patient' ? base44.entities.Patient : base44.entities.Delivery;
      
      const cleanRecord = { ...resolution.data };
      delete cleanRecord.id;
      delete cleanRecord.created_date;
      delete cleanRecord.updated_date;
      delete cleanRecord.created_by;
      
      await Entity.update(recordId, cleanRecord);
      console.log(`   ✅ Conflict resolved (${resolution.winner})`);
      
      // Update offline DB with merged version
      const storeName = entityName === 'Patient' ? offlineDB.STORES.PATIENTS : offlineDB.STORES.DELIVERIES;
      await offlineDB.bulkSave(storeName, [{ ...resolution.data, id: recordId }]);
    } else {
      // Server wins - update offline DB
      const storeName = entityName === 'Patient' ? offlineDB.STORES.PATIENTS : offlineDB.STORES.DELIVERIES;
      await offlineDB.bulkSave(storeName, [conflictCheck.serverRecord]);
      console.log(`   ✅ Conflict resolved (server wins)`);
    }
    
    return { success: true, conflict: true, resolution: resolution.winner };
  } catch (error) {
    console.error('❌ [ConflictResolver] Sync failed:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Get all pending conflicts
 */
export const getPendingConflicts = () => {
  return pendingConflicts;
};

/**
 * Resolve a conflict manually (user choice)
 */
export const resolveConflictManually = async (conflictId, choice) => {
  const conflict = pendingConflicts.find(c => c.id === conflictId);
  if (!conflict) return { success: false, error: 'Conflict not found' };
  
  try {
    const Entity = conflict.entityName === 'Patient' ? base44.entities.Patient : base44.entities.Delivery;
    const dataToUse = choice === 'local' ? conflict.localRecord : conflict.serverRecord;
    
    if (choice === 'local') {
      // Apply local changes
      const cleanRecord = { ...dataToUse };
      delete cleanRecord.id;
      delete cleanRecord.created_date;
      delete cleanRecord.updated_date;
      delete cleanRecord.created_by;
      
      await Entity.update(conflict.recordId, cleanRecord);
    }
    
    // Update offline DB
    const storeName = conflict.entityName === 'Patient' ? offlineDB.STORES.PATIENTS : offlineDB.STORES.DELIVERIES;
    await offlineDB.bulkSave(storeName, [{ ...dataToUse, id: conflict.recordId }]);
    
    // Remove from pending
    pendingConflicts = pendingConflicts.filter(c => c.id !== conflictId);
    
    return { success: true, choice };
  } catch (error) {
    console.error('❌ [ConflictResolver] Manual resolution failed:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Clear all resolved conflicts
 */
export const clearResolvedConflicts = () => {
  pendingConflicts = [];
};