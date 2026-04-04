import React from 'react';
import { format } from 'date-fns';

// Global filter state manager for consistent filters across all pages
// CRITICAL: These are stored in localStorage which is device-specific
// They should NOT be synced across devices via UserSettings

const STORAGE_KEYS = {
  selectedDate: 'app_selectedDate',
  selectedDriverId: 'app_selectedDriverId',
  selectedCityId: 'app_selectedCityId',
  selectedStoreId: 'app_selectedStoreId',
  lastAutoSetDate: 'app_lastAutoSetDate',
  dashboardSessionInitializedAt: 'app_dashboardSessionInitializedAt'
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

    if (savedDate) {
      const savedDateObj = new Date(savedDate + 'T00:00:00');
      const todayObj = new Date(today + 'T00:00:00');
      const daysDiff = Math.floor((todayObj - savedDateObj) / (1000 * 60 * 60 * 24));

      if (daysDiff >= 0 && daysDiff <= 30) {
        globalState.selectedDate = savedDate;
        console.log(`📅 [GlobalFilters] Using saved date: ${savedDate}`);
      } else {
        globalState.selectedDate = today;
        localStorage.setItem(STORAGE_KEYS.selectedDate, today);
        console.log(`📅 [GlobalFilters] Saved date too old, using today: ${today}`);
      }
    } else {
      globalState.selectedDate = today;
      localStorage.setItem(STORAGE_KEYS.selectedDate, today);
      console.log(`📅 [GlobalFilters] No saved date, using today: ${today}`);
    }

    globalState.selectedDriverId = localStorage.getItem(STORAGE_KEYS.selectedDriverId) || 'all';
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
    return false; // Indicate no change
  }
  
  globalState[key] = value;
  try {
    localStorage.setItem(STORAGE_KEYS[key], value);
  } catch (error) {
    console.warn('Failed to save to localStorage:', error);
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