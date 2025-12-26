// Real-time sync manager - broadcasts entity changes to all connected devices
// Uses hybrid adaptive polling: fast (10s) after local changes, slow (60s) otherwise
import { base44 } from '@/api/base44Client';
import { getDeviceId } from './userSettingsManager';

// Polling intervals
const FAST_POLL_INTERVAL = 15000; // 15 seconds after local change
const SLOW_POLL_INTERVAL = 30000; // 30 seconds normally
const FAST_POLL_DURATION = 30000; // Stay fast for 30 seconds after local change

class RealtimeSyncManager {
  constructor() {
    this.listeners = new Set();
    this.deviceId = null;
    this.lastLocalChangeTime = 0;
    this.lastProcessedBroadcastIds = new Set();
    this.pollInterval = null;
    this.isPolling = false;
    this.currentUserId = null;
  }

  /**
   * Initialize device ID for cross-device sync filtering
   */
  async initDeviceId() {
    if (!this.deviceId) {
      this.deviceId = await getDeviceId();
    }
    return this.deviceId;
  }

  /**
   * Start adaptive polling for sync broadcasts
   */
  startPolling(userId) {
    if (this.isPolling) return;
    
    this.currentUserId = userId;
    this.isPolling = true;
    console.log('🔄 [RealtimeSync] Starting adaptive polling...');
    
    // Initial poll after short delay
    setTimeout(() => this.poll(), 5000);
    
    // Set up adaptive interval
    this.scheduleNextPoll();
  }

  /**
   * Stop polling
   */
  stopPolling() {
    this.isPolling = false;
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }
    console.log('⏹️ [RealtimeSync] Stopped polling');
  }

  /**
   * Schedule the next poll based on recent activity
   */
  scheduleNextPoll() {
    if (!this.isPolling) return;
    
    const timeSinceLocalChange = Date.now() - this.lastLocalChangeTime;
    const interval = timeSinceLocalChange < FAST_POLL_DURATION ? FAST_POLL_INTERVAL : SLOW_POLL_INTERVAL;
    
    this.pollInterval = setTimeout(() => {
      this.poll();
      this.scheduleNextPoll();
    }, interval);
  }

  /**
   * Trigger fast polling mode (called after local changes)
   */
  triggerFastPolling() {
    this.lastLocalChangeTime = Date.now();
    console.log('⚡ [RealtimeSync] Fast polling mode activated for 30 seconds');
    
    // Reschedule to use fast interval immediately
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.scheduleNextPoll();
    }
    
    // Also do an immediate poll
    setTimeout(() => this.poll(), 1000);
  }

  /**
   * Poll for new broadcasts from other devices
   */
  async poll() {
    if (!this.isPolling || !this.currentUserId) return;
    
    try {
      // Ensure device ID is initialized
      if (!this.deviceId) {
        this.deviceId = await getDeviceId();
      }

      // Fetch recent broadcasts (last 2 minutes)
      const broadcasts = await base44.entities.SyncBroadcast.filter(
        {
          created_date: { $gte: new Date(Date.now() - 120000).toISOString() }
        },
        '-created_date',
        20
      );

      // Filter out:
      // 1. Broadcasts from THIS DEVICE
      // 2. Broadcasts we've already processed
      // 3. Broadcasts from the same user (fallback if no device_id)
      const newBroadcasts = broadcasts.filter(b => {
        // Skip if already processed
        if (this.lastProcessedBroadcastIds.has(b.id)) return false;
        
        const broadcastDeviceId = b.device_id || b.data?.device_id;
        const triggeredBy = b.triggered_by || b.data?.triggered_by;
        
        // Filter by device if available, otherwise by user
        if (broadcastDeviceId && this.deviceId) {
          return broadcastDeviceId !== this.deviceId;
        }
        return triggeredBy !== this.currentUserId;
      });

      if (newBroadcasts.length > 0) {
        console.log(`📢 [RealtimeSync] Found ${newBroadcasts.length} new broadcast(s) from other devices`);
        
        // Mark as processed
        newBroadcasts.forEach(b => this.lastProcessedBroadcastIds.add(b.id));
        
        // Keep only last 100 processed IDs to prevent memory bloat
        if (this.lastProcessedBroadcastIds.size > 100) {
          const ids = Array.from(this.lastProcessedBroadcastIds);
          this.lastProcessedBroadcastIds = new Set(ids.slice(-50));
        }
        
        // Normalize and notify listeners
        const normalizedBroadcasts = newBroadcasts.map(b => ({
          id: b.id,
          entity_name: b.entity_name || b.data?.entity_name || 'Unknown',
          operation: b.operation || b.data?.operation || 'unknown',
          triggered_by: b.triggered_by || b.data?.triggered_by,
          triggered_by_name: b.triggered_by_name || b.data?.triggered_by_name || 'Unknown',
          device_id: b.device_id || b.data?.device_id,
          metadata: b.metadata || b.data?.metadata || {}
        }));
        
        // Notify all listeners
        this.notifyListeners({
          type: 'broadcasts_received',
          broadcasts: normalizedBroadcasts
        });
      }
    } catch (error) {
      // Silently handle errors - don't spam console
      if (!error.message?.includes('429') && !error.message?.includes('Rate limit')) {
        console.warn('⚠️ [RealtimeSync] Poll error:', error.message);
      }
    }
  }

  /**
   * Broadcast entity change to backend (which will notify all other devices)
   */
  async broadcastChange(entityName, operation, data) {
    try {
      // Ensure device ID is initialized
      await this.initDeviceId();
      
      // Use backend function to broadcast change
      await base44.functions.invoke('broadcastEntityChange', {
        entity_name: entityName,
        operation: operation, // 'create', 'update', 'delete', 'bulk_create'
        timestamp: new Date().toISOString(),
        device_id: this.deviceId,
        metadata: data
      });
      
      console.log(`📡 [RealtimeSync] Broadcasted ${operation} for ${entityName} (device: ${this.deviceId})`);
      
      // Trigger fast polling on all devices after a broadcast
      this.triggerFastPolling();
    } catch (error) {
      console.warn('⚠️ [RealtimeSync] Broadcast failed:', error);
      // Don't throw - broadcasting is best-effort
    }
  }

  /**
   * Get current device ID (sync version)
   */
  getDeviceIdSync() {
    return this.deviceId;
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
   * Disconnect/cleanup
   */
  disconnect() {
    this.stopPolling();
  }
}

export const realtimeSyncManager = new RealtimeSyncManager();