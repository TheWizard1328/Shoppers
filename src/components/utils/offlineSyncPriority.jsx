import { offlineDB } from './offlineDatabase';
import { createOfflineSyncPreRenderHelpers } from './offlineSyncPreRender';

export const createOfflineSyncPriorityHelpers = ({
  AppUser,
  City,
  Store,
  Company,
  Delivery,
  Patient,
  format,
  BATCH_COOLDOWN,
  syncEntityWithTimestampCheck,
  restartDeliveryPatientSync,
  invalidateEntityCache,
  fetchAppUsersDedup,
  fetchDeliveriesDedup,
  fetchPatientsDedup,
  fetchCitiesDedup,
  notifySyncStatus
}) => {
  const { preRenderFreshSync } = createOfflineSyncPreRenderHelpers({
    fetchCitiesDedup,
    invalidateEntityCache
  });

  const performPrioritySyncBeforeRefresh = async (selectedDateStr, cityId = null, smartRefreshMgr = null, fetchAllDriversDeliveries = false) => {
    try {
      const allStores = await offlineDB.getAll(offlineDB.STORES.STORES);
      const cityStoreIds = cityId ? (allStores || []).filter((store) => store?.city_id === cityId).map((store) => store.id) : [];

      notifySyncStatus({ status: 'priority_sync', phase: 'appusers' });
      if (smartRefreshMgr) await smartRefreshMgr.waitForRateLimit();

      const timeSinceLastAppUserSync = Date.now() - (smartRefreshMgr?._lastAppUserSyncTime || 0);
      const shouldSkipAppUserSync = timeSinceLastAppUserSync < 10000;
      let allAppUsers = [];

      if (shouldSkipAppUserSync) {
        console.log('⏭️ [PrioritySyncBeforeRefresh] STEP 1: Skipping AppUser sync (synced recently)');
        allAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
      } else {
        console.log('👤 [PrioritySyncBeforeRefresh] STEP 1: Fetching ALL AppUsers (deduplicated)...');
        allAppUsers = await fetchAppUsersDedup();
        console.log(`👤 [PrioritySyncBeforeRefresh] Fetched ${allAppUsers?.length || 0} AppUsers (Mode: ${fetchAllDriversDeliveries ? 'ALL DRIVERS' : 'Individual'})`);

        if (allAppUsers && allAppUsers.length > 0) {
          const appUsersByUserId = new Map();
          allAppUsers.forEach((au) => {
            if (!au || !au.user_id) return;
            const existing = appUsersByUserId.get(au.user_id);
            if (!existing) {
              appUsersByUserId.set(au.user_id, au);
            } else {
              const newLocationTime = au.location_updated_at ? new Date(au.location_updated_at).getTime() : 0;
              const existingLocationTime = existing.location_updated_at ? new Date(existing.location_updated_at).getTime() : 0;
              const newUpdatedTime = au.updated_date ? new Date(au.updated_date).getTime() : 0;
              const existingUpdatedTime = existing.updated_date ? new Date(existing.updated_date).getTime() : 0;

              if (newLocationTime > existingLocationTime || (newLocationTime === existingLocationTime && newUpdatedTime > existingUpdatedTime)) {
                appUsersByUserId.set(au.user_id, au);
              }
            }
          });

          const deduplicatedAppUsers = Array.from(appUsersByUserId.values());
          await offlineDB.replaceAllRecords(offlineDB.STORES.APP_USERS, deduplicatedAppUsers);
          invalidateEntityCache('AppUser');
          await offlineDB.updateSyncMetadata('AppUser', new Date().toISOString(), new Date().toISOString());
          if (smartRefreshMgr) {
            smartRefreshMgr.recordSuccess();
            smartRefreshMgr._lastAppUserSyncTime = Date.now();
          }
          allAppUsers = deduplicatedAppUsers;
        }
      }

      await new Promise((r) => setTimeout(r, 2500));
      notifySyncStatus({ status: 'priority_sync', phase: 'deliveries' });
      if (smartRefreshMgr) await smartRefreshMgr.waitForRateLimit();

      const deliveryFilter = cityStoreIds.length > 0 ? { store_id: { $in: cityStoreIds } } : {};
      const deliveries = await fetchDeliveriesDedup(selectedDateStr, deliveryFilter);
      if (deliveries && deliveries.length > 0) {
        await offlineDB.replaceRecordsByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', selectedDateStr, deliveries);
        invalidateEntityCache('Delivery');
        await offlineDB.updateSyncMetadata('Delivery', new Date().toISOString(), new Date().toISOString());
        if (smartRefreshMgr) smartRefreshMgr.recordSuccess();
      }

      await new Promise((r) => setTimeout(r, 3000));
      notifySyncStatus({ status: 'priority_sync', phase: 'patients' });

      const patientIds = new Set((deliveries || []).filter((d) => d && d.patient_id).map((d) => d.patient_id));
      let patients = [];
      if (patientIds.size > 0) {
        const patientIdList = Array.from(patientIds);
        const patientBatchSize = 50;

        for (let i = 0; i < patientIdList.length; i += patientBatchSize) {
          if (smartRefreshMgr) await smartRefreshMgr.waitForRateLimit();
          const batchIds = patientIdList.slice(i, i + patientBatchSize);
          const batchPatients = await fetchPatientsDedup({ id: { $in: batchIds } });
          if (batchPatients && batchPatients.length > 0) {
            await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, batchPatients);
            invalidateEntityCache('Patient');
            patients = [...patients, ...batchPatients];
            if (smartRefreshMgr) smartRefreshMgr.recordSuccess();
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      patients = patients.filter((p) => p && p.id && !p.id.startsWith('temp_'));
      await offlineDB.updateSyncMetadata('Patient', new Date().toISOString(), new Date().toISOString());

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('offlineSyncProgress', {
          detail: { entity: 'Patient', count: patients.length }
        }));
      }

      notifySyncStatus({ status: 'priority_sync_complete', appUsers: allAppUsers?.length || 0, deliveries: deliveries?.length || 0, patients: patients.length });
      return { success: true, appUsers: allAppUsers?.length || 0, deliveries: deliveries?.length || 0, patients: patients.length };
    } catch (error) {
      if (smartRefreshMgr) smartRefreshMgr.recordError();
      notifySyncStatus({ status: 'priority_sync_error', error: error.message });
      return { error: error.message };
    }
  };

  const loadPriorityData = async (selectedDateStr, filters = {}, syncState) => {
    if (syncState.getSyncInProgress()) return { skipped: true, reason: 'sync_in_progress' };

    syncState.setSyncInProgress(true);
    notifySyncStatus({ status: 'loading_priority', date: selectedDateStr });

    try {
      const [existingAppUsers, existingPatients, existingDeliveries, existingCities] = await Promise.all([
        offlineDB.getAll(offlineDB.STORES.APP_USERS),
        offlineDB.getAll(offlineDB.STORES.PATIENTS),
        offlineDB.getAll(offlineDB.STORES.DELIVERIES),
        offlineDB.getAll(offlineDB.STORES.CITIES)
      ]);

      const isUnderPopulated = !existingAppUsers || existingAppUsers.length === 0 || !existingCities || existingCities.length === 0;
      console.log(`📊 [LoadPriorityData] DB Status: Users=${existingAppUsers?.length || 0}, Cities=${existingCities?.length || 0}, Patients=${existingPatients?.length || 0}, Deliveries=${existingDeliveries?.length || 0}, ForceSync=${isUnderPopulated}`);

      if (isUnderPopulated) {
        console.warn('⚠️ [LoadPriorityData] Offline DB underpopulated, initiating comprehensive restore...');
        const restoreResult = await restartDeliveryPatientSync();
        if (!restoreResult.error) return restoreResult;
      }

      await syncEntityWithTimestampCheck('AppUser', AppUser, {}, {});
      invalidateEntityCache('AppUser');
      const appUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);

      await new Promise((r) => setTimeout(r, BATCH_COOLDOWN));

      await syncEntityWithTimestampCheck('City', City, {}, {});
      invalidateEntityCache('City');
      const cities = await offlineDB.getAll(offlineDB.STORES.CITIES);

      if (!cities || cities.length === 0) {
        const citiesFromAPI = await City.list();
        if (citiesFromAPI?.length) {
          await offlineDB.replaceAllRecords(offlineDB.STORES.CITIES, citiesFromAPI);
          invalidateEntityCache('City');
        }
      }

      await new Promise((r) => setTimeout(r, BATCH_COOLDOWN));

      await syncEntityWithTimestampCheck('Store', Store, {}, {});
      invalidateEntityCache('Store');
      let stores = await offlineDB.getAll(offlineDB.STORES.STORES);
      if (!stores || stores.length === 0) {
        const storesFromAPI = await Store.list();
        if (storesFromAPI?.length) {
          await offlineDB.replaceAllRecords(offlineDB.STORES.STORES, storesFromAPI);
          invalidateEntityCache('Store');
          stores = storesFromAPI;
        }
      }

      await new Promise((r) => setTimeout(r, BATCH_COOLDOWN));

      await syncEntityWithTimestampCheck('Company', Company, {}, {});
      invalidateEntityCache('Company');
      let companies = await offlineDB.getAll(offlineDB.STORES.COMPANIES);
      if (!companies || companies.length === 0) {
        const companiesFromAPI = await Company.list();
        if (companiesFromAPI?.length) {
          await offlineDB.replaceAllRecords(offlineDB.STORES.COMPANIES, companiesFromAPI);
          invalidateEntityCache('Company');
          companies = companiesFromAPI;
        }
      }

      await new Promise((r) => setTimeout(r, 3000));

      let patients = [];
      const cityStoreIds = filters?.city_id ? (stores || []).filter((store) => store?.city_id === filters.city_id).map((store) => store.id) : [];
      const deliveryFilter = {
        delivery_date: selectedDateStr,
        ...(cityStoreIds.length > 0 ? { store_id: { $in: cityStoreIds } } : {}),
        ...Object.fromEntries(Object.entries(filters || {}).filter(([key]) => key !== 'city_id'))
      };

      const deliveries = await Delivery.filter(deliveryFilter);
      if (deliveries && deliveries.length > 0) {
        await offlineDB.replaceRecordsByIndex(offlineDB.STORES.DELIVERIES, 'delivery_date', selectedDateStr, deliveries);
        invalidateEntityCache('Delivery');

        const patientIds = new Set(deliveries.filter((d) => d && d.patient_id).map((d) => d.patient_id));
        if (patientIds.size > 0) {
          const patientIdList = Array.from(patientIds);
          const batchSize = 50;
          for (let i = 0; i < patientIdList.length; i += batchSize) {
            const batchIds = patientIdList.slice(i, i + batchSize);
            const batchPatients = await Patient.filter({ id: { $in: batchIds } });
            if (batchPatients?.length) {
              await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, batchPatients);
              invalidateEntityCache('Patient');
              patients = [...patients, ...batchPatients];
            }
            await new Promise((r) => setTimeout(r, 200));
          }
        }

        await offlineDB.updateSyncStatus('Patient', { recordCount: patients.length, status: 'synced', lastSync: new Date().toISOString() });
      }

      const [finalAppUsers, finalCities, finalStores, finalCompanies, finalPatients, finalDeliveries] = await Promise.all([
        offlineDB.getAll(offlineDB.STORES.APP_USERS),
        offlineDB.getAll(offlineDB.STORES.CITIES),
        offlineDB.getAll(offlineDB.STORES.STORES),
        offlineDB.getAll(offlineDB.STORES.COMPANIES),
        offlineDB.getAll(offlineDB.STORES.PATIENTS),
        offlineDB.getAll(offlineDB.STORES.DELIVERIES)
      ]);

      await Promise.all([
        offlineDB.updateSyncStatus('City', { recordCount: finalCities?.length || 0, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
        offlineDB.updateSyncStatus('Store', { recordCount: finalStores?.length || 0, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
        offlineDB.updateSyncStatus('Company', { recordCount: finalCompanies?.length || 0, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
        offlineDB.updateSyncStatus('AppUser', { recordCount: finalAppUsers?.length || 0, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
        offlineDB.updateSyncStatus('Delivery', { recordCount: finalDeliveries?.length || 0, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() }),
        offlineDB.updateSyncStatus('Patient', { recordCount: finalPatients?.length || 0, status: 'synced', lastSync: new Date().toISOString(), lastFullSync: new Date().toISOString() })
      ]);

      notifySyncStatus({ status: 'priority_loaded', cities: finalCities?.length, stores: finalStores?.length, companies: finalCompanies?.length, appUsers: finalAppUsers?.length, deliveries: finalDeliveries?.length, patients: finalPatients?.length });

      return {
        cities: finalCities || cities,
        stores: finalStores || stores,
        companies: finalCompanies || companies || [],
        appUsers: finalAppUsers || appUsers,
        deliveries: finalDeliveries || deliveries,
        patients: finalPatients?.filter((p) => p && p.id && !p.id.startsWith('temp_')) || patients
      };
    } catch (error) {
      notifySyncStatus({ status: 'error', error: error.message });
      return { error: error.message };
    } finally {
      syncState.setSyncInProgress(false);
    }
  };

  return {
    preRenderFreshSync,
    performPrioritySyncBeforeRefresh,
    loadPriorityData
  };
};