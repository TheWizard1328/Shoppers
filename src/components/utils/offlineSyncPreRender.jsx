import { offlineDB } from './offlineDatabase';

export const createOfflineSyncPreRenderHelpers = ({ fetchCitiesDedup, invalidateEntityCache }) => {
  const preRenderFreshSync = async (smartRefreshMgr = null, currentUser = null) => {
    try {
      console.log('🔄 [PreRenderSync] FORCING fresh AppUsers and Cities from API before map render...');
      console.log('🗑️ [PreRenderSync] CRITICAL: Clearing AppUser cache before location upload...');
      invalidateEntityCache('AppUser');

      if (currentUser) {
        const { base44 } = await import('@/api/base44Client');
        const { locationTracker } = await import('./locationTracker');
        const isTrackingLocation = locationTracker.isTracking && locationTracker.lastPosition;

        if (isTrackingLocation) {
          try {
            console.log('📤 [PreRenderSync] STEP 0: Uploading current driver location to API...');
            const lastPos = locationTracker.lastPosition;
            const nowISO = new Date().toISOString();
            const appUsersList = await base44.entities.AppUser.filter({ user_id: currentUser.id });
            const appUserId = appUsersList?.[0]?.id;

            if (appUserId) {
              await base44.entities.AppUser.update(appUserId, {
                current_latitude: lastPos.latitude,
                current_longitude: lastPos.longitude,
                location_updated_at: nowISO
              });
              console.log(`✅ [PreRenderSync] Uploaded driver location: ${lastPos.latitude.toFixed(6)}, ${lastPos.longitude.toFixed(6)}`);
            }
          } catch (uploadError) {
            console.warn('⚠️ [PreRenderSync] Failed to upload driver location:', uploadError.message);
          }
        }
      }

      if (smartRefreshMgr) {
        await smartRefreshMgr.waitForRateLimit();
      }

      console.log('📍 [PreRenderSync] STEP 1: Skipping AppUser API fetch (RLS-protected - using offline DB only)...');
      invalidateEntityCache('AppUser');

      const existingAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
      if (existingAppUsers && existingAppUsers.length > 0) {
        console.log(`✅ [PreRenderSync] Using ${existingAppUsers.length} AppUsers from offline DB (WebSocket subscriptions keep in sync)`);
        await offlineDB.updateSyncMetadata('AppUser', new Date().toISOString(), new Date().toISOString());
        if (smartRefreshMgr) smartRefreshMgr.recordSuccess();
      } else {
        console.warn('⚠️ [PreRenderSync] Offline DB has no AppUsers - will be populated by initial sync');
        if (smartRefreshMgr) smartRefreshMgr.recordError();
      }

      if (smartRefreshMgr) {
        await smartRefreshMgr.waitForRateLimit();
      }

      console.log('🏙️ [PreRenderSync] Fetching fresh Cities (deduplicated)...');
      const cities = await fetchCitiesDedup();
      if (cities && cities.length > 0) {
        await offlineDB.replaceAllRecords(offlineDB.STORES.CITIES, cities);
        invalidateEntityCache('City');
        await offlineDB.updateSyncMetadata('City', new Date().toISOString(), new Date().toISOString());
        console.log(`✅ [PreRenderSync] Synced ${cities.length} fresh Cities to offline DB`);
        if (smartRefreshMgr) smartRefreshMgr.recordSuccess();
      }

      invalidateEntityCache('AppUser');
      const freshAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
      const freshCities = await offlineDB.getAll(offlineDB.STORES.CITIES);

      console.log(`✅ [PreRenderSync] Ready for render: ${freshAppUsers?.length || 0} users, ${freshCities?.length || 0} cities`);
      return { success: true, appUsers: freshAppUsers, cities: freshCities };
    } catch (error) {
      console.error('❌ [PreRenderSync] Error:', error.message);
      if (smartRefreshMgr) smartRefreshMgr.recordError();
      return { success: false, appUsers: [], cities: [], error: error.message };
    }
  };

  return { preRenderFreshSync };
};