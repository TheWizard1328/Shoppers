// Emergency alarm — the siren + haptics that run while an emergency is ACTIVE.
//
// Owner note (Nov 14 2026): "can the emergency sounds get through silent and
// vibrate only modes?"
//  • Android (Chrome / installed PWA / our APK): Web Audio is played on the
//    MEDIA stream, which the ringer switch does NOT mute. Silent or vibrate
//    still plays. Do Not Disturb can block it if media is muted there.
//  • iPhone: the hardware mute switch DOES silence web audio. Only a native
//    audio-session change (Capacitor AVAudioSession = playback) defeats it, so
//    iOS relies on vibration + the on-screen alert instead.
//  • Vibration (navigator.vibrate) is Android-only; iOS ignores it.
//
// Everything here is best-effort and never throws — a silent alarm must not
// break the emergency UI itself.

let audioCtx = null;
let masterGain = null;
let toneTimer = null;
let vibrateTimer = null;
let running = false;

const TWO_PI = Math.PI * 2;

const ensureContext = async () => {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new Ctor();
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch { /* needs a gesture; UI press usually provides one */ }
  }
  return audioCtx;
};

// One siren sweep, ~900 ms: 700 Hz → 1200 Hz → 700 Hz.
const playSweep = (ctx) => {
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(700, now);
    osc.frequency.linearRampToValueAtTime(1250, now + 0.45);
    osc.frequency.linearRampToValueAtTime(700, now + 0.9);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.55, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.88);
    osc.connect(gain);
    gain.connect(masterGain);
    osc.start(now);
    osc.stop(now + 0.9);
  } catch { /* non-fatal */ }
};

const startVibration = () => {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  const pattern = [0, 700, 250, 700, 250];
  const fire = () => { try { navigator.vibrate(pattern); } catch { /* ignore */ } };
  fire();
  vibrateTimer = setInterval(fire, 2000);
};

export const startEmergencyAlarm = async () => {
  if (running) return;
  running = true;
  startVibration();
  try {
    const ctx = await ensureContext();
    if (!ctx) return;
    masterGain = ctx.createGain();
    masterGain.gain.value = 1;
    masterGain.connect(ctx.destination);
    playSweep(ctx);
    toneTimer = setInterval(() => {
      if (!running) return;
      if (audioCtx?.state === 'suspended') audioCtx.resume().catch(() => {});
      playSweep(audioCtx);
    }, 950);
  } catch { /* non-fatal */ }
};

// OWNER REPORT (Nov 26 2026): "my tablet runs the in-app crash clip but also keeps
// playing its default notification sound until I pull down the shade and cancel."
// The OS notification outlived the alert, so the device kept alerting after the
// siren stopped. Closing the emergency notifications is part of stopping the alarm.
const closeEmergencyNotifications = () => {
  try {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker?.getRegistration) return;
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg?.getNotifications) return;
      reg.getNotifications({ includeTriggered: true }).then((list) => {
        for (const n of (list || [])) {
          const tag = String(n?.tag || '');
          if (tag.startsWith('rx-emergency')) { try { n.close(); } catch { /* ignore */ } }
        }
      }).catch(() => null);
    }).catch(() => null);
  } catch { /* ignore */ }
};

export const stopEmergencyAlarm = () => {
  closeEmergencyNotifications();
  running = false;
  if (toneTimer) { clearInterval(toneTimer); toneTimer = null; }
  if (vibrateTimer) { clearInterval(vibrateTimer); vibrateTimer = null; }
  try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(0); } catch { /* ignore */ }
  try {
    if (masterGain) {
      masterGain.gain.value = 0;
      masterGain.disconnect();
      masterGain = null;
    }
  } catch { /* ignore */ }
};

export const isEmergencyAlarmRunning = () => running;

// Short confirmation beep for the arming countdown (10..1 ticks are silent).
export const playArmTick = () => {
  ensureContext().then((ctx) => {
    if (!ctx) return;
    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.13);
    } catch { /* ignore */ }
  });
};

// ── STAND-DOWN CHIME (owner request Nov 14 2026) ────────────────────────────
// "We can send a similar set of notification for cancellation with pushes and a
// green banner and a nicer sound." Three soft sine notes (C6-E6-G6) instead of
// the sawtooth siren: obviously an all-clear, not another alarm. Same MEDIA
// stream trick as the siren so it is audible on silent/vibrate Android devices.
let chimeRunning = false;

export const playCancellationChime = async () => {
  if (chimeRunning) return;
  chimeRunning = true;
  try {
    const ctx = await ensureContext();
    if (!ctx) return;
    const notes = [1046.5, 1318.5, 1568.0]; // C6, E6, G6
    const start = ctx.currentTime + 0.02;
    notes.forEach((freq, index) => {
      try {
        const at = start + index * 0.22;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.28, at + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.42);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(at);
        osc.stop(at + 0.45);
      } catch { /* non-fatal */ }
    });
  } catch { /* non-fatal */ } finally {
    setTimeout(() => { chimeRunning = false; }, 1200);
  }
};
