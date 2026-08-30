import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.rxdeliver.app',
  appName: 'RxDeliver',
  webDir: 'dist',
  bundledWebRuntime: false,
  android: {
    allowMixedContent: true,
    // CRITICAL: Prevents background-geolocation updates from halting after 5 minutes
    // due to Android's WebView background throttling. See:
    // https://github.com/capacitor-community/background-geolocation#android
    useLegacyBridge: true
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_notify',
      iconColor: '#22c55e'
    }
  },
  // NOTE: This file is NOT the config used by the actual native Android build —
  // that's capacitor/capacitor.config.json (different appId: com.rxdeliver.driver
  // vs com.rxdeliver.app here). Kept in sync anyway to avoid future confusion.
  server: {
    androidScheme: 'https'
  }
};

export default config;
