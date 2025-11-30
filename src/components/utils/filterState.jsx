// Global filter state management
let globalFilters = {
  selectedDate: new Date(),
  selectedCityId: 'all',
  selectedStoreId: 'all',
  selectedDriverId: 'all'
};

export const getGlobalFilters = () => {
  // Try to get from localStorage first
  try {
    const stored = localStorage.getItem('rxdeliver_filters');
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        ...globalFilters,
        ...parsed,
        selectedDate: new Date(parsed.selectedDate || new Date())
      };
    }
  } catch (error) {
    console.warn('Error loading filters from localStorage:', error);
  }
  return globalFilters;
};

export const setGlobalFilters = (newFilters) => {
  globalFilters = { ...globalFilters, ...newFilters };
  
  // Save to localStorage
  try {
    localStorage.setItem('rxdeliver_filters', JSON.stringify(globalFilters));
  } catch (error) {
    console.warn('Error saving filters to localStorage:', error);
  }
};

export const updateGlobalFilter = (key, value) => {
  setGlobalFilters({ [key]: value });
};