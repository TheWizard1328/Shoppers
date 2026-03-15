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

      // CRITICAL: Center map on the centered delivery's marker + assigned driver's location,
      // and unlock FAB when the user scrolls to any non-phase-1 centered card.
      if (centeredDeliveryId) {
        const centeredDelivery = deliveriesWithStopOrder.find(d => d?.id === centeredDeliveryId);
        if (centeredDelivery) {
          const appUser = appUsers.find((user) => user?.user_id === centeredDelivery.driver_id || user?.id === centeredDelivery.driver_id);
          const driverLat = appUser?.current_latitude;
          const driverLon = appUser?.current_longitude;
          const relockPhase = centeredDelivery.isNextDelivery === true && (mapViewPhase === 2 || mapViewPhase === 3) ? mapViewPhase : null;

          if (mapViewPhase === 2 || mapViewPhase === 3) {
            if (typeof window !== 'undefined') window.__fabRelockPhase = mapViewPhase;
            if (mapLockTimeoutRef.current) {
              clearTimeout(mapLockTimeoutRef.current);
              mapLockTimeoutRef.current = null;
            }
            mapLockExpiresAtRef.current = null;
            setIsMapViewLocked(false);
          }

          // Center map on this delivery's marker and driver location
          let stopLat, stopLon;
          if (centeredDelivery.patient_id) {
            const patient = patients.find(p => p?.id === centeredDelivery.patient_id);
            stopLat = patient?.latitude;
            stopLon = patient?.longitude;
          } else if (centeredDelivery.store_id) {
            const store = stores.find(s => s?.id === centeredDelivery.store_id);
            stopLat = store?.latitude;
            stopLon = store?.longitude;
          }

          const bounds = [];
          if (stopLat && stopLon) bounds.push([stopLat, stopLon]);
          if (driverLat && driverLon) bounds.push([driverLat, driverLon]);

          if (bounds.length > 0) {
            const padding = getMapPadding();
            setShouldFitBounds({
              bounds,
              options: {
                ...padding,
                maxZoom: 17,
                animate: true
              }
            });
            setMapCenter(null);
            setMapZoom(null);
          }

          if (relockPhase) {
            setMapViewPhase(relockPhase);
            setIsMapViewLocked(true);
            if (typeof window !== 'undefined') window.__fabRelockPhase = relockPhase;
          }
          onCenteredCardChange?.({ deliveryId: centeredDelivery.id, driverId: centeredDelivery.driver_id, isNextDelivery: centeredDelivery.isNextDelivery === true, source: 'scroll' });
        }
      }

      if (typeof window !== 'undefined') window.__isUserCardSwipe = false;
    }, 150);
  };
};