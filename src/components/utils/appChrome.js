import { useEffect, useState } from 'react';

/**
 * appChrome - THE single source of truth for the dead space the phone's own
 * chrome (status / notification bar, OS navigation bar, in-app mobile header,
 * in-app bottom nav) takes away from the app.
 *
 * WHY THIS EXISTS (owner, Nov 18 2026): "make sure the app doesn't require me to
 * have to make 20 different requests to fix all these dead headers and footers".
 * The same question - how much gap do I need at the top / bottom? - was answered
 * separately in 25+ files, each with its own guess:
 *
 *     isNativeShell ? 'max(env(safe-area-inset-top, 0px), 30px)' : 'env(...)'
 *     var(--native-safe-top, env(safe-area-inset-top, 0px))
 *     'calc(var(--native-safe-bottom, 0px) + var(--native-safe-bottom, 0px))'
 *
 * so every new panel re-introduced a dead band on one platform or another, and
 * the answer had to be re-learned per device: APK needs top + bottom, iPhone
 * standalone needs top + a little bottom, browser PWA needs neither, tablet and
 * PC need neither.
 *
 * THE RULE FROM NOW ON
 * --------------------
 * CSS (preferred, works in className and in style):
 *     paddingTop:    INSET_TOP        -> var(--app-inset-top)
 *     paddingBottom: INSET_BOTTOM     -> var(--app-inset-bottom)
 *     paddingTop:    padTop('1rem')   -> calc(var(--app-inset-top) + 1rem)
 *
 * JS (when a number is really needed):
 *     const { band } = useChrome();   -> the visible free area, header bottom to
 *                                        nav top, already clamped to the REAL
 *                                        visible viewport (window.visualViewport,
 *                                        not the inflated APK layout).
 *
 * --app-inset-* is resolved ONCE in layoutStyles.jsx:
 *     max(APK safety floor, --native-safe-top injected by MainActivity, env())
 * so no component needs to know whether it is running in the APK, a browser PWA,
 * an iPhone home-screen app, a tablet or a PC.
 *
 * Never hardcode 30px / 14px / a nav height in a component again. Add a variable
 * to layoutStyles if a new platform quirk appears - one place, not twenty.
 */

export const INSET_TOP = 'var(--app-inset-top)';
export const INSET_BOTTOM = 'var(--app-inset-bottom)';
export const INSET_LEFT = 'var(--app-inset-left)';
export const INSET_RIGHT = 'var(--app-inset-right)';

/** calc(var(--app-inset-top) + extra) */
export const padTop = (extra = '0px') => `calc(${INSET_TOP} + ${extra})`;
/** calc(var(--app-inset-bottom) + extra) */
export const padBottom = (extra = '0px') => `calc(${INSET_BOTTOM} + ${extra})`;
/** calc(var(--app-inset-top) + extra) */
export const topOffset = padTop;
/** calc(var(--app-inset-bottom) + extra) */
export const bottomOffset = padBottom;

/** Resolved px value of one of the --app-inset-* variables (0 when unavailable). */
export const readInset = (side = 'top') => {
  if (typeof window === 'undefined' || !document?.documentElement) return 0;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(`--app-inset-${side}`)
    .trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
};

const rectOf = (selector) => {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector(selector);
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  const r = el.getBoundingClientRect();
  if (!r || (!r.width && !r.height)) return null;
  return r;
};

/**
 * The visible free area of the app, in viewport pixels:
 *   { top, bottom, height, left, width }   band.top    = bottom edge of the mobile header
 *                                          band.bottom = top edge of the bottom nav
 *
 * Both edges are clamped into window.visualViewport. That clamp is what fixed the
 * End of Day stats panel (owner report Nov 18 2026): the APK lays the app out
 * TALLER than the visible screen, so the bottom nav's rect sits below the fold and
 * any midpoint computed from raw rects lands ~30px too low.
 */
export const readBand = () => {
  if (typeof window === 'undefined') return null;
  const vv = window.visualViewport;
  const viewTop = vv ? vv.offsetTop : 0;
  const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  // rectOf() returns a DOMRect, so read its edges directly (never .getBoundingClientRect()).
  const headerRect = rectOf('[data-mobile-header]');
  const navRect = rectOf('[data-mobile-bottom-nav]');
  const rawTop = headerRect ? headerRect.bottom : viewTop;
  const rawBottom = navRect ? navRect.top : viewBottom;
  const top = Math.max(viewTop, Math.min(rawTop, viewBottom));
  const bottom = Math.min(viewBottom, Math.max(rawBottom, top));
  if (!(bottom - top > 160)) return null;
  return {
    top: Math.round(top),
    bottom: Math.round(bottom),
    height: Math.round(bottom - top),
    left: 0,
    width: Math.round(window.innerWidth),
  };
};

/**
 * Live chrome state:
 *   { band, headerH, navH, insetTop, insetBottom, viewportH }
 * Re-measured after mount, on resize, orientation change and visualViewport
 * scroll/resize, so a device that hides its bars (or an iOS PWA that resolves its
 * insets late) settles on the right numbers without a reload.
 */
export const useChrome = () => {
  const [state, setState] = useState({
    band: null,
    headerH: 0,
    navH: 0,
    insetTop: 0,
    insetBottom: 0,
    viewportH: 0,
  });

  useEffect(() => {
    let raf = 0;
    const measure = () => {
      const band = readBand();
      const headerRect = rectOf('[data-mobile-header]');
      const navRect = rectOf('[data-mobile-bottom-nav]');
      const vv = window.visualViewport;
      setState((prev) => {
        const next = {
          band,
          headerH: headerRect ? Math.round(headerRect.height) : 0,
          navH: navRect ? Math.round(navRect.height) : 0,
          insetTop: Math.round(readInset('top')),
          insetBottom: Math.round(readInset('bottom')),
          viewportH: Math.round(vv ? vv.height : window.innerHeight),
        };
        const same =
          prev.headerH === next.headerH &&
          prev.navH === next.navH &&
          prev.insetTop === next.insetTop &&
          prev.insetBottom === next.insetBottom &&
          prev.viewportH === next.viewportH &&
          JSON.stringify(prev.band) === JSON.stringify(next.band);
        return same ? prev : next;
      });
    };

    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };

    measure();
    const timers = [setTimeout(measure, 80), setTimeout(measure, 350), setTimeout(measure, 1200)];
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);

    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(schedule);
      const headerEl = document.querySelector('[data-mobile-header]');
      const navEl = document.querySelector('[data-mobile-bottom-nav]');
      if (headerEl) ro.observe(headerEl);
      if (navEl) ro.observe(navEl);
    }

    return () => {
      timers.forEach(clearTimeout);
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('scroll', schedule);
      ro?.disconnect();
    };
  }, []);

  return state;
};

export default useChrome;
