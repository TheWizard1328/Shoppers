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
 * Show real-time broadcast notification in top right
 * CRITICAL: Only show on non-primary devices
 */
const showBroadcastNotification = async (entityName, eventType, data) => {
  if (typeof window === 'undefined') return;

  // CRITICAL: Don't show notifications on primary device (it made the change)
  try {
    const { deviceManager } = await import('./deviceManager');
    const isPrimary = await deviceManager.isPrimaryTracker();
    if (isPrimary) {
      console.log(`ℹ️ [RealtimeSync] Suppressing notification on primary device`);
      return;
    }
  } catch (error) {
    console.warn('⚠️ [RealtimeSync] Could not check primary device status:', error);
  }

  const notificationId = `broadcast-${entityName}-${eventType}-${Date.now()}`;
  const notification = document.createElement('div');
  
  const entityLabel = {
    'Delivery': '📦',
    'Patient': '👤',
    'AppUser': '👨‍💼'
  }[entityName] || '🔄';

  const eventLabel = {
    'create': '✨ Created',
    'update': '🔄 Updated',
    'delete': '🗑️ Deleted'
  }[eventType] || eventType;

  notification.id = notificationId;
  notification.className = 'fixed top-4 right-4 z-[9999] animate-in slide-in-from-top-4 fade-in duration-300';
  notification.innerHTML = `
    <div style="
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 12px 16px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      font-size: 13px;
      font-weight: 500;
      max-width: 300px;
      word-break: break-word;
    ">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 16px;">${entityLabel}</span>
        <div>
          <div style="font-weight: 600;">${entityName} ${eventLabel}</div>
          <div style="font-size: 11px; opacity: 0.9;">WebSocket sync received</div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(notification);

  // Auto-remove after 3 seconds
  setTimeout(() => {
    notification.style.animation = 'slide-out-to-top fade-out 300ms ease-in-out forwards';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
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

    const unsubscribe = base44.entities[entityName].subscribe((event) => {
      const { type, id, data } = event;
      
      console.log(`📡 [RealtimeSync] ${entityName} ${type}: ${id}`);
      
      // Show broadcast notification
      showBroadcastNotification(entityName, type, data);

      // Notify all listeners
      listeners.forEach(callback => {
        try {
          callback({ entityType: entityName, eventType: type, data, id });
        } catch (error) {
          console.error('❌ [RealtimeSync] Listener error:', error);
        }
      });

      // Dispatch custom event for other parts of the app
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(`realtimeUpdate_${entityName}`, {
          detail: { type, id, data }
        }));
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