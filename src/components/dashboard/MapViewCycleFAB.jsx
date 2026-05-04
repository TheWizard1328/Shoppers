import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Target, Maximize2, Minimize2 } from 'lucide-react';
import { isMobileDevice } from '@/components/utils/deviceUtils';
import { fabControlEvents } from '@/components/utils/fabControlEvents';

export default function MapViewCycleFAB({ currentUser = null, filteredDeliveries = [], onClick, currentPhase, hasVisibleCards = false, isAIVisible = false, isLocked = false, isEnabled = true, stopCardsHeight = 75, isMotionDimmed = false, immersiveHidden = false }) {
  const [isFlashing, setIsFlashing] = useState(false);
  const [isTemporarilyDeactivated, setIsTemporarilyDeactivated] = useState(false);
  const flashTimeoutRef = useRef(null);
  const deactivateTimeoutRef = useRef(null);
  const lastFlashAtRef = useRef(0);
  const lastFlashKeyRef = useRef('');

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
        setIsTemporarilyDeactivated(false);
        if (deactivateTimeoutRef.current) clearTimeout(deactivateTimeoutRef.current);
        deactivateTimeoutRef.current = setTimeout(() => {
          setIsTemporarilyDeactivated(true);
        }, currentPhase === 1 ? 3000 : Math.max(1200, (window.__suppressCardAutoCenterUntil || 0) - Date.now()));
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

      if (event?.type !== 'REACTIVATE_FAB' && event?.type !== 'IMMERSIVE_MODE_TOGGLED' && event?.type !== 'DATA_READY') return;
      if ((event?.type === 'REACTIVATE_FAB' || event?.type === 'DATA_READY') && (window.__suppressCardAutoCenterUntil || 0) > Date.now()) return;
      setIsTemporarilyDeactivated(false);
      if (deactivateTimeoutRef.current) clearTimeout(deactivateTimeoutRef.current);
      if (event?.suppressIfPhase1 && currentPhase === 1) return;
      if (currentPhase === 1) {
        deactivateTimeoutRef.current = setTimeout(() => {
          setIsTemporarilyDeactivated(true);
        }, 500);
      }
      if (event?.type === 'IMMERSIVE_MODE_TOGGLED' && (currentPhase === 2 || currentPhase === 3)) {
        return;
      }
      flashUpdate(event?.reason || 'route_change');
    });

    return () => {
      unsubscribe();
      if (deactivateTimeoutRef.current) clearTimeout(deactivateTimeoutRef.current);
    };
  }, [currentPhase, flashUpdate]);

  // CRITICAL: Fixed position - uses base collapsed height, doesn't move with expansion
  const bottomPixels = ((hasVisibleCards && !immersiveHidden) ? stopCardsHeight : 0) + 10;
  const fabPosition = isMobileDevice() ? 'absolute' : 'fixed';
  const rightPixels = immersiveHidden ? 12 : 16;

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
    if (!isEnabled) {
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
            onClick?.(event);
          }}
          title={getTooltip()}
          data-fab-temporarily-deactivated={isTemporarilyDeactivated ? 'true' : 'false'}
          className={`inline-flex items-center justify-center whitespace-nowrap text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&_svg]:pointer-events-none [&_svg]:shrink-0 text-primary-foreground h-10 w-10 rounded-lg shadow-2xl p-0 relative transition-all duration-200 ${
            !isEnabled
              ? 'bg-gray-400 hover:bg-gray-500'
              : currentPhase === 1
                ? (isLocked && !isTemporarilyDeactivated ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-400 hover:bg-gray-500')
                : currentPhase === 2
                  ? 'bg-blue-600 hover:bg-blue-700'
                  : currentPhase === 3
                    ? 'bg-blue-600 hover:bg-blue-700'
                    : 'bg-blue-600 hover:bg-blue-700'
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