// Handler for stop card scrolling - syncs map to centered card and resets FAB phase
export const createStopCardsScrollHandler = ({
  deliveriesWithStopOrder,
  patients,
  stores,
  mapViewPhase,
  isMapViewLocked,
  setIsMapViewLocked,
  setMapViewPhase,
  setShouldFitBounds,
  setMapCenter,
  setMapZoom,
  getMapPadding,
  mapLockTimeoutRef,
  mapLockExpiresAtRef
}) => {
  return (e) => {
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

      // CRITICAL: Center map on the centered delivery's marker and reset FAB phase if needed
      if (centeredDeliveryId) {
        const centeredDelivery = deliveriesWithStopOrder.find(d => d?.id === centeredDeliveryId);
        if (centeredDelivery) {
          // Reset FAB phase if currently in phase 2 or 3
          if ((mapViewPhase === 2 || mapViewPhase === 3) && isMapViewLocked) {
            console.log('🗺️ [Stop Card Scroll] Resetting FAB from phase', mapViewPhase, 'to phase 1');
            setIsMapViewLocked(false);
            setMapViewPhase(1);
            
            // Clear any existing timers
            if (mapLockTimeoutRef.current) {
              clearTimeout(mapLockTimeoutRef.current);
              mapLockTimeoutRef.current = null;
            }
            mapLockExpiresAtRef.current = null;
          }

          // Center map on this delivery's marker
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

          if (stopLat && stopLon) {
            const padding = getMapPadding();
            setShouldFitBounds({
              bounds: [[stopLat, stopLon]],
              options: {
                ...padding,
                maxZoom: 17,
                animate: true
              }
            });
            setMapCenter(null);
            setMapZoom(null);
            console.log('🗺️ [Stop Card Scroll] Centered map on delivery:', centeredDelivery.patient_name || centeredDelivery.delivery_id);
          }
        }
      }
    }, 150);
  };
};