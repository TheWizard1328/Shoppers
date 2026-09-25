/**
 * Hey Doc — driver voice assistant with OK-Google-style wake word.
 *
 * Tap the mic once to arm hands-free listening. While armed, the mic
 * listens continuously for "Hey Doc" (plus common mishearings: dock,
 * dog, doctor, talk). On wake it chimes, then the driver's next phrase
 * is the command:
 *   - "what's the name / address / phone / notes?" (current stop)
 *   - "call the store" (current stop's pickup store)
 *   - "call <any store, driver or admin name>"
 * Answers are spoken back (speechSynthesis) and shown as text.
 *
 * Behavior notes:
 *   - Continuous recognition sessions auto-restart (Android Chrome
 *     ends sessions every few seconds) while armed and the app is
 *     visible; suspended when backgrounded, resumed on focus.
 *   - Armed state persists per driver (localStorage).
 *   - Uses browser SpeechRecognition (PWA). The Android APK WebView
 *     needs a native mic layer — a later phase.
 *
 * Phase 2: "optimize my route". Phase 3: confirm-gated
 * complete/fail/return actions.
 */
import React, { useState, useRef, useCallback, useEffect, memo } from 'react';
import { Mic, MicOff, Phone, Info, Volume2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { parseHeyDocCommand, resolveCallTarget } from './heyDocParser';

const getSpeechRecognition = () =>
  typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

const digitsOnly = (v) => String(v || '').replace(/\D/g, '');

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

const WAKE_PATTERNS = [
  /\b(?:hey|hay|okay|ok)\s+(?:doc|dock|dog|doctor|dot|talk)\b/,
  /\ba\s+(?:doc|dock|dog)\b/,
];

const WAKE_SPLIT = /\b(?:hey|hay|okay|ok)?\s*(?:doc|dock|dog|doctor|dot|talk)\b/;

const findWake = (normText) => {
  for (const re of WAKE_PATTERNS) {
    const m = normText.match(re);
    if (m) return m;
  }
  return null;
};

const armedStorageKey = (userId) => `heydoc_armed_${userId || 'default'}`;

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

// Short confirmation beep (Web Audio — quick feedback the wake word
// was heard, without our own TTS being captured back as a command).
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

function HeyDoc({
  currentUser,
  filteredDeliveries,
  patients,
  stores,
  appUsers,
  isDriver,
  isMobile,
  immersiveHidden,
  hideForExpandedCard,
  cardsReadyForFAB,
  stopCardsBaseHeight,
  fabPosition = 'absolute',
}) {
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

  const SR = getSpeechRecognition();
  const enabled = !!(SR && isDriver && isMobile && currentUser);

  // ── Chip helpers ────────────────────────────────────────────
  const showChip = useCallback((icon, title, body, speakText) => {
    if (chipTimerRef.current) clearTimeout(chipTimerRef.current);
    setChip({ icon, title, body });
    if (speakText) speak(speakText);
    chipTimerRef.current = setTimeout(() => setChip(null), 12000);
  }, []);

  const clearTimers = () => {
    if (restartTimerRef.current) { clearTimeout(restartTimerRef.current); restartTimerRef.current = null; }
    if (awaitTimeoutRef.current) { clearTimeout(awaitTimeoutRef.current); awaitTimeoutRef.current = null; }
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
      "Sorry, I didn't understand that. You can ask for the name, address, phone or notes, or say call."
    );
  }, [filteredDeliveries, patients, stores, appUsers, currentUser, showChip]);

  // ── Continuous wake-word listening loop ─────────────────────
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
        // Driver already said "Hey Doc" — this utterance is the command
        if (sessionFinal.trim()) {
          setAwaiting(false);
          handleCommand(sessionFinal.trim());
          sessionFinal = '';
        } else if (interimNorm.trim()) {
          setChip({ icon: 'listening', title: 'Listening…', body: interim.trim() });
        }
        return;
      }

      // Wake-word scanning
      const wakeInFinal = findWake(finalNorm);
      const wakeInInterim = findWake(interimNorm);
      if (wakeInFinal) {
        const after = finalNorm.slice(finalNorm.lastIndexOf(wakeInFinal[0]) + wakeInFinal[0].length).trim();
        const before = finalNorm.slice(0, finalNorm.indexOf(wakeInFinal[0]));
        if (before.split(' ').filter(Boolean).length > 6) {
          // Wake phrase heard mid-sentence — likely conversation, ignore
          sessionFinal = '';
          return;
        }
        chime();
        if (after.length > 1) {
          handleCommand(after);
          sessionFinal = '';
        } else {
          setAwaiting(true);
          setChip({ icon: 'listening', title: 'Yes?', body: 'Listening for your command…' });
        }
        return;
      }
      if (wakeInInterim && !wakeHeardRef.current) {
        wakeHeardRef.current = true; // chime early, avoid double-fire when final arrives
        chime();
      }
    };

    recognition.onend = () => {
      // Sessions end often (silence, engine limits) — restart while armed
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
        showChip('error', 'Mic blocked', 'Allow microphone access for Hey Doc.', 'Microphone access is blocked. Allow the microphone to use Hey Doc.');
      } else if (err === 'no-speech' || err === 'network' || err === 'aborted') {
        // handled by onend restart
      } else {
        console.warn('[HeyDoc] recognition error:', err);
      }
    };

    recognitionRef.current = recognition;
    try { recognition.start(); } catch {}
  }, [SR, handleCommand, setAwaiting, showChip]);

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

  const toggle = useCallback(() => {
    try { window.speechSynthesis?.cancel?.(); } catch {}
    if (armedRef.current) {
      disarm();
      showChip('off', 'Hey Doc off', 'Voice commands disabled.', 'Hey Doc is off.');
    } else {
      arm();
      showChip('on', 'Hey Doc on', 'Say "Hey Doc", then your command.', "Hey Doc is listening. Say Hey Doc, then your command.");
    }
  }, [arm, disarm, showChip]);

  // Restore persisted armed state (requires a user gesture first on
  // many platforms, so we only restore the toggle visually and arm
  // on the next tap if permission was never granted... simpler: if
  // the key is set, arm immediately — permission persists per
  // origin once granted).
  useEffect(() => {
    if (!enabled) return;
    let stored = null;
    try { stored = localStorage.getItem(armedStorageKey(currentUser?.id)); } catch {}
    if (stored === 'true') {
      // Defer until first user interaction to satisfy autoplay/mic
      // gesture rules on iOS/Chrome
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
  }, [enabled, currentUser?.id, arm]);

  // Persist armed state
  useEffect(() => {
    if (!enabled) return;
    try { localStorage.setItem(armedStorageKey(currentUser?.id), armed ? 'true' : 'false'); } catch {}
  }, [armed, enabled, currentUser?.id]);

  // Suspend when backgrounded, resume when visible (Android suspends
  // the mic anyway — mirrors the GPS tracker pattern)
  useEffect(() => {
    if (!enabled) return;
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        try { recognitionRef.current?.abort?.(); } catch {}
      } else if (armedRef.current && !recognitionRef.current) {
        restartTimerRef.current = setTimeout(() => { if (armedRef.current) startWakeSession(); }, 400);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [enabled, startWakeSession]);

  // Cleanup on unmount
  useEffect(() => () => {
    armedRef.current = false;
    stopRecognition();
    if (chipTimerRef.current) clearTimeout(chipTimerRef.current);
    try { window.speechSynthesis?.cancel?.(); } catch {}
  }, [stopRecognition]);

  if (!enabled) return null;
  if (immersiveHidden || hideForExpandedCard) return null;

  // Positioned one row ABOVE the bulk-select checkbox / API counter
  // row (that row sits at stopCardsBaseHeight + 10, left side)
  const bottomPixels = (filteredDeliveries?.length > 0 && cardsReadyForFAB ? stopCardsBaseHeight : 0) + 10 + 48;

  const chipIcon = chip?.icon === 'call' ? <Phone className="w-4 h-4" />
    : chip?.icon === 'info' ? <Info className="w-4 h-4" />
    : chip?.icon === 'listening' ? <Mic className="w-4 h-4 animate-pulse" />
    : chip?.icon === 'on' ? <Volume2 className="w-4 h-4" />
    : chip?.icon === 'off' || chip?.icon === 'error' ? <MicOff className="w-4 h-4" />
    : null;

  return (
    <>
      {/* Response / status chip */}
      <AnimatePresence>
        {chip && !awaitingCommand && (
          <motion.div
            key="heydoc-chip"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="fixed left-4 right-4 z-[10090] mx-auto max-w-sm rounded-xl border border-slate-200 bg-white/95 p-3 shadow-xl backdrop-blur dark:border-slate-700 dark:bg-slate-800/95"
            style={{ bottom: `${bottomPixels + 52}px`, pointerEvents: 'auto' }}
          >
            <div className="flex items-start gap-2">
              <div className="mt-0.5 shrink-0 text-slate-600 dark:text-slate-300">{chipIcon}</div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{chip.title}</p>
                <p className="whitespace-pre-line text-sm text-slate-800 dark:text-slate-100">{chip.body}</p>
              </div>
              <button
                type="button"
                onClick={() => setChip(null)}
                className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
                aria-label="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Awaiting command banner */}
      <AnimatePresence>
        {awaitingCommand && (
          <motion.div
            key="heydoc-awaiting"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="fixed left-4 right-4 z-[10090] mx-auto max-w-sm rounded-xl border border-red-300 bg-red-50/95 p-3 shadow-xl backdrop-blur dark:border-red-700 dark:bg-red-950/90"
            style={{ bottom: `${bottomPixels + 52}px`, pointerEvents: 'auto' }}
          >
            <div className="flex items-start gap-2">
              <div className="mt-0.5 shrink-0 animate-pulse text-red-600 dark:text-red-400"><Mic className="w-4 h-4" /></div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">Yes? — listening…</p>
                <p className="whitespace-pre-line text-sm text-red-900 dark:text-red-100">{chip?.body || 'Say your command…'}</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mic FAB */}
      <motion.div
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 260, damping: 20 }}
        className="z-[100]"
        style={{ position: fabPosition, bottom: `${bottomPixels}px`, left: '16px', pointerEvents: 'auto' }}
      >
        <button
          type="button"
          onClick={toggle}
          title={armed ? 'Hey Doc is listening — tap to turn off' : 'Hey Doc — tap to start hands-free listening'}
          aria-label="Hey Doc voice assistant"
          className={`inline-flex h-10 w-10 items-center justify-center rounded-full shadow-md transition-colors ${
            armed
              ? 'bg-red-500 text-white'
              : 'bg-emerald-100 text-emerald-600 hover:bg-emerald-200 dark:bg-emerald-900/60 dark:text-emerald-300'
          }`}
          style={{ touchAction: 'manipulation' }}
        >
          {armed ? <Mic className="w-5 h-5 animate-pulse" /> : <Mic className="w-5 h-5" />}
        </button>
      </motion.div>
    </>
  );
}

export default memo(HeyDoc);
