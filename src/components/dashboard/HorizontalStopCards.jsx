import React from "react";
import StopCard from '../common/StopCard';
import { format } from 'date-fns';
import { isMobileDevice } from '../utils/deviceUtils';

const HorizontalPickupCards = React.forwardRef((props, ref) => {
  const {
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
  } = props;
  // CRITICAL: ALL HOOKS MUST BE CALLED BEFORE ANY CONDITIONAL RETURNS
  const containerRef = React.useRef(null);
  
  // CRITICAL: Combine refs - both the forwarded ref and internal containerRef
  const setRefs = React.useCallback((node) => {
    containerRef.current = node;
    if (typeof ref === 'function') {
      ref(node);
    } else if (ref) {
      ref.current = node;
    }
  }, [ref]);
  const scrollTimeoutRef = React.useRef(null);

  // Define finished statuses
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

  // CRITICAL FIX: Filter out invalid cards BEFORE sorting/mapping to prevent hook count mismatches
  const validCards = pickupCards.filter((card) => card && card.id);

  // Auto-scroll to selected card - always center when card is expanded
  const prevSelectedCardIdRef = React.useRef(null);
  const autoScrollEnabledRef = React.useRef(true);
  const touchStartXRef = React.useRef(null);

  // CRITICAL: Listen for collapseAllStopCards event and collapse all cards
  React.useEffect(() => {
    const handleCollapseAll = () => {
      console.log('🗜️ [HorizontalStopCards] Collapsing all cards');
      if (onSelectionChange) {
        onSelectionChange(null, false);
      } else if (onCardClick) {
        onCardClick(null);
      }
    };
    
    window.addEventListener('collapseAllStopCards', handleCollapseAll);
    
    return () => {
      window.removeEventListener('collapseAllStopCards', handleCollapseAll);
    };
  }, [onSelectionChange, onCardClick]);

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

  // CRITICAL: Check if next delivery card is already centered
  const isNextDeliveryCardCentered = React.useCallback(() => {
    const container = containerRef.current;
    if (!container) return false;
    
    const nextCard = validCards.find((card) => card?.isNextDelivery === true);
    if (!nextCard) return false;
    
    const cardElement = document.getElementById(`stop-card-${nextCard.id}`);
    if (!cardElement) return false;
    
    const containerRect = container.getBoundingClientRect();
    const cardRect = cardElement.getBoundingClientRect();
    
    const containerCenter = containerRect.left + containerRect.width / 2;
    const cardCenter = cardRect.left + cardRect.width / 2;
    const distanceFromCenter = Math.abs(cardCenter - containerCenter);
    
    // Consider centered if within 50px of center
    return distanceFromCenter < 50;
  }, [validCards]);

  // CRITICAL: Listen for incomplete deliveries count change (Rule 1) AND smart refresh events (Rule 2)
  React.useEffect(() => {
    const handleIncompleteCountChanged = () => {
      // RULE 1: Incomplete delivery count changed AND no cards expanded
      if (!selectedCardId) {
        console.log('🎯 [Auto-Center Rule 1] Incomplete count changed - centering next delivery card');
        const nextCard = validCards.find((card) => card?.isNextDelivery === true);
        if (nextCard) {
          const cardElement = document.getElementById(`stop-card-${nextCard.id}`);
          if (cardElement) {
            scrollToCenterCard(cardElement);
          }
        }
      }
    };
    
    const handleSmartRefreshComplete = () => {
      // RULE 2: Collapse all cards, then center next delivery if not centered
      if (!isNextDeliveryCardCentered()) {
        console.log('🎯 [Auto-Center Rule 2] Smart refresh - collapsing all and centering next');
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('collapseAllStopCards'));
        }
        
        setTimeout(() => {
          const nextCard = validCards.find((card) => card?.isNextDelivery === true);
          if (nextCard) {
            const cardElement = document.getElementById(`stop-card-${nextCard.id}`);
            if (cardElement) {
              scrollToCenterCard(cardElement);
            }
          }
        }, 100);
      }
    };
    
    window.addEventListener('incompleteDeliveriesCountChanged', handleIncompleteCountChanged);
    window.addEventListener('smartRefreshComplete', handleSmartRefreshComplete);
    
    return () => {
      window.removeEventListener('incompleteDeliveriesCountChanged', handleIncompleteCountChanged);
      window.removeEventListener('smartRefreshComplete', handleSmartRefreshComplete);
    };
  }, [selectedCardId, validCards, scrollToCenterCard, isNextDeliveryCardCentered]);

  // Enable native scroll with CSS scroll-snap for smooth card-by-card scrolling
  // Removed custom touch handlers that were preventing native scrolling

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

    // Function to perform the scroll with a delay to let cards render/resize
    // Use longer delay (350ms) to wait for card expand/collapse animations
    scrollTimeoutRef.current = setTimeout(() => {
      requestAnimationFrame(() => {
        const container = containerRef.current;
        const element = document.getElementById(`stop-card-${targetCardId}`);

        if (!container || !element) {
          console.warn(`⚠️ [HorizontalStopCards] Cannot scroll - container: ${!!container}, element: ${!!element}`);
          return;
        }

        // Use scrollToCenterCard for consistent centering
        scrollToCenterCard(element);
      });
    }, 350); // Wait for card animations to complete

    // Update ref for tracking
    prevSelectedCardIdRef.current = selectedCardId;

    // Cleanup timeout on unmount or dependency change
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [selectedCardId, scrollToCenterCard]);

  // NOW we can do the safety check and early return
  if (!pickupCards || !Array.isArray(pickupCards) || pickupCards.length === 0) {
    return (
      <div className="text-center py-1 text-slate-500 z-[100]">
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

  const isMobile = isMobileDevice();

  return (
    <div
      ref={setRefs} 
      className="flex gap-3 overflow-x-auto items-end min-h-[75px] pointer-events-auto z-[200]"
      style={{
        scrollbarWidth: isMobile ? 'none' : 'thin',
        msOverflowStyle: isMobile ? 'none' : 'auto',
        WebkitOverflowScrolling: 'touch',
        scrollSnapType: isMobile ? 'x mandatory' : 'none',
        scrollSnapStop: isMobile ? 'always' : 'normal',
        paddingLeft: isMobile ? 'calc(50% - 140px)' : '16px',
        paddingRight: isMobile ? 'calc(50% - 140px)' : '16px'
      }}
      onWheel={(e) => {
        e.currentTarget.scrollLeft += e.deltaY;
      }}

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
            style={{ 
              scrollSnapAlign: isMobile ? 'center' : 'none',
              scrollSnapStop: isMobile ? 'always' : 'normal'
            }}
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

});

HorizontalPickupCards.displayName = 'HorizontalStopCards';

export default HorizontalPickupCards;