import { useEffect, useRef } from 'react';

/**
 * KITT bar phased messages: activate on button click, show 3 phases, clear on done.
 * Extracted from Dashboard.jsx so the file stays under the platform size limit.
 *
 * @param {(msg: string|null) => void} setOptimizationMessage
 */
export function useKittOptimizationMessages(setOptimizationMessage) {
  const kittTimeoutRef = useRef(null);
  useEffect(() => {
    // Scope filter: optimization events carry { driverId, deliveryDate }. Only
    // show the KITT messages when the optimized route matches the dashboard's
    // currently viewed driver+date (via __currentDashboardContext, same source
    // as OptimizationSpinner). Fail open when context or event ids are missing,
    // so legacy/unscoped events keep behaving as before.
    const isRelevantToView = (e) => {
      const { driverId, deliveryDate } = e?.detail || {};
      const context = window.__currentDashboardContext || null;
      if (!context) return true;
      if (driverId && context.driverId && driverId !== context.driverId) return false;
      if (deliveryDate && context.deliveryDate && deliveryDate !== context.deliveryDate) return false;
      return true;
    };

    const handleOptStart = (e) => {
      if (!isRelevantToView(e)) return;
      if (kittTimeoutRef.current) { clearTimeout(kittTimeoutRef.current); kittTimeoutRef.current = null; }
      setOptimizationMessage('Optimizing Route…');
    };
    const handleOptPhase = (e) => {
      if (!isRelevantToView(e)) return;
      const { phase } = e.detail || {};
      if (phase === 'polylines') {
        setOptimizationMessage('Generating Route Lines…');
      }
    };
    const handleOptRunning = (e) => {
      if (!isRelevantToView(e)) return;
      const { active } = e.detail || {};
      if (active) {
        if (kittTimeoutRef.current) { clearTimeout(kittTimeoutRef.current); kittTimeoutRef.current = null; }
        setOptimizationMessage('Optimizing Route…');
      } else {
        if (kittTimeoutRef.current) { clearTimeout(kittTimeoutRef.current); kittTimeoutRef.current = null; }
        setOptimizationMessage(null);
      }
    };
    const handleOptComplete = (e) => {
      if (!isRelevantToView(e)) return;
      const { source, optimizedCount } = e.detail || {};
      if (optimizedCount != null) {
        const count = optimizedCount || 0;
        setOptimizationMessage(`${count} Stops Optimized`);
        if (kittTimeoutRef.current) clearTimeout(kittTimeoutRef.current);
        kittTimeoutRef.current = setTimeout(() => {
          setOptimizationMessage(null);
          kittTimeoutRef.current = null;
        }, 3000);
      } else {
        if (kittTimeoutRef.current) clearTimeout(kittTimeoutRef.current);
        setOptimizationMessage(null);
        kittTimeoutRef.current = null;
      }
    };
    window.addEventListener('routeOptimizationStarted', handleOptStart);
    window.addEventListener('routeOptimizationPhase', handleOptPhase);
    window.addEventListener('routeOptimizationComplete', handleOptComplete);
    window.addEventListener('optimizationRunning', handleOptRunning);
    return () => {
      window.removeEventListener('routeOptimizationStarted', handleOptStart);
      window.removeEventListener('routeOptimizationPhase', handleOptPhase);
      window.removeEventListener('routeOptimizationComplete', handleOptComplete);
      window.removeEventListener('optimizationRunning', handleOptRunning);
      if (kittTimeoutRef.current) clearTimeout(kittTimeoutRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setOptimizationMessage]);
}