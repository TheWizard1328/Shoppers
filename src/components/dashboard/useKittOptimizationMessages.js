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
    const handleOptStart = () => {
      if (kittTimeoutRef.current) { clearTimeout(kittTimeoutRef.current); kittTimeoutRef.current = null; }
      setOptimizationMessage('Optimizing Route…');
    };
    const handleOptPhase = (e) => {
      const { phase } = e.detail || {};
      if (phase === 'polylines') {
        setOptimizationMessage('Generating Route Lines…');
      }
    };
    const handleOptRunning = (e) => {
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