// ── Version update summary (owner request Oct 30 2026) ──────────────────────
//
// Shown once to the APP OWNER, only on the live domain, only when a publish was
// just detected (see changeLogState.jsx). Groups the shipped changes by WHO they
// affect — everyone, drivers, dispatchers, administrators or a combination —
// using the brief synopses in src/changeLog.jsx.
//
// Plain portal-free fixed overlay on purpose: this must render on driver phones
// and store PCs alike without pulling a dialog chunk into the boot path, and it
// is owner-only so the surface stays small.

import { useEffect, useMemo } from 'react';
import { X, PackageCheck } from 'lucide-react';
import { groupEntriesByAudience } from '@/changeLog';

export default function BuildUpdateDialog({ entries, versionLabel, onClose }) {
  const groups = useMemo(() => groupEntriesByAudience(entries || []), [entries]);

  // Escape closes — matches every other dialog in the app.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!entries || entries.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[10050] flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white shadow-2xl">
        <div className="sticky top-0 flex items-start justify-between gap-3 border-b bg-white px-4 py-3">
          <div className="flex items-center gap-2">
            <PackageCheck className="h-5 w-5 text-emerald-600" />
            <div>
              <h3 className="text-sm font-bold text-gray-900">What's new</h3>
              <p className="text-xs text-gray-500">
                {versionLabel ? `${versionLabel} · ` : ''}{entries.length} change{entries.length === 1 ? '' : 's'} published
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-4 py-3">
          {groups.map((group) => (
            <div key={group.audience}>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                {group.label}
              </p>
              <ul className="space-y-1.5">
                {group.items.map((item) => (
                  <li key={`${item.build}-${item.area}-${item.summary}`} className="rounded-lg bg-gray-50 px-3 py-2">
                    <p className="text-xs font-semibold text-gray-700">{item.area}</p>
                    <p className="text-xs leading-snug text-gray-600">{item.summary}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="sticky bottom-0 border-t bg-white px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
