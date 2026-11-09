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

  // EDITOR GUARD (owner report Nov 1 2026: app set to LIGHT on a Dark-OS PC,
  // and a handful of elements still rendered dark — editor only). The Base44
  // editor's preview document writes its OWN theme classes onto <html>. The app
  // never needs a bare 'dark': its own state is always expressed as
  // 'dark-theme' (explicit Dark) or 'auto-theme' + 'dark' (Auto + dark OS). So
  // a 'dark' with neither of those companions is somebody else's and is
  // stripped, which keeps tailwind dark: utilities, the .dark CSS block and
  // every JS check on the app's own signal.
  useEffect(() => {
    const root = document.documentElement;
    const stripForeignDark = () => {
      if (!root.classList.contains('dark')) return;
      if (root.classList.contains('dark-theme') || root.classList.contains('auto-theme')) return;
      root.classList.remove('dark');
    };
    stripForeignDark();
    const observer = new MutationObserver(stripForeignDark);
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