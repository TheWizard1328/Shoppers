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

import { useEffect, useMemo, useState } from 'react';
import { X, PackageCheck } from 'lucide-react';
import { groupEntriesByAudience, entriesForRole, ROLE_VIEWS, AUDIENCE_LABELS } from '@/changeLog';

// The five audiences the owner can assign from the log. 'everyone' is stored as
// 'all' to match the shipped keys in src/changeLog.jsx.
const AUDIENCE_CHOICES = [
  { key: 'owner', label: 'Owner' },
  { key: 'drivers', label: 'Drivers' },
  { key: 'dispatchers', label: 'Dispatch' },
  { key: 'admins', label: 'Admins' },
  { key: 'all', label: 'All' },
];

// Flat text badges, not buttons: no pill fill, no border. The active one is
// emerald and bold, the rest stay quiet grey (owner request Oct 31 2026:
// "shorter and less bubble like ... regular badges that are clickable").
const tagBase = 'rounded px-1 py-[1px] text-[10px] leading-none transition-colors';

export default function BuildUpdateDialog({ entries, versionLabel, onClose, onSetAudience }) {
  // ROLE TABS (owner request Oct 31 2026): the owner wants to see at a glance
  // which changes are for Drivers, Dispatchers, Admins and himself. 'Everyone'
  // keeps the full grouped view; the other tabs narrow the list to the changes
  // that actually affect that role.
  const [roleView, setRoleView] = useState('all');
  const roleFiltered = useMemo(() => entriesForRole(entries || [], roleView), [entries, roleView]);
  const groups = useMemo(() => groupEntriesByAudience(roleFiltered), [roleFiltered]);
  const roleCounts = useMemo(() => {
    const counts = {};
    ROLE_VIEWS.forEach((view) => { counts[view.key] = entriesForRole(entries || [], view.key).length; });
    return counts;
  }, [entries]);

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
                {versionLabel ? `${versionLabel} · ` : ''}{roleFiltered.length} change{roleFiltered.length === 1 ? '' : 's'}
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

        <div className="sticky top-[57px] z-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-white px-4 py-1.5">
          {ROLE_VIEWS.map((view) => {
            const active = roleView === view.key;
            return (
              <button
                key={view.key}
                type="button"
                onClick={() => setRoleView(view.key)}
                className={`text-[11px] transition-colors ${active ? 'font-bold text-emerald-700 underline decoration-emerald-600 decoration-2 underline-offset-4' : 'font-medium text-gray-400 hover:text-gray-700'}`}
              >
                {view.label}
                <span className={`ml-0.5 text-[9px] ${active ? 'text-emerald-600' : 'text-gray-300'}`}>{roleCounts[view.key] || 0}</span>
              </button>
            );
          })}
        </div>

        <div className="space-y-4 px-4 py-3">
          {groups.length === 0 && (
            <p className="text-xs text-gray-500">No changes for this role in this window.</p>
          )}
          {groups.map((group) => (
            <div key={group.audience}>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                {group.label}
              </p>
              <ul className="space-y-1.5">
                {group.items.map((item) => (
                  <li key={`${item.build}-${item.area}-${item.summary}`} className="rounded-lg bg-gray-50 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-gray-700">
                        {item.area}
                        <span className="ml-1.5 text-[10px] font-normal text-gray-400">build {item.build}</span>
                      </p>
                      <span className="rounded-full bg-white px-1.5 py-0.5 text-[10px] font-semibold text-gray-500">
                        {AUDIENCE_LABELS[item.audience] || 'Everyone'}
                      </span>
                    </div>
                    <p className="text-xs leading-snug text-gray-600">{item.summary}</p>
                    {/* Owner-editable audience (owner request Oct 31 2026): tap a
                        badge to correct who this change is for. Saved app-wide,
                        so the correction survives the next build. */}
                    {onSetAudience && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-gray-400">
                        {AUDIENCE_CHOICES.map((choice) => {
                          const active = (item.audience || 'all') === choice.key;
                          return (
                            <button
                              key={choice.key}
                              type="button"
                              onClick={() => onSetAudience(item, choice.key)}
                              title={`Set this change to ${choice.label}`}
                              className={`${tagBase} ${active ? 'font-bold text-emerald-700 underline decoration-emerald-600 underline-offset-2' : 'font-medium text-gray-400 hover:text-gray-700'}`}
                            >
                              {choice.label}
                            </button>
                          );
                        })}
                        {item.audience_overridden && (
                          <span className="text-[10px] text-amber-600">edited</span>
                        )}
                      </div>
                    )}
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
