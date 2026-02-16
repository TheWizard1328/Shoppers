import { createContext, useContext, useEffect } from 'react';
import { smartRefreshManager } from './smartRefreshManager';
import { base44 } from '@/api/base44Client';
import { cityFilteredRealtimeSync } from './cityFilteredRealtimeSync';

const AppDataContext = createContext(null);

export const AppDataProvider = ({ children, value }) => {
  // CRITICAL: Set up city-filtered real-time subscriptions
  useEffect(() => {
    if (!value.currentUser || !value.selectedCityId || !value.selectedDate) {
      return;
    }

    // Get user's city IDs for filtering AppUser updates
    const userCityIds = value.currentUser.city_ids || (value.currentUser.city_id ? [value.currentUser.city_id] : []);
    
    // Start real-time subscriptions
    cityFilteredRealtimeSync.start(value.selectedCityId, value.selectedDate);

    // Subscribe to real-time updates
    const unsubscribe = cityFilteredRealtimeSync.subscribe(({ entityType, eventType, data }) => {
      if (entityType === 'Delivery') {
        // CRITICAL: Refresh entire data context on any delivery change to ensure UI consistency
        value.refreshData();
        smartRefreshManager.notifyRealtimeUpdate('Delivery');
      } else if (entityType === 'AppUser') {
        // CRITICAL: Dispatch location update event IMMEDIATELY for map markers and badges
        if (typeof window !== 'undefined') {
          const coords = `${data.current_latitude?.toFixed(6)}, ${data.current_longitude?.toFixed(6)}`;
          console.log(`📡 [AppDataContext] Dispatching driverLocationsUpdated for ${data.user_name} with coords ${coords}`);
          window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
            detail: { appUsers: [data], singleUpdate: true, fromRealtime: true }
          }));
          
          window.dispatchEvent(new CustomEvent('appUserUpdated', {
            detail: { appUser: data, fromRealtime: true }
          }));
        }
        
        // CRITICAL: Refresh entire data context to ensure UI consistency
        value.refreshData();
        smartRefreshManager.notifyRealtimeUpdate('AppUser');
      }
    });

    return () => {
      unsubscribe();
      cityFilteredRealtimeSync.stop();
    };
  }, [value.currentUser?.id, value.selectedCityId, value.selectedDate, value.updateDeliveriesLocally, value.updateAppUsersLocally, value.deliveries, value.appUsers]);
  
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