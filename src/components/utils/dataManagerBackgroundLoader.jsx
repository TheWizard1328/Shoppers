import { format } from 'date-fns';
import { loadDeliveriesForDate } from './dataManagerDeliveryLoader';

export const loadBackgroundDeliveries = async (selectedDateStr, filters, onComplete, initialDeliveries = []) => {
  const today = new Date();
  const deliveryMap = new Map();

  initialDeliveries.forEach((delivery) => deliveryMap.set(delivery.id, delivery));

  for (let i = 0; i <= 6; i++) {
    const fetchDate = new Date(today);
    fetchDate.setDate(today.getDate() + i);
    const fetchDateStr = format(fetchDate, 'yyyy-MM-dd');

    if (fetchDateStr === selectedDateStr) continue;

    try {
      const dateDeliveries = await loadDeliveriesForDate(fetchDateStr, filters, false);
      dateDeliveries.forEach((delivery) => deliveryMap.set(delivery.id, delivery));

      if (i < 6) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch {}
  }

  onComplete(Array.from(deliveryMap.values()));
};