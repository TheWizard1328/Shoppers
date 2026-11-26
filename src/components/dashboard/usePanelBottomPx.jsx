import { useEffect, useState } from 'react';

/**
 * OWNER REQUEST (Nov 26 2026): "the bulk edit checkbox, the Google API counter,
 * the Navigate button and the map cycle FAB should all be about 5 pixels above
 * the horizontal stop card panel" — they had drifted upward because every one of
 * them was placed from `stopCardsBaseHeight`, a REMEMBERED collapsed height that
 * can disagree with what is actually on screen (a card that gets shorter, a
 * strip that re-measures late, a panel whose height changes without a card
 * status change). Measuring the panel's real top edge instead makes the row
 * self-correcting: whatever the panel does, the row sits the requested gap above
 * it.
 *
 * The panel carries `data-stop-cards-panel` (StopCardsSection). When it is not
 * measurable — immersive mode translates it off screen, or it has not mounted
 * yet — every caller falls back to its own previous formula.
 */
export function measurePanelBottomPx(gapPx = 5) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  try {
    const el = document.querySelector('[data-stop-cards-panel]');
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.height < 10 || rect.width < 10) return null;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || Number(style.opacity) < 0.05) return null;
    // Immersive mode slides the panel below the fold — it is not a reference then.
    if (rect.top >= window.innerHeight - 2) return null;
    const px = Math.round(window.innerHeight - rect.top + gapPx);
    return px > 0 ? px : null;
  } catch {
    return null;
  }
}

/**
 * Live `bottom` offset (px) that puts an element `gapPx` above the stop card
 * panel's top edge. Returns `fallbackPx` whenever the panel cannot be measured.
 */
export function usePanelBottomPx(fallbackPx = 0, gapPx = 5) {
  const [px, setPx] = useState(() => measurePanelBottomPx(gapPx) ?? fallbackPx);

  useEffect(() => {
    let raf = 0;
    let ro = null;
    const compute = () => {
      const next = measurePanelBottomPx(gapPx) ?? fallbackPx;
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
      const el = document.querySelector('[data-stop-cards-panel]');
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
  }, [fallbackPx, gapPx]);

  return px;
}
