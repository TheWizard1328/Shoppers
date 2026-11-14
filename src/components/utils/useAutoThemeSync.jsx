import { useCallback, useEffect, useRef } from 'react';
// APK transparent status/nav bars follow the APP theme, not the OS one
// (owner report Nov 5 2026: light mode icons were invisible).
import { syncNativeSystemBarTheme } from './nativeSystemBars';
import { applyThemePreference } from './userSettingsManager';
import { isMobileDeviceForTheme } from './deviceUtils';

/**
 * THEME = LIGHT / DARK / AUTO (owner directive Nov 13 2026 evening — Auto was
 * removed earlier the same day without being asked for and is restored here).
 * Light is the default. Light and Dark are explicit overrides and never consult
 * the OS. Auto follows the device's prefers-color-scheme and keeps following it
 * live (media-query listener below), which is what Auto has always meant.
 */
export function resolveThemePreference(pref) {
  // No saved preference = device default: Auto on phones/tablets, Light on PC.
  if (pref === undefined || pref === null || pref === '') {
    try { pref = isMobileDeviceForTheme() ? 'auto' : 'light'; } catch { pref = 'light'; }
  }
  if (pref === 'auto') {
    try { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch { return 'light'; }
  }
  return pref === 'dark' ? 'dark' : 'light';
}

export default function useAutoThemeSync(themePreference) {
  const themeRef = useRef(themePreference);
  themeRef.current = themePreference;

  // Single source of truth for the theme classes (userSettingsManager).
  // The native bar sync runs AFTER the class flip so it reads the new theme.
  const applyThemeClasses = useCallback((pref) => {
    applyThemePreference(pref);
    syncNativeSystemBarTheme();
  }, []);

  // THEME-AUTHORITY GUARD (owner report Nov 11 2026: app set to LIGHT on a
  // Dark-OS Windows PC, and pieces like the "Synced" dropdown at the top of the
  // Dashboard still rendered dark). The Base44 editor's preview document writes
  // its OWN theme classes onto <html>, and anything that trusted a stray 'dark'
  // class fired every dark: utility while the app was Light.
  // The saved preference is authoritative: whenever <html>'s class list
  // disagrees with what the app's own setting demands, the single apply path
  // re-asserts it. A foreign or OS-derived class can never stick.
  useEffect(() => {
    const root = document.documentElement;
    const ALL = ['dark', 'dark-theme', 'auto-theme', 'light-theme'];
    const savedPreference = () => {
      try { return localStorage.getItem('rxdeliver_theme_preference'); } catch { return null; }
    };
    const expectedClasses = (pref) => (
      resolveThemePreference(pref) === 'dark' ? ['dark', 'dark-theme'] : ['light-theme']
    );
    const expectedWithAuto = (pref) => (pref === 'auto' ? [...expectedClasses(pref), 'auto-theme'] : expectedClasses(pref));
    let fixing = false;
    // FIGHT GUARD (owner report Nov 12 2026: picking a theme froze the app).
    // The Base44 editor preview writes its own theme classes onto <html>, so
    // reassert removed them and the editor put them straight back — an endless
    // class ping-pong that pegged the main thread. Re-asserts are now coalesced
    // and, once something external keeps rewriting the class list, this backs
    // off for a few seconds instead of fighting it forever.
    let applyCount = 0;
    let windowStart = Date.now();
    let backoffUntil = 0;
    let scheduled = 0;
    const reassert = () => {
      if (fixing) return;
      const now = Date.now();
      if (now < backoffUntil) return;
      if (now - windowStart > 2000) { windowStart = now; applyCount = 0; }
      const pref = savedPreference();
      const want = expectedWithAuto(pref);
      const missing = want.some((c) => !root.classList.contains(c));
      const foreign = ALL.some((c) => !want.includes(c) && root.classList.contains(c));
      if (!missing && !foreign) return;
      applyCount += 1;
      if (applyCount > 12) {
        backoffUntil = now + 4000;
        console.warn('[theme] external writer keeps rewriting <html> classes — backing off 4s');
        return;
      }
      fixing = true;
      applyThemePreference(pref || themeRef.current);
      fixing = false;
    };
    const scheduleReassert = () => {
      if (scheduled) return;
      scheduled = requestAnimationFrame(() => { scheduled = 0; reassert(); });
    };
    reassert();
    const observer = new MutationObserver(scheduleReassert);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // Self-heal after a suspended/backgrounded session clobbered the class
    // list — the app's own preference is re-applied, never the OS one.
    const recheck = () => applyThemeClasses(themeRef.current);
    const onVis = () => { if (document.visibilityState === 'visible') recheck(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', recheck);
    const timer = setInterval(recheck, 60000);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', recheck);
      clearInterval(timer);
    };
  }, [applyThemeClasses]);

  useEffect(() => {
    // applyThemePreference caches the resolved value too, so index.html's
    // pre-React head script paints the correct theme on the very next load.
    applyThemeClasses(themePreference);
  }, [themePreference, applyThemeClasses]);

  // AUTO MODE (restored Nov 13 2026): while the preference is 'auto' the app
  // repaints the moment the device flips its own light/dark setting, instead of
  // waiting for the next load or the 60s self-heal tick.
  useEffect(() => {
    if (themePreference !== 'auto' || typeof window === 'undefined' || !window.matchMedia) return;
    let mq;
    try { mq = window.matchMedia('(prefers-color-scheme: dark)'); } catch { return; }
    const onChange = () => applyThemeClasses('auto');
    try { mq.addEventListener('change', onChange); } catch { mq.addListener?.(onChange); }
    return () => {
      try { mq.removeEventListener('change', onChange); } catch { mq.removeListener?.(onChange); }
    };
  }, [themePreference, applyThemeClasses]);
}