import { useEffect, useRef } from 'react';

/**
 * Measures and tracks the COLLAPSED height of the stop cards strip.
 * Never updates the height while a card is expanded — uses a ref to check
 * selectedCardId synchronously inside async timers to avoid stale closures.
 *
 * Also tracks statsCardRef height via ResizeObserver when provided.
 */
export function useStopCardsBaseHeight({
  horizontalStopCardsRef,
  selectedCardId,
  deliveriesWithStopOrder,
  stopCardsBaseHeight,
  setStopCardsBaseHeight,
  statsCardRef = null,
  setStatsCardBaseHeight = null,
}) {
  // Track stats card height via ResizeObserver
  useEffect(() => {
    if (!statsCardRef?.current || !setStatsCardBaseHeight) return;
    const el = statsCardRef.current;
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      if (h > 0) setStatsCardBaseHeight(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Ref so timers always see the current value without re-registering effects
  const selectedCardIdRef = useRef(selectedCardId);
  useEffect(() => { selectedCardIdRef.current = selectedCardId; }, [selectedCardId]);

  // Measure on card collapse / deliveries change
  useEffect(() => {
    const element = horizontalStopCardsRef.current;
    if (!element) return;
    if (selectedCardIdRef.current) return; // already expanded — skip

    const timer = setTimeout(() => {
      if (selectedCardIdRef.current) return; // expanded during the delay — skip
      const height = element.offsetHeight;
      if (height > 0 && height !== stopCardsBaseHeight) {
        setStopCardsBaseHeight(height);
      }
    }, 400);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCardId, deliveriesWithStopOrder.length, deliveriesWithStopOrder.map((d) => `${d?.id}:${d?.status}`).join(',')]);

  // Re-measure after data refresh events
  useEffect(() => {
    const handleHeightRemeasure = () => {
      if (!horizontalStopCardsRef.current || selectedCardIdRef.current) return;
      setTimeout(() => {
        const element = horizontalStopCardsRef.current;
        if (!element || selectedCardIdRef.current) return;
        const height = element.offsetHeight;
        if (height > 0 && height !== stopCardsBaseHeight) {
          setStopCardsBaseHeight(height);
        }
      }, 400);
    };

    window.addEventListener('deliveriesUpdated', handleHeightRemeasure);
    window.addEventListener('smartRefreshComplete', handleHeightRemeasure);

    return () => {
      window.removeEventListener('deliveriesUpdated', handleHeightRemeasure);
      window.removeEventListener('smartRefreshComplete', handleHeightRemeasure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopCardsBaseHeight]);
}