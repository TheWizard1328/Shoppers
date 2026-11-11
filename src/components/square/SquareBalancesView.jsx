import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAppSettingRows, getFreshAppSettingRows } from '@/components/utils/appSettingsCache';
import { base44 } from "@/api/base44Client";
import { offlineDB } from '@/components/utils/offlineDatabase';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshCw, Wallet, Landmark, PiggyBank, Receipt, ArrowLeftRight, CreditCard, Loader2, BarChart3, UserRound, ChevronDown, PenLine, StickyNote } from "lucide-react";
import StoreFeesByDay from "./StoreFeesByDay";
import { toast } from "sonner";
import { isAppOwner, userHasRole } from "@/components/utils/userRoles";
import { edmontonBusinessDayKey, edmontonWallString, parseAnyTimestamp } from "@/components/utils/albertaTime";
import { changeCodTender, refundCodDelivery } from "./codTenderActions";
import { buildStoreToLocMap, computeWeeklyCodTotalsByStore, weeklyAvgByLocFromStores, getBalanceLevel, BALANCE_LEVELS, computeCodOutstandingDetailed, loadCardPayouts, loadCardTopups, loadDeliveryCardCredits, computeNetCollected, DEFAULT_FOLDER_RATE, payoutsByLocation, computePendingCodDeduction, estimateCardFeeCents, folderCentsFor, markFailedCodRefunded, invalidateIdbReadCache, invalidateServerOverlay, sendFailedRefundAlerts, getAllDeliveriesIdb, publishFromBalancesPage, healDeliveryMirror } from "./useSquareBalancesSummary";
import { getSummarySnapshot, deserializeSummary } from "./squareBalancesOfflineManager";
import { fetchLatestSharedSnapshot, subscribeSharedSnapshot } from "./squareBalancesSharedSnapshot";
import { invalidateLedgerWindows } from "./useSquareBalancesSummary";
import { EDITOR_HOST_DEVICE_NAME, getCurrentDevice } from "@/components/utils/deviceManager";
import PaymentDiscrepanciesList from "./PaymentDiscrepanciesList";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

/**
 * SquareBalancesView — owner-only estimated balance tracker (prototype, Oct 2026).
 *
 * Tracks, per Square location (OWNER SPEC, Oct 7 2026 — STRICTLY DELIVERY DATA):
 *   - Card balance estimate: starting balance + Σ(finished delivery's Debit/Credit
 *     cod_payment − fee (rate sheet) − loan% − folder 2%) − bank sweeps − pending COD deductions
 *   - Loan remaining: starting loan − Σ(loan_rate × card payment)
 *   - Folder (savings) total: Σ(2% × card payment) since last true-up
 *
 * Data sources:
 *   - AppSettings 'square_balances': { trued_up_at, folder_rate, locations: [{location_id, name, card_start, loan_start, loan_rate, folder_start}] }
 *   - Delivery.cod_payments — the single authority for what was collected and how
 *     (Debit/Credit/Cash/Cheque). Active pending/in_transit/en_route CODs list as
 *     Uncollected with the Card Spend pill; FINISHED deliveries calculate the money
 *     back onto the card and badge Debit/Cash/Credit in Collected.
 *   - SquareLedgerEntry: ONLY cached BATCH payout (bank sweep) + card topup rows.
 *     NO Square API sync on this page anymore — the ledger only ever held half
 *     the collections (broken link chains, pending entries, unlinked rings).
 *
 * The loan repayment and folder contribution are NOT exposed by Square's API — they are
 * computed here from owner-supplied rates. Numbers drift with any off-card spending; the
 * true-up form resets the starting points from real Square dashboard numbers.
 */

const SETTING_KEY = 'square_balances';
// Owner-requested manual Card Spend marks (Oct 6 2026): Square's card-activity
// feed (negative spends at the pharmacy, e.g. -$49.98 Shoppers Drug Mart
// "Inventory") has NO public API — the entry never reaches the Payments/
// Orders/Payouts endpoints the sync pulls, so an auto badge can't fire until
// it settles into a real Square payment. This record stores owner-marked
// confirmations: { [delivery_id]: { at: ISO, by: user_id } }.
const SPEND_MARKS_KEY = 'square_card_spend_marks';
// DEFAULT_FOLDER_RATE + fee-sheet math now come from useSquareBalancesSummary.

const fmtMoney = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;


function daysSince(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

// ── ACTIVE CATALOG SWEEP CACHE (owner report Nov 6 2026) ────────────────────
// computeCatalogUncollected pages SquareCatalogItems 500 at a time (up to 40
// pages) and then pulls Store.list() + Patient.list() uncached, and it re-ran
// on app load, on every balances compute and on every catalog/delivery
// websocket echo — a rate-limit volley that could fire several times a minute
// while nothing had actually changed. The sweep is now reused for 90s and
// invalidated by the catalog subscription.
const CATALOG_SWEEP_TTL_MS = 90 * 1000;
let _catalogSweep = { at: 0, rows: null };
const invalidateCatalogSweep = () => {_catalogSweep = { at: 0, rows: null };};

// Fallback when a SquareCatalogItems row has no patient_id (older rows created
// by a path that didn't persist it — Oct 2 2026 report: name shows briefly
// then flips to "COD" once the catalog list loads and replaces the
// delivery-derived rows that DID have a resolvable name). The name is always
// baked into description at creation time ("COD for <name> | Delivery <id>"),
// so extract it from there instead of returning null.
function extractNameFromCatalogDescription(description) {
  const m = /^COD for (.+?) \| Delivery/.exec(String(description || ''));
  return m ? m[1].trim() : null;
}

// Square catalog item_name follows "MM/DD(ABBREV)-Patient Name" (see
// formatItemName in squareCodHelpers). The store abbreviation in parentheses and
// the leading Month/Day are the source of truth for the store badge and the
// today-vs-past bucketing when a catalog row has no resolvable store_id or
// delivery_date (owner report Oct 8 2026: Past uncollected rows lost their
// store badge and landed in the wrong section).
function parseCatalogItemName(raw) {
  const m = String(raw || '').match(/^\s*(\d{1,2})\/(\d{1,2})\s*\(([^)]+)\)\s*-\s*(.+)$/);
  if (!m) return null;
  return { month: m[1], day: m[2], abbrev: m[3].trim(), patientName: m[4].trim() };
}
function catalogDateFromName(parsed, todayStr) {
  if (!parsed) return null;
  const year = Number(todayStr.slice(0, 4));
  const mm = String(parsed.month).padStart(2, '0');
  const dd = String(parsed.day).padStart(2, '0');
  const todayMd = todayStr.slice(5);
  // A month/day later than today's is almost certainly last year's uncollected
  // COD carrying over — roll it back a year so it sorts into Past uncollected
  // instead of reading as a future date.
  return `${mm}-${dd}` > todayMd ? `${year - 1}-${mm}-${dd}` : `${year}-${mm}-${dd}`;
}

// Delivery only stores patient_id (no patient_name field) — resolve the real
// name from the Patient entity, same dual-key lookup used across the app
// Ledger rows are keyed on square_id upstream, but a mid-storm sync once
// left duplicate rows (each copy re-counting amount AND fee). Every ledger
// read on this page goes through this guard: one row per square_id.
function dedupeLedgerById(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const key = r?.square_id || r?.id || null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// (patient_id can match either Patient.id or Patient.patient_id).
function buildPatientResolver(patientsRaw) {
  const byId = new Map();
  const byPid = new Map();
  (patientsRaw || []).forEach((p) => {
    if (p?.id) byId.set(String(p.id), p);
    if (p?.patient_id) byPid.set(String(p.patient_id), p);
  });
  return (patientId) => {
    if (!patientId) return null;
    const key = String(patientId);
    return byId.get(key) || byPid.get(key) || null;
  };
}

// Owner-only COD list at the bottom of each card. Rows use the SAME format as
// the Square catalog items list (name + subtext, bold amount, Collected/Pending
// pill). Three levels, top to bottom: collected today, uncollected (today +
// future-dated pending CODs), past uncollected.
// Two stacked pills per row (owner, Oct 2 2026): the TOP "Card Spend" pill
// appears only when the delivery has a real CARD swipe in the Square
// transaction data — the store actually paid it onto the app card — and the
// BOTTOM pill is the collection status (Collected / Pending / Awaiting
// Pickup). pendingPickup rows previously used the sky "Card Spend" pill as a
// status; that wording now belongs to the transaction-evidence pill, so
// their status pill reads "Awaiting Pickup".
// COMBINED-SWIPE SUPPORT (owner rule Oct 9 2026): proportional largest-
// remainder split of one swipe's fee/loan/folder cents across the combined
// items so the parts sum EXACTLY to the whole (same pattern as the ledger
// ring split in squareLedgerSync).
function splitSwipeCents(total, weights) {
  const w = weights.map((x) => Math.max(0, Number(x) || 0));
  const sum = w.reduce((a, b) => a + b, 0);
  const totalC = Math.round(Number(total) || 0);
  if (sum <= 0 || totalC === 0) return w.map(() => 0);
  const raw = w.map((x) => totalC * x / sum);
  const base = raw.map(Math.floor);
  let left = totalC - base.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {if (left <= 0) break;base[i] += 1;left -= 1;}
  return base;
}

function CardCodList({ sections, canMarkSpend, onMarkSpend, onMarkRefunded, onCashToCard, onRefundCod, loading, isOwner = true, combineCandidates = null, locationOrder = [], cardLocId = null,
  // ADMIN NOTES (owner request Nov 3 2026): a pen on every delivery item card
  // opens a note dialog that saves to that balance item, and a note-paper icon
  // appears when the DRIVER left a note on the delivery (tapping shows it).
  canEditNotes = false, balanceNotesById = {}, driverNotesById = {}, onEditNote = null, onViewDriverNote = null }) {
  // OWNER SPEC (Oct 8 2026, night): a 'Cash' badge on a COLLECTED row OR an
  // uncollected cash-awaiting-square row is clickable — the owner can
  // correct the recorded tender to Debit or Credit (which re-does the
  // fee/settled math and appends the "Paid Via Drivers [Debit/Credit]
  // card." note).
  const [cashPick, setCashPick] = useState(null); // { row, x, y, anchorBottom }
  const [cashPickBusy, setCashPickBusy] = useState(false);
  const hasRows = !!(sections && sections.some((s) => s.rows.length > 0));
  // Loading placeholder: show the three section headers (Collected today /
  // Uncollected / Past uncollected) with a spinner while the delivery + COD
  // data is still being fetched, so the user knows more data is coming shortly.
  if (!hasRows && loading) {
    return (
      <div className="pt-2 mt-2 border-t border-slate-100 dark:border-slate-800 space-y-2">
        <div className="flex items-center gap-2 text-slate-400 dark:text-slate-500 text-[13px] py-1">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading COD data…
        </div>
        {(sections || []).map((sec) =>
        <div key={sec.label} className="space-y-1">
            <div className="flex items-center justify-between font-medium text-[13px]">
              <span style={{ color: sec.color }}>{sec.label}</span>
              <span className="text-slate-400 dark:text-slate-500 tabular-nums">…</span>
            </div>
            <div className="text-slate-300 dark:text-slate-600 text-[13px]">Loading…</div>
          </div>
        )}
      </div>);
  }
  if (!hasRows) return null;
  return (
    <div className="pt-2 mt-2 border-t border-slate-100 dark:border-slate-800 space-y-2">
      {sections.map((sec) => {
        // DAY FEES (owner spec Nov 10 2026): the section header carries the
        // day's total fees, centred between the section label and the
        // "count · amount" summary. Only rows that actually store fee parts
        // (card tenders) contribute.
        const feeTotal = isOwner ? (sec.rows || []).reduce((acc, fr) => {
          if (!fr?.feeParts) return acc;
          acc.fee += Number(fr.feeParts.fee) || 0;
          acc.folder += Number(fr.feeParts.folder) || 0;
          acc.loan += Number(fr.feeParts.loan) || 0;
          return acc;
        }, { fee: 0, folder: 0, loan: 0 }) : null;
        const hasFeeTotal = !!feeTotal && (feeTotal.fee > 0 || feeTotal.folder > 0 || feeTotal.loan > 0);
        return (
          <div key={sec.label} className="space-y-1">
          <div className="flex items-center justify-between gap-2 font-medium text-[13px]">
            <span className="shrink-0" style={{ color: sec.color }}>{sec.label}</span>
            {hasFeeTotal &&
              <span className="flex-1 min-w-0 text-center tabular-nums text-[11px] text-slate-500 dark:text-slate-400 truncate">
              S: {feeTotal.fee.toFixed(2)} · F: {feeTotal.folder.toFixed(2)} · L: {feeTotal.loan.toFixed(2)}
            </span>}
            <span className="text-slate-400 tabular-nums shrink-0">{sec.rows.length} · {fmtMoney(sec.total)}</span>
          </div>
          {sec.rows.length === 0 && <div className="text-slate-400 text-[13px]">none</div>}
          {sec.rows.map((r) => {
              // Owner spec (Oct 5 2026): left side is identity (name+store on
              // top, date/time below); right side is a 2x2 value/badge grid so
              // every number and pill stays lined up on the far right —
              // row 1 = amount to collect + Card Spend flag, row 2 = (once
              // collected) the net amount returned to the card + the status
              // badge, whose word itself names the real tender (Cash / Debit /
              // Credit). Cash never shows a net amount — no card fees applied.
              // Cash-already-collected rows (owner spec, Oct 6 2026): the
              // catalog item deliberately stays alive after a cash collection
              // until the deposit is processed back to the Square card — so the
              // row stays in Uncollected / Past uncollected, but its status
              // pill reads 'Cash' (emerald, same as a collected Cash row) so it
              // looks visibly different from a COD nobody has collected yet
              // (amber 'Pending'). Card Spend pills still render on these rows.
              // OWNER SPEC (Oct 8 2026): pending-status rows read 'Awaiting Pickup';
              // in_transit rows read 'In Transit'; FAILED deliveries read a red
              // 'Failed' badge — the COD stays in Uncollected and stays deducted off
              // the card until a Square refund is registered (owner rule: a failed
              // delivery must NOT put the amount back on the card); everything else
              // uncollected stays 'Pending' (e.g., en_route, catalog rows without
              // status).
              const statusLabel = r.collected ?
              r.collectedLabel || 'Collected' :
              r.cashAwaitingSquare ? 'Cash' : r.failed ? 'Failed' : r.pendingPickup ? 'Awaiting Pickup' : r.inTransit ? 'In Transit' : 'Pending';
              const emeraldCls = 'bg-emerald-100 dark:bg-emerald-900/30 border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300';
              const redCls = 'bg-red-100 dark:bg-red-900/30 border-red-300 dark:border-red-700 text-red-700 dark:text-red-300';
              const roseCls = 'bg-rose-100 dark:bg-rose-900/30 border-rose-300 dark:border-rose-700 text-rose-700 dark:text-rose-300';
              const statusColorCls = r.collected ?
              statusLabel === 'Refunded' ? roseCls : emeraldCls :
              r.cashAwaitingSquare ? emeraldCls : r.failed ? redCls : 'bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300';
              const showNetAmount = r.collected && statusLabel !== 'Cash' && statusLabel !== 'Refunded' && r.netAmount != null;
              // OWNER LAYOUT (Oct 22 2026): ONE ROW PER COD ITEM — store badge,
              // patient name, amount, Card Spend badge per row, exactly like the
              // original layout; a combined swipe simply adds one row per included
              // COD. ONE final footer row per transaction: time | S/F/L fees |
              // settled net | tender badge (combined cards carry the transaction's
              // true summed fees). No x2·1-swipe chip (owner: "without the new
              // purple badge").
              const combinedList = Array.isArray(r.combinedItems) && r.combinedItems.length > 1;
              const rowItems = combinedList ?
              r.combinedItems :
              [{ storeAbbrev: r.storeAbbrev, storeColor: r.storeColor, patientName: r.patientName, amount: r.amount, sub: r.sub }];
              const spendPill =
              r.collected ? (r.hasCardSpend || r.manualCardSpend || r.notTapped) && canMarkSpend && !!r.delivery_id && onMarkSpend ?
              // COLLECTED rows toggle exactly like uncollected ones (owner
              // rule Nov 3 2026: "I need to still be able to click the Card
              // Spend badges for Collected Today items to change them to
              // Not Tapped"). No role="button" - same 44px min-height trap.
              <span
                onClick={() => onMarkSpend(r.delivery_id)}
                title={r.notTapped ? 'Mark this COD as tapped in your Square app (Card Spend)' : 'Mark this collected COD as Not Tapped in your Square app'}
                className={r.notTapped ?
                "cursor-pointer rounded-full bg-violet-100 dark:bg-violet-900/30 border border-violet-300 dark:border-violet-700 px-2 py-1 text-[11px] font-medium text-violet-700 dark:text-violet-300 text-center leading-none min-w-[80px]" :
                "cursor-pointer rounded-full bg-sky-100 dark:bg-sky-900/30 border border-sky-300 dark:border-sky-700 px-2 py-1 text-[11px] font-medium text-sky-700 dark:text-sky-300 text-center leading-none min-w-[80px]"}>
                    {r.notTapped ? 'Not Tapped' : 'Card Spend'}</span> :
              r.hasCardSpend ?
              <span className="rounded-full bg-sky-100 dark:bg-sky-900/30 border border-sky-300 dark:border-sky-700 px-2 py-1 text-[11px] font-medium text-sky-700 dark:text-sky-300 text-center leading-none min-w-[80px]">Card Spend</span> :
              r.manualCardSpend ?
              <span className="rounded-full bg-violet-100 dark:bg-violet-900/30 border border-violet-300 dark:border-violet-700 px-2 py-1 text-[11px] font-medium text-violet-700 dark:text-violet-300 text-center leading-none min-w-[80px]">Card Spend</span> :
              canMarkSpend && !!r.delivery_id && !(r.collected && statusLabel === 'Cash') && onMarkSpend ?
              <span
                onClick={() => onMarkSpend(r.delivery_id)}
                title="Mark this COD as having a Card Spend in your Square app"
                // NOTE (Oct 6 2026): deliberately NO role="button" here —
                // src/index.css has a global accessibility rule,
                // [role="button"] { min-height: 44px }, that forced this
                // pill to a tap-target height far taller than every other
                // badge on the row. Plain onClick on a bare span keeps it
                // visually identical to the Pending/Collected/Card Spend
                // pills (same classes), just clickable.
                className="cursor-pointer rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-600 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 text-center leading-none min-w-[60px]">
                    Mark Spend</span> :
              null :
              // UNCOLLECTED rows (owner spec Oct 6 2026): the pill is a
              // toggle — every COD defaults to "Card Spend"; tapping it
              // flips to "Not Tapped" (the COD is added back to the card
              // balance), tapping again flips back. Owner-only tappable;
              // drivers see the static state.
              canMarkSpend && !!r.delivery_id && onMarkSpend ?
              <span
                onClick={() => onMarkSpend(r.delivery_id)}
                className={r.notTapped ?
                "cursor-pointer rounded-full bg-violet-100 dark:bg-violet-900/30 border border-violet-300 dark:border-violet-700 text-[11px] font-medium text-violet-700 dark:text-violet-300 text-center leading-none px-2 py-1 min-w-[80px]" :
                "cursor-pointer rounded-full bg-sky-100 dark:bg-sky-900/30 border border-sky-300 dark:border-sky-700 text-[11px] font-medium text-sky-700 dark:text-sky-300 text-center leading-none px-2 py-1 min-w-[80px]"}>
                    {r.notTapped ? 'Not Tapped' : 'Card Spend'}</span> :

              <span className={r.notTapped ?
              'rounded-full bg-violet-100 dark:bg-violet-900/30 border border-violet-300 dark:border-violet-700 px-2 py-1 text-[11px] font-medium text-violet-700 dark:text-violet-300 text-center leading-none min-w-[80px]' :
              'rounded-full bg-sky-100 dark:bg-sky-900/30 border border-sky-300 dark:border-sky-700 px-2 py-1 text-[11px] font-medium text-sky-700 dark:text-sky-300 text-center leading-none min-w-[80px]'}>
                    {r.notTapped ? 'Not Tapped' : 'Card Spend'}</span>;
              const statusBadge =
              r.failed && !r.collected && canMarkSpend && !!r.delivery_id && onMarkRefunded ?
              <span
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const below = window.innerHeight - rect.bottom > 150;
                  // OWNER SPEC (Nov 10 2026): a failed delivery's badge opens
                  // the same Set tender menu so it can become Debit, Credit or
                  // Refunded — it no longer jumps straight to the refund mark.
                  setCashPick({ row: r, label: 'Failed', kind: 'failed', cashRows: [], tappedLocId: cardLocId, sel: {}, x: rect.left, y: below ? rect.bottom + 6 : rect.top, anchorBottom: !below });
                }}
                title="Tap to set this failed COD to Debit, Credit or Refunded"
                // No role="button" (same min-height CSS trap as the pills).
                className={`cursor-pointer rounded-full border px-2 font-medium text-[11px] text-center leading-none min-w-[80px] py-1 ${statusColorCls} ring-1 ring-red-400/60 dark:ring-red-500/50`}>{statusLabel}</span> :
              (r.collected || r.cashAwaitingSquare) && ['Cash', 'Debit', 'Credit'].includes(statusLabel) && canMarkSpend && !!r.delivery_id && onCashToCard ?
              <span
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const below = window.innerHeight - rect.bottom > 150;
                  // COMBINE INTO ONE SWIPE (owner rule Oct 9 2026): other
                  // same-store, same-day cash-collected items can join
                  // this conversion as ONE swipe — fees/loan/folder are
                  // computed on the swipe TOTAL (owner report: marking
                  // $1.18 and $28.36 separately charged the flat $0.07
                  // twice and left the settled amount off by $0.05).
                  // COMBINE CANDIDATES (owner rule Oct 9 2026): the
                  // checkbox list is every UNCOLLECTED item on the card —
                  // but ONE swipe runs on ONE physical card, so candidates
                  // are limited to the TAPPED card (owner correction Oct 9
                  // 23:44: combining across different cards is impossible
                  // at the POS anyway).
                  const candSrc = Array.isArray(combineCandidates) && combineCandidates.length ?
                  combineCandidates :
                  (sections || []).flatMap((sec) => (sec?.rows || []).filter((x) => x && x.cashAwaitingSquare));
                  const cashRows = statusLabel === 'Cash' ?
                  candSrc.filter((x) => x && !!x.delivery_id && String(x.delivery_id) !== String(r.delivery_id) && String(x.locId || cardLocId || '') === String(cardLocId || '')) : [];
                  setCashPick({ row: r, label: statusLabel, kind: 'cash', cashRows, tappedLocId: cardLocId, sel: {}, x: rect.left, y: below ? rect.bottom + 6 : rect.top, anchorBottom: !below });
                }}
                title="Tap to change this tender (Debit / Credit / Cash)"
                // No role="button" (same min-height CSS trap as the pills).
                className={`cursor-pointer rounded-full border px-2 font-medium text-[11px] text-center leading-none min-w-[80px] py-1 ${statusColorCls} ring-1 ${statusLabel === 'Cash' ? 'ring-emerald-400/60 dark:ring-emerald-500/50' : 'ring-sky-400/60 dark:ring-sky-500/50'}`}>{statusLabel}</span> :

              <span className={`rounded-full border px-2 font-medium text-[11px] text-center leading-none min-w-[80px] py-1 ${statusColorCls}`}>{statusLabel}</span>;
              return (
                <div key={r.key} className="flex flex-col gap-1.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-2.5 py-1.5">
              {rowItems.map((it, iIdx) =>
                  <div key={iIdx} className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0 my-1">
                  <span
                        className="text-[9px] font-bold leading-none px-1.5 py-0.5 rounded-full text-white flex-shrink-0"
                        style={{ backgroundColor: it.storeColor || '#64748b' }}>
                    {it.storeAbbrev || '—'}
                  </span>
                  <p className="font-semibold leading-4 text-slate-900 dark:text-slate-50 text-[13px] truncate flex-1 min-w-0">{it.patientName || 'COD'}</p>
                </div>
                <div className="shrink-0 flex items-center gap-1.5">
                  {canEditNotes && r.delivery_id &&
                      <button
                        type="button"
                        onClick={(e) => {e.stopPropagation();onEditNote?.(r);}}
                        title={balanceNotesById?.[String(r.delivery_id)]?.note ? `Note: ${balanceNotesById[String(r.delivery_id)].note}` : 'Add a note to this COD'}
                        className={`shrink-0 w-6 h-6 rounded-md border flex items-center justify-center transition-colors ${balanceNotesById?.[String(r.delivery_id)]?.note ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400' : 'border-transparent text-slate-400 dark:text-slate-500 hover:border-slate-300 dark:hover:border-slate-600 hover:text-slate-700 dark:hover:text-slate-200'}`}>
                    <PenLine className="w-3.5 h-3.5" />
                  </button>
                      }
                  {r.delivery_id && driverNotesById?.[String(r.delivery_id)] &&
                      <button
                        type="button"
                        onClick={(e) => {e.stopPropagation();onViewDriverNote?.(r, driverNotesById[String(r.delivery_id)]);}}
                        title="Driver note on this delivery"
                        className="shrink-0 w-6 rounded-md border border-sky-300 dark:border-sky-700 bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400 flex items-center justify-center h-3">
                    <StickyNote className="w-3.5 h-3.5" />
                  </button>
                      }
                  <span className="text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{fmtMoney(it.amount)}</span>
                  {combinedList ?
                      <span className="rounded-full bg-sky-100 dark:bg-sky-900/30 border border-sky-300 dark:border-sky-700 px-2 py-1 text-[11px] font-medium text-sky-700 dark:text-sky-300 text-center leading-none min-w-[80px]">Card Spend</span> :
                      spendPill}
                </div>
              </div>
                  )}
              {/* FINAL ROW — one per transaction: time, combined fee breakdown, settled net, tender badge */}
              <div className="flex items-center justify-between text-lg gap-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[13px] text-slate-500 dark:text-slate-400 tabular-nums shrink-0">{r.sub}</span>
                  {/* ASSIGNED DRIVER (owner request Nov 1 2026): the empty space
                           between the date and the status pill now names the driver
                           this COD is assigned to. Truncates on narrow cards so the
                           status pill keeps its place. */}
                  {r.driverName &&
                      <span
                        title={`Assigned to ${r.driverName}`}
                        className="inline-flex items-center gap-0.5 min-w-0 rounded-full border border-slate-200 dark:border-slate-600 bg-slate-100 dark:bg-slate-700/60 px-1.5 py-0.5 text-[11px] font-medium leading-none text-slate-600 dark:text-slate-300">
                    <UserRound className="w-3 h-3 shrink-0" />
                    <span className="truncate max-w-[76px]">{r.driverName}</span>
                  </span>}
                </div>
                <div className="flex items-center gap-1.5">
                  {showNetAmount &&
                      <span className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-400 text-[13px]">{fmtMoney(r.netAmount)}</span>}
                  {statusBadge}
                </div>
              </div>
              {/* FEE BREAKDOWN (owner spec Nov 10 2026): the Square fee / folder
                       / loan split is now its OWN last row on the card, spaced out
                       instead of being squeezed between the date and the net amount. */}
              {showNetAmount && isOwner && r.feeParts &&
                  <div className="flex items-center justify-center gap-2 text-[12px] tabular-nums text-slate-500 dark:text-slate-400">
                  <span>S: {r.feeParts.fee.toFixed(2)}</span>
                  <span className="text-slate-300 dark:text-slate-600">·</span>
                  <span>F: {r.feeParts.folder.toFixed(2)}</span>
                  <span className="text-slate-300 dark:text-slate-600">·</span>
                  <span>L: {r.feeParts.loan.toFixed(2)}</span>
                </div>}
            </div>);

            })}
        </div>);

      })}
      {/* Quick anchored popup (owner spec, Oct 8 2026 late): tapping a
              Cash badge opens the Debit / Credit choice as a small button menu
              right at the badge — below it when there's room, above when it sits
              near the bottom of the screen. Tap anywhere else to dismiss. */}
      {cashPick &&
      <>
        <div className="fixed inset-0 z-40" onClick={() => !cashPickBusy && setCashPick(null)} />
        <div
          className={`fixed z-50 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-2xl p-2 space-y-1 ${cashPick.cashRows && cashPick.cashRows.length ? 'w-60' : 'w-48'}`}
          style={{
            left: Math.max(8, Math.min(cashPick.x, window.innerWidth - (cashPick.cashRows && cashPick.cashRows.length ? 250 : 200))),
            top: cashPick.anchorBottom ? undefined : cashPick.y,
            bottom: cashPick.anchorBottom ? Math.max(8, window.innerHeight - cashPick.y + 6) : undefined
          }}>
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400 text-center">Set tender</div>
          <div className="grid grid-cols-2 gap-1.5">
            <Button size="sm" className="h-9 px-0" disabled={cashPickBusy || cashPick.label === 'Debit'} onClick={async () => {setCashPickBusy(true);try {const ids = Object.keys(cashPick.sel || {}).filter((k) => cashPick.sel[k]);await onCashToCard?.(cashPick.row.delivery_id, 'Debit', ids);setCashPick(null);} finally {setCashPickBusy(false);}}}>Debit</Button>
            <Button size="sm" className="h-9 px-0" disabled={cashPickBusy || cashPick.label === 'Credit'} onClick={async () => {setCashPickBusy(true);try {const ids = Object.keys(cashPick.sel || {}).filter((k) => cashPick.sel[k]);await onCashToCard?.(cashPick.row.delivery_id, 'Credit', ids);setCashPick(null);} finally {setCashPickBusy(false);}}}>Credit</Button>
            {/* Card -> Cash clears cod_card_spend_at + cod_confirmed_collected
                    (/_at) so the fee/loan/folder credit and ledger confirmation
                    stop counting it (owner rule Oct 9 2026). */}
            {cashPick.kind !== 'failed' &&
            <Button size="sm" className="h-9 px-0" variant="outline" disabled={cashPickBusy || cashPick.label === 'Cash'} onClick={async () => {setCashPickBusy(true);try {await onCashToCard?.(cashPick.row.delivery_id, 'Cash');setCashPick(null);} finally {setCashPickBusy(false);}}}>Cash</Button>}
            {/* Refunded (owner spec Nov 8 2026): clears the COD amount, collected
                 amount and Type, notes the refund, then refreshes the page. */}
            {/* Refunded — ONLY for a completed-as-cash COD or a failed delivery
                 (owner spec Nov 10 2026). A failed COD uses the failed-refund
                 mark (amount returns to the card balance); a cash COD uses the
                 full refund (amount + payments + stamps cleared). */}
            {(cashPick.kind === 'cash' || cashPick.kind === 'failed') &&
            <Button size="sm" className="h-9 px-0" variant="outline" disabled={cashPickBusy || (cashPick.kind === 'failed' ? !onMarkRefunded : !onRefundCod)} onClick={async () => {setCashPickBusy(true);try {
                if (cashPick.kind === 'failed') {await onMarkRefunded?.(cashPick.row.delivery_id);setCashPick(null);} else
                {const ok = await onRefundCod?.(cashPick.row.delivery_id);if (ok !== false) setCashPick(null);}
              } finally {setCashPickBusy(false);}}}>Refunded</Button>}
          </div>
          {cashPick.label === 'Cash' && (cashPick.cashRows || []).length > 0 &&
          <div className="pt-1 border-t border-slate-100 dark:border-slate-700 space-y-0.5">
            <div className="text-[10px] font-medium text-slate-400 text-center leading-tight">Combine into one swipe</div>
            {(() => {
              // GROUP BY CARD (owner request Oct 9 2026 night): one section per
              // Square card (Bonnie Doon / Callingwood / Londonderry ...) with
              // a divider + card-name header between sections. Section order
              // follows the page's card order; items without a known card go
              // last under 'Other'.
              const rows = cashPick.cashRows || [];
              const order = Array.isArray(locationOrder) ? locationOrder : [];
              const groups = new Map();
              rows.forEach((c) => {
                const k = c.locId || '__other';
                if (!groups.has(k)) groups.set(k, { name: c.locName || 'Other', items: [] });
                groups.get(k).items.push(c);
              });
              // TAPPED CARD FIRST (owner request Oct 9 23:38): the card whose
              // Cash badge was tapped lists first (tap a Callingwood row →
              // Callingwood deliveries on top), then the other cards in page
              // order.
              const tapped = cashPick.tappedLocId || null;
              const keys = [...groups.keys()].sort((a, b) => {
                if (tapped) {
                  if (a === tapped && b !== tapped) return -1;
                  if (b === tapped && a !== tapped) return 1;
                }
                const ia = order.indexOf(a),ib = order.indexOf(b);
                return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
              });
              return keys.map((k, gi) =>
              <div key={k} className={gi > 0 ? 'mt-1 pt-1 border-t border-slate-200 dark:border-slate-700' : ''}>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500 px-1">{groups.get(k).name}</div>
                  {groups.get(k).items.map((c) =>
                <div key={c.delivery_id}
                onClick={(e) => {e.stopPropagation();if (cashPickBusy) return;setCashPick((p) => p ? { ...p, sel: { ...(p.sel || {}), [c.delivery_id]: !(p.sel || {})[c.delivery_id] } } : p);}}
                className="flex items-center gap-1.5 px-1 py-0.5 rounded cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800">
                    <input type="checkbox" className="accent-emerald-600" readOnly checked={!!(cashPick.sel || {})[c.delivery_id]} />
                    {c.storeAbbrev && <span className="text-[9px] font-bold leading-none px-1 py-0.5 rounded-full text-white flex-shrink-0" style={{ backgroundColor: c.storeColor || '#64748b' }}>{c.storeAbbrev}</span>}
                    <span className="truncate flex-1 text-[11px] text-slate-600 dark:text-slate-300">{c.patientName || c.sub || 'COD'}</span>
                    <span className="tabular-nums text-[11px] font-medium text-slate-600 dark:text-slate-300">${Number(c.amount || 0).toFixed(2)}</span>
                  </div>
                )}
                </div>
              );
            })()}
            {(() => {
              const selRows = (cashPick.cashRows || []).filter((c) => (cashPick.sel || {})[c.delivery_id]);
              const total = [cashPick.row, ...selRows].reduce((sm, x) => sm + Number(x?.amount || 0), 0);
              return <div className="text-[10px] text-center text-slate-500 dark:text-slate-400 tabular-nums">Swipe total ${total.toFixed(2)}</div>;
            })()}
          </div>
          }
          <div className="text-center">
            <span className="text-[11px] text-slate-400 cursor-pointer select-none" onClick={() => !cashPickBusy && setCashPick(null)}>Cancel</span>
          </div>
        </div>
      </>
      }
    </div>);

}

export default function SquareBalancesView({ currentUser, visibleLocationIds = null }) {
  const [config, setConfig] = useState(null);
  const [configRecordId, setConfigRecordId] = useState(null);
  // OWNER SPEC (Oct 7 2026): card credits are computed STRICTLY from
  // finished deliveries' recorded Debit/Credit cod_payments (net of the fee
  // rate sheet + loan% + folder%) — the Square-ledger sale scan is retired
  // (it only ever held half the collections). Map(location_id →
  // { gross, fees, loan, folder, credits, count, lastAt }).
  const [deliveryCredits, setDeliveryCredits] = useState(new Map());
  const [payouts, setPayouts] = useState([]); // BATCH bank sweeps since true-up
  const [topups, setTopups] = useState([]); // card_topup transfers onto the Square Cards since true-up
  const [codOutstandingByLoc, setCodOutstandingByLoc] = useState({});
  const [localOutstanding, setLocalOutstanding] = useState(null); // client-side compute — freshest source
  // ADMIN NOTES on COD delivery items (owner request Nov 3 2026). Notes live in
  // their own entity (SquareBalanceNote) keyed by delivery_id — never on the
  // Delivery record, which would fire the COD refresh chain on every device.
  const [balanceNotesById, setBalanceNotesById] = useState({});
  const [noteTarget, setNoteTarget] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [driverNoteView, setDriverNoteView] = useState(null);
  const [codCollectedTodayByLoc, setCodCollectedTodayByLoc] = useState({}); // owner-only: today's collected CODs per card
  const [catalogUncollectedByLoc, setCatalogUncollectedByLoc] = useState(undefined); // owner-only: ACTIVE SquareCatalogItems = uncollected, all dates
  // RACE GUARD (Oct 6 2026, owner report: "Past Uncollected shows up then
  // disappears"). computeCatalogUncollected is triggered from several
  // places — initial mount, manual sync, Delivery WS (8s debounce), and
  // SquareCatalogItems WS (5s debounce) — and can run concurrently. If an
  // OLDER call (slower network, or a retry delay) resolves AFTER a NEWER
  // call, its stale/incomplete result stomps the fresh one. This sequence
  // counter ensures only the most-recently-STARTED call's result is ever
  // committed to state.
  const catalogUncollectedSeqRef = useRef(0);
  // FLICKER GUARD (Oct 6 2026, owner report persists after the sequence
  // guard fix: Past uncollected rows appear then disappear). The
  // SquareCatalogItems data itself can blip, a backend dedup/reconcile pass
  // can momentarily delete-then-recreate an item for the same delivery
  // (new row id, brief window where neither row matches status active), so
  // even a perfectly-ordered, non-racing recompute can legitimately fetch an
  // empty or missing row for a delivery that is still truly uncollected.
  // Track consecutive misses per delivery_id; only drop a row from the list
  // after it is missing on TWO CONSECUTIVE successful fetches (a real
  // collection or removal stays missing both times; a blip self-heals
  // within one cycle).
  const catalogMissStreakRef = useRef(new Map());
  // CARD-PAID FILTER (owner report Oct 26 2026: flipping Valerie Collins'
  // $15.11 Bonnie Doon COD from Cash to Debit moved the delivery into
  // Collected today but left its still-active Square register item merged
  // into Uncollected past with a 'Pending' badge). A delivery whose own
  // cod_payments carry a Debit/Credit entry is COLLECTED ON THE CARD — its
  // register item must not render as uncollected, no matter how long the
  // Square-side reconcile takes to retire it. Refreshed by the background
  // delivery pass in computeCatalogUncollected; consumed at list-build time
  // so a re-added active item can't flicker back in on later passes.
  const cardPaidDeliveryIdsRef = useRef(new Set());
  const catalogUncollectedByLocRef = useRef({});
  const [weeklyCodAvgByLoc, setWeeklyCodAvgByLoc] = useState({}); // 7-day avg daily CODs per card (excl. today)
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  // SYNC STATUS (owner request Oct 9 2026 night): live text shown just left of
  // the Refresh Square button — "Syncing Catalog Items. (Adding/Deleting
  // [name - $amount])" then "Syncing Square Balances."
  const [syncStatusText, setSyncStatusText] = useState('');
  const [showTrueUp, setShowTrueUp] = useState(false);
  const [trueUpDraft, setTrueUpDraft] = useState({});
  const [showTopUp, setShowTopUp] = useState(false);
  const [topUpDraft, setTopUpDraft] = useState({});
  // Funds transfer: move money from ONE card to another (owner-only).
  // transferFromLoc = full location object the button was clicked on.
  const [transferFromLoc, setTransferFromLoc] = useState(null);
  const [transferAmount, setTransferAmount] = useState('');
  const [transferToLocId, setTransferToLocId] = useState('');
  // Folder → card transfer (owner request, Oct 4 2026). One direction only:
  // money moves OUT of the shared folder ONTO a card — never card → folder.
  const [folderTransferOpen, setFolderTransferOpen] = useState(false);
  const [folderTransferAmount, setFolderTransferAmount] = useState('');
  const [folderTransferToLocId, setFolderTransferToLocId] = useState('');
  const trueUpPanelRef = useRef(null);
  const [isSaving, setIsSaving] = useState(false);
  const loadSeq = useRef(0);
  // Guards loadConfig() specifically: multiple call sites (mount, Refresh,
  // True-Up/Top-Up save, the AppSettings WS debounce) can all resolve out of
  // order on a slow connection. Without this, an OLDER in-flight fetch that
  // happens to finish LAST clobbers the page with the stale "base" true-up
  // snapshot it started with, undoing a fresher update that already landed
  // (Oct 1 2026 "replaced with the base True-Up data" report).
  const configLoadSeq = useRef(0);
  // Latest-handler refs for the WebSocket subscriptions (mounted once)
  const loadSalesRef = useRef(null);
  const syncRef = useRef(null);
  const configRef = useRef(null);
  const computeLocalOutstandingRef = useRef(null);
  const ownerCanEditRef = useRef(false);
  const loadDailyCodRef = useRef(null);
  const computeCodCollectedTodayRef = useRef(null);
  const computeCatalogUncollectedRef = useRef(null);

  const ownerCanEdit = !!(currentUser && isAppOwner(currentUser));
  // Notes are an ADMIN tool (owner request: "for Admin's"): app owner or an
  // AppUser carrying the admin role.
  const canEditBalanceNotes = !!(currentUser && (isAppOwner(currentUser) || userHasRole(currentUser, 'admin')));

  // Load every admin note once, then keep it fresh on other admins' saves.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const rows = await base44.entities.SquareBalanceNote.list('-updated_date', 1000, 0);
        if (cancelled) return;
        const map = {};
        for (const r of rows || []) {if (r?.delivery_id) map[String(r.delivery_id)] = r;}
        setBalanceNotesById(map);
      } catch {/* notes are best-effort — the page works without them */}
    };
    void load();
    let unsub = null;
    try {
      unsub = base44.entities.SquareBalanceNote.subscribe(() => {void load();});
    } catch {/* subscription is optional */}
    return () => {cancelled = true;try {unsub?.();} catch {/* noop */}};
  }, []);

  // Driver notes come straight off the COD items (delivery_notes), so no extra
  // delivery read is needed to know which rows wear the note-paper icon.
  const driverNotesById = useMemo(() => {
    const map = {};
    const scan = (locMap) => {
      for (const locId of Object.keys(locMap || {})) {
        const bucket = locMap[locId] || {};
        for (const arr of [bucket.items, bucket.cashItems, bucket.deductItems, bucket.legacyDeductItems]) {
          for (const it of arr || []) {
            const id = it?.delivery_id ? String(it.delivery_id) : null;
            if (id && it?.delivery_notes && !map[id]) map[id] = String(it.delivery_notes);
          }
        }
      }
    };
    scan(localOutstanding);
    scan(codOutstandingByLoc);
    return map;
  }, [localOutstanding, codOutstandingByLoc]);

  const saveBalanceNote = useCallback(async (target, text) => {
    const deliveryId = String(target?.delivery_id || '');
    if (!deliveryId) return;
    const existing = balanceNotesById[deliveryId] || null;
    const clean = String(text || '').trim();
    setNoteSaving(true);
    try {
      // Empty note + existing record = delete it (an empty note is no note).
      if (!clean && existing?.id) {
        await base44.entities.SquareBalanceNote.delete(existing.id);
        setBalanceNotesById((prev) => {const next = { ...prev };delete next[deliveryId];return next;});
        toast.success('Note removed');
        return true;
      }
      if (!clean) {return true;}
      const payload = {
        delivery_id: deliveryId,
        location_id: target?.cardLocId || null,
        patient_name: target?.patientName || null,
        note: clean,
        author_id: currentUser?.id || null,
        author_name: currentUser?.full_name || currentUser?.email || null
      };
      const saved = existing?.id ?
      await base44.entities.SquareBalanceNote.update(existing.id, payload) :
      await base44.entities.SquareBalanceNote.create(payload);
      setBalanceNotesById((prev) => ({ ...prev, [deliveryId]: { ...(existing || {}), ...payload, ...(saved || {}) } }));
      toast.success('Note saved');
      return true;
    } catch (e) {
      console.error('saveBalanceNote failed:', e);
      toast.error('Could not save the note');
      return false;
    } finally {
      setNoteSaving(false);
    }
  }, [balanceNotesById, currentUser]);
  // DRIVER SCOPE (owner rule Oct 9 2026): a driver only sees the delivery
  // items assigned to them — balance/card math stays global (it is the
  // store's real card money), only the row lists are scoped.
  const driverScopeId = !ownerCanEdit && currentUser?.id && userHasRole(currentUser, 'driver') ? String(currentUser.id) : null;
  // null = show every card (admins/owner); array = only these cards (drivers see the
  // cards assigned to their stores for the current date).
  const restricted = Array.isArray(visibleLocationIds);

  // ── PAYMENT DISCREPANCIES (owner spec Oct 9 2026 night) ──────────────────
  // The backend Square Balances updater (squareBalancesCompute) compares every
  // recorded COD collection type against what Square actually saw (60-day
  // window) and writes action='discrepancy' records here. The viewer below is
  // ALWAYS visible while open discrepancies exist; the owner CONFIRMS a
  // record to apply the recorded→actual type fix (with the normal
  // fee/loan/folder math) or DISMISSES it after review. No auto-updates of
  // the in-app collection type happen anywhere — detection only flags.
  const [paymentDiscrepancies, setPaymentDiscrepancies] = useState([]);
  // OWNER FEATURE (Oct 27 2026): per-card Fees-by-day panel toggle - one card open at a time.
  const [feesByDayLoc, setFeesByDayLoc] = useState(null);
  // 'month' = single-month day table, 'year' = full-year month-by-month graph
  // (owner spec Oct 28 2026) — toggle sits in the dialog header top-right.
  const [feesViewMode, setFeesViewMode] = useState('month');
  const [discrepancyBusy, setDiscrepancyBusy] = useState(false);
  const loadPaymentDiscrepancies = useCallback(async () => {
    try {
      const rows = await base44.entities.CodBadgeChangeLog.filter({ action: 'discrepancy', status: 'open' }, '-changed_at', 100, 0);
      setPaymentDiscrepancies(Array.isArray(rows) ? rows : []);
    } catch (_) {/* entity/filter not available on this env */}
  }, []);
  useEffect(() => {if (ownerCanEdit) loadPaymentDiscrepancies();}, [ownerCanEdit, loadPaymentDiscrepancies]);

  const loadConfig = useCallback(async () => {
    const seq = ++configLoadSeq.current;
    const rows = await getAppSettingRows(SETTING_KEY);
    const rec = (rows || [])[0];
    const value = rec?.setting_value?.locations?.length ? rec.setting_value : null;
    // A newer loadConfig() call already started (and will apply its own,
    // fresher result) — discard this older one instead of overwriting state.
    if (seq !== configLoadSeq.current) return value;
    if (value) {
      setConfig(value);
      setConfigRecordId(rec.id);
      return value;
    }
    setConfig(null);
    setConfigRecordId(rec?.id || null);
    return null;
  }, []);

  // ── Manual Card Spend marks (owner spec Oct 6 2026) ──
  const [manualSpendMarks, setManualSpendMarks] = useState({});
  const manualSpendMarksRef = useRef({});
  const spendMarksRecordIdRef = useRef(null);
  const spendMarksSeq = useRef(0);
  const loadSpendMarks = useCallback(async () => {
    const seq = ++spendMarksSeq.current;
    // FRESH read (bypasses the 60s app-settings cache): a cached read here
    // served the PRE-toggle value when the write's WS echo reloaded the marks,
    // reverting the owner's badge flip (Oct 6 2026 "2 clicks" bug).
    const rows = await getFreshAppSettingRows(SPEND_MARKS_KEY);
    if (seq !== spendMarksSeq.current) return;
    // Defensive: duplicate records with this setting_key have existed —
    // always read the most recently updated one.
    const rec = (rows || []).filter(Boolean).sort((a, b) => String(b?.updated_date || '').localeCompare(String(a?.updated_date || '')))[0];
    const raw = rec?.setting_value && typeof rec.setting_value === 'object' ? rec.setting_value : {};
    // Oct 7 2026: normalize to { [deliveryId]: { notTapped, touchedAt, by } }.
    // touchedAt is kept even when the owner clicks BACK to Card Spend — the
    // deduction rule needs to know an item was explicitly clicked since
    // True-Up, not just its current state. Legacy {notTappedAt} entries
    // (pre-touch-tracking) normalize to notTapped:true.
    const value = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!v || typeof v !== 'object') continue;
      if (v.notTappedAt) value[k] = { notTapped: true, touchedAt: v.notTappedAt, by: v.by };else
      if (v.touchedAt) value[k] = { notTapped: !!v.notTapped, touchedAt: v.touchedAt, by: v.by };
    }
    spendMarksRecordIdRef.current = rec?.id || null;
    setManualSpendMarks(value);
    manualSpendMarksRef.current = value;
    // Collected-today rows embed manualCardSpend at COMPUTE time (unlike the
    // inline-built uncollected rows which read the ref at render) — rerun the
    // compute so a fresh mark (local tap or WS from another device) shows on
    // those rows immediately.
    computeCodCollectedTodayRef.current?.();
  }, []);
  // OWNER SPEC (Oct 6 2026): the Card Spend pill is now a TOGGLE. Every
  // uncollected COD defaults to "Card Spend" (we assume the store's card gets
  // charged — Square's card-activity feed was too unreliable to auto-detect).
  // Tapping flips it to "Not Tapped"; tapping again flips back to "Card
  // Spend". Balance rule: a pending/in-transit COD deducts from the card
  // estimate, a "Not Tapped" one is added back (never deducts).
  // OWNER SPEC (Oct 8 2026, night): correct a cash-collected completed COD to
  // Debit or Credit. Rewrites the delivery's cod_payments (cash → chosen
  // type), appends "Paid Via Drivers [Debit/Credit] card." to the delivery
  // note, and lets the existing fee/settled math take over — a Debit/Credit
  // payment automatically accrues Square fee + loan% + folder% in Collected
  // today, loadDeliveryCardCredits (card estimate), loan remaining and the
  // folder total.
  // REFUNDED TENDER (owner spec Nov 8 2026): 4th option in the Set tender popup.
  // The customer's COD money was handed back, so the delivery no longer owes or
  // holds a COD: clear the amount to collect, the collected payments (amount +
  // Type) and every collection stamp, add the audit note, then refresh the page.
  // Distinct from markFailedCodRefunded (failed COD returned to the card balance).
  // OWNER SPEC (Oct 8 2026, night): correct a cash-collected completed COD to
  // Debit or Credit. OWNER SPEC (Nov 8 2026): Refunded is a 4th tender in the
  // Set tender popup. Both writes now live in the shared codTenderActions module
  // so the Square COD page's Deliveries tab runs the exact same math.
  const refundCod = useCallback(async (deliveryId) => {
    const res = await refundCodDelivery({ deliveryId });
    if (!res.ok) {toast.error(res.message);return false;}
    toast.success(res.message);
    await syncRef.current?.();
    return true;
  }, []);

  const cashToCardSyncTimerRef = useRef(null);
  const cashToCard = useCallback(async (deliveryId, newType, combineIds = []) => {
    const res = await changeCodTender({ deliveryId, toType: newType, combineIds, config });
    if (!res.ok) {toast.error(res.message);return false;}
    toast.success(res.message);
    // Recompute the collected rows, balance estimate (fees/net) and the
    // outstanding lists from the updated delivery.
    computeCodCollectedTodayRef.current?.();
    refreshDeliveryCreditsRef.current?.();
    computeLocalOutstandingRef.current?.();
    computeCatalogUncollectedRef.current?.();
    // Square sync runs on the same 20s debounce as a card-collected WS event;
    // the local recomputes above already refresh the fees immediately.
    clearTimeout(cashToCardSyncTimerRef.current);
    cashToCardSyncTimerRef.current = setTimeout(() => {syncRef.current?.();}, 20000);
    return true;
  }, [config]);

  // PAYMENT DISCREPANCY CONFIRM (owner spec Oct 9 2026 night): applies the
  // recorded→actual tender fix with the normal fee/loan/folder math.
  //   cash_swiped   → the standard Cash→Debit/Credit conversion (cashToCard)
  //   type_mismatch → retype the card payment + recompute its stored cents
  //   mixed_tenders / missing_payment → not confirmable (review + Dismiss)
  const fixTenderType = useCallback(async (deliveryId, actualType) => {
    const toType = String(actualType || '').toLowerCase() === 'debit' ? 'Debit' : 'Credit';
    try {
      const rows = await base44.entities.Delivery.filter({ id: String(deliveryId) }, undefined, 1, 0).catch(() => []);
      const d = (rows || [])[0];
      if (!d) {toast.error('Could not find that delivery');return false;}
      const payments = Array.isArray(d.cod_payments) ? d.cod_payments : [];
      const storeToLoc = await buildStoreToLocMap().catch(() => new Map());
      const loanRateByLoc = new Map((config?.locations || []).map((l) => [String(l.location_id), Number(l.loan_rate) || 0]));
      const folderRateNow = Number.isFinite(Number(config?.folder_rate)) ? Number(config.folder_rate) : 0.02;
      const locId = storeToLoc.get(String(d.store_id || '')) || null;
      const loanRate = locId ? loanRateByLoc.get(String(locId)) || 0 : 0;
      let changed = false;
      const nextPayments = payments.map((p) => {
        if (!p || !['debit', 'credit'].includes(String(p?.type || '').toLowerCase())) return p;
        if (String(p?.type || '') === toType) return p;
        changed = true;
        const grossC = Math.round(Number(p.amount || 0) * 100);
        const feeC = estimateCardFeeCents(grossC, toType);
        const loanC = Math.round(grossC * loanRate);
        const folderC = folderCentsFor(grossC, folderRateNow);
        return { ...p, type: toType, fee_c: feeC, loan_c: loanC, folder_c: folderC, settled_c: Math.max(0, grossC - feeC - loanC - folderC) };
      });
      if (!changed) {toast.error(`Payment is already ${toType}`);return false;}
      const noteSuffix = `Tender corrected to ${toType} (payment discrepancy confirm).`;
      const existingNote = String(d.delivery_notes || '');
      const updatePayload = { cod_payments: nextPayments, delivery_notes: existingNote ? `${existingNote} ${noteSuffix}` : noteSuffix };
      await base44.entities.Delivery.update(String(d.id), updatePayload);
      await offlineDB.bulkSave(offlineDB.STORES.DELIVERIES, [{ ...d, ...updatePayload }]).catch(() => {});
      invalidateIdbReadCache('deliveries');
      toast.success(`Tender corrected to ${toType} — fee/loan/folder recalculated`);
      computeCodCollectedTodayRef.current?.();
      refreshDeliveryCreditsRef.current?.();
      computeLocalOutstandingRef.current?.();
      computeCatalogUncollectedRef.current?.();
      return true;
    } catch (e) {
      console.error('fixTenderType failed:', e);
      toast.error('Could not correct the tender');
      return false;
    }
  }, [config]);

  const confirmDiscrepancy = useCallback(async (rec, linkedDeliveryIds = []) => {
    if (!rec?.delivery_id || discrepancyBusy) return;
    setDiscrepancyBusy(true);
    try {
      const wanted = String(rec.actual_type || '').toLowerCase();
      const tender = wanted === 'debit' ? 'Debit' : 'Credit';
      // LINK AS ONE SWIPE (owner request Nov 5 2026): the Confirm Debit/Credit
      // button takes the other discrepancies the owner ticked, and the whole set
      // is applied as ONE card swipe — exactly the Cash badge popup flow on the
      // store cards. `cashToCard` already accepts extra delivery ids and splits
      // ONE swipe's fee/folder/loan cents across them.
      const extras = (Array.isArray(linkedDeliveryIds) ? linkedDeliveryIds : []).
      map((x) => String(x || '')).
      filter((x) => x && x !== String(rec.delivery_id));
      let ok = false;
      if (rec.discrepancy_kind === 'cash_swiped') {
        ok = await cashToCard(rec.delivery_id, tender, extras);
      } else if (rec.discrepancy_kind === 'type_mismatch') {
        ok = await fixTenderType(rec.delivery_id, rec.actual_type);
        if (ok && extras.length) {
          for (const id of extras) {
            const also = await fixTenderType(id, rec.actual_type).catch(() => false);
            if (!also) toast.error('One linked discrepancy could not be applied — check it again');
          }
        }
      } else {
        toast.error('This discrepancy type is review-only — dismiss it once checked');
        return;
      }
      if (!ok) return;
      const nowIso = new Date().toISOString();
      const byName = currentUser?.full_name || currentUser?.email || null;
      const touched = [String(rec.id), ...extras];
      await Promise.all(touched.map((chgId) =>
      base44.entities.CodBadgeChangeLog.update(String(chgId), {
        status: 'confirmed', confirmed_at: nowIso, confirmed_by_name: byName
      }).catch(() => {})));
      const linkedSet = new Set(extras);
      setPaymentDiscrepancies((prev) => prev.filter((x) => {
        if (String(x.id) === String(rec.id)) return false;
        // linked rows clear too when they point at one of the linked deliveries
        return !linkedSet.has(String(x.delivery_id || ''));
      }));
      toast.success(extras.length ?
      `Confirmed as one ${tender.toLowerCase()} swipe — ${extras.length + 1} discrepancies` :
      'Discrepancy confirmed and applied');
    } finally {
      setDiscrepancyBusy(false);
    }
  }, [cashToCard, fixTenderType, currentUser, discrepancyBusy]);

  const dismissDiscrepancy = useCallback(async (rec) => {
    if (!rec?.id || discrepancyBusy) return;
    setDiscrepancyBusy(true);
    try {
      await base44.entities.CodBadgeChangeLog.update(String(rec.id), {
        status: 'dismissed',
        confirmed_at: new Date().toISOString(),
        confirmed_by_name: currentUser?.full_name || currentUser?.email || null
      }).catch(() => {});
      setPaymentDiscrepancies((prev) => prev.filter((x) => x.id !== rec.id));
      toast.success('Discrepancy dismissed');
    } finally {
      setDiscrepancyBusy(false);
    }
  }, [currentUser, discrepancyBusy]);

  const markCardSpend = useCallback(async (deliveryId) => {
    if (!currentUser || !deliveryId) return;
    const prev = manualSpendMarksRef.current || {};
    const key = String(deliveryId);
    const togglingBack = !!prev?.[key]?.notTapped;
    const nowIso = new Date().toISOString();
    // Oct 7 2026: ALWAYS keep a record with the fresh touchedAt — never
    // delete the key when toggling back to Card Spend. The deduction rule
    // treats a pre-True-Up COD as neutral until it has been explicitly
    // clicked since True-Up; deleting the key on toggle-back would erase
    // that "I clicked this" evidence and silently revert it to neutral.
    const next = { ...prev, [key]: { notTapped: !togglingBack, touchedAt: nowIso, by: currentUser?.id || null } };
    // Optimistic: flip the badge instantly.
    setManualSpendMarks(next);
    manualSpendMarksRef.current = next;
    computeCodCollectedTodayRef.current?.();
    try {
      if (spendMarksRecordIdRef.current) {
        await base44.entities.AppSettings.update(spendMarksRecordIdRef.current, { setting_value: next });
      } else {
        const created = await base44.entities.AppSettings.create({ setting_key: SPEND_MARKS_KEY, setting_value: next, description: 'Card Spend toggle state — {notTapped, touchedAt} per delivery; touchedAt proves an explicit owner click since the last True-Up' });
        spendMarksRecordIdRef.current = created?.id || null;
      }
      toast.success(togglingBack ? 'Card Spend' : 'Not Tapped');
    } catch (e) {
      console.error('markCardSpend failed:', e);
      toast.error('Could not save the toggle');
      setManualSpendMarks(prev);
      manualSpendMarksRef.current = prev;
    }
  }, [currentUser]);

  // OWNER SPEC (Oct 8 2026): manual "mark refunded" — the red Failed badge
  // is clickable (owner only) as the backup when auto refund detection misses
  // a refund in the Square ledger (broken link chains). Marking removes the
  // failed delivery from the Uncollected lists and releases its amount back
  // onto the card estimate. Idempotent server-side; local recompute follows.
  const markFailedRefunded = useCallback(async (deliveryId) => {
    if (!currentUser || !deliveryId) return;
    try {
      await markFailedCodRefunded(deliveryId, currentUser?.id || null);
      toast.success('Marked refunded — amount returned to the card balance');
      computeLocalOutstandingRef.current?.();
      computeCodCollectedTodayRef.current?.();} catch (e) {
      console.error('markFailedRefunded failed:', e);
      toast.error('Could not mark the COD as refunded');
    }
  }, [currentUser]);

  // OWNER SPEC (Oct 7 2026) — STRICTLY DELIVERY DATA: this page no longer
  // syncs through the Square API at all. "Loading the numbers" now means:
  //   - card credits from FINISHED deliveries' recorded Debit/Credit
  //     cod_payments (net of fee rate sheet + loan% + folder%) — complete by
  //     construction, versus the ledger's half-coverage (broken link chains,
  //     pending entries, unlinked manual rings);
  //   - bank sweeps (BATCH payouts) + card topups from the existing ledger
  //     rows (DB reads served by the 10-min IDB windows cache — no API call).
  const loadSales = useCallback(async (cfg) => {
    if (!cfg?.trued_up_at) {setDeliveryCredits(new Map());setPayouts([]);return;}
    const seq = ++loadSeq.current;
    const creditsMap = await loadDeliveryCardCredits(cfg, currentUser?.id || null).catch(() => new Map());
    const payoutRows = await loadCardPayouts(cfg, currentUser?.id || null).catch(() => []);
    const topupRows = await loadCardTopups(cfg, currentUser?.id || null).catch(() => []);
    if (seq === loadSeq.current) {setDeliveryCredits(creditsMap);setPayouts(payoutRows);setTopups(topupRows);}
  }, [currentUser?.id]);

  // Client-side COD outstanding — same rules as the backend pass, computed fresh
  // from the entities so COD add/remove on any delivery shows up in seconds
  // (no Square API round-trip needed). Local result wins over the sync response.
  // CODs-outstanding now comes from the ONE shared implementation in
  // useSquareBalancesSummary.js (computeCodOutstandingDetailed) — the sidebar
  // badge and this page can no longer drift apart (Oct 2 2026 badge-vs-page
  // mismatch: the badge's private copy swallowed a fetch failure and showed
  // $0 outstanding while this page computed $18.14 correctly).
  const computeLocalOutstanding = useCallback(async (cfgArg) => {
    try {
      const out = await computeCodOutstandingDetailed(cfgArg || configRef.current, currentUser?.id || null);
      setLocalOutstanding(out);
      // REFUND-POSTED ALERT (owner spec Oct 9 2026): owner devices notify the
      // owner + the assigned driver when a failed COD's Square refund is
      // auto-detected (idempotent per delivery; drivers never send).
      if (ownerCanEdit && Array.isArray(out?.autoRefundedFailed) && out.autoRefundedFailed.length) {
        void sendFailedRefundAlerts(cfgArg || configRef.current, out.autoRefundedFailed, currentUser?.id || null);
      }
    } catch (e) {
      console.error('local COD outstanding failed:', e);
    }
  }, [currentUser?.id, ownerCanEdit]);

  // Owner-only: UNCOLLECTED CODs taken from the SquareCatalogItems database.
  // An ACTIVE catalog item = the COD is still sitting in the Square register,
  // regardless of delivery date — this catches old ones (e.g. 100 days back)
  // that the true-up-window delivery queries exclude. Statuses 'completed' and
  // 'deleted' mean the item was rung/removed = collected, so they're skipped.
  const computeCatalogUncollected = useCallback(async () => {
    // MERGE ROLE (owner spec, Oct 7 2026 follow-up): the catalog list is
    // MERGED into the Uncollected / Past uncollected sections alongside the
    // delivery-derived rows, exactly like the old system — ACTIVE catalog
    // items catch CODs whose delivery rows fall outside the delivery-derived
    // window (e.g. week-old CODs). Drivers see the same merged lists.
    const mySeq = ++catalogUncollectedSeqRef.current;
    const isLatest = () => mySeq === catalogUncollectedSeqRef.current;
    try {
      // DISAPPEARING-ROWS GUARD (Oct 6 2026, owner report: Past uncollected
      // rows "show up then disappear"). A failed/empty fetch page MUST NOT
      // wipe the visible list — each failed page retries once, and if the
      // overall fetch still came back empty-with-errors we keep the previous
      // state instead of overwriting it with an empty map (an entity fetch
      // hiccup — e.g. a rate-limit volley from another Square load — would
      // previously blank the section until the next successful recompute).
      const fetchPage = async (skip, attempt) => {
        try {
          const rows = await base44.entities.SquareCatalogItems.filter({ status: 'active' }, undefined, 500, skip);
          return { rows: rows || [], failed: false };
        } catch (e) {
          if (attempt < 2) {
            await new Promise((res) => setTimeout(res, 2500));
            return fetchPage(skip, attempt + 1);
          }
          return { rows: [], failed: true };
        }
      };
      // DRIVER SCOPE (owner rule Oct 9 2026): stamp each catalog row with
      // the linked delivery's driver so drivers only see their own items.
      // Rows with no delivery link get no driver and stay owner-only.
      const scopeId = !isAppOwner(currentUser) && currentUser?.id && userHasRole(currentUser, 'driver') ? String(currentUser.id) : null;
      const driverByDelivery = new Map();
      // ASSIGNED DRIVER (owner request Nov 1 2026): the store cards must name
      // the driver on every COD row, so the same pass also records the
      // delivery's driver_name (ids alone are unreadable on screen).
      const driverNameByDelivery = new Map();
      const refundedDeliveryIds = new Set();
      try {
        const allDel = await offlineDB.getAll(offlineDB.STORES.DELIVERIES);
        (allDel || []).forEach((dd) => {
          // A refunded COD's register item must not resurface as a Pending row.
          if (dd?.id && dd?.cod_refunded_at) refundedDeliveryIds.add(String(dd.id));
          if (dd?.id && dd?.driver_id) driverByDelivery.set(String(dd.id), String(dd.driver_id));
          if (dd?.id && dd?.driver_name) driverNameByDelivery.set(String(dd.id), String(dd.driver_name));
        });
      } catch {/* fall through — unstamped catalog rows are driver-hidden */}
      const _cacheWarm = _catalogSweep.rows && Date.now() - _catalogSweep.at < CATALOG_SWEEP_TTL_MS;
      let itemsRaw;
      let anyFetchFailed = false;
      if (_cacheWarm) {
        itemsRaw = _catalogSweep.rows;
        console.log(`⚡ [SquareBalances] active catalog sweep reused (${itemsRaw.length} items, ${Math.round((Date.now() - _catalogSweep.at) / 1000)}s old)`);
      } else {
        const itemsPages = [];
        // HARD PAGE CAP: 12 pages (6000 active items) is far beyond any real
        // register backlog and stops an unbounded sweep eating the rate budget.
        for (let page = 0; page < 12; page++) {
          const { rows: list, failed } = await fetchPage(page * 500, 1);
          anyFetchFailed = anyFetchFailed || failed;
          itemsPages.push(...list);
          if (list.length < 500) break;
        }
        itemsRaw = itemsPages;
        if (!anyFetchFailed) _catalogSweep = { at: Date.now(), rows: itemsPages };
      }
      const totalItemsFetched = itemsRaw.length;
      // OFFLINE FIRST (owner report Nov 6 2026): both lists live in the offline
      // DB; they were re-pulled from the server on every balances compute.
      const [storesRaw, patientsRaw] = await Promise.all([
      offlineDB.getAll(offlineDB.STORES.STORES).then((r) => r && r.length ? r : base44.entities.Store.list().catch(() => [])).catch(() => base44.entities.Store.list().catch(() => [])),
      offlineDB.getAll(offlineDB.STORES.PATIENTS).then((r) => r && r.length ? r : base44.entities.Patient.list().catch(() => [])).catch(() => base44.entities.Patient.list().catch(() => []))]
      );
      const resolvePatientName = buildPatientResolver(patientsRaw);
      const storeById = new Map();
      const storeByAbbrev = new Map();
      (storesRaw || []).forEach((s) => {
        if (s?.id) storeById.set(String(s.id), s);
        if (s?.abbreviation) storeByAbbrev.set(String(s.abbreviation).toUpperCase(), s);
      });
      const todayStrForParsing = edmontonBusinessDayKey(new Date());
      const byLoc = new Map();
      for (const it of itemsRaw || []) {
        if (!it?.location_id) continue;
        if (!byLoc.has(it.location_id)) byLoc.set(it.location_id, []);
        const sInfo = storeById.get(String(it.store_id || ''));
        const parsed = parseCatalogItemName(it.item_name);
        const parsedDate = catalogDateFromName(parsed, todayStrForParsing);
        const date = parsedDate || String(it.delivery_date || '').slice(0, 10) || null;
        const abbrev = sInfo?.abbreviation || parsed?.abbrev || null;
        const sInfoByAbbrev = abbrev ? storeByAbbrev.get(String(abbrev).toUpperCase()) : null;
        if (it.delivery_id && (cardPaidDeliveryIdsRef.current.has(String(it.delivery_id)) || refundedDeliveryIds.has(String(it.delivery_id)))) continue;
        byLoc.get(it.location_id).push({
          key: `cat-${it.id || it.square_catalog_object_id}`,
          delivery_id: it.delivery_id || null,
          driver_id: driverByDelivery.get(String(it.delivery_id || '')) || null,
          driverName: driverNameByDelivery.get(String(it.delivery_id || '')) || null,
          patientName: resolvePatientName(it.patient_id)?.full_name || parsed?.patientName || extractNameFromCatalogDescription(it.description) || null,
          storeAbbrev: abbrev,
          storeColor: sInfo?.color || sInfoByAbbrev?.color || null,
          amount: Number(it.amount || 0),
          date: date || null,
          cashAwaitingSquare: false
        });
      }
      // DEFENSIVE DEDUP (Oct 6 2026, owner report: Emilen Brochu COD shown
      // twice in Uncollected). The backend has a duplicate-guard against ever
      // creating two live Square catalog items for the same delivery, but
      // this frontend list must never show a repeat even if a stale/duplicate
      // row briefly exists in SquareCatalogItems (e.g. mid-cleanup, racing
      // sync). Collapse by delivery_id, keeping the most recently created row.
      const freshOut = {};
      for (const [locId, rowsRaw] of byLoc) {
        const byDelivery = new Map();
        const noDeliveryId = [];
        for (const r of rowsRaw) {
          if (!r.delivery_id) {noDeliveryId.push(r);continue;}
          const existing = byDelivery.get(r.delivery_id);
          if (!existing || String(r.key) > String(existing.key)) byDelivery.set(r.delivery_id, r);
        }
        freshOut[locId] = [...byDelivery.values(), ...noDeliveryId];
      }
      // Carry-forward merge: a delivery_id present in the PREVIOUS rendered
      // state but missing from this fresh fetch is kept for up to one extra
      // cycle (a transient backend blip), then dropped once it has missed
      // twice in a row (a real collection/removal).
      const freshIdsByLoc = new Map();
      for (const [locId, rows] of Object.entries(freshOut)) {
        freshIdsByLoc.set(locId, new Set(rows.map((r) => r.delivery_id).filter(Boolean)));
      }
      const streak = catalogMissStreakRef.current;
      const seenThisPass = new Set();
      const out = { ...freshOut };
      for (const [locId, prevRows] of Object.entries(catalogUncollectedByLocRef.current || {})) {
        const freshIds = freshIdsByLoc.get(locId) || new Set();
        for (const r of prevRows || []) {
          if (!r.delivery_id) continue;
          seenThisPass.add(r.delivery_id);
          if (freshIds.has(r.delivery_id)) {streak.delete(r.delivery_id);continue;}
          const misses = (streak.get(r.delivery_id) || 0) + 1;
          if (misses >= 2) {streak.delete(r.delivery_id);continue;} // confirmed gone
          streak.set(r.delivery_id, misses);
          if (!out[locId]) out[locId] = [];
          out[locId] = [...out[locId], r]; // carry forward one more cycle
        }
      }
      // Any delivery_id that was present fresh resets its streak (handled
      // above via streak.delete when found); prune streak entries for ids no
      // longer seen anywhere to avoid an unbounded map.
      for (const id of Array.from(streak.keys())) {
        if (!seenThisPass.has(id)) streak.delete(id);
      }
      // Render the full list immediately — never let the list wait on, or be
      // wiped by, the slower cash-check below (Oct 6 2026 regression: an
      // earlier version computed cashAwaitingSquare inline before this
      // setState, and any failure/slowness in that step risked the whole
      // Uncollected/Past-uncollected catalog list going stale or empty).
      // If the fetch itself failed AND produced nothing, keep the previous
      // rows on screen rather than blanking the section.
      if (totalItemsFetched === 0 && anyFetchFailed) {
        return; // keep previous state; a later successful recompute replaces it
      }
      if (!isLatest()) return; // a newer call already started — don't stomp its result
      catalogUncollectedByLocRef.current = out;
      setCatalogUncollectedByLoc(out);

      // CASH-ALREADY-COLLECTED tag (Oct 6 2026, owner report: Emilen Brochu
      // looked like a plain duplicate between Collected Today and
      // Uncollected). By design (squareCodSync.jsx desired-state table):
      // "completed + cash -> item stays until squareReconcile matches the
      // driver's deposit" — the catalog item deliberately survives a cash
      // collection so the bank deposit can later be matched. Runs AFTER the
      // list is already on screen, as a non-blocking background refinement;
      // merges into existing state via functional setState so it can never
      // regress rows that were already rendered.
      const deliveryIdsForCashCheck = Array.from(new Set((itemsRaw || []).map((it) => it?.delivery_id).filter(Boolean)));
      if (deliveryIdsForCashCheck.length) {
        const cashCollectedDeliveryIds = new Set();
        const cardPaidDeliveryIds = new Set();
        const resolvedIds = new Set();
        const isCashCompleted = (d) => String(d?.status) === 'completed' && (d?.cod_payments || []).some((p) => String(p?.type).toLowerCase() === 'cash');
        // ANY Debit/Credit payment on the delivery = collected on the card
        // (covers completed flips AND the pending-item-in-a-combined-swipe
        // path in cashToCard, which creates card payments on uncollected
        // pending CODs).
        const isCardPaid = (d) => (Array.isArray(d?.cod_payments) ? d.cod_payments : []).some((p) => ['debit', 'credit'].includes(String(p?.type || '').toLowerCase()));
        for (let i = 0; i < deliveryIdsForCashCheck.length; i += 400) {
          const chunk = deliveryIdsForCashCheck.slice(i, i + 400);
          const rows = await base44.entities.Delivery.filter({ id: { $in: chunk } }, undefined, 400).catch(() => []);
          for (const d of rows || []) {
            resolvedIds.add(String(d.id));
            if (isCashCompleted(d)) cashCollectedDeliveryIds.add(String(d.id));
            if (isCardPaid(d)) cardPaidDeliveryIds.add(String(d.id));
          }
        }
        // LOCAL-IDB FALLBACK (owner report Oct 24 2026: Bonnie Doon's
        // cash-collected rows kept showing the amber 'Pending' pill): when
        // the server read fails or comes back short on a hot/rate-limited
        // pool, finish the check from the local delivery mirror so the
        // emerald 'Cash' tag never depends on a fragile API call.
        const unresolvedIds = deliveryIdsForCashCheck.filter((id) => !resolvedIds.has(String(id)));
        if (unresolvedIds.length) {
          try {
            const idbRows = (await getAllDeliveriesIdb()) || [];
            const byId = new Map(idbRows.map((d) => [String(d?.id), d]));
            for (const id of unresolvedIds) {
              const d = byId.get(String(id));
              if (d && isCashCompleted(d)) cashCollectedDeliveryIds.add(String(id));
              if (d && isCardPaid(d)) cardPaidDeliveryIds.add(String(id));
            }
          } catch {/* IDB read failed — rows stay untagged until the next pass */}
        }
        // Refresh the build-time filter (full recompute each pass — a badge
        // flipped BACK to Cash re-shows the register row on the next pass).
        cardPaidDeliveryIdsRef.current = cardPaidDeliveryIds;
        if (cardPaidDeliveryIds.size > 0 && isLatest()) {
          setCatalogUncollectedByLoc((prev) => {
            if (!prev) return prev;
            const next = {};
            for (const [locId, rows] of Object.entries(prev)) {
              next[locId] = rows.filter((r) => !(r.delivery_id && cardPaidDeliveryIds.has(String(r.delivery_id))));
            }
            catalogUncollectedByLocRef.current = next;
            return next;
          });
        }
        // OWNER SPEC (Oct 8 2026, REVISED same day): cash-completed rows
        // STAY in Uncollected / Past uncollected with the emerald 'Cash'
        // badge — the delivery is done but the money is not back on the
        // Square card yet, so it is still technically uncollected (and NOT
        // in Collected today — see computeCodCollectedToday). Since the
        // PAYMENT DISCREPANCIES spec (owner, Oct 9 2026 night) there is NO
        // ledger-match auto-collect here either: a cash COD that Square
        // shows as swiped is flagged in the Payment discrepancies viewer
        // (backend squareBalancesCompute) and stays listed until the owner
        // CONFIRMS the fix there — no in-app auto updates.
        if (cashCollectedDeliveryIds.size > 0 && isLatest()) {
          setCatalogUncollectedByLoc((prev) => {
            if (!prev) return prev;
            const next = {};
            for (const [locId, rows] of Object.entries(prev)) {
              next[locId] = rows.
              map((r) =>
              r.delivery_id && cashCollectedDeliveryIds.has(r.delivery_id) ? { ...r, cashAwaitingSquare: true } : r
              );
            }
            catalogUncollectedByLocRef.current = next;
            return next;
          });
        }
      }
    } catch (e) {
      console.error('catalog uncollected compute failed:', e);
    }
  }, [currentUser]);
  // Owner-only: today's COLLECTED CODs per card.
  //   a) Square-confirmed cash collections (ledger cod_collection entries whose
  //      occurred_at lands on today's Edmonton date)
  //   b) non-cash payments (debit/credit/cheque) collected today — recorded on
  //      the delivery itself, no Square transaction
  // Uncollected lists are derived from localOutstanding at render time.
  // OWNER SPEC (Oct 7 2026) — STRICTLY DELIVERY DATA: "Collected today" is
  // every delivery FINISHED today with a COD, badged by its recorded payment
  // type (Debit / Credit / Cheque / Cash). Debit & Credit rows show the net
  // money back on the Square card (gross − fee rate sheet − loan% − folder%);
  // Cash and Cheque never touch the card (no net shown). The Square-ledger
  // sections and the fuzzy swipe-evidence matching (fingerprints, declines,
  // near-time combos) are retired — the delivery's own cod_payments are the
  // single authority.
  const computeCodCollectedToday = useCallback(async () => {
    try {
      const [storesRaw, cfgsRaw, patientsRaw] = await Promise.all([
      base44.entities.Store.list().catch(() => null),
      base44.entities.SquareLocationConfig.list().catch(() => null),
      base44.entities.Patient.list().catch(() => [])]
      );
      // FAILED-READ GUARD (owner report Oct 9 23:00: rows show up, then after
      // the sync they disappear): the sync's Square volley (ledger pull +
      // catalog reconcile + backend compute) eats the API budget, and the
      // recompute right after it hits 429s. A failed Store/config read used
      // to look like "no stores" → every row failed the locId lookup → an
      // EMPTY set overwrote the Collected-today lists. Failed reads now keep
      // the previous rows instead of wiping them.
      if (!Array.isArray(storesRaw) || !Array.isArray(cfgsRaw)) {
        console.warn('[SquareBalances] collected-today store/config read failed — keeping previous rows');
        return;
      }
      const resolvePatientName = buildPatientResolver(patientsRaw);
      const cfgNow = configRef.current || {};
      const folderRateNow = Number(cfgNow.folder_rate ?? DEFAULT_FOLDER_RATE);
      const loanRateByLoc = new Map();
      (cfgNow.locations || []).forEach((l) => {if (l?.location_id) loanRateByLoc.set(l.location_id, Number(l.loan_rate || 0));});
      const cfgLoc = new Map();
      (cfgsRaw || []).forEach((c) => {if (c?.id && c?.square_location_id) cfgLoc.set(c.id, c.square_location_id);});
      const storeToLoc = new Map();
      const storeById = new Map();
      (storesRaw || []).forEach((st) => {
        const loc = st?.square_location_config_id ? cfgLoc.get(st.square_location_config_id) : null;
        if (st?.id && loc) storeToLoc.set(String(st.id), loc);
        if (st?.id) storeById.set(String(st.id), st);
      });
      const today = edmontonBusinessDayKey(new Date());
      const centsOf = (n) => Math.round(Number(n || 0) * 100);
      const byLoc = new Map();
      const aggFor = (locId) => {
        if (!byLoc.has(locId)) byLoc.set(locId, []);
        return byLoc.get(locId);
      };

      // Deliveries relevant to TODAY's collections ONLY (owner report Oct 24
      // 2026, 01:42 MDT: the old 30-day created-window paged scan burned 4-8+
      // requests per compute on the account pool, so every refresh tripped the
      // 140 req/min rate limit and the Refresh button could NEVER land fresh
      // data — it looked dead. Two narrow reads replace the scan: (1)
      // today's + yesterday's deliveries by date (yesterday covers
      // post-midnight completions of the previous route), (2) any past-dated
      // delivery whose COD was swiped/collected today (cod_card_spend_at —
      // the Oct 19 rule for late/off-day card collections like Beverly+
      // Burton). One 2.5s retry rides transient 429s; ANY final failure keeps
      // the previous rows (a failure must never wipe or partially overwrite
      // the lists).
      const readDeliveries = async (query, tag) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const rows = await base44.entities.Delivery.filter(query, '-created_date', 500).catch(() => null);
          if (rows !== null) return rows;
          if (attempt === 0) await new Promise((r) => setTimeout(r, 2500));
        }
        console.warn(`[SquareBalances] collected-today delivery read failed (${tag}) — keeping previous rows`);
        return null;
      };
      const yesterdayEdm = edmontonBusinessDayKey(new Date(Date.now() - 24 * 3600000));
      const seenDelIds = new Set();
      const deliveryList = [];
      const collect = (rows) => {
        for (const d of rows || []) {
          if (!d?.id || seenDelIds.has(d.id)) continue;
          seenDelIds.add(d.id);
          deliveryList.push(d);
        }
      };
      // IDB-FIRST (owner directive Oct 24 2026 02:02 MDT: this Editor is the
      // ONLY device that initiates Square sync/balance compute, and its IDB
      // is kept current by the same WS delivery broadcasts — so the date-based
      // set comes from the LOCAL mirror at zero API cost. Server fallback only
      // when IDB itself is unavailable.
      let idbAll = null;
      try {idbAll = (await getAllDeliveriesIdb()) || null;} catch {idbAll = null;}
      if (idbAll) {
        collect(idbAll.filter((d) => [today, yesterdayEdm].includes(String(d?.delivery_date || ''))));
      } else {
        const todayRows = await readDeliveries({ delivery_date: { $in: [today, yesterdayEdm] } }, 'today');
        if (todayRows === null) return; // keep previous rows
        collect(todayRows);
      }
      // SPEND-STAMPED SET — SERVER-FIRST (owner report Oct 24 2026: backend
      // sync writes cod_card_spend_at / confirm stamps silently with NO WS
      // broadcast, so the server list is ahead of the local mirror right
      // after a sync): one narrow read with the 2.5s retry; IDB fallback when
      // the pool rate-limits it.
      const spentRows = await readDeliveries({ cod_card_spend_at: { $gte: `${yesterdayEdm}T00:00:00Z` } }, 'spend-today');
      if (spentRows !== null) {
        collect(spentRows);
      } else if (idbAll) {
        const spendFloor = `${yesterdayEdm}T00:00:00Z`;
        collect(idbAll.filter((d) => {const sp = String(d?.cod_card_spend_at || '');return sp && sp >= spendFloor;}));
        console.log('[SquareBalances] collected-today spend set from IDB (server read rate-limited)');
      } else {
        return; // both sources failed — keep previous rows
      }

      // ── CASH-SWIPED COLLECTIONS (owner report Nov 5 2026, Bonnie Doon card) ──
      // "There is at least 1 multi swipe collection today for $44.83 that
      // includes 3 Cash collected CODs from yesterday and today. These should be
      // getting shown on the Collected section of the Bonnie Doon card as a
      // single collection."
      // The Oct 8 rule drops every non-card row from Collected today, so a COD
      // recorded Cash whose money was actually taken on ONE card swipe showed
      // NOWHERE on the card. A COMPLETED cod_collection ledger entry with a card
      // brand that landed TODAY is proof the cash was collected on the card: the
      // row joins Collected today, carries the swipe's REAL fee/folder/loan and
      // settled cents, and the existing transaction grouping (same square_id
      // prefix) merges the whole swipe into ONE collection card.
      const swipedTodayByDelivery = new Map(); // delivery_id -> ledger entry
      try {
        const swStartIso = `${yesterdayEdm}T00:00:00Z`;
        for (let attempt = 0; attempt < 2; attempt++) {
          let rows = await base44.entities.SquareLedgerEntry.filter(
            { sale_class: 'cod_collection', occurred_at: { $gte: swStartIso } },
            '-occurred_at', 500, 0
          ).catch(() => null);
          if (rows === null) {
            if (attempt === 0) {await new Promise((r) => setTimeout(r, 2500));continue;}
            console.warn('[SquareBalances] cash-swiped ledger read failed — Collected today keeps card rows only this pass');
            break;
          }
          for (const e of rows || []) {
            if (!e?.delivery_id || !String(e?.card_brand || '')) continue;
            if (String(e?.status || '').toUpperCase() !== 'COMPLETED') continue;
            if (edmontonBusinessDayKey(parseAnyTimestamp(e.occurred_at)) !== today) continue;
            const k = String(e.delivery_id);
            if (!swipedTodayByDelivery.has(k)) swipedTodayByDelivery.set(k, e);
          }
          break;
        }
      } catch (e) {console.warn('[SquareBalances] cash-swiped ledger pass skipped:', e?.message || e);}

      for (const d of deliveryList) {
        if (d?.status !== 'completed') continue;
        const doneAt = String(d.actual_delivery_time || '');
        // OWNER SPEC (Oct 19 2026): a PAST-dated delivery whose COD was
        // collected TODAY still belongs in "Collected today" — retro/backdated
        // completions and old uncollected CODs whose tender was recorded or
        // converted to Debit/Credit today (cod_card_spend_at is stamped at
        // that moment). The collection moment shown is the card-spend stamp
        // when it falls today, otherwise the completion time.
        // TIMEZONE FIX (owner report Oct 24 2026 02:11 MDT, Burton Demeriez
        // missing while Beverly Dickie showed): the old check sliced the
        // spend stamp's RAW UTC DATE and compared it to the Edmonton
        // business-day key — a 00:09 AM swipe carries a UTC date one day
        // ahead, so inside the overnight business-day window (before 05:00
        // Edmonton, still 'yesterday's' day) the row was dropped. Both the
        // spend stamp AND the naive completion time now resolve through
        // edmontonBusinessDayKey(parseAnyTimestamp(...)) so they land on the
        // same business day the rest of the card uses.
        const spendAt = String(d.cod_card_spend_at || '');
        const spendDay = spendAt ? edmontonBusinessDayKey(parseAnyTimestamp(spendAt)) : null;
        const doneDay = doneAt ? edmontonBusinessDayKey(parseAnyTimestamp(doneAt)) : null;
        const spentToday = spendDay === today;
        if (!spentToday && doneDay !== today) continue;
        const collectionMoment = spentToday ? spendAt : doneAt;
        const required = centsOf(d?.cod_total_amount_required);
        const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
        const paidSum = payments.reduce((s, pm) => s + centsOf(pm?.amount), 0);
        // REFUNDED CODS STAY VISIBLE (owner spec Nov 8 2026): no amount left and
        // no payments, but it still belongs in Collected today with a Refunded
        // badge so the day's story stays complete.
        const refundedAt = String(d?.cod_refunded_at || '');
        if (required <= 0 && paidSum <= 0 && !refundedAt) continue;
        const locId = storeToLoc.get(String(d?.store_id || ''));
        if (!locId) continue;
        const sInfo = storeById.get(String(d?.store_id || ''));

        // Badge word from the recorded payment types (owner spec: "marking
        // accordingly the debit cash and credit… badges"). Debit wins over
        // Credit when both were recorded; Cheque shows as Cheque; anything
        // else (or no payment rows) reads as Cash.
        const types = payments.map((pm) => String(pm?.type || '').toLowerCase());
        const isCard = types.includes('debit') || types.includes('credit');
        const label = types.includes('debit') ? 'Debit' :
        types.includes('credit') ? 'Credit' :
        types.includes('cheque') ? 'Cheque' :
        'Cash';
        // OWNER RULE (Oct 8 2026, late): a CASH (or cheque) collection is
        // UNCOLLECTED, period — it never appears in "Collected today", even
        // when cod_confirmed_collected is stamped (the Londonderry report:
        // ledger-confirmed cash rows must NOT surface as Collected). Only a
        // Debit/Credit tender is collected: cash rows read in the Uncollected
        // lists with their CLICKABLE 'Cash' badge (CardCodList) until the
        // tender is corrected to Debit/Credit, which moves the row here with
        // real fee math.
        const swipedEntry = swipedTodayByDelivery.get(String(d.id)) || null;
        // A cash-recorded COD whose money landed on a card TODAY is collected
        // card money — never dropped by the cash rule above.
        if (!isCard && !swipedEntry && !refundedAt) continue;
        const effLabel = refundedAt ? 'Refunded' : isCard ? label :
        String(swipedEntry?.card_brand || '').toUpperCase() === 'INTERAC' ? 'Debit' : 'Credit';

        const gross = refundedAt ? Number(d?.cod_refunded_amount || 0) : (required > 0 ? required : paidSum) / 100;
        const mark = manualSpendMarksRef.current?.[String(d.id)];
        const rowObj = {
          key: `d-${d.id}`,
          delivery_id: String(d.id),
          // driver scoping (owner rule Oct 9 2026): drivers only see rows
          // for deliveries assigned to them.
          driver_id: String(d.driver_id || '') || null,
          driverName: d.driver_name || null,
          patientName: resolvePatientName(d.patient_id)?.full_name || null,
          storeAbbrev: sInfo?.abbreviation || null,
          storeColor: sInfo?.color || null,
          amount: gross,
          sub: collectionMoment.slice(11, 16),
          collected: true,
          refunded: !!refundedAt,
          // Debit/Credit payments ARE card money by definition in the
          // delivery-data model — the sky "Card Spend" pill marks them.
          hasCardSpend: isCard,
          manualCardSpend: !!(mark?.touchedAt || mark?.at),
          // OWNER RULE (Nov 3 2026): the Card Spend pill on a COLLECTED row is
          // a toggle again (tap => Not Tapped) and a Not Tapped mark NEVER
          // removes the row from Collected Today - the money really was
          // collected, only the POS-tap claim is disputed. A mark is stale
          // (ignored) when the card was charged AFTER it was made, the same
          // superseded test the balance math uses.
          notTapped: (() => {
            if (mark?.notTapped !== true) return false;
            const markAt = mark?.touchedAt ? new Date(mark.touchedAt).getTime() : null;
            const spendAt = d?.cod_card_spend_at ? new Date(d.cod_card_spend_at).getTime() : null;
            if (spendAt != null && Number.isFinite(spendAt) && (
            markAt == null || !Number.isFinite(markAt) || spendAt >= markAt)) return false;
            return true;
          })(),
          collectedLabel: effLabel,
          // Cash / Cheque never touch the card — no fee/loan/folder math.
          // COMBINED-SWIPE (Oct 9 2026): conversions store the per-item
          // fee/folder/loan/settled cents on the payment (fee_c etc.) —
          // those are splits of ONE swipe's fees and are authoritative.
          storedCardP: (() => payments.find((pm) =>
          ['debit', 'credit'].includes(String(pm?.type || '').toLowerCase()) &&
          Number.isFinite(pm?.fee_c) && Number.isFinite(pm?.folder_c) && Number.isFinite(pm?.loan_c)) || null)(),
          netAmount: isCard ?
          payments.some((pm) => ['debit', 'credit'].includes(String(pm?.type || '').toLowerCase()) && Number.isFinite(pm?.settled_c)) ?
          Math.max(0, payments.filter((pm) => ['debit', 'credit'].includes(String(pm?.type || '').toLowerCase()) && Number.isFinite(pm?.settled_c)).reduce((sum2, pm) => sum2 + Math.round(Number(pm.settled_c)), 0)) / 100 :
          computeNetCollected(gross, { cardType: effLabel, loanRate: loanRateByLoc.get(locId), folderRate: folderRateNow }) :
          null,
          // FEE BREAKDOWN (owner spec Oct 7 2026): second row shows
          // "HH:MM | S:fee F:folder L:loan | net Type" for card payments —
          // the settled story of the collection in one line. Cash / Cheque
          // rows have no card fees, so no breakdown.
          feeParts: isCard ? function () {
            const sp = payments.find((pm) =>
            ['debit', 'credit'].includes(String(pm?.type || '').toLowerCase()) &&
            Number.isFinite(pm?.fee_c) && Number.isFinite(pm?.folder_c) && Number.isFinite(pm?.loan_c));
            if (sp) return { fee: Math.round(Number(sp.fee_c)) / 100, folder: Math.round(Number(sp.folder_c)) / 100, loan: Math.round(Number(sp.loan_c)) / 100 };
            // Cents-rounded components (owner spec Oct 7 2026) — same values
            // that feed the settled net, so the S/F/L line always sums to
            // gross − net exactly.
            const grossC = Math.round(gross * 100);
            return {
              fee: estimateCardFeeCents(grossC, effLabel) / 100,
              folder: folderCentsFor(grossC, folderRateNow) / 100,
              loan: Math.round(grossC * Number(loanRateByLoc.get(locId) || 0)) / 100
            };
          }() : null
        };
        // SWIPED-CASH OVERRIDE (owner report Nov 5 2026): the swipe's own ledger
        // entry owns the money story — real brand, real fee/folder/loan split and
        // the authoritative settled cents. The moment shown is the SWIPE time, so
        // a yesterday-dated COD reads as collected today.
        if (!isCard && swipedEntry) {
          rowObj.collected = true;
          rowObj.hasCardSpend = true;
          rowObj.swipedCash = true;
          const swCents = Math.round(Number(swipedEntry.amount_cents || 0));
          if (swCents > 0) rowObj.amount = swCents / 100;
          const swFee = Number(swipedEntry.fee_cents);
          const swFolder = Number(swipedEntry.folder_cents);
          const swLoan = Number(swipedEntry.loan_cents);
          const swSettled = Number(swipedEntry.settled_cents);
          const sumSplit = (Number.isFinite(swFee) ? swFee : 0) + (Number.isFinite(swFolder) ? swFolder : 0) + (Number.isFinite(swLoan) ? swLoan : 0);
          rowObj.netAmount = Number.isFinite(swSettled) && swSettled > 0 ?
          swSettled / 100 :
          Math.max(0, Math.round(rowObj.amount * 100) - sumSplit) / 100;
          rowObj.feeParts = Number.isFinite(swFee) || Number.isFinite(swFolder) || Number.isFinite(swLoan) ?
          { fee: (Number(swFee) || 0) / 100, folder: (Number(swFolder) || 0) / 100, loan: (Number(swLoan) || 0) / 100 } :
          estimateCardFeeCents(Math.round(rowObj.amount * 100), effLabel) != null ?
          { fee: estimateCardFeeCents(Math.round(rowObj.amount * 100), effLabel) / 100, folder: folderCentsFor(Math.round(rowObj.amount * 100), folderRateNow) / 100, loan: Math.round(rowObj.amount * 100 * Number(loanRateByLoc.get(locId) || 0)) / 100 } :
          null;
          try {
            const swMoment = edmontonWallString(parseAnyTimestamp(swipedEntry.occurred_at));
            if (swMoment) rowObj.sub = String(swMoment).slice(11, 16);
          } catch (_) {/* keep the completion time */}
        }
        aggFor(locId).push(rowObj);
      }

      // ─── COMBINED TRANSACTION DETECTION (owner feature, Oct 22 2026) ─────────
      // Multiple COD items paid in ONE Square transaction appear as separate
      // delivery rows. Group the Collected-today rows by their shared
      // transaction (SquareLedgerEntry square_id): 2+ rows on the same swipe
      // merge into ONE combined card — summed amounts and the transaction's
      // TRUE Square/Folder/Loan fees (per-entry split cents sum exactly to the
      // swipe's fees; estimates never double-charge the flat fee).
      // SAFEGUARDS: rows only merge when they share the SAME driver_id (owner
      // rule Oct 9 2026: drivers only see their own rows — a swipe covering
      // another driver's COD never merges across the scope); a ledger read
      // failure leaves rows separate (no data loss, just no combining).
      try {
        const since2d = new Date(Date.now() - 2 * 86400000).toISOString();
        const ledgerRaw = [];
        // BOUNDED RETRY (owner report Oct 24 2026, 01:53 MDT: the grouped card
        // 'still not showing' after every fix — this read 429'd ONCE on the
        // flapping pool, silently broke out of the loop, and combining was
        // skipped with NO warn — the page looked healthy with separate cards.
        // Same 2.5s single retry as the collected-today delivery read; a final
        // failure now LOGS instead of vanishing.
        let ledgerReadFailed = false;
        for (let page = 0; page < 20; page++) {
          let rows = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            rows = await base44.entities.SquareLedgerEntry.filter(
              { sale_class: 'cod_collection', occurred_at: { $gte: since2d } },
              'occurred_at', 500, page * 500
            ).catch(() => null);
            if (rows !== null) break;
            if (attempt === 0) await new Promise((r) => setTimeout(r, 2500));
          }
          if (rows === null) {
            console.warn('[SquareBalances] combining ledger read failed — skipped combining this pass');
            ledgerReadFailed = true;
            break;
          }
          const list = rows || [];
          ledgerRaw.push(...list);
          if (list.length < 500) break;
        }
        if (ledgerReadFailed) {/* rows stay separate this pass; next pass retries */}
        const entryByDelivery = new Map(); // delivery_id -> first matching entry
        const entriesBySquare = new Map(); // TRANSACTION key -> [entries]
        const seenEntryId = new Set();
        // TRANSACTION KEY (owner report Oct 22, Londonderry Angie+Marjorie):
        // squareLedgerSync's MULTI-COD SPLIT writes one entry per COD item with
        // a SUFFIXED square_id — `${payment.id}:${delivery_id}` (its upsert is
        // keyed on square_id, so identical ids would overwrite each other).
        // Grouping by the EXACT square_id therefore never matched the split
        // siblings. The transaction id is the prefix BEFORE the last colon
        // (plain single-COD entries have no suffix and pass through unchanged).
        const txKeyOf = (raw) => String(raw).replace(/:[^:]*$/, '');
        for (const e of ledgerRaw) {
          if (!e?.id || seenEntryId.has(e.id)) continue;
          seenEntryId.add(e.id);
          if (String(e?.status || '').toUpperCase() !== 'COMPLETED') continue;
          if (!e?.square_id || !e?.delivery_id) continue;
          if (edmontonBusinessDayKey(new Date(e.occurred_at)) !== today) continue;
          const sq = txKeyOf(e.square_id);
          if (!entriesBySquare.has(sq)) entriesBySquare.set(sq, []);
          entriesBySquare.get(sq).push(e);
          if (!entryByDelivery.has(String(e.delivery_id))) entryByDelivery.set(String(e.delivery_id), e);
        }
        const sumCents = (arr, f) => arr.reduce((s, e) => s + (Number.isFinite(e?.[f]) ? Math.round(Number(e[f])) : 0), 0);
        // GLOBAL TX GROUPING (owner report Oct 26 2026, Somia Siffledeen KW +
        // James Grant BD — ONE swipe on the BD card): the merge used to run
        // INSIDE each store-location bucket, but rows bucket by their
        // DELIVERY's store — a swipe covering CODs from two stores puts each
        // row in a different bucket and the combined card can never form.
        // Group by transaction ACROSS buckets; a multi-row group's combined
        // card lands in the bucket of the swipe's OWN ledger location (the
        // card the money actually went through), falling back to the first
        // row's bucket.
        const allRows = [];
        for (const [locId, rows] of byLoc) for (const r of rows) allRows.push({ ...r, __locId: locId });
        const groupsBySquare = new Map();
        const ungrouped = [];
        for (const r of allRows) {
          const e = r.delivery_id ? entryByDelivery.get(String(r.delivery_id)) : null;
          if (e) {
            const sq = txKeyOf(e.square_id);
            if (!groupsBySquare.has(sq)) groupsBySquare.set(sq, []);
            groupsBySquare.get(sq).push(r);
          } else {
            ungrouped.push(r);
          }
        }
        for (const locId of byLoc.keys()) byLoc.set(locId, []);
        for (const r of ungrouped) {const { __locId, ...rest } = r;byLoc.get(__locId)?.push(rest);}
        for (const [sq, group] of groupsBySquare) {
          const locId = (() => {
            const swLoc = String(entryByDelivery.get(String(group.find((r) => r.delivery_id)?.delivery_id))?.location_id || '');
            return byLoc.has(swLoc) ? swLoc : group[0].__locId;
          })();
          // Same-driver check (driver scoping rule) — enforced ONLY for
          // driver viewers (scopeId set): their rows are already filtered to
          // their own deliveries, so mixed groups can't form for them anyway.
          // OWNER REPORT (Oct 24 2026, Beverly Dickie + Burton Demeriez —
          // one swipe, two drivers, two dates): for unscoped viewers
          // (owner/dispatcher, driverScopeId null) a mixed-driver group is
          // the REAL transaction and MUST merge into one combined card.
          // HOTFIX (01:26 MDT): v1.9.70 referenced a scopeId variable that
          // does NOT exist in this closure — the ReferenceError was caught
          // by the surrounding try and DISABLED combining entirely (12
          // 'scopeId is not defined' warns). Component-level driverScopeId
          // is the correct viewer-scoping source.
          const scopeIds = [...new Set(group.map((r) => String(r.driver_id || 'null')))];
          if (driverScopeId && scopeIds.length > 1) {for (const r of group) {const { __locId, ...rest } = r;byLoc.get(__locId)?.push(rest);}continue;}
          if (group.length <= 1) {const { __locId, ...rest } = group[0];byLoc.get(__locId)?.push(rest);continue;}
          // Per-item ledger entries for THIS group's deliveries only —
          // sibling items collected on another day keep their own share.
          const groupDelIds = new Set(group.map((r) => String(r.delivery_id)));
          const groupEntries = (entriesBySquare.get(sq) || []).filter((e) => groupDelIds.has(String(e.delivery_id)));
          const grossC = Math.round(group.reduce((s, r) => s + r.amount, 0) * 100);
          const label = group.find((r) => r.collectedLabel === 'Debit')?.collectedLabel || group[0].collectedLabel || 'Debit';
          const feeC = sumCents(groupEntries, 'fee_cents');
          const folderC = sumCents(groupEntries, 'folder_cents');
          const loanC = sumCents(groupEntries, 'loan_cents');
          const settledC = sumCents(groupEntries, 'settled_cents');
          const hasLedgerCents = groupEntries.length > 0 && (feeC > 0 || folderC > 0 || loanC > 0 || settledC > 0);
          const names = [...new Set(group.map((r) => r.patientName).filter(Boolean))];
          const mergedRow = {
            key: `tx-${sq}`,
            delivery_id: null, // combined card — per-delivery actions don't apply
            combinedCount: group.length,
            combinedItems: group.map((r) => ({ storeAbbrev: r.storeAbbrev || null, storeColor: r.storeColor || null, patientName: r.patientName || null, amount: r.amount, sub: r.sub || null })),
            driver_id: group[0].driver_id || null,
            driverName: group[0].driverName || null,
            patientName: names.join(' + ') || 'COD',
            storeAbbrev: group[0].storeAbbrev || null,
            storeColor: group[0].storeColor || null,
            amount: grossC / 100,
            sub: group.map((r) => r.sub).filter(Boolean).sort()[0] || group[0].sub || '',
            collected: true,
            hasCardSpend: true,
            manualCardSpend: group.some((r) => r.manualCardSpend),
            collectedLabel: label,
            netAmount: hasLedgerCents && settledC > 0 ?
            settledC / 100 :
            group.reduce((s, r) => s + (Number(r.netAmount) || 0), 0),
            feeParts: hasLedgerCents ?
            { fee: feeC / 100, folder: folderC / 100, loan: loanC / 100 } :
            group[0].feeParts ?
            { // no ledger cents — sum the stored per-item splits
              fee: group.reduce((s, r) => s + (r.feeParts?.fee || 0), 0),
              folder: group.reduce((s, r) => s + (r.feeParts?.folder || 0), 0),
              loan: group.reduce((s, r) => s + (r.feeParts?.loan || 0), 0) } :
            { // last resort: estimate fees ONCE on the combined total
              fee: estimateCardFeeCents(grossC, label) / 100,
              folder: folderCentsFor(grossC, folderRateNow) / 100,
              loan: Math.round(grossC * Number(loanRateByLoc.get(locId) || 0)) / 100 }
          };
          byLoc.get(locId)?.push(mergedRow);
        }
      } catch (e) {
        console.warn('[SquareBalances] combined-transaction grouping skipped:', e?.message || e);
      }

      const out = {};
      for (const [locId, rows] of byLoc) out[locId] = rows;
      setCodCollectedTodayByLoc(out);
    } catch (e) {
      console.error('cod collected-today compute failed:', e);
    }
  }, []);

  // OWNER REPORT (Oct 25 2026, 23:47): phone page values went stale — the
  // sidebar/bottom-nav live-updated but the PAGE kept old numbers and even the
  // Refresh button repainted the same stale values; only a full app restart
  // fixed it. Root cause: on NON-Editor devices the page's local chain
  // (loadConfig + loadSales) recomputes from this device's own in-memory/IDB
  // ledger mirrors, which lag behind the Editor's authoritative compute that
  // the shared snapshot already carries. Fix: after the local chain (which
  // still fills Collected-today and other locally-derived bits), non-host
  // devices repaint from the latest SHARED SNAPSHOT so the Editor's numbers
  // win. The Editor host keeps its local result (it IS the source of the
  // snapshot — painting its own last publish could be staler than its fresh
  // local chain).
  const isEditorHostRef = useRef(null);
  const resolveIsEditorHost = useCallback(async () => {
    if (isEditorHostRef.current !== null) return isEditorHostRef.current;
    try {
      const rec = await getCurrentDevice(currentUser?.id);
      isEditorHostRef.current = rec?.device_name === EDITOR_HOST_DEVICE_NAME;
    } catch {isEditorHostRef.current = false;}
    return isEditorHostRef.current;
  }, [currentUser?.id]);

  const paintLatestSharedSnapshot = useCallback(async () => {
    try {
      const rec = await fetchLatestSharedSnapshot().catch(() => null);
      if (rec?.payload) {
        const data = deserializeSummary(rec.payload);
        if (!data) return false;
        // CONFIG IS NEVER TAKEN FROM THE CACHE WHEN A REAL ONE IS LOADED
        // (owner report Oct 28 2026: Bonnie Doon loan fees stayed at 17.25%
        // after the rate was corrected to 16.5% in AppSettings). The shared
        // snapshot carries a COPY of whatever config the publishing device
        // had in memory — a device that published before a rate change keeps
        // re-seeding the old rate into every other device's page on load.
        // AppSettings is the source of truth; the snapshot copy only fills in
        // when nothing local has loaded yet.
        if (data.config) setConfig((prev) => prev || data.config);
        if (data.configRecordId) setConfigRecordId(data.configRecordId);
        setDeliveryCredits(data.deliveryCredits instanceof Map ? data.deliveryCredits : new Map(Array.isArray(data.deliveryCredits) ? data.deliveryCredits : []));
        setPayouts(data.payouts || []);
        if (data.codOutstandingDetailed && Object.keys(data.codOutstandingDetailed).length) setLocalOutstanding(data.codOutstandingDetailed);
        return true;
      }
    } catch {/* snapshot is best-effort */}
    return false;
  }, []);

  const refresh = useCallback(async (opts = {}) => {
    setIsLoading(true);
    try {
      let cfg = config;
      if (opts.reloadConfig || !cfg) cfg = await loadConfig();
      await loadSales(cfg);
      // Non-host devices: the Editor's published numbers are authoritative —
      // repaint LAST so stale local mirrors can't keep the old values on screen.
      if (!(await resolveIsEditorHost())) {
        await paintLatestSharedSnapshot();
      }
    } finally {
      setIsLoading(false);
    }
  }, [config, loadConfig, loadSales, resolveIsEditorHost, paintLatestSharedSnapshot]);

  // LIVE PAGE UPDATES (non-host devices): while this page is open, repaint
  // whenever the Editor publishes a fresh shared snapshot — same WS feed the
  // sidebar/bottom-nav already listen on, so the page finally tracks the
  // desktop in real time instead of waiting for a restart.
  useEffect(() => {
    if (!currentUser?.id) return;
    let unsub = null;
    let pending = null;
    let cancelled = false;
    (async () => {
      if (await resolveIsEditorHost()) return; // host computes locally — no self-echo repaint
      unsub = subscribeSharedSnapshot(() => {
        clearTimeout(pending);
        pending = setTimeout(() => {if (!cancelled) void paintLatestSharedSnapshot();}, 2000);
      });
    })();
    return () => {cancelled = true;clearTimeout(pending);unsub?.();};
  }, [currentUser?.id, resolveIsEditorHost, paintLatestSharedSnapshot]);

  // Fresh numbers every visit: load config, pull new Square sales since the
  // true-up, then read the ledger. The 9pm briefing also freshens the ledger,
  // and the Refresh button does it on demand.
  useEffect(() => {
    let pageBootCancelled = false;
    const applySnapshotData = (data) => {
      if (!data || pageBootCancelled) return false;
      // Same rule as paintLatestSharedSnapshot: the snapshot's config copy is
      // whatever the publisher had in memory and must never beat the real
      // AppSettings config already loaded on this device (Oct 28 2026 rate fix).
      if (data.config) setConfig((prev) => prev || data.config);
      if (data.configRecordId) setConfigRecordId(data.configRecordId);
      setDeliveryCredits(data.deliveryCredits instanceof Map ? data.deliveryCredits : new Map(Array.isArray(data.deliveryCredits) ? data.deliveryCredits : []));
      setPayouts(data.payouts || []);
      if (data.codOutstandingDetailed && Object.keys(data.codOutstandingDetailed).length) setLocalOutstanding(data.codOutstandingDetailed);
      setIsLoading(false);
      return true;
    };
    (async () => {
      // PAINT ORDER (owner report Oct 9 2026: page showed a sync state for
      // 10-30s before store cards appeared, and uncollected rows showed
      // 'Pending' for 1-2 min before flipping to 'Cash'):
      // 1. SHARED ONLINE SNAPSHOT (SquareBalancesSnapshot entity) — one
      //    small entity read, no IDB involvement. The boot write-storm holds
      //    IDB reads in a write-drain gate for tens of seconds, but the
      //    shared record paints the full page (cards + rows + cash badges,
      //    cashAwaitingSquare is baked into the items) in ~1-2s.
      // 2. IDB snapshot — offline fallback when the entity read fails.
      // 3. Local compute chain below — still authoritative, it overwrites
      //    everything once done.
      // Driver row-scoping stays at render (driverScopeId filters), so the
      // shared payload is safe on driver devices too.
      let painted = false;
      try {
        const rec = await fetchLatestSharedSnapshot().catch(() => null);
        if (rec?.payload) painted = applySnapshotData(deserializeSummary(rec.payload));
      } catch {/* fall through to IDB */}
      // OFFLINE-FIRST (Oct 2 2026): paint the last IDB snapshot instantly so
      // the page opens with real numbers even before the network round-trips
      // (config + sales + payouts + CODs outstanding all live in the snapshot
      // the sidebar hook writes after every successful load). User-scoped:
      // never render another account's balances. Server loads below then
      // overwrite everything with fresh data.
      if (!painted) {
        try {
          // Pass the CURRENT config once it is loaded: a snapshot computed
          // under a different loan/folder rate sheet is discarded so the card
          // balance can never render pre-fix money math (Oct 28 2026).
          const snap = await getSummarySnapshot(configRef.current || null).catch(() => null);
          if (snap?.payload && (!snap.user_id || snap.user_id === currentUser?.id)) {
            applySnapshotData(deserializeSummary(snap.payload));
          }
        } catch (e) {/* snapshot is best-effort — server load below is authoritative */}
      }
      // PAGE LOAD INITIATES THE SERVER-SIDE SYNC (owner spec Oct 9 2026):
      // the paint above is already showing — this forces the
      // squareBalancesCompute backend function to run once on page open (the
      // initiating device receives the fresh payload and publishes the
      // shared record, broadcasting every other device to convergence).
      // OWNER REQUEST (Oct 9 2026 night): SYNC THE SQUARE CODs BEFORE the
      // balance compute reads the ledger — but NON-BLOCKING (owner report
      // 22:50: awaiting the 40s+ squareLedgerSync here froze the boot chain
      // BEFORE computeCodCollectedToday ran, and since the shared snapshot
      // paint carries no Collected-today data, every store showed an EMPTY
      // Collected-today list for the whole sync). The ledger pull rides in
      // the background; the compute chain below fills Collected-today
      // immediately; when the background sync lands, the ledger cache drops
      // and a second 'squareBalancesRefreshed' re-runs the backend compute on
      // fresh ledger rows (swiped-cash credits + discrepancies). The heavy
      // catalog reconcile stays on the Sync button.
      if (ownerCanEditRef.current && !pageBootCancelled) {
        void (async () => {
          try {
            // OWNER DIRECTIVE (Oct 27 2026): no cash-collection gate — the
            // sync runs on page load too (a driver's card swipe for a
            // cash-collected COD can land after the last collection event).
            // Throttled by the SHARED 90s marker so the pre-compute path and
            // this boot path never double-run.
            const _nowMs = Date.now();
            const _lastSyncMs = Math.max(
              Number(localStorage.getItem(LS_BAL_COD_SYNC) || 0),
              Number(localStorage.getItem(LS_CODPAGE_SYNC) || 0));
            if (_nowMs - _lastSyncMs < 90_000) {
              console.log('[SquareBalances] page-load COD sync skipped — synced within the last 90s');
              return;
            }
            const tu = configRef.current?.trued_up_at || new Date(Date.now() - 3 * 86400000).toISOString();
            await base44.functions.invoke('squareLedgerSync', { startDate: tu, includeCodOutstanding: true });
            if (pageBootCancelled) return;
            localStorage.setItem(LS_BAL_COD_SYNC, String(_nowMs));
            invalidateLedgerWindows();
            window.dispatchEvent(new CustomEvent('squareBalancesRefreshed'));
            // Catalog verification (owner spec Oct 27 2026): recheck the
            // current active Square Catalog items for collected transactions
            // across their own full age window — collected items clear.
            await base44.functions.invoke('squareVerifyCatalog', {}).catch((e) => {
              console.warn('[SquareBalances] page-load catalog verify failed:', e?.message || e);
            });
            // FRESH DELIVERY MIRROR (owner report Oct 27 2026 night): the
            // sync just stamped collections server-side — heal the IDB mirror
            // and recompute the page lists so rows updated to Collected LEAVE
            // the Uncollected sections immediately (no WS echo arrives for
            // service-role writes).
            invalidateServerOverlay();
            invalidateIdbReadCache('deliveries');
            await healDeliveryMirror().catch(() => {});
            computeCodCollectedTodayRef.current?.();
            computeLocalOutstandingRef.current?.();
            computeCatalogUncollectedRef.current?.();
          } catch (e) {
            console.warn('[SquareBalances] page-load COD sync failed (compute keeps cached ledger):', e?.message || e);
          }
        })();
      }
      window.dispatchEvent(new CustomEvent('squareBalancesRefreshed'));
      try {
        // OWNER SPEC (Oct 7 2026): NO Square API sync on this page anymore —
        // mount computes strictly from delivery data (credits, outstanding,
        // collected-today) plus cached ledger payout/topup rows.
        const cfg = await loadConfig();
        await loadSales(cfg);
        computeLocalOutstanding();
        computeCodCollectedToday();
        computeCatalogUncollected();
        loadDailyCod();
      } catch (e) {
        console.error('balances load failed:', e);
      } finally {
        setIsLoading(false);
        setIsSyncing(false);
      }
    })();
    return () => {pageBootCancelled = true;};
    /* eslint-disable-next-line */
  }, []);

  // OWNER SPEC (Oct 7 2026) — STRICTLY DELIVERY DATA: the Sync button no
  // longer calls the Square API (squareLedgerSync / squareGetCodData2 are
  // retired on this page). It re-reads fresh DELIVERY data — credits from
  // finished deliveries' cod_payments, outstanding from active deliveries,
  // collected-today — plus cached ledger payout rows. The Square COD page and
  // the Audit page keep their own syncs.
  // ── SQUARE COD SYNC COOLDOWN (owner request Oct 9 23:32) ──────────────
  // The COD sync (squareLedgerSync + catalog reconcile) only needs to re-run
  // when a CASH COD has been collected since the last sync — that's the
  // only event that adds something new for Square to register. The marker
  // also credits the Square COD page's own full sync
  // (squareCod_lastOrderFetchAt) so the two pages never double-run.
  const LS_BAL_COD_SYNC = 'squareBalances_lastCodSyncAt';
  const LS_CODPAGE_SYNC = 'squareCod_lastOrderFetchAt';
  const lastCodSyncAtMs = () => Math.max(
    Number(localStorage.getItem(LS_BAL_COD_SYNC) || 0),
    Number(localStorage.getItem(LS_CODPAGE_SYNC) || 0)
  );

  const syncFromSquare = useCallback(async () => {
    setIsSyncing(true);
    try {
      let cfg = config;
      if (!cfg?.trued_up_at) cfg = await loadConfig();

      // ── OWNER REQUEST (Oct 9 2026 night): SYNC THE SQUARE CODs FIRST.
      // The balances math reads the LEDGER (swiped-cash settled credits +
      // payment discrepancies), so the SquareLedgerEntry rows must be fresh
      // BEFORE the balance compute runs. Same two-step order as the Square
      // COD page (Oct 7 spec): squareLedgerSync FIRST (pulls real Square
      // payments, splits grouped rings, stamps cod_confirmed_collected),
      // THEN squareGetCodData2 catalog reconcile (sees the confirmations and
      // clears the matched catalog items). Owner-only — drivers keep the
      // local-only refresh.
      let codSyncNote = '';
      // OWNER DIRECTIVE (Oct 27 2026): the Square sync runs on EVERY balances
      // refresh (no cash-collection gate — a driver's card swipe for a
      // cash-collected COD can land after the last collection event, and the
      // gate was skipping those).
      if (ownerCanEdit) {
        const startDate = cfg?.trued_up_at || new Date(Date.now() - 3 * 86400000).toISOString();
        setSyncStatusText('Syncing Square payments…');
        try {
          const res = await base44.functions.invoke('squareLedgerSync', { startDate, includeCodOutstanding: true });
          const out = res?.codOutstanding || [];
          const byLoc = {};out.forEach((o) => {byLoc[o.location_id] = o;});
          setCodOutstandingByLoc(byLoc);
          // The sync wrote NEW ledger rows service-side (no WS echo reaches
          // us) — drop the windows cache before the computes below re-read.
          invalidateLedgerWindows();
          codSyncNote = 'Square CODs synced';
          localStorage.setItem(LS_BAL_COD_SYNC, String(Date.now()));
        } catch (err) {
          console.warn('[SquareBalances] squareLedgerSync failed (continuing with cached ledger):', err?.message || err);
          codSyncNote = 'COD sync failed — used cached ledger';
        }
        // STEP 2 — CATALOG VERIFICATION (owner spec Oct 27 2026): instead of the
        // old 90-day squareGetCodData2 reconcile, recheck the CURRENT active
        // Square Catalog items for collected transactions across their OWN
        // full age window (some past items are older than any fixed lookback).
        // Collected items clear; uncollected items are never touched. Shares
        // the Square COD page's localStorage lease so the two syncs never run
        // concurrently (shared Square rate-limit budget).
        setSyncStatusText('Verifying Catalog Items.');
        try {
          const LS_INFLIGHT = 'squareCodSync_inFlightUntil';
          const nowMs = Date.now();
          if (Number(localStorage.getItem(LS_INFLIGHT) || 0) > nowMs) {
            console.log('[SquareBalances] catalog verify skipped — Square COD page sync already running');
          } else {
            localStorage.setItem(LS_INFLIGHT, String(nowMs + 240000));
            try {
              const codRes = await base44.functions.invoke('squareVerifyCatalog', {});
              // Sync status detail (owner spec): show the catalog adds/deletes
              // this reconcile performed — "Adding/Deleting [name - amount]".
              const fmt = (arr, verb) => (arr || []).map((c) => `${verb} ${c.name} - $${(Math.round(Number(c.amount_cents || 0)) / 100).toFixed(2)}`);
              const detail = [
              ...fmt(codRes?.catalogCreated, 'Adding'),
              ...fmt(codRes?.catalogDeleted, 'Deleting')];

              setSyncStatusText(detail.length ?
              `Syncing Catalog Items. (${detail.join(', ')})` :
              'Syncing Catalog Items. (no changes)');
            } finally {
              localStorage.removeItem(LS_INFLIGHT);
            }
          }
        } catch (err) {
          console.warn('[SquareBalances] COD catalog sync after ledger sync failed:', err);
        }
      }
      // FRESH DELIVERY MIRROR (owner report Oct 27 2026 night): the sync
      // steps above stamp collections SERVER-SIDE (cod_confirmed_collected /
      // tender confirmations — service-role writes, no WS echo). Without a
      // mirror heal the recomputes below still read the STALE IDB copy and a
      // COD updated to Collected kept showing in the Uncollected sections.
      // Pull the recently-updated deliveries into IDB first, then recompute.
      try {
        invalidateServerOverlay();
        invalidateIdbReadCache('deliveries');
        await healDeliveryMirror();
      } catch (e) {
        console.warn('[SquareBalances] delivery mirror heal failed (recomputes may be stale):', e?.message || e);
      }
      setSyncStatusText('Syncing Square Balances.');
      await loadSales(cfg);
      await computeLocalOutstanding(cfg);
      await computeCodCollectedToday();
      computeCatalogUncollected();
      loadDailyCod();
      // PAYMENT DISCREPANCIES (owner spec Oct 9 2026 night): the backend
      // balances updater flags recorded-vs-Square tender mismatches during
      // the compute this sync triggers — pull the fresh open list after it.
      if (ownerCanEdit) loadPaymentDiscrepancies();
      // SIDEBAR BADGE SYNC (owner report Oct 8 2026: Refresh Square updated
      // the page cards but the sidebar badge kept a stale total): this refresh
      // is strictly local re-reads — no server write, so no WS broadcast ever
      // reaches the badge hook. Drop the shared ledger-windows cache (same
      // cache the badge computes from, up to 10 min stale) and broadcast a
      // local event so the sidebar badge force-reloads with fresh numbers on
      // the SAME device that clicked Refresh.
      invalidateLedgerWindows();
      window.dispatchEvent(new CustomEvent('squareBalancesRefreshed'));
      toast.success(codSyncNote ? `${codSyncNote}, delivery data refreshed` : 'Delivery data refreshed');
    } catch (err) {
      console.error('delivery-data refresh failed:', err);
      toast.error('Refresh failed');
    } finally {
      // Keep the final status line up briefly so the owner can read what the
      // catalog reconcile did before it fades.
      setTimeout(() => setSyncStatusText(''), 4000);
      setIsSyncing(false);
    }
  }, [config, loadConfig, loadSales, computeLocalOutstanding, computeCodCollectedToday, ownerCanEdit, loadPaymentDiscrepancies]);

  loadSalesRef.current = loadSales;
  syncRef.current = syncFromSquare;
  configRef.current = config;
  computeLocalOutstandingRef.current = computeLocalOutstanding;
  computeCodCollectedTodayRef.current = computeCodCollectedToday;
  computeCatalogUncollectedRef.current = computeCatalogUncollected;
  ownerCanEditRef.current = ownerCanEdit;

  // ── WebSocket live updates ──
  // AppSettings broadcasts (user-scoped true-up writes) → live config/sales reload
  // so a true-up on another device shows immediately.
  // Delivery broadcasts (driver COD activity: created/completed/collected) →
  // debounced 45s full re-sync so "CODs out" stays live while the page is open.
  // SquareLedgerEntry broadcasts (user-scoped writes only; backend service-role
  // syncs do NOT broadcast) → debounced 5s sales re-read.
  // Manual Card Spend marks: load on mount, keep fresh on AppSettings
  // broadcasts (marking on one device instantly shows the violet pill on
  // every open device).
  useEffect(() => {loadSpendMarks();}, [loadSpendMarks]);

  useEffect(() => {
    const unsubs = [];
    let cfgTimer = null,ledgerTimer = null,deliveryTimer = null,codTimer = null,catalogTimer = null,cardCollectedTimer = null;
    // Fast path: COD add/remove on any delivery → recompute outstanding locally (8s debounce).
    const scheduleCodRecompute = () => {
      clearTimeout(codTimer);
      codTimer = setTimeout(() => {computeLocalOutstandingRef.current?.();computeCodCollectedTodayRef.current?.();computeCatalogUncollectedRef.current?.();loadDailyCodRef.current?.();refreshDeliveryCreditsRef.current?.();}, 8000);
    };
    try {
      unsubs.push(base44.entities.AppSettings.subscribe((event) => {
        if (event?.data?.setting_key === SPEND_MARKS_KEY) {
          // Apply the broadcast record DIRECTLY (Oct 6 2026 "2 clicks" fix):
          // re-reading (even freshly) can race the just-written value, and a
          // cached read serves the pre-toggle state — either reverts the
          // optimistic flip. The broadcast carries the authoritative record.
          const seq = ++spendMarksSeq.current;
          const raw = event?.data?.setting_value && typeof event.data.setting_value === 'object' ? event.data.setting_value : {};
          const value = {};
          for (const [k, v] of Object.entries(raw)) {
            if (!v || typeof v !== 'object') continue;
            if (v.notTappedAt) value[k] = { notTapped: true, touchedAt: v.notTappedAt, by: v.by };else
            if (v.touchedAt) value[k] = { notTapped: !!v.notTapped, touchedAt: v.touchedAt, by: v.by };
          }
          if (event?.data?.id) spendMarksRecordIdRef.current = event.data.id;
          if (seq !== spendMarksSeq.current) return;
          setManualSpendMarks(value);
          manualSpendMarksRef.current = value;
          computeCodCollectedTodayRef.current?.();
          return;
        }
        // Backend ledger-sync stamp (Oct 7 2026): squareLedgerSync changed
        // links/splits/confirmations server-side. Its entity writes are
        // service-role — no SquareLedgerEntry WS echo ever reaches this
        // page — so drop the ledger cache and reload sales from this stamp.
        if (event?.data?.setting_key === 'square_ledger_sync') {
          invalidateLedgerWindows();
          clearTimeout(ledgerTimer);
          ledgerTimer = setTimeout(() => {
            loadSalesRef.current?.(configRef.current);
            computeLocalOutstandingRef.current?.();
            computeCodCollectedTodayRef.current?.();
            computeCatalogUncollectedRef.current?.();
          }, 5000);
          return;
        }
        if (event?.data?.setting_key !== SETTING_KEY) return;
        clearTimeout(cfgTimer);
        cfgTimer = setTimeout(async () => {
          const cfg = await loadConfig().catch(() => null);
          if (cfg) await loadSalesRef.current?.(cfg);
        }, 2000);
      }));
    } catch (e) {console.error('AppSettings subscribe failed:', e);}
    try {
      unsubs.push(base44.entities.SquareLedgerEntry.subscribe(() => {
        invalidateLedgerWindows(); // windows cache is stale — force refetch inside loadSales
        clearTimeout(ledgerTimer);
        ledgerTimer = setTimeout(() => loadSalesRef.current?.(configRef.current), 5000);
      }));
    } catch (e) {console.error('Ledger subscribe failed:', e);}
    try {
      unsubs.push(base44.entities.SquareCatalogItems.subscribe(() => {
        invalidateCatalogSweep();
        clearTimeout(catalogTimer);
        catalogTimer = setTimeout(() => {computeCatalogUncollectedRef.current?.();}, 5000);
      }));
    } catch (e) {console.error('Catalog subscribe failed:', e);}
    try {
      unsubs.push(base44.entities.Delivery.subscribe((event) => {
        scheduleCodRecompute();
        // OWNER RULE (Oct 6 2026): the moment a delivery is marked Collected
        // with a Debit or Credit payment, refresh the card balances with the
        // real settled values — a short-debounce Square sync (owner tab only).
        const ed = event?.data;
        if (
        ownerCanEditRef.current &&
        String(ed?.status || '') === 'completed' &&
        Array.isArray(ed?.cod_payments) &&
        ed.cod_payments.some((pm) => ['debit', 'credit'].includes(String(pm?.type || '').toLowerCase())))
        {
          clearTimeout(cardCollectedTimer);
          cardCollectedTimer = setTimeout(() => {syncRef.current?.();}, 20000);
        }
        // Full Square re-sync on sustained activity only (protects Square API rate limits)
        // — owner-only: a driver's open tab must never fire Square API syncs.
        clearTimeout(deliveryTimer);
        deliveryTimer = setTimeout(() => {if (ownerCanEditRef.current) syncRef.current?.();}, 300000);
      }));
    } catch (e) {console.error('Delivery subscribe failed:', e);}
    // Same-device delivery edits (DeliveryForm/StopCard dispatch these) — WS echo
    // suppression blocks our own writes for 5 min, so also listen to the app events.
    const onDeliveriesUpdated = () => scheduleCodRecompute();
    const onRouteReordered = () => scheduleCodRecompute();
    window.addEventListener('deliveriesUpdated', onDeliveriesUpdated);
    window.addEventListener('routeReordered', onRouteReordered);
    return () => {
      clearTimeout(cfgTimer);clearTimeout(ledgerTimer);clearTimeout(deliveryTimer);clearTimeout(codTimer);clearTimeout(catalogTimer);clearTimeout(cardCollectedTimer);
      unsubs.forEach((u) => {try {u?.();} catch {}});
      window.removeEventListener('deliveriesUpdated', onDeliveriesUpdated);
      window.removeEventListener('routeReordered', onRouteReordered);
    };
  }, []);

  // 7-day (excluding today) required-COD average per card (drives the green/yellow/red levels)
  const loadDailyCod = useCallback(async () => {
    try {
      const [stl, weekly] = await Promise.all([
      buildStoreToLocMap(),
      computeWeeklyCodTotalsByStore()]
      );
      setWeeklyCodAvgByLoc(weeklyAvgByLocFromStores(stl, weekly));
    } catch (e) {
      console.error('weekly COD average load failed:', e);
    }
  }, []);
  loadDailyCodRef.current = loadDailyCod;

  // FEE CONSISTENCY (owner report Oct 8 2026: folder/loan fees "not constantly
  // added/subtracted" to the corresponding balances): loan remaining, folder
  // total and the card estimate all derive from `deliveryCredits`, which only
  // refreshed inside loadSales — and the WS delivery full re-sync is 5 minutes.
  // Collected-today rows (the S/F/L fee parts) updated on the 8s fast path, so
  // fees visibly appeared while the balances sat stale. The 8s COD recompute
  // now ALSO reloads delivery credits so folder/loan/card totals move with
  // every card collection.
  const creditsSeqRef = useRef(0);
  const refreshDeliveryCredits = useCallback(async () => {
    const cfg = configRef.current;
    if (!cfg?.trued_up_at) return;
    const seq = ++creditsSeqRef.current;
    const creditsMap = await loadDeliveryCardCredits(cfg, currentUser?.id || null).catch(() => null);
    if (!creditsMap || seq !== creditsSeqRef.current) return;
    setDeliveryCredits(creditsMap);
  }, [currentUser?.id]);
  const refreshDeliveryCreditsRef = useRef(refreshDeliveryCredits);
  refreshDeliveryCreditsRef.current = refreshDeliveryCredits;

  // Bank-sweep totals per location since true-up
  const payoutByLoc = useMemo(() => payoutsByLocation(payouts), [payouts]);

  // Pre-True-Up CODs flagged "already counted" (Oct 8 2026): the snapshot of
  // delivery IDs that existed at true-up time is neutralized via excludeIds so
  // the trued-up starting balance isn't re-deducted. Only CODs created or
  // collected AFTER the true-up (absent from the snapshot) keep deducting.
  const countedIdsSet = useMemo(() => new Set((config?.trued_up_counted_ids || []).map(String)), [config?.trued_up_counted_ids]);

  // Per-location math from the sale records
  const perLocation = useMemo(() => {
    if (!config) return [];
    // Real card withdrawals per location since true-up (loadCardPayouts
    // returns 'store_withdraw' rows with amount_cents).
    const payoutCentsByLoc = new Map();
    for (const pw of payouts || []) {
      if (!pw?.location_id) continue;
      if (!payoutCentsByLoc.has(pw.location_id)) payoutCentsByLoc.set(pw.location_id, []);
      payoutCentsByLoc.get(pw.location_id).push(Math.round(Number(pw.amount_cents || 0)));
    }
    return (config.locations || []).map((loc) => {
      // OWNER SPEC (Oct 7 2026) — STRICTLY DELIVERY DATA: gross/fees/loan/
      // folder/credits come from FINISHED deliveries' recorded Debit/Credit
      // cod_payments (loadDeliveryCardCredits), net of the fee rate sheet.
      // The Square-ledger sale scan (and its store-card fingerprint
      // exclusions) is retired on this page.
      const dc = deliveryCredits.get(loc.location_id) || {};
      const gross = Number(dc.gross || 0);
      const fees = Number(dc.fees || 0);
      const loan = Number(dc.loan || 0);
      const folder = Number(dc.folder || 0);
      const credits = Number(dc.credits || 0);
      const storeCardSpend = 0;
      const r2 = (x) => Math.round(x * 100) / 100;
      const codOut = localOutstanding?.[loc.location_id] || codOutstandingByLoc[loc.location_id] || null;
      // ESTIMATE-SIDE COD LIST = active uncollected items + collected-charge
      // deduction items (owner report Oct 7 2026, $53.05 Londonderry case): a
      // deducted COD KEEPS its deduction after completion — the order's goods
      // were already charged to the Square card. Only the collected net
      // (credits) comes back on top.
      // + legacyDeductItems (owner report Oct 31 2026): uncollected CODs from
      // before the current window are hidden from the lists and the Charged to
      // Card total, but they still hold their charge off the card — dropping
      // them made this estimate read too high.
      const estimateItems = [...(codOut?.items || []), ...(codOut?.deductItems || []), ...(codOut?.legacyDeductItems || [])];
      // REAL card withdrawals only (owner report Oct 7 2026): a card sale's
      // settled/net cents auto-sweep FROM the store location ONTO the card
      // ('store_topup' rows) — they ARRIVE, they never leave. Subtracting
      // them while also crediting the collection netted each sale to ~zero
      // while the real cards grew (the "way off since true-up" report). Only
      // 'store_withdraw' payouts subtract now.
      const withdrawn = (payoutCentsByLoc.get(loc.location_id) || []).reduce((sum, c) => sum + (Number(c) || 0), 0) / 100;
      // Owner rule (Oct 6-7 2026): a pre-True-Up COD stays neutral until the
      // owner explicitly clicks its badge since that True-Up; a brand-new
      // (post-True-Up) COD deducts by default and STAYS deducted after
      // collection. See computePendingCodDeduction.
      const { deductCents: pendingDeductCents, count: pendingDeductCount } = computePendingCodDeduction(estimateItems, manualSpendMarks || {}, countedIdsSet, config?.trued_up_at || null);
      // DISPLAY figure (owner report Oct 31 2026: balances correct, but "CODs
      // charged to card" read −$444 against lists that only show the current
      // window). The card estimate above keeps the FULL balance scope; this
      // line shows only the charges still listed on the page, so the number
      // matches the rows the owner can see and tap.
      // Mirrors the ROWS on this card (owner report Oct 31 2026): uncollected
      // rows wear a Card Spend pill unless marked Not Tapped, completed
      // card-collected CODs wear one too, completed cash CODs only once marked.
      const isChargedRow = (it) => {
        const id = it?.delivery_id ? String(it.delivery_id) : null;
        const mark = id ? (manualSpendMarks || {})[id] : null;
        // Same rule as the balance math: a Not Tapped mark is stale once the
        // card was actually charged after the mark (see computePendingCod
        // Deduction — Anastasia/Callingwood $97.97 report).
        const _markAt = mark?.touchedAt ? new Date(mark.touchedAt).getTime() : null;
        const _spendAt = it?.spend_at ? new Date(it.spend_at).getTime() : null;
        const _superseded = _spendAt != null && Number.isFinite(_spendAt) && (_markAt == null || !Number.isFinite(_markAt) || _spendAt >= _markAt);
        if (mark?.notTapped === true && !_superseded) return false;
        if (String(it?.status || '') === 'completed') {
          if (it?.reason === 'collected_charge') return true;
          return !!mark;
        }
        return true;
      };
      const displayItems = [...(codOut?.items || []), ...(codOut?.deductItems || []).filter((it) => it?.in_window !== false)].filter(isChargedRow);
      let displayDeductCents = 0;let displayDeductCount = 0;
      for (const it of displayItems) {
        const c = Math.round(Number(it?.amount || 0) * 100);
        if (!(c > 0)) continue;
        displayDeductCents += c;displayDeductCount += 1;
      }
      return {
        ...loc,
        saleCount: Number(dc.count || 0),
        gross: r2(gross), fees: r2(fees), loanPaid: r2(loan), folderContrib: r2(folder), netCredits: r2(credits),
        sweptOut: r2(withdrawn), // real withdrawals since true-up
        chargedToCard: 0, // payout-matching retired Oct 7: sale nets ARRIVE on the card
        chargedCount: 0,
        storeCardSpend: r2(storeCardSpend),
        // UN-SWIPED CODs DO NOT REDUCE THE BALANCE (owner rule, Oct 2 2026,
        // Londonderry $528.17 report): a COD only counts as money removed from
        // the card once its real card spend exists in the Square records (the
        // spend lands as a card sale credit and confirms the delivery).
        // Outstanding CODs stay visible as "owed, not yet swiped" and drive
        // the low-balance forecast, but do NOT subtract from the estimate.
        // BATCH bank sweeps since true-up leave the real card too (Oct 2 2026 fix)
        // Full integer-cent estimate (owner spec Oct 7 2026, "CW $10.64 vs
        // $10.65"): float dollar addition can land a cent off — sum cents,
        // divide once.
        cardEstimate: (Math.round(Number(loc.card_start || 0) * 100) + Math.round(credits * 100) - Math.round(withdrawn * 100) - pendingDeductCents) / 100,
        loanRemaining: r2(Math.max(0, Number(loc.loan_start || 0) - loan)),
        weeklyCodAvg: r2(Number(weeklyCodAvgByLoc[loc.location_id] || 0)),
        level: getBalanceLevel((Math.round(Number(loc.card_start || 0) * 100) + Math.round(credits * 100) - Math.round(withdrawn * 100) - pendingDeductCents) / 100, Number(weeklyCodAvgByLoc[loc.location_id] || 0)),
        pendingDeducted: r2(displayDeductCents / 100),
        pendingDeductCount: displayDeductCount,
        balanceDeduction: r2(pendingDeductCents / 100),
        codOutstanding: codOut,
        lastSaleAt: dc.lastAt || null
      };
    });
  }, [config, deliveryCredits, payoutByLoc, payouts, codOutstandingByLoc, localOutstanding, weeklyCodAvgByLoc, manualSpendMarks, countedIdsSet]);

  // ── PAGE-TRUTH PUBLISH (owner fix Oct 20 2026) ───────────────────────────
  // The sidebar Card-Balances badge reads the shared snapshot, whose compute
  // pipeline is duty-gated (no computes at night / rate-limit degradation), so
  // the badge kept serving hours-old numbers ($9) while this page's fresh math
  // (evening collections baked into deliveryCredits) showed $280.36. This page
  // is the value the owner watches and trusts — publish its computed summary
  // into the shared pipeline: local store (badge updates instantly here),
  // IDB mirror, and the shared snapshot for every other device.
  // OWNER/ADMIN ONLY (drivers view their own cards; only the owner's page is
  // the trusted compute), throttled to one publish per 60s with a trailing
  // publish so the LAST state always lands.
  const pagePublishLastRef = useRef(0);
  const pagePublishTimerRef = useRef(null);
  const pagePublishDataRef = useRef(null);
  const runPagePublish = useCallback(() => {
    const snap = pagePublishDataRef.current;
    if (!snap || !snap.byLocId || snap.byLocId.size === 0) return;
    pagePublishLastRef.current = Date.now();
    publishFromBalancesPage(snap, { userId: currentUser?.id || null, userName: currentUser?.full_name || 'Square Balances page' }).catch(() => {});
  }, [currentUser?.id, currentUser?.full_name]);
  useEffect(() => {
    if (!ownerCanEdit || !config || !perLocation || perLocation.length === 0) return;
    const byLocId = new Map(perLocation.map((p) => [p.location_id, {
      name: p.name || p.location_id,
      cardEstimate: p.cardEstimate,
      loanRemaining: p.loanRemaining,
      codAvg: p.weeklyCodAvg || 0,
      sweptOut: p.sweptOut || 0,
      chargedToCard: 0, chargedCount: 0,
      pendingDeducted: p.pendingDeducted || 0,
      pendingDeductCount: p.pendingDeductCount || 0,
      storeCardSpend: p.storeCardSpend || 0,
      level: p.level
    }]));
    const codOutstandingDetailed = {};
    for (const loc of config.locations || []) {
      const out = localOutstanding?.[loc.location_id] || codOutstandingByLoc?.[loc.location_id] || null;
      if (out) codOutstandingDetailed[loc.location_id] = out;
    }
    pagePublishDataRef.current = {
      byLocId,
      deliveryCredits, payouts, codOutstandingDetailed,
      config, configRecordId,
      weeklyByLoc: weeklyCodAvgByLoc
    };
    const now = Date.now();
    const since = now - pagePublishLastRef.current;
    if (since >= 60_000) {runPagePublish();return;}
    if (pagePublishTimerRef.current) return;
    pagePublishTimerRef.current = setTimeout(() => {
      pagePublishTimerRef.current = null;
      if (Date.now() - pagePublishLastRef.current >= 60_000) runPagePublish();
    }, 60_000 - since + 250);
  }, [ownerCanEdit, config, perLocation, deliveryCredits, payouts, codOutstandingByLoc, localOutstanding, weeklyCodAvgByLoc, configRecordId, runPagePublish]);
  useEffect(() => () => {if (pagePublishTimerRef.current) clearTimeout(pagePublishTimerRef.current);}, []);

  // SINGLE folder total — the 2% flows from every card's sales into ONE folder
  const folderTotal = useMemo(() => {
    if (!config) return 0;
    // STRICTLY DELIVERY DATA (Oct 7 2026): the folder accrues from finished
    // deliveries' Debit/Credit card payments — loadDeliveryCardCredits already
    // applied folder% per payment. No ledger rows involved.
    let total = Number(config.folder_start || 0);
    for (const dc of deliveryCredits.values()) total += Number(dc.folder || 0);
    return Math.round(total * 100) / 100;
  }, [config, deliveryCredits]);

  const startTrueUp = () => {
    const draft = {};
    (config?.locations || []).forEach((loc) => {
      // loan_rate stays blank in the dialog — the placeholder shows the
      // existing rate as a percent (17.25); blank keeps the stored fraction.
      draft[loc.location_id] = { card: '', loan: '', loan_rate: '' };
    });
    draft.__folder = '';
    setTrueUpDraft(draft);
    setShowTrueUp(true);
  };

  const startTopUp = () => {
    const draft = {};
    (config?.locations || []).forEach((loc) => {draft[loc.location_id] = '';});
    setTopUpDraft(draft);
    setShowTopUp(true);
  };

  // Funds transfer: subtract from the source card's start, add to the target
  // card's start. Same mechanism as Top-Up (adjusts card_start, does NOT reset
  // the tracking window) — it's money moving between cards, not a reconciliation.
  const openTransfer = (loc) => {
    setTransferFromLoc(loc);
    setTransferAmount('');
    setTransferToLocId('');
  };

  const saveTransfer = async () => {
    if (!config || !transferFromLoc) return;
    const amt = parseFloat(transferAmount);
    if (!Number.isFinite(amt) || amt <= 0) {toast.error('Enter a transfer amount greater than 0');return;}
    if (!transferToLocId) {toast.error('Pick a destination card');return;}
    if (transferToLocId === transferFromLoc.location_id) {toast.error('Destination must be a different card');return;}
    const locations = (config.locations || []).map((loc) => {
      if (loc.location_id === transferFromLoc.location_id) return { ...loc, card_start: Number(loc.card_start || 0) - amt };
      if (loc.location_id === transferToLocId) return { ...loc, card_start: Number(loc.card_start || 0) + amt };
      return loc;
    });
    setIsSaving(true);
    try {
      const newConfig = { ...config, locations };
      if (configRecordId) {
        await base44.entities.AppSettings.update(configRecordId, { setting_value: newConfig });
      } else {
        const created = await base44.entities.AppSettings.create({ setting_key: SETTING_KEY, setting_value: newConfig, description: 'Square card/loan/folder balance tracker config' });
        setConfigRecordId(created?.id || null);
      }
      setConfig(newConfig);
      const toName = (config.locations || []).find((l) => l.location_id === transferToLocId)?.name || transferToLocId;
      toast.success(`Transferred ${fmtMoney(amt)} from ${transferFromLoc.name || transferFromLoc.location_id} to ${toName}`);
      setTransferFromLoc(null);
    } catch (err) {
      console.error('funds transfer failed:', err);
      toast.error('Could not save the transfer');
    } finally {
      setIsSaving(false);
    }
  };

  // Folder transfer: subtract from the single shared folder total
  // (folder_start in the config), add onto the chosen card's card_start.
  // Same window-preserving mechanism as card-to-card. One-way only:
  // folder → card. There is no card → folder path and never will be.
  const saveFolderTransfer = async () => {
    if (!config) return;
    const amt = parseFloat(folderTransferAmount);
    if (!Number.isFinite(amt) || amt <= 0) {toast.error('Enter a transfer amount greater than 0');return;}
    if (!folderTransferToLocId) {toast.error('Pick a destination card');return;}
    if (amt > folderTotal + 0.001) {toast.error(`Amount exceeds the folder total (${fmtMoney(folderTotal)})`);return;}
    const locations = (config.locations || []).map((loc) =>
    loc.location_id === folderTransferToLocId ?
    { ...loc, card_start: Number(loc.card_start || 0) + amt } :
    loc
    );
    const newConfig = {
      ...config,
      folder_start: Number(config.folder_start || 0) - amt,
      locations
    };
    setIsSaving(true);
    try {
      if (configRecordId) {
        await base44.entities.AppSettings.update(configRecordId, { setting_value: newConfig });
      } else {
        const created = await base44.entities.AppSettings.create({ setting_key: SETTING_KEY, setting_value: newConfig, description: 'Square card/loan/folder balance tracker config' });
        setConfigRecordId(created?.id || null);
      }
      setConfig(newConfig);
      const toName = (config.locations || []).find((l) => l.location_id === folderTransferToLocId)?.name || folderTransferToLocId;
      toast.success(`Transferred ${fmtMoney(amt)} from Folder to ${toName}`);
      setFolderTransferOpen(false);
    } catch (err) {
      console.error('folder transfer failed:', err);
      toast.error('Could not save the folder transfer');
    } finally {
      setIsSaving(false);
    }
  };

  // Top-Up: ADD the typed amounts to each card's current starting balance.
  // Unlike True-Up this does NOT reset the tracking window (trued_up_at) —
  // it's money added to the cards, not a reconciliation.
  const saveTopUp = async () => {
    if (!config) return;
    const locations = (config.locations || []).map((loc) => {
      const amt = signedCentsValue(topUpDraft[loc.location_id]);
      return {
        ...loc,
        card_start: Number.isFinite(amt) && amt !== 0 ? Number(loc.card_start || 0) + amt : loc.card_start
      };
    });
    setIsSaving(true);
    try {
      const newConfig = { ...config, locations };
      if (configRecordId) {
        await base44.entities.AppSettings.update(configRecordId, { setting_value: newConfig });
      } else {
        const created = await base44.entities.AppSettings.create({ setting_key: SETTING_KEY, setting_value: newConfig, description: 'Square card/loan/folder balance tracker config' });
        setConfigRecordId(created?.id || null);
      }
      setConfig(newConfig);
      setShowTopUp(false);
      const totalTopUp = (config.locations || []).reduce((s, loc) => {
        const amt = signedCentsValue(topUpDraft[loc.location_id]);
        return Number.isFinite(amt) ? s + amt : s;
      }, 0);
      toast.success(
        totalTopUp === 0 ?
        'No amounts entered — nothing changed' :
        totalTopUp > 0 ?
        `Cards topped up (+${fmtMoney(totalTopUp)} split across cards)` :
        `Deducted ${fmtMoney(Math.abs(totalTopUp))} from cards`
      );
    } catch (err) {
      console.error('top-up save failed:', err);
      toast.error('Could not save the top-up');
    } finally {
      setIsSaving(false);
    }
  };

  // ── True-Up field formatting (owner spec Oct 8 2026) ──
  // Auto-decimal exactly like the COD amount-to-collect input: digits only,
  // typed digits are CENTS ("1234" → $12.34, "5" → 0.05 for a loan rate),
  // display always shows 2 decimals while typing. Clearing a field returns
  // it to blank (keeps the existing value on save).
  const trueUpCentsValue = (raw) => {
    const cleaned = String(raw).replace(/\D/g, '');
    if (!cleaned) return '';
    return (parseInt(cleaned, 10) || 0) / 100;
  };
  const fmtTrueUpField = (v) => {
    if (v === '' || v === undefined || v === null) return '';
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    return n.toFixed(2);
  };

  // ── Signed cents fields for Top Up / Adjust (owner request Oct 29 2026) ──
  // Same "typed digits are cents" convention as True-Up, but a leading minus is
  // KEPT so a card balance can be DEDUCTED (e.g. -5.93). The old path ran every
  // keystroke through trueUpCentsValue, whose String.replace(/\D/g, '') threw the
  // minus away, so negatives were impossible. Draft values are now the raw typed
  // string ('', '-', '-593'), so the '-' shows while typing and the number is only
  // computed on save.
  const parseSignedCentsRaw = (raw) => {
    const str = String(raw ?? '').trim();
    const negative = str.startsWith('-');
    const digits = str.replace(/\D/g, '');
    return { negative, digits };
  };
  const signedCentsRaw = (raw) => {
    const { negative, digits } = parseSignedCentsRaw(raw);
    if (!digits) return negative ? '-' : '';
    return (negative ? '-' : '') + digits;
  };
  const signedCentsValue = (raw) => {
    const { negative, digits } = parseSignedCentsRaw(raw);
    if (!digits) return null;
    const value = (parseInt(digits, 10) || 0) / 100;
    return negative ? -value : value;
  };
  const fmtSignedCentsField = (raw) => {
    const { negative, digits } = parseSignedCentsRaw(raw);
    if (!digits) return negative ? '-' : '';
    const value = (parseInt(digits, 10) || 0) / 100;
    return (negative ? -value : value).toFixed(2);
  };
  // True-Up edited-field highlight (owner spec Oct 21 2026): green border +
  // tint on any field carrying a NEW value (blank = keeps existing → no
  // highlight). 0 is a legitimate edit.
  const trueUpEdited = (v) => v !== '' && v !== undefined && v !== null && Number.isFinite(Number(v));
  const trueUpEditedCls = (v) => trueUpEdited(v) ? ' border-emerald-500 bg-emerald-50 dark:border-emerald-400 dark:bg-emerald-900/40' : '';
  const setTrueUpCentsField = (locId, field, raw) => {
    setTrueUpDraft((d) => ({ ...d, [locId]: { ...(d[locId] || {}), [field]: trueUpCentsValue(raw) } }));
  };

  const saveTrueUp = async () => {
    if (!config) return;
    const locations = (config.locations || []).map((loc) => {
      const d = trueUpDraft[loc.location_id] || {};
      const card = parseFloat(d.card);
      const loan = parseFloat(d.loan);
      const rate = parseFloat(d.loan_rate);
      // OWNER SPEC (Oct 8 2026): the dialog shows/accepts the loan rate as a
      // PERCENT with 2 decimals (e.g. 17.25) — storage stays a fraction (0.1725).
      return {
        ...loc,
        card_start: Number.isFinite(card) ? card : loc.card_start,
        loan_start: Number.isFinite(loan) ? loan : loc.loan_start,
        loan_rate: Number.isFinite(rate) ? rate / 100 : loc.loan_rate
      };
    });
    const folderVal = parseFloat(trueUpDraft.__folder);
    // FLAG PRE-EXISTING CODs AS "ALREADY COUNTED" (owner rule, Oct 8 2026): the
    // true-up value is the REAL card balance right now, so every COD already in
    // the system (pending / in_transit / en_route, plus completed charges still
    // deducting, plus anything collected today) is already baked into that
    // number — none of them should add to or subtract from the trued-up
    // starting point. We snapshot their delivery IDs here and store them on the
    // config; computePendingCodDeduction then treats every one of them as
    // neutral (excludeIds). Only CODs created (added as Pending) or collected
    // AFTER this true-up — which are NOT in this snapshot — keep affecting the
    // running estimate. A fresh true-up re-baselines the snapshot.
    const countedIds = new Set();
    const outstandingNow = localOutstanding || codOutstandingByLoc || {};
    for (const loc of Object.values(outstandingNow)) {
      (loc?.items || []).forEach((it) => {if (it?.delivery_id) countedIds.add(String(it.delivery_id));});
      (loc?.deductItems || []).forEach((it) => {if (it?.delivery_id) countedIds.add(String(it.delivery_id));});
    }
    for (const rows of Object.values(codCollectedTodayByLoc || {})) {
      (rows || []).forEach((r) => {if (r?.delivery_id) countedIds.add(String(r.delivery_id));});
    }
    const newConfig = {
      ...config,
      locations,
      folder_start: Number.isFinite(folderVal) ? folderVal : Number(config.folder_start || 0),
      trued_up_at: new Date().toISOString(),
      trued_up_counted_ids: Array.from(countedIds)
    };
    setIsSaving(true);
    try {
      if (configRecordId) {
        await base44.entities.AppSettings.update(configRecordId, { setting_value: newConfig });
      } else {
        const created = await base44.entities.AppSettings.create({ setting_key: SETTING_KEY, setting_value: newConfig, description: 'Square card/loan/folder balance tracker config' });
        setConfigRecordId(created?.id || null);
      }
      setConfig(newConfig);
      setShowTrueUp(false);
      toast.success('Balances trued-up from new starting points');
      await loadSales(newConfig);
      computeLocalOutstanding(newConfig);
    } catch (err) {
      console.error('true-up save failed:', err);
      toast.error('Could not save the new balances');
    } finally {
      setIsSaving(false);
    }
  };

  // PAGE-WIDE COMBINE CANDIDATES (owner rule Oct 9 2026): the Set-tender
  // popup's checkbox list covers every UNCOLLECTED item on the card — not
  // just cash-collected ones — and stores SHARE cards, so candidates are
  // gathered across ALL locations on the page (cross-store swipes). Deduped
  // by delivery_id with delivery-derived rows winning over catalog rows;
  // failed CODs are excluded (their path is a refund, not a swipe).
  // Driver scoping applies like the row lists: drivers only get candidates
  // for deliveries assigned to them.
  const combineCandidates = (() => {
    const byId = new Map();
    const push = (it, locId = null) => {
      if (!it?.delivery_id) return;
      const key = String(it.delivery_id);
      if (byId.has(key)) return;
      const locCfg = (config?.locations || []).find((l) => l.location_id === locId);
      byId.set(key, {
        // Card section the popup groups under (owner request Oct 9 2026
        // night: split the multi-select list per card with dividers).
        locId: locId || null,
        locName: locCfg?.name || null,
        delivery_id: it.delivery_id,
        patientName: it.patient || it.patientName || null,
        storeAbbrev: it.storeAbbrev || null,
        storeColor: it.storeColor || null,
        amount: Number(it.amount || 0),
        driver_id: it.driver_id || null
      });
    };
    const locIds = new Set([...Object.keys(localOutstanding || {}), ...Object.keys(codOutstandingByLoc || {})]);
    locIds.forEach((locId) => {
      const agg = localOutstanding && localOutstanding[locId] || codOutstandingByLoc[locId] || {};
      (agg.items || []).forEach((it) => {if (it?.reason !== 'failed_uncollected') push(it, locId);});
      (agg.cashItems || []).forEach((it) => push(it, locId));
    });
    Object.keys(catalogUncollectedByLoc || {}).forEach((locId) =>
    (catalogUncollectedByLoc[locId] || []).forEach((it) => push(it, locId)));
    const all = [...byId.values()];
    return driverScopeId ? all.filter((it) => String(it.driver_id || '') === driverScopeId) : all;
  })();

  if (isLoading && !config) {
    return <div className="text-sm text-slate-500 p-4">Loading balances…</div>;
  }

  if (visibleLocationIds === undefined) {
    return <div className="text-sm text-slate-500 p-4">Loading balances…</div>;
  }

  if (restricted && visibleLocationIds.length === 0) {
    return (
      <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="text-sm font-medium mb-1">No cards assigned to your stores today</div>
        <div className="text-xs text-slate-500">The Square card balance badge in the sidebar will update once you have stops from a Square-linked store.</div>
      </div>);

  }

  if (!config) {
    return (
      <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="text-sm font-medium mb-1">No balance config yet</div>
        <div className="text-xs text-slate-500">Ask the agent to seed the AppSettings 'square_balances' record (locations, starting balances, loan rates), then reload this tab.</div>
      </div>);

  }

  const trueUpDays = daysSince(config.trued_up_at);

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm text-slate-500 dark:text-slate-400">
          Estimates since true-up {new Date(config.trued_up_at).toLocaleString()} ({trueUpDays}d ago)
        </div>
        <div className="ml-auto flex gap-2 items-center">
          {ownerCanEdit && (syncStatusText || isSyncing) &&
          <span data-square-sync-status className="text-xs italic text-blue-600 dark:text-blue-400 whitespace-nowrap overflow-hidden text-ellipsis max-w-[300px] sm:max-w-[420px]" title={syncStatusText}>
              {syncStatusText || 'Syncing…'}
            </span>
          }
          {ownerCanEdit &&
          <Button size="sm" variant="outline" onClick={syncFromSquare} disabled={isSyncing || isLoading}>
            <RefreshCw className={`w-4 h-4 mr-1 ${isSyncing ? 'animate-spin' : ''}`} />
            {isSyncing ? 'Syncing…' : 'Refresh Square'}
          </Button>
          }
          {ownerCanEdit &&
          <Button size="sm" variant="outline" onClick={startTopUp} disabled={isSaving || isLoading}>
              Top Up Cards
            </Button>
          }
          {ownerCanEdit &&
          <Button size="sm" onClick={startTrueUp} disabled={isSaving}>
              True-Up Balances
            </Button>
          }
        </div>
      </div>

      {/* Single combined Folder total — owner/admin view only (spans all cards) */}
      {!restricted &&
      <div className="rounded-xl border border-blue-200 dark:border-blue-800 bg-white dark:bg-slate-900 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300"><PiggyBank className="w-4 h-4 text-blue-600 dark:text-blue-400" /> Folder (all cards, 2% per sale)</div>
        <div className="flex items-center gap-2">
          <div className="text-xl font-bold tabular-nums text-blue-600 dark:text-blue-400">{fmtMoney(folderTotal)}</div>
          {ownerCanEdit &&
          <button
            type="button"
            title="Transfer from folder to a card"
            aria-label="Transfer from folder to a card"
            className="shrink-0 w-7 h-7 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-50 hover:border-slate-400 dark:hover:border-slate-500 flex items-center justify-center transition-colors"
            onClick={() => {setFolderTransferAmount('');setFolderTransferToLocId('');setFolderTransferOpen(true);}}
            disabled={isSaving || isLoading}>
            
              <ArrowLeftRight className="w-3.5 h-3.5" />
            </button>
          }
        </div>
      </div>
      }

      {/* Color legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
        <span className="font-medium text-slate-600 dark:text-slate-300">Card colors:</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-[4px]" style={{ background: BALANCE_LEVELS.green.border }} />
          green — balance more than $20 above the store's average CODs/day
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-[4px]" style={{ background: BALANCE_LEVELS.yellow.border }} />
          yellow — within $20 of the average
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-[4px]" style={{ background: BALANCE_LEVELS.red.border }} />
          red — more than $20 below the average
        </span>
        <span className="text-slate-400">(average = total CODs to collect over the last 7 days, excluding today, ÷ 7)</span>
      </div>

      {/* Location cards — CENTERED per row (owner request Oct 9 2026):
            no matter how many store cards exist, each row's cards are
            horizontally centered (flex-wrap + justify-center so a lone last
            card sits mid-row instead of hugging the left edge).
            WIDTH BAND (owner request Oct 9 2026): each card is 320px min /
            380px max (basis 340px) — a slight spread so cards flex a little
            to fill a row, but never squeeze the data (names truncating to
            'Joanne ...'). When three can't fit at 320px+ the row wraps and
            the extra card drops to a new centered row. Phones: full width. */}
      <div className="flex flex-wrap justify-center gap-3">
        {(restricted ? perLocation.filter((l) => visibleLocationIds.includes(l.location_id)) : perLocation).map((loc) => {
          const lvl = BALANCE_LEVELS[loc.level] || null;
          // ROWS-TRUTH for "CODs charged to card" (owner report Nov 3 2026:
          // "Bonnie Doon says (1) but I see 6 delivery cards"). The count now
          // comes from the SAME rows this card renders — the delivery-derived
          // uncollected rows, the cash-collected rows and the catalog
          // leftovers — and only the ones that still hold their charge (a
          // Not Tapped row does not, unless the card was charged after the
          // mark). Each row is listed under the line, so the count always
          // accounts for itself. The CARD BALANCE math is untouched (that still
          // uses the full balance scope in summaryByLoc).
          const chargedDetail = (() => {
            const src = localOutstanding?.[loc.location_id] || codOutstandingByLoc[loc.location_id] || {};
            const marks = manualSpendMarksRef.current || {};
            const rows = [];
            const seen = new Set();
            const addRow = (it, kind) => {
              const id = it?.delivery_id ? String(it.delivery_id) : null;
              const amount = Number(it?.amount || 0);
              if (!(amount > 0)) return;
              if (id && seen.has(id)) return;
              const mark = id ? marks[id] : null;
              // A Not Tapped mark is STALE once the delivery carries a card
              // spend newer than the mark (Anastasia/Callingwood $97.97 case).
              const markAt = mark?.touchedAt ? new Date(mark.touchedAt).getTime() : null;
              const spendAt = it?.spend_at ? new Date(it.spend_at).getTime() : null;
              const superseded = spendAt != null && Number.isFinite(spendAt) && (markAt == null || !Number.isFinite(markAt) || spendAt >= markAt);
              if (mark?.notTapped === true && !superseded) return;
              if (id) seen.add(id);
              const day = String(it?.date || '').slice(0, 10);
              rows.push({
                key: `${kind}-${id || rows.length}`,
                patientName: it?.patient || it?.patientName || null,
                amount,
                sub: day ? `${day.slice(5, 7)}/${day.slice(8, 10)}` : '',
                driverName: it?.driver_name || it?.driverName || null
              });
            };
            for (const it of src.items || []) addRow(it, 'o');
            for (const it of src.cashItems || []) addRow(it, 'c');
            // COMPLETED charges are NOT listed (owner report Nov 3 2026, second
            // pass: "it is still showing completed items in the lists").
            // Collected/settled CODs have no live row on the card, so listing
            // them under a line the owner reads as "what is still holding
            // money" was noise. This list is ONLY the rows the card shows.
            for (const it of catalogUncollectedByLoc?.[loc.location_id] || []) addRow(it, 'cat');
            rows.sort((x, y) => (y.sub || '').localeCompare(x.sub || ''));
            const cents = rows.reduce((sum, r) => sum + Math.round(r.amount * 100), 0);
            return { rows, cents };
          })();
          return (
            <div key={loc.location_id}
            className="rounded-xl border-2 bg-white dark:bg-slate-900 overflow-hidden w-full min-w-0 sm:w-[360px] sm:min-w-[320px] sm:max-w-[380px] sm:flex-1 sm:basis-[340px]"
            style={lvl ? { borderColor: lvl.border, backgroundImage: `linear-gradient(0deg, ${lvl.tint}, ${lvl.tint})` } : { borderColor: 'var(--border-slate-200, #e2e8f0)' }}>
            <div className="px-4 pt-3 pb-2 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">{loc.name || loc.location_id}</div>
                  <div className="text-slate-400 text-[13px]">{loc.saleCount} card sale{loc.saleCount === 1 ? '' : 's'} since true-up{loc.lastSaleAt ? ` · last ${new Date(loc.lastSaleAt).toLocaleTimeString()}` : ''}</div>
                </div>
                {ownerCanEdit && <div className="shrink-0 flex items-center gap-1">
                  <button
                      type="button"
                      title="Fees by day"
                      aria-label={`Fees by day for ${loc.name || loc.location_id}`}
                      className={`shrink-0 w-7 h-7 rounded-md border flex items-center justify-center transition-colors ${feesByDayLoc === loc.location_id ? 'border-teal-500 text-teal-600 dark:text-teal-400 bg-teal-500/10' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-50 hover:border-slate-400 dark:hover:border-slate-500'}`}
                      onClick={(e) => {e.stopPropagation();setFeesByDayLoc((prev) => prev === loc.location_id ? null : loc.location_id);}}>
                    <BarChart3 className="w-3.5 h-3.5" />
                  </button>
                  <button
                      type="button"
                      title="Funds transfer"
                      aria-label={`Funds transfer from ${loc.name || loc.location_id}`}
                      className="shrink-0 w-7 h-7 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-50 hover:border-slate-400 dark:hover:border-slate-500 flex items-center justify-center transition-colors"
                      onClick={(e) => {e.stopPropagation();openTransfer(loc);}}
                      disabled={isSaving || isLoading}>

                    <ArrowLeftRight className="w-3.5 h-3.5" />
                  </button>
                </div>
                  }
              </div>
            </div>
            <div className="py-2 px-2 space-y-0">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"><Wallet className="w-3.5 h-3.5" /> Card</div>
                <div className="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{fmtMoney(loc.cardEstimate)}</div>
              </div>
              {ownerCanEdit &&
                <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"><Landmark className="w-3.5 h-3.5" /> Loan left</div>
                <div className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-50">{fmtMoney(loc.loanRemaining)}</div>
              </div>
                }
              {loc.weeklyCodAvg > 0 &&
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400"><Receipt className="w-3.5 h-3.5" /> CODs/day (7-day avg)</div>
                  <div className="font-semibold tabular-nums text-slate-900 dark:text-slate-50 text-lg">{fmtMoney(loc.weeklyCodAvg)}</div>
                </div>
                }
              {loc.sweptOut > 0 &&
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400"><Landmark className="w-3.5 h-3.5" /> Withdrawn from card</div>
                  <div className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">−{fmtMoney(loc.sweptOut)}</div>
                </div>
                }
              {(() => {
                  // ROWS-TRUTH (owner report Nov 3 2026): the count and the
                  // amount are the rows listed right here, so "charged to
                  // card (3)" always has 3 items underneath it. Tapping the
                  // line opens the list.
                  const rows = chargedDetail.rows;
                  const total = chargedDetail.cents / 100;
                  if (!rows.length && !(Number(loc.pendingDeducted) > 0)) return null;
                  const shownTotal = rows.length ? total : Number(loc.pendingDeducted);
                  return (
                    <details className="text-xs group">
                      <summary className="flex items-center justify-between cursor-pointer list-none select-none">
                        <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                          <Receipt className="w-3.5 h-3.5" /> CODs charged to card{rows.length ? ` (${rows.length})` : ''}
                          <ChevronDown className="w-3 h-3 opacity-50 group-open:rotate-180 transition-transform" />
                        </div>
                        <div className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">−{fmtMoney(shownTotal)}</div>
                      </summary>
                      {rows.length === 0 &&
                      <div className="mt-1 pl-5 text-[11px] text-slate-400">settled earlier — no open rows</div>
                      }
                      {rows.length > 0 &&
                      <div className="mt-1 space-y-0.5 pl-5 pr-1">
                          {rows.map((r) =>
                        <div key={r.key} className="flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                              <span className="truncate">
                                {r.patientName || 'COD'}{r.sub ? ` · ${r.sub}` : ''}{r.driverName ? ` · ${r.driverName}` : ''}
                              </span>
                              <span className="tabular-nums shrink-0">{fmtMoney(r.amount)}</span>
                            </div>
                        )}
                        </div>
                      }
                    </details>);

                })()}
              {loc.storeCardSpend > 0 &&
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400"><CreditCard className="w-3.5 h-3.5" /> Store-card spends (excluded)</div>
                  <div className="font-semibold tabular-nums text-slate-400">{fmtMoney(loc.storeCardSpend)}</div>
                </div>
                }
              



                
              {/* Fees by day now opens as a larger popout dialog (owner
                     spec Oct 27 2026 night) — no longer crammed inside the card. */}
              {(() => {
                  // Collected/Uncollected/Past uncollected list — owner request
                  // Oct 4 2026: drivers see this full section too (same as the
                  // App Owner), just without the Loan left row and the net
                  // credits/gross/fees/loan/folder breakdown line above, which
                  // stay ownerCanEdit-gated.
                  const todayStr = edmontonBusinessDayKey(new Date());
                  // OWNER SPEC (Oct 7 2026) — STRICTLY DELIVERY DATA: the
                  // uncollected rows come from the delivery-derived outstanding
                  // list (pending / in_transit / en_route CODs). The
                  // SquareCatalogItems source is retired on this page — the
                  // catalog was only ever a partial mirror of the same
                  // deliveries. Pending-status rows (not yet picked up) are
                  // tagged pendingPickup for the "Awaiting Pickup" badge;
                  // everything else reads as Pending (out with a driver).
                  // Every row defaults to the Card Spend pill (owner rule) —
                  // tapping toggles it to "Not Tapped".
                  const outItems = (localOutstanding?.[loc.location_id] || codOutstandingByLoc[loc.location_id] || {}).items || [];
                  // EARLIEST-DATE RULE (Oct 27 2026): kept failed items carry
                  // covers_retry_ids — the ACTIVE retry deliveries whose
                  // charge they already represent. Those retries' catalog
                  // rows must be suppressed too or the pair double-shows.
                  const coveredRetryIds = new Set();
                  for (const it of outItems) (it?.covers_retry_ids || []).forEach((cid) => coveredRetryIds.add(String(cid)));
                  const notTapped = (id) => !!id && !!manualSpendMarksRef.current?.[String(id)]?.notTapped;
                  const manualMark = (id) => !!id && !!manualSpendMarksRef.current?.[String(id)];
                  // Delivery-derived active CODs (pendingPickup flag for
                  // pending status)…
                  // …plus CASH-COLLECTED completed CODs (owner rule Oct 8
                  // 2026 night): every cash collection stays listed under
                  // Uncollected until the tender is actually set as collected
                  // (Debit/Credit via the clickable 'Cash' badge, or ledger
                  // confirmation) — these rows render with the emerald 'Cash'
                  // badge and take dedup precedence over catalog rows.
                  const cashItems = (localOutstanding?.[loc.location_id] || codOutstandingByLoc[loc.location_id] || {}).cashItems || [];
                  const deliveryRows = [...outItems.map((it) => ({
                    key: `o-${it.delivery_id}`,
                    delivery_id: it.delivery_id,
                    driver_id: it.driver_id || null,
                    driverName: it.driver_name || null,
                    patientName: it.patient || null,
                    storeAbbrev: it.storeAbbrev || null,
                    storeColor: it.storeColor || null,
                    amount: it.amount,
                    date: it.date || null,
                    pendingPickup: it.status === 'pending',
                    inTransit: it.status === 'in_transit',
                    failed: it.status === 'failed',
                    notTapped: notTapped(it.delivery_id)
                  })), ...cashItems.map((it) => ({
                    key: `c-${it.delivery_id}`,
                    delivery_id: it.delivery_id,
                    driver_id: it.driver_id || null,
                    driverName: it.driver_name || null,
                    patientName: it.patient || null,
                    storeAbbrev: it.storeAbbrev || null,
                    storeColor: it.storeColor || null,
                    amount: it.amount,
                    date: it.date || null,
                    pendingPickup: false,
                    inTransit: false,
                    failed: false,
                    notTapped: notTapped(it.delivery_id),
                    cashAwaitingSquare: true
                  }))];
                  // …MERGED with the SquareCatalogItems still ACTIVE in the
                  // register (owner spec, Oct 7 2026 follow-up — same as the
                  // old system: catalog items catch CODs whose delivery rows
                  // fall outside the delivery-derived window). Deduped by
                  // delivery_id — delivery-derived rows win; catalog rows with
                  // no delivery link always show.
                  const srcDeliveryIds = new Set(deliveryRows.map((it) => String(it.delivery_id)).filter((it) => it !== 'null' && it !== 'undefined'));
                  const catRows = (catalogUncollectedByLoc?.[loc.location_id] || []).
                  filter((it) => !it.delivery_id || !srcDeliveryIds.has(String(it.delivery_id)) && !coveredRetryIds.has(String(it.delivery_id))).
                  map((it) => ({
                    key: it.key || `cat-${it.delivery_id || it.patientName}`,
                    delivery_id: it.delivery_id || null,
                    driver_id: it.driver_id || null,
                    driverName: it.driverName || null,
                    patientName: it.patientName || null,
                    storeAbbrev: it.storeAbbrev || null,
                    storeColor: it.storeColor || null,
                    amount: it.amount,
                    date: it.date || null,
                    pendingPickup: false,
                    notTapped: notTapped(it.delivery_id),
                    cashAwaitingSquare: !!it.cashAwaitingSquare
                  }));
                  // DRIVER SCOPE (owner rule Oct 9 2026): drivers only see
                  // the delivery items assigned to them. The card/balance
                  // math above stays global — it is the store's real card
                  // money — only the visible rows are scoped.
                  const combinedSrc = !driverScopeId ? [...deliveryRows, ...catRows] : [...deliveryRows, ...catRows].filter((it) => String(it.driver_id || '') === driverScopeId);
                  // Owner spec (Oct 6 2026): cash-collected CODs STAY in
                  // Uncollected / Past uncollected — they are technically
                  // uncollected until processed back to the Square card. They
                  // render with a 'Cash' status badge (CardCodList) and keep
                  // their Card Spend pills.
                  // OWNER SPEC (Oct 27 2026): FUTURE-dated CODs (delivery_date
                  // after today) move to their own 'Awaiting Pickup' section
                  // BELOW Uncollected Past — they are scheduled but not
                  // collectible yet, so they leave the Today list.
                  // OWNER REPORT (Oct 29 2026): today's pending-status CODs (driver has not
                  // picked them up yet, 'Awaiting Pickup' pill) were listed under
                  // Uncollected Today while the Awaiting Pickup section read 'none'.
                  // The section is now: future-dated rows PLUS any pending-status row
                  // dated today. Past-dated pending rows stay in Uncollected Past
                  // (they are overdue, not merely scheduled).
                  const isAwaitingPickupRow = (it) => !!it && !it.cashAwaitingSquare && !it.failed && (
                  it.date && it.date > todayStr || !!it.pendingPickup && (!it.date || it.date === todayStr));

                  const awaitingPickupRows = combinedSrc.filter(isAwaitingPickupRow).map((it) => ({
                    key: it.key || `f-${it.delivery_id}`,
                    delivery_id: it.delivery_id || null,
                    driver_id: it.driver_id || null,
                    driverName: it.driverName || null,
                    patientName: it.patientName || it.patient || null,
                    storeAbbrev: it.storeAbbrev || null,
                    storeColor: it.storeColor || null,
                    amount: it.amount,
                    sub: it.sub || it.date,
                    date: it.date || null,
                    collected: false,
                    pendingPickup: !!it.pendingPickup,
                    inTransit: !!it.inTransit,
                    failed: !!it.failed,
                    hasCardSpend: false,
                    manualCardSpend: manualMark(it.delivery_id),
                    notTapped: notTapped(it.delivery_id),
                    cashAwaitingSquare: !!it.cashAwaitingSquare
                  }));
                  const uncollectedTodayRows = combinedSrc.filter((it) => (!it.date || it.date === todayStr) && !isAwaitingPickupRow(it)).map((it) => ({
                    key: it.key || `o-${it.delivery_id}`,
                    delivery_id: it.delivery_id || null,
                    driver_id: it.driver_id || null,
                    driverName: it.driverName || null,
                    patientName: it.patientName || it.patient || null,
                    storeAbbrev: it.storeAbbrev || null,
                    storeColor: it.storeColor || null,
                    amount: it.amount,
                    sub: `${it.date || todayStr}${it.sub ? ` · ${it.sub}` : ''}`,
                    date: it.date || todayStr,
                    collected: false,
                    pendingPickup: !!it.pendingPickup,
                    inTransit: !!it.inTransit,
                    failed: !!it.failed,
                    hasCardSpend: false, // Square-evidence swipe scan retired Oct 7 2026 — delivery data only
                    manualCardSpend: manualMark(it.delivery_id),
                    notTapped: notTapped(it.delivery_id),
                    cashAwaitingSquare: !!it.cashAwaitingSquare
                  }));
                  // Future-dated rows now live in the Awaiting Pickup section
                  // (owner spec Oct 27 2026) — nothing extra merges here.
                  const pastUncollectedRows = combinedSrc.filter((it) => it.date && it.date < todayStr).map((it) => ({
                    key: it.key || `p-${it.delivery_id}`,
                    delivery_id: it.delivery_id || null,
                    driver_id: it.driver_id || null,
                    driverName: it.driverName || null,
                    patientName: it.patientName || it.patient || null,
                    storeAbbrev: it.storeAbbrev || null,
                    storeColor: it.storeColor || null,
                    amount: it.amount,
                    sub: it.sub || it.date,
                    date: it.date || null,
                    collected: false,
                    pendingPickup: !!it.pendingPickup,
                    inTransit: !!it.inTransit,
                    failed: !!it.failed,
                    hasCardSpend: false, // Square-evidence swipe scan retired Oct 7 2026 — delivery data only
                    manualCardSpend: manualMark(it.delivery_id),
                    notTapped: notTapped(it.delivery_id),
                    cashAwaitingSquare: !!it.cashAwaitingSquare
                  }));
                  // OWNER RULE (Nov 3 2026): a completed COD marked Not Tapped
                  // keeps its row on the store card even after its collected
                  // date has passed — the MONEY is neutral, the row is not. It
                  // comes from the completed deduct items (balance scope, so
                  // past days are present), skipping any mark the card has
                  // since superseded by an actual charge.
                  const carryOverNotTappedRows = (() => {
                    const out = [];
                    const ded = (localOutstanding?.[loc.location_id] || codOutstandingByLoc[loc.location_id] || {}).deductItems || [];
                    const alreadyListed = new Set((codCollectedTodayByLoc[loc.location_id] || []).map((r) => String(r.delivery_id || '')));
                    // Still-uncollected CODs (cash sitting in the drawer, or a
                    // COD not collected at all) already have their own row in
                    // Uncollected Past — never carry those into Collected
                    // (owner report Nov 3 2026, Margit Kovalik $4.94 Bonnie
                    // Doon, whose matching Uncollected row is still open).
                    for (const it of [...(outItems || []), ...(cashItems || [])]) {
                      if (it?.delivery_id) alreadyListed.add(String(it.delivery_id));
                    }
                    for (const it of ded) {
                      if (String(it?.status || '') !== 'completed') continue;
                      if (String(it?.reason || '') !== 'collected_charge') continue;
                      const id = it?.delivery_id ? String(it.delivery_id) : null;
                      if (!id || alreadyListed.has(id)) continue;
                      const mark = manualSpendMarksRef.current?.[id];
                      if (mark?.notTapped !== true) continue;
                      const markAt = mark?.touchedAt ? new Date(mark.touchedAt).getTime() : null;
                      const spendAt = it?.spend_at ? new Date(it.spend_at).getTime() : null;
                      const superseded = spendAt != null && Number.isFinite(spendAt) && (markAt == null || !Number.isFinite(markAt) || spendAt >= markAt);
                      if (superseded) continue;
                      const day = String(it?.date || '').slice(0, 10);
                      if (!day || day >= todayStr) continue; // today's rows are already listed
                      out.push({
                        key: `nt-${id}`,
                        delivery_id: id,
                        driver_id: it.driver_id || null,
                        driverName: it.driver_name || null,
                        patientName: it.patient || null,
                        storeAbbrev: it.storeAbbrev || null,
                        storeColor: it.storeColor || null,
                        amount: Number(it.amount) || 0,
                        sub: `${day.slice(5, 7)}/${day.slice(8, 10)}`,
                        collected: true,
                        hasCardSpend: false,
                        manualCardSpend: true,
                        notTapped: true,
                        collectedLabel: 'COD',
                        carriedOver: true
                      });
                    }
                    return out;
                  })();
                  const allCollectedRows = [...(codCollectedTodayByLoc[loc.location_id] || []), ...carryOverNotTappedRows];
                  const collectedTodayRows = !driverScopeId ? allCollectedRows : allCollectedRows.filter((r) => String(r.driver_id || '') === driverScopeId);
                  // Refunded rows show the refunded COD amount but are NOT kept money, so they never join the total.
                  const sumOf = (rows) => rows.reduce((s, r) => s + (r.refunded ? 0 : Number(r.amount || 0)), 0);
                  return (
                    <CardCodList
                      canMarkSpend={!!currentUser}
                      isOwner={ownerCanEdit}
                      canEditNotes={canEditBalanceNotes}
                      balanceNotesById={balanceNotesById}
                      driverNotesById={driverNotesById}
                      onEditNote={(row) => {setNoteTarget({ ...row, cardLocId: loc.location_id });setNoteDraft(String(balanceNotesById[String(row.delivery_id)]?.note || ''));}}
                      onViewDriverNote={(row, note) => setDriverNoteView({ patientName: row?.patientName || null, sub: row?.sub || null, amount: row?.amount, note })}
                      combineCandidates={combineCandidates} locationOrder={(config?.locations || []).map((l) => l.location_id)} cardLocId={loc.location_id}
                      onMarkSpend={markCardSpend}
                      onMarkRefunded={markFailedRefunded}
                      onCashToCard={cashToCard}
                      onRefundCod={refundCod}
                      loading={isLoading || localOutstanding === null || catalogUncollectedByLoc === undefined}
                      sections={[
                      { label: 'Collected', color: '#059669', rows: collectedTodayRows, total: sumOf(collectedTodayRows) },
                      { label: 'Uncollected Today', color: '#d97706', rows: uncollectedTodayRows, total: sumOf(uncollectedTodayRows) },
                      { label: 'Uncollected Past', color: '#64748b', rows: pastUncollectedRows, total: sumOf(pastUncollectedRows) },
                      { label: 'Awaiting Pickup', color: '#7c3aed', rows: awaitingPickupRows, total: sumOf(awaitingPickupRows) }]
                      } />);


                })()}
            </div>
          </div>);

        })}
      </div>

      {/* ADMIN NOTE DIALOG (owner request Nov 3 2026): pen icon on a COD
           delivery item card opens this; the note saves to that balance item
           and shows on the row for every admin/device. */}
      <Dialog open={!!noteTarget} onOpenChange={(o) => {if (!o) {setNoteTarget(null);setNoteDraft('');}}}>
        <DialogContent className="sm:max-w-md w-[94vw]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PenLine className="w-4 h-4" /> Note — {noteTarget?.patientName || 'COD'}
            </DialogTitle>
            <DialogDescription>
              {[noteTarget?.sub, noteTarget?.amount != null ? fmtMoney(noteTarget.amount) : null, noteTarget?.driverName].filter(Boolean).join(' · ') || 'COD delivery'}
              {balanceNotesById?.[String(noteTarget?.delivery_id)]?.author_name ? ` · last edit by ${balanceNotesById[String(noteTarget.delivery_id)].author_name}` : ''}
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            rows={5}
            autoFocus
            placeholder="Add a note about this COD (visible to admins on this row)…"
            className="w-full rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-50 focus:outline-none focus:ring-2 focus:ring-emerald-500" />
          
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-slate-400">Empty and saved = note removed</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={noteSaving} onClick={() => {setNoteTarget(null);setNoteDraft('');}}>Cancel</Button>
              <Button size="sm" disabled={noteSaving} onClick={async () => {
                const ok = await saveBalanceNote(noteTarget, noteDraft);
                if (ok) {setNoteTarget(null);setNoteDraft('');}
              }}>{noteSaving ? 'Saving…' : 'Save note'}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* DRIVER NOTE VIEWER (owner request Nov 3 2026): tapping the note-paper
           icon shows the note the driver left on that delivery. Read only. */}
      <Dialog open={!!driverNoteView} onOpenChange={(o) => {if (!o) setDriverNoteView(null);}}>
        <DialogContent className="sm:max-w-md w-[94vw]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <StickyNote className="w-4 h-4 text-sky-600 dark:text-sky-400" /> Driver note — {driverNoteView?.patientName || 'COD'}
            </DialogTitle>
            <DialogDescription>
              {[driverNoteView?.sub, driverNoteView?.amount != null ? fmtMoney(driverNoteView.amount) : null].filter(Boolean).join(' · ') || 'COD delivery'}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] overflow-y-auto rounded-md border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-900/20 px-3 py-2 text-sm text-slate-800 dark:text-slate-100 whitespace-pre-wrap break-words">
            {driverNoteView?.note || 'No note'}
          </div>
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={() => setDriverNoteView(null)}>Close</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* FEES BY DAY POPOUT DIALOG (owner spec Oct 27 2026 night): the
           per-store fee breakdown opens as a larger dialog instead of being
           stuck inside the store card. */}
      <Dialog open={!!feesByDayLoc} onOpenChange={(o) => {if (!o) {setFeesByDayLoc(null);setFeesViewMode('month');}}}>
        <DialogContent className="sm:max-w-2xl w-[94vw] max-h-[88vh] flex flex-col gap-3 overflow-hidden">
          <DialogHeader>
            <div className="flex items-start justify-between gap-2 pr-6">
              <div className="min-w-0">
                <DialogTitle>{feesViewMode === 'year' ? 'Fees by month' : 'Fees by day'} — {feesByDayLoc ? (config?.locations || []).find((l) => l.location_id === feesByDayLoc)?.name || 'card' : ''}</DialogTitle>
                <DialogDescription className="mt-1.5">
                  {feesViewMode === 'year' ?
                  'Month-by-month fees for collected CODs, full year, per store.' :
                  'Daily Square fee and Loan fee for collected CODs on this card, by month.'}
                </DialogDescription>
              </div>
              {/* VIEW TOGGLE (owner spec Oct 28 2026): single month <-> full year */}
              <div className="shrink-0 inline-flex rounded-md border border-slate-200 dark:border-slate-600 overflow-hidden text-xs" role="group" aria-label="Fees view">
                {[['month', 'Month'], ['year', 'Year']].map(([val, lbl]) =>
                <button
                  key={val}
                  type="button"
                  onClick={() => setFeesViewMode(val)}
                  aria-pressed={feesViewMode === val}
                  className={`px-2.5 py-1 transition-colors ${feesViewMode === val ? 'bg-teal-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'}`}>
                  
                    {lbl}
                  </button>
                )}
              </div>
            </div>
          </DialogHeader>
          {feesByDayLoc &&
          <div className="flex-1 min-h-0 flex flex-col">
              <StoreFeesByDay
              locationId={feesByDayLoc}
              locationName={(config?.locations || []).find((l) => l.location_id === feesByDayLoc)?.name}
              locations={config?.locations || []}
              viewMode={feesViewMode} />
            
            </div>
          }
        </DialogContent>
      </Dialog>

      {/* Card transfers (owner request, Oct 3 2026): fund moves ONTO the
                                    Square Cards, pulled from the card (MOBILE) locations the per-store
                                    sync never saw before. Attributed = fed by that store's sale
                                    (SQUARE_STORED_BALANCE payout wrapping the sale's charge);
                                    unattributed = folder / manual transfer with no sale link yet. */}
      {topups.length > 0 &&
      <div className="rounded-xl border border-slate-200 dark:border-slate-700/60 bg-white dark:bg-slate-800/60 p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
              <ArrowLeftRight className="w-4 h-4 text-emerald-600 dark:text-emerald-400" /> Card Transfers (since true-up)
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {topups.length} transfer{topups.length === 1 ? '' : 's'} · +{fmtMoney(topups.reduce((a, t) => a + (Number(t.amount) || 0), 0))}
            </div>
          </div>
          <div className="space-y-1 max-h-56 overflow-y-auto">
            {topups.slice().sort((a, b) => new Date(b.occurred_at || 0) - new Date(a.occurred_at || 0)).map((t) => {
            const storeName = config?.locations?.find((l) => l.location_id === t.attributed_location_id)?.name || null;
            const isFolder = !storeName && !/CHARGE/.test(String(t.reason || ''));
            return (
              <div key={t.id || t.square_id} className="flex items-center justify-between text-xs px-2 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-900/40">
                  <div className="min-w-0">
                    <span className="font-medium text-slate-700 dark:text-slate-200">{t.card_name || 'Square Card'}</span>
                    <span className="text-slate-400 dark:text-slate-500"> · {new Date(t.occurred_at || Date.now()).toLocaleString()}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-200/70 dark:bg-slate-700/70 text-slate-600 dark:text-slate-300">
                      {storeName ? `from ${storeName}` : isFolder ? 'folder / manual' : 'card transfer'}
                    </span>
                    <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">+{fmtMoney(Number(t.amount) || 0)}</span>
                  </div>
                </div>);

          })}
          </div>
        </div>
      }

      {ownerCanEdit &&
      <div className="text-[11px] text-slate-400">
        Card = start + sales − fees − 2% folder − loan%. Loan and folder are computed from owner-supplied rates (not in Square's API). Off-card spending isn't tracked — use True-Up whenever the real Square numbers are checked.
      </div>
      }

      {/* True-up overlay: enter the CURRENT real numbers from each Square dashboard */}
      {showTrueUp &&
      <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !isSaving && setShowTrueUp(false)}>
          <div ref={trueUpPanelRef} className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // OWNER SPEC (Oct 8 2026): Enter on ANY field saves the True-Up.
          if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !isSaving) {
            e.preventDefault();
            saveTrueUp();
          }
        }}>
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">True-Up: enter the CURRENT real numbers from each Square dashboard</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Blank fields keep the existing value. This resets the tracking window to now. Enter saves.</div>
            </div>
            {(config.locations || []).map((loc, li) =>
          <div key={loc.location_id} className="space-y-1.5">
                <div className="text-sm font-medium text-slate-900 dark:text-slate-50">{loc.name || loc.location_id}</div>
                <div className="grid grid-cols-3 gap-1.5 items-end">
                  <label className="text-[10px] text-slate-500 dark:text-slate-400">Card balance
                    <Input type="text" inputMode="decimal" tabIndex={li + 1} className={"mt-0.5 px-2 text-xs" + trueUpEditedCls(trueUpDraft[loc.location_id]?.card)} placeholder={fmtMoney(loc.card_start)}
                value={fmtTrueUpField(trueUpDraft[loc.location_id]?.card)}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setTrueUpCentsField(loc.location_id, 'card', e.target.value)} />
                  </label>
                  <label className="text-[10px] text-slate-500 dark:text-slate-400">Loan remaining
                    <Input type="text" inputMode="decimal" tabIndex={(config.locations || []).length + 2 + li} className={"mt-0.5 px-2 text-xs" + trueUpEditedCls(trueUpDraft[loc.location_id]?.loan)} placeholder={fmtMoney(loc.loan_start)}
                value={fmtTrueUpField(trueUpDraft[loc.location_id]?.loan)}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setTrueUpCentsField(loc.location_id, 'loan', e.target.value)} />
                  </label>
                  <label className="text-[10px] text-slate-500 dark:text-slate-400">Loan rate %
                    <Input type="text" inputMode="decimal" tabIndex={2 * (config.locations || []).length + 2 + li} className={"mt-0.5 px-2 text-xs" + trueUpEditedCls(trueUpDraft[loc.location_id]?.loan_rate)} placeholder={fmtTrueUpField(Number(loc.loan_rate ?? 0) * 100)}
                value={fmtTrueUpField(trueUpDraft[loc.location_id]?.loan_rate)}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setTrueUpCentsField(loc.location_id, 'loan_rate', e.target.value)} />
                  </label>
                </div>
              </div>
          )}
            <div className="space-y-1.5">
              <div className="text-sm font-medium text-slate-900 dark:text-slate-50">Folder (combined)</div>
              <div className="grid grid-cols-3 gap-1.5 items-end">
                <label className="text-[10px] text-slate-500 dark:text-slate-400">Folder balance
                  <Input type="text" inputMode="decimal" tabIndex={(config.locations || []).length + 1} className={"mt-0.5 px-2 text-xs" + trueUpEditedCls(trueUpDraft.__folder)} placeholder={fmtMoney(config.folder_start || 0)}
                value={fmtTrueUpField(trueUpDraft.__folder)}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setTrueUpDraft((d) => ({ ...d, __folder: trueUpCentsValue(e.target.value) }))} />
                  </label>
              </div>
            </div>
            <div className="flex gap-2 justify-end pt-1">
              <Button size="sm" variant="outline" onClick={() => setShowTrueUp(false)} disabled={isSaving}>Cancel</Button>
              <Button size="sm" onClick={saveTrueUp} disabled={isSaving}>{isSaving ? 'Saving…' : 'Save True-Up'}</Button>
            </div>
          </div>
        </div>
      }

      {/* Top-Up overlay: add money to each card's balance (does not reset the window) */}
      {showTopUp &&
      <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !isSaving && setShowTopUp(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">Adjust Card Balances</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Enter an amount to ADD to (or DEDUCT from) each card's balance — negative values like -5.93 deduct. Blank fields are skipped. This does not reset the tracking window.</div>
            </div>
            {(config?.locations || []).map((loc) =>
          <label key={loc.location_id} className="block space-y-1">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{loc.name || loc.location_id}</span>
                <Input
              type="text"
              inputMode="text"
              placeholder={`adjust ~${fmtMoney(perLocation.find((l) => l.location_id === loc.location_id)?.cardEstimate || 0)}`}
              value={fmtSignedCentsField(topUpDraft[loc.location_id])}
              disabled={isSaving}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setTopUpDraft((d) => ({ ...d, [loc.location_id]: signedCentsRaw(e.target.value) }))} />

              </label>
          )}
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="outline" onClick={() => setShowTopUp(false)} disabled={isSaving}>Cancel</Button>
              <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={saveTopUp} disabled={isSaving}>
                {isSaving ? 'Applying…' : 'Apply to Cards'}
              </Button>
            </div>
          </div>
        </div>
      }

      {/* Folder Transfer overlay: move money from the shared folder onto a
                                    card (does not reset the window). One-way only — never card → folder. */}
      {folderTransferOpen &&
      <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !isSaving && setFolderTransferOpen(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">Folder Transfer</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Move money from the folder onto a card. Does not reset the tracking window. Transfers out of the folder only — never into it.</div>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2">
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">From</span>
              <span className="text-sm font-semibold text-blue-600 dark:text-blue-400">Folder · {fmtMoney(folderTotal)} available</span>
            </div>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Amount</span>
              <Input
              type="number"
              step="0.01"
              min="0"
              max={folderTotal}
              placeholder={`available ${fmtMoney(folderTotal)}`}
              value={folderTransferAmount}
              disabled={isSaving}
              onChange={(e) => setFolderTransferAmount(e.target.value)} />
            
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">To card</span>
              <select
              className="w-full h-9 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 text-sm text-slate-900 dark:text-slate-50"
              value={folderTransferToLocId}
              disabled={isSaving}
              onChange={(e) => setFolderTransferToLocId(e.target.value)}>
              
                <option value="">Select destination card…</option>
                {(config?.locations || []).map((loc) =>
              <option key={loc.location_id} value={loc.location_id}>{loc.name || loc.location_id}</option>
              )}
              </select>
            </label>
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="outline" onClick={() => setFolderTransferOpen(false)} disabled={isSaving}>Cancel</Button>
              <Button size="sm" onClick={saveFolderTransfer} disabled={isSaving}>
                {isSaving ? 'Transferring…' : 'Transfer'}
              </Button>
            </div>
          </div>
        </div>
      }

      {/* Funds Transfer overlay: move money from one card to another (does not reset the window) */}
      {transferFromLoc &&
      <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !isSaving && setTransferFromLoc(null)}>
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">Funds Transfer</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Move money from this card to another card. Does not reset the tracking window.</div>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2">
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">From</span>
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-50">{transferFromLoc.name || transferFromLoc.location_id}</span>
            </div>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Amount</span>
              <Input
              type="number"
              step="0.01"
              min="0"
              placeholder={`available ~${fmtMoney(perLocation.find((l) => l.location_id === transferFromLoc.location_id)?.cardEstimate || 0)}`}
              value={transferAmount}
              disabled={isSaving}
              onChange={(e) => setTransferAmount(e.target.value)} />
            
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">To card</span>
              <select
              className="w-full h-9 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 text-sm text-slate-900 dark:text-slate-50"
              value={transferToLocId}
              disabled={isSaving}
              onChange={(e) => setTransferToLocId(e.target.value)}>
              
                <option value="">Select destination card…</option>
                {(config?.locations || []).filter((loc) => loc.location_id !== transferFromLoc.location_id).map((loc) =>
              <option key={loc.location_id} value={loc.location_id}>{loc.name || loc.location_id}</option>
              )}
              </select>
            </label>
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="outline" onClick={() => setTransferFromLoc(null)} disabled={isSaving}>Cancel</Button>
              <Button size="sm" onClick={saveTransfer} disabled={isSaving}>
                {isSaving ? 'Transferring…' : 'Transfer'}
              </Button>
            </div>
          </div>
        </div>
      }

      {/* HOW THE BADGES WORK (owner request Oct 9 2026): short usage guide
              for the clickable badges, collapsed by default at the bottom of the
              page. The S/F/L line is owner-only (drivers see settled amounts
              only). Drivers see a scope note — they only see their own rows. */}
      <details className="mt-4 rounded-xl border border-slate-200 dark:border-slate-700/60 bg-white dark:bg-slate-800/60 p-3">
        <summary className="cursor-pointer select-none text-sm font-semibold text-slate-700 dark:text-slate-200">
          How the badges work
        </summary>
        <div className="mt-3 space-y-2.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700 dark:border-sky-800 dark:bg-sky-900/40 dark:text-sky-300">Card Spend</span>
            <span>A pending COD with this pill is charged to the card and deducts from that card's balance estimate. Tap it to mark it <span className="font-semibold">Not Tapped</span> — the deduction stops.</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700 dark:border-violet-800 dark:bg-violet-900/40 dark:text-violet-300">Not Tapped</span>
            <span>Tap the pill again to flip it back to <span className="font-semibold">Card Spend</span> — the pending COD deducts from the card estimate again.</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">Cash</span>
            <span>A cash-collected COD still keeps its amount deducted from the card — the drawer money isn't back on the card yet. Tap the badge to correct the tender: tick other items to combine them into <span className="font-semibold">one swipe</span>, then pick Debit or Credit — fees are computed on the swipe total and the net settles onto the card.</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-600 dark:border-slate-700 dark:bg-slate-700/40 dark:text-slate-300">Debit / Credit</span>
            <span>Tap to switch the tender type, or revert to Cash — reverting puts the money back in the drawer, so the full amount deducts from the card balance again.</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 inline-flex items-center rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-700 dark:border-red-800 dark:bg-red-900/40 dark:text-red-300">Failed</span>
            <span>A failed delivery's COD stays in Uncollected and keeps deducting from the card (the goods were charged). Tap the badge once the refund is registered in Square — the amount returns to the card balance and the row clears.</span>
          </div>
          {ownerCanEdit &&
          <div className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 font-mono text-[10px] font-semibold text-slate-500 dark:text-slate-400">S: F: L:</span>
            <span>On collected rows: S = Square fee, F = folder, L = loan — the amount after them is what settled back onto the card.</span>
          </div>
          }
          



          
        </div>
      </details>

      {/* PAYMENT DISCREPANCIES (owner spec Oct 9 2026 night): every COD whose
            recorded collection type disagrees with what Square actually saw
            (60-day scan, flagged by the backend balances updater — no in-app
            auto-updates). ALWAYS visible while open flags exist; Confirm
            applies the recorded→actual fix with normal fee/loan/folder math,
            Dismiss closes it after review. Owner-only. */}
      {ownerCanEdit && paymentDiscrepancies.length > 0 &&
      <PaymentDiscrepanciesList
        discrepancies={paymentDiscrepancies}
        discrepancyBusy={discrepancyBusy}
        onConfirm={confirmDiscrepancy}
        onDismiss={dismissDiscrepancy}
        onRefresh={loadPaymentDiscrepancies} />

      }
      </div>);

}