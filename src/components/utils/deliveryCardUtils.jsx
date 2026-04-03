export const centerDeliveryCard = (deliveryId) => {
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