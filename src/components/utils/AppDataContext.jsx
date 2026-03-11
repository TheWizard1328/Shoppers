import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { smartRefreshManager } from './smartRefreshManager';
import { base44 } from '@/api/base44Client';
import { cityFilteredRealtimeSync } from './cityFilteredRealtimeSync';
import { ensurePolylineSubscription } from './hereRouting';

const AppDataContext = createContext(null);

export const AppDataProvider = ({ children, value }) => {
  // Track last WS delivery update time to prevent stale reconcile from overwriting
  const lastDeliveryWsUpdateRef = useRef(0);
  // Keep refs to mutable values so the subscription closure always has the latest
  // without needing to re-subscribe on every render
  const updateDeliveriesLocallyRef = useRef(value.updateDeliveriesLocally);
  const updateAppUsersLocallyRef = useRef(value.updateAppUsersLocally);
  const deliveriesRef = useRef(value.deliveries);
  const appUsersRef = useRef(value.appUsers);
  
  // Track boot sync per city/date and syncing banner state
  const bootKeyRef = useRef('');
  const [isProgressiveSyncing, setIsProgressiveSyncing] = useState(false);
  const realtimeBatchRef = useRef({
    deliveries: { upserts: new Map(), deletes: new Set() },
    appUsers: { upserts: new Map(), deletes: new Set() }
  });
  const realtimeBatchTimerRef = useRef(null);

  const flushRealtimeBatch = useCallback(async () => {
    const batch = realtimeBatchRef.current;
    const deliveryUpserts = Array.from(batch.deliveries.upserts.values());
    const deliveryDeletes = Array.from(batch.deliveries.deletes.values());
    const appUserUpserts = Array.from(batch.appUsers.upserts.values());
    const appUserDeletes = Array.from(batch.appUsers.deletes.values());

    if (!deliveryUpserts.length && !deliveryDeletes.length && !appUserUpserts.length && !appUserDeletes.length) {
      return;
    }

    realtimeBatchRef.current = {
      deliveries: { upserts: new Map(), deletes: new Set() },
      appUsers: { upserts: new Map(), deletes: new Set() }
    };

    const deliveryChanged = deliveryUpserts.length > 0 || deliveryDeletes.length > 0;
    const appUsersChanged = appUserUpserts.length > 0 || appUserDeletes.length > 0;

    let nextDeliveries = deliveriesRef.current || [];
    let nextAppUsers = appUsersRef.current || [];

    if (deliveryChanged) {
      const byId = new Map(nextDeliveries.filter(Boolean).map((item) => [item?.id, item]).filter(([id]) => !!id));
      deliveryDeletes.forEach((id) => byId.delete(id));
      deliveryUpserts.forEach((item) => {
        if (item?.id) byId.set(item.id, item);
      });
      nextDeliveries = Array.from(byId.values());
    }

    if (appUsersChanged) {
      const ts = (item) => {
        const value = item?.location_updated_at || item?.updated_date || item?.created_date;
        return value ? new Date(value).getTime() : 0;
      };

      const byId = new Map(
        nextAppUsers
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

    try {
      const { offlineDB } = await import('./offlineDatabase');
      await Promise.all([
        deliveryUpserts.length ? offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, deliveryUpserts) : Promise.resolve(),
        appUserUpserts.length ? offlineDB.bulkSave(offlineDB.STORES.APP_USERS, appUserUpserts) : Promise.resolve(),
        ...deliveryDeletes.map((id) => offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, id).catch(() => null)),
        ...appUserDeletes.map((id) => offlineDB.deleteRecord(offlineDB.STORES.APP_USERS, id).catch(() => null))
      ]);
    } catch (error) {
      console.warn('[AppDataContext] Realtime offline sync batch failed:', error.message);
    }

    flushSync(() => {
      if (deliveryChanged && updateDeliveriesLocallyRef.current) {
        updateDeliveriesLocallyRef.current(nextDeliveries, true);
      }

      if (appUsersChanged && updateAppUsersLocallyRef.current) {
        updateAppUsersLocallyRef.current(nextAppUsers, true);
      }
    });

    if (deliveryChanged) {
      lastDeliveryWsUpdateRef.current = Date.now();
      smartRefreshManager.notifyRealtimeDeliveryUpdate && smartRefreshManager.notifyRealtimeDeliveryUpdate();
    }

    if (appUsersChanged) {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
          detail: { appUsers: nextAppUsers, singleUpdate: appUserUpserts.length === 1, fromRealtime: true }
        }));

        if (appUserUpserts.length === 1) {
          window.dispatchEvent(new CustomEvent('appUserUpdated', {
            detail: { appUser: appUserUpserts[0], fromRealtime: true }
          }));
        } else if (appUserUpserts.length > 1) {
          window.dispatchEvent(new CustomEvent('appUsersUpdated', {
            detail: { appUsers: appUserUpserts, fromRealtime: true }
          }));
        }
      }

      if (appUserUpserts.some((item) => item?.user_id === value.currentUser?.id) || appUserDeletes.length > 0) {
        value.refreshUser?.();
      }

      smartRefreshManager.notifyRealtimeUpdate('AppUser');
    }
  }, [value.currentUser?.id, value.refreshUser]);

  const scheduleRealtimeEntityUpdate = useCallback((entityType, eventType, data) => {
    const entityBatch = entityType === 'Delivery'
      ? realtimeBatchRef.current.deliveries
      : realtimeBatchRef.current.appUsers;

    const recordId = data?.id;
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
  useEffect(() => { deliveriesRef.current = value.deliveries; }, [value.deliveries]);
  useEffect(() => { appUsersRef.current = value.appUsers; }, [value.appUsers]);

  useEffect(() => {
    if (!value.currentUser) return;
    ensurePolylineSubscription();
  }, [value.currentUser?.id]);

  // CRITICAL: Set up city-filtered real-time subscriptions
  useEffect(() => {
    if (!value.currentUser || !value.selectedCityId || !value.selectedDate) {
      return;
    }
    
    // Start real-time subscriptions
    cityFilteredRealtimeSync.start(value.selectedCityId, value.selectedDate);

    // Subscribe to real-time updates
    // CRITICAL: Use refs instead of closure-captured values to always get the latest state
    const unsubscribe = cityFilteredRealtimeSync.subscribe(({ entityType, eventType, data }) => {
      if (entityType === 'Delivery') {
        scheduleRealtimeEntityUpdate('Delivery', eventType, data);
        return;
      }

      if (entityType === 'AppUser') {
        scheduleRealtimeEntityUpdate('AppUser', eventType, data);
      }
    });

    return () => {
      unsubscribe();
      cityFilteredRealtimeSync.stop();
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

        // 1) Load OFFLINE first in parallel
        const [offlineDeliveries, offlineAppUsers] = await Promise.all([
          offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDate),
          offlineDB.getAll(offlineDB.STORES.APP_USERS).catch(() => [])
        ]);

        if (cancelled) return;

        // Push offline deliveries to UI immediately (merge by date)
        if (Array.isArray(offlineDeliveries) && offlineDeliveries.length > 0 && value.updateDeliveriesLocally) {
          const other = (value.deliveries || []).filter(d => d && d.delivery_date !== selectedDate);
          value.updateDeliveriesLocally([...other, ...offlineDeliveries], true);
        }
        // Push offline app users (merge-safe, never overwrite fresher in-memory data)
        if (Array.isArray(offlineAppUsers) && offlineAppUsers.length > 0) {
          await wrappedUpdateAppUsersLocally(offlineAppUsers, false);
        }

        // 2) If offline missing or stale, fetch ONLINE progressively and persist
        const needsOnline = !offlineDeliveries || offlineDeliveries.length === 0;
        if (needsOnline) {
          const [onlineDeliveries, onlineAppUsers] = await Promise.all([
            // Minimal online pull scoped by date to reduce rate limits
            base44.entities.Delivery.filter({ delivery_date: selectedDate }),
            base44.entities.AppUser.list().catch(() => [])
          ]);

          if (cancelled) return;

          // Save to offline and refresh UI once
          if (onlineDeliveries && onlineDeliveries.length > 0) {
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, onlineDeliveries);
            const other2 = (value.deliveries || []).filter(d => d && d.delivery_date !== selectedDate);
            value.updateDeliveriesLocally([...other2, ...onlineDeliveries], true);
          }
          if (onlineAppUsers && onlineAppUsers.length > 0) {
            await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, onlineAppUsers);
            await wrappedUpdateAppUsersLocally(onlineAppUsers, false);
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
      
      if (value.updateDeliveriesLocally) {
        // Full replacement to ensure deletions are reflected
        value.updateDeliveriesLocally(mergedDeliveries, true);
        console.log(`✅ [Force Refresh] Updated context with ${mergedDeliveries.length} total deliveries`);
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

      // What do we already have offline?
      const existingPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
      const have = new Set((existingPatients || []).map(p => p.id));
      const missingIds = patientIdsNeeded.filter(id => !have.has(id));

      if (missingIds.length === 0) {
        patientSyncStateRef.current.inProgress = false;
        return;
      }

      // Fetch missing patients in small batches to avoid rate limits
      const fetched = [];
      const BATCH = 10;
      for (let i = 0; i < missingIds.length; i += BATCH) {
        const chunk = missingIds.slice(i, i + BATCH);
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
            detail: { count: fetched.length, selectedDate, selectedCityId }
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
    const onPullToSyncComplete = () => ensurePatientsForSelectedDate();

    window.addEventListener('deliveriesUpdated', onDeliveriesUpdated);
    window.addEventListener('pullToSyncComplete', onPullToSyncComplete);
    return () => {
      window.removeEventListener('deliveriesUpdated', onDeliveriesUpdated);
      window.removeEventListener('pullToSyncComplete', onPullToSyncComplete);
    };
  }, [ensurePatientsForSelectedDate]);

  const wrappedValue = {
    ...value,
    updateDeliveriesLocally: wrappedUpdateDeliveriesLocally,
    updateAppUsersLocally: wrappedUpdateAppUsersLocally,
    forceRefreshDriverDeliveries,
    onSelectedDateDataReady: value.onSelectedDateDataReady,
    setOnSelectedDateDataReady: value.setOnSelectedDateDataReady
  };
  
  return (
    <AppDataContext.Provider value={wrappedValue}>
      {isProgressiveSyncing && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[9999] rounded-full bg-slate-900/90 text-white text-xs px-3 py-1 shadow">
          Syncing…
        </div>
      )}
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