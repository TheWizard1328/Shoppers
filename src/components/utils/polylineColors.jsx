// Centralized polyline color palette — single source of truth for all polyline components
// High-visibility, contrasting colors — no shades of blue (blue is reserved for the active/current leg in Type1)

export const POLYLINE_COLORS = [
  '#E11D48', // Rose
  '#16A34A', // Green
  '#EA580C', // Orange
  '#7C3AED', // Violet
  '#0F766E', // Teal
  '#DB2777', // Pink
  '#65A30D', // Lime
  '#9333EA', // Purple
  '#B45309', // Amber Brown
  '#DC2626', // Red
  '#059669', // Emerald
  '#C2410C', // Burnt Orange
  '#6D28D9', // Deep Violet
  '#047857', // Dark Emerald
  '#BE123C', // Crimson
];

// Stable hash so the same driver always gets the same color
const driverColorCache = new Map();

export const getPolylineColorForDriver = (driverId) => {
  if (!driverId) return POLYLINE_COLORS[0];
  if (driverColorCache.has(driverId)) return driverColorCache.get(driverId);
  let hash = 0;
  const str = String(driverId);
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash | 0;
  }
  const color = POLYLINE_COLORS[Math.abs(hash) % POLYLINE_COLORS.length];
  driverColorCache.set(driverId, color);
  return color;
};