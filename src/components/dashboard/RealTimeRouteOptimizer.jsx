// sync-marker: 1784314529
import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Route, CheckCircle } from 'lucide-react';

/**
 * RealTimeRouteOptimizer (NEUTERED)
 *
 * This component previously listened for `deliveriesUpdated` and
 * `triggerRouteOptimization` events to call the BACKEND `optimizeRemainingStops`
 * function. That backend optimizer competed with the client-side
 * `performRouteOptimization` coordinator (clientRouteEngine.js), causing:
 *   - Stop order bouncing for 1-2 minutes after Accept All / Assign All
 *   - Full-replacement `deliveriesUpdated` dispatches that reverted optimistic UI state
 *   - Duplicate HERE API calls
 *
 * All route optimization now flows exclusively through the client-side
 * `performRouteOptimization` coordinator. This component is kept only for its
 * notification UI, which is now driven by `routeOptimizationComplete` events
 * dispatched by the client-side engine.
 *
 * DO NOT re-add event listeners that call backend optimization functions.
 */

export default function RealTimeRouteOptimizer({
  selectedDriverId,
  selectedDate,
  currentUser,
  isActive = true,
  onRouteOptimized
}) {
  const [notification, setNotification] = useState(null);

  useEffect(() => {
    // Listen for optimization completion events from the client-side engine
    const handleOptimizationComplete = (event) => {
      const { driverId, deliveryDate, optimizedRoute, showUI } = event?.detail || {};
      if (!showUI) return;

      // Only show notification for the current driver/date
      if (driverId && selectedDriverId && driverId !== selectedDriverId) return;
      if (deliveryDate && selectedDate && deliveryDate !== selectedDate) return;

      setNotification({
        id: Date.now(),
        updates: optimizedRoute || [],
        totalStops: (optimizedRoute || []).length
      });
      setTimeout(() => setNotification(null), 6000);

      if (onRouteOptimized) {
        onRouteOptimized(optimizedRoute);
      }
    };

    window.addEventListener('routeOptimizationComplete', handleOptimizationComplete);
    return () => window.removeEventListener('routeOptimizationComplete', handleOptimizationComplete);
  }, [selectedDriverId, selectedDate, onRouteOptimized]);

  return (
    <AnimatePresence>
      {notification && (
        <motion.div
          initial={{ opacity: 0, y: -50, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -50, scale: 0.95 }}
          className="fixed top-20 left-4 right-4 z-[10000] mx-auto max-w-md"
          style={{ transform: 'none' }}
        >
          <div
            className="rounded-xl shadow-2xl p-4 border-2"
            style={{
              background: 'var(--bg-white)',
              borderColor: 'var(--border-slate-300)',
              boxShadow: '0 25px 50px -12px var(--shadow-color)'
            }}
          >
            <div className="flex items-start gap-3">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ background: 'var(--bg-slate-100)' }}
              >
                <Route className="w-5 h-5 text-blue-600" />
              </div>

              <div className="flex-1 min-w-0">
                <h4 className="font-bold text-sm mb-1" style={{ color: 'var(--text-slate-900)' }}>
                  Route Optimized
                </h4>

                <p className="text-sm mb-2" style={{ color: 'var(--text-slate-600)' }}>
                  {(() => {
                    const activeCount = (notification.updates || []).filter(s => !s.isPending).length;
                    return `${activeCount} stop${activeCount !== 1 ? 's' : ''} resequenced based on current traffic`;
                  })()}
                </p>

                <div className="flex items-center gap-2 text-xs text-blue-600">
                  <CheckCircle className="w-4 h-4" />
                  <span className="font-semibold">Estimated time saved</span>
                </div>
              </div>

              <button
                onClick={() => setNotification(null)}
                className="transition-colors flex-shrink-0"
                style={{ color: 'var(--text-slate-400)' }}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
