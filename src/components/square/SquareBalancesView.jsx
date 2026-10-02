import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshCw, Wallet, Landmark, PiggyBank, Receipt, ArrowLeftRight } from "lucide-react";
import { toast } from "sonner";
import { isAppOwner } from "@/components/utils/userRoles";
import { edmontonWallString } from "@/components/utils/albertaTime";
import { buildStoreToLocMap, computeWeeklyCodTotalsByStore, weeklyAvgByLocFromStores, getBalanceLevel, BALANCE_LEVELS, computeCodOutstandingDetailed, loadCardPayouts, payoutsByLocation } from "./useSquareBalancesSummary";
import { getSummarySnapshot, deserializeSummary } from "./squareBalancesOfflineManager";

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
 *   - SquareLedgerEntry: entry_kind 'sale', tender_type 'CARD', status COMPLETED, occurred_at >= trued_up_at
 *     (kept fresh by squareLedgerSync; the Refresh button invokes it for the window since true-up).
 *
 * The loan repayment and folder contribution are NOT exposed by Square's API — they are
 * computed here from owner-supplied rates. Numbers drift with any off-card spending; the
 * true-up form resets the starting points from real Square dashboard numbers.
 */

const SETTING_KEY = 'square_balances';
const DEFAULT_FOLDER_RATE = 0.02;

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

// Delivery only stores patient_id (no patient_name field) — resolve the real
// name from the Patient entity, same dual-key lookup used across the app
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
function CardCodList({ sections }) {
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
          {sec.rows.map((r) => (
            <div key={r.key} className="flex items-center gap-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-2.5 py-1.5">
              <div className="min-w-0 flex-1">
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
                <p className="text-[11px] mt-0.5 text-slate-500 dark:text-slate-400 truncate">{r.sub}</p>
              </div>
              <div className="shrink-0 text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{fmtMoney(r.amount)}</div>
              {r.collected
                ? <span className="shrink-0 rounded-full bg-emerald-100 dark:bg-emerald-900/30 border border-emerald-300 dark:border-emerald-700 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">Collected</span>
                : r.pendingPickup
                  ? <span className="shrink-0 rounded-full bg-sky-100 dark:bg-sky-900/30 border border-sky-300 dark:border-sky-700 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300">Card Spend</span>
                  : <span className="shrink-0 rounded-full bg-amber-100 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">Pending</span>}
            </div>
          ))}
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
  const [codOutstandingByLoc, setCodOutstandingByLoc] = useState({});
  const [localOutstanding, setLocalOutstanding] = useState(null); // client-side compute — freshest source
  const [codCollectedTodayByLoc, setCodCollectedTodayByLoc] = useState({}); // owner-only: today's collected CODs per card
  const [catalogUncollectedByLoc, setCatalogUncollectedByLoc] = useState(undefined); // owner-only: ACTIVE SquareCatalogItems = uncollected, all dates
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
    const rows = await base44.entities.AppSettings.filter({ setting_key: SETTING_KEY }).catch(() => []);
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

  const loadSales = useCallback(async (cfg) => {
    if (!cfg?.trued_up_at) { setSales([]); setPayouts([]); return; }
    const seq = ++loadSeq.current;
    const out = [];
    let skip = 0;
    // Paginate completed CARD sales since the true-up timestamp
    for (let page = 0; page < 40; page++) {
      const rows = await base44.entities.SquareLedgerEntry.filter(
        { entry_kind: 'sale', tender_type: 'CARD', status: 'COMPLETED', occurred_at: { $gte: cfg.trued_up_at } },
        undefined, 500, skip
      ).catch(() => []);
      const list = rows || [];
      out.push(...list);
      if (list.length < 500) break;
      skip += 500;
    }
    // Bank sweeps (BATCH payouts) since true-up — they leave the real card, so
    // the estimate must subtract them (Oct 2 2026 owner mismatch fix).
    const payoutRows = await loadCardPayouts(cfg).catch(() => []);
    if (seq === loadSeq.current) { setSales(out); setPayouts(payoutRows); }
  }, []);

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
      const out = await computeCodOutstandingDetailed(cfgArg || configRef.current);
      setLocalOutstanding(out);
    } catch (e) {
      console.error('local COD outstanding failed:', e);
    }
  }, []);

  // Owner-only: UNCOLLECTED CODs taken from the SquareCatalogItems database.
  // An ACTIVE catalog item = the COD is still sitting in the Square register,
  // regardless of delivery date — this catches old ones (e.g. 100 days back)
  // that the true-up-window delivery queries exclude. Statuses 'completed' and
  // 'deleted' mean the item was rung/removed = collected, so they're skipped.
  const computeCatalogUncollected = useCallback(async () => {
    if (!ownerCanEditRef.current) return;
    try {
      const itemsPages = [];
      for (let skip = 0; skip < 20000; skip += 500) {
        const rows = await base44.entities.SquareCatalogItems.filter({ status: 'active' }, undefined, 500, skip).catch(() => []);
        const list = rows || [];
        itemsPages.push(...list);
        if (list.length < 500) break;
      }
      const [storesRaw, patientsRaw] = await Promise.all([
        base44.entities.Store.list().catch(() => []),
        base44.entities.Patient.list().catch(() => []),
      ]);
      const itemsRaw = itemsPages;
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
        });
      }
      const out = {};
      for (const [locId, rows] of byLoc) out[locId] = rows;
      setCatalogUncollectedByLoc(out);
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
    if (!ownerCanEditRef.current) return;
    try {
      const [storesRaw, cfgsRaw, codSalesRaw, patientsRaw] = await Promise.all([
        base44.entities.Store.list().catch(() => []),
        base44.entities.SquareLocationConfig.list().catch(() => []),
        base44.entities.SquareLedgerEntry.filter({ sale_class: 'cod_collection' }).catch(() => []),
        base44.entities.Patient.list().catch(() => []),
      ]);
      const resolvePatientName = buildPatientResolver(patientsRaw);
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
      for (let page = 0; page < 4; page++) {
        const rows = await base44.entities.Delivery.list('-created_date', 2000, page * 2000).catch(() => []);
        const list = rows || [];
        deliveryList.push(...list);
        list.forEach((d) => { if (d?.id) deliveryById.set(String(d.id), d); });
        if (list.length < 2000) break;
        if (list.length && new Date(list[list.length - 1]?.created_date || 0).getTime() < Date.now() - 3 * 86400000) break;
      }

      // a) Square-confirmed cash collections that happened TODAY
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
        aggFor(locId).push({
          key: `tx-${e.id || e.square_id}`,
          patientName: txPatientName,
          storeAbbrev: sInfo?.abbreviation || null,
          storeColor: sInfo?.color || null,
          amount: Math.abs(Number(e.amount_cents || 0)) / 100,
          sub: `Square cash · ${when.slice(11, 16)}`,
          collected: true,
        });
      }

      // b) non-cash payments collected today (no Square tx)
      {
        const list = deliveryList;
        for (const d of list) {
          if (d?.status !== 'completed' || Number(d?.cod_total_amount_required || 0) <= 0) continue;
          const doneAt = String(d.actual_delivery_time || '');
          if (doneAt.slice(0, 10) !== today) continue;
          const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
          const nonCash = payments.filter((p) => String(p?.type || '').toLowerCase() !== 'cash').reduce((s, p) => s + centsOf(p?.amount), 0);
          if (nonCash <= 0) continue;
          if (squareTodayIds.has(String(d.id))) continue; // already reported via Square
          const locId = storeToLoc.get(String(d?.store_id || ''));
          if (!locId) continue;
          const sInfo = storeById.get(String(d?.store_id || ''));
          const type = (payments.find((p) => String(p?.type || '').toLowerCase() !== 'cash') || {}).type || 'card';
          aggFor(locId).push({
            key: `d-${d.id}`,
            patientName: resolvePatientName(d.patient_id)?.full_name || null,
            storeAbbrev: sInfo?.abbreviation || null,
            storeColor: sInfo?.color || null,
            amount: nonCash / 100,
            sub: `${type} · ${doneAt.slice(11, 16)}`,
            collected: true,
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
  useEffect(() => {
    const unsubs = [];
    let cfgTimer = null, ledgerTimer = null, deliveryTimer = null, codTimer = null, catalogTimer = null;
    // Fast path: COD add/remove on any delivery → recompute outstanding locally (8s debounce).
    const scheduleCodRecompute = () => {
      clearTimeout(codTimer);
      codTimer = setTimeout(() => { computeLocalOutstandingRef.current?.(); computeCodCollectedTodayRef.current?.(); computeCatalogUncollectedRef.current?.(); loadDailyCodRef.current?.(); }, 8000);
    };
    try {
      unsubs.push(base44.entities.AppSettings.subscribe((event) => {
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
      unsubs.push(base44.entities.Delivery.subscribe(() => {
        scheduleCodRecompute();
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
      clearTimeout(cfgTimer); clearTimeout(ledgerTimer); clearTimeout(deliveryTimer); clearTimeout(codTimer); clearTimeout(catalogTimer);
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
    return (config.locations || []).map((loc) => {
      const locSales = sales.filter((s) => s.location_id === loc.location_id);
      let gross = 0, fees = 0, loan = 0, folder = 0, credits = 0;
      for (const s of locSales) {
        const amount = Number(s.amount_cents || 0) / 100;
        const fee = Number(s.fee_cents || 0) / 100;
        const l = amount * Number(loc.loan_rate || 0);
        const f = amount * folderRate;
        gross += amount; fees += fee; loan += l; folder += f;
        credits += amount - fee - l - f;
      }
      const r2 = (x) => Math.round(x * 100) / 100;
      const codOut = localOutstanding?.[loc.location_id] || codOutstandingByLoc[loc.location_id] || null;
      const codOutTotal = Number(codOut?.total || 0);
      const swept = payoutByLoc.get(loc.location_id) || 0;
      return {
        ...loc,
        saleCount: locSales.length,
        gross: r2(gross), fees: r2(fees), loanPaid: r2(loan), folderContrib: r2(folder), netCredits: r2(credits),
        sweptOut: r2(swept),
        // CODs out (pending/in-transit + cash awaiting Square) reduce the available card balance;
        // BATCH bank sweeps since true-up leave the real card too (Oct 2 2026 fix)
        cardEstimate: r2(Number(loc.card_start || 0) + credits - codOutTotal - swept),
        loanRemaining: r2(Math.max(0, Number(loc.loan_start || 0) - loan)),
        weeklyCodAvg: r2(Number(weeklyCodAvgByLoc[loc.location_id] || 0)),
        level: getBalanceLevel(r2(Number(loc.card_start || 0) + credits - codOutTotal), Number(weeklyCodAvgByLoc[loc.location_id] || 0)),
        codOutstanding: codOut,
        lastSaleAt: locSales.length ? locSales.map((s) => s.occurred_at).sort().pop() : null,
      };
    });
  }, [config, sales, payoutByLoc, codOutstandingByLoc, localOutstanding, weeklyCodAvgByLoc]);

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
        <div className="text-xl font-bold tabular-nums text-blue-600 dark:text-blue-400">{fmtMoney(folderTotal)}</div>
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
              {loc.codOutstanding?.total > 0 && (
                <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400"><Receipt className="w-3.5 h-3.5" /> CODs out</div>
                    <div className="font-semibold tabular-nums text-amber-600 dark:text-amber-400">−{fmtMoney(loc.codOutstanding.total)}</div>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {loc.codOutstanding.pending_count > 0 && `${loc.codOutstanding.pending_count} on route`}
                    {loc.codOutstanding.pending_count > 0 && loc.codOutstanding.awaiting_square_count > 0 && ' · '}
                    {loc.codOutstanding.awaiting_square_count > 0 && `${loc.codOutstanding.awaiting_square_count} cash awaiting Square`}
                  </div>
                  {loc.codOutstanding.items?.length > 0 && (
                    <details className="mt-1">
                      <summary className="text-[11px] text-slate-400 cursor-pointer hover:text-slate-500">view breakdown</summary>
                      <div className="mt-1 space-y-0.5 text-[11px] text-slate-400 tabular-nums">
                        {loc.codOutstanding.items.map((it) => (
                          <div key={it.delivery_id} className="flex justify-between gap-2">
                            <span className="truncate">{it.reason === 'cash_awaiting_square' ? 'cash awaiting Square' : it.status}{it.patient ? ` · ${it.patient}` : ''}</span>
                            <span>{fmtMoney(it.amount)}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}
              {ownerCanEdit && (
              <div className="pt-2 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-400 tabular-nums">
                +{fmtMoney(loc.netCredits)} net credits · {fmtMoney(loc.gross)} gross − {fmtMoney(loc.fees)} fees − {fmtMoney(loc.loanPaid)} loan ({(Number(loc.loan_rate) * 100).toFixed(2)}%) − {fmtMoney(loc.folderContrib)} folder (2%)
              </div>
              )}
              {ownerCanEdit && (() => {
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
                  }));
                const combinedSrc = [...uncollectedSrc, ...pendingPickupItems];
                const uncollectedTodayRows = combinedSrc.filter((it) => !it.date || it.date >= todayStr).map((it) => ({
                  key: it.key || `o-${it.delivery_id}`,
                  patientName: it.patientName || it.patient || null,
                  storeAbbrev: it.storeAbbrev || null,
                  storeColor: it.storeColor || null,
                  amount: it.amount,
                  sub: `${it.date || todayStr}${it.sub ? ` · ${it.sub}` : ''}`,
                  collected: false,
                  pendingPickup: !!it.pendingPickup,
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
                    patientName: it.patient || null,
                    storeAbbrev: it.storeAbbrev || null,
                    storeColor: it.storeColor || null,
                    amount: it.amount,
                    sub: `${it.date} · upcoming`,
                    collected: false,
                    pendingPickup: it.status === 'pending',
                  }));
                const pastUncollectedRows = combinedSrc.filter((it) => it.date && it.date < todayStr).map((it) => ({
                  key: it.key || `p-${it.delivery_id}`,
                  patientName: it.patientName || it.patient || null,
                  storeAbbrev: it.storeAbbrev || null,
                  storeColor: it.storeColor || null,
                  amount: it.amount,
                  sub: it.sub || it.date,
                  collected: false,
                  pendingPickup: !!it.pendingPickup,
                }));
                const collectedTodayRows = codCollectedTodayByLoc[loc.location_id] || [];
                const sumOf = (rows) => rows.reduce((s, r) => s + Number(r.amount || 0), 0);
                return (
                  <CardCodList
                    sections={[
                      { label: 'Collected today', color: '#059669', rows: collectedTodayRows, total: sumOf(collectedTodayRows) },
                      { label: 'Uncollected', color: '#d97706', rows: [...uncollectedTodayRows, ...futurePendingRows], total: sumOf(uncollectedTodayRows) + sumOf(futurePendingRows) },
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
