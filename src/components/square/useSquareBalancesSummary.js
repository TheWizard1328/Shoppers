import { useCallback, useEffect, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { edmontonWallString } from '@/components/utils/albertaTime';

/**
 * useSquareBalancesSummary — lightweight per-card balance estimates for the
 * sidebar badge (and any non-owner surface). Mirrors the math in
 * SquareBalancesView (card_start + sales − fee − folder 2% − loan% − CODs out)
 * but fetches only what a badge needs. Subscribes to the same live sources so
 * the badge tracks the page: AppSettings (true-up), SquareLedgerEntry (sales)
 * and Delivery (CODs out), all debounced.
 */

const SETTING_KEY = 'square_balances';

async function loadConfig() {
  const rows = await base44.entities.AppSettings.filter({ setting_key: SETTING_KEY }).catch(() => []);
  const rec = (rows || [])[0];
  return rec?.setting_value?.locations?.length ? rec.setting_value : null;
}

async function loadCardSales(cfg) {
  if (!cfg?.trued_up_at) return [];
  const out = [];
  let skip = 0;
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
  return out;
}

export async function buildStoreToLocMap() {
  const [storesRaw, cfgsRaw] = await Promise.all([
    base44.entities.Store.list().catch(() => []),
    base44.entities.SquareLocationConfig.list().catch(() => []),
  ]);
  const cfgLoc = new Map();
  (cfgsRaw || []).forEach((c) => { if (c?.id && c?.square_location_id) cfgLoc.set(c.id, c.square_location_id); });
  const storeToLoc = new Map();
  (storesRaw || []).forEach((s) => {
    const loc = s?.square_location_config_id ? cfgLoc.get(s.square_location_config_id) : null;
    if (s?.id && loc) storeToLoc.set(String(s.id), loc);
  });
  return storeToLoc;
}

// Same COD-outstanding rules as SquareBalancesView: pending/in-transit CODs minus
// non-cash payments, plus completed cash CODs not yet rung at Square.
async function computeCodOutstandingByLoc(cfg, storeToLoc) {
  try {
    const codSalesRaw = await base44.entities.SquareLedgerEntry.filter({ sale_class: 'cod_collection' }).catch(() => []);
    const confirmed = new Set(
      (codSalesRaw || []).filter((e) => e?.delivery_id && String(e?.status || '').toUpperCase() === 'COMPLETED').map((e) => String(e.delivery_id))
    );
    const tu = cfg?.trued_up_at ? new Date(cfg.trued_up_at) : null;
    const cutoffDate = (tu ? new Date(tu.getTime() - 6 * 3600000) : new Date(Date.now() - 6 * 3600000)).toISOString().slice(0, 10);
    const isCounted = (d) => String(d?.delivery_date || '') >= cutoffDate;
    const centsOf = (n) => Math.round(Number(n || 0) * 100);
    const byLoc = new Map();

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
        byLoc.set(locId, (byLoc.get(locId) || 0) + outstanding);
      }
    }

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
        byLoc.set(locId, (byLoc.get(locId) || 0) + cash);
      }
      if (list.length < 2000) break;
      const createdFloor = new Date(new Date(cutoffDate + 'T00:00:00Z').getTime() - 3 * 86400000).getTime();
      if (list.length && new Date(list[list.length - 1]?.created_date || 0).getTime() < createdFloor) break;
    }

    const out = {};
    for (const [locId, cents] of byLoc) out[locId] = cents / 100;
    return out;
  } catch (e) {
    console.error('[useSquareBalancesSummary] COD outstanding failed:', e);
    return {};
  }
}

// Today's (Edmonton date) still-to-collect CODs per card: pending/in-transit/en-route
// deliveries dated today, minus non-cash payments already taken, not confirmed collected.
export async function computeDailyCodByLoc(storeToLoc) {
  try {
    const today = edmontonWallString(new Date()).slice(0, 10);
    const centsOf = (n) => Math.round(Number(n || 0) * 100);
    const byLoc = new Map();
    for (const status of ['pending', 'in_transit', 'en_route']) {
      const rows = await base44.entities.Delivery.filter({ status }).catch(() => []);
      for (const d of rows || []) {
        if (String(d?.delivery_date || '') !== today) continue;
        const required = Number(d?.cod_total_amount_required || 0);
        if (required <= 0 || d?.cod_confirmed_collected) continue;
        const locId = storeToLoc.get(String(d?.store_id || ''));
        if (!locId) continue;
        const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
        const nonCash = payments.filter((p) => String(p?.type || '').toLowerCase() !== 'cash').reduce((s, p) => s + centsOf(p?.amount), 0);
        const out = Math.max(0, centsOf(required) - nonCash);
        if (out > 0) byLoc.set(locId, (byLoc.get(locId) || 0) + out);
      }
    }
    const out = {};
    for (const [locId, cents] of byLoc) out[locId] = cents / 100;
    return out;
  } catch (e) {
    console.error('[useSquareBalancesSummary] daily COD failed:', e);
    return {};
  }
}

// Color level: green when the balance is more than $20 ABOVE the daily CODs to
// collect, red when more than $20 BELOW, yellow inside the ±$20 band.
export const BALANCE_BAND = 20;
export function getBalanceLevel(balance, dailyCod) {
  const diff = (Number(balance) || 0) - (Number(dailyCod) || 0);
  if (diff > BALANCE_BAND) return 'green';
  if (diff >= -BALANCE_BAND) return 'yellow';
  return 'red';
}
export const BALANCE_LEVELS = {
  green: { border: '#10b981', tint: 'rgba(16, 185, 129, 0.07)', chipBg: '#d1fae5', chipText: '#065f46' },
  yellow: { border: '#f59e0b', tint: 'rgba(245, 158, 11, 0.08)', chipBg: '#fef3c7', chipText: '#92400e' },
  red: { border: '#ef4444', tint: 'rgba(239, 68, 68, 0.07)', chipBg: '#fee2e2', chipText: '#991b1b' },
};

function computeByLocId({ config, sales, codOutstanding, dailyCod }) {
  const folderRate = Number(config.folder_rate ?? 0.02);
  const byLocId = new Map();
  for (const loc of (config.locations || [])) {
    let credits = 0, loan = 0;
    for (const s of sales) {
      if (s.location_id !== loc.location_id) continue;
      const amount = Number(s.amount_cents || 0) / 100;
      const fee = Number(s.fee_cents || 0) / 100;
      loan += amount * Number(loc.loan_rate || 0);
      credits += amount - fee - amount * Number(loc.loan_rate || 0) - amount * folderRate;
    }
    const codOut = Number(codOutstanding?.[loc.location_id] || 0);
    const cardEstimate = Math.round((Number(loc.card_start || 0) + credits - codOut) * 100) / 100;
    const dailyCodTotal = Math.round(Number(dailyCod?.[loc.location_id] || 0) * 100) / 100;
    byLocId.set(loc.location_id, {
      name: loc.name || loc.location_id,
      cardEstimate,
      loanRemaining: Math.round(Math.max(0, Number(loc.loan_start || 0) - loan) * 100) / 100,
      dailyCodTotal,
      level: getBalanceLevel(cardEstimate, dailyCodTotal),
    });
  }
  return byLocId;
}

export function useSquareBalancesSummary(enabled = true) {
  const [ready, setReady] = useState(false);
  const [byLocId, setByLocId] = useState(new Map());
  const [storeToLoc, setStoreToLoc] = useState(new Map());
  const reloadSeq = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++reloadSeq.current;
    const config = await loadConfig();
    const [sales, stl] = await Promise.all([
      config ? loadCardSales(config).catch(() => []) : Promise.resolve([]),
      buildStoreToLocMap().catch(() => new Map()),
    ]);
    const [codOutstanding, dailyCod] = await Promise.all([
      config ? computeCodOutstandingByLoc(config, stl) : Promise.resolve({}),
      config ? computeDailyCodByLoc(stl) : Promise.resolve({}),
    ]);
    if (seq !== reloadSeq.current) return;
    setByLocId(config ? computeByLocId({ config, sales, codOutstanding, dailyCod }) : new Map());
    setStoreToLoc(stl);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    reload();
    const unsubs = [];
    let cfgTimer = null, ledgerTimer = null, deliveryTimer = null;
    try {
      unsubs.push(base44.entities.AppSettings.subscribe(() => { clearTimeout(cfgTimer); cfgTimer = setTimeout(reload, 2500); }));
    } catch {}
    try {
      unsubs.push(base44.entities.SquareLedgerEntry.subscribe(() => { clearTimeout(ledgerTimer); ledgerTimer = setTimeout(reload, 6000); }));
    } catch {}
    try {
      unsubs.push(base44.entities.Delivery.subscribe(() => { clearTimeout(deliveryTimer); deliveryTimer = setTimeout(reload, 20000); }));
    } catch {}
    const onDeliveriesUpdated = () => { clearTimeout(deliveryTimer); deliveryTimer = setTimeout(reload, 15000); };
    window.addEventListener('deliveriesUpdated', onDeliveriesUpdated);
    return () => {
      clearTimeout(cfgTimer); clearTimeout(ledgerTimer); clearTimeout(deliveryTimer);
      unsubs.forEach((u) => { try { u?.(); } catch {} });
      window.removeEventListener('deliveriesUpdated', onDeliveriesUpdated);
    };
  }, [enabled, reload]);

  return { ready, byLocId, storeToLoc };
}
