import { useCallback } from 'react';

/**
 * Handles state updates from smartRefreshManager with proper merging logic
 */
export const useSmartRefreshStateUpdater = ({
  isFormOverlayOpen,
  deliveries,
  patients,
  currentUser,
  isReloadingFromAppUserChange,
  hasCurrentUserRefreshImpact,
  setDeliveries,
  setPatients,
  setAppUsers,
  setUsers,
  clearUserCache,
  invalidate,
  getEffectiveUser,
  setCurrentUser,
  needsDataReload,
  mergePatients
}) => {
  return useCallback(async (updates) => {
    if (isFormOverlayOpen) return;

    // CRITICAL: Don't clear UI if server returns empty (no data changed)
    if (updates.deliveries && updates.deliveries.length === 0 && deliveries.length > 0) return;
    if (updates.patients && updates.patients.length === 0 && patients.length > 0) return;

    // ─── MERGE DELIVERIES ──────────────────────────────────────────
    if (updates.deliveries && updates.deliveries.length > 0) {
      setDeliveries((prev) => {
        const map = new Map((prev || []).filter(Boolean).map((d) => [d?.id, d]).filter(([id]) => !!id));
        updates.deliveries.forEach((d) => {
          if (d?.id) map.set(d.id, d);
        });
        return Array.from(map.values());
      });
    }
    
    // ─── MERGE PATIENTS ────────────────────────────────────────────
    if (updates.patients && updates.patients.length > 0) {
      setPatients((prev) => mergePatients(prev, updates.patients));
    }
    
    // ─── MERGE APP USERS ──────────────────────────────────────────
    if (updates.appUsers && updates.appUsers.length > 0) {
      // Check if current user's roles/permissions changed
      if (currentUser && !isReloadingFromAppUserChange.current) {
        const updatedAppUserForCurrentUser = updates.appUsers.find((au) => au && au.user_id === currentUser.id);

        if (updatedAppUserForCurrentUser && hasCurrentUserRefreshImpact(currentUser, updatedAppUserForCurrentUser)) {
          isReloadingFromAppUserChange.current = true;
          setAppUsers(updates.appUsers);
          clearUserCache();
          invalidate('AppUser');
          const refreshedUser = await getEffectiveUser();

          if (refreshedUser) {
            invalidate('Store');
            invalidate('Patient');
            invalidate('Delivery');
            invalidate('User');
            setCurrentUser(refreshedUser);
            needsDataReload.current = true;
          }

          isReloadingFromAppUserChange.current = false;
          return;
        }
      }

      // Otherwise just merge appUsers
      setAppUsers((prev) => {
        const map = new Map((prev || []).map((u) => [u?.id, u]).filter(([id]) => !!id));
        updates.appUsers.forEach((u) => {
          if (u?.id) map.set(u.id, u);
        });
        return Array.from(map.values());
      });
    }
    
    // ─── MERGE USERS ──────────────────────────────────────────────
    if (updates.users && updates.users.length > 0) {
      setUsers((prev) => {
        const map = new Map((prev || []).map((u) => [u?.id, u]).filter(([id]) => !!id));
        updates.users.forEach((u) => {
          if (u?.id) map.set(u.id, u);
        });
        return Array.from(map.values());
      });
    }
  }, [
    isFormOverlayOpen,
    deliveries,
    patients,
    currentUser,
    isReloadingFromAppUserChange,
    hasCurrentUserRefreshImpact,
    setDeliveries,
    setPatients,
    setAppUsers,
    setUsers,
    clearUserCache,
    invalidate,
    getEffectiveUser,
    setCurrentUser,
    needsDataReload,
    mergePatients
  ]);
};