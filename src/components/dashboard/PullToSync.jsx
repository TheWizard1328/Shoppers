import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw } from 'lucide-react';
import { offlineDB } from '@/components/utils/offlineDatabase';
import { base44 } from '@/api/base44Client';
import { format } from 'date-fns';
import { toast } from 'sonner';

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
      console.log(`🔄 [PullToSync] Sync triggered programmatically (silent: ${silent})`);
      await performSync(silent);
    };

    window.addEventListener('triggerPullToSync', handleTriggerSync);
    return () => window.removeEventListener('triggerPullToSync', handleTriggerSync);
  }, []);

  const performSync = async (silent = false) => {
    setIsSyncing(true);
    setShowOverlay(!silent);
    try { window.__dashboardSyncing = true; window.dispatchEvent(new CustomEvent('pullToSyncStarted')); } catch (e) {}

    try {
      const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
      const driverFilter = selectedDriverId && selectedDriverId !== 'all' 
        ? { driver_id: selectedDriverId } 
        : {};

      // ─── STEP 1: Fetch deliveries for selected driver + date ───────────────
      window.dispatchEvent(new CustomEvent('pullToSyncStarted', { detail: { suppressIncrementalUi: true } }));
      const freshDeliveries = await base44.entities.Delivery.filter({ 
        delivery_date: selectedDateStr,
        ...driverFilter
      });

      // FULL REPLACEMENT: Delete all offline deliveries for this date, then save fresh ones.
      // This ensures deletions and driver transfers are properly reflected.
      if (selectedDriverId && selectedDriverId !== 'all') {
        // Driver-specific sync: only delete that driver's records for this date
        const existingForDate = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
        const driverRecords = (existingForDate || []).filter(d => d?.driver_id === selectedDriverId);
        await Promise.all(
          driverRecords.map(d => offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, d.id).catch(() => {}))
        );
      } else {
        // All-drivers sync: wipe the entire date using the efficient cursor-based delete
        await offlineDB.deleteDeliveriesByDate(selectedDateStr).catch(() => {});
      }

      // Save fresh records from server
      if (freshDeliveries?.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
      }
      await offlineDB.updateSyncMetadata(
        'Delivery',
        new Date().toISOString(),
        new Date().toISOString(),
        { synced_delivery_date: selectedDateStr }
      );

      // ─── STEP 2: Sync patients for those deliveries ────────────────────────
      const patientIds = Array.from(
        new Set((freshDeliveries || []).filter(d => d?.patient_id).map(d => d.patient_id))
      );

      let freshPatients = [];
      if (patientIds.length > 0) {
        const batchSize = 50;
        const batches = [];
        for (let i = 0; i < patientIds.length; i += batchSize) {
          batches.push(patientIds.slice(i, i + batchSize));
        }
        freshPatients = (await Promise.all(
          batches.map(ids => base44.entities.Patient.filter({ id: { $in: ids } }))
        )).flat().filter(Boolean);

        if (freshPatients.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, freshPatients);
        }
      }

      // ─── STEP 3: Load from offline DB + update UI ─────────────────────────
      const [offlineDeliveries, freshAppUsers, freshCities, freshStores] = await Promise.all([
        offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr),
        offlineDB.getAll(offlineDB.STORES.APP_USERS).then(r => (r || []).filter(u => u?.user_id && u.user_id !== 'undefined')),
        offlineDB.getAll(offlineDB.STORES.CITIES),
        offlineDB.getAll(offlineDB.STORES.STORES)
      ]);

      // Dispatch one final UI update with the full synced dataset
      window.dispatchEvent(new CustomEvent('pullToSyncDataReady', {
        detail: { 
          deliveryDate: selectedDateStr,
          deliveries: offlineDeliveries,
          appUsers: freshAppUsers,
          cities: freshCities,
          stores: freshStores,
          patients: freshPatients,
          triggeredBy: 'pullToSync',
          batchedUiUpdate: true
        }
      }));

      if (onSyncComplete) {
        await onSyncComplete(offlineDeliveries, freshPatients, freshAppUsers);
      }

      // Mark UI sync complete + release overlay
      try { window.__dashboardSyncing = false; } catch (e) {}
      window.dispatchEvent(new CustomEvent('pullToSyncComplete', { detail: { batchedUiUpdate: true } }));

      if (!silent) {
        toast.success('Data synced', {
          description: `${freshDeliveries?.length || 0} deliveries updated`
        });
      }

      // Reactivate FAB
      const currentFABPhase = window.__currentFABPhase || 1;
      if (currentFABPhase !== 1) {
        const { fabControlEvents } = await import('@/components/utils/fabControlEvents');
        fabControlEvents.notifyDataReady();
      }

      // ─── STEP 4 (background): Polylines + ETAs for incomplete stops ────────
      // Runs entirely in background — does NOT block UI
      const targetDriverId = selectedDriverId && selectedDriverId !== 'all' ? selectedDriverId : null;
      if (targetDriverId) {
        Promise.resolve().then(async () => {
          const incompleteDeliveries = (offlineDeliveries || []).filter(d => 
            d && !['completed', 'failed', 'cancelled'].includes(d.status)
          );

          if (incompleteDeliveries.length === 0) return;

          const now = new Date();
          const currentLocalTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

          // Polyline repair for incomplete stops
          const { repairMissingPolylines } = await import('@/functions/repairMissingPolylines');
          repairMissingPolylines({ driverId: targetDriverId, deliveryDate: selectedDateStr })
            .catch(e => console.warn('⚠️ [Pull to Sync] Background polyline repair failed:', e?.message));

          // ETA recalculation for incomplete stops
          base44.functions.invoke('calculateRealTimeETA', {
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
        try { window.__dashboardSyncing = false; } catch (e) {}
      }, 500);
    }
  };

  // Listen for silent sync trigger (e.g., after AppUser updates)
  useEffect(() => {
    const handleSilentSync = async () => {
      console.log('🔇 [PullToSync] Silent sync triggered after AppUser update');
      try { window.__dashboardSyncing = true; window.dispatchEvent(new CustomEvent('pullToSyncStarted')); } catch (e) {}
      await performSync(true);
    };

    window.addEventListener('triggerSilentSync', handleSilentSync);
    return () => window.removeEventListener('triggerSilentSync', handleSilentSync);
  }, []);

  const pullProgress = Math.min(pullDistance / syncThreshold, 1);
  const rotation = pullProgress * 360;

  return (
    <>

      {/* Pull indicator - inside stats card container with higher z-index */}
      <AnimatePresence>
        {(isPulling || isSyncing) && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="absolute top-2 left-0 right-0 z-50 pointer-events-none flex justify-center"
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