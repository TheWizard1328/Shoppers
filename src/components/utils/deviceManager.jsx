import { base44 } from '@/api/base44Client';

const DEVICE_ID_KEY = 'rxdeliver_device_identifier';

/**
 * Get the current device's identifier from localStorage
 */
export function getDeviceIdentifier() {
  return localStorage.getItem(DEVICE_ID_KEY);
}

/**
 * Get the current device's UserDevice record from backend
 */
export async function getCurrentDevice(userId) {
  const deviceId = getDeviceIdentifier();
  if (!deviceId || !userId) {
    console.log(`⚠️ [DeviceManager] Missing deviceId (${!!deviceId}) or userId (${!!userId})`);
    return null;
  }

  try {
    const devices = await base44.entities.UserDevice.filter({
      user_id: userId,
      device_identifier: deviceId,
      status: 'active'
    });

    if (devices && devices.length > 0) {
      const device = devices[0];
      console.log(`📱 [DeviceManager] Found device: ${device.device_name} (Primary: ${device.is_primary_tracker ? 'YES' : 'NO'})`);
      return device;
    } else {
      console.log(`⚠️ [DeviceManager] No UserDevice record found for this device - assuming PRIMARY by default`);
      return null;
    }
  } catch (error) {
    console.error('❌ [DeviceManager] Failed to get current device:', error);
    return null;
  }
}

/**
 * Check if the current device is the primary tracker
 */
export async function isCurrentDevicePrimary(userId) {
  const device = await getCurrentDevice(userId);
  const isPrimary = device?.is_primary_tracker || false;
  
  const deviceName = device?.device_name || 'Unknown Device';
  console.log(`📱 [DeviceManager] Primary check for ${deviceName}: ${isPrimary ? 'YES ✅' : 'NO ❌'}`);
  
  return isPrimary;
}

/**
 * Update device's last active timestamp
 */
export async function updateDeviceLastActive(userId) {
  const device = await getCurrentDevice(userId);
  if (!device) return;

  try {
    await base44.entities.UserDevice.update(device.id, {
      last_active_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Failed to update device last active:', error);
  }
}

/**
 * Clear device identifier from localStorage (use when logging out or resetting)
 */
export function clearDeviceIdentifier() {
  localStorage.removeItem(DEVICE_ID_KEY);
}