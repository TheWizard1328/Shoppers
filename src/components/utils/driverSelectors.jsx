import { sortUsers } from './sorting';
import { userHasRole } from './userRoles';

/**
 * Get all users who can be assigned as drivers (have 'driver' OR 'admin' role)
 * This is the standard logic used across the app for driver dropdowns
 * 
 * @param {Array} users - Array of merged user objects (User + AppUser)
 * @param {Object} options - Optional filtering options
 * @param {string} options.cityId - Filter by specific city ID
 * @param {boolean} options.activeOnly - Only include active users (default: true)
 * @returns {Array} - Sorted array of users who can be drivers
 */
export const getAvailableDrivers = (users, options = {}) => {
  if (!users || !Array.isArray(users)) {
    console.warn('⚠️ [driverSelectors] Invalid users array provided');
    return [];
  }

  const { cityId = null, activeOnly = true } = options;

  console.log(`🔍 [driverSelectors] Filtering ${users.length} users with options:`, {
    cityId: cityId || 'all cities',
    activeOnly
  });

  // Filter users who have 'driver' OR 'admin' role in app_roles
  const drivers = users.filter((user) => {
    // Must be a valid user object with app_roles
    if (!user || !user.app_roles || !Array.isArray(user.app_roles)) {
      return false;
    }

    // Must have either 'driver' or 'admin' role
    const hasDriverRole = user.app_roles.includes('driver');
    const hasAdminRole = user.app_roles.includes('admin');
    
    if (!hasDriverRole && !hasAdminRole) {
      return false;
    }

    // Must have a user_name
    if (!user.user_name) {
      return false;
    }

    // Check active status if required
    if (activeOnly && user.status !== 'active') {
      return false;
    }

    // Check city if specified
    if (cityId && user.city_id !== cityId) {
      return false;
    }

    return true;
  });

  console.log(`✅ [driverSelectors] Filtered to ${drivers.length} available drivers`);
  console.log(`   Names:`, drivers.map(d => d.user_name).join(', '));

  return sortUsers(drivers);
};

/**
 * Get all active drivers for a specific city (used by Layout for the drivers prop)
 * 
 * @param {Array} users - Array of merged user objects
 * @param {string} cityId - City ID to filter by
 * @returns {Array} - Sorted array of active drivers in the city
 */
export const getActiveDriversForCity = (users, cityId) => {
  return getAvailableDrivers(users, { cityId, activeOnly: true });
};

/**
 * Get all users who can drive (for forms and imports - no city filter, includes inactive)
 * 
 * @param {Array} users - Array of merged user objects
 * @param {boolean} activeOnly - Only include active users (default: false for imports)
 * @returns {Array} - Sorted array of users who can be drivers
 */
export const getAllDriverUsers = (users, activeOnly = false) => {
  return getAvailableDrivers(users, { cityId: null, activeOnly });
};