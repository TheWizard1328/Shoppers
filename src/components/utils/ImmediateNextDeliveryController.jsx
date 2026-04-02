import { useEffect, useRef } from 'react';
import { calculateRealTimeETA } from '@/functions/calculateRealTimeETA';
import { updateDeliveryLocal } from './offlineMutations';
import { useAppData } from './AppDataContext';

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

const getCurrentLocalTimeString = () => {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
};

const centerDeliveryCard = (deliveryId) => {
  if (!deliveryId || typeof window === 'undefined') return;
  const scroll = () => {
    const card = document.getElementById(`stop-card-${deliveryId}`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  };
  scroll();
  requestAnimationFrame(scroll);
  setTimeout(scroll, 0);
};

const getRouteDeliveries = (deliveries, delivery) =>
  (deliveries || []).filter((item) =>
    item &&
    item.driver_id === delivery.driver_id &&
    item.delivery_date === delivery.delivery_date
  );

const getNextActiveDelivery = (routeDeliveries, currentDeliveryId) =>
  (routeDeliveries || [])
    .filter((item) =>
      item &&
      item.id !== currentDeliveryId &&
      !FINISHED_STATUSES.includes(item.status) &&
      item.status !== 'pending'
    )
    .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0] || null;

const getActionFromTarget = (target) => {
  const button = target?.closest?.('button');
  const stopCard = target?.closest?.('[id^="stop-card-"]');
  if (!button || !stopCard) return null;

  const deliveryId = stopCard.id.replace('stop-card-', '');
  if (!deliveryId) return null;

  if (button.dataset.stopcardAction === 'start') {
    return { type: 'start', deliveryId };
  }

  const buttonText = button.textContent?.trim?.().toLowerCase?.() || '';
  if (buttonText === 'complete') {
    return { type: 'complete', deliveryId };
  }

  return null;
};

export default function ImmediateNextDeliveryController() {
  const { deliveries, updateDeliveriesLocally } = useAppData();
  const deliveriesRef = useRef(deliveries || []);
  const recentActionRef = useRef({ key: '', ts: 0 });
  const etaRefreshRef = useRef(new Set());

  useEffect(() => {
    deliveriesRef.current = deliveries || [];
  }, [deliveries]);

  useEffect(() => {
    const handlePointerDown = async (event) => {
      const action = getActionFromTarget(event.target);
      if (!action) return;

      const actionKey = `${action.type}:${action.deliveryId}`;
      if (recentActionRef.current.key === actionKey && Date.now() - recentActionRef.current.ts < 800) {
        return;
      }
      recentActionRef.current = { key: actionKey, ts: Date.now() };

      const currentDeliveries = deliveriesRef.current || [];
      const delivery = currentDeliveries.find((item) => item?.id === action.deliveryId);
      if (!delivery) return;

      const routeDeliveries = getRouteDeliveries(currentDeliveries, delivery);
      const routeKey = `${delivery.driver_id}:${delivery.delivery_date}`;

      if (action.type === 'start') {
        const startUpdate = {
          status: delivery.patient_id ? 'in_transit' : 'en_route',
          delivery_time_start: getCurrentLocalTimeString(),
          isNextDelivery: true
        };

        await Promise.all(
          routeDeliveries.map((item) => {
            const shouldBeNext = item.id === delivery.id;
            const payload = shouldBeNext ? startUpdate : { isNextDelivery: false };
            return updateDeliveryLocal(item.id, payload, { skipSmartRefresh: true });
          })
        );

        const optimistic = currentDeliveries.map((item) => {
          if (!item || item.driver_id !== delivery.driver_id || item.delivery_date !== delivery.delivery_date) {
            return item;
          }
          if (item.id === delivery.id) {
            return { ...item, ...startUpdate };
          }
          return { ...item, isNextDelivery: false };
        });

        updateDeliveriesLocally?.(optimistic, true);
        centerDeliveryCard(delivery.id);
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: { triggeredBy: 'nextDeliveryImmediate', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
        }));
        return;
      }

      if (action.type === 'complete') {
        return;
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [updateDeliveriesLocally]);

  useEffect(() => {
    const handleDeliveriesUpdated = async (event) => {
      const { triggeredBy, driverId, deliveryDate } = event.detail || {};
      const shouldRefreshEta = ['complete', 'nextDeliveryImmediate', 'deliveryFormUpdate', 'completeEtaRefresh'].includes(triggeredBy);
      if (!shouldRefreshEta || triggeredBy === 'completeEtaRefresh' || !driverId || !deliveryDate) return;

      const routeKey = `${driverId}:${deliveryDate}`;
      if (etaRefreshRef.current.has(routeKey)) return;
      etaRefreshRef.current.add(routeKey);

      try {
        const currentLocalTime = getCurrentLocalTimeString();
        let etaUpdates = [];

        try {
          const etaRes = await calculateRealTimeETA({
            driverId,
            deliveryDate,
            currentLocalTime,
            deviceTime: currentLocalTime
          });
          const etaData = etaRes?.data || etaRes;
          etaUpdates = etaData?.durationUpdates || etaData?.etas || [];
        } catch (error) {
          console.warn('[ImmediateNextDeliveryController] ETA refresh skipped:', error?.message || error);
        }

        if (Array.isArray(etaUpdates) && etaUpdates.length > 0) {
          window.dispatchEvent(new CustomEvent('etaUpdated', {
            detail: {
              updates: etaUpdates.map((item) => ({
                deliveryId: item.deliveryId || item.delivery_id,
                newEta: item.eta || item.newETA
              }))
            }
          }));
        }

        const refreshedDeliveries = deliveriesRef.current || [];
        const nextStop = refreshedDeliveries.find((item) =>
          item &&
          item.driver_id === driverId &&
          item.delivery_date === deliveryDate &&
          item.isNextDelivery === true
        );
        if (nextStop?.id) {
          centerDeliveryCard(nextStop.id);
        }
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: { triggeredBy: 'completeEtaRefresh', driverId, deliveryDate }
        }));
      } finally {
        etaRefreshRef.current.delete(routeKey);
      }
    };

    window.addEventListener('deliveriesUpdated', handleDeliveriesUpdated);
    return () => window.removeEventListener('deliveriesUpdated', handleDeliveriesUpdated);
  }, []);

  return null;
}