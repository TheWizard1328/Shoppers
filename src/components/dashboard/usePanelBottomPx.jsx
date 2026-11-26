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
/**
 * The FABs are `position: absolute` inside the map area, so a `bottom` value is
 * measured from THAT box's edge, not from the viewport. Using window.innerHeight
 * silently over-lifted every control by however much the map area ends above the
 * bottom of the screen (the bottom nav sits over it).
 */
/**
 * OWNER REQUEST (Nov 26 2026): "Why don't we just move everything down about 20
 * pixels to start when the stop cards are visible. When the stop cards aren't
 * visible it's all fine." The measurement alone kept landing on the same value
 * the old formula produced, so this is an explicit nudge applied ONLY while the
 * stop card panel is on screen — immersive mode (no cards) keeps its own value.
 */
const CARD_VISIBLE_NUDGE_PX = 20;

function readContainerBottom() {
  try {
    // OWNER REPORT (Nov 26 2026): "right back where we started with that huge gap
    // between them and the stop card container." An absolute element resolves its
    // `bottom` against its OFFSET PARENT, and FABControls/StopCardCheckboxToggle
    // are siblings of the map area, NOT children of it — so measuring the map area
    // (or the viewport) shifted every control up by the nav height. Ask the map
    // cycle FAB itself which box it is positioned against; every control on this
    // row shares that containing block.
    const fab = document.querySelector('[data-map-cycle-fab]');
    const op = fab && fab.offsetParent;
    if (op) {
      const r = op.getBoundingClientRect();
      if (r && r.height > 10) return r.bottom;
    }
    const area = document.querySelector('[data-map-area]');
    if (area) {
      const r = area.getBoundingClientRect();
      if (r && r.height > 10) return r.bottom;
    }
  } catch { /* fall through */ }
  return window.innerHeight;
}

function readPanelRect() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  try {
    // OWNER CORRECTION (Nov 26 2026): "that fix actually moved them higher
    // instead of lower towards the cards." The strip box is min-h-[70px], so its
    // top edge can sit ABOVE the cards themselves — anchoring to it lifted the row
    // away from the cards. Measure the real card tops instead: the row belongs
    // 5px above the topmost visible stop card, which is the panel a driver sees.
    const cards = Array.from(document.querySelectorAll('[id^="stop-card-"]'))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r && r.height > 10 && r.width > 20 && r.top < window.innerHeight - 4);
    if (cards.length) {
      const top = Math.min(...cards.map((r) => r.top));
      const bottom = Math.max(...cards.map((r) => r.bottom));
      return { top, height: bottom - top, containerBottom: readContainerBottom() };
    }

    // Fallbacks: the card strip, then the panel container.
    const el = document.querySelector('[data-stop-cards-strip]') || document.querySelector('[data-stop-cards-panel]');
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (!rect || rect.height < 10 || rect.width < 10) return null;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || Number(style.opacity) < 0.05) return null;
    if (rect.top >= window.innerHeight - 2) return null;
    return { top: rect.top, height: rect.height, containerBottom: readContainerBottom() };
  } catch {
    return null;
  }
}

export function measurePanelBottomPx(gapPx = 5) {
  const rect = readPanelRect();
  if (!rect) return null;
  const px = Math.round(rect.containerBottom - rect.top + gapPx + CARD_VISIBLE_NUDGE_PX);
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
          const measured = Math.round(rect.containerBottom - rect.top + gapPx + CARD_VISIBLE_NUDGE_PX);
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
