import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RefreshCw } from 'lucide-react';

const PullToSync = ({ onSync, isActive = true, children }) => {
  const [pullDistance, setPullDistance] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const touchStartY = useRef(0);
  const containerRef = useRef(null);
  const scrollContainerRef = useRef(null);

  const PULL_THRESHOLD = 80; // Distance to pull before triggering sync
  const MAX_PULL = 120; // Maximum pull distance

  useEffect(() => {
    if (!isActive) return;

    const container = containerRef.current;
    if (!container) return;

    // Find the scrollable container (or use body)
    const scrollable = document.querySelector('.horizontal-cards-container') || document.body;
    scrollContainerRef.current = scrollable;

    const handleTouchStart = (e) => {
      // Only start pull if at top of scroll
      const scrollTop = scrollable === document.body ? window.scrollY : scrollable.scrollTop;
      
      if (scrollTop === 0 && !isSyncing) {
        touchStartY.current = e.touches[0].clientY;
        setIsPulling(true);
      }
    };

    const handleTouchMove = (e) => {
      if (!isPulling || isSyncing) return;

      const currentY = e.touches[0].clientY;
      const diff = currentY - touchStartY.current;

      // Only allow pulling down
      if (diff > 0) {
        const scrollTop = scrollable === document.body ? window.scrollY : scrollable.scrollTop;
        
        // Only pull if still at top
        if (scrollTop === 0) {
          // Prevent default to stop scrolling when pulling
          if (diff > 10) {
            e.preventDefault();
          }
          
          // Apply rubber band effect - slower pull as distance increases
          const rubberBandFactor = 1 - (diff / (MAX_PULL * 2));
          const adjustedPull = Math.min(diff * Math.max(rubberBandFactor, 0.3), MAX_PULL);
          setPullDistance(adjustedPull);
        }
      }
    };

    const handleTouchEnd = async () => {
      if (!isPulling || isSyncing) return;

      setIsPulling(false);

      // Trigger sync if pulled past threshold
      if (pullDistance >= PULL_THRESHOLD) {
        setIsSyncing(true);
        
        try {
          await onSync();
        } catch (error) {
          console.error('Pull-to-sync error:', error);
        } finally {
          setIsSyncing(false);
          setPullDistance(0);
        }
      } else {
        // Snap back if not enough pull
        setPullDistance(0);
      }
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isActive, isPulling, isSyncing, pullDistance, onSync]);

  const pullProgress = Math.min((pullDistance / PULL_THRESHOLD) * 100, 100);
  const iconRotation = (pullDistance / PULL_THRESHOLD) * 360;

  return (
    <div ref={containerRef} className="relative w-full h-full">
      {/* Pull indicator - shows at top of screen */}
      <AnimatePresence>
        {(isPulling && pullDistance > 10) && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute top-0 left-0 right-0 flex justify-center pointer-events-none z-[9999]"
            style={{ transform: `translateY(${Math.min(pullDistance - 40, 40)}px)` }}
          >
            <div className="bg-white/95 backdrop-blur-sm rounded-full shadow-lg p-3 border-2 border-emerald-500">
              <RefreshCw 
                className="w-5 h-5 text-emerald-600" 
                style={{ transform: `rotate(${iconRotation}deg)` }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Syncing overlay - full screen loading indicator */}
      <AnimatePresence>
        {isSyncing && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 flex items-center justify-center pointer-events-none z-[9999]"
            style={{ background: 'rgba(0, 0, 0, 0.3)' }}
          >
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.8, opacity: 0 }}
              className="bg-white rounded-2xl shadow-2xl p-6 flex flex-col items-center gap-3"
            >
              <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
              >
                <RefreshCw className="w-8 h-8 text-emerald-600" />
              </motion.div>
              <p className="text-sm font-medium text-slate-900">Syncing data...</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Content */}
      {children}
    </div>
  );
};

export default PullToSync;