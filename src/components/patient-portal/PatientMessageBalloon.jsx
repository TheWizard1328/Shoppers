import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, MessageSquare } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

/**
 * PatientMessageBalloon — the patient-portal twin of the staff
 * MessageNotificationBalloon (owner request Nov 25 2026).
 *
 * When an in-app message lands while the patient is looking at the portal, the
 * same kind of panel pops up: who sent it, a one-line preview, and a tap to open
 * the messaging sheet on that thread.
 *
 * PLACEMENT + FIRST LOAD (owner request Nov 25 2026): "for wider screen devices
 * let's have it show up just below the right top corner of the screen just below
 * the patient header bar... but on narrower mobile devices will just have it pop
 * down center of the screen just below the header. And as soon as the app loads
 * for a patient... if there's any unread messages this box shows up with their
 * most recent message or messages." So the stack is right-aligned on md+ and
 * centred on phones, always measured BELOW the real header height, and it holds
 * several boxes (newest first) when more than one message is unread.
 */
const AUTO_DISMISS_MS = 15000;
const MAX_BOXES = 3;

const senderLabel = (message) => {
  if (!message) return 'New message';
  if (message.sender_name) return message.sender_name;
  if (message.driver_name) return message.driver_name;
  if (message.store_name) return message.store_name;
  return message.driver_id ? 'Your driver' : 'Pharmacy team';
};

/** Header bottom, so no box ever covers the "My Deliveries" bar. */
const useHeaderTop = (dep) => {
  const [top, setTop] = useState(null);
  useEffect(() => {
    const measure = () => {
      const header = document.querySelector('[data-patient-header]');
      const bottom = header ? header.getBoundingClientRect().bottom : 0;
      setTop(Math.round((bottom > 0 ? bottom : 0) + 8));
    };
    measure();
    const timer = setTimeout(measure, 120); // after the first paint settles
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, [dep]);
  return top;
};

function BalloonBox({ message, onOpen, onDismiss }) {
  const timerRef = useRef(null);
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { onDismiss?.(message); }, AUTO_DISMISS_MS);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [message?.id, onDismiss]);

  const preview = String(message?.content || '').replace(/\s+/g, ' ').trim().slice(0, 120);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -12, scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 320, damping: 28 }}>
      <button
        type="button"
        onClick={() => onOpen?.(message)}
        className="w-full text-left rounded-xl border border-blue-200 bg-white shadow-xl px-3 py-2.5 flex items-start gap-2.5 active:scale-[0.99] transition-transform">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-500 text-white">
          <MessageSquare className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-slate-800">
              {senderLabel(message)}
            </span>
            <span className="shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-blue-700">
              New
            </span>
          </span>
          <span className="mt-0.5 block truncate text-[12px] leading-snug text-slate-600">
            {preview || 'Sent you a message'}
          </span>
          <span className="mt-1 block text-[10px] font-medium text-blue-600">Tap to open</span>
        </span>
        <span
          role="button"
          tabIndex={0}
          aria-label="Dismiss"
          onClick={(e) => { e.stopPropagation(); onDismiss?.(message); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onDismiss?.(message); } }}
          className="mt-0.5 shrink-0 rounded p-1 text-slate-400 hover:text-slate-600">
          <X className="h-4 w-4" />
        </span>
      </button>
    </motion.div>
  );
}

export default function PatientMessageBalloon({ messages = [], message = null, onOpen, onDismiss }) {
  const list = useMemo(() => {
    const arr = Array.isArray(messages) ? messages : (message ? [message] : []);
    const seen = new Set();
    return arr.filter((m) => m?.id && !seen.has(m.id) && seen.add(m.id)).slice(0, MAX_BOXES);
  }, [messages, message]);
  const top = useHeaderTop(list.length);
  const hasItems = list.length > 0;

  return (
    <div
      aria-live="polite"
      className={`fixed z-[2147482000] left-3 right-3 mx-auto max-w-md md:left-auto md:right-4 md:mx-0 md:w-[380px] md:max-w-[380px] ${hasItems ? 'pointer-events-none' : 'hidden'}`}
      style={{ top: top != null ? `${top}px` : 'calc(env(safe-area-inset-top, 0px) + 12px)' }}>
      <div className="flex flex-col gap-2 pointer-events-auto">
        <AnimatePresence initial={false}>
          {list.map((m) => (
            <BalloonBox key={m.id} message={m} onOpen={onOpen} onDismiss={onDismiss} />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
