import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useLocation, useNavigationType } from 'react-router-dom';
import { useMobileNavigation } from '@/components/navigation/MobileNavigationProvider';

export default function PageTransition({ children }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const { lastAction } = useMobileNavigation();
  const isMobileLayout = typeof window !== 'undefined' && window.innerWidth < 768;
  const horizontalOffset = isMobileLayout ? 28 : 0;
  const transitionAction = lastAction || (navigationType === 'POP' ? 'pop' : 'push');
  const enterX = transitionAction === 'pop' ? -horizontalOffset : horizontalOffset;
  const exitX = transitionAction === 'pop' ? horizontalOffset : -horizontalOffset;

  return (
    <div className="relative w-full h-full overflow-hidden">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={`${location.pathname}${location.search}`}
          initial={{ opacity: 0, x: enterX, scale: isMobileLayout ? 0.995 : 1 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: exitX, scale: isMobileLayout ? 0.995 : 1 }}
          transition={{ duration: isMobileLayout ? 0.24 : 0.16, ease: [0.22, 1, 0.36, 1] }}
          className="w-full h-full"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}