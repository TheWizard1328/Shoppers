export async function handleLayoutMutation({ mutation, offlineDB, setPatients, setDeliveries, setStores, setCities, setAppUsers, setUsers, appUsers }) {
  if (mutation.type === 'replace') {
    if (mutation.entity === 'Patient') {
      setPatients((prev) => prev.map((p) => p?.id === mutation.oldId ? mutation.data : p));
    } else if (mutation.entity === 'Delivery') {
      setDeliveries((prev) => prev.map((d) => d?.id === mutation.oldId ? mutation.data : d));
    }
    return true;
  }

  if (mutation.type === 'delete') {
    if (mutation.entity === 'Patient') {
      await offlineDB.deleteRecord(offlineDB.STORES.PATIENTS, mutation.id).catch(() => {});
      setPatients((prev) => prev.filter((p) => p?.id !== mutation.id));
    } else if (mutation.entity === 'Delivery') {
      await offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, mutation.id).catch(() => {});
      setDeliveries((prev) => prev.filter((d) => d?.id !== mutation.id));
    } else if (mutation.entity === 'Store') {
      await offlineDB.deleteRecord(offlineDB.STORES.STORES, mutation.id).catch(() => {});
      setStores((prev) => prev.filter((s) => s?.id !== mutation.id));
    } else if (mutation.entity === 'City') {
      await offlineDB.deleteRecord(offlineDB.STORES.CITIES, mutation.id).catch(() => {});
      setCities((prev) => prev.filter((c) => c?.id !== mutation.id));
    } else if (mutation.entity === 'AppUser') {
      await offlineDB.deleteRecord(offlineDB.STORES.APP_USERS, mutation.id).catch(() => {});
      setAppUsers((prev) => prev.filter((a) => a?.id !== mutation.id));
      setUsers((prev) => prev.filter((u) => u?.id !== mutation.id));
    } else if (mutation.entity === 'DriverRoutePolyline') {
      await offlineDB.deleteRecord(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, mutation.id).catch(() => {});
      const polylines = await offlineDB.getAll(offlineDB.STORES.DRIVER_ROUTE_POLYLINES).catch(() => []);
      window.dispatchEvent(new CustomEvent('driverRoutePolylinesUpdated', {
        detail: { polylines, source: 'layoutMutationDelete' }
      }));
    }
    return true;
  }

  if (mutation.type === 'batch_delete') {
    const idsToDelete = new Set(mutation.ids || []);
    if (mutation.entity === 'Delivery') {
      await Promise.all((mutation.ids || []).map((id) =>
        offlineDB.deleteRecord(offlineDB.STORES.DELIVERIES, id).catch(() => {})
      ));
      setDeliveries((prev) => prev.filter((d) => !idsToDelete.has(d?.id)));
    }
    return true;
  }

  if (mutation.type === 'create') {
    if (mutation.entity === 'Patient') {
      setPatients((prev) => {
        const exists = prev.some((p) => p?.id === mutation.id);
        return exists ? prev : [...prev, mutation.data];
      });
    } else if (mutation.entity === 'Delivery') {
      setDeliveries((prev) => {
        const exists = prev.some((d) => d?.id === mutation.id);
        return exists ? prev : [...prev, mutation.data];
      });
    } else if (mutation.entity === 'Store') {
      setStores((prev) => {
        const exists = prev.some((s) => s?.id === mutation.id);
        return exists ? prev : [...prev, mutation.data];
      });
    } else if (mutation.entity === 'City') {
      setCities((prev) => {
        const exists = prev.some((c) => c?.id === mutation.id);
        return exists ? prev : [...prev, mutation.data];
      });
    } else if (mutation.entity === 'AppUser') {
      setAppUsers((prev) => {
        const exists = prev.some((a) => a?.id === mutation.id);
        return exists ? prev : [...prev, mutation.data];
      });
      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
        detail: { appUsers: null, singleUpdate: mutation.data }
      }));
    } else if (mutation.entity === 'DriverRoutePolyline') {
      await offlineDB.save(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, mutation.data).catch(() => {});
      const polylines = await offlineDB.getAll(offlineDB.STORES.DRIVER_ROUTE_POLYLINES).catch(() => []);
      window.dispatchEvent(new CustomEvent('driverRoutePolylinesUpdated', {
        detail: { polylines, source: 'layoutMutationCreate' }
      }));
    }
    return true;
  }

  if (mutation.type === 'update') {
    if (mutation.entity === 'Patient') {
      setPatients((prev) => prev.map((p) => p?.id === mutation.id ? { ...p, ...mutation.data } : p));
    } else if (mutation.entity === 'Delivery') {
      setDeliveries((prev) => prev.map((d) => d?.id === mutation.id ? { ...d, ...mutation.data } : d));
    } else if (mutation.entity === 'Store') {
      setStores((prev) => prev.map((s) => s?.id === mutation.id ? { ...s, ...mutation.data } : s));
    } else if (mutation.entity === 'City') {
      setCities((prev) => prev.map((c) => c?.id === mutation.id ? { ...c, ...mutation.data } : c));
    } else if (mutation.entity === 'AppUser') {
      setAppUsers((prev) => prev.map((a) => a?.id === mutation.id ? { ...a, ...mutation.data } : a));
      window.dispatchEvent(new CustomEvent('driverLocationsUpdated', {
        detail: { appUsers: null, singleUpdate: mutation.data }
      }));
    } else if (mutation.entity === 'DriverRoutePolyline') {
      await offlineDB.save(offlineDB.STORES.DRIVER_ROUTE_POLYLINES, mutation.data).catch(() => {});
      const polylines = await offlineDB.getAll(offlineDB.STORES.DRIVER_ROUTE_POLYLINES).catch(() => []);
      window.dispatchEvent(new CustomEvent('driverRoutePolylinesUpdated', {
        detail: { polylines, source: 'layoutMutationUpdate' }
      }));
    }
    return true;
  }

  return false;
}