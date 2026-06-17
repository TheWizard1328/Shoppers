/**
 * usePreActionDataRefresh
 *
 * Pulls the absolute latest delivery, patient, and store records directly
 * from the offline IndexedDB immediately before any critical delivery action
 * (complete, fail, cancel, retry, return, restart).
 *
 * This guarantees that the messaging system and polyline generator always
 * use fresh data — even if the React in-memory state has gone stale due to
 * the app being backgrounded or OS memory pressure.
 *
 * Usage:
 *   const { refreshForAction } = usePreActionDataRefresh();
 *   const fresh = await refreshForAction(delivery, patients, stores);
 *   // Use fresh.delivery, fresh.patient, fresh.store going forward
 */

import { useCallback } from 'react';
import { offlineDB } from './offlineDatabase';

export function usePreActionDataRefresh() {
  const refreshForAction = useCallback(async (delivery, patients, stores) => {
    if (!delivery?.id) {
      return { delivery, patient: null, store: null };
    }

    try {
      // Pull all three in parallel from IndexedDB — fast, persistent, OS-safe
      const [freshDelivery, freshPatient, freshStore] = await Promise.all([
        offlineDB.getById(offlineDB.STORES.DELIVERIES, delivery.id),
        delivery.patient_id
          ? offlineDB.getById(offlineDB.STORES.PATIENTS, delivery.patient_id)
          : Promise.resolve(null),
        delivery.store_id
          ? offlineDB.getById(offlineDB.STORES.STORES, delivery.store_id)
          : Promise.resolve(null),
      ]);

      // Merge IDB record on top of the prop so we never lose any in-flight
      // optimistic fields that were written to IDB but not yet in React state
      const mergedDelivery = freshDelivery
        ? { ...delivery, ...freshDelivery }
        : delivery;

      // For patient/store: IDB is authoritative (full record always stored there)
      // Fall back to finding the record in the passed-in arrays if IDB returns null
      const resolvedPatient =
        freshPatient ||
        (delivery.patient_id
          ? (Array.isArray(patients) ? patients.find((p) => p?.id === delivery.patient_id) : null)
          : null) ||
        null;

      const resolvedStore =
        freshStore ||
        (delivery.store_id
          ? (Array.isArray(stores) ? stores.find((s) => s?.id === delivery.store_id) : null)
          : null) ||
        null;

      return {
        delivery: mergedDelivery,
        patient: resolvedPatient,
        store: resolvedStore,
      };
    } catch {
      // If IDB read fails for any reason, fall back gracefully to in-memory data
      const fallbackPatient = delivery.patient_id
        ? (Array.isArray(patients) ? patients.find((p) => p?.id === delivery.patient_id) : null)
        : null;
      const fallbackStore = delivery.store_id
        ? (Array.isArray(stores) ? stores.find((s) => s?.id === delivery.store_id) : null)
        : null;

      return { delivery, patient: fallbackPatient, store: fallbackStore };
    }
  }, []);

  return { refreshForAction };
}