import { base44 } from '@/api/base44Client';

export const TRAVEL_MODE_OPTIONS = [
  { value: 'driving', label: 'Driving' },
  { value: 'cycling', label: 'Cycling' },
  { value: 'pedestrian', label: 'Walking' }
];

export function normalizeTravelMode(mode) {
  return ['driving', 'cycling', 'pedestrian'].includes(mode) ? mode : 'driving';
}

export function getTravelModeLineStyle(mode, color) {
  const normalized = normalizeTravelMode(mode);
  if (normalized === 'cycling') {
    return { color: '#16A34A', weight: 3, opacity: 0.9, dashArray: '2 4' };
  }
  if (normalized === 'pedestrian') {
    return { color, weight: 3, opacity: 0.9, dashArray: '3 8' };
  }
  return { color, weight: 3, opacity: 0.9, dashArray: '' };
}

export function getPreferredTravelMode(appUsers = [], currentUserId) {
  return normalizeTravelMode(
    appUsers.find((user) => user?.user_id === currentUserId)?.preferred_travel_mode
  );
}

export async function updatePreferredTravelMode(appUsers = [], currentUserId, nextMode) {
  const appUser = appUsers.find((user) => user?.user_id === currentUserId);
  if (!appUser?.id) return;
  await base44.entities.AppUser.update(appUser.id, {
    preferred_travel_mode: normalizeTravelMode(nextMode)
  });
}