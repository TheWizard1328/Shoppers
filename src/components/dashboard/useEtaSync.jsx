import { useEffect } from 'react';

export default function useEtaSync(deliveries, updateDeliveriesLocally) {
  useEffect(() => {
    const handleEtaUpdated = (event) => {
      const { updates } = (event && event.detail) || {};
      if (!Array.isArray(updates) || updates.length === 0) return;

      if (typeof updateDeliveriesLocally === 'function' && Array.isArray(deliveries)) {
        const etaMap = new Map(
          updates
            .map(u => [u.deliveryId || u.delivery_id, u.newEta])
            .filter(([id, eta]) => id && typeof eta === 'string')
        );

        if (etaMap.size === 0) return;

        const next = deliveries.map(d => {
          if (!d?.id) return d;
          const newEta = etaMap.get(d.id);
          return newEta && d.delivery_time_eta !== newEta ? { ...d, delivery_time_eta: newEta } : d;
        });

        updateDeliveriesLocally(next, true);
      }

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: { triggeredBy: 'etaUpdated', count: (updates || []).length }
        }));
      }
    };

    window.addEventListener('etaUpdated', handleEtaUpdated);
    return () => window.removeEventListener('etaUpdated', handleEtaUpdated);
  }, [deliveries, updateDeliveriesLocally]);
}