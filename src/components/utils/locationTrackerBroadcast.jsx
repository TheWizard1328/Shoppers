import { base44 } from '@/api/base44Client';
import { getCurrentDevice, updateDeviceLastActive } from './deviceManager';

const broadcastMutation = async (entity, action, id, data) => {
  try {
    const { broadcastMutation: broadcast } = await import('./realtimeSync');
    return broadcast(entity, action, id, data);
  } catch (error) {
    console.warn('[LocationTracker] Could not broadcast mutation:', error.message);
  }
};

export const syncUpdatedAppUser = async ({ updatedAppUser, currentUser }) => {
  // Stamp the device_identifier so realtimeSync can suppress the self-echo on this device
  const deviceIdentifier = localStorage.getItem('rxdeliver_device_identifier');
  if (deviceIdentifier) {
    updatedAppUser = { ...updatedAppUser, _source_device: deviceIdentifier };
  }

  try {
    const { offlineDB } = await import('./offlineDatabase');
    await offlineDB.save(offlineDB.STORES.APP_USERS, updatedAppUser);

    window.dispatchEvent(new CustomEvent('appUserUpdated', {
      detail: { appUser: updatedAppUser, fromLocationTracker: true }
    }));
  } catch (offlineError) {
    console.error('❌ [LocationTracker] FAILED TO SYNC to offline DB:', offlineError.message);
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
      detail: {
        appUsers: [updatedAppUser],
        singleUpdate: true,
        fromLocationTracker: true,
        mergeMode: 'merge'
      }
    }));
  }

  await broadcastMutation('AppUser', 'update', updatedAppUser.id, updatedAppUser);

  const currentDevice = await getCurrentDevice(currentUser.id);
  if (currentDevice) {
    await updateDeviceLastActive(currentUser.id, currentDevice);
  }
};

export const fetchFreshAppUser = async (appUserId) => {
  const fullAppUser = await base44.entities.AppUser.filter({ id: appUserId });
  return fullAppUser && fullAppUser.length > 0 ? fullAppUser[0] : null;
};