import React, { createContext, useContext } from 'react';
import { smartRefreshManager } from './smartRefreshManager';

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
  
  const wrappedValue = {
    ...value,
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