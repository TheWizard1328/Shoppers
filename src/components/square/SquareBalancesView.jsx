import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshCw, Wallet, Landmark, PiggyBank, Receipt } from "lucide-react";
import { toast } from "sonner";
import { isAppOwner } from "@/components/utils/userRoles";
import { edmontonWallString } from "@/components/utils/albertaTime";
import { buildStoreToLocMap, computeWeeklyCodTotalsByStore, weeklyAvgByLocFromStores, getBalanceLevel, BALANCE_LEVELS } from "./useSquareBalancesSummary";

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

// Owner-only COD list at the bottom of each card. Rows use the SAME format as
// the Square catalog items list (name + subtext, bold amount, Collected/Pending
// pill). Three levels, top to bottom: collected today, uncollected today, past
// uncollected.
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
            <div key={r.key} className="flex items-center gap-2 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 px-2.5 py-1.5">
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
  const [codOutstandingByLoc, setCodOutstandingByLoc] = useState({});
  const [localOutstanding, setLocalOutstanding] = useState(null); // client-side compute — freshest source
  const [codCollectedTodayByLoc, setCodCollectedTodayByLoc] = useState({}); // owner-only: today's collected CODs per card
  const [weeklyCodAvgByLoc, setWeeklyCodAvgByLoc] = useState({}); // 7-day avg daily CODs per card (excl. today)
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [showTrueUp, setShowTrueUp] = useState(false);
  const [trueUpDraft, setTrueUpDraft] = useState({});
  const [showTopUp, setShowTopUp] = useState(false);
  const [topUpDraft, setTopUpDraft] = useState({});
  const trueUpPanelRef = useRef(null);
  const [isSaving, setIsSaving] = useState(false);
  const loadSeq = useRef(0);
  // Latest-handler refs for the WebSocket subscriptions (mounted once)
  const loadSalesRef = useRef(null);
  const syncRef = useRef(null);
  const configRef = useRef(null);
  const computeLocalOutstandingRef = useRef(null);
  const ownerCanEditRef = useRef(false);
  const loadDailyCodRef = useRef(null);
  const computeCodCollectedTodayRef = useRef(null);

  const ownerCanEdit = !!(currentUser && isAppOwner(currentUser));
  // null = show every card (admins/owner); array = only these cards (drivers see the
  // cards assigned to their stores for the current date).
  const restricted = Array.isArray(visibleLocationIds);

  const loadConfig = useCallback(async () => {
    const rows = await base44.entities.AppSettings.filter({ setting_key: SETTING_KEY }).catch(() => []);
    const rec = (rows || [])[0];
    if (rec?.setting_value?.locations?.length) {
      setConfig(rec.setting_value);
      setConfigRecordId(rec.id);
      return rec.setting_value;
    }
    setConfig(null);
    setConfigRecordId(rec?.id || null);
    return null;
  }, []);

  const loadSales = useCallback(async (cfg) => {
    if (!cfg?.trued_up_at) { setSales([]); return; }
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
    if (seq === loadSeq.current) setSales(out);
  }, []);

  // Client-side COD outstanding — same rules as the backend pass, computed fresh
  // from the entities so COD add/remove on any delivery shows up in seconds
  // (no Square API round-trip needed). Local result wins over the sync response.
  const computeLocalOutstanding = useCallback(async (cfgArg) => {
    try {
      const [storesRaw, cfgsRaw, codSalesRaw] = await Promise.all([
        base44.entities.Store.list().catch(() => []),
        base44.entities.SquareLocationConfig.list().catch(() => []),
        base44.entities.SquareLedgerEntry.filter({ sale_class: 'cod_collection' }).catch(() => []),
      ]);
      const cfgLoc = new Map();
      (cfgsRaw || []).forEach((c) => { if (c?.id && c?.square_location_id) cfgLoc.set(c.id, c.square_location_id); });
      const storeToLoc = new Map();
      const storeById = new Map();
      (storesRaw || []).forEach((s) => {
        const loc = s?.square_location_config_id ? cfgLoc.get(s.square_location_config_id) : null;
        if (s?.id && loc) storeToLoc.set(String(s.id), loc);
        if (s?.id) storeById.set(String(s.id), s);
      });
      // Cash rung at a register = ledger cod_collection sale linked to the delivery
      const confirmed = new Set(
        (codSalesRaw || []).filter((e) => e?.delivery_id && String(e?.status || '').toUpperCase() === 'COMPLETED').map((e) => String(e.delivery_id))
      );
      // Owner rule: CODs outstanding at true-up are already in the starting
      // balances — only deliveries dated on/after the true-up day count.
      const cfg = cfgArg || configRef.current;
      const tu = cfg?.trued_up_at ? new Date(cfg.trued_up_at) : null;
      const cutoffDate = (tu ? new Date(tu.getTime() - 6 * 3600000) : new Date(Date.now() - 6 * 3600000)).toISOString().slice(0, 10);
      const createdFloor = new Date(new Date(cutoffDate + 'T00:00:00Z').getTime() - 3 * 86400000).getTime();
      const isCounted = (d) => String(d?.delivery_date || '') >= cutoffDate;
      const centsOf = (n) => Math.round(Number(n || 0) * 100);
      const byLoc = new Map();
      const aggFor = (locId) => {
        if (!byLoc.has(locId)) byLoc.set(locId, { total: 0, pendingCount: 0, awaitingCount: 0, items: [] });
        return byLoc.get(locId);
      };

      // a) pending / in-transit CODs (minus debit/credit/cheque already collected)
      for (const status of ['pending', 'in_transit', 'en_route']) {
        const rows = await base44.entities.Delivery.filter({ status }).catch(() => []);
        for (const d of rows || []) {
          const required = Number(d?.cod_total_amount_required || 0);
          if (required <= 0 || !isCounted(d) || d?.cod_confirmed_collected) continue;
          const locId = storeToLoc.get(String(d?.store_id || ''));
          if (!locId) continue;
          const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
          const nonCash = payments.filter((p) => String(p?.type || '').toLowerCase() !== 'cash').reduce((s, p) => s + centsOf(p?.amount), 0);
          const outstanding = Math.max(0, centsOf(required) - nonCash);
          if (outstanding <= 0) continue;
          const agg = aggFor(locId);
          agg.total += outstanding; agg.pendingCount += 1;
          const sInfoA = storeById.get(String(d.store_id || ''));
          agg.items.push({ delivery_id: d.id, status, patient: d.patient_name || null, driverName: d.driver_name || null, storeAbbrev: sInfoA?.abbreviation || null, storeColor: sInfoA?.color || null, amount: outstanding / 100, reason: 'pending_or_in_transit', date: String(d.delivery_date || '').slice(0, 10) });
        }
      }

      // b) completed cash CODs still awaiting Square registration (last 45 days)
      for (let page = 0; page < 4; page++) {
        const rows = await base44.entities.Delivery.list('-created_date', 2000, page * 2000).catch(() => []);
        const list = rows || [];
        for (const d of list) {
          if (d?.status !== 'completed' || d?.cod_confirmed_collected || !isCounted(d)) continue;
          const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
          const cash = payments.filter((p) => String(p?.type || '').toLowerCase() === 'cash').reduce((s, p) => s + centsOf(p?.amount), 0);
          if (cash <= 0 || confirmed.has(String(d.id))) continue;
          const locId = storeToLoc.get(String(d?.store_id || ''));
          if (!locId) continue;
          const agg = aggFor(locId);
          agg.total += cash; agg.awaitingCount += 1;
          const sInfoB = storeById.get(String(d.store_id || ''));
          agg.items.push({ delivery_id: d.id, status: 'completed', patient: d.patient_name || null, driverName: d.driver_name || null, storeAbbrev: sInfoB?.abbreviation || null, storeColor: sInfoB?.color || null, amount: cash / 100, reason: 'cash_awaiting_square', date: String(d.delivery_date || '').slice(0, 10) });
        }
        if (list.length < 2000) break;
        if (list.length && new Date(list[list.length - 1]?.created_date || 0).getTime() < createdFloor) break;
      }

      const out = {};
      for (const [locId, agg] of byLoc) {
        out[locId] = { location_id: locId, total: agg.total / 100, pending_count: agg.pendingCount, awaiting_square_count: agg.awaitingCount, items: agg.items.slice(0, 50) };
      }
      setLocalOutstanding(out);
    } catch (e) {
      console.error('local COD outstanding failed:', e);
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
      const [storesRaw, cfgsRaw, codSalesRaw] = await Promise.all([
        base44.entities.Store.list().catch(() => []),
        base44.entities.SquareLocationConfig.list().catch(() => []),
        base44.entities.SquareLedgerEntry.filter({ sale_class: 'cod_collection' }).catch(() => []),
      ]);
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
        aggFor(locId).push({
          key: `tx-${e.id || e.square_id}`,
          patientName: linkedDelivery?.patient_name || null,
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
            patientName: d.patient_name || null,
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
    let cfgTimer = null, ledgerTimer = null, deliveryTimer = null, codTimer = null;
    // Fast path: COD add/remove on any delivery → recompute outstanding locally (8s debounce).
    const scheduleCodRecompute = () => {
      clearTimeout(codTimer);
      codTimer = setTimeout(() => { computeLocalOutstandingRef.current?.(); computeCodCollectedTodayRef.current?.(); loadDailyCodRef.current?.(); }, 8000);
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
      clearTimeout(cfgTimer); clearTimeout(ledgerTimer); clearTimeout(deliveryTimer); clearTimeout(codTimer);
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
      return {
        ...loc,
        saleCount: locSales.length,
        gross: r2(gross), fees: r2(fees), loanPaid: r2(loan), folderContrib: r2(folder), netCredits: r2(credits),
        // CODs out (pending/in-transit + cash awaiting Square) reduce the available card balance
        cardEstimate: r2(Number(loc.card_start || 0) + credits - codOutTotal),
        loanRemaining: r2(Math.max(0, Number(loc.loan_start || 0) - loan)),
        weeklyCodAvg: r2(Number(weeklyCodAvgByLoc[loc.location_id] || 0)),
        level: getBalanceLevel(r2(Number(loc.card_start || 0) + credits - codOutTotal), Number(weeklyCodAvgByLoc[loc.location_id] || 0)),
        codOutstanding: codOut,
        lastSaleAt: locSales.length ? locSales.map((s) => s.occurred_at).sort().pop() : null,
      };
    });
  }, [config, sales, codOutstandingByLoc, localOutstanding, weeklyCodAvgByLoc]);

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
    // The panel renders at the bottom of this tall page — scroll it into view
    // so the button doesn't look dead after opening.
    setTimeout(() => trueUpPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  };

  const startTopUp = () => {
    const draft = {};
    (config?.locations || []).forEach((loc) => { draft[loc.location_id] = ''; });
    setTopUpDraft(draft);
    setShowTopUp(true);
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
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">{loc.name || loc.location_id}</div>
              <div className="text-[11px] text-slate-400">{loc.saleCount} card sale{loc.saleCount === 1 ? '' : 's'} since true-up{loc.lastSaleAt ? ` · last ${new Date(loc.lastSaleAt).toLocaleTimeString()}` : ''}</div>
            </div>
            <div className="px-4 py-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"><Wallet className="w-3.5 h-3.5" /> Card</div>
                <div className="text-lg font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{fmtMoney(loc.cardEstimate)}</div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"><Landmark className="w-3.5 h-3.5" /> Loan left</div>
                <div className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-50">{fmtMoney(loc.loanRemaining)}</div>
              </div>
              {loc.weeklyCodAvg > 0 && (
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400"><Receipt className="w-3.5 h-3.5" /> CODs/day (7-day avg)</div>
                  <div className="font-semibold tabular-nums text-slate-900 dark:text-slate-50">{fmtMoney(loc.weeklyCodAvg)}</div>
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
              <div className="pt-2 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-400 tabular-nums">
                +{fmtMoney(loc.netCredits)} net credits · {fmtMoney(loc.gross)} gross − {fmtMoney(loc.fees)} fees − {fmtMoney(loc.loanPaid)} loan ({(Number(loc.loan_rate) * 100).toFixed(2)}%) − {fmtMoney(loc.folderContrib)} folder (2%)
              </div>
              {ownerCanEdit && (() => {
                const todayStr = edmontonWallString(new Date()).slice(0, 10);
                const outItems = (localOutstanding?.[loc.location_id] || codOutstandingByLoc[loc.location_id] || {}).items || [];
                const uncollectedTodayRows = outItems.filter((it) => !it.date || it.date >= todayStr).map((it) => ({
                  key: `o-${it.delivery_id}`,
                  patientName: it.patient || null,
                  storeAbbrev: it.storeAbbrev || null,
                  storeColor: it.storeColor || null,
                  amount: it.amount,
                  sub: `${it.date || todayStr} · ${it.reason === 'cash_awaiting_square' ? 'cash awaiting Square' : it.status}`,
                  collected: false,
                }));
                const pastUncollectedRows = outItems.filter((it) => it.date && it.date < todayStr).map((it) => ({
                  key: `p-${it.delivery_id}`,
                  patientName: it.patient || null,
                  storeAbbrev: it.storeAbbrev || null,
                  storeColor: it.storeColor || null,
                  amount: it.amount,
                  sub: `${it.date} · ${it.reason === 'cash_awaiting_square' ? 'cash awaiting Square' : it.status}`,
                  collected: false,
                }));
                const collectedTodayRows = codCollectedTodayByLoc[loc.location_id] || [];
                const sumOf = (rows) => rows.reduce((s, r) => s + Number(r.amount || 0), 0);
                return (
                  <CardCodList
                    sections={[
                      { label: 'Collected today', color: '#059669', rows: collectedTodayRows, total: sumOf(collectedTodayRows) },
                      { label: 'Uncollected today', color: '#d97706', rows: uncollectedTodayRows, total: sumOf(uncollectedTodayRows) },
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

      {/* True-up dialog (simple inline panel) */}
      {showTrueUp && (
        <div ref={trueUpPanelRef} className="p-4 rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-slate-900 space-y-3">
          <div className="text-sm font-medium">True-Up: enter the CURRENT real numbers from each Square dashboard</div>
          <div className="text-xs text-slate-500">Blank fields keep the existing value. This resets the tracking window to now.</div>
          {(config.locations || []).map((loc) => (
            <div key={loc.location_id} className="grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
              <div className="text-sm font-medium col-span-2 md:col-span-1 flex items-center">{loc.name || loc.location_id}</div>
              <label className="text-[11px] text-slate-500">Card balance
                <Input type="number" step="0.01" className="mt-0.5" placeholder={fmtMoney(loc.card_start)}
                  value={trueUpDraft[loc.location_id]?.card ?? ''}
                  onChange={(e) => setTrueUpDraft((d) => ({ ...d, [loc.location_id]: { ...(d[loc.location_id] || {}), card: e.target.value } }))} />
              </label>
              <label className="text-[11px] text-slate-500">Loan remaining
                <Input type="number" step="0.01" className="mt-0.5" placeholder={fmtMoney(loc.loan_start)}
                  value={trueUpDraft[loc.location_id]?.loan ?? ''}
                  onChange={(e) => setTrueUpDraft((d) => ({ ...d, [loc.location_id]: { ...(d[loc.location_id] || {}), loan: e.target.value } }))} />
              </label>
              <label className="text-[11px] text-slate-500">Loan rate (e.g. 0.1725)
                <Input type="number" step="0.0001" className="mt-0.5" placeholder={String(loc.loan_rate)}
                  value={trueUpDraft[loc.location_id]?.loan_rate ?? ''}
                  onChange={(e) => setTrueUpDraft((d) => ({ ...d, [loc.location_id]: { ...(d[loc.location_id] || {}), loan_rate: e.target.value } }))} />
              </label>
            </div>
          ))}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
            <div className="text-sm font-medium col-span-2 md:col-span-1 flex items-center">Folder (combined)</div>
            <label className="text-[11px] text-slate-500">Folder balance
              <Input type="number" step="0.01" className="mt-0.5" placeholder={fmtMoney(config.folder_start || 0)}
                value={trueUpDraft.__folder ?? ''}
                onChange={(e) => setTrueUpDraft((d) => ({ ...d, __folder: e.target.value }))} />
            </label>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={saveTrueUp} disabled={isSaving}>{isSaving ? 'Saving…' : 'Save True-Up'}</Button>
            <Button size="sm" variant="outline" onClick={() => setShowTrueUp(false)} disabled={isSaving}>Cancel</Button>
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
    </div>
  );
}
