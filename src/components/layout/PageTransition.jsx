import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useLocation, useNavigationType } from 'react-router-dom';

export default function PageTransition({ children }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const isMobileLayout = typeof window !== 'undefined' && window.innerWidth < 768;
  const horizontalOffset = isMobileLayout ? 24 : 0;
  const enterX = navigationType === 'POP' ? -horizontalOffset : horizontalOffset;
  const exitX = navigationType === 'POP' ? horizontalOffset : -horizontalOffset;

  return (
    <div className="relative w-full h-full overflow-hidden">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={`${location.pathname}${location.search}`}
          initial={{ opacity: 0, x: enterX, scale: isMobileLayout ? 0.995 : 1 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: exitX, scale: isMobileLayout ? 0.995 : 1 }}
          transition={{ duration: isMobileLayout ? 0.22 : 0.16, ease: 'easeOut' }}
          className="w-full h-full"
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}