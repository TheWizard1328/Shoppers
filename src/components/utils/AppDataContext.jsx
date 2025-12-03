import React, { createContext, useContext } from 'react';
import { smartRefreshManager } from './smartRefreshManager';
import { base44 } from '@/api/base44Client';

const AppDataContext = createContext(null);

export const AppDataProvider = ({ children, value }) => {
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
      const otherDateDeliveries = (value.deliveries || []).filter(d => 
        d && (d.delivery_date !== deliveryDate || d.driver_id !== driverId)
      );
      const mergedDeliveries = [...otherDateDeliveries, ...freshDeliveries];
      
      // CRITICAL: Clear ALL pending updates protection for this driver's route
      freshDeliveries.forEach(d => {
        if (d?.id) {
          smartRefreshManager.pendingLocalUpdates.delete(d.id);
        }
      });
      
      if (value.updateDeliveriesLocally) {
        // CRITICAL: Don't register these as pending updates - we want them to display immediately
        const originalUpdateFn = value.updateDeliveriesLocally;
        value.updateDeliveriesLocally(mergedDeliveries);
        console.log(`✅ [Force Refresh] Updated context with ${mergedDeliveries.length} total deliveries`);
      }
      
      return freshDeliveries;
    } catch (error) {
      console.error('❌ [Force Refresh] Failed to fetch deliveries:', error);
      throw error;
    }
  };

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
  
  const wrappedValue = {
    ...value,
    forceRefreshDriverDeliveries,
    updateDeliveriesLocally: wrappedUpdateDeliveriesLocally
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