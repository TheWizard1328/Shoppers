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
      
      console.log(`🎯 [Pull to Sync] Step 1: Fetching ALL deliveries for ${selectedDateStr} from online database...`);

      // STEP 1: Fetch ALL deliveries for selected date directly from online database (all drivers)
      const freshDeliveries = await base44.entities.Delivery.filter({ 
        delivery_date: selectedDateStr 
      });
      console.log(`✅ [Pull to Sync] Step 1: Fetched ${freshDeliveries?.length || 0} deliveries from online database`);

      // STEP 2: Update offline database with fresh deliveries
      console.log('💾 [Pull to Sync] Step 2: Updating offline database with fresh deliveries...');
      const deleteResult = await offlineDB.deleteDeliveriesByDate(selectedDateStr);
      console.log(`   - Deleted ${deleteResult?.deletedCount || 0} old deliveries`);

      if (freshDeliveries && freshDeliveries.length > 0) {
        await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveries);
        console.log(`   ✅ Saved ${freshDeliveries.length} deliveries to offline DB`);
      }

      // STEP 3: Load fresh deliveries from offline DB and update UI
      console.log('🔄 [Pull to Sync] Step 3: Loading deliveries from offline DB for UI update...');
      const offlineDeliveries = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDateStr);
      console.log(`   ✅ Loaded ${offlineDeliveries?.length || 0} deliveries from offline DB`);
      
      // STEP 4: Update UI with deliveries from offline database
      console.log('🖥️ [Pull to Sync] Step 4: Updating UI with offline deliveries...');
      window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
        detail: { 
          deliveryDate: selectedDateStr, 
          triggeredBy: 'pullToSync',
          allDrivers: true 
        }
      }));
      console.log('   ✅ UI update event dispatched')

      // STEP 5: Begin slower, methodical updates for patients, app users, cities, and stores
      console.log('🔄 [Pull to Sync] Step 5: Starting background updates for patients, users, cities, stores...');
      
      // Background update: Fetch and save patients
      base44.entities.Patient.list().then(async (freshPatients) => {
        if (freshPatients && freshPatients.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.PATIENTS, freshPatients);
          console.log(`✅ [Pull to Sync - Background] Saved ${freshPatients.length} patients to offline DB`);
        }
      }).catch((error) => console.warn('⚠️ [Pull to Sync - Background] Patients sync failed:', error.message));

      // Background update: Fetch and save app users
      base44.entities.AppUser.list().then(async (freshAppUsers) => {
        console.log('🗑️ [Pull to Sync - Background] Clearing all AppUsers...');
        await offlineDB.clearStore(offlineDB.STORES.APP_USERS);
        
        if (freshAppUsers && freshAppUsers.length > 0) {
          // Update current driver's location from primary tracking device if available
          const { locationTracker } = await import('@/components/utils/locationTracker');
          if (locationTracker.isTracking && window.__currentUser) {
            const currentAppUser = freshAppUsers.find(u => u.user_id === window.__currentUser.user_id);
            
            if (currentAppUser && locationTracker.lastKnownLocation) {
              console.log('📍 [Pull to Sync - Background] Updating current driver location from primary tracking device...');
              
              currentAppUser.current_latitude = locationTracker.lastKnownLocation.latitude;
              currentAppUser.current_longitude = locationTracker.lastKnownLocation.longitude;
              currentAppUser.location_updated_at = new Date().toISOString();
              
              // Update online database
              try {
                await base44.entities.AppUser.update(currentAppUser.id, {
                  current_latitude: currentAppUser.current_latitude,
                  current_longitude: currentAppUser.current_longitude,
                  location_updated_at: currentAppUser.location_updated_at
                });
                console.log('✅ [Pull to Sync - Background] Updated online AppUser with fresh location');
              } catch (error) {
                console.warn('⚠️ [Pull to Sync - Background] Failed to update online AppUser:', error.message);
              }
            }
          }
          
          await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, freshAppUsers);
          console.log(`✅ [Pull to Sync - Background] Saved ${freshAppUsers.length} AppUsers to offline DB`);
          
          // Dispatch location updates
          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
            detail: { appUsers: freshAppUsers, forceAll: true }
          }));
        }
      }).catch((error) => console.warn('⚠️ [Pull to Sync - Background] AppUsers sync failed:', error.message));

      // Background update: Fetch and save cities
      base44.entities.City.list().then(async (freshCities) => {
        if (freshCities && freshCities.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.CITIES, freshCities);
          console.log(`✅ [Pull to Sync - Background] Saved ${freshCities.length} cities to offline DB`);
        }
      }).catch((error) => console.warn('⚠️ [Pull to Sync - Background] Cities sync failed:', error.message));

      // Background update: Fetch and save stores
      base44.entities.Store.list().then(async (freshStores) => {
        if (freshStores && freshStores.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.STORES, freshStores);
          console.log(`✅ [Pull to Sync - Background] Saved ${freshStores.length} stores to offline DB`);
        }
      }).catch((error) => console.warn('⚠️ [Pull to Sync - Background] Stores sync failed:', error.message));

      // STEP 6: Callback to parent component with deliveries
      if (onSyncComplete) {
        await onSyncComplete(offlineDeliveries, [], []);
      }
      
      // CRITICAL: Dispatch completion event for SmartRefreshIndicator
      window.dispatchEvent(new CustomEvent('pullToSyncComplete'));

      console.log(`✅ [Pull to Sync] ${silent ? 'Silent sync' : 'Sync'} complete!`);
      
      // CRITICAL: Reactivate FAB
      const currentFABPhase = window.__currentFABPhase || 1;
      if (currentFABPhase !== 1) {
        console.log(`📍 [Pull to Sync] Reactivating FAB (was on phase ${currentFABPhase})`);
        const { fabControlEvents } = await import('@/components/utils/fabControlEvents');
        fabControlEvents.notifyDataReady();
      }
      
      if (!silent) {
        toast.success('Data synced', {
          description: `${freshDeliveries.length} deliveries updated`
        });
      }

    } catch (error) {
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