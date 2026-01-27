/**
 * Device ID Manager
 * Generates and manages unique device/session IDs for multi-device sync
 */

const DEVICE_ID_KEY = 'rxdeliver_device_id';

/**
 * Get or create a unique device ID for this browser session
 */
export const getDeviceId = () => {
  try {
    let deviceId = sessionStorage.getItem(DEVICE_ID_KEY);
    
    if (!deviceId) {
      // Generate new device ID: userId_timestamp_random
      deviceId = `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      sessionStorage.setItem(DEVICE_ID_KEY, deviceId);
    }
    
    return deviceId;
  } catch (e) {
    // Fallback if sessionStorage is unavailable
    return `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
};

/**
 * Clear device ID (on logout)
 */
export const clearDeviceId = () => {
  try {
    sessionStorage.removeItem(DEVICE_ID_KEY);
  } catch (e) {
    // Silent fail
  }
};