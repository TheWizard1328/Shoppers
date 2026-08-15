import { nativeLocationProvider } from './nativeLocationProvider';
import { webLocationProvider } from './webLocationProvider';
import { isCapacitorNativeApp } from './capacitorRuntime';

export const getLocationProvider = () => {
  const isNative = isCapacitorNativeApp();
  const nativeAvailable = isNative && nativeLocationProvider.isAvailable();
  const provider = nativeAvailable ? nativeLocationProvider : webLocationProvider;
  console.log(`📍 [LocationProvider] Selected: ${provider.name} (isNative=${isNative}, nativeAvailable=${nativeAvailable})`);
  return provider;
};