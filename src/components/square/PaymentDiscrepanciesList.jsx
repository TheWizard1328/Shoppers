import React from "react";
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
  if (!discrepancies || discrepancies.length === 0) return null;

  return (
    <div className="mt-3 rounded-xl border-2 border-red-300 dark:border-red-500/50 bg-red-50/60 dark:bg-red-950/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-red-700 dark:text-red-300">
          Payment discrepancies ({discrepancies.length}) — recorded type vs Square
        </span>
        <button
          type="button"
          onClick={onRefresh}
          className="text-[11px] text-red-600 dark:text-red-400 hover:underline"
        >
          Refresh
        </button>
      </div>
      <div className="mt-2 space-y-1.5">
        {discrepancies.map((r) => {
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
                  onClick={() => onConfirm(r)}
                  className="ml-1 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-0.5 text-[11px] font-medium disabled:opacity-50"
                >
                  Confirm {r.actual_type === "debit" ? "Debit" : "Credit"}
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
    </div>
  );
}