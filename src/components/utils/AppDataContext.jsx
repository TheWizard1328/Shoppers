import { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { smartRefreshManager } from './smartRefreshManager';
import { base44 } from '@/api/base44Client';
import { shouldRefreshUserFromAppUser } from './appUserRefreshUtils';
import { cityFilteredRealtimeSync } from './cityFilteredRealtimeSync';
import { subscribeToRealtime } from './realtimeSync';
import { ensurePolylineSubscription } from './hereRouting';
import ImmediateNextDeliveryController from './ImmediateNextDeliveryController';

const AppDataContext = createContext(null);

export const AppDataProvider = ({ children, value }) => {
  // Track last WS delivery update time to prevent stale reconcile from overwriting
  const lastDeliveryWsUpdateRef = useRef(0);
  // Keep refs to mutable values so the subscription closure always has the latest
  // without needing to re-subscribe on every render
  const updateDeliveriesLocallyRef = useRef(value.updateDeliveriesLocally);
  const updateAppUsersLocallyRef = useRef(value.updateAppUsersLocally);
  const applyDeliveryChangesLocallyRef = useRef(value.applyDeliveryChangesLocally);
  const applyAppUserChangesLocallyRef = useRef(value.applyAppUserChangesLocally);
  const applyPatientChangesLocallyRef = useRef(value.applyPatientChangesLocally);
  const deliveriesRef = useRef(value.deliveries);
  const appUsersRef = useRef(value.appUsers);
  const patientsRef = useRef(value.patients);
  
  // Track boot sync per city/date and syncing banner state
  const bootKeyRef = useRef('');
  const [isProgressiveSyncing, setIsProgressiveSyncing] = useState(false);
  const realtimeBatchRef = useRef({
    deliveries: { upserts: new Map(), deletes: new Set() },
    appUsers: { upserts: new Map(), deletes: new Set() },
    patients: { upserts: new Map(), deletes: new Set() }
  });
  const realtimeBatchTimerRef = useRef(null);

  const flushRealtimeBatch = useCallback(async () => {
    const batch = realtimeBatchRef.current;
    const deliveryUpserts = Array.from(batch.deliveries.upserts.values());
    const deliveryDeletes = Array.from(batch.deliveries.deletes.values());
    const appUserUpserts = Array.from(batch.appUsers.upserts.values());
    const appUserDeletes = Array.from(batch.appUsers.deletes.values());
    const patientUpserts = Array.from(batch.patients.upserts.values());
    const patientDeletes = Array.from(batch.patients.deletes.values());

    if (!deliveryUpserts.length && !deliveryDeletes.length && !appUserUpserts.length && !appUserDeletes.length && !patientUpserts.length && !patientDeletes.length) {
      return;
    }

    realtimeBatchRef.current = {
      deliveries: { upserts: new Map(), deletes: new Set() },
      appUsers: { upserts: new Map(), deletes: new Set() },
      patients: { upserts: new Map(), deletes: new Set() }
    };

    const deliveryChanged = deliveryUpserts.length > 0 || deliveryDeletes.length > 0;
    const appUsersChanged = appUserUpserts.length > 0 || appUserDeletes.length > 0;
    const patientsChanged = patientUpserts.length > 0 || patientDeletes.length > 0;

    let nextDeliveries = deliveriesRef.current || [];
    let nextAppUsers = appUsersRef.current || [];
    let nextPatients = patientsRef.current || [];

    try {
      const { offlineDB } = await import('./offlineDatabase');
      await Promise.all([
        deliveryUpserts.length ? offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveryUpserts) : Promise.resolve(),
        appUserUpserts.length ? offlineDB.bulkSave(offlineDB.STORES.APP_USERS, appUserUpserts) : Promise.resolve(),
        patientUpserts.length ? offlineDB.bulkSave(offlineDB.STORES.PATIENTS, patientUpserts) : Promise.resolve(),
        ...deliveryDeletes.map((id) => offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, id).catch(() => null)),
        ...appUserDeletes.map((id) => offlineDB.deleteRecord(offlineDB.STORES.APP_USERS, id).catch(() => null)),
        ...patientDeletes.map((id) => offlineDB.deleteRecord(offlineDB.STORES.PATIENTS, id).catch(() => null))
      ]);

      if (deliveryChanged) {
        const selectedDate = value.selectedDate || (typeof window !== 'undefined' ? window.__appSelectedDate : null) || localStorage.getItem('global_selected_date');
        const offlineDeliveries = selectedDate
          ? await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDate)
          : await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
        const nonSelectedDateDeliveries = (deliveriesRef.current || []).filter((item) => item?.delivery_date !== selectedDate);
        nextDeliveries = Array.isArray(offlineDeliveries)
          ? [...nonSelectedDateDeliveries, ...offlineDeliveries]
          : nonSelectedDateDeliveries;
      }

      if (patientsChanged) {
        const offlinePatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
        nextPatients = Array.isArray(offlinePatients) ? offlinePatients : [];
      }

      if (appUsersChanged) {
        const offlineAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
        nextAppUsers = Array.isArray(offlineAppUsers) ? offlineAppUsers : [];
      }
    } catch (error) {
      console.warn('[AppDataContext] Realtime offline sync batch failed:', error.message);
    }

    if (deliveryChanged && !nextDeliveries.length && deliveriesRef.current?.length) {
      const byId = new Map(deliveriesRef.current.filter(Boolean).map((item) => [item?.id, item]).filter(([id]) => !!id));
      deliveryDeletes.forEach((id) => byId.delete(id));
      deliveryUpserts.forEach((item) => {
        if (item?.id) byId.set(item.id, item);
      });
      nextDeliveries = Array.from(byId.values());
    }

    if (appUsersChanged && !nextAppUsers.length && appUsersRef.current?.length) {
      const ts = (item) => {
        const value = item?.location_updated_at || item?.updated_date || item?.created_date;
        return value ? new Date(value).getTime() : 0;
      };

      const byId = new Map(
        appUsersRef.current
          .filter((item) => item?.id && !appUserDeletes.includes(item.id))
          .map((item) => [item.id, item])
      );

      appUserUpserts.forEach((item) => {
        if (!item?.id) return;
        const current = byId.get(item.id);
        if (!current || ts(item) >= ts(current)) {
          byId.set(item.id, item);
        }
      });

      nextAppUsers = Array.from(byId.values());
    }

    if (patientsChanged && !nextPatients.length && patientsRef.current?.length) {
      const byId = new Map(patientsRef.current.filter(Boolean).map((item) => [item?.id, item]).filter(([id]) => !!id));
      patientDeletes.forEach((id) => byId.delete(id));
      patientUpserts.forEach((item) => {
        if (item?.id) byId.set(item.id, item);
      });
      nextPatients = Array.from(byId.values());
    }

    if (deliveryChanged) {
      const dedupedDeliveries = Array.from(new Map((nextDeliveries || []).filter(Boolean).map((item) => [item.id, item])).values());
      if (applyDeliveryChangesLocallyRef.current) {
        applyDeliveryChangesLocallyRef.current({ upserts: deliveryUpserts, deleteIds: deliveryDeletes });
      } else if (updateDeliveriesLocallyRef.current) {
        updateDeliveriesLocallyRef.current(dedupedDeliveries, false);
      }

      if (typeof window !== 'undefined') {
        const realtimeDate = deliveryUpserts[0]?.delivery_date || nextDeliveries[0]?.delivery_date;
        const selectedDateDeliveries = realtimeDate
          ? nextDeliveries.filter((item) => item?.delivery_date === realtimeDate)
          : nextDeliveries;

        window.dispatchEvent(new CustomEvent('deliveryUpdated', {
          detail: {
            delivery: deliveryUpserts.length === 1 ? deliveryUpserts[0] : null,
            deliveries: selectedDateDeliveries,
            deletedIds: deliveryDeletes,
            deletedId: deliveryDeletes.length === 1 ? deliveryDeletes[0] : undefined,
            type: deliveryDeletes.length > 0 && deliveryUpserts.length === 0 ? 'delete' : 'update',
            source: 'realtime_sync',
            fromRealtime: true,
            fullReplacement: false,
            preserveLocalState: true
          }
        }));
      }
    }

    if (appUsersChanged) {
      if (updateAppUsersLocallyRef.current) {
        updateAppUsersLocallyRef.current(nextAppUsers, true);
      } else if (applyAppUserChangesLocallyRef.current) {
        applyAppUserChangesLocallyRef.current({ upserts: nextAppUsers, deleteIds: [] });
      }
    }

    if (patientsChanged) {
      if (value.updatePatientsLocally) {
        value.updatePatientsLocally({ upserts: nextPatients, deleteIds: [] });
      } else if (applyPatientChangesLocallyRef.current) {
        applyPatientChangesLocallyRef.current({ upserts: nextPatients, deleteIds: [] });
      }

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('patientsUpdated', {
          detail: {
            patients: nextPatients,
            deletedIds: patientDeletes,
            deletedId: patientDeletes.length === 1 ? patientDeletes[0] : undefined,
            fromRealtime: true,
            fullReplacement: true
          }
        }));
      }
    }

    if (deliveryChanged) {
      lastDeliveryWsUpdateRef.current = Date.now();
      smartRefreshManager.notifyRealtimeDeliveryUpdate && smartRefreshManager.notifyRealtimeDeliveryUpdate();
    }

    if (appUsersChanged) {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
          detail: { appUsers: nextAppUsers, singleUpdate: appUserUpserts.length === 1, fromRealtime: true, fullReplacement: true }
        }));

        if (appUserUpserts.length === 1) {
          window.dispatchEvent(new CustomEvent('appUserUpdated', {
            detail: { appUser: appUserUpserts[0], appUsers: nextAppUsers, fromRealtime: true, fullReplacement: true }
          }));
        } else if (appUserUpserts.length > 1) {
          window.dispatchEvent(new CustomEvent('appUsersUpdated', {
            detail: { appUsers: nextAppUsers, fromRealtime: true, fullReplacement: true }
          }));
        }
      }

      const currentUserUpdate = appUserUpserts.find((item) => item?.user_id === value.currentUser?.id);
      const previousCurrentUserAppUser = currentUserUpdate
        ? (appUsersRef.current || []).find((item) => item?.id === currentUserUpdate.id || item?.user_id === currentUserUpdate.user_id)
        : null;
      const deletedCurrentUser = appUserDeletes.some((id) => (
        appUsersRef.current || []
      ).some((item) => item?.id === id && item?.user_id === value.currentUser?.id));

      if ((currentUserUpdate && shouldRefreshUserFromAppUser(previousCurrentUserAppUser, currentUserUpdate)) || deletedCurrentUser) {
        value.refreshUser?.();
      }

      smartRefreshManager.notifyRealtimeUpdate('AppUser');
    }

    if (patientsChanged) {
      smartRefreshManager.notifyRealtimeUpdate('Patient');
    }
  }, [value.currentUser?.id, value.refreshUser, value.updatePatientsLocally]);

  const scheduleRealtimeEntityUpdate = useCallback((entityType, eventType, data) => {
    const entityBatch = entityType === 'Delivery'
      ? realtimeBatchRef.current.deliveries
      : entityType === 'Patient'
        ? realtimeBatchRef.current.patients
        : realtimeBatchRef.current.appUsers;

    const recordId = typeof data === 'string' ? data : data?.id;
    if (!recordId) return;

    if (eventType === 'delete') {
      entityBatch.upserts.delete(recordId);
      entityBatch.deletes.add(recordId);
    } else {
      entityBatch.deletes.delete(recordId);
      entityBatch.upserts.set(recordId, data);
    }

    if (realtimeBatchTimerRef.current) {
      clearTimeout(realtimeBatchTimerRef.current);
    }

    realtimeBatchTimerRef.current = setTimeout(() => {
      realtimeBatchTimerRef.current = null;
      flushRealtimeBatch();
    }, 120);
  }, [flushRealtimeBatch]);

  // Keep refs in sync with latest values
  useEffect(() => { updateDeliveriesLocallyRef.current = value.updateDeliveriesLocally; }, [value.updateDeliveriesLocally]);
  useEffect(() => { updateAppUsersLocallyRef.current = value.updateAppUsersLocally; }, [value.updateAppUsersLocally]);
  useEffect(() => { applyDeliveryChangesLocallyRef.current = value.applyDeliveryChangesLocally; }, [value.applyDeliveryChangesLocally]);
  useEffect(() => { applyAppUserChangesLocallyRef.current = value.applyAppUserChangesLocally; }, [value.applyAppUserChangesLocally]);
  useEffect(() => { applyPatientChangesLocallyRef.current = value.applyPatientChangesLocally; }, [value.applyPatientChangesLocally]);
  useEffect(() => { deliveriesRef.current = value.deliveries; }, [value.deliveries]);
  useEffect(() => { appUsersRef.current = value.appUsers; }, [value.appUsers]);
  useEffect(() => { patientsRef.current = value.patients; }, [value.patients]);

  useEffect(() => {
    if (!value.currentUser) return;
    ensurePolylineSubscription();
  }, [value.currentUser?.id]);

  // CRITICAL: Set up city-filtered real-time subscriptions
  useEffect(() => {
    const resolveFilters = () => ({
      selectedCityId: value.selectedCityId || (typeof window !== 'undefined' ? window.__appSelectedCityId : null) || localStorage.getItem('global_selected_city_id'),
      selectedDate: value.selectedDate || (typeof window !== 'undefined' ? window.__appSelectedDate : null) || localStorage.getItem('global_selected_date')
    });

    const { selectedCityId, selectedDate } = resolveFilters();

    if (!value.currentUser || !selectedCityId || !selectedDate) {
      return;
    }
    
    // Start real-time subscriptions
    cityFilteredRealtimeSync.start(selectedCityId, selectedDate);

    const handleRealtimeEvent = ({ entityType, entity, eventType, type, data, id }) => {
      const resolvedEntityType = entityType || entity;
      const resolvedEventType = eventType || type;
      const payload = resolvedEventType === 'delete'
        ? (typeof data === 'string' ? data : data?.id || id)
        : data;

      if (resolvedEntityType === 'Delivery') {
        scheduleRealtimeEntityUpdate('Delivery', resolvedEventType, payload);
        return;
      }

      if (resolvedEntityType === 'Patient') {
        scheduleRealtimeEntityUpdate('Patient', resolvedEventType, payload);
        return;
      }

      if (resolvedEntityType === 'AppUser') {
        scheduleRealtimeEntityUpdate('AppUser', resolvedEventType, payload);
      }
    };

    // Subscribe to both city-filtered websocket events and global local broadcasts
    const unsubscribe = cityFilteredRealtimeSync.subscribe(handleRealtimeEvent);
    const unsubscribeGlobalRealtime = subscribeToRealtime(handleRealtimeEvent);

    const handleFiltersChanged = () => {
      const { selectedCityId: nextCityId, selectedDate: nextDate } = resolveFilters();
      if (!nextCityId || !nextDate) return;
      cityFilteredRealtimeSync.updateFilters(nextCityId, nextDate);
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('globalFiltersChanged', handleFiltersChanged);
      window.addEventListener('storage', handleFiltersChanged);
    }

    return () => {
      unsubscribe();
      unsubscribeGlobalRealtime();
      cityFilteredRealtimeSync.stop();
      if (typeof window !== 'undefined') {
        window.removeEventListener('globalFiltersChanged', handleFiltersChanged);
        window.removeEventListener('storage', handleFiltersChanged);
      }
      if (realtimeBatchTimerRef.current) {
        clearTimeout(realtimeBatchTimerRef.current);
        realtimeBatchTimerRef.current = null;
      }
      flushRealtimeBatch();
    };
  // CRITICAL: Only re-subscribe when user/city/date changes - NOT on every delivery/appUser update
  // Using refs above ensures callbacks always see latest data without triggering re-subscriptions
  }, [value.currentUser?.id, value.selectedCityId, value.selectedDate]);
  
  // Offline-first boot for selected date/city
  useEffect(() => {
    const selectedDate = value.selectedDate;
    const selectedCityId = value.selectedCityId;
    if (!value.currentUser || !selectedDate) return;

    const key = `${selectedCityId || 'all'}|${selectedDate}`;
    // Avoid rerunning for the same key during this session
    if (bootKeyRef.current === key) return;
    bootKeyRef.current = key;

    let cancelled = false;
    (async () => {
      try {
        setIsProgressiveSyncing(true);
        const { offlineDB } = await import('./offlineDatabase');
        const deliveryScopeKey = `date:${selectedDate}`;

        // 1) Load OFFLINE first in parallel
        const [offlineDeliveries, offlineAppUsers, deliveryCache, appUsersCache] = await Promise.all([
          offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDate),
          offlineDB.getAll(offlineDB.STORES.APP_USERS).catch(() => []),
          offlineDB.getCacheValidation('Delivery', {
            scopeKey: deliveryScopeKey,
            maxAgeMs: selectedDate === new Date().toISOString().split('T')[0] ? 60 * 1000 : 10 * 60 * 1000,
            allowEmpty: true
          }),
          offlineDB.getCacheValidation('AppUser', {
            scopeKey: 'global',
            maxAgeMs: 10 * 60 * 1000,
            minRecordCount: 1
          })
        ]);

        if (cancelled) return;

        if (Array.isArray(offlineDeliveries) && offlineDeliveries.length > 0 && value.updateDeliveriesLocally) {
          value.updateDeliveriesLocally(offlineDeliveries, false);
        }

        if (Array.isArray(offlineAppUsers) && offlineAppUsers.length > 0) {
          await wrappedUpdateAppUsersLocally(offlineAppUsers, false);
        }

        const shouldFetchDeliveries = !deliveryCache.isValid;
        const shouldFetchAppUsers = !appUsersCache.isValid;

        if (shouldFetchDeliveries || shouldFetchAppUsers) {
          const [onlineDeliveries, onlineAppUsers] = await Promise.all([
            shouldFetchDeliveries ? base44.entities.Delivery.filter({ delivery_date: selectedDate }).catch(() => []) : Promise.resolve(null),
            shouldFetchAppUsers ? base44.entities.AppUser.list().catch(() => []) : Promise.resolve(null)
          ]);

          if (cancelled) return;

          if (onlineDeliveries !== null) {
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, onlineDeliveries || []);
            await offlineDB.updateCacheSnapshot('Delivery', onlineDeliveries || [], {
              scopeKey: deliveryScopeKey,
              syncType: 'startup_full'
            });

            value.updateDeliveriesLocally(onlineDeliveries || [], false);
          }

          if (onlineAppUsers !== null) {
            await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, onlineAppUsers || []);
            await offlineDB.updateCacheSnapshot('AppUser', onlineAppUsers || [], {
              scopeKey: 'global',
              syncType: 'startup_full'
            });
            await wrappedUpdateAppUsersLocally(onlineAppUsers || [], false);
          }
        }
      } catch (e) {
        console.warn('Offline-first boot failed (continuing):', e);
      } finally {
        if (!cancelled) setIsProgressiveSyncing(false);
      }
    })();

    return () => { cancelled = true; };
  // Only react to these keys
  }, [value.currentUser?.id, value.selectedCityId, value.selectedDate]);
  
  // Wrap updateDeliveriesLocally to register pending updates with driver/date context
  const wrappedUpdateDeliveriesLocally = (updates, isFullReplacement = false) => {
    if (value.updateDeliveriesLocally) {
      // CRITICAL: Only register pending updates when NOT doing full replacement
      if (!isFullReplacement && Array.isArray(updates)) {
        updates.forEach(update => {
          if (update && update.id) {
            const driverId = update.driver_id || '';
            const deliveryDate = update.delivery_date || '';
            smartRefreshManager.registerPendingUpdate(update.id, driverId, deliveryDate);
          }
        });
      }
      
      // Call the original function with isFullReplacement flag
      value.updateDeliveriesLocally(updates, isFullReplacement);
    }
  };
  
  // CRITICAL: Direct data refresh for a specific driver and date (bypasses isEntityUpdating flag)
  const forceRefreshDriverDeliveries = async (driverId, deliveryDate) => {
    console.log(`🔄 [Force Refresh] Loading deliveries for driver ${driverId} on ${deliveryDate}...`);
    
    try {
      // CRITICAL: Try offline DB FIRST to prevent rate limits
      const { offlineDB } = await import('./offlineDatabase');
      let freshDeliveriesForDriver = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, deliveryDate);
      
      if (freshDeliveriesForDriver && freshDeliveriesForDriver.length > 0) {
        // Filter to specific driver from offline data
        freshDeliveriesForDriver = freshDeliveriesForDriver.filter(d => d.driver_id === driverId);
        console.log(`✅ [Force Refresh] Got ${freshDeliveriesForDriver.length} deliveries from offline DB`);
      } else {
        // Fallback to API only if offline DB is empty
        console.log('📥 [Force Refresh] Offline DB empty - fetching from API');
        freshDeliveriesForDriver = await base44.entities.Delivery.filter({
          driver_id: driverId,
          delivery_date: deliveryDate
        });
        
        // CRITICAL: Always save to offline DB immediately after API fetch
        if (freshDeliveriesForDriver && freshDeliveriesForDriver.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveriesForDriver);
          console.log(`💾 [Force Refresh] Saved ${freshDeliveriesForDriver.length} deliveries to offline DB`);
        }
      }
      
      // CRITICAL: Clear ALL pending updates for this driver/route FIRST
      smartRefreshManager.clearPendingUpdatesForDriver(driverId, deliveryDate);
      
      // Construct the new overall deliveries array
      const otherDeliveries = (value.deliveries || []).filter(d => 
        d && (d.delivery_date !== deliveryDate || d.driver_id !== driverId)
      );
      const mergedDeliveries = [...otherDeliveries, ...freshDeliveriesForDriver].filter(Boolean);
      
      if (value.applyDeliveryChangesLocally) {
        value.applyDeliveryChangesLocally({ upserts: freshDeliveriesForDriver, deleteIds: [] });
        console.log(`✅ [Force Refresh] Updated context with merge-safe deliveries for driver ${driverId}`);
      } else if (value.updateDeliveriesLocally) {
        value.updateDeliveriesLocally(freshDeliveriesForDriver, false);
        console.log(`✅ [Force Refresh] Updated context with merge-safe deliveries for driver ${driverId}`);
      }
      
      return freshDeliveriesForDriver;
    } catch (error) {
      console.error('❌ [Force Refresh] Failed to load deliveries:', error);
      throw error;
    }
  };
  
  // Merge-safe AppUsers updater: prefers newer location_updated_at to prevent stale offline overwrites
  const wrappedUpdateAppUsersLocally = async (incoming, isFullReplacement = false) => {
    const incomingList = Array.isArray(incoming) ? incoming.filter(Boolean) : [];
    const existing = appUsersRef.current || [];

    // Build map of existing by id
    const byId = new Map(existing.map(u => [u?.id, u]).filter(([id]) => !!id));

    const ts = (u) => {
      const t = u?.location_updated_at || u?.updated_date || u?.created_date;
      return t ? new Date(t).getTime() : 0;
    };

    const acceptedForOffline = [];

    // Merge incoming into map using last-write-wins on timestamp
    for (const u of incomingList) {
      if (!u || !u.id) continue;
      const cur = byId.get(u.id);
      if (!cur) {
        byId.set(u.id, u);
        acceptedForOffline.push(u);
      } else {
        const newer = ts(u) >= ts(cur) ? u : cur;
        byId.set(u.id, newer);
        if (newer === u) acceptedForOffline.push(u);
      }
    }

    // If full replacement requested, include any incoming-only ids already handled above.
    const merged = Array.from(byId.values());

    if (value.updateAppUsersLocally) {
      // Always commit merged snapshot to prevent regressions
      value.updateAppUsersLocally(merged, true);
    }

    // Dual-write: persist fresher incoming records to offline DB
    if (acceptedForOffline.length > 0) {
      try {
        const { offlineDB } = await import('./offlineDatabase');
        await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, acceptedForOffline);
      } catch (e) {
        console.warn('[AppDataContext] Failed to persist AppUsers to offline DB:', e.message);
      }
    }
  };
  
  // NEW: Ensure patients for selected date/city are synced locally (Pull to Sync + dashboard refresh)
  const patientSyncStateRef = useRef({ key: '', inProgress: false, lastRunAt: 0 });

  const ensurePatientsForSelectedDate = useCallback(async () => {
    try {
      const selectedDate = value.selectedDate;
      const selectedCityId = value.selectedCityId;
      if (!selectedDate || !selectedCityId) return;

      const key = `${selectedCityId}|${selectedDate}`;
      const now = Date.now();
      if (patientSyncStateRef.current.inProgress) return;
      if (patientSyncStateRef.current.key === key && now - patientSyncStateRef.current.lastRunAt < 15000) return;

      patientSyncStateRef.current = { key, inProgress: true, lastRunAt: now };

      const { offlineDB } = await import('./offlineDatabase');

      // Load stores for selected city (offline first, then API fallback)
      let cityStores = await offlineDB.getByIndex(offlineDB.STORES.STORES, 'city_id', selectedCityId);
      if (!cityStores || cityStores.length === 0) {
        cityStores = await base44.entities.Store.filter({ city_id: selectedCityId });
        if (cityStores?.length) await offlineDB.bulkSave(offlineDB.STORES.STORES, cityStores);
      }
      const storeIds = new Set((cityStores || []).map(s => s.id));

      // Get deliveries for selected date (prefer in-memory, else offline)
      let deliveriesForDate = (deliveriesRef.current || []).filter(d => d?.delivery_date === selectedDate);
      if (!deliveriesForDate || deliveriesForDate.length === 0) {
        deliveriesForDate = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDate);
      }

      // Patient IDs needed for stops whose store is in the selected city
      const patientIdsNeeded = Array.from(new Set(
        (deliveriesForDate || [])
          .filter(d => d?.patient_id && storeIds.has(d?.store_id))
          .map(d => d.patient_id)
      ));

      if (patientIdsNeeded.length === 0) {
        patientSyncStateRef.current.inProgress = false;
        return;
      }

      // Always refresh the patients needed for the selected date so coordinate edits sync too
      const fetched = [];
      const BATCH = 10;
      for (let i = 0; i < patientIdsNeeded.length; i += BATCH) {
        const chunk = patientIdsNeeded.slice(i, i + BATCH);
        const chunkResults = await Promise.all(
          chunk.map(async (pid) => {
            const res = await base44.entities.Patient.filter({ id: pid });
            return Array.isArray(res) && res.length > 0 ? res[0] : null;
          })
        );
        fetched.push(...chunkResults.filter(Boolean));
      }

      if (fetched.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, fetched);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('patientsUpdated', {
            detail: { count: fetched.length, selectedDate, selectedCityId, preserveLocalState: true }
          }));
        }
      }

    } catch (e) {
      console.warn('[AppDataContext] ensurePatientsForSelectedDate failed:', e?.message || e);
    } finally {
      patientSyncStateRef.current.inProgress = false;
      patientSyncStateRef.current.lastRunAt = Date.now();
    }
  }, [value.selectedCityId, value.selectedDate]);

  // Trigger on dashboard refresh/boot
  useEffect(() => {
    ensurePatientsForSelectedDate();
  }, [ensurePatientsForSelectedDate]);

  // Trigger after Pull to Sync and general deliveries refresh events
  useEffect(() => {
    const onDeliveriesUpdated = (e) => {
      const { triggeredBy, source } = (e && e.detail) || {};
      if (
        triggeredBy === 'pullToSyncComplete' ||
        triggeredBy === 'manualRefresh' ||
        triggeredBy === 'periodicRefresh' ||
        triggeredBy === 'route_importer' ||
        source === 'realtime_sync'
      ) {
        ensurePatientsForSelectedDate();
      }
    };

    const onPullToSyncDataReady = async (e) => {
      const { deliveries = [], appUsers = [], patients = [], deliveryDate, preserveLocalState } = (e && e.detail) || {};
      if (!preserveLocalState) return;

      try {
        if (Array.isArray(deliveries) && deliveries.length > 0) {
          const currentDate = value.selectedDate || deliveryDate;
          const existing = deliveriesRef.current || [];
          const otherDates = currentDate ? existing.filter((item) => item?.delivery_date !== currentDate) : existing;
          const merged = [...otherDates, ...deliveries.filter(Boolean)];
          if (applyDeliveryChangesLocallyRef.current) {
            applyDeliveryChangesLocallyRef.current({ upserts: deliveries, deleteIds: [] });
          } else if (updateDeliveriesLocallyRef.current) {
            updateDeliveriesLocallyRef.current(merged, true);
          }
        }

        if (Array.isArray(appUsers) && appUsers.length > 0) {
          await wrappedUpdateAppUsersLocally(appUsers, true);
        }

        if (Array.isArray(patients) && patients.length > 0) {
          if (value.updatePatientsLocally) {
            value.updatePatientsLocally({ upserts: patients, deleteIds: [] });
          } else if (applyPatientChangesLocallyRef.current) {
            applyPatientChangesLocallyRef.current({ upserts: patients, deleteIds: [] });
          }
        }

        if (typeof window !== 'undefined') {
          if (appUsers.length > 0) {
            window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
              detail: { appUsers, forceAll: true, fromPullToSync: true }
            }));
          }
          if (patients.length > 0) {
            window.dispatchEvent(new CustomEvent('patientsUpdated', {
              detail: { patients, fromPullToSync: true, fullReplacement: false }
            }));
          }
          window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));
        }
      } finally {
        ensurePatientsForSelectedDate();
      }
    };

    const onPullToSyncComplete = () => ensurePatientsForSelectedDate();

    window.addEventListener('deliveriesUpdated', onDeliveriesUpdated);
    window.addEventListener('pullToSyncDataReady', onPullToSyncDataReady);
    window.addEventListener('pullToSyncComplete', onPullToSyncComplete);
    return () => {
      window.removeEventListener('deliveriesUpdated', onDeliveriesUpdated);
      window.removeEventListener('pullToSyncDataReady', onPullToSyncDataReady);
      window.removeEventListener('pullToSyncComplete', onPullToSyncComplete);
    };
  }, [ensurePatientsForSelectedDate, value.selectedDate, value.updatePatientsLocally]);

  const wrappedValue = useMemo(() => ({
    ...value,
    updateDeliveriesLocally: wrappedUpdateDeliveriesLocally,
    updateAppUsersLocally: wrappedUpdateAppUsersLocally,
    updatePatientsLocally: value.updatePatientsLocally,
    forceRefreshDriverDeliveries,
    onSelectedDateDataReady: value.onSelectedDateDataReady,
    setOnSelectedDateDataReady: value.setOnSelectedDateDataReady
  }), [
    value,
    wrappedUpdateDeliveriesLocally,
    wrappedUpdateAppUsersLocally,
    value.updatePatientsLocally,
    forceRefreshDriverDeliveries
  ]);
  
  return (
    <AppDataContext.Provider value={wrappedValue}>
      {isProgressiveSyncing && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[9999] rounded-full bg-slate-900/90 text-white text-xs px-3 py-1 shadow">
          Syncing…
        </div>
      )}
      <ImmediateNextDeliveryController />
      {children}
    </AppDataContext.Provider>
  );
};

export const useAppData = () => {
  const context = useContext(AppDataContext);
  if (!context) {
    return {
      deliveries: [],
      patients: [],
      stores: [],
      drivers: [],
      users: [],
      appUsers: [],
      cities: [],
      isDataLoaded: false,
      refreshData: () => {},
      updateDeliveriesLocally: () => {},
      updateAppUsersLocally: () => {},
      applyDeliveryChangesLocally: () => {},
      applyAppUserChangesLocally: () => {},
      applyPatientChangesLocally: () => {},
      forceRefreshDriverDeliveries: async () => {},
      isFormOverlayOpen: false,
      setIsFormOverlayOpen: () => {},
      isEntityUpdating: false,
      setIsEntityUpdating: () => {},
      onSmartRefreshComplete: null,
      setOnSmartRefreshComplete: () => {}
    };
  }
  return context;
};

export { AppDataContext };