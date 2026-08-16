package com.rxdeliver.driver;

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.WebView;
import android.widget.Toast;
import androidx.core.view.WindowCompat;
import android.content.SharedPreferences;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import java.lang.reflect.Field;

public class MainActivity extends BridgeActivity {

    private long activeDownloadId = -1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Read the stored environment preference BEFORE the bridge loads
        // Capacitor Preferences plugin stores in SharedPreferences named "CapacitorStorage"
        SharedPreferences prefs = getSharedPreferences("CapacitorStorage", MODE_PRIVATE);
        String env = prefs.getString("rxdeliver_env", "live");

        String serverUrl;
        if ("preview".equals(env)) {
            serverUrl = "https://preview--rx-deliver-2408a9d6.base44.app/";
        } else {
            serverUrl = "https://wizardworxx.com";
        }

        // Load full config from capacitor.config.json, then override just the server URL
        this.config = CapConfig.loadDefault(this);
        try {
            Field field = CapConfig.class.getDeclaredField("serverUrl");
            field.setAccessible(true);
            field.set(this.config, serverUrl);
        } catch (Exception e) {
            // If reflection fails, fall back to config's default URL
            e.printStackTrace();
        }

        super.onCreate(savedInstanceState);

        // Android 15 (SDK 35, our targetSdkVersion) enforces edge-to-edge by
        // default: the WebView draws its content behind the system status
        // bar AND navigation bar unless the app explicitly opts out. Without
        // this, the app's own bottom nav / FABs get covered by the phone's
        // on-screen nav buttons (3-button nav or gesture bar). This restores
        // the pre-Android-15 behavior where the system automatically insets
        // (pads) the window so content never draws under the system bars.
        //
        // We set this AFTER super.onCreate (which is where Capacitor creates
        // the WebView), and also re-apply in onWindowFocusChanged because
        // Capacitor's bridge setup can reset window insets behavior.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
        // Also explicitly show system bars in case they were hidden
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.show(WindowInsetsCompat.Type.systemBars());
            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        }

        // ── APK self-update download handling ──────────────────────────
        setupDownloadListener();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Re-apply decor fits to guard against Capacitor or plugin code
        // resetting the edge-to-edge behavior during lifecycle changes.
        if (hasFocus) {
            WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
        }
    }

    private void setupDownloadListener() {
        WebView webView = this.bridge.getWebView();
        if (webView == null) return;

        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            try {
                String fileName = extractFileName(url, contentDisposition);

                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                request.setMimeType("application/vnd.android.package-archive");
                request.addRequestHeader("User-Agent", userAgent);
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
                request.setTitle("RxDeliver update");
                request.setDescription("Downloading " + fileName);
                request.setAllowedOverMetered(true);
                request.setAllowedOverRoaming(true);

                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                activeDownloadId = dm.enqueue(request);

                Toast.makeText(this, "Downloading update…", Toast.LENGTH_SHORT).show();
                // NOTE: We intentionally do NOT register a BroadcastReceiver for
                // ACTION_DOWNLOAD_COMPLETE here. On Android 14+ (API 34+),
                // registerReceiver() without RECEIVER_NOT_EXPORTED/EXPORTED flags
                // throws SecurityException, which would show a false "Download
                // failed" toast even though the download started successfully.
                // The DownloadManager already shows its own "Download complete"
                // notification, and tapping it opens the system installer.
            } catch (Exception e) {
                Toast.makeText(this, "Download failed to start: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
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
