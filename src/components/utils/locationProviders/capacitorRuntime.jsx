import { Capacitor, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

export const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

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