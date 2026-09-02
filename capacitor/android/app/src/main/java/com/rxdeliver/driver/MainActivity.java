package com.rxdeliver.driver;

import android.app.DownloadManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.FileProvider;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import com.getcapacitor.WebViewListener;
import java.io.File;
import java.lang.reflect.Field;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class MainActivity extends BridgeActivity {

    private long activeDownloadId = -1;
    private BroadcastReceiver downloadCompleteReceiver = null;
    private Handler pollHandler = null;
    private Runnable pollRunnable = null;

    // Request code for Square POS startActivityForResult(). Square's POS API
    // requires this call pattern (see launchSquareIntent below) — the actual
    // result extras aren't consumed here because the web app receives the
    // transaction outcome via the WEB_CALLBACK_URI deep link instead, but
    // Android still requires an onActivityResult override to complete the
    // same-task contract Square validates against.
    private static final int SQUARE_POS_REQUEST_CODE = 7284;

    // Timestamp of the most recent CHARGE (payment) launch to Square POS. Used by
    // onActivityResult()'s fallback heuristic: Square's "Unexpected developer error"
    // dialog (wrong-launch-mechanism error) returns control to us almost immediately
    // after the driver taps OK — much faster than a real payment flow (entering card
    // info, tapping through screens) or even a deliberate manual cancel. If the result
    // comes back within FALLBACK_WINDOW_MS of a CHARGE launch, we treat it as a failed
    // payload launch and auto-retry with a bare (no-payload) launch so the driver isn't
    // stuck — this is the safety net on top of the primary startActivityForResult fix.
    private long lastSquareChargeLaunchAtMs = 0;
    private static final long FALLBACK_WINDOW_MS = 4000;

    // ── Proximity auto-foreground (isNextDelivery approach trigger) ──────────
    // The web app's proximityForegroundTrigger module calls
    // window.AndroidNative.bringToFront() when the driver enters the approach
    // radius of their flagged next stop while the app is backgrounded. Strategy:
    //   1. If the app is already in the foreground → no-op.
    //   2. If SYSTEM_ALERT_WINDOW ("Display over other apps") is granted →
    //      directly relaunch MainActivity (BAL exemption for SAW apps — true
    //      auto-foreground, works with the screen on and device unlocked).
    //   3. Otherwise post a full-screen-intent notification: launches the app
    //      full-screen over the lock screen when the screen is off, and shows a
    //      high-priority heads-up banner when the screen is on.
    public static final String PROXIMITY_LAUNCH_EXTRA = "rx_proximity_launch";
    private static final String PROXIMITY_CHANNEL_ID = "proximity_foreground";
    private static final int PROXIMITY_NOTIFICATION_ID = 4711;
    private boolean activityResumed = false;

    // JavaScript interface for direct APK download from web app.
    // Bypasses the WebView DownloadListener entirely, which can be
    // unreliable on some devices (Samsung battery optimization kills
    // the DownloadManager service, WebView caching prevents the
    // DownloadListener from firing, etc.).
    public class NativeDownloadInterface {
        @JavascriptInterface
        public void downloadApk(String url) {
            runOnUiThread(() -> startApkDownload(url, "RxDeliver WebView"));
        }

        @JavascriptInterface
        public boolean isNative() {
            return true;
        }

        // Web app polls this to check download status without relying on BroadcastReceiver
        @JavascriptInterface
        public String getDownloadStatus() {
            if (activeDownloadId < 0) {
                return "{\"status\":\"idle\"}";
            }
            try {
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                Cursor cursor = dm.query(new DownloadManager.Query().setFilterById(activeDownloadId));
                if (cursor != null && cursor.moveToFirst()) {
                    int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                    long totalBytes = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                    long downloadedBytes = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                    int progress = totalBytes > 0 ? (int) (downloadedBytes * 100 / totalBytes) : 0;
                    String localUri = "";
                    if (status == DownloadManager.STATUS_SUCCESSFUL) {
                        localUri = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI));
                    }
                    String statusStr;
                    switch (status) {
                        case DownloadManager.STATUS_PENDING: statusStr = "pending"; break;
                        case DownloadManager.STATUS_RUNNING: statusStr = "running"; break;
                        case DownloadManager.STATUS_SUCCESSFUL: statusStr = "success"; break;
                        case DownloadManager.STATUS_FAILED:
                            int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                            statusStr = "failed";
                            cursor.close();
                            activeDownloadId = -1;
                            return "{\"status\":\"failed\",\"reason\":\"" + downloadErrorReason(reason) + "\"}";
                        default: statusStr = "unknown"; break;
                    }
                    cursor.close();
                    return "{\"status\":\"" + statusStr + "\",\"progress\":" + progress + "\",\"uri\":\"" + localUri + "\"}";
                }
                if (cursor != null) cursor.close();
            } catch (Exception e) {
                // ignore
            }
            return "{\"status\":\"idle\"}";
        }

        // Web app calls this to open the downloaded APK for installation
        @JavascriptInterface
        public void openDownloadedApk(String uri) {
            runOnUiThread(() -> {
                try {
                    Uri installableUri = resolveInstallableUri(uri);
                    Intent installIntent = new Intent(Intent.ACTION_VIEW);
                    installIntent.setDataAndType(installableUri, "application/vnd.android.package-archive");
                    installIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(installIntent);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "Unable to open APK: " + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            });
        }

        // ── Square POS native intent launcher ──────────────────────────────────
        // Capacitor's WebView doesn't implement onCreateWindow, so window.open()
        // silently fails for intent:// URLs. And Bridge.launchIntent() uses
        // Intent.ACTION_VIEW with the raw URI instead of Intent.parseUri(), so
        // even anchor-click navigation doesn't properly parse intent:// URIs.
        //
        // This method receives the full intent:// URI string from JS, parses it
        // with Intent.parseUri() (which correctly extracts action, package, extras),
        // and launches it with the mechanism Square's own POS API requires per its
        // OWN error dialog: "Point of Sale API must be started with
        // startActivityForResult() in the same task."
        //
        //   • CHARGE (payment): startActivityForResult() WITHOUT FLAG_ACTIVITY_NEW_TASK.
        //     This is the exact contract Square validates — confirmed directly by their
        //     error message when it's violated.
        //
        //   • MAIN (bare launch): startActivity() with no flags. No result is expected
        //     for a bare open, and startActivityForResult() here causes an immediate
        //     RESULT_CANCELED bounce-back since MAIN doesn't "return a result."
        @JavascriptInterface
        public boolean launchSquareIntent(String intentUrl) {
            try {
                Intent intent = Intent.parseUri(intentUrl, Intent.URI_INTENT_SCHEME);
                String action = intent.getAction();
                boolean isCharge = "com.squareup.pos.action.CHARGE".equals(action);
                runOnUiThread(() -> {
                    try {
                        if (isCharge) {
                            lastSquareChargeLaunchAtMs = System.currentTimeMillis();
                            startActivityForResult(intent, SQUARE_POS_REQUEST_CODE);
                        } else {
                            startActivity(intent);
                        }
                    } catch (Exception e) {
                        // Launch itself threw (e.g. Square POS not installed) — try Play Store,
                        // and if this was a CHARGE attempt, also fall back to a bare launch so
                        // the driver at least gets Square open to select their location.
                        if (isCharge) {
                            launchBareSquarePOS();
                        } else {
                            try {
                                Intent playStoreIntent = new Intent(Intent.ACTION_VIEW,
                                    Uri.parse("market://details?id=com.squareup"));
                                playStoreIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                startActivity(playStoreIntent);
                            } catch (Exception e2) {
                                Toast.makeText(MainActivity.this,
                                    "Square POS app not installed", Toast.LENGTH_LONG).show();
                            }
                        }
                    }
                });
                return true;
            } catch (Exception e) {
                Toast.makeText(MainActivity.this,
                    "Unable to launch Square POS: " + e.getMessage(), Toast.LENGTH_LONG).show();
                return false;
            }
        }



        // ── Proximity auto-foreground bridge ─────────────────────────────
        // Called by the web app's proximityForegroundTrigger module when the
        // driver approaches their isNextDelivery stop while the app is
        // backgrounded. Returns a short status string for JS diagnostics:
        //   already_foreground | launched_direct | notified_fullscreen |
        //   notified_heads_up | error:<msg>
        @JavascriptInterface
        public String bringToFront(String title, String message) {
            try {
                if (activityResumed) {
                    return "already_foreground";
                }

                // Strategy 1: direct launch — allowed while backgrounded ONLY
                // when the user has granted "Display over other apps"
                // (SYSTEM_ALERT_WINDOW is an official BAL exemption).
                if (Settings.canDrawOverlays(MainActivity.this)) {
                    runOnUiThread(() -> {
                        try {
                            startActivity(buildProximityLaunchIntent());
                        } catch (Exception e) {
                            android.util.Log.w("RxDeliver", "Proximity direct launch failed: " + e.getMessage());
                        }
                    });
                    return "launched_direct";
                }

                // Strategy 2: full-screen-intent notification (alarm/call style).
                ensureProximityChannel();
                PendingIntent launchPI = PendingIntent.getActivity(
                    MainActivity.this,
                    PROXIMITY_NOTIFICATION_ID,
                    buildProximityLaunchIntent(),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                );

                String safeTitle = (title == null || title.isEmpty()) ? "Approaching your next stop" : title;
                String safeMessage = (message == null || message.isEmpty())
                    ? "You are close to your next delivery — tap to open RxDeliver" : message;

                NotificationCompat.Builder builder = new NotificationCompat.Builder(MainActivity.this, PROXIMITY_CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_stat_notify)
                    .setContentTitle(safeTitle)
                    .setContentText(safeMessage)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
                    .setAutoCancel(true)
                    .setOnlyAlertOnce(true)
                    .setContentIntent(launchPI)
                    .setFullScreenIntent(launchPI, true);

                boolean canFsi = true;
                if (Build.VERSION.SDK_INT >= 29) {
                    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                    canFsi = nm != null && nm.canUseFullScreenIntent();
                }

                try {
                    NotificationManagerCompat.from(MainActivity.this)
                        .notify(PROXIMITY_NOTIFICATION_ID, builder.build());
                } catch (SecurityException se) {
                    // POST_NOTIFICATIONS runtime permission not granted on 13+
                    android.util.Log.w("RxDeliver", "Proximity notify blocked (no notification permission): " + se.getMessage());
                    return "error:no_notification_permission";
                }

                return canFsi ? "notified_fullscreen" : "notified_heads_up";
            } catch (Exception e) {
                android.util.Log.e("RxDeliver", "bringToFront failed: " + e.getMessage());
                return "error:" + e.getMessage();
            }
        }

        // Whether the user granted "Display over other apps" (required for
        // true auto-foreground with the screen ON; without it we fall back to
        // the full-screen-intent notification).
        @JavascriptInterface
        public boolean hasOverlayPermission() {
            try {
                return Settings.canDrawOverlays(MainActivity.this);
            } catch (Exception e) {
                return false;
            }
        }

        // Opens the system "Display over other apps" settings page for this app.
        // The user must toggle it manually — Android will not show a runtime
        // dialog for this special access permission.
        @JavascriptInterface
        public void requestOverlayPermission() {
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + getPackageName()));
                    intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this,
                        "Unable to open overlay settings: " + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            });
        }

        // JS can check this to skip unnecessary trigger calls.
        @JavascriptInterface
        public boolean isAppInForeground() {
            return activityResumed;
        }
    }

    // Since Android 7.0 (API 24), passing a raw file:// URI to another app's
    // Intent (e.g. the Package Installer) throws FileUriExposedException —
    // this was the actual root cause of "Unable to open APK: file://..." on
    // both the web banner's "Open & Install" button AND the native dialog's
    // "Open" button. DownloadManager's COLUMN_LOCAL_URI returns a file:// URI,
    // so it must be re-resolved through the FileProvider (declared in
    // AndroidManifest.xml with authority "${applicationId}.fileprovider") to
    // get an installable content:// URI with a granted read permission.
    private Uri resolveInstallableUri(String rawUri) {
        Uri parsed = Uri.parse(rawUri);
        if ("content".equals(parsed.getScheme())) {
            // Already a content:// URI (some OEMs/API levels return this directly) — use as-is.
            return parsed;
        }
        String path = parsed.getPath();
        if (path == null) path = rawUri; // fallback: treat the raw string as a filesystem path
        File apkFile = new File(path);
        return FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apkFile);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Read the stored environment preference BEFORE the bridge loads
        SharedPreferences prefs = getSharedPreferences("CapacitorStorage", MODE_PRIVATE);
        String env = prefs.getString("rxdeliver_env", "live");

        String serverUrl;
        if ("preview".equals(env)) {
            serverUrl = "https://preview--rx-deliver-2408a9d6.base44.app/";
        } else {
            serverUrl = "https://wizardworxx.com";
        }

        this.config = CapConfig.loadDefault(this);
        try {
            Field field = CapConfig.class.getDeclaredField("serverUrl");
            field.setAccessible(true);
            field.set(this.config, serverUrl);
        } catch (Exception e) {
            e.printStackTrace();
        }

        super.onCreate(savedInstanceState);

        // If the activity was (re)launched by the proximity auto-foreground
        // trigger, show over the lock screen and wake the display.
        applyProximityLaunchFlags(getIntent());

        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.show(WindowInsetsCompat.Type.systemBars());
            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            // Set system bar icon appearance based on system dark mode
            int nightModeFlags = getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
            boolean isDarkMode = nightModeFlags == android.content.res.Configuration.UI_MODE_NIGHT_YES;
            // Light mode: dark icons on grey background. Dark mode: light icons on dark background.
            controller.setAppearanceLightStatusBars(!isDarkMode);
            controller.setAppearanceLightNavigationBars(!isDarkMode);
        }

        // ── APK self-update download handling ──────────────────────────
        setupDownloadListener();

        // ── Register JavaScript interface for direct download ──────────
        // Exposed as window.AndroidNative.downloadApk(url) — more reliable
        // than relying on the WebView DownloadListener, which can fail
        // intermittently on Samsung and other aggressive battery-managed
        // devices.
        WebView webView = this.bridge.getWebView();
        if (webView != null) {
            webView.addJavascriptInterface(new NativeDownloadInterface(), "AndroidNative");
        }

        // ── Safe-area inset injection for edge-to-edge mode ──────────
        // On Android 15 (targetSdk 35) edge-to-edge is enforced, so the
        // WebView content extends behind the status bar and navigation bar.
        // env(safe-area-inset-*) in CSS works but is not applied by many
        // fixed-position overlay elements (dialogs, sheets, drawers, toasts,
        // full-screen panels). We inject the OS-level inset values as CSS
        // custom properties and tag the body with .is-native-apk so the web
        // app can apply safe-area padding to ALL fixed overlays globally
        // without touching the web/PWA version.
        ViewCompat.setOnApplyWindowInsetsListener(getWindow().getDecorView(), (v, insets) -> {
            WindowInsetsCompat stableBars = insets;
            int statusBarHeight = stableBars.getInsets(WindowInsetsCompat.Type.statusBars()).top;
            int navBarHeight = stableBars.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom;
            int leftInset = stableBars.getInsets(WindowInsetsCompat.Type.systemBars()).left;
            int rightInset = stableBars.getInsets(WindowInsetsCompat.Type.systemBars()).right;

            // Convert to px (density) and inject into WebView
            float density = getResources().getDisplayMetrics().density;
            String js = String.format(java.util.Locale.US,
                "(function(){" +
                "  var r=document.documentElement;" +
                "  r.style.setProperty('--native-safe-top','%dpx');" +
                "  r.style.setProperty('--native-safe-bottom','%dpx');" +
                "  r.style.setProperty('--native-safe-left','%dpx');" +
                "  r.style.setProperty('--native-safe-right','%dpx');" +
                "  if(document.body)document.body.classList.add('is-native-apk');" +
                "  else document.addEventListener('DOMContentLoaded',function(){document.body.classList.add('is-native-apk');});" +
                "})();",
                (int)(statusBarHeight / density),
                (int)(navBarHeight / density),
                (int)(leftInset / density),
                (int)(rightInset / density)
            );
            if (webView != null) {
                webView.evaluateJavascript(js, null);
            }
            return insets;
        });

        // ── WebView renderer crash recovery ──────────────────────────
        // CRITICAL FIX: Chrome WebView runs its rendering engine in a separate
        // process. Under memory pressure (common on shared-use tablets running
        // all day with maps, GPS, camera, BLE, and image-heavy stop cards) that
        // renderer process can be killed by the OS. Android's WebViewClient
        // contract is explicit: if onRenderProcessGone() is NOT overridden (or
        // is overridden but returns false with no recovery), the framework
        // kills the ENTIRE app process outright — no exception is thrown, no
        // JS error fires, no React error boundary catches anything. This is
        // exactly the "taskbar disappears, screen goes white, app closes,
        // taskbar reappears" symptom reported on the dispatcher/driver tablets.
        //
        // Fix: register a WebViewListener on the Capacitor bridge, destroy the
        // dead WebView, persist a crash marker into the SAME SharedPreferences
        // file ("CapacitorStorage") backing @capacitor/preferences (group
        // default), so the JS side can read it via Preferences.get() right
        // after reboot and log/report it — then recreate() the Activity so
        // Capacitor reinitializes a fresh WebView + bridge instead of the
        // whole app being killed to the home screen.
        this.bridge.addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                boolean didCrash = detail != null && detail.didCrash();
                long nowMs = System.currentTimeMillis();
                try {
                    SharedPreferences crashPrefs = getSharedPreferences("CapacitorStorage", MODE_PRIVATE);
                    SharedPreferences.Editor editor = crashPrefs.edit();
                    String nowIso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).format(new Date());
                    int prevCount = 0;
                    try {
                        prevCount = Integer.parseInt(crashPrefs.getString("rxdeliver_native_crash_count", "0"));
                    } catch (Exception ignored) {}
                    // Track crash timing for circuit breaker
                    long lastCrashMs = 0;
                    try {
                        lastCrashMs = Long.parseLong(crashPrefs.getString("rxdeliver_native_crash_last_ms", "0"));
                    } catch (Exception ignored) {}
                    long sinceLastCrash = lastCrashMs > 0 ? (nowMs - lastCrashMs) : Long.MAX_VALUE;
                    editor.putString("rxdeliver_native_crash_last", nowIso);
                    editor.putString("rxdeliver_native_crash_last_ms", String.valueOf(nowMs));
                    editor.putString("rxdeliver_native_crash_did_crash", String.valueOf(didCrash));
                    editor.putString("rxdeliver_native_crash_count", String.valueOf(prevCount + 1));
                    editor.apply();

                    // CIRCUIT BREAKER: If the renderer crashed within 30 seconds
                    // of the previous crash, we're in a crash loop — the fresh
                    // WebView load is triggering another OOM. Instead of looping
                    // forever (which kills the battery and frustrates the user),
                    // let the OS handle it this time (return false = Android's
                    // default behavior). The crash marker is still logged so
                    // the JS side can report it if the app survives via a
                    // manual restart.
                    if (sinceLastCrash < 30000) {
                        android.util.Log.w("RxDeliver", "🚨 Render process crash loop detected (" + sinceLastCrash + "ms since last crash) — letting OS handle");
                        if (view != null) { try { view.destroy(); } catch (Exception e) { e.printStackTrace(); } }
                        return false; // Let Android's default handling kick in
                    }
                } catch (Exception e) {
                    e.printStackTrace();
                }

                // The dead renderer's WebView instance is unusable — destroy it,
                // then restart the Activity so Capacitor builds a brand-new
                // WebView + bridge and reloads the app fresh. This keeps the
                // app process (and thus the user's session) alive instead of
                // Android silently killing it.
                try {
                    if (view != null) {
                        view.destroy();
                    }
                } catch (Exception e) {
                    e.printStackTrace();
                }

                new Handler(Looper.getMainLooper()).post(() -> {
                    try {
                        recreate();
                    } catch (Exception e) {
                        e.printStackTrace();
                    }
                });

                // Returning true tells Android WE handled the renderer loss —
                // this is what prevents the framework's default "kill the app"
                // behavior from kicking in.
                return true;
            }
        });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
            // Re-apply system bar appearance on focus change
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
            if (controller != null) {
                int nightModeFlags = getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
                boolean isDarkMode = nightModeFlags == android.content.res.Configuration.UI_MODE_NIGHT_YES;
                controller.setAppearanceLightStatusBars(!isDarkMode);
                controller.setAppearanceLightNavigationBars(!isDarkMode);
            }
        }
    }

    // Fallback: open Square POS with no payment payload (main-screen launch).
    // Used when a CHARGE (payload) launch fails outright, or bounces back almost
    // immediately with Square's "wrong launch mechanism" error dialog (see
    // onActivityResult below). Lets the driver at least open Square manually
    // and pick the right location/collect payment themselves, instead of the
    // button doing nothing.
    private void launchBareSquarePOS() {
        try {
            Intent bareIntent = new Intent(Intent.ACTION_MAIN);
            bareIntent.setPackage("com.squareup");
            startActivity(bareIntent);
            Toast.makeText(this,
                "Opened Square POS — please confirm your location and collect payment manually.",
                Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            try {
                Intent playStoreIntent = new Intent(Intent.ACTION_VIEW,
                    Uri.parse("market://details?id=com.squareup"));
                playStoreIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(playStoreIntent);
            } catch (Exception e2) {
                Toast.makeText(this,
                    "Square POS app not installed", Toast.LENGTH_LONG).show();
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == SQUARE_POS_REQUEST_CODE) {
            // Fallback safety net: if Square POS bounces back almost immediately after a
            // CHARGE (payload) launch, it's very likely showing its "Unexpected developer
            // error" dialog rather than a real payment attempt (entering card info takes
            // several seconds; even a deliberate manual cancel isn't usually this fast).
            // Auto-retry with a bare (no-payload) launch so the driver still gets Square
            // open and can collect payment/select location manually instead of the button
            // doing nothing.
            long elapsed = System.currentTimeMillis() - lastSquareChargeLaunchAtMs;
            if (lastSquareChargeLaunchAtMs > 0 && elapsed < FALLBACK_WINDOW_MS) {
                lastSquareChargeLaunchAtMs = 0;
                launchBareSquarePOS();
            }
        }
    }

    // ── Proximity auto-foreground helpers ────────────────────────────────────

    // Launch intent for the proximity trigger. MainActivity is singleTask, so
    // this reorders the existing task to the front instead of spawning a copy.
    private Intent buildProximityLaunchIntent() {
        Intent intent = new Intent(MainActivity.this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK
            | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
            | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra(PROXIMITY_LAUNCH_EXTRA, true);
        return intent;
    }

    private void ensureProximityChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(PROXIMITY_CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
            PROXIMITY_CHANNEL_ID,
            "Stop proximity alerts",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Brings RxDeliver to the front when you approach your next delivery stop");
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(channel);
    }

    // When launched by the proximity trigger (direct or via full-screen intent),
    // show over the lock screen and wake the screen — the driver is mid-route.
    private void applyProximityLaunchFlags(Intent intent) {
        if (intent != null && intent.getBooleanExtra(PROXIMITY_LAUNCH_EXTRA, false)) {
            if (Build.VERSION.SDK_INT < 27) return; // setShowWhenLocked/setTurnScreenOn are API 27+
            try {
                setShowWhenLocked(true);
                setTurnScreenOn(true);
            } catch (Exception e) {
                android.util.Log.w("RxDeliver", "Proximity launch flags failed: " + e.getMessage());
            }
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // singleTask launchMode: re-launches of a running activity arrive here
        applyProximityLaunchFlags(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        activityResumed = true;
    }

    @Override
    public void onPause() {
        super.onPause();
        activityResumed = false;
    }

    private void setupDownloadListener() {
        WebView webView = this.bridge.getWebView();
        if (webView == null) return;

        // Keep the DownloadListener as a fallback — if the WebView does
        // intercept a download URL via navigation, it still works. The
        // JavaScript interface is the primary path (called directly by
        // the web app).
        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            startApkDownload(url, userAgent);
        });
    }

    private void startApkDownload(String url, String userAgent) {
        // ── Cancel any previous download + cleanup its listeners ──────
        // Prevents duplicate downloads when the user taps the button
        // multiple times or when both the DownloadListener and JS
        // interface fire for the same URL.
        if (pollHandler != null && pollRunnable != null) {
            pollHandler.removeCallbacks(pollRunnable);
            pollRunnable = null;
        }
        if (downloadCompleteReceiver != null) {
            try { unregisterReceiver(downloadCompleteReceiver); } catch (Exception ignored) {}
            downloadCompleteReceiver = null;
        }
        if (activeDownloadId >= 0) {
            try {
                DownloadManager dm0 = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                dm0.remove(activeDownloadId);
            } catch (Exception ignored) {}
            activeDownloadId = -1;
        }

        try {
            String fileName = extractFileName(url, null);

            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setMimeType("application/vnd.android.package-archive");
            if (userAgent != null) request.addRequestHeader("User-Agent", userAgent);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            request.setTitle("RxDeliver update");
            request.setDescription("Downloading " + fileName);
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(true);

            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            activeDownloadId = dm.enqueue(request);

            Toast.makeText(this, "Downloading update…", Toast.LENGTH_SHORT).show();

            // ── Stalled download detection ─────────────────────────────
            // On Samsung and other aggressive battery-managed devices,
            // DownloadManager.enqueue() succeeds but the download never
            // starts (the service gets killed or queued). Two-phase check:
            //   15s — warn the user it's still queued
            //   30s — auto-open the GitHub URL in the browser as fallback
            final String stalledUrl = url;
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                if (activeDownloadId < 0) return;
                try {
                    DownloadManager dm2 = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    Cursor cursor = dm2.query(new DownloadManager.Query().setFilterById(activeDownloadId));
                    if (cursor != null && cursor.moveToFirst()) {
                        int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                        if (status == DownloadManager.STATUS_PENDING) {
                            Toast.makeText(this,
                                "Download still queued by system — will auto-open browser in 15s if it doesn't start.",
                                Toast.LENGTH_LONG).show();
                        }
                    }
                    if (cursor != null) cursor.close();
                } catch (Exception ignored) {}
            }, 15000);

            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                if (activeDownloadId < 0) return;
                try {
                    DownloadManager dm2 = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    Cursor cursor = dm2.query(new DownloadManager.Query().setFilterById(activeDownloadId));
                    if (cursor != null && cursor.moveToFirst()) {
                        int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                        if (status == DownloadManager.STATUS_PENDING) {
                            // DownloadManager is stuck — open the URL in the browser instead
                            Toast.makeText(this,
                                "DownloadManager stuck — opening browser fallback.",
                                Toast.LENGTH_SHORT).show();
                            Intent browserIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(stalledUrl));
                            browserIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(browserIntent);
                        }
                    }
                    if (cursor != null) cursor.close();
                } catch (Exception ignored) {}
            }, 30000);

            // ── Register download-complete receiver ────────────────────
            downloadCompleteReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context ctx, Intent intent) {
                    long receivedId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                    if (receivedId != activeDownloadId) return;

                    DownloadManager dm2 = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    Cursor cursor = dm2.query(new DownloadManager.Query().setFilterById(activeDownloadId));
                    if (cursor != null && cursor.moveToFirst()) {
                        int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                        if (status == DownloadManager.STATUS_SUCCESSFUL) {
                            String localUri = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI));
                            activeDownloadId = -1;
                            notifyWebDownloadComplete(localUri);
                        } else if (status == DownloadManager.STATUS_FAILED) {
                            int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                            activeDownloadId = -1;
                            Toast.makeText(MainActivity.this,
                                "Download failed: " + downloadErrorReason(reason),
                                Toast.LENGTH_LONG).show();
                            notifyWebDownloadFailed(downloadErrorReason(reason));
                        }
                    }
                    if (cursor != null) cursor.close();

                    try { unregisterReceiver(downloadCompleteReceiver); } catch (Exception ignored) {}
                    downloadCompleteReceiver = null;
                    if (pollHandler != null && pollRunnable != null) {
                        pollHandler.removeCallbacks(pollRunnable);
                        pollRunnable = null;
                    }
                }
            };
            // Use RECEIVER_EXPORTED for system broadcasts on Android 13+ —
            // RECEIVER_NOT_EXPORTED can block system broadcasts on some OEM implementations.
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                registerReceiver(downloadCompleteReceiver,
                    new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
                    Context.RECEIVER_EXPORTED);
            } else {
                registerReceiver(downloadCompleteReceiver,
                    new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE));
            }

            // ── Polling fallback ──────────────────────────────────────
            // BroadcastReceiver can be unreliable on Samsung/other aggressive
            // battery-managed devices. Poll every 2 seconds as a backup.
            // Also calls the web-side callback if registered.
            pollHandler = new Handler(Looper.getMainLooper());
            pollRunnable = new Runnable() {
                @Override
                public void run() {
                    if (activeDownloadId < 0) return;
                    try {
                        DownloadManager dm2 = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                        Cursor cursor = dm2.query(new DownloadManager.Query().setFilterById(activeDownloadId));
                        if (cursor != null && cursor.moveToFirst()) {
                            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                            if (status == DownloadManager.STATUS_SUCCESSFUL) {
                                String localUri = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI));
                                cursor.close();
                                activeDownloadId = -1;
                                if (downloadCompleteReceiver != null) {
                                    try { unregisterReceiver(downloadCompleteReceiver); } catch (Exception ignored) {}
                                    downloadCompleteReceiver = null;
                                }
                                notifyWebDownloadComplete(localUri);
                                return;
                            } else if (status == DownloadManager.STATUS_FAILED) {
                                int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                                cursor.close();
                                activeDownloadId = -1;
                                if (downloadCompleteReceiver != null) {
                                    try { unregisterReceiver(downloadCompleteReceiver); } catch (Exception ignored) {}
                                    downloadCompleteReceiver = null;
                                }
                                Toast.makeText(MainActivity.this, "Download failed: " + downloadErrorReason(reason), Toast.LENGTH_LONG).show();
                                notifyWebDownloadFailed(downloadErrorReason(reason));
                                return;
                            }
                        }
                        if (cursor != null) cursor.close();
                    } catch (Exception ignored) {}
                    pollHandler.postDelayed(this, 2000);
                }
            };
            pollHandler.postDelayed(pollRunnable, 2000);
        } catch (Exception e) {
            Toast.makeText(this, "Download failed to start: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private String downloadErrorReason(int reason) {
        switch (reason) {
            case DownloadManager.ERROR_CANNOT_RESUME: return "Cannot resume";
            case DownloadManager.ERROR_DEVICE_NOT_FOUND: return "Storage not found";
            case DownloadManager.ERROR_FILE_ALREADY_EXISTS: return "File already exists";
            case DownloadManager.ERROR_FILE_ERROR: return "File error";
            case DownloadManager.ERROR_HTTP_DATA_ERROR: return "Data error";
            case DownloadManager.ERROR_INSUFFICIENT_SPACE: return "Not enough storage";
            case DownloadManager.ERROR_TOO_MANY_REDIRECTS: return "Too many redirects";
            case DownloadManager.ERROR_UNHANDLED_HTTP_CODE: return "HTTP error";
            case DownloadManager.ERROR_UNKNOWN: return "Unknown error";
            default: return "Error " + reason;
        }
    }

    private void notifyWebDownloadComplete(String apkUri) {
        try {
            WebView webView = this.bridge.getWebView();
            if (webView != null) {
                webView.evaluateJavascript(
                    "window.__apkDownloadComplete && window.__apkDownloadComplete('" + apkUri + "');",
                    null);
            }
        } catch (Exception ignored) {}
    }

    private void notifyWebDownloadFailed(String reason) {
        try {
            WebView webView = this.bridge.getWebView();
            if (webView != null) {
                webView.evaluateJavascript(
                    "window.__apkDownloadFailed && window.__apkDownloadFailed('" + reason + "');",
                    null);
            }
        } catch (Exception ignored) {}
    }

    private String extractFileName(String url, String contentDisposition) {
        String fileName = "RxDeliver.apk";
        try {
            if (contentDisposition != null && contentDisposition.contains("filename=")) {
                String cd = contentDisposition.substring(contentDisposition.indexOf("filename=") + 9);
                fileName = cd.replace("\"", "").trim();
            } else {
                String last = Uri.parse(url).getLastPathSegment();
                if (last != null && last.toLowerCase().endsWith(".apk")) {
                    fileName = last;
                }
            }
        } catch (Exception ignored) {}
        return fileName;
    }
}
