import { userHasRole } from './userRoles';

/**
 * Filters deliveries based on user roles and selected filters.
 * Admins see all deliveries (subject to store/city filters).
 * Dispatchers see deliveries for their assigned stores/patients.
 * Drivers see only their assigned deliveries.
 */
export const getFilteredDeliveries = (deliveries, currentUser, patients, selectedStoreId) => {
  if (!deliveries.length || !currentUser) return [];
  let data = deliveries.filter((delivery) => delivery);

  // 1. Store Filter (Global)
  if (selectedStoreId && selectedStoreId !== 'all') {
    data = data.filter((delivery) => delivery && delivery.store_id === selectedStoreId);
  }

  // 2. Role-Based Filtering
  // CRITICAL: Admins bypass all role-based restrictions
  if (userHasRole(currentUser, 'admin')) {
    return data;
  }

  // Dispatcher Logic
  if (userHasRole(currentUser, 'dispatcher')) {
    const dispatcherStoreIds = currentUser.store_ids || [];
    
    // If dispatcher selects a store they don't have access to, show nothing
    if (selectedStoreId && selectedStoreId !== 'all' && !dispatcherStoreIds.includes(selectedStoreId)) {
      return [];
    }

    const relevantStoreIds = selectedStoreId && selectedStoreId !== 'all' ? [selectedStoreId] : dispatcherStoreIds;

    // Get all patient IDs belonging to the relevant stores
    const dispatcherPatientIds = new Set(
      patients.filter((p) => p && relevantStoreIds.includes(p.store_id)).map((p) => p.id)
    );

    data = data.filter((delivery) => {
      if (!delivery) return false;
      // If delivery has a patient, check if patient belongs to dispatcher's stores
      if (delivery.patient_id) {
        return dispatcherPatientIds.has(delivery.patient_id);
      }
      // Otherwise check if delivery's store_id matches
      return delivery.store_id && relevantStoreIds.includes(delivery.store_id);
    });
  } 
  // Driver Logic
  else if (userHasRole(currentUser, 'driver')) {
    data = data.filter((delivery) => delivery && delivery.driver_id === currentUser.id);
    
    // If driver is assigned to a specific store but selects a different one, show nothing
    // (Note: Drivers usually don't have store selection, but for safety)
    if (selectedStoreId && selectedStoreId !== 'all' && currentUser.store_id && currentUser.store_id !== selectedStoreId) {
      return [];
    }
  }

  return data;
};

/**
 * Filters patients based on user roles and selected filters.
 */
export const getFilteredPatients = (patients, currentUser, selectedStoreId) => {
  if (!patients.length || !currentUser) return [];
  let data = patients.filter((patient) => patient);

  // 1. Store Filter (Global)
  if (selectedStoreId && selectedStoreId !== 'all') {
    data = data.filter((p) => p && p.store_id === selectedStoreId);
  }

  // 2. Role-Based Filtering
  // CRITICAL: Admins bypass all role-based restrictions
  if (userHasRole(currentUser, 'admin')) {
    return data;
  }

  // Dispatcher Logic
  if (userHasRole(currentUser, 'dispatcher')) {
    const dispatcherStoreIds = currentUser.store_ids || [];
    
    // If dispatcher selects a store they don't have access to, show nothing
    if (selectedStoreId && selectedStoreId !== 'all' && !dispatcherStoreIds.includes(selectedStoreId)) {
      return [];
    }

    const relevantStoreIds = selectedStoreId && selectedStoreId !== 'all' ? [selectedStoreId] : dispatcherStoreIds;
    data = data.filter((p) => p && relevantStoreIds.includes(p.store_id));
  }
  // Driver Logic - Drivers typically don't view the full patient list, but if they do:
  else if (userHasRole(currentUser, 'driver')) {
    // Drivers usually only see patients for their active deliveries, 
    // but if accessing the patient list, they might be restricted to their store
    if (currentUser.store_id) {
       data = data.filter((p) => p && p.store_id === currentUser.store_id);
    }
  }

  return data;
};