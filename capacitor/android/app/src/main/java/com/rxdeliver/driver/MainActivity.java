package com.rxdeliver.driver;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import java.io.File;
import java.lang.reflect.Field;

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
        // and launches it via startActivityForResult(). Works for both bare launches
        // (MAIN) and payment charges (CHARGE) with all Square POS extras.
        //
        // IMPORTANT: Square's POS API REQUIRES startActivityForResult() in the SAME
        // task — it validates this via getCallingActivity(), which is only non-null
        // when launched with startActivityForResult() and WITHOUT
        // FLAG_ACTIVITY_NEW_TASK. The original code used startActivity() +
        // FLAG_ACTIVITY_NEW_TASK, which "worked" the first time a fresh Square task
        // was created, but failed with "Unexpected developer error... must be started
        // with startActivityForResult()" on subsequent launches once Android reused
        // Square's existing task/activity instance and the stricter caller-identity
        // check kicked in. Do NOT re-add FLAG_ACTIVITY_NEW_TASK here.
        @JavascriptInterface
        public boolean launchSquareIntent(String intentUrl) {
            try {
                Intent intent = Intent.parseUri(intentUrl, Intent.URI_INTENT_SCHEME);
                runOnUiThread(() -> {
                    try {
                        startActivityForResult(intent, SQUARE_POS_REQUEST_CODE);
                    } catch (Exception e) {
                        // Square POS not installed — open Play Store
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
                });
                return true;
            } catch (Exception e) {
                Toast.makeText(MainActivity.this,
                    "Unable to launch Square POS: " + e.getMessage(), Toast.LENGTH_LONG).show();
                return false;
            }
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

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == SQUARE_POS_REQUEST_CODE) {
            // Square POS returns here after the transaction sheet closes. The web
            // app's payment outcome is delivered via the WEB_CALLBACK_URI deep link
            // (see squarePOSLauncher.jsx), so we don't need to relay `data` back to
            // JS — this override's presence + startActivityForResult() upstream is
            // what satisfies Square's same-task caller validation.
        }
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
