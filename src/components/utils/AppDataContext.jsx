import { createContext, useContext } from 'react';
import { smartRefreshManager } from './smartRefreshManager';
import { base44 } from '@/api/base44Client';

const AppDataContext = createContext(null);

export const AppDataProvider = ({ children, value }) => {
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
    console.log(`🔄 [Force Refresh] Fetching latest deliveries for driver ${driverId} on ${deliveryDate}...`);

    try {
      const freshDeliveriesForDriver = await base44.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      });

      console.log(`✅ [Force Refresh] Got ${freshDeliveriesForDriver.length} deliveries from database`);

      // CRITICAL: Clear ALL pending updates for this driver/route FIRST
      smartRefreshManager.clearPendingUpdatesForDriver(driverId, deliveryDate);

      // CRITICAL: INTELLIGENT MERGE - preserve UI state, only update changed records
      const currentDeliveries = value.deliveries || [];

      // Build a map of fresh deliveries by ID for fast lookup
      const freshMap = new Map(freshDeliveriesForDriver.map(d => [d.id, d]));

      // Keep deliveries from other dates/drivers unchanged
      const otherDeliveries = currentDeliveries.filter(d => 
        d && (d.delivery_date !== deliveryDate || d.driver_id !== driverId)
      );

      // Get current deliveries for this driver/date
      const currentRouteDeliveries = currentDeliveries.filter(d =>
        d && d.delivery_date === deliveryDate && d.driver_id === driverId
      );

      // Merge: use fresh data but preserve temp IDs and pending local changes
      const mergedRouteDeliveries = [];

      // Update existing deliveries
      currentRouteDeliveries.forEach(current => {
        const fresh = freshMap.get(current.id);
        if (fresh) {
          mergedRouteDeliveries.push(fresh);
          freshMap.delete(current.id); // Mark as processed
        } else if (current.id?.startsWith('temp_')) {
          // Keep temp records (not yet synced)
          mergedRouteDeliveries.push(current);
        }
        // Deleted on server - don't include
      });

      // Add new deliveries from server
      freshMap.forEach(fresh => {
        mergedRouteDeliveries.push(fresh);
      });

      const finalDeliveries = [...otherDeliveries, ...mergedRouteDeliveries].filter(Boolean);

      if (value.updateDeliveriesLocally) {
        // CRITICAL: Use FALSE for isFullReplacement to preserve UI state
        value.updateDeliveriesLocally(finalDeliveries, false);
        console.log(`✅ [Force Refresh] Intelligently merged ${mergedRouteDeliveries.length} route deliveries (total: ${finalDeliveries.length})`);
      }

      return freshDeliveriesForDriver;
    } catch (error) {
      console.error('❌ [Force Refresh] Failed to fetch deliveries:', error);
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