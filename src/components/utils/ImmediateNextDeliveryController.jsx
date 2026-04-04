import { useEffect, useRef } from 'react';
import { optimizeRouteRealTime } from '@/functions/optimizeRouteRealTime';
import { updateDeliveryLocal } from './offlineMutations';
import { useAppData } from './AppDataContext';
import { centerDeliveryCard } from './deliveryCardUtils';
import { reorderActiveRouteLocally } from '../common/stopCardActionHelpers';

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

const getCurrentLocalTimeString = () => {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
};

const getCurrentLocalDateTimeString = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
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

        const locallyStartedRoute = reorderActiveRouteLocally(
          routeDeliveries.map((item) => {
            if (!item) return item;
            if (item.id === delivery.id) {
              return { ...item, ...startUpdate };
            }
            return { ...item, isNextDelivery: false };
          }),
          delivery.id
        );

        const startedRouteMap = new Map(locallyStartedRoute.filter(Boolean).map((item) => [item.id, item]));
        const optimistic = currentDeliveries.map((item) => {
          if (!item || item.driver_id !== delivery.driver_id || item.delivery_date !== delivery.delivery_date) {
            return item;
          }
          return startedRouteMap.get(item.id) || item;
        });

        updateDeliveriesLocally?.(optimistic, true);
        centerDeliveryCard(delivery.id);
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: {
            triggeredBy: 'nextDeliveryImmediate',
            driverId: delivery.driver_id,
            deliveryDate: delivery.delivery_date,
            preserveLocalState: true
          }
        }));

        Promise.resolve().then(async () => {
          await Promise.all(
            locallyStartedRoute.map((item) => {
              const existingItem = routeDeliveries.find((routeItem) => routeItem?.id === item?.id);
              if (!item || !existingItem) return Promise.resolve();

              const updates = {};
              if (existingItem.status !== item.status) updates.status = item.status;
              if (existingItem.delivery_time_start !== item.delivery_time_start) updates.delivery_time_start = item.delivery_time_start;
              if ((existingItem.isNextDelivery || false) !== (item.isNextDelivery || false)) updates.isNextDelivery = item.isNextDelivery || false;
              if ((existingItem.stop_order || 0) !== (item.stop_order || 0)) updates.stop_order = item.stop_order;

              if (Object.keys(updates).length === 0) return Promise.resolve();
              return updateDeliveryLocal(item.id, updates, { skipSmartRefresh: true });
            })
          );

          window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
            detail: { triggeredBy: 'nextDeliveryImmediate', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
          }));
        });
        return;
      }

      if (action.type === 'complete') {
        const completionTimestamp = getCurrentLocalDateTimeString();
        const completionUpdate = {
          status: 'completed',
          actual_delivery_time: completionTimestamp,
          arrival_time: delivery.arrival_time || completionTimestamp,
          isNextDelivery: false
        };

        const optimisticBase = currentDeliveries.map((item) => {
          if (!item || item.driver_id !== delivery.driver_id || item.delivery_date !== delivery.delivery_date) {
            return item;
          }
          if (item.id === delivery.id) {
            return { ...item, ...completionUpdate };
          }
          return { ...item, isNextDelivery: false };
        });

        const nextStop = getNextActiveDelivery(
          optimisticBase.filter((item) =>
            item && item.driver_id === delivery.driver_id && item.delivery_date === delivery.delivery_date
          ),
          delivery.id
        );

        await Promise.all(
          routeDeliveries.map((item) => {
            if (item.id === delivery.id) {
              return updateDeliveryLocal(item.id, completionUpdate, { skipSmartRefresh: true });
            }
            if (item.id === nextStop?.id) {
              return updateDeliveryLocal(item.id, { isNextDelivery: true }, { skipSmartRefresh: true });
            }
            if (item.isNextDelivery) {
              return updateDeliveryLocal(item.id, { isNextDelivery: false }, { skipSmartRefresh: true });
            }
            return Promise.resolve();
          })
        );

        const optimistic = optimisticBase.map((item) => {
          if (!item || item.driver_id !== delivery.driver_id || item.delivery_date !== delivery.delivery_date) {
            return item;
          }
          return { ...item, isNextDelivery: item.id === nextStop?.id };
        });

        updateDeliveriesLocally?.(optimistic, true);
        if (nextStop?.id) {
          centerDeliveryCard(nextStop.id);
        }
        window.dispatchEvent(new CustomEvent('deliveriesUpdated', {
          detail: { triggeredBy: 'nextDeliveryImmediate', driverId: delivery.driver_id, deliveryDate: delivery.delivery_date }
        }));

        etaRefreshRef.current.delete(routeKey);
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