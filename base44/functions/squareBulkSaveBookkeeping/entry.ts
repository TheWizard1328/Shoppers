// ── squareBulkSaveBookkeeping ──────────────────────────────────────
// OFFLINE-FIRST mirror (owner spec, Sep 27 2026): the client writes its
// OFFLINE DB first, updates the UI, then hands the complete catalog set +
// the current push's transaction payloads to THIS single invocation, which
// mirrors them to the online DB. Replaces the per-item online writes the
// push used to make (suspected rate-limit driver).
import { createClientFromRequest } from "https://cdn.jsdelivr.net/npm/@base44/sdk@0.8.31/+esm";

Deno.serve(async (req) => {
  try {
    const b = createClientFromRequest(req);
    // NOTE: the SDK does NOT export requireUser — b.auth.me() is the auth check
    // (same pattern as syncSquareCods). The requireUser import made every
    // mirror call fail instantly (owner report, Sep 28).
    const u = await b.auth.me().catch(() => null);
    if (!u) return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const payload = await req.json().catch(() => ({}));
    const catalogRecords = Array.isArray(payload?.catalogRecords) ? payload.catalogRecords.filter(Boolean) : [];
    const txRecords = Array.isArray(payload?.txRecords) ? payload.txRecords.filter(Boolean) : [];

    // ── SquareCatalogItems: upsert the whole set ──────────────────────
    // Catalog is small (a few hundred rows max). One list builds the
    // delivery_id map; missing rows go in with ONE bulkCreate; changed
    // existing rows update individually (rare after the first pass).
    let created = 0, updated = 0, deleted = 0;
    if (catalogRecords.length > 0) {
      const existing = await b.asServiceRole.entities.SquareCatalogItems.list('-updated_date', 2000).catch(() => []);
      const byDelivery = new Map();
      for (const ex of (existing || [])) {
        const prev = byDelivery.get(ex.delivery_id);
        // keep the first-seen row as primary; duplicates get collapsed below
        if (!prev) byDelivery.set(ex.delivery_id, [ex]);
        else prev.push(ex);
      }
      const toCreate = [];
      for (const rec of catalogRecords) {
        if (!rec?.delivery_id) continue;
        const rows = byDelivery.get(rec.delivery_id) || [];
        const primary = rows.find((r) => r.square_catalog_object_id === rec.square_catalog_object_id) || rows[0];
        if (primary) {
          const changed = primary.item_name !== rec.item_name
            || Number(primary.amount_cents) !== Number(rec.amount_cents)
            || primary.square_catalog_version !== rec.square_catalog_version
            || primary.square_catalog_object_id !== rec.square_catalog_object_id
            || (primary.status || 'active') !== (rec.status || 'active')
            || primary.location_id !== rec.location_id;
          if (changed) {
            const { id, created_date, updated_date, created_by, ...clean } = rec;
            await b.asServiceRole.entities.SquareCatalogItems.update(primary.id, clean).catch(() => null);
            updated++;
          }
          // collapse duplicates for the same delivery (racing invocations)
          for (let i = 0; i < rows.length; i++) {
            if (rows[i] && rows[i].id !== primary.id) {
              await b.asServiceRole.entities.SquareCatalogItems.delete(rows[i].id).catch(() => null);
              deleted++;
            }
          }
        } else {
          const { id, created_date, updated_date, created_by, ...clean } = rec;
          toCreate.push(clean);
        }
      }
      // ONE bulk create for everything new
      for (let i = 0; i < toCreate.length; i += 100) {
        const chunk = toCreate.slice(i, i + 100);
        await b.asServiceRole.entities.SquareCatalogItems.bulkCreate(chunk).catch(() => null);
        created += chunk.length;
      }
    }

    // ── SquareTransaction: upsert only this push's pending rows ──────
    let txCreated = 0, txUpdated = 0;
    for (const txp of txRecords) {
      if (!txp?.delivery_id) continue;
      const exTx = await b.asServiceRole.entities.SquareTransaction.filter({ delivery_id: txp.delivery_id, status: 'pending' }).catch(() => []);
      const { id, created_date, updated_date, created_by, ...clean } = txp;
      if (exTx?.length > 0) {
        await b.asServiceRole.entities.SquareTransaction.update(exTx[0].id, clean).catch(() => null);
        txUpdated++;
      } else {
        await b.asServiceRole.entities.SquareTransaction.create(clean).catch(() => null);
        txCreated++;
      }
    }

    return Response.json({ success: true, catalogCreated: created, catalogUpdated: updated, catalogDuplicatesRemoved: deleted, txCreated, txUpdated });
  } catch (error) {
    console.error('[squareBulkSaveBookkeeping] failed:', error?.message);
    return Response.json({ success: false, error: error?.message }, { status: 500 });
  }
});
