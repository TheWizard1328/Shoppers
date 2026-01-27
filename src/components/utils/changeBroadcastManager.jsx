/**
 * Change Broadcast Manager
 * Manages reading and writing ChangeBroadcast records for cross-device sync
 */

import { base44 } from '@/api/base44Client';
import { getDeviceId } from './deviceIdManager';
import { format } from 'date-fns';

class ChangeBroadcastManager {
  constructor() {
    this.lastCheckTime = 0;
    this.checkInterval = 15000; // Check every 15 seconds
    this.listeners = new Set();
  }

  /**
   * Subscribe to broadcast changes
   */
  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Notify all listeners of new broadcasts
   */
  notifyListeners(broadcasts) {
    this.listeners.forEach(cb => {
      try {
        cb(broadcasts);
      } catch (e) {
        console.error('[ChangeBroadcast] Listener error:', e);
      }
    });
  }

  /**
   * Create a broadcast for an entity change
   */
  async createBroadcast(params) {
    try {
      const deviceId = getDeviceId();
      
      // Get current user ID
      const user = await base44.auth.me();
      if (!user) {
        console.warn('[ChangeBroadcast] No user - cannot create broadcast');
        return null;
      }

      const broadcast = {
        entity_name: params.entity_name,
        change_type: params.change_type,
        sent_by_user_id: user.id,
        sent_by_device_id: deviceId,
        affected_city_id: params.affected_city_id,
        affected_store_id: params.affected_store_id,
        to_users: params.to_users || [],
        metadata: params.metadata || {}
      };

      // Add optional fields
      if (params.entity_id) broadcast.entity_id = params.entity_id;
      if (params.entity_ids && params.entity_ids.length > 0) broadcast.entity_ids = params.entity_ids;
      if (params.affected_date) broadcast.affected_date = params.affected_date;
      if (params.affected_dates) broadcast.affected_dates = params.affected_dates;
      if (params.affected_driver_id) broadcast.affected_driver_id = params.affected_driver_id;
      if (params.last_location_update_time) broadcast.last_location_update_time = params.last_location_update_time;
      if (params.driver_status) broadcast.driver_status = params.driver_status;

      // Create broadcast record
      const created = await base44.entities.ChangeBroadcast.create(broadcast);
      console.log(`📡 [ChangeBroadcast] Created: ${params.entity_name} ${params.change_type}`, created.id);
      
      return created;
    } catch (error) {
      console.error('[ChangeBroadcast] Failed to create broadcast:', error.message);
      return null;
    }
  }

  /**
   * Mark a broadcast as received by this device
   */
  async markReceived(broadcastId) {
    try {
      const deviceId = getDeviceId();
      const broadcast = await base44.entities.ChangeBroadcast.get(broadcastId);
      
      if (!broadcast) return;

      // Add this device to received_by_device_ids if not already present
      const receivedByDeviceIds = broadcast.received_by_device_ids || [];
      if (!receivedByDeviceIds.includes(deviceId)) {
        receivedByDeviceIds.push(deviceId);
        await base44.entities.ChangeBroadcast.update(broadcastId, {
          received_by_device_ids: receivedByDeviceIds
        });
      }
    } catch (error) {
      console.warn('[ChangeBroadcast] Failed to mark received:', error.message);
    }
  }

  /**
   * Check for new broadcasts since last check
   */
  async checkForBroadcasts(currentUser, cityId) {
    try {
      const deviceId = getDeviceId();
      const now = Date.now();

      // Throttle checks to prevent rate limits
      if (now - this.lastCheckTime < this.checkInterval) {
        return [];
      }
      this.lastCheckTime = now;

      // Query broadcasts:
      // - created in last 5 minutes (avoid fetching old broadcasts)
      // - not sent by this device
      // - not already received by this device
      // - for this user's city
      const fiveMinutesAgo = new Date(now - 300000).toISOString();
      
      const broadcasts = await base44.entities.ChangeBroadcast.filter({
        created_date: { $gte: fiveMinutesAgo },
        affected_city_id: cityId
      }, '-created_date', 100);

      if (!broadcasts || broadcasts.length === 0) {
        return [];
      }

      // Filter out broadcasts from this device and already received
      const relevantBroadcasts = broadcasts.filter(b => {
        // Skip if sent by this device
        if (b.sent_by_device_id === deviceId) return false;

        // Skip if already received by this device
        if (b.received_by_device_ids && b.received_by_device_ids.includes(deviceId)) return false;

        // Check if this user should receive it
        if (b.to_users && b.to_users.length > 0) {
          // Specific users targeted
          return b.to_users.includes(currentUser.id);
        }

        // No specific users = broadcast to all in city
        return true;
      });

      // CRITICAL: Process broadcasts based on type
      const processedBroadcasts = [];
      
      for (const broadcast of relevantBroadcasts) {
        // Driver location updates - check if we should refresh this driver
        if (broadcast.entity_name === 'AppUser' && broadcast.last_location_update_time) {
          const timeSinceUpdate = Date.now() - new Date(broadcast.last_location_update_time).getTime();
          
          // Only refresh if:
          // - Driver is on_duty
          // - Last update was > 10 seconds ago
          if (broadcast.driver_status === 'on_duty' && timeSinceUpdate > 10000) {
            processedBroadcasts.push(broadcast);
          } else if (broadcast.driver_status === 'off_duty' || broadcast.driver_status === 'on_break') {
            // Ignore location updates for off_duty/on_break drivers
            await this.markReceived(broadcast.id);
            continue;
          }
        } else {
          processedBroadcasts.push(broadcast);
        }

        // Mark as received
        await this.markReceived(broadcast.id);
      }

      if (processedBroadcasts.length > 0) {
        console.log(`📥 [ChangeBroadcast] Received ${processedBroadcasts.length} relevant broadcasts`);
        this.notifyListeners(processedBroadcasts);
      }

      return processedBroadcasts;
    } catch (error) {
      // Silent fail on rate limits
      if (error.response?.status === 429) {
        console.warn('[ChangeBroadcast] Rate limit - skipping check');
      } else {
        console.error('[ChangeBroadcast] Check failed:', error.message);
      }
      return [];
    }
  }

  /**
   * Cleanup old broadcasts (> 1 hour)
   * ADMIN ONLY - should be run periodically via automation
   */
  async cleanupOldBroadcasts() {
    try {
      const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
      const oldBroadcasts = await base44.entities.ChangeBroadcast.filter({
        created_date: { $lt: oneHourAgo }
      });

      if (oldBroadcasts && oldBroadcasts.length > 0) {
        for (const broadcast of oldBroadcasts) {
          await base44.entities.ChangeBroadcast.delete(broadcast.id);
        }
        console.log(`🧹 [ChangeBroadcast] Cleaned up ${oldBroadcasts.length} old broadcasts`);
      }
    } catch (error) {
      console.error('[ChangeBroadcast] Cleanup failed:', error.message);
    }
  }
}

export const changeBroadcastManager = new ChangeBroadcastManager();