import { useEffect } from 'react';
import { base44 } from '@/api/base44Client';

/**
 * Subscribes to Delivery and Patient WebSocket events.
 * On each event: updates React state immediately AND persists to offline DB.
 */
export function useDeliveryRealtimeSync({ isMountedRef, setAllDeliveries, setAllPatients }) {
  useEffect(() => {
    const unsubD = base44.entities.Delivery.subscribe(async (event) => {
      if (!isMountedRef.current) return;

      // Update UI state immediately
      if (event.type === 'create') {
        setAllDeliveries((prev) => prev.some((d) => d?.id === event.id) ? prev : [...prev, event.data]);
      } else if (event.type === 'update') {
        setAllDeliveries((prev) => prev.map((d) => d?.id === event.id ? { ...d, ...event.data } : d));
      } else if (event.type === 'delete') {
        setAllDeliveries((prev) => prev.filter((d) => d?.id !== event.id));
      }

      // Persist to offline DB
      try {
        const { offlineDB } = await import('@/components/utils/offlineDatabase');
        if (event.type === 'create' || event.type === 'update') {
          await offlineDB.save(offlineDB.STORES.DELIVERIES, event.data);
        } else if (event.type === 'delete') {
          await offlineDB.delete(offlineDB.STORES.DELIVERIES, event.id);
        }
      } catch (_) {
        // Non-critical — offline DB sync failure doesn't break the UI
      }
    });

    const unsubP = base44.entities.Patient.subscribe(async (event) => {
      if (!isMountedRef.current) return;

      // Update UI state immediately
      if (event.type === 'create') {
        setAllPatients((prev) => prev.some((p) => p?.id === event.id) ? prev : [...prev, event.data]);
      } else if (event.type === 'update') {
        setAllPatients((prev) => prev.map((p) => p?.id === event.id ? { ...p, ...event.data } : p));
      } else if (event.type === 'delete') {
        setAllPatients((prev) => prev.filter((p) => p?.id !== event.id));
      }

      // Persist to offline DB
      try {
        const { offlineDB } = await import('@/components/utils/offlineDatabase');
        if (event.type === 'create' || event.type === 'update') {
          await offlineDB.save(offlineDB.STORES.PATIENTS, event.data);
        } else if (event.type === 'delete') {
          await offlineDB.delete(offlineDB.STORES.PATIENTS, event.id);
        }
      } catch (_) {
        // Non-critical
      }
    });

    return () => { unsubD(); unsubP(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}