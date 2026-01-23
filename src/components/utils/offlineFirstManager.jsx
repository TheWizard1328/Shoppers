/**
 * Offline-First Data Manager
 * All reads go to offline DB first, then API
 * All writes go to offline DB immediately, then sync API in background
 */

import { base44 } from "@/api/base44Client";
import { offlineDB } from "./offlineDatabase";
import { smartRefreshManager } from "./smartRefreshManager";
import { toast } from "sonner";

// Track pending syncs
let pendingSyncs = new Map();

/**
 * READ: Get entities from offline DB first, fallback to API
 * @param {string} entityName - Name of entity (Delivery, Patient, AppUser, etc)
 * @param {object} filter - Filter object for query
 * @param {string} sort - Sort field (e.g., '-updated_date')
 * @param {number} limit - Limit results
 * @returns {Promise<array>} - Entities array
 */
export async function readEntities(entityName, filter = {}, sort = '-updated_date', limit = 1000) {
  try {
    // Step 1: Try offline DB first
    const offlineData = await offlineDB.getAll(offlineDB.STORES[entityName.toUpperCase()]);
    
    if (offlineData && offlineData.length > 0) {
      console.log(`📖 [OfflineFirst] ${entityName}: Using ${offlineData.length} records from offline DB`);
      
      // Filter results if filter provided
      if (Object.keys(filter).length > 0) {
        return offlineData.filter(record => {
          return Object.entries(filter).every(([key, value]) => {
            if (typeof value === 'object' && value.$in) {
              return value.$in.includes(record[key]);
            }
            return record[key] === value;
          });
        }).slice(0, limit);
      }
      
      return offlineData.slice(0, limit);
    }
    
    // Step 2: Fallback to API if offline DB empty
    console.log(`🌐 [OfflineFirst] ${entityName}: Offline DB empty, fetching from API...`);
    const entity = base44.entities[entityName];
    if (!entity) throw new Error(`Entity ${entityName} not found`);
    
    const apiData = await entity.filter(filter, sort, limit);
    
    // Step 3: Cache to offline DB
    if (apiData && apiData.length > 0) {
      await offlineDB.bulkSave(offlineDB.STORES[entityName.toUpperCase()], apiData);
      console.log(`💾 [OfflineFirst] ${entityName}: Cached ${apiData.length} records to offline DB`);
    }
    
    return apiData || [];
  } catch (error) {
    console.error(`❌ [OfflineFirst] ${entityName} read error:`, error.message);
    return [];
  }
}

/**
 * WRITE: Save to offline DB immediately, sync API in background
 * @param {string} entityName - Name of entity
 * @param {string} id - Record ID
 * @param {object} data - Data to save
 * @returns {Promise<object>} - Updated record
 */
export async function writeEntity(entityName, id, data) {
  const entity = base44.entities[entityName];
  if (!entity) throw new Error(`Entity ${entityName} not found`);
  
  try {
    // Step 1: Update in offline DB immediately
    const updatedRecord = {
      id,
      ...data,
      updated_date: new Date().toISOString()
    };
    
    await offlineDB.bulkSave(offlineDB.STORES[entityName.toUpperCase()], [updatedRecord]);
    console.log(`💾 [OfflineFirst] ${entityName}: Saved to offline DB`);
    
    // Register pending sync
    const syncKey = `${entityName}:${id}`;
    pendingSyncs.set(syncKey, { entityName, id, data });
    
    // Step 2: Sync to API in background (don't await)
    syncToAPI(entityName, id, data).catch(error => {
      console.error(`⚠️ [OfflineFirst] Failed to sync ${entityName}:${id}:`, error.message);
    });
    
    return updatedRecord;
  } catch (error) {
    console.error(`❌ [OfflineFirst] ${entityName} write error:`, error.message);
    throw error;
  }
}

/**
 * CREATE: Save new record to offline DB, sync to API in background
 * @param {string} entityName - Name of entity
 * @param {object} data - Data for new record
 * @returns {Promise<object>} - Created record with ID
 */
export async function createEntity(entityName, data) {
  const entity = base44.entities[entityName];
  if (!entity) throw new Error(`Entity ${entityName} not found`);
  
  try {
    // Step 1: Create in API first to get ID
    console.log(`🔄 [OfflineFirst] ${entityName}: Creating record...`);
    const createdRecord = await entity.create(data);
    
    // Step 2: Save to offline DB immediately
    await offlineDB.bulkSave(offlineDB.STORES[entityName.toUpperCase()], [createdRecord]);
    console.log(`💾 [OfflineFirst] ${entityName}: Created and saved to offline DB`);
    
    // Step 3: Register pending sync (already synced, but track it)
    const syncKey = `${entityName}:${createdRecord.id}`;
    pendingSyncs.delete(syncKey); // Remove from pending since we already synced
    
    return createdRecord;
  } catch (error) {
    console.error(`❌ [OfflineFirst] ${entityName} create error:`, error.message);
    throw error;
  }
}

/**
 * DELETE: Remove from offline DB, sync deletion to API in background
 * @param {string} entityName - Name of entity
 * @param {string} id - Record ID to delete
 */
export async function deleteEntity(entityName, id) {
  const entity = base44.entities[entityName];
  if (!entity) throw new Error(`Entity ${entityName} not found`);
  
  try {
    // Step 1: Remove from offline DB immediately
    await offlineDB.deleteRecord(offlineDB.STORES[entityName.toUpperCase()], id);
    console.log(`🗑️ [OfflineFirst] ${entityName}: Removed from offline DB`);
    
    // Step 2: Sync deletion to API in background
    syncDeleteToAPI(entityName, id).catch(error => {
      console.error(`⚠️ [OfflineFirst] Failed to sync deletion of ${entityName}:${id}:`, error.message);
    });
  } catch (error) {
    console.error(`❌ [OfflineFirst] ${entityName} delete error:`, error.message);
    throw error;
  }
}

/**
 * Sync updated record to API in background
 */
async function syncToAPI(entityName, id, data) {
  try {
    const entity = base44.entities[entityName];
    await entity.update(id, data);
    console.log(`✅ [OfflineFirst] ${entityName}:${id} synced to API`);
    
    // Remove from pending syncs
    pendingSyncs.delete(`${entityName}:${id}`);
  } catch (error) {
    console.error(`⚠️ [OfflineFirst] Sync failed for ${entityName}:${id}:`, error.message);
    throw error;
  }
}

/**
 * Sync deletion to API in background
 */
async function syncDeleteToAPI(entityName, id) {
  try {
    const entity = base44.entities[entityName];
    await entity.delete(id);
    console.log(`✅ [OfflineFirst] ${entityName}:${id} deletion synced to API`);
    
    pendingSyncs.delete(`${entityName}:${id}`);
  } catch (error) {
    console.error(`⚠️ [OfflineFirst] Deletion sync failed for ${entityName}:${id}:`, error.message);
    throw error;
  }
}

/**
 * Get all pending syncs
 */
export function getPendingSyncs() {
  return Array.from(pendingSyncs.values());
}

/**
 * Wait for all pending syncs to complete (with timeout)
 */
export async function waitForPendingSyncs(timeoutMs = 30000) {
  const startTime = Date.now();
  
  while (pendingSyncs.size > 0) {
    if (Date.now() - startTime > timeoutMs) {
      console.warn(`⏱️ [OfflineFirst] Pending syncs timeout after ${timeoutMs}ms, continuing with ${pendingSyncs.size} pending`);
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * Batch read multiple entity types efficiently
 * Reads from offline first, syncs missing data from API
 */
export async function readEntitiesBatch(requests) {
  const results = {};
  
  // Read all from offline DB first
  const offlineReads = await Promise.all(
    requests.map(async (req) => ({
      name: req.name,
      data: await offlineDB.getAll(offlineDB.STORES[req.name.toUpperCase()])
    }))
  );
  
  // Check which have data
  const needsAPI = [];
  offlineReads.forEach(({ name, data }) => {
    if (data && data.length > 0) {
      results[name] = data;
      console.log(`📖 [OfflineFirst] ${name}: ${data.length} from offline`);
    } else {
      needsAPI.push(name);
    }
  });
  
  // Fetch missing from API
  if (needsAPI.length > 0) {
    console.log(`🌐 [OfflineFirst] Fetching ${needsAPI.length} entity types from API...`);
    
    const apiReads = await Promise.all(
      needsAPI.map(async (name) => {
        const entity = base44.entities[name];
        if (!entity) return { name, data: [] };
        
        try {
          const data = await entity.list();
          await offlineDB.bulkSave(offlineDB.STORES[name.toUpperCase()], data);
          return { name, data };
        } catch (error) {
          console.warn(`⚠️ Failed to fetch ${name}:`, error.message);
          return { name, data: [] };
        }
      })
    );
    
    apiReads.forEach(({ name, data }) => {
      results[name] = data;
    });
  }
  
  return results;
}

export const offlineFirstManager = {
  readEntities,
  writeEntity,
  createEntity,
  deleteEntity,
  readEntitiesBatch,
  getPendingSyncs,
  waitForPendingSyncs
};