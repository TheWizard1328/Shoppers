import React, { useState, useEffect } from 'react';
import { Loader2, Navigation } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export default function OptimizationSpinner() {
  const [isOptimizing, setIsOptimizing] = useState(false);

  useEffect(() => {
    const visibleSources = new Set(['optimize_route_fab', 'accept_all']);

    const handleOptimizationStart = (event) => {
      const source = event?.detail?.source;
      if (!visibleSources.has(source)) return;
      setIsOptimizing(true);
    };

    const handleOptimizationEnd = (event) => {
      const source = event?.detail?.source;
      if (!visibleSources.has(source)) return;
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
          style={{
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            left: 0,
            right: 0,
            background: 'color-mix(in srgb, var(--bg-slate-900) 45%, transparent)'
          }}
        >
          <div
            className="backdrop-blur-sm rounded-2xl p-6 shadow-2xl flex flex-col items-center gap-3 border"
            style={{
              background: 'color-mix(in srgb, var(--bg-white) 92%, transparent)',
              borderColor: 'var(--border-slate-200)'
            }}
          >
            <div className="relative">
              <Loader2 className="w-12 h-12 animate-spin" style={{ color: 'var(--primary-color, #2563eb)' }} />
              <Navigation className="w-6 h-6 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" style={{ color: 'var(--primary-color, #2563eb)' }} />
            </div>
            <p className="text-sm font-medium" style={{ color: 'var(--text-slate-700)' }}>Optimizing route...</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}