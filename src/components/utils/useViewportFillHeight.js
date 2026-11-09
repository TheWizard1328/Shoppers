import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useViewportFillHeight
 * Gives a scrollable grid the height between its own top edge and the bottom of
 * the viewport, so long lists use the whole page instead of a fixed px cap
 * (owner request Nov 8 2026: Admin Utilities Deliveries + Stores lists).
 *
 * Usage:
 *   const [scrollRef, maxHeight] = useViewportFillHeight();
 *   <div ref={scrollRef} className="overflow-y-auto" style={{ maxHeight }}>
 *
 * Re-measures on resize, orientation change, scroll and when `deps` change
 * (pass the row count so the box grows after data loads).
 */
export default function useViewportFillHeight({ min = 240, gap = 12, initial = 600, deps = [] } = {}) {
  const ref = useRef(null);
  const [height, setHeight] = useState(initial);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    const next = Math.max(min, Math.round(window.innerHeight - top - gap));
    // Only update on real changes so we never fight React with micro-jitter.
    setHeight((prev) => (Math.abs(prev - next) > 2 ? next : prev));
  }, [gap, min]);

  useEffect(() => {
    measure();
    const settle = setTimeout(measure, 250); // after fonts / filter bars settle
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    window.addEventListener('scroll', measure, { passive: true });
    return () => {
      clearTimeout(settle);
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      window.removeEventListener('scroll', measure);
    };
  }, [measure]);

  // Re-measure when the caller's data footprint changes.
  useEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return [ref, height, measure];
}
