/**
 * Layout Data Management Helpers
 * Handles merging and updating state to preserve full patient database during syncs
 */

/**
 * Merge patients into existing state - preserves full patient DB during syncs
 * @param {Array} prevPatients - Current patients in state
 * @param {Array} newPatients - New patients from sync
 * @returns {Array} Merged patient array
 */
export const mergePatients = (prevPatients, newPatients) => {
  if (!newPatients || newPatients.length === 0) return prevPatients || [];
  
  const updatedPatients = new Map((prevPatients || []).map((p) => [p.id, p]));
  newPatients.forEach((p) => {
    if (p?.id) updatedPatients.set(p.id, p);
  });
  return Array.from(updatedPatients.values());
};

/**
 * Merge deliveries into existing state
 * @param {Array} prevDeliveries - Current deliveries in state
 * @param {Array} newDeliveries - New deliveries from sync
 * @param {boolean} isFullReplacement - If true, replaces entire array
 * @returns {Array} Merged delivery array
 */
export const mergeDeliveries = (prevDeliveries, newDeliveries, isFullReplacement = false) => {
  if (!newDeliveries || newDeliveries.length === 0) return prevDeliveries || [];
  
  if (isFullReplacement) {
    return newDeliveries.filter(Boolean);
  }
  
  const updatedDeliveries = new Map((prevDeliveries || []).filter(Boolean).map((d) => [d.id, d]));
  newDeliveries.filter(Boolean).forEach((d) => {
    if (d?.id) updatedDeliveries.set(d.id, d);
  });
  return Array.from(updatedDeliveries.values());
};

/**
 * Apply full dataset to state with proper merging
 * @param {Object} params - Data to apply
 * @param {Function} params.setCities - Setter for cities
 * @param {Function} params.setStores - Setter for stores
 * @param {Function} params.setPatients - Setter for patients
 * @param {Function} params.setUsers - Setter for users
 * @param {Function} params.setDrivers - Setter for drivers
 * @param {Function} params.setAppUsers - Setter for appUsers
 * @param {Function} params.setDeliveries - Setter for deliveries
 * @param {Array} params.cities - Cities data
 * @param {Array} params.stores - Stores data
 * @param {Array} params.patients - Patients data
 * @param {Array} params.appUsers - AppUsers data
 * @param {Array} params.currentUser - Current user
 * @param {Function} params.updateDeliveriesLocally - Delivery update helper
 * @param {Function} params.setDataLoaded - Data loaded state setter
 */
export const applyFullDataToState = ({
  cities, stores, patients, appUsers, currentUser, deliveries,
  setCities, setStores, setPatients, setUsers, setDrivers, setAppUsers, setDeliveries,
  updateDeliveriesLocally, setDataLoaded
}) => {
  if (cities && cities.length > 0) {
    setCities(cities.sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity)));
  }
  
  if (stores && stores.length > 0) {
    setStores(stores.sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity)));
  }
  
  // CRITICAL: Merge patients to preserve full patient DB
  if (patients) {
    setPatients((prevPatients) => mergePatients(prevPatients, patients));
  }
  
  const mergedUsersMap = new Map();
  if (currentUser) mergedUsersMap.set(currentUser.id, currentUser);
  (appUsers || []).forEach((appUser) => {
    if (!appUser || mergedUsersMap.has(appUser.user_id)) return;
    const pseudoUser = createMergedUser(null, appUser);
    if (pseudoUser) mergedUsersMap.set(pseudoUser.id, pseudoUser);
  });
  const initialUsers = Array.from(mergedUsersMap.values()).filter(Boolean);
  const activeDrivers = sortUsers(initialUsers.filter((user) =>
    user && Array.isArray(user.app_roles) &&
    (user.app_roles.includes('driver') || user.app_roles.includes('admin')) &&
    user.user_name && user.status === 'active'
  ));
  setUsers(initialUsers);
  setDrivers(activeDrivers);
  
  if (appUsers && appUsers.length > 0) {
    setAppUsers(appUsers);
  }
  
  // Single delivery UI update — after all other state is set
  updateDeliveriesLocally(deliveries || [], true);
  setDataLoaded(true);
};

// Helper functions (imported from layout)
const createMergedUser = (authUser, appUser) => {
  if (!authUser && !appUser) return null;
  if (!authUser && appUser) return {
    id: appUser.user_id,
    user_id: appUser.user_id,
    email: null,
    full_name: appUser.user_name || 'Unknown User',
    user_name: appUser.user_name || 'Unknown User',
    display_name: appUser.user_name || 'Unknown User',
    app_roles: Array.isArray(appUser.app_roles) ? appUser.app_roles : [],
    status: appUser.status || 'inactive',
    driver_status: appUser.driver_status,
    city_id: appUser.city_id,
    store_ids: appUser.store_ids,
    sort_order: appUser.sort_order,
    phone: appUser.phone,
    home_latitude: appUser.home_latitude,
    home_longitude: appUser.home_longitude,
    current_latitude: appUser.current_latitude,
    current_longitude: appUser.current_longitude,
    location_updated_at: appUser.location_updated_at,
    location_tracking_enabled: appUser.location_tracking_enabled
  };
  
  let merged = { ...authUser, id: authUser.id, user_name: authUser.full_name, display_name: authUser.full_name, app_roles: [], status: 'inactive' };
  if (appUser) {
    merged = {
      ...merged,
      ...appUser,
      id: authUser.id,
      user_name: appUser.user_name ?? merged.user_name,
      display_name: appUser.user_name ?? merged.display_name,
      app_roles: Array.isArray(appUser.app_roles) ? appUser.app_roles : merged.app_roles,
      status: appUser.status ?? merged.status
    };
  }
  return merged;
};

const sortUsers = (users) => {
  return (users || []).sort((a, b) => (a?.sort_order ?? Infinity) - (b?.sort_order ?? Infinity));
};