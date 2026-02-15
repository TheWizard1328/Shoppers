import React, { useState, useEffect } from 'react';
import { Loader2, Navigation } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function OptimizationSpinner() {
  const [isOptimizing, setIsOptimizing] = useState(false);

  useEffect(() => {
    const handleOptimizationStart = () => {
      setIsOptimizing(true);
    };

    const handleOptimizationEnd = () => {
      setIsOptimizing(false);
    };

    window.addEventListener('routeOptimizationStarted', handleOptimizationStart);
    window.addEventListener('routeOptimizationComplete', handleOptimizationEnd);

    return () => {
      window.removeEventListener('routeOptimizationStarted', handleOptimizationStart);
      window.removeEventListener('routeOptimizationComplete', handleOptimizationEnd);
    };
  }, []);

  return (
    <AnimatePresence>
      {isOptimizing && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 pointer-events-none"
          style={{ zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', left: 0, right: 0, paddingTop: '140px' }}
        >
          <div className="bg-white/90 backdrop-blur-sm rounded-2xl p-6 shadow-2xl flex flex-col items-center gap-3">
            <div className="relative">
              <Loader2 className="w-12 h-12 text-blue-600 animate-spin" />
              <Navigation className="w-6 h-6 text-blue-600 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
            </div>
            <p className="text-sm font-medium text-slate-700">Optimizing route...</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}