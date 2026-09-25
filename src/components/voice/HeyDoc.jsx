/**
 * Hey Doc — driver voice assistant, Phase 1 (stop info + calls).
 *
 * A floating mic FAB on the driver dashboard. Tap, ask a question:
 *   - "What's the name / address / phone / notes?" (current stop)
 *   - "Call the store" (current stop's pickup store)
 *   - "Call <any store, driver or admin name>"
 * Answers are spoken back (speechSynthesis) and shown as text.
 *
 * Uses the browser's built-in SpeechRecognition (Chrome/Safari PWAs).
 * The Android APK WebView needs a native mic layer — a later phase.
 *
 * Phase 2: "optimize my route". Phase 3: wake word + confirm-gated
 * complete/fail/return actions.
 */
import React, { useState, useRef, useCallback, useEffect, memo } from 'react';
import { Mic, MicOff, Phone, Info, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { parseHeyDocCommand, resolveCallTarget } from './heyDocParser';

const getSpeechRecognition = () =>
  typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

const digitsOnly = (v) => String(v || '').replace(/\D/g, '');

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'returned'];

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

/**
 * The driver's current stop: isNextDelivery first, else the lowest
 * stop_order among non-terminal en_route/in_transit stops.
 */
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

const FIELD_LABELS = { name: 'Name', address: 'Address', phone: 'Phone', notes: 'Notes' };

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
  const [isListening, setIsListening] = useState(false);
  const [chip, setChip] = useState(null); // { icon, title, body }
  const recognitionRef = useRef(null);
  const chipTimerRef = useRef(null);

  const SR = getSpeechRecognition();
  const enabled = !!(SR && isDriver && isMobile && currentUser);

  const showChip = useCallback((icon, title, body, speakText) => {
    if (chipTimerRef.current) clearTimeout(chipTimerRef.current);
    setChip({ icon, title, body });
    if (speakText) speak(speakText);
    chipTimerRef.current = setTimeout(() => setChip(null), 12000);
  }, []);

  useEffect(() => () => {
    if (chipTimerRef.current) clearTimeout(chipTimerRef.current);
    try { recognitionRef.current?.abort?.(); } catch {}
    try { window.speechSynthesis?.cancel?.(); } catch {}
  }, []);

  const dial = useCallback((phone, who) => {
    const num = digitsOnly(phone);
    if (!num) {
      showChip('error', 'No phone number', `No phone on file for ${who}`, `There's no phone number on file for ${who}.`);
      return;
    }
    showChip('call', 'Calling', `${who}: ${phone}`, `Calling ${who}.`);
    window.location.href = `tel:${num}`;
  }, [showChip]);

  const handleCommand = useCallback((rawText) => {
    const command = parseHeyDocCommand(rawText);
    const stop = findCurrentStop(filteredDeliveries);

    // ── Calls ─────────────────────────────────────────────────
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

    // ── Stop info ─────────────────────────────────────────────
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

      const fields = command.field === 'all'
        ? ['name', 'address', 'phone']
        : [command.field];

      const parts = [];
      for (const f of fields) {
        if (f === 'name') parts.push(`Name: ${stopName}`);
        else if (f === 'address') parts.push(`Address: ${address || 'no address on file'}`);
        else if (f === 'phone') parts.push(`Phone: ${phone || 'no phone on file'}`);
        else if (f === 'notes') parts.push(notes ? `Notes: ${notes}` : 'No notes on this stop');
      }
      if (command.field === 'all') parts.push(notes ? `Notes: ${notes}` : '');

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
  }, [filteredDeliveries, patients, stores, appUsers, currentUser, dial, showChip]);

  const startListening = useCallback(() => {
    if (isListening) {
      try { recognitionRef.current?.stop?.(); } catch {}
      return;
    }
    try { window.speechSynthesis?.cancel?.(); } catch {}

    const recognition = new SR();
    recognition.lang = 'en-CA';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;

    let finalText = '';
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (interim) setChip((c) => ({ icon: 'listening', title: 'Listening…', body: interim }));
    };
    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
      if (finalText.trim()) {
        handleCommand(finalText.trim());
      } else if (!chip) {
        setChip(null);
      }
    };
    recognition.onerror = (event) => {
      setIsListening(false);
      recognitionRef.current = null;
      const err = event?.error;
      if (err === 'no-speech') showChip('error', 'Nothing heard', 'No speech detected — tap and try again.', "I didn't hear anything. Tap the mic and try again.");
      else if (err === 'not-allowed' || err === 'service-not-allowed') showChip('error', 'Mic blocked', 'Allow microphone access for voice commands.', 'Microphone access is blocked. Allow the microphone to use voice commands.');
      else if (err !== 'aborted') console.warn('[HeyDoc] recognition error:', err);
    };

    recognitionRef.current = recognition;
    finalText = '';
    setIsListening(true);
    setChip({ icon: 'listening', title: 'Listening…', body: 'Ask about the stop or say call…' });
    recognition.start();
  }, [SR, isListening, handleCommand, showChip, chip]);

  if (!enabled) return null;
  if (immersiveHidden || hideForExpandedCard) return null;

  const bottomPixels = (filteredDeliveries?.length > 0 && cardsReadyForFAB ? stopCardsBaseHeight : 0) + 10;

  const chipIcon = chip?.icon === 'call' ? <Phone className="w-4 h-4" />
    : chip?.icon === 'info' ? <Info className="w-4 h-4" />
    : chip?.icon === 'listening' ? <Mic className="w-4 h-4 animate-pulse" />
    : chip?.icon === 'error' ? <MicOff className="w-4 h-4" />
    : null;

  return (
    <>
      {/* Response / transcript chip */}
      <AnimatePresence>
        {chip && !isListening && (
          <motion.div
            key="heydoc-chip"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="fixed left-4 right-4 z-[10090] mx-auto max-w-sm rounded-xl border border-slate-200 bg-white/95 p-3 shadow-xl backdrop-blur dark:border-slate-700 dark:bg-slate-800/95"
            style={{ bottom: `${bottomPixels + 64}px`, pointerEvents: 'auto' }}
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

      {/* Listening banner */}
      <AnimatePresence>
        {isListening && (
          <motion.div
            key="heydoc-listening"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="fixed left-4 right-4 z-[10090] mx-auto max-w-sm rounded-xl border border-red-300 bg-red-50/95 p-3 shadow-xl backdrop-blur dark:border-red-700 dark:bg-red-950/90"
            style={{ bottom: `${bottomPixels + 64}px`, pointerEvents: 'auto' }}
          >
            <div className="flex items-start gap-2">
              <div className="mt-0.5 shrink-0 animate-pulse text-red-600 dark:text-red-400"><Mic className="w-4 h-4" /></div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">Listening…</p>
                <p className="whitespace-pre-line text-sm text-red-900 dark:text-red-100">{chip?.body || 'Ask about the stop or say call…'}</p>
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
          onClick={startListening}
          title="Hey Doc — voice assistant"
          aria-label="Hey Doc voice assistant"
          className={`inline-flex h-10 w-10 items-center justify-center rounded-full shadow-md transition-colors ${
            isListening
              ? 'bg-red-500 text-white'
              : 'bg-emerald-100 text-emerald-600 hover:bg-emerald-200 dark:bg-emerald-900/60 dark:text-emerald-300'
          }`}
          style={{ touchAction: 'manipulation' }}
        >
          {isListening ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
        </button>
      </motion.div>
    </>
  );
}

export default memo(HeyDoc);
