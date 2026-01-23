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
    this.isOnline = true;
    this.syncRetryCount = 0; // Reset retry count when coming online
    this.notifyListeners();
    this.syncPendingActions();
  }

  handleOffline() {
    this.isOnline = false;
    this.notifyListeners();
  }

  handleVisibilityChange() {
    if (document.visibilityState === 'visible' && this.isOnline) {
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
    }
  }

  // Start periodic background sync
  startBackgroundSync() {
    if (this.backgroundSyncInterval) {
      clearInterval(this.backgroundSyncInterval);
    }
    
    this.backgroundSyncInterval = setInterval(() => {
      if (this.isOnline && this.pendingActions.length > 0 && !this.isSyncing) {
        this.syncPendingActions();
      }
    }, this.backgroundSyncPeriod);
    
  }

  stopBackgroundSync() {
    if (this.backgroundSyncInterval) {
      clearInterval(this.backgroundSyncInterval);
      this.backgroundSyncInterval = null;
    }
  }

  // Register for service worker background sync (if available)
  async registerBackgroundSync() {
    try {
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.ready;
        if (registration && 'sync' in registration) {
          await registration.sync.register('offline-sync');
        }
      }
    } catch (error) {
      console.error('ℹ️ [OfflineManager] Service worker background sync not available');
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

  // Cache entities to offlineDB for offline-first data access
  async cacheEntities(entityName, entities) {
    try {
      const { offlineDB } = await import('./offlineDatabase');
      
      // Map entity names to offline DB stores
      const storeMap = {
        'Patient': offlineDB.STORES.PATIENTS,
        'Delivery': offlineDB.STORES.DELIVERIES,
        'Store': offlineDB.STORES.STORES,
        'AppUser': offlineDB.STORES.APP_USERS
      };
      
      const storeName = storeMap[entityName];
      if (storeName && entities && Array.isArray(entities)) {
        await offlineDB.bulkSave(storeName, entities);
        console.log(`✅ [OfflineManager] Cached ${entities.length} ${entityName} records to offline DB`);
      }
    } catch (error) {
      console.warn(`⚠️ [OfflineManager] Failed to cache ${entityName} to offline DB:`, error.message);
    }
  }

  // Cache data to IndexedDB (legacy method - maintained for backwards compatibility)
  async cacheData(entityType, data) {
    try {
      // CRITICAL: Also sync to offlineDB for offline-first access
      await this.cacheEntities(entityType, data);
      
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
      
    } catch (error) {
      console.error('❌ [OfflineManager] Error caching data:', error);
    }
  }

  // Cache user settings specifically for offline use, keyed by userId and deviceId
  async cacheUserSettings(userId, deviceId, settings) {
    try {
      const db = await this.openDB();
      const tx = db.transaction('cache', 'readwrite');
      const store = tx.objectStore('cache');
      
      await store.put({
        id: `userSettings_${userId}_${deviceId}`, // Unique ID for user+device settings
        data: settings,
        timestamp: Date.now()
      });
      
      this.cachedData.userSettings = settings;
    } catch (error) {
      console.error('❌ [OfflineManager] Error caching user settings:', error);
    }
  }

  // Get cached user settings, keyed by userId and deviceId
  async getCachedUserSettings(userId, deviceId) {
    try {
      if (this.cachedData.userSettings && this.cachedData.userSettings.user_id === userId && this.cachedData.userSettings.device_id === deviceId) {
        return this.cachedData.userSettings;
      }

      const db = await this.openDB();
      const tx = db.transaction('cache', 'readonly');
      const store = tx.objectStore('cache');
      
      return new Promise((resolve, reject) => {
        const request = store.get(`userSettings_${userId}_${deviceId}`);
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
          } else {
            conflicts.push({ action, serverData: result.serverData });
          }
        } else {
          successfulSyncs.push(action.id);
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
      // CRITICAL: Use stable database name to prevent recreation
      const request = indexedDB.open('rxdeliver_persistent_cache_v2', 2);
      
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

  // Get all cached UserSettings from IndexedDB (for admin diagnostics)
  async getAllCachedUserSettings() {
    try {
      const db = await this.openDB();
      const tx = db.transaction('cache', 'readonly');
      const store = tx.objectStore('cache');
      
      return new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => {
          // Filter only UserSettings entries (those with id starting with 'userSettings_')
          const allCached = request.result || [];
          const userSettingsEntries = allCached
            .filter(entry => entry.id && entry.id.startsWith('userSettings_'))
            .map(entry => ({
              ...entry.data,
              _cacheId: entry.id,
              _timestamp: entry.timestamp
            }));
          
          resolve(userSettingsEntries);
        };
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('❌ [OfflineManager] Error getting cached UserSettings:', error);
      return [];
    }
  }

  // Delete cached UserSettings entry from IndexedDB (for cleanup)
  async deleteCachedUserSettings(cacheId) {
    try {
      const db = await this.openDB();
      const tx = db.transaction('cache', 'readwrite');
      const store = tx.objectStore('cache');
      
      await store.delete(cacheId);
      
      return true;
    } catch (error) {
      console.error('❌ [OfflineManager] Error deleting cached UserSettings:', error);
      return false;
    }
  }

  /**
   * UNIFIED DATA MANAGEMENT API
   * Centralized interface for all offline data operations
   */

  // Get all offline data stores
  async getAllDataStores() {
    try {
      const db = await this.openDB();
      const tx = db.transaction('cache', 'readonly');
      const store = tx.objectStore('cache');
      
      return new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => {
          const allData = request.result || [];
          const organized = {
            patients: allData.find(d => d.id === 'Patient')?.data || [],
            deliveries: allData.find(d => d.id === 'Delivery')?.data || [],
            stores: allData.find(d => d.id === 'Store')?.data || [],
            appUsers: allData.find(d => d.id === 'AppUser')?.data || [],
            userSettings: allData.filter(d => d.id && d.id.startsWith('userSettings_')),
            metadata: {
              totalStores: allData.length,
              lastUpdate: this.cachedData.lastUpdate
            }
          };
          resolve(organized);
        };
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('❌ [OfflineManager] Error getting all data stores:', error);
      return null;
    }
  }

  // Get data statistics for diagnostics
  async getDataStatistics() {
    try {
      const allData = await this.getAllDataStores();
      
      return {
        patients: {
          count: allData.patients?.length || 0,
          hasData: (allData.patients?.length || 0) > 0
        },
        deliveries: {
          count: allData.deliveries?.length || 0,
          hasData: (allData.deliveries?.length || 0) > 0
        },
        stores: {
          count: allData.stores?.length || 0,
          hasData: (allData.stores?.length || 0) > 0
        },
        appUsers: {
          count: allData.appUsers?.length || 0,
          hasData: (allData.appUsers?.length || 0) > 0
        },
        userSettings: {
          count: allData.userSettings?.length || 0,
          entries: allData.userSettings
        },
        pendingActions: this.pendingActions.length,
        pendingConflicts: this.pendingConflicts.length,
        lastUpdate: allData.metadata?.lastUpdate
      };
    } catch (error) {
      console.error('❌ [OfflineManager] Error getting statistics:', error);
      return null;
    }
  }

  /**
   * CROSS-INSTANCE DATA DETECTION & MERGING
   * Detects if multiple instances created separate databases and merges them
   */

  // Detect potential duplicate data from multiple instances
  async detectDuplicateInstances() {
    try {
      const stats = await this.getDataStatistics();
      const issues = [];

      // Check for duplicate UserSettings (same user, different device IDs)
      if (stats.userSettings?.entries?.length > 1) {
        const settingsByUser = {};
        
        stats.userSettings.entries.forEach(entry => {
          const userId = entry.data?.user_id;
          if (userId) {
            if (!settingsByUser[userId]) {
              settingsByUser[userId] = [];
            }
            settingsByUser[userId].push(entry);
          }
        });

        // Check for same user with multiple device IDs
        Object.keys(settingsByUser).forEach(userId => {
          const userEntries = settingsByUser[userId];
          if (userEntries.length > 3) { // Threshold: more than 3 devices seems suspicious
            issues.push({
              type: 'multiple_device_ids',
              userId,
              count: userEntries.length,
              entries: userEntries,
              severity: 'warning'
            });
          }
        });
      }

      // Check for stale data (data not updated in > 7 days)
      if (stats.lastUpdate) {
        const daysSinceUpdate = (Date.now() - stats.lastUpdate) / (1000 * 60 * 60 * 24);
        if (daysSinceUpdate > 7) {
          issues.push({
            type: 'stale_data',
            daysSinceUpdate: Math.floor(daysSinceUpdate),
            severity: 'info'
          });
        }
      }

      return { hasIssues: issues.length > 0, issues, stats };
    } catch (error) {
      console.error('❌ [OfflineManager] Error detecting duplicate instances:', error);
      return { hasIssues: false, issues: [], stats: null };
    }
  }

  // Merge duplicate UserSettings entries for the same user
  async mergeDuplicateUserSettings(userId) {
    try {
      
      const db = await this.openDB();
      let tx = db.transaction('cache', 'readonly');
      let store = tx.objectStore('cache');
      
      const allEntries = await new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });

      // Find all UserSettings for this user
      const userSettingsEntries = allEntries
        .filter(entry => 
          entry.id && 
          entry.id.startsWith('userSettings_') && 
          entry.data?.user_id === userId
        );

      if (userSettingsEntries.length <= 1) {
        return { merged: false, kept: userSettingsEntries[0]?.id };
      }

      // Sort by timestamp (newest first)
      userSettingsEntries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      // Keep the newest entry, merge settings from others
      const newestEntry = userSettingsEntries[0];
      const mergedSettings = { ...newestEntry.data };

      // Merge unique settings from older entries (prefer newer values)
      for (let i = 1; i < userSettingsEntries.length; i++) {
        const olderEntry = userSettingsEntries[i];
        Object.keys(olderEntry.data || {}).forEach(key => {
          // Only merge if the value is not already set in newest
          if (mergedSettings[key] === undefined || mergedSettings[key] === null) {
            mergedSettings[key] = olderEntry.data[key];
          }
        });
      }

      // Save merged settings
      await this.cacheUserSettings(userId, mergedSettings.device_id, mergedSettings);

      // Delete old duplicate entries
      const deleteTx = db.transaction('cache', 'readwrite');
      const deleteStore = deleteTx.objectStore('cache');
      
      for (let i = 1; i < userSettingsEntries.length; i++) {
        await deleteStore.delete(userSettingsEntries[i].id);
      }

      return { 
        merged: true, 
        kept: newestEntry.id, 
        deletedCount: userSettingsEntries.length - 1 
      };
    } catch (error) {
      console.error('❌ [OfflineManager] Error merging duplicate settings:', error);
      return { merged: false, error: error.message };
    }
  }

  // Clean up all duplicate UserSettings across all users
  async cleanupAllDuplicateUserSettings() {
    try {
      
      const stats = await this.getDataStatistics();
      const userIds = [...new Set(
        stats.userSettings?.entries?.map(e => e.data?.user_id).filter(Boolean) || []
      )];

      const results = [];
      for (const userId of userIds) {
        const result = await this.mergeDuplicateUserSettings(userId);
        if (result.merged) {
          results.push({ userId, ...result });
        }
      }

      return { success: true, mergedUsers: results };
    } catch (error) {
      console.error('❌ [OfflineManager] Error during cleanup:', error);
      return { success: false, error: error.message };
    }
  }

  // Resolve data conflicts by comparing timestamps and keeping newest
  async resolveDataConflicts(entityType, localData, remoteData) {
    if (!Array.isArray(localData) || !Array.isArray(remoteData)) {
      return remoteData; // Default to remote if data structure is invalid
    }

    const merged = new Map();
    
    // Add all remote data first (server is source of truth for existing records)
    remoteData.forEach(item => {
      if (item && item.id) {
        merged.set(item.id, item);
      }
    });

    // Merge local data - only if newer or doesn't exist remotely
    localData.forEach(item => {
      if (!item || !item.id) return;

      const remoteItem = merged.get(item.id);
      
      if (!remoteItem) {
        // Local-only item (probably created offline) - keep it
        merged.set(item.id, item);
      } else {
        // Compare timestamps - keep newer
        const localTime = new Date(item.updated_date || item.created_date || 0).getTime();
        const remoteTime = new Date(remoteItem.updated_date || remoteItem.created_date || 0).getTime();
        
        if (localTime > remoteTime) {
          console.log(`   📱 ${entityType}: Keeping local version of ${item.id} (local newer)`);
          merged.set(item.id, item);
        }
      }
    });

    return Array.from(merged.values());
  }

  // Export all offline data for backup/debugging
  async exportOfflineData() {
    try {
      const allData = await this.getAllDataStores();
      const stats = await this.getDataStatistics();
      const { getDeviceId } = await import('./userSettingsManager');
      const deviceId = await getDeviceId();
      
      return {
        exportDate: new Date().toISOString(),
        deviceId: deviceId,
        statistics: stats,
        data: allData,
        pendingActions: this.pendingActions,
        pendingConflicts: this.pendingConflicts
      };
    } catch (error) {
      console.error('❌ [OfflineManager] Error exporting data:', error);
      return null;
    }
  }

  // Clear all offline data (nuclear option - use with caution)
  async clearAllOfflineData() {
    try {
      console.warn('⚠️ [OfflineManager] Clearing ALL offline data...');
      
      const db = await this.openDB();
      
      // Clear all stores
      const stores = ['cache', 'pending', 'conflicts'];
      for (const storeName of stores) {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        await store.clear();
      }
      
      // Reset in-memory cache
      this.cachedData = {
        deliveries: null,
        patients: null,
        stores: null,
        drivers: null,
        users: null,
        userSettings: null,
        lastUpdate: null
      };
      this.pendingActions = [];
      this.pendingConflicts = [];
      
      return { success: true };
    } catch (error) {
      console.error('❌ [OfflineManager] Error clearing all data:', error);
      return { success: false, error: error.message };
    }
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