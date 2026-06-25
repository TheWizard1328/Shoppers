import { useEffect, useRef } from 'react';
import { format } from '../utils/dataManager';
import { globalFilters } from '../utils/globalFilters';
import { requestThrottler } from '../utils/requestThrottler';
import { getEffectiveUser, clearUserCache } from '../utils/auth';
import { base44 } from '@/api/base44Client';
import { userHasRole } from '../utils/userRoles';
import { loadUserSettings, clearSettingsCache, getDeviceType, getDeviceIdentifier } from '../utils/userSettingsManager';
import { isMobileDeviceForTheme } from '../utils/deviceUtils';
import { getCompanyBranding } from '../utils/brandingManager';
import { offlineDB } from '../utils/offlineDatabase';
import { initializeGlobalFilters } from './initializeGlobalFilters';
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

  useEffect(() => {
    const init = async () => {
      setIsLoadingLayout(true);
      try {
        setDeviceTypeDetected(getDeviceType());
        const fetchedUser = await requestThrottler.queue(() => getEffectiveUser(), 'critical', 'getEffectiveUser');
        if (!fetchedUser) {setHasAccess(false);setCurrentUser(null);setIsLoadingLayout(false);setDataLoaded(true);return;}
        const deviceIdentifier = getDeviceIdentifier();
        const todayStr = format(new Date(), 'yyyy-MM-dd');
        const cachedReg = localStorage.getItem(`rxdeliver_device_registered_${deviceIdentifier}`);

        // ── STEP 1: Load ALL static bootstrap entities from IndexedDB immediately ──
        // This runs in parallel with the slim backend manifest call so neither blocks the other.
        const [
          offlineManifestResult,
          offlineDels, offlinePats, offlineAppUsers, offlineStores, offlineCities,
          sqConfigs, sqCatalog, sqTx, offlineInterStoreLocations,
        ] = await Promise.all([
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

        // Handle manifest response (slim — device check + API key only)
        let manifest = {}, isDeviceRegistered = false;
        if (offlineManifestResult && !offlineManifestResult._error) {
          manifest = offlineManifestResult?.data || offlineManifestResult || {};
          isDeviceRegistered = manifest.deviceRegistered === true;
        } else if (cachedReg === 'true') {
          isDeviceRegistered = true; // Offline fallback
        } else if (offlineManifestResult?._error) {
          throw offlineManifestResult._error;
        }

        // KEEP LOADING SPINNER while waiting for device registration
        if (!isDeviceRegistered && cachedReg !== 'true') {setCurrentUser(fetchedUser);return;}
        localStorage.setItem(`rxdeliver_device_registered_${deviceIdentifier}`, 'true');
        setDeviceRegistered(true);

        try {
          const s = await requestThrottler.queue(() => loadUserSettings(fetchedUser.id), 'critical', 'loadUserSettings');
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
        if (ms.hereApiKey) {
          if (typeof window !== 'undefined') window.__hereApiKey = ms.hereApiKey;
          const { seedHereApiKey } = await import('../utils/hereApiKeyStore');
          seedHereApiKey(ms.hereApiKey);
        }

        if (userHasRole(fetchedUser, 'dispatcher') && fetchedUser.status === 'inactive' && !userHasRole(fetchedUser, 'admin')) {
          sessionStorage.clear();clearUserCache();clearSettingsCache();
          alert('Access Denied: Your dispatcher account is currently inactive. Please contact an administrator.');
          try {await base44.auth.logout();} catch (e) {}
          window.location.href = '/';return;
        }
        setCurrentUser(fetchedUser);setHasAccess(true);

        // Start heartbeat — find this user's AppUser record id
        try {
          const appUserRecords = await base44.entities.AppUser.filter({ user_id: fetchedUser.id });
          const appUserRecord = appUserRecords?.[0];
          if (appUserRecord?.id) {
            const isDispatcherRole = userHasRole(fetchedUser, 'dispatcher') && !userHasRole(fetchedUser, 'driver');
            heartbeatService.start(appUserRecord.id, isDispatcherRole);
          }
        } catch { /* non-critical */ }
        if (fetchedUser?.company_id) {try {const b = await getCompanyBranding(fetchedUser.company_id);setBranding(b);const { applyBrandingStyles } = await import('../utils/brandingManager');applyBrandingStyles(b);} catch {}}

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
        const criticalDataMissing = !citiesData.length || !resolvedStores.length || !resolvedAppUsers.length;
        const squareConfigsMissing = !sqConfigs?.length;
        if (criticalDataMissing || squareConfigsMissing) {
          console.warn('⚠️ [Init] Critical bootstrap data missing from IndexedDB — fetching from server immediately...');
          try {
            const [freshCities, freshStores, freshAppUsers, freshSqConfigs] = await Promise.all([
              !citiesData.length       ? base44.entities.City.list().catch(() => null)    : Promise.resolve(null),
              !resolvedStores.length   ? base44.entities.Store.list().catch(() => null)   : Promise.resolve(null),
              !resolvedAppUsers.length ? base44.entities.AppUser.list().catch(() => null) : Promise.resolve(null),
              squareConfigsMissing     ? base44.entities.SquareLocationConfig.filter({ status: 'active' }).catch(() => null) : Promise.resolve(null),
            ]);

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
    init();
    return () => heartbeatService.stop();
  }, []);

  // Initialize daily message cleanup
  useEffect(() => {
    initializeDailyCleanup();
  }, []);

  useEffect(() => {
    if (isLoadingLayout) {
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