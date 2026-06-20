import React, { useState, useEffect } from 'react';

/**
 * OptimizationSpinner
 *
 * Shows:
 * - A "Saving changes…" spinner during the debounce countdown (optimizationDebouncerState)
 * - A KITT-style scanning bar while the route optimizer is actively running (optimizationRunning)
 */
export default function OptimizationSpinner() {
  const [activeRoutes, setActiveRoutes] = useState(new Set());
  const [optimizingRoutes, setOptimizingRoutes] = useState(new Set());

  useEffect(() => {
    const handleDebouncer = (e) => {
      const { driverId, deliveryDate, active } = e.detail || {};
      if (!driverId || !deliveryDate) return;
      const key = `${driverId}|${deliveryDate}`;
      setActiveRoutes(prev => {
        const next = new Set(prev);
        if (active) next.add(key);
        else next.delete(key);
        return next;
      });
    };

    const handleRunning = (e) => {
      const { driverId, deliveryDate, active } = e.detail || {};
      if (!driverId || !deliveryDate) return;
      const key = `${driverId}|${deliveryDate}`;
      setOptimizingRoutes(prev => {
        const next = new Set(prev);
        if (active) next.add(key);
        else next.delete(key);
        return next;
      });
    };

    window.addEventListener('optimizationDebouncerState', handleDebouncer);
    window.addEventListener('optimizationRunning', handleRunning);
    return () => {
      window.removeEventListener('optimizationDebouncerState', handleDebouncer);
      window.removeEventListener('optimizationRunning', handleRunning);
    };
  }, []);

  const isOptimizing = optimizingRoutes.size > 0;
  const isSaving = activeRoutes.size > 0;

  if (!isSaving && !isOptimizing) return null;

  return (
    <div
      className="fixed bottom-6 right-6 z-[9999] flex flex-col items-end gap-2"
      style={{ pointerEvents: 'none' }}
    >
      {/* KITT scanning bar — visible while optimizer is actively running */}
      {isOptimizing && (
        <div className="flex flex-col gap-1 bg-black border border-orange-500 shadow-xl rounded-lg px-3 py-2 w-52">
          <span className="text-[10px] font-bold text-orange-400 tracking-widest uppercase">
            Optimizing Route…
          </span>
          <div className="relative h-3 w-full rounded-full overflow-hidden bg-slate-900">
            <div
              className="absolute top-0 h-full rounded-full bg-orange-500"
              style={{
                width: '52px',
                animation: 'kitt-scan 0.8s ease-in-out infinite alternate',
                boxShadow: '0 0 10px 4px rgba(249,115,22,0.7)',
              }}
            />
          </div>
        </div>
      )}

      {/* Saving spinner — visible during debounce countdown */}
      {isSaving && !isOptimizing && (
        <div className="flex items-center gap-2 bg-white dark:bg-slate-800 border border-orange-300 shadow-lg rounded-full px-3 py-2">
          <svg
            className="w-5 h-5 flex-shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            style={{ animation: 'spin-ccw 1s linear infinite' }}
          >
            <style>{`
              @keyframes spin-ccw {
                from { transform: rotate(0deg); }
                to   { transform: rotate(-360deg); }
              }
            `}</style>
            <circle cx="12" cy="12" r="10" stroke="#fed7aa" strokeWidth="3" />
            <path
              d="M22 12a10 10 0 0 1-10 10"
              stroke="#f97316"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
          <span className="text-xs font-semibold text-orange-600 dark:text-orange-400 whitespace-nowrap">
            Saving changes…
          </span>
        </div>
      )}
    </div>
  );
}