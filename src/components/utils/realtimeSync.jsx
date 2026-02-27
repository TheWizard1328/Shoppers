/**
 * Real-time Sync Client - WebSocket subscriptions for Base44 entities
 * 
 * Uses base44.entities.*.subscribe() to receive real-time updates for:
 * - Delivery entities
 * - Patient entities
 * - AppUser entities
 * 
 * Broadcasts changes to the app and notifies all listeners.
 */

import { base44 } from '@/api/base44Client';

// Global listeners for real-time updates
const listeners = new Set();

// Active subscription unsubscribers
const activeSubscriptions = new Map();

// Client state
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Helper to detect changed fields between old and new data
 */
const getChangedFields = (oldData, newData) => {
  if (!oldData || !newData) return [];
  const changed = [];
  for (const key in newData) {
    if (oldData[key] !== newData[key]) {
      changed.push(key);
    }
  }
  return changed;
};

/**
 * Subscribe to entity changes
 */
const subscribeToEntity = (entityName) => {
  if (activeSubscriptions.has(entityName)) {
    console.log(`✅ [RealtimeSync] Already subscribed to ${entityName}`);
    return;
  }

  try {
    console.log(`🔗 [RealtimeSync] Subscribing to ${entityName} WebSocket...`);

    // Keep track of entity data to detect changes
    const entityDataCache = new Map();

    const unsubscribe = base44.entities[entityName].subscribe(async (event) => {
      const { type, id, data } = event;
      
      // Get current user name for "updatedBy"
      let updatedBy = 'System';
      try {
        const userCache = sessionStorage.getItem('effectiveUserCache');
        if (userCache) {
          const parsed = JSON.parse(userCache);
          updatedBy = parsed?.user?.user_name || parsed?.user?.full_name || 'System';
        }
      } catch (e) {
        // Ignore
      }

      // Detect changed fields for updates
      let changedFields = [];
      if (type === 'update') {
        const oldData = entityDataCache.get(id);
        changedFields = getChangedFields(oldData, data);
        entityDataCache.set(id, data);
      } else if (type === 'create') {
        entityDataCache.set(id, data);
      } else if (type === 'delete') {
        entityDataCache.delete(id);
      }
      
      console.log(`📡 [RealtimeSync] ${entityName} ${type}: ${id}`, changedFields.length > 0 ? `changed: ${changedFields.join(', ')}` : '');
      
      // CRITICAL: Save to offline DB immediately on WebSocket update
      try {
        const { offlineDB } = await import('./offlineDatabase');
        
        if (type === 'create' || type === 'update') {
          const storeName = entityName === 'AppUser' ? offlineDB.STORES.APP_USERS :
                           entityName === 'Delivery' ? offlineDB.STORES.DELIVERIES :
                           entityName === 'Patient' ? offlineDB.STORES.PATIENTS :
                           entityName === 'City' ? offlineDB.STORES.CITIES :
                           entityName === 'Store' ? offlineDB.STORES.STORES :
                           entityName === 'Message' ? null : null;
          
          if (storeName) {
            await offlineDB.save(storeName, data);
            console.log(`💾 [RealtimeSync] Saved ${entityName} to offline DB - changed: ${changedFields.join(', ')}`);
          }
        } else if (type === 'delete') {
          const storeName = entityName === 'AppUser' ? offlineDB.STORES.APP_USERS :
                           entityName === 'Delivery' ? offlineDB.STORES.DELIVERIES :
                           entityName === 'Patient' ? offlineDB.STORES.PATIENTS :
                           null;
          
          if (storeName) {
            await offlineDB.deleteRecord(storeName, id);
            console.log(`💾 [RealtimeSync] Deleted ${entityName} from offline DB: ${id}`);
          }
        }
      } catch (offlineError) {
        console.warn(`⚠️ [RealtimeSync] Failed to update offline DB for ${entityName}:`, offlineError.message);
      }
      
      // Show broadcast notification with metadata
      showBroadcastNotification(entityName, type, data);

      // Notify all listeners with full metadata
      listeners.forEach(callback => {
        try {
          callback({ 
            entityType: entityName, 
            eventType: type, 
            data, 
            id,
            updatedBy,
            changedFields
          });
        } catch (error) {
          console.error('❌ [RealtimeSync] Listener error:', error);
        }
      });

      // Dispatch custom event for other parts of the app with full metadata
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(`realtimeUpdate_${entityName}`, {
          detail: { type, id, data, updatedBy, changedFields }
        }));

        // CRITICAL: For AppUser updates, also dispatch 'appUserUpdated' so that
        // DriverStatusToggle and LocationTrackingToggle (mounted in Layout, outside the
        // Dashboard's cityFilteredRealtimeSync pipeline) always receive their own status changes.
        if (entityName === 'AppUser' && (type === 'create' || type === 'update') && data) {
          window.dispatchEvent(new CustomEvent('appUserUpdated', {
            detail: { appUser: data, fromRealtime: true }
          }));
        }
      }
    });

    activeSubscriptions.set(entityName, unsubscribe);
    console.log(`✅ [RealtimeSync] Successfully subscribed to ${entityName}`);
  } catch (error) {
    console.error(`❌ [RealtimeSync] Failed to subscribe to ${entityName}:`, error);
  }
};

/**
 * Connect to real-time sync
 */
export const connect = () => {
  console.log('🔗 [RealtimeSync] Connecting to WebSocket...');
  
  try {
    // Subscribe to key entities
    subscribeToEntity('Delivery');
    subscribeToEntity('Patient');
    subscribeToEntity('AppUser');
    subscribeToEntity('Message');

    isConnected = true;
    reconnectAttempts = 0;
    console.log('✅ [RealtimeSync] WebSocket connected');
  } catch (error) {
    console.error('❌ [RealtimeSync] Connection failed:', error);
    isConnected = false;
    attemptReconnect();
  }
};

/**
 * Disconnect from real-time sync
 */
export const disconnect = () => {
  console.log('🔌 [RealtimeSync] Disconnecting from WebSocket...');
  
  activeSubscriptions.forEach((unsubscribe, entityName) => {
    try {
      unsubscribe();
      console.log(`✅ [RealtimeSync] Unsubscribed from ${entityName}`);
    } catch (error) {
      console.error(`❌ [RealtimeSync] Error unsubscribing from ${entityName}:`, error);
    }
  });

  activeSubscriptions.clear();
  isConnected = false;
};

/**
 * Attempt reconnection with exponential backoff
 */
const attemptReconnect = () => {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.warn('❌ [RealtimeSync] Max reconnection attempts reached');
    return;
  }

  reconnectAttempts++;
  const backoffMs = Math.pow(2, reconnectAttempts) * 1000;
  
  console.log(`🔄 [RealtimeSync] Reconnecting in ${backoffMs}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  
  setTimeout(() => {
    connect();
  }, backoffMs);
};

/**
 * Check if connected
 */
export const isConnectedStatus = () => isConnected;

/**
 * Get connection status
 */
export const getStatus = () => ({
  connected: isConnected,
  activeSubscriptions: Array.from(activeSubscriptions.keys()),
  reconnectAttempts
});

/**
 * Force reconnect
 */
export const reconnect = () => {
  console.log('🔄 [RealtimeSync] Force reconnecting...');
  disconnect();
  reconnectAttempts = 0;
  connect();
};

/**
 * Subscribe to real-time updates
 */
export const subscribeToRealtime = (callback) => {
  listeners.add(callback);
  return () => listeners.delete(callback);
};

/**
 * Broadcast a local mutation
 */
export const broadcastMutation = (entity, action, id, data, ids = null) => {
  console.log(`📡 [RealtimeSync] Broadcasting ${entity} ${action}: ${id}`);
  
  // Dispatch to all listeners
  listeners.forEach(callback => {
    try {
      callback({ entityType: entity, eventType: action, data, id });
    } catch (error) {
      console.error('❌ [RealtimeSync] Broadcast listener error:', error);
    }
  });

  // Dispatch custom event
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(`realtimeUpdate_${entity}`, {
      detail: { type: action, id, data }
    }));
  }

  return true;
};

// Export singleton instance
export const realtimeSync = {
  connect,
  disconnect,
  isConnected: isConnectedStatus,
  getStatus,
  reconnect,
  subscribe: subscribeToRealtime,
  broadcast: broadcastMutation
};

export default realtimeSync;