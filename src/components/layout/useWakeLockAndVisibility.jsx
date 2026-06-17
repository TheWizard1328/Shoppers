import { useEffect, useRef } from 'react';
import { format } from 'date-fns';
import { globalFilters } from '../utils/globalFilters';
import { smartRefreshManager } from '../utils/smartRefreshManager';
import { performBackgroundSync } from '../utils/offlineSync';
import { locationTracker } from '../utils/locationTracker';

/**
 * Manages Wake Lock API and visibility change handling.
 * Triggers background sync when app regains focus after being hidden.
 */
export function useWakeLockAndVisibility({
  currentPageName,
  initialGlobalFiltersSet,
  currentUser,
  dataLoaded,
  isFormOverlayOpen,
  stores
}) {
  const wakeLockRef = useRef(null);
  const appFocusLostAtRef = useRef(null);
  const SMART_REFRESH_CYCLE = 15000;

  useEffect(() => {
    let batteryRef = null;

    const requestWakeLock = async () => {
      if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
      try {
        if ('getBattery' in navigator) {
          const battery = await navigator.getBattery();
          if (battery.level * 100 < 25 && !battery.charging) return;
        }
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        wakeLockRef.current.addEventListener('release', () => {});
      } catch {}
    };

    const releaseWakeLock = () => {
      if (wakeLockRef.current) { wakeLockRef.current.release(); wakeLockRef.current = null; }
    };

    const setupBatteryMonitoring = async () => {
      if (!('getBattery' in navigator)) return;
      try {
        batteryRef = await navigator.getBattery();
        const check = () => {
          const level = batteryRef.level * 100;
          if (level < 25 && !batteryRef.charging && wakeLockRef.current) releaseWakeLock();
          else if ((level >= 25 || batteryRef.charging) && !wakeLockRef.current && document.visibilityState === 'visible') requestWakeLock();
        };
        batteryRef.addEventListener('levelchange', check);
        batteryRef.addEventListener('chargingchange', check);
      } catch {}
    };

    setupBatteryMonitoring();

    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        await requestWakeLock();
        if (appFocusLostAtRef.current) {
          const hiddenDuration = Date.now() - appFocusLostAtRef.current;
          appFocusLostAtRef.current = null;

          if (locationTracker.isTracking && locationTracker.isPrimaryDevice) {
            // Primary device: push a fresh GPS fix so the online+offline DB are immediately current.
            locationTracker.refreshNow({ source: 'visibility-return' }).catch(() => {});
          } else if (!locationTracker.isPrimaryDevice) {
            // Non-primary device: reload AppUsers from offline DB and broadcast so markers
            // reflect the latest persisted location data without waiting for a WebSocket event.
            import('../utils/offlineDatabase').then(({ offlineDB }) => {
              offlineDB.getAll(offlineDB.STORES.APP_USERS).then((appUsers) => {
                if (appUsers && appUsers.length > 0) {
                  window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
                    detail: { appUsers, fromOfflineDB: true, mergeMode: 'merge' }
                  }));
                }
              }).catch(() => {});
            }).catch(() => {});
          }

          if (hiddenDuration >= SMART_REFRESH_CYCLE && currentPageName === 'Dashboard' && initialGlobalFiltersSet && currentUser && dataLoaded && !isFormOverlayOpen) {
            smartRefreshManager.lastRefreshTimes = { driverLocation: 0, activeDeliveries: 0, todayDeliveries: 0, appUsers: 0, patients: 0, stores: 0 };
            const selectedDateStr = globalFilters.getSelectedDate() || format(new Date(), 'yyyy-MM-dd');
            const cityStoreIds = stores.map((s) => s?.id).filter(Boolean);
            performBackgroundSync(selectedDateStr, cityStoreIds).catch(() => {});
          }
        }
      } else {
        appFocusLostAtRef.current = Date.now();
        releaseWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (document.visibilityState === 'visible') requestWakeLock();

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      releaseWakeLock();
    };
  }, [initialGlobalFiltersSet, currentUser, dataLoaded, isFormOverlayOpen, stores, currentPageName]);
}