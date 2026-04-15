import { useEffect, useRef } from 'react';
import { optimizeRouteRealTime } from '@/functions/optimizeRouteRealTime';
import { handleStartDelivery } from '@/functions/handleStartDelivery';
import { updateDeliveryLocal } from './offlineMutations';
import { getLocalTimestamp } from './localTimeHelper';
import { parseLocalTimestamp } from './timeRoundingHelper';
import { useAppData } from './AppDataContext';
import { centerDeliveryCard } from './deliveryCardUtils';

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

const getCurrentLocalTimeString = () => {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
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

  return null;
};

const getTodayDateString = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

const isRetroRouteDelivery = (delivery) => {
  if (!delivery?.delivery_date) return false;
  return String(delivery.delivery_date) < getTodayDateString();
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

        try {
          await handleStartDelivery({
            deliveryId: delivery.id,
            driverId: delivery.driver_id,
            deliveryDate: delivery.delivery_date
          });
        } catch (error) {
          console.warn('[ImmediateNextDeliveryController] Start delivery fallback failed:', error?.message || error);
        }

        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: { triggeredBy: 'nextDeliveryImmediate', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date, preserveLocalState: true }
        }));
        return;
      }

      if (action.type === 'complete') {
        console.warn('[ImmediateNextDeliveryController] Skipping immediate complete handoff', {
          deliveryId: delivery.id,
          deliveryDate: delivery.delivery_date,
          isRetroRoute: isRetroRouteDelivery(delivery),
          existingActualDeliveryTime: delivery.actual_delivery_time || null,
          existingArrivalTime: delivery.arrival_time || null
        });
        recentActionRef.current = { key: '', ts: 0 };
        return;
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [updateDeliveriesLocally]);

  useEffect(() => {
    const handleDeliveriesUpdated = async (event) => {
      const { triggeredBy, driverId, deliveryDate, preserveLocalState } = event.detail || {};
      const shouldRefreshEta = ['complete', 'nextDeliveryImmediate', 'deliveryFormUpdate', 'completeEtaRefresh'].includes(triggeredBy);
      if (!shouldRefreshEta || triggeredBy === 'completeEtaRefresh' || preserveLocalState || !driverId || !deliveryDate) return;

      const routeKey = `${driverId}:${deliveryDate}`;
      if (etaRefreshRef.current.has(routeKey)) return;
      etaRefreshRef.current.add(routeKey);

      try {
        const currentLocalTime = getCurrentLocalTimeString();
        let etaUpdates = [];

        try {
          const etaRes = await optimizeRouteRealTime({
            driverId,
            deliveryDate,
            currentLocalTime,
            deviceTime: currentLocalTime,
            generatePolyline: false
          });
          const etaData = etaRes?.data || etaRes;
          etaUpdates = etaData?.optimizedRoute || etaData?.durationUpdates || etaData?.etas || [];
        } catch (error) {
          console.warn('[ImmediateNextDeliveryController] ETA refresh skipped:', error?.message || error);
        }

        if (!Array.isArray(deliveriesRef.current) || deliveriesRef.current.length === 0) {
          return;
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
          detail: { triggeredBy: 'completeEtaRefresh', driverId, deliveryDate, preserveLocalState: true }
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