export const centerDeliveryCard = (deliveryId) => {
  if (!deliveryId || typeof window === 'undefined') return false;

  window.dispatchEvent(new CustomEvent('centerStopCard', {
    detail: { deliveryId }
  }));

  const scroll = () => {
    const card = document.getElementById(`stop-card-${deliveryId}`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      return true;
    }
    return false;
  };
  const foundNow = scroll();
  requestAnimationFrame(scroll);
  setTimeout(scroll, 0);
  return foundNow;
};

export const getNextDeliveryCard = (deliveries = []) => {
  if (!Array.isArray(deliveries) || deliveries.length === 0) return null;
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];
  return (
    deliveries.find((d) => d && d.isNextDelivery === true && !finishedStatuses.includes(d.status)) ||
    deliveries
      .filter((d) => d && !finishedStatuses.includes(d.status) && d.status !== 'pending')
      .sort((a, b) => (a.stop_order || 0) - (b.stop_order || 0))[0] ||
    null
  );
};

export const centerNextDeliveryCard = (deliveries = []) => {
  const nextDelivery = getNextDeliveryCard(deliveries);
  if (!nextDelivery?.id) return null;
  centerDeliveryCard(nextDelivery.id);
  return nextDelivery;
};

export const getCurrentDashboardSelection = () => {
  if (typeof window === 'undefined') return { selectedDriverId: null, selectedDate: null };
  return {
    selectedDriverId: window.__appSelectedDriverId || localStorage.getItem('global_selected_driver_id') || localStorage.getItem('app_selectedDriverId') || 'all',
    selectedDate: window.__appSelectedDate || localStorage.getItem('global_selected_date') || localStorage.getItem('app_selectedDate') || null
  };
};

export const isDeliveryRelevantToCurrentSelection = (delivery) => {
  if (!delivery) return false;
  const { selectedDriverId, selectedDate } = getCurrentDashboardSelection();
  if (selectedDate && delivery.delivery_date && delivery.delivery_date !== selectedDate) return false;
  if (selectedDriverId && selectedDriverId !== 'all' && delivery.driver_id !== selectedDriverId) return false;
  return true;
};