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

// Buffered inbound realtime events to reduce UI thrash
const DEBOUNCE_MS = 1000; // per request
const eventBuffers = {
  Delivery: new Map(),
  Patient: new Map(),
  AppUser: new Map(),
  Message: new Map(),
};
const flushTimers = {};

function bufferEvent(entityName, payload) {
  const buf = eventBuffers[entityName] || new Map();
  eventBuffers[entityName] = buf;
  const prev = buf.get(payload.id);
  if (prev) {
    const mergedChanged = Array.from(new Set([...(prev.changedFields || []), ...(payload.changedFields || [])]));
    buf.set(payload.id, { ...prev, ...payload, changedFields: mergedChanged });
  } else {
    buf.set(payload.id, payload);
  }
  if (!flushTimers[entityName]) {
    flushTimers[entityName] = setTimeout(() => flushBuffered(entityName), DEBOUNCE_MS);
  }
}

function flushBuffered(entityName) {
  const buf = eventBuffers[entityName];
  if (!buf || buf.size === 0) { if (flushTimers[entityName]) { clearTimeout(flushTimers[entityName]); flushTimers[entityName] = null; } return; }
  const items = Array.from(buf.values());
  buf.clear();
  if (flushTimers[entityName]) { clearTimeout(flushTimers[entityName]); flushTimers[entityName] = null; }

  // Notify listeners and dispatch window events once per record
  items.forEach(({ entityType, eventType, data, id, updatedBy, changedFields }) => {
    listeners.forEach(callback => {
      try { callback({ entityType, eventType, data, id, updatedBy, changedFields }); } catch (err) { console.error('❌ [RealtimeSync] Listener error:', err); }
    });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(`realtimeUpdate_${entityName}`, { detail: { type: eventType, id, data, updatedBy, changedFields } }));
      if (entityName === 'AppUser' && (eventType === 'create' || eventType === 'update') && data) {
        window.dispatchEvent(new CustomEvent('appUserUpdated', { detail: { appUser: data, fromRealtime: true } }));
      }
    }
  });

  // Center next delivery card if any update warrants it
  if (entityName === 'Delivery' && items.some(it => shouldCenterForDeliveryUpdate(it.data, it.changedFields))) {
    scheduleAfterUISettled(() => {
      triggerCenterNextDeliveryCard({ source: 'realtimeSyncBuffered' });
    });
  }
}


// Active subscription unsubscribers
const activeSubscriptions = new Map();

// Client state
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Helpers for auto-centering the "next delivery" card after UI settles
let centerEventTimer = null;
const scheduleAfterUISettled = (fn) => {
  if (typeof window === 'undefined') return;
  const raf = window.requestAnimationFrame || ((cb) => setTimeout(cb, 16));
  // Double RAF + microtask to wait for React state commits/paint
  raf(() => raf(() => setTimeout(fn, 0)));
};

const getEffectiveUser = () => {
  try {
    const cache = sessionStorage.getItem('effectiveUserCache');
    if (cache) return JSON.parse(cache);
  } catch {}
  return null;
};

const isDeliveryVisibleToUser = (delivery) => {
  const eff = getEffectiveUser();
  if (!eff) return true; // Fallback: don't block if unknown
  const roles = eff?.appUser?.app_roles || eff?.user?.app_roles || [];
  const appUserId = eff?.appUser?.id || eff?.user?.app_user_id;
  const userId = eff?.user?.id || eff?.user?.user_id;

  // Driver: visible if delivery driver_id matches app user or user id (support both schemas)
  if (roles.includes('driver')) {
    if (delivery?.driver_id && (delivery.driver_id === appUserId || delivery.driver_id === userId)) return true;
  }

  // Dispatcher/Admin: visible if store_id is one they manage
  const storeIds = eff?.appUser?.store_ids || eff?.user?.store_ids || [];
  if ((roles.includes('dispatcher') || roles.includes('admin')) && delivery?.store_id && Array.isArray(storeIds)) {
    if (storeIds.includes(delivery.store_id)) return true;
  }

  return false;
};

const shouldCenterForDeliveryUpdate = (data, changedFields) => {
  if (!data) return false;
  if (!isDeliveryVisibleToUser(data)) return false;
  const statusChanged = Array.isArray(changedFields) && changedFields.includes('status');
  const isNextChanged = Array.isArray(changedFields) && changedFields.includes('isNextDelivery');
  const status = data?.status;

  if ((statusChanged && (status === 'en_route' || status === 'completed')) || isNextChanged) {
    // For isNextChanged, prefer when it becomes true
    if (isNextChanged) {
      return data?.isNextDelivery === true;
    }
    return true;
  }
  return false;
};

const triggerCenterNextDeliveryCard = (payload) => {
  if (centerEventTimer) {
    clearTimeout(centerEventTimer);
    centerEventTimer = null;
  }
  // Debounce slightly to coalesce bursts of updates
  centerEventTimer = setTimeout(() => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('centerNextDeliveryCard', { detail: payload }));
    }
  }, 50);
};

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
      
      // Buffer notifications to debounce UI updates
      bufferEvent(entityName, { entityType: entityName, eventType: type, data, id, updatedBy, changedFields });
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

    // Instantly cascade Patient changes to related Deliveries in OFFLINE DB + UI
    window.addEventListener('realtimeUpdate_Patient', async (e) => {
      try {
        const { data, changedFields } = e.detail || {};
        if (!data?.id) return;

        // Build local patch mirroring backend cascade
        const patch = {
          patient_name: data.full_name || null,
          patient_phone: data.phone || null,
          unit_number: data.unit_number || null,
          delivery_instructions: data.notes || null,
          mailbox_ok: !!data.mailbox_ok,
          call_upon_arrival: !!data.call_upon_arrival,
          ring_bell: data.dont_ring_bell ? false : (typeof data.ring_bell === 'boolean' ? data.ring_bell : true),
          dont_ring_bell: !!data.dont_ring_bell,
          back_door: !!data.back_door,
        };

        const { offlineDB } = await import('./offlineDatabase');
        const allDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
        const activeStatuses = new Set(['pending','en_route','in_transit']);
        const toUpdate = (allDeliveries || []).filter(d => d?.patient_id === data.id && activeStatuses.has(d?.status || 'pending'));

        if (toUpdate.length === 0) return;

        const nowIso = new Date().toISOString();
        const patched = toUpdate.map(d => ({ ...d, ...patch, updated_date: nowIso }));
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, patched);

        // Broadcast local Delivery updates so UI rerenders immediately
        patched.forEach(d => {
          try { broadcastMutation('Delivery', 'update', d.id, d); } catch {}
        });

        // Update sync statuses and emit a soft refresh hint (non-blocking)
        await offlineDB.updateSyncStatus('Patient', { status: 'synced' });
        await offlineDB.updateSyncStatus('Delivery', { status: 'synced' });
        window.dispatchEvent(new CustomEvent('softRefreshDeliveries', { detail: { reason: 'patient_update_cascade', patientId: data.id, changedFields } }));
      } catch (err) {
        console.warn('⚠️ [RealtimeSync] Local cascade on Patient update failed:', err?.message);
      }
    }, { once: false });

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