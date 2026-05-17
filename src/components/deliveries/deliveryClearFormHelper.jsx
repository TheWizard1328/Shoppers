/**
 * Resets the global driver filter when the delivery form is cleared.
 * - Dispatchers: reset to their store's default AM/PM driver for today
 * - Everyone else (admins, etc.): reset to 'all'
 */
export function resetDriverFilterOnClear(currentUser, stores, userHasRole) {
  import('../utils/globalFilters').then(({ globalFilters }) => {
    if (currentUser && userHasRole(currentUser, 'dispatcher') && !userHasRole(currentUser, 'admin')) {
      const storeId = (currentUser.store_ids || [])[0];
      const store = (stores || []).find((s) => s && s.id === storeId);
      const d = new Date();
      const day = d.getDay();
      const pfx = day === 0 ? 'sunday' : day === 6 ? 'saturday' : 'weekday';
      const driverId = store?.[`${pfx}_am_driver_id`] || store?.[`${pfx}_pm_driver_id`] || 'all';
      globalFilters.setSelectedDriverId(driverId);
    } else {
      globalFilters.setSelectedDriverId('all');
    }
  }).catch(() => {});
}