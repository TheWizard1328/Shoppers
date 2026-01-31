/**
 * User Settings Manager
 * Manages per-user, per-device settings stored in the backend
 * Enhanced with offline caching support
 */

import { UserSettings } from '@/entities/UserSettings';
import { offlineManager } from './offlineManager';
import { getUserAgentInfo } from './deviceUtils';

// In-memory cache for current session
let cachedSettings = null;
let currentUserId = null;
let cachedDeviceType = null; // Cache device type (Mobile or Desktop)
let lastFetchTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache to prevent rate limits

/**
 * Gets device type identifier - simply "Mobile" or "Desktop"
 * This ensures only 1 settings record per device type per user
 * CRITICAL: Always returns "Mobile" if is_mobile flag was set, regardless of current screen width
 */
export function getDeviceType() {
  // CRITICAL: Check if this device was previously marked as mobile via localStorage
  const wasMobile = localStorage.getItem('rxdeliver_is_mobile');
  if (wasMobile === 'true') {
    cachedDeviceType = 'Mobile';
    console.log('📱 [UserSettings] Device Type: Mobile (from localStorage flag)');
    return cachedDeviceType;
  }

  // Return cached if available
  if (cachedDeviceType) {
    return cachedDeviceType;
  }

  const { deviceType } = getUserAgentInfo();
  const isMobile = deviceType === 'Mobile';
  cachedDeviceType = isMobile ? 'Mobile' : 'Desktop';
  
  // CRITICAL: Store mobile flag in localStorage to persist across sessions
  if (isMobile) {
    localStorage.setItem('rxdeliver_is_mobile', 'true');
  }
  
  console.log('📱 [UserSettings] Device Type:', cachedDeviceType);
  return cachedDeviceType;
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
    theme_preference: isMobile ? 'auto' : 'light'
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

// CRITICAL: These settings are NEVER synced across devices
// Each device maintains its own values for these
const DEVICE_SPECIFIC_SETTINGS = [
  'fab_map_cycle_phase',
  'sidebar_width',
  'right_panel_width',
  'theme_preference',
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
async function saveToLocalPersistentStore(userId, deviceType, settings) {
  try {
    await offlineManager.cacheUserSettings(userId, deviceType, settings);
    console.log('📦 [UserSettings] Saved to local persistent store (IndexedDB)');
  } catch (error) {
    console.warn('⚠️ [UserSettings] Error saving to local persistent store:', error);
  }
}

/**
 * Loads settings from offlineManager's IndexedDB (for offline use)
 */
async function loadFromLocalPersistentStore(userId, deviceType) {
  try {
    const cached = await offlineManager.getCachedUserSettings(userId, deviceType);
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
 * CRITICAL: Only loads settings explicitly marked as GLOBAL_SETTINGS
 * Device-specific settings like selected_driver_id and selected_date are NEVER loaded here
 * @param {string} userId - The user's ID
 * @returns {Promise<object>} - Global settings object (only units, notifications, etc.)
 */
async function loadGlobalSettings(userId) {
  try {
    // Add small delay to prevent rate limiting from concurrent requests
    await new Promise(r => setTimeout(r, 50));
    
    // CRITICAL: Query for global settings without device_id filter
    // Returns settings from any device (latest)
    const allUserSettings = await UserSettings.filter({
      user_id: userId
    }, '-updated', 1); // Get most recently updated record

    if (allUserSettings && allUserSettings.length > 0) {
      const latestSettings = allUserSettings[0];
      const globalSettings = {};
      
      // CRITICAL: Extract ONLY global settings - NOT device-specific ones like selected_driver_id, selected_date
      GLOBAL_SETTINGS.forEach(key => {
        if (latestSettings[key] !== undefined) {
          globalSettings[key] = latestSettings[key];
        }
      });
      
      console.log('🌐 [UserSettings] Loaded global settings:', Object.keys(globalSettings).join(', '));
      return globalSettings;
    }
    
    return {};
  } catch (error) {
    console.warn('⚠️ [UserSettings] Error loading global settings:', error);
    return {};
  }
}

/**
 * Loads user settings from the backend for the current user and device type
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

  const deviceType = getDeviceType();
  
  // Return cached if same user AND cache is fresh (< 5 min)
  const now = Date.now();
  if (cachedSettings && currentUserId === userId && (now - lastFetchTime < CACHE_DURATION)) {
    console.log('📋 [UserSettings] Returning cached settings (fresh)');
    return cachedSettings;
  }

  // Check if offline - use cached settings from IndexedDB
  if (!offlineManager.getOnlineStatus()) {
    console.log('📴 [UserSettings] Offline - loading from local persistent store');
    
    const indexedSettings = await loadFromLocalPersistentStore(userId, deviceType);
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
    console.log(`🔍 [UserSettings] Loading settings for user: ${userId}, device type: ${deviceType}`);
    
    // STEP 1: Load global settings (synced across all devices)
    const globalSettings = await loadGlobalSettings(userId);
    
    // STEP 2: Load device-specific settings for this device type
    // Add delay to space out API calls
    await new Promise(r => setTimeout(r, 100));
    
    const deviceSettings = await UserSettings.filter({
      user_id: userId,
      device_type: deviceType
    }, '-created_date', 10);

    if (deviceSettings && deviceSettings.length > 0) {
      // CRITICAL: If multiple records exist, delete duplicates and keep the OLDEST one
      if (deviceSettings.length > 1) {
        console.warn(`⚠️ [UserSettings] Found ${deviceSettings.length} duplicate records for ${deviceType}, cleaning up...`);
        const sorted = [...deviceSettings].sort((a, b) => 
          new Date(a.created_date || a.created || 0) - new Date(b.created_date || b.created || 0)
        );
        const keepRecord = sorted[0];
        
        for (let i = 1; i < deviceSettings.length; i++) {
          try {
            await UserSettings.delete(deviceSettings[i].id);
            console.log(`   Deleted duplicate ${deviceType} record: ${deviceSettings[i].id}`);
          } catch (deleteError) {
            console.warn('   Failed to delete duplicate:', deleteError.message);
          }
        }
        
        deviceSettings[0] = keepRecord;
      }
      
      cachedSettings = { 
        ...DEFAULT_SETTINGS, 
        ...globalSettings,
        ...deviceSettings[0]
      };
      currentUserId = userId;
      lastFetchTime = Date.now();
      
      await saveToLocalPersistentStore(userId, deviceType, cachedSettings);
      
      console.log(`✅ [UserSettings] Loaded ${deviceType} settings (cached for 5 min)`);
      return cachedSettings;
    }

    // No settings found - create new record for this device type
    console.log(`ℹ️ [UserSettings] No ${deviceType} settings found, creating...`);
    
    try {
      const now = new Date().toISOString();
      const isMobile = deviceType === 'Mobile';
      
      const newSettings = await UserSettings.create({
        user_id: userId,
        device_type: deviceType,
        is_mobile: isMobile,
        ...DEFAULT_SETTINGS,
        ...globalSettings,
        theme_preference: isMobile ? 'auto' : 'light',
        created: now,
        updated: now
      });
      cachedSettings = { ...DEFAULT_SETTINGS, ...globalSettings, ...newSettings };
      currentUserId = userId;
      lastFetchTime = Date.now();
      
      await saveToLocalPersistentStore(userId, deviceType, cachedSettings);
      
      console.log(`✅ [UserSettings] Created ${deviceType} settings record (cached for 5 min)`);
      return cachedSettings;
    } catch (createError) {
      if (createError.message?.includes('duplicate') || createError.message?.includes('conflict')) {
        console.warn('⚠️ [UserSettings] Creation conflict - fetching again');
        const finalCheck = await UserSettings.filter({
          user_id: userId,
          device_type: deviceType
        }, '-created_date', 1);
        
        if (finalCheck && finalCheck.length > 0) {
          cachedSettings = { ...DEFAULT_SETTINGS, ...finalCheck[0] };
          currentUserId = userId;
          await saveToLocalPersistentStore(userId, deviceType, cachedSettings);
          return cachedSettings;
        }
      }
      
      console.error('❌ [UserSettings] Error creating settings record:', createError);
      cachedSettings = { ...DEFAULT_SETTINGS };
      currentUserId = userId;
      return cachedSettings;
    }

  } catch (error) {
    console.error('❌ [UserSettings] Error loading settings:', error);
    
    const indexedSettings = await loadFromLocalPersistentStore(userId, deviceType);
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
 * Handles global settings (synced across devices) vs device-specific settings
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

  const deviceType = getDeviceType();
  const isGlobal = isGlobalSetting(key);
  
  console.log(`💾 [UserSettings] Saving ${isGlobal ? 'GLOBAL' : deviceType} setting: ${key}=${value}`);
  
  if (cachedSettings) {
    cachedSettings[key] = value;
  } else {
    cachedSettings = { ...DEFAULT_SETTINGS, [key]: value };
  }
  currentUserId = userId;
  
  await saveToLocalPersistentStore(userId, deviceType, cachedSettings);

  if (!offlineManager.getOnlineStatus()) {
    console.log(`📴 [UserSettings] Offline - queuing setting ${key} for sync`);
    
    await offlineManager.queueAction({
      type: 'updateUserSettings',
      userId,
      deviceType,
      key,
      value,
      data: { [key]: value }
    });
    
    return cachedSettings;
  }

  try {
    if (isGlobal) {
      console.log(`🌐 [UserSettings] Updating GLOBAL setting across Mobile + Desktop`);
      
      const allDeviceSettings = await UserSettings.filter({
        user_id: userId
      });
      
      for (const deviceRecord of allDeviceSettings) {
        try {
          await UserSettings.update(deviceRecord.id, {
            [key]: value,
            updated: new Date().toISOString()
          });
        } catch (updateError) {
          console.warn(`   Failed to update device type ${deviceRecord.device_type}:`, updateError.message);
        }
      }
      
      console.log(`✅ [UserSettings] Updated global setting on ${allDeviceSettings.length} device types`);
    }

    const existingSettings = await UserSettings.filter({
      user_id: userId,
      device_type: deviceType
    }, '-created_date', 10);

    let updatedSettings;

    if (existingSettings && existingSettings.length > 0) {
      if (existingSettings.length > 1) {
        console.warn(`⚠️ [UserSettings] Found ${existingSettings.length} duplicate ${deviceType} records, cleaning up...`);
        for (let i = 1; i < existingSettings.length; i++) {
          try {
            await UserSettings.delete(existingSettings[i].id);
            console.log(`   Deleted duplicate ${deviceType} record`);
          } catch (deleteError) {
            console.warn('   Failed to delete duplicate:', deleteError.message);
          }
        }
      }
      
      updatedSettings = await UserSettings.update(existingSettings[0].id, {
        ...cachedSettings,
        updated: new Date().toISOString()
      });
      console.log(`✅ [UserSettings] Updated ${deviceType} settings`);
    } else {
      const now = new Date().toISOString();
      const isMobile = deviceType === 'Mobile';
      
      updatedSettings = await UserSettings.create({
        user_id: userId,
        device_type: deviceType,
        is_mobile: isMobile,
        ...DEFAULT_SETTINGS,
        theme_preference: isMobile ? 'auto' : 'light',
        [key]: value,
        created: now,
        updated: now
      });
      console.log(`✅ [UserSettings] Created ${deviceType} settings record`);
    }

    cachedSettings = { ...DEFAULT_SETTINGS, ...updatedSettings };
    currentUserId = userId;
    
    await saveToLocalPersistentStore(userId, deviceType, cachedSettings);

    return cachedSettings;

  } catch (error) {
    console.error('❌ [UserSettings] Error saving setting:', error);
    
    if (error.message?.includes('Network') || error.message?.includes('fetch')) {
      await offlineManager.queueAction({
        type: 'updateUserSettings',
        userId,
        deviceType,
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
 * Handles global settings (synced across devices) vs device-specific settings
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

  const deviceType = getDeviceType();
  
  const globalUpdates = {};
  const deviceUpdates = {};
  
  Object.keys(settings).forEach(key => {
    if (isGlobalSetting(key)) {
      globalUpdates[key] = settings[key];
    } else {
      deviceUpdates[key] = settings[key];
    }
  });
  
  console.log(`💾 [UserSettings] Saving ${Object.keys(globalUpdates).length} global + ${Object.keys(deviceUpdates).length} ${deviceType} settings`);
  
  if (cachedSettings) {
    cachedSettings = { ...cachedSettings, ...settings };
  } else {
    cachedSettings = { ...DEFAULT_SETTINGS, ...settings };
  }
  currentUserId = userId;
  
  await saveToLocalPersistentStore(userId, deviceType, cachedSettings);

  if (!offlineManager.getOnlineStatus()) {
    console.log(`📴 [UserSettings] Offline - queuing settings for sync`);
    
    await offlineManager.queueAction({
      type: 'updateUserSettings',
      userId,
      deviceType,
      data: settings
    });
    
    return cachedSettings;
  }

  try {
    if (Object.keys(globalUpdates).length > 0) {
      console.log(`🌐 [UserSettings] Updating global settings across Mobile + Desktop`);
      
      const allDeviceSettings = await UserSettings.filter({
        user_id: userId
      });
      
      for (const deviceRecord of allDeviceSettings) {
        try {
          await UserSettings.update(deviceRecord.id, {
            ...globalUpdates,
            updated: new Date().toISOString()
          });
        } catch (updateError) {
          console.warn(`   Failed to update device type ${deviceRecord.device_type}:`, updateError.message);
        }
      }
      
      console.log(`✅ [UserSettings] Updated global settings on ${allDeviceSettings.length} device types`);
    }

    const existingSettings = await UserSettings.filter({
      user_id: userId,
      device_type: deviceType
    }, '-created_date', 10);

    let updatedSettings;

    if (existingSettings && existingSettings.length > 0) {
      if (existingSettings.length > 1) {
        console.warn(`⚠️ [UserSettings] Found ${existingSettings.length} duplicate ${deviceType} records, cleaning up...`);
        for (let i = 1; i < existingSettings.length; i++) {
          try {
            await UserSettings.delete(existingSettings[i].id);
          } catch (deleteError) {
            console.warn('   Failed to delete duplicate:', deleteError.message);
          }
        }
      }
      
      updatedSettings = await UserSettings.update(existingSettings[0].id, {
        ...cachedSettings,
        updated: new Date().toISOString()
      });
      console.log(`✅ [UserSettings] Updated ${deviceType} settings`);
    } else {
      const now = new Date().toISOString();
      const isMobile = deviceType === 'Mobile';
      
      updatedSettings = await UserSettings.create({
        user_id: userId,
        device_type: deviceType,
        is_mobile: isMobile,
        ...DEFAULT_SETTINGS,
        theme_preference: isMobile ? 'auto' : 'light',
        ...settings,
        created: now,
        updated: now
      });
      console.log(`✅ [UserSettings] Created ${deviceType} settings record`);
    }

    cachedSettings = { ...DEFAULT_SETTINGS, ...updatedSettings };
    currentUserId = userId;
    
    await saveToLocalPersistentStore(userId, deviceType, cachedSettings);

    return cachedSettings;

  } catch (error) {
    console.error('❌ [UserSettings] Error saving settings:', error);
    
    if (error.message?.includes('Network') || error.message?.includes('fetch')) {
      await offlineManager.queueAction({
        type: 'updateUserSettings',
        userId,
        deviceType,
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