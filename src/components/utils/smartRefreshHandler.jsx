// Handler to detect and respond to current user AppUser changes during smart refresh

import { getEffectiveUser, clearUserCache } from './auth';
import { invalidate } from './dataManager';

/**
 * Checks if the current user's AppUser data has changed and triggers appropriate updates
 * @param {Object} currentUser - Current user from Layout state
 * @param {Array} oldAppUsers - Previous appUsers state
 * @param {Array} newAppUsers - Updated appUsers from smart refresh
 * @param {Function} setCurrentUser - State setter for currentUser
 * @param {Function} setAppUsers - State setter for appUsers
 * @param {Function} triggerFullDataLoad - Function to reload all data
 * @returns {Promise<boolean>} - True if current user changed and full reload triggered
 */
export const handleAppUserUpdate = async (
  currentUser,
  oldAppUsers,
  newAppUsers,
  setCurrentUser,
  setAppUsers,
  triggerFullDataLoad
) => {
  if (!currentUser) {
    console.log('⏭️ [SmartRefreshHandler] No currentUser, skipping check');
    setAppUsers(newAppUsers);
    return false;
  }

  const oldAppUser = oldAppUsers.find(au => au && au.user_id === currentUser.id);
  const newAppUser = newAppUsers.find(au => au && au.user_id === currentUser.id);

  console.log('🔍 [SmartRefreshHandler] Checking currentUser AppUser changes...');
  console.log('   User:', currentUser.user_name);
  console.log('   OLD store_ids:', oldAppUser?.store_ids);
  console.log('   NEW store_ids:', newAppUser?.store_ids);

  // Compare store_ids
  const oldStoreIds = JSON.stringify((oldAppUser?.store_ids || []).sort());
  const newStoreIds = JSON.stringify((newAppUser?.store_ids || []).sort());
  const storeIdsChanged = oldStoreIds !== newStoreIds;

  // Compare other critical fields
  const cityIdChanged = oldAppUser?.city_id !== newAppUser?.city_id;
  const rolesChanged = JSON.stringify((oldAppUser?.app_roles || []).sort()) !== JSON.stringify((newAppUser?.app_roles || []).sort());

  if (storeIdsChanged || cityIdChanged || rolesChanged) {
    console.log('🚨🚨🚨 [SmartRefreshHandler] CURRENT USER AppUser DATA CHANGED!');
    console.log('   Store IDs changed:', storeIdsChanged);
    console.log('   City ID changed:', cityIdChanged);
    console.log('   Roles changed:', rolesChanged);

    // Update appUsers state first
    setAppUsers(newAppUsers);

    // Clear auth cache to force fresh merge
    console.log('🗑️ [SmartRefreshHandler] Clearing user cache');
    clearUserCache();

    // Wait a bit for state propagation
    await new Promise(resolve => setTimeout(resolve, 100));

    // Re-fetch and merge user
    console.log('🔄 [SmartRefreshHandler] Re-fetching effective user...');
    const refreshedUser = await getEffectiveUser();

    if (refreshedUser) {
      console.log('✅ [SmartRefreshHandler] User refreshed successfully!');
      console.log('   New store_ids:', refreshedUser.store_ids);
      console.log('   New app_roles:', refreshedUser.app_roles);

      // Update currentUser state
      setCurrentUser(refreshedUser);

      // Invalidate patient/delivery caches so next load gets filtered data
      invalidate('Patient');
      invalidate('Delivery');
      invalidate('Store');

      // Trigger full data reload with new user context
      // Use setTimeout to ensure React state updates have batched
      setTimeout(() => {
        console.log('🔄 [SmartRefreshHandler] Triggering full data reload...');
        triggerFullDataLoad(true);
      }, 200);

      return true;
    } else {
      console.error('❌ [SmartRefreshHandler] Failed to refresh user');
    }
  } else {
    console.log('✅ [SmartRefreshHandler] Current user AppUser unchanged');
  }

  // Normal update
  setAppUsers(newAppUsers);
  return false;
};