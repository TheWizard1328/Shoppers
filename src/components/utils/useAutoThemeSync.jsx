import { useCallback, useEffect, useRef } from 'react';
// APK transparent status/nav bars follow the APP theme, not the OS one
// (owner report Nov 5 2026: light mode icons were invisible).
import { syncNativeSystemBarTheme } from './nativeSystemBars';
import { applyThemePreference } from './userSettingsManager';

/**
 * THEME = LIGHT OR DARK ONLY (owner spec Nov 13 2026).
 * Light is the default and the saved app setting is the SINGLE source of truth:
 * the OS colour scheme is never consulted (no prefers-color-scheme query
 * anywhere in the app), so Dashboard, Clients, Routes and every other page look
 * exactly the same whatever the device's own light/dark setting is.
 */
export function resolveThemePreference(pref) {
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
      const want = expectedClasses(pref);
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
}