import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useDevice } from '@/components/utils/DeviceContext';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Target, Maximize2, Minimize2 } from 'lucide-react';

import { fabControlEvents } from '@/components/utils/fabControlEvents';

export default function MapViewCycleFAB({
  currentUser = null, filteredDeliveries = [], onClick, currentPhase, hasVisibleCards = false, isAIVisible = false, isLocked = false, isEnabled = true, stopCardsHeight = 75, isMotionDimmed = false, immersiveHidden = false, bottomNavHeight = 0 }) {
  const { isMobile } = useDevice();
  const [isFlashing, setIsFlashing] = useState(false);
  const [isTemporarilyDeactivated, setIsTemporarilyDeactivated] = useState(false);
  const flashTimeoutRef = useRef(null);
  const deactivateTimeoutRef = useRef(null);
  const lastFlashAtRef = useRef(0);
  const lastFlashKeyRef = useRef('');
  const lastClickAtRef = useRef(0);

  const flashUpdate = useCallback((reason = 'generic', details = {}) => {
    if (currentPhase !== 1) return;
    if (reason === 'data_ready') return;

    const now = Date.now();
    const throttleWindow = reason === 'route_change' || reason === 'completed_stop' ? 350 : 2500;

    if (currentPhase === 1 && reason !== 'route_change') return;
    const flashKey = `${reason}:${details?.driverId || 'all'}:${details?.deliveryDate || 'all'}:${details?.deliveryId || 'all'}`;

    if (lastFlashKeyRef.current === flashKey && now - lastFlashAtRef.current < throttleWindow) return;
    if (now - lastFlashAtRef.current < throttleWindow) return;

    lastFlashAtRef.current = now;
    lastFlashKeyRef.current = flashKey;
    setIsFlashing(true);

    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    flashTimeoutRef.current = setTimeout(() => setIsFlashing(false), 500);
  }, [currentPhase]);

  // Make flash method available globally
  // CRITICAL: Clear deactivated state whenever we enter phase 2 or 3
  useEffect(() => {
    if (currentPhase === 2 || currentPhase === 3) {
      setIsTemporarilyDeactivated(false);
      if (deactivateTimeoutRef.current) {
        clearTimeout(deactivateTimeoutRef.current);
        deactivateTimeoutRef.current = null;
      }
    }
  }, [currentPhase]);

  // SELF-HEALING SAFETY NET: several code paths intentionally publish
  // FAB_MAP_UNLOCKED_BY_USER_INTERACTION as a "visual flash only" signal without
  // actually unlocking the map (e.g. double-tap zoom in MapSection.jsx, or the
  // Navigate button's temp-unlock/re-lock cycle in useFabControlEventHandler.jsx).
  // Those paths never publish a matching "clear the gray-out" event once the map
  // re-locks — REACTIVATE_FAB/DATA_READY/IMMERSIVE_MODE_TOGGLED are the only
  // events this component listens for to un-gray, and none of those fire from
  // e.g. REACTIVATE_PHASE_TWO_IF_AVAILABLE. Result: the FAB gets stuck gray
  // ("looks unlocked") forever even though isMapViewLocked (the real state) is
  // true again — exactly the "phase 2 but FAB doesn't look locked" bug.
  // Fix: tie the visual state back to the authoritative `isLocked` prop — the
  // instant the map is confirmed locked again, clear any stale gray override.
  useEffect(() => {
    if (isLocked && isTemporarilyDeactivated) {
      setIsTemporarilyDeactivated(false);
      if (deactivateTimeoutRef.current) {
        clearTimeout(deactivateTimeoutRef.current);
        deactivateTimeoutRef.current = null;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLocked]);

  useEffect(() => {
    window.__fabFlashUpdate = flashUpdate;
    window.__currentMapViewPhase = currentPhase;
    window.__currentMapViewFABLocked = isLocked;
    window.__currentUserForFAB = currentUser || null;
    window.__fabContextDeliveries = filteredDeliveries || [];
    return () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      delete window.__fabFlashUpdate;
      delete window.__currentMapViewPhase;
      delete window.__currentMapViewFABLocked;
      delete window.__currentUserForFAB;
      delete window.__fabContextDeliveries;
    };
  }, [currentPhase, flashUpdate, isLocked, currentUser, filteredDeliveries]);

  useEffect(() => {
    const unsubscribe = fabControlEvents.subscribe((event) => {
      if (event?.type === 'DEACTIVATE_FAB') {
        // In phase 2 or 3 the FAB should always stay colored/active — never gray it out
        if (currentPhase === 2 || currentPhase === 3) {
          setIsTemporarilyDeactivated(false);
          if (deactivateTimeoutRef.current) { clearTimeout(deactivateTimeoutRef.current); deactivateTimeoutRef.current = null; }
          return;
        }
        setIsTemporarilyDeactivated(false);
        if (deactivateTimeoutRef.current) clearTimeout(deactivateTimeoutRef.current);
        deactivateTimeoutRef.current = setTimeout(() => {
          setIsTemporarilyDeactivated(true);
        }, 3000);
        return;
      }

      if (event?.type === 'DONE_RESET_TO_PHASE_ONE') {
        setIsTemporarilyDeactivated(false);
        if (deactivateTimeoutRef.current) clearTimeout(deactivateTimeoutRef.current);
        deactivateTimeoutRef.current = setTimeout(() => {
          setIsTemporarilyDeactivated(true);
        }, event?.duration || 500);
        flashUpdate('route_change');
        return;
      }

      // User manually panned/zoomed the map → immediately show the FAB as unlocked
      if (event?.type === 'FAB_MAP_UNLOCKED_BY_USER_INTERACTION') {
        // CRITICAL: Double-tap zoom in phase 2/3 passes isVisualOnly=true — the map is
        // NOT actually unlocking (mapUserUnlockedRef stays false, isMapViewLocked stays
        // true). The gray-out should be a brief 1.5s flash, not permanent. Without this,
        // the FAB gets stuck gray forever after a double-tap zoom: the map re-locks on the
        // next GPS tick but nothing clears isTemporarilyDeactivated, so the FAB looks
        // unlocked while the map is actually locked. Tapping it then cycles the phase
        // (advances to phase 3 or 1) instead of re-locking, because handleMapViewCycle
        // sees isCurrentlyLocked=true (the real state) and treats the tap as a cycle.
        const isVisualOnly = event?.isVisualOnly === true;
        if (isVisualOnly && (currentPhase === 2 || currentPhase === 3)) {
          setIsTemporarilyDeactivated(true);
          if (deactivateTimeoutRef.current) clearTimeout(deactivateTimeoutRef.current);
          deactivateTimeoutRef.current = setTimeout(() => {
            setIsTemporarilyDeactivated(false);
          }, 1500);
          return;
        }
        // Real unlock (user dragged/pinched, or Navigate button temp-unlock) — stay gray
        // until the map is explicitly re-locked (REACTIVATE_FAB, REACTIVATE_PHASE_TWO_IF_AVAILABLE,
        // or the self-healing isLocked effect below).
        setIsTemporarilyDeactivated(true);
        if (deactivateTimeoutRef.current) clearTimeout(deactivateTimeoutRef.current);
        return;
      }
      if (event?.type !== 'REACTIVATE_FAB' && event?.type !== 'IMMERSIVE_MODE_TOGGLED' && event?.type !== 'DATA_READY') return;
      // When immersive mode exits in phases 2/3, re-activate the FAB visual (clear gray state)
      if (event?.type === 'IMMERSIVE_MODE_TOGGLED' && (currentPhase === 2 || currentPhase === 3)) {
        setIsTemporarilyDeactivated(false);
        if (deactivateTimeoutRef.current) { clearTimeout(deactivateTimeoutRef.current); deactivateTimeoutRef.current = null; }
        return;
      }
      if ((event?.type === 'REACTIVATE_FAB' || event?.type === 'DATA_READY') && (window.__suppressCardAutoCenterUntil || 0) > Date.now()) return;
      setIsTemporarilyDeactivated(false);
      if (deactivateTimeoutRef.current) clearTimeout(deactivateTimeoutRef.current);
      if (event?.suppressIfPhase1 && currentPhase === 1) return;
      // Only schedule deactivation (gray-out) for phase 1 — phases 2/3 always stay colored
      if (currentPhase === 1) {
        deactivateTimeoutRef.current = setTimeout(() => {
          setIsTemporarilyDeactivated(true);
        }, 500);
      } else {
        setIsTemporarilyDeactivated(false);
      }
      flashUpdate(event?.reason || 'route_change');
    });

    return () => {
      unsubscribe();
      if (deactivateTimeoutRef.current) clearTimeout(deactivateTimeoutRef.current);
    };
  }, [currentPhase, flashUpdate]);

  // CRITICAL: Fixed position - uses base collapsed height, doesn't move with expansion
  // Must also account for bottomNavHeight since stop cards sit above it
  const bottomPixels = ((hasVisibleCards && !immersiveHidden) ? stopCardsHeight + bottomNavHeight : bottomNavHeight) + 10;
  const fabPosition = isMobile ? 'absolute' : 'fixed';
  const rightPixels = immersiveHidden ? 12 : 16;

  // No longer needed — GuideAssistant uses getBoundingClientRect directly.

  const fabOpacity = useMemo(() => {
    if (!isEnabled) return 0.65;
    return isMotionDimmed ? 0.45 : 1;
  }, [isEnabled, isMotionDimmed]);

  // Get icon based on current phase (always white icon)
  const getIcon = () => {
    switch (currentPhase) {
      case 1:
        return <Maximize2 className="w-5 h-5 text-white" />;
      case 2:
        return <Minimize2 className="w-5 h-5 text-white" />;
      case 3:
        return <Target className="w-5 h-5 text-white" />;
      default:
        return <Target className="w-5 h-5 text-white" />;
    }
  };

  // Get tooltip text based on phase and lock state
  const getTooltip = () => {
    if (!isEnabled && currentPhase !== 1) {
      return 'Requires at least 1 active stop';
    }
    if (isLocked) {
      return 'Map View Active (click to cycle)';
    }
    if (isTemporarilyDeactivated) {
      return 'Map View Temporarily Unlocked';
    }
    switch (currentPhase) {
      case 1:
        return 'Show All Stops';
      case 2:
        return 'Active Drivers & Next Stops';
      case 3:
        return 'Show Incomplete & Pending';
      default:
        return 'Cycle Map View';
    }
  };

  return (
    <motion.div
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 20 }}
      className="z-[100]"
      data-map-cycle-fab="true"
      style={{ position: fabPosition, bottom: `${bottomPixels}px`, right: `${rightPixels}px` }}>
      
      <motion.div
        animate={isFlashing ? { scale: [1, 1.2, 1], opacity: [1, 0.6, 1] } : { scale: 1, opacity: 1 }}
        transition={{ duration: 0.5 }}>
        <Button
          onClick={(event) => {
            if (!isEnabled) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            // Debounce: ignore clicks within 600ms of the last one to prevent
            // mobile double-tap or touch+click ghost events from double-cycling the phase
            const now = Date.now();
            if (now - lastClickAtRef.current < 600) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            lastClickAtRef.current = now;
            // CRITICAL: Always clear deactivated state on user click so color feedback is immediate
            setIsTemporarilyDeactivated(false);
            if (deactivateTimeoutRef.current) {
              clearTimeout(deactivateTimeoutRef.current);
              deactivateTimeoutRef.current = null;
            }
            onClick?.(event);
          }}
          title={getTooltip()}
          data-fab-temporarily-deactivated={isTemporarilyDeactivated ? 'true' : 'false'}
          className={`inline-flex items-center justify-center whitespace-nowrap text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&_svg]:pointer-events-none [&_svg]:shrink-0 text-primary-foreground h-10 w-10 rounded-lg shadow-2xl p-0 relative transition-all duration-200 ${
            !isEnabled
              ? 'bg-gray-400 hover:bg-gray-500'
              : isTemporarilyDeactivated
                ? 'bg-gray-400 hover:bg-gray-500'
                : currentPhase === 2
                  ? 'bg-green-600 hover:bg-green-700'
                  : currentPhase === 3
                    ? 'bg-blue-600 hover:bg-blue-700'
                    : (isLocked ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-400 hover:bg-gray-500')
          }`} style={{ pointerEvents: 'auto', touchAction: 'manipulation', opacity: fabOpacity, cursor: isEnabled ? 'pointer' : 'not-allowed' }}>
          {/* Mode number in top-left corner */}
          <span className="absolute top-1 left-1 text-white font-bold text-[10px]">
            {currentPhase}
          </span>
          {getIcon()}
        </Button>
      </motion.div>
    </motion.div>
  );
}