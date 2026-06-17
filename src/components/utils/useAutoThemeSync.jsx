import { useEffect, useState } from 'react';

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

  useEffect(() => {
    const root = document.documentElement;

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