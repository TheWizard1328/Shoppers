import { base44 } from '@/api/base44Client';
import { offlineDB } from '@/components/utils/offlineDatabase';

export const TRAVEL_MODE_OPTIONS = [
  { value: 'driving', label: 'Driving' },
  { value: 'cycling', label: 'Cycling' },
  { value: 'pedestrian', label: 'Walking' }
];

export function normalizeTravelMode(mode) {
  return ['driving', 'cycling', 'pedestrian'].includes(mode) ? mode : 'driving';
}

export function getTravelModeLineStyle(mode, color, isPM = false) {
  const normalized = normalizeTravelMode(mode);
  const safeColor = color || '#71717A';
  // PM stops always use a dashed line regardless of travel mode
  if (isPM) {
    const weight = normalized === 'cycling' ? 4 : 3;
    const lineColor = normalized === 'cycling' ? '#16A34A' : safeColor;
    // Dot-dash: short dash + clear gap — '6,5' gives a clearly dashed look vs the solid AM line
    return { color: lineColor, weight, opacity: 0.9, dashArray: '6,5' };
  }
  if (normalized === 'cycling') {
    return { color: '#16A34A', weight: 4, opacity: 0.9, dashArray: '2 8' };
  }
  if (normalized === 'pedestrian') {
    return { color: safeColor, weight: 3, opacity: 0.9, dashArray: '3 8' };
  }
  return { color: safeColor, weight: 3, opacity: 0.9, dashArray: '' };
}

export function getPreferredTravelMode(appUsers = [], currentUserId) {
  return normalizeTravelMode(
    appUsers.find((user) => user?.user_id === currentUserId)?.preferred_travel_mode
  );
}

export async function updatePreferredTravelMode(appUsers = [], currentUserId, nextMode) {
  const appUser = appUsers.find((user) => user?.user_id === currentUserId);
  if (!appUser?.id) return;
  const normalized = normalizeTravelMode(nextMode);

  // Update online DB
  await base44.entities.AppUser.update(appUser.id, {
    preferred_travel_mode: normalized
  });

  // Update offline DB
  const updatedAppUser = { ...appUser, preferred_travel_mode: normalized };
  await offlineDB.save(offlineDB.STORES.APP_USERS, updatedAppUser).catch(() => {});

  // Broadcast to all devices so they pick up the new travel mode
  window.dispatchEvent(new CustomEvent('entityMutationBroadcast', {
    detail: {
      entity: 'AppUser',
      type: 'update',
      id: appUser.id,
      data: updatedAppUser
    }
  }));
  window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
    detail: { appUsers: null, singleUpdate: updatedAppUser }
  }));
}