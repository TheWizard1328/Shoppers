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

  // Driving:
  //   AM → solid line (dashArray: '')
  //   PM → dash-dot (dashArray: '8,6,2,6')
  if (normalized === 'driving' || normalized === 'pedestrian') {
    const dashArray = isPM ? '8,6,2,6' : '';
    return { color: safeColor, weight: 3, opacity: 0.9, dashArray };
  }

  // Cycling (color is always green — passed in as CYCLING_COLOR by caller):
  //   AM → dotted (dashArray: '2,8')
  //   PM → dash-dot (dashArray: '8,6,2,6')
  if (normalized === 'cycling') {
    const dashArray = isPM ? '8,6,2,6' : '2,8';
    return { color: safeColor, weight: 4, opacity: 0.9, dashArray };
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