/**
 * Page-specific data reloader from offline database (JSX module wrapper)
 * This file ensures dynamic imports that reference .jsx work correctly.
 */

export const pageDataReloader = {
  async reloadDashboard(selectedDate, selectedCityId, currentUser) {
    try {
      const { offlineDB } = await import('./offlineDatabase');
      const { globalFilters } = await import('./globalFilters');

      const date = selectedDate || globalFilters.getSelectedDate();
      const cityId = selectedCityId || globalFilters.getSelectedCityId();

      console.log(`📦 [PageReload] Dashboard: Loading data for ${date} in city ${cityId}`);

      const allDeliveries = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
      const dateDeliveries = allDeliveries.filter(d => d && d.delivery_date === date);

      const patientIds = new Set(dateDeliveries.map(d => d.patient_id).filter(Boolean));
      const allPatients = await offlineDB.getAll(offlineDB.STORES.PATIENTS);
      const relevantPatients = allPatients.filter(p => p && (patientIds.has(p.id) || p.delivery_count > 0));

      const appUsers = await offlineDB.getAll(offlineDB.STORES.APP_USERS);
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

  async reloadPageData(pageName, filters = {}) {
    const { selectedDate, selectedCityId } = filters;
    const user = filters.currentUser;

    switch (pageName) {
      case 'Dashboard':
        return this.reloadDashboard(selectedDate, selectedCityId, user);
      default:
        return null;
    }
  }
};

export default pageDataReloader;