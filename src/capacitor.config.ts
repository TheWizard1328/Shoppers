import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.rxdeliver.app',
  appName: 'RxDeliver',
  webDir: 'dist',
  bundledWebRuntime: false,
  android: {
    allowMixedContent: true
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