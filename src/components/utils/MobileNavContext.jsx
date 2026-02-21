import React, { createContext, useContext, useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const MobileNavContext = createContext();

export function MobileNavProvider({ children }) {
  const location = useLocation();
  const [tabState, setTabState] = useState({
    Dashboard: { path: '/Dashboard', scrollY: 0 },
    Patients: { path: '/Patients', scrollY: 0 },
    Deliveries: { path: '/Deliveries', scrollY: 0 },
    DeviceSettings: { path: '/DeviceSettings', scrollY: 0 }
  });
  const [lastActiveTab, setLastActiveTab] = useState('Dashboard');

  // Determine current tab based on location
  const currentTab = location.pathname.split('/').pop() || 'Dashboard';

  // Update tab state when navigating
  useEffect(() => {
    const mainTab = getMainTab(currentTab);
    setLastActiveTab(mainTab);
  }, [currentTab]);

  const getMainTab = (pageName) => {
    if (pageName === 'Dashboard') return 'Dashboard';
    if (pageName === 'Patients') return 'Patients';
    if (['Deliveries'].includes(pageName)) return 'Deliveries';
    if (['DeviceSettings'].includes(pageName)) return 'DeviceSettings';
    
    // For nested routes, return the parent tab
    if (pageName.includes('Patient') || pageName.includes('patient')) return 'Patients';
    if (pageName.includes('Delivery') || pageName.includes('delivery')) return 'Deliveries';
    
    return 'Dashboard';
  };

  const saveTabState = (tabName, path) => {
    setTabState(prev => ({
      ...prev,
      [tabName]: { ...prev[tabName], path, scrollY: window.scrollY }
    }));
  };

  const navigateToTab = (tabName, path) => {
    saveTabState(tabName, path);
  };

  const getTabPath = (tabName) => {
    return tabState[tabName]?.path || `/` + tabName;
  };

  return (
    <MobileNavContext.Provider value={{
      tabState,
      lastActiveTab,
      saveTabState,
      navigateToTab,
      getTabPath,
      getMainTab,
      currentTab: getMainTab(currentTab)
    }}>
      {children}
    </MobileNavContext.Provider>
  );
}

export function useMobileNav() {
  const context = useContext(MobileNavContext);
  if (!context) {
    throw new Error('useMobileNav must be used within MobileNavProvider');
  }
  return context;
}