package com.rxdeliver.blemonitor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/**
 * Restarts BleMonitorService automatically after the phone reboots,
 * but only if the driver was previously logged in.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED &&
            intent.action != "android.intent.action.QUICKBOOT_POWERON") return

        val prefs = context.getSharedPreferences("rxdeliver_prefs", Context.MODE_PRIVATE)
        val token = prefs.getString("auth_token", null) ?: return
        // Token exists — driver was logged in, restart the service
        ContextCompat.startForegroundService(
            context,
            Intent(context, BleMonitorService::class.java)
        )
    }
}
