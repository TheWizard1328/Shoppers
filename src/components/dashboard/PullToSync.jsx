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

  const performSync = async () => {
    setIsSyncing(true);
    console.log('🔄 [Pull to Sync] Starting full offline database sync...');

    try {
      // CRITICAL: Pause all background managers to prevent data overwrites
      console.log('⏸️ [Pull to Sync] Pausing background managers...');

      // Pause smart refresh manager
      if (window.smartRefreshManager?.pause) {
        window.smartRefreshManager.pause();
      }

      // Pause subscriptions by pausing the realtimeSync manager
      if (window.realtimeSyncManager?.pause) {
        window.realtimeSyncManager.pause();
      }

      // Pause background sync
      if (window.backgroundSyncManager?.pause) {
        window.backgroundSyncManager.pause();
      }
      const selectedDateStr = format(selectedDate, 'yyyy-MM-dd');
      
      // Get city's store IDs for filtering
      const cityStores = await base44.entities.Store.filter({ city_id: selectedCityId });
      const cityStoreIds = cityStores.map(s => s.id);
      
      console.log(`📅 [Pull to Sync] Syncing for date: ${selectedDateStr}, city: ${selectedCityId}`);
      console.log(`🏪 [Pull to Sync] City has ${cityStoreIds.length} stores`);

      // STEP 1: Purge deliveries for selected date/city from offline DB
      console.log('🗑️ [Pull to Sync] Purging deliveries for selected date...');
      const deleteResult = await offlineDB.deleteDeliveriesByDate(selectedDateStr);
      console.log(`✅ [Pull to Sync] Deleted ${deleteResult?.deletedCount || 0} deliveries from offline DB`);

      // STEP 2: Fetch fresh deliveries for ALL drivers in selected city/date
      console.log('📥 [Pull to Sync] Fetching fresh deliveries from backend...');
      const freshDeliveries = cityStoreIds.length > 0 
        ? await base44.entities.Delivery.filter({ 
            delivery_date: selectedDateStr,
            store_id: { $in: cityStoreIds }
          })
        : await base44.entities.Delivery.filter({ delivery_date: selectedDateStr });
      
      console.log(`✅ [Pull to Sync] Fetched ${freshDeliveries.length} deliveries`);

      // STEP 3: Save deliveries to offline DB in one shot
      if (freshDeliveries.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
        console.log(`✅ [Pull to Sync] Saved ${freshDeliveries.length} deliveries to offline DB`);
      }

      // STEP 4: Get unique patient IDs and fetch related patients
      const uniquePatientIds = [...new Set(
        freshDeliveries
          .filter(d => d?.patient_id)
          .map(d => d.patient_id)
      )];
      
      if (uniquePatientIds.length > 0) {
        console.log(`📥 [Pull to Sync] Fetching ${uniquePatientIds.length} patients...`);
        const freshPatients = await base44.entities.Patient.filter({ 
          id: { $in: uniquePatientIds } 
        });
        
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, freshPatients);
        console.log(`✅ [Pull to Sync] Saved ${freshPatients.length} patients to offline DB`);
      }

      // STEP 5: Clear ALL AppUsers from offline DB
      console.log('🗑️ [Pull to Sync] Clearing all AppUsers from offline DB...');
      await offlineDB.clearStore(offlineDB.STORES.APP_USERS);
      console.log('✅ [Pull to Sync] Cleared AppUsers from offline DB');

      // STEP 6: Fetch ALL AppUsers and save in one shot
      console.log('📥 [Pull to Sync] Fetching ALL AppUsers from backend...');
      const freshAppUsers = await base44.entities.AppUser.list();
      
      if (freshAppUsers.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, freshAppUsers);
        console.log(`✅ [Pull to Sync] Saved ${freshAppUsers.length} AppUsers to offline DB`);
      }

      // STEP 7: Trigger UI update with fresh data
      console.log('🔄 [Pull to Sync] Triggering UI update...');
      
      // Dispatch events to update map markers and deliveries
      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
        detail: { appUsers: freshAppUsers, forceAll: true }
      }));
      
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { 
          deliveryDate: selectedDateStr, 
          triggeredBy: 'pullToSync',
          allDrivers: true 
        }
      }));

      // Callback to parent component for additional refresh logic
      if (onSyncComplete) {
        await onSyncComplete(freshDeliveries, freshPatients, freshAppUsers);
      }

      console.log('✅ [Pull to Sync] Sync complete!');
      toast.success('Data synced', {
        description: `${freshDeliveries.length} deliveries, ${uniquePatientIds.length} patients, ${freshAppUsers.length} users`
      });

      } catch (error) {
      // Resume managers even on error
      console.log('⏸️ [Pull to Sync] Resuming managers after error...');
      if (window.smartRefreshManager?.resume) {
        window.smartRefreshManager.resume();
      }
      if (window.realtimeSyncManager?.resume) {
        window.realtimeSyncManager.resume();
      }
      if (window.backgroundSyncManager?.resume) {
        window.backgroundSyncManager.resume();
      }
      console.error('❌ [Pull to Sync] Sync failed:', error);
      toast.error('Sync failed', {
        description: error.message
      });
    } finally {
      // Resume all background managers after sync
      console.log('▶️ [Pull to Sync] Resuming managers...');
      if (window.smartRefreshManager?.resume) {
        window.smartRefreshManager.resume();
      }
      if (window.realtimeSyncManager?.resume) {
        window.realtimeSyncManager.resume();
      }
      if (window.backgroundSyncManager?.resume) {
        window.backgroundSyncManager.resume();
      }

      // Small delay before removing loading indicator
      setTimeout(() => {
        setIsSyncing(false);
        setPullDistance(0);
        setIsPulling(false);
      }, 500);
    }
  };

  const pullProgress = Math.min(pullDistance / syncThreshold, 1);
  const rotation = pullProgress * 360;

  return (
    <>

      {/* Pull indicator */}
      <AnimatePresence>
        {(isPulling || isSyncing) && (
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-2 left-0 right-0 z-[602] pointer-events-none flex justify-center"
          >
            <div className="flex items-center gap-2 px-4 py-2 rounded-full shadow-lg border bg-white/95 backdrop-blur-sm">
              <RefreshCw 
                className="w-4 h-4 text-emerald-600"
                style={{ 
                  transform: isSyncing ? undefined : `rotate(${rotation}deg)`,
                  animation: isSyncing ? 'spin 1s linear infinite' : undefined
                }}
              />
              <span className="text-sm font-medium text-slate-700">
                {isSyncing ? 'Syncing...' : pullProgress >= 1 ? 'Release to sync' : 'Pull to sync'}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Full-screen loading overlay during sync */}
      <AnimatePresence>
        {isSyncing && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/20 backdrop-blur-sm pointer-events-none"
          >
            <div className="bg-white rounded-2xl shadow-2xl p-6 flex flex-col items-center gap-4">
              <div className="w-16 h-16 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <div className="text-center">
                <p className="text-lg font-semibold text-slate-900">Syncing Data</p>
                <p className="text-sm text-slate-600 mt-1">Updating deliveries, patients & drivers</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}