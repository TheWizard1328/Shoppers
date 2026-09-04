// squareCodReconcile — AUTHORITATIVE desired-state reconciler for Square COD catalog items.
//
// DESIGN (Sep 2026 refactor): replaces the scattered client-side create/delete decision
// logic (deleteCODWithTimeout / updateSquareCODIfChanged / cleanupSquareCodCatalogForDate /
// triggerSquareCod* / inline squareCreateCodItem-squareDeleteCodItem calls) with ONE
// backend function that derives the desired state from the authoritative DB record
// (optionally overlaid with caller-supplied cod-field patches for just-written records
// whose DB write hasn't propagated yet) and makes the live Square catalog match.
//
// BUSINESS RULES (single source of truth — confirmed Sep 3, 2026):
// - Once a COD is registered, the store is out of the picture (already paid via Square cards).
// - Drivers collect from patients.
// - CASH collected: item STAYS in the catalog until squareReconcile detects the matching
//   collection transaction (driver deposits cash later). This function NEVER deletes a
//   cash-collected item — that is squareReconcile's sole authority.
// - DEBIT/CREDIT/CHEQUE collected: item must NOT exist (money collected directly).
// - Active delivery + COD > 0: item must exist.
// - failed/cancelled/returned: item must NOT exist.
// - pending/staged (reverted): item must NOT exist.
// - completed with no payment info: item stays (safer — cash-ambiguous, never delete).
//
// MODES:
//  records:   [{ deliveryId, patch? }]  — reconcile specific deliveries (patch = cod-field
//             overrides for records the caller JUST wrote; only cod fields are honored)
//  deletions: [{ deliveryId, reason }]  — force-remove catalog items for deliveries that no
//             longer exist in the DB (hard-deleted deliveries)
//  sweep: true (+ optional deliveryDate, defaults to today Edmonton) — reconcile ALL of the
//             date's COD deliveries + remove bookkeeping orphans for that date
//  dryRun: true — compute planned actions, execute nothing
//
// Self-contained: NO cross-function base44.functions.invoke calls (403 gateway issue).
// Idempotent: calling N times is the same as calling once.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const SB = 'https://connect.squareup.com';
const SV = '2025-01-23';
const MR = 3; const RD = 400;
class HE extends Error { constructor(s, m) { super(m); this.status = s; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nt = (v) => String(v || '').trim();
const irs = (s) => [408, 409, 429, 500, 502, 503, 504].includes(Number(s));
const et = () => { const t = Deno.env.get('SQUARE_ACCESS_TOKEN'); if (!t) throw new HE(500, 'Square not configured'); return t; };
const iei = (v) => /^[a-f0-9]{24}$/i.test(String(v || ''));
// Soft auth: validate when user context is present; allow platform-invoked calls
// (scheduled sweep workflow) that carry no user context.
const ru = async (b) => { const ok = await b.auth.isAuthenticated().catch(() => false); if (!ok) return null; const u = await b.auth.me().catch(() => null); if (!u) throw new HE(401, 'Unauthorized'); return u; };

// ── PAYMENT SEMANTICS — the ONLY place these are defined ──
const CASH_TYPES = ['cash'];
const DIRECT_TYPES = ['debit', 'credit', 'cheque', 'check', 'card'];
const ACTIVE_STATUSES = ['in_transit', 'en_route', 'arrived'];
const REMOVE_STATUSES = ['failed', 'cancelled', 'returned'];

const hasCashPayment = (d) => (Array.isArray(d?.cod_payments) ? d.cod_payments : []).some((p) => CASH_TYPES.includes(String(p?.type || '').toLowerCase()) && Number(p?.amount || 0) > 0);
const hasDirectPayment = (d) => (Array.isArray(d?.cod_payments) ? d.cod_payments : []).some((p) => DIRECT_TYPES.includes(String(p?.type || '').toLowerCase()) && Number(p?.amount || 0) > 0);

// desiredState: 'want' | 'remove' | 'ignore'
const desiredState = (d) => {
  if (!d) return 'ignore';
  const cod = Number(d.cod_total_amount_required || 0);
  const status = String(d.status || '').toLowerCase();
  if (REMOVE_STATUSES.includes(status)) return 'remove';
  if (ACTIVE_STATUSES.includes(status)) {
    if (cod <= 0) return 'remove';
    // Payment evidence beats status: cash collected while active = item stays
    // (driver deposits later); debit/credit/cheque collected while active =
    // money taken directly = item must not exist.
    if (hasCashPayment(d)) return 'want';
    if (hasDirectPayment(d)) return 'remove';
    return 'want';
  }
  if (status === 'completed') {
    if (cod <= 0) return 'remove';
    if (hasCashPayment(d)) return 'want';
    if (hasDirectPayment(d)) return 'remove';
    return 'want'; // no payment info yet — never delete cash-ambiguous items
  }
  if (status === 'pending' || status === 'staged') return cod > 0 ? 'remove' : 'ignore';
  return 'ignore';
};

// Only these caller patch fields are honored (exact cod decision inputs + identity fields
// needed to resolve the item name when the DB record isn't visible yet).
const PATCH_FIELDS = ['status', 'cod_total_amount_required', 'cod_payments', 'cod_payment_type', 'patient_name', 'delivery_date', 'store_id'];
const applyPatch = (d, patch) => { if (!patch) return d; const p = {}; for (const k of PATCH_FIELDS) if (patch[k] !== undefined) p[k] = patch[k]; return { ...d, ...p }; };

const getEdmDate = () => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t)?.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
};

async function sf(path, method, token, body) {
  let le = null;
  for (let a = 1; a <= MR; a++) {
    try {
      const r = await fetch(`${SB}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Square-Version': SV }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); const j = t ? JSON.parse(t) : {};
      if (!r.ok) { const m = j?.errors?.map((e) => e.detail).join(', ') || `Square API error ${r.status}`; le = new HE(r.status, m); if (a < MR && irs(r.status)) { await sleep(RD * a); continue; } throw le; }
      return j;
    } catch (e) { le = e; if (a < MR && irs(e?.status)) { await sleep(RD * a); continue; } throw le; }
  }
  throw le || new Error('Square API failed');
}

async function sdo(id, token) {
  if (!id) return { attempted: false, ok: false };
  let lf = null;
  for (let a = 1; a <= MR; a++) {
    try {
      const r = await fetch(`${SB}/v2/catalog/object/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Square-Version': SV } });
      if (r.ok || r.status === 404 || r.status === 409) return { attempted: true, ok: true, status: r.status };
      lf = { attempted: true, ok: false, status: r.status };
      if (a < MR && irs(r.status)) { await sleep(RD * a); continue; }
      return lf;
    } catch (e) { lf = { attempted: true, ok: false, error: e?.message }; if (a < MR) { await sleep(RD * a); continue; } return lf; }
  }
  return lf || { attempted: true, ok: false };
}

async function lc(token) {
  const o = []; let c;
  do {
    const j = await sf('/v2/catalog/search', 'POST', token, { object_types: ['ITEM'], include_deleted_objects: false, archived_state: 'ARCHIVED_STATE_NOT_ARCHIVED', limit: 1000, cursor: c });
    o.push(...(j.objects || [])); c = j.cursor; if (c) await sleep(150);
  } while (c);
  return o;
}

// Map live catalog items by EXACT delivery id extracted from the description tail
// (`COD for {patient} | Delivery {id}`). Exact-match extraction — no substring includes(),
// so one delivery id can never match another's item.
const extractDeliveryId = (desc) => { const m = String(desc || '').match(/Delivery\s+([A-Za-z0-9_-]+)\s*$/i); return m ? m[1] : null; };
const catalogMapByDeliveryId = (items) => {
  const m = new Map();
  for (const it of items || []) {
    const did = extractDeliveryId(it?.item_data?.description);
    if (did && !m.has(did)) m.set(did, it);
  }
  return m;
};

const formatItemName = (deliveryDate, storeAbbreviation, patientName) => {
  const [, month, day] = String(deliveryDate || '').split('-');
  return `${(month || '00').padStart(2, '0')}/${(day || '00').padStart(2, '0')}(${nt(storeAbbreviation) || 'NA'})-${nt(patientName) || 'Unknown Patient'}`;
};

const itemPriceCents = (it) => {
  const v = (it?.item_data?.variations || [])[0];
  return Number(v?.item_variation_data?.price_money?.amount || 0);
};

async function resolvePatientName(b44, delivery) {
  const ref = nt(delivery?.patient_id);
  let name = nt(delivery?.patient_name);
  if (!ref && name) return name || 'Unknown Patient';
  if (ref) {
    let p = null;
    if (iei(ref)) p = await b44.asServiceRole.entities.Patient.get(ref).catch(() => null);
    if (!p) { const ms = await b44.asServiceRole.entities.Patient.filter({ patient_id: ref }, '-updated_date', 1).catch(() => []); p = Array.isArray(ms) ? ms[0] : null; }
    if (p?.full_name) name = nt(p.full_name);
  }
  if (!name || name === 'COD' || name === 'Unknown Patient') name = `Delivery ${String(delivery?.id || '').slice(-6)}`;
  return name;
}

async function getStoreCtx(b44, storeId) {
  if (!storeId) throw new HE(400, 'Store ID required');
  const store = await b44.asServiceRole.entities.Store.get(storeId).catch(() => null);
  if (!store) throw new HE(400, `Store not found: ${storeId}`);
  if (!store.square_location_config_id) throw new HE(400, `Store "${store.name}" not configured for Square COD`);
  const cfg = await b44.asServiceRole.entities.SquareLocationConfig.get(store.square_location_config_id).catch(() => null);
  if (!cfg) throw new HE(400, `Square config not found for store "${store.name}"`);
  if (cfg.status !== 'active') throw new HE(400, `Square location "${cfg.name}" inactive for store "${store.name}"`);
  return { store, locationId: cfg.square_location_id };
}

// ── BOOKKEEPING (mirrors the legacy handleCreateCodItem/handleDeleteCodItem records) ──
async function upsertBookkeeping(b44, { delivery, catalogId, catalogVersion, itemName, amountCents, locationId }) {
  const tp = {
    square_catalog_object_id: catalogId, square_catalog_version: catalogVersion, item_name: itemName,
    amount: amountCents / 100, amount_cents: amountCents, patient_id: delivery?.patient_id || null,
    store_id: delivery?.store_id || null, location_id: locationId || null
  };
  const exTx = await b44.asServiceRole.entities.SquareTransaction.filter({ delivery_id: delivery.id, status: 'pending' }).catch(() => []);
  const tx = exTx.length > 0
    ? await b44.asServiceRole.entities.SquareTransaction.update(exTx[0].id, tp).catch(() => null)
    : await b44.asServiceRole.entities.SquareTransaction.create({ ...tp, type: 'collection', status: 'pending', delivery_id: delivery.id }).catch(() => null);
  const exCat = await b44.asServiceRole.entities.SquareCatalogItems.filter({ delivery_id: delivery.id }).catch(() => []);
  const cp = {
    square_catalog_object_id: catalogId, square_catalog_version: catalogVersion, item_name: itemName,
    description: '', amount: amountCents / 100, amount_cents: amountCents, delivery_id: delivery.id,
    delivery_date: delivery.delivery_date || null, patient_id: delivery?.patient_id || null,
    store_id: delivery?.store_id || null, location_id: locationId || null, status: 'active'
  };
  if (exCat.length > 0) await b44.asServiceRole.entities.SquareCatalogItems.update(exCat[0].id, cp).catch(() => null);
  else await b44.asServiceRole.entities.SquareCatalogItems.create(cp).catch(() => null);
  return tx?.id || exTx[0]?.id || null;
}

async function removeBookkeeping(b44, deliveryId, reason, ns) {
  const dts = await b44.asServiceRole.entities.SquareTransaction.filter({ delivery_id: deliveryId }, '-updated_date', 50).catch(() => []);
  for (let i = 0; i < (dts || []).length; i += 10) {
    await Promise.all((dts || []).slice(i, i + 10).map((tx) =>
      b44.asServiceRole.entities.SquareTransaction.update(tx.id, { status: ns, raw_square_data: { ...(tx.raw_square_data || {}), deleted_at: new Date().toISOString(), deleted_reason: reason || 'reconcile_remove' } }).catch(() => null)));
    if (i + 10 < (dts || []).length) await sleep(50);
  }
  const cats = await b44.asServiceRole.entities.SquareCatalogItems.filter({ delivery_id: deliveryId }, '-updated_date', 50).catch(() => []);
  for (let i = 0; i < (cats || []).length; i += 10) {
    await Promise.all((cats || []).slice(i, i + 10).map((x) => b44.asServiceRole.entities.SquareCatalogItems.delete(x.id).catch(() => null)));
    if (i + 10 < (cats || []).length) await sleep(50);
  }
  return { transactions: (dts || []).length, catalogRecords: (cats || []).length };
}

Deno.serve(async (req) => {
  const started = Date.now();
  try {
    const b = createClientFromRequest(req);
    await ru(b);
    const payload = await req.json().catch(() => ({}));
    const dryRun = payload?.dryRun === true;
    const token = et();
    const results = [];
    const log = (...a) => console.log('[squareCodReconcile]', ...a);

    // ── Build the work list ──────────────────────────────────────────────
    const wants = [];   // [{ deliveryId, delivery }]
    const removes = []; // [{ deliveryId, reason }]
    const recordIds = new Set();

    // Mode A: explicit records
    for (const r of (Array.isArray(payload?.records) ? payload.records : [])) {
      const did = nt(r?.deliveryId); if (!did || recordIds.has(did)) continue; recordIds.add(did);
      let getErr = null;
      let d = await b.asServiceRole.entities.Delivery.get(did).catch((e) => { getErr = e?.message || String(e); return null; });
      if (getErr) results.push({ deliveryId: did, action: 'noop', status: 'error', error: `db_get: ${getErr}` });
      d = d ? applyPatch(d, r?.patch) : (r?.patch ? applyPatch({ id: did }, r?.patch) : null);
      const ds = desiredState(d);
      if (ds === 'want') wants.push({ deliveryId: did, delivery: d });
      else if (ds === 'remove') removes.push({ deliveryId: did, reason: r?.reason || `status_${d?.status || 'unknown'}` });
      else results.push({ deliveryId: did, action: 'noop', status: 'skipped', reason: `desired_state_${ds}` });
    }

    // Mode B: force deletions (hard-deleted deliveries)
    for (const r of (Array.isArray(payload?.deletions) ? payload.deletions : [])) {
      const did = nt(r?.deliveryId || r); if (!did || recordIds.has(did)) continue; recordIds.add(did);
      removes.push({ deliveryId: did, reason: r?.reason || 'delivery_deleted' });
    }

    // Mode C: sweep — all COD deliveries for a date + bookkeeping orphans
    if (payload?.sweep) {
      const date = nt(payload?.deliveryDate) || getEdmDate();
      const dayDeliveries = await b.asServiceRole.entities.Delivery.filter({ delivery_date: date }, undefined, 500).catch(() => []);
      for (const d of dayDeliveries || []) {
        const did = d?.id; if (!did || recordIds.has(did)) continue; recordIds.add(did);
        const ds = desiredState(d);
        if (ds === 'want') wants.push({ deliveryId: did, delivery: d });
        else if (ds === 'remove') removes.push({ deliveryId: did, reason: `status_${d.status}` });
        // 'ignore' → no bookkeeping work expected; orphans handled below
      }
      // Orphan sweep: bookkeeping records for this date whose delivery isn't in the work list
      const dayCats = await b.asServiceRole.entities.SquareCatalogItems.filter({ delivery_date: date }, '-updated_date', 200).catch(() => []);
      for (const c of dayCats || []) {
        const did = c?.delivery_id; if (!did || recordIds.has(did)) continue; recordIds.add(did);
        removes.push({ deliveryId: did, reason: 'sweep_orphan_no_want_state' });
      }
      log(`sweep ${date}: ${wants.length} want, ${removes.length} remove`);
    }

    if (!wants.length && !removes.length) {
      return Response.json({ success: true, processed: 0, results });
    }

    // ── Resolve existing catalog items (ONE live-catalog pass, cached) ───
    let catMap = null;
    const getCatMap = async () => { if (!catMap) catMap = catalogMapByDeliveryId(await lc(token)); return catMap; };

    // Bookkeeping-first lookup: avoids the full catalog scan when records exist.
    const resolveExistingObjectId = async (deliveryId) => {
      const cats = await b.asServiceRole.entities.SquareCatalogItems.filter({ delivery_id: deliveryId }, '-updated_date', 1).catch(() => []);
      if (cats?.length && cats[0]?.square_catalog_object_id) return cats[0].square_catalog_object_id;
      const txs = await b.asServiceRole.entities.SquareTransaction.filter({ delivery_id: deliveryId }, '-updated_date', 1).catch(() => []);
      if (txs?.length && txs[0]?.square_catalog_object_id) return txs[0].square_catalog_object_id;
      return null;
    };

    // ── REMOVES ──────────────────────────────────────────────────────────
    for (const r of removes) {
      try {
        let catId = await resolveExistingObjectId(r.deliveryId);
        let existedLive = false;
        if (!dryRun && catId) {
          // Verify the object still exists (bookkeeping may be stale)
          const ej = await sf(`/v2/catalog/object/${catId}`, 'GET', token, null).catch((e) => ({ _err: e }));
          if (ej?._err || !ej?.object) catId = null;
        }
        if (!catId) {
          const m = await getCatMap();
          catId = m.get(r.deliveryId)?.id || null;
          existedLive = !!catId;
        }
        if (dryRun) { results.push({ deliveryId: r.deliveryId, action: 'remove', status: 'planned', reason: r.reason, catalogObjectId: catId }); continue; }
        const del = catId ? await sdo(catId, token) : { attempted: false, ok: true };
        const bk = await removeBookkeeping(b, r.deliveryId, r.reason, r.reason === 'failed' ? 'failed' : 'cancelled');
        results.push({ deliveryId: r.deliveryId, action: 'remove', status: 'ok', reason: r.reason, catalogObjectId: catId, squareDeleted: !!del?.ok, foundViaCatalogScan: existedLive, ...bk });
      } catch (e) {
        results.push({ deliveryId: r.deliveryId, action: 'remove', status: 'error', error: e?.message || 'remove failed' });
      }
    }

    // ── WANTS ────────────────────────────────────────────────────────────
    const toCreate = [];
    for (const w of wants) {
      try {
        const d = w.delivery;
        const { store, locationId } = await getStoreCtx(b, d.store_id);
        const patientName = await resolvePatientName(b, d);
        const amountCents = Math.max(0, Math.round(Number(d.cod_total_amount_required || 0) * 100));
        const iname = formatItemName(d.delivery_date, store?.abbreviation, patientName);
        // Fast path: bookkeeping → verify live object directly
        let catId = await resolveExistingObjectId(d.id);
        let existing = null;
        if (catId) {
          const ej = await sf(`/v2/catalog/object/${catId}`, 'GET', token, null).catch(() => null);
          existing = ej?.object || null;
          if (!existing) catId = null; // stale bookkeeping — fall through to scan/create
        }
        if (!existing) {
          const m = await getCatMap();
          existing = m.get(d.id) || null;
          catId = existing?.id || null;
        }
        if (existing && nt(existing?.item_data?.name) === iname && itemPriceCents(existing) === amountCents) {
          if (!dryRun) { const txId = await upsertBookkeeping(b, { delivery: d, catalogId: existing.id, catalogVersion: existing.version, itemName: iname, amountCents, locationId }); }
          results.push({ deliveryId: d.id, action: 'noop', status: 'ok', reason: 'item_current', catalogObjectId: existing.id });
        } else if (existing) {
          if (dryRun) { results.push({ deliveryId: d.id, action: 'update', status: 'planned', catalogObjectId: existing.id, itemName: iname, amountCents }); continue; }
          const u = await updateExistingItem({ token, existing, itemName: iname, amountCents, locationId, deliveryId: d.id, patientName });
          const txId = await upsertBookkeeping(b, { delivery: d, catalogId: u?.id || existing.id, catalogVersion: u?.version || existing.version, itemName: iname, amountCents, locationId });
          results.push({ deliveryId: d.id, action: 'update', status: 'ok', catalogObjectId: u?.id || existing.id, transactionId: txId });
        } else {
          toCreate.push({ delivery: d, itemName: iname, amountCents, locationId, patientName, storeId: d.store_id });
        }
      } catch (e) {
        results.push({ deliveryId: w.deliveryId, action: 'want', status: 'error', error: e?.message || 'want failed' });
      }
    }

    // ── BATCH CREATE (single batch-upsert for all missing items) ─────────
    if (toCreate.length > 0) {
      const objects = toCreate.map((c) => ({
        type: 'ITEM', id: `#item-${c.delivery.id}`, present_at_all_locations: false,
        present_at_location_ids: c.locationId ? [c.locationId] : [],
        item_data: {
          name: c.itemName, description: `COD for ${c.patientName} | Delivery ${c.delivery.id}`,
          is_taxable: true, product_type: 'REGULAR',
          variations: [{ type: 'ITEM_VARIATION', id: `#variation-${c.delivery.id}`, present_at_all_locations: false, present_at_location_ids: c.locationId ? [c.locationId] : [], item_variation_data: { name: 'Default', pricing_type: 'FIXED_PRICING', price_money: { amount: c.amountCents, currency: 'CAD' }, sellable: true, stockable: true } }]
        }
      }));
      if (dryRun) {
        for (const c of toCreate) results.push({ deliveryId: c.delivery.id, action: 'create', status: 'planned', itemName: c.itemName, amountCents: c.amountCents });
      } else {
        for (let i = 0; i < objects.length; i += 100) {
          const chunk = objects.slice(i, i + 100);
          try {
            const j = await sf('/v2/catalog/batch-upsert', 'POST', token, { idempotency_key: crypto.randomUUID(), batches: [{ objects: chunk }] });
            const created = j?.objects || [];
            const byTmp = new Map(created.map((o) => [o.id, o]));
            for (const c of toCreate.slice(i, i + 100)) {
              // batch-upsert returns assigned ids; match by our temp id suffix
              const obj = created.find((o) => o?.id && String(o.id).length > 0 && o?.item_data?.description?.includes(c.delivery.id)) || byTmp.get(`#item-${c.delivery.id}`);
              const txId = await upsertBookkeeping(b, { delivery: c.delivery, catalogId: obj?.id || null, catalogVersion: obj?.version || null, itemName: c.itemName, amountCents: c.amountCents, locationId: c.locationId });
              results.push({ deliveryId: c.delivery.id, action: 'create', status: obj?.id ? 'ok' : 'ok_bookkeeping_only', catalogObjectId: obj?.id || null, transactionId: txId });
            }
          } catch (e) {
            for (const c of toCreate.slice(i, i + 100)) results.push({ deliveryId: c.delivery.id, action: 'create', status: 'error', error: e?.message || 'batch create failed' });
          }
        }
      }
    }

    const errors = results.filter((r) => r.status === 'error');
    log(`done in ${Date.now() - started}ms — ${results.length} results, ${errors.length} errors`);
    return Response.json({ success: errors.length === 0, processed: results.length, errors: errors.length, results });
  } catch (error) {
    console.error('[squareCodReconcile] FATAL:', error?.message || error);
    return Response.json({ error: error?.message || 'Error' }, { status: error?.status || 500 });
  }
});

// Update an existing item in place (name/amount/location); falls back to create if gone.
async function updateExistingItem({ token, existing, itemName, amountCents, locationId, deliveryId, patientName }) {
  const evs = existing?.item_data?.variations || [];
  const pl = locationId ? [locationId] : [];
  const uv = evs.length > 0 ? evs.map((v) => ({ type: 'ITEM_VARIATION', id: v.id, version: v.version, present_at_all_locations: false, present_at_location_ids: pl, item_variation_data: { ...v.item_variation_data, name: 'Default', pricing_type: 'FIXED_PRICING', price_money: { amount: amountCents, currency: 'CAD' } } })) : [{ type: 'ITEM_VARIATION', id: `#variation-${deliveryId}`, present_at_all_locations: false, present_at_location_ids: pl, item_variation_data: { name: 'Default', pricing_type: 'FIXED_PRICING', price_money: { amount: amountCents, currency: 'CAD' }, sellable: true, stockable: true } }];
  const j = await sf('/v2/catalog/batch-upsert', 'POST', token, { idempotency_key: crypto.randomUUID(), batches: [{ objects: [{ type: 'ITEM', id: existing.id, version: existing.version, present_at_all_locations: false, present_at_location_ids: pl, item_data: { name: itemName, description: `COD for ${patientName} | Delivery ${deliveryId}`, is_taxable: true, product_type: 'REGULAR', variations: uv } }] }] });
  return (j.objects || []).find((o) => o.type === 'ITEM') || null;
}
