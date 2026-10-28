import React, { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, FileDown } from "lucide-react";
import { jsPDF } from "jspdf";
import { getLedgerEntriesOffline } from "@/components/utils/squareLedgerOfflineManager";
import { base44 } from "@/api/base44Client";
import { edmontonBusinessDayKey, parseAnyTimestamp } from "@/components/utils/albertaTime";

/**
 * Store fees-by-day panel (owner spec, Oct 27 2026):
 * tap a store card on the Square Balance page → expandable panel with a month
 * selector showing, for each day of the selected month, the total Square fee
 * and Loan fee for all COLLECTED CODs on that card.
 *
 * Data source: the local offline ledger mirror (square_ledger IDB store) —
 * the Editor syncs it regularly, so this panel costs ZERO API calls. Each
 * ledger entry for a card collection carries its own fee_cents/loan_cents
 * split; combined swipes are ALREADY split per-COD by squareLedgerSync (the
 * split children sum exactly to the whole swipe's fees), so summing entries
 * never double-counts a multi-COD swipe — the "counted once" rule falls out
 * of the data model. Distinct swipe count (tx key before the ':' suffix)
 * surfaces the combination.
 */

const txKeyOf = (raw) => String(raw || '').replace(/:[^:]*$/, '');
const money = (cents) => `$${(Math.max(0, cents) / 100).toFixed(2)}`;

const MONTHS_BACK = 8; // selectable month range

const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const monthLabel = (mk) => {
  const [y, m] = mk.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
};
const daysInMonth = (mk) => {
  const [y, m] = mk.split('-').map(Number);
  return new Date(y, m, 0).getDate();
};

export default function StoreFeesByDay({ locationId, locationName, locations }) {
  // STORE SELECTOR (owner spec Oct 27 2026 night): checkboxes so the dialog
  // can show another card (or a COMBINED view of several cards) without
  // closing and reopening it. Starts with the card that opened the dialog;
  // re-syncs if the dialog is reopened for a different card.
  const locList = useMemo(
    () => (Array.isArray(locations) ? locations.filter((l) => l?.location_id) : []),
    [locations]
  );
  const [selectedIds, setSelectedIds] = useState(() => new Set([String(locationId)]));
  const locIdRef = useRef(locationId);
  useEffect(() => {
    if (locIdRef.current !== locationId) {
      locIdRef.current = locationId;
      setSelectedIds(new Set([String(locationId)]));
    }
  }, [locationId]);
  const selectedNames = useMemo(
    () => locList.filter((l) => selectedIds.has(String(l.location_id))).map((l) => l.name || l.location_id),
    [locList, selectedIds]
  );
  const headerLabel = selectedNames.length === 1 ? (selectedNames[0] || 'Card')
    : selectedNames.length > 1 ? `${selectedNames.length} stores` : (locationName || 'Card');
  const toggleLoc = (id) => {
    setSelectedIds((prev) => {
      const key = String(id);
      const next = new Set(prev);
      if (next.has(key)) { if (next.size > 1) next.delete(key); } // keep ≥1 checked
      else next.add(key);
      return next;
    });
  };
  const [entries, setEntries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(() => monthKey(new Date()));

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      // Instant prefill from the offline mirror (zero API calls).
      const rows = await getLedgerEntriesOffline().catch(() => []);
      if (alive) { setEntries(rows || []); setLoading(false); }
      // OWNER FIX (Oct 27 2026, "fees all $0.00"): the offline mirror is
      // written ONLY by the owner-gated SquareSyncAudit page — on any device
      // that hasn't synced the audit page, the mirror is empty and every
      // day showed $0.00 even though the server ledger has correct fee
      // splits. Fetch the SELECTED MONTH's cod_collection ledger rows from
      // the entity API (owner-only panel, ~1-2 paged calls per month
      // selection). Server rows are authoritative for the month; offline
      // rows outside the month are kept so past months still render from
      // the mirror without refetching.
      try {
        const [y, m] = month.split('-').map(Number);
        // Month window in UTC, padded 2 days into the next month: late-night
        // Edmonton collections on the month's last day land after the UTC
        // boundary; the day-bucket filter below discards out-of-month days.
        const until = new Date(Date.UTC(y, m, 2)).toISOString();
        const out = [];
        for (let page = 0; page < 10; page++) {
          const rows = await base44.entities.SquareLedgerEntry.filter(
            { sale_class: 'cod_collection', occurred_at: { $gte: `${month}-01T00:00:00.000Z`, $lte: until } },
            'created_date', 500, out.length
          ).catch(() => []);
          const list = rows || [];
          out.push(...list);
          if (list.length < 500) break;
        }
        if (alive) {
          setEntries((prev) => {
            const prevRows = Array.isArray(prev) ? prev : [];
            const serverIds = new Set(out.map((r) => String(r?.square_id || '')));
            const keptOffline = prevRows.filter((r) =>
              !serverIds.has(String(r?.square_id || '')) && String(r?.occurred_at || '') < `${month}-01`);
            return [...keptOffline, ...out];
          });
        }
      } catch (err) {
        // Offline / rate-limited: the offline prefill stays as-is.
        console.warn('[StoreFeesByDay] month ledger fetch failed (using offline mirror):', err?.message || err);
      }
    })();
    return () => { alive = false; };
  }, [locationId, month]);

  const monthOptions = useMemo(() => {
    const now = new Date();
    const out = [];
    for (let i = 0; i < MONTHS_BACK; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      out.push(monthKey(d));
    }
    return out;
  }, []);

  // EXPORT TO PDF (owner spec Oct 27 2026 night): plain jsPDF table —
  // header block (stores + month + totals) then the same Day / Collected /
  // Square fees / Loan fees / CODs rows the dialog shows.
  const exportPdf = () => {
    try {
      const doc = new jsPDF();
      const title = `Fees by Day — ${selectedNames.length ? selectedNames.join(', ') : (locationName || 'Card')}`;
      doc.setFontSize(13).setFont('helvetica', 'bold');
      doc.text(title, 14, 16);
      doc.setFontSize(11).setFont('helvetica', 'normal');
      doc.text(monthLabel(month), 14, 22);
      doc.setFontSize(9);
      doc.text(
        `Collected: ${money(totals.amountC)}    Square fees: ${money(totals.feeC)}    Folder fees: ${money(totals.folderC)}    Loan fees: ${money(totals.loanC)}    CODs: ${totals.cods} (${totals.swipes} swipes)`,
        14, 28
      );
      // Column x positions (mm) — Day, Collected, Square fees, Folder fees, Loan fees, CODs
      const cols = [14, 66, 100, 134, 168, 196];
      let y = 36;
      doc.setFont('helvetica', 'bold');
      doc.text('Day', cols[0], y);
      doc.text('Collected', cols[1], y, { align: 'right' });
      doc.text('Square fees', cols[2], y, { align: 'right' });
      doc.text('Folder fees', cols[3], y, { align: 'right' });
      doc.text('Loan fees', cols[4], y, { align: 'right' });
      doc.text('CODs', cols[5], y, { align: 'right' });
      doc.setFont('helvetica', 'normal');
      y += 3;
      doc.line(14, y, 196, y);
      y += 5;
      for (const d of days) {
        if (y > 280) { doc.addPage(); y = 20; }
        const empty = d.cods === 0;
        doc.text(String(d.label), cols[0], y);
        doc.text(empty ? '—' : money(d.amountC), cols[1], y, { align: 'right' });
        doc.text(empty ? '—' : money(d.feeC), cols[2], y, { align: 'right' });
        doc.text(empty ? '—' : money(d.folderC), cols[3], y, { align: 'right' });
        doc.text(empty ? '—' : money(d.loanC), cols[4], y, { align: 'right' });
        doc.text(empty ? '—' : (d.swipes && d.swipes < d.cods ? `${d.cods} (${d.swipes} swipes)` : String(d.cods)), cols[5], y, { align: 'right' });
        y += 5;
      }
      const slug = (selectedNames.length === 1 ? selectedNames[0] : `${selectedNames.length}-stores`).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      doc.save(`fees-by-day-${month}-${slug}.pdf`);
    } catch (e) {
      console.error('[StoreFeesByDay] PDF export failed:', e);
      import('sonner').then(({ toast }) => toast.error('PDF export failed'));
    }
  };

  const { days, totals, maxFeeC } = useMemo(() => {
    const byDay = new Map(); // day -> { feeC, folderC, loanC, cods, amountC, swipes:Set }
    const todayKey = edmontonBusinessDayKey(new Date());
    const dim = daysInMonth(month);
    const mTotals = { feeC: 0, folderC: 0, loanC: 0, cods: 0, amountC: 0, swipes: 0 };
    let maxFee = 0;
    const swipeCount = new Map(); // day -> Set(txKey)

    for (const e of entries || []) {
      if (!e?.occurred_at) continue;
      if (!selectedIds.has(String(e.location_id || ''))) continue;
      if (String(e.sale_class || '') !== 'cod_collection') continue;
      if (String(e.entry_kind || '') !== 'collected') continue;
      if (String(e.tender_type || '').toUpperCase() !== 'CARD') continue;
      if (String(e.status || '').toUpperCase() !== 'COMPLETED') continue;
      const day = edmontonBusinessDayKey(parseAnyTimestamp(e.occurred_at));
      if (!day || !day.startsWith(month)) continue;
      const feeC = Math.round(Number(e.fee_cents || 0));
      const folderC = Math.round(Number(e.folder_cents || 0));
      const loanC = Math.round(Number(e.loan_cents || 0));
      if (feeC <= 0 && folderC <= 0 && loanC <= 0) continue;
      if (!byDay.has(day)) byDay.set(day, { feeC: 0, folderC: 0, loanC: 0, cods: 0, amountC: 0 });
      const row = byDay.get(day);
      row.feeC += feeC; row.folderC += folderC; row.loanC += loanC; row.cods += 1;
      row.amountC += Math.max(0, Math.round(Number(e.amount_cents || 0)));
      mTotals.amountC += Math.max(0, Math.round(Number(e.amount_cents || 0)));
      if (!swipeCount.has(day)) swipeCount.set(day, new Set());
      swipeCount.get(day).add(txKeyOf(e.square_id));
      mTotals.feeC += feeC; mTotals.folderC += folderC; mTotals.loanC += loanC; mTotals.cods += 1;
    }
    for (const [day, set] of swipeCount) {
      if (byDay.has(day)) byDay.get(day).swipes = set.size;
    }
    mTotals.swipes = [...swipeCount.values()].reduce((s, x) => s + x.size, 0);

    const rows = [];
    for (let dIdx = 1; dIdx <= dim; dIdx++) {
      const [y, m] = month.split('-').map(Number);
      const dayKey = `${month}-${String(dIdx).padStart(2, '0')}`;
      if (dayKey > todayKey) break; // future days of the current month
      const data = byDay.get(dayKey) || null;
      if (data) maxFee = Math.max(maxFee, data.feeC);
      const _dd = new Date(y, m - 1, dIdx);
      rows.push({
        dayKey,
        // COMPACT (owner spec Oct 27 2026 night): "Tue 27" instead of
        // "Tue, Oct 27" — narrower Date column, scrollbar stays clear.
        label: `${_dd.toLocaleDateString('en-CA', { weekday: 'short' })} ${dIdx}`,
        feeC: data?.feeC || 0,
        folderC: data?.folderC || 0,
        loanC: data?.loanC || 0,
        cods: data?.cods || 0,
        amountC: data?.amountC || 0,
        swipes: data?.swipes || 0,
      });
    }
    return { days: rows, totals: mTotals, maxFeeC: maxFee };
  }, [entries, selectedIds, month]);

  return (
    <div className="mx-2 mb-2 mt-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/40 p-2.5 flex-1 min-h-0 flex flex-col">
      {/* Header: title + month selector + PDF export (icon only) */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
          {headerLabel} — month detail
        </span>
        <div className="flex items-center gap-1.5">
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="text-xs rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-1.5 py-1 text-slate-700 dark:text-slate-200"
          >
            {monthOptions.map((mk) => (
              <option key={mk} value={mk}>{monthLabel(mk)}</option>
            ))}
          </select>
          <button
            type="button"
            title="Export to PDF"
            aria-label="Export to PDF"
            onClick={exportPdf}
            className="w-7 h-7 rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-50 hover:border-slate-400 dark:hover:border-slate-500 flex items-center justify-center transition-colors"
          >
            <FileDown className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Store selector checkboxes (owner spec Oct 27 2026 night): pick
          another card — or several at once for a combined view — without
          closing the dialog. The card that opened the dialog starts
          checked; at least one stays checked. */}
      {locList.length > 1 && (
        <div className="mt-1.5 flex items-center gap-x-3 gap-y-1 flex-wrap">
          {locList.map((l) => (
            <label key={l.location_id} className="flex items-center gap-1 text-[11px] text-slate-600 dark:text-slate-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={selectedIds.has(String(l.location_id))}
                onChange={() => toggleLoc(l.location_id)}
                className="h-3 w-3 accent-teal-600"
              />
              {l.name || l.location_id}
            </label>
          ))}
        </div>
      )}

      {/* Monthly totals chips — ALIGNED WITH THE TABLE (owner spec Oct 27
          2026 night): the grid uses the SAME 6-column template as the table
          below (Day-width spacer + the five data columns), so each card sits
          centered over the column it totals. Content is centered inside each
          card. [scrollbar-gutter:stable] + pr-2 mirror the scroll container
          so the columns stay aligned whether or not the scrollbar shows. */}
      <div className="mt-2 grid grid-cols-[25fr_15fr_15fr_15fr_15fr_15fr] gap-1.5 text-[11px] pr-2 overflow-y-auto [scrollbar-gutter:stable]">
        <div />
        <div className="rounded-md bg-emerald-500/10 border border-emerald-500/30 px-1 py-1.5 text-center">
          <div className="text-slate-500 dark:text-slate-400">CODs collected</div>
          <div className="font-bold tabular-nums text-emerald-700 dark:text-emerald-300">{money(totals.amountC)}</div>
        </div>
        <div className="rounded-md bg-teal-500/10 border border-teal-500/30 px-1 py-1.5 text-center">
          <div className="text-slate-500 dark:text-slate-400">Square fees</div>
          <div className="font-bold tabular-nums text-teal-700 dark:text-teal-300">{money(totals.feeC)}</div>
        </div>
        <div className="rounded-md bg-violet-500/10 border border-violet-500/30 px-1 py-1.5 text-center">
          <div className="text-slate-500 dark:text-slate-400">Folder fees</div>
          <div className="font-bold tabular-nums text-violet-700 dark:text-violet-300">{money(totals.folderC)}</div>
        </div>
        <div className="rounded-md bg-amber-500/10 border border-amber-500/30 px-1 py-1.5 text-center">
          <div className="text-slate-500 dark:text-slate-400">Loan fees</div>
          <div className="font-bold tabular-nums text-amber-700 dark:text-amber-300">{money(totals.loanC)}</div>
        </div>
        <div className="rounded-md bg-blue-500/10 border border-blue-500/30 px-1 py-1.5 text-center">
          <div className="text-slate-500 dark:text-slate-400">CODs (swipes)</div>
          <div className="font-bold tabular-nums text-blue-700 dark:text-blue-300">{totals.cods} ({totals.swipes})</div>
        </div>
      </div>

      {/* Daily rows */}
      <div className="mt-2 flex-1 min-h-0 overflow-y-auto pr-2 [scrollbar-gutter:stable]">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-4 text-xs text-slate-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading ledger…
          </div>
        ) : (
          <table className="w-full table-fixed text-xs">
            <thead>
              <tr className="text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
                {/* widths match the chips grid above (25fr + 5×15fr) so each
                    card is centered over its column */}
                <th className="text-left font-semibold py-1 pr-2 w-[25%]">Day</th>
                <th className="text-right font-semibold px-2 w-[15%]">Collected</th>
                <th className="text-right font-semibold px-2 w-[15%]">Square fees</th>
                <th className="text-right font-semibold px-2 w-[15%]">Folder fees</th>
                <th className="text-right font-semibold px-2 w-[15%]">Loan fees</th>
                <th className="text-right font-semibold pl-2 w-[15%]">CODs</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => {
                const empty = d.cods === 0;
                return (
                  <tr key={d.dayKey} className={`border-b border-slate-100 dark:border-slate-800/60 ${empty ? 'opacity-40' : ''}`}>
                    <td className="py-1 pr-2 tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">{d.label}</td>
                    <td className="py-1 px-2 text-right tabular-nums text-emerald-700 dark:text-emerald-300">{empty ? '—' : money(d.amountC)}</td>
                    <td className="py-1 px-2 text-right tabular-nums text-teal-700 dark:text-teal-300">
                      {empty ? '—' : money(d.feeC)}
                      {/* mini bar: day fee vs month max */}
                      {!empty && maxFeeC > 0 && (
                        <div className="h-1 mt-0.5 rounded-sm bg-teal-500/60" style={{ width: `${Math.max(6, Math.round((d.feeC / maxFeeC) * 100))}%`, marginLeft: 'auto' }} />
                      )}
                    </td>
                    <td className="py-1 px-2 text-right tabular-nums text-violet-700 dark:text-violet-300">{empty ? '—' : money(d.folderC)}</td>
                    <td className="py-1 px-2 text-right tabular-nums text-amber-700 dark:text-amber-300">{empty ? '—' : money(d.loanC)}</td>
                    <td className="py-1 pl-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                      {empty ? '—' : (d.swipes && d.swipes < d.cods ? `${d.cods} (${d.swipes} swipes)` : d.cods)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {!loading && totals.cods === 0 && (
          <div className="text-center text-xs text-slate-400 py-3">No card collections recorded this month.</div>
        )}
      </div>
    </div>
  );
}
