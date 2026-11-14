package com.rxdeliver.driver;

import android.app.NotificationManager;
import android.util.Log;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Handles emergency pushes when the WebView is minimised or swiped away.
 *
 * A backgrounded or killed WebView runs no JS, so the Capacitor push listener
 * (and therefore window.AndroidNative.raiseEmergencyAlarm) never runs — which is
 * why a minimised tablet stayed silent. This service receives the same FCM
 * message natively and posts the SILENT emergency card with a full-screen
 * intent, bringing the app up so its own siren is the only audible alert.
 *
 * Only messages whose data payload carries type=emergency are touched; every
 * other push is left to the Capacitor plugin's own service.
 */
public class RxEmergencyPushService extends FirebaseMessagingService {

    private static final String TAG = "RxEmergencyPush";

    @Override
    public void onMessageReceived(RemoteMessage message) {
        try {
            Map<String, String> data = message.getData();
            if (data == null) return;
            if (!"emergency".equals(data.get("type"))) return;

            String title = data.get("title");
            String body = data.get("body");
            if (message.getNotification() != null) {
                if (title == null) title = message.getNotification().getTitle();
                if (body == null) body = message.getNotification().getBody();
            }

            String status = EmergencyAlarmHelper.raise(getApplicationContext(), title, body);
            Log.i(TAG, "emergency raise: " + status);

            // Remove the plain OS-drawn duplicate card for the same push (the
            // payload also carries a notification block so a killed app always
            // shows something). Both cards are silent, so this only avoids two
            // stacked rows.
            try {
                String tag = data.get("tag");
                if (tag != null) {
                    NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                    if (nm != null) nm.cancel(tag, 0);
                }
            } catch (Throwable ignored) { /* cosmetic only */ }
        } catch (Throwable t) {
            Log.e(TAG, "onMessageReceived failed: " + t.getMessage());
        }
    }
}
