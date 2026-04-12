export const TRAVEL_MODE_OPTIONS = [
  { value: 'driving', label: 'Driving' },
  { value: 'cycling', label: 'Cycling' },
  { value: 'pedestrian', label: 'Walking' }
];

export function getTravelModeLineStyle(mode, color) {
  if (mode === 'cycling') {
    return { color, weight: 4, opacity: 0.9, dashArray: '10 6' };
  }
  if (mode === 'pedestrian') {
    return { color, weight: 4, opacity: 0.9, dashArray: '3 8' };
  }
  return { color, weight: 5, opacity: 0.9, dashArray: '' };
}

export function normalizeTravelMode(mode) {
  return ['driving', 'cycling', 'pedestrian'].includes(mode) ? mode : 'driving';
}