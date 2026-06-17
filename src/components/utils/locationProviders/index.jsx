import { nativeLocationProvider } from './nativeLocationProvider';
import { webLocationProvider } from './webLocationProvider';
import { isCapacitorNativeApp } from './capacitorRuntime';

export const getLocationProvider = () => {
  return isCapacitorNativeApp() && nativeLocationProvider.isAvailable() ? nativeLocationProvider : webLocationProvider;
};