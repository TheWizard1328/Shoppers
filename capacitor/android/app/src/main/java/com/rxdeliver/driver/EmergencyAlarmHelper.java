package com.rxdeliver.driver;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/**
 * SILENT full-screen emergency notification.
 *
 * Owner report (Nov 14 2026): "there are 2 separate alerts playing over the
 * speaker ... we need to only use the in app alert sound".
 *
 * Rule enforced here: this card makes NO sound at all. Android channel sounds
 * are immutable, so the old loud "rx_emergency" channel (alarm-stream tone) is
 * deleted and replaced by the silent "rx_emergency_v2" one. The card exists only
 * to (a) show the emergency on the lock screen and (b) bring the app to the
 * front through a full-screen intent, so the app's OWN siren — the single audio
 * source — starts. Vibration is kept because it is felt, not heard.
 */
public final class EmergencyAlarmHelper {

    public static final String CHANNEL_ID = "rx_emergency_v2";
    public static final String LEGACY_CHANNEL_ID = "rx_emergency";
    public static final int NOTIFICATION_ID = 4712;
    public static final String LAUNCH_EXTRA = "rx_emergency_launch";
    private static final String TAG = "RxEmergency";

    private EmergencyAlarmHelper() {}

    /** Create the silent channel and remove the old loud one. Idempotent. */
    public static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        try {
            if (nm.getNotificationChannel(LEGACY_CHANNEL_ID) != null) {
                nm.deleteNotificationChannel(LEGACY_CHANNEL_ID);
            }
        } catch (Throwable ignored) { /* nothing to clean */ }

        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;

        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Emergency alerts",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("RxDeliver emergency alerts — opens the app, whose own siren is the only sound");
        channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[]{0, 900, 300, 900, 300, 900});
        // THE fix: no channel sound, so it never stacks under the in-app siren.
        channel.setSound(null, null);
        try {
            channel.setBypassDnd(true);
        } catch (Throwable ignored) { /* needs policy access on some builds */ }
        channel.setShowBadge(true);
        nm.createNotificationChannel(channel);
    }

    /**
     * Post the silent emergency card and try to bring the app up.
     * Works from any Context (Activity bridge call OR a FirebaseMessagingService
     * receiving the push while the WebView is dead).
     */
    public static String raise(Context ctx, String title, String message) {
        try {
            ensureChannel(ctx);

            Intent launch = new Intent(ctx, MainActivity.class);
            launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            launch.putExtra(LAUNCH_EXTRA, true);

            int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
            PendingIntent fullScreenPI = PendingIntent.getActivity(ctx, NOTIFICATION_ID, launch, flags);

            String safeTitle = (title == null || title.isEmpty()) ? "RxDeliver EMERGENCY" : title;
            String safeMessage = (message == null || message.isEmpty())
                ? "An emergency alert is active. Open RxDeliver." : message;

            NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setContentTitle(safeTitle)
                .setContentText(safeMessage)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setContentIntent(fullScreenPI)
                .setFullScreenIntent(fullScreenPI, true);

            NotificationManagerCompat.from(ctx).notify(NOTIFICATION_ID, builder.build());

            if (Settings.canDrawOverlays(ctx)) {
                try {
                    ctx.startActivity(launch);
                    return "launched_direct";
                } catch (Exception ignored) { /* the card above already fired */ }
            }
            return "notified_fullscreen";
        } catch (SecurityException se) {
            return "error:no_notification_permission";
        } catch (Throwable t) {
            Log.e(TAG, "raise failed: " + t.getMessage());
            return "error:" + t.getMessage();
        }
    }
}
