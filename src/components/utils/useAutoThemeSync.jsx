import { useCallback, useEffect, useRef, useState } from 'react';

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
  const applyThemeClasses = useCallback((pref, sysDark) => {
    const root = document.documentElement;
    if (pref === 'dark') {
      root.classList.remove('auto-theme', 'light-theme');
      root.classList.add('dark-theme', 'dark');
      root.setAttribute('data-system-theme', 'dark');
      return;
    }
    if (pref === 'light') {
      root.classList.remove('auto-theme', 'dark-theme', 'dark');
      root.classList.add('light-theme');
      root.setAttribute('data-system-theme', 'light');
      return;
    }
    root.classList.remove('light-theme', 'dark-theme');
    root.classList.add('auto-theme');
    root.setAttribute('data-system-theme', sysDark ? 'dark' : 'light');
    if (sysDark) root.classList.add('dark');
    else root.classList.remove('dark');
  }, []);

  useEffect(() => {
    const recheck = () => {
      let sysDark = false;
      try { sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { sysDark = false; }
      setSystemPrefersDark(sysDark);
      applyThemeClasses(themeRef.current, sysDark);
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
    const root = document.documentElement;
    // Cache the RESOLVED preference (owner fix, Sep 28) so index.html's
    // pre-React head script can apply the correct theme on the very next
    // load before any JS/React runs — eliminates the light-flash on load.
    try { localStorage.setItem('rxdeliver_theme_preference', themePreference || 'auto'); } catch { /* non-fatal */ }

    if (themePreference === 'dark') {
      root.classList.remove('auto-theme', 'light-theme');
      root.classList.add('dark-theme', 'dark');
      root.setAttribute('data-system-theme', 'dark');
      return;
    }

    if (themePreference === 'light') {
      root.classList.remove('auto-theme', 'dark-theme', 'dark');
      root.classList.add('light-theme');
      root.setAttribute('data-system-theme', 'light');
      return;
    }

    root.classList.remove('light-theme', 'dark-theme');
    root.classList.add('auto-theme');
    root.setAttribute('data-system-theme', systemPrefersDark ? 'dark' : 'light');

    if (systemPrefersDark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [themePreference, systemPrefersDark]);
}