// Utility functions for handling driver display names and comparisons
// CRITICAL: Always use FULL user_name from AppUser for consistency and to handle duplicate first names

/**
 * Gets the display name for a driver (FULL user_name)
 * @param {Object|string} driver - Driver object or name string
 * @returns {string} - Full user_name
 */
export const getDriverDisplayName = (driver) => {
  if (!driver) return 'Unassigned';
  
  if (typeof driver === 'string') {
    return driver;
  }
  
  // SAFETY: Check if driver is a valid object
  if (typeof driver !== 'object') {
    console.warn('[driverUtils] Invalid driver type:', typeof driver);
    return 'Unknown';
  }
  
  // Return FULL user_name
  if (!driver.user_name) {
    console.warn('[driverUtils] Driver missing user_name:', driver.id || 'no-id');
    return driver.full_name || 'Unknown';
  }
  
  return driver.user_name; // Return FULL name
};

/**
 * Gets the full display name for a driver (full user_name)
 * @param {Object|string} driver - Driver object or name string
 * @returns {string} - Full user_name
 */
export const getDriverFullName = (driver) => {
  if (!driver) return 'Unassigned';
  if (typeof driver === 'string') return driver;
  
  // SAFETY: Check if driver is a valid object
  if (typeof driver !== 'object') {
    console.warn('[driverUtils] Invalid driver type in getDriverFullName:', typeof driver);
    return 'Unknown';
  }
  
  if (!driver.user_name) {
    console.warn('[driverUtils] Driver missing user_name in getDriverFullName:', driver.id || 'no-id');
    return driver.full_name || 'Unknown';
  }
  
  return driver.user_name;
};

/**
 * Finds a driver by name (matches against user_name)
 * @param {Array} drivers - Array of driver objects
 * @param {string} driverName - Name to search for
 * @returns {Object|null} - Found driver or null
 */
export const findDriverByName = (drivers, driverName) => {
  if (!drivers || !Array.isArray(drivers) || !driverName) return null;
  
  // SAFETY: Filter out null/undefined entries
  const validDrivers = drivers.filter(d => d && typeof d === 'object' && d.user_name);
  
  const searchName = driverName.toLowerCase().trim();
  
  // Try exact match first
  let driver = validDrivers.find(d => {
    const userName = (d.user_name || '').toLowerCase().trim();
    return userName === searchName;
  });
  
  // If not found, try contains (for partial matches)
  if (!driver) {
    driver = validDrivers.find(d => {
      const userName = (d.user_name || '').toLowerCase().trim();
      return userName.includes(searchName) || searchName.includes(userName);
    });
  }
  
  return driver;
};

/**
 * Gets the name to use for comparisons (uses FULL user_name)
 * @param {Object|string} driver - Driver object or name string
 * @returns {string|null} - Full name for comparison
 */
export const getDriverNameForComparison = (driver) => {
  if (!driver) return null;
  if (typeof driver === 'string') return driver.toLowerCase().trim();
  
  // SAFETY: Check if driver is a valid object
  if (typeof driver !== 'object') {
    console.warn('[driverUtils] Invalid driver type in getDriverNameForComparison:', typeof driver);
    return null;
  }
  
  const userName = driver.user_name || driver.full_name;
  return userName ? userName.toLowerCase().trim() : null;
};

/**
 * Gets the name to use for database storage (uses FULL user_name)
 * @param {Object|string} driver - Driver object or name string
 * @returns {string|null} - Full name for storage
 */
export const getDriverNameForStorage = (driver) => {
  if (!driver) return null;
  if (typeof driver === 'string') return driver;
  
  // SAFETY: Check if driver is a valid object
  if (typeof driver !== 'object') {
    console.warn('[driverUtils] Invalid driver type in getDriverNameForStorage:', typeof driver);
    return null;
  }
  
  if (!driver.user_name) {
    console.warn('[driverUtils] Cannot store - driver missing user_name:', driver.id || 'no-id');
    return driver.full_name || null;
  }
  
  return driver.user_name; // Store FULL name
};

/**
 * Helper to create merged user objects with AppUser data
 * @param {Object} authUser - User from authentication
 * @param {Object} appUser - AppUser with app-specific data
 * @returns {Object|null} - Merged user object
 */
export const createMergedUser = (authUser, appUser) => {
  if (!authUser) {
    console.warn('[driverUtils] createMergedUser: No authUser provided');
    return null;
  }
  
  // If no AppUser record exists, return null (incomplete user)
  if (!appUser) {
    console.warn('[driverUtils] createMergedUser: No appUser found for authUser:', authUser.email);
    return null;
  }
  
  // CRITICAL: Preserve app_roles exactly as they are in AppUser entity
  // DO NOT default, DO NOT override, DO NOT modify
  const preservedAppRoles = Array.isArray(appUser.app_roles) ? appUser.app_roles : [];
  
  const mergedUser = {
    ...authUser,
    ...appUser,
    id: authUser.id, // CRITICAL: Primary ID is always authUser.id
    app_roles: preservedAppRoles, // CRITICAL: Use the preserved app_roles EXACTLY as they are
    user_name: appUser.user_name || authUser.full_name,
    status: appUser.status || 'active',
    display_name: appUser.user_name || authUser.full_name,
    first_name: (appUser.user_name || authUser.full_name).split(' ')[0]
  };
  
  // Verify the merge preserved the roles correctly
  if (JSON.stringify(mergedUser.app_roles) !== JSON.stringify(preservedAppRoles)) {
    console.error('[driverUtils] CRITICAL: app_roles were corrupted during merge!', {
      expected: preservedAppRoles,
      actual: mergedUser.app_roles
    });
  }
  
  return mergedUser;
};

/**
 * Helper to merge arrays of users with their AppUser data
 * @param {Array} authUsers - Array of User objects
 * @param {Array} appUsers - Array of AppUser objects
 * @returns {Array} - Array of merged user objects (filtered to remove null entries)
 */
export const mergeUsersWithAppUsers = (authUsers = [], appUsers = []) => {
  
  // SAFETY: Filter out any null/undefined results
  const merged = authUsers.map(authUser => {
    const appUser = appUsers.find(au => au && au.user_id === authUser.id);
    const result = createMergedUser(authUser, appUser);
    
    return result;
  }).filter(user => user && user.user_name); // Only keep valid users with user_name
  
  return merged;
};

// Driver color palette for consistent coloring across the app
const DRIVER_COLORS = [
  '', // Index 0 - not used, to align with 1-based sort_order/hashing
  '#1E90FF', // Dodger Blue (Index 1)
  '#8A2BE2', // Blue Violet (Index 2)
  '#00CED1', // Dark Cyan/Teal (Index 3)
  '#FF69B4', // Hot Pink (Index 4)
  '#4B0082', // Indigo (Index 5)
  '#A0522D'  // Sienna - Reddish-Brown (Index 6)
];

/**
 * Returns a stable, distinct driver color used by map icons and polylines
 */
export const getDriverColor = (driver) => {
  if (!driver || typeof driver !== 'object' || !driver.id) {
    return '#607D8B'; // Default blue-grey for invalid/unassigned
  }

  const numFixedColors = DRIVER_COLORS.length - 1; // Exclude empty index 0

  // Prefer explicit sort_order mapping if within palette range
  if (typeof driver.sort_order === 'number' && driver.sort_order > 0 && driver.sort_order <= numFixedColors) {
    return DRIVER_COLORS[driver.sort_order];
  }

  // Fallback: generate HSL from driver.id in safe hue ranges (avoid greens/reds/yellows)
  let hash = 0;
  const idString = String(driver.id);
  for (let i = 0; i < idString.length; i++) {
    hash = idString.charCodeAt(i) + ((hash << 5) - hash);
  }
  const safeHueMin = 190; // Start from blue
  const safeHueRange = 140; // 190-330: blues, cyans, purples, magentas
  const hue = safeHueMin + (Math.abs(hash) % safeHueRange);
  return `hsl(${hue}, 70%, 50%)`;
};