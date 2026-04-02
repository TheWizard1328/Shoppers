import { useEffect } from 'react';
import { format } from 'date-fns';

export default function useRouteManagementRealtimeSync({
  enabled,
  selectedDate,
  setAllDeliveries,
  setAllPatients
}) {
  useEffect(() => {
    if (!enabled) return;

    const handleRealtimeDeliveriesUpdated = (event) => {
      const detail = event?.detail || {};
      const incomingDeliveries = Array.isArray(detail.deliveries)
        ? detail.deliveries
        : Array.isArray(detail.freshDeliveries)
          ? detail.freshDeliveries
          : [];

      const selectedDateString = selectedDate ? format(new Date(selectedDate), 'yyyy-MM-dd') : null;

      if (detail.fullReplacement && selectedDateString && Array.isArray(incomingDeliveries)) {
        setAllDeliveries?.((prev) => {
          const otherDates = (prev || []).filter((item) => item?.delivery_date !== selectedDateString);
          const selectedDateDeliveries = incomingDeliveries.filter((item) => item?.delivery_date === selectedDateString);
          return [...otherDates, ...selectedDateDeliveries];
        });
        return;
      }

      if (incomingDeliveries.length > 0) {
        setAllDeliveries?.((prev) => {
          const byId = new Map((prev || []).filter(Boolean).map((item) => [item.id, item]));
          incomingDeliveries.forEach((item) => {
            if (item?.id) byId.set(item.id, item);
          });
          return Array.from(byId.values());
        });
      }

      const deletedIds = Array.isArray(detail.deletedIds)
        ? detail.deletedIds
        : detail.deletedId
          ? [detail.deletedId]
          : [];

      if (deletedIds.length > 0) {
        setAllDeliveries?.((prev) => (prev || []).filter((item) => !deletedIds.includes(item?.id)));
      }
    };

    const handleRealtimePatientsUpdated = (event) => {
      const detail = event?.detail || {};
      const incomingPatients = Array.isArray(detail.patients) ? detail.patients : [];

      if (detail.fullReplacement && incomingPatients.length > 0) {
        setAllPatients?.(incomingPatients);
        return;
      }

      if (incomingPatients.length > 0) {
        setAllPatients?.((prev) => {
          const byId = new Map((prev || []).filter(Boolean).map((item) => [item.id, item]));
          incomingPatients.forEach((item) => {
            if (item?.id) byId.set(item.id, item);
          });
          return Array.from(byId.values());
        });
      }

      const deletedIds = Array.isArray(detail.deletedIds)
        ? detail.deletedIds
        : detail.deletedId
          ? [detail.deletedId]
          : [];

      if (deletedIds.length > 0) {
        setAllPatients?.((prev) => (prev || []).filter((item) => !deletedIds.includes(item?.id)));
      }
    };

    window.addEventListener('deliveriesUpdated', handleRealtimeDeliveriesUpdated);
    window.addEventListener('patientsUpdated', handleRealtimePatientsUpdated);

    return () => {
      window.removeEventListener('deliveriesUpdated', handleRealtimeDeliveriesUpdated);
      window.removeEventListener('patientsUpdated', handleRealtimePatientsUpdated);
    };
  }, [enabled, selectedDate, setAllDeliveries, setAllPatients]);
}