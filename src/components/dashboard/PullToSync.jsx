import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw } from 'lucide-react';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { base44 } from '@/api/base44Client';
import { manualSyncSelected } from '@/components/utils/offlineSync';
import calculateRealTimeETA from '@/functions/calculateRealTimeETA';

import { format } from 'date-fns';
import { toast } from 'sonner';
import { globalFilters } from '@/components/utils/globalFilters';

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
      try {
        window.__selectedDashboardDate = selectedDateStr;
        window.__selectedDashboardDriverId = currentDriverId;
        window.__selectedDashboardCityId = currentCityId;
      } catch (e) {}

      await new Promise((resolve) => setTimeout(resolve, silent ? 0 : 400));
      if (window.__dashboardSyncing && window.__activePullToSyncRunId && !silent && window.__activePullToSyncRunId !== syncRunId) {
        return;
      }

      window.dispatchEvent(new CustomEvent('pullToSyncStarted', { detail: { suppressIncrementalUi: true } }));
      const syncResult = await manualSyncSelected(selectedDateStr, currentCityId);
      if (syncResult?.error) {
        throw new Error(syncResult.error);
      }

      const freshDeliveries = Array.isArray(syncResult?.deliveries) ? syncResult.deliveries : [];
      const freshPatients = Array.isArray(syncResult?.patients) ? syncResult.patients : [];
      const freshAppUsers = Array.isArray(syncResult?.appUsers) ? syncResult.appUsers : [];
      const freshCities = Array.isArray(syncResult?.cities) ? syncResult.cities : [];
      const freshStores = Array.isArray(syncResult?.stores) ? syncResult.stores : [];

      const offlineDeliveriesRaw = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
      const offlineDeliveries = Array.isArray(offlineDeliveriesRaw)
        ? offlineDeliveriesRaw.filter((delivery) => !currentCityId || freshStores.some((store) => store?.id === delivery?.store_id && store?.city_id === currentCityId))
        : [];

      const safeAppUsers = Array.isArray(freshAppUsers)
        ? freshAppUsers.filter((u) => u?.user_id && u.user_id !== 'undefined' && u?.user_name && u.user_name !== 'undefined')
        : [];

      // Dispatch one final UI update with the full synced dataset.
      // CRITICAL: preserveLocalState must be FALSE so that a server-authoritative empty result
      // (e.g. all stops deleted on another device) clears the local UI instead of being ignored.
      window.dispatchEvent(new CustomEvent('pullToSyncDataReady', {
        detail: { 
          deliveryDate: selectedDateStr,
          deliveries: offlineDeliveries,
          appUsers: safeAppUsers,
          cities: freshCities,
          stores: freshStores,
          patients: freshPatients,
          triggeredBy: 'pullToSyncDataReady',
          batchedUiUpdate: true,
          preserveLocalState: false,
          syncRunId
        }
      }));

      if (onSyncComplete) {
        await onSyncComplete(offlineDeliveries, freshPatients, safeAppUsers);
      }

      console.log('🔄 [PullToSync] Final synced delivery set', {
        selectedDateStr,
        currentCityId,
        currentDriverId,
        serverCount: freshDeliveries?.length || 0,
        offlineCount: offlineDeliveries?.length || 0,
        drivers: Array.from(new Set((offlineDeliveries || []).map((delivery) => delivery?.driver_id).filter(Boolean)))
      });

      // Mark UI sync complete + release overlay
      try { window.__dashboardSyncing = false; } catch (e) {}
      window.dispatchEvent(new CustomEvent('pullToSyncComplete', { detail: { batchedUiUpdate: true, syncRunId, preserveLocalState: true, completedAt: Date.now() } }));

      if (!silent) {
        toast.success('Data synced', {
          description: `${freshDeliveries?.length || 0} deliveries updated after purge + resync`
        });
      }

      // Reactivate FAB
      const currentFABPhase = window.__currentFABPhase || 1;
      if (currentFABPhase !== 1) {
        const { fabControlEvents } = await import('@/components/utils/fabControlEvents');
        fabControlEvents.notifyDataReady();
      }

      // ─── STEP 4 (background): Polylines + ETAs for active stops only ────────
      // Runs entirely in background — does NOT block UI
      const targetDriverId = currentDriverId && currentDriverId !== 'all' ? currentDriverId : null;
      if (targetDriverId) {
        Promise.resolve().then(async () => {
          const incompleteDeliveries = (offlineDeliveries || []).filter(d => 
            d && ['in_transit', 'en_route'].includes(d.status)
          );

          if (incompleteDeliveries.length === 0) return;

          const now = new Date();
          const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

          window.dispatchEvent(new CustomEvent('polylineUpdated', {
            detail: { driverId: targetDriverId, deliveryDate: selectedDateStr, source: 'pullToSync' }
          }));

          // ETA recalculation for active stops only
          calculateRealTimeETA({
            driverId: targetDriverId,
            deliveryDate: selectedDateStr,
            currentLocalTime,
            deviceTime: currentLocalTime
          }).then(etaRes => {
            const etaUpdates = etaRes?.data?.durationUpdates || etaRes?.data?.etas || etaRes?.etas || [];
            if (Array.isArray(etaUpdates) && etaUpdates.length > 0) {
              window.dispatchEvent(new CustomEvent('etaUpdated', {
                detail: { updates: etaUpdates.map(u => ({ deliveryId: u.deliveryId || u.delivery_id, newEta: u.eta || u.newETA })) }
              }));
            }
          }).catch(e => console.warn('⚠️ [Pull to Sync] Background ETA update failed:', e?.message));
        }).catch(e => console.warn('⚠️ [Pull to Sync] Background tasks failed:', e?.message));
      }

    } catch (error) {
      console.error('❌ [Pull to Sync] Sync failed:', error);
      try {
        window.__dashboardSyncing = false;
        window.dispatchEvent(new CustomEvent('pullToSyncComplete', { detail: { syncRunId, failed: true, completedAt: Date.now() } }));
      } catch (e) {}
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

    window.addEventListener('triggerSilentSync', handleSilentSync);
    return () => window.removeEventListener('triggerSilentSync', handleSilentSync);
  }, [isSyncing]);

  const pullProgress = Math.min(pullDistance / syncThreshold, 1);
  const rotation = pullProgress * 360;

  return (
    <>

      {/* Pull indicator - inside stats card container with higher z-index */}
      <AnimatePresence>
        {isPulling && !isSyncing && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="absolute top-2 left-0 right-0 z-50 pointer-events-none flex justify-center -translate-x-[30px]"
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
                  color: 'var(--text-emerald-600)',
                  transform: `rotate(${rotation}deg)`
                }}
              />
              <span 
                className="text-sm font-medium"
                style={{ color: 'var(--text-slate-700)' }}
              >
                {pullProgress >= 1 ? 'Release to sync' : 'Pull to sync'}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Full-screen loading overlay during sync */}
      <AnimatePresence>
        {showOverlay && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 backdrop-blur-md pointer-events-none"
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
                  Updating deliveries, patients & drivers
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}