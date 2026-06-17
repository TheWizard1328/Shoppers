package com.rxdeliver.blemonitor

import android.app.*
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.Context
import android.content.Intent
import android.os.*
import android.util.Log
import androidx.core.app.NotificationCompat
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.TimeUnit

class BleMonitorService : Service() {

    companion object {
        var isRunning = false
        private const val TAG = "RxBleMonitor"
        private const val CHANNEL_ID = "rxdeliver_cooler_monitor"
        private const val NOTIF_ID = 1001

        // Inkbird IBS-TH2 company ID: 0x08E3
        // DataView (after company ID stripped, 7 bytes):
        //   bytes 0-1: signed int16 LE → temperature × 100
        //   byte  5:   uint8 → battery %
        private const val INKBIRD_COMPANY_ID = 0x08E3
        private val INKBIRD_NAMES = setOf("tps", "sps")

        // How often to POST a reading even if temp hasn't changed (ms)
        private const val POST_INTERVAL_MS = 60_000L
        // Don't re-post the exact same temp more than once per interval
        private const val DEDUP_INTERVAL_MS = 55_000L
    }

    private val BASE44_APP_ID = "68570f3cd01bfa2d2408a9d6"
    private val BASE44_API    = "https://api.base44.com/api/apps/$BASE44_APP_ID"
    private val PREFS         = "rxdeliver_prefs"

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private var bleScanner: BluetoothLeScanner? = null
    private var scanCallback: ScanCallback? = null

    // Dedup tracking
    private var lastPostedTemp: Float? = null
    private var lastPostTime: Long = 0L

    // Scan restart handler (BLE scan stops after ~30 min on some Android versions)
    private val handler = Handler(Looper.getMainLooper())
    private val restartRunnable = object : Runnable {
        override fun run() {
            restartScan()
            handler.postDelayed(this, 25 * 60 * 1000L) // restart every 25 min
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        createNotificationChannel()
        startForeground(NOTIF_ID, buildNotification("Scanning for cooler sensor…"))
        startBleScan()
        handler.postDelayed(restartRunnable, 25 * 60 * 1000L)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY // restart if killed by OS
    }

    override fun onDestroy() {
        super.onDestroy()
        isRunning = false
        handler.removeCallbacks(restartRunnable)
        stopBleScan()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── BLE Scanning ──────────────────────────────────────────────────────────

    private fun startBleScan() {
        val btManager = getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        val btAdapter = btManager.adapter
        if (btAdapter == null || !btAdapter.isEnabled) {
            updateNotification("Bluetooth is off — waiting…")
            // Retry in 30 seconds
            handler.postDelayed({ startBleScan() }, 30_000L)
            return
        }

        bleScanner = btAdapter.bluetoothLeScanner
        if (bleScanner == null) {
            updateNotification("BLE scanner unavailable")
            return
        }

        // Passive scan — no scan response requests, minimal battery use
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_POWER)
            .setReportDelay(0)
            .build()

        // No filters — we check device name in the callback
        // (Filtering by manufacturer data requires knowing the exact bytes upfront
        //  and some Android versions drop manufacturer data from filtered scans)
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                handleScanResult(result)
            }
            override fun onBatchScanResults(results: List<ScanResult>) {
                results.forEach { handleScanResult(it) }
            }
            override fun onScanFailed(errorCode: Int) {
                Log.w(TAG, "Scan failed: $errorCode")
                updateNotification("Scan error ($errorCode) — retrying…")
                handler.postDelayed({ restartScan() }, 5_000L)
            }
        }
        scanCallback = cb
        bleScanner?.startScan(null, settings, cb)
        Log.d(TAG, "BLE scan started")
    }

    private fun stopBleScan() {
        try {
            scanCallback?.let { bleScanner?.stopScan(it) }
        } catch (_: Exception) {}
        scanCallback = null
    }

    private fun restartScan() {
        stopBleScan()
        startBleScan()
    }

    private fun handleScanResult(result: ScanResult) {
        val name = result.device?.name ?: return
        if (!INKBIRD_NAMES.contains(name)) return

        val record = result.scanRecord ?: return
        val mfrData = record.manufacturerSpecificData ?: return

        // Try known company ID first, then any entry
        var bytes: ByteArray? = mfrData.get(INKBIRD_COMPANY_ID)
        if (bytes == null && mfrData.size() > 0) {
            bytes = mfrData.valueAt(0)
        }
        if (bytes == null || bytes.size < 2) return

        // bytes 0-1: signed int16 LE = temp × 100
        val rawTemp = (bytes[0].toInt() and 0xFF) or ((bytes[1].toInt()) shl 8)
        // Convert to signed
        val rawSigned = if (rawTemp > 32767) rawTemp - 65536 else rawTemp
        val tempC = rawSigned / 100.0f

        if (tempC < -40f || tempC > 85f) return

        val battery = if (bytes.size >= 6) (bytes[5].toInt() and 0xFF) else null
        val mac     = result.device?.address ?: name

        Log.d(TAG, "Inkbird: $tempC°C  battery=${battery}%  mac=$mac")

        // Dedup — only post if temp changed or enough time has passed
        val now = System.currentTimeMillis()
        if (lastPostedTemp == tempC && (now - lastPostTime) < DEDUP_INTERVAL_MS) return

        lastPostedTemp = tempC
        lastPostTime   = now

        updateNotification("Cooler: $tempC°C${if (battery != null) "  🔋$battery%" else ""}")
        postReading(tempC, battery, mac)
    }

    // ── HTTP POST ─────────────────────────────────────────────────────────────

    private fun postReading(tempC: Float, battery: Int?, sensorMac: String) {
        val prefs    = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val token    = prefs.getString("auth_token", null) ?: return
        val driverId = prefs.getString("driver_id", null)  ?: return

        val today = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
            .format(Date())
        val ts = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.getDefault())
            .format(Date()).substring(0, 19)

        val payload = JSONObject().apply {
            put("temperatureCelsius", tempC.toDouble())
            put("deliveryDate", today)
            put("driverId", driverId)
            put("timestamp", ts)
            put("trigger", "heartbeat")
            put("input_method", "ble")
            put("sensor_mac", sensorMac)
            if (battery != null) put("battery_percent", battery)
        }

        val body = payload.toString().toRequestBody("application/json".toMediaType())

        val request = Request.Builder()
            .url("$BASE44_API/functions/recordFridgeTemperature")
            .post(body)
            .addHeader("Authorization", "Bearer $token")
            .addHeader("Content-Type", "application/json")
            .build()

        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                Log.w(TAG, "POST failed: ${e.message}")
            }
            override fun onResponse(call: Call, response: Response) {
                val code = response.code
                response.close()
                if (code == 401) {
                    // Token expired — clear it so driver is prompted to re-login
                    getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                        .remove("auth_token").remove("driver_id").apply()
                    updateNotification("Session expired — please open RxDeliver Monitor to re-login.")
                    stopSelf()
                } else {
                    Log.d(TAG, "POST success: $code  temp=$tempC°C")
                }
            }
        })
    }

    // ── Notification ──────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Cooler Temperature Monitor",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Background BLE monitoring for cold-chain delivery"
                setShowBadge(false)
            }
            (getSystemService(NotificationManager::class.java))
                .createNotificationChannel(channel)
        }
    }

    private fun buildNotification(text: String): Notification {
        val openApp = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("RxDeliver — Cooler Monitor")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentIntent(openApp)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIF_ID, buildNotification(text))
    }
}
