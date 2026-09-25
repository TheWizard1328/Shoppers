/**
 * Hey Doc response overlay — the chip (answers) and "Yes? listening"
 * banner. No mic button here; the toggle lives in the stats panel
 * (HeyDocToggleButton.jsx). Positioned above the bulk-select /
 * API-counter row so it never overlaps them.
 */
import React from 'react';
import { Mic, MicOff, Phone, Info, Volume2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

export default function HeyDocOverlay({
  chip,
  awaitingCommand,
  onDismiss,
  cardsReadyForFAB,
  stopCardsBaseHeight,
  hasVisibleCards,
  immersiveHidden,
  fabPosition = 'absolute',
}) {
  if (immersiveHidden) return null;
  if (!chip && !awaitingCommand) return null;

  const bottomPixels = (hasVisibleCards && cardsReadyForFAB ? stopCardsBaseHeight : 0) + 10;

  const chipIcon = chip?.icon === 'call' ? <Phone className="w-4 h-4" />
    : chip?.icon === 'info' ? <Info className="w-4 h-4" />
    : chip?.icon === 'listening' ? <Mic className="w-4 h-4 animate-pulse" />
    : chip?.icon === 'on' ? <Volume2 className="w-4 h-4" />
    : chip?.icon === 'off' || chip?.icon === 'error' ? <MicOff className="w-4 h-4" />
    : null;

  return (
    <>
      <AnimatePresence>
        {chip && !awaitingCommand && (
          <motion.div
            key="heydoc-chip"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="fixed left-4 right-4 z-[10090] mx-auto max-w-sm rounded-xl border border-slate-200 bg-white/95 p-3 shadow-xl backdrop-blur dark:border-slate-700 dark:bg-slate-800/95"
            style={{ position: fabPosition === 'absolute' ? 'fixed' : fabPosition, bottom: `${bottomPixels + 12}px`, pointerEvents: 'auto' }}
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
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="fixed left-4 right-4 z-[10090] mx-auto max-w-sm rounded-xl border border-red-300 bg-red-50/95 p-3 shadow-xl backdrop-blur dark:border-red-700 dark:bg-red-950/90"
            style={{ position: fabPosition === 'absolute' ? 'fixed' : fabPosition, bottom: `${bottomPixels + 12}px`, pointerEvents: 'auto' }}
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
    </>
  );
}
