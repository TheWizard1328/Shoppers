// REMOVED - No longer used
import React, { createContext, useContext } from 'react';

const MobileNavContext = createContext({});

export function MobileNavProvider({ children }) {
  return <MobileNavContext.Provider value={{}}>{children}</MobileNavContext.Provider>;
}

export function useMobileNav() {
  return useContext(MobileNavContext);
}