// Self-contained Square COD batch sync — calls squareCreateCodItem/squareDeleteCodItem directly
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

class HE extends Error { constructor(s, m) { super(m); this.status = s; } }
const nt = (v) => String(v || '').trim();
const ru = async (b) => { const u = await b.auth.me().catch(() => null); if (!u) throw new HE(401, 'Unauthorized'); return u; };

function hasOfflinePayment(d) { return (Array.isArray(d?.cod_payments) ? d.cod_payments : []).some((p) => ['cash', 'check', 'other'].includes(String(p?.type || '').toLowerCase()) && Number(p?.amount || 0) > 0); }
function hasCardPayment(d) { return (Array.isArray(d?.cod_payments) ? d.cod_payments : []).some((p) => ['Debit', 'Credit'].includes(p?.type) && Number(p?.amount || 0) > 0); }

Deno.serve(async (req) => {
  try {
    const b = createClientFromRequest(req);
    await ru(b);
    const payload = await req.json().catch(() => ({}));

    // Event-driven sync (from entity trigger)
    const event = payload?.event;
    if (event?.entity_name === 'Delivery') {
      const delivery = payload?.data || await b.asServiceRole.entities.Delivery.get(event.entity_id).catch(() => null);
      if (!delivery || Number(delivery?.cod_total_amount_required || 0) <= 0) return Response.json({ success: true, processed: 0, results: [{ deliveryId: event?.entity_id, action: 'noop', status: 'skipped' }] });
      const oldStatus = nt(payload?.old_data?.status); const newStatus = nt(delivery.status);
      try {
        if (newStatus === 'failed' || newStatus === 'cancelled') {
          const r = await b.functions.invoke('squareDeleteCodItem', { deliveryId: delivery.id, reason: newStatus });
          return Response.json({ success: true, processed: 1, results: [{ deliveryId: delivery.id, action: 'delete', status: 'ok', result: r }] });
        }
        if (newStatus === 'completed' && (hasOfflinePayment(delivery) || hasCardPayment(delivery))) {
          const r = await b.functions.invoke('squareDeleteCodItem', { deliveryId: delivery.id, reason: hasOfflinePayment(delivery) ? 'offline_payment_collected' : 'card_payment_collected' });
          return Response.json({ success: true, processed: 1, results: [{ deliveryId: delivery.id, action: 'delete', status: 'ok', result: r }] });
        }
        const wasActive = oldStatus === 'in_transit' || oldStatus === 'en_route';
        if (newStatus === 'pending' && wasActive) {
          const r = await b.functions.invoke('squareDeleteCodItem', { deliveryId: delivery.id, reason: 'reverted_to_pending' });
          return Response.json({ success: true, processed: 1, results: [{ deliveryId: delivery.id, action: 'delete', status: 'ok', result: r }] });
        }
        const isNowActive = newStatus === 'in_transit' || newStatus === 'en_route';
        if (isNowActive) {
          const r = await b.functions.invoke('squareCreateCodItem', { deliveryId: delivery.id, codAmount: delivery.cod_total_amount_required, deliveryDate: delivery.delivery_date, storeId: delivery.store_id, patientName: delivery.patient_name });
          return Response.json({ success: true, processed: 1, results: [{ deliveryId: delivery.id, action: 'upsert', status: r?.skipped ? 'skipped' : 'ok', result: r }] });
        }
        return Response.json({ success: true, processed: 1, results: [{ deliveryId: delivery.id, action: 'noop', status: 'skipped', reason: `no_action_${oldStatus}_to_${newStatus}` }] });
      } catch (error) {
        return Response.json({ success: false, processed: 1, results: [{ deliveryId: delivery.id, action: 'sync', status: 'error', error: error?.message || 'Failed' }] });
      }
    }

    // Batch mode: process items array
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const deletions = Array.isArray(payload?.deletions) ? payload.deletions : [];
    if (!items.length && !deletions.length) return Response.json({ success: true, processed: 0, results: [] });

    const results = [];
    for (const del of deletions) {
      try {
        const r = await b.functions.invoke('squareDeleteCodItem', { deliveryId: del?.deliveryId, catalogObjectId: del?.catalogObjectId, transactionId: del?.transactionId, reason: del?.status === 'failed' ? 'failed' : del?.reason });
        results.push({ deliveryId: del?.deliveryId, action: 'delete', status: 'ok', result: r });
      } catch (error) {
        results.push({ deliveryId: del?.deliveryId, action: 'delete', status: 'error', error: error?.message || 'Delete failed' });
      }
    }
    for (const item of items) {
      try {
        const r = await b.functions.invoke('squareCreateCodItem', { deliveryId: item?.deliveryId, patientName: item?.patientName, storeAbbreviation: item?.storeAbbreviation, codAmount: item?.codAmount, deliveryDate: item?.deliveryDate, storeId: item?.storeId });
        results.push({ deliveryId: item?.deliveryId, action: 'upsert', status: r?.skipped ? 'skipped' : 'ok', result: r });
      } catch (error) {
        results.push({ deliveryId: item?.deliveryId, action: 'upsert', status: 'error', error: error?.message || 'Upsert failed' });
      }
    }
    return Response.json({ success: !results.some((e) => e.status === 'error'), processed: results.length, results });
  } catch (error) {
    return Response.json({ error: error?.message || 'Error' }, { status: error?.status || 500 });
  }
});
