import React, { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { getLedgerEntriesOffline } from "@/components/utils/squareLedgerOfflineManager";
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

export default function StoreFeesByDay({ locationId, locationName }) {
  const [entries, setEntries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState(() => monthKey(new Date()));

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const rows = await getLedgerEntriesOffline().catch(() => []);
      if (alive) { setEntries(rows || []); setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  const monthOptions = useMemo(() => {
    const now = new Date();
    const out = [];
    for (let i = 0; i < MONTHS_BACK; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      out.push(monthKey(d));
    }
    return out;
  }, []);

  const { days, totals, maxFeeC } = useMemo(() => {
    const byDay = new Map(); // day -> { feeC, loanC, cods, swipes:Set }
    const todayKey = edmontonBusinessDayKey(new Date());
    const dim = daysInMonth(month);
    const mTotals = { feeC: 0, loanC: 0, cods: 0, swipes: 0 };
    let maxFee = 0;
    const swipeCount = new Map(); // day -> Set(txKey)

    for (const e of entries || []) {
      if (!e?.occurred_at) continue;
      if (String(e.location_id || '') !== String(locationId)) continue;
      if (String(e.sale_class || '') !== 'cod_collection') continue;
      if (String(e.entry_kind || '') !== 'collected') continue;
      if (String(e.tender_type || '').toUpperCase() !== 'CARD') continue;
      if (String(e.status || '').toUpperCase() !== 'COMPLETED') continue;
      const day = edmontonBusinessDayKey(parseAnyTimestamp(e.occurred_at));
      if (!day || !day.startsWith(month)) continue;
      const feeC = Math.round(Number(e.fee_cents || 0));
      const loanC = Math.round(Number(e.loan_cents || 0));
      if (feeC <= 0 && loanC <= 0) continue;
      if (!byDay.has(day)) byDay.set(day, { feeC: 0, loanC: 0, cods: 0 });
      const row = byDay.get(day);
      row.feeC += feeC; row.loanC += loanC; row.cods += 1;
      if (!swipeCount.has(day)) swipeCount.set(day, new Set());
      swipeCount.get(day).add(txKeyOf(e.square_id));
      mTotals.feeC += feeC; mTotals.loanC += loanC; mTotals.cods += 1;
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
      rows.push({
        dayKey,
        label: new Date(y, m - 1, dIdx).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' }),
        feeC: data?.feeC || 0,
        loanC: data?.loanC || 0,
        cods: data?.cods || 0,
        swipes: data?.swipes || 0,
      });
    }
    return { days: rows, totals: mTotals, maxFeeC: maxFee };
  }, [entries, locationId, month]);

  return (
    <div className="mx-2 mb-2 mt-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/40 p-2.5">
      {/* Header: title + month selector */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
          Fees by day — {locationName || 'card'}
        </span>
        <select
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="text-xs rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 px-1.5 py-1 text-slate-700 dark:text-slate-200"
        >
          {monthOptions.map((mk) => (
            <option key={mk} value={mk}>{monthLabel(mk)}</option>
          ))}
        </select>
      </div>

      {/* Monthly totals chips */}
      <div className="mt-2 grid grid-cols-3 gap-1.5 text-[11px]">
        <div className="rounded-md bg-teal-500/10 border border-teal-500/30 px-2 py-1.5">
          <div className="text-slate-500 dark:text-slate-400">Square fees</div>
          <div className="font-bold tabular-nums text-teal-700 dark:text-teal-300">{money(totals.feeC)}</div>
        </div>
        <div className="rounded-md bg-amber-500/10 border border-amber-500/30 px-2 py-1.5">
          <div className="text-slate-500 dark:text-slate-400">Loan fees</div>
          <div className="font-bold tabular-nums text-amber-700 dark:text-amber-300">{money(totals.loanC)}</div>
        </div>
        <div className="rounded-md bg-blue-500/10 border border-blue-500/30 px-2 py-1.5">
          <div className="text-slate-500 dark:text-slate-400">CODs (swipes)</div>
          <div className="font-bold tabular-nums text-blue-700 dark:text-blue-300">{totals.cods} ({totals.swipes})</div>
        </div>
      </div>

      {/* Daily rows */}
      <div className="mt-2 max-h-72 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-4 text-xs text-slate-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading ledger…
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
                <th className="text-left font-semibold py-1 pr-2">Day</th>
                <th className="text-right font-semibold px-2">Square fees</th>
                <th className="text-right font-semibold px-2">Loan fees</th>
                <th className="text-right font-semibold pl-2">CODs</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => {
                const empty = d.cods === 0;
                return (
                  <tr key={d.dayKey} className={`border-b border-slate-100 dark:border-slate-800/60 ${empty ? 'opacity-40' : ''}`}>
                    <td className="py-1 pr-2 tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">{d.label}</td>
                    <td className="py-1 px-2 text-right tabular-nums text-teal-700 dark:text-teal-300">
                      {empty ? '—' : money(d.feeC)}
                      {/* mini bar: day fee vs month max */}
                      {!empty && maxFeeC > 0 && (
                        <div className="h-1 mt-0.5 rounded-sm bg-teal-500/60" style={{ width: `${Math.max(6, Math.round((d.feeC / maxFeeC) * 100))}%`, marginLeft: 'auto' }} />
                      )}
                    </td>
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
