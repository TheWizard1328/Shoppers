/**
 * User Role Utilities
 * 
 * IMPORTANT: These utilities check app_roles (plural) from AppUser entity ONLY.
 * The platform User.role (App Owner check) should ONLY be used in isAppOwner() function.
 */

/**
 * Check if user has a specific role in their app_roles array
 * CRITICAL: Only checks app_roles array from AppUser entity
 */
export const userHasRole = (user, role) => {
  if (!user || !role) return false;
  // STRICTLY check the app_roles array only - no fallback to User.role
  return Array.isArray(user.app_roles) && user.app_roles.includes(role);
};

/**
 * Check if user can access imports (Admin Utilities)
 * This checks PLATFORM admin role (App Owner) via User.role
 */
export const canAccessImports = (user, adminImportEnabled = false) => {
  if (!user) return false;
  // App owners always have access
  if (user.role === 'admin') return true;
  // Kyle J when admin import is enabled
  if (adminImportEnabled && user.user_name === 'Kyle J') return true;
  return false;
};

/**
 * Check if user is an App Owner (Base44 platform admin)
 * This checks PLATFORM admin role via User.role
 */
export const isAppOwner = (user) => {
  if (!user) return false;
  // Check platform User.role for App Owner status
  return user.role === 'admin';
};

/**
 * Get all roles assigned to a user
 * Returns app_roles array from AppUser entity
 */
export const getUserRoles = (user) => {
  if (!user) return [];
  if (Array.isArray(user.app_roles)) {
    return user.app_roles;
  }
  return [];
};

/**
 * Get the primary/highest priority role for display
 * Priority: admin > dispatcher > driver
 * Uses app_roles array only
 */
export const getPrimaryRole = (user) => {
  if (!user) return '';
  
  const roles = getUserRoles(user);
  
  if (roles.includes('admin')) return 'admin';
  if (roles.includes('dispatcher')) return 'dispatcher';
  if (roles.includes('driver')) return 'driver';
  
  return '';
};

/**
 * Direct role checks using app_roles array
 */
export const isAdmin = (user) => userHasRole(user, 'admin');
export const isDriver = (user) => userHasRole(user, 'driver');
export const isDispatcher = (user) => userHasRole(user, 'dispatcher');

/**
 * Format roles for display
 * Uses app_roles array only
 */
export const formatRoles = (user) => {
  const roles = getUserRoles(user);
  if (roles.length === 0) return 'no role';
  if (roles.length === 1) return roles[0];
  return roles.join(', ');
};

/**
 * Determines if store badges should be shown for the current user.
 * Hides store badges for dispatchers who manage only one store.
 */
export const shouldShowStoreBadges = (user) => {
  if (!user) return true;
  if (userHasRole(user, 'dispatcher')) {
    const storeIds = user.store_ids || [];
    return storeIds.length !== 1;
  }
  return true;
};