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
      smallIcon: 'ic_stat_icon_config_sample',
      iconColor: '#0f172a'
    }
  },
  server: {
    androidScheme: 'https'
  }
};

export default config;
