/**
 * nativeSystemBars — keeps the APK's transparent status/nav bar icons legible.
 *
 * OWNER REPORT (Nov 5 2026): in the APK the header and footer areas behind the
 * phone's notification panel and navigation bar are transparent. Dark mode is
 * perfect ("I can see everything at the top and bottom"), but in LIGHT mode the
 * icons were invisible: MainActivity only read the OS night mode at launch, so
 * a light app on a dark phone kept white icons over a white app bar.
 *
 * The page knows the truth (the `dark` class on <html>), so every theme change
 * tells the native layer which appearance to use. Non-APK builds and browsers
 * without the bridge are silently ignored.
 */

const canCallNative = () => (
  typeof window !== 'undefined'
  && window.AndroidNative
  && typeof window.AndroidNative.setSystemBarTheme === 'function'
);

/** Is the app currently painted dark? (resolved theme, not the preference) */
export const isAppCurrentlyDark = () => {
  if (typeof document === 'undefined') return false;
  const root = document.documentElement;
  return root.classList.contains('dark')
    || root.classList.contains('dark-theme')
    || (root.classList.contains('auto-theme') && root.getAttribute('data-system-theme') === 'dark');
};

/**
 * Push the current app theme to the native system bars.
 * Cheap and idempotent — safe to call on mount, on theme change, on resume.
 */
export const syncNativeSystemBarTheme = () => {
  if (!canCallNative()) return false;
  try {
    window.AndroidNative.setSystemBarTheme(isAppCurrentlyDark());
    return true;
  } catch (_) {
    return false;
  }
};

export default syncNativeSystemBarTheme;
