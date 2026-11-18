import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * repairInterStoreDeliveryIds (owner rule Nov 17 2026)
 *
 * "Whatever is changing ISD/ISP to DID, remove it."
 *
 * Some inter-store legs were saved with a plain DID- delivery_id. The prefix is
 * what marks a stop as a PAID inter-store delivery (payroll, admin metrics,
 * dashboard stats, marker type, Edit-InterStore lookups), so a mangled id makes
 * the stop read as an unpaid store pickup.
 *
 * - dryRun (default true): report only.
 * - dryRun=false: rewrite those ids to ISD-/ISP-, chosen from the record's own
 *   interstore markers and notes. Only records with NO patient_id and clear
 *   inter-store evidence are touched.
 */
const looksInterStore = (d: any) => {
  if (!d) return false;
  if (String(d.patient_id || '').trim()) return false;
  const id = String(d.delivery_id || '').toUpperCase();
  if (id.startsWith('ISD-') || id.startsWith('ISP-')) return true;
  const notes = String(d.delivery_notes || '').toLowerCase();
  if (notes.includes('interstore') || notes.includes('inter-store') || notes.includes('inter store')) return true;
  return !!(d.interstore_dest_id || d._interstore_dest_id || d.interstore_source_id || d._interstore_source_id);
};

const prefixFor = (d: any) => {
  const kind = String(d?._interstore_stop_type || '').toLowerCase();
  if (kind === 'dropoff' || kind === 'drop-off') return 'ISD';
  if (kind === 'pickup') return 'ISP';
  const notes = String(d?.delivery_notes || '').toLowerCase();
  if (/drop\s*-?\s*off/.test(notes)) return 'ISD';
  if (/pick\s*-?\s*up/.test(notes)) return 'ISP';
  return String(d?.delivery_id || '').toUpperCase().startsWith('ISP') ? 'ISP' : 'ISD';
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dryRun !== false;
    const maxPages = Math.min(Number(body?.maxPages) || 40, 120);

    const damaged: any[] = [];
    let scanned = 0;
    let skip = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const rows = await base44.asServiceRole.entities.Delivery.list('-created_date', 500, skip).catch(() => []);
      const list = Array.isArray(rows) ? rows : (rows?.items || []);
      if (!list.length) break;
      scanned += list.length;
      for (const d of list) {
        const id = String(d?.delivery_id || '').toUpperCase();
        if (!id.startsWith('DID-')) continue;
        if (!looksInterStore(d)) continue;
        damaged.push({ id: d.id, delivery_id: d.delivery_id, delivery_date: d.delivery_date, status: d.status, notes: String(d.delivery_notes || ''), _interstore_stop_type: d._interstore_stop_type || d.interstore_stop_type || null.slice(0, 60) });
      }
      if (list.length < 500) break;
      skip += 500;
    }

    const repaired: any[] = [];
    if (!dryRun) {
      for (const rec of damaged) {
        // prefixFor must see the record's own evidence (stop type + notes), not
        // just the trimmed report row — otherwise every repair defaults to ISD
        // and an inter-store PICKUP comes back as a drop-off.
        const newId = `${prefixFor({ ...rec, delivery_notes: rec.notes })}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
        try {
          await base44.asServiceRole.entities.Delivery.update(String(rec.id), { delivery_id: newId });
          repaired.push({ id: rec.id, from: rec.delivery_id, to: newId });
        } catch (e) {
          repaired.push({ id: rec.id, from: rec.delivery_id, error: String((e as any)?.message || e) });
        }
      }
    }

    return Response.json({ success: true, dryRun, scanned, damagedCount: damaged.length, damaged: damaged.slice(0, 50), repaired: repaired.slice(0, 50) });
  } catch (error) {
    return Response.json({ error: (error as any)?.message || String(error) }, { status: 500 });
  }
});
