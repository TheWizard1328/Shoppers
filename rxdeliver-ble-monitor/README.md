# RxDeliver Cooler Monitor — Android App

A tiny background Android app that passively scans for Inkbird IBS-TH2 (`tps`) or
IBS-TH2 Plus (`sps`) BLE advertisements and posts temperature readings directly to
the RxDeliver backend every ~60 seconds.

**Drivers never interact with it after first login. It runs completely silently.**

---

## How it works

1. Driver installs the APK on their Android phone
2. Opens the app once, signs in with their RxDeliver email + password
3. App starts a background service that passively scans for the Inkbird in the cooler
4. Every time the Inkbird broadcasts (every few seconds), the app reads the temperature
5. It POSTs to `recordFridgeTemperature` with the driver's ID + today's date (max once per 60s)
6. The LiveTempBadge on the dashboard polls the DB and shows live readings automatically
7. After reboot, the service restarts automatically — no driver action needed

---

## Build instructions

### Prerequisites
- Android Studio Hedgehog (2023.1) or newer
- Android SDK 34

### Steps
1. Open this folder in Android Studio
2. Let Gradle sync
3. Build → Generate Signed APK (or Build → Build APK for debug testing)
4. The APK will be at `app/build/outputs/apk/release/app-release.apk`

---

## Install on driver phones

### Option A — Direct install (sideload)
1. On the driver's phone: Settings → Security → enable "Install unknown apps" for Chrome/Files
2. Send the APK via WhatsApp, email, or Google Drive
3. Driver taps the APK file to install
4. Open app, sign in once with RxDeliver credentials

### Option B — QR code
Host the APK on a URL and generate a QR code — drivers scan and download directly.

---

## Driver setup (one time, ~2 minutes)
1. Install the APK
2. Open "RxDeliver Monitor"
3. Sign in with the same email/password as the main RxDeliver app
4. Tap "Allow" on the Bluetooth permission prompt
5. See "🟢 Cooler monitoring is ACTIVE"
6. Done — they can minimize and forget about it

---

## Battery impact
- Passive BLE scanning uses ~1-3% extra battery per hour
- No WiFi or mobile data used except for the once-per-minute HTTP POST
- The POST is ~200 bytes — negligible data usage

---

## Permissions required
- `BLUETOOTH_SCAN` — to receive BLE advertisement packets passively
- `BLUETOOTH_CONNECT` — required by Android 12+ for BLE APIs
- `FOREGROUND_SERVICE` — to keep scanning in the background
- `INTERNET` — to POST readings to the backend
- `RECEIVE_BOOT_COMPLETED` — to auto-restart after phone reboot
- `POST_NOTIFICATIONS` — to show the persistent "Cooler monitoring active" notification
  (Android 13+ requirement for foreground services — notification is silent and unobtrusive)

---

## Notes
- The Inkbird IBS-TH2 uses passive non-connectable BLE advertising (ADV_NONCONN_IND)
  which is invisible to browsers but fully readable by native Android BLE scanning
- The app does NOT connect to the Inkbird — it just listens for broadcasts
- This means zero pairing, zero user interaction with the sensor, and the Inkbird
  battery life is completely unaffected
- Temperature data is deduplicated server-side (one record per driver per day,
  readings appended as an array)
