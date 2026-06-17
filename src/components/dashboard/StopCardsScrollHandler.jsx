// Handler for stop card scrolling - syncs map to centered card and resets FAB phase
import { fabControlEvents } from '@/components/utils/fabControlEvents';

export const createStopCardsScrollHandler = ({
  deliveriesWithStopOrder,
  patients,
  stores,
  appUsers = [],
  currentUser = null,
  driverLocation = null,
  allDriverLocations = [],
  selectedDriverId = null,
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

    // Unlock FAB for ALL phases when the user manually swipes a card.
    // Route through USER_MAP_INTERACTION so useFabControlEventHandler clears both the ref
    // AND React state in one place — preventing stale-ref clicks from cycling as if locked.
    if (isMapViewLocked) {
      if (mapLockTimeoutRef.current) {
        clearTimeout(mapLockTimeoutRef.current);
        mapLockTimeoutRef.current = null;
      }
      mapLockExpiresAtRef.current = null;
      console.log(`🟠 [map phase unlocked] reason=card-swipe phase=${mapViewPhase}`);
      fabControlEvents.notifyUserMapInteraction();
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

      if (centeredDeliveryId) {
        const centeredDelivery = deliveriesWithStopOrder.find(d => d?.id === centeredDeliveryId);
        if (centeredDelivery) {
          // Resolve driver location for the card's assigned driver
          const cardDriverId = centeredDelivery.driver_id;
          const targetDriverId = selectedDriverId && selectedDriverId !== 'all'
            ? selectedDriverId
            : cardDriverId;

          // Try live driverLocation first (primary device), then appUsers, then allDriverLocations
          let driverLat = null, driverLng = null;
          if (driverLocation?.latitude && driverLocation?.longitude) {
            driverLat = driverLocation.latitude;
            driverLng = driverLocation.longitude;
          } else {
            const driverAppUser = appUsers.find(u =>
              u?.user_id === targetDriverId || u?.id === targetDriverId
            );
            if (driverAppUser?.current_latitude && driverAppUser?.current_longitude) {
              driverLat = driverAppUser.current_latitude;
              driverLng = driverAppUser.current_longitude;
            } else {
              const locEntry = allDriverLocations.find(l =>
                l?.driverId === targetDriverId || l?.driver_id === targetDriverId || l?.id === targetDriverId
              );
              if (locEntry?.latitude && locEntry?.longitude) {
                driverLat = locEntry.latitude;
                driverLng = locEntry.longitude;
              }
            }
          }

          // Resolve card marker coordinates
          let cardLat = null, cardLng = null;
          if (centeredDelivery.patient_id) {
            const patient = patients.find(p => p?.id === centeredDelivery.patient_id);
            cardLat = patient?.latitude; cardLng = patient?.longitude;
          } else if (centeredDelivery.store_id) {
            const store = stores.find(s => s?.id === centeredDelivery.store_id);
            cardLat = store?.latitude; cardLng = store?.longitude;
          }

          // Fit bounds to driver location + card marker at maxZoom 17.5
          if (setShouldFitBounds && cardLat && cardLng) {
            const bounds = [[cardLat, cardLng]];
            if (driverLat && driverLng) bounds.push([driverLat, driverLng]);
            const padding = typeof getMapPadding === 'function' ? getMapPadding(false) : {};
            setShouldFitBounds({
              bounds,
              options: {
                ...(padding || {}),
                maxZoom: 17.5,
                animate: true,
                duration: 0.35,
              }
            });
            if (setMapCenter) setMapCenter(null);
            if (setMapZoom) setMapZoom(null);
          }

          onCenteredCardChange?.({
            deliveryId: centeredDelivery.id,
            driverId: centeredDelivery.driver_id,
            isNextDelivery: centeredDelivery.isNextDelivery === true,
            source: 'scroll'
          });
        }
      }

      if (typeof window !== 'undefined') window.__isUserCardSwipe = false;
    }, 150);
  };
};