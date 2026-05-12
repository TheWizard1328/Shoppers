// Store color palette - distinct, professional colors for pharmacy stores
const STORE_COLOR_PALETTE = [
  '',        // Blank color storeage for unused 0 index
  '#2196F3', // Blue (Index 1) - Removed empty string
  '#9C27B0', // Purple (Index 2)
  '#E91E63', // Pink (Index 3)
  '#FF5722', // Deep Orange (Index 4)
  '#607D8B', // Blue Grey (Index 5)
  '#03A9F4', // Light Blue (Index 6)
  '#00BCD4', // Cyan (Index 7)
  '#795548', // Brown (Index 8)
  '#FFC107', // Amber (Index 9)
  '#4CAF50', // Green (Index 10)
  '#8BC34A', // Light Green (Index 11)
  '#FF9800'  // Orange (Index 12)
];
/*
    '', // unused
    '#3B82F6', // Blue
    '#10B981', // Emerald
    '#F59E0B', // Amber
    '#EF4444', // Red
    '#8B5CF6', // Purple
    '#EC4899', // Pink
    '#06B6D4', // Cyan
    '#84CC16', // Lime
    '#F97316', // Orange
    '#6366F1', // Indigo
    '#14B8A6', // Teal
    '#A855F7', // Violet
    '#F43F5E', // Rose
    '#22C55E', // Green
    '#FBBF24', // Yellow
*/
const usedStoreColors = new Map();

export const generateStoreColor = (storeName) => {
    // If we already generated a color for this store, return it
    if (usedStoreColors.has(storeName)) {
        return usedStoreColors.get(storeName);
    }

    // Simple hash function to get consistent color for same store name
    let hash = 0;
    for (let i = 0; i < storeName.length; i++) {
        hash = ((hash << 5) - hash) + storeName.charCodeAt(i);
        hash = hash & hash; // Convert to 32-bit integer
    }
    
    const index = Math.abs(hash) % STORE_COLOR_PALETTE.length;
    const color = STORE_COLOR_PALETTE[index];
    
    usedStoreColors.set(storeName, color);
    return color;
};

export const getStoreColor = (store) => {
    if (!store) return '#71717A'; // Default gray
    
    // If store has a color, use it
    if (store.color) return store.color;
    
    // Otherwise generate one based on store name
    return generateStoreColor(store.name || store.id || 'Unknown');
};

export const hexToRgba = (hex, alpha = 1) => {
    if (!hex) return `rgba(113, 113, 122, ${alpha})`; // Default gray
    
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return `rgba(113, 113, 122, ${alpha})`;
    
    return `rgba(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}, ${alpha})`;
};

// Get all available colors (useful for color picker)
export const getAvailableColors = () => STORE_COLOR_PALETTE;

// Helper function to get contrast color for text on a given background
export const getContrastColor = (backgroundColor) => {
  if (!backgroundColor) return '#000000';
  
  // Convert hex to RGB
  const hex = backgroundColor.replace('#', '');
  // Handle short hex codes (e.g., #FFF)
  const expandedHex = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex;

  const r = parseInt(expandedHex.substr(0, 2), 16);
  const g = parseInt(expandedHex.substr(2, 2), 16);
  const b = parseInt(expandedHex.substr(4, 2), 16);

  // Calculate luminance (ITU-R BT.709)
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

  // Return black or white based on luminance
  return luminance > 0.5 ? '#000000' : '#FFFFFF';
};

// Driver color palette - higher-contrast colors for nearby markers/polylines
const DRIVER_COLOR_PALETTE = [
    '#DC2626', // Red
    '#7C3AED', // Violet
    '#059669', // Emerald
    '#EA580C', // Orange
    '#DB2777', // Pink
    '#0F766E', // Teal
    '#9333EA', // Purple
    '#C2410C', // Burnt Orange
    '#BE123C', // Rose
    '#047857', // Dark Emerald
    '#7E22CE', // Deep Purple
    '#B91C1C', // Dark Red
    '#65A30D', // Lime Green
    '#D97706', // Amber
    '#A16207', // Brown Gold
    '#9A3412', // Rust
    '#881337', // Burgundy
    '#16A34A', // Green
];

const usedDriverColors = new Map();

export const generateDriverColor = (driverName) => {
    // If we already generated a color for this driver, return it
    if (usedDriverColors.has(driverName)) {
        return usedDriverColors.get(driverName);
    }

    // Simple hash function to get consistent color for same driver name
    let hash = 0;
    for (let i = 0; i < driverName.length; i++) {
        hash = ((hash << 5) - hash) + driverName.charCodeAt(i);
        hash = hash & hash; // Convert to 32-bit integer
    }
    
    const index = Math.abs(hash) % DRIVER_COLOR_PALETTE.length;
    const color = DRIVER_COLOR_PALETTE[index];
    
    usedDriverColors.set(driverName, color);
    return color;
};