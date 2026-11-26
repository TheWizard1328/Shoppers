import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

/**
 * LogSwipeDialog — the manual fallback form. Full-screen overlay (fixed inset-0)
 * like every other edit form in the app. Owner only.
 */
export default function LogSwipeDialog({ open, card, onClose, onSave, currentUserName }) {
  const todayStr = () => {
    // Square's app shows a swipe with no time, so the form asks for the date
    // only (owner correction Nov 22 2026).
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  };
  // OWNER REQUEST (Nov 26 2026): a store can have SEVERAL missing swipes. The
  // form used to hold one amount and close on save, so only one entry could be
  // logged per store at a time. It now stages a list and saves them all.
  const [entries, setEntries] = useState([]);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAmount('');
    setNote('');
    setEntries([]);
    setDate(todayStr());
  }, [open]);

  const fmtDraft = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

  if (!open) return null;

  const draftCents = Math.round(Number(String(amount).replace(/[^0-9.]/g, '')) * 100);
  const draftValid = draftCents > 0;

  const addEntry = () => {
    if (!draftValid) {
      toast.error('Enter the swipe amount');
      return;
    }
    setEntries((prev) => [...prev, { cents: draftCents, date, note: note.trim() }]);
    setAmount('');
    setNote('');
  };

  const submit = async () => {
    // Whatever is still in the form counts as an entry, so one-shot logging
    // keeps working exactly as before.
    const queue = draftValid ? [...entries, { cents: draftCents, date, note: note.trim() }] : [...entries];
    if (!queue.length) {
      toast.error('Enter the swipe amount');
      return;
    }
    setSaving(true);
    try {
      for (const entry of queue) {
        await onSave({
          // The app schema still requires store_id, and a logged swipe has no
          // store yet (that is the whole point), so it is written as 'unassigned'.
          store_id: 'unassigned',
          location_id: card?.location_id || null,
          amount_cents: entry.cents,
          swipe_date: entry.date || null,
          swiped_at: entry.date ? new Date(`${entry.date}T12:00:00`).toISOString() : new Date().toISOString(),
          note: entry.note || null,
          created_by_name: currentUserName || null
        });
      }
      if (queue.length > 1) toast.success(`${queue.length} swipes logged`);
      onClose();
    } catch (e) {
      console.error('[LogSwipe] save failed:', e);
      toast.error(e?.message || 'Could not log the swipe');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[10050] flex items-center justify-center p-4 bg-slate-900/40" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-800">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">Log a missing card swipe</div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
              {card?.label || 'Card'} · stays until a collected delivery matches it
            </div>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 w-7 h-7 rounded-md border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 flex items-center justify-center">✕</button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Amount</label>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="3.09" autoFocus />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Swiped on</label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-300 mb-1">Note (optional)</label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Patient, till, anything you know" />
          </div>
          {entries.length > 0 &&
          <div className="space-y-1 rounded-lg border border-slate-200 dark:border-slate-700 p-2">
            {entries.map((entry, i) =>
            <div key={i} className="flex items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-slate-300">
                <span className="tabular-nums font-medium">{fmtDraft(entry.cents)}</span>
                <span className="truncate">{entry.date}{entry.note ? ` · ${entry.note}` : ''}</span>
                <button type="button" className="shrink-0 text-slate-400 hover:text-red-600" onClick={() => setEntries((prev) => prev.filter((_, idx) => idx !== i))}>×</button>
              </div>
            )}
            <div className="text-[11px] text-slate-500 dark:text-slate-400 pt-1">{entries.length} ready to log</div>
          </div>
          }
          <div className="flex items-center justify-between gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={addEntry} disabled={saving || !draftValid}>Add another</Button>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
              <Button type="button" onClick={submit} disabled={saving}>{saving ? 'Saving…' : (entries.length ? `Log ${entries.length + (draftValid ? 1 : 0)} swipes` : 'Log swipe')}</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}