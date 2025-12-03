import React, { createContext, useContext } from 'react';
import { smartRefreshManager } from './smartRefreshManager';
import { base44 } from '@/api/base44Client';

const AppDataContext = createContext(null);

export const AppDataProvider = ({ children, value }) => {
  // Wrap updateDeliveriesLocally to register pending updates
  const wrappedUpdateDeliveriesLocally = (updates) => {
    if (value.updateDeliveriesLocally) {
      // Register all updated delivery IDs as pending
      updates.forEach(update => {
        if (update.id) {
          smartRefreshManager.registerPendingUpdate(update.id);
        }
      });
      
      // Call the original function
      value.updateDeliveriesLocally(updates);
    }
  };
  
  // CRITICAL: Direct data refresh for a specific driver and date (bypasses isEntityUpdating flag)
  const forceRefreshDriverDeliveries = async (driverId, deliveryDate) => {
    console.log(`🔄 [Force Refresh] Fetching latest deliveries for driver ${driverId} on ${deliveryDate}...`);
    
    try {
      const freshDeliveries = await base44.entities.Delivery.filter({
        driver_id: driverId,
        delivery_date: deliveryDate
      });
      
      console.log(`✅ [Force Refresh] Got ${freshDeliveries.length} deliveries from database`);
      
      // CRITICAL: ALWAYS update state, even if freshDeliveries is empty
      // This ensures removed deliveries are properly cleared from UI
      const otherDeliveries = (value.deliveries || []).filter(d => 
        d && (d.delivery_date !== deliveryDate || d.driver_id !== driverId)
      );
      const mergedDeliveries = [...otherDeliveries, ...freshDeliveries];
      
      // CRITICAL: Clear pending updates protection for this driver's route
      // This ensures the fresh data is not blocked by the protection mechanism
      freshDeliveries.forEach(d => {
        if (d?.id) {
          smartRefreshManager.pendingLocalUpdates.delete(d.id);
        }
      });
      
      if (value.updateDeliveriesLocally) {
        // Call directly without wrapper to bypass pending update registration
        value.updateDeliveriesLocally(mergedDeliveries);
        console.log(`✅ [Force Refresh] Updated context with ${mergedDeliveries.length} total deliveries`);
      }
      
      return freshDeliveries;
    } catch (error) {
      console.error('❌ [Force Refresh] Failed to fetch deliveries:', error);
      throw error;
    }
  };
  
  const wrappedValue = {
    ...value,
    updateDeliveriesLocally: wrappedUpdateDeliveriesLocally,
    forceRefreshDriverDeliveries
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