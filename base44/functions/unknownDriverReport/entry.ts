import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * READ-ONLY admin report: payable deliveries whose driver_id does not resolve to
 * an AppUser (the "Unknown Driver" bucket in Admin Metrics -> Driver Breakdown).
 *
 * Request body:
 *   year    - report year (default: current year)
 *   offset  - row offset for paging (default 0)
 *   limit   - rows to return; 0 = summary only (default 100)
 */
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const roles = Array.isArray(user.app_roles) ? user.app_roles : [];
    const isAdmin = user.role === 'admin' || roles.includes('admin') || roles.includes('dispatcher');
    if (!isAdmin) return Response.json({ error: 'Forbidden' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const year = Number(body.year) || new Date().getFullYear();
    const offset = Math.max(0, Number(body.offset) || 0);
    const limit = body.limit === 0 ? 0 : Math.min(300, Number(body.limit) || 100);

    const sr = base44.asServiceRole.entities;
    const appUsers = await sr.AppUser.list('-created_date', 1000, 0).catch(() => []);
    const validIds = new Set((appUsers || []).map((a) => a.user_id).filter(Boolean));
    const stores = await sr.Store.list('-created_date', 500, 0).catch(() => []);
    const storeLabel = new Map((stores || []).map((s) => [s.id, s.abbreviation || s.name || s.id]));

    const prefix = `${year}-`;
    const rows = [];
    let skip = 0;
    const pageSize = 500;

    while (true) {
      const page = await sr.Delivery.list('-delivery_date', pageSize, skip);
      const items = page?.items || page || [];
      if (!items.length) break;
      let leftYear = false;
      for (const d of items) {
        const dd = String(d.delivery_date || '');
        if (dd && dd < prefix) { leftYear = true; break; }
        if (!dd.startsWith(prefix)) continue;
        const driverId = String(d.driver_id || '');
        if (!driverId || validIds.has(driverId)) continue;
        const status = String(d.status || '');
        const payable = d.after_hours_pickup === true
          ? (status === 'completed' || status === 'cancelled')
          : (status === 'completed' || status === 'failed');
        if (!payable) continue;
        const payments = Array.isArray(d.cod_payments) ? d.cod_payments : [];
        const collected = payments.reduce((sum, p) => sum + (Number(p?.amount) || 0), 0);
        rows.push([
          dd,
          String(d.actual_delivery_time || '').replace('T', ' ').slice(0, 16),
          storeLabel.get(d.store_id) || '',
          driverId,
          (Number(d.cod_total_amount_required) || 0).toFixed(2),
          collected.toFixed(2),
          d.cod_payment_type || '',
          status,
        ]);
      }
      if (leftYear || items.length < pageSize) break;
      skip += pageSize;
      if (skip > 80000) break;
    }

    const idCounts = {};
    for (const r of rows) idCounts[r[3]] = (idCounts[r[3]] || 0) + 1;
    const slice = limit === 0 ? [] : rows.slice(offset, offset + limit);

    return Response.json({
      year,
      total: rows.length,
      by_driver_id: idCounts,
      offset,
      returned: slice.length,
      next_offset: offset + slice.length < rows.length ? offset + slice.length : null,
      rows: slice,
    });
  } catch (error) {
    return Response.json({ error: error?.message || String(error) }, { status: 500 });
  }
}
