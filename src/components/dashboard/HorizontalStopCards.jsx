import React from "react";
import { useDevice } from '@/components/utils/DeviceContext';
import StopCard from '../common/StopCard';
import CyclingMarkerStopCard from './CyclingMarkerStopCard';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { acquireDeliveryActionLock, releaseDeliveryActionLock, getActiveDeliveryAction, isDeliveryActionLocked } from '../utils/deliveryActionLock';
import { getOrientation } from '../utils/deviceUtils';
import { fabControlEvents } from '../utils/fabControlEvents';

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
    bulkSelectionEnabled = false,
    showDriverName = false, // Accept new prop
    getDriverColor, // Accept new prop
    // NEW: Action handlers
    onEdit,
    onEditPatient,
    onDelete,
    onRestart,
    onStatusUpdate,
    onNotesUpdate,
    onCODUpdate,
    onCreateReturn, // NEW: Add onCreateReturn prop
    onStartDelivery, // NEW: Add onStartDelivery prop
    allDeliveries = [], // NEW: Add allDeliveries prop
    selectedDate, // NEW: Add selectedDate prop
    onDriverStatusChange, // NEW: Add onDriverStatusChange prop
    appUsers = [], // NEW: Add appUsers prop for messaging
    onCenteredCardChange,
    isSnapshotModeActive = false
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
  const [containerWidth, setContainerWidth] = React.useState(0);
  const [desktopContainerHeight, setDesktopContainerHeight] = React.useState(120);
  const [desktopCenteredCardId, setDesktopCenteredCardId] = React.useState(null);
  const wheelNavLockRef = React.useRef(0);
  const deliveryActionReleaseTimerRef = React.useRef(null);
  const fabInteractionLockRef = React.useRef(0);
  const manualSwipeUnlockUntilRef = React.useRef(0);

  // Define finished statuses
  const finishedStatuses = ['completed', 'failed', 'cancelled', 'returned'];

  // CRITICAL FIX: Filter out invalid cards and dedupe by id BEFORE sorting/mapping
  const validCards = Array.from(
    new Map(
      pickupCards.
      filter((card) => card && card.id).
      map((card) => [card.id, card])
    ).values()
  );

  // Auto-scroll to selected card - always center when card is expanded
  const prevSelectedCardIdRef = React.useRef(null);
  const autoScrollEnabledRef = React.useRef(true);
  const touchStartXRef = React.useRef(null);
  const touchStartYRef = React.useRef(null);
  const { isMobile } = useDevice();
  const { deviceType } = useDevice();
  const isTabletPortrait = deviceType === 'Tablet' && getOrientation() === 'portrait';
  // Wide folding phones (e.g. Z Fold / Tri-fold unfolded, >= 625px) should use
  // desktop card sizing even though their UA still reports 'Mobile'.
  const isPhone = isMobile && deviceType !== 'Tablet' && window.innerWidth < 625;
  // Use flexible width for any mobile device with a narrow screen (matches StatsPanel formula)
  const useFlexibleCardWidth = isMobile && window.innerWidth < 625;
  const _availableVW = window.innerWidth - (isSnapshotModeActive ? 80 : 0);
  const phoneCardWidth = useFlexibleCardWidth ? Math.round(_availableVW * 0.95) : 370;
  const scrollPadding = useFlexibleCardWidth
    ? `calc(50% - ${Math.round(phoneCardWidth / 2)}px)`
    : 'calc(50% - 140px)';
  const isDesktopFanLayout = false;
  const hasBottomNav = isMobile || isTabletPortrait;

  // Helper function to smoothly scroll to center a specific card element
  const scrollToCenterCard = React.useCallback((cardElement) => {
    const container = containerRef.current;
    if (!container || !cardElement) return;

    const containerWidth = container.offsetWidth;
    const cardOffsetLeft = cardElement.offsetLeft;
    const cardWidth = cardElement.offsetWidth;
    const scrollTarget = cardOffsetLeft - containerWidth / 2 + cardWidth / 2;

    container.scrollTo({
      left: scrollTarget,
      behavior: 'smooth'
    });
  }, []);

  // CRITICAL: Listen for collapse events without toggling collapsed cards open
  React.useEffect(() => {
    const handleCollapseAll = (event) => {
      const targetDriverId = event?.detail?.driverId;
      if (targetDriverId && selectedCardId) {
        const selectedCard = validCards.find((card) => card?.id === selectedCardId);
        if (selectedCard?.driver_id && selectedCard.driver_id !== targetDriverId) return;
      }
      if (!selectedCardId) return;
      console.log('🗜️ [HorizontalStopCards] Collapsing selected card');
      if (onSelectionChange) {
        onSelectionChange(null, false);
      } else if (onCardClick) {
        onCardClick(null);
      }
    };

    const handleCollapseSelected = () => {
      if (!selectedCardId) return;
      if (onSelectionChange) {
        onSelectionChange(null, false);
      } else if (onCardClick) {
        onCardClick(null);
      }
    };

    const centerCardById = (deliveryId) => {
      if (!deliveryId) return;
      const exists = validCards.some((card) => card?.id === deliveryId);
      if (!exists) return;

      if (isDesktopFanLayout) {
        setDesktopCenteredCardId(deliveryId);
        return;
      }

      requestAnimationFrame(() => {
        const element = document.getElementById(`stop-card-${deliveryId}`);
        if (element) {
          scrollToCenterCard(element);
        }
      });
    };

    const handleCenterStopCard = (event) => {
      const deliveryId = event?.detail?.deliveryId;
      centerCardById(deliveryId);
      // Skip map reposition when triggered by a marker click — map already panned via panToMarkerOffset
      if (event?.detail?.fromMarkerClick) return;
      // Skip map reposition for programmatic scrolls — FAB already positioned the map
      if ((window._lastProgrammaticMapMove || 0) > Date.now() - 2000) return;
      const centeredCard = validCards.find((card) => card?.id === deliveryId);
      if (centeredCard) {
        onCenteredCardChange?.({
          deliveryId: centeredCard.id,
          driverId: centeredCard.driver_id,
          isNextDelivery: centeredCard.isNextDelivery === true,
          source: 'external_center'
        });
      }
    };

    const handleCenterNextDeliveryCard = () => {
      if (typeof window !== 'undefined' && (window.__suppressCardAutoCenterUntil || 0) > Date.now()) return;
      const nextCard = validCards.find((card) => card?.isNextDelivery === true);
      centerCardById(nextCard?.id);
      // CRITICAL: Do NOT call onCenteredCardChange for programmatic FAB-initiated scrolls.
      // The FAB effect already positioned the map — calling this would cause a second pan.
      // Only fire onCenteredCardChange for genuine user-swipe events (handled in scroll handler).
    };

    window.addEventListener('collapseAllStopCards', handleCollapseAll);
    window.addEventListener('collapseSelectedStopCard', handleCollapseSelected);
    window.addEventListener('centerStopCard', handleCenterStopCard);
    window.addEventListener('centerNextDeliveryCard', handleCenterNextDeliveryCard);

    return () => {
      window.removeEventListener('collapseAllStopCards', handleCollapseAll);
      window.removeEventListener('collapseSelectedStopCard', handleCollapseSelected);
      window.removeEventListener('centerStopCard', handleCenterStopCard);
      window.removeEventListener('centerNextDeliveryCard', handleCenterNextDeliveryCard);
    };
  }, [onSelectionChange, onCardClick, selectedCardId, validCards, isDesktopFanLayout, scrollToCenterCard]);

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
      if (typeof window !== 'undefined' && (window.__suppressCardAutoCenterUntil || 0) > Date.now()) return;
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
      if (typeof window !== 'undefined' && (window.__suppressCardAutoCenterUntil || 0) > Date.now()) return;
    };

    window.addEventListener('incompleteDeliveriesCountChanged', handleIncompleteCountChanged);
    window.addEventListener('smartRefreshComplete', handleSmartRefreshComplete);

    return () => {
      window.removeEventListener('incompleteDeliveriesCountChanged', handleIncompleteCountChanged);
      window.removeEventListener('smartRefreshComplete', handleSmartRefreshComplete);
    };
  }, [selectedCardId, validCards, scrollToCenterCard]);

  // Enable native scroll with CSS scroll-snap for smooth card-by-card scrolling
  // Removed custom touch handlers that were preventing native scrolling

  React.useEffect(() => {
    const handleDeliveryActionSettled = (event) => {
      const triggeredBy = event?.detail?.triggeredBy;
      const source = event?.detail?.source;
      if (!['start', 'complete', 'restart', 'startOptimized', 'acceptAll', 'acceptAllOptimized'].includes(triggeredBy) && !['start', 'accept_all'].includes(source)) return;
      if (deliveryActionReleaseTimerRef.current) {
        clearTimeout(deliveryActionReleaseTimerRef.current);
        deliveryActionReleaseTimerRef.current = null;
      }
      const activeLock = getActiveDeliveryAction();
      if (activeLock) {
        setTimeout(() => releaseDeliveryActionLock(activeLock), 250);
      }
    };

    window.addEventListener('deliveriesUpdated', handleDeliveryActionSettled);
    window.addEventListener('routeOptimizationComplete', handleDeliveryActionSettled);

    return () => {
      window.removeEventListener('deliveriesUpdated', handleDeliveryActionSettled);
      window.removeEventListener('routeOptimizationComplete', handleDeliveryActionSettled);
      if (deliveryActionReleaseTimerRef.current) {
        clearTimeout(deliveryActionReleaseTimerRef.current);
      }
    };
  }, []);

  React.useEffect(() => {
    if (!selectedCardId || !containerRef.current) {
      prevSelectedCardIdRef.current = selectedCardId;
      return;
    }

    const selectionChanged = prevSelectedCardIdRef.current !== selectedCardId;
    prevSelectedCardIdRef.current = selectedCardId;
    if (!selectionChanged) return;

    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    const targetCardId = selectedCardId;

    scrollTimeoutRef.current = setTimeout(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const container = containerRef.current;
          const element = document.getElementById(`stop-card-${targetCardId}`);
          if (!container || !element) return;
          scrollToCenterCard(element);
        });
      });
    }, 400);

    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, [selectedCardId, scrollToCenterCard]);

  // Dashboard ordering: always follow stop_order, with pending stops last
  const sortedPickupCards = [...validCards].sort((a, b) => {
    if (!a || !b) return 0;

    // Cycling markers are positional anchors — never treat as "pending push to end"
    const isACycling = !!a.is_cycling_marker;
    const isBCycling = !!b.is_cycling_marker;
    const isAPending = a.status === 'pending' && !isACycling;
    const isBPending = b.status === 'pending' && !isBCycling;
    if (isAPending && !isBPending) return 1;
    if (!isAPending && isBPending) return -1;

    const stopOrderA = Number(a.stop_order);
    const stopOrderB = Number(b.stop_order);
    const hasAOrder = Number.isFinite(stopOrderA) && stopOrderA > 0;
    const hasBOrder = Number.isFinite(stopOrderB) && stopOrderB > 0;

    if (hasAOrder && hasBOrder && stopOrderA !== stopOrderB) return stopOrderA - stopOrderB;
    if (hasAOrder && !hasBOrder) return -1;
    if (!hasAOrder && hasBOrder) return 1;

    const etaA = a.delivery_time_eta || a.delivery_time_start || '';
    const etaB = b.delivery_time_eta || b.delivery_time_start || '';
    if (etaA !== etaB) return etaA.localeCompare(etaB);

    return 0;
  });

  const selectedIds = React.useMemo(
    () => Object.keys(selectedDeliveryIds || {}).filter((id) => selectedDeliveryIds[id]),
    [selectedDeliveryIds]
  );
  const hasBulkSelection = bulkSelectionEnabled && selectedIds.length > 0;

  React.useEffect(() => {
    if (!containerRef.current) return;

    const updateWidth = () => {
      setContainerWidth(containerRef.current?.offsetWidth || 0);
    };

    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(containerRef.current);

    return () => observer.disconnect();
  }, [sortedPickupCards.length, isDesktopFanLayout]);

  React.useEffect(() => {
    if (!isDesktopFanLayout || !sortedPickupCards.length) return;

    const selectedExists = selectedCardId && sortedPickupCards.some((card) => card?.id === selectedCardId);
    if (selectedExists) {
      setDesktopCenteredCardId(selectedCardId);
      return;
    }

    const existingExists = desktopCenteredCardId && sortedPickupCards.some((card) => card?.id === desktopCenteredCardId);
    if (existingExists) {
      return;
    }

    const nextDeliveryCard = sortedPickupCards.find((card) => card?.isNextDelivery === true);
    setDesktopCenteredCardId(nextDeliveryCard?.id || sortedPickupCards[0]?.id || null);
  }, [isDesktopFanLayout, sortedPickupCards, selectedCardId, desktopCenteredCardId]);

  React.useEffect(() => {
    if (!onCenteredCardChange || !desktopCenteredCardId) return;
    const centeredCard = sortedPickupCards.find((card) => card?.id === desktopCenteredCardId);
    if (!centeredCard) return;

    onCenteredCardChange({
      deliveryId: centeredCard.id,
      driverId: centeredCard.driver_id,
      isNextDelivery: centeredCard.isNextDelivery === true,
      source: 'desktop_center'
    });
  }, [desktopCenteredCardId, sortedPickupCards, onCenteredCardChange]);

  const centeredCardIndex = React.useMemo(() => {
    if (!sortedPickupCards.length) return 0;
    const currentIndex = sortedPickupCards.findIndex((card) => card?.id === desktopCenteredCardId);
    if (currentIndex >= 0) return currentIndex;
    const nextIndex = sortedPickupCards.findIndex((card) => card?.isNextDelivery === true);
    return nextIndex >= 0 ? nextIndex : 0;
  }, [sortedPickupCards, desktopCenteredCardId]);

  const handleTouchStart = React.useCallback((e) => {
    const touch = e.touches?.[0];
    if (!touch) return;
    touchStartXRef.current = touch.clientX;
    touchStartYRef.current = touch.clientY;
    fabInteractionLockRef.current = 0;
    manualSwipeUnlockUntilRef.current = Date.now() + 3500;
    if (typeof window !== 'undefined') {
      window.__isUserCardSwipe = true;
      window.__suppressCardAutoCenterUntil = manualSwipeUnlockUntilRef.current;
    }
    // Unlock FAB visually so the UI matches the actual lock state when user swipes cards
    fabControlEvents.notifyUserMapInteraction();
    if (isDesktopFanLayout) return;
  }, [isDesktopFanLayout]);

  const handleTouchMove = React.useCallback((e) => {
    const touch = e.touches?.[0];
    const startX = touchStartXRef.current;
    const startY = touchStartYRef.current;
    if (!touch || startX === null || startY === null) return;

    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    if (Math.abs(deltaX) < 16 || Math.abs(deltaX) <= Math.abs(deltaY)) return;
    if (fabInteractionLockRef.current) return;

    fabInteractionLockRef.current = Date.now();
    manualSwipeUnlockUntilRef.current = Date.now() + 2500;
    if (typeof window !== 'undefined') {
      window.__isUserCardSwipe = true;
      window.__suppressCardAutoCenterUntil = manualSwipeUnlockUntilRef.current;
    }
  }, []);

  const handleTouchEnd = React.useCallback((e) => {
    const touch = e.changedTouches?.[0];
    const startX = touchStartXRef.current;
    const startY = touchStartYRef.current;

    touchStartXRef.current = null;
    touchStartYRef.current = null;
    fabInteractionLockRef.current = 0;
    manualSwipeUnlockUntilRef.current = Date.now() + 1500;
    if (typeof window !== 'undefined') {
      window.__isUserCardSwipe = true;
      window.__suppressCardAutoCenterUntil = manualSwipeUnlockUntilRef.current;
    }

    if (!isDesktopFanLayout) return;
    if (!touch || startX === null || startY === null) return;

    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;

    if (Math.abs(deltaX) < 40 || Math.abs(deltaX) <= Math.abs(deltaY)) return;

    const direction = deltaX < 0 ? 1 : -1;
    const nextIndex = Math.max(0, Math.min(sortedPickupCards.length - 1, centeredCardIndex + direction));
    const nextCard = sortedPickupCards[nextIndex];
    if (nextCard?.id) {
      setDesktopCenteredCardId(nextCard.id);
    }
  }, [isDesktopFanLayout, sortedPickupCards, centeredCardIndex]);

  React.useEffect(() => {
    if (!isDesktopFanLayout) {
      setDesktopContainerHeight(120);
      return;
    }

    const selectedId = selectedCardId || desktopCenteredCardId;
    const targetElement = selectedId ? document.getElementById(`stop-card-${selectedId}`) : null;
    const incompleteElements = sortedPickupCards.
    filter((card) => card && !finishedStatuses.includes(card.status)).
    map((card) => document.getElementById(`stop-card-${card.id}`)).
    filter(Boolean);

    const updateHeight = () => {
      const targetHeight = targetElement ? Math.ceil(targetElement.offsetHeight) + 0 : 122;

      if (incompleteElements.length === 0) {
        setDesktopContainerHeight(targetHeight);
        return;
      }

      const tallestIncompleteHeight = Math.max(
        ...incompleteElements.map((element) => Math.ceil(element.offsetHeight) + 0),
        120
      );

      setDesktopContainerHeight(Math.max(targetHeight, tallestIncompleteHeight));
    };

    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    if (targetElement) {
      observer.observe(targetElement);
    }
    incompleteElements.forEach((element) => observer.observe(element));

    return () => observer.disconnect();
  }, [isDesktopFanLayout, selectedCardId, desktopCenteredCardId, sortedPickupCards, finishedStatuses]);

  const desktopFanLayout = React.useMemo(() => {
    if (!isDesktopFanLayout || !sortedPickupCards.length || !containerWidth) return null;

    const cardWidth = 338;
    const centerLeft = Math.max(0, (containerWidth - cardWidth) / 2);
    const anchorIndex = centeredCardIndex;
    const leftCount = anchorIndex;
    const rightCount = sortedPickupCards.length - anchorIndex - 1;
    const leftStep = leftCount > 0 ? centerLeft / leftCount : Infinity;
    const rightStep = rightCount > 0 ? centerLeft / rightCount : Infinity;

    let step = Math.min(leftStep, rightStep, 86);
    if (!Number.isFinite(step)) step = 86;
    step = Math.max(18, step);

    return sortedPickupCards.map((card, index) => {
      const offset = index - anchorIndex;
      const distance = Math.abs(offset);
      const isCenteredCard = index === anchorIndex;

      return {
        left: centerLeft + offset * step,
        rotate: 0,
        translateY: 0,
        zIndex: isCenteredCard ? 2000 : 1000 - distance
      };
    });
  }, [isDesktopFanLayout, sortedPickupCards, containerWidth, centeredCardIndex]);

  if (!pickupCards || !Array.isArray(pickupCards) || pickupCards.length === 0) {
    return null;
  }

  return (
    <div
      ref={setRefs} className="flex gap-1.5 overflow-x-auto overflow-y-visible items-end min-h-[70px] pointer-events-auto z-[200]"
      style={{
        position: 'static',
        display: 'flex',
        height: 'auto',
        minHeight: '70px',
        overflowX: 'auto',
        overflowY: 'visible',
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
        WebkitOverflowScrolling: 'touch',
        touchAction: 'pan-x',
        scrollSnapType: isMobile ? 'x mandatory' : 'none',
        scrollSnapStop: isMobile ? 'always' : 'normal',
        paddingLeft: isMobile ? scrollPadding : '16px',
        paddingRight: isMobile ? scrollPadding : '16px',
        paddingBottom: 0
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onClickCapture={(e) => {
        const actionButton = e.target?.closest?.('[data-stopcard-action="start"], [data-stopcard-action="complete"], [data-stopcard-action="restart"]');
        if (!actionButton) return;

        e.preventDefault();
        e.stopPropagation();

        const buttonText = (actionButton.textContent || '').trim().toLowerCase();
        const isStartAction = actionButton.matches?.('[data-stopcard-action="start"]') || buttonText === 'start';
        const isCompleteAction = actionButton.matches?.('[data-stopcard-action="complete"]') || buttonText === 'complete';
        const isRestartAction = actionButton.matches?.('[data-stopcard-action="restart"]') || buttonText === 'restart';

        if (!isStartAction && !isCompleteAction && !isRestartAction) return;

        if (isRestartAction) return;

        if (isDeliveryActionLocked()) {
          e.preventDefault();
          e.stopPropagation();
          toast.message('Please wait for the current delivery action to finish.');
          return;
        }

        const lock = acquireDeliveryActionLock(isStartAction ? 'start_delivery' : 'complete_delivery');
        if (!lock) {
          e.preventDefault();
          e.stopPropagation();
          toast.message('Please wait for the current delivery action to finish.');
          return;
        }

        if (deliveryActionReleaseTimerRef.current) {
          clearTimeout(deliveryActionReleaseTimerRef.current);
        }

        deliveryActionReleaseTimerRef.current = setTimeout(() => {
          releaseDeliveryActionLock(lock);
          deliveryActionReleaseTimerRef.current = null;
        }, 20000);
      }}
      onWheel={(e) => {
        const axisDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (Math.abs(axisDelta) < 8) return;

        e.stopPropagation();

        if (isDesktopFanLayout) {
          if (Date.now() - wheelNavLockRef.current < 120) return;

          wheelNavLockRef.current = Date.now();
          const direction = axisDelta > 0 ? 1 : -1;
          const nextIndex = Math.max(0, Math.min(sortedPickupCards.length - 1, centeredCardIndex + direction));
          const nextCard = sortedPickupCards[nextIndex];
          if (nextCard?.id) {
            setDesktopCenteredCardId(nextCard.id);
          }
          return;
        }

        e.currentTarget.scrollLeft += axisDelta;
      }}
      onScroll={() => {
        if (!isDesktopFanLayout) {
          autoScrollEnabledRef.current = false;
        }
      }}>
      
      {isDesktopFanLayout && <style>{`
        .desktop-stop-card-shell[data-rail-condensed="true"] > [id^="stop-card-"] > .rounded-xl {
          max-height: 96px;
          overflow: hidden;
        }

        .desktop-stop-card-shell[data-rail-condensed="false"] > [id^="stop-card-"] > .rounded-xl {
          min-height: 188px;
        }

        .desktop-stop-card-shell > [id^="stop-card-"] > .rounded-xl[data-route-completed-condensed="true"] {
          min-height: 0 !important;
        }
      `}</style>}

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

        // const cardSelectedDeliveries = selectedDeliveryIds[card.id] || [];

        const cardIndex = sortedPickupCards.findIndex((item) => item?.id === card.id);
        const fanStyle = desktopFanLayout?.[cardIndex];
        const isRailCentered = !isDesktopFanLayout || card.id === sortedPickupCards[centeredCardIndex]?.id;
        // Fan in only if the card immediately before this one is bulk-selected
        const prevCard = sortedPickupCards[cardIndex - 1];
        const isInRightDeck = bulkSelectionEnabled && !!prevCard && !!selectedDeliveryIds?.[prevCard.id];
        const sequentialCardZIndex = 200 + cardIndex;

        // Cycling markers get their own special inline pin card
        if (card.is_cycling_marker) {
          return (
            <div
              key={card.id}
              id={`stop-card-${card.id}`}
              className="flex-shrink-0 pointer-events-auto flex items-stretch"
              style={{
                scrollSnapAlign: isMobile ? 'center' : 'none',
                scrollSnapStop: isMobile ? 'always' : 'normal',
                zIndex: sequentialCardZIndex,
                position: 'relative',
                overflow: 'visible',
              }}
              data-is-next-delivery={card.isNextDelivery ? "true" : undefined}
            >
              <CyclingMarkerStopCard
                delivery={card}
                stopOrder={card.stop_order}
                onEdit={onEdit}
                onDelete={onDelete}
                onComplete={onStatusUpdate}
                onRestart={onRestart}
                allDeliveries={allDeliveries}
                isSelected={isSelected}
                onStartDelivery={onStartDelivery}
              />
            </div>
          );
        }

        return (
          <div
            key={card.id}
            id={`stop-card-${card.id}`}
            className="desktop-stop-card-shell flex-shrink-0 pointer-events-auto transition-all duration-300 ease-out"
            data-rail-condensed={isDesktopFanLayout && !isRailCentered ? 'true' : 'false'}
            style={{
              position: 'relative',
              overflow: 'visible',
              scrollSnapAlign: isMobile ? 'center' : 'none',
              scrollSnapStop: isMobile ? 'always' : 'normal',
              marginLeft: isInRightDeck
                ? isMobile
                  ? `${-(phoneCardWidth - 60)}px`
                  : '-290px'
                : undefined,
              zIndex: sequentialCardZIndex
            }}
            data-is-next-delivery={card.isNextDelivery ? "true" : undefined}>
            <StopCard
              delivery={card}
              store={store}
              driver={driver}
              patients={patients || []}
              currentUser={currentUser}
              cardWidthOverride={useFlexibleCardWidth ? phoneCardWidth : undefined}
              onClick={(clickedCard) => {
                if (!clickedCard) {
                  if (onSelectionChange) onSelectionChange(null, false);else
                  if (onCardClick) onCardClick(null);
                  return;
                }
                onCardClick(clickedCard);
              }}
              isSelected={isSelected}
              isProjected={isProjected}
              pendingPickups={projectedDeliveriesForCard}
              onSelectionChange={onSelectionChange}
              selectedDeliveryIds={selectedDeliveryIds}
              stopOrder={stopOrder}
              bulkSelectionEnabled={bulkSelectionEnabled}
              showDriverName={showDriverName}
              getDriverColor={getDriverColor}
              onEdit={onEdit}
              onEditPatient={onEditPatient}
              onDelete={onDelete}
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
              appUsers={appUsers}
              isRailCentered={isRailCentered || isInRightDeck} />

          </div>);

      })}
    </div>);

});

HorizontalPickupCards.displayName = 'HorizontalStopCards';

export default HorizontalPickupCards;