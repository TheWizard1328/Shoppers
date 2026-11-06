import React, { useState } from "react";
import { edmontonWallString, parseAnyTimestamp } from "@/components/utils/albertaTime";

/**
 * Payment Discrepancies list (owner-only).
 * Each row shows COD deliveries whose recorded collection type disagrees with
 * what Square actually saw (60-day scan, flagged by the backend balances
 * updater — no in-app auto-updates). Confirm applies the recorded→actual fix
 * with normal fee/loan/folder math; Dismiss closes the flag after review.
 *
 * Row layout (owner request Oct 10 2026):
 *   1. Date & time = the affected delivery's original delivery_date +
 *      actual_delivery_time (NOT the detection time). Legacy rows fall back to
 *      changed_at until the backend backfills the new fields.
 *   2. Store badge (abbreviation + color) instead of the store name.
 *   3. Amount + detail (recorded type → Square actual type).
 *   4. Patient name.
 *   5. Far right: "detected …" phrase + Dismiss button (rounded corners, not
 *      oval).
 */
export default function PaymentDiscrepanciesList({
  discrepancies,
  discrepancyBusy,
  onConfirm,
  onDismiss,
  onRefresh,
}) {
  // LINK-AS-ONE-SWIPE state (owner request Nov 5 2026). Declared before any
  // early return so the hook order never changes between renders.
  const [linkFor, setLinkFor] = useState(null); // row id being confirmed with links
  const [linkSel, setLinkSel] = useState({});   // { [discrepancyId]: true }

  if (!discrepancies || discrepancies.length === 0) return null;

  // MOST RECENT FIRST (owner request Oct 24 2026): the loader sorts by
  // -changed_at, but a detection batch stamps every row identically so the
  // order collapsed to insertion order (oldest delivery first). Rows now sort
  // by the affected delivery's own moment — actual_delivery_time (naive
  // Edmonton) on its delivery_date, falling back to changed_at for legacy
  // rows — newest first.
  const deliveryMomentOf = (r) => {
    try {
      const d = String(r.delivery_date || '').slice(0, 10);
      if (d) {
        if (r.actual_delivery_time) {
          const t = parseAnyTimestamp(String(r.actual_delivery_time));
          if (t && !Number.isNaN(t.getTime())) return t.getTime();
        }
        return Date.parse(`${d}T00:00:00Z`);
      }
    } catch (_) { /* fall through */ }
    const c = Date.parse(String(r.changed_at || ''));
    return Number.isNaN(c) ? 0 : c;
  };
  const sorted = [...discrepancies].sort((a, b) => deliveryMomentOf(b) - deliveryMomentOf(a));

  // ── REAL DISCREPANCIES ONLY (owner spec Nov 5 2026) ────────────────────────
  // "only show actual discrepancies where the amount in app is different from
  // the square recorded type." A card-label swap (app Debit, Square Credit) on
  // the SAME money is not a discrepancy — it is how the driver's POS reports the
  // brand — and those rows were the bulk of the section. A row stays only when
  // the money itself disagrees: app amount vs Square amount differ, cash was
  // recorded but Square took a card, or Square has no payment at all.
  const isRealDiscrepancy = (r) => {
    const kind = String(r.discrepancy_kind || '');
    if (kind === 'missing_payment') return true;
    if (kind === 'cash_swiped') return true;
    const appCents = Math.round(Number(r.amount_cents || 0));
    const squareCents = Number(r.square_amount_cents);
    if (!Number.isFinite(squareCents) || squareCents <= 0) return false;
    return squareCents !== appCents;
  };
  const visible = sorted.filter(isRealDiscrepancy);
  // Nothing but label noise left — hide the whole section instead of an empty box.
  if (visible.length === 0) return null;

  // ── LINK OTHER DISCREPANCIES INTO ONE SWIPE (owner request Nov 5 2026) ─────
  // "If I click a Confirm [Debit/Credit] button I should be able to link other
  // discrepancies to it as a single swipe like we do with the Cash button on
  // the Store cards." Same flow as the Cash badge popup: pick the sibling
  // discrepancies that went through on the SAME card swipe, and confirming
  // applies the tender to all of them as ONE collection.
  const confirmable = visible.filter((r) => ["cash_swiped", "type_mismatch"].includes(r.discrepancy_kind));
  const linkCandidatesOf = (r) => confirmable.filter((o) =>
    String(o.id) !== String(r.id) &&
    String(o.actual_type || "").toLowerCase() === String(r.actual_type || "").toLowerCase());


  return (
    <details className="group mt-3 rounded-xl border-2 border-red-300 dark:border-red-500/50 bg-red-50/60 dark:bg-red-950/30 p-3">
      <summary className="flex items-center justify-between gap-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
        <span className="text-sm font-semibold text-red-700 dark:text-red-300 flex items-center gap-1.5">
          <span className="inline-block text-[10px] transition-transform -rotate-90 group-open:rotate-0">▼</span>
          Payment discrepancies ({visible.length}) — amount in app vs Square
        </span>
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRefresh(); }}
          className="text-[11px] text-red-600 dark:text-red-400 hover:underline"
        >
          Refresh
        </button>
      </summary>
      <div className="mt-2 space-y-1.5">
        {visible.map((r) => {
          // 1) Date & time — original delivery date + actual delivery time.
          const dtDate = r.delivery_date ? String(r.delivery_date).slice(0, 10) : null;
          // TZ FIX (owner report Oct 10 00:10: Patricia Dalpe showed 11:13,
          // actual 10:13; Freda Muth 13:06 vs 12:06): actual_delivery_time is
          // a NAIVE Edmonton wall string — `new Date()` parses naive input as
          // DEVICE-LOCAL time, and on machines with a premature tz database
          // (Edmonton read as UTC-7) the round-trip through edmontonWallString
          // shifted it +1h. parseAnyTimestamp treats naive strings as
          // Edmonton wall time by convention, so the wall string round-trips
          // byte-identical on every device.
          const dtTime = r.actual_delivery_time
            ? (() => { try { return edmontonWallString(parseAnyTimestamp(r.actual_delivery_time)); } catch (_) { return null; } })()
            : null;
          const dtLabel = dtDate
            ? (dtTime ? `${dtDate} ${dtTime.slice(11, 16)}` : dtDate)
            : (r.changed_at
                ? (() => { try { return new Date(r.changed_at).toLocaleString("en-CA", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch (_) { return ""; } })()
                : "");

          const canConfirm = ["cash_swiped", "type_mismatch"].includes(r.discrepancy_kind);

          return (
            <div
              key={r.id || `${r.changed_at}-${r.delivery_id}`}
              className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-red-100 dark:border-red-900/50 pb-1 text-xs text-slate-700 dark:text-slate-200"
            >
              {/* 1) Date & time */}
              <span className="font-mono text-slate-400 dark:text-slate-500 text-sm tabular-nums">
                {dtLabel}
              </span>

              {/* 2) Store badge (or store name fallback for legacy rows) */}
              {r.store_abbrev ? (
                <span
                  className="text-[9px] font-bold leading-none px-1.5 py-0.5 rounded-full text-white flex-shrink-0"
                  style={{ backgroundColor: r.store_color || "#64748b" }}
                >
                  {r.store_abbrev}
                </span>
              ) : (
                r.store_name && (
                  <span className="text-slate-400 dark:text-slate-500">({r.store_name})</span>
                )
              )}

              {/* 3) Amount + recorded→Square detail */}
              {r.amount_cents > 0 && (
                <span className="font-medium tabular-nums">
                  ${(r.amount_cents / 100).toFixed(2)}
                </span>
              )}
              <span className="font-semibold">{r.detail}</span>

              {/* 4) Patient name */}
              {r.patient_names && <span>· {r.patient_names}</span>}

              {canConfirm && (
                <button
                  type="button"
                  disabled={discrepancyBusy}
                  onClick={() => {
                    const open = String(linkFor) === String(r.id);
                    setLinkFor(open ? null : (r.id || r.delivery_id));
                    setLinkSel({});
                  }}
                  className={`ml-1 rounded-full text-white px-2.5 py-0.5 text-[11px] font-medium disabled:opacity-50 ${String(linkFor) === String(r.id) ? "bg-emerald-700" : "bg-emerald-600 hover:bg-emerald-500"}`}
                >
                  Confirm {r.actual_type === "debit" ? "Debit" : "Credit"}
                  {(() => {
                    const n = linkCandidatesOf(r).length;
                    return n > 0 ? ` +link (${n})` : "";
                  })()}
                </button>
              )}

              {/* 5) Far right: detected phrase + Dismiss (rounded corners) */}
              <span className="ml-auto flex items-center gap-1.5">
                <span className="text-slate-400 dark:text-slate-500 text-xs">
                  detected{" "}
                  {r.changed_at
                    ? new Date(r.changed_at).toLocaleDateString("en-CA", { month: "2-digit", day: "2-digit" })
                    : ""}{" "}
                  by Square sync
                </span>
                <button
                  type="button"
                  disabled={discrepancyBusy}
                  onClick={() => onDismiss(r)}
                  className="rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 px-2.5 py-0.5 text-[11px] font-medium disabled:opacity-50"
                >
                  Dismiss
                </button>
              </span>
            </div>
          );
        })}
      </div>
      {/* LINK PANEL — one card swipe covering several discrepancies */}
      {(() => {
        const row = visible.find((x) => String(x.id || x.delivery_id) === String(linkFor));
        if (!row) return null;
        const cands = linkCandidatesOf(row);
        const picked = Object.keys(linkSel).filter((k) => linkSel[k]);
        return (
          <div className="mt-2 rounded-lg border border-emerald-300 dark:border-emerald-700 bg-white dark:bg-slate-900 p-2">
            <div className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
              One swipe covers {picked.length + 1} discrepanc{picked.length === 0 ? "y" : "ies"} — select the others that went through on the same card
            </div>
            {cands.length === 0 ? (
              <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                No other {String(row.actual_type || "card")} discrepancies to link right now.
              </div>
            ) : (
              <div className="mt-1 space-y-0.5">
                {cands.map((o) => {
                  const key = String(o.id || o.delivery_id);
                  return (
                    <label key={key} className="flex items-center gap-2 text-[11px] text-slate-700 dark:text-slate-200">
                      <input
                        type="checkbox"
                        checked={!!linkSel[key]}
                        onChange={(e) => setLinkSel((prev) => ({ ...prev, [key]: e.target.checked }))}
                      />
                      <span className="tabular-nums">${(Number(o.amount_cents || 0) / 100).toFixed(2)}</span>
                      {o.store_abbrev && <span className="text-slate-400">{o.store_abbrev}</span>}
                      <span className="truncate">{o.patient_names || ""}</span>
                    </label>
                  );
                })}
              </div>
            )}
            <div className="mt-2 flex items-center gap-1.5">
              <button
                type="button"
                disabled={discrepancyBusy}
                onClick={async () => {
                  const linked = cands
                    .filter((o) => linkSel[String(o.id || o.delivery_id)])
                    .map((o) => o.delivery_id)
                    .filter(Boolean);
                  setLinkFor(null);
                  setLinkSel({});
                  await onConfirm(row, linked);
                }}
                className="rounded-full bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1 text-[11px] font-semibold disabled:opacity-50"
              >
                Confirm {row.actual_type === "debit" ? "Debit" : "Credit"} as one swipe
              </button>
              <button
                type="button"
                onClick={() => { setLinkFor(null); setLinkSel({}); }}
                className="rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 px-2.5 py-1 text-[11px]"
              >
                Cancel
              </button>
            </div>
          </div>
        );
      })()}
    </details>
  );
}