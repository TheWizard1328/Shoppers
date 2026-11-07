import { useEffect, useLayoutEffect, useState } from 'react';

/**
 * useMobileChromeHeights - live chrome measurements for the full-area forms.
 *
 * WHY THIS EXISTS (owner reports Nov 7 2026):
 *  1. Edit Patient on a phone opened with the app header covering the form title
 *     and the Cancel / Update buttons behind the bottom nav. PatientForm and
 *     DeliveryFormView both read document.querySelector('[data-mobile-header]')
 *     .offsetHeight straight inside render. On the render the form mounts, the
 *     header and nav can be mid-layout (safe-area insets resolving, the battery
 *     pill row changing the header height, fonts loading), so the read returned 0
 *     or a stale number and, not being state, was never re-measured.
 *  2. Edit Delivery / Patient / InterStore / Pickup must FILL the view area
 *     without covering the phone's top notification area or the bottom nav, on
 *     narrow phones as well as tablets and PCs.
 *
 * Returns { header, bottomNav, area } where `area` is the real content box
 * (.main-content-area) as { left, top, width, height } in viewport pixels. On the
 * desktop-class layouts the sidebar is user-resizable (200-400px), so the left
 * edge is MEASURED, never a hardcoded 16rem.
 *
 * Everything is measured after layout, re-measured on ResizeObserver / resize /
 * orientation change / visualViewport changes, and rounded to whole pixels so
 * sub-pixel jitter cannot cause a render loop.
 */

const rect = (selector) => {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r || (!r.width && !r.height)) return null;
  return r;
};

const readAll = () => {
  const header = rect('[data-mobile-header]');
  const nav = rect('[data-mobile-bottom-nav]');
  const area = rect('.main-content-area');
  return {
    header: header ? Math.round(header.height) : 0,
    bottomNav: nav ? Math.round(nav.height) : 0,
    area: area
      ? {
          left: Math.round(area.left),
          top: Math.round(area.top),
          width: Math.round(area.width),
          height: Math.round(area.height),
        }
      : null,
  };
};

const same = (a, b) =>
  a.header === b.header &&
  a.bottomNav === b.bottomNav &&
  ((!a.area && !b.area) ||
    (a.area && b.area &&
      a.area.left === b.area.left && a.area.top === b.area.top &&
      a.area.width === b.area.width && a.area.height === b.area.height));

export default function useMobileChromeHeights(enabled = true) {
  const [m, setM] = useState(() => (enabled ? readAll() : { header: 0, bottomNav: 0, area: null }));

  const measure = () => {
    const next = readAll();
    setM((prev) => (same(prev, next) ? prev : next));
  };

  // First correct value BEFORE the first paint of the form.
  useLayoutEffect(() => {
    if (!enabled) return;
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;

    // Chrome can finish laying out a frame or two after the form mounts.
    const raf = requestAnimationFrame(() => {
      measure();
      requestAnimationFrame(measure);
    });

    const observers = [];
    if (typeof ResizeObserver !== 'undefined') {
      ['[data-mobile-header]', '[data-mobile-bottom-nav]', '.main-content-area'].forEach((sel) => {
        const el = document.querySelector(sel);
        if (!el) return;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        observers.push(ro);
      });
    }

    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    window.visualViewport?.addEventListener?.('resize', measure);
    return () => {
      cancelAnimationFrame(raf);
      observers.forEach((ro) => ro.disconnect());
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      window.visualViewport?.removeEventListener?.('resize', measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return m;
}
