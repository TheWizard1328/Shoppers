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
 * OWNER REQUEST (Nov 26 2026): "move everything down about 20 pixels to start
 * when the stop cards are visible. When the stop cards aren't visible it's all
 * fine." SIGN MATTERS: these controls use `bottom`, so a BIGGER value moves them
 * UP. w533 added 20 and pushed the row further away, so the drop is subtracted.
 * Applied only while the stop card panel is on screen; immersive is untouched.
 */
const CARD_VISIBLE_DROP_PX = 0;

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

/**
 * True while any stop card is still sliding in (stopCardEnter runs 0.3s on every
 * remount, including a driver switch). Readings taken then are discarded so the
 * hook keeps its last good value instead of locking in a mid-animation one.
 */
function cardsAreAnimating() {
  try {
    const shells = document.querySelectorAll('[id^="stop-card-"]');
    for (const el of shells) {
      const anims = el.getAnimations ? el.getAnimations({ subtree: true }) : [];
      // Only FINITE running animations count (the 0.3s slide-in). Looping ones
      // (pulses, spinners, ETA flashes) never end and must not block the anchor.
      if (anims.some((a) => {
        if (a.playState !== 'running') return false;
        const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
        return !t || Number.isFinite(t.endTime);
      })) return true;
    }
    return false;
  } catch { return false; }
}

function readPanelRect() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  try {
    // OWNER REPORT (Nov 26 2026): switching drivers dropped the whole row half
    // behind the stop cards. A driver switch remounts the cards, which play
    // stopCardEnter (translateY(20px) -> 0, 0.3s) while old and new cards briefly
    // coexist, so reading a card's top mid-slide put the row ~20px+ too low and
    // that value then got locked in. While any card is still animating (or the
    // card set is mid-swap) report "settling" so the hook keeps its last good
    // value; only a settled card top is ever trusted.
    if (cardsAreAnimating()) return { settling: true };

    // OWNER REPORT (Nov 26 2026): "they were all in the right spot for the other
    // drivers but got raised up for me for Robert." With a fanned/stacked rail the
    // min() of every card's top follows the TALLEST card, which can be one tucked
    // BEHIND the front card — so a view whose back card is ~20px taller lifted the
    // row away from the card the eye actually sees. Use the FRONT card (highest
    // z-index, tallest on a tie): that is the top edge the owner is aligning to.
    const cards = Array.from(document.querySelectorAll('[id^="stop-card-"]'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r && r.height > 10 && r.width > 20 && r.top < window.innerHeight - 4);
    if (cards.length) {
      const zOf = ({ el }) => {
        const z = parseInt(window.getComputedStyle(el).zIndex, 10);
        return Number.isFinite(z) ? z : 0;
      };
      cards.sort((a, b) => (zOf(b) - zOf(a)) || (b.r.height - a.r.height));
      const front = cards[0].r;
      const top = front.top;
      const bottom = Math.max(...cards.map(({ r }) => r.bottom));
      return { top, height: bottom - top, containerBottom: readContainerBottom() };
    }

    // The panel container's own box: its layout does not move while child cards
    // run their translateY slide-in, so it is the stable anchor.
    const el = document.querySelector('[data-stop-cards-panel]') || document.querySelector('[data-stop-cards-strip]');
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
  if (!rect || rect.settling) return null;
  const px = Math.round(rect.containerBottom - rect.top + gapPx - CARD_VISIBLE_DROP_PX);
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
      } else if (rect && rect.settling) {
        // Cards are sliding in (driver switch / reload): keep the last settled
        // value; never lock a mid-animation reading. Re-check shortly after.
        next = lockedRef.current ?? fallbackPx;
        setTimeout(schedule, 120);
      } else if (!rect) {
        next = lockedRef.current ?? fallbackPx;
      } else {
        const grown = collapsedHeightPx > 0 && rect.height > collapsedHeightPx + 12;
        if (grown) {
          // The panel is taller than the remembered collapsed height even though
          // no expand event was seen — trust the remembered height and hold.
          next = lockedRef.current ?? fallbackPx;
        } else {
          const measured = Math.round(rect.containerBottom - rect.top + gapPx - CARD_VISIBLE_DROP_PX);
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
