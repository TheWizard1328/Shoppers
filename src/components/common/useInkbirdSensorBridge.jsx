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

// Computed once at module load — stable for the lifetime of the page.
// Use native BLE ONLY when running inside a real Capacitor APK/IPA build.
// In PWA / browser / editor: always use Web Bluetooth (navigator.bluetooth).
// If Web Bluetooth is also absent (editor iframe), both hooks no-op gracefully.
const USE_NATIVE = isCapacitorNativeApp();

export function useInkbirdSensorBridge(currentUser) {
  // Always call both hooks (Rules of Hooks) but pass null to the inactive one
  // so it short-circuits immediately without touching BLE APIs.
  const nativeSensor = useNativeBleSensor(USE_NATIVE ? currentUser : null);
  const webSensor    = useInkbirdSensor(USE_NATIVE ? null : currentUser);
  return USE_NATIVE ? nativeSensor : webSensor;
}