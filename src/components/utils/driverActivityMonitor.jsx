/**
 * Driver Activity Monitor
 * Automatically sets driver status based on location activity and remaining stops:
 * - No movement for 5+ min + active stops → on_break
 * - No movement for 5+ min + no active stops → off_duty
 */

import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';

class DriverActivityMonitor {
  constructor() {
    this.isRunning = false;
    this.intervalId = null;
    this.CHECK_INTERVAL = 60000; // Check every 60 seconds
    this.INACTIVITY_THRESHOLD = 5 * 60 * 1000; // 5 minutes in milliseconds
  }

  start(currentUser) {
    if (this.isRunning || !currentUser) return;

    // Only monitor for drivers (not admin/dispatcher)
    if (!currentUser.app_roles?.includes('driver')) return;
    if (currentUser.app_roles?.includes('admin') || currentUser.app_roles?.includes('dispatcher')) return;

    this.isRunning = true;
    console.log('🔍 [Activity Monitor] Started monitoring driver activity');

    // Run check immediately, then every minute
    this.checkDriverActivity(currentUser);
    this.intervalId = setInterval(() => this.checkDriverActivity(currentUser), this.CHECK_INTERVAL);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('🔍 [Activity Monitor] Stopped');
  }

  async checkDriverActivity(currentUser) {
    try {
      // Only check if driver is currently on_duty
      if (currentUser.driver_status !== 'on_duty') {
        return;
      }

      // Check if location tracking is enabled
      if (currentUser.location_tracking_enabled !== true) {
        return;
      }

      // Get driver's last location update time
      const lastUpdateTime = currentUser.location_updated_at;
      if (!lastUpdateTime) {
        return;
      }

      const timeSinceUpdate = Date.now() - new Date(lastUpdateTime).getTime();

      // If location was updated recently (< 5 minutes), driver is active
      if (timeSinceUpdate < this.INACTIVITY_THRESHOLD) {
        return;
      }

      console.log(`⚠️ [Activity Monitor] Driver hasn't moved in ${Math.round(timeSinceUpdate / 60000)} minutes`);

      // CRITICAL: Check if a status change is in progress (avoid race condition)
      const statusChangeInProgress = sessionStorage.getItem('driver_status_change_in_progress');
      if (statusChangeInProgress) {
        const changeStart = parseInt(statusChangeInProgress, 10);
        const timeSinceChange = Date.now() - changeStart;
        
        // If status change started within last 5 seconds, skip this check
        if (timeSinceChange < 5000) {
          console.log('⏸️ [Activity Monitor] Skipping - driver status change in progress');
          return;
        }
      }

      // Check for active stops today
      const todayStr = format(new Date(), 'yyyy-MM-dd');
      const todayDeliveries = await base44.entities.Delivery.filter({
        delivery_date: todayStr,
        driver_id: currentUser.id
      });

      const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
      const activeStops = todayDeliveries.filter(d => 
        d && !finishedStatuses.includes(d.status) && d.status !== 'pending'
      );

      let newStatus;
      if (activeStops.length > 0) {
        // Has active stops → set to on_break
        newStatus = 'on_break';
        console.log(`☕ [Activity Monitor] Setting driver to ON BREAK (${activeStops.length} active stops remaining)`);
      } else {
        // No active stops → set to off_duty
        newStatus = 'off_duty';
        console.log(`🏁 [Activity Monitor] Setting driver to OFF DUTY (no active stops)`);
      }

      // CRITICAL: Find AppUser record by user_id, not by id
      const appUserRecords = await base44.entities.AppUser.filter({ user_id: currentUser.id });
      const appUserRecord = appUserRecords?.[0];
      
      if (!appUserRecord) {
        console.warn('⚠️ [Activity Monitor] AppUser record not found for user:', currentUser.id);
        return;
      }

      // Update driver status using AppUser record ID
      await base44.entities.AppUser.update(appUserRecord.id, {
        driver_status: newStatus
      });

      console.log(`✅ [Activity Monitor] Driver status updated to ${newStatus}`);

      // Notify app to refresh user data
      window.dispatchEvent(new CustomEvent('driverStatusAutoUpdated', {
        detail: { newStatus }
      }));

    } catch (error) {
      console.error('❌ [Activity Monitor] Error checking driver activity:', error);
    }
  }
}

export const driverActivityMonitor = new DriverActivityMonitor();