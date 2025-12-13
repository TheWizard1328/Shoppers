/**
 * User Settings Manager
 * Manages per-user, per-device settings stored in the backend
 * Enhanced with offline caching support
 */

import { UserSettings } from '@/entities/UserSettings';
import { offlineManager } from './offlineManager';
import { getUserAgentInfo } from './deviceUtils';

const DEVICE_ID_KEY = 'rxdeliver_device_id';

// In-memory cache for current session
let cachedSettings = null;
let currentUserId = null;
let cachedDeviceId = null; // In-memory cache to avoid repeated async calls

// CRITICAL: Use a unique database name that won't conflict with other IndexedDB operations
const DB_NAME = 'rxdeliver_persistent_device_id';
const STORE_NAME = 'device_store';

function openDeviceDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onerror = (event) => {
      console.error('IndexedDB error:', event.target.errorCode);
      reject(event.target.error);
    };
  });
}

async function saveDeviceIdToIndexedDB(id) {
  try {
    const db = await openDeviceDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(id, DEVICE_ID_KEY);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.warn('⚠️ [UserSettings] Failed to save device ID to IndexedDB:', error);
  }
}

async function getDeviceIdFromIndexedDB() {
  try {
    const db = await openDeviceDb();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(DEVICE_ID_KEY);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  } catch (error) {
    console.warn('⚠️ [UserSettings] Failed to get device ID from IndexedDB:', error);
    return null;
  }
}

/**
 * Generate a deterministic device fingerprint based on browser/hardware characteristics
 * This creates a stable ID across browser tabs, PWAs, and sessions on the same machine
 */
async function generateDeviceFingerprint() {
  const components = [];
  
  // 1. Screen characteristics (stable across sessions)
  components.push(screen.width);
  components.push(screen.height);
  components.push(screen.colorDepth);
  components.push(screen.pixelDepth);
  
  // 2. Timezone (stable unless user changes timezone)
  components.push(Intl.DateTimeFormat().resolvedOptions().timeZone);
  
  // 3. Language preferences (stable)
  components.push(navigator.language);
  components.push(navigator.languages.join(','));
  
  // 4. Platform/OS (stable)
  components.push(navigator.platform);
  components.push(navigator.userAgent);
  
  // 5. Hardware concurrency (CPU cores - stable)
  components.push(navigator.hardwareConcurrency || 0);
  
  // 6. Device memory (stable on same device)
  components.push(navigator.deviceMemory || 0);
  
  // 7. Canvas fingerprint (highly stable, unique per device)
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 200;
    canvas.height = 50;
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('RxDeliver Device ID', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.fillText('RxDeliver Device ID', 4, 17);
    const canvasData = canvas.toDataURL();
    components.push(canvasData.slice(-100)); // Last 100 chars for uniqueness
  } catch (e) {
    components.push('canvas-unavailable');
  }
  
  // 8. WebGL fingerprint (stable, unique per GPU)
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        components.push(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL));
        components.push(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL));
      }
    }
  } catch (e) {
    components.push('webgl-unavailable');
  }
  
  // Combine all components and hash
  const fingerprint = components.join('|||');
  
  // Generate deterministic hash using SubtleCrypto
  const encoder = new TextEncoder();
  const data = encoder.encode(fingerprint);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  return 'device_fp_' + hashHex.slice(0, 32);
}

/**
 * Gets or generates a unique device ID using deterministic fingerprinting
 * This ensures the same device ID across browser tabs, PWAs, and sessions
 */
export async function getDeviceId() {
  // Return cached if available
  if (cachedDeviceId) {
    return cachedDeviceId;
  }

  // 1. Generate fingerprint-based device ID (deterministic)
  const fingerprintId = await generateDeviceFingerprint();
  
  // 2. Check if we have a stored ID that matches this fingerprint
  const storedId = await getDeviceIdFromIndexedDB();
  const localStorageId = localStorage.getItem(DEVICE_ID_KEY);
  
  let deviceId;
  
  // Priority: Use fingerprint-based ID for consistency across instances
  // But if we have a stored non-fingerprint ID, migrate it
  if (storedId && storedId.startsWith('device_fp_')) {
    deviceId = storedId;
    console.log('📱 [UserSettings] Using existing fingerprint-based device ID');
  } else if (localStorageId && localStorageId.startsWith('device_fp_')) {
    deviceId = localStorageId;
    console.log('📱 [UserSettings] Using existing fingerprint-based device ID from localStorage');
  } else if (storedId && !storedId.startsWith('device_fp_')) {
    // Migrate old random ID to fingerprint-based
    console.log('🔄 [UserSettings] Migrating old device ID to fingerprint-based ID');
    deviceId = fingerprintId;
  } else if (localStorageId && !localStorageId.startsWith('device_fp_')) {
    // Migrate old random ID to fingerprint-based
    console.log('🔄 [UserSettings] Migrating old device ID to fingerprint-based ID');
    deviceId = fingerprintId;
  } else {
    // No existing ID - use fingerprint
    deviceId = fingerprintId;
    console.log('📱 [UserSettings] Generated new fingerprint-based device ID');
  }
  
  // Save to both storage locations for redundancy
  localStorage.setItem(DEVICE_ID_KEY, deviceId);
  await saveDeviceIdToIndexedDB(deviceId);
  cachedDeviceId = deviceId;
  
  console.log('📱 [UserSettings] Device ID (first 16 chars):', deviceId.slice(0, 24));
  
  return deviceId;
}

/**
 * Default settings values
 * CRITICAL: Check device type to set appropriate default theme
 */
const getInitialDefaultSettings = () => {
  const { deviceType } = getUserAgentInfo();
  const isMobile = deviceType === 'Mobile';
  
  return {
    fab_map_cycle_phase: 1,
    units_of_measurement: 'kilometers',
    notifications_enabled: true,
    notifications_sound: true,
    notifications_vibration: true,
    sidebar_width: 240,
    right_panel_width: 350,
    theme_preference: isMobile ? 'auto' : 'light',
    selected_driver_id: null
  };
};

const DEFAULT_SETTINGS = getInitialDefaultSettings();

/**
 * SETTINGS CLASSIFICATION
 * Defines which settings are global (synced across devices) vs device-specific
 */
const GLOBAL_SETTINGS = [
  'units_of_measurement',
  'notifications_enabled', 
  'notifications_sound',
  'notifications_vibration'
];

const DEVICE_SPECIFIC_SETTINGS = [
  'fab_map_cycle_phase',
  'sidebar_width',
  'right_panel_width',
  'theme_preference',
  'selected_driver_id',
  'selected_date',
  'admin_utilities_year',
  'admin_utilities_month',
  'admin_utilities_driver'
];

// Check if a setting is global or device-specific
function isGlobalSetting(key) {
  return GLOBAL_SETTINGS.includes(key);
}

function isDeviceSpecificSetting(key) {
  return DEVICE_SPECIFIC_SETTINGS.includes(key);
}

/**
 * Save settings to offlineManager's IndexedDB for robust local persistence
 */
async function saveToLocalPersistentStore(userId, deviceId, settings) {
  try {
    await offlineManager.cacheUserSettings(userId, deviceId, settings);
    console.log('📦 [UserSettings] Saved to local persistent store (IndexedDB)');
  } catch (error) {
    console.warn('⚠️ [UserSettings] Error saving to local persistent store:', error);
  }
}

/**
 * Loads settings from offlineManager's IndexedDB (for offline use)
 */
async function loadFromLocalPersistentStore(userId, deviceId) {
  try {
    const cached = await offlineManager.getCachedUserSettings(userId, deviceId);
    if (cached) {
      console.log('📦 [UserSettings] Loaded from local persistent store (IndexedDB)');
      return cached;
    }
  } catch (error) {
    console.warn('⚠️ [UserSettings] Error loading from local persistent store:', error);
  }
  return null;
}

/**
 * Loads global settings (synced across all devices) for the user
 * @param {string} userId - The user's ID
 * @returns {Promise<object>} - Global settings object
 */
async function loadGlobalSettings(userId) {
  try {
    // CRITICAL: Query for global settings without device_id filter
    // Returns settings from any device (latest)
    const allUserSettings = await UserSettings.filter({
      user_id: userId
    }, '-updated', 1); // Get most recently updated record

    if (allUserSettings && allUserSettings.length > 0) {
      const latestSettings = allUserSettings[0];
      const globalSettings = {};
      
      // Extract only global settings
      GLOBAL_SETTINGS.forEach(key => {
        if (latestSettings[key] !== undefined) {
          globalSettings[key] = latestSettings[key];
        }
      });
      
      console.log('🌐 [UserSettings] Loaded global settings from latest device');
      return globalSettings;
    }
    
    return {};
  } catch (error) {
    console.warn('⚠️ [UserSettings] Error loading global settings:', error);
    return {};
  }
}

/**
 * Loads user settings from the backend for the current user and device
 * Merges global settings (synced across devices) with device-specific settings
 * Falls back to cached settings when offline
 * @param {string} userId - The user's ID
 * @returns {Promise<object>} - The user settings object
 */
export async function loadUserSettings(userId) {
  if (!userId) {
    console.warn('⚠️ [UserSettings] No userId provided, returning defaults');
    return { ...DEFAULT_SETTINGS };
  }

  const deviceId = await getDeviceId();
  
  // Return cached if same user
  if (cachedSettings && currentUserId === userId) {
    console.log('📋 [UserSettings] Returning cached settings');
    return cachedSettings;
  }

  // Check if offline - use cached settings from IndexedDB
  if (!offlineManager.getOnlineStatus()) {
    console.log('📴 [UserSettings] Offline - loading from local persistent store');
    
    const indexedSettings = await loadFromLocalPersistentStore(userId, deviceId);
    if (indexedSettings) {
      cachedSettings = { ...DEFAULT_SETTINGS, ...indexedSettings };
      currentUserId = userId;
      return cachedSettings;
    }
    
    // Return defaults if no cache available
    console.log('⚠️ [UserSettings] No cached settings available in IndexedDB, using defaults');
    return { ...DEFAULT_SETTINGS };
  }

  try {
    console.log(`🔍 [UserSettings] Loading settings for user: ${userId}, device: ${deviceId}`);
    
    // STEP 1: Load global settings (synced across all devices)
    const globalSettings = await loadGlobalSettings(userId);
    
    // STEP 2: Load device-specific settings for this device
    const deviceSettings = await UserSettings.filter({
      user_id: userId,
      device_id: deviceId
    }, '-created_date', 10);

    if (deviceSettings && deviceSettings.length > 0) {
      // CRITICAL: If multiple records exist, delete duplicates and keep the first one
      if (deviceSettings.length > 1) {
        console.warn(`⚠️ [UserSettings] Found ${deviceSettings.length} duplicate records, cleaning up...`);
        for (let i = 1; i < deviceSettings.length; i++) {
          try {
            await UserSettings.delete(deviceSettings[i].id);
            console.log(`   Deleted duplicate record: ${deviceSettings[i].id}`);
          } catch (deleteError) {
            console.warn('   Failed to delete duplicate:', deleteError.message);
          }
        }
      }
      
      // STEP 3: Merge defaults → global settings → device-specific settings
      // Priority: device-specific > global > defaults
      cachedSettings = { 
        ...DEFAULT_SETTINGS, 
        ...globalSettings, // Apply global settings (synced across devices)
        ...deviceSettings[0] // Override with device-specific settings
      };
      currentUserId = userId;
      
      // Cache for offline use in IndexedDB
      await saveToLocalPersistentStore(userId, deviceId, cachedSettings);
      
      console.log('✅ [UserSettings] Loaded settings (global + device-specific)');
      return cachedSettings;
    }

    // No settings found for this user/device combo - create a new record
    // CRITICAL: Double-check again to prevent race condition from concurrent calls
    console.log('ℹ️ [UserSettings] No settings found, double-checking before creating...');
    
    const doubleCheck = await UserSettings.filter({
      user_id: userId,
      device_id: deviceId
    }, '-created_date', 1);
    
    if (doubleCheck && doubleCheck.length > 0) {
      console.log('✅ [UserSettings] Found record in double-check (race condition avoided)');
      cachedSettings = { ...DEFAULT_SETTINGS, ...doubleCheck[0] };
      currentUserId = userId;
      await saveToLocalPersistentStore(userId, deviceId, cachedSettings);
      return cachedSettings;
    }
    
    try {
      const now = new Date().toISOString();
      const { deviceType } = getUserAgentInfo();
      const isMobile = deviceType === 'Mobile';
      
      const newSettings = await UserSettings.create({
        user_id: userId,
        device_id: deviceId,
        ...DEFAULT_SETTINGS,
        theme_preference: isMobile ? 'auto' : 'light',
        created: now,
        updated: now
      });
      cachedSettings = { ...DEFAULT_SETTINGS, ...newSettings };
      currentUserId = userId;
      
      // Cache for offline use in IndexedDB
      await saveToLocalPersistentStore(userId, deviceId, cachedSettings);
      
      console.log('✅ [UserSettings] Created new settings record');
      return cachedSettings;
    } catch (createError) {
      // CRITICAL: If creation fails due to conflict, try fetching one more time
      if (createError.message?.includes('duplicate') || createError.message?.includes('conflict')) {
        console.warn('⚠️ [UserSettings] Creation conflict - fetching again');
        const finalCheck = await UserSettings.filter({
          user_id: userId,
          device_id: deviceId
        }, '-created_date', 1);
        
        if (finalCheck && finalCheck.length > 0) {
          cachedSettings = { ...DEFAULT_SETTINGS, ...finalCheck[0] };
          currentUserId = userId;
          await saveToLocalPersistentStore(userId, deviceId, cachedSettings);
          return cachedSettings;
        }
      }
      
      console.error('❌ [UserSettings] Error creating new settings record:', createError);
      cachedSettings = { ...DEFAULT_SETTINGS };
      currentUserId = userId;
      return cachedSettings;
    }

  } catch (error) {
    console.error('❌ [UserSettings] Error loading settings:', error);
    
    // Try to load from local persistent store on error
    const indexedSettings = await loadFromLocalPersistentStore(userId, deviceId);
    if (indexedSettings) {
      console.log('📦 [UserSettings] Network error - falling back to cached settings from IndexedDB');
      cachedSettings = { ...DEFAULT_SETTINGS, ...indexedSettings };
      currentUserId = userId;
      return cachedSettings;
    }
    
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Saves a specific setting to the backend
 * Queues for offline sync if not connected
 * @param {string} userId - The user's ID
 * @param {string} key - The setting key to update
 * @param {any} value - The new value
 * @returns {Promise<object>} - The updated settings object
 */
export async function saveSetting(userId, key, value) {
  if (!userId) {
    console.warn('⚠️ [UserSettings] No userId provided, cannot save');
    return cachedSettings || { ...DEFAULT_SETTINGS };
  }

  const deviceId = await getDeviceId();
  
  // Update local cache immediately for responsive UI
  if (cachedSettings) {
    cachedSettings[key] = value;
  } else {
    cachedSettings = { ...DEFAULT_SETTINGS, [key]: value };
  }
  currentUserId = userId;
  
  // Save to local persistent store (IndexedDB)
  await saveToLocalPersistentStore(userId, deviceId, cachedSettings);

  // If offline, queue for later sync
  if (!offlineManager.getOnlineStatus()) {
    console.log(`📴 [UserSettings] Offline - queuing setting ${key} for sync`);
    
    // Queue the update for when we're back online
    await offlineManager.queueAction({
      type: 'updateUserSettings',
      userId,
      deviceId,
      key,
      value,
      data: { [key]: value }
    });
    
    return cachedSettings;
  }

  try {
    console.log(`💾 [UserSettings] Saving ${key}=${value} for user: ${userId}, device: ${deviceId}`);

    // Find existing settings
    const existingSettings = await UserSettings.filter({
      user_id: userId,
      device_id: deviceId
    });

    let updatedSettings;

    if (existingSettings && existingSettings.length > 0) {
      // CRITICAL: If multiple records exist, delete duplicates and keep the first one
      if (existingSettings.length > 1) {
        console.warn(`⚠️ [UserSettings] Found ${existingSettings.length} duplicate records during save, cleaning up...`);
        for (let i = 1; i < existingSettings.length; i++) {
          try {
            await UserSettings.delete(existingSettings[i].id);
          } catch (deleteError) {
            console.warn('   Failed to delete duplicate:', deleteError.message);
          }
        }
      }
      
      // Update existing record with updated timestamp
      updatedSettings = await UserSettings.update(existingSettings[0].id, {
        ...cachedSettings, // Pass all current cached settings to ensure consistency
        updated: new Date().toISOString()
      });
      console.log('✅ [UserSettings] Updated existing settings');
    } else {
      // Create new record with created timestamp
      const now = new Date().toISOString();
      const { deviceType } = getUserAgentInfo();
      const isMobile = deviceType === 'Mobile';
      
      updatedSettings = await UserSettings.create({
        user_id: userId,
        device_id: deviceId,
        ...DEFAULT_SETTINGS,
        theme_preference: isMobile ? 'auto' : 'light',
        [key]: value,
        created: now,
        updated: now
      });
      console.log('✅ [UserSettings] Created new settings record');
    }

    // Update cache
    cachedSettings = { ...DEFAULT_SETTINGS, ...updatedSettings };
    currentUserId = userId;
    
    // Update local persistent store (IndexedDB)
    await saveToLocalPersistentStore(userId, deviceId, cachedSettings);

    return cachedSettings;

  } catch (error) {
    console.error('❌ [UserSettings] Error saving setting:', error);
    
    // Queue for retry if network error
    if (error.message?.includes('Network') || error.message?.includes('fetch')) {
      await offlineManager.queueAction({
        type: 'updateUserSettings',
        userId,
        deviceId,
        key,
        value,
        data: { [key]: value }
      });
    }
    
    return cachedSettings || { ...DEFAULT_SETTINGS, [key]: value };
  }
}

/**
 * Saves multiple settings at once
 * Queues for offline sync if not connected
 * @param {string} userId - The user's ID
 * @param {object} settings - Object with key-value pairs to save
 * @returns {Promise<object>} - The updated settings object
 */
export async function saveSettings(userId, settings) {
  if (!userId) {
    console.warn('⚠️ [UserSettings] No userId provided, cannot save');
    return cachedSettings || { ...DEFAULT_SETTINGS };
  }

  const deviceId = await getDeviceId();
  
  // Update local cache immediately
  if (cachedSettings) {
    cachedSettings = { ...cachedSettings, ...settings };
  } else {
    cachedSettings = { ...DEFAULT_SETTINGS, ...settings };
  }
  currentUserId = userId;
  
  // Save to local persistent store (IndexedDB)
  await saveToLocalPersistentStore(userId, deviceId, cachedSettings);

  // If offline, queue for later sync
  if (!offlineManager.getOnlineStatus()) {
    console.log(`📴 [UserSettings] Offline - queuing settings for sync`);
    
    await offlineManager.queueAction({
      type: 'updateUserSettings',
      userId,
      deviceId,
      data: settings
    });
    
    return cachedSettings;
  }

  try {
    console.log(`💾 [UserSettings] Saving multiple settings for user: ${userId}, device: ${deviceId}`, settings);

    // Find existing settings
    const existingSettings = await UserSettings.filter({
      user_id: userId,
      device_id: deviceId
    });

    let updatedSettings;

    if (existingSettings && existingSettings.length > 0) {
      // CRITICAL: If multiple records exist, delete duplicates and keep the first one
      if (existingSettings.length > 1) {
        console.warn(`⚠️ [UserSettings] Found ${existingSettings.length} duplicate records during bulk save, cleaning up...`);
        for (let i = 1; i < existingSettings.length; i++) {
          try {
            await UserSettings.delete(existingSettings[i].id);
          } catch (deleteError) {
            console.warn('   Failed to delete duplicate:', deleteError.message);
          }
        }
      }
      
      // Update existing record with updated timestamp
      updatedSettings = await UserSettings.update(existingSettings[0].id, {
        ...cachedSettings, // Pass all current cached settings to ensure consistency
        updated: new Date().toISOString()
      });
      console.log('✅ [UserSettings] Updated existing settings');
    } else {
      // Create new record with created timestamp
      const now = new Date().toISOString();
      const { deviceType } = getUserAgentInfo();
      const isMobile = deviceType === 'Mobile';
      
      updatedSettings = await UserSettings.create({
        user_id: userId,
        device_id: deviceId,
        ...DEFAULT_SETTINGS,
        theme_preference: isMobile ? 'auto' : 'light',
        ...settings,
        created: now,
        updated: now
      });
      console.log('✅ [UserSettings] Created new settings record');
    }

    // Update cache
    cachedSettings = { ...DEFAULT_SETTINGS, ...updatedSettings };
    currentUserId = userId;
    
    // Update local persistent store (IndexedDB)
    await saveToLocalPersistentStore(userId, deviceId, cachedSettings);

    return cachedSettings;

  } catch (error) {
    console.error('❌ [UserSettings] Error saving settings:', error);
    
    // Queue for retry if network error
    if (error.message?.includes('Network') || error.message?.includes('fetch')) {
      await offlineManager.queueAction({
        type: 'updateUserSettings',
        userId,
        deviceId,
        data: settings
      });
    }
    
    return cachedSettings || { ...DEFAULT_SETTINGS, ...settings };
  }
}

/**
 * Gets a specific setting value (from cache or defaults)
 * @param {string} key - The setting key
 * @returns {any} - The setting value
 */
export function getSetting(key) {
  if (cachedSettings && cachedSettings[key] !== undefined) {
    return cachedSettings[key];
  }
  return DEFAULT_SETTINGS[key];
}

/**
 * Gets all current settings (from cache or defaults)
 * @returns {object} - All settings
 */
export function getAllSettings() {
  return cachedSettings || { ...DEFAULT_SETTINGS };
}

/**
 * Clears the settings cache (useful on logout)
 */
export function clearSettingsCache() {
  cachedSettings = null;
  currentUserId = null;
  console.log('🧹 [UserSettings] Cache cleared');
}

/**
 * Gets the default settings object
 * @returns {object} - Default settings
 */
export function getDefaultSettingsObject() {
  return { ...DEFAULT_SETTINGS };
}