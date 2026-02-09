import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Target, Maximize2, Minimize2 } from 'lucide-react';

export default function MapViewCycleFAB({ onClick, currentPhase, hasVisibleCards = false, isAIVisible = false, isLocked = false, stopCardsHeight = 75 }) {
  const [isFlashing, setIsFlashing] = useState(false);

  const flashUpdate = () => {
    if (currentPhase !== 1) return;
    setIsFlashing(true);
    setTimeout(() => setIsFlashing(false), 500);
  };

  // Make flash method available globally
  useEffect(() => {
    window.__fabFlashUpdate = flashUpdate;
    return () => delete window.__fabFlashUpdate;
  }, [currentPhase]);

  // CRITICAL: Fixed position - never moves with card expansion
  const bottomPixels = (hasVisibleCards ? stopCardsHeight : 0) + 15;

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
    if (isLocked) {
      return 'Map View Active (click to cycle)';
    }
    switch (currentPhase) {
      case 1:
        return 'Show All Stops';
      case 2:
        return 'Center on Driver & Next Stop';
      case 3:
        return 'Show All Active Drivers';
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
      className="fixed right-4 z-[250]"
      style={{ bottom: `${bottomPixels}px` }}>
      
      <motion.div
        animate={isFlashing ? { scale: [1, 1.2, 1], opacity: [1, 0.6, 1] } : { scale: 1, opacity: 1 }}
        transition={{ duration: 0.5 }}>
        <Button
          onClick={onClick}
          title={getTooltip()}
          className={`inline-flex items-center justify-center whitespace-nowrap text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 text-primary-foreground h-10 w-10 rounded-lg shadow-2xl p-0 relative transition-all duration-200 ${
            isLocked 
              ? 'bg-blue-600 hover:bg-blue-700' 
              : 'bg-gray-400 hover:bg-gray-500'
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