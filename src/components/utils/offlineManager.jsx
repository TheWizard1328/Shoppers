/**
 * Offline Manager - Handles offline data caching and sync
 */

class OfflineManager {
  constructor() {
    this.isOnline = navigator.onLine;
    this.listeners = new Set();
    this.pendingActions = [];
    this.cachedData = {
      deliveries: null,
      patients: null,
      stores: null,
      drivers: null,
      users: null,
      lastUpdate: null
    };
    
    // Listen for online/offline events
    window.addEventListener('online', () => this.handleOnline());
    window.addEventListener('offline', () => this.handleOffline());
    
    // Load cached data from IndexedDB on init
    this.loadCachedData();
  }

  handleOnline() {
    console.log('🟢 [OfflineManager] Online');
    this.isOnline = true;
    this.notifyListeners();
    this.syncPendingActions();
  }

  handleOffline() {
    console.log('🔴 [OfflineManager] Offline');
    this.isOnline = false;
    this.notifyListeners();
  }

  subscribe(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notifyListeners() {
    this.listeners.forEach(callback => callback(this.isOnline));
  }

  getOnlineStatus() {
    return this.isOnline;
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
      
      console.log(`💾 [OfflineManager] Cached ${entityType}:`, data.length, 'records');
    } catch (error) {
      console.error('❌ [OfflineManager] Error caching data:', error);
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
      const result = await store.get(entityType);
      
      if (result?.data) {
        this.cachedData[entityType] = result.data;
        return result.data;
      }
      
      return null;
    } catch (error) {
      console.error('❌ [OfflineManager] Error getting cached data:', error);
      return null;
    }
  }

  // Queue action for later sync
  async queueAction(action) {
    const queuedAction = {
      ...action,
      id: Date.now() + Math.random(),
      timestamp: new Date().toISOString()
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
    
    return queuedAction;
  }

  // Get pending actions count
  getPendingActionsCount() {
    return this.pendingActions.length;
  }

  // Sync pending actions when back online
  async syncPendingActions() {
    if (!this.isOnline || this.pendingActions.length === 0) {
      return;
    }

    console.log('🔄 [OfflineManager] Syncing', this.pendingActions.length, 'pending actions...');
    
    const actionsToSync = [...this.pendingActions];
    const successfulSyncs = [];
    
    for (const action of actionsToSync) {
      try {
        await this.executeSyncAction(action);
        successfulSyncs.push(action.id);
        console.log('✅ [OfflineManager] Synced:', action.type);
      } catch (error) {
        console.error('❌ [OfflineManager] Sync failed:', action.type, error);
      }
    }
    
    // Remove successful syncs from queue
    this.pendingActions = this.pendingActions.filter(
      action => !successfulSyncs.includes(action.id)
    );
    
    // Clear from IndexedDB
    if (successfulSyncs.length > 0) {
      try {
        const db = await this.openDB();
        const tx = db.transaction('pending', 'readwrite');
        const store = tx.objectStore('pending');
        
        for (const id of successfulSyncs) {
          await store.delete(id);
        }
        
        console.log('✅ [OfflineManager] Cleared', successfulSyncs.length, 'synced actions from queue');
      } catch (error) {
        console.error('❌ [OfflineManager] Error clearing synced actions:', error);
      }
    }
  }

  // Execute a single sync action
  async executeSyncAction(action) {
    const { base44 } = await import('@/api/base44Client');
    
    switch (action.type) {
      case 'updateDelivery':
        await base44.entities.Delivery.update(action.deliveryId, action.data);
        break;
      case 'createDelivery':
        await base44.entities.Delivery.create(action.data);
        break;
      case 'updatePatient':
        await base44.entities.Patient.update(action.patientId, action.data);
        break;
      default:
        console.warn('⚠️ [OfflineManager] Unknown action type:', action.type);
    }
  }

  // Open IndexedDB
  openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('rxdeliver_offline', 1);
      
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
      const pendingRequest = pendingStore.getAll();
      
      pendingRequest.onsuccess = () => {
        this.pendingActions = pendingRequest.result || [];
        console.log('📦 [OfflineManager] Loaded', this.pendingActions.length, 'pending actions');
      };
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
      await store.clear();
      
      this.cachedData = {
        deliveries: null,
        patients: null,
        stores: null,
        drivers: null,
        users: null,
        lastUpdate: null
      };
      
      console.log('🧹 [OfflineManager] Cache cleared');
    } catch (error) {
      console.error('❌ [OfflineManager] Error clearing cache:', error);
    }
  }
}

// Singleton instance
export const offlineManager = new OfflineManager();