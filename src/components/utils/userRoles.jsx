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

/**
 * Check if user is an App Owner (Base44 platform admin)
 * This checks PLATFORM admin role via User.role
 */
/**
 * The ONE platform account that is the App Owner (owner decision Nov 5 2026).
 * The platform User table lists eight role === 'admin' accounts; the extras are
 * Base44 platform administrators kept from testing and hold ordinary
 * administrative access, never owner access. Mirrors
 * PINNED_OWNER_PLATFORM_USER_ID in base44/functions/resolveAppOwnerIds.
 */
export const APP_OWNER_PLATFORM_USER_ID = '68570f3cd01bfa2d2408a9d7';

/**
 * Check if user is the App Owner.
 * Requires BOTH platform admin role and the pinned owner account id, so a
 * platform administrator who is not the owner no longer gets owner-only UI.
 */
export const isAppOwner = (user) => {
  if (!user) return false;
  if (user.role !== 'admin') return false;
  const id = user.id || user.user_id || null;
  if (!id) return false;
  return id === APP_OWNER_PLATFORM_USER_ID;
};

/**
 * TESTING USERS — accounts that run OWNER-ONLY features while they are being
 * tested in the field (owner request Nov 14 2026: "add Sharuk to the testing
 * list of users").
 *
 * This is the single list to edit when another person joins a test. Entries are
 * matched against BOTH ids a user object can carry — the platform auth id
 * (`user.id`, which equals AppUser.user_id) and the AppUser record id
 * (`user.user_id`, which equals AppUser.id) — because a Delivery/AppUser id and
 * an auth id are two different things in this app. Emails are matched too, in
 * lowercase, for accounts whose id changes on re-invite.
 *
 * The App Owner is ALWAYS a testing user (see isTestingUser) — nothing to add.
 */
export const TESTING_USER_IDS = [
  '696825d8ffeeeb3965f2db70', // Sharuk — auth id (AppUser.user_id), driver, added Nov 14 2026
  '6968265f58e58d9cee41e741', // Sharuk — AppUser record id
];
export const TESTING_USER_EMAILS = [];

/** True for the App Owner and for anyone on the testing list. */
export const isTestingUser = (user) => {
  if (!user) return false;
  if (isAppOwner(user)) return true;
  const ids = [user.id, user.user_id]
    .filter(Boolean)
    .map((v) => String(v));
  if (ids.some((id) => TESTING_USER_IDS.includes(id))) return true;
  const email = String(user.email || '').toLowerCase();
  return !!email && TESTING_USER_EMAILS.includes(email);
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
  if (roles.includes('store_owner')) return 'store_owner';
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
export const isStoreOwner = (user) => userHasRole(user, 'store_owner');

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