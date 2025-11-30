import { getDriverFullName } from './driverUtils';

/**
 * Sorts users (drivers) by sort_order, then by full user_name (from AppUser)
 * @param {Array} users - Array of user objects (should be merged User + AppUser)
 * @returns {Array} - Sorted array
 */
export const sortUsers = (users) => {
    if (!users || !Array.isArray(users) || users.length === 0) {
        console.warn('⚠️ [sortUsers] Invalid input:', { 
            exists: !!users, 
            isArray: Array.isArray(users), 
            length: users?.length 
        });
        return [];
    }

    // SAFETY: Filter out null/undefined entries before sorting
    const validUsers = users.filter(user => user && typeof user === 'object');

    return [...validUsers].sort((a, b) => {
        if (!a || !b) {
            return 0;
        }
        
        const orderA = a.sort_order ?? Infinity;
        const orderB = b.sort_order ?? Infinity;

        if (orderA !== orderB) {
            return orderA - orderB;
        }
        
        const nameA = getDriverFullName(a) || '';
        const nameB = getDriverFullName(b) || '';
        return nameA.localeCompare(nameB);
    });
};

export const sortStores = (stores) => {
    if (!stores || !Array.isArray(stores) || stores.length === 0) {
        return [];
    }
    
    // SAFETY: Filter out null/undefined entries
    const validStores = stores.filter(store => store && typeof store === 'object');
    
    return [...validStores].sort((a, b) => {
        if (!a || !b) {
            return 0;
        }
        
        const orderA = a.sort_order ?? Infinity;
        const orderB = b.sort_order ?? Infinity;
        
        if (orderA !== orderB) {
            return orderA - orderB;
        }
        
        return (a.name || '').localeCompare(b.name || '');
    });
};

export const sortCities = (cities) => {
    if (!cities || !Array.isArray(cities) || cities.length === 0) {
        return [];
    }
    
    // SAFETY: Filter out null/undefined entries
    const validCities = cities.filter(city => city && typeof city === 'object');
    
    return [...validCities].sort((a, b) => {
        if (!a || !b) {
            return 0;
        }
        
        const orderA = a.sort_order ?? Infinity;
        const orderB = b.sort_order ?? Infinity;
        
        if (orderA !== orderB) {
            return orderA - orderB;
        }
        
        return (a.name || '').localeCompare(b.name || '');
    });
};