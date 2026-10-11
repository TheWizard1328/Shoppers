/**
 * Hey Doc response overlay — the chip (answers) and "Listening" banner.
 *
 * ANCHORING: rendered via createPortal to document.body and pinned to the
 * actual mic toggle button ([data-heydoc-toggle]), NOT the stats-card panel —
 * the balloons open downward from the mic itself and stay visually attached
 * to it no matter which card is expanded or how far the panel scrolled.
 * Animates open with a top-origin scale/expand so it reads as "coming from
 * the mic". If the mic button isn't in the DOM (edge case), falls back to a
 * bottom-centered fixed placement.
 *
 * COLOR: active listening is GREEN (matches the armed mic toggle). Red is
 * reserved for off/error states.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mic, MicOff, Phone, Info, Volume2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

const MIRRORING_MS = 400; // keep the measured position fresh on scroll/resize

function useAnchorRect(active, anchorSelector) {
  const [rect, setRect] = useState(null);

  const measure = useCallback(() => {
    const anchor = document.querySelector(anchorSelector);
    if (!anchor || !anchor.getBoundingClientRect) { setRect(null); return; }
    const r = anchor.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) { setRect(null); return; }
    setRect({ top: r.top, bottom: r.bottom, left: r.left, width: r.width });
  }, [anchorSelector]);

  useEffect(() => {
    if (!active) return undefined;
    measure();
    const onMove = () => measure();
    window.addEventListener('scroll', onMove, true); // capture: any panel scroll
    window.addEventListener('resize', onMove);
    const poll = setInterval(onMove, MIRRORING_MS); // cheap safety for layout shifts
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      clearInterval(poll);
    };
  }, [active, measure]);

  return rect;
}

export default function HeyDocOverlay({
  chip,
  awaitingCommand,
  onDismiss,
  immersiveHidden,
}) {
  const visible = !immersiveHidden && !!(chip || awaitingCommand);
  const rect = useAnchorRect(visible, '[data-heydoc-toggle]');

  if (immersiveHidden) return null;
  if (!chip && !awaitingCommand) return null;

  // Balloon placement: below the mic button, left-aligned to it, clamped to
  // the viewport. Falls back to bottom-center fixed when no anchor.
  const maxWidth = 384; // max-w-sm
  const anchorStyle = rect
    ? (() => {
        const vw = window.innerWidth || 375;
        const left = Math.max(12, Math.min(rect.left, vw - maxWidth - 12));
        return {
          position: 'fixed',
          top: `${Math.round(rect.bottom + 10)}px`,
          left: `${Math.round(left)}px`,
          width: `${Math.min(maxWidth, vw - 24)}px`,
        };
      })()
    : { position: 'fixed', left: '12px', right: '12px', bottom: '16px' };

  const chipIcon = chip?.icon === 'call' ? <Phone className="w-4 h-4" />
    : chip?.icon === 'info' ? <Info className="w-4 h-4" />
    : chip?.icon === 'listening' ? <Mic className="w-4 h-4 animate-pulse" />
    : chip?.icon === 'on' ? <Volume2 className="w-4 h-4" />
    : chip?.icon === 'off' || chip?.icon === 'error' ? <MicOff className="w-4 h-4" />
    : null;

  return createPortal(
    <>
      <AnimatePresence>
        {chip && !awaitingCommand && (
          <motion.div
            key="heydoc-chip"
            initial={{ opacity: 0, y: -10, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            style={{ ...anchorStyle, transformOrigin: 'top left', pointerEvents: 'auto' }}
            className="z-[10090] mx-auto max-w-sm rounded-xl border border-slate-200 bg-white/95 p-3 shadow-xl backdrop-blur dark:border-slate-700 dark:bg-slate-800/95"
          >
            <div className="flex items-start gap-2">
              <div className="mt-0.5 shrink-0 text-slate-600 dark:text-slate-300">{chipIcon}</div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{chip.title}</p>
                <p className="whitespace-pre-line text-sm text-slate-800 dark:text-slate-100">{chip.body}</p>
              </div>
              <button
                type="button"
                onClick={onDismiss}
                className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
                aria-label="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {awaitingCommand && (
          <motion.div
            key="heydoc-awaiting"
            initial={{ opacity: 0, y: -10, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            style={{ ...anchorStyle, transformOrigin: 'top left', pointerEvents: 'auto' }}
            // GREEN = active listening (matches the armed mic). Red stays
            // reserved for off/error.
            className="z-[10090] mx-auto max-w-sm rounded-xl border border-emerald-300 bg-emerald-50/95 p-3 shadow-xl backdrop-blur dark:border-emerald-700 dark:bg-emerald-950/90"
          >
            <div className="flex items-start gap-2">
              <div className="mt-0.5 shrink-0 animate-pulse text-emerald-600 dark:text-emerald-400"><Mic className="w-4 h-4" /></div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">Listening…</p>
                <p className="whitespace-pre-line text-sm text-emerald-900 dark:text-emerald-100">{chip?.body || 'Say your command…'}</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>,
    document.body
  );
}
