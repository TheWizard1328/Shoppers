import { nativeLocationProvider } from './nativeLocationProvider';
import { webLocationProvider } from './webLocationProvider';

export const getLocationProvider = () => {
  return nativeLocationProvider.isAvailable() ? nativeLocationProvider : webLocationProvider;
};