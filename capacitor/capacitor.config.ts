import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.rxdeliver.driver',
  appName: 'RxDeliver',
  webDir: 'dist',
  // Live URL mode — the APK loads the deployed Base44 app directly.
  // Git pushes to main still deploy instantly; the APK picks up changes
  // on next app launch without needing a Play Store update.
  server: {
    url: 'https://app.base44.com/apps/68570f3cd01bfa2d2408a9d6',
    cleartext: false,
  },
  android: {
    // Allows the WebView to access native bridge without CORS issues
    allowMixedContent: false,
    // Required for background geolocation foreground service
    backgroundColor: '#ffffff',
  },
  plugins: {
    BackgroundGeolocation: {
      // Native foreground service for always-on GPS
      notificationTitle: 'RxDeliver GPS Active',
      notificationText: 'Location tracking is running',
      notificationIcon: 'ic_notification',
      // Update interval: 10 seconds (balanced accuracy vs battery)
      interval: 10000,
      fastestInterval: 5000,
      // High accuracy mode for delivery routing
      locationAccuracy: 100, // PRIORITY_HIGH_ACCURACY
      // Keep tracking when app is backgrounded
      startForeground: true,
      // Small displacement filter to reduce battery drain
      smallestDisplacement: 10, // meters
    },
    BluetoothLe: {
      // Auto-request permissions on connect
      // Android 12+ requires runtime BT permissions
      askForPermissions: true,
    },
  },
};

export default config;
