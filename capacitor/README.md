# RxDeliver Capacitor APK

Wraps the RxDeliver web app in a native Android shell with:
- **Always-on GPS** via foreground service (no screen-off suspension)
- **Background BLE** auto-connect to Inkbird sensors (no user gesture required)

## Architecture

```
capacitor/
├── capacitor.config.ts     ← Live URL mode (loads app.base44.com/apps/...)
├── android/                 ← Native Android project
├── package.json             ← Capacitor + plugins
└── README.md

src/components/native/       ← Adapters (live in the web app codebase)
├── nativePlatform.ts        ← isNative() / isWeb() detection
├── nativeGpsAdapter.ts      ← BackgroundGeolocation or navigator.geolocation
└── nativeBleAdapter.ts      ← Capacitor BluetoothLe or Web Bluetooth
```

## How it works

- The APK loads `https://app.base44.com/apps/68570f3cd01bfa2d2408a9d6` in a WebView
- Git pushes to `main` deploy instantly — the APK picks up changes on next launch
- `isNative()` detects whether we're in the APK or browser, routes to the right API
- Web/PWA users are completely unaffected — they use the existing browser APIs

## Prerequisites (on your machine)

1. **Android Studio** (Arctic Fox or newer) — https://developer.android.com/studio
2. **Android SDK** (API 31+ recommended, min 24)
3. **Java JDK 17** (bundled with Android Studio)
4. **Node.js 18+** and npm

## Build steps

### 1. Install dependencies
```bash
cd capacitor
npm install
```

### 2. Build the web assets (optional — live URL mode doesn't need this)
If you want offline bundling instead of live URL:
```bash
# Build the RxDeliver web app first
cd .. && npm run build
# Then sync to Capacitor
cd capacitor && npx cap sync
```

### 3. Open in Android Studio
```bash
cd capacitor
npx cap open android
```

### 4. Build the APK in Android Studio
- **Debug APK:** Build → Build Bundle(s)/APK(s) → Build APK(s)
- **Release AAB (Play Store):** Build → Generate Signed Bundle/APK → AAB

### 5. Install on device
```bash
# Debug install (USB debugging enabled)
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

## Permissions granted at runtime

The APK requests these on first launch:
- **Location (Always)** — for background GPS tracking
- **Bluetooth** — for Inkbird sensor auto-connect
- **Notifications** — for the foreground service notification

## Distributing to drivers

### Option A: Direct APK sideload
Copy the release APK to driver devices via USB, email, or a download link.
Drivers enable "Install from unknown sources" in Android settings.

### Option B: Play Store (separate listing)
Upload the signed AAB to Google Play Console as a separate app
(com.rxdeliver.driver). Your existing Base44 TWA and PWA remain independent.

## Plugin versions
- `@capacitor/core` 7.x
- `@capacitor/android` 7.x
- `@capacitor-community/background-geolocation` — foreground service GPS
- `@capacitor-community/bluetooth-le` — native BLE auto-connect
- `@capacitor/app` — lifecycle hooks
- `@capacitor/preferences` — native SharedPreferences

## Integration with existing code

The adapters in `src/components/native/` are designed to slot into the existing
`locationTracker.jsx` and Inkbird BLE code with minimal changes:

```ts
// locationTracker.jsx — before
navigator.geolocation.watchPosition(...)

// locationTracker.jsx — after
import { NativeGpsAdapter } from '@/components/native/nativeGpsAdapter';
const gps = new NativeGpsAdapter();
await gps.start(onPosition, onError);
// ... later:
await gps.stop();
```

```ts
// Inkbird BLE — before
navigator.bluetooth.requestDevice(...)

// Inkbird BLE — after
import { NativeBleAdapter } from '@/components/native/nativeBleAdapter';
const ble = new NativeBleAdapter();
await ble.initialize();
await ble.autoConnect(onReading, onConnectionChange);
// ... later:
await ble.disconnect();
```

The `isNative()` check inside each adapter handles the routing automatically —
no `if (isNative())` branches needed in the calling code.
