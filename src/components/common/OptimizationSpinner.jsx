import React, { useState, useEffect } from 'react';

/**
 * OptimizationSpinner
 *
 * Shows an orange counter-clockwise spinning indicator while the
 * optimizationDebouncer is counting down before committing a route optimization.
 *
 * Listens to the 'optimizationDebouncerState' custom event emitted by
 * optimizationDebouncer.js. Any active countdown makes the spinner visible.
 */
export default function OptimizationSpinner() {
  const [activeRoutes, setActiveRoutes] = useState(new Set());

  useEffect(() => {
    const handler = (e) => {
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
    window.addEventListener('optimizationDebouncerState', handler);
    return () => window.removeEventListener('optimizationDebouncerState', handler);
  }, []);

  if (activeRoutes.size === 0) return null;

  return (
    <div
      className="fixed bottom-6 right-6 z-[9999] flex items-center gap-2 bg-white dark:bg-slate-800 border border-orange-300 shadow-lg rounded-full px-3 py-2"
      style={{ pointerEvents: 'none' }}
    >
      {/* Counter-clockwise orange spinner */}
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
  );
}