// Centralized polyline color palette — single source of truth for all polyline components
// High-visibility, contrasting colors — no shades of blue (blue is reserved for the active/current leg in Type1)

export const POLYLINE_COLORS = [
  '#E11D48', // Rose
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
  '#16A34A', // Green
];

// sortOrder-based color assignment — drivers are colored by their sort_order position in the list.
// Falls back to string hash if sort_order is not available.
const driverColorCache = new Map();

export const getPolylineColorForDriver = (driverId, sortOrder) => {
  if (!driverId) return POLYLINE_COLORS[0];

  // Use sort_order directly as the palette index when available (1-based → 0-based)
  if (sortOrder != null && Number.isFinite(Number(sortOrder))) {
    return POLYLINE_COLORS[(Number(sortOrder) - 1) % POLYLINE_COLORS.length];
  }

  // Fallback: stable string hash (used by Type1/Type2 where sort_order isn't passed)
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