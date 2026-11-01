import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
  return twMerge(clsx(inputs))
} 


export const isIframe = window.self !== window.top;

/**
 * Single source of truth for "is the app in dark mode?" used by every
 * component that styles itself in JS (map tiles, markers, canvas viewers).
 *
 * OWNER REPORT (Nov 1 2026): the app was set to LIGHT while the PC's OS was
 * DARK, and a few JS-themed pieces still rendered dark. Two traps caused it:
 * reading prefers-color-scheme directly (the OS, not the app's choice) and
 * trusting a bare `dark` class. The Base44 editor puts its OWN dark classes on
 * the preview document, so a bare `dark` must never count.
 *
 * Signals owned by useAutoThemeSync:
 *   light   → html.light-theme
 *   dark    → html.dark-theme
 *   auto    → html.auto-theme + html.dark only when the OS is dark
 */
export const isAppDarkTheme = () => {
  if (typeof document === 'undefined' || !document.documentElement) return false;
  const root = document.documentElement;
  const cls = root.classList;
  if (cls.contains('light-theme')) return false;
  if (cls.contains('dark-theme')) return true;
  return cls.contains('auto-theme') && cls.contains('dark');
};

/**
 * True when the app is running inside the Base44 editor's Preview tab
 * (desktop PWA editor, the Base44 Android APK editor, or any sandbox host).
 *
 * Why it matters (owner report, Oct 29 2026): the editor preview rebuilds on
 * EVERY git push and the deploy prunes the previous build's hashed chunks, so
 * an editor preview holding an older index 404s a lazy chunk mid-load. The app
 * also used to register its service worker and schedule its idle-kill timer on
 * that host, and idle-kill calls Capacitor App.exitApp() — which closes the
 * ENTIRE Base44 app on the phone, editor and all.
 *
 * Editor-preview contexts get the app WITHOUT service-worker caching and
 * WITHOUT the self-closing battery logic. Production domains and the native
 * APK never match this, so their behaviour is unchanged.
 */
export const isEditorPreview = (() => {
  try {
    const host = String(window.location.hostname || '').toLowerCase();
    if (!host) return false;
    return (
      host.startsWith('preview--')
      || host.includes('--') && host.endsWith('.base44.app')
      || host.endsWith('.base44.app')
      || host.endsWith('.base44.dev')
      || host.startsWith('sandbox-')
      || host.startsWith('localhost')
      || host.startsWith('127.0.0.1')
    );
  } catch (_) {
    return false;
  }
})();
