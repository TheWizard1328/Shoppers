import { useCallback, useEffect, useRef, useState } from 'react';
// APK transparent status/nav bars follow the APP theme, not the OS one
// (owner report Nov 5 2026: light mode icons were invisible).
import { syncNativeSystemBarTheme } from './nativeSystemBars';
import { applyThemePreference } from './userSettingsManager';

export default function useAutoThemeSync(themePreference) {
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (event) => {
      setSystemPrefersDark(event.matches);
    };

    setSystemPrefersDark(mediaQuery.matches);

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  // RESYNC GUARD (Oct 2 2026): matchMedia '(prefers-color-scheme: dark)'
  // 'change' events do NOT reliably fire in suspended/backgrounded Android
  // WebView and PWA sessions. A page loaded while the OS was Light (auto theme,
  // no 'dark' class) whose OS later switched to Dark ended up SPLIT: the app's
  // CSS variables flipped dark instantly (layoutStyles' '@media
  // (prefers-color-scheme: dark) { html.auto-theme ... }' block needs no JS),
  // but Tailwind's dark: utilities stayed light — white cards/chips on a dark
  // page. Re-check the live media query whenever the page becomes visible or
  // focused, plus once a minute, and RE-APPLY the class set directly (not via
  // state equality) so a clobbered <html> class list also self-heals.
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
  // Dashboard still rendered dark). Two things used to win over the app's
  // choice: the Base44 editor's preview document writes its OWN theme classes
  // onto <html> (it goes dark with the OS), and anything that trusted a stray
  // 'dark' class. The previous guard only stripped a BARE 'dark', so a foreign
  // 'dark-theme' or 'auto-theme' + 'dark' pair sailed through and fired every
  // dark: utility while the app was Light.
  // Now the saved preference is authoritative: whenever <html>'s class list
  // disagrees with what the app's own setting demands, the single apply path
  // re-asserts it. A foreign or OS-derived class can never stick.
  useEffect(() => {
    const root = document.documentElement;
    const ALL = ['dark', 'dark-theme', 'auto-theme', 'light-theme'];
    const savedPreference = () => {
      try { return localStorage.getItem('rxdeliver_theme_preference'); } catch { return null; }
    };
    const expectedClasses = (pref) => {
      if (pref === 'light') return ['light-theme'];
      if (pref === 'dark') return ['dark', 'dark-theme'];
      let sysDark = false;
      try { sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { sysDark = false; }
      return sysDark ? ['auto-theme', 'dark'] : ['auto-theme'];
    };
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
      applyThemePreference(pref || themeRef.current || 'auto');
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
    const recheck = () => {
      let sysDark = false;
      try { sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { sysDark = false; }
      setSystemPrefersDark(sysDark);
      applyThemeClasses(themeRef.current);
    };
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
    // Cache the RESOLVED preference (owner fix, Sep 28) so index.html's
    // pre-React head script can apply the correct theme on the very next
    // load before any JS/React runs — eliminates the light-flash on load.
    // applyThemePreference caches it too; the single apply path handles the rest.
    try { localStorage.setItem('rxdeliver_theme_preference', themePreference || 'auto'); } catch { /* non-fatal */ }
    applyThemeClasses(themePreference);
  }, [themePreference, systemPrefersDark, applyThemeClasses]);
}