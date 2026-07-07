/**
 * Stop Card Collapse Manager
 *
 * Centralizes the auto-collapse timer logic for expanded stop cards.
 *
 * Usage in Dashboard (useEffect):
 *   useStopCardCollapseTimer({ selectedCardId, cardExpandedAtRef, setSelectedCardId })
 *
 * Usage anywhere to trigger a fast collapse (e.g. Complete, Mark as Failed, Cancel Pickup):
 *   window.dispatchEvent(new CustomEvent('stopCardActionCollapse'))
 *
 * The Dashboard listens for 'stopCardActionCollapse' and resets the timer to 500ms,
 * so the card collapses almost immediately after one of these terminal actions.
 */

import { useEffect } from 'react';

const AUTO_COLLAPSE_MS = 120000; // 2 minutes — normal idle timeout
const ACTION_COLLAPSE_MS = 500;  // 500ms — after terminal button action or outside click

/**
 * Hook: manages the auto-collapse timer for the currently expanded stop card.
 * Place this once in Dashboard.jsx in place of the manual useEffect.
 */
export function useStopCardCollapseTimer({ selectedCardId, cardExpandedAtRef, setSelectedCardId }) {
  // ── Normal 2-minute idle timer ───────────────────────────────────────────
  useEffect(() => {
    if (!selectedCardId || !cardExpandedAtRef.current) return;

    const expandedAt = cardExpandedAtRef.current;
    const elapsed = Date.now() - expandedAt;
    const remaining = AUTO_COLLAPSE_MS - elapsed;

    const collapse = () => {
      setSelectedCardId(null);
      cardExpandedAtRef.current = null;
    };

    if (remaining <= 0) { collapse(); return; }

    const timer = setTimeout(collapse, remaining);
    return () => clearTimeout(timer);
  }, [selectedCardId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fast 500ms collapse on terminal button action or outside click ───────
  useEffect(() => {
    let timer = null;

    const handleActionCollapse = () => {
      if (!cardExpandedAtRef.current) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setSelectedCardId(null);
        cardExpandedAtRef.current = null;
        timer = null;
      }, ACTION_COLLAPSE_MS);
    };

    window.addEventListener('stopCardActionCollapse', handleActionCollapse);
    return () => {
      window.removeEventListener('stopCardActionCollapse', handleActionCollapse);
      if (timer) clearTimeout(timer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Call this from any button handler inside a StopCard (Complete, Mark as Failed,
 * Cancel Pickup, Save and Complete COD) to trigger the fast 500ms collapse.
 */
export function dispatchStopCardActionCollapse() {
  window.dispatchEvent(new CustomEvent('stopCardActionCollapse'));
}