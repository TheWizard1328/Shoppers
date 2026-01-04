/**
 * Real-time Sync Client (Stub)
 * 
 * NOTE: WebSocket connections are not supported in Base44's serverless environment.
 * This module provides stub functions that do nothing, allowing the app to work
 * without real-time sync. The existing smart refresh system handles data updates.
 * 
 * In the future, if Base44 adds support for WebSockets or Server-Sent Events,
 * this module can be updated to use those features.
 */

// Listeners (not used but kept for API compatibility)
const listeners = new Set();

/**
 * Subscribe to real-time updates (no-op)
 */
export const subscribeToRealtime = (callback) => {
  listeners.add(callback);
  return () => listeners.delete(callback);
};

/**
 * Broadcast a local mutation (no-op - smart refresh handles sync)
 */
export const broadcastMutation = (entity, action, id, data, ids = null) => {
  // No-op: WebSocket not supported in serverless environment
  // Smart refresh handles cross-device sync via polling
  return false;
};

/**
 * Connect (no-op)
 */
export const connect = () => {
  // No-op: WebSocket not supported
};

/**
 * Disconnect (no-op)
 */
export const disconnect = () => {
  // No-op
};

/**
 * Check if connected (always false)
 */
export const isConnected = () => false;

/**
 * Get connection status
 */
export const getStatus = () => ({
  connected: false,
  clientId: null,
  reconnectAttempts: 0
});

/**
 * Force reconnect (no-op)
 */
export const reconnect = () => {
  // No-op
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