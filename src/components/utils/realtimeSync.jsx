// Real-time sync manager - broadcasts entity changes to all connected devices
import { base44 } from '@/api/base44Client';

class RealtimeSyncManager {
  constructor() {
    this.listeners = new Set();
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 2000;
    this.isConnected = false;
    this.lastMessageTime = 0;
    this.heartbeatInterval = null;
  }

  /**
   * Initialize WebSocket connection for real-time updates
   */
  async connect() {
    try {
      // Get app info for WebSocket connection
      const appId = await this.getAppId();
      if (!appId) {
        console.warn('⚠️ [RealtimeSync] No app ID available, skipping WebSocket connection');
        return;
      }

      const wsUrl = `wss://api.base44.com/ws/${appId}/sync`;
      console.log('🔌 [RealtimeSync] Connecting to WebSocket:', wsUrl);

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('✅ [RealtimeSync] WebSocket connected');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.startHeartbeat();
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.lastMessageTime = Date.now();
          
          if (message.type === 'entity_updated') {
            console.log('📢 [RealtimeSync] Entity update received:', message.entity);
            this.notifyListeners(message);
          }
        } catch (error) {
          console.error('❌ [RealtimeSync] Error parsing message:', error);
        }
      };

      this.ws.onerror = (error) => {
        console.error('❌ [RealtimeSync] WebSocket error:', error);
      };

      this.ws.onclose = () => {
        console.log('🔌 [RealtimeSync] WebSocket disconnected');
        this.isConnected = false;
        this.stopHeartbeat();
        this.attemptReconnect();
      };

    } catch (error) {
      console.error('❌ [RealtimeSync] Connection error:', error);
    }
  }

  /**
   * Get app ID from Base44 SDK
   */
  async getAppId() {
    try {
      // Extract app ID from SDK or environment
      const envAppId = import.meta.env?.VITE_BASE44_APP_ID;
      if (envAppId) return envAppId;
      
      // Fallback: try to get from SDK internals
      return null;
    } catch (error) {
      console.error('❌ [RealtimeSync] Error getting app ID:', error);
      return null;
    }
  }

  /**
   * Start heartbeat to keep connection alive
   */
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000); // 30 seconds
  }

  /**
   * Stop heartbeat
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Attempt to reconnect with exponential backoff
   */
  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('❌ [RealtimeSync] Max reconnect attempts reached');
      return;
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    console.log(`🔄 [RealtimeSync] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  /**
   * Broadcast entity change to backend (which will notify all other devices)
   */
  async broadcastChange(entityName, operation, data) {
    try {
      // Use backend function to broadcast change
      await base44.functions.invoke('broadcastEntityChange', {
        entity_name: entityName,
        operation: operation, // 'create', 'update', 'delete', 'bulk_create'
        timestamp: new Date().toISOString(),
        metadata: data
      });
      
      console.log(`📡 [RealtimeSync] Broadcasted ${operation} for ${entityName}`);
    } catch (error) {
      console.warn('⚠️ [RealtimeSync] Broadcast failed:', error);
      // Don't throw - broadcasting is best-effort
    }
  }

  /**
   * Subscribe to entity change notifications
   */
  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Notify all listeners of entity changes
   */
  notifyListeners(message) {
    this.listeners.forEach(callback => {
      try {
        callback(message);
      } catch (error) {
        console.error('❌ [RealtimeSync] Listener error:', error);
      }
    });
  }

  /**
   * Disconnect WebSocket
   */
  disconnect() {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }
}

export const realtimeSyncManager = new RealtimeSyncManager();