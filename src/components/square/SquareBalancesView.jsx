import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAppSettingRows, getFreshAppSettingRows } from '@/components/utils/appSettingsCache';
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshCw, Wallet, Landmark, PiggyBank, Receipt, ArrowLeftRight, CreditCard, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { isAppOwner } from "@/components/utils/userRoles";
import { edmontonWallString } from "@/components/utils/albertaTime";
import { buildStoreToLocMap, computeWeeklyCodTotalsByStore, weeklyAvgByLocFromStores, getBalanceLevel, BALANCE_LEVELS, computeCodOutstandingDetailed, loadCardPayouts, loadCardTopups, loadDeliveryCardCredits, computeNetCollected, DEFAULT_FOLDER_RATE, payoutsByLocation, computePendingCodDeduction, estimateCardFeeCents, folderCentsFor, markFailedCodRefunded } from "./useSquareBalancesSummary";
import { getSummarySnapshot, deserializeSummary } from "./squareBalancesOfflineManager";
import { invalidateLedgerWindows } from "./useSquareBalancesSummary";

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
function CardCodList({ sections, canMarkSpend, onMarkSpend, onMarkRefunded, loading }) {
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
        {(sections || []).map((sec) => (
          <div key={sec.label} className="space-y-1">
            <div className="flex items-center justify-between font-medium text-[13px]">
              <span style={{ color: sec.color }}>{sec.label}</span>
              <span className="text-slate-400 dark:text-slate-500 tabular-nums">…</span>
            </div>
            <div className="text-slate-300 dark:text-slate-600 text-[13px]">Loading…</div>
          </div>
        ))}
      </div>);
  }
  if (!hasRows) return null;
  return (
    <div className="pt-2 mt-2 border-t border-slate-100 dark:border-slate-800 space-y-2">
      {sections.map((sec) =>
      <div key={sec.label} className="space-y-1">
          <div className="flex items-center justify-between font-medium text-[13px]">
            <span style={{ color: sec.color }}>{sec.label}</span>
            <span className="text-slate-400 tabular-nums">{sec.rows.length} · {fmtMoney(sec.total)}</span>
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
          const statusColorCls = r.collected ?
          emeraldCls :
          r.cashAwaitingSquare ? emeraldCls : r.failed ? redCls : 'bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300';
          const showNetAmount = r.collected && statusLabel !== 'Cash' && r.netAmount != null;
          return (
            <div key={r.key} className="flex flex-col gap-1.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-2.5 py-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex flex-col gap-2">
                  <div className="flex items-center gap-1.5 min-w-0 my-1">
                    <span
                      className="text-[9px] font-bold leading-none px-1.5 py-0.5 rounded-full text-white flex-shrink-0"
                      style={{ backgroundColor: r.storeColor || '#64748b' }}>
                      {r.storeAbbrev || '—'}
                    </span>
                    <p className="font-semibold leading-4 text-slate-900 dark:text-slate-50 text-[13px] truncate flex-1 min-w-0">{r.patientName || 'COD'}</p>
                   </div>
                </div>
                <div className="shrink-0 flex items-center gap-1.5">
                    <span className="text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{fmtMoney(r.amount)}</span>
                    {/* Card Spend pill (owner spec Oct 6 2026) — TOGGLE on
                    uncollected rows: Square's card-activity data proved too
                    unreliable to auto-detect, so every uncollected COD
                    defaults to "Card Spend" (sky). Tapping flips it to
                    "Not Tapped" (violet) — the COD is added back to the
                    card balance estimate — and tapping again flips back.
                    Collected rows keep the legacy auto/manual evidence
                    pills. */}
                    {r.collected ? r.hasCardSpend ?
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
                    {r.notTapped ? 'Not Tapped' : 'Card Spend'}</span>

                  }
                  </div>
              </div>
                <div className="flex items-center justify-between text-lg gap-1.5">
                    <span className="tabular-nums text-slate-500 dark:text-slate-400 text-[13px]">{r.sub}</span>
                    {/* Owner spec (Oct 8 2026): fees centered on row 2 —
                  S = Square fee, F = folder%, L = loan%. Card rows only. */}
                    {showNetAmount && r.feeParts &&
                <span className="tabular-nums text-slate-500 dark:text-slate-400 text-[13px]">
                        S:{r.feeParts.fee.toFixed(2)} F:{r.feeParts.folder.toFixed(2)} L:{r.feeParts.loan.toFixed(2)}
                      </span>
                }
                    <div className="flex items-center gap-1.5">
                    {showNetAmount &&
                  <span className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-400 text-[13px]">{fmtMoney(r.netAmount)}</span>
                  }
                    {r.failed && !r.collected && canMarkSpend && !!r.delivery_id && onMarkRefunded ? (
                  <span
                    onClick={() => onMarkRefunded(r.delivery_id)}
                    title="Mark this failed COD as refunded — the amount returns to the card balance"
                    // No role="button" (same min-height CSS trap as the pills).
                    className={`cursor-pointer rounded-full border px-2 font-medium text-[11px] text-center leading-none min-w-[80px] py-1 ${statusColorCls} ring-1 ring-red-400/60 dark:ring-red-500/50`}>{statusLabel}</span>
                ) : (
                  <span className={`rounded-full border px-2 font-medium text-[11px] text-center leading-none min-w-[80px] py-1 ${statusColorCls}`}>{statusLabel}</span>
                )}
                    </div>
                  </div>
              </div>);

        })}
        </div>
      )}
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
  const catalogUncollectedByLocRef = useRef({});
  const [weeklyCodAvgByLoc, setWeeklyCodAvgByLoc] = useState({}); // 7-day avg daily CODs per card (excl. today)
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
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
  // null = show every card (admins/owner); array = only these cards (drivers see the
  // cards assigned to their stores for the current date).
  const restricted = Array.isArray(visibleLocationIds);

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
      computeDailyCodRef.current?.();
    } catch (e) {
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
    } catch (e) {
      console.error('local COD outstanding failed:', e);
    }
  }, [currentUser?.id]);

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
      const itemsPages = [];
      let anyFetchFailed = false;
      for (let skip = 0; skip < 20000; skip += 500) {
        const { rows: list, failed } = await fetchPage(skip, 1);
        anyFetchFailed = anyFetchFailed || failed;
        itemsPages.push(...list);
        if (list.length < 500) break;
      }
      const itemsRaw = itemsPages;
      const totalItemsFetched = itemsRaw.length;
      const [storesRaw, patientsRaw] = await Promise.all([
      base44.entities.Store.list().catch(() => []),
      base44.entities.Patient.list().catch(() => [])]
      );
      const resolvePatientName = buildPatientResolver(patientsRaw);
      const storeById = new Map();
      const storeByAbbrev = new Map();
      (storesRaw || []).forEach((s) => {
        if (s?.id) storeById.set(String(s.id), s);
        if (s?.abbreviation) storeByAbbrev.set(String(s.abbreviation).toUpperCase(), s);
      });
      const todayStrForParsing = edmontonWallString(new Date()).slice(0, 10);
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
        byLoc.get(it.location_id).push({
          key: `cat-${it.id || it.square_catalog_object_id}`,
          delivery_id: it.delivery_id || null,
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
        const alreadyConfirmedIds = new Set();
        for (let i = 0; i < deliveryIdsForCashCheck.length; i += 400) {
          const chunk = deliveryIdsForCashCheck.slice(i, i + 400);
          const rows = await base44.entities.Delivery.filter({ id: { $in: chunk } }, undefined, 400).catch(() => []);
          for (const d of rows || []) {
            if (String(d?.status) === 'completed' && (d?.cod_payments || []).some((p) => String(p?.type).toLowerCase() === 'cash')) {
              cashCollectedDeliveryIds.add(d.id);
              if (d?.cod_confirmed_collected) alreadyConfirmedIds.add(d.id);
            }
          }
        }
        // LEDGER-MATCHED AUTO-COLLECT (owner rule, Oct 7 2026): a
        // cash-collected COD is CONSIDERED COLLECTED once its match shows up
        // on the ledger — a COMPLETED cod_collection SquareLedgerEntry linked
        // to the delivery (squareLedgerSync stamps delivery_id when the
        // catalog item is rung in Square). Matched rows leave the
        // Uncollected / Past uncollected lists, the delivery is stamped
        // cod_confirmed_collected (fire-and-forget, so the outstanding math
        // and reconcile agree), and it surfaces in Collected today with its
        // real ledger data. Unmatched cash rows keep the emerald 'Cash'
        // badge as before.
        const ledgerSince = new Date(Date.now() - 14 * 86400000).toISOString();
        const ledgerLinkedIds = new Set();
        for (let skip = 0; skip < 20000; skip += 500) {
          const led = await base44.entities.SquareLedgerEntry.filter(
            { sale_class: 'cod_collection', created_date: { $gte: ledgerSince } }, undefined, 500, skip
          ).catch(() => []);
          const ledList = led || [];
          for (const e of ledList) {
            if (e?.delivery_id && String(e?.status || '').toUpperCase() === 'COMPLETED') ledgerLinkedIds.add(String(e.delivery_id));
          }
          if (ledList.length < 500) break;
        }
        const confirmedIds = new Set([...alreadyConfirmedIds]);
        for (const id of cashCollectedDeliveryIds) {
          if (ledgerLinkedIds.has(String(id))) confirmedIds.add(id);
        }
        // Fire-and-forget stamp so every surface (badge outstanding math,
        // backend reconcile, other devices) agrees the COD is collected.
        for (const id of confirmedIds) {
          if (!alreadyConfirmedIds.has(id)) {
            base44.entities.Delivery.update(String(id), { cod_confirmed_collected: true }).catch(() => {});
          }
        }
        if (cashCollectedDeliveryIds.size > 0 && isLatest()) {
          setCatalogUncollectedByLoc((prev) => {
            if (!prev) return prev;
            const next = {};
            for (const [locId, rows] of Object.entries(prev)) {
              next[locId] = rows.
              filter((r) => !(r.delivery_id && confirmedIds.has(String(r.delivery_id)))) // ledger-matched → collected
              .map((r) =>
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
  }, []);
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
      base44.entities.Store.list().catch(() => []),
      base44.entities.SquareLocationConfig.list().catch(() => []),
      base44.entities.Patient.list().catch(() => [])]
      );
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
      const today = edmontonWallString(new Date()).slice(0, 10);
      const centsOf = (n) => Math.round(Number(n || 0) * 100);
      const byLoc = new Map();
      const aggFor = (locId) => {
        if (!byLoc.has(locId)) byLoc.set(locId, []);
        return byLoc.get(locId);
      };

      // Deliveries finished TODAY (any created date) with a COD. A 30-day
      // created-window comfortably covers completions of long-pending stops.
      const deliveryList = [];
      const since30 = new Date(Math.floor(Date.now() / 86400000) * 86400000 - 30 * 86400000).toISOString();
      for (let page = 0; page < 20; page++) {
        const rows = await base44.entities.Delivery.filter({ created_date: { $gte: since30 } }, '-created_date', 500, page * 500).catch(() => []);
        const list = rows || [];
        deliveryList.push(...list);
        if (list.length < 500) break;
      }

      for (const d of deliveryList) {
        if (d?.status !== 'completed') continue;
        const doneAt = String(d.actual_delivery_time || '');
        if (!doneAt || doneAt.slice(0, 10) !== today) continue;
        const required = centsOf(d?.cod_total_amount_required);
        const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
        const paidSum = payments.reduce((s, pm) => s + centsOf(pm?.amount), 0);
        if (required <= 0 && paidSum <= 0) continue;
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

        const gross = (required > 0 ? required : paidSum) / 100;
        const mark = manualSpendMarksRef.current?.[String(d.id)];
        aggFor(locId).push({
          key: `d-${d.id}`,
          delivery_id: String(d.id),
          patientName: resolvePatientName(d.patient_id)?.full_name || null,
          storeAbbrev: sInfo?.abbreviation || null,
          storeColor: sInfo?.color || null,
          amount: gross,
          sub: doneAt.slice(11, 16),
          collected: true,
          // Debit/Credit payments ARE card money by definition in the
          // delivery-data model — the sky "Card Spend" pill marks them.
          hasCardSpend: isCard,
          manualCardSpend: !!(mark?.touchedAt || mark?.at),
          collectedLabel: label,
          // Cash / Cheque never touch the card — no fee/loan/folder math.
          netAmount: isCard ?
          computeNetCollected(gross, { cardType: label, loanRate: loanRateByLoc.get(locId), folderRate: folderRateNow }) :
          null,
          // FEE BREAKDOWN (owner spec Oct 7 2026): second row shows
          // "HH:MM | S:fee F:folder L:loan | net Type" for card payments —
          // the settled story of the collection in one line. Cash / Cheque
          // rows have no card fees, so no breakdown.
          feeParts: isCard ? function () {
            // Cents-rounded components (owner spec Oct 7 2026) — same values
            // that feed the settled net, so the S/F/L line always sums to
            // gross − net exactly.
            const grossC = Math.round(gross * 100);
            return {
              fee: estimateCardFeeCents(grossC, label) / 100,
              folder: folderCentsFor(grossC, folderRateNow) / 100,
              loan: Math.round(grossC * Number(loanRateByLoc.get(locId) || 0)) / 100
            };
          }() : null
        });
      }

      const out = {};
      for (const [locId, rows] of byLoc) out[locId] = rows;
      setCodCollectedTodayByLoc(out);
    } catch (e) {
      console.error('cod collected-today compute failed:', e);
    }
  }, []);

  const refresh = useCallback(async (opts = {}) => {
    setIsLoading(true);
    try {
      let cfg = config;
      if (opts.reloadConfig || !cfg) cfg = await loadConfig();
      await loadSales(cfg);
    } finally {
      setIsLoading(false);
    }
  }, [config, loadConfig, loadSales]);

  // Fresh numbers every visit: load config, pull new Square sales since the
  // true-up, then read the ledger. The 9pm briefing also freshens the ledger,
  // and the Refresh button does it on demand.
  useEffect(() => {
    (async () => {
      // OFFLINE-FIRST (Oct 2 2026): paint the last IDB snapshot instantly so
      // the page opens with real numbers even before the network round-trips
      // (config + sales + payouts + CODs outstanding all live in the snapshot
      // the sidebar hook writes after every successful load). User-scoped:
      // never render another account's balances. Server loads below then
      // overwrite everything with fresh data.
      try {
        const snap = await getSummarySnapshot().catch(() => null);
        if (snap?.payload && (!snap.user_id || snap.user_id === currentUser?.id)) {
          const data = deserializeSummary(snap.payload);
          if (data) {
            if (data.config) setConfig(data.config);
            if (data.configRecordId) setConfigRecordId(data.configRecordId);
            setDeliveryCredits(data.deliveryCredits instanceof Map ? data.deliveryCredits : new Map(Array.isArray(data.deliveryCredits) ? data.deliveryCredits : []));
            setPayouts(data.payouts || []);
            if (data.codOutstandingDetailed && Object.keys(data.codOutstandingDetailed).length) setLocalOutstanding(data.codOutstandingDetailed);
            setIsLoading(false);
          }
        }
      } catch (e) {/* snapshot is best-effort — server load below is authoritative */}
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
    /* eslint-disable-next-line */
  }, []);

  // OWNER SPEC (Oct 7 2026) — STRICTLY DELIVERY DATA: the Sync button no
  // longer calls the Square API (squareLedgerSync / squareGetCodData2 are
  // retired on this page). It re-reads fresh DELIVERY data — credits from
  // finished deliveries' cod_payments, outstanding from active deliveries,
  // collected-today — plus cached ledger payout rows. The Square COD page and
  // the Audit page keep their own syncs.
  const syncFromSquare = useCallback(async () => {
    setIsSyncing(true);
    try {
      let cfg = config;
      if (!cfg?.trued_up_at) cfg = await loadConfig();
      await loadSales(cfg);
      await computeLocalOutstanding(cfg);
      await computeCodCollectedToday();
      computeCatalogUncollected();
      loadDailyCod();
      toast.success('Delivery data refreshed');
    } catch (err) {
      console.error('delivery-data refresh failed:', err);
      toast.error('Refresh failed');
    } finally {
      setIsSyncing(false);
    }
  }, [config, loadConfig, loadSales, computeLocalOutstanding, computeCodCollectedToday]);

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
      codTimer = setTimeout(() => {computeLocalOutstandingRef.current?.();computeCodCollectedTodayRef.current?.();computeCatalogUncollectedRef.current?.();loadDailyCodRef.current?.();}, 8000);
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
      const estimateItems = [...(codOut?.items || []), ...(codOut?.deductItems || [])];
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
        pendingDeducted: r2(pendingDeductCents / 100),
        pendingDeductCount,
        codOutstanding: codOut,
        lastSaleAt: dc.lastAt || null
      };
    });
  }, [config, deliveryCredits, payoutByLoc, payouts, codOutstandingByLoc, localOutstanding, weeklyCodAvgByLoc, manualSpendMarks, countedIdsSet]);

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
      draft[loc.location_id] = { card: '', loan: '', loan_rate: String(loc.loan_rate ?? '') };
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
      const amt = parseFloat(topUpDraft[loc.location_id]);
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
        const amt = parseFloat(topUpDraft[loc.location_id]);
        return Number.isFinite(amt) ? s + amt : s;
      }, 0);
      toast.success(totalTopUp ? `Cards topped up (+${fmtMoney(totalTopUp)} split across cards)` : 'No amounts entered — nothing changed');
    } catch (err) {
      console.error('top-up save failed:', err);
      toast.error('Could not save the top-up');
    } finally {
      setIsSaving(false);
    }
  };

  const saveTrueUp = async () => {
    if (!config) return;
    const locations = (config.locations || []).map((loc) => {
      const d = trueUpDraft[loc.location_id] || {};
      const card = parseFloat(d.card);
      const loan = parseFloat(d.loan);
      const rate = parseFloat(d.loan_rate);
      return {
        ...loc,
        card_start: Number.isFinite(card) ? card : loc.card_start,
        loan_start: Number.isFinite(loan) ? loan : loc.loan_start,
        loan_rate: Number.isFinite(rate) ? rate : loc.loan_rate
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
      (loc?.items || []).forEach((it) => { if (it?.delivery_id) countedIds.add(String(it.delivery_id)); });
      (loc?.deductItems || []).forEach((it) => { if (it?.delivery_id) countedIds.add(String(it.delivery_id)); });
    }
    for (const rows of Object.values(codCollectedTodayByLoc || {})) {
      (rows || []).forEach((r) => { if (r?.delivery_id) countedIds.add(String(r.delivery_id)); });
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
        <div className="ml-auto flex gap-2">
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

      {/* Location cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {(restricted ? perLocation.filter((l) => visibleLocationIds.includes(l.location_id)) : perLocation).map((loc) => {
          const lvl = BALANCE_LEVELS[loc.level] || null;
          return (
            <div key={loc.location_id}
            className="rounded-xl border-2 bg-white dark:bg-slate-900 overflow-hidden"
            style={lvl ? { borderColor: lvl.border, backgroundImage: `linear-gradient(0deg, ${lvl.tint}, ${lvl.tint})` } : { borderColor: 'var(--border-slate-200, #e2e8f0)' }}>
            <div className="px-4 pt-3 pb-2 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">{loc.name || loc.location_id}</div>
                  <div className="text-slate-400 text-[13px]">{loc.saleCount} card sale{loc.saleCount === 1 ? '' : 's'} since true-up{loc.lastSaleAt ? ` · last ${new Date(loc.lastSaleAt).toLocaleTimeString()}` : ''}</div>
                </div>
                {ownerCanEdit &&
                  <button
                    type="button"
                    title="Funds transfer"
                    aria-label={`Funds transfer from ${loc.name || loc.location_id}`}
                    className="shrink-0 w-7 h-7 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-50 hover:border-slate-400 dark:hover:border-slate-500 flex items-center justify-center transition-colors"
                    onClick={(e) => {e.stopPropagation();openTransfer(loc);}}
                    disabled={isSaving || isLoading}>
                    
                    <ArrowLeftRight className="w-3.5 h-3.5" />
                  </button>
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
              <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400"><Receipt className="w-3.5 h-3.5" /> CODs charged to card{loc.pendingDeductCount ? ` (${loc.pendingDeductCount})` : ''}</div>
                  <div className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">−{fmtMoney(loc.pendingDeducted)}</div>
                </div>
              {loc.storeCardSpend > 0 &&
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400"><CreditCard className="w-3.5 h-3.5" /> Store-card spends (excluded)</div>
                  <div className="font-semibold tabular-nums text-slate-400">{fmtMoney(loc.storeCardSpend)}</div>
                </div>
                }
              



                
              {(() => {
                  // Collected/Uncollected/Past uncollected list — owner request
                  // Oct 4 2026: drivers see this full section too (same as the
                  // App Owner), just without the Loan left row and the net
                  // credits/gross/fees/loan/folder breakdown line above, which
                  // stay ownerCanEdit-gated.
                  const todayStr = edmontonWallString(new Date()).slice(0, 10);
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
                  const notTapped = (id) => !!id && !!manualSpendMarksRef.current?.[String(id)]?.notTapped;
                  const manualMark = (id) => !!id && !!manualSpendMarksRef.current?.[String(id)];
                  // Delivery-derived active CODs (pendingPickup flag for
                  // pending status)…
                  const deliveryRows = outItems.map((it) => ({
                    key: `o-${it.delivery_id}`,
                    delivery_id: it.delivery_id,
                    patientName: it.patient || null,
                    storeAbbrev: it.storeAbbrev || null,
                    storeColor: it.storeColor || null,
                    amount: it.amount,
                    date: it.date || null,
                    pendingPickup: it.status === 'pending',
                    inTransit: it.status === 'in_transit',
                    failed: it.status === 'failed',
                    notTapped: notTapped(it.delivery_id)
                  }));
                  // …MERGED with the SquareCatalogItems still ACTIVE in the
                  // register (owner spec, Oct 7 2026 follow-up — same as the
                  // old system: catalog items catch CODs whose delivery rows
                  // fall outside the delivery-derived window). Deduped by
                  // delivery_id — delivery-derived rows win; catalog rows with
                  // no delivery link always show.
                  const srcDeliveryIds = new Set(deliveryRows.map((it) => String(it.delivery_id)).filter((it) => it !== 'null' && it !== 'undefined'));
                  const catRows = (catalogUncollectedByLoc?.[loc.location_id] || []).
                  filter((it) => !it.delivery_id || !srcDeliveryIds.has(String(it.delivery_id))).
                  map((it) => ({
                    key: it.key || `cat-${it.delivery_id || it.patientName}`,
                    delivery_id: it.delivery_id || null,
                    patientName: it.patientName || null,
                    storeAbbrev: it.storeAbbrev || null,
                    storeColor: it.storeColor || null,
                    amount: it.amount,
                    date: it.date || null,
                    pendingPickup: false,
                    notTapped: notTapped(it.delivery_id),
                    cashAwaitingSquare: !!it.cashAwaitingSquare
                  }));
                  const combinedSrc = [...deliveryRows, ...catRows];
                  // Owner spec (Oct 6 2026): cash-collected CODs STAY in
                  // Uncollected / Past uncollected — they are technically
                  // uncollected until processed back to the Square card. They
                  // render with a 'Cash' status badge (CardCodList) and keep
                  // their Card Spend pills.
                  const uncollectedTodayRows = combinedSrc.filter((it) => !it.date || it.date >= todayStr).map((it) => ({
                    key: it.key || `o-${it.delivery_id}`,
                    delivery_id: it.delivery_id || null,
                    patientName: it.patientName || it.patient || null,
                    storeAbbrev: it.storeAbbrev || null,
                    storeColor: it.storeColor || null,
                    amount: it.amount,
                    sub: `${it.date || todayStr}${it.sub ? ` · ${it.sub}` : ''}`,
                    collected: false,
                    pendingPickup: !!it.pendingPickup,
                    inTransit: !!it.inTransit,
                    failed: !!it.failed,
                    hasCardSpend: false, // Square-evidence swipe scan retired Oct 7 2026 — delivery data only
                    manualCardSpend: manualMark(it.delivery_id),
                    notTapped: notTapped(it.delivery_id),
                    cashAwaitingSquare: !!it.cashAwaitingSquare
                  }));
                  // combinedSrc already covers EVERY active-delivery COD (any
                  // date) — future-dated rows land in Uncollected via the
                  // today/past filters below, so no separate future merge is
                  // needed anymore.
                  const futurePendingRows = [];
                  const pastUncollectedRows = combinedSrc.filter((it) => it.date && it.date < todayStr).map((it) => ({
                    key: it.key || `p-${it.delivery_id}`,
                    delivery_id: it.delivery_id || null,
                    patientName: it.patientName || it.patient || null,
                    storeAbbrev: it.storeAbbrev || null,
                    storeColor: it.storeColor || null,
                    amount: it.amount,
                    sub: it.sub || it.date,
                    collected: false,
                    pendingPickup: !!it.pendingPickup,
                    inTransit: !!it.inTransit,
                    failed: !!it.failed,
                    hasCardSpend: false, // Square-evidence swipe scan retired Oct 7 2026 — delivery data only
                    manualCardSpend: manualMark(it.delivery_id),
                    notTapped: notTapped(it.delivery_id),
                    cashAwaitingSquare: !!it.cashAwaitingSquare
                  }));
                  const collectedTodayRows = codCollectedTodayByLoc[loc.location_id] || [];
                  const sumOf = (rows) => rows.reduce((s, r) => s + Number(r.amount || 0), 0);
                  return (
                    <CardCodList
                      canMarkSpend={!!currentUser}
                      onMarkSpend={markCardSpend}
                      onMarkRefunded={markFailedRefunded}
                      loading={isLoading || localOutstanding === null || catalogUncollectedByLoc === undefined}
                      sections={[
                      { label: 'Collected Today', color: '#059669', rows: collectedTodayRows, total: sumOf(collectedTodayRows) },
                      { label: 'Uncollected Today', color: '#d97706', rows: [...futurePendingRows, ...uncollectedTodayRows], total: sumOf(uncollectedTodayRows) + sumOf(futurePendingRows) },
                      { label: 'Uncollected Past', color: '#64748b', rows: pastUncollectedRows, total: sumOf(pastUncollectedRows) }]
                      } />);


                })()}
            </div>
          </div>);

        })}
      </div>

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
          <div ref={trueUpPanelRef} className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">True-Up: enter the CURRENT real numbers from each Square dashboard</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Blank fields keep the existing value. This resets the tracking window to now.</div>
            </div>
            {(config.locations || []).map((loc) =>
          <div key={loc.location_id} className="space-y-1.5">
                <div className="text-sm font-medium text-slate-900 dark:text-slate-50">{loc.name || loc.location_id}</div>
                <div className="grid grid-cols-3 gap-1.5 items-end">
                  <label className="text-[10px] text-slate-500 dark:text-slate-400">Card balance
                    <Input type="number" step="0.01" className="mt-0.5 px-2 text-xs" placeholder={fmtMoney(loc.card_start)}
                value={trueUpDraft[loc.location_id]?.card ?? ''}
                onChange={(e) => setTrueUpDraft((d) => ({ ...d, [loc.location_id]: { ...(d[loc.location_id] || {}), card: e.target.value } }))} />
                  </label>
                  <label className="text-[10px] text-slate-500 dark:text-slate-400">Loan remaining
                    <Input type="number" step="0.01" className="mt-0.5 px-2 text-xs" placeholder={fmtMoney(loc.loan_start)}
                value={trueUpDraft[loc.location_id]?.loan ?? ''}
                onChange={(e) => setTrueUpDraft((d) => ({ ...d, [loc.location_id]: { ...(d[loc.location_id] || {}), loan: e.target.value } }))} />
                  </label>
                  <label className="text-[10px] text-slate-500 dark:text-slate-400">Loan rate
                    <Input type="number" step="0.0001" className="mt-0.5 px-2 text-xs" placeholder={String(loc.loan_rate)}
                value={trueUpDraft[loc.location_id]?.loan_rate ?? ''}
                onChange={(e) => setTrueUpDraft((d) => ({ ...d, [loc.location_id]: { ...(d[loc.location_id] || {}), loan_rate: e.target.value } }))} />
                  </label>
                </div>
              </div>
          )}
            <div className="space-y-1.5">
              <div className="text-sm font-medium text-slate-900 dark:text-slate-50">Folder (combined)</div>
              <div className="grid grid-cols-3 gap-1.5 items-end">
                <label className="text-[10px] text-slate-500 dark:text-slate-400">Folder balance
                  <Input type="number" step="0.01" className="mt-0.5 px-2 text-xs" placeholder={fmtMoney(config.folder_start || 0)}
                value={trueUpDraft.__folder ?? ''}
                onChange={(e) => setTrueUpDraft((d) => ({ ...d, __folder: e.target.value }))} />
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
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">Top Up Cards</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Enter the amount to ADD to each card's current balance. Blank fields are skipped. This does not reset the tracking window.</div>
            </div>
            {(config?.locations || []).map((loc) =>
          <label key={loc.location_id} className="block space-y-1">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{loc.name || loc.location_id}</span>
                <Input
              type="number"
              step="0.01"
              min="0"
              placeholder={`current ~${fmtMoney(perLocation.find((l) => l.location_id === loc.location_id)?.cardEstimate || 0)}`}
              value={topUpDraft[loc.location_id] ?? ''}
              disabled={isSaving}
              onChange={(e) => setTopUpDraft((d) => ({ ...d, [loc.location_id]: e.target.value }))} />
            
              </label>
          )}
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="outline" onClick={() => setShowTopUp(false)} disabled={isSaving}>Cancel</Button>
              <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={saveTopUp} disabled={isSaving}>
                {isSaving ? 'Adding…' : 'Add to Cards'}
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
    </div>);

}