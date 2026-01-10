import React from "react";
import StopCard from '../common/StopCard';
import { format } from 'date-fns';

export default function HorizontalPickupCards({ // Renamed to HorizontalStopCards internally
  pickupCards = [],
  onCardClick,
  selectedCardId,
  stores = [],
  drivers = [], // Now receiving full driver objects
  patients = [],
  currentUser, // NEW: Add currentUser prop
  onSelectionChange,
  selectedDeliveryIds = {},
  stopOrder = {},
  showDriverName = false, // Accept new prop
  getDriverColor, // Accept new prop
  // NEW: Action handlers
  onEditDelivery,
  onEditPatient,
  onDeleteDelivery,
  onRestart,
  onStatusUpdate,
  onNotesUpdate,
  onCODUpdate,
  onCreateReturn, // NEW: Add onCreateReturn prop
  onStartDelivery, // NEW: Add onStartDelivery prop
  allDeliveries = [], // NEW: Add allDeliveries prop
  selectedDate, // NEW: Add selectedDate prop
  onDriverStatusChange, // NEW: Add onDriverStatusChange prop
  appUsers = [] // NEW: Add appUsers prop for messaging
}) {
  // CRITICAL: ALL HOOKS MUST BE CALLED BEFORE ANY CONDITIONAL RETURNS
  const containerRef = React.useRef(null);
  const scrollTimeoutRef = React.useRef(null);

  // Define finished statuses
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

  // CRITICAL FIX: Filter out invalid cards BEFORE sorting/mapping to prevent hook count mismatches
  const validCards = pickupCards.filter((card) => card && card.id);

  // Auto-scroll to selected card - always center when card is expanded
  const prevSelectedCardIdRef = React.useRef(null);
  const autoScrollEnabledRef = React.useRef(true);
  const touchStartXRef = React.useRef(null);

  // Helper function to smoothly scroll to center a specific card element
  const scrollToCenterCard = React.useCallback((cardElement) => {
    const container = containerRef.current;
    if (!container || !cardElement) return;

    const containerWidth = container.offsetWidth;
    const cardOffsetLeft = cardElement.offsetLeft;
    const cardWidth = cardElement.offsetWidth;
    const scrollTarget = cardOffsetLeft - (containerWidth / 2) + (cardWidth / 2);

    container.scrollTo({
      left: scrollTarget,
      behavior: 'smooth'
    });
  }, []);

  // Snap scrolling for mobile - scroll one card at a time based on swipe zones
  const handleTouchStart = React.useCallback((e) => {
    autoScrollEnabledRef.current = false;
    touchStartXRef.current = e.touches[0].clientX;
  }, []);

  const handleTouchMove = React.useCallback((e) => {
    // MOBILE: Prevent native scroll during swipe - cards stay static until touchend
    e.preventDefault();
  }, []);

  const handleTouchEnd = React.useCallback((e) => {
    const container = containerRef.current;
    if (!container || touchStartXRef.current === null) return;

    const touchEndX = e.changedTouches[0].clientX;
    const deltaX = touchStartXRef.current - touchEndX;
    const swipeThreshold = 30;

    // Clean up touch tracking
    touchStartXRef.current = null;

    // Find all card elements
    const cardElements = Array.from(container.querySelectorAll('[id^="stop-card-"]'));
    if (cardElements.length === 0) return;

    // Find which card is currently closest to center
    const containerWidth = container.offsetWidth;
    const scrollCenter = container.scrollLeft + containerWidth / 2;

    let currentCenteredIndex = 0;
    let closestDistance = Infinity;

    cardElements.forEach((card, index) => {
      const cardCenter = card.offsetLeft + card.offsetWidth / 2;
      const distance = Math.abs(cardCenter - scrollCenter);
      if (distance < closestDistance) {
        closestDistance = distance;
        currentCenteredIndex = index;
      }
    });

    // Determine target index based on swipe direction
    let targetIndex = currentCenteredIndex;

    if (deltaX > swipeThreshold) {
      // Swiped LEFT (finger moved left) = go to NEXT card (index + 1)
      targetIndex = Math.min(currentCenteredIndex + 1, cardElements.length - 1);
    } else if (deltaX < -swipeThreshold) {
      // Swiped RIGHT (finger moved right) = go to PREVIOUS card (index - 1)
      targetIndex = Math.max(currentCenteredIndex - 1, 0);
    }

    // Smoothly scroll to center the target card
    scrollToCenterCard(cardElements[targetIndex]);

  }, [scrollToCenterCard]);

  React.useEffect(() => {
    // Skip if no selection or container
    if (!selectedCardId || !containerRef.current) {
      prevSelectedCardIdRef.current = selectedCardId;
      return;
    }

    // Clear any existing scroll timeout
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    // Capture the ID we intend to scroll to
    const targetCardId = selectedCardId;

    console.log(`🎯 [HorizontalStopCards] selectedCardId changed to: ${targetCardId}`);

    // Function to perform the scroll with a delay to let cards render
    scrollTimeoutRef.current = setTimeout(() => {
      requestAnimationFrame(() => {
        const container = containerRef.current;
        const element = document.getElementById(`stop-card-${targetCardId}`);

        // CRITICAL: Verify the target is still the selected card after the delay
        // This prevents "bouncing" if the selection changes rapidly during re-renders
        if (!container || !element) {
          console.warn(`⚠️ [HorizontalStopCards] Cannot scroll - container: ${!!container}, element: ${!!element}`);
          return;
        }

        // Get the actual bounding rects to account for any padding/margins
        const containerRect = container.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();

        // Calculate how much to scroll to center the element
        const elementCenterOffset = elementRect.left + elementRect.width / 2;
        const containerCenterOffset = containerRect.left + containerRect.width / 2;
        const scrollAdjustment = elementCenterOffset - containerCenterOffset;

        console.log(`📍 [HorizontalStopCards] Scrolling to card ${targetCardId}, adjustment: ${scrollAdjustment.toFixed(0)}px`);

        // Only scroll if adjustment is significant (more than 5px)
        if (Math.abs(scrollAdjustment) > 5) {
          container.scrollTo({
            left: container.scrollLeft + scrollAdjustment,
            behavior: 'smooth'
          });
        }
      });
    }, 250); // Increased delay to ensure cards are rendered

    // Update ref for tracking
    prevSelectedCardIdRef.current = selectedCardId;

    // Cleanup timeout on unmount or dependency change
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [selectedCardId]);

  // NOW we can do the safety check and early return
  if (!pickupCards || !Array.isArray(pickupCards) || pickupCards.length === 0) {
    return (
      <div className="text-center py-1 text-slate-500">
        No pickups scheduled
      </div>);

  }

  // Sort pickup cards: completed deliveries first (by actual_delivery_time), then incomplete (by ETA/stop_order)
  // Secondary sort by driver sort_order when times are equal
  const sortedPickupCards = [...validCards].sort((a, b) => {
    // CRITICAL: Add defensive null checks
    if (!a || !b) return 0;

    const isACompleted = finishedStatuses.includes(a.status);
    const isBCompleted = finishedStatuses.includes(b.status);

    // 1. Separate completed from incomplete (completed first - left side)
    if (isACompleted && !isBCompleted) return -1; // a (completed) comes first
    if (!isACompleted && isBCompleted) return 1; // b (completed) comes first

    // 2. CRITICAL: For incomplete deliveries, isNextDelivery ALWAYS comes first
    if (!isACompleted && !isBCompleted) {
      if (a.isNextDelivery && !b.isNextDelivery) return -1; // a is next delivery, comes first
      if (!a.isNextDelivery && b.isNextDelivery) return 1; // b is next delivery, comes first
    }

    // 3. Sort by time
    let timeA, timeB;

    if (isACompleted) {
      // For completed: use actual_delivery_time timestamp
      // Parse as Date object for accurate comparison
      if (a.actual_delivery_time) {
        timeA = new Date(a.actual_delivery_time).getTime();
      } else {
        // Fallback to stop_order if no actual_delivery_time
        timeA = (a.stop_order || 999) * 1000000; // Large multiplier to keep in separate range
      }
    } else {
      // For incomplete: use stop_order first (most reliable), then ETA
      // This ensures the "started" delivery stays at the front
      const stopOrderA = a.stop_order || 999;
      const etaA = a.delivery_time_eta || a.delivery_time_start || '99:99';
      const [hoursA, minutesA] = etaA.split(':').map(Number);
      const etaMinutesA = (isNaN(hoursA) ? 99 : hoursA) * 60 + (isNaN(minutesA) ? 99 : minutesA);
      // Use stop_order as primary, ETA as tiebreaker
      timeA = stopOrderA * 10000 + etaMinutesA;
    }

    if (isBCompleted) {
      // For completed: use actual_delivery_time timestamp
      if (b.actual_delivery_time) {
        timeB = new Date(b.actual_delivery_time).getTime();
      } else {
        timeB = (b.stop_order || 999) * 1000000;
      }
    } else {
      // For incomplete: use stop_order first, then ETA
      const stopOrderB = b.stop_order || 999;
      const etaB = b.delivery_time_eta || b.delivery_time_start || '99:99';
      const [hoursB, minutesB] = etaB.split(':').map(Number);
      const etaMinutesB = (isNaN(hoursB) ? 99 : hoursB) * 60 + (isNaN(minutesB) ? 99 : minutesB);
      timeB = stopOrderB * 10000 + etaMinutesB;
    }

    if (timeA !== timeB) {
      return timeA - timeB;
    }

    // 3. If times are equal, sort by driver sort order
    const driverA = (drivers || []).find((d) => d && d.id === a.driver_id);
    const driverB = (drivers || []).find((d) => d && d.id === b.driver_id);
    const sortOrderA = driverA?.sort_order ?? 999;
    const sortOrderB = driverB?.sort_order ?? 999;

    return sortOrderA - sortOrderB;
  });

  return (
    <div
      ref={containerRef} 
      className="flex gap-3 overflow-x-auto overflow-y-visible items-end min-h-[75px] pointer-events-auto z-[200]"
      style={{
        scrollbarWidth: 'thin',
        scrollbarColor: 'rgba(0,0,0,0.15) transparent',
        WebkitOverflowScrolling: 'touch'
      }}
      onWheel={(e) => {
        e.currentTarget.scrollLeft += e.deltaY;
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onScroll={() => {
        // Disable auto-scroll when user manually scrolls
        autoScrollEnabledRef.current = false;
      }}>
      
      {sortedPickupCards.map((card) => {
        // CRITICAL: Add defensive check for card
        if (!card) return null;

        const store = (stores || []).find((s) => s && s.id === card.store_id);
        const driver = (drivers || []).find((d) => d && d.id === card.driver_id);

        const isSelected = selectedCardId === card.id;
        const isProjected = card.is_projected;

        // Get projected deliveries for this pickup card
        const projectedDeliveriesForCard = (card.projected_deliveries || []).
        filter((delivery) => delivery && delivery.patient_id) // CRITICAL: Filter out null deliveries
        .sort((a, b) => {
          // CRITICAL: Add defensive null checks
          if (!a || !b) return 0;

          const timeA = a.delivery_time_start || '';
          const timeB = b.delivery_time_start || '';

          if (timeA !== timeB) {
            return timeA.localeCompare(timeB);
          }

          // If times are equal, sort by distance from store (closest first)
          if (store && store.latitude && store.longitude) {
            const patientA = (patients || []).find((p) => p && p.id === a.patient_id);
            const patientB = (patients || []).find((p) => p && p.id === b.patient_id);

            if (patientA?.latitude && patientA?.longitude && patientB?.latitude && patientB?.longitude) {
              const distA = Math.sqrt(
                Math.pow(store.latitude - patientA.latitude, 2) +
                Math.pow(store.longitude - patientA.longitude, 2)
              );
              const distB = Math.sqrt(
                Math.pow(store.latitude - patientB.latitude, 2) +
                Math.pow(store.longitude - patientB.longitude, 2)
              );
              return distA - distB;
            }
          }

          return 0;
        });

        const cardSelectedDeliveries = selectedDeliveryIds[card.id] || [];

        return (
          <div 
            key={card.id} 
            id={`stop-card-${card.id}`} 
            className="flex-shrink-0" 
            data-is-next-delivery={card.isNextDelivery ? "true" : undefined}>
            <StopCard
              delivery={card}
              store={store}
              driver={driver}
              patients={patients || []}
              currentUser={currentUser}
              onClick={() => onCardClick(card)}
              isSelected={isSelected}
              isProjected={isProjected}
              pendingPickups={projectedDeliveriesForCard}
              onSelectionChange={onSelectionChange}
              selectedDeliveryIds={cardSelectedDeliveries}
              stopOrder={stopOrder}
              showDriverName={showDriverName}
              getDriverColor={getDriverColor}
              onEditDelivery={onEditDelivery}
              onEditPatient={onEditPatient}
              onDeleteDelivery={onDeleteDelivery}
              onRestart={(id) => {
                autoScrollEnabledRef.current = true;
                onRestart(id);
              }}
              onStatusUpdate={(id, status, additionalData, skipAutoCenter) => {
                // Re-enable auto-scroll when status changes to completed/cancelled
                if (['completed', 'cancelled', 'returned', 'failed'].includes(status)) {
                  autoScrollEnabledRef.current = true;
                }
                onStatusUpdate(id, status, additionalData, skipAutoCenter);
              }}
              onNotesUpdate={onNotesUpdate}
              onCODUpdate={onCODUpdate}
              onCreateReturn={onCreateReturn}
              onStartDelivery={onStartDelivery}
              allDeliveries={allDeliveries}
              selectedDate={selectedDate}
              drivers={drivers}
              stores={stores}
              onDriverStatusChange={onDriverStatusChange}
              appUsers={appUsers} />

          </div>);

      })}
    </div>);

}