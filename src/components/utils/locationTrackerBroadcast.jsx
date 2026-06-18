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
  const deviceIdentifier = localStorage.getItem('rxdeliver_device_identifier');

  // Register this AppUser record ID as "just written by this device" so the WS echo
  // arriving back on this same device can be suppressed — regardless of whether the
  // platform strips _source_device from the returned payload.
  if (deviceIdentifier && updatedAppUser?.id) {
    if (!window.__localAppUserWrites) window.__localAppUserWrites = new Map();
    window.__localAppUserWrites.set(updatedAppUser.id, Date.now());
  }

  // Strip _source_device before saving to offline DB — it is a local-only signal
  // and must never be persisted or broadcast to other devices via the DB record.
  const appUserForDB = { ...updatedAppUser };
  delete appUserForDB._source_device;

  try {
    const { offlineDB } = await import('./offlineDatabase');
    await offlineDB.save(offlineDB.STORES.APP_USERS, appUserForDB);

    window.dispatchEvent(new CustomEvent('appUserUpdated', {
      detail: { appUser: appUserForDB, fromLocationTracker: true }
    }));
  } catch (offlineError) {
    console.error('❌ [LocationTracker] FAILED TO SYNC to offline DB:', offlineError.message);
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
      detail: {
        appUsers: [appUserForDB],
        singleUpdate: true,
        fromLocationTracker: true,
        mergeMode: 'merge'
      }
    }));
  }

  // Broadcast to other devices — no _source_device in this payload so other devices
  // receive it normally. The originating device suppresses via __localAppUserWrites.
  await broadcastMutation('AppUser', 'update', appUserForDB.id, appUserForDB);

  const currentDevice = await getCurrentDevice(currentUser.id);
  if (currentDevice) {
    await updateDeviceLastActive(currentUser.id, currentDevice);
  }
};

export const fetchFreshAppUser = async (appUserId) => {
  const fullAppUser = await base44.entities.AppUser.filter({ id: appUserId });
  return fullAppUser && fullAppUser.length > 0 ? fullAppUser[0] : null;
};