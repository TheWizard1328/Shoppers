// SQUARE BALANCES COMPUTE — SERVER-SIDE (owner spec Oct 9 2026, "take the load
// off the drivers' devices"): the badge/balance summary math that every device
// used to run client-side (45-day delivery scan per device on every COD event,
// page load and refresh — the phone-slowing sync the owner reported) now runs
// HERE. A device invokes this function (page load, Refresh, debounced COD
// delivery events), receives the FINISHED payload, paints it and writes the
// shared SquareBalancesSnapshot record client-side — a client entity write
// broadcasts over WS, so every other device converges with one small read.
// No 5-minute schedule: delivery create/update with a COD (completion, failure,
// back-to-transit, amount or tender change), page load and the Refresh button
// are the only initiators.
//
// SELF-CONTAINED PORT of the client pipeline (useSquareBalancesSummary.js):
// fee sheet + whole-cent rounding, isCounted true-up rules, cod_card_spend_at
// post-true-up conversions, stored combined-swipe cents, retry-pair dedupe,
// failed-COD refund detection, pending-deduction marks, weekly/daily windows.
// The payload shape is IDENTICAL to buildSummaryPayload so the client applies
// it through the same deserializeSummary path as its IDB snapshot.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const requireUser = async (b44) => { const u = await b44.auth.me().catch(() => null); if (!u) throw new HttpError(401, 'Unauthorized'); return u; };

// ── Alberta wall-clock (port of albertaTime.js — pure UTC arithmetic, no Intl) ──
const ALBERTA_PERMANENT_UTC6_MS = Date.UTC(2026, 10, 1, 8, 0, 0);
const albertaOffsetHoursAt = (utcMs) => {
  if (utcMs >= ALBERTA_PERMANENT_UTC6_MS) return -6;
  const y = new Date(utcMs).getUTCFullYear();
  const firstSundayDate = (monthIdx) => 1 + ((7 - new Date(Date.UTC(y, monthIdx, 1)).getUTCDay()) % 7);
  const dstStartMs = Date.UTC(y, 2, firstSundayDate(2) + 7, 9, 0, 0);
  const dstEndMs = Date.UTC(y, 10, firstSundayDate(10), 8, 0, 0);
  return utcMs >= dstStartMs && utcMs < dstEndMs ? -6 : -7;
};
const pad = (v) => String(v).padStart(2, '0');
const toEdmontonWall = (date) => {
  const local = new Date(date.getTime() + albertaOffsetHoursAt(date.getTime()) * 3600000);
  return { y: local.getUTCFullYear(), mo: local.getUTCMonth() + 1, d: local.getUTCDate(), h: local.getUTCHours(), mi: local.getUTCMinutes(), s: local.getUTCSeconds() };
};
const edmontonWallString = (date) => { const w = toEdmontonWall(date); return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`; };
const edmontonBusinessDayKey = (date = new Date()) => {
  const w = edmontonWallString(date);
  if (Number(w.slice(11, 13)) >= 5) return w.slice(0, 10);
  const y = Number(w.slice(0, 4)), mo = Number(w.slice(5, 7)), d = Number(w.slice(8, 10));
  return new Date(Date.UTC(y, mo - 1, d - 1)).toISOString().slice(0, 10);
};

// ── Fee sheet + whole-cent rounding (owner spec Oct 7 2026) ──
const DEFAULT_FOLDER_RATE = 0.02;
const CARD_FEE_SHEET = {
  debit: (amt) => 0.07 + amt * 0.0075,
  interac: (amt) => 0.07 + amt * 0.0075,
  credit: (amt) => amt * 0.025,
};
const estimateCardFeeCents = (amountCents, cardType) => {
  const key = String(cardType || '').toLowerCase();
  const fn = CARD_FEE_SHEET[key] || CARD_FEE_SHEET.credit;
  return Math.max(0, Math.round(fn(Number(amountCents || 0) / 100) * 100));
};
const folderCentsFor = (grossC, folderRate) => Math.floor(grossC * Number(folderRate ?? DEFAULT_FOLDER_RATE));
const centsOf = (n) => Math.round(Number(n || 0) * 100);
const BALANCE_BAND = 20;
const getBalanceLevel = (balance, codAvg) => {
  const diff = (Number(balance) || 0) - (Number(codAvg) || 0);
  if (diff > BALANCE_BAND) return 'green';
  if (diff >= -BALANCE_BAND) return 'yellow';
  return 'red';
};
const dedupeBySquareId = (rows) => {
  const seen = new Set(); const out = [];
  for (const r of rows || []) { const key = r?.square_id || r?.id || null; if (!key || seen.has(key)) continue; seen.add(key); out.push(r); }
  return out;
};

const COD_WINDOW_DAYS = 7;
const DEBOUNCE_MS = 90_000; // server-side: a fresh compute is at most one per 90s unless forced

async function pagedFilter(b44, entity, filter, sort, maxPages = 40) {
  const out = []; let skip = 0;
  for (let p = 0; p < maxPages; p++) {
    const rows = await b44.entities[entity].filter(filter, sort, 500, skip).catch((e) => { throw e; });
    const list = rows || [];
    out.push(...list);
    if (list.length < 500) break;
    skip += 500;
  }
  return out;
}
const getSettingRows = async (b44, key) => {
  const rows = await b44.entities.AppSettings.filter({ setting_key: key }, '-updated_date', 20, 0).catch(() => []);
  return (rows || []).filter(Boolean).sort((a, b) => String(b?.updated_date || '').localeCompare(String(a?.updated_date || '')));
};

async function fetchPatientNames(b44, ids) {
  const out = {};
  const unique = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!unique.length) return out;
  try {
    // $in attempt (one call); fall back to per-id gets in small batches.
    const rows = await b44.entities.Patient.filter({ id: { $in: unique } }, undefined, 500, 0);
    for (const p of rows || []) if (p?.id && p?.full_name) out[String(p.id)] = p.full_name;
    if (Object.keys(out).length) return out;
  } catch { /* fall through */ }
  for (let i = 0; i < unique.length; i += 8) {
    const chunk = unique.slice(i, i + 8);
    const rows = await Promise.all(chunk.map((id) => b44.entities.Patient.get(id).catch(() => null)));
    rows.forEach((p, idx) => { if (p?.full_name) out[chunk[idx]] = p.full_name; });
  }
  return out;
}

async function computeSummary(b44, userId) {
  // ── config (AppSettings 'square_balances') ──
  const cfgRec = (await getSettingRows(b44, 'square_balances'))[0];
  const config = cfgRec?.setting_value?.locations?.length ? cfgRec.setting_value : null;
  if (!config) throw new HttpError(409, 'Square balances config not initialized');
  const cfgRecordId = cfgRec?.id || null;
  const tu = config?.trued_up_at ? new Date(config.trued_up_at) : null;
  const tuMs = tu ? tu.getTime() : null;
  const cutoffDate = (tu ? new Date(tu.getTime() - 6 * 3600000) : new Date(Date.now() - 6 * 3600000)).toISOString().slice(0, 10);
  const today = edmontonBusinessDayKey(new Date());
  const weekFrom = new Date(new Date(today + 'T00:00:00Z').getTime() - 7 * 86400000).toISOString().slice(0, 10);

  // ── reference data (Stores, SquareLocationConfig, marks) ──
  const [storesRaw, cfgsRaw, marksRec, failedMarksRec] = await Promise.all([
    b44.entities.Store.list().catch(() => []),
    b44.entities.SquareLocationConfig.list().catch(() => []),
    getSettingRows(b44, 'square_card_spend_marks'),
    getSettingRows(b44, 'square_failed_refund_marks'),
  ]);
  const cfgLoc = new Map();
  (cfgsRaw || []).forEach((c) => { if (c?.id && c?.square_location_id) cfgLoc.set(c.id, c.square_location_id); });
  const storeToLoc = new Map();
  const storeNames = new Map();
  const storeInfoById = new Map();
  (storesRaw || []).forEach((s) => {
    const loc = s?.square_location_config_id ? cfgLoc.get(s.square_location_config_id) : null;
    if (s?.id && loc) storeToLoc.set(String(s.id), loc);
    if (s?.id) { storeNames.set(String(s.id), s?.name || String(s.id)); storeInfoById.set(String(s.id), { abbreviation: s?.abbreviation || null, color: s?.color || null }); }
  });
  const storeBadgeOf = (sid) => {
    const si = sid ? storeInfoById.get(String(sid)) : null;
    return si ? { storeAbbrev: si.abbreviation, storeColor: si.color } : { storeAbbrev: null, storeColor: null };
  };
  // marks map {id: {notTapped, touchedAt}} (legacy {notTappedAt} normalized)
  const marksMap = {};
  const marksVal = marksRec?.[0]?.setting_value;
  for (const [k, v] of Object.entries(marksVal && typeof marksVal === 'object' ? marksVal : {})) {
    if (!v || typeof v !== 'object') continue;
    if (v.notTappedAt) marksMap[k] = { notTapped: true, touchedAt: v.notTappedAt };
    else if (v.touchedAt) marksMap[k] = { notTapped: !!v.notTapped, touchedAt: v.touchedAt };
  }
  const manualRefundMarks = {};
  const failedVal = failedMarksRec?.[0]?.setting_value;
  for (const [k, v] of Object.entries(failedVal && typeof failedVal === 'object' ? failedVal : {})) {
    if (v && typeof v === 'object' && (v.at || v.refundedAt)) manualRefundMarks[k] = true;
  }

  // ── delivery windows ──
  const countedSnapshot = new Set((config?.trued_up_counted_ids || []).map(String));
  const isCountedCredits = (d) => {
    if (tuMs == null) return String(d?.delivery_date || '') >= cutoffDate;
    const spendAt = d?.cod_card_spend_at ? new Date(d.cod_card_spend_at).getTime() : null;
    if (spendAt != null && Number.isFinite(spendAt) && spendAt >= tuMs) return true;
    const done = d?.actual_delivery_time ? new Date(d.actual_delivery_time).getTime() : null;
    if (done != null && Number.isFinite(done)) return done >= tuMs;
    const id = d?.id ? String(d.id) : null;
    if (id && countedSnapshot.has(id)) return false;
    return String(d?.delivery_date || '') >= cutoffDate;
  };
  const isCountedDate = (d) => String(d?.delivery_date || '') >= cutoffDate;

  const activeSince = cutoffDate < today ? cutoffDate : today;
  const completedSince = cutoffDate < weekFrom ? cutoffDate : weekFrom;
  const [pendingRows, transitRows, enRouteRows, failedRows, completedWindowRows] = await Promise.all([
    pagedFilter(b44, 'Delivery', { status: 'pending', delivery_date: { $gte: activeSince } }, '-delivery_date'),
    pagedFilter(b44, 'Delivery', { status: 'in_transit', delivery_date: { $gte: activeSince } }, '-delivery_date'),
    pagedFilter(b44, 'Delivery', { status: 'en_route', delivery_date: { $gte: activeSince } }, '-delivery_date'),
    pagedFilter(b44, 'Delivery', { status: 'failed', delivery_date: { $gte: activeSince } }, '-delivery_date'),
    pagedFilter(b44, 'Delivery', { status: 'completed', delivery_date: { $gte: completedSince } }, '-delivery_date'),
  ]);
  // Post-true-up completions of OLDER-dated deliveries (parity with the
  // client's isCountedCredits: completion or cod_card_spend_at after the
  // true-up instant, even when delivery_date predates the window).
  const recentUpdated = await pagedFilter(b44, 'Delivery', { status: 'completed' }, '-updated_date', 4);
  const completedTail = (recentUpdated || []).filter((d) => isCountedCredits(d) && String(d?.delivery_date || '') < completedSince);
  const allDeliveries = [...pendingRows, ...transitRows, ...enRouteRows, ...failedRows, ...completedWindowRows, ...completedTail];
  const completedAll = [...completedWindowRows, ...completedTail];

  // ── delivery card credits (loadDeliveryCardCredits port) ──
  const folderRate = Number(config?.folder_rate ?? DEFAULT_FOLDER_RATE);
  const loanRateByLoc = new Map();
  (config?.locations || []).forEach((l) => { if (l?.location_id) loanRateByLoc.set(l.location_id, Number(l.loan_rate || 0)); });
  const deliveryCredits = new Map();
  const aggForCredit = (locId) => {
    if (!deliveryCredits.has(locId)) deliveryCredits.set(locId, { gross: 0, fees: 0, loan: 0, folder: 0, credits: 0, count: 0, lastAt: null });
    return deliveryCredits.get(locId);
  };
  const seenDelivId = new Set();
  for (const d of completedAll) {
    if (!d?.id || seenDelivId.has(String(d.id))) continue; // tail overlap
    seenDelivId.add(String(d.id));
    if (d?.status !== 'completed' || !isCountedCredits(d)) continue;
    const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
    const cardPayments = payments.filter((p) => ['debit', 'credit'].includes(String(p?.type || '').toLowerCase()) && Number(p?.amount) > 0);
    if (!cardPayments.length) continue;
    const locId = storeToLoc.get(String(d?.store_id || ''));
    if (!locId) continue;
    const loanRate = loanRateByLoc.get(locId) || 0;
    const agg = aggForCredit(locId);
    for (const p of cardPayments) {
      const grossC = Math.round(Number(p.amount) * 100);
      const type = String(p.type || '').toLowerCase();
      const storedC = Number.isFinite(Number(p?.fee_c)) && Number.isFinite(Number(p?.folder_c)) && Number.isFinite(Number(p?.loan_c));
      const feeC = storedC ? Math.round(Number(p.fee_c)) : estimateCardFeeCents(grossC, type);
      const loanC = storedC ? Math.round(Number(p.loan_c)) : Math.round(grossC * loanRate);
      const folderC = storedC ? Math.round(Number(p.folder_c)) : folderCentsFor(grossC, folderRate);
      agg.gross += grossC; agg.fees += feeC; agg.loan += loanC; agg.folder += folderC;
      agg.credits += Number.isFinite(Number(p?.settled_c)) ? Math.round(Number(p.settled_c)) : grossC - feeC - loanC - folderC;
      agg.count += 1;
    }
    const doneAt = String(d.actual_delivery_time || '');
    if (doneAt && String(agg.lastAt || '') < doneAt) agg.lastAt = doneAt;
  }
  for (const agg of deliveryCredits.values()) {
    agg.gross = agg.gross / 100; agg.fees = agg.fees / 100; agg.loan = agg.loan / 100;
    agg.folder = agg.folder / 100; agg.credits = agg.credits / 100;
  }

  // ── payouts: real withdrawals only (loadCardPayouts port) ──
  let payouts = [];
  if (config?.trued_up_at) {
    const rows = await pagedFilter(b44, 'SquareLedgerEntry', { occurred_at: { $gte: config.trued_up_at } }, 'created_date', 20).catch(() => []);
    const seenId = new Set(); payouts = [];
    for (const r of rows || []) {
      if (String(r?.entry_kind || '') !== 'store_withdraw') continue;
      const st = String(r?.status || '').toUpperCase();
      if (st === 'PENDING' || st === 'IN_PROGRESS' || st === 'FAILED') continue;
      if (!r?.id || !r?.square_id || seenId.has(r.square_id)) continue;
      seenId.add(r.square_id);
      const cents = Math.abs(Math.round(Number(r.amount_cents || 0)));
      payouts.push({ id: r.id, location_id: r.location_id, amount: cents / 100, amount_cents: cents, occurred_at: r.occurred_at, status: r.status });
    }
  }
  const payoutsByLocMap = new Map();
  for (const p of payouts || []) {
    if (!p?.location_id) continue;
    payoutsByLocMap.set(p.location_id, (payoutsByLocMap.get(p.location_id) || 0) + (Number(p.amount) || 0));
  }
  const payoutCentsByLoc = new Map();
  for (const pw of payouts || []) {
    if (!pw?.location_id) continue;
    if (!payoutCentsByLoc.has(pw.location_id)) payoutCentsByLoc.set(pw.location_id, []);
    payoutCentsByLoc.get(pw.location_id).push(Math.round(Number(pw.amount_cents || 0)));
  }

  // ── refunds window (loadFailedRefundEntries port) ──
  const windowSince = (() => {
    const cutoffD = (tu ? new Date(tu.getTime() - 6 * 3600000) : new Date(Date.now() - 6 * 3600000)).toISOString().slice(0, 10);
    return new Date(new Date(`${cutoffD}T00:00:00Z`).getTime() - 3 * 86400000).toISOString();
  })();
  const refundRows = dedupeBySquareId(await pagedFilter(b44, 'SquareLedgerEntry', { entry_kind: 'refund', occurred_at: { $gte: windowSince } }, 'created_date', 20).catch(() => []));
  const isFailedCodRefunded = (item, locIdForStore) => {
    if (!item) return false;
    const id = item.delivery_id ? String(item.delivery_id) : null;
    const cents = Math.round(Number(item.amount || 0) * 100);
    const delivDate = String(item.date || '').slice(0, 10);
    const locId = locIdForStore ? String(locIdForStore(item.store_id)) : null;
    for (const r of refundRows || []) {
      if (id && String(r?.delivery_id || '') === id) return true;
      if (cents > 0 && Math.round(Number(r?.amount_cents || 0)) === cents &&
        (!locId || String(r?.location_id || '') === locId) &&
        (!delivDate || !r?.occurred_at || String(edmontonWallString(new Date(r.occurred_at))).slice(0, 10) >= delivDate)) return true;
    }
    return false;
  };

  // ── patient names for item rows ──
  const neededPatientIds = [];
  for (const d of allDeliveries) if (d?.patient_id) neededPatientIds.push(d.patient_id);
  const patientNameOf = (pid) => (pid ? patientNames[String(pid)] || null : null);
  const patientNames = await fetchPatientNames(b44, neededPatientIds);

  // ── outstanding detailed (computeCodOutstandingDetailed port) ──
  const byLoc = new Map();
  const aggFor = (locId) => {
    if (!byLoc.has(locId)) byLoc.set(locId, { total: 0, pendingCount: 0, awaitingCount: 0, items: [] });
    return byLoc.get(locId);
  };
  // legacy retry-pair index (patient → {amt, createdT})
  const retryCarriedByPatient = new Map();
  for (const x of allDeliveries) {
    if (!x?.patient_id || !x?.created_date) continue;
    const amt = Math.round(centsOf(x?.cod_total_amount_required));
    if (!(amt > 0)) continue;
    if (!['pending', 'in_transit', 'en_route', 'completed'].includes(String(x?.status || ''))) continue;
    const k = String(x.patient_id);
    if (!retryCarriedByPatient.has(k)) retryCarriedByPatient.set(k, []);
    retryCarriedByPatient.get(k).push({ amt, createdT: new Date(x.created_date).getTime() });
  }
  const isLegacyRetried = (d, amtCents) => {
    const createdT = d?.created_date ? new Date(d.created_date).getTime() : 0;
    for (const e of retryCarriedByPatient.get(String(d?.patient_id || '')) || []) {
      if (e.amt === amtCents && e.createdT > createdT) return true;
    }
    return false;
  };
  const autoRefundedFailed = [];
  for (const status of ['pending', 'in_transit', 'en_route', 'failed']) {
    const rows = allDeliveries.filter((d) => d?.status === status);
    for (const d of rows || []) {
      const required = Number(d?.cod_total_amount_required || 0);
      if (required <= 0 || !isCountedDate(d) || d?.cod_confirmed_collected) continue;
      const locId = storeToLoc.get(String(d?.store_id || ''));
      if (!locId) continue;
      const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
      const nonCash = payments.filter((p) => String(p?.type || '').toLowerCase() !== 'cash').reduce((s, p) => s + centsOf(p?.amount), 0);
      const outstanding = Math.max(0, centsOf(required) - nonCash);
      if (outstanding <= 0) continue;
      if (status === 'failed' && (d?.cod_retried_at || isLegacyRetried(d, Math.round(centsOf(required))))) continue;
      const item = { delivery_id: d.id, status, amount: outstanding / 100, reason: status === 'failed' ? 'failed_uncollected' : 'pending_or_in_transit', date: String(d.delivery_date || '').slice(0, 10), created_date: d.created_date || null, patient: patientNameOf(d.patient_id), store_id: d.store_id, driver_id: d.driver_id || null, ...storeBadgeOf(d.store_id) };
      if (status === 'failed') {
        if (manualRefundMarks[String(d.id)]) continue;
        if (isFailedCodRefunded(item, (sid) => storeToLoc.get(String(sid || '')))) {
          const amtC = Math.round(centsOf(required));
          const rr = (refundRows || []).find((r) => String(r?.delivery_id || '') === String(d.id) ||
            (Math.round(Number(r?.amount_cents || 0)) === amtC && String(r?.location_id || '') === locId));
          autoRefundedFailed.push({ ...item, loc_id: locId, refund_at: rr?.occurred_at || null });
          continue;
        }
      }
      const agg = aggFor(locId);
      agg.total += outstanding; agg.pendingCount += 1;
      agg.items.push(item);
    }
  }
  // cash-collected completed CODs (display rows; deduction via deductItems)
  const cashByLoc = new Map();
  const seenCash = new Set();
  for (const d of completedAll) {
    if (!d?.id || seenCash.has(String(d.id))) continue;
    seenCash.add(String(d.id));
    const required = Number(d?.cod_total_amount_required || 0);
    if (required <= 0 || !isCountedDate(d)) continue;
    const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
    const hasCash = payments.some((p) => String(p?.type || '').toLowerCase() === 'cash');
    const hasCard = payments.some((p) => ['debit', 'credit'].includes(String(p?.type || '').toLowerCase()));
    if (!hasCash || hasCard) continue;
    const locId = storeToLoc.get(String(d?.store_id || ''));
    if (!locId) continue;
    if (!cashByLoc.has(locId)) cashByLoc.set(locId, []);
    cashByLoc.get(locId).push({
      delivery_id: d.id, status: 'completed', amount: centsOf(required) / 100,
      reason: 'cash_collected', date: String(d.delivery_date || '').slice(0, 10),
      created_date: d.created_date || null,
      patient: patientNameOf(d.patient_id), store_id: d.store_id, driver_id: d.driver_id || null, ...storeBadgeOf(d.store_id)
    });
  }
  // collected-charge / cash-awaiting-card deduction items (owner rules Oct 7/Oct 9)
  const deductByLoc = new Map();
  const seenDeduct = new Set();
  for (const d of completedAll) {
    if (!d?.id || seenDeduct.has(String(d.id))) continue;
    seenDeduct.add(String(d.id));
    const required = Number(d?.cod_total_amount_required || 0);
    if (required <= 0 || !isCountedDate(d)) continue;
    const locId = storeToLoc.get(String(d?.store_id || ''));
    if (!locId) continue;
    const pays = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
    const cardCollected = pays.some((p) => ['debit', 'credit'].includes(String(p?.type || '').toLowerCase()));
    if (!deductByLoc.has(locId)) deductByLoc.set(locId, []);
    deductByLoc.get(locId).push({
      delivery_id: d.id, status: 'completed', amount: centsOf(required) / 100,
      reason: cardCollected ? 'collected_charge' : 'cash_awaiting_card',
      date: String(d.delivery_date || '').slice(0, 10),
      created_date: d.created_date || null,
    });
  }
  const codOutstandingDetailed = {};
  if (autoRefundedFailed.length) codOutstandingDetailed.autoRefundedFailed = autoRefundedFailed;
  const allLocs = new Set([...byLoc.keys(), ...deductByLoc.keys(), ...cashByLoc.keys()]);
  for (const locId of allLocs) {
    const agg = byLoc.get(locId) || { total: 0, pendingCount: 0, awaitingCount: 0, items: [] };
    codOutstandingDetailed[locId] = { location_id: locId, total: agg.total / 100, pending_count: agg.pendingCount, awaiting_count: agg.awaitingCount, items: agg.items.slice(0, 50), deductItems: deductByLoc.get(locId) || [], cashItems: cashByLoc.get(locId) || [] };
  }
  const codOutstanding = {};
  for (const [locId, agg] of Object.entries(codOutstandingDetailed)) {
    if (locId === 'autoRefundedFailed') continue;
    codOutstanding[locId] = agg?.total ?? agg;
  }

  // ── weekly totals + daily remaining ──
  const weeklyByStore = new Map();
  for (const d of allDeliveries) {
    const dd = String(d?.delivery_date || '');
    if (dd < weekFrom || dd >= today) continue;
    if (d?.status === 'cancelled') continue;
    const required = Number(d?.cod_total_amount_required || 0);
    if (required <= 0 || !d?.store_id) continue;
    weeklyByStore.set(String(d.store_id), (weeklyByStore.get(String(d.store_id)) || 0) + required);
  }
  const dailyRemainingByStore = new Map();
  for (const status of ['pending', 'in_transit', 'en_route', 'failed']) {
    for (const d of allDeliveries.filter((x) => x?.status === status)) {
      if (String(d?.delivery_date || '') !== today) continue;
      const required = Number(d?.cod_total_amount_required || 0);
      if (required <= 0 || d?.cod_confirmed_collected) continue;
      const payments = Array.isArray(d?.cod_payments) ? d.cod_payments : [];
      const nonCash = payments.filter((p) => String(p?.type || '').toLowerCase() !== 'cash').reduce((s, p) => s + centsOf(p?.amount), 0);
      const out = Math.max(0, centsOf(required) - nonCash);
      if (out <= 0) continue;
      const key = String(d?.store_id || '');
      const rec = dailyRemainingByStore.get(key) || { count: 0, total: 0 };
      rec.count += 1; rec.total += out / 100;
      dailyRemainingByStore.set(key, rec);
    }
  }
  const weeklyAvgByLoc = {};
  {
    const totals = new Map();
    for (const [storeId, locId] of storeToLoc.entries()) {
      const t = Number(weeklyByStore.get(String(storeId)) || 0);
      if (!t) continue;
      totals.set(locId, (totals.get(locId) || 0) + t);
    }
    for (const [locId, t] of totals.entries()) weeklyAvgByLoc[locId] = t / COD_WINDOW_DAYS;
  }

  // ── per-card balance math (computeByLocId port) ──
  const byLocId = new Map();
  for (const loc of (config.locations || [])) {
    const _dc = deliveryCredits.get?.(loc.location_id) || {};
    const credits = Number(_dc.credits || 0);
    const loan = Number(_dc.loan || 0);
    const withdrawn = (payoutCentsByLoc.get?.(loc.location_id) || []).reduce((sum, c) => sum + (Number(c) || 0), 0) / 100;
    const outstandingItems = [
      ...((codOutstandingDetailed?.[loc.location_id]?.items) || []),
      ...((codOutstandingDetailed?.[loc.location_id]?.deductItems) || []),
    ];
    // computePendingCodDeduction port
    let pendingDeductCents = 0; let pendingDeductCount = 0;
    const tuCutoffDate = tuMs != null ? new Date(tuMs - 6 * 3600000).toISOString().slice(0, 10) : null;
    for (const it of outstandingItems) {
      if (!['pending', 'in_transit', 'en_route', 'failed', 'completed'].includes(String(it?.status || ''))) continue;
      const id = it?.delivery_id ? String(it.delivery_id) : null;
      if (id && countedSnapshot.has(id)) continue;
      const cents = Math.round(Number(it?.amount || 0) * 100);
      if (!(cents > 0)) continue;
      const mark = id ? marksMap[id] : null;
      const createdT = it?.created_date ? new Date(it.created_date).getTime() : null;
      const isNewSinceTrueUp = tuMs != null && createdT != null && createdT >= tuMs;
      const inScopeAtTrueUp = tuCutoffDate != null && String(it?.date || '') >= tuCutoffDate;
      const amountAddedSinceTrueUp = !isNewSinceTrueUp && inScopeAtTrueUp;
      const touchedT = mark?.touchedAt ? new Date(mark.touchedAt).getTime() : null;
      const isTouchedSinceTrueUp = tuMs != null && touchedT != null && touchedT >= tuMs;
      if (!isNewSinceTrueUp && !amountAddedSinceTrueUp && !isTouchedSinceTrueUp) continue;
      if (mark?.notTapped === true) continue;
      pendingDeductCents += cents; pendingDeductCount += 1;
    }
    const cardEstimate = (Math.round(Number(loc.card_start || 0) * 100) + Math.round(credits * 100) - Math.round(withdrawn * 100) - pendingDeductCents) / 100;
    const codAvg = Math.round(Number(weeklyAvgByLoc?.[loc.location_id] || 0) * 100) / 100;
    byLocId.set(loc.location_id, {
      name: loc.name || loc.location_id,
      cardEstimate,
      loanRemaining: Math.round(Math.max(0, Number(loc.loan_start || 0) - loan) * 100) / 100,
      codAvg,
      sweptOut: Math.round(withdrawn * 100) / 100,
      chargedToCard: 0,
      chargedCount: 0,
      pendingDeducted: Math.round(pendingDeductCents) / 100,
      pendingDeductCount,
      storeCardSpend: 0,
      level: getBalanceLevel(cardEstimate, codAvg),
    });
  }

  // ── PAYMENT DISCREPANCIES (owner spec Oct 9 2026 night): flag every COD
  // whose RECORDED collection type in the app disagrees with what Square
  // actually saw, over the last 60 days — NO auto-updates of the in-app
  // collection type (the previous auto tender-fix cross-check is retired).
  // The owner reviews the flags in the Payment discrepancies viewer and
  // CONFIRMS each one there; the confirm applies the type fix + normal
  // fee/loan/folder math client-side. Flag kinds:
  //   cash_swiped     — recorded Cash, but Square shows a Debit/Credit swipe
  //   type_mismatch   — recorded Debit but Square shows Credit (or reverse)
  //   mixed_tenders   — delivery carries BOTH Debit and Credit entries vs one Square brand
  //   missing_payment — recorded Debit/Credit but no Square payment found
  //                     (only flagged once 3 days old, past ledger-sync lag)
  // Matching: ledger cod_collection rows linked by delivery_id (squareLedgerSync
  // stamps the split rows of grouped rings too), else an exact
  // amount+location+day match among UNLINKED rows. Records live in the
  // CodBadgeChangeLog entity (action='discrepancy'): open rows are upserted,
  // rows whose mismatch heals are auto-marked 'resolved', and confirmed /
  // dismissed rows are never touched or recreated.
  {
    const nowIso = new Date().toISOString();
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    const tenderSince = new Date(Date.now() - 60 * 86400000).toISOString();
    // 60-day completed COD deliveries (filter narrowed by $gt; fallback
    // fetches the bare date window and narrows in code if $gt unsupported).
    let codDeliveries = [];
    try {
      codDeliveries = await pagedFilter(b44, 'Delivery', { status: 'completed', delivery_date: { $gte: sixtyDaysAgo }, cod_total_amount_required: { $gt: 0 } }, '-delivery_date', 40);
    } catch (_) {
      const rawRows = await pagedFilter(b44, 'Delivery', { status: 'completed', delivery_date: { $gte: sixtyDaysAgo } }, '-delivery_date', 40).catch(() => []);
      codDeliveries = (rawRows || []).filter((d) => Number(d?.cod_total_amount_required || 0) > 0);
    }
    // Ledger cod_collection rows (60d): linked index by delivery_id + an
    // unlinked index by amount|location|Edmonton-day for fallback matching.
    const codRows = await pagedFilter(b44, 'SquareLedgerEntry', { sale_class: 'cod_collection', occurred_at: { $gte: tenderSince } }, '-occurred_at', 40).catch(() => []);
    const brandByDelivery = new Map(); // delivery_id -> { brands:Set, squareIds:[], tender: 'debit'|'credit' }
    const unlinkedIdx = new Map(); // `${loc}|${day}|${cents}` -> [entry,...]
    for (const r of codRows || []) {
      if (String(r?.status || '').toUpperCase() !== 'COMPLETED') continue;
      const brand = String(r?.card_brand || '').toUpperCase();
      const day = r?.occurred_at ? String(edmontonWallString(new Date(r.occurred_at))).slice(0, 10) : null;
      const cents = Math.round(Number(r?.amount_cents || 0));
      const tender = brand === 'INTERAC' ? 'debit' : (brand ? 'credit' : null);
      if (r?.delivery_id) {
        const id = String(r.delivery_id);
        const rec = brandByDelivery.get(id) || { brands: new Set(), squareIds: [], tender: null };
        if (brand) rec.brands.add(brand);
        if (tender) rec.tender = tender;
        if (r?.square_id) rec.squareIds.push(r.square_id);
        brandByDelivery.set(id, rec);
      } else if (day && cents > 0 && tender) {
        const k = `${r?.location_id || ''}|${day}|${cents}`;
        if (!unlinkedIdx.has(k)) unlinkedIdx.set(k, []);
        unlinkedIdx.get(k).push({ tender, square_id: r?.square_id || null, occurred_at: r?.occurred_at || null });
      }
    }
    const todayKey = edmontonBusinessDayKey(new Date());
    const lagCutoffMs = Date.now() - 3 * 86400000;
    const detected = new Map(); // delivery_id -> {kind, actual, detail, square_id}
    for (const d of codDeliveries || []) {
      if (!d?.id) continue;
      const payments = Array.isArray(d?.cod_payments) ? d.cod_payments.filter(Boolean) : [];
      if (!payments.length) continue; // nothing recorded — no recorded type to compare
      const cardEntries = payments.filter((p) => ['debit', 'credit'].includes(String(p?.type || '').toLowerCase()));
      const recordedIsCash = !cardEntries.length;
      const recCardTypes = [...new Set(cardEntries.map((p) => String(p?.type || '').toLowerCase()))];
      const recordedLabel = recordedIsCash ? 'Cash' : (recCardTypes.length > 1 ? 'mixed Debit+Credit' : (recCardTypes[0] === 'debit' ? 'Debit' : 'Credit'));
      // actual Square tender: linked rows first, else exact unlinked match
      let actual = null; let squareId = null;
      const linked = brandByDelivery.get(String(d.id));
      if (linked?.tender) { actual = linked.tender; squareId = linked.squareIds[0] || null; }
      if (!actual) {
        const locId = storeToLoc.get(String(d?.store_id || '')) || '';
        const day = String(d?.delivery_date || '').slice(0, 10);
        const tryCents = [...new Set([Math.round(Number(d?.cod_total_amount_required || 0) * 100), ...cardEntries.map((p) => Math.round(Number(p?.amount || 0) * 100))])].filter((c) => c > 0);
        for (const c of tryCents) {
          const hit = (unlinkedIdx.get(`${locId}|${day}|${c}`) || [])[0];
          if (hit) { actual = hit.tender; squareId = hit.square_id; break; }
        }
      }
      const actualLabel = actual === 'debit' ? 'Debit' : (actual === 'credit' ? 'Credit' : null);
      if (recordedIsCash && actual) {
        detected.set(String(d.id), { kind: 'cash_swiped', recorded: 'cash', actual, detail: `Recorded Cash · Square shows ${actualLabel}`, square_id: squareId });
      } else if (!recordedIsCash && actual) {
        if (recCardTypes.length > 1) {
          detected.set(String(d.id), { kind: 'mixed_tenders', recorded: 'mixed', actual, detail: `Recorded ${recordedLabel} · Square shows ${actualLabel}`, square_id: squareId });
        } else if (recCardTypes[0] !== actual) {
          detected.set(String(d.id), { kind: 'type_mismatch', recorded: recCardTypes[0], actual, detail: `Recorded ${recordedLabel} · Square shows ${actualLabel}`, square_id: squareId });
        }
      } else if (!recordedIsCash && !actual) {
        // no Square payment found — only flag once past the ledger-sync lag
        const delivMs = d?.delivery_date ? new Date(`${String(d.delivery_date).slice(0, 10)}T12:00:00Z`).getTime() : 0;
        if (delivMs && delivMs < lagCutoffMs) {
          detected.set(String(d.id), { kind: 'missing_payment', recorded: recCardTypes.length > 1 ? 'mixed' : recCardTypes[0], actual: null, detail: `Recorded ${recordedLabel} · no payment found on Square`, square_id: null });
        }
      }
      void todayKey;
    }
    // Upsert into CodBadgeChangeLog (action='discrepancy').
    const existingRows = await pagedFilter(b44, 'CodBadgeChangeLog', { action: 'discrepancy' }, '-changed_at', 40).catch(() => []);
    const byDelivRec = new Map(); // delivery_id -> newest record
    for (const r of existingRows || []) {
      if (!r?.delivery_id) continue;
      const prev = byDelivRec.get(String(r.delivery_id));
      if (!prev || String(r?.changed_at || '') > String(prev?.changed_at || '')) byDelivRec.set(String(r.delivery_id), r);
    }
    const patientIds = (codDeliveries || []).map((d) => d?.patient_id).filter(Boolean);
    const discPatientNames = await fetchPatientNames(b44, patientIds);
    for (const d of codDeliveries || []) {
      const id = String(d?.id);
      const det = detected.get(id);
      const prev = byDelivRec.get(id);
      const prevStatus = prev ? String(prev?.status || 'open') : null;
      const cents = Math.round(Number(d?.cod_total_amount_required || 0) * 100);
      const storeName = storeNames.get(String(d?.store_id || '')) || null;
      const patientName = d?.patient_id ? discPatientNames[String(d.patient_id)] || null : null;
      if (!det) {
        // mismatch healed (e.g. confirm already applied) — resolve open rows
        if (prev && (prevStatus === 'open' || prevStatus === 'resolved')) {
          if (prevStatus === 'open') await b44.entities.CodBadgeChangeLog.update(prev.id, { status: 'resolved' }).catch(() => {});
        }
        continue;
      }
      if (prev && (prevStatus === 'confirmed' || prevStatus === 'dismissed')) continue; // owner already handled — never recreate
      const row = {
        changed_at: nowIso,
        action: 'discrepancy',
        detail: det.detail,
        delivery_id: id,
        delivery_ids: [id],
        patient_names: patientName,
        store_name: storeName,
        amount_cents: cents,
        discrepancy_kind: det.kind,
        recorded_type: det.recorded || null,
        actual_type: det.actual,
        square_id: det.square_id,
        status: 'open',
        changed_by_name: 'Square sync (auto)',
      };
      if (prev) {
        const same = String(prev?.detail || '') === det.detail && String(prev?.discrepancy_kind || '') === det.kind && Math.round(Number(prev?.amount_cents || 0)) === cents;
        if (!same) await b44.entities.CodBadgeChangeLog.update(prev.id, row).catch(() => {});
      } else {
        await b44.entities.CodBadgeChangeLog.create(row).catch(() => {});
      }
    }
    // CONCURRENT-RUN HEAL (owner report Oct 10 2026, 221 records with
    // per-delivery duplicates on the first scan): two computes racing (two
    // devices' page loads within the same seconds) both see "no existing
    // record" and double-create the same delivery's flag. Sweep the open
    // rows once more and delete older duplicates per delivery_id (sorted
    // -changed_at, first hit is the newest) — self-heals on every compute.
    const after = await pagedFilter(b44, 'CodBadgeChangeLog', { action: 'discrepancy', status: 'open' }, '-changed_at', 40).catch(() => []);
    const seenOpen = new Set();
    const dupIds = [];
    for (const r of after || []) {
      const k = String(r?.delivery_id || '');
      if (!k) continue;
      if (seenOpen.has(k)) dupIds.push(r.id);
      else seenOpen.add(k);
    }
    for (const id of dupIds) await b44.entities.CodBadgeChangeLog.delete(id).catch(() => {});
  }

  const payload = {
    byLocId: [...byLocId],
    payoutsByLoc: [...payoutsByLocMap],
    storeToLoc: [...storeToLoc],
    weeklyByStore: [...weeklyByStore],
    storeNames: [...storeNames],
    dailyRemainingByStore: [...dailyRemainingByStore],
    codOutstandingDetailed,
    config,
    configRecordId: cfgRecordId,
    deliveryCredits: [...deliveryCredits],
    sales: [],
    payouts: payouts || [],
    savedAt: new Date().toISOString(),
  };
  return { payload, autoRefundedFailed };
}

Deno.serve(async (req) => {
  try {
    const b44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const user = await requireUser(b44);
    const force = !!body?.force;
    const userId = user?.id || null;

    // SERVER-SIDE DEBOUNCE: unless forced, a compute fresher than 90s is
    // returned as-is (page load + Refresh pass force=true; debounced COD
    // delivery events ride the cache) — one compute per change at most.
    if (!force) {
      try {
        const rows = await b44.entities.SquareBalancesSnapshot.list('-version', 10, 0);
        const latest = (rows || []).filter(Boolean).sort((a, b) => Number(b?.version || 0) - Number(a?.version || 0))[0];
        if (latest?.computed_at && Date.now() - new Date(latest.computed_at).getTime() < DEBOUNCE_MS && latest?.payload) {
          return Response.json({ debounced: true, version: Number(latest.version), computed_at: latest.computed_at, computed_by: latest.computed_by || null, payload: latest.payload });
        }
      } catch { /* no snapshot yet / transient — compute */ }
    }

    const { payload, autoRefundedFailed } = await computeSummary(b44, userId);
    const version = Date.now();
    const computed_at = new Date().toISOString();
    return Response.json({
      debounced: false,
      version,
      computed_at,
      computed_by: userId,
      autoRefundedFailed: autoRefundedFailed || [],
      payload,
    });
  } catch (error) {
    const status = error?.status || 500;
    return Response.json({ error: error?.message || 'Internal Server Error' }, { status });
  }
});
