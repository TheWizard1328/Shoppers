// Detects and reports native WebView renderer crashes (Android
// RenderProcessGone) that were caught and recovered from by
// MainActivity.java's onRenderProcessGone override.
//
// Before this fix, when Chrome WebView's renderer process was killed by the
// OS (memory pressure) or crashed natively, Android's default (unhandled)
// behavior is to kill the ENTIRE app process — no JS exception, no React
// error boundary trigger, nothing catchable from script. That's why these
// crashes were completely invisible (app just goes white and closes, taskbar
// flickers, no error screen at all).
//
// MainActivity.java now overrides onRenderProcessGone(), persists a crash
// marker into the SAME SharedPreferences file ("CapacitorStorage") backing
// @capacitor/preferences' default group, then recreate()s the Activity so
// the app recovers instead of dying. This module runs on every native boot,
// checks for that marker, reports it (console + local crash buffer so it
// shows up in the AppErrorBoundary "Copy All" export), then clears the
// one-shot fields so it isn't re-reported on unrelated future boots.

let checked = false;

export async function checkAndReportNativeCrash() {
  if (checked) return;
  checked = true;

  try {
    if (typeof window === 'undefined' || !window.Capacitor?.isNativePlatform?.()) return;

    const { Preferences } = await import('@capacitor/preferences');
    const lastCrash = await Preferences.get({ key: 'rxdeliver_native_crash_last' });
    if (!lastCrash?.value) return;

    const [didCrashRes, countRes] = await Promise.all([
      Preferences.get({ key: 'rxdeliver_native_crash_did_crash' }),
      Preferences.get({ key: 'rxdeliver_native_crash_count' })
    ]);

    const crashInfo = {
      timestamp: lastCrash.value,
      didCrash: didCrashRes?.value === 'true',
      lifetimeCount: Number(countRes?.value) || 1
    };

    const message = `WebView renderer process gone — app auto-recovered instead of crashing to home screen (didCrash: ${crashInfo.didCrash}, lifetime occurrences: ${crashInfo.lifetimeCount}, occurred: ${crashInfo.timestamp})`;
    console.error('🔴 [NativeCrash]', message);

    try {
      const bufferKey = 'rxdeliver_crash_buffer';
      const raw = localStorage.getItem(bufferKey);
      const buffer = raw ? JSON.parse(raw) : [];
      buffer.push({
        type: 'native-render-process-gone',
        message,
        stack: '',
        timestamp: new Date().toISOString(),
        url: window.location.pathname
      });
      localStorage.setItem(bufferKey, JSON.stringify(buffer.slice(-10)));
    } catch {}

    // Clear the one-shot fields so a normal, unrelated future boot doesn't
    // re-report the same historical crash. The lifetime count field is left
    // alone (native side keeps incrementing it independently).
    await Promise.all([
      Preferences.remove({ key: 'rxdeliver_native_crash_last' }),
      Preferences.remove({ key: 'rxdeliver_native_crash_did_crash' })
    ]);
  } catch (error) {
    console.warn('[NativeCrash] Failed to check native crash marker:', error?.message || error);
  }
}

checkAndReportNativeCrash();
