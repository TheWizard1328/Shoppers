/**
 * Platform detection for Capacitor native vs web/PWA.
 *
 * In the Capacitor APK, `Capacitor.isNativePlatform()` returns true.
 * In the browser/PWA, it returns false and all existing web APIs are used.
 *
 * Usage:
 *   import { isNative, isWeb } from '@/components/native/nativePlatform';
 *   if (isNative()) { /* use native plugin */ }
 *   else { /* use web API */ }
 */

// Synchronous check — works because Capacitor injects a global
// `Capacitor` object into the WebView before JS runs.
export function isNative(): boolean {
  try {
    // @ts-ignore — Capacitor global is injected by the native shell
    return typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
}

export function isWeb(): boolean {
  return !isNative();
}

// Async version for cases where the Capacitor plugin needs to be loaded
export async function isNativeAsync(): Promise<boolean> {
  try {
    const cap = await import('@capacitor/core');
    return cap.Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export async function getPlatform(): Promise<'android' | 'ios' | 'web'> {
  try {
    const cap = await import('@capacitor/core');
    return cap.Capacitor.getPlatform();
  } catch {
    return 'web';
  }
}
