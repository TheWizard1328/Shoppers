/**
 * Page-specific data reloader from offline database
 * Ensures each page has fresh data based on current filters
 */

export const pageDataReloader = {
  async reloadDashboard(selectedDate, selectedCityId, currentUser) {
    try {
      const { offlineDB } = await import('./offlineDatabase');
      const { globalFilters } = await import('./globalFilters');
      
      // Use current filters if not provided
      const date = selectedDate || globalFilters.getSelectedDate();
      const cityId = selectedCityId || globalFilters.getSelectedCityId();
      
      console.log(`📦 [PageReload] Dashboard: Loading data for ${date} in city ${cityId}`);
      
      // Load all deliveries for the selected date
      const allDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
      const dateDeliveries = allDeliveries.filter(d => d && d.delivery_date === date);
      
      // Load all patients for matching deliveries
      const patientIds = new Set(dateDeliveries.map(d => d.patient_id).filter(Boolean));
      const allPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
      const relevantPatients = allPatients.filter(p => p && (patientIds.has(p.id) || p.delivery_count > 0));
      
      // Load app users (drivers)
      const appUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
      
      // Load stores
      const stores = await offlineDB.getAll(offlineDB.STORES.STORES);
      
      console.log(`✅ [PageReload] Dashboard: ${dateDeliveries.length} deliveries, ${relevantPatients.length} patients, ${appUsers.length} drivers`);
      
      return {
        deliveries: dateDeliveries,
        patients: relevantPatients,
        appUsers: appUsers,
        stores: stores,
        date: date,
        cityId: cityId
      };
    } catch (error) {
      console.error('❌ [PageReload] Dashboard load failed:', error);
      return null;
    }
  },

  async reloadPatients(selectedCityId, currentUser) {
    try {
      const { offlineDB } = await import('./offlineDatabase');
      const { globalFilters } = await import('./globalFilters');
      
      const cityId = selectedCityId || globalFilters.getSelectedCityId();
      
      console.log(`📦 [PageReload] Patients: Loading for city ${cityId}`);
      
      const allPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
      const stores = await offlineDB.getAll(offlineDB.STORES.STORES);
      
      console.log(`✅ [PageReload] Patients: ${allPatients.length} patients`);
      
      return {
        patients: allPatients,
        stores: stores,
        cityId: cityId
      };
    } catch (error) {
      console.error('❌ [PageReload] Patients load failed:', error);
      return null;
    }
  },

  async reloadDeliveries(selectedDate, selectedCityId, currentUser) {
    try {
      const { offlineDB } = await import('./offlineDatabase');
      const { globalFilters } = await import('./globalFilters');
      
      const date = selectedDate || globalFilters.getSelectedDate();
      const cityId = selectedCityId || globalFilters.getSelectedCityId();
      
      console.log(`📦 [PageReload] Deliveries: Loading for ${date}`);
      
      const allDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
      const dateDeliveries = allDeliveries.filter(d => d && d.delivery_date === date);
      
      const allPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
      const stores = await offlineDB.getAll(offlineDB.STORES.STORES);
      const appUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
      
      console.log(`✅ [PageReload] Deliveries: ${dateDeliveries.length} deliveries`);
      
      return {
        deliveries: dateDeliveries,
        patients: allPatients,
        stores: stores,
        appUsers: appUsers,
        date: date,
        cityId: cityId
      };
    } catch (error) {
      console.error('❌ [PageReload] Deliveries load failed:', error);
      return null;
    }
  },

  async reloadStores(selectedCityId, currentUser) {
    try {
      const { offlineDB } = await import('./offlineDatabase');
      const { globalFilters } = await import('./globalFilters');
      
      const cityId = selectedCityId || globalFilters.getSelectedCityId();
      
      console.log(`📦 [PageReload] Stores: Loading`);
      
      const stores = await offlineDB.getAll(offlineDB.STORES.STORES);
      const appUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
      
      console.log(`✅ [PageReload] Stores: ${stores.length} stores`);
      
      return {
        stores: stores,
        appUsers: appUsers,
        cityId: cityId
      };
    } catch (error) {
      console.error('❌ [PageReload] Stores load failed:', error);
      return null;
    }
  },

  async reloadCities(currentUser) {
    try {
      const { offlineDB } = await import('./offlineDatabase');
      
      console.log(`📦 [PageReload] Cities: Loading`);
      
      const cities = await offlineDB.getAll(offlineDB.STORES.CITIES);
      
      console.log(`✅ [PageReload] Cities: ${cities.length} cities`);
      
      return { cities };
    } catch (error) {
      console.error('❌ [PageReload] Cities load failed:', error);
      return null;
    }
  },

  async reloadAppUsers(currentUser) {
    try {
      const { offlineDB } = await import('./offlineDatabase');
      
      console.log(`📦 [PageReload] Users: Loading`);
      
      const appUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
      
      console.log(`✅ [PageReload] Users: ${appUsers.length} users`);
      
      return { appUsers };
    } catch (error) {
      console.error('❌ [PageReload] Users load failed:', error);
      return null;
    }
  },

  // Generic reloader - loads all data for a page
  async reloadPageData(pageName, filters = {}) {
    const { selectedDate, selectedCityId, selectedDriverId } = filters;
    const user = filters.currentUser;
    
    switch (pageName) {
      case 'Dashboard':
        return this.reloadDashboard(selectedDate, selectedCityId, user);
      case 'Patients':
        return this.reloadPatients(selectedCityId, user);
      case 'Deliveries':
        return this.reloadDeliveries(selectedDate, selectedCityId, user);
      case 'Stores':
        return this.reloadStores(selectedCityId, user);
      case 'Cities':
        return this.reloadCities(user);
      case 'AppUsers':
        return this.reloadAppUsers(user);
      default:
        console.warn(`⚠️ [PageReload] Unknown page: ${pageName}`);
        return null;
    }
  }
};