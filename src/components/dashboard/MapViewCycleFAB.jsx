import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Target, Maximize2, Minimize2 } from 'lucide-react';
import { isMobileDevice } from '@/components/utils/deviceUtils';
import { fabControlEvents } from '@/components/utils/fabControlEvents';

export default function MapViewCycleFAB({ onClick, currentPhase, hasVisibleCards = false, isAIVisible = false, isLocked = false, isEnabled = true, stopCardsHeight = 75 }) {
  const [isFlashing, setIsFlashing] = useState(false);
  const [isTemporarilyDeactivated, setIsTemporarilyDeactivated] = useState(false);
  const flashTimeoutRef = useRef(null);
  const deactivateTimeoutRef = useRef(null);
  const lastFlashAtRef = useRef(0);
  const lastFlashKeyRef = useRef('');

  const flashUpdate = useCallback((reason = 'generic', details = {}) => {
    if (currentPhase !== 1) return;

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
    return () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      delete window.__fabFlashUpdate;
      delete window.__currentMapViewPhase;
    };
  }, [currentPhase, flashUpdate]);

  useEffect(() => {
    const unsubscribe = fabControlEvents.subscribe((event) => {
      if (event?.type === 'DEACTIVATE_FAB') {
        setIsTemporarilyDeactivated(true);
        if (deactivateTimeoutRef.current) clearTimeout(deactivateTimeoutRef.current);
        deactivateTimeoutRef.current = setTimeout(() => {
          if ((window.__suppressCardAutoCenterUntil || 0) > Date.now()) return;
          setIsTemporarilyDeactivated(false);
        }, 1200);
        return;
      }

      if (event?.type !== 'REACTIVATE_FAB') return;
      if ((window.__suppressCardAutoCenterUntil || 0) > Date.now()) return;
      setIsTemporarilyDeactivated(false);
      if (deactivateTimeoutRef.current) clearTimeout(deactivateTimeoutRef.current);
      if (event?.suppressIfPhase1 && currentPhase === 1) return;
      flashUpdate(event?.reason || 'generic');
    });

    return () => {
      unsubscribe();
      if (deactivateTimeoutRef.current) clearTimeout(deactivateTimeoutRef.current);
    };
  }, [currentPhase, flashUpdate]);

  // CRITICAL: Fixed position - uses base collapsed height, doesn't move with expansion
  const bottomPixels = (hasVisibleCards ? stopCardsHeight : 0) + 10;
  const fabPosition = isMobileDevice() ? 'absolute' : 'fixed';

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
      return 'Requires more than 1 active stop';
    }
    if (isLocked) {
      return 'Map View Active (click to cycle)';
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
      className="right-4 z-[100]"
      style={{ position: fabPosition, bottom: `${bottomPixels}px` }}>
      
      <motion.div
        animate={isFlashing ? { scale: [1, 1.2, 1], opacity: [1, 0.6, 1] } : { scale: 1, opacity: 1 }}
        transition={{ duration: 0.5 }}>
        <Button
          onClick={onClick}
          title={getTooltip()}
          disabled={!isEnabled}
          className={`inline-flex items-center justify-center whitespace-nowrap text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 text-primary-foreground h-10 w-10 rounded-lg shadow-2xl p-0 relative transition-all duration-200 ${
            !isEnabled || !isLocked || isTemporarilyDeactivated
              ? 'bg-gray-400 hover:bg-gray-500'
              : currentPhase === 2
                ? 'bg-green-600 hover:bg-green-700'
                : 'bg-blue-600 hover:bg-blue-700'
          }`} style={{ pointerEvents: 'auto', touchAction: 'manipulation' }}>
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