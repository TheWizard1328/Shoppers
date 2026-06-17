// Lightweight page data reloader used by Layout
// Provides a safe, fast way to prep page-scoped data from offline DB

import { format } from 'date-fns';

export const pageDataReloader = {
  // Returns a minimal object; Layout keeps global state and pages filter locally
  async reloadPageData(pageName, filters = {}) {
    const result = { page: pageName, prepared: false };

    try {
      // Lazy import to avoid bundling cost and to work offline-first
      const mod = await import('./offlineDatabase');
      const { offlineDB } = mod;

      // Always ensure the key stores are readable; pages filter locally
      const [deliveries, patients, stores, appUsers] = await Promise.all([
        offlineDB.getAll(offlineDB.STORES.DELIVERIES).catch(() => []),
        offlineDB.getAll(offlineDB.STORES.PATIENTS).catch(() => []),
        offlineDB.getAll(offlineDB.STORES.STORES).catch(() => []),
        offlineDB.getAll(offlineDB.STORES.APP_USERS).catch(() => []),
      ]);

      // Optionally derive a small page-facing snapshot (non-destructive)
      const selectedDate = typeof filters?.selectedDate === 'string' ? filters.selectedDate : format(new Date(), 'yyyy-MM-dd');

      if (pageName === 'Dashboard') {
        // Minimal prep: confirm we have some data for the selected date (no network calls)
        const hasToday = deliveries?.some(d => d?.delivery_date === selectedDate);
        result.prepared = true;
        result.meta = { hasSelectedDateData: !!hasToday };
      } else if (pageName === 'Deliveries') {
        // Provide a tiny filtered list for immediate UX (pages still use global state)
        const quick = (deliveries || []).filter(d => d?.delivery_date === selectedDate).slice(0, 50);
        result.prepared = true;
        result.preview = { deliveries: quick };
      } else if (pageName === 'Patients') {
        result.prepared = true;
        result.preview = { patients: (patients || []).slice(0, 50) };
      } else {
        result.prepared = true; // No-op for other pages
      }

      // Soft notify interested listeners without forcing refetch
      try {
        window.dispatchEvent(new CustomEvent('pageDataPrepared', { detail: { page: pageName, date: selectedDate } }));
      } catch {}

      return result;
    } catch (err) {
      // Keep failure non-fatal; return a consistent shape
      return { page: pageName, prepared: false, error: err?.message || 'reloadPageData failed' };
    }
  }
};

export default pageDataReloader;