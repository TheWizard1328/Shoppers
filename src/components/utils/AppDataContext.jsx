import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { smartRefreshManager } from './smartRefreshManager';
import { base44 } from '@/api/base44Client';
import { cityFilteredRealtimeSync } from './cityFilteredRealtimeSync';

const AppDataContext = createContext(null);

export const AppDataProvider = ({ children, value }) => {
  // Track last WS delivery update time to prevent stale reconcile from overwriting
  const lastDeliveryWsUpdateRef = useRef(0);
  // Keep refs to mutable values so the subscription closure always has the latest
  // without needing to re-subscribe on every render
  const updateDeliveriesLocallyRef = useRef(value.updateDeliveriesLocally);
  const updateAppUsersLocallyRef = useRef(value.updateAppUsersLocally);
  const deliveriesRef = useRef(value.deliveries);
  const appUsersRef = useRef(value.appUsers);
  
  // Track boot sync per city/date and syncing banner state
  const bootKeyRef = useRef('');
  const [isProgressiveSyncing, setIsProgressiveSyncing] = useState(false);

  // Keep refs in sync with latest values
  useEffect(() => { updateDeliveriesLocallyRef.current = value.updateDeliveriesLocally; }, [value.updateDeliveriesLocally]);
  useEffect(() => { updateAppUsersLocallyRef.current = value.updateAppUsersLocally; }, [value.updateAppUsersLocally]);
  useEffect(() => { deliveriesRef.current = value.deliveries; }, [value.deliveries]);
  useEffect(() => { appUsersRef.current = value.appUsers; }, [value.appUsers]);

  // CRITICAL: Set up city-filtered real-time subscriptions
  useEffect(() => {
    if (!value.currentUser || !value.selectedCityId || !value.selectedDate) {
      return;
    }
    
    // Start real-time subscriptions
    cityFilteredRealtimeSync.start(value.selectedCityId, value.selectedDate);

    // Subscribe to real-time updates
    // CRITICAL: Use refs instead of closure-captured values to always get the latest state
    const unsubscribe = cityFilteredRealtimeSync.subscribe(({ entityType, eventType, data }) => {
      if (entityType === 'Delivery') {
        if (eventType === 'create' || eventType === 'update') {
          // CRITICAL: Record WS update time to prevent reconcile from overwriting with stale data
          lastDeliveryWsUpdateRef.current = Date.now();
          smartRefreshManager.notifyRealtimeDeliveryUpdate && smartRefreshManager.notifyRealtimeDeliveryUpdate();

          // CRITICAL: Use ref to get latest function - avoids stale closure on rapid updates
          if (updateDeliveriesLocallyRef.current) {
            updateDeliveriesLocallyRef.current([data], false);
          }
          
          // CRITICAL: Notify smartRefreshManager to skip next scheduled refresh
          smartRefreshManager.notifyRealtimeUpdate('Delivery');
        } else if (eventType === 'delete') {
          // CRITICAL: Record WS update time
          lastDeliveryWsUpdateRef.current = Date.now();

          // CRITICAL: Use ref to get latest deliveries list for filtering
          if (updateDeliveriesLocallyRef.current && deliveriesRef.current) {
            const filtered = deliveriesRef.current.filter(d => d?.id !== data.id);
            updateDeliveriesLocallyRef.current(filtered, true);
          }
          
          // CRITICAL: Notify smartRefreshManager to skip next scheduled refresh
          smartRefreshManager.notifyRealtimeUpdate('Delivery');
        }
      } else if (entityType === 'AppUser') {
        if (eventType === 'create' || eventType === 'update') {
          const coords = `${data.current_latitude?.toFixed(6)}, ${data.current_longitude?.toFixed(6)}`;
          console.log(`🔔 [AppDataContext] AppUser ${eventType} via realtime - user: ${data.user_name}, coords: ${coords}`);
          
          // CRITICAL: Update appUsers array in context for instant UI updates
          if (updateAppUsersLocallyRef.current) {
            updateAppUsersLocallyRef.current([data], false);
          }
          
          // CRITICAL: Merge this update with existing appUsers before dispatching
          const currentAppUsers = appUsersRef.current || [];
          const updatedAppUsers = currentAppUsers.map(au => au?.id === data.id ? data : au);
          if (!currentAppUsers.some(au => au?.id === data.id)) {
            updatedAppUsers.push(data);
          }
          
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
              detail: { appUsers: updatedAppUsers, singleUpdate: true, fromRealtime: true }
            }));
            window.dispatchEvent(new CustomEvent('appUserUpdated', {
              detail: { appUser: data, fromRealtime: true }
            }));
          }
          
          smartRefreshManager.notifyRealtimeUpdate('AppUser');
        } else if (eventType === 'delete') {
          if (updateAppUsersLocallyRef.current && appUsersRef.current) {
            const filtered = appUsersRef.current.filter(au => au?.id !== data.id);
            updateAppUsersLocallyRef.current(filtered, true);
          }
          smartRefreshManager.notifyRealtimeUpdate('AppUser');
        }
      }
    });

    return () => {
      unsubscribe();
      cityFilteredRealtimeSync.stop();
    };
  // CRITICAL: Only re-subscribe when user/city/date changes - NOT on every delivery/appUser update
  // Using refs above ensures callbacks always see latest data without triggering re-subscriptions
  }, [value.currentUser?.id, value.selectedCityId, value.selectedDate]);
  
  // Offline-first boot for selected date/city
  useEffect(() => {
    const selectedDate = value.selectedDate;
    const selectedCityId = value.selectedCityId;
    if (!value.currentUser || !selectedDate) return;

    const key = `${selectedCityId || 'all'}|${selectedDate}`;
    // Avoid rerunning for the same key during this session
    if (bootKeyRef.current === key) return;
    bootKeyRef.current = key;

    let cancelled = false;
    (async () => {
      try {
        setIsProgressiveSyncing(true);
        const { offlineDB } = await import('./offlineDatabase');

        // 1) Load OFFLINE first in parallel
        const [offlineDeliveries, offlineAppUsers] = await Promise.all([
          offlineDB.getByDate(offlineDB.STORES.DELIVERIES, selectedDate),
          offlineDB.getAll(offlineDB.STORES.APP_USERS).catch(() => [])
        ]);

        if (cancelled) return;

        // Push offline deliveries to UI immediately (merge by date)
        if (Array.isArray(offlineDeliveries) && offlineDeliveries.length > 0 && value.updateDeliveriesLocally) {
          const other = (value.deliveries || []).filter(d => d && d.delivery_date !== selectedDate);
          value.updateDeliveriesLocally([...other, ...offlineDeliveries], true);
        }
        // Push offline app users (best effort)
        if (Array.isArray(offlineAppUsers) && offlineAppUsers.length > 0 && value.updateAppUsersLocally) {
          try { value.updateAppUsersLocally(offlineAppUsers, true); } catch (_) { value.updateAppUsersLocally(offlineAppUsers); }
        }

        // 2) If offline missing or stale, fetch ONLINE progressively and persist
        const needsOnline = !offlineDeliveries || offlineDeliveries.length === 0;
        if (needsOnline) {
          const [onlineDeliveries, onlineAppUsers] = await Promise.all([
            // Minimal online pull scoped by date to reduce rate limits
            base44.entities.Delivery.filter({ delivery_date: selectedDate }),
            base44.entities.AppUser.list().catch(() => [])
          ]);

          if (cancelled) return;

          // Save to offline and refresh UI once
          if (onlineDeliveries && onlineDeliveries.length > 0) {
            await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, onlineDeliveries);
            const other2 = (value.deliveries || []).filter(d => d && d.delivery_date !== selectedDate);
            value.updateDeliveriesLocally([...other2, ...onlineDeliveries], true);
          }
          if (onlineAppUsers && onlineAppUsers.length > 0 && value.updateAppUsersLocally) {
            await offlineDB.bulkSave(offlineDB.STORES.APP_USERS, onlineAppUsers);
            try { value.updateAppUsersLocally(onlineAppUsers, true); } catch (_) { value.updateAppUsersLocally(onlineAppUsers); }
          }
        }
      } catch (e) {
        console.warn('Offline-first boot failed (continuing):', e);
      } finally {
        if (!cancelled) setIsProgressiveSyncing(false);
      }
    })();

    return () => { cancelled = true; };
  // Only react to these keys
  }, [value.currentUser?.id, value.selectedCityId, value.selectedDate]);
  
  // Wrap updateDeliveriesLocally to register pending updates with driver/date context
  const wrappedUpdateDeliveriesLocally = (updates, isFullReplacement = false) => {
    if (value.updateDeliveriesLocally) {
      // CRITICAL: Only register pending updates when NOT doing full replacement
      if (!isFullReplacement && Array.isArray(updates)) {
        updates.forEach(update => {
          if (update && update.id) {
            const driverId = update.driver_id || '';
            const deliveryDate = update.delivery_date || '';
            smartRefreshManager.registerPendingUpdate(update.id, driverId, deliveryDate);
          }
        });
      }
      
      // Call the original function with isFullReplacement flag
      value.updateDeliveriesLocally(updates, isFullReplacement);
    }
  };
  
  // CRITICAL: Direct data refresh for a specific driver and date (bypasses isEntityUpdating flag)
  const forceRefreshDriverDeliveries = async (driverId, deliveryDate) => {
    console.log(`🔄 [Force Refresh] Loading deliveries for driver ${driverId} on ${deliveryDate}...`);
    
    try {
      // CRITICAL: Try offline DB FIRST to prevent rate limits
      const { offlineDB } = await import('./offlineDatabase');
      let freshDeliveriesForDriver = await offlineDB.getByDate(offlineDB.STORES.DELIVERIES, deliveryDate);
      
      if (freshDeliveriesForDriver && freshDeliveriesForDriver.length > 0) {
        // Filter to specific driver from offline data
        freshDeliveriesForDriver = freshDeliveriesForDriver.filter(d => d.driver_id === driverId);
        console.log(`✅ [Force Refresh] Got ${freshDeliveriesForDriver.length} deliveries from offline DB`);
      } else {
        // Fallback to API only if offline DB is empty
        console.log('📥 [Force Refresh] Offline DB empty - fetching from API');
        freshDeliveriesForDriver = await base44.entities.Delivery.filter({
          driver_id: driverId,
          delivery_date: deliveryDate
        });
        
        // CRITICAL: Always save to offline DB immediately after API fetch
        if (freshDeliveriesForDriver && freshDeliveriesForDriver.length > 0) {
          await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, freshDeliveriesForDriver);
          console.log(`💾 [Force Refresh] Saved ${freshDeliveriesForDriver.length} deliveries to offline DB`);
        }
      }
      
      // CRITICAL: Clear ALL pending updates for this driver/route FIRST
      smartRefreshManager.clearPendingUpdatesForDriver(driverId, deliveryDate);
      
      // Construct the new overall deliveries array
      const otherDeliveries = (value.deliveries || []).filter(d => 
        d && (d.delivery_date !== deliveryDate || d.driver_id !== driverId)
      );
      const mergedDeliveries = [...otherDeliveries, ...freshDeliveriesForDriver].filter(Boolean);
      
      if (value.updateDeliveriesLocally) {
        // Full replacement to ensure deletions are reflected
        value.updateDeliveriesLocally(mergedDeliveries, true);
        console.log(`✅ [Force Refresh] Updated context with ${mergedDeliveries.length} total deliveries`);
      }
      
      return freshDeliveriesForDriver;
    } catch (error) {
      console.error('❌ [Force Refresh] Failed to load deliveries:', error);
      throw error;
    }
  };
  
  const wrappedValue = {
    ...value,
    updateDeliveriesLocally: wrappedUpdateDeliveriesLocally,
    forceRefreshDriverDeliveries,
    onSelectedDateDataReady: value.onSelectedDateDataReady,
    setOnSelectedDateDataReady: value.setOnSelectedDateDataReady
  };
  
  return (
    <AppDataContext.Provider value={wrappedValue}>
      {isProgressiveSyncing && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[9999] rounded-full bg-slate-900/90 text-white text-xs px-3 py-1 shadow">
          Syncing…
        </div>
      )}
      {children}
    </AppDataContext.Provider>
  );
};

export const useAppData = () => {
  const context = useContext(AppDataContext);
  if (!context) {
    return {
      deliveries: [],
      patients: [],
      stores: [],
      drivers: [],
      users: [],
      appUsers: [],
      cities: [],
      isDataLoaded: false,
      refreshData: () => {},
      updateDeliveriesLocally: () => {},
      updateAppUsersLocally: () => {},
      forceRefreshDriverDeliveries: async () => {},
      isFormOverlayOpen: false,
      setIsFormOverlayOpen: () => {},
      isEntityUpdating: false,
      setIsEntityUpdating: () => {},
      onSmartRefreshComplete: null,
      setOnSmartRefreshComplete: () => {}
    };
  }
  return context;
};

export { AppDataContext };