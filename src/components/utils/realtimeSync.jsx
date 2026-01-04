/**
 * Real-time Sync Client
 * 
 * Manages WebSocket connection for instant data synchronization
 * between devices/users for Delivery and AppUser entities.
 * 
 * Features:
 * - Auto-reconnect with exponential backoff
 * - Heartbeat/keepalive
 * - Broadcasts local mutations to other devices
 * - Receives and applies remote mutations instantly
 */

// WebSocket connection state
let ws = null;
let clientId = null;
let reconnectAttempts = 0;
let reconnectTimeout = null;
let heartbeatInterval = null;
let isConnecting = false;
let isIntentionalClose = false;

// Listeners for real-time updates
const listeners = new Set();

// Configuration
const CONFIG = {
  maxReconnectAttempts: 10,
  baseReconnectDelay: 1000,
  maxReconnectDelay: 30000,
  heartbeatInterval: 30000, // 30 seconds
  connectionTimeout: 10000
};

/**
 * Get WebSocket URL for the realtimeSync function
 */
const getWebSocketUrl = () => {
  // In Base44, functions are accessed via the app URL
  const baseUrl = window.location.origin;
  const appId = baseUrl.includes('base44.app') ? 
    window.location.pathname.split('/')[2] : 
    null;
  
  // Construct WebSocket URL
  // Base44 function URLs: https://base44.app/api/apps/{appId}/functions/{functionName}
  // WebSocket: wss://base44.app/api/apps/{appId}/functions/{functionName}
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  
  // Use relative path that will be handled by the platform
  return `${protocol}//${window.location.host}/api/functions/realtimeSync`;
};

/**
 * Subscribe to real-time updates
 * Callback receives: { type, entity, action, id, ids, data, timestamp }
 */
export const subscribeToRealtime = (callback) => {
  listeners.add(callback);
  return () => listeners.delete(callback);
};

/**
 * Notify all listeners of an update
 */
const notifyListeners = (update) => {
  listeners.forEach(callback => {
    try {
      callback(update);
    } catch (error) {
      console.error('[RealtimeSync] Error in listener:', error);
    }
  });
};

/**
 * Send a message through WebSocket
 */
const send = (message) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
};

/**
 * Broadcast a local mutation to other devices
 */
export const broadcastMutation = (entity, action, id, data, ids = null) => {
  const message = {
    type: 'mutation',
    entity,
    action,
    id,
    ids,
    data,
    timestamp: Date.now()
  };
  
  const sent = send(message);
  if (sent) {
    console.log(`📤 [RealtimeSync] Broadcast: ${entity} ${action}`, id || ids);
  }
  return sent;
};

/**
 * Start heartbeat to keep connection alive
 */
const startHeartbeat = () => {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      send({ type: 'ping' });
    }
  }, CONFIG.heartbeatInterval);
};

/**
 * Stop heartbeat
 */
const stopHeartbeat = () => {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
};

/**
 * Calculate reconnect delay with exponential backoff
 */
const getReconnectDelay = () => {
  const delay = Math.min(
    CONFIG.baseReconnectDelay * Math.pow(2, reconnectAttempts),
    CONFIG.maxReconnectDelay
  );
  return delay;
};

/**
 * Connect to WebSocket server
 */
export const connect = () => {
  if (isConnecting || (ws && ws.readyState === WebSocket.OPEN)) {
    console.log('[RealtimeSync] Already connected or connecting');
    return;
  }
  
  isConnecting = true;
  isIntentionalClose = false;
  
  try {
    const url = getWebSocketUrl();
    console.log(`🔗 [RealtimeSync] Connecting to ${url}...`);
    
    ws = new WebSocket(url);
    
    // Connection timeout
    const connectionTimer = setTimeout(() => {
      if (ws && ws.readyState === WebSocket.CONNECTING) {
        console.warn('[RealtimeSync] Connection timeout');
        ws.close();
      }
    }, CONFIG.connectionTimeout);
    
    ws.onopen = () => {
      clearTimeout(connectionTimer);
      isConnecting = false;
      reconnectAttempts = 0;
      console.log('✅ [RealtimeSync] Connected');
      startHeartbeat();
      
      // Subscribe to entities we care about
      send({
        type: 'subscribe',
        entities: ['Delivery', 'AppUser']
      });
      
      // Notify listeners of connection
      notifyListeners({ type: 'connected' });
    };
    
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        
        switch (message.type) {
          case 'connected':
            clientId = message.clientId;
            console.log(`[RealtimeSync] Assigned client ID: ${clientId}`);
            break;
            
          case 'pong':
            // Heartbeat response - connection is alive
            break;
            
          case 'entity_change':
            // Remote mutation received - notify listeners
            console.log(`📥 [RealtimeSync] Received: ${message.entity} ${message.action}`, message.id || message.ids);
            notifyListeners(message);
            break;
            
          default:
            console.log('[RealtimeSync] Unknown message type:', message.type);
        }
      } catch (error) {
        console.error('[RealtimeSync] Error parsing message:', error);
      }
    };
    
    ws.onclose = (event) => {
      clearTimeout(connectionTimer);
      isConnecting = false;
      stopHeartbeat();
      
      console.log(`🔌 [RealtimeSync] Disconnected (code: ${event.code})`);
      
      // Notify listeners of disconnection
      notifyListeners({ type: 'disconnected' });
      
      // Auto-reconnect unless intentionally closed
      if (!isIntentionalClose && reconnectAttempts < CONFIG.maxReconnectAttempts) {
        const delay = getReconnectDelay();
        console.log(`[RealtimeSync] Reconnecting in ${delay}ms (attempt ${reconnectAttempts + 1}/${CONFIG.maxReconnectAttempts})`);
        
        reconnectTimeout = setTimeout(() => {
          reconnectAttempts++;
          connect();
        }, delay);
      } else if (reconnectAttempts >= CONFIG.maxReconnectAttempts) {
        console.warn('[RealtimeSync] Max reconnect attempts reached');
        notifyListeners({ type: 'max_reconnect_failed' });
      }
    };
    
    ws.onerror = (error) => {
      console.error('[RealtimeSync] WebSocket error:', error);
      isConnecting = false;
    };
    
  } catch (error) {
    console.error('[RealtimeSync] Failed to create WebSocket:', error);
    isConnecting = false;
  }
};

/**
 * Disconnect from WebSocket server
 */
export const disconnect = () => {
  isIntentionalClose = true;
  
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  
  stopHeartbeat();
  
  if (ws) {
    ws.close();
    ws = null;
  }
  
  clientId = null;
  reconnectAttempts = 0;
  console.log('[RealtimeSync] Disconnected intentionally');
};

/**
 * Check if connected
 */
export const isConnected = () => {
  return ws && ws.readyState === WebSocket.OPEN;
};

/**
 * Get connection status
 */
export const getStatus = () => ({
  connected: isConnected(),
  clientId,
  reconnectAttempts
});

/**
 * Force reconnect
 */
export const reconnect = () => {
  disconnect();
  reconnectAttempts = 0;
  setTimeout(connect, 100);
};

// Export singleton instance
export const realtimeSync = {
  connect,
  disconnect,
  isConnected,
  getStatus,
  reconnect,
  subscribe: subscribeToRealtime,
  broadcast: broadcastMutation
};

export default realtimeSync;