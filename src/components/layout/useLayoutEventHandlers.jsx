import { useEffect } from 'react';
import { format, invalidate, getData } from '../utils/dataManager';
import { globalFilters } from '../utils/globalFilters';
import { smartRefreshManager } from '../utils/smartRefreshManager';
import { subscribeMutations } from '../utils/entityMutations';
import { realtimeSync } from '../utils/realtimeSync';
import { offlineDB } from '../utils/offlineDatabase';
import { isUiLocked } from '../utils/filterChangeSync';
import { mergePatients } from './layoutDataHelpers';
import { performBackgroundSync, processPendingMutations } from '../utils/offlineSync';
import { clearUserCache } from '../utils/auth';
import { clearSettingsCache } from '../utils/userSettingsManager';
import { base44 } from '@/api/base44Client';

/**
 * useLayoutEventHandlers
 *
 * Owns ALL window.addEventListener subscriptions that were previously
 * embedded in the 426-line useEffect inside Layout.jsx.
 * Deps: [currentUser, currentPageName] — same as the original.
 */
export function useLayoutEventHandlers({
  // read-only state
  currentUser,
  currentPageName,
  initialGlobalFiltersSet,
  dataLoaded,
  isFormOverlayOpen,
  deliveries,
  patients,
  appUsers,
  stores,
  cities,
  drivers,
  users,
  // state setters
  setDeliveries,
  setPatients,
  setAppUsers,
  setStores,
  setCities,
  setUsers,
  setCatalogItems,
  setCurrentUser,
  setShowMessaging,
  setInitialConversation,
  setUnreadMessageCount,
  // callbacks from Layout
  triggerFullDataLoad,
  updateDeliveriesLocally,
  updateAppUsersLocally,
  updateAppDataState,
}) {
  useEffect(() => {
    if (!currentUser) return;

    // CRITICAL: Background sync - run ONCE after init, skip if already running
    let bgSyncHasRun = false;
    const bgSyncTimer = setTimeout(async () => {
      if (currentPageName !== 'Dashboard' || !initialGlobalFiltersSet || !currentUser || !dataLoaded || isFormOverlayOpen || bgSyncHasRun) return;
      bgSyncHasRun = true;

      const selectedDateStr = globalFilters.getSelectedDate() || format(new Date(), 'yyyy-MM-dd');
      const cityStoreIds = stores.map((s) => s?.id).filter(Boolean);

      console.log('🔄 [Layout] Starting ONE-TIME background sync for current month...');
      const { performBackgroundSync } = await import('../utils/offlineSync');
      performBackgroundSync(selectedDateStr, cityStoreIds).catch(() => {});
    }, 60000);

    // Set up periodic mutation processing (every 60 seconds to avoid rate limits)
    const mutationSyncInterval = setInterval(() => {
      processPendingMutations().catch(() => {});
    }, 60000);

    // Subscribe to ALL entity mutations and refresh UI IMMEDIATELY
    const unsubscribeMutations = subscribeMutations(async (mutation) => {
      console.log('🔔 [Layout] Mutation received:', mutation.entity, mutation.type, mutation.id);

      // CRITICAL: Handle 'replace' mutations to swap temp IDs with real backend IDs
      if (mutation.type === 'replace') {
        if (mutation.entity === 'Patient') {
          setPatients((prev) => prev.map((p) => p?.id === mutation.oldId ? mutation.data : p));
        } else if (mutation.entity === 'Delivery') {
          setDeliveries((prev) => prev.map((d) => d?.id === mutation.oldId ? mutation.data : d));
        }
        return;
      }

      // CRITICAL: Handle 'delete' mutations - update UI only after offline DB deletion completes
      if (mutation.type === 'delete') {
        if (mutation.entity === 'Patient') {
          await offlineDB.deleteRecord(offlineDB.STORES.PATIENTS, mutation.id).catch(() => {});
          setPatients((prev) => prev.filter((p) => p?.id !== mutation.id));
        } else if (mutation.entity === 'Delivery') {
          await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, mutation.id).catch(() => {});
          setDeliveries((prev) => prev.filter((d) => d?.id !== mutation.id));
        } else if (mutation.entity === 'Store') {
          await offlineDB.deleteRecord(offlineDB.STORES.STORES, mutation.id).catch(() => {});
          setStores((prev) => prev.filter((s) => s?.id !== mutation.id));
        } else if (mutation.entity === 'City') {
          await offlineDB.deleteRecord(offlineDB.STORES.CITIES, mutation.id).catch(() => {});
          setCities((prev) => prev.filter((c) => c?.id !== mutation.id));
        } else if (mutation.entity === 'AppUser') {
          await offlineDB.deleteRecord(offlineDB.STORES.APP_USERS, mutation.id).catch(() => {});
          setAppUsers((prev) => prev.filter((a) => a?.id !== mutation.id));
          setUsers((prev) => prev.filter((u) => u?.id !== mutation.id));
        }
        return;
      }

      // CRITICAL: Handle 'batch_delete' mutations - update UI only after offline DB deletions complete
      if (mutation.type === 'batch_delete') {
        const idsToDelete = new Set(mutation.ids || []);
        if (mutation.entity === 'Delivery') {
          await Promise.all((mutation.ids || []).map((id) =>
          offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, id).catch(() => {})
          ));
          setDeliveries((prev) => prev.filter((d) => !idsToDelete.has(d?.id)));
        }
        return;
      }

      // CRITICAL: Handle 'create' and 'update' mutations
      if (mutation.type === 'create') {
        if (mutation.entity === 'Patient') {
          setPatients((prev) => {
            const exists = prev.some((p) => p?.id === mutation.id);
            return exists ? prev : [...prev, mutation.data];
          });
        } else if (mutation.entity === 'Delivery') {
          setDeliveries((prev) => {
            const exists = prev.some((d) => d?.id === mutation.id);
            return exists ? prev : [...prev, mutation.data];
          });
        } else if (mutation.entity === 'Store') {
          setStores((prev) => {
            const exists = prev.some((s) => s?.id === mutation.id);
            if (!exists) offlineDB.save(offlineDB.STORES.STORES, mutation.data).catch(() => {});
            return exists ? prev : [...prev, mutation.data];
          });
        } else if (mutation.entity === 'City') {
          setCities((prev) => {
            const exists = prev.some((c) => c?.id === mutation.id);
            return exists ? prev : [...prev, mutation.data];
          });
        } else if (mutation.entity === 'AppUser') {
          setAppUsers((prev) => {
            const exists = prev.some((a) => a?.id === mutation.id);
            return exists ? prev : [...prev, mutation.data];
          });

          // CRITICAL: Immediately dispatch location update for new AppUser
          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
            detail: { appUsers: null, singleUpdate: mutation.data }
          }));
        }
      } else if (mutation.type === 'update') {
        if (mutation.entity === 'Patient') {
          setPatients((prev) => prev.map((p) => p?.id === mutation.id ? { ...p, ...mutation.data } : p));
        } else if (mutation.entity === 'Delivery') {
          setDeliveries((prev) => prev.map((d) => d?.id === mutation.id ? { ...d, ...mutation.data } : d));
        } else if (mutation.entity === 'Store') {
          // CRITICAL: Update in-memory state AND offline DB so all pages see fresh driver assignments
          setStores((prev) => {
            const updated = prev.map((s) => s?.id === mutation.id ? { ...s, ...mutation.data } : s);
            // Persist updated store to offlineDB so useFreshStores and other consumers stay in sync
            const updatedRecord = updated.find((s) => s?.id === mutation.id) || mutation.data;
            offlineDB.save(offlineDB.STORES.STORES, updatedRecord).catch(() => {});
            return updated;
          });
        } else if (mutation.entity === 'City') {
          setCities((prev) => prev.map((c) => c?.id === mutation.id ? { ...c, ...mutation.data } : c));
        } else if (mutation.entity === 'AppUser') {
          setAppUsers((prev) => prev.map((a) => a?.id === mutation.id ? { ...a, ...mutation.data } : a));

          // CRITICAL: Immediately dispatch location update for AppUser changes
          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
            detail: { appUsers: null, singleUpdate: mutation.data }
          }));
        }
      }
    });

    // Listen for offline sync completion to refresh UI
    const handleSyncComplete = () => {
      // CRITICAL: Just invalidate caches, DON'T trigger full reload
      // performBackgroundSync already loaded fresh data into offline DB
      invalidate('Patient');
      invalidate('Delivery');
      // Skip triggerFullDataLoad to prevent duplicate API calls
    };
    window.addEventListener('offlineSyncComplete', handleSyncComplete);

    // Listen for patient realtime updates (create/update/delete broadcast from other devices)
    const handlePatientsUpdated = (event) => {
      const { patients: freshPatients, deletedId, deletedIds, fullReplacement } = event.detail || {};
      // Handle deletes first
      const idsToRemove = new Set([...(deletedIds || []), ...(deletedId ? [deletedId] : [])]);
      if (idsToRemove.size > 0) {
        setPatients((prev) => prev.filter((p) => p?.id && !idsToRemove.has(p.id)));
      }
      // Handle upserts / full replacement
      if (freshPatients && freshPatients.length > 0) {
        if (fullReplacement) {
          setPatients(freshPatients.filter(Boolean));
        } else {
          setPatients((prev) => mergePatients(prev.filter((p) => p?.id && !idsToRemove.has(p.id)), freshPatients));
        }
      }
    };
    window.addEventListener('patientsUpdated', handlePatientsUpdated);

    // Listen for messaging requests from map markers
    const handleOpenMessaging = (event) => {
      const { otherUserId, otherUserName } = event.detail || {};
      setInitialConversation(otherUserId && otherUserName ? { otherUserId, otherUserName } : null);
      setUnreadMessageCount(0);setShowMessaging(true);
    };
    const handleOpenMessagingPanel = () => {setInitialConversation(null);setUnreadMessageCount(0);setShowMessaging(true);};
    window.addEventListener('openMessaging', handleOpenMessaging);window.addEventListener('openMessagingPanel', handleOpenMessagingPanel);

    // Listen for user role changes and update UI immediately
    const handleUserRolesChanged = async (event) => {
      const { appUsers: changedAppUsers } = event.detail || {};
      if (!changedAppUsers || changedAppUsers.length === 0) return;

      console.log(`🔐 [Layout] User roles changed - updating UI and navigation`);

      // Update appUsers state with new roles
      setAppUsers((prev) => {
        const map = new Map(prev.map((u) => [u.id, u]));
        changedAppUsers.forEach((updated) => {
          const existing = map.get(updated.id);
          if (existing) {
            map.set(updated.id, { ...existing, ...updated });
          }
        });
        return Array.from(map.values());
      });

      // Update merged users with new roles for navigation
      setUsers((prev) => {
        const map = new Map(prev.map((u) => [u.id, u]));
        changedAppUsers.forEach((updated) => {
          const existing = map.get(updated.user_id || updated.id);
          if (existing) {
            map.set(existing.id, { ...existing, app_roles: updated.app_roles });
          }
        });
        return Array.from(map.values());
      });

      // Update current user's roles if they changed
      if (currentUser && changedAppUsers.some((u) => u.user_id === currentUser.id)) {
        const updatedCurrentUser = changedAppUsers.find((u) => u.user_id === currentUser.id);
        if (updatedCurrentUser) {
          setCurrentUser({
            ...currentUser,
            app_roles: updatedCurrentUser.app_roles
          });
        }
      }

      // Force UI refresh for sidebar navigation
      window.dispatchEvent(new CustomEvent('navigationUpdate'));
    };
    window.addEventListener('userRolesChanged', handleUserRolesChanged);

    // Listen for conflict events and show resolution UI
    const handleConflict = async (event) => {
      const { conflicts } = event.detail || {};
      if (!conflicts || conflicts.length === 0) return;

      // Import conflict resolver dynamically
      const { getPendingConflicts, resolveConflictManually } = await import('../utils/offlineConflictResolver');
      const { default: ConflictResolutionDialog } = await import('../offline/ConflictResolutionDialog');

      // Show conflict resolution dialog
      // This will be handled by a global conflict manager
      console.log(`⚠️ [Layout] ${conflicts.length} conflicts detected`);
    };
    window.addEventListener('dataConflictsDetected', handleConflict);

    // Listen for store updates from Stores page — surgical merge, no full reload
    const handleStoreUpdated = (event) => {
      const { storeId, updatedStore } = event.detail || {};
      if (!storeId) return;
      if (updatedStore) {
        setStores((prev) => {
          const map = new Map((prev || []).filter(Boolean).map((s) => [s.id, s]));
          map.set(storeId, { ...(map.get(storeId) || {}), ...updatedStore });
          return Array.from(map.values()).sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
        });
      }
    };
    window.addEventListener('storeUpdated', handleStoreUpdated);

    // Listen for offline deletions and update UI immediately
    const handleOfflineDeliveriesDeleted = (event) => {
      const { deletedIds } = event.detail || {};
      if (deletedIds && deletedIds.length > 0) {
        console.log(`🗑️ [Layout] Removing ${deletedIds.length} deleted deliveries from UI`);
        setDeliveries((prevDeliveries) => prevDeliveries.filter((d) => !deletedIds.includes(d?.id)));
      }
    };
    window.addEventListener('offlineDeliveriesDeleted', handleOfflineDeliveriesDeleted);

    // Listen for import completion to update UI immediately
    const handleDeliveriesImported = async (event) => {
      const { deliveries, source } = event.detail || {};
      // CRITICAL: Only process if deliveries array is provided and non-empty
      // Skip if source is 'layout' to prevent infinite loops
      if (deliveries && deliveries.length > 0 && source !== 'layout') {
        console.log(`📥 [Layout] Received ${deliveries.length} imported deliveries - syncing patients FIRST`);

        // CRITICAL: Sync patient data FIRST before updating deliveries
        // This ensures all patient references are available when markers render
        try {
          invalidate('Patient');
          const freshPatients = await getData('Patient', null, null, true);
          setPatients(freshPatients);
          console.log(`✅ [Layout] Patient data synced: ${freshPatients.length} patients`);
        } catch (error) {
          console.error('❌ [Layout] Failed to sync patients after import:', error);
        }

        // Now update deliveries
        setDeliveries((prevDeliveries) => {
          const map = new Map(prevDeliveries.map((d) => [d.id, d]));
          deliveries.forEach((d) => map.set(d.id, d));
          return Array.from(map.values());
        });

        // CRITICAL: Force dispatch driverLocationsUpdated to update map markers immediately
        // This ensures "Show All" checkbox shows updated markers for other drivers
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
            detail: { appUsers }
          }));
        }, 500);
      }
    };
    window.addEventListener('deliveriesImported', handleDeliveriesImported);

    // Listen for delivery updates from DeliveryForm and trigger refresh
    const handleDeliveriesUpdated = async (event) => {
      // CRITICAL: Ignore intermediate events while filter-change sync is running
      if (isUiLocked()) {
        console.log('🔒 [Layout] deliveriesUpdated ignored — UI locked during filter-change sync');
        return;
      }
      const { deliveryId, driverId, deliveryDate, triggeredBy, freshDeliveries, preserveLocalState, deletedIds, deletedId, fullReplacement } = event.detail || {};
      const skipReloadTriggers = ['batchSaveImmediate', 'driver_location_update', 'driverLocationUpdate', 'pullToSyncDataReady', 'pullToSyncComplete', 'initialDataReady', 'eta_recalculation'];
      if (preserveLocalState || skipReloadTriggers.includes(triggeredBy)) {
        // CRITICAL: Always remove deleted IDs even when preserving local state (cross-device realtime deletes)
        const idsToRemove = new Set([...(deletedIds || []), ...(deletedId ? [deletedId] : [])]);
        if (idsToRemove.size > 0) setDeliveries((prev) => prev.filter((d) => !idsToRemove.has(d?.id)));
        if (freshDeliveries?.length > 0) setDeliveries((prev) => {const map = new Map(prev.filter((d) => !idsToRemove.has(d?.id)).map((d) => [d?.id, d]).filter(([id]) => !!id));freshDeliveries.forEach((d) => {if (d?.id && !idsToRemove.has(d.id)) map.set(d.id, d);});return Array.from(map.values());});
        return;
      }
      console.log(`🔄 [Layout] Delivery updated event: ${deliveryId} (${triggeredBy}) - fullReplacement: ${fullReplacement}`);
      if (freshDeliveries?.length > 0) {
        // CRITICAL: Always merge — never blindly replace the entire array.
        // fullReplacement updates stop_order/ETAs but must not drop deliveries
        // that are present in prev but absent from freshDeliveries (e.g. stops from
        // other dates or stops that haven't been re-fetched yet). Dropping them
        // causes the momentary "incomplete stops vanish" flicker on the map.
        setDeliveries((prev) => {
          const map = new Map((prev || []).filter(Boolean).map((d) => [d?.id, d]).filter(([id]) => !!id));
          freshDeliveries.forEach((d) => {
            if (!d?.id) return;
            const existing = map.get(d.id);
            let merged;
            if (fullReplacement) {
              merged = d;
            } else {
              merged = existing ? { ...existing, ...d } : d;
            }
            // CRITICAL: Preserve isNextDelivery=true from in-memory state.
            // setNextDeliveryFlag runs async — incoming data (from reconciler, smartRefresh,
            // or WebSocket flush) may still carry false on the next stop while the backend
            // hasn't committed yet. Never allow an incoming false to clobber a local true.
            if (existing?.isNextDelivery === true && !merged.isNextDelivery) {
              merged = { ...merged, isNextDelivery: true };
            }
            map.set(d.id, merged);
          });
          return Array.from(map.values());
        });
      }
    };
    window.addEventListener('deliveriesUpdated', handleDeliveriesUpdated);

    // Listen for AppUser status/location updates and merge into Layout appUsers state immediately.
    // This drives onlineCounts (sidebar Drivers badge) and AppDataContext (DriverLegendBar).
    const handleAppUserUpdated = (event) => {
      const { appUser } = event.detail || {};
      if (!appUser?.id) return;
      setAppUsers((prev) => {
        const m = new Map(prev.map((u) => [u.id, u]));
        const existing = m.get(appUser.id);
        m.set(appUser.id, existing ? { ...existing, ...appUser } : appUser);
        return Array.from(m.values());
      });
    };
    window.addEventListener('appUserUpdated', handleAppUserUpdated);

    // CRITICAL: Update patients/stores/appUsers in UI immediately when pullToSync completes
    const handlePullToSyncDataReady = (event) => {
      if (isUiLocked()) {
        console.log('🔒 [Layout] pullToSyncDataReady ignored — UI locked during filter-change sync');
        return;
      }
      const { patients: freshPatients, stores: freshStores, appUsers: freshAppUsers } = event.detail || {};
      if (freshPatients && freshPatients.length > 0) {
        setPatients((prev) => mergePatients(prev, freshPatients));
      }
      if (freshStores && freshStores.length > 0) setStores(freshStores);
      if (freshAppUsers && freshAppUsers.length > 0) {
        setAppUsers((prev) => {const m = new Map(prev.map((u) => [u.id, u]));freshAppUsers.forEach((u) => {if (u?.id) m.set(u.id, u);});return Array.from(m.values());});
      }
    };
    window.addEventListener('pullToSyncDataReady', handlePullToSyncDataReady);

    // Update patients state when patientDbPrioritySync finishes syncing fresh data
    const handleOfflinePatientsRefreshed = async () => {
      try {
        const freshPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS).catch(() => []);
        if (freshPatients && freshPatients.length > 0) {
          setPatients((prev) => mergePatients(prev, freshPatients));
          console.log(`✅ [Layout] Patient DB priority sync applied — ${freshPatients.length} patients in state`);
        }
      } catch (_) {}
    };
    window.addEventListener('offlinePatientsRefreshed', handleOfflinePatientsRefreshed);

    // DRIVER RESUME: When the driver returns after being away, resync the offline DB
    // so deliveries are fresh before the breadcrumb timer fires its next point.
    const handleDriverResumedAfterAbsence = async (event) => {
      const { awayDurationMs = 0 } = event.detail || {};
      console.log(`🔄 [Layout] Driver resumed after ${Math.round(awayDurationMs / 1000)}s away — resyncing deliveries from offline DB`);
      try {
        const selectedDateStr = globalFilters.getSelectedDate() || format(new Date(), 'yyyy-MM-dd');
        const { loadAndCacheDeliveriesForDate } = await import('../utils/offlineSync');
        const freshDeliveries = await loadAndCacheDeliveriesForDate(selectedDateStr);
        if (freshDeliveries && freshDeliveries.length > 0) {
          setDeliveries((prev) => {
            const map = new Map((prev || []).filter(Boolean).map((d) => [d.id, d]));
            freshDeliveries.forEach((d) => { if (d?.id) map.set(d.id, map.has(d.id) ? { ...map.get(d.id), ...d } : d); });
            return Array.from(map.values());
          });
          console.log(`✅ [Layout] Resume resync applied — ${freshDeliveries.length} deliveries refreshed`);
        }
      } catch (e) {
        console.warn('⚠️ [Layout] Resume resync failed:', e?.message);
      }
    };
    window.addEventListener('driverResumedAfterAbsence', handleDriverResumedAfterAbsence);

    // AUTO-RECOVERY: Listen for force refresh after connection recovery
    const handleForceDataRefresh = async () => {
      console.log('🔄 [Layout] Force data refresh after connection recovery - COMPREHENSIVE MODE');

      // CRITICAL: Invalidate ALL data caches to ensure fresh fetch
      invalidate('Delivery');
      invalidate('Patient');
      invalidate('AppUser');
      invalidate('Store');
      invalidate('User');
      invalidate('City');

      // CRITICAL: Clear the user cache to force fresh user data fetch
      clearUserCache();
      clearSettingsCache();

      // CRITICAL: Force immediate data reload with validation
      const triggerFn = typeof triggerFullDataLoad === 'function' ? triggerFullDataLoad : triggerFullDataLoad?.current;
      if (triggerFn) {
        console.log('📥 [Recovery] Starting full data reload...');
        await triggerFn(true);
        console.log('✅ [Recovery] Full data reload complete');
      }

      // Wait for data to settle
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // CRITICAL: Validate we have complete data BEFORE updating UI
      const hasValidData =
      (users?.length ?? 0) > 0 &&
      (drivers?.length ?? 0) > 0 &&
      (stores?.length ?? 0) > 0 &&
      (cities?.length ?? 0) > 0 &&
      (appUsers?.length ?? 0) > 0;

      if (!hasValidData) {
        console.warn('⚠️ [Recovery] Data incomplete after reload - retrying...');
        // Retry once
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (triggerFn) await triggerFn(true);
      }

      // Refresh stats after data is loaded
      window.dispatchEvent(new CustomEvent('refreshDeliveryStats'));

      // CRITICAL: Force refresh ALL UI elements including COD data
      console.log('🎨 [Recovery] Refreshing all UI elements...');

      // Refresh COD data — read only from entity, do NOT call squareSyncCatalogItems here.
      // Calling syncCatalogItems on every connection recovery recreates historical catalog items in Square.
      base44.entities.SquareCatalogItems.list('-updated_date', 500).then((items) => {
        setCatalogItems(items || []);
      }).catch(() => {});

      // Force dispatch driverLocationsUpdated to update map markers
      setTimeout(async () => {
        // Refresh driver locations to ensure colors are correct
        const locationUpdates = await smartRefreshManager.refreshDriverLocations(appUsers, true);
        if (locationUpdates?.hasChanges) {
          // CRITICAL: Merge — never replace. refreshDriverLocations may return a subset
          // of all drivers, so a full replacement would wipe the others from state.
          setAppUsers((prev) => {
            const m = new Map((prev || []).map((u) => [u.id, u]));
            (locationUpdates.appUsers || []).forEach((u) => { if (u?.id) m.set(u.id, u); });
            return Array.from(m.values());
          });
        }

        window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
          detail: { appUsers: locationUpdates?.appUsers || appUsers }
        }));

        console.log('✅ [Recovery] UI refresh complete');
      }, 1500);
    };
    window.addEventListener('forceDataRefresh', handleForceDataRefresh);

    realtimeSync.connect();

    return () => {
      clearTimeout(bgSyncTimer);
      clearInterval(mutationSyncInterval);
      unsubscribeMutations();
      realtimeSync.disconnect();
      window.removeEventListener('offlineSyncComplete', handleSyncComplete);
      window.removeEventListener('patientsUpdated', handlePatientsUpdated);
      window.removeEventListener('userRolesChanged', handleUserRolesChanged);
      window.removeEventListener('deliveriesImported', handleDeliveriesImported);
      window.removeEventListener('storeUpdated', handleStoreUpdated);
      window.removeEventListener('offlineDeliveriesDeleted', handleOfflineDeliveriesDeleted);
      window.removeEventListener('deliveriesUpdated', handleDeliveriesUpdated);
      // window.removeEventListener('driverLocationsUpdated', handleDriverLocationUpdated);
      window.removeEventListener('dataConflictsDetected', handleConflict);
      window.removeEventListener('forceDataRefresh', handleForceDataRefresh);
      window.removeEventListener('pullToSyncDataReady', handlePullToSyncDataReady);
      window.removeEventListener('appUserUpdated', handleAppUserUpdated);
      window.removeEventListener('openMessaging', handleOpenMessaging);window.removeEventListener('openMessagingPanel', handleOpenMessagingPanel);
      window.removeEventListener('offlinePatientsRefreshed', handleOfflinePatientsRefreshed);
      window.removeEventListener('driverResumedAfterAbsence', handleDriverResumedAfterAbsence);
    };
  }, [currentUser, currentPageName]);
}