/**
 * Background Sync Worker
 * 
 * Intelligently syncs data in the background during idle time.
 * Uses priority levels and monitors user activity to minimize API calls.
 * 
 * STRATEGY:
 * 1. HIGH PRIORITY (every 30s when active): On-duty drivers, active deliveries
 * 2. MEDIUM PRIORITY (every 5min): Today's patients, Square transactions
 * 3. LOW PRIORITY (every 30min): Historical deliveries, inactive data, Cities, Stores
 */

import { base44 } from '@/api/base44Client';
import { offlineDB } from './offlineDatabase';
import { format } from 'date-fns';
import { queueEntityRequest } from './requestQueue';

class BackgroundSyncWorker {
  constructor() {
    this.isRunning = false;
    this.isPaused = false;
    this.lastUserActivity = Date.now();
    this.listeners = new Set();
    
    // Track last sync times per priority level
    this.lastSync = {
      highPriority: 0,      // On-duty drivers, active deliveries
      mediumPriority: 0,    // Today's patients, Square TX
      lowPriority: 0        // Cities, Stores, historical data
    };
    
    // Sync intervals (milliseconds)
    this.intervals = {
      highPriority: 30000,    // 30 seconds - critical data
      mediumPriority: 300000, // 5 minutes - important but not critical
      lowPriority: 1800000    // 30 minutes - rarely changes
    };
    
    // Track consecutive errors for backoff
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 3;
    this.cooldownUntil = 0;
    
    // Setup user activity tracking
    this._setupActivityTracking();
  }
  
  /**
   * Track user activity to adjust sync frequency
   */
  _setupActivityTracking() {
    if (typeof window === 'undefined') return;
    
    const updateActivity = () => {
      this.lastUserActivity = Date.now();
    };
    
    ['click', 'keydown', 'scroll', 'touchstart'].forEach(event => {
      window.addEventListener(event, updateActivity, { passive: true });
    });
  }
  
  /**
   * Check if user is idle (no activity for 2 minutes)
   */
  isUserIdle() {
    return (Date.now() - this.lastUserActivity) > 120000;
  }
  
  /**
   * Start background sync worker
   */
  start() {
    if (this.isRunning) return;
    
    console.log('🔄 [BackgroundSync] Starting worker...');
    this.isRunning = true;
    this.isPaused = false;
    
    // Run sync loop
    this._runSyncLoop();
  }
  
  /**
   * Stop background sync worker
   */
  stop() {
    console.log('⏹️ [BackgroundSync] Stopping worker');
    this.isRunning = false;
  }
  
  /**
   * Pause syncing (during user operations)
   */
  pause() {
    console.log('⏸️ [BackgroundSync] Paused');
    this.isPaused = true;
  }
  
  /**
   * Resume syncing
   */
  resume() {
    console.log('▶️ [BackgroundSync] Resumed');
    this.isPaused = false;
  }
  
  /**
   * Subscribe to sync events
   */
  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  
  /**
   * Notify listeners
   */
  async _notify(event) {
    // CRITICAL: Import offlineDB dynamically to avoid circular dependencies
    const { offlineDB } = await import('./offlineDatabase');
    
    this.listeners.forEach(cb => {
      try {
        cb(event, offlineDB);
      } catch (e) {
        console.error('[BackgroundSync] Listener error:', e);
      }
    });
  }
  
  /**
   * Main sync loop - checks what needs syncing and does it
   */
  async _runSyncLoop() {
    while (this.isRunning) {
      try {
        // Skip if paused
        if (this.isPaused) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          continue;
        }
        
        // Check cooldown
        if (Date.now() < this.cooldownUntil) {
          await new Promise(resolve => setTimeout(resolve, 10000));
          continue;
        }
        
        const now = Date.now();
        
        // HIGH PRIORITY: On-duty drivers + active deliveries (every 30s when active)
        if (now - this.lastSync.highPriority >= this.intervals.highPriority) {
          await this._syncHighPriority();
          this.lastSync.highPriority = now;
        }
        
        // MEDIUM PRIORITY: Today's patients, Square TX (every 5min)
        if (now - this.lastSync.mediumPriority >= this.intervals.mediumPriority) {
          await this._syncMediumPriority();
          this.lastSync.mediumPriority = now;
        }
        
        // LOW PRIORITY: Cities, Stores, historical (every 30min, only when idle)
        if (now - this.lastSync.lowPriority >= this.intervals.lowPriority && this.isUserIdle()) {
          await this._syncLowPriority();
          this.lastSync.lowPriority = now;
        }
        
        // Wait before next check
        await new Promise(resolve => setTimeout(resolve, 10000)); // Check every 10 seconds
        
      } catch (error) {
        console.error('[BackgroundSync] Loop error:', error);
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    }
  }
  
  /**
   * HIGH PRIORITY: Sync on-duty drivers and active deliveries
   */
  async _syncHighPriority() {
    if (this.isPaused) return;
    
    try {
      console.log('🔥 [BackgroundSync] HIGH: On-duty drivers + active deliveries');
      
      // Fetch only on-duty/on-break drivers
      const onDutyDrivers = await queueEntityRequest(
        () => base44.entities.AppUser.filter({
          app_roles: { $in: ['driver'] },
          driver_status: { $in: ['on_duty', 'on_break'] }
        }),
        'AppUser [on-duty drivers]'
      );
      
      if (onDutyDrivers && onDutyDrivers.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, onDutyDrivers);
        this._notify({ type: 'sync_complete', priority: 'high', entity: 'AppUser', count: onDutyDrivers.length });
      }
      
      // Fetch active deliveries for today only
      const todayStr = format(new Date(), 'yyyy-MM-dd');
      const activeDeliveries = await queueEntityRequest(
        () => base44.entities.Delivery.filter({
          delivery_date: todayStr,
          status: { $in: ['pending', 'in_transit', 'en_route'] }
        }),
        'Delivery [active today]'
      );
      
      if (activeDeliveries && activeDeliveries.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, activeDeliveries);
        this._notify({ type: 'sync_complete', priority: 'high', entity: 'Delivery', count: activeDeliveries.length });
      }
      
      this.consecutiveErrors = 0;
      
    } catch (error) {
      this._handleError(error);
    }
  }
  
  /**
   * MEDIUM PRIORITY: Sync today's patients and Square transactions
   */
  async _syncMediumPriority() {
    if (this.isPaused) return;
    
    try {
      console.log('📊 [BackgroundSync] MEDIUM: Today patients + Square TX');
      
      // Get patient IDs from today's deliveries
      const todayStr = format(new Date(), 'yyyy-MM-dd');
      const todayDeliveries = await offlineDB.getByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', todayStr);
      const todayPatientIds = [...new Set(
        todayDeliveries
          .filter(d => d && d.patient_id)
          .map(d => d.patient_id)
      )];
      
      if (todayPatientIds.length > 0) {
        // Fetch only today's patients in batches
        const batchSize = 100;
        for (let i = 0; i < todayPatientIds.length; i += batchSize) {
          if (this.isPaused) break;
          
          const batchIds = todayPatientIds.slice(i, i + batchSize);
          const patients = await queueEntityRequest(
            () => base44.entities.Patient.filter({ id: { $in: batchIds } }),
            `Patient [batch ${i / batchSize + 1}]`
          );
          
          if (patients && patients.length > 0) {
            await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, patients);
          }
          
          await new Promise(r => setTimeout(r, 2000)); // 2s between batches
        }
        
        this._notify({ type: 'sync_complete', priority: 'medium', entity: 'Patient', count: todayPatientIds.length });
      }
      
      // Fetch Square transactions (last 100)
      const squareTX = await queueEntityRequest(
        () => base44.entities.SquareTransaction.list('-updated_date', 100),
        'SquareTransaction [recent]'
      );
      
      if (squareTX && squareTX.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.SQUARE_TRANSACTIONS, squareTX);
        this._notify({ type: 'sync_complete', priority: 'medium', entity: 'SquareTransaction', count: squareTX.length });
      }
      
      this.consecutiveErrors = 0;
      
    } catch (error) {
      this._handleError(error);
    }
  }
  
  /**
   * LOW PRIORITY: Sync rarely-changing data (cities, stores, historical deliveries)
   */
  async _syncLowPriority() {
    if (this.isPaused) return;
    if (!this.isUserIdle()) return; // Only sync when user is idle
    
    try {
      console.log('🐌 [BackgroundSync] LOW: Cities, Stores, historical');
      
      // Fetch cities
      const cities = await queueEntityRequest(
        () => base44.entities.City.list(),
        'City [all]'
      );
      
      if (cities && cities.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.CITIES, cities);
      }
      
      await new Promise(r => setTimeout(r, 2000));
      
      // Fetch stores
      const stores = await queueEntityRequest(
        () => base44.entities.Store.list(),
        'Store [all]'
      );
      
      if (stores && stores.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.STORES, stores);
      }
      
      this._notify({ type: 'sync_complete', priority: 'low', entity: 'City,Store' });
      this.consecutiveErrors = 0;
      
    } catch (error) {
      this._handleError(error);
    }
  }
  
  /**
   * Handle sync errors with exponential backoff
   */
  _handleError(error) {
    this.consecutiveErrors++;
    
    if (error.response?.status === 429 || error.message?.includes('429')) {
      console.warn(`⏰ [BackgroundSync] Rate limit - cooldown ${this.consecutiveErrors * 30}s`);
      this.cooldownUntil = Date.now() + (this.consecutiveErrors * 30000);
    } else {
      console.error('[BackgroundSync] Error:', error.message);
    }
    
    if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
      console.warn(`🛑 [BackgroundSync] Max errors reached - pausing for 5 minutes`);
      this.cooldownUntil = Date.now() + 300000; // 5 minute cooldown
      this.consecutiveErrors = 0;
    }
  }
  
  /**
   * Force immediate sync of specific priority
   */
  async forceSync(priority = 'high') {
    if (priority === 'high') {
      this.lastSync.highPriority = 0;
      await this._syncHighPriority();
    } else if (priority === 'medium') {
      this.lastSync.mediumPriority = 0;
      await this._syncMediumPriority();
    } else if (priority === 'low') {
      this.lastSync.lowPriority = 0;
      await this._syncLowPriority();
    }
  }
}

export const backgroundSyncWorker = new BackgroundSyncWorker();