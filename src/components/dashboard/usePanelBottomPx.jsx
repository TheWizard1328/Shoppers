import { useEffect, useRef, useState } from 'react';

/**
 * OWNER REQUEST (Nov 26 2026): "the bulk edit checkbox, the Google API counter,
 * the Navigate button and the map cycle FAB should all be about 5 pixels above
 * the horizontal stop card panel."
 *
 * OWNER CORRECTION (Nov 26 2026, right after w529): "whenever the stop cards
 * expand they all move up. They are supposed to be locked to the height of the
 * NON-expanded stop cards and not move when the stop cards expand." w529 measured
 * the panel's live top unconditionally, so an expanded card dragged the whole row
 * upward. The row must therefore use the COLLAPSED panel edge only:
 *
 *  - while every card is collapsed, the row follows the panel's real top edge
 *    (which fixes the drift that started this) with the requested 5px gap;
 *  - the moment a card expands, the measurement is FROZEN at the last collapsed
 *    value, so the row stays locked and never rides up with the card.
 *
 * The panel carries `data-stop-cards-panel` (StopCardsSection). When it cannot be
 * measured — immersive mode slides it off screen, or it has not mounted yet —
 * every caller falls back to its own previous formula.
 */
function readPanelRect() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  try {
    // Prefer the card strip itself: its height IS the remembered collapsed
    // height, so "is a card expanded" is judged against the same number.
    const el = document.querySelector('[data-stop-cards-strip]') || document.querySelector('[data-stop-cards-panel]');
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.height < 10 || rect.width < 10) return null;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || Number(style.opacity) < 0.05) return null;
    // Immersive mode slides the panel below the fold — it is not a reference then.
    if (rect.top >= window.innerHeight - 2) return null;
    return { top: rect.top, height: rect.height };
  } catch {
    return null;
  }
}

export function measurePanelBottomPx(gapPx = 5) {
  const rect = readPanelRect();
  if (!rect) return null;
  const px = Math.round(window.innerHeight - rect.top + gapPx);
  return px > 0 ? px : null;
}

/**
 * Live `bottom` offset (px) that puts an element `gapPx` above the COLLAPSED stop
 * card panel top edge. `collapsedHeightPx` is the remembered collapsed height
 * (stopCardsBaseHeight): a panel taller than that by more than a few px means a
 * card is expanded, and the last collapsed reading is held instead.
 */
export function usePanelBottomPx(fallbackPx = 0, gapPx = 5, collapsedHeightPx = 0) {
  const [px, setPx] = useState(() => measurePanelBottomPx(gapPx) ?? fallbackPx);
  const expandedRef = useRef(false);
  const lockedRef = useRef(null);

  useEffect(() => {
    const onExpand = (e) => {
      expandedRef.current = !!e?.detail?.cardId;
    };
    window.addEventListener('stopCardExpandedChange', onExpand);
    return () => window.removeEventListener('stopCardExpandedChange', onExpand);
  }, []);

  useEffect(() => {
    let raf = 0;
    let ro = null;

    const compute = () => {
      const rect = readPanelRect();
      let next;
      if (expandedRef.current) {
        // A card is open — hold the locked (collapsed) value, never ride up.
        next = lockedRef.current ?? fallbackPx;
      } else if (!rect) {
        next = fallbackPx;
      } else {
        const grown = collapsedHeightPx > 0 && rect.height > collapsedHeightPx + 12;
        if (grown) {
          // The panel is taller than the remembered collapsed height even though
          // no expand event was seen — trust the remembered height and hold.
          next = lockedRef.current ?? fallbackPx;
        } else {
          const measured = Math.round(window.innerHeight - rect.top + gapPx);
          next = measured > 0 ? measured : fallbackPx;
          lockedRef.current = next;
        }
      }
      setPx((prev) => (prev === next ? prev : next));
    };

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; compute(); });
    };

    compute();
    // Cheap safety net: the panel can change height without firing a card event
    // (weather bar, route lock banner, a card whose text reflows).
    const iv = setInterval(compute, 800);
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);

    const attach = () => {
      // Prefer the card strip itself: its height IS the remembered collapsed
    // height, so "is a card expanded" is judged against the same number.
    const el = document.querySelector('[data-stop-cards-strip]') || document.querySelector('[data-stop-cards-panel]');
      if (!el || typeof ResizeObserver === 'undefined') return;
      ro = new ResizeObserver(schedule);
      ro.observe(el);
    };
    attach();
    const attachTimer = setTimeout(attach, 600);

    return () => {
      clearInterval(iv);
      clearTimeout(attachTimer);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
      if (ro) ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [fallbackPx, gapPx, collapsedHeightPx]);

  return px;
}
