// dataDiffer.js - Utilities for comparing and merging data efficiently

/**
 * Compares two arrays of entities and returns what's changed
 * @param {Array} oldData - Current data in state
 * @param {Array} newData - Fresh data from server
 * @returns {Object} - { toUpdate, toAdd, toRemove }
 */
export const diffEntityArrays = (oldData = [], newData = []) => {
  const oldMap = new Map(oldData.map(item => [item.id, item]));
  const newMap = new Map(newData.map(item => [item.id, item]));
  
  const toUpdate = [];
  const toAdd = [];
  const toRemove = [];
  
  // Find updates and additions
  for (const [id, newItem] of newMap) {
    const oldItem = oldMap.get(id);
    
    if (!oldItem) {
      // New item
      toAdd.push(newItem);
    } else {
      // Check if updated (compare updated_date or entire object)
      const hasChanged = hasEntityChanged(oldItem, newItem);
      if (hasChanged) {
        toUpdate.push(newItem);
      }
    }
  }
  
  // Find removals (only if doing full sync)
  for (const [id] of oldMap) {
    if (!newMap.has(id)) {
      toRemove.push(id);
    }
  }
  
  return { toUpdate, toAdd, toRemove };
};

/**
 * Checks if an entity has changed by comparing key fields
 */
const hasEntityChanged = (oldItem, newItem) => {
  // Quick check: compare updated_date if available
  if (oldItem.updated_date && newItem.updated_date) {
    return new Date(newItem.updated_date).getTime() !== new Date(oldItem.updated_date).getTime();
  }
  
  // Fallback: shallow comparison
  return JSON.stringify(oldItem) !== JSON.stringify(newItem);
};

/**
 * Merges changes into existing state array
 * @param {Array} currentState - Current state array
 * @param {Object} diff - Result from diffEntityArrays
 * @returns {Array} - New merged array
 */
export const mergeEntityChanges = (currentState = [], { toUpdate, toAdd, toRemove }) => {
  // CRITICAL: Return same reference if no changes to prevent React re-renders
  if (toUpdate.length === 0 && toAdd.length === 0 && toRemove.length === 0) {
    return currentState;
  }
  
  // CRITICAL: Preserve object references for unchanged items so React can optimize re-renders
  let merged = currentState;
  
  // Apply updates - only create new array if there are changes
  if (toUpdate.length > 0) {
    const updateMap = new Map(toUpdate.map(item => [item.id, item]));
    merged = merged.map(item => {
      const updated = updateMap.get(item.id);
      if (updated) {
        // CRITICAL: Preserve PUID if it exists in old item but not in update
        // This prevents PUID loss during incremental updates
        if (item.puid && !updated.puid) {
          return { ...updated, puid: item.puid };
        }
        return updated;
      }
      return item; // Keep same reference if unchanged
    });
  }
  
  // Apply additions - CRITICAL: Check for duplicates before adding
  if (toAdd.length > 0) {
    const existingIds = new Set(merged.map(item => item.id));
    const uniqueAdditions = toAdd.filter(item => !existingIds.has(item.id));
    if (uniqueAdditions.length > 0) {
      merged = [...merged, ...uniqueAdditions];
    }
  }
  
  // Apply removals
  if (toRemove.length > 0) {
    const removeSet = new Set(toRemove);
    merged = merged.filter(item => !removeSet.has(item.id));
  }
  
  return merged;
};

/**
 * Gets the most recent updated_date from an array of entities
 */
export const getLatestUpdateTimestamp = (entities = []) => {
  if (!entities || entities.length === 0) return null;
  
  const timestamps = entities
    .filter(e => e && e.updated_date)
    .map(e => new Date(e.updated_date).getTime());
  
  if (timestamps.length === 0) return null;
  
  return new Date(Math.max(...timestamps));
};

/**
 * Specifically merges driver location updates into AppUser array
 * Only updates location fields, preserves other data
 */
export const mergeDriverLocations = (currentAppUsers = [], locationUpdates = []) => {
  if (!locationUpdates || locationUpdates.length === 0) return currentAppUsers;
  
  const locationMap = new Map(
    locationUpdates.map(update => [
      update.id,
      {
        current_latitude: update.current_latitude,
        current_longitude: update.current_longitude,
        location_updated_at: update.location_updated_at,
        location_tracking_enabled: update.location_tracking_enabled
      }
    ])
  );
  
  // CRITICAL: Preserve object references for users without location changes
  return currentAppUsers.map(appUser => {
    const locationUpdate = locationMap.get(appUser.id);
    if (locationUpdate) {
      // Check if location actually changed to avoid unnecessary re-renders
      const hasLocationChange = 
        appUser.current_latitude !== locationUpdate.current_latitude ||
        appUser.current_longitude !== locationUpdate.current_longitude ||
        appUser.location_updated_at !== locationUpdate.location_updated_at ||
        appUser.location_tracking_enabled !== locationUpdate.location_tracking_enabled;
      
      if (hasLocationChange) {
        return { ...appUser, ...locationUpdate };
      }
    }
    return appUser; // Keep same reference if unchanged
  });
};

/**
 * Logs diff statistics for debugging
 */
export const logDiffStats = (entityName, diff) => {
  const { toUpdate, toAdd, toRemove } = diff;
  
  if (toUpdate.length > 0 || toAdd.length > 0 || toRemove.length > 0) {
    console.log(`📊 [DataDiff] ${entityName}:`, {
      updated: toUpdate.length,
      added: toAdd.length,
      removed: toRemove.length
    });
  }
};