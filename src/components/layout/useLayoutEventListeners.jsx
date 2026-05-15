import { useEffect } from 'react';

/**
 * Centralizes all event listeners for Layout.jsx
 * Reduces Layout file bloat and improves maintainability
 */
export const useLayoutEventListeners = ({
  isUiLocked,
  isFormOverlayOpen,
  deliveries,
  patients,
  appUsers,
  setDeliveries,
  setPatients,
  setAppUsers,
  setUsers,
  setSmartRefreshActivity,
  mergePatients,
  clearUserCache,
  invalidate,
  getEffectiveUser,
  setCurrentUser,
  currentUser,
  triggerFullDataLoadRef
}) => {
  useEffect(() => {
    // ─── PULL-TO-SYNC DATA READY ───────────────────────────────────
    const handlePullToSyncDataReady = (event) => {
      if (isUiLocked()) {
        console.log('🔒 [Layout] pullToSyncDataReady ignored — UI locked');
        return;
      }
      const { patients: freshPatients, stores: freshStores, appUsers: freshAppUsers, deliveries: freshDeliveries } = event.detail || {};
      if (freshPatients && freshPatients.length > 0) {
        setPatients((prev) => mergePatients(prev, freshPatients));
      }
      if (freshStores && freshStores.length > 0) {
        // Stores handled elsewhere
      }
      if (freshAppUsers && freshAppUsers.length > 0) {
        setAppUsers((prev) => { const m = new Map(prev.map((u) => [u.id, u])); freshAppUsers.forEach((u) => { if (u?.id) m.set(u.id, u); }); return Array.from(m.values()); });
      }
      if (freshDeliveries && freshDeliveries.length > 0) {
        setDeliveries((prev) => {
          const map = new Map((prev || []).filter(Boolean).map((d) => [d?.id, d]).filter(([id]) => !!id));
          freshDeliveries.forEach((d) => {
            if (d?.id) map.set(d.id, d);
          });
          return Array.from(map.values());
        });
      }
    };
    window.addEventListener('pullToSyncDataReady', handlePullToSyncDataReady);

    // ─── SYNC STATUS UPDATES (BACKGROUND/HISTORICAL) ────────────────
    const handleSyncStatusUpdate = (event) => {
      const { status, entity, progress } = event.detail || {};
      if (!status) return;
      
      if (status === 'complete' || status === 'error') {
        setSmartRefreshActivity({ active: false, updatedEntities: [] });
      } else if (status === 'syncing' || status === 'force_syncing' || status === 'restart_syncing') {
        setSmartRefreshActivity({ 
          active: true, 
          updatedEntities: entity ? [entity] : []
        });
      }
    };
    window.addEventListener('syncStatusUpdated', handleSyncStatusUpdate);

    // ─── OFFLINE SYNC COMPLETE ──────────────────────────────────────
    const handleSyncComplete = () => {
      invalidate('Patient');
      invalidate('Delivery');
    };
    window.addEventListener('offlineSyncComplete', handleSyncComplete);

    // ─── FORCE DATA REFRESH (CONNECTION RECOVERY) ───────────────────
    const handleForceDataRefresh = async () => {
      console.log('🔄 [Layout] Force data refresh after connection recovery');
      invalidate('Delivery');
      invalidate('Patient');
      invalidate('AppUser');
      invalidate('Store');
      invalidate('User');
      invalidate('City');
      clearUserCache();
      if (triggerFullDataLoadRef.current) {
        await triggerFullDataLoadRef.current(true);
      }
    };
    window.addEventListener('forceDataRefresh', handleForceDataRefresh);

    return () => {
      window.removeEventListener('pullToSyncDataReady', handlePullToSyncDataReady);
      window.removeEventListener('syncStatusUpdated', handleSyncStatusUpdate);
      window.removeEventListener('offlineSyncComplete', handleSyncComplete);
      window.removeEventListener('forceDataRefresh', handleForceDataRefresh);
    };
  }, [isUiLocked, isFormOverlayOpen, deliveries, patients, appUsers, setDeliveries, setPatients, setAppUsers, setUsers, setSmartRefreshActivity, mergePatients, clearUserCache, invalidate, getEffectiveUser, setCurrentUser, currentUser, triggerFullDataLoadRef]);
};