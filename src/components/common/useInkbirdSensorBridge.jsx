/**
 * useInkbirdSensorBridge.js
 *
 * Environment-aware bridge — use this in all components.
 * - Native APK/IPA  → useNativeBleSensor  (auto-connects, no gesture required)
 * - PWA / Browser   → useInkbirdSensor    (piggybacks on button taps)
 */
import { useInkbirdSensor } from './useInkbirdSensor';
import { useNativeBleSensor } from './useNativeBleSensor';
import { isCapacitorNativeApp } from '@/components/utils/locationProviders/capacitorRuntime';
import { appendInkbirdLog } from '@/components/devices/InkbirdBleLog';

// Computed once at module load — stable for the lifetime of the page.
// Use native BLE ONLY when running inside a real Capacitor APK/IPA build.
// In PWA / browser / editor: always use Web Bluetooth (navigator.bluetooth).
// If Web Bluetooth is also absent (editor iframe), both hooks no-op gracefully.
const USE_NATIVE = isCapacitorNativeApp();

// Log the active BLE path once at startup so DeviceSettings diagnostics show it
try {
  appendInkbirdLog('info', `BLE bridge initialised`, {
    mode: USE_NATIVE ? 'native-capacitor' : 'web-bluetooth',
    isSecureContext: window?.isSecureContext,
    isTopFrame: window === window?.top,
    hasBluetooth: !!navigator?.bluetooth,
    hasGetDevices: typeof navigator?.bluetooth?.getDevices === 'function',
    userAgent: navigator?.userAgent?.slice(0, 80),
  });
} catch (_) {}

export function useInkbirdSensorBridge(currentUser) {
  // Always call both hooks (Rules of Hooks) but pass null to the inactive one
  // so it short-circuits immediately without touching BLE APIs.
  const nativeSensor = useNativeBleSensor(USE_NATIVE ? currentUser : null);
  const webSensor    = useInkbirdSensor(USE_NATIVE ? null : currentUser);
  const sensor = USE_NATIVE ? nativeSensor : webSensor;
  // Safety: ensure forceRead is always a callable function regardless of hook version
  return {
    ...sensor,
    forceRead: typeof sensor.forceRead === 'function' ? sensor.forceRead : () => {},
    latestReadingRef: sensor.latestReadingRef || { current: null },
  };
}