import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * codCardReversal — owner rule (Nov 18 2026, Londonderry $10.50):
 *
 * "if a cod to collect is removed from a delivery or that delivery with a cod
 *  to collect is deleted, the amount of that cod needs to be added back to the
 *  card balance"
 *
 * A COD created after the last true-up is DEDUCTED from the store card estimate
 * by default (the card is presumed charged for the prescription). That
 * deduction is derived from the delivery record, so deleting the delivery (or
 * clearing its COD) silently drops the deduction while the physical card
 * already paid the money out — the card then reads short by exactly that COD,
 * with no row in Payment Discrepancies or Card Transfer to explain it.
 *
 * This appends a durable signed adjustment to AppSettings 'square_balances'
 * (card_adjustments[]) which the balance compute adds back per location.
 * Runs as the SERVICE ROLE so a delete by any role records the reversal.
 *
 * Idempotent per (delivery_id, kind, location_id).
 *
 * POST { deliveryId, storeId, amountCents, patientName?, kind? }
 *   kind: 'delivery_deleted' | 'cod_removed'
 * Only writes when the COD was really being deducted: delivery created at/after
 * trued_up_at, or a cod_card_spend_at at/after it.
 */

const SETTING_KEY = 'square_balances';

const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const body = await req.json().catch(() => ({}));
    const deliveryId = body?.deliveryId ? String(body.deliveryId) : null;
    const kind = String(body?.kind || 'cod_removed');
    let storeId = body?.storeId ? String(body.storeId) : null;
    let amountCents = Math.round(Number(body?.amountCents || 0));
    let patientName = body?.patient_name || body?.patientName || null;
    let createdAt = body?.createdDate ? String(body.createdDate) : null;
    let spendAt = body?.codCardSpendAt ? String(body.codCardSpendAt) : null;

    // Authoritative read when the record still exists (COD-cleared edits).
    if (deliveryId) {
      const live = await base44.asServiceRole.entities.Delivery.get(deliveryId).catch(() => null);
      if (live) {
        storeId = storeId || (live?.store_id ? String(live.store_id) : null);
        patientName = patientName || live?.patient_name || null;
        createdAt = createdAt || live?.created_date || null;
        spendAt = spendAt || live?.cod_card_spend_at || null;
        if (!(amountCents > 0)) amountCents = Math.round(Number(live?.cod_total_amount_required || 0) * 100);
      }
    }
    if (!(amountCents > 0)) return json({ success: true, skipped: 'no_amount' });

    const rows = await base44.asServiceRole.entities.AppSettings.filter({ setting_key: SETTING_KEY }, '-updated_date', 1);
    const row = Array.isArray(rows) ? rows[0] : (rows as any)?.items?.[0];
    if (!row?.id) return json({ success: false, skipped: 'no_config' });
    const config = { ...(row?.setting_value || {}) };

    // Only reverse a deduction that was really applied.
    const tuMs = config?.trued_up_at ? new Date(config.trued_up_at).getTime() : null;
    if (tuMs == null) return json({ success: true, skipped: 'no_true_up' });
    const createdMs = createdAt ? new Date(createdAt).getTime() : null;
    const spendMs = spendAt ? new Date(spendAt).getTime() : null;
    const deducted = (createdMs != null && Number.isFinite(createdMs) && createdMs >= tuMs)
      || (spendMs != null && Number.isFinite(spendMs) && spendMs >= tuMs);
    if (!deducted) return json({ success: true, skipped: 'not_deducted' });

    // store -> square location
    let locationId: string | null = null;
    if (storeId) {
      const store = await base44.asServiceRole.entities.Store.get(storeId).catch(() => null);
      const cfgId = store?.square_location_config_id ? String(store.square_location_config_id) : null;
      if (cfgId) {
        const locCfg = await base44.asServiceRole.entities.SquareLocationConfig.get(cfgId).catch(() => null);
        locationId = locCfg?.square_location_id ? String(locCfg.square_location_id) : null;
      }
    }
    if (!locationId) return json({ success: false, skipped: 'no_location' });

    const list = Array.isArray(config.card_adjustments) ? [...config.card_adjustments] : [];
    const dupe = list.some((a: any) => String(a?.delivery_id || '') === String(deliveryId || '')
      && String(a?.kind || '') === kind
      && String(a?.location_id || '') === String(locationId));
    if (dupe) return json({ success: true, skipped: 'duplicate' });

    list.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      location_id: locationId,
      store_id: storeId,
      delivery_id: deliveryId,
      patient_name: patientName,
      amount_cents: amountCents,
      kind,
      reason: `COD ${kind === 'delivery_deleted' ? 'removed with deleted delivery' : 'removed'} — added back to the card`,
      at: new Date().toISOString(),
      recorded_by: user?.email || null,
    });
    config.card_adjustments = list;
    await base44.asServiceRole.entities.AppSettings.update(row.id, { setting_value: config });

    return json({ success: true, added_cents: amountCents, location_id: locationId, kind });
  } catch (error) {
    return json({ error: (error as any)?.message || String(error) }, 500);
  }
});
