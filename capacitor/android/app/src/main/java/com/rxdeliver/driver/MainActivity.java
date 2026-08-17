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

    @Override
    protected void onDestroy() {
        // Unregister the download complete receiver to prevent leaks
        if (downloadCompleteReceiver != null) {
            try {
                unregisterReceiver(downloadCompleteReceiver);
            } catch (Exception ignored) {}
            downloadCompleteReceiver = null;
        }
        super.onDestroy();
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

                // Register a one-shot receiver for ACTION_DOWNLOAD_COMPLETE.
                // On Android 14+ (API 34+), registerReceiver() REQUIRES either
                // RECEIVER_EXPORTED or RECEIVER_NOT_EXPORTED. Since
                // ACTION_DOWNLOAD_COMPLETE is a system broadcast (sent by
                // DownloadManager), RECEIVER_NOT_EXPORTED is correct — it
                // receives system broadcasts but blocks broadcasts from
                // other apps.
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
                                Toast.makeText(MainActivity.this, "Download failed", Toast.LENGTH_LONG).show();
                            }
                        }
                        if (cursor != null) cursor.close();

                        // Unregister after handling (one-shot)
                        try { unregisterReceiver(downloadCompleteReceiver); } catch (Exception ignored) {}
                        downloadCompleteReceiver = null;
                    }
                };
                // Android 13+ (API 33+) requires the receiver flag; older
                // versions ignore it. RECEIVER_NOT_EXPORTED = system-only.
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
        });
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
