package com.rxdeliver.driver;

import android.app.AlertDialog;
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
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import java.lang.reflect.Field;

public class MainActivity extends BridgeActivity {

    private long activeDownloadId = -1;
    private BroadcastReceiver downloadCompleteReceiver = null;

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
            // starts (the service gets killed). Poll after 5 seconds —
            // if still PENDING, warn the user and suggest the browser.
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                if (activeDownloadId < 0) return;
                try {
                    DownloadManager dm2 = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    Cursor cursor = dm2.query(new DownloadManager.Query().setFilterById(activeDownloadId));
                    if (cursor != null && cursor.moveToFirst()) {
                        int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                        if (status == DownloadManager.STATUS_PENDING) {
                            Toast.makeText(this,
                                "Download seems stalled. Check Downloads or try opening the link in your browser.",
                                Toast.LENGTH_LONG).show();
                        }
                    }
                    if (cursor != null) cursor.close();
                } catch (Exception ignored) {}
            }, 5000);

            // ── Register download-complete receiver ────────────────────
            if (downloadCompleteReceiver != null) {
                try { unregisterReceiver(downloadCompleteReceiver); } catch (Exception ignored) {}
            }
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
                            showDownloadCompleteDialog(Uri.parse(localUri));
                        } else if (status == DownloadManager.STATUS_FAILED) {
                            int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                            Toast.makeText(MainActivity.this,
                                "Download failed: " + downloadErrorReason(reason),
                                Toast.LENGTH_LONG).show();
                        }
                    }
                    if (cursor != null) cursor.close();

                    try { unregisterReceiver(downloadCompleteReceiver); } catch (Exception ignored) {}
                    downloadCompleteReceiver = null;
                }
            };
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                registerReceiver(downloadCompleteReceiver,
                    new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
                    Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(downloadCompleteReceiver,
                    new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE));
            }
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

    private void showDownloadCompleteDialog(Uri apkUri) {
        runOnUiThread(() -> {
            new AlertDialog.Builder(this)
                .setTitle("Download Complete")
                .setMessage("RxDeliver APK downloaded successfully. Open it to install?")
                .setPositiveButton("Open", (d, w) -> {
                    try {
                        Intent installIntent = new Intent(Intent.ACTION_VIEW);
                        installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                        installIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(installIntent);
                    } catch (Exception e) {
                        Toast.makeText(this, "Unable to open APK: " + e.getMessage(), Toast.LENGTH_LONG).show();
                    }
                })
                .setNegativeButton("Later", null)
                .show();
        });
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
