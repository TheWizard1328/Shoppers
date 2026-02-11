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
    console.log(`🔄 [Pull to Sync] Starting ${silent ? 'silent' : 'full'} targeted refresh...`);

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
      
      console.log(`🎯 [Pull to Sync] Targeted refresh: date=${selectedDateStr}, city=${selectedCityId}`);

      // CRITICAL: Use backend function for clean, rate-limit-free data fetch
      const { performTargetedRefresh } = await import('@/functions/performTargetedRefresh');
      const response = await performTargetedRefresh({
        cityId: selectedCityId,
        deliveryDate: selectedDateStr
      });

      const { data } = response;
      if (!data) {
        throw new Error('No data returned from targeted refresh');
      }

      const { deliveries: freshDeliveries, patients: freshPatients, appUsers: freshAppUsers, stores: freshStores } = data;
      
      console.log(`✅ [Pull to Sync] Received: ${freshDeliveries?.length || 0} deliveries, ${freshPatients?.length || 0} patients, ${freshAppUsers?.length || 0} drivers, ${freshStores?.length || 0} stores`);

      // STEP 1: Clear and save deliveries
      console.log('💾 [Pull to Sync] Clearing deliveries for selected date...');
      const deleteResult = await offlineDB.deleteDeliveriesByDate(selectedDateStr);
      console.log(`✅ [Pull to Sync] Deleted ${deleteResult?.deletedCount || 0} old deliveries`);

      if (freshDeliveries && freshDeliveries.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
        console.log(`✅ [Pull to Sync] Saved ${freshDeliveries.length} deliveries to offline DB`);
      }

      // STEP 2: Save patients
      if (freshPatients && freshPatients.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, freshPatients);
        console.log(`✅ [Pull to Sync] Saved ${freshPatients.length} patients to offline DB`);
      }

      // STEP 3: Clear and save AppUsers
      console.log('🗑️ [Pull to Sync] Clearing all AppUsers...');
      await offlineDB.clearStore(offlineDB.STORES.APP_USERS);
      
      if (freshAppUsers && freshAppUsers.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, freshAppUsers);
        console.log(`✅ [Pull to Sync] Saved ${freshAppUsers.length} AppUsers to offline DB`);
      }

      // STEP 4: Save stores
      if (freshStores && freshStores.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.STORES, freshStores);
        console.log(`✅ [Pull to Sync] Saved ${freshStores.length} stores to offline DB`);
      }

      // STEP 6.5: Update current driver's location from primary tracking device
      const { locationTracker } = await import('@/components/utils/locationTracker');
      
      if (locationTracker.isTracking && window.__currentUser) {
        const currentAppUser = freshAppUsers.find(u => u.user_id === window.__currentUser.user_id);
        
        if (currentAppUser && locationTracker.lastKnownLocation) {
          console.log('📍 [Pull to Sync] Updating current driver location from primary tracking device...');
          
          const locationUpdate = {
            current_latitude: locationTracker.lastKnownLocation.latitude,
            current_longitude: locationTracker.lastKnownLocation.longitude,
            location_updated_at: new Date().toISOString()
          };

          // Update online database
          try {
            await base44.entities.AppUser.update(currentAppUser.id, locationUpdate);
            console.log('✅ [Pull to Sync] Updated online AppUser with fresh location');
          } catch (error) {
            console.warn('⚠️ [Pull to Sync] Failed to update online AppUser:', error.message);
          }

          // Update offline database
          const updatedAppUser = { ...currentAppUser, ...locationUpdate };
          await offlineDB.save(offlineDB.STORES.APP_USERS, updatedAppUser);
          
          // Update in-memory array for subsequent processing
          const userIndex = freshAppUsers.findIndex(u => u.id === currentAppUser.id);
          if (userIndex !== -1) {
            freshAppUsers[userIndex] = updatedAppUser;
          }
          
          console.log('✅ [Pull to Sync] Updated offline AppUser with fresh location');
        }
      }

      // STEP 7: Trigger UI update with fresh data from offline database
      console.log('🔄 [Pull to Sync] Triggering UI update with fresh offline data...');
      
      // Load fresh AppUsers from offline DB (includes updated location)
      const offlineAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
      
      // Dispatch events to update map markers and deliveries
      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
        detail: { appUsers: offlineAppUsers, forceAll: true }
      }));
      
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { 
          deliveryDate: selectedDateStr, 
          triggeredBy: 'pullToSync',
          allDrivers: true 
        }
      }));

      // CRITICAL: Process driver locations through poller with fresh offline data
      try {
        const { driverLocationPoller } = await import('@/components/utils/driverLocationPoller');
        
        driverLocationPoller.processLocationData(
          window.__currentUser, 
          freshDeliveries, 
          [], // drivers loaded from context
          [], // stores loaded from context
          offlineAppUsers, // Use fresh offline data with updated location
          selectedDate, 
          true // forceNotify
        );
        console.log('✅ [Pull to Sync] Processed driver locations through poller with offline data');
      } catch (pollerError) {
        console.warn('⚠️ [Pull to Sync] Failed to process through poller:', pollerError.message);
      }

      // CRITICAL: Refresh polylines for all drivers with fresh offline data
      try {
        const { routePolylineManager } = await import('@/components/utils/routePolylineManager');
        const uniqueDriverIds = [...new Set(freshDeliveries.map(d => d.driver_id).filter(Boolean))];
        
        for (const driverId of uniqueDriverIds) {
          await routePolylineManager.resetAndRefresh(driverId, selectedDateStr);
        }
        console.log(`✅ [Pull to Sync] Refreshed polylines for ${uniqueDriverIds.length} drivers`);
      } catch (polylineError) {
        console.warn('⚠️ [Pull to Sync] Failed to refresh polylines:', polylineError.message);
      }

      // CRITICAL: Check current FAB phase before reactivation
      const currentFABPhase = window.__currentFABPhase || 1;
      
      // Callback to parent component with fresh offline data
      const finalAppUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
      
      if (onSyncComplete) {
        await onSyncComplete(freshDeliveries, freshPatients, finalAppUsers);
      }

      console.log(`✅ [Pull to Sync] ${silent ? 'Silent sync' : 'Sync'} complete!`);
      
      // CRITICAL: Only reactivate FAB if NOT on phase 1
      if (currentFABPhase !== 1) {
        console.log(`📍 [Pull to Sync] Reactivating FAB (was on phase ${currentFABPhase})`);
        const { fabControlEvents } = await import('@/components/utils/fabControlEvents');
        fabControlEvents.notifyDataReady();
      } else {
        console.log('⏭️ [Pull to Sync] Skipping FAB reactivation - already on phase 1');
      }
      
      if (!silent) {
        toast.success('Data synced', {
          description: `${freshDeliveries.length} deliveries, ${uniquePatientIds.length} patients, ${freshAppUsers.length} users`
        });
      }

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
      if (!silent) {
        toast.error('Sync failed', {
          description: error.message
        });
      }
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
        setShowOverlay(false);
        setPullDistance(0);
        setIsPulling(false);
      }, 500);
    }
  };

  // Listen for silent sync trigger (e.g., after AppUser updates)
  useEffect(() => {
    const handleSilentSync = async () => {
      console.log('🔇 [PullToSync] Silent sync triggered after AppUser update');
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