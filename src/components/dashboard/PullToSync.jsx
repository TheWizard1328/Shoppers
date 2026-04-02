import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw } from 'lucide-react';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { globalFilters } from '@/components/utils/globalFilters';
import { processPendingMutations } from '@/components/utils/offlineSync';

export default function PullToSync({ 
  selectedDate, 
  selectedCityId, 
  selectedDriverId, 
  showAllDriverMarkers,
  onSyncComplete,
  statsCardRef
}) {
  const [isPulling, setIsPulling] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const touchStartY = useRef(0);
  const syncThreshold = 80; // Pull threshold to trigger sync
  const activeSyncRunIdRef = useRef(null);
  const lastSyncStartedAtRef = useRef(0);

  useEffect(() => {
    const statsCard = statsCardRef?.current;
    if (!statsCard) return;

    const handleTouchStart = (e) => {
      // Only trigger if swipe starts on the stats card
      touchStartY.current = e.touches[0].clientY;
      setIsPulling(true);
    };

    const handleTouchMove = (e) => {
      if (!isPulling || isSyncing) return;

      const currentY = e.touches[0].clientY;
      const distance = Math.max(0, currentY - touchStartY.current);
      
      // Cap at 120px
      setPullDistance(Math.min(distance, 120));
    };

    const handleTouchEnd = async () => {
      if (!isPulling || isSyncing) return;

      if (pullDistance >= syncThreshold) {
        await performSync();
      }

      setIsPulling(false);
      setPullDistance(0);
    };

    statsCard.addEventListener('touchstart', handleTouchStart, { passive: true });
    statsCard.addEventListener('touchmove', handleTouchMove, { passive: true });
    statsCard.addEventListener('touchend', handleTouchEnd);

    return () => {
      statsCard.removeEventListener('touchstart', handleTouchStart);
      statsCard.removeEventListener('touchmove', handleTouchMove);
      statsCard.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isPulling, pullDistance, isSyncing, statsCardRef]);

  // Listen for programmatic trigger events (e.g., from route import completion)
  useEffect(() => {
    const handleTriggerSync = async (event) => {
      const silent = event.detail?.silent || false;
      if (isSyncing || (window.__dashboardSyncing && window.__activePullToSyncRunId)) return;
      console.log(`🔄 [PullToSync] Sync triggered programmatically (silent: ${silent})`);
      await performSync(silent);
    };

    window.addEventListener('triggerPullToSync', handleTriggerSync);
    return () => window.removeEventListener('triggerPullToSync', handleTriggerSync);
  }, []);

  const performSync = async (silent = false) => {
    const now = Date.now();
    if (isSyncing || (window.__dashboardSyncing && window.__activePullToSyncRunId)) return;
    if (now - lastSyncStartedAtRef.current < 10000) return;

    lastSyncStartedAtRef.current = now;
    const syncRunId = `${Date.now()}`;
    activeSyncRunIdRef.current = syncRunId;
    window.__activePullToSyncRunId = syncRunId;
    setIsSyncing(true);
    setShowOverlay(!silent);
    try { window.__dashboardSyncing = true; window.dispatchEvent(new CustomEvent('pullToSyncStarted')); } catch (e) {}

    try {
      const selectedDateStr = globalFilters.getSelectedDate() || format(selectedDate, 'yyyy-MM-dd');
      const currentDriverId = globalFilters.getSelectedDriverId() || selectedDriverId;
      const currentCityId = globalFilters.getSelectedCityId() || selectedCityId;

      await processPendingMutations().catch((error) => {
        console.warn('⚠️ [PullToSync] Pending mutation flush failed:', error?.message || error);
      });

      await new Promise((resolve) => setTimeout(resolve, silent ? 0 : 400));
      let cityStores = currentCityId
        ? await offlineDB.getByIndex(offlineDB.STORES.STORES, 'city_id', currentCityId)
        : [];

      if (currentCityId && (!Array.isArray(cityStores) || cityStores.length === 0)) {
        cityStores = await base44.entities.Store.filter({ city_id: currentCityId });
        if (Array.isArray(cityStores) && cityStores.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.STORES, cityStores);
        }
      }

      const cityStoreIds = Array.isArray(cityStores) ? cityStores.map((store) => store?.id).filter(Boolean) : [];
      const deliveryFilter = {
        delivery_date: selectedDateStr,
        ...(cityStoreIds.length > 0 ? { store_id: { $in: cityStoreIds } } : {})
      };
      const uiDriverFilter = currentDriverId && currentDriverId !== 'all' ? currentDriverId : null;
      if (window.__dashboardSyncing && window.__activePullToSyncRunId && !silent && window.__activePullToSyncRunId !== syncRunId) {
        return;
      }

      window.dispatchEvent(new CustomEvent('pullToSyncStarted', { detail: { suppressIncrementalUi: true } }));

      const [freshDeliveriesRaw, pendingMutations] = await Promise.all([
        base44.entities.Delivery.filter(deliveryFilter),
        offlineDB.getPendingMutations().catch(() => [])
      ]);

      const pendingDeleteIds = new Set(
        (pendingMutations || [])
          .filter((mutation) => mutation?.entity === 'Delivery' && mutation?.operation === 'delete' && mutation?.recordId)
          .map((mutation) => mutation.recordId)
      );
      const freshDeliveries = (freshDeliveriesRaw || []).filter((delivery) => !pendingDeleteIds.has(delivery?.id));

      await offlineDB.replaceRecordsByIndex(
        offlineDB.STORES.DELIVERIES,
        'delivery_date',
        selectedDateStr,
        freshDeliveries,
        { allowEmptyReplace: true }
      );

      await offlineDB.updateSyncMetadata(
        'Delivery',
        new Date().toISOString(),
        new Date().toISOString(),
        { synced_delivery_date: selectedDateStr, synced_city_id: currentCityId || null }
      );

      const patientIds = Array.from(
        new Set((freshDeliveries || []).filter((d) => d?.patient_id).map((d) => d.patient_id))
      );

      let freshPatients = [];
      if (patientIds.length > 0) {
        const batchSize = 50;
        const patientBatches = [];
        for (let i = 0; i < patientIds.length; i += batchSize) {
          patientBatches.push(patientIds.slice(i, i + batchSize));
        }

        freshPatients = (await Promise.all(
          patientBatches.map((ids) => base44.entities.Patient.filter({ id: { $in: ids } }))
        )).flat().filter(Boolean);

        if (freshPatients.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, freshPatients);
        }
      }

      const [offlineDeliveriesRaw, freshAppUsers, freshCities, freshStores] = await Promise.all([
        offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr),
        offlineDB.getAll(offlineDB.STORES.APP_USERS).then((r) => (r || []).filter((u) => u?.user_id && u.user_id !== 'undefined')),
        offlineDB.getAll(offlineDB.STORES.CITIES),
        offlineDB.getAll(offlineDB.STORES.STORES)
      ]);

      const offlineDeliveries = Array.isArray(offlineDeliveriesRaw)
        ? offlineDeliveriesRaw.filter((d) => {
            if (!d) return false;
            if (cityStoreIds.length > 0 && !cityStoreIds.includes(d.store_id)) return false;
            if (uiDriverFilter && d.driver_id !== uiDriverFilter) return false;
            return true;
          })
        : [];

      const safeAppUsers = Array.isArray(freshAppUsers)
        ? freshAppUsers.filter((u) => u?.user_id && u.user_id !== 'undefined' && u?.user_name && u.user_name !== 'undefined')
        : [];

      // Dispatch one final UI update with the full synced dataset
      window.dispatchEvent(new CustomEvent('pullToSyncDataReady', {
        detail: { 
          deliveryDate: selectedDateStr,
          deliveries: offlineDeliveries,
          appUsers: safeAppUsers,
          cities: freshCities,
          stores: freshStores,
          patients: freshPatients,
          triggeredBy: 'pullToSync',
          batchedUiUpdate: true,
          syncRunId
        }
      }));

      if (onSyncComplete) {
        await onSyncComplete(offlineDeliveries, freshPatients, safeAppUsers);
      }

      // Mark UI sync complete + release overlay
      try { window.__dashboardSyncing = false; } catch (e) {}
      window.dispatchEvent(new CustomEvent('offlineSyncComplete'));
      window.dispatchEvent(new CustomEvent('pullToSyncComplete', { detail: { batchedUiUpdate: true, syncRunId } }));

      if (!silent) {
        toast.success('Data synced', {
          description: `${freshDeliveries?.length || 0} deliveries updated`
        });
      }

      await offlineDB.deduplicateDeliveries().catch(() => {});

      const currentFABPhase = window.__currentFABPhase || 1;
      if (currentFABPhase !== 1) {
        const { fabControlEvents } = await import('@/components/utils/fabControlEvents');
        fabControlEvents.notifyDataReady();
      }

    } catch (error) {
      console.error('❌ [Pull to Sync] Sync failed:', error);
      try { window.__dashboardSyncing = false; window.dispatchEvent(new CustomEvent('pullToSyncComplete')); } catch (e) {}
      if (!silent) {
        toast.error('Sync failed', { description: error.message });
      }
    } finally {
      setTimeout(() => {
        setIsSyncing(false);
        setShowOverlay(false);
        setPullDistance(0);
        setIsPulling(false);
        try {
          window.__dashboardSyncing = false;
          if (window.__activePullToSyncRunId === syncRunId) {
            window.__activePullToSyncRunId = null;
          }
        } catch (e) {}
      }, 500);
    }
  };

  // Listen for silent sync trigger (e.g., after AppUser updates)
  useEffect(() => {
    const handleSilentSync = async () => {
      if (isSyncing || (window.__dashboardSyncing && window.__activePullToSyncRunId)) return;
      console.log('🔇 [PullToSync] Silent sync triggered after AppUser update');
      await performSync(true);
    };

    const handleSmartRefreshComplete = () => {
      setIsSyncing(false);
      setShowOverlay(false);
      setPullDistance(0);
      setIsPulling(false);
    };

    window.addEventListener('triggerSilentSync', handleSilentSync);
    window.addEventListener('smartRefreshComplete', handleSmartRefreshComplete);
    window.addEventListener('lightweightRefreshComplete', handleSmartRefreshComplete);
    window.addEventListener('offlineSyncComplete', handleSmartRefreshComplete);
    return () => {
      window.removeEventListener('triggerSilentSync', handleSilentSync);
      window.removeEventListener('smartRefreshComplete', handleSmartRefreshComplete);
      window.removeEventListener('lightweightRefreshComplete', handleSmartRefreshComplete);
      window.removeEventListener('offlineSyncComplete', handleSmartRefreshComplete);
    };
  }, [isSyncing]);

  const pullProgress = Math.min(pullDistance / syncThreshold, 1);
  const rotation = pullProgress * 360;

  return (
    <>

      {/* Pull indicator - mobile only, positioned beside refresh spinner */}
      <AnimatePresence>
        {(isPulling || isSyncing) && (
          <motion.div
            initial={{ opacity: 0, y: -10, x: -8 }}
            animate={{ opacity: 1, y: 0, x: 0 }}
            exit={{ opacity: 0, y: -10, x: -8 }}
            className="absolute top-2 left-[16.75rem] z-20 pointer-events-none flex justify-start md:hidden"
          >
            <div 
              className="flex items-center gap-2 px-4 py-2 rounded-full shadow-lg border backdrop-blur-sm"
              style={{
                background: 'var(--bg-white)',
                borderColor: 'var(--border-slate-200)',
                opacity: 1
              }}
            >
              <RefreshCw 
                className="w-4 h-4"
                style={{ 
                  color: isSyncing || pullProgress >= 1 ? 'var(--text-emerald-600)' : 'var(--text-slate-500)',
                  transform: isSyncing ? undefined : `rotate(${rotation}deg)`,
                  animation: isSyncing ? 'spin 1s linear infinite' : undefined
                }}
              />
              <span 
                className="text-sm font-medium"
                style={{ color: 'var(--text-slate-700)' }}
              >
                {isSyncing ? 'Syncing...' : pullProgress >= 1 ? 'Release to sync' : 'Pull to sync'}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Full-screen loading overlay during sync - desktop/tablet only */}
      <AnimatePresence>
        {showOverlay && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[1000] hidden md:flex items-center justify-center bg-black/60 backdrop-blur-md pointer-events-none"
          >
            <div 
              className="rounded-2xl shadow-2xl p-6 flex flex-col items-center gap-4"
              style={{ background: 'var(--bg-white)', opacity: 1 }}
            >
              <div 
                className="w-16 h-16 border-4 border-t-transparent rounded-full animate-spin"
                style={{ borderColor: 'var(--border-emerald-500)', borderTopColor: 'transparent' }}
              />
              <div className="text-center">
                <p 
                  className="text-lg font-semibold"
                  style={{ color: 'var(--text-slate-900)' }}
                >
                  Syncing Data
                </p>
                <p 
                  className="text-sm mt-1"
                  style={{ color: 'var(--text-slate-600)' }}
                >
                  Replacing route data and updating patients
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}