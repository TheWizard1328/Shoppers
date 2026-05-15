const parseTimeToMinutes = (timeString) => {
  if (!timeString || typeof timeString !== 'string') return null;
  const parts = timeString.split(':');
  if (parts.length < 2) return null;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return (hours * 60) + minutes;
};

const ensureBus = () => {
  if (typeof window === 'undefined') {
    return {
      currentById: new Map(),
      trendById: new Map(),
      initialized: true,
    };
  }

  if (!window.__etaTrendBus) {
    window.__etaTrendBus = {
      currentById: new Map(),
      trendById: new Map(),
      initialized: false,
    };
  }

  const bus = window.__etaTrendBus;

  if (!bus.initialized) {
    bus.initialized = true;
    window.addEventListener('etaUpdated', (event) => {
      recordEtaUpdates(event?.detail?.updates || []);
    });
    window.addEventListener('deliveriesUpdated', (event) => {
      const freshDeliveries = event?.detail?.freshDeliveries || [];
      const updates = freshDeliveries.map((d) => ({
        deliveryId: d?.id,
        newEta: d?.delivery_time_eta,
      }));
      recordEtaUpdates(updates);
    });
  }

  return bus;
};

export const primeEtaTrendBus = (deliveries = []) => {
  const bus = ensureBus();
  deliveries.forEach((delivery) => {
    const deliveryId = delivery?.id;
    const eta = delivery?.delivery_time_eta || delivery?.delivery_time_start;
    if (deliveryId && eta && !bus.currentById.has(deliveryId)) {
      bus.currentById.set(deliveryId, eta);
    }
  });
};

export const recordEtaUpdates = (updates = []) => {
  const bus = ensureBus();
  let changed = false;

  updates.forEach((update) => {
    const deliveryId = update?.deliveryId || update?.delivery_id;
    const nextEta = update?.newEta || update?.newETA || update?.eta;
    if (!deliveryId || !nextEta) return;

    const previousEta = bus.currentById.get(deliveryId);
    if (previousEta && previousEta !== nextEta) {
      const previousMinutes = parseTimeToMinutes(previousEta);
      const nextMinutes = parseTimeToMinutes(nextEta);
      const diffMinutes = previousMinutes !== null && nextMinutes !== null ? nextMinutes - previousMinutes : 0;
      bus.trendById.set(deliveryId, {
        trend: diffMinutes < 0 ? 'improved' : diffMinutes > 0 ? 'delayed' : 'neutral',
        diffMinutes,
        previousEta,
        currentEta: nextEta,
        updatedAt: Date.now(),
      });
      changed = true;
    }

    bus.currentById.set(deliveryId, nextEta);
  });

  if (changed && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('etaTrendUpdated'));
  }
};

export const getCurrentEtaForDelivery = (deliveryId, fallback = '--:--') => {
  const bus = ensureBus();
  return bus.currentById.get(deliveryId) || fallback;
};

export const getEtaTrendForDelivery = (deliveryId) => {
  const bus = ensureBus();
  return bus.trendById.get(deliveryId) || null;
};