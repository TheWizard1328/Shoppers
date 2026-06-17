package com.rxdeliver.blemonitor

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

class MainActivity : AppCompatActivity() {

    private val PREFS = "rxdeliver_prefs"
    private val KEY_TOKEN = "auth_token"
    private val KEY_DRIVER_ID = "driver_id"
    private val KEY_EMAIL = "email"

    private val BASE44_APP_ID = "68570f3cd01bfa2d2408a9d6"
    private val BASE44_API = "https://api.base44.com/api/apps/$BASE44_APP_ID"

    private val PERM_REQUEST = 100

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // If already logged in and service running, go straight to status screen
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val token = prefs.getString(KEY_TOKEN, null)
        if (token != null) {
            showStatusScreen(prefs)
            return
        }

        showLoginScreen()
    }

    // ── Login screen ──────────────────────────────────────────────────────────
    private fun showLoginScreen() {
        setContentView(R.layout.activity_login)

        val emailField    = findViewById<EditText>(R.id.etEmail)
        val passwordField = findViewById<EditText>(R.id.etPassword)
        val loginButton   = findViewById<Button>(R.id.btnLogin)
        val statusText    = findViewById<TextView>(R.id.tvStatus)

        loginButton.setOnClickListener {
            val email = emailField.text.toString().trim()
            val pass  = passwordField.text.toString()
            if (email.isEmpty() || pass.isEmpty()) {
                statusText.text = "Please enter email and password."
                return@setOnClickListener
            }
            loginButton.isEnabled = false
            statusText.text = "Logging in…"
            doLogin(email, pass, statusText, loginButton)
        }
    }

    private fun doLogin(email: String, password: String, statusText: TextView, loginButton: Button) {
        val client = OkHttpClient()
        val body = JSONObject().apply {
            put("email", email)
            put("password", password)
        }.toString().toRequestBody("application/json".toMediaType())

        val request = Request.Builder()
            .url("$BASE44_API/auth/login")
            .post(body)
            .build()

        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                runOnUiThread {
                    statusText.text = "Network error: ${e.message}"
                    loginButton.isEnabled = true
                }
            }
            override fun onResponse(call: Call, response: Response) {
                val bodyStr = response.body?.string() ?: ""
                runOnUiThread {
                    if (response.isSuccessful) {
                        try {
                            val json = JSONObject(bodyStr)
                            val token    = json.getString("token")
                            val userId   = json.getJSONObject("user").getString("id")
                            val userEmail= json.getJSONObject("user").getString("email")
                            getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                                .putString(KEY_TOKEN, token)
                                .putString(KEY_DRIVER_ID, userId)
                                .putString(KEY_EMAIL, userEmail)
                                .apply()
                            showStatusScreen(getSharedPreferences(PREFS, Context.MODE_PRIVATE))
                        } catch (e: Exception) {
                            statusText.text = "Login failed: unexpected response."
                            loginButton.isEnabled = true
                        }
                    } else {
                        statusText.text = "Login failed: check your email/password."
                        loginButton.isEnabled = true
                    }
                }
            }
        })
    }

    // ── Status screen (after login) ───────────────────────────────────────────
    private fun showStatusScreen(prefs: android.content.SharedPreferences) {
        setContentView(R.layout.activity_status)

        val tvEmail   = findViewById<TextView>(R.id.tvEmail)
        val tvMonitor = findViewById<TextView>(R.id.tvMonitorStatus)
        val btnToggle = findViewById<Button>(R.id.btnToggle)
        val btnLogout = findViewById<Button>(R.id.btnLogout)

        val email    = prefs.getString(KEY_EMAIL, "Driver") ?: "Driver"
        tvEmail.text = "Logged in as: $email"

        val running = BleMonitorService.isRunning
        tvMonitor.text = if (running) "🟢 Cooler monitoring is ACTIVE" else "⚫ Cooler monitoring is OFF"
        btnToggle.text = if (running) "Stop Monitoring" else "Start Monitoring"

        btnToggle.setOnClickListener {
            if (BleMonitorService.isRunning) {
                stopService(Intent(this, BleMonitorService::class.java))
                tvMonitor.text = "⚫ Cooler monitoring is OFF"
                btnToggle.text = "Start Monitoring"
            } else {
                requestPermsAndStart(tvMonitor, btnToggle)
            }
        }

        btnLogout.setOnClickListener {
            stopService(Intent(this, BleMonitorService::class.java))
            prefs.edit().clear().apply()
            showLoginScreen()
        }

        // Auto-start on first login
        if (!BleMonitorService.isRunning) {
            requestPermsAndStart(tvMonitor, btnToggle)
        }
    }

    private fun requestPermsAndStart(tvMonitor: TextView, btnToggle: Button) {
        val needed = mutableListOf<String>()
        val perms = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            listOf(
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.POST_NOTIFICATIONS
            )
        } else {
            listOf(
                Manifest.permission.BLUETOOTH,
                Manifest.permission.BLUETOOTH_ADMIN,
                Manifest.permission.ACCESS_FINE_LOCATION
            )
        }
        for (p in perms) {
            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED)
                needed.add(p)
        }
        if (needed.isEmpty()) {
            startMonitor(tvMonitor, btnToggle)
        } else {
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), PERM_REQUEST)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        if (requestCode == PERM_REQUEST) {
            val tvMonitor = findViewById<TextView?>(R.id.tvMonitorStatus) ?: return
            val btnToggle = findViewById<Button?>(R.id.btnToggle) ?: return
            if (results.all { it == PackageManager.PERMISSION_GRANTED }) {
                startMonitor(tvMonitor, btnToggle)
            } else {
                tvMonitor.text = "⚠️ Bluetooth permission denied — monitoring disabled."
            }
        }
    }

    private fun startMonitor(tvMonitor: TextView, btnToggle: Button) {
        val intent = Intent(this, BleMonitorService::class.java)
        ContextCompat.startForegroundService(this, intent)
        tvMonitor.text = "🟢 Cooler monitoring is ACTIVE"
        btnToggle.text = "Stop Monitoring"
    }
}
