package com.rxdeliver.driver;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.WebView;
import android.widget.Toast;
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

        // ── APK self-update download handling ──────────────────────────
        // The Capacitor WebView has no download handling wired up by
        // default, so tapping "Download APK" (a plain <a href download>
        // link) inside the in-app WebView silently does nothing — no
        // progress, no "download complete" notification, nothing to tap
        // to install. Registering a DownloadListener hands the download
        // off to Android's own DownloadManager, which shows the native
        // "Download complete" notification the user expects, and tapping
        // it opens the system installer for the APK.
        setupDownloadListener();
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

                // Tapping the system "Download complete" notification already opens
                // the installer via the DownloadManager's own content:// URI, so no
                // extra receiver logic is needed for that path. We still register a
                // one-shot receiver so we can react (e.g. log) if useful later.
                registerDownloadCompleteReceiver();
            } catch (Exception e) {
                Toast.makeText(this, "Download failed to start: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
    }

    private void registerDownloadCompleteReceiver() {
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long completedId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (completedId == activeDownloadId) {
                    try { unregisterReceiver(this); } catch (Exception ignored) {}
                }
            }
        };
        registerReceiver(receiver, new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE));
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
