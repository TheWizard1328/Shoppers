import React, { createContext, useContext, useState, useEffect } from 'react';
import { getEffectiveUser } from './auth';

const UserContext = createContext({
  currentUser: null,
  isLoadingUser: true,
  refreshUser: async () => {}
});

export const UserProvider = ({ children, initialUser = null }) => {
  const [currentUser, setCurrentUser] = useState(initialUser);
  const [isLoadingUser, setIsLoadingUser] = useState(!initialUser);

  const refreshUser = async () => {
    try {
      setIsLoadingUser(true);
      const user = await getEffectiveUser();
      setCurrentUser(user);
      return user;
    } catch (error) {
      console.error('❌ [UserContext] Failed to refresh user:', error);
      setCurrentUser(null);
      return null;
    } finally {
      setIsLoadingUser(false);
    }
  };

  useEffect(() => {
    // Only load user if not provided initially
    if (!initialUser) {
      refreshUser();
    } else {
      setIsLoadingUser(false);
    }
  }, [initialUser]);

  return (
    <UserContext.Provider value={{ currentUser, isLoadingUser, refreshUser }}>
      {children}
    </UserContext.Provider>
  );
};

export const useUser = () => {
  const context = useContext(UserContext);
  if (!context) {
    throw new Error('useUser must be used within a UserProvider');
  }
  return context;
};