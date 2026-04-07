import { Capacitor, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

export const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');
export const App = registerPlugin('App');

export const isCapacitorNativeApp = () => {
  return typeof Capacitor?.isNativePlatform === 'function' && Capacitor.isNativePlatform();
};

export const getCapacitorPlatform = () => {
  if (typeof Capacitor?.getPlatform === 'function') {
    return Capacitor.getPlatform();
  }
  return 'web';
};

export const ensureBackgroundNotificationPermission = async () => {
  if (!isCapacitorNativeApp() || getCapacitorPlatform() !== 'android') {
    return true;
  }

  const permissionStatus = await LocalNotifications.checkPermissions();
  if (permissionStatus.display === 'granted') {
    return true;
  }

  const requested = await LocalNotifications.requestPermissions();
  return requested.display === 'granted';
};

export const getNativeLocationAuthorization = async () => {
  if (!isCapacitorNativeApp()) {
    return { granted: false, status: 'web' };
  }

  const plugin = BackgroundGeolocation;
  if (!plugin || typeof plugin.checkPermissions !== 'function') {
    return { granted: false, status: 'unavailable' };
  }

  const permissions = await plugin.checkPermissions();
  const status = permissions?.location || permissions?.status || permissions?.authorizationStatus || 'unknown';
  const background = permissions?.backgroundLocation || permissions?.background || permissions?.backgroundGranted || false;
  const granted = status === 'granted' || status === 'always';
  const backgroundGranted = background === true || status === 'always';

  return { granted, backgroundGranted, status, permissions };
};

export const requestNativeLocationAuthorization = async () => {
  if (!isCapacitorNativeApp()) {
    return { granted: false, backgroundGranted: false, status: 'web' };
  }

  const plugin = BackgroundGeolocation;
  if (!plugin || typeof plugin.openSettings !== 'function') {
    return getNativeLocationAuthorization();
  }

  const current = await getNativeLocationAuthorization();
  if (current.backgroundGranted || getCapacitorPlatform() !== 'android') {
    return current;
  }

  await plugin.openSettings();
  return current;
};