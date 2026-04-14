import React from 'react';
import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';

// Global filter state manager for consistent filters across all pages
// CRITICAL: These are stored in localStorage which is device-specific
// They should NOT be synced across devices via UserSettings

const STORAGE_KEYS = {
  selectedDate: 'app_selectedDate',
  selectedDriverId: 'app_selectedDriverId',
  selectedCityId: 'app_selectedCityId',
  selectedStoreId: 'app_selectedStoreId',
  lastAutoSetDate: 'app_lastAutoSetDate',
  dashboardSessionInitializedAt: 'app_dashboardSessionInitializedAt',
  lastSeenAt: 'app_lastSeenAt'
};

let appUserPreferenceSyncTimeout = null;

const syncPreferencesToAppUser = (overrides = {}) => {
  if (appUserPreferenceSyncTimeout) {
    clearTimeout(appUserPreferenceSyncTimeout);
  }

  appUserPreferenceSyncTimeout = setTimeout(async () => {
    try {
      const cachedUserRaw = sessionStorage.getItem('effectiveUserCache') || localStorage.getItem('effectiveUserCache');
      const cachedUser = cachedUserRaw ? JSON.parse(cachedUserRaw)?.user : null;
      const appUserId = cachedUser?.id;

      if (!appUserId) return;

      await base44.entities.AppUser.update(appUserId, {
        last_selected_date: overrides.last_selected_date ?? globalState.selectedDate,
        last_selected_driver_id: overrides.last_selected_driver_id ?? globalState.selectedDriverId
      });
    } catch (error) {
      console.warn('Failed to sync dashboard preferences:', error);
    }
  }, 400);
};

// Global state object
let globalState = {
  selectedDate: null,
  selectedDriverId: 'all',
  selectedCityId: 'all',
  selectedStoreId: 'all',
  listeners: new Set()
};

// Initialize from localStorage ONLY - never from UserSettings
// CRITICAL: These values are device-specific and stored only in localStorage
const initializeGlobalFilters = () => {
  try {
    const today = format(new Date(), 'yyyy-MM-dd');
    const savedDate = localStorage.getItem(STORAGE_KEYS.selectedDate);
    const lastSeenAt = Number(localStorage.getItem(STORAGE_KEYS.lastSeenAt) || 0);
    const hasSessionStarted = sessionStorage.getItem(STORAGE_KEYS.dashboardSessionInitializedAt) === 'true';
    const INACTIVITY_WINDOW_MS = 15 * 60 * 1000;
    const shouldTreatAsFreshSession = !hasSessionStarted || !lastSeenAt || Date.now() - lastSeenAt > INACTIVITY_WINDOW_MS;

    let isDispatcherUser = false;
    try {
      const cachedUser = sessionStorage.getItem('effectiveUserCache');
      const parsedUser = cachedUser ? JSON.parse(cachedUser) : null;
      const appRoles = parsedUser?.appUser?.app_roles || parsedUser?.user?.app_roles || [];
      isDispatcherUser = Array.isArray(appRoles) && appRoles.includes('dispatcher');
    } catch (error) {
      isDispatcherUser = false;
    }

    let serverSelectedDate = null;
    let serverSelectedDriverId = null;

    try {
      const cachedUserRaw = sessionStorage.getItem('effectiveUserCache') || localStorage.getItem('effectiveUserCache');
      const cachedUser = cachedUserRaw ? JSON.parse(cachedUserRaw)?.user : null;
      serverSelectedDate = cachedUser?.last_selected_date || null;
      serverSelectedDriverId = cachedUser?.last_selected_driver_id || null;
    } catch (error) {
      serverSelectedDate = null;
      serverSelectedDriverId = null;
    }

    const preferredDate = serverSelectedDate || savedDate;

    if (isDispatcherUser && preferredDate && preferredDate !== today) {
      globalState.selectedDate = today;
      localStorage.setItem(STORAGE_KEYS.selectedDate, today);
      console.log(`📅 [GlobalFilters] Dispatcher fresh load using today instead of saved date: ${today}`);
    } else if (preferredDate && !shouldTreatAsFreshSession) {
      globalState.selectedDate = preferredDate;
      localStorage.setItem(STORAGE_KEYS.selectedDate, preferredDate);
      console.log(`📅 [GlobalFilters] Using saved date from active session: ${preferredDate}`);
    } else if (preferredDate) {
      globalState.selectedDate = preferredDate;
      localStorage.setItem(STORAGE_KEYS.selectedDate, preferredDate);
      console.log(`📅 [GlobalFilters] Preserving saved date on init until dashboard decides otherwise: ${preferredDate}`);
    } else {
      globalState.selectedDate = today;
      localStorage.setItem(STORAGE_KEYS.selectedDate, today);
      console.log(`📅 [GlobalFilters] No saved date, using today: ${today}`);
    }

    globalState.selectedDriverId = serverSelectedDriverId || localStorage.getItem(STORAGE_KEYS.selectedDriverId) || 'all';
    globalState.selectedCityId = localStorage.getItem(STORAGE_KEYS.selectedCityId) || 'all';
    globalState.selectedStoreId = localStorage.getItem(STORAGE_KEYS.selectedStoreId) || 'all';

    console.log(`👤 [GlobalFilters] Initialized driver: ${globalState.selectedDriverId}, city: ${globalState.selectedCityId}`);
  } catch (error) {
    const today = format(new Date(), 'yyyy-MM-dd');
    globalState.selectedDate = today;
    globalState.selectedDriverId = 'all';
    globalState.selectedCityId = 'all';
    globalState.selectedStoreId = 'all';
    console.warn('⚠️ [GlobalFilters] localStorage failed, using defaults');
  }
};

// Initialize on module load
initializeGlobalFilters();

// Helper function to notify all listeners
const notifyListeners = () => {
  globalState.listeners.forEach(listener => {
    try {
      listener(globalState);
    } catch (error) {
      console.error('Error in global filter listener:', error);
    }
  });

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('globalFiltersChanged', {
      detail: {
        selectedDate: globalState.selectedDate,
        selectedDriverId: globalState.selectedDriverId,
        selectedCityId: globalState.selectedCityId,
        selectedStoreId: globalState.selectedStoreId
      }
    }));
  }
};

// CRITICAL FIX: Only update and notify if value actually changed
const updateAndSave = (key, value) => {
  const currentValue = globalState[key];
  
  // GUARD: Don't update if value is the same
  if (currentValue === value) {
    try {
      localStorage.setItem(STORAGE_KEYS.lastSeenAt, Date.now().toString());
    } catch (error) {
      console.warn('Failed to save last seen timestamp:', error);
    }
    return false; // Indicate no change
  }
  
  globalState[key] = value;
  try {
    localStorage.setItem(STORAGE_KEYS[key], value);
    localStorage.setItem(STORAGE_KEYS.lastSeenAt, Date.now().toString());
  } catch (error) {
    console.warn('Failed to save to localStorage:', error);
  }

  if (key === 'selectedDate') {
    syncPreferencesToAppUser({ last_selected_date: value });
  }

  if (key === 'selectedDriverId') {
    syncPreferencesToAppUser({ last_selected_driver_id: value });
  }

  notifyListeners();
  return true; // Indicate change occurred
};

// Public API
export const globalFilters = {
  // Getters
  getSelectedDate: () => globalState.selectedDate,
  getSelectedDriverId: () => globalState.selectedDriverId,
  getSelectedCityId: () => globalState.selectedCityId,
  getSelectedStoreId: () => globalState.selectedStoreId,
  getAllFilters: () => ({
    selectedDate: globalState.selectedDate,
    selectedDriverId: globalState.selectedDriverId,
    selectedCityId: globalState.selectedCityId,
    selectedStoreId: globalState.selectedStoreId
  }),

  // Check if all mandatory filters are ready for data fetching
  isReadyForDataFetch: () => {
    const { selectedCityId, selectedDate, selectedDriverId } = globalState;
    
    // Check if cityId is valid (not null, not 'all', not a placeholder)
    const hasCityId = selectedCityId && 
                      selectedCityId !== 'all' && 
                      selectedCityId !== 'waiting-for-selection' &&
                      selectedCityId !== 'select-city';
    
    // Check if date is valid (not null/undefined and is a valid date string)
    const hasDate = selectedDate && selectedDate.length > 0;
    
    // Check if driver is valid (not null/undefined - 'all' is acceptable)
    const hasDriver = selectedDriverId && selectedDriverId.length > 0;
    
    const isReady = hasCityId && hasDate && hasDriver;
    
    return isReady;
  },

  // Setters with change detection
  setSelectedDate: (date) => {
    // CRITICAL FIX: Add check for Invalid Date objects
    if (!date || (date instanceof Date && isNaN(date.getTime()))) {
      console.warn('setSelectedDate called with null or invalid date. Action aborted.');
      return;
    }

    let dateString;
    try {
      dateString = typeof date === 'string' ? date : format(date, 'yyyy-MM-dd');
    } catch (error) {
      console.error('Error converting date to string:', error, 'Provided date:', date, '. Action aborted.');
      return;
    }

    updateAndSave('selectedDate', dateString);
  },

  setSelectedDriverId: (driverId) => {
    const newDriverId = driverId || 'all';
    updateAndSave('selectedDriverId', newDriverId);
  },

  setSelectedCityId: (cityId) => {
    const newCityId = cityId || 'all';
    updateAndSave('selectedCityId', newCityId);
  },

  setSelectedStoreId: (storeId) => {
    updateAndSave('selectedStoreId', storeId || 'all');
  },

  // Bulk update with change detection
  updateFilters: (filters) => {
    let hasChanges = false;
    const todayString = format(new Date(), 'yyyy-MM-dd');

    if (filters.selectedDate !== undefined) {
      let dateString;
      try {
        if (!filters.selectedDate) {
          dateString = todayString;
        } else {
          dateString = typeof filters.selectedDate === 'string' ? filters.selectedDate : format(filters.selectedDate, 'yyyy-MM-dd');
        }

        if (updateAndSave('selectedDate', dateString)) {
          hasChanges = true;
        }
      } catch (error) {
        console.error('Error processing selectedDate in updateFilters:', error);
      }
    }

    if (filters.selectedDriverId !== undefined) {
      if (updateAndSave('selectedDriverId', filters.selectedDriverId || 'all')) {
        hasChanges = true;
      }
    }

    if (filters.selectedCityId !== undefined) {
      if (updateAndSave('selectedCityId', filters.selectedCityId || 'all')) {
        hasChanges = true;
      }
    }

    if (filters.selectedStoreId !== undefined) {
      if (updateAndSave('selectedStoreId', filters.selectedStoreId || 'all')) {
        hasChanges = true;
      }
    }

    // Note: updateAndSave already calls notifyListeners if changes occurred
    return hasChanges;
  },

  // Listener management
  subscribe: (listener) => {
    globalState.listeners.add(listener);
    // Return unsubscribe function
    return () => {
      globalState.listeners.delete(listener);
    };
  },

  // Reset all filters
  reset: () => {
    const today = format(new Date(), 'yyyy-MM-dd');
    globalState.selectedDate = today;
    globalState.selectedDriverId = 'all';
    globalState.selectedCityId = 'all';
    globalState.selectedStoreId = 'all';

    try {
      localStorage.setItem(STORAGE_KEYS.selectedDate, today);
      localStorage.setItem(STORAGE_KEYS.selectedDriverId, 'all');
      localStorage.setItem(STORAGE_KEYS.selectedCityId, 'all');
      localStorage.setItem(STORAGE_KEYS.selectedStoreId, 'all');
    } catch (error) {
      console.warn('Failed to save reset filters:', error);
    }

    notifyListeners();
  },
};

// React hook for easy integration
export const useGlobalFilters = () => {
  const [filters, setFilters] = React.useState(() => globalFilters.getAllFilters());

  React.useEffect(() => {
    const unsubscribe = globalFilters.subscribe(() => {
      setFilters(globalFilters.getAllFilters());
    });

    return unsubscribe;
  }, []);

  return {
    ...filters,
    setSelectedDate: globalFilters.setSelectedDate,
    setSelectedDriverId: globalFilters.setSelectedDriverId,
    setSelectedCityId: globalFilters.setSelectedCityId,
    setSelectedStoreId: globalFilters.setSelectedStoreId,
    updateFilters: globalFilters.updateFilters,
    reset: globalFilters.reset,
    isReadyForDataFetch: globalFilters.isReadyForDataFetch
  };
};