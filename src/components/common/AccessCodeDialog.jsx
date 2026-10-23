import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Lock, Home } from 'lucide-react';

/**
 * AccessCodeDialog (owner spec, Oct 23 2026)
 *
 * Pops automatically on the driver's primary device the moment they arrive at
 * a patient stop whose PATIENT NOTES contain an access code (door / lock /
 * elevator / gate). Buzzer numbers, unit numbers, and driver notes are
 * deliberately NOT parsed — buzzers already render on stop cards.
 *
 * Owner UI decisions:
 *  • Header uses the notes' own phrasing ("Gate Code", "Elevator Code").
 *  • The code sits in one big pill — impossible to miss, no typing.
 *  • A single "Got it" button dismisses it; no copy button (owner: "don't
 *    need it").
 *  • Several codes at one stop (co-located patients or a multi-code note)
 *    all show at once.
 *
 * Props:
 *  open       – boolean
 *  onClose    – () => void
 *  codes      – [{ patientName, address, label, code }]
 */

export default function AccessCodeDialog({ open, onClose, codes = [] }) {
  if (!Array.isArray(codes) || codes.length === 0) return null;
  const single = codes.length === 1;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose && onClose(); }}>
      <DialogContent
        className="max-w-[22rem] p-0 overflow-hidden"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-gradient-to-b from-blue-50 to-white px-5 pt-6 pb-5">
          <div className="flex flex-col items-center text-center">
            <div className="h-11 w-11 rounded-full bg-blue-100 flex items-center justify-center mb-2">
              <Lock className="h-5 w-5 text-blue-600" />
            </div>
            <DialogTitle className="text-lg font-bold text-slate-800 leading-tight">
              {single ? codes[0].label : 'Access Codes'}
            </DialogTitle>
            {single && codes[0].patientName && (
              <div className="mt-1 text-xs text-slate-500 flex items-center gap-1">
                <Home className="h-3 w-3" />
                <span>{codes[0].patientName}{codes[0].address ? ` — ${codes[0].address}` : ''}</span>
              </div>
            )}
          </div>

          <div className="mt-4 space-y-3">
            {codes.map((c, i) => (
              <div key={`${c.label}-${c.code}-${i}`} className="flex flex-col items-center">
                {!single && (
                  <div className="text-xs text-slate-500 mb-1">
                    {c.label}{c.patientName ? ` — ${c.patientName}` : ''}
                  </div>
                )}
                <div className="rounded-2xl bg-blue-50 border border-blue-200 px-8 py-3">
                  <span className="text-3xl font-extrabold tracking-widest text-blue-700 tabular-nums">
                    {c.code}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="mt-5 w-full rounded-xl bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white font-semibold py-3 text-base transition-colors"
          >
            Got it
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
