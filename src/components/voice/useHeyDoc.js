/**
 * Hey Doc — driver voice assistant logic, extracted as a hook so the
 * on/off toggle button (stats panel) and the response overlay (chip
 * / banner, rendered lower on the dashboard) can share one listening
 * session without duplicating state.
 *
 * See HeyDocToggleButton.jsx (the stats panel button) and
 * HeyDocOverlay.jsx (the chip/banner) for the UI pieces.
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import { parseHeyDocCommand, resolveCallTarget } from './heyDocParser';

// ── Native APK speech shim ──────────────────────────────────────────────
// The Android WebView does NOT implement the Web Speech API. When we're
// running inside the APK wrapper (window.AndroidNative + hasNativeSpeech),
// this class backs the same start/abort/onresult/onend contract the wake
// session uses, forwarding to MainActivity's SpeechRecognizer bridge and
// mapping its callbacks into the web SpeechRecognition event shapes.
class NativeSpeechRecognition {
  constructor() {
    this.continuous = false;
    this.interimResults = false;
    this.lang = 'en-CA';
    this.maxAlternatives = 1;
    this.onresult = null;
    this.onend = null;
    this.onerror = null;
    this.onstart = null;
    this._aborted = false;
    window.__nativeSpeech = {
      onResult: (text, isFinal) => {
        if (this._aborted || !this.onresult || typeof text !== 'string') return;
        try {
          this.onresult({
            resultIndex: 0,
            results: [{ isFinal: !!isFinal, length: 1, 0: { transcript: text } }],
          });
        } catch {}
      },
      onError: (err) => {
        if (this._aborted || !this.onerror) return;
        try { this.onerror({ error: err }); } catch {}
      },
      onEnd: () => {
        if (this._aborted) return; // abort() already fired onend locally
        try { this.onend?.(); } catch {}
      },
    };
  }
  start() {
    this._aborted = false;
    try {
      window.AndroidNative.startVoiceRecognition();
    } catch {
      this.onerror?.({ error: 'service-not-allowed' });
      this.onend?.();
    }
  }
  abort() {
    if (this._aborted) return;
    this._aborted = true;
    try { window.AndroidNative.stopVoiceRecognition(); } catch {}
    try { this.onend?.(); } catch {}
  }
  stop() {
    try { window.AndroidNative.stopVoiceRecognition(); } catch {}
  }
}

const getSpeechRecognition = () => {
  if (typeof window === 'undefined') return null;
  if (window.AndroidNative?.hasNativeSpeech?.()) return NativeSpeechRecognition;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
};

const digitsOnly = (v) => String(v || '').replace(/\D/g, '');

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

const WAKE_PATTERNS = [
  /\b(?:hey|hay|okay|ok)\s+(?:doc|dock|dog|doctor|dot|talk)\b/,
  /\ba\s+(?:doc|dock|dog)\b/,
];

const findWake = (normText) => {
  for (const re of WAKE_PATTERNS) {
    const m = normText.match(re);
    if (m) return m;
  }
  return null;
};

const armedStorageKey = (userId) => `heydoc_armed_${userId || 'default'}`;

const isNativeApk = () => {
  try { return !!(window.AndroidNative && window.AndroidNative.isNative && window.AndroidNative.isNative()); } catch { return false; }
};

const micBlockedMessage = () =>
  isNativeApk()
    ? 'Open Android Settings > Apps > RxDeliver > Permissions > Microphone, and set it to Allow. Then tap the mic again.'
    : 'Tap the lock/info icon next to the address bar, open Permissions, and set Microphone to Allow. Then tap the mic again.';

const micBlockedSpeech = () =>
  isNativeApk()
    ? 'The microphone is blocked. Open Android app settings, allow the microphone for this app, then tap the mic again.'
    : 'The microphone is blocked. Open browser permissions, allow the microphone, then tap the mic again.';

const speak = (text) => {
  try {
    if (!('speechSynthesis' in window) || !text) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-CA';
    u.rate = 1;
    window.speechSynthesis.speak(u);
  } catch (error) {
    console.error('[HeyDoc] TTS failed:', error);
  }
};

// Short confirmation beep (Web Audio) — quick feedback the wake word
// was heard, without our own TTS being captured back as a command.
let audioCtx = null;
const chime = () => {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.3);
  } catch {}
};

const findCurrentStop = (deliveries) => {
  const active = (deliveries || []).filter(
    (d) => !TERMINAL_STATUSES.includes(d?.status) && !['pending', 'staged'].includes(d?.status)
  );
  return (
    active.find((d) => d.isNextDelivery === true) ||
    active.filter((d) => d.en_route_status === 'in_transit' || d.status === 'en_route' || d.status === 'in_transit')
      .sort((a, b) => (a.stop_order ?? 999) - (b.stop_order ?? 999))[0] ||
    active.sort((a, b) => (a.stop_order ?? 999) - (b.stop_order ?? 999))[0] ||
    null
  );
};

export function useHeyDoc({ currentUser, filteredDeliveries, patients, stores, appUsers, enabled }) {
  const [armed, setArmed] = useState(false);
  const [awaitingCommand, setAwaitingCommand] = useState(false);
  const [chip, setChip] = useState(null); // { icon, title, body }
  const recognitionRef = useRef(null);
  const armedRef = useRef(false);
  const awaitingRef = useRef(false);
  const wakeHeardRef = useRef(false);
  const restartTimerRef = useRef(null);
  const awaitTimeoutRef = useRef(null);
  const chipTimerRef = useRef(null);
  const cmdDebounceRef = useRef(null);
  const pendingActionRef = useRef(null); // { action, deliveryId, label, progressBody, progressSpeech }
  const pendingTimerRef = useRef(null);

  const SR = getSpeechRecognition();
  const canUse = !!(SR && enabled && currentUser);

  const showChip = useCallback((icon, title, body, speakText) => {
    if (chipTimerRef.current) clearTimeout(chipTimerRef.current);
    setChip({ icon, title, body });
    if (speakText) speak(speakText);
    chipTimerRef.current = setTimeout(() => setChip(null), 12000);
  }, []);

  const clearTimers = () => {
    if (restartTimerRef.current) { clearTimeout(restartTimerRef.current); restartTimerRef.current = null; }
    if (awaitTimeoutRef.current) { clearTimeout(awaitTimeoutRef.current); awaitTimeoutRef.current = null; }
    if (cmdDebounceRef.current) { clearTimeout(cmdDebounceRef.current); cmdDebounceRef.current = null; }
  };

  const setAwaiting = useCallback((value) => {
    awaitingRef.current = value;
    setAwaitingCommand(value);
    if (awaitTimeoutRef.current) { clearTimeout(awaitTimeoutRef.current); awaitTimeoutRef.current = null; }
    if (value) {
      awaitTimeoutRef.current = setTimeout(() => {
        awaitingRef.current = false;
        setAwaitingCommand(false);
      }, 10000);
    }
  }, []);

  const stopRecognition = useCallback(() => {
    clearTimers();
    try { recognitionRef.current?.abort?.(); } catch {}
    recognitionRef.current = null;
    wakeHeardRef.current = false;
    awaitingRef.current = false;
    setAwaitingCommand(false);
  }, []);

  const handleCommand = useCallback((rawText) => {
    // ── Voice confirmation gate ─────────────────────────────────────
    // If a stop action is pending confirmation, the next utterance is
    // read as yes / no. Anything else cancels the pending action and is
    // processed as a brand-new command instead.
    if (pendingActionRef.current) {
      const pending = pendingActionRef.current;
      pendingActionRef.current = null;
      if (pendingTimerRef.current) { clearTimeout(pendingTimerRef.current); pendingTimerRef.current = null; }
      const normCmd = ` ${String(rawText).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ')} `;
      const isYes = /\b(?:yes|yeah|yep|yup|confirm|confirmed|correct|sure|do it|go ahead)\b/.test(normCmd);
      const isNo = /\b(?:no|nope|nah|cancel|cancelled|never mind|forget it|dont|don't)\b/.test(normCmd);
      if (isYes) {
        window.dispatchEvent(new CustomEvent('heydoc:stopAction', { detail: { deliveryId: pending.deliveryId, action: pending.action } }));
        showChip('info', 'Working on it', pending.progressBody, pending.progressSpeech);
        return;
      }
      if (isNo) {
        showChip('off', 'Cancelled', `${pending.label} cancelled.`, `${pending.label} cancelled.`);
        return;
      }
      // Neither yes nor no — fall through and parse it as a new command.
    }

    const command = parseHeyDocCommand(rawText);
    const stop = findCurrentStop(filteredDeliveries);

    const dial = (phone, who) => {
      const num = digitsOnly(phone);
      if (!num) {
        showChip('error', 'No phone number', `No phone on file for ${who}`, `There's no phone number on file for ${who}.`);
        return;
      }
      showChip('call', 'Calling', `${who}: ${phone}`, `Calling ${who}.`);
      window.location.href = `tel:${num}`;
    };

    if (command.type === 'help') {
      const body = [
        'Name — who the stop is for',
        'Address — where to go',
        'Phone — the phone number',
        'Notes — delivery notes',
        'Call the store — dials the pickup store',
        'Call [name] — dials a person or store',
        'Optimize my route — best stop order',
        'Complete / fail / return stop — with a yes confirm',
      ].join('\n');
      showChip('info', 'Available commands', body,
        'You can ask for the name, address, phone number, or notes of your current stop. Say call the store, or call, then a name, to dial anyone. Say optimize my route to re-order your stops for the shortest drive. Say complete, fail, or return stop to work a stop — I will always ask for a yes first.');
      return;
    }

    if (command.type === 'complete_stop' || command.type === 'fail_stop' || command.type === 'return_stop') {
      if (!stop) {
        showChip('error', 'No current stop', 'You have no active stop right now.', 'You have no active stop right now.');
        return;
      }
      const action = command.type === 'complete_stop' ? 'complete' : command.type === 'fail_stop' ? 'fail' : 'return';
      const label = command.type === 'complete_stop' ? 'Complete' : command.type === 'fail_stop' ? 'Fail' : 'Return';
      const patient = (patients || []).find((p) => p?.id === stop.patient_id);
      const store = (stores || []).find((s) => s?.id === stop.store_id);
      const stopName = stop.patient_id
        ? (patient?.full_name || stop.patient_name || 'this stop')
        : (store?.name || 'this stop');
      pendingActionRef.current = {
        action,
        deliveryId: stop.id,
        label,
        progressBody: `${label}ing ${stopName}…`,
        progressSpeech: `${label.toLowerCase() === 'return' ? 'Returning' : label.toLowerCase() === 'fail' ? 'Marking failed' : 'Completing'} ${stopName}.`,
      };
      pendingTimerRef.current = setTimeout(() => { pendingActionRef.current = null; }, 15000);
      setAwaiting(true);
      showChip('info', `${label} this stop?`, `${stopName} — say yes to confirm, or no to cancel.`,
        `Do you want to ${label === 'Return' ? 'return' : label.toLowerCase()} the stop for ${stopName}? Say yes to confirm, or no to cancel.`);
      return;
    }

    if (command.type === 'optimize_route') {
      const active = (filteredDeliveries || []).filter(
        (d) => d && (d.status === 'in_transit' || d.status === 'en_route')
      );
      if (active.length === 0) {
        showChip('error', 'No active route', 'No in-transit stops to optimize. Accept your stops first.',
          'You have no active route to optimize. Accept your stops first.');
        return;
      }
      const driverId = active[0].driver_id || currentUser?.id;
      const deliveryDate = active[0].delivery_date;
      showChip('info', 'Optimizing', 'Working on the best stop order…', 'Optimizing your route. One moment.');
      let done = false;
      const cleanup = () => {
        window.removeEventListener('triggerReoptimizeRouteDone', onDone);
        clearTimeout(failTimer);
      };
      const onDone = (e) => {
        if (done) return;
        done = true;
        cleanup();
        const ok = e?.detail?.success !== false;
        if (ok) {
          showChip('info', 'Route optimized', 'Your stops are now in the best order.',
            'Route optimized. Your stops are now in the best order.');
        } else {
          showChip('error', 'Optimization failed', e?.detail?.error || 'Something went wrong. Try again in a moment.',
            'Sorry, the optimization failed. Try again in a moment.');
        }
      };
      const failTimer = setTimeout(() => onDone({ detail: { success: false, error: 'Timed out' } }), 120000);
      window.addEventListener('triggerReoptimizeRouteDone', onDone);
      window.dispatchEvent(new CustomEvent('triggerReoptimizeRoute', { detail: { driverId, deliveryDate } }));
      return;
    }

    if (command.type === 'call_store') {
      const store = (stores || []).find((s) => s?.id === stop?.store_id);
      if (!store) {
        showChip('error', 'No current stop', 'No active stop with an assigned store.', "You don't have an active stop with an assigned store.");
        return;
      }
      dial(store.phone, `store ${store.name}`);
      return;
    }

    if (command.type === 'call_name') {
      const people = (appUsers || []).filter(
        (u) => u?.phone && (u?.user_id !== currentUser?.id && u?.id !== currentUser?.id)
      );
      const match = resolveCallTarget(command.name, stores || [], people);
      if (!match) {
        showChip('error', 'Not found', `No match for "${command.name}"`, `I couldn't find anyone called ${command.name}.`);
        return;
      }
      if (match.ambiguousWith) {
        const a = match.record.user_name || match.record.name;
        const b = match.ambiguousWith.record.user_name || match.ambiguousWith.record.name;
        showChip('error', 'Multiple matches', `${a} or ${b}?`, `I found both ${a} and ${b}. Which one do you mean?`);
        return;
      }
      const who = match.kind === 'store' ? `store ${match.record.name}` : match.record.user_name;
      dial(match.record.phone, who);
      return;
    }

    if (command.type === 'info') {
      if (!stop) {
        showChip('error', 'No current stop', 'You have no active stop right now.', 'You have no active stop right now.');
        return;
      }
      const patient = (patients || []).find((p) => p?.id === stop.patient_id);
      const store = (stores || []).find((s) => s?.id === stop.store_id);
      const isPickup = !stop.patient_id;
      const stopName = isPickup ? (store?.name || 'the pickup store') : (patient?.full_name || stop.patient_name || 'the patient');
      const address = isPickup ? store?.address : patient?.address;
      const phone = isPickup ? store?.phone : (patient?.phone || patient?.phone_secondary);
      const notes = stop.delivery_notes;

      const fields = command.field === 'all' ? ['name', 'address', 'phone'] : [command.field];
      const parts = [];
      for (const f of fields) {
        if (f === 'name') parts.push(`Name: ${stopName}`);
        else if (f === 'address') parts.push(`Address: ${address || 'no address on file'}`);
        else if (f === 'phone') parts.push(`Phone: ${phone || 'no phone on file'}`);
        else if (f === 'notes') parts.push(notes ? `Notes: ${notes}` : 'No notes on this stop');
      }
      if (command.field === 'all' && notes) parts.push(`Notes: ${notes}`);

      const body = parts.filter(Boolean).join('\n');
      showChip('info', `Current stop — ${stopName}`, body, body);
      return;
    }

    if (command.type === 'none') {
      showChip('error', 'Nothing heard', 'I did not catch any speech.', "I didn't catch that.");
      return;
    }

    showChip(
      'error',
      'Not understood',
      `"${rawText}" — try "what's the address" or "call the store".`,
      "Sorry, I didn't understand that. Say what can I say for a list of commands."
    );
  }, [filteredDeliveries, patients, stores, appUsers, currentUser, showChip, setAwaiting]);

  const runCommandDebounced = useCallback((sessionFinalGetter, resetter) => {
    if (cmdDebounceRef.current) clearTimeout(cmdDebounceRef.current);
    cmdDebounceRef.current = setTimeout(() => {
      cmdDebounceRef.current = null;
      const full = String(sessionFinalGetter() || '').trim();
      resetter?.();
      if (full) {
        setAwaiting(false);
        handleCommand(full);
      }
    }, 900);
  }, [handleCommand, setAwaiting]);

  const startWakeSession = useCallback(() => {
    if (!armedRef.current || recognitionRef.current) return;
    let sessionFinal = '';

    const recognition = new SR();
    recognition.lang = 'en-CA';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) sessionFinal += ` ${result[0].transcript}`;
        else interim += ` ${result[0].transcript}`;
      }

      const norm = (s) => ` ${String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ')} `;
      const finalNorm = norm(sessionFinal);
      const interimNorm = norm(interim);

      if (awaitingRef.current) {
        let gotFinal = false;
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) gotFinal = true;
        }
        if (gotFinal && sessionFinal.trim()) {
          // More finals may follow ("what" … "can I say") — debounce,
          // then execute the full accumulated sentence at once.
          runCommandDebounced(() => sessionFinal, () => { sessionFinal = ''; });
        } else if (interimNorm.trim()) {
          setChip({ icon: 'listening', title: 'Listening…', body: interim.trim() });
        }
        return;
      }

      const wakeInFinal = findWake(finalNorm);
      const wakeInInterim = findWake(interimNorm);
      if (wakeInFinal) {
        const after = finalNorm.slice(finalNorm.lastIndexOf(wakeInFinal[0]) + wakeInFinal[0].length).trim();
        const before = finalNorm.slice(0, finalNorm.indexOf(wakeInFinal[0]));
        if (before.split(' ').filter(Boolean).length > 6) {
          sessionFinal = '';
          return;
        }
        chime();
        // Enter command-collect mode either way. If words followed the wake
        // word in the same breath, seed them and start the debounce; the rest
        // of the sentence arrives as further finals and joins the same run.
        sessionFinal = after.length > 1 ? ` ${after}` : '';
        setAwaiting(true);
        setChip({ icon: 'listening', title: 'Yes?', body: 'Listening for your command…' });
        if (after.length > 1) {
          runCommandDebounced(() => sessionFinal, () => { sessionFinal = ''; });
        }
        return;
      }
      if (wakeInInterim && !wakeHeardRef.current) {
        wakeHeardRef.current = true;
        chime();
      }
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      if (armedRef.current && document.visibilityState === 'visible') {
        restartTimerRef.current = setTimeout(() => {
          if (armedRef.current && document.visibilityState === 'visible') startWakeSession();
        }, 300);
      }
    };

    recognition.onerror = (event) => {
      const err = event?.error;
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        armedRef.current = false;
        setArmed(false);
        showChip('error', 'Microphone blocked', micBlockedMessage(), micBlockedSpeech());
      } else if (err === 'no-speech' || err === 'network' || err === 'aborted') {
        // handled by onend restart
      } else {
        console.warn('[HeyDoc] recognition error:', err);
      }
    };

    recognitionRef.current = recognition;
    try { recognition.start(); } catch {}
  }, [SR, handleCommand, setAwaiting, showChip, runCommandDebounced]);

  const arm = useCallback(() => {
    armedRef.current = true;
    setArmed(true);
    startWakeSession();
  }, [startWakeSession]);

  const disarm = useCallback(() => {
    armedRef.current = false;
    setArmed(false);
    stopRecognition();
  }, [stopRecognition]);

  // Explicit mic-permission request baked into the toggle tap.
  // getUserMedia from a user gesture triggers the real permission
  // dialog (Chrome/Android PWA + APK WebView). We release the stream
  // immediately — only the grant matters.
  const ensureMicPermission = useCallback(async () => {
    try {
      if (navigator.permissions?.query) {
        try {
          const status = await navigator.permissions.query({ name: 'microphone' });
          if (status.state === 'granted') return true;
        } catch {}
      }
    } catch {}
    try {
      if (!navigator.mediaDevices?.getUserMedia) return true; // older engine — let SpeechRecognition prompt itself
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      return true;
    } catch (err) {
      console.warn('[HeyDoc] mic permission denied:', err?.name, err?.message);
      return false;
    }
  }, []);

  const toggle = useCallback(async () => {
    try { window.speechSynthesis?.cancel?.(); } catch {}
    if (armedRef.current) {
      disarm();
      showChip('off', 'Hey Doc off', 'Voice commands disabled.', 'Hey Doc is off.');
      return;
    }
    const granted = await ensureMicPermission();
    if (!granted) {
      showChip(
        'error',
        'Microphone blocked',
        micBlockedMessage(),
        micBlockedSpeech()
      );
      return;
    }
    arm();
    showChip('on', 'Hey Doc on', 'Say "Hey Doc", then your command.', "Hey Doc is listening. Say Hey Doc, then your command.");
  }, [arm, disarm, showChip, ensureMicPermission]);

  // Restore persisted armed state — deferred until first user gesture
  // (mic permission/autoplay rules on iOS/Chrome).
  useEffect(() => {
    if (!canUse) return;
    let stored = null;
    try { stored = localStorage.getItem(armedStorageKey(currentUser?.id)); } catch {}
    if (stored === 'true') {
      const onFirstGesture = () => {
        window.removeEventListener('touchend', onFirstGesture);
        window.removeEventListener('click', onFirstGesture);
        if (!armedRef.current && localStorage.getItem(armedStorageKey(currentUser?.id)) === 'true') {
          arm();
        }
      };
      window.addEventListener('touchend', onFirstGesture, { once: false });
      window.addEventListener('click', onFirstGesture, { once: false });
      return () => {
        window.removeEventListener('touchend', onFirstGesture);
        window.removeEventListener('click', onFirstGesture);
      };
    }
  }, [canUse, currentUser?.id, arm]);

  useEffect(() => {
    if (!canUse) return;
    try { localStorage.setItem(armedStorageKey(currentUser?.id), armed ? 'true' : 'false'); } catch {}
  }, [armed, canUse, currentUser?.id]);

  useEffect(() => {
    if (!canUse) return;
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        try { recognitionRef.current?.abort?.(); } catch {}
      } else if (armedRef.current && !recognitionRef.current) {
        restartTimerRef.current = setTimeout(() => { if (armedRef.current) startWakeSession(); }, 400);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [canUse, startWakeSession]);

  useEffect(() => () => {
    armedRef.current = false;
    stopRecognition();
    if (chipTimerRef.current) clearTimeout(chipTimerRef.current);
    try { window.speechSynthesis?.cancel?.(); } catch {}
  }, [stopRecognition]);

  const dismissChip = useCallback(() => setChip(null), []);

  return { available: canUse, armed, awaitingCommand, chip, toggle, dismissChip };
}
