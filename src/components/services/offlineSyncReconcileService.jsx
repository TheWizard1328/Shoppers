export const createOfflineSyncReconcileService = ({
  offlineDB,
  Delivery,
  AppUser,
  fetchAppUsersDedup,
  invalidateEntityCache
}) => {
  const quickReconcile = async (selectedDateStr) => {
    const result = { deliveriesUpdated: false, appUsersUpdated: false };

    try {
      const offlineDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
      const offlineLatest = (offlineDeliveries || []).reduce((max, d) => {
        const t = d.updated_date ? new Date(d.updated_date).getTime() : 0;
        return t > max ? t : max;
      }, 0);

      const [serverSample] = await Delivery.filter({ delivery_date: selectedDateStr }, '-updated_date', 1);
      if (serverSample) {
        const serverLatest = new Date(serverSample.updated_date || 0).getTime();
        if (serverLatest > offlineLatest) {
          const freshDeliveries = await Delivery.filter({ delivery_date: selectedDateStr }, '-updated_date', 5000);
          if (freshDeliveries && freshDeliveries.length > 0) {
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
            invalidateEntityCache('Delivery');
            await offlineDB.updateSyncMetadata('Delivery', serverSample.updated_date, new Date().toISOString());
            result.deliveriesUpdated = true;
            result.freshDeliveries = freshDeliveries;
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('offlineDBReconciled', {
                detail: { entity: 'Delivery', date: selectedDateStr, count: freshDeliveries.length }
              }));
            }
          }
        }
      }
    } catch (e) {
      console.warn('⚠️ [QuickReconcile] Delivery check failed:', e.message);
    }

    try {
      const offlineAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
      const offlineLatest = (offlineAppUsers || []).reduce((max, u) => {
        const t = u.updated_date ? new Date(u.updated_date).getTime() : 0;
        return t > max ? t : max;
      }, 0);

      const [serverSampleUser] = await AppUser.filter({}, '-updated_date', 1);
      if (serverSampleUser) {
        const serverLatest = new Date(serverSampleUser.updated_date || 0).getTime();
        const isEmpty = !offlineAppUsers || offlineAppUsers.length === 0;
        if (serverLatest > offlineLatest || isEmpty) {
          const freshAppUsers = await fetchAppUsersDedup();
          if (freshAppUsers && freshAppUsers.length > 0) {
            const userMap = new Map();
            freshAppUsers.forEach((au) => {
              if (!au?.user_id) return;
              const ex = userMap.get(au.user_id);
              if (!ex) {
                userMap.set(au.user_id, au);
                return;
              }
              const newLoc = au.location_updated_at ? new Date(au.location_updated_at).getTime() : 0;
              const exLoc = ex.location_updated_at ? new Date(ex.location_updated_at).getTime() : 0;
              if (newLoc > exLoc) userMap.set(au.user_id, au);
            });
            const deduped = Array.from(userMap.values());
            await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, deduped);
            invalidateEntityCache('AppUser');
            await offlineDB.updateSyncMetadata('AppUser', new Date().toISOString(), new Date().toISOString());
            result.appUsersUpdated = true;
            result.freshAppUsers = deduped;
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('offlineDBReconciled', {
                detail: { entity: 'AppUser', count: deduped.length }
              }));
              const validDeduped = deduped.filter((u) => u?.user_id && u.user_id !== 'undefined' && u?.user_name && u.user_name !== 'undefined');
              if (validDeduped.length > 0) {
                window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
                  detail: { appUsers: validDeduped }
                }));
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn('⚠️ [QuickReconcile] AppUser check failed:', e.message);
    }

    return result;
  };

  return { quickReconcile };
};