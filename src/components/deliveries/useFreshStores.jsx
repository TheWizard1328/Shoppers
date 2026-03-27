import { useEffect, useState } from 'react';

export default function useFreshStores(stores) {
  const [freshStores, setFreshStores] = useState(stores);

  useEffect(() => {
    const loadFreshStores = async () => {
      try {
        const { offlineDB } = await import('../utils/offlineDatabase');
        const offlineStores = await offlineDB.getAll(offlineDB.STORES.STORES);
        if (offlineStores && offlineStores.length > 0) {
          setFreshStores(offlineStores);
        } else {
          setFreshStores(stores);
        }
      } catch {
        setFreshStores(stores);
      }
    };

    loadFreshStores();
  }, [stores]);

  return freshStores;
}