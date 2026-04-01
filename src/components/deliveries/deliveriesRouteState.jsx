import { format } from 'date-fns';

export function updateDeliveriesUrl({ locationSearch, locationPathname, navigate, newFilters }) {
  const params = new URLSearchParams(locationSearch);
  const todayString = format(new Date(), 'yyyy-MM-dd');
  const currentYear = new Date().getFullYear().toString();
  const currentMonth = (new Date().getMonth() + 1).toString();

  Object.entries(newFilters).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '' || value === 'all') {
      params.delete(key);
      return;
    }

    if (key === 'date') {
      let dateStr;

      if (value instanceof Date) {
        if (isNaN(value.getTime())) return;
        dateStr = format(value, 'yyyy-MM-dd');
      } else if (typeof value === 'string') {
        const [y, m, d] = value.split('-').map(Number);
        if (isNaN(y) || isNaN(m) || isNaN(d)) return;
        dateStr = value;
      } else {
        return;
      }

      if (dateStr !== todayString) {
        params.set(key, dateStr);
      } else {
        params.delete(key);
      }
      return;
    }

    if (key === 'year') {
      const paramValue = value.toString();
      if (paramValue !== currentYear) params.set(key, paramValue);
      else params.delete(key);
      return;
    }

    if (key === 'month') {
      const paramValue = value.toString();
      if (paramValue !== currentMonth) params.set(key, paramValue);
      else params.delete(key);
      return;
    }

    if (key === 'city') {
      if (value !== 'all') params.set(key, value);
      else params.delete(key);
      return;
    }

    params.set(key, value.toString());
  });

  navigate(`${locationPathname}?${params.toString()}`, { replace: true });
}

export function navigateToDriverRoute({ locationSearch, locationPathname, navigate, driverId, selectedYear, selectedMonth }) {
  const nextDriverFilter = driverId || 'all';
  const params = new URLSearchParams(locationSearch);
  params.set('year', (selectedYear || new Date().getFullYear()).toString());
  params.set('month', ((selectedMonth ?? new Date().getMonth()) + 1).toString());

  if (nextDriverFilter === 'all') params.delete('driver');
  else params.set('driver', nextDriverFilter);

  navigate(`${locationPathname}?${params.toString()}`, { replace: true });
}

export function resolveDriverFilter({ driverParam, globalDriverFilter, currentDriverFilter, currentUser, effectiveDrivers, userHasRole }) {
  let nextDriverFilter = driverParam || globalDriverFilter || currentDriverFilter || 'all';

  if (!driverParam && userHasRole(currentUser, 'driver')) {
    const driverUser = (effectiveDrivers || []).find((d) => d.id === nextDriverFilter);
    if (driverUser) nextDriverFilter = driverUser.id;
  }

  return nextDriverFilter;
}