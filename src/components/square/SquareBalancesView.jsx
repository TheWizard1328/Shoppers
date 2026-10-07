import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAppSettingRows, getFreshAppSettingRows } from '@/components/utils/appSettingsCache';
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshCw, Wallet, Landmark, PiggyBank, Receipt, ArrowLeftRight, CreditCard } from "lucide-react";
import { toast } from "sonner";
import { isAppOwner } from "@/components/utils/userRoles";
import { edmontonWallString } from "@/components/utils/albertaTime";
import { buildStoreToLocMap, computeWeeklyCodTotalsByStore, weeklyAvgByLocFromStores, getBalanceLevel, BALANCE_LEVELS, computeCodOutstandingDetailed, loadCardPayouts, loadCardTopups, loadCardSales, loadCardSpendEvidence, payoutsByLocation, learnStoreCardFingerprints, matchPayoutChargedCods, computePendingCodDeduction } from "./useSquareBalancesSummary";
import { getSummarySnapshot, deserializeSummary } from "./squareBalancesOfflineManager";
import { invalidateLedgerWindows } from "./useSquareBalancesSummary";

/**
 * SquareBalancesView — owner-only estimated balance tracker (prototype, Oct 2026).
 *
 * Tracks, per Square location:
 *   - Card balance estimate: starting balance + Σ(collected card sale − fee − folder 2% − loan%)
 *   - Loan remaining: starting loan − Σ(loan_rate × card sale)
 *   - Folder (savings) total: Σ(2% × card sale) since last true-up
 *
 * Data sources:
 *   - AppSettings 'square_balances': { trued_up_at, folder_rate, locations: [{location_id, name, card_start, loan_start, loan_rate, folder_start}] }
 *   - SquareLedgerEntry: entry_kind 'collected' (legacy 'sale' also accepted), tender_type 'CARD', status COMPLETED, occurred_at >= trued_up_at
 *     (kept fresh by squareLedgerSync; the Refresh button invokes it for the window since true-up).
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
const DEFAULT_FOLDER_RATE = 0.02;

const fmtMoney = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;

// Collected-amount net math (owner spec, Oct 5 2026): the "Collected" row
// shows amount to collect − service fee − folder fee (2%) − loan fee, same
// formula as the card-balance credits math (owner-verified live: BATCH payout
// = sale − fee − loan% − 2%). Two fee sources, authoritative wins:
//   1. Real ledger match: settled_cents is Square's own post-fee figure for
//      that exact sale — use it directly, no estimate needed.
//   2. No ledger match (in-app recorded card payment with no Square tx,
//      e.g. a Debit/Credit COD the driver keyed without a device swipe):
//      estimate the fee from the recorded card type using the owner's rate
//      sheet (Oct 3 2026 plan): Interac/Debit = $0.07 + 0.75%, Credit = 2.5%
//      flat. Then still deduct the location's own loan_rate + folder_rate.
const FEE_SHEET = {
  debit: (amt) => 0.07 + amt * 0.0075,     // Interac
  interac: (amt) => 0.07 + amt * 0.0075,
  credit: (amt) => amt * 0.025,            // flat-rate credit swipe
};
function estimateCardFee(amount, cardType) {
  const key = String(cardType || '').toLowerCase();
  const fn = FEE_SHEET[key] || FEE_SHEET.credit; // default to credit's flat rate when unknown
  return Math.max(0, fn(Number(amount) || 0));
}
function computeNetCollected(grossAmount, { settledCents = null, cardType = null, loanRate = 0, folderRate = DEFAULT_FOLDER_RATE } = {}) {
  const gross = Number(grossAmount) || 0;
  if (settledCents != null) return Math.abs(Number(settledCents)) / 100;
  const fee = estimateCardFee(gross, cardType);
  const loan = gross * Number(loanRate || 0);
  const folder = gross * Number(folderRate ?? DEFAULT_FOLDER_RATE);
  return Math.max(0, gross - fee - loan - folder);
}

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
function CardCodList({ sections, canMarkSpend, onMarkSpend }) {
  if (!sections || !sections.some((s) => s.rows.length > 0)) return null;
  return (
    <div className="pt-2 mt-2 border-t border-slate-100 dark:border-slate-800 space-y-2">
      {sections.map((sec) => (
        <div key={sec.label} className="space-y-1">
          <div className="flex items-center justify-between text-[11px] font-medium">
            <span style={{ color: sec.color }}>{sec.label}</span>
            <span className="text-slate-400 tabular-nums">{sec.rows.length} · {fmtMoney(sec.total)}</span>
          </div>
          {sec.rows.length === 0 && <div className="text-[11px] text-slate-400">none</div>}
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
            const statusLabel = r.collected
              ? (r.collectedLabel || 'Collected')
              : (r.cashAwaitingSquare ? 'Cash' : (r.pendingPickup ? 'Awaiting Pickup' : 'Pending'));
            const emeraldCls = 'bg-emerald-100 dark:bg-emerald-900/30 border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300';
            const statusColorCls = r.collected
              ? emeraldCls
              : (r.cashAwaitingSquare ? emeraldCls : 'bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300');
            const showNetAmount = r.collected && statusLabel !== 'Cash' && r.netAmount != null;
            return (
              <div key={r.key} className="flex items-start justify-between gap-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-2.5 py-1.5">
                <div className="min-w-0 flex flex-col gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {r.storeAbbrev && (
                      <span
                        className="text-[9px] font-bold leading-none px-1.5 py-0.5 rounded-full text-white flex-shrink-0"
                        style={{ backgroundColor: r.storeColor || '#64748b' }}
                      >
                        {r.storeAbbrev}
                      </span>
                    )}
                    <p className="font-semibold text-[13px] leading-4 text-slate-900 dark:text-slate-50 truncate">{r.patientName || 'COD'}</p>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{r.sub}</p>
                </div>
                <div className="shrink-0 flex flex-col items-end gap-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{fmtMoney(r.amount)}</span>
                    {/* Card Spend pill (owner spec Oct 6 2026) — TOGGLE on
                        uncollected rows: Square's card-activity data proved too
                        unreliable to auto-detect, so every uncollected COD
                        defaults to "Card Spend" (sky). Tapping flips it to
                        "Not Tapped" (violet) — the COD is added back to the
                        card balance estimate — and tapping again flips back.
                        Collected rows keep the legacy auto/manual evidence
                        pills. */}
                    {r.collected ? r.hasCardSpend ? (
                      <span className="rounded-full bg-sky-100 dark:bg-sky-900/30 border border-sky-300 dark:border-sky-700 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300">Card Spend</span>
                    ) : r.manualCardSpend ? (
                      <span className="rounded-full bg-violet-100 dark:bg-violet-900/30 border border-violet-300 dark:border-violet-700 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:text-violet-300">Card Spend</span>
                    ) : (canMarkSpend && !!r.delivery_id && !(r.collected && statusLabel === 'Cash') && onMarkSpend) ? (
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
                        className="cursor-pointer rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-600 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-300"
                      >Mark Spend</span>
                    ) : null : (
                      // UNCOLLECTED rows (owner spec Oct 6 2026): the pill is a
                      // toggle — every COD defaults to "Card Spend"; tapping it
                      // flips to "Not Tapped" (the COD is added back to the card
                      // balance), tapping again flips back. Owner-only tappable;
                      // drivers see the static state.
                      canMarkSpend && !!r.delivery_id && onMarkSpend ? (
                        <span
                          onClick={() => onMarkSpend(r.delivery_id)}
                          className={r.notTapped
                            ? 'cursor-pointer rounded-full bg-violet-100 dark:bg-violet-900/30 border border-violet-300 dark:border-violet-700 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:text-violet-300'
                            : 'cursor-pointer rounded-full bg-sky-100 dark:bg-sky-900/30 border border-sky-300 dark:border-sky-700 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300'}
                        >{r.notTapped ? 'Not Tapped' : 'Card Spend'}</span>
                      ) : (
                        <span className={r.notTapped
                          ? 'rounded-full bg-violet-100 dark:bg-violet-900/30 border border-violet-300 dark:border-violet-700 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:text-violet-300'
                          : 'rounded-full bg-sky-100 dark:bg-sky-900/30 border border-sky-300 dark:border-sky-700 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300'}
                        >{r.notTapped ? 'Not Tapped' : 'Card Spend'}</span>
                      )
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {showNetAmount && (
                      <span className="text-[12px] font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">{fmtMoney(r.netAmount)}</span>
                    )}
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusColorCls}`}>{statusLabel}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export default function SquareBalancesView({ currentUser, visibleLocationIds = null }) {
  const [config, setConfig] = useState(null);
  const [configRecordId, setConfigRecordId] = useState(null);
  const [sales, setSales] = useState([]);
  const [payouts, setPayouts] = useState([]); // BATCH bank sweeps since true-up
  const [topups, setTopups] = useState([]); // card_topup transfers onto the Square Cards since true-up
  const [codOutstandingByLoc, setCodOutstandingByLoc] = useState({});
  const [localOutstanding, setLocalOutstanding] = useState(null); // client-side compute — freshest source
  const [codCollectedTodayByLoc, setCodCollectedTodayByLoc] = useState({}); // owner-only: today's collected CODs per card
  const [cardSpendIds, setCardSpendIds] = useState(new Set()); // owner-only: delivery_ids with a real CARD swipe in Square tx data
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
      if (v.notTappedAt) value[k] = { notTapped: true, touchedAt: v.notTappedAt, by: v.by };
      else if (v.touchedAt) value[k] = { notTapped: !!v.notTapped, touchedAt: v.touchedAt, by: v.by };
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
    if (!ownerCanEdit || !deliveryId) return;
    const prev = manualSpendMarksRef.current || {};
    const key = String(deliveryId);
    const togglingBack = !!(prev?.[key]?.notTapped);
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
  }, [ownerCanEdit, currentUser]);

  const loadSales = useCallback(async (cfg) => {
    if (!cfg?.trued_up_at) { setSales([]); setPayouts([]); return; }
    const seq = ++loadSeq.current;
    // IDB-cached windows (Oct 2 2026 "100% offline-first"): loadCardSales and
    // loadCardPayouts both serve the shared 10-minute ledger windows cache —
    // opening the page during/after a rate-limit storm paints instantly from
    // IDB instead of joining the storm with 2-4 paginated API scans.
    const out = await loadCardSales(cfg, currentUser?.id || null).catch(() => []);
    // Bank sweeps (BATCH payouts) since true-up — they leave the real card, so
    // the estimate must subtract them (Oct 2 2026 owner mismatch fix).
    const payoutRows = await loadCardPayouts(cfg, currentUser?.id || null).catch(() => []);
    const topupRows = await loadCardTopups(cfg, currentUser?.id || null).catch(() => []);
    if (seq === loadSeq.current) { setSales(out); setPayouts(payoutRows); setTopups(topupRows); }
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
    // Was owner-only; drivers now see the same full Uncollected/Past
    // uncollected lists as the App Owner (owner request, Oct 4 2026) — the
    // catalog-sourced list catches old items the windowed delivery query
    // misses, which is exactly what "Past uncollected" needs for drivers too.
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
        base44.entities.Patient.list().catch(() => []),
      ]);
      const resolvePatientName = buildPatientResolver(patientsRaw);
      const storeById = new Map();
      (storesRaw || []).forEach((s) => { if (s?.id) storeById.set(String(s.id), s); });
      const byLoc = new Map();
      for (const it of (itemsRaw || [])) {
        if (!it?.location_id) continue;
        if (!byLoc.has(it.location_id)) byLoc.set(it.location_id, []);
        const sInfo = storeById.get(String(it.store_id || ''));
        const date = String(it.delivery_date || '').slice(0, 10);
        byLoc.get(it.location_id).push({
          key: `cat-${it.id || it.square_catalog_object_id}`,
          delivery_id: it.delivery_id || null,
          patientName: resolvePatientName(it.patient_id)?.full_name || extractNameFromCatalogDescription(it.description) || null,
          storeAbbrev: sInfo?.abbreviation || null,
          storeColor: sInfo?.color || null,
          amount: Number(it.amount || 0),
          date: date || null,
          cashAwaitingSquare: false,
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
          if (!r.delivery_id) { noDeliveryId.push(r); continue; }
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
        for (const r of (prevRows || [])) {
          if (!r.delivery_id) continue;
          seenThisPass.add(r.delivery_id);
          if (freshIds.has(r.delivery_id)) { streak.delete(r.delivery_id); continue; }
          const misses = (streak.get(r.delivery_id) || 0) + 1;
          if (misses >= 2) { streak.delete(r.delivery_id); continue; } // confirmed gone
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
          for (const d of (rows || [])) {
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
              next[locId] = rows
                .filter((r) => !(r.delivery_id && confirmedIds.has(String(r.delivery_id)))) // ledger-matched → collected
                .map((r) => (
                  r.delivery_id && cashCollectedDeliveryIds.has(r.delivery_id) ? { ...r, cashAwaitingSquare: true } : r
                ));
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
  const computeCodCollectedToday = useCallback(async () => {
    // Was owner-only; drivers now see "Collected today" the same as the App
    // Owner (owner request, Oct 4 2026).
    try {
      const [storesRaw, cfgsRaw, patientsRaw, codSalesPages] = await Promise.all([
        base44.entities.Store.list().catch(() => []),
        base44.entities.SquareLocationConfig.list().catch(() => []),
        base44.entities.Patient.list().catch(() => []),
        (async () => {
          const pages = [];
          for (let skip = 0; skip < 20000; skip += 500) {
            const rows = await base44.entities.SquareLedgerEntry.filter({ sale_class: 'cod_collection' }, 'created_date', 500, skip).catch(() => []);
            const list = rows || [];
            pages.push(...list);
            if (list.length < 500) break;
          }
          return pages;
        })(),
      ]);
      const codSalesRaw = dedupeLedgerById(codSalesPages);
      const resolvePatientName = buildPatientResolver(patientsRaw);
      // Fee-net math (owner spec, Oct 5 2026) needs each location's own
      // loan_rate; folder_rate is account-wide. configRef.current may be null
      // on first paint before config loads — net falls back to gross in that
      // case (computeNetCollected treats missing loanRate as 0).
      const cfgNow = configRef.current || {};
      const folderRateNow = Number(cfgNow.folder_rate ?? DEFAULT_FOLDER_RATE);
      const loanRateByLoc = new Map();
      (cfgNow.locations || []).forEach((l) => { if (l?.location_id) loanRateByLoc.set(l.location_id, Number(l.loan_rate || 0)); });
      const cfgLoc = new Map();
      (cfgsRaw || []).forEach((c) => { if (c?.id && c?.square_location_id) cfgLoc.set(c.id, c.square_location_id); });
      const storeToLoc = new Map();
      const storeById = new Map();
      (storesRaw || []).forEach((s) => {
        const loc = s?.square_location_config_id ? cfgLoc.get(s.square_location_config_id) : null;
        if (s?.id && loc) storeToLoc.set(String(s.id), loc);
        if (s?.id) storeById.set(String(s.id), s);
      });
      const today = edmontonWallString(new Date()).slice(0, 10);
      const centsOf = (n) => Math.round(Number(n || 0) * 100);
      const byLoc = new Map();
      const aggFor = (locId) => {
        if (!byLoc.has(locId)) byLoc.set(locId, []);
        return byLoc.get(locId);
      };

      // Pull deliveries first — needed to resolve driver name + store badge for
      // BOTH the Square-confirmed cash rows (a) and the non-cash rows (b).
      const deliveryById = new Map();
      const deliveryList = [];
      // 30-day horizon (owner, Oct 3 2026): the card-spend fingerprint rule
      // must cover the whole "Past uncollected" list (e.g. Sep 10 CODs on an
      // Oct 3 view), not just the last 3 days.
      const since30 = new Date(Math.floor(Date.now() / 86400000) * 86400000 - 30 * 86400000).toISOString();
      for (let page = 0; page < 20; page++) {
        const rows = await base44.entities.Delivery.filter({ created_date: { $gte: since30 } }, '-created_date', 500, page * 500).catch(() => []);
        const list = rows || [];
        deliveryList.push(...list);
        list.forEach((d) => { if (d?.id) deliveryById.set(String(d.id), d); });
        if (list.length < 500) break;
      }

      // ── Card-spend evidence (owner spec, Oct 3 2026). A delivery gets the
      // sky "Card Spend" pill when there is a real CARD swipe in the Square
      // data for its COD. Owner's description of how a swiped COD shows up in
      // the ledger: either a SINGLE sale entry, or a COMBINATION of 2+ sale
      // items totaling the COD amount to collect — all on the same date, on
      // the same (customer) card at the store, with one or more FAILED
      // entries registered on that card too (the card declined, then got
      // charged, possibly in pieces). Rules, in order:
      //   1. Direct link — squareLedgerSync's backfill stamped delivery_id
      //      on the sale row (decline-anchored exact match).
      //   2. Fingerprint story — same store + same Edmonton date + same
      //      card_fingerprint, at least one DECLINE on that card that day,
      //      and a subset (1-4) of that card's completed sales summing
      //      EXACTLY to the COD amount. This is the owner's split-payment
      //      pattern: declines, then partial charges.
      //   3. Near-time fallback — a completed CARD sale (or combo of nearby
      //      CODs) within ±90min of the completion whose amounts add up
      //      EXACTLY. Catches the clean single swipe with no decline.
      // Store-card fingerprints (5+ swipes at one location, never linked to
      // a COD) are learned and excluded — those are the store's own card
      // spends, not customer COD swipes.
      const evidence = await loadCardSpendEvidence(configRef.current, currentUser?.id || null).catch(() => ({ sales: [], declines: [] }));
      const storeCardFps = learnStoreCardFingerprints(evidence.sales || []);
      const isStoreCard = (e) => !!e?.card_fingerprint && storeCardFps.has(e.card_fingerprint);
      const cardSales = dedupeLedgerById([
        ...(evidence.sales || []),
        ...(codSalesRaw || []),
      ].filter((e) =>
        ['sale', 'collected'].includes(String(e?.entry_kind || ''))
        && String(e?.tender_type || '').toUpperCase() === 'CARD'
        // Owner report (Oct 6 2026): Square's app shows some swipes under a
        // "Pending" header, still authorized but not yet settled — those
        // must count toward the badge too (e.g. Elaine Ash 49.98), not just
        // fully COMPLETED sales.
        && ['COMPLETED', 'APPROVED', 'PENDING'].includes(String(e?.status || '').toUpperCase())
        && e?.location_id
        && !isStoreCard(e)));
      const declines = (evidence.declines || []).filter((e) => e?.location_id && e?.card_fingerprint && !isStoreCard(e));
      const swipedIds = new Set();
      for (const e of cardSales) if (e?.delivery_id) swipedIds.add(String(e.delivery_id)); // rule 1

      const saleKeyOf = (e) => String(e?.id || e?.square_id || '');
      const usedSaleKeys = new Set();

      // Candidate pool: completed deliveries with a COD to collect and a
      // known completion time. Amount = the recorded debit/credit collection
      // when present; otherwise the required COD amount (the split-swipe
      // story must also surface for CODs the driver recorded as Cash — the
      // exact-amount + same-card + decline-present guards keep it precise).
      const candidatesByLoc = new Map();
      for (const d of deliveryList) {
        // Owner rule (Oct 5 2026): the Card Spend pill must surface on EVERY
        // delivery whose COD value exists in the Square data — including
        // UNCOLLECTED ones (pending/in_transit/en_route). An active delivery
        // whose swipe already landed in Square is exactly the mismatch the
        // pill exists to flag. Completed deliveries anchor on completion time;
        // active ones anchor on their own delivery_date (no completion yet).
        if (!d?.id || swipedIds.has(String(d.id))) continue;
        const dStatus = String(d?.status || '').toLowerCase();
        const isCompleted = dStatus === 'completed';
        if (!isCompleted && !['pending', 'in_transit', 'en_route'].includes(dStatus)) continue;
        const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
        let cardAmt = payments
          .filter((p) => ['debit', 'credit'].includes(String(p?.type || '').toLowerCase()))
          .reduce((sum, p) => sum + centsOf(p?.amount), 0);
        if (cardAmt <= 0) cardAmt = centsOf(d?.cod_total_amount_required);
        if (cardAmt <= 0) continue;
        const doneAt = isCompleted && d.actual_delivery_time ? new Date(d.actual_delivery_time).getTime() : null;
        if (isCompleted && !doneAt) continue;
        const locId = storeToLoc.get(String(d?.store_id || ''));
        if (!locId) continue;
        if (!candidatesByLoc.has(locId)) candidatesByLoc.set(locId, []);
        const day = isCompleted
          ? edmontonWallString(new Date(doneAt)).slice(0, 10)
          : String(d?.delivery_date || '').slice(0, 10);
        candidatesByLoc.get(locId).push({ id: String(d.id), amt: cardAmt, t: doneAt, day });
      }
      // Find a combo (size 1-maxSize) within `items` summing EXACTLY to `target`.
      const findExactSumCombo = (items, target, maxSize) => {
        const n = items.length;
        for (let size = 1; size <= Math.min(maxSize, n); size++) {
          const idx = Array.from({ length: size }, (_, i) => i);
          while (idx[0] <= n - size) {
            const combo = idx.map((i) => items[i]);
            if (combo.reduce((s, c) => s + c.amt, 0) === target) return combo;
            let i = size - 1;
            while (i >= 0 && idx[i] === n - size + i) i--;
            if (i < 0) break;
            idx[i]++;
            for (let j = i + 1; j < size; j++) idx[j] = idx[j - 1] + 1;
          }
        }
        return [];
      };

      // Rule 2 — fingerprint story (owner, Oct 3 2026): group CARD sales and
      // declines by store + Edmonton date + card fingerprint; a group with at
      // least one decline that day whose sales contain an exact-amount
      // subset of a COD is the swipe.
      const groupsByLocDayFp = new Map();
      const groupKey = (locId, day, fp) => `${locId}|${day}|${fp}`;
      for (const e of cardSales) {
        if (!e?.card_fingerprint || !e?.occurred_at) continue;
        const day = edmontonWallString(new Date(e.occurred_at)).slice(0, 10);
        const k = groupKey(e.location_id, day, e.card_fingerprint);
        if (!groupsByLocDayFp.has(k)) groupsByLocDayFp.set(k, { sales: [], declineCount: 0, locId: e.location_id, day });
        groupsByLocDayFp.get(k).sales.push(e);
      }
      for (const e of declines) {
        if (!e?.occurred_at) continue;
        const day = edmontonWallString(new Date(e.occurred_at)).slice(0, 10);
        const k = groupKey(e.location_id, day, e.card_fingerprint);
        if (!groupsByLocDayFp.has(k)) groupsByLocDayFp.set(k, { sales: [], declineCount: 0, locId: e.location_id, day });
        groupsByLocDayFp.get(k).declineCount += 1;
      }
      for (const [locId, cands] of candidatesByLoc) {
        for (const c of cands) {
          if (swipedIds.has(c.id)) continue;
          for (const g of groupsByLocDayFp.values()) {
            if (g.locId !== locId || g.day !== c.day || g.declineCount < 1) continue;
            const avail = g.sales.filter((x) => !usedSaleKeys.has(saleKeyOf(x)));
            if (!avail.length) continue;
            const combo = findExactSumCombo(avail.map((x) => ({ amt: Math.abs(Number(x.amount_cents || 0)), row: x })), c.amt, 4);
            if (combo.length) {
              swipedIds.add(c.id);
              combo.forEach((x) => usedSaleKeys.add(saleKeyOf(x.row)));
              break;
            }
          }
        }
      }

      // Rule 2b — clean swipe story (owner, Oct 5 2026): same store + same
      // Edmonton date + same card_fingerprint, NO decline required — an exact
      // subset (1-4) of that card's completed sales summing to the COD. The
      // decline anchor (rule 2) covers the split-payment story; this covers
      // the clean single swipe rung hours away from the completion, and
      // UNCOLLECTED deliveries (pending/in_transit/en_route) which have no
      // completion time for rule 3's ±90min window. Owner rule: every delivery
      // whose value exists in the Square data gets the pill.
      for (const [locId, cands] of candidatesByLoc) {
        for (const c of cands) {
          if (swipedIds.has(c.id)) continue;
          for (const g of groupsByLocDayFp.values()) {
            if (g.locId !== locId || g.day !== c.day) continue;
            const avail = g.sales.filter((x) => !usedSaleKeys.has(saleKeyOf(x)));
            if (!avail.length) continue;
            const combo = findExactSumCombo(avail.map((x) => ({ amt: Math.abs(Number(x.amount_cents || 0)), row: x })), c.amt, 4);
            if (combo.length) {
              swipedIds.add(c.id);
              combo.forEach((x) => usedSaleKeys.add(saleKeyOf(x.row)));
              break;
            }
          }
        }
      }

      // Rule 3 — near-time fallback: a completed CARD sale whose amount is
      // an exact combo (1-3) of CODs completed within ±90 minutes of it.
      const cardSalesByLoc = new Map();
      for (const e of cardSales) {
        if (!e?.location_id || usedSaleKeys.has(saleKeyOf(e))) continue;
        if (!cardSalesByLoc.has(e.location_id)) cardSalesByLoc.set(e.location_id, []);
        cardSalesByLoc.get(e.location_id).push(e);
      }
      for (const [locId, sales] of cardSalesByLoc) {
        const pool = candidatesByLoc.get(locId) || [];
        for (const sale of sales) {
          if (!sale.occurred_at) continue;
          const saleAmt = Math.abs(Number(sale.amount_cents || 0));
          const saleT = new Date(sale.occurred_at).getTime();
          const nearby = pool.filter((c) => c.t != null && !swipedIds.has(c.id) && Math.abs(c.t - saleT) <= 90 * 60000);
          if (nearby.length === 0) continue;
          const combo = findExactSumCombo(nearby, saleAmt, 3);
          for (const c of combo) swipedIds.add(c.id);
        }
      }
      setCardSpendIds(swipedIds);

      // Owner spec (Oct 5 2026): the status badge word itself now reflects
      // HOW the money came back — 'Cash' (no card fees ever applied, no net
      // math shown), or 'Debit'/'Credit' (real card tender, net amount shown
      // to its left = gross − fee − loan% − folder%). INTERAC tender reads
      // as Debit, everything else CARD reads as Credit.
      const labelForTender = (tenderType, cardBrand) => {
        if (String(tenderType || '').toUpperCase() !== 'CARD') return 'Cash';
        return String(cardBrand || '').toUpperCase() === 'INTERAC' ? 'Debit' : 'Credit';
      };
      const labelForPaymentType = (t) => {
        const k = String(t || '').toLowerCase();
        if (k === 'debit') return 'Debit';
        if (k === 'credit') return 'Credit';
        return 'Cash';
      };

      // a) Square-confirmed collections that happened TODAY — the ledger
      // entry is the authoritative source for both the real tender (so a
      // cash-recorded COD that was actually swiped shows Debit/Credit, not
      // Cash) and the real settled amount (no estimate needed).
      const squareTodayIds = new Set();
      for (const e of (codSalesRaw || [])) {
        if (String(e?.status || '').toUpperCase() !== 'COMPLETED' || !e?.delivery_id) continue;
        const when = e.occurred_at ? edmontonWallString(new Date(e.occurred_at)) : '';
        if (!when || when.slice(0, 10) !== today) continue;
        squareTodayIds.add(String(e.delivery_id));
        const locId = e.location_id;
        if (!locId) continue;
        const linkedDelivery = deliveryById.get(String(e.delivery_id));
        const sInfo = linkedDelivery ? storeById.get(String(linkedDelivery.store_id || '')) : null;
        const txPatientName = resolvePatientName(e.patient_id || linkedDelivery?.patient_id)?.full_name || null;
        const grossA = Math.abs(Number(e.amount_cents || 0)) / 100;
        const label = labelForTender(e.tender_type, e.card_brand);
        aggFor(locId).push({
          key: `tx-${e.id || e.square_id}`,
          delivery_id: String(e.delivery_id),
          patientName: txPatientName,
          storeAbbrev: sInfo?.abbreviation || null,
          storeColor: sInfo?.color || null,
          amount: grossA,
          sub: when.slice(11, 16),
          collected: true,
          hasCardSpend: swipedIds.has(String(e.delivery_id)),
          manualCardSpend: !!manualSpendMarksRef.current?.[String(e.delivery_id)]?.at,
          collectedLabel: label,
          // Cash never touches the card — no fee/loan/folder math applies.
          netAmount: label === 'Cash' ? null : computeNetCollected(grossA, { settledCents: e.settled_cents, loanRate: loanRateByLoc.get(locId), folderRate: folderRateNow }),
        });
      }

      // b) deliveries completed TODAY with no Square-ledger match — covers
      // BOTH in-app recorded non-cash payments (Debit/Credit, estimated fee
      // math) AND pure cash collections (Cash badge, no amount, no math),
      // so every completed-today COD shows up with the right badge word.
      {
        const list = deliveryList;
        for (const d of list) {
          if (d?.status !== 'completed' || Number(d?.cod_total_amount_required || 0) <= 0) continue;
          const doneAt = String(d.actual_delivery_time || '');
          if (doneAt.slice(0, 10) !== today) continue;
          if (squareTodayIds.has(String(d.id))) continue; // already reported via Square (block a)
          const locId = storeToLoc.get(String(d?.store_id || ''));
          if (!locId) continue;
          const sInfo = storeById.get(String(d?.store_id || ''));
          const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
          const nonCashPmt = payments.find((p) => String(p?.type || '').toLowerCase() !== 'cash');
          // Owner spec (Oct 6 2026): a pure CASH collection is NOT "Collected"
          // — it is technically uncollected until processed back to the
          // Square card. Its catalog item keeps it listed in Uncollected /
          // Past uncollected with a Cash badge, so skip it here to avoid the
          // same delivery reading as both Collected and Uncollected.
          if (!nonCashPmt) continue;
          const grossB = Number(d.cod_total_amount_required || 0);
          const label = labelForPaymentType(nonCashPmt?.type);
          aggFor(locId).push({
            key: `d-${d.id}`,
            delivery_id: String(d.id),
            patientName: resolvePatientName(d.patient_id)?.full_name || null,
            storeAbbrev: sInfo?.abbreviation || null,
            storeColor: sInfo?.color || null,
            amount: grossB,
            sub: doneAt.slice(11, 16),
            collected: true,
            // BUG FIX (Oct 5 2026): this used to be hardcoded false — "in-app
            // recorded, not a Square-confirmed spend" — but swipedIds already
            // holds every delivery the fuzzy rules (2/3) matched against a
            // REAL card sale in the ledger (same amount, same day, near-time
            // or fingerprint+decline story), even when the backend never
            // stamped a direct delivery_id link. Verified live: Marlene Vis's
            // $64.89 Debit COD has an exact-amount, exact-time (16:41) CARD
            // sale in the ledger that was simply never linked — the fuzzy
            // match catches it, this hardcoded false was throwing it away.
            hasCardSpend: swipedIds.has(String(d.id)),
            manualCardSpend: !!manualSpendMarksRef.current?.[String(d.id)]?.at,
            collectedLabel: label,
            // No real Square tx for this one — estimate the fee from the
            // recorded card type (owner rate sheet, Oct 3 2026). Pure cash
            // skips the math entirely per owner rule.
            netAmount: label === 'Cash' ? null : computeNetCollected(grossB, { cardType: label, loanRate: loanRateByLoc.get(locId), folderRate: folderRateNow }),
          });
        }
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
            setSales(data.sales || []);
            setPayouts(data.payouts || []);
            if (data.codOutstandingDetailed && Object.keys(data.codOutstandingDetailed).length) setLocalOutstanding(data.codOutstandingDetailed);
            setIsLoading(false);
          }
        }
      } catch (e) { /* snapshot is best-effort — server load below is authoritative */ }
      try {
        const cfg = await loadConfig();
        // Auto Square sync is owner-only — a driver's open tab must never hit the Square API.
        if (cfg?.trued_up_at && ownerCanEditRef.current) {
          setIsSyncing(true);
          const res = await base44.functions.invoke('squareLedgerSync', { startDate: cfg.trued_up_at, includeCodOutstanding: true }).catch((e) => { console.error('auto ledger sync failed:', e); return null; });
          const out = res?.codOutstanding || [];
          const byLoc = {}; out.forEach((o) => { byLoc[o.location_id] = o; });
          setCodOutstandingByLoc(byLoc);
          setIsSyncing(false);
          // Fresh ledger rows just landed via a service-role sync (no WS echo
          // reaches us), so the IDB windows cache — including the card-spend
          // evidence pool — is stale. Drop it BEFORE loadSales/computes run,
          // otherwise new swipes badge only after the 10-min TTL (owner report
          // Oct 5 2026: Card Spend pill showing intermittently).
          if (res) invalidateLedgerWindows();
        }
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

  const syncFromSquare = useCallback(async () => {
    const startDate = config?.trued_up_at || new Date(Date.now() - 3 * 86400000).toISOString();
    setIsSyncing(true);
    try {
      const res = await base44.functions.invoke('squareLedgerSync', { startDate, includeCodOutstanding: true });
      const out = res?.codOutstanding || [];
      const byLoc = {}; out.forEach((o) => { byLoc[o.location_id] = o; });
      setCodOutstandingByLoc(byLoc);
      // The sync just wrote NEW ledger rows (service-role — no WS echo reaches
      // us), so the IDB windows cache is stale: drop it before refresh() runs
      // loadSales, otherwise the page repaints the pre-sync cache.
      invalidateLedgerWindows();

      // STEP 2 — COD CATALOG SYNC (owner spec, Oct 7 2026): the ledger sync
      // above registers the real Square sales and stamps
      // cod_confirmed_collected on cash-collected deliveries; the COD sync
      // then clears their Square catalog items so those rows drop from the
      // Uncollected lists on BOTH data sets (ledger + catalog). ORDER MATTERS:
      // reversed, the catalog sync runs before the confirmations exist and
      // nothing clears.
      try {
        const LS_INFLIGHT = 'squareCodSync_inFlightUntil';
        const nowMs = Date.now();
        if (Number(localStorage.getItem(LS_INFLIGHT) || 0) > nowMs) {
          // The Square COD page's full sync holds the shared lease — its run
          // covers the same catalog reconcile, so don't double-fetch.
          console.log('[SquareBalances] COD sync skipped — Square COD page sync already running');
        } else {
          // Take the same cross-page lease the Square COD page uses so the
          // two syncs never run concurrently (shared Square rate-limit budget).
          localStorage.setItem(LS_INFLIGHT, String(nowMs + 240000));
          try {
            // Incremental order fetch (same marker logic as the Square COD
            // page): pass orderFetchSince when a recent sync exists so this
            // pulls only the order tail instead of the full 90-day window.
            // READ-ONLY use of the marker — this page does not replace-save
            // the COD page's IDB transaction mirror, so the marker itself is
            // NOT stamped here (the COD page's next sync re-covers this tail).
            const lastOrderFetch = Number(localStorage.getItem('squareCod_lastOrderFetchAt') || 0);
            const orderFetchSince = (lastOrderFetch > 0 && Date.now() - lastOrderFetch < 14 * 86400000)
              ? new Date(lastOrderFetch - 7 * 86400000).toISOString()
              : null;
            await base44.functions.invoke('squareGetCodData2', {
              forceDeliveryRefresh: true,
              daysBack: 90,
              ...(orderFetchSince ? { orderFetchSince } : {}),
            });
          } finally {
            localStorage.removeItem(LS_INFLIGHT);
          }
        }
      } catch (err) {
        console.warn('[SquareBalances] COD catalog sync after ledger sync failed:', err);
      }
      toast.success('Square data refreshed');
      await refresh({ reloadConfig: false });
      computeLocalOutstanding();
      computeCodCollectedToday();
      computeCatalogUncollected();
    } catch (err) {
      console.error('squareLedgerSync failed:', err);
      toast.error('Square refresh failed');
    } finally {
      setIsSyncing(false);
    }
  }, [config, refresh]);

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
  useEffect(() => { loadSpendMarks(); }, [loadSpendMarks]);

  useEffect(() => {
    const unsubs = [];
    let cfgTimer = null, ledgerTimer = null, deliveryTimer = null, codTimer = null, catalogTimer = null, cardCollectedTimer = null;
    // Fast path: COD add/remove on any delivery → recompute outstanding locally (8s debounce).
    const scheduleCodRecompute = () => {
      clearTimeout(codTimer);
      codTimer = setTimeout(() => { computeLocalOutstandingRef.current?.(); computeCodCollectedTodayRef.current?.(); computeCatalogUncollectedRef.current?.(); loadDailyCodRef.current?.(); }, 8000);
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
            if (v.notTappedAt) value[k] = { notTapped: true, touchedAt: v.notTappedAt, by: v.by };
            else if (v.touchedAt) value[k] = { notTapped: !!v.notTapped, touchedAt: v.touchedAt, by: v.by };
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
    } catch (e) { console.error('AppSettings subscribe failed:', e); }
    try {
      unsubs.push(base44.entities.SquareLedgerEntry.subscribe(() => {
        invalidateLedgerWindows(); // windows cache is stale — force refetch inside loadSales
        clearTimeout(ledgerTimer);
        ledgerTimer = setTimeout(() => loadSalesRef.current?.(configRef.current), 5000);
      }));
    } catch (e) { console.error('Ledger subscribe failed:', e); }
    try {
      unsubs.push(base44.entities.SquareCatalogItems.subscribe(() => {
        clearTimeout(catalogTimer);
        catalogTimer = setTimeout(() => { computeCatalogUncollectedRef.current?.(); }, 5000);
      }));
    } catch (e) { console.error('Catalog subscribe failed:', e); }
    try {
      unsubs.push(base44.entities.Delivery.subscribe((event) => {
        scheduleCodRecompute();
        // OWNER RULE (Oct 6 2026): the moment a delivery is marked Collected
        // with a Debit or Credit payment, refresh the card balances with the
        // real settled values — a short-debounce Square sync (owner tab only).
        const ed = event?.data;
        if (
          ownerCanEditRef.current
          && String(ed?.status || '') === 'completed'
          && Array.isArray(ed?.cod_payments)
          && ed.cod_payments.some((pm) => ['debit', 'credit'].includes(String(pm?.type || '').toLowerCase()))
        ) {
          clearTimeout(cardCollectedTimer);
          cardCollectedTimer = setTimeout(() => { syncRef.current?.(); }, 20000);
        }
        // Full Square re-sync on sustained activity only (protects Square API rate limits)
        // — owner-only: a driver's open tab must never fire Square API syncs.
        clearTimeout(deliveryTimer);
        deliveryTimer = setTimeout(() => { if (ownerCanEditRef.current) syncRef.current?.(); }, 300000);
      }));
    } catch (e) { console.error('Delivery subscribe failed:', e); }
    // Same-device delivery edits (DeliveryForm/StopCard dispatch these) — WS echo
    // suppression blocks our own writes for 5 min, so also listen to the app events.
    const onDeliveriesUpdated = () => scheduleCodRecompute();
    const onRouteReordered = () => scheduleCodRecompute();
    window.addEventListener('deliveriesUpdated', onDeliveriesUpdated);
    window.addEventListener('routeReordered', onRouteReordered);
    return () => {
      clearTimeout(cfgTimer); clearTimeout(ledgerTimer); clearTimeout(deliveryTimer); clearTimeout(codTimer); clearTimeout(catalogTimer); clearTimeout(cardCollectedTimer);
      unsubs.forEach((u) => { try { u?.(); } catch {} });
      window.removeEventListener('deliveriesUpdated', onDeliveriesUpdated);
      window.removeEventListener('routeReordered', onRouteReordered);
    };
  }, []);

  // 7-day (excluding today) required-COD average per card (drives the green/yellow/red levels)
  const loadDailyCod = useCallback(async () => {
    try {
      const [stl, weekly] = await Promise.all([
        buildStoreToLocMap(),
        computeWeeklyCodTotalsByStore(),
      ]);
      setWeeklyCodAvgByLoc(weeklyAvgByLocFromStores(stl, weekly));
    } catch (e) {
      console.error('weekly COD average load failed:', e);
    }
  }, []);
  loadDailyCodRef.current = loadDailyCod;

  // Bank-sweep totals per location since true-up
  const payoutByLoc = useMemo(() => payoutsByLocation(payouts), [payouts]);

  // Per-location math from the sale records
  const perLocation = useMemo(() => {
    if (!config) return [];
    const folderRate = Number(config.folder_rate ?? DEFAULT_FOLDER_RATE);
    const storeCardFps = learnStoreCardFingerprints(sales);
    const payoutCentsByLoc = new Map();
    for (const pw of payouts || []) {
      if (!pw?.location_id) continue;
      if (!payoutCentsByLoc.has(pw.location_id)) payoutCentsByLoc.set(pw.location_id, []);
      payoutCentsByLoc.get(pw.location_id).push(Math.round(Number(pw.amount_cents || 0)));
    }
    return (config.locations || []).map((loc) => {
      const locSales = sales.filter((s) => s.location_id === loc.location_id);
      let gross = 0, fees = 0, loan = 0, folder = 0, credits = 0, storeCardSpend = 0;
      for (const s of locSales) {
        const amount = Number(s.amount_cents || 0) / 100;
        // Store-card spend (fingerprint-learned, owner plan Oct 3 2026): money
        // OUT on the store's own card — excluded from the credit math.
        if (s.card_fingerprint && storeCardFps.has(String(s.card_fingerprint))) { storeCardSpend += amount; continue; }
        const fee = Number(s.fee_cents || 0) / 100;
        const l = amount * Number(loc.loan_rate || 0);
        const f = amount * folderRate;
        gross += amount; fees += fee; loan += l; folder += f;
        credits += amount - fee - l - f;
      }
      const r2 = (x) => Math.round(x * 100) / 100;
      const codOut = localOutstanding?.[loc.location_id] || codOutstandingByLoc[loc.location_id] || null;
      // PAYOUT-MATCHED OUTSTANDING CODs (owner rule Oct 3 2026): the COD to
      // collect subtracts ONLY when payouts at this store equal it exactly
      // (single or combined subset) — matched payouts leave the sweep total
      // so the COD and its charge never double-count.
      const { matched, chargedCents, chargedCount, matchedItemIds } = matchPayoutChargedCods(
        (codOut?.items) || [],
        payoutCentsByLoc.get(loc.location_id) || []
      );
      // Owner rule (Oct 6-7 2026): a pre-True-Up COD stays neutral until the
      // owner explicitly clicks its badge since that True-Up; a brand-new
      // (post-True-Up) COD deducts by default. See computePendingCodDeduction.
      const { deductCents: pendingDeductCents, count: pendingDeductCount } = computePendingCodDeduction((codOut?.items) || [], manualSpendMarks || {}, matchedItemIds, config?.trued_up_at || null);
      const payoutCents = payoutCentsByLoc.get(loc.location_id) || [];
      const swept = payoutCents.length ? payoutCents.reduce((sum, c, i) => (matched.has(i) ? sum : sum + (Number(c) || 0)), 0) / 100 : (payoutByLoc.get(loc.location_id) || 0);
      return {
        ...loc,
        saleCount: locSales.length,
        gross: r2(gross), fees: r2(fees), loanPaid: r2(loan), folderContrib: r2(folder), netCredits: r2(credits),
        sweptOut: r2(swept),
        chargedToCard: r2(chargedCents / 100),
        chargedCount,
        storeCardSpend: r2(storeCardSpend),
        // UN-SWIPED CODs DO NOT REDUCE THE BALANCE (owner rule, Oct 2 2026,
        // Londonderry $528.17 report): a COD only counts as money removed from
        // the card once its real card spend exists in the Square records (the
        // spend lands as a card sale credit and confirms the delivery).
        // Outstanding CODs stay visible as "owed, not yet swiped" and drive
        // the low-balance forecast, but do NOT subtract from the estimate.
        // BATCH bank sweeps since true-up leave the real card too (Oct 2 2026 fix)
        cardEstimate: r2(Number(loc.card_start || 0) + credits - swept - chargedCents / 100 - pendingDeductCents / 100),
        loanRemaining: r2(Math.max(0, Number(loc.loan_start || 0) - loan)),
        weeklyCodAvg: r2(Number(weeklyCodAvgByLoc[loc.location_id] || 0)),
        level: getBalanceLevel(r2(Number(loc.card_start || 0) + credits - swept - chargedCents / 100 - pendingDeductCents / 100), Number(weeklyCodAvgByLoc[loc.location_id] || 0)),
        pendingDeducted: r2(pendingDeductCents / 100),
        pendingDeductCount,
        codOutstanding: codOut,
        lastSaleAt: locSales.length ? locSales.map((s) => s.occurred_at).sort().pop() : null,
      };
    });
  }, [config, sales, payoutByLoc, payouts, codOutstandingByLoc, localOutstanding, weeklyCodAvgByLoc, manualSpendMarks]);

  // SINGLE folder total — the 2% flows from every card's sales into ONE folder
  const folderTotal = useMemo(() => {
    if (!config) return 0;
    const folderRate = Number(config.folder_rate ?? DEFAULT_FOLDER_RATE);
    let total = Number(config.folder_start || 0);
    for (const s of sales) {
      total += (Number(s.amount_cents || 0) / 100) * folderRate;
    }
    return Math.round(total * 100) / 100;
  }, [config, sales]);

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
    (config?.locations || []).forEach((loc) => { draft[loc.location_id] = ''; });
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
    if (!Number.isFinite(amt) || amt <= 0) { toast.error('Enter a transfer amount greater than 0'); return; }
    if (!transferToLocId) { toast.error('Pick a destination card'); return; }
    if (transferToLocId === transferFromLoc.location_id) { toast.error('Destination must be a different card'); return; }
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
    if (!Number.isFinite(amt) || amt <= 0) { toast.error('Enter a transfer amount greater than 0'); return; }
    if (!folderTransferToLocId) { toast.error('Pick a destination card'); return; }
    if (amt > folderTotal + 0.001) { toast.error(`Amount exceeds the folder total (${fmtMoney(folderTotal)})`); return; }
    const locations = (config.locations || []).map((loc) =>
      loc.location_id === folderTransferToLocId
        ? { ...loc, card_start: Number(loc.card_start || 0) + amt }
        : loc
    );
    const newConfig = {
      ...config,
      folder_start: Number(config.folder_start || 0) - amt,
      locations,
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
        card_start: Number.isFinite(amt) && amt !== 0 ? Number(loc.card_start || 0) + amt : loc.card_start,
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
        loan_rate: Number.isFinite(rate) ? rate : loc.loan_rate,
      };
    });
    const folderVal = parseFloat(trueUpDraft.__folder);
    const newConfig = {
      ...config,
      locations,
      folder_start: Number.isFinite(folderVal) ? folderVal : Number(config.folder_start || 0),
      trued_up_at: new Date().toISOString(),
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
      </div>
    );
  }

  if (!config) {
    return (
      <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="text-sm font-medium mb-1">No balance config yet</div>
        <div className="text-xs text-slate-500">Ask the agent to seed the AppSettings 'square_balances' record (locations, starting balances, loan rates), then reload this tab.</div>
      </div>
    );
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
          {ownerCanEdit && (
          <Button size="sm" variant="outline" onClick={syncFromSquare} disabled={isSyncing || isLoading}>
            <RefreshCw className={`w-4 h-4 mr-1 ${isSyncing ? 'animate-spin' : ''}`} />
            {isSyncing ? 'Syncing…' : 'Refresh Square'}
          </Button>
          )}
          {ownerCanEdit && (
            <Button size="sm" variant="outline" onClick={startTopUp} disabled={isSaving || isLoading}>
              Top Up Cards
            </Button>
          )}
          {ownerCanEdit && (
            <Button size="sm" onClick={startTrueUp} disabled={isSaving}>
              True-Up Balances
            </Button>
          )}
        </div>
      </div>

      {/* Single combined Folder total — owner/admin view only (spans all cards) */}
      {!restricted && (
      <div className="rounded-xl border border-blue-200 dark:border-blue-800 bg-white dark:bg-slate-900 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300"><PiggyBank className="w-4 h-4 text-blue-600 dark:text-blue-400" /> Folder (all cards, 2% per sale)</div>
        <div className="flex items-center gap-2">
          <div className="text-xl font-bold tabular-nums text-blue-600 dark:text-blue-400">{fmtMoney(folderTotal)}</div>
          {ownerCanEdit && (
            <button
              type="button"
              title="Transfer from folder to a card"
              aria-label="Transfer from folder to a card"
              className="shrink-0 w-7 h-7 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-50 hover:border-slate-400 dark:hover:border-slate-500 flex items-center justify-center transition-colors"
              onClick={() => { setFolderTransferAmount(''); setFolderTransferToLocId(''); setFolderTransferOpen(true); }}
              disabled={isSaving || isLoading}
            >
              <ArrowLeftRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      )}

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
                  <div className="text-[11px] text-slate-400">{loc.saleCount} card sale{loc.saleCount === 1 ? '' : 's'} since true-up{loc.lastSaleAt ? ` · last ${new Date(loc.lastSaleAt).toLocaleTimeString()}` : ''}</div>
                </div>
                {ownerCanEdit && (
                  <button
                    type="button"
                    title="Funds transfer"
                    aria-label={`Funds transfer from ${loc.name || loc.location_id}`}
                    className="shrink-0 w-7 h-7 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-50 hover:border-slate-400 dark:hover:border-slate-500 flex items-center justify-center transition-colors"
                    onClick={(e) => { e.stopPropagation(); openTransfer(loc); }}
                    disabled={isSaving || isLoading}
                  >
                    <ArrowLeftRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
            <div className="px-4 py-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"><Wallet className="w-3.5 h-3.5" /> Card</div>
                <div className="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{fmtMoney(loc.cardEstimate)}</div>
              </div>
              {ownerCanEdit && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"><Landmark className="w-3.5 h-3.5" /> Loan left</div>
                <div className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-50">{fmtMoney(loc.loanRemaining)}</div>
              </div>
              )}
              {loc.weeklyCodAvg > 0 && (
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400"><Receipt className="w-3.5 h-3.5" /> CODs/day (7-day avg)</div>
                  <div className="font-semibold tabular-nums text-slate-900 dark:text-slate-50">{fmtMoney(loc.weeklyCodAvg)}</div>
                </div>
              )}
              {loc.sweptOut > 0 && (
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400"><Landmark className="w-3.5 h-3.5" /> Swept to bank</div>
                  <div className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">−{fmtMoney(loc.sweptOut)}</div>
                </div>
              )}
              {loc.pendingDeducted > 0 && (
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400"><Receipt className="w-3.5 h-3.5" /> Uncollected CODs (not "Not Tapped"{loc.pendingDeductCount ? `, ${loc.pendingDeductCount}` : ''})</div>
                  <div className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">−{fmtMoney(loc.pendingDeducted)}</div>
                </div>
              )}
              {loc.chargedToCard > 0 && (
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400"><CreditCard className="w-3.5 h-3.5" /> Charged CODs (payout-matched{loc.chargedCount ? `, ${loc.chargedCount}` : ''})</div>
                  <div className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">−{fmtMoney(loc.chargedToCard)}</div>
                </div>
              )}
              {loc.storeCardSpend > 0 && (
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400"><CreditCard className="w-3.5 h-3.5" /> Store-card spends (excluded)</div>
                  <div className="font-semibold tabular-nums text-slate-400">{fmtMoney(loc.storeCardSpend)}</div>
                </div>
              )}
              {ownerCanEdit && (
              <div className="pt-2 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-400 tabular-nums">
                +{fmtMoney(loc.netCredits)} net credits · {fmtMoney(loc.gross)} gross − {fmtMoney(loc.fees)} fees − {fmtMoney(loc.loanPaid)} loan ({(Number(loc.loan_rate) * 100).toFixed(2)}%) − {fmtMoney(loc.folderContrib)} folder (2%)
              </div>
              )}
              {(() => {
                // Collected/Uncollected/Past uncollected list — owner request
                // Oct 4 2026: drivers see this full section too (same as the
                // App Owner), just without the Loan left row and the net
                // credits/gross/fees/loan/folder breakdown line above, which
                // stay ownerCanEdit-gated.
                const todayStr = edmontonWallString(new Date()).slice(0, 10);
                // Uncollected rows come from the SquareCatalogItems database:
                // ACTIVE catalog items = still sitting in the register, ALL
                // dates included (the old true-up-window delivery query missed
                // anything past the window, e.g. week-old CODs).
                // Fallback to the delivery-derived items only while the
                // catalog list hasn't loaded yet.
                const catItems = catalogUncollectedByLoc?.[loc.location_id];
                const outItems = (localOutstanding?.[loc.location_id] || codOutstandingByLoc[loc.location_id] || {}).items || [];
                // Pending-status ("impending pickup" — not yet picked up by a
                // driver) deliveries never get a Square catalog item at all;
                // the reconciler removes a delivery's item until the stop
                // goes active (en_route/in_transit). Keep them OUT of the
                // catalog-sourced list and handle them separately below so
                // they can be tagged pendingPickup regardless of date.
                const uncollectedSrc = catItems || outItems.filter((it) => it.status !== 'pending').map((it) => ({
                  key: `o-${it.delivery_id}`,
                  delivery_id: it.delivery_id,
                  patientName: it.patient || null,
                  storeAbbrev: it.storeAbbrev || null,
                  storeColor: it.storeColor || null,
                  amount: it.amount,
                  date: it.date || null,
                }));
                const srcDeliveryIds = new Set(
                  uncollectedSrc.map((it) => it.delivery_id).filter(Boolean)
                );
                // Pending-status deliveries with a COD to collect still need
                // to show up in Uncollected/Past uncollected — just labeled
                // "Card Spend" instead of "Pending" since the driver hasn't
                // picked the order up yet (owner request, Oct 2 2026).
                // Covers EVERY date (today, future, past), not just future —
                // these were previously invisible entirely for today's date
                // because catalog items don't exist for them yet.
                const pendingPickupItems = outItems
                  .filter((it) => it.status === 'pending' && !srcDeliveryIds.has(it.delivery_id))
                  .map((it) => ({
                    key: `pp-${it.delivery_id}`,
                    delivery_id: it.delivery_id,
                    patientName: it.patient || null,
                    storeAbbrev: it.storeAbbrev || null,
                    storeColor: it.storeColor || null,
                    amount: it.amount,
                    date: it.date || null,
                    pendingPickup: true,
                    notTapped: notTapped(it.delivery_id),
                  }));
                const notTapped = (id) => !!id && !!manualSpendMarksRef.current?.[String(id)]?.notTapped;
                const combinedSrc = [...uncollectedSrc, ...pendingPickupItems];
                const swiped = (id) => !!id && cardSpendIds.has(String(id));
                const manualMark = (id) => !!id && !!manualSpendMarksRef.current?.[String(id)];
                // Owner spec (Oct 6 2026): cash-collected CODs STAY in
                // Uncollected / Past uncollected — they are technically
                // uncollected until processed back to the Square card. They
                // render with a 'Cash' status badge (CardCodList) and keep
                // their Card Spend pills.
                const uncollectedTodayRows = combinedSrc.filter((it) => (!it.date || it.date >= todayStr)).map((it) => ({
                  key: it.key || `o-${it.delivery_id}`,
                  delivery_id: it.delivery_id || null,
                  patientName: it.patientName || it.patient || null,
                  storeAbbrev: it.storeAbbrev || null,
                  storeColor: it.storeColor || null,
                  amount: it.amount,
                  sub: `${it.date || todayStr}${it.sub ? ` · ${it.sub}` : ''}`,
                  collected: false,
                  pendingPickup: !!it.pendingPickup,
                  hasCardSpend: swiped(it.delivery_id),
                  manualCardSpend: manualMark(it.delivery_id),
                  notTapped: notTapped(it.delivery_id),
                  cashAwaitingSquare: !!it.cashAwaitingSquare,
                }));
                // Future-dated en_route/in_transit CODs never have a Square
                // catalog item either (same reconciler behavior) — merge them
                // in from the delivery-derived outstanding list (owner
                // request, Oct 1 2026: "Uncollected" must also list pending
                // CODs from future dates). Pending-status future items are
                // already covered by pendingPickupItems above, so exclude
                // anything already placed via combinedSrc.
                const allKnownIds = new Set(combinedSrc.map((it) => it.delivery_id).filter(Boolean));
                const futurePendingRows = outItems
                  .filter((it) => it.date && it.date > todayStr)
                  .filter((it) => !allKnownIds.has(it.delivery_id))
                  .map((it) => ({
                    key: `f-${it.delivery_id}`,
                    delivery_id: it.delivery_id || null,
                    patientName: it.patient || null,
                    storeAbbrev: it.storeAbbrev || null,
                    storeColor: it.storeColor || null,
                    amount: it.amount,
                    sub: `${it.date} · upcoming`,
                    collected: false,
                    pendingPickup: false,
                    hasCardSpend: swiped(it.delivery_id),
                    manualCardSpend: manualMark(it.delivery_id),
                    notTapped: notTapped(it.delivery_id),
                  }));
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
                  hasCardSpend: swiped(it.delivery_id),
                  manualCardSpend: manualMark(it.delivery_id),
                  notTapped: notTapped(it.delivery_id),
                  cashAwaitingSquare: !!it.cashAwaitingSquare,
                }));
                const collectedTodayRows = codCollectedTodayByLoc[loc.location_id] || [];
                const sumOf = (rows) => rows.reduce((s, r) => s + Number(r.amount || 0), 0);
                return (
                  <CardCodList
                    canMarkSpend={ownerCanEdit}
                    onMarkSpend={markCardSpend}
                    sections={[
                      { label: 'Collected today', color: '#059669', rows: collectedTodayRows, total: sumOf(collectedTodayRows) },
                      { label: 'Uncollected', color: '#d97706', rows: [...futurePendingRows, ...uncollectedTodayRows], total: sumOf(uncollectedTodayRows) + sumOf(futurePendingRows) },
                      { label: 'Past uncollected', color: '#64748b', rows: pastUncollectedRows, total: sumOf(pastUncollectedRows) },
                    ]}
                  />
                );
              })()}
            </div>
          </div>
          );
        })}
      </div>

      {/* Card transfers (owner request, Oct 3 2026): fund moves ONTO the
          Square Cards, pulled from the card (MOBILE) locations the per-store
          sync never saw before. Attributed = fed by that store's sale
          (SQUARE_STORED_BALANCE payout wrapping the sale's charge);
          unattributed = folder / manual transfer with no sale link yet. */}
      {topups.length > 0 && (
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
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="text-[11px] text-slate-400">
        Card = start + sales − fees − 2% folder − loan%. Loan and folder are computed from owner-supplied rates (not in Square's API). Off-card spending isn't tracked — use True-Up whenever the real Square numbers are checked.
      </div>

      {/* True-up overlay: enter the CURRENT real numbers from each Square dashboard */}
      {showTrueUp && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !isSaving && setShowTrueUp(false)}>
          <div ref={trueUpPanelRef} className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">True-Up: enter the CURRENT real numbers from each Square dashboard</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Blank fields keep the existing value. This resets the tracking window to now.</div>
            </div>
            {(config.locations || []).map((loc) => (
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
            ))}
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
      )}

      {/* Top-Up overlay: add money to each card's balance (does not reset the window) */}
      {showTopUp && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => !isSaving && setShowTopUp(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">Top Up Cards</div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Enter the amount to ADD to each card's current balance. Blank fields are skipped. This does not reset the tracking window.</div>
            </div>
            {(config?.locations || []).map((loc) => (
              <label key={loc.location_id} className="block space-y-1">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{loc.name || loc.location_id}</span>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder={`current ~${fmtMoney(perLocation.find((l) => l.location_id === loc.location_id)?.cardEstimate || 0)}`}
                  value={topUpDraft[loc.location_id] ?? ''}
                  disabled={isSaving}
                  onChange={(e) => setTopUpDraft((d) => ({ ...d, [loc.location_id]: e.target.value }))}
                />
              </label>
            ))}
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="outline" onClick={() => setShowTopUp(false)} disabled={isSaving}>Cancel</Button>
              <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={saveTopUp} disabled={isSaving}>
                {isSaving ? 'Adding…' : 'Add to Cards'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Folder Transfer overlay: move money from the shared folder onto a
          card (does not reset the window). One-way only — never card → folder. */}
      {folderTransferOpen && (
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
                onChange={(e) => setFolderTransferAmount(e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">To card</span>
              <select
                className="w-full h-9 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 text-sm text-slate-900 dark:text-slate-50"
                value={folderTransferToLocId}
                disabled={isSaving}
                onChange={(e) => setFolderTransferToLocId(e.target.value)}
              >
                <option value="">Select destination card…</option>
                {(config?.locations || []).map((loc) => (
                  <option key={loc.location_id} value={loc.location_id}>{loc.name || loc.location_id}</option>
                ))}
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
      )}

      {/* Funds Transfer overlay: move money from one card to another (does not reset the window) */}
      {transferFromLoc && (
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
                onChange={(e) => setTransferAmount(e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">To card</span>
              <select
                className="w-full h-9 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 text-sm text-slate-900 dark:text-slate-50"
                value={transferToLocId}
                disabled={isSaving}
                onChange={(e) => setTransferToLocId(e.target.value)}
              >
                <option value="">Select destination card…</option>
                {(config?.locations || []).filter((loc) => loc.location_id !== transferFromLoc.location_id).map((loc) => (
                  <option key={loc.location_id} value={loc.location_id}>{loc.name || loc.location_id}</option>
                ))}
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
      )}
    </div>
  );
}
