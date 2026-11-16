/**
 * TEMPORARY iOS / PWA LAYOUT PROBE  (added Nov 15 2026, owner request)
 *
 * Owner report on an iPhone home-screen PWA (installed from Chrome): a blank
 * bar at the bottom that looks like a double reserve, and the in-app bottom nav
 * plus that gap DISAPPEAR on every page except the Dashboard.
 *
 * Rather than guess at insets we log real measurements per route so the whole
 * thing can be fixed from numbers. Everything is read-only: it inspects the
 * live DOM and writes one RemoteLogEntry per route (warn level, so it shows up
 * in the hourly digest). Nothing is modified, no entity writes, no UI.
 *
 * REMOVAL: set IOS_PROBE_ENABLED to false, or delete this file plus the two
 * probe calls in Layout.jsx.
 */

import { remoteLogger } from './remoteLogger';

const IOS_PROBE_ENABLED = true;

let installed = false;
let lastKey = null;
let lastAt = 0;

/** Measures a CSS length by rendering it off-screen (returns px, rounded). */
const pxProbe = (cssValue) => {
  try {
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;top:-9999px;left:0;width:1px;visibility:hidden;pointer-events:none;height:${cssValue};`;
    document.body.appendChild(el);
    const h = el.getBoundingClientRect().height;
    el.remove();
    return Math.round(h);
  } catch {
    return null;
  }
};

const isIosLike = () => {
  try {
    const ua = navigator.userAgent || '';
    const iosUa = /iPad|iPhone|iPod/.test(ua);
    // iPadOS 13+ reports a desktop Mac UA with touch support
    const ipadDesktopUa = navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
    const standalone = window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    return iosUa || ipadDesktopUa || standalone;
  } catch {
    return false;
  }
};

const rectOf = (el) => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
};

const sample = () => {
  const de = document.documentElement;
  const container = document.querySelector('.app-container');
  const nav = document.querySelector('[data-mobile-bottom-nav]');
  const main = document.querySelector('.main-content-area');
  const scroller = main ? main.querySelector('main') : null;
  const cs = container ? getComputedStyle(container) : null;
  const navCs = nav ? getComputedStyle(nav) : null;
  const deCs = getComputedStyle(de);
  const vv = window.visualViewport;
  const navRect = rectOf(nav);
  const containerRect = rectOf(container);

  return {
    route: window.location.pathname,
    // heights
    innerH: window.innerHeight,
    docClientH: de.clientHeight,
    bodyClientH: document.body.clientHeight,
    vvH: vv ? Math.round(vv.height) : null,
    vvTop: vv ? Math.round(vv.offsetTop) : null,
    probeDvh: pxProbe('100dvh'),
    probeSvh: pxProbe('100svh'),
    probeLvh: pxProbe('100lvh'),
    probeEnvBottom: pxProbe('env(safe-area-inset-bottom, 0px)'),
    probeEnvTop: pxProbe('env(safe-area-inset-top, 0px)'),
    // container
    containerClass: container ? String(container.className) : null,
    containerPadTop: cs ? cs.paddingTop : null,
    containerPadBottom: cs ? cs.paddingBottom : null,
    containerRect,
    containerOverflow: cs ? `${cs.overflowX}/${cs.overflowY}` : null,
    // css vars
    varNativeBottom: deCs.getPropertyValue('--native-safe-bottom').trim() || null,
    varNativeTop: deCs.getPropertyValue('--native-safe-top').trim() || null,
    varBottomNavHeight: deCs.getPropertyValue('--bottom-nav-height').trim() || null,
    varActualBottomNav: deCs.getPropertyValue('--actual-bottom-nav-height').trim() || null,
    bodyClass: document.body ? String(document.body.className) : null,
    // bottom nav
    navPresent: !!nav,
    navDisplay: navCs ? `${navCs.display}/${navCs.visibility}/z${navCs.zIndex}` : null,
    navPadBottom: navCs ? navCs.paddingBottom : null,
    navRect,
    navBelowFold: navRect ? navRect.top >= window.innerHeight : null,
    // scroll containers
    mainRect: rectOf(main),
    mainScroll: main ? `${main.scrollHeight}/${main.clientHeight}` : null,
    mainScrollInner: scroller ? `${scroller.scrollHeight}/${scroller.clientHeight}` : null,
    // mode
    standalone: window.navigator.standalone === true,
    displayStandalone: !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches),
    dpr: window.devicePixelRatio
  };
};

/** Logs one measurement row for the current route. Deduped for 8s. */
export function probeIosLayout(page, reason = 'route') {
  if (!IOS_PROBE_ENABLED || typeof window === 'undefined') return;
  try {
    if (!isIosLike()) return;
    const key = `${page}|${window.location.pathname}|${reason}`;
    const now = Date.now();
    if (key === lastKey && now - lastAt < 8000) return;
    lastKey = key;
    lastAt = now;

    const data = sample();
    console.warn('[IOS_LAYOUT_PROBE]', page, reason, data);
    remoteLogger.event('IOS_LAYOUT_PROBE', `${page} | ${reason} | nav=${data.navPresent ? (data.navBelowFold ? 'BELOW_FOLD' : 'visible') : 'MISSING'} envBottom=${data.probeEnvBottom} padBottom=${data.containerPadBottom}`, data, 'warn');
  } catch (e) {
    // A probe must never break the app.
    try { console.warn('[IOS_LAYOUT_PROBE] failed:', e?.message); } catch { /* noop */ }
  }
}

/** Installs resize/orientation re-sampling. Safe to call more than once. */
export function installIosLayoutProbe(getPage) {
  if (!IOS_PROBE_ENABLED || installed || typeof window === 'undefined') return;
  if (!isIosLike()) return;
  installed = true;

  let t = null;
  const schedule = (reason) => {
    clearTimeout(t);
    t = setTimeout(() => probeIosLayout(getPage ? getPage() : 'resize', reason), 500);
  };

  window.addEventListener('resize', () => schedule('resize'));
  window.addEventListener('orientationchange', () => schedule('orientation'));
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => schedule('visualViewport'));
  }
  console.warn('[IOS_LAYOUT_PROBE] installed');
}
