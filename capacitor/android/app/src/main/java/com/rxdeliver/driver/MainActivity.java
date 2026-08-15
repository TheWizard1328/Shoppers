package com.rxdeliver.driver;

import android.content.SharedPreferences;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import java.lang.reflect.Field;

public class MainActivity extends BridgeActivity {
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
    }
}
