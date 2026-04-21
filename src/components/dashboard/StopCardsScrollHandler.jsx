// Handler for stop card scrolling - syncs map to centered card and resets FAB phase
export const createStopCardsScrollHandler = ({
  deliveriesWithStopOrder,
  patients,
  stores,
  appUsers = [],
  currentUser = null,
  mapViewPhase,
  isMapViewLocked,
  setIsMapViewLocked,
  setMapViewPhase,
  setShouldFitBounds,
  setMapCenter,
  setMapZoom,
  getMapPadding,
  mapLockTimeoutRef,
  mapLockExpiresAtRef,
  onCenteredCardChange
}) => {
  return (e) => {
    if (typeof window !== 'undefined' && !window.__isUserCardSwipe) return;
    if (typeof window !== 'undefined') {
      window.__suppressCardAutoCenterUntil = Math.max(window.__suppressCardAutoCenterUntil || 0, Date.now() + 1500);
    }
    if (mapViewPhase === 3 && isMapViewLocked) {
      if (mapLockTimeoutRef.current) {
        clearTimeout(mapLockTimeoutRef.current);
        mapLockTimeoutRef.current = null;
      }
      mapLockExpiresAtRef.current = null;
      setIsMapViewLocked(false);
    }
    // Debounce the scroll snap
    const container = e.currentTarget;
    if (container._scrollTimeout) {
      clearTimeout(container._scrollTimeout);
    }

    container._scrollTimeout = setTimeout(() => {
      const containerRect = container.getBoundingClientRect();
      const containerCenter = containerRect.left + containerRect.width / 2;

      // Find the card closest to center
      const cards = container.querySelectorAll('[id^="stop-card-"]');
      let closestCard = null;
      let closestDistance = Infinity;
      let centeredDeliveryId = null;

      cards.forEach((card) => {
        const cardRect = card.getBoundingClientRect();
        const cardCenter = cardRect.left + cardRect.width / 2;
        const distance = Math.abs(cardCenter - containerCenter);

        if (distance < closestDistance) {
          closestDistance = distance;
          closestCard = card;
          centeredDeliveryId = card.id.replace('stop-card-', '');
        }
      });

      // Only snap if card is more than 30px off center
      if (closestCard && closestDistance > 30) {
        closestCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }

      // CRITICAL: Manual stop-card scrolling should unlock FAB/map and leave them unlocked.
      if (centeredDeliveryId) {
        const centeredDelivery = deliveriesWithStopOrder.find(d => d?.id === centeredDeliveryId);
        if (centeredDelivery) {
          if (mapLockTimeoutRef.current) {
            clearTimeout(mapLockTimeoutRef.current);
            mapLockTimeoutRef.current = null;
          }
          mapLockExpiresAtRef.current = null;
          setIsMapViewLocked(false);
          onCenteredCardChange?.({ deliveryId: centeredDelivery.id, driverId: centeredDelivery.driver_id, isNextDelivery: centeredDelivery.isNextDelivery === true, source: 'scroll' });
        }
      }

      if (typeof window !== 'undefined') window.__isUserCardSwipe = false;
    }, 150);
  };
};