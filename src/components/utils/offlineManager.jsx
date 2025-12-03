/**
 * Offline Manager - Handles offline data caching and sync
 * Enhanced with background sync, exponential backoff, and conflict resolution
 */

// Conflict resolution strategies
export const ConflictResolution = {
  LAST_WRITE_WINS: 'last_write_wins',
  SERVER_WINS: 'server_wins',
  CLIENT_WINS: 'client_wins',
  PROMPT_USER: 'prompt_user'
};

class OfflineManager {
  constructor() {
    this.isOnline = navigator.onLine;
    this.listeners = new Set();
    this.conflictListeners = new Set();
    this.pendingActions = [];
    this.cachedData = {
      deliveries: null,
      patients: null,
      stores: null,
      drivers: null,
      users: null,
      userSettings: null,
      lastUpdate: null
    };
    
    // Sync state
    this.isSyncing = false;
    this.syncRetryCount = 0;
    this.maxRetries = 5;
    this.baseRetryDelay = 1000; // 1 second
    this.maxRetryDelay = 60000; // 1 minute max
    this.backgroundSyncInterval = null;
    this.backgroundSyncPeriod = 30000; // 30 seconds
    
    // Conflict resolution strategy (default: last write wins)
    this.conflictStrategy = ConflictResolution.LAST_WRITE_WINS;
    this.pendingConflicts = [];
    
    // Listen for online/offline events
    window.addEventListener('online', () => this.handleOnline());
    window.addEventListener('offline', () => this.handleOffline());
    
    // Listen for visibility changes for background sync
    document.addEventListener('visibilitychange', () => this.handleVisibilityChange());
    
    // Load cached data from IndexedDB on init
    this.loadCachedData();
    
    // Start background sync
    this.startBackgroundSync();
    
    // Register service worker for true background sync if available
    this.registerBackgroundSync();
  }

  handleOnline() {
    console.log('🟢 [OfflineManager] Online');
    this.isOnline = true;
    this.syncRetryCount = 0; // Reset retry count when coming online
    this.notifyListeners();
    this.syncPendingActions();
  }

  handleOffline() {
    console.log('🔴 [OfflineManager] Offline');
    this.isOnline = false;
    this.notifyListeners();
  }

  handleVisibilityChange() {
    if (document.visibilityState === 'visible' && this.isOnline) {
      console.log('👁️ [OfflineManager] App became visible - triggering sync');
      this.syncPendingActions();
    }
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  // Subscribe to conflict events for UI prompts
  subscribeToConflicts(callback) {
    this.conflictListeners.add(callback);
    return () => this.conflictListeners.delete(callback);
  }

  notifyListeners() {
    this.listeners.forEach(callback => callback(this.isOnline));
  }

  notifyConflictListeners(conflict) {
    this.conflictListeners.forEach(callback => callback(conflict));
  }

  getOnlineStatus() {
    return this.isOnline;
  }

  getSyncStatus() {
    return {
      isSyncing: this.isSyncing,
      pendingCount: this.pendingActions.length,
      retryCount: this.syncRetryCount,
      hasConflicts: this.pendingConflicts.length > 0
    };
  }

  // Set conflict resolution strategy
  setConflictStrategy(strategy) {
    if (Object.values(ConflictResolution).includes(strategy)) {
      this.conflictStrategy = strategy;
      console.log(`⚙️ [OfflineManager] Conflict strategy set to: ${strategy}`);
    }
  }

  // Start periodic background sync
  startBackgroundSync() {
    if (this.backgroundSyncInterval) {
      clearInterval(this.backgroundSyncInterval);
    }
    
    this.backgroundSyncInterval = setInterval(() => {
      if (this.isOnline && this.pendingActions.length > 0 && !this.isSyncing) {
        console.log('⏰ [OfflineManager] Background sync triggered');
        this.syncPendingActions();
      }
    }, this.backgroundSyncPeriod);
    
    console.log(`🔄 [OfflineManager] Background sync started (every ${this.backgroundSyncPeriod / 1000}s)`);
  }

  stopBackgroundSync() {
    if (this.backgroundSyncInterval) {
      clearInterval(this.backgroundSyncInterval);
      this.backgroundSyncInterval = null;
      console.log('⏹️ [OfflineManager] Background sync stopped');
    }
  }

  // Register for service worker background sync (if available)
  async registerBackgroundSync() {
    if ('serviceWorker' in navigator && 'sync' in window.registration) {
      try {
        const registration = await navigator.serviceWorker.ready;
        await registration.sync.register('offline-sync');
        console.log('📡 [OfflineManager] Service worker background sync registered');
      } catch (error) {
        console.log('ℹ️ [OfflineManager] Service worker background sync not available');
      }
    }
  }

  // Calculate exponential backoff delay
  calculateBackoffDelay() {
    const delay = Math.min(
      this.baseRetryDelay * Math.pow(2, this.syncRetryCount),
      this.maxRetryDelay
    );
    // Add jitter (±10%)
    const jitter = delay * 0.1 * (Math.random() * 2 - 1);
    return Math.round(delay + jitter);
  }

  // Cache data to IndexedDB
  async cacheData(entityType, data) {
    try {
      const db = await this.openDB();
      const tx = db.transaction('cache', 'readwrite');
      const store = tx.objectStore('cache');
      
      await store.put({
        id: entityType,
        data: data,
        timestamp: Date.now()
      });
      
      this.cachedData[entityType] = data;
      this.cachedData.lastUpdate = Date.now();
      
      console.log(`💾 [OfflineManager] Cached ${entityType}:`, Array.isArray(data) ? data.length + ' records' : 'object');
    } catch (error) {
      console.error('❌ [OfflineManager] Error caching data:', error);
    }
  }

  // Cache user settings specifically for offline use
  async cacheUserSettings(userId, settings) {
    try {
      const db = await this.openDB();
      const tx = db.transaction('cache', 'readwrite');
      const store = tx.objectStore('cache');
      
      await store.put({
        id: `userSettings_${userId}`,
        data: settings,
        timestamp: Date.now()
      });
      
      this.cachedData.userSettings = settings;
      console.log(`💾 [OfflineManager] Cached user settings for: ${userId}`);
    } catch (error) {
      console.error('❌ [OfflineManager] Error caching user settings:', error);
    }
  }

  // Get cached user settings
  async getCachedUserSettings(userId) {
    try {
      if (this.cachedData.userSettings) {
        return this.cachedData.userSettings;
      }

      const db = await this.openDB();
      const tx = db.transaction('cache', 'readonly');
      const store = tx.objectStore('cache');
      
      return new Promise((resolve, reject) => {
        const request = store.get(`userSettings_${userId}`);
        request.onsuccess = () => {
          if (request.result?.data) {
            this.cachedData.userSettings = request.result.data;
            resolve(request.result.data);
          } else {
            resolve(null);
          }
        };
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('❌ [OfflineManager] Error getting cached user settings:', error);
      return null;
    }
  }

  // Get cached data from IndexedDB
  async getCachedData(entityType) {
    try {
      if (this.cachedData[entityType]) {
        return this.cachedData[entityType];
      }

      const db = await this.openDB();
      const tx = db.transaction('cache', 'readonly');
      const store = tx.objectStore('cache');
      
      return new Promise((resolve, reject) => {
        const request = store.get(entityType);
        request.onsuccess = () => {
          if (request.result?.data) {
            this.cachedData[entityType] = request.result.data;
            resolve(request.result.data);
          } else {
            resolve(null);
          }
        };
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('❌ [OfflineManager] Error getting cached data:', error);
      return null;
    }
  }

  // Queue action for later sync with version tracking
  async queueAction(action) {
    const queuedAction = {
      ...action,
      id: Date.now() + Math.random(),
      timestamp: new Date().toISOString(),
      retryCount: 0,
      version: action.version || Date.now() // For conflict detection
    };
    
    this.pendingActions.push(queuedAction);
    
    // Save to IndexedDB
    try {
      const db = await this.openDB();
      const tx = db.transaction('pending', 'readwrite');
      const store = tx.objectStore('pending');
      await store.add(queuedAction);
      
      console.log('📝 [OfflineManager] Queued action:', action.type, queuedAction.id);
    } catch (error) {
      console.error('❌ [OfflineManager] Error queuing action:', error);
    }
    
    // Try to sync immediately if online
    if (this.isOnline && !this.isSyncing) {
      setTimeout(() => this.syncPendingActions(), 100);
    }
    
    return queuedAction;
  }

  // Get pending actions count
  getPendingActionsCount() {
    return this.pendingActions.length;
  }

  // Sync pending actions with exponential backoff
  async syncPendingActions() {
    if (!this.isOnline || this.pendingActions.length === 0 || this.isSyncing) {
      return { synced: 0, failed: 0, conflicts: 0 };
    }

    this.isSyncing = true;
    console.log('🔄 [OfflineManager] Syncing', this.pendingActions.length, 'pending actions...');
    
    const actionsToSync = [...this.pendingActions];
    const successfulSyncs = [];
    const failedActions = [];
    const conflicts = [];
    
    for (const action of actionsToSync) {
      try {
        const result = await this.executeSyncAction(action);
        
        if (result.conflict) {
          // Handle conflict based on strategy
          const resolution = await this.resolveConflict(action, result.serverData);
          if (resolution.resolved) {
            successfulSyncs.push(action.id);
            console.log('✅ [OfflineManager] Conflict resolved:', action.type);
          } else {
            conflicts.push({ action, serverData: result.serverData });
          }
        } else {
          successfulSyncs.push(action.id);
          console.log('✅ [OfflineManager] Synced:', action.type);
        }
        
        // Reset retry count on success
        action.retryCount = 0;
        
      } catch (error) {
        console.error('❌ [OfflineManager] Sync failed:', action.type, error);
        
        action.retryCount = (action.retryCount || 0) + 1;
        
        if (action.retryCount >= this.maxRetries) {
          console.warn(`⚠️ [OfflineManager] Max retries reached for action: ${action.id}`);
          failedActions.push(action);
        }
      }
    }
    
    // Remove successful syncs from queue
    this.pendingActions = this.pendingActions.filter(
      action => !successfulSyncs.includes(action.id)
    );
    
    // Store conflicts for user resolution if needed
    this.pendingConflicts = conflicts;
    if (conflicts.length > 0 && this.conflictStrategy === ConflictResolution.PROMPT_USER) {
      this.notifyConflictListeners(conflicts);
    }
    
    // Clear from IndexedDB
    if (successfulSyncs.length > 0) {
      await this.clearSyncedActions(successfulSyncs);
    }
    
    // Update failed actions in IndexedDB with new retry count
    if (failedActions.length > 0) {
      await this.updateFailedActions(failedActions);
    }
    
    this.isSyncing = false;
    
    // Schedule retry with exponential backoff if there are still pending actions
    if (this.pendingActions.length > 0 && this.syncRetryCount < this.maxRetries) {
      this.syncRetryCount++;
      const delay = this.calculateBackoffDelay();
      console.log(`⏳ [OfflineManager] Scheduling retry in ${delay}ms (attempt ${this.syncRetryCount}/${this.maxRetries})`);
      setTimeout(() => this.syncPendingActions(), delay);
    } else if (this.pendingActions.length === 0) {
      this.syncRetryCount = 0; // Reset on complete success
    }
    
    return {
      synced: successfulSyncs.length,
      failed: failedActions.length,
      conflicts: conflicts.length
    };
  }

  // Resolve conflict based on strategy
  async resolveConflict(action, serverData) {
    switch (this.conflictStrategy) {
      case ConflictResolution.LAST_WRITE_WINS:
        // Compare timestamps - most recent wins
        const clientTime = new Date(action.timestamp).getTime();
        const serverTime = serverData.updated_date ? new Date(serverData.updated_date).getTime() : 0;
        
        if (clientTime >= serverTime) {
          // Client wins - apply client changes
          return { resolved: true, winner: 'client' };
        } else {
          // Server wins - discard client changes
          return { resolved: true, winner: 'server' };
        }
        
      case ConflictResolution.SERVER_WINS:
        // Always use server data
        return { resolved: true, winner: 'server' };
        
      case ConflictResolution.CLIENT_WINS:
        // Always use client data - force update
        return { resolved: true, winner: 'client', forceUpdate: true };
        
      case ConflictResolution.PROMPT_USER:
        // Don't auto-resolve - let user decide
        return { resolved: false, requiresUserInput: true };
        
      default:
        return { resolved: true, winner: 'server' };
    }
  }

  // User resolves a conflict manually
  async resolveConflictManually(conflictId, resolution) {
    const conflict = this.pendingConflicts.find(c => c.action.id === conflictId);
    if (!conflict) return false;
    
    const { base44 } = await import('@/api/base44Client');
    
    try {
      if (resolution === 'client') {
        // Apply client's changes
        await this.executeSyncAction(conflict.action);
      }
      // If 'server', we just remove from queue (server data stays)
      
      // Remove from pending conflicts
      this.pendingConflicts = this.pendingConflicts.filter(c => c.action.id !== conflictId);
      
      // Remove from pending actions
      this.pendingActions = this.pendingActions.filter(a => a.id !== conflictId);
      await this.clearSyncedActions([conflictId]);
      
      console.log(`✅ [OfflineManager] Conflict resolved manually: ${resolution} wins`);
      return true;
    } catch (error) {
      console.error('❌ [OfflineManager] Error resolving conflict:', error);
      return false;
    }
  }

  // Execute a single sync action with conflict detection
  async executeSyncAction(action) {
    const { base44 } = await import('@/api/base44Client');
    
    switch (action.type) {
      case 'updateDelivery':
        // Check for conflicts first
        try {
          const serverDelivery = await base44.entities.Delivery.get(action.deliveryId);
          
          // Check if server data was modified after our offline change
          if (serverDelivery && serverDelivery.updated_date) {
            const serverUpdateTime = new Date(serverDelivery.updated_date).getTime();
            const clientUpdateTime = new Date(action.timestamp).getTime();
            
            if (serverUpdateTime > clientUpdateTime && action.version < serverUpdateTime) {
              return { conflict: true, serverData: serverDelivery };
            }
          }
        } catch (e) {
          // Entity might not exist - proceed with update
        }
        
        await base44.entities.Delivery.update(action.deliveryId, action.data);
        return { conflict: false };
        
      case 'createDelivery':
        await base44.entities.Delivery.create(action.data);
        return { conflict: false };
        
      case 'updatePatient':
        await base44.entities.Patient.update(action.patientId, action.data);
        return { conflict: false };
        
      case 'updateUserSettings':
        await base44.entities.UserSettings.update(action.settingsId, action.data);
        return { conflict: false };
        
      default:
        console.warn('⚠️ [OfflineManager] Unknown action type:', action.type);
        return { conflict: false };
    }
  }

  // Clear synced actions from IndexedDB
  async clearSyncedActions(actionIds) {
    try {
      const db = await this.openDB();
      const tx = db.transaction('pending', 'readwrite');
      const store = tx.objectStore('pending');
      
      for (const id of actionIds) {
        store.delete(id);
      }
      
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      
      console.log('✅ [OfflineManager] Cleared', actionIds.length, 'synced actions from queue');
    } catch (error) {
      console.error('❌ [OfflineManager] Error clearing synced actions:', error);
    }
  }

  // Update failed actions in IndexedDB
  async updateFailedActions(actions) {
    try {
      const db = await this.openDB();
      const tx = db.transaction('pending', 'readwrite');
      const store = tx.objectStore('pending');
      
      for (const action of actions) {
        store.put(action);
      }
      
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (error) {
      console.error('❌ [OfflineManager] Error updating failed actions:', error);
    }
  }

  // Open IndexedDB with version upgrade for new stores
  openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('rxdeliver_offline', 2); // Version 2 for new features
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // Create cache store for entity data
        if (!db.objectStoreNames.contains('cache')) {
          db.createObjectStore('cache', { keyPath: 'id' });
        }
        
        // Create pending actions store
        if (!db.objectStoreNames.contains('pending')) {
          db.createObjectStore('pending', { keyPath: 'id' });
        }
        
        // Create conflicts store for unresolved conflicts
        if (!db.objectStoreNames.contains('conflicts')) {
          db.createObjectStore('conflicts', { keyPath: 'id' });
        }
      };
    });
  }

  // Load cached data and pending actions from IndexedDB
  async loadCachedData() {
    try {
      const db = await this.openDB();
      
      // Load pending actions
      const pendingTx = db.transaction('pending', 'readonly');
      const pendingStore = pendingTx.objectStore('pending');
      
      return new Promise((resolve) => {
        const pendingRequest = pendingStore.getAll();
        
        pendingRequest.onsuccess = () => {
          this.pendingActions = pendingRequest.result || [];
          console.log('📦 [OfflineManager] Loaded', this.pendingActions.length, 'pending actions');
          
          // Try to sync immediately if online
          if (this.isOnline && this.pendingActions.length > 0) {
            setTimeout(() => this.syncPendingActions(), 1000);
          }
          
          resolve();
        };
        
        pendingRequest.onerror = () => {
          console.error('❌ [OfflineManager] Error loading pending actions');
          resolve();
        };
      });
    } catch (error) {
      console.error('❌ [OfflineManager] Error loading cached data:', error);
    }
  }

  // Clear all cached data
  async clearCache() {
    try {
      const db = await this.openDB();
      const tx = db.transaction('cache', 'readwrite');
      const store = tx.objectStore('cache');
      store.clear();
      
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      
      this.cachedData = {
        deliveries: null,
        patients: null,
        stores: null,
        drivers: null,
        users: null,
        userSettings: null,
        lastUpdate: null
      };
      
      console.log('🧹 [OfflineManager] Cache cleared');
    } catch (error) {
      console.error('❌ [OfflineManager] Error clearing cache:', error);
    }
  }

  // Force sync now (manual trigger)
  async forceSyncNow() {
    this.syncRetryCount = 0;
    return this.syncPendingActions();
  }

  // Get cache age in milliseconds
  getCacheAge(entityType) {
    const cached = this.cachedData[entityType];
    if (!cached) return null;
    return Date.now() - (this.cachedData.lastUpdate || 0);
  }

  // Check if cache is stale (older than threshold)
  isCacheStale(entityType, maxAgeMs = 5 * 60 * 1000) {
    const age = this.getCacheAge(entityType);
    return age === null || age > maxAgeMs;
  }

  // Cleanup on destroy
  destroy() {
    this.stopBackgroundSync();
    window.removeEventListener('online', () => this.handleOnline());
    window.removeEventListener('offline', () => this.handleOffline());
    document.removeEventListener('visibilitychange', () => this.handleVisibilityChange());
  }
}

// Singleton instance
export const offlineManager = new OfflineManager();