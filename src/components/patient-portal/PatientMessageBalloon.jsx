import React, { useEffect, useRef } from 'react';
import { X, MessageSquare } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

/**
 * PatientMessageBalloon — the patient-portal twin of the staff
 * MessageNotificationBalloon (owner request Nov 25 2026).
 *
 * When a new in-app message lands while the patient is looking at the portal,
 * the same kind of panel pops up: who sent it, a one-line preview, and a tap to
 * open the messaging sheet on that thread. It auto-dismisses so it never sits on
 * top of the map, and an explicit dismiss remembers that message id so the
 * 4-second live sync cannot re-show the same one.
 */
const AUTO_DISMISS_MS = 15000;

const senderLabel = (message) => {
  if (!message) return 'New message';
  if (message.sender_name) return message.sender_name;
  if (message.driver_name) return message.driver_name;
  if (message.store_name) return message.store_name;
  return message.driver_id ? 'Your driver' : 'Pharmacy team';
};

export default function PatientMessageBalloon({ message, onOpen, onDismiss }) {
  const timerRef = useRef(null);

  useEffect(() => {
    if (!message?.id) return undefined;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { onDismiss?.(); }, AUTO_DISMISS_MS);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [message?.id, onDismiss]);

  const preview = String(message?.content || '').replace(/\s+/g, ' ').trim().slice(0, 120);

  return (
    <AnimatePresence>
      {message?.id && (
        <motion.div
          key={message.id}
          initial={{ opacity: 0, y: -16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -12, scale: 0.98 }}
          transition={{ type: 'spring', stiffness: 320, damping: 28 }}
          className="fixed left-3 right-3 z-[2147482000] mx-auto max-w-md"
          style={{ top: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}>
          <button
            type="button"
            onClick={onOpen}
            className="w-full text-left rounded-xl border border-blue-200 bg-white shadow-xl px-3 py-2.5 flex items-start gap-2.5 active:scale-[0.99] transition-transform"
          >
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
              onClick={(e) => { e.stopPropagation(); onDismiss?.(); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onDismiss?.(); } }}
              className="mt-0.5 shrink-0 rounded p-1 text-slate-400 hover:text-slate-600"
            >
              <X className="h-4 w-4" />
            </span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
