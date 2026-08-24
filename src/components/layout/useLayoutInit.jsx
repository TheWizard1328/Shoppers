import { useEffect, useRef } from 'react';
import { format } from '../utils/dataManager';
import { globalFilters } from '../utils/globalFilters';
import { requestThrottler } from '../utils/requestThrottler';
import { getEffectiveUser, clearUserCache } from '../utils/auth';
import { base44 } from '@/api/base44Client';
import { isCapacitorNativeApp } from '@/components/utils/locationProviders/capacitorRuntime';
import { userHasRole } from '../utils/userRoles';
import { loadUserSettings, clearSettingsCache, getDeviceType, getDeviceIdentifier } from '../utils/userSettingsManager';
import { isMobileDeviceForTheme } from '../utils/deviceUtils';
import { getCompanyBranding, getCachedBranding } from '../utils/brandingManager';
import { offlineDB } from '../utils/offlineDatabase';
import { initializeGlobalFilters } from './initializeGlobalFilters';
import { loadNotificationTemplates, subscribeToTemplateUpdates } from '../utils/notificationRules';
import { smartRefreshManager } from '../utils/smartRefreshManager';
import { initializeDailyCleanup } from '../utils/messageCleaner';
import { backgroundSyncManager } from '../utils/backgroundSyncManager';
import { runBootstrapBackgroundSync } from '../utils/bootstrapBackgroundSync';
import { indexInterStoreLocation, resetInterStoreLocationsCache } from '../utils/interStoreDisplayName';
import { heartbeatService } from '../utils/heartbeatService';
import { runPatientDbPrioritySync } from '../utils/patientDbPrioritySync';

/**
 * useLayoutInit
 *
 * Owns the one-time app bootstrap sequence and the three small companion
 * useEffects that were grouped with it in Layout.jsx:
 *   - daily message cleanup
 *   - loading-spinner auto-retry timer
 *   - background sync manager start/stop
 */
export function useLayoutInit({
  isLoadingLayout, isFormOverlayOpen, dataLoaded, currentUser, currentPageName,
  setIsLoadingLayout, setDeviceTypeDetected, setHasAccess, setCurrentUser,
  setDataLoaded, setDeviceRegistered, setSidebarWidth, setThemePreference,
  setDataSource, setUserSettingsLoaded, setAppVersion, setAdminImportEnabled,
  setBranding, setCities, setShowCitySelectionPopup, setSquareLocationConfigs,
  setCatalogItems, setSquareTransactions, setDeliveries, setPatients,
  setAppUsers, setStores, setInitialGlobalFiltersSet, setShowInitRetryHint,
  setInitialFabPhase,
}) {
  const initAutoRefreshTimerRef = useRef(null);
  const initRetryHintTimerRef   = useRef(null);
  // True once the boot pauses because the current device has no UserDevice record.
  // Disarms the 60s auto-reload so the DeviceRegistration modal can be reached
  // instead of looping the page reload every minute (boot-loop root cause).
  const waitingForDeviceRegistrationRef = useRef(false);
  // Holds the bootstrap init function so it can be re-invoked in-place after the
  // user completes device registration (no page reload required).
  const initRef = useRef(null);

  useEffect(() => {
    const init = async () => {
      setIsLoadingLayout(true);
      try {
        setDeviceTypeDetected(getDeviceType());

        // CRITICAL: Wrap the user fetch in a timeout — if the backend is unreachable
        // or the throttler is stuck, the boot would hang here forever, and the 60s
        // auto-reload timer would fire and retry in an infinite loop.
        const _withTimeout = (promise, ms, label) =>
          Promise.race([promise, new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
          )]);

        let fetchedUser;
        try {
          fetchedUser = await _withTimeout(
            requestThrottler.queue(() => getEffectiveUser(), 'critical', 'getEffectiveUser'),
            10000, 'getEffectiveUser'
          );
        } catch (e) {
          console.error('❌ [Init] getEffectiveUser failed/timeout:', e.message);
          setHasAccess(false);setCurrentUser(null);setIsLoadingLayout(false);setDataLoaded(true);return;
        }
        if (!fetchedUser) {setHasAccess(false);setCurrentUser(null);setIsLoadingLayout(false);setDataLoaded(true);return;}
        const deviceIdentifier = getDeviceIdentifier();
        const todayStr = format(new Date(), 'yyyy-MM-dd');
        const cachedReg = localStorage.getItem(`rxdeliver_device_registered_${deviceIdentifier}`);

        // ── STEP 1: Load ALL static bootstrap entities from IndexedDB immediately ──
        // This runs in parallel with the slim backend manifest call so neither blocks the other.
        // Wrap the entire bootstrap Promise.all in a timeout — if ANY single
        // getAll() call hangs (not rejects), the .catch(() => []) is useless
        // because catch only fires on rejection, not on a promise that never settles.
        const _bootstrapPromise = Promise.all([
          // Slim backend call: device check + HERE API key only (no entity fetches)
          requestThrottler.queue(
            () => base44.functions.invoke('getBootstrapManifest', { deviceIdentifier, todayStr }),
            'critical', 'getBootstrapManifest'
          ).catch((e) => ({ _error: e })),
          offlineDB.getAll(offlineDB.STORES.DELIVERIES).catch(() => []),
          offlineDB.getAll(offlineDB.STORES.PATIENTS).catch(() => []),
          offlineDB.getAll(offlineDB.STORES.APP_USERS).catch(() => []),
          offlineDB.getAll(offlineDB.STORES.STORES).catch(() => []),
          offlineDB.getAll(offlineDB.STORES.CITIES).catch(() => []),
          offlineDB.getAll(offlineDB.STORES.SQUARE_LOCATION_CONFIGS).catch(() => []),
          offlineDB.getAll(offlineDB.STORES.SQUARE_CATALOG_ITEMS).catch(() => []),
          offlineDB.getAll(offlineDB.STORES.SQUARE_TRANSACTIONS).catch(() => []),
          offlineDB.getAll(offlineDB.STORES.INTER_STORE_LOCATIONS).catch(() => []),
        ]);

        let offlineManifestResult, offlineDels, offlinePats, offlineAppUsers, offlineStores, offlineCities,
            sqConfigs, sqCatalog, sqTx, offlineInterStoreLocations;
        try {
          [
            offlineManifestResult,
            offlineDels, offlinePats, offlineAppUsers, offlineStores, offlineCities,
            sqConfigs, sqCatalog, sqTx, offlineInterStoreLocations,
          ] = await _withTimeout(_bootstrapPromise, 15000, 'bootstrap Promise.all');
        } catch (bootTimeoutErr) {
          console.error('❌ [Init] Bootstrap Promise.all timed out — continuing with empty IDB data:', bootTimeoutErr.message);
          offlineManifestResult = { _error: bootTimeoutErr };
          offlineDels = []; offlinePats = []; offlineAppUsers = []; offlineStores = [];
          offlineCities = []; sqConfigs = []; sqCatalog = []; sqTx = []; offlineInterStoreLocations = [];
        }

        // Handle manifest response (slim — device check + API key only)
        let manifest = {}, isDeviceRegistered = false, manifestSucceeded = false;
        if (offlineManifestResult && !offlineManifestResult._error) {
          manifest = offlineManifestResult?.data || offlineManifestResult || {};
          isDeviceRegistered = manifest.deviceRegistered === true;
          manifestSucceeded = true; // Server responded — its deviceRegistered flag is authoritative
        } else if (cachedReg === 'true') {
          isDeviceRegistered = true; // Offline fallback — manifest fetch failed, trust last known cache
        } else if (offlineManifestResult?._error) {
          throw offlineManifestResult._error;
        }

        // KEEP LOADING SPINNER while waiting for device registration.
        // CRITICAL: Once the manifest call succeeds, the server's deviceRegistered flag
        // is authoritative and must NEVER be overridden by a stale local cache flag.
        // Previously `cachedReg === 'true'` alone could suppress the registration dialog
        // forever even after the server correctly reported deviceRegistered:false (e.g.
        // the UserDevice record was deleted/never created) — silently disabling GPS
        // heartbeats for that user with no way to self-heal. Only trust the cache when
        // the manifest call itself failed (offline), never to override a fresh "false".
        if (!isDeviceRegistered && (manifestSucceeded || cachedReg !== 'true')) {
          // Device not registered — pause boot so the DeviceRegistration modal
          // (rendered via GlobalOverlays) becomes the user's only path forward to
          // reselect/create the correct device. CRITICAL: clear the auto-reload
          // timers so a degraded platform can't keep reloading the page every 60s
          // and trap the user in a loop before the modal appears. The modal calls
          // window.location.reload() itself once a device is chosen, resuming boot.
          waitingForDeviceRegistrationRef.current = true;
          setCurrentUser(fetchedUser);
          // CRITICAL: Release the loading gate so GlobalOverlays (which hosts the
          // DeviceRegistration modal) actually renders. Previously the spinner
          // stayed up while the modal — gated behind isLoadingLayout=false —
          // never appeared, deadlocking the boot on an infinite spinner. This
          // was the root cause of the editor-only "stuck on Loading RxDeliver"
          // hang: the preview device has no UserDevice record, so every boot
          // paused here and never recovered.
          setHasAccess(true);
          setIsLoadingLayout(false);
          if (initAutoRefreshTimerRef.current) { clearTimeout(initAutoRefreshTimerRef.current); initAutoRefreshTimerRef.current = null; }
          if (initRetryHintTimerRef.current) { clearTimeout(initRetryHintTimerRef.current); initRetryHintTimerRef.current = null; }
          setShowInitRetryHint(false);
          return;
        }
        localStorage.setItem(`rxdeliver_device_registered_${deviceIdentifier}`, 'true');
        setDeviceRegistered(true);

        try {
          // Wrap loadUserSettings in a timeout — if the throttler is stuck or the
          // UserSettings fetch hangs (mobile/laptop can stall here during the first
          // editor-preview boot), the boot would hang on the loading screen forever.
          const s = await _withTimeout(
            requestThrottler.queue(() => loadUserSettings(fetchedUser.id), 'critical', 'loadUserSettings'),
            10000, 'loadUserSettings'
          );
          if (s.sidebar_width) setSidebarWidth(s.sidebar_width);
          if (s.theme_preference && isMobileDeviceForTheme()) setThemePreference(s.theme_preference);else setThemePreference('light');
          if (s.data_source) setDataSource(s.data_source);
          if (s.fab_map_cycle_phase && setInitialFabPhase) setInitialFabPhase(Number(s.fab_map_cycle_phase) || 1);
          initializeGlobalFilters(fetchedUser, s);
          setUserSettingsLoaded(true);
        } catch {setUserSettingsLoaded(true);}

        const ms = manifest.appSettings || {};
        smartRefreshManager._enabled = ms.smartRefreshEnabled !== false;
        smartRefreshManager._initialized = true;
        if (ms.appVersion) {const v = ms.appVersion;setAppVersion(`v${v.major}.${v.minor}.${v.build}`);}
        setAdminImportEnabled(ms.adminImportEnabled === true);

        // Load notification templates from entity so runtime messaging respects admin config
        loadNotificationTemplates(base44).catch(() => { /* non-critical */ });
        // Subscribe to live template changes — updates take effect immediately for all users
        subscribeToTemplateUpdates(base44);
        if (ms.hereApiKey) {
          if (typeof window !== 'undefined') window.__hereApiKey = ms.hereApiKey;
          const { seedHereApiKey } = await import('../utils/hereApiKeyStore');
          seedHereApiKey(ms.hereApiKey);
        }

        if (userHasRole(fetchedUser, 'dispatcher') && fetchedUser.status === 'inactive' && !userHasRole(fetchedUser, 'admin')) {
          sessionStorage.clear();clearUserCache();clearSettingsCache();
          alert('Access Denied: Your dispatcher account is currently inactive. Please contact an administrator.');
          if (isCapacitorNativeApp()) { try { localStorage.removeItem('base44_access_token'); localStorage.removeItem('token'); } catch (e) {} } else { try { await base44.auth.logout(); } catch (e) {} }
          window.location.href = '/';return;
        }
        setCurrentUser(fetchedUser);setHasAccess(true);

        // Start heartbeat — find this user's AppUser record id
        try {
          // Wrap in a timeout — a hung backend/throttler here would hold the
          // loading gate open permanently on the first boot of a preview session.
          const appUserRecords = await _withTimeout(
            base44.entities.AppUser.filter({ user_id: fetchedUser.id }),
            10000, 'heartbeat AppUser.filter'
          );
          const appUserRecord = appUserRecords?.[0];
          if (appUserRecord?.id) {
            const isDispatcherRole = userHasRole(fetchedUser, 'dispatcher') && !userHasRole(fetchedUser, 'driver');
            heartbeatService.start(appUserRecord.id, isDispatcherRole, fetchedUser.id);
          }
        } catch { /* non-critical */ }
        // Apply cached branding IMMEDIATELY from localStorage (survives Android recreate)
        const _cached = getCachedBranding();
        if (_cached?.logo_url) {
          setBranding(_cached);
          const { applyBrandingStyles } = await import('../utils/brandingManager');
          applyBrandingStyles(_cached);
        }
        // Fetch fresh branding from API. If it falls back to defaults (API failure
        // or Company entity missing), use that as a SIGNAL that data load had a
        // problem — force a full data reload to ensure entities are loaded correctly.
        let _brandingFallback = false;
        if (fetchedUser?.company_id) {
          try {
            // Wrap branding fetch in a timeout — if Company.filter hangs (throttler
            // stuck / backend unresponsive) the boot would hang here forever, the
            // loading spinner would cycle endlessly, and the 5s patient priority
            // sync below would never fire — leaving patient cards blank.
            const b = await _withTimeout(
              getCompanyBranding(fetchedUser.company_id),
              15000, 'getCompanyBranding'
            );
            setBranding(b);
            const { applyBrandingStyles } = await import('../utils/brandingManager');
            applyBrandingStyles(b);
            if (b?._fallback) {
              _brandingFallback = true;
              console.warn('🟢 [Init] Branding fallback triggered — forcing full data reload to verify entity integrity');
            }
          } catch {
            _brandingFallback = true;
          }
        }
        // Branding fallback alone does NOT trigger a full entity reload.
        // The Company entity may simply be empty or the company_id may not match —
        // this doesn't mean other entities (cities, stores, app users) are broken.
        // The criticalDataMissing check below already handles genuinely missing data.
        // Previously, branding fallback set window.__forceDataReload AND dispatched
        // a brandingFallbackDetected event, causing TWO redundant full data loads
        // (one in useLayoutInit, one in Layout.jsx) — this was the boot loop.

        // ── STEP 2: Apply offline data to UI immediately ──
        setSquareLocationConfigs(sqConfigs || []);
        // Immediately seed the window cache so StopCardActionButtons doesn't flash "disabled"
        // before React state propagates through the useEffect in Layout.jsx
        if (sqConfigs?.length && typeof window !== 'undefined') {
          window.__squareLocationConfigCache = sqConfigs;
        }
        setCatalogItems(sqCatalog || []);
        setSquareTransactions(sqTx || []);

        if (offlineDels?.length) setDeliveries(offlineDels);
        if (offlinePats?.length) setPatients(offlinePats);

        // Seed inter-store location in-memory cache from offline DB immediately
        if (offlineInterStoreLocations?.length) {
          resetInterStoreLocationsCache(); // clear stale promise so getAllLocations() uses fresh data
          offlineInterStoreLocations.forEach(indexInterStoreLocation);
          console.log(`✅ [Init] Seeded ${offlineInterStoreLocations.length} inter-store locations from offline DB`);
        }

        let resolvedAppUsers = offlineAppUsers || [];
        let resolvedStores   = offlineStores   || [];
        let citiesData       = offlineCities?.length
          ? offlineCities.sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity))
          : [];

        // ── PRIORITY FETCH: If critical bootstrap data is missing from IndexedDB,
        // fetch it directly from the backend NOW (before releasing the loading gate).
        // This handles first-ever sessions and corrupted / partially-wiped offline DBs.
        const _forceReload = !!window.__forceDataReload;
        if (_forceReload) {
          console.warn('🔄 [Init] Force-reloading ALL critical entities from server');
          window.__forceDataReload = false; // consume the flag
        }
        const criticalDataMissing = !citiesData.length || !resolvedStores.length || !resolvedAppUsers.length;
        const squareConfigsMissing = !sqConfigs?.length;
        if (criticalDataMissing || squareConfigsMissing || _forceReload) {
          console.warn('⚠️ [Init] Critical bootstrap data missing from IndexedDB — fetching from server immediately...');
          try {
            // Wrap the priority fetch in a timeout — if any entity.list()/filter()
            // call hangs (not rejects), the boot would hang here forever, trapping
            // the user on the cycling loading screen and preventing the patient
            // priority sync (5s timer below) from ever repopulating patient records.
            let freshCities = null, freshStores = null, freshAppUsers = null, freshSqConfigs = null;
            try {
              [freshCities, freshStores, freshAppUsers, freshSqConfigs] = await _withTimeout(
                Promise.all([
                  (!citiesData.length || _forceReload)       ? base44.entities.City.list().catch(() => null)    : Promise.resolve(null),
                  (!resolvedStores.length || _forceReload)   ? base44.entities.Store.list().catch(() => null)   : Promise.resolve(null),
                  (!resolvedAppUsers.length || _forceReload) ? base44.entities.AppUser.list().catch(() => null) : Promise.resolve(null),
                  (squareConfigsMissing || _forceReload)     ? base44.entities.SquareLocationConfig.filter({ status: 'active' }).catch(() => null) : Promise.resolve(null),
                ]),
                20000, 'priority entity fetch'
              );
            } catch {
              // Timeout — proceed with whatever offline data we have; background
              // sync will repopulate once the UI is released.
            }

            if (freshCities?.length) {
              citiesData = freshCities.sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity));
              await offlineDB.bulkSave(offlineDB.STORES.CITIES, freshCities).catch(() => {});
              console.log(`✅ [Init] Priority-fetched ${freshCities.length} cities`);
            }
            if (freshStores?.length) {
              resolvedStores = freshStores;
              await offlineDB.bulkSave(offlineDB.STORES.STORES, freshStores).catch(() => {});
              console.log(`✅ [Init] Priority-fetched ${freshStores.length} stores`);
            }
            if (freshAppUsers?.length) {
              resolvedAppUsers = freshAppUsers;
              await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, freshAppUsers).catch(() => {});
              console.log(`✅ [Init] Priority-fetched ${freshAppUsers.length} appUsers`);
            }
            if (freshSqConfigs?.length) {
              await offlineDB.bulkSave(offlineDB.STORES.SQUARE_LOCATION_CONFIGS, freshSqConfigs).catch(() => {});
              setSquareLocationConfigs(freshSqConfigs);
              if (typeof window !== 'undefined') window.__squareLocationConfigCache = freshSqConfigs;
              console.log(`✅ [Init] Priority-fetched ${freshSqConfigs.length} Square location configs`);
            }
          } catch (priorityErr) {
            console.warn('⚠️ [Init] Priority fetch failed:', priorityErr?.message);
          }
        }

        // ALWAYS mark bootstrap sync as fresh after init — whether we fetched or not.
        // This prevents bootstrapBackgroundSync from firing City/Store/AppUser calls
        // 3 seconds later on top of the filterChangeSync delivery fetch.
        localStorage.setItem('rxdeliver_bootstrap_sync_ts', String(Date.now()));

        if (resolvedAppUsers.length) setAppUsers(resolvedAppUsers);
        if (resolvedStores.length) setStores(resolvedStores.sort((a, b) => (a.sort_order ?? Infinity) - (b.sort_order ?? Infinity)));
        if (citiesData.length) setCities(citiesData);

        console.log(`✅ [Init] Offline DB loaded: ${offlineDels?.length || 0} deliveries, ${offlinePats?.length || 0} patients, ${citiesData.length} cities`);

        // Determine initial city for global filters
        let initialCityId = citiesData.find((c) => c && c.id === fetchedUser.city_id)?.id || null;
        if (!initialCityId && userHasRole(fetchedUser, 'admin') && citiesData.length > 0) initialCityId = citiesData[0].id;
        if (!initialCityId) {setShowCitySelectionPopup(true);globalFilters.setSelectedCityId('waiting-for-selection');setIsLoadingLayout(false);return;}
        globalFilters.setSelectedCityId(initialCityId);

        if (!globalFilters.getSelectedDate()) globalFilters.setSelectedDate(format(new Date(), 'yyyy-MM-dd'));
        if (!globalFilters.getSelectedDriverId()) globalFilters.setSelectedDriverId('all');

        const { markOfflineDBLoadComplete } = await import('../utils/dataManager');
        markOfflineDBLoadComplete();
        setInitialGlobalFiltersSet(true);setDataLoaded(true);
        setIsLoadingLayout(false); // Release loading gate ONLY after all prerequisites confirmed

        // ── STEP 0: Load initial unread message count (non-blocking) ──
        setTimeout(async () => {
          try {
            if (!fetchedUser?.id) return;
            const unreadMessages = await base44.entities.Message.filter({ receiver_id: fetchedUser.id, read: false });
            if (unreadMessages?.length > 0 && setInitialGlobalFiltersSet) {
              // Reuse the setUnreadMessageCount via a custom event so we don't need to thread the setter
              window.dispatchEvent(new CustomEvent('unreadMessageCountLoaded', { detail: { count: unreadMessages.length } }));
            }
          } catch { /* non-critical */ }
        }, 2000);

        // ── STEP 3a: Patient DB priority sync — runs if offline DB < 3000 patients ──
        // Non-blocking. Prioritises stores relevant to the current user's role.
        setTimeout(() => {
          runPatientDbPrioritySync(fetchedUser).catch(() => {});
        }, 5000); // 5s delay — let deliveries + initial render settle first

        // ── STEP 3b: Background sync — update IndexedDB + UI from server (non-blocking) ──
        // Fires after UI is visible. Skipped if data was synced within the last 4 hours.
        setTimeout(() => {
          runBootstrapBackgroundSync({
            setCities: (fresh) => setCities(fresh),
            setStores: (fresh) => setStores(fresh),
            // CRITICAL: Merge — never replace. Full replacement wipes drivers absent from
            // this bootstrap fetch payload, breaking header/bottom-nav conditionals.
            setAppUsers: (fresh) => setAppUsers((prev) => {
              const m = new Map((prev || []).map((u) => [u.id, u]));
              (fresh || []).forEach((u) => { if (u?.id) m.set(u.id, u); });
              return Array.from(m.values());
            }),
            setAdminImportEnabled,
            setAppVersion,
            setSquareLocationConfigs: (fresh) => {
              setSquareLocationConfigs(fresh);
              if (typeof window !== 'undefined') window.__squareLocationConfigCache = fresh;
            },
          });
        }, 3000); // 3s delay — let the UI settle first
      } catch (error) {
        const isAuth = error.response?.status === 401 || error.response?.status === 403 || error.message?.includes('Unauthorized') || error.message?.includes('Forbidden');
        if (isAuth) {setHasAccess(false);} else {console.warn('⚠️ Init error:', error.message);setHasAccess(true);}
        setIsLoadingLayout(false);setDataLoaded(true);
      }
    };
    initRef.current = init;
    init();
    return () => heartbeatService.stop();
  }, []);

  // Resume the bootstrap in-place after the user selects/creates a device in the
  // DeviceRegistration modal (no page reload). DeviceRegistration.completeRegistration
  // dispatches this event once the new device identifier is in localStorage and the
  // identifier cache is invalidated, so re-running init picks up the registered
  // device and the manifest gate passes.
  useEffect(() => {
    const handleResume = () => {
      if (!initRef.current) return;
      waitingForDeviceRegistrationRef.current = false;
      initRef.current();
    };
    window.addEventListener('deviceRegistrationCompleted', handleResume);
    return () => window.removeEventListener('deviceRegistrationCompleted', handleResume);
  }, []);

  // Initialize daily message cleanup
  useEffect(() => {
    initializeDailyCleanup();
  }, []);

  useEffect(() => {
    // Don't arm the 60s auto-reload while the boot is intentionally paused
    // waiting for the user to register/reselect a device — the modal is the
    // recovery path, and reloading would trap the user in a loop.
    if (isLoadingLayout && !waitingForDeviceRegistrationRef.current) {
      setShowInitRetryHint(false);
      initRetryHintTimerRef.current = setTimeout(() => setShowInitRetryHint(true), 15000);
      initAutoRefreshTimerRef.current = setTimeout(() => window.location.reload(), 60000);
    } else {
      setShowInitRetryHint(false);
      if (initRetryHintTimerRef.current) clearTimeout(initRetryHintTimerRef.current);
      if (initAutoRefreshTimerRef.current) clearTimeout(initAutoRefreshTimerRef.current);
    }
    return () => {
      if (initRetryHintTimerRef.current) clearTimeout(initRetryHintTimerRef.current);
      if (initAutoRefreshTimerRef.current) clearTimeout(initAutoRefreshTimerRef.current);
    };
  }, [isLoadingLayout]);

  // Initialize background sync manager
  useEffect(() => {
    if (!currentUser || !dataLoaded || currentPageName !== 'Dashboard') return backgroundSyncManager.stop();
    const startBackgroundSync = async () => {
      try {
        backgroundSyncManager.setCurrentUser(currentUser);
        await backgroundSyncManager.loadConfig();
        backgroundSyncManager.start();
      } catch (error) {
        console.warn('⚠️ [Layout] Failed to start background sync:', error);
      }
    };
    const timer = setTimeout(startBackgroundSync, 120000);
    return () => { clearTimeout(timer); backgroundSyncManager.stop(); };
  }, [currentUser, dataLoaded, currentPageName]);
}