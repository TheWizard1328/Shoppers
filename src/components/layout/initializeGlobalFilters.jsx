import { format } from 'date-fns';
import { globalFilters } from '../utils/globalFilters';
import { userHasRole } from '../utils/userRoles';

/**
 * Sets globalFilters (selectedDate + selectedDriverId) based on role-based priorities:
 * - Drivers: always today + their own driver ID
 * - Dispatchers: always today + saved driver preference (or 'all')
 * - Admins: restore saved date + driver (defaults to today/'all')
 * - Fallback: today + all
 */
export function initializeGlobalFilters(fetchedUser, savedSettings) {
  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const s = savedSettings || {};

  const isDriverOnly = userHasRole(fetchedUser, 'driver') && !userHasRole(fetchedUser, 'admin');
  const isDispatcherOnly = userHasRole(fetchedUser, 'dispatcher') && !userHasRole(fetchedUser, 'admin');
  const isAdmin = userHasRole(fetchedUser, 'admin');

  if (isDriverOnly) {
    // Drivers: always today + their own ID
    globalFilters.setSelectedDate(todayStr, fetchedUser.id);
    globalFilters.setSelectedDriverId(fetchedUser.id, fetchedUser.id);
  } else if (isDispatcherOnly) {
    // Dispatchers: always today + saved driver pref (or 'all')
    globalFilters.setSelectedDate(todayStr, fetchedUser.id);
    globalFilters.setSelectedDriverId(s.selected_driver_id || 'all', fetchedUser.id);
  } else if (isAdmin) {
    // Admins: restore saved date + driver, fallback to today/'all'
    globalFilters.setSelectedDate(s.selected_date || todayStr, fetchedUser.id);
    globalFilters.setSelectedDriverId(s.selected_driver_id || 'all', fetchedUser.id);
  } else {
    // Fallback
    globalFilters.setSelectedDate(todayStr, fetchedUser.id);
    globalFilters.setSelectedDriverId('all', fetchedUser.id);
  }
}

export const createMergedUser = (authUser, appUser) => {
  if (!authUser && !appUser) return null;
  if (!authUser && appUser) return {
    id: appUser.user_id, user_id: appUser.user_id, email: null,
    full_name: appUser.user_name || 'Unknown User', user_name: appUser.user_name || 'Unknown User',
    display_name: appUser.user_name || 'Unknown User',
    app_roles: Array.isArray(appUser.app_roles) ? appUser.app_roles : [],
    status: appUser.status || 'inactive', driver_status: appUser.driver_status,
    city_id: appUser.city_id, store_ids: appUser.store_ids, sort_order: appUser.sort_order,
    phone: appUser.phone, home_latitude: appUser.home_latitude, home_longitude: appUser.home_longitude,
    current_latitude: appUser.current_latitude, current_longitude: appUser.current_longitude,
    location_updated_at: appUser.location_updated_at, location_tracking_enabled: appUser.location_tracking_enabled
  };
  let merged = {
    ...authUser, id: authUser.id, user_name: authUser.full_name,
    display_name: authUser.full_name, app_roles: [], status: 'inactive'
  };
  if (appUser) {
    merged = {
      ...merged, ...appUser, id: authUser.id,
      user_name: appUser.user_name ?? merged.user_name,
      display_name: appUser.user_name ?? merged.display_name,
      app_roles: Array.isArray(appUser.app_roles) ? appUser.app_roles : merged.app_roles,
      status: appUser.status ?? merged.status
    };
  }
  return merged;
};

// CRITICAL: driver_status, location fields, company_id intentionally excluded — changes to these
// must NOT trigger a full data reload (would wipe sidebar + appUsers from state).
// company_id is fixed at account creation and never changes during a session; including it
// caused false-positive reloads because currentUser (merged auth+appUser) sometimes carries
// it as undefined while the raw AppUser record has the real value.
const CURRENT_USER_REFRESH_KEYS = ['app_roles', 'store_ids', 'city_id', 'status', 'user_name', 'square_location_ids'];

// Keys that are purely operational/transient — changes to these alone should never trigger reload.
const TRANSIENT_ONLY_KEYS = new Set(['driver_status', 'location_tracking_enabled', 'current_latitude', 'current_longitude', 'location_updated_at', 'updated_date']);

export const hasCurrentUserRefreshImpact = (currentUser, updateData = {}) => {
  if (!currentUser || !updateData) return false;

  // Collect the keys that actually changed
  const changedKeys = CURRENT_USER_REFRESH_KEYS.filter((key) =>
    key in updateData && JSON.stringify(currentUser[key] ?? null) !== JSON.stringify(updateData[key] ?? null)
  );

  if (changedKeys.length === 0) return false;

  // If the only changes in the entire update payload are transient fields, don't reload.
  // This handles the case where a SmartRefresh poll returns appUser data that includes
  // a sentinel refresh key alongside transient fields (e.g. company_id mismatch).
  const nonTransientChangedKeys = Object.keys(updateData).filter(k => !TRANSIENT_ONLY_KEYS.has(k));
  if (nonTransientChangedKeys.length === 0) return false;

  return true;
};